// scripts/refresh-recs.js
// Generate personal audiobook recommendations from the Nuvio library.
//
//   node scripts/refresh-recs.js            # regenerate only if the library changed
//   node scripts/refresh-recs.js --force    # regenerate regardless
//   node scripts/refresh-recs.js --dry-run  # show the library + prompt, call nothing
//
// COST CONTROL
// The whole point is to not spend tokens when nothing has changed. The library
// is fingerprinted with a hash of its content_ids; if that hash matches the one
// stored in .recs-state.json and .recs.json exists, the model is not called at
// all. Adding or removing a single book in Nuvio is what triggers a run.
//
// OUTPUT
// Writes .recs.json (gitignored):
//   { generatedAt, model, basedOnHash, count, items: [{title, author, reason}] }
// The addon then resolves each title through AudiobookBay at request time, so
// a recommendation is only shown if it is actually playable.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const nuvio = require("../src/nuvio");
const libex = require("../src/libex");
const sources = require("../src/sources");
const { parseNameParts } = require("../src/metadata");
const { searchTermFor, titleMatches } = require("../src/recs");

const ROOT = path.join(__dirname, "..");
const RECS_FILE = process.env.RECS_FILE || path.join(ROOT, ".recs.json");
const STATE_FILE = process.env.RECS_STATE_FILE || path.join(ROOT, ".recs-state.json");

// Free models only. Override with RECS_MODEL if a better one is available.
const DEFAULT_MODEL = "opencode/space-bunny-free";
const MODEL = process.env.RECS_MODEL || DEFAULT_MODEL;

const WANT = parseInt(process.env.RECS_COUNT || "15", 10);
const TIMEOUT_MS = parseInt(process.env.RECS_TIMEOUT_MS || "240000", 10);

// The desktop app bundles the CLI; it is not on PATH.
const CLI_CANDIDATES = [
  process.env.OPENCODE_CLI,
  path.join(process.env.LOCALAPPDATA || "", "Programs", "@opencodedesktop", "resources", "opencode-cli.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Programs", "opencode", "bin", "opencode.exe"),
  "opencode",
].filter(Boolean);

function loadDotEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (_) {
    return null;
  }
};

// -- library ------------------------------------------------------------------

/**
 * Fetch the profile's library and reduce each release name to title/author.
 * Names are torrent-style ("Foundation (Book 1) - Isaac Asimov"), which is what
 * the recommender should NOT see; parseNameParts already knows how to strip
 * the release noise, and Libex canonicalises the result against Audible.
 */
async function loadLibrary(profileIndex) {
  const { events } = await nuvio.pullLibraryDelta(profileIndex, 0);
  const state = new Map();
  for (const ev of events) {
    const key = ev.content_id || ev.id;
    if (!key) continue;
    if (ev.operation === "delete") state.delete(key);
    else state.set(key, ev);
  }

  const books = [];
  for (const row of state.values()) {
    const item = nuvio.normaliseItem(row);
    if (!item || !item.name) continue;
    if (item.contentType && item.contentType !== "audiobook") continue;
    const parsed = parseNameParts(item.name, "audiobook");
    if (!parsed.title) continue;
    books.push({
      contentId: item.contentId,
      title: parsed.title,
      author: parsed.author || null,
      series: parsed.series || null,
      raw: item.name,
    });
  }

  // De-duplicate by title+author: the same book can be saved twice.
  const byKey = new Map();
  for (const b of books) {
    const key = `${b.title}|${b.author || ""}`.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, b);
  }
  const unique = [...byKey.values()];

  // Canonicalise against Audible where possible. The release names are
  // inconsistent ("Andy Weir - Project Hail Mary" is author-first, "Frank
  // Herbert - Dune Messiah (2007) edition" has the edition glued on) and only
  // Libex knows the real title/author.
  const CANONICALISE = process.env.RECS_CANONICALISE !== "0";
  if (CANONICALISE) {
    const apply = (b, hit) => {
      b.parsedTitle = b.parsedTitle || b.title;
      b.title = hit.title;
      if (hit.author) b.author = hit.author;
      if (hit.series && !b.series) b.series = hit.series;
    };

    for (const b of unique) {
      try {
        let hit = await libex.lookup(b.title, b.author);

        // No hit: the parser may have the two ends the wrong way round, which
        // no heuristic can settle. Libex can — it is an exact-title oracle, so
        // retry with title/author swapped before giving up.
        if (!hit && b.author) {
          const swapped = await libex.lookup(b.author, b.title);
          if (swapped && swapped.title) {
            hit = swapped;
            b.swapped = true;
          }
        }

        if (hit && hit.title) apply(b, hit);
      } catch (_) {
        /* keep parsed values */
      }
    }
  }

  return unique;
}

// -- model --------------------------------------------------------------------

/**
 * Run the opencode CLI and return its stdout.
 *
 * Uses spawn, not execFile. execFile hangs indefinitely against this CLI
 * (measured: 180s with no output, then SIGTERM) while spawn returns in 2-3s.
 * The CLI keeps its state in a SQLite database under the opencode data dir and
 * the two entry points evidently contend for it. Do not "simplify" this back to
 * execFile.
 */
function runModel(prompt) {
  return new Promise((resolve, reject) => {
    let lastErr = null;

    const attempt = (i) => {
      if (i >= CLI_CANDIDATES.length) {
        return reject(lastErr || new Error("opencode CLI not found in any known location"));
      }
      const bin = CLI_CANDIDATES[i];
      let child;
      try {
        child = spawn(bin, ["run", "--model", MODEL, "--format", "json", prompt], {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch (err) {
        lastErr = err;
        return attempt(i + 1);
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch (_) {}
        lastErr = new Error(`model timed out after ${TIMEOUT_MS}ms`);
        attempt(i + 1);
      }, TIMEOUT_MS);

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          lastErr = err;
          return attempt(i + 1);
        }
        resolve(stdout);
      };

      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => finish(err));
      child.on("close", (code) => {
        if (code !== 0 && !stdout.trim()) {
          return finish(new Error(`${bin} exited ${code}: ${stderr.slice(0, 200)}`));
        }
        if (!stdout.trim()) {
          return finish(new Error(`${bin} produced no output`));
        }
        finish(null);
      });
    };

    attempt(0);
  });
}

/**
 * Pull the model's reply out of the CLI's JSONL stream and then out of
 * whatever prose/fencing wrapped the actual answer.
 */
function extractJson(stdout) {
  let text = "";
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt.type === "text" && evt.part && typeof evt.part.text === "string") {
        text += evt.part.text;
      }
    } catch (_) {
      /* not our JSONL, or partial line */
    }
  }
  if (!text.trim()) text = stdout;

  // Strip code fences and any leading/trailing prose.
  text = text.replace(/```(?:json)?/gi, " ").trim();

  const start = text.search(/[[{]/);
  if (start === -1) return null;
  // Walk forward to find the matching bracket, respecting strings.
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (_) {
          break;
        }
      }
    }
  }
  return salvageObjects(text);
}

/**
 * Last resort for a response the model ran out of output tokens part-way
 * through. Observed for real: fifteen requested titles produced a valid array
 * that stopped mid-string, `"reason":"Same lone-`, and strict parsing threw the
 * whole thing away even though the first several entries were complete.
 *
 * So pull out every balanced `{...}` and keep the ones that parse. A short list
 * is fine here — the caller already drops anything unusable, and a partial
 * answer still beats none at all.
 */
function salvageObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(text.slice(i, j + 1));
            if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj);
          } catch (_) {
            /* incomplete object, keep scanning */
          }
          i = j; // continue after this object
          break;
        }
      }
    }
  }
  return out.length ? out : null;
}

/**
 * Reject titles that are not a plain book name.
 *
 * The small free models pad their answers: "Project Hail Mary's companion: The
 * Martian", "The Hobbit illustrated edition narrated by Andy Serkis", "Children
 * of the Vechta / The Rules of Magic — Six of Crows". None of those is a title
 * an index will ever match, so they are dropped rather than searched for.
 */
const DIRTY_TITLE =
  /\b(companion|illustrated|narrated by|unabridged|abridged|edition|box set|omnibus|audiobook edition|summary|analysis)\b|[/:]|\s[-–—]\s|\s--\s|\d{4}/i;

function isPlausibleTitle(title) {
  const t = String(title || "").trim();
  if (t.length < 3 || t.length > 120) return false;
  if (DIRTY_TITLE.test(t)) return false;
  // A real book title has letters and is not mostly punctuation/digits.
  const letters = (t.match(/[a-z]/gi) || []).length;
  if (letters < t.length * 0.5) return false;
  return true;
}

/**
 * Coerce whatever the model returned into [{title, author, reason}].
 * @param parsed      whatever extractJson() produced
 * @param libraryTitles array of plain title strings already owned by the user
 */
function normaliseRecs(parsed, libraryTitles) {
  let rows = parsed;
  if (parsed && !Array.isArray(parsed)) {
    // Some models wrap the array in an object.
    const key = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
    rows = key ? parsed[key] : [];
  }
  if (!Array.isArray(rows)) return [];

  const have = new Set(libraryTitles.filter(Boolean).map((t) => String(t).trim().toLowerCase()));
  const out = [];
  const seen = new Set();
  let dropped = 0;
  for (const r of rows) {
    if (!r) continue;
    // Tolerate {title,author} or {name,by} or a bare string.
    const title = String(r.title || r.name || (typeof r === "string" ? r : "") || "").trim();
    if (!title || title.length < 2) continue;
    if (!isPlausibleTitle(title)) {
      dropped++;
      continue;
    }
    const author = String(r.author || r.by || r.writer || "").trim() || null;
    const reason = String(r.reason || r.why || r.description || "").trim().slice(0, 200) || null;
    const key = `${title}|${author || ""}`.toLowerCase();
    if (seen.has(key)) continue;
    if (have.has(title.toLowerCase())) continue; // already in the library
    seen.add(key);
    out.push({ title, author, reason });
  }
  if (dropped) {
    console.log(`Dropped ${dropped} malformed title(s) the model padded in.`);
  }
  return out;
}

// -- resolution ---------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is the source actually up?
 *
 * Without this, an unreachable index and a genuine coverage miss look identical:
 * every search returns nothing, and the run reports "0 of 15 are actually in the
 * index" — which blames the index for what is really a dead domain. ABB mirrors
 * go down and change address often, so this is a routine failure, not an edge
 * case. One cheap request settles it before spending a minute on 15 searches.
 *
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
/**
 * Probe the path resolution actually uses, rather than the direct ABB domain.
 *
 * This exists because checking `ABB_DOMAIN` alone was wrong. `searchAudiobooks`
 * fans out to direct AudiobookBay *and* Jackett and merges whatever survives
 * `allSettled`, so a dead mirror does not stop resolution — Jackett still
 * answers. Gating on the mirror meant a perfectly working Jackett setup was
 * reported as "index unreachable" and exited before trying a single lookup.
 * The only question worth asking is whether a search returns anything, so ask
 * that, using the same call the resolver makes.
 *
 * @returns {Promise<{ok: boolean, hits: number, detail: string}>}
 */
async function probeSearchPath(cfg) {
  // Plain, unambiguous, and present in any usable audiobook index. Probed
  // through the real search function rather than a raw HTTP GET, because that
  // is the only signal that predicts whether resolution will succeed.
  const probes = ["A Game of Thrones", "The Hobbit"];
  const started = Date.now();
  for (const q of probes) {
    try {
      const hits = await sources.searchAudiobooks(cfg, q, 1);
      if (hits && hits.length) {
        return {
          ok: true,
          hits: hits.length,
          detail: `search path answered "${q}" with ${hits.length} hit(s) in ${Date.now() - started}ms`,
        };
      }
    } catch (_) {
      // Try the next probe.
    }
  }
  return {
    ok: false,
    hits: 0,
    detail: `no index answered a probe search after ${Date.now() - started}ms`,
  };
}

/**
 * Work out a Jackett URL that is reachable from *this* process.
 *
 * The backend container talks to Jackett as `http://jackett:9117`, which is a
 * compose-network name and does not resolve on the host where this script runs.
 * Jackett is published on 127.0.0.1:9117 for exactly this, so prefer whatever
 * is actually reachable instead of demanding the .env value be edited — the
 * container still needs the internal name, so changing .env is not the fix.
 *
 * @returns {Promise<string|undefined>} undefined means "no override needed".
 */
async function jackettUrlForHost() {
  const raw = (process.env.JACKETT_URL || "").trim();
  if (!raw) return undefined;

  const host = raw.replace(/^https?:\/\//, "").split(":")[0];
  // Loopback, a raw IP, or an explicit port is already usable as written.
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    return undefined;
  }

  const resolves = await new Promise((done) => {
    require("dns").lookup(host, (err) => done(!err));
  });
  if (resolves) return undefined;

  const fallback = "http://127.0.0.1:9117";
  const reachable = await new Promise((done) => {
    const req = require("http").request(`${fallback}/api/v2.0/indexers?apikey=x`, { timeout: 3000 }, (r) => {
      r.resume();
      done(true);
    });
    req.on("error", () => done(false));
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.end();
  });

  if (reachable) {
    console.log(`Jackett: ${raw} is container-internal, using the published ${fallback} instead.`);
    return fallback;
  }
  console.log(`Jackett: ${raw} does not resolve here and ${fallback} is not answering either.`);
  return undefined;
}

async function checkSourceReachable(domain) {
  const started = Date.now();
  try {
    const res = await fetch(`https://${domain}/`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return { ok: false, detail: `${domain} answered HTTP ${res.status}` };
    }
    await res.text();
    return { ok: true, detail: `${domain} reachable in ${Date.now() - started}ms` };
  } catch (err) {
    return {
      ok: false,
      detail: `${domain} unreachable after ${Date.now() - started}ms: ${err.message}`,
    };
  }
}

/**
 * Turn each recommendation into a playable release.
 *
 * This happens here, offline, rather than in the catalogue request. Doing it on
 * the request path means one source request per recommendation fired at once,
 * and AudiobookBay answers a burst with an empty page or its front page instead
 * of results — measured here: "A Game of Thrones" resolves fine on its own but
 * returns nothing when sixteen searches go out together. So the requests are
 * serialised with a real gap, and the catalogue just reads the outcome.
 *
 * A recommendation that does not resolve is dropped rather than shown as a dead
 * tile. ABB is a small index, so for a lot of good suggestions this is the
 * expected outcome, and the summary printed at the end says so plainly.
 */
async function resolveRecs(recs, cfg) {
  const gap = parseInt(process.env.RECS_GAP_MS || "2500", 10);
  const resolved = [];

  for (const rec of recs) {
    const term = searchTermFor(rec);
    if (!term) continue;

    let hits = [];
    try {
      hits = await sources.searchAudiobooks(cfg, term, 1);
    } catch (err) {
      console.warn(`  ! ${rec.title}: ${err.message}`);
    }

    // AudiobookBay can answer a search with its front page, so never trust the
    // result set blindly — require the hit to actually be the book we asked for.
    const hit = hits.find((h) => titleMatches(h.name, rec.title));
    if (!hit) {
      console.log(`  - ${rec.title} (not in the index)`);
      continue;
    }

    // A release is only playable if it has *some* torrent identity. ABB gives a
    // magnet, but Jackett returns a /dl/ endpoint with neither hash nor magnet and
    // expects to be resolved at play time — dropping torrentUrl here turned those
    // hits into dead tiles that the serving path then discarded, silently losing
    // a third of the row.
    if (!hit.infohash && !hit.magnet && !hit.torrentUrl) {
      console.log(`  - ${rec.title} (matched, but no way to fetch it)`);
      continue;
    }

    resolved.push({
      ...rec,
      release: {
        name: hit.name,
        infohash: hit.infohash || null,
        magnet: hit.magnet || null,
        torrentUrl: hit.torrentUrl || null,
        size: hit.size || 0,
        format: hit.format || null,
        bitrate: hit.bitrate || null,
      },
    });
    console.log(`  + ${rec.title} -> ${hit.name}`);

    await sleep(gap);
  }

  return resolved;
}

// -- prompt -------------------------------------------------------------------

function buildPrompt(books) {
  const lines = books.map((b) => (b.author ? `- ${b.title} — ${b.author}` : `- ${b.title}`));
  return [
    "You are recommending audiobooks to one specific reader.",
    "",
    "Their library (books they already have, listed by title and author):",
    ...lines,
    "",
    `Recommend ${WANT} audiobooks they almost certainly do NOT already own.`,
    "Infer their taste from the library: preferred genres, tone, series they",
    "follow, authors they read, and era. Favour well-known, widely available",
    "titles that exist as real audiobooks, because each title will be looked up",
    "in a torrent index and must resolve to something playable.",
    "",
    "Do not recommend anything already in the list above.",
    "",
    "How to write each title — this matters more than it looks:",
    "- Give the plain, canonical English book title and nothing else.",
    "- No subtitles, no colons, no series position, no edition names.",
    '- Bad: "Sapiens: A Brief History of Humankind", "Dune: Book 1".',
    '- Good: "Sapiens", "Dune".',
    "- No narrator, no 'narrated by', no 'illustrated edition', no 'unabridged'.",
    "- No commentary of any kind: no 'companion to', no 'summary of'.",
    "- One book per entry. Never join two books with a slash or a dash.",
    "- Never include a year.",
    "",
    "Reply with ONLY a JSON array, no prose and no code fence, like:",
    '[{"title":"Book Name","author":"Author Name","reason":"One short sentence."}]',
  ].join("\n");
}

// -- main ---------------------------------------------------------------------

async function main() {
  loadDotEnv();

  const force = process.argv.includes("--force");
  const dryRun = process.argv.includes("--dry-run");

  if (!nuvio.isConfigured()) {
    console.error("NUVIO_EMAIL / NUVIO_PASSWORD are not set in .env. Nothing to do.");
    process.exit(1);
  }
  const profileIndex = nuvio.parseProfileIndex(process.env.NUVIO_PROFILE_ID);
  if (!profileIndex) {
    console.error("NUVIO_PROFILE_ID must be 1..6. Run `node scripts/nuvio-profiles.js`.");
    process.exit(1);
  }

  const books = await loadLibrary(profileIndex);
  const hash = nuvio.hashContentIds(books.map((b) => b.contentId));
  console.log(`Profile [${profileIndex}]: ${books.length} distinct books, fingerprint ${hash.slice(0, 12)}`);

  const existing = readJson(RECS_FILE);
  const state = readJson(STATE_FILE);

  if (dryRun) {
    console.log("\n--- library as the model will see it ---");
    for (const b of books) console.log(`  ${b.title}${b.author ? " — " + b.author : ""}`);
    console.log(`\n--- prompt ---\n${buildPrompt(books)}`);
    return;
  }

  if (!force && existing && state && state.hash === hash && Array.isArray(existing.items)) {
    const stored = Array.isArray(existing.suggestions) ? existing.suggestions : [];
    if (existing.items.length === 0 && stored.length) {
      // The previous run generated fine but resolved nothing. That is a source
      // problem, not a library problem, so the hash gate must not swallow it:
      // re-resolve the suggestions we already paid for instead of returning 0
      // forever, and still do not call the model.
      console.log(
        `Library unchanged since ${existing.generatedAt}, but nothing resolved last time.`
      );
      console.log(`Retrying resolution of ${stored.length} stored suggestion(s) — model not called.`);
      await writeResolved(existing, stored, books, profileIndex, hash, existing.generatedAt);
      return;
    }
    console.log(
      `Library unchanged since ${existing.generatedAt}. Keeping ${existing.items.length} recommendations — model not called.`
    );
    console.log("(use --force to regenerate anyway)");
    return;
  }

  if (!books.length) {
    console.error("Library is empty; refusing to guess. Add some books to the profile first.");
    process.exit(1);
  }

  console.log(`\nGenerating with model ${MODEL} ...`);
  const started = Date.now();
  let stdout;
  try {
    stdout = await runModel(buildPrompt(books));
  } catch (err) {
    console.error("Model call failed:", err.message);
    if (existing && Array.isArray(existing.items)) {
      console.error("Keeping the previous recommendations.");
    }
    process.exit(1);
  }

  const parsed = extractJson(stdout);
  const recs = normaliseRecs(parsed, books.map((b) => b.title));
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (!recs.length) {
    console.error(`Model returned no usable recommendations after ${secs}s.`);
    console.error("Raw output was:\n" + stdout.slice(0, 800));
    if (existing && Array.isArray(existing.items)) console.error("Keeping the previous set.");
    process.exit(1);
  }

  console.log(`\n${recs.length} recommendations in ${secs}s.`);

  await writeResolved(recs, recs, books, profileIndex, hash);
}

/**
 * Resolve suggestions to playable releases, write the result, and print a summary.
 * Shared by the generate path and the re-resolve path so both behave identically.
 */
async function writeResolved(suggestions, recs, books, profileIndex, hash, generatedAt) {
  const abbDomain = process.env.ABB_DOMAIN || "audiobookbay.lu";
  const jackettUrl = await jackettUrlForHost();
  const cfg = jackettUrl ? { abbDomain, jackettUrl } : { abbDomain };

  // Check the source before spending a minute on searches that cannot succeed.
  // Note the probe goes through the search path, not the mirror: a dead
  // audiobookbay.* is survivable when Jackett is configured, and reporting that
  // as a dead index was a false negative that silently emptied the row.
  const probe = await probeSearchPath(cfg);
  const reach = await checkSourceReachable(abbDomain);
  if (!probe.ok) {
    console.error(`\nCannot resolve: ${probe.detail}`);
    console.error(`Direct mirror check: ${reach.detail}`);
    console.error(
      "Suggestions were generated but no release could be looked up. This is the\n" +
        "index being unreachable, not a coverage problem — ABB mirrors change domain\n" +
        "often, and Jackett needs a working indexer of its own. Fix ABB_DOMAIN or the\n" +
        "Jackett indexer config in .env, then run this again."
    );
    process.exit(1);
  }
  if (!reach.ok) {
    // Not fatal: resolution runs through searchAudiobooks, which merges Jackett
    // results in alongside whatever the mirror returns.
    console.log(`Note: direct mirror is down (${reach.detail}).`);
    console.log(`Continuing — ${probe.detail}.`);
  } else {
    console.log(`${reach.detail}. Resolving to playable releases...`);
  }

  const resolved = await resolveRecs(recs, cfg);

  const payload = {
    // Preserve the original generation time when only re-resolving, so the
    // "generated at" in the UI still means when the model actually ran.
    generatedAt: generatedAt || new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    profileIndex,
    model: MODEL,
    basedOnHash: hash,
    basedOnCount: books.length,
    count: resolved.length,
    suggested: suggestions.length,
    items: resolved,
    // The unresolved suggestions are kept so a failed resolution can be retried
    // later without calling the model again. Generation and resolution fail for
    // unrelated reasons — a dead index should not cost a second round of tokens.
    suggestions,
  };
  fs.writeFileSync(RECS_FILE, JSON.stringify(payload, null, 2));
  fs.writeFileSync(STATE_FILE, JSON.stringify({ hash, count: books.length, at: payload.generatedAt }, null, 2));

  console.log(`\n${resolved.length} of ${suggestions.length} are actually in the index -> ${path.basename(RECS_FILE)}\n`);
  resolved.forEach((r, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${r.title}${r.author ? " — " + r.author : ""}\n      ${r.release.name}`)
  );

  if (!resolved.length) {
    console.log(
      "\nNothing resolved. Either the index does not carry these titles, or the\n" +
        "source was unreachable during resolution (an unreachable source returns no\n" +
        "results, which looks the same as a missing book). Re-run this command later\n" +
        "to retry — the suggestions are kept, so no tokens are spent. Or try a\n" +
        "different RECS_MODEL, or raise RECS_COUNT so more candidates are tried."
    );
  }
}

// Exported so the parsing and title filter can be unit tested without running
// the whole generation (which needs credentials and spends tokens).
module.exports = {
  extractJson,
  normaliseRecs,
  isPlausibleTitle,
  buildPrompt,
  runModel,
  checkSourceReachable,
  probeSearchPath,
  jackettUrlForHost,
};

if (require.main === module) {
  main().catch((err) => {
    console.error("Failed:", err.message);
    process.exit(1);
  });
}

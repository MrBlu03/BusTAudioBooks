// scripts/refresh-recs.js
// Generate personal audiobook recommendations from the Nuvio watch history & library.
//
//   node scripts/refresh-recs.js            # regenerate only if activity changed
//   node scripts/refresh-recs.js --force    # regenerate regardless
//   node scripts/refresh-recs.js --dry-run  # show the prompt, call nothing
//   node scripts/refresh-recs.js --email <email> --password <pwd> --profile <id>
//
// COST CONTROL
// The whole point is to not spend tokens when nothing has changed. The user's
// activity (watch progress + library) is fingerprinted with a hash. If that hash
// matches the one stored in .recs-state.json and .recs.json exists, the model is
// not called at all. Adding/removing a book or listening progress in Nuvio is what
// triggers a run.
//
// WEIGHTING
// Audiobooks the user has actively listened to / consumed are weighted HEAVIEST
// as the primary taste driver, while unconsumed books in their library serve as
// secondary context.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const nuvio = require("../src/nuvio");
const audnexus = require("../src/audnexus");
const libex = require("../src/libex");
const sources = require("../src/sources");
const { parseNameParts } = require("../src/metadata");
const { parseSeriesAndBook } = require("../src/series");
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

// -- activity & library --------------------------------------------------------

/**
 * Fetch the profile's watch progress & library, reduce names to title/author,
 * and separate into consumed (heavily weighted) and queued (secondary).
 */
async function loadUserActivity(profileIndex, creds = null) {
  const { watchItems, libraryItems, fingerprint } = await nuvio.pullUserHistoryAndLibrary(
    profileIndex,
    creds
  );

  // 1. Process watch items (actively consumed)
  const consumedBooks = [];
  for (const item of watchItems) {
    if (item.contentType && item.contentType !== "audiobook") continue;
    const parsed = parseNameParts(item.name, "audiobook");
    if (!parsed.title) continue;
    consumedBooks.push({
      contentId: item.contentId,
      title: parsed.title,
      author: parsed.author || null,
      series: parsed.series || null,
      progressPercent: item.progressPercent,
      lastWatched: item.lastWatched,
      raw: item.name,
    });
  }

  // 2. Process library items (saved backlog)
  const libraryBooks = [];
  for (const item of libraryItems) {
    if (item.contentType && item.contentType !== "audiobook") continue;
    const parsed = parseNameParts(item.name, "audiobook");
    if (!parsed.title) continue;
    libraryBooks.push({
      contentId: item.contentId,
      title: parsed.title,
      author: parsed.author || null,
      series: parsed.series || null,
      raw: item.name,
    });
  }

  // Canonicalise against Audnexus / Audible / Libex
  const CANONICALISE = process.env.RECS_CANONICALISE !== "0";
  const canonicaliseList = async (list) => {
    if (!CANONICALISE) return;
    const apply = (b, hit) => {
      b.parsedTitle = b.parsedTitle || b.title;
      b.title = hit.title;
      if (hit.author) b.author = hit.author;
      if (hit.series && !b.series) b.series = hit.series;
    };
    for (const b of list) {
      try {
        let hit = await audnexus.lookupAudnexus(b.title, b.author);
        if (!hit) {
          hit = await libex.lookup(b.title, b.author);
          if (!hit && b.author) {
            const swapped = await libex.lookup(b.author, b.title);
            if (swapped && swapped.title) {
              hit = swapped;
              b.swapped = true;
            }
          }
        }
        if (hit && hit.title) apply(b, hit);
      } catch (_) {}
    }
  };

  await Promise.all([canonicaliseList(consumedBooks), canonicaliseList(libraryBooks)]);

  // De-duplicate consumed by title
  const consumedMap = new Map();
  for (const b of consumedBooks) {
    const key = (b.title || "").toLowerCase();
    if (!consumedMap.has(key)) consumedMap.set(key, b);
  }
  const uniqueConsumed = [...consumedMap.values()];

  // De-duplicate queued: don't include books already in consumed
  const queuedMap = new Map();
  for (const b of libraryBooks) {
    const key = (b.title || "").toLowerCase();
    if (!consumedMap.has(key) && !queuedMap.has(key)) {
      queuedMap.set(key, b);
    }
  }
  const uniqueQueued = [...queuedMap.values()];

  return {
    consumed: uniqueConsumed,
    queued: uniqueQueued,
    allBooks: [...uniqueConsumed, ...uniqueQueued],
    fingerprint,
  };
}

/** Legacy wrapper for tests / callers */
async function loadLibrary(profileIndex, creds = null) {
  const { allBooks } = await loadUserActivity(profileIndex, creds);
  return allBooks;
}

// -- model --------------------------------------------------------------------

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
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            const obj = JSON.parse(text.slice(i, j + 1));
            if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj);
          } catch (_) {}
          i = j;
          break;
        }
      }
    }
  }
  return out.length ? out : null;
}

const DIRTY_TITLE =
  /\b(companion|illustrated|narrated by|unabridged|abridged|edition|box set|omnibus|audiobook edition|summary|analysis)\b|[/:]|\s[-–—]\s|\s--\s|\d{4}/i;

function isPlausibleTitle(title) {
  const t = String(title || "").trim();
  if (t.length < 3 || t.length > 120) return false;
  if (DIRTY_TITLE.test(t)) return false;
  const letters = (t.match(/[a-z]/gi) || []).length;
  if (letters < t.length * 0.5) return false;
  return true;
}

function normaliseRecs(parsed, libraryTitles) {
  let rows = parsed;
  if (parsed && !Array.isArray(parsed)) {
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
    if (have.has(title.toLowerCase())) continue;
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

async function probeSearchPath(cfg) {
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
    } catch (_) {}
  }
  return {
    ok: false,
    hits: 0,
    detail: `no index answered a probe search after ${Date.now() - started}ms`,
  };
}

async function jackettUrlForHost() {
  const raw = (process.env.JACKETT_URL || "").trim();
  if (!raw) return undefined;

  const host = raw.replace(/^https?:\/\//, "").split(":")[0];
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

    const hit = hits.find((h) => titleMatches(h.name, rec.title));
    if (!hit) {
      console.log(`  - ${rec.title} (not in the index)`);
      continue;
    }

    if (!hit.infohash && !hit.magnet && !hit.torrentUrl) {
      console.log(`  - ${rec.title} (matched, but no way to fetch it)`);
      continue;
    }

    let meta = null;
    try {
      meta = await audnexus.lookupAudnexus(rec.title, rec.author);
    } catch (_) {}

    let series = (meta && meta.series) || null;
    let seriesIndex = (meta && meta.seriesIndex) || null;
    if (!series) {
      const s1 = parseNameParts(hit.name, "audiobook");
      const s2 = parseSeriesAndBook(hit.name, rec.author);
      series = (s2 && s2.seriesName) || (s1 && s1.series) || null;
      seriesIndex = s2 && s2.bookNumber != null ? s2.bookNumber : null;
    }

    resolved.push({
      ...rec,
      poster: (meta && meta.poster) || null,
      series: series || null,
      seriesIndex: seriesIndex != null ? seriesIndex : null,
      narrator: (meta && meta.narrator) || null,
      rating: (meta && meta.rating) || null,
      duration: (meta && meta.duration) || null,
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

function buildPrompt(data) {
  let consumed = [];
  let queued = [];

  if (Array.isArray(data)) {
    queued = data;
  } else if (data && typeof data === "object") {
    consumed = Array.isArray(data.consumed) ? data.consumed : [];
    queued = Array.isArray(data.queued) ? data.queued : [];
  }

  const consumedLines = consumed.map((b) => {
    const prog = b.progressPercent ? ` (Listened: ${b.progressPercent}% completed)` : " (Listened)";
    return b.author ? `- ${b.title} — ${b.author}${prog}` : `- ${b.title}${prog}`;
  });

  const queuedLines = queued.map((b) =>
    b.author ? `- ${b.title} — ${b.author}` : `- ${b.title}`
  );

  const sections = [
    "You are recommending audiobooks to one specific reader.",
    "",
    "The reader's listening activity and library:",
    "",
  ];

  if (consumedLines.length > 0) {
    sections.push(
      "### ACTIVELY CONSUMED / LISTENED AUDIOBOOKS (HEAVIEST WEIGHT - PRIMARY TASTE DRIVER):",
      "The reader has actively listened to and consumed these audiobooks. Their tone, world-building,",
      "authors, pacing, complexity, and narration style represent the reader's proven, strongest preferences.",
      "Weigh these HEAVIEST when selecting recommendations:",
      ...consumedLines,
      ""
    );
  }

  if (queuedLines.length > 0) {
    sections.push(
      "### SAVED IN LIBRARY (SECONDARY TASTE CONTEXT):",
      "Books saved in their backlog that they have not yet listened to. Use as secondary context only:",
      ...queuedLines,
      ""
    );
  }

  sections.push(
    `Recommend ${WANT} audiobooks they almost certainly do NOT already own.`,
    "Infer their taste primarily from the actively consumed audiobooks, with library items as secondary clues.",
    "Favour well-known, widely available titles that exist as real audiobooks, because each title will be looked up",
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
    '[{"title":"Book Name","author":"Author Name","reason":"One short sentence."}]'
  );

  return sections.join("\n");
}

// -- main ---------------------------------------------------------------------

async function main() {
  loadDotEnv();

  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");

  let explicitEmail = null;
  let explicitPassword = null;
  let explicitProfile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email" && args[i + 1]) explicitEmail = args[++i];
    if (args[i] === "--password" && args[i + 1]) explicitPassword = args[++i];
    if (args[i] === "--profile" && args[i + 1]) explicitProfile = args[++i];
  }

  const creds = nuvio.getCredentials(
    explicitEmail && explicitPassword ? { email: explicitEmail, password: explicitPassword } : null
  );

  if (!creds) {
    console.error("Nuvio credentials not provided (via --email/--password or .env). Nothing to do.");
    process.exit(1);
  }

  const profileIndex =
    nuvio.parseProfileIndex(explicitProfile) ||
    nuvio.parseProfileIndex(process.env.NUVIO_PROFILE_ID);

  if (!profileIndex) {
    console.error("NUVIO_PROFILE_ID must be 1..6. Pass --profile <n> or run `node scripts/nuvio-profiles.js`.");
    process.exit(1);
  }

  const activity = await loadUserActivity(profileIndex, creds);
  const { consumed, queued, allBooks, fingerprint } = activity;

  console.log(
    `Profile [${profileIndex}]: ${consumed.length} actively listened, ${queued.length} queued in library (total ${allBooks.length} books)`
  );
  console.log(`Activity fingerprint: ${fingerprint.slice(0, 12)}`);

  const targetRecsFile =
    process.env.RECS_FILE ||
    (explicitProfile
      ? path.join(ROOT, `.recs-${profileIndex}.json`)
      : path.join(ROOT, ".recs.json"));
  const targetStateFile =
    process.env.RECS_STATE_FILE ||
    (explicitProfile
      ? path.join(ROOT, `.recs-state-${profileIndex}.json`)
      : path.join(ROOT, ".recs-state.json"));

  const existing = readJson(targetRecsFile) || readJson(RECS_FILE);
  const state = readJson(targetStateFile) || readJson(STATE_FILE);

  if (dryRun) {
    console.log("\n--- Actively Consumed (Heavy Weight) ---");
    for (const b of consumed) {
      console.log(`  [${b.progressPercent}%] ${b.title}${b.author ? " — " + b.author : ""}`);
    }
    console.log("\n--- Queued in Library (Secondary) ---");
    for (const b of queued) {
      console.log(`  ${b.title}${b.author ? " — " + b.author : ""}`);
    }
    console.log(`\n--- Prompt to Model ---\n${buildPrompt(activity)}`);
    return;
  }

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const isOlderThanADay =
    existing &&
    existing.generatedAt &&
    Date.now() - new Date(existing.generatedAt).getTime() >= ONE_DAY_MS;

  if (isOlderThanADay) {
    console.log(
      `Recommendations are older than 24 hours (last generated: ${existing.generatedAt}). Refreshing daily recommendations...`
    );
  } else if (!force && existing && state && state.hash === fingerprint && Array.isArray(existing.items)) {
    const stored = Array.isArray(existing.suggestions) ? existing.suggestions : [];
    if (existing.items.length === 0 && stored.length) {
      console.log(
        `Activity unchanged since ${existing.generatedAt}, but nothing resolved last time.`
      );
      console.log(`Retrying resolution of ${stored.length} stored suggestion(s) — model not called.`);
      await writeResolved(
        existing,
        stored,
        allBooks,
        profileIndex,
        fingerprint,
        targetRecsFile,
        targetStateFile,
        existing.generatedAt
      );
      return;
    }
    console.log(
      `Activity unchanged since ${existing.generatedAt}. Keeping ${existing.items.length} recommendations — model not called.`
    );
    console.log("(use --force to regenerate anyway)");
    return;
  }

  if (!allBooks.length) {
    console.error("No books found in history or library; refusing to guess. Add some books first.");
    process.exit(1);
  }

  console.log(`\nGenerating recommendations with model ${MODEL} (heavily weighting watch history)...`);
  const started = Date.now();
  let stdout;
  try {
    stdout = await runModel(buildPrompt(activity));
  } catch (err) {
    console.error("Model call failed:", err.message);
    if (existing && Array.isArray(existing.items)) {
      console.error("Keeping previous recommendations.");
    }
    process.exit(1);
  }

  const parsed = extractJson(stdout);
  const recs = normaliseRecs(parsed, allBooks.map((b) => b.title));
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (!recs.length) {
    console.error(`Model returned no usable recommendations after ${secs}s.`);
    console.error("Raw output was:\n" + stdout.slice(0, 800));
    if (existing && Array.isArray(existing.items)) console.error("Keeping the previous set.");
    process.exit(1);
  }

  console.log(`\n${recs.length} recommendations generated in ${secs}s.`);

  await writeResolved(recs, recs, allBooks, profileIndex, fingerprint, targetRecsFile, targetStateFile);
}

async function writeResolved(
  suggestions,
  recs,
  books,
  profileIndex,
  hash,
  targetRecsFile = RECS_FILE,
  targetStateFile = STATE_FILE,
  generatedAt = null
) {
  const abbDomain = process.env.ABB_DOMAIN || "audiobookbay.lu";
  const jackettUrl = await jackettUrlForHost();
  const cfg = jackettUrl ? { abbDomain, jackettUrl } : { abbDomain };

  const probe = await probeSearchPath(cfg);
  const reach = await checkSourceReachable(abbDomain);
  if (!probe.ok) {
    console.error(`\nCannot resolve: ${probe.detail}`);
    console.error(`Direct mirror check: ${reach.detail}`);
    console.error(
      "Suggestions were generated but no release could be looked up. Fix ABB_DOMAIN or Jackett indexer config, then run again."
    );
    process.exit(1);
  }
  if (!reach.ok) {
    console.log(`Note: direct mirror is down (${reach.detail}). Continuing via Jackett — ${probe.detail}.`);
  } else {
    console.log(`${reach.detail}. Resolving to playable releases...`);
  }

  const resolved = await resolveRecs(recs, cfg);

  const payload = {
    generatedAt: generatedAt || new Date().toISOString(),
    resolvedAt: new Date().toISOString(),
    profileIndex,
    model: MODEL,
    basedOnHash: hash,
    basedOnCount: books.length,
    count: resolved.length,
    suggested: suggestions.length,
    items: resolved,
    suggestions,
  };

  fs.writeFileSync(targetRecsFile, JSON.stringify(payload, null, 2));
  fs.writeFileSync(targetStateFile, JSON.stringify({ hash, count: books.length, at: payload.generatedAt }, null, 2));

  // Mirror to default .recs.json if a profile-specific target was used
  if (targetRecsFile !== path.join(ROOT, ".recs.json")) {
    try {
      fs.writeFileSync(path.join(ROOT, ".recs.json"), JSON.stringify(payload, null, 2));
    } catch (_) {}
  }

  console.log(`\n${resolved.length} of ${suggestions.length} are actually in the index -> ${path.basename(targetRecsFile)}\n`);
  resolved.forEach((r, i) =>
    console.log(`  ${String(i + 1).padStart(2)}. ${r.title}${r.author ? " — " + r.author : ""}\n      ${r.release.name}`)
  );
}

async function normalizeWithOpenCode(rawTitle) {
  if (!rawTitle) return null;
  const prompt = `Parse this messy audiobook torrent/release title into JSON with keys "title" (clean book title), "author" (clean author name or null), "series" (series name or null), "seriesIndex" (number or null), "narrator" (narrator name or null):\n"${rawTitle}"`;
  try {
    const raw = await runModel(prompt);
    const parsed = extractJson(raw);
    if (parsed && typeof parsed === "object") {
      return Array.isArray(parsed) ? parsed[0] : parsed;
    }
  } catch (_) {}
  return null;
}

module.exports = {
  extractJson,
  normaliseRecs,
  isPlausibleTitle,
  buildPrompt,
  runModel,
  checkSourceReachable,
  probeSearchPath,
  jackettUrlForHost,
  loadUserActivity,
  loadLibrary,
  normalizeWithOpenCode,
};

if (require.main === module) {
  main().catch((err) => {
    console.error("Failed:", err.message);
    process.exit(1);
  });
}

// src/libex.js
// Libex — Audible-backed audiobook metadata (https://libexdb.com).
//
// Why this provider: the older chain in metadata.js (iTunes, Google Books,
// Open Library, audiobookcovers.com) returns thin, often-wrong records for
// audiobooks — generic square art, no series ordering, no narrator. Libex
// returns all of it, needs no API key, and ranks far better on noisy torrent
// names (it returns the real "Dune" rather than "Foundations of Grace CA").
//
// It exposes an Audiobookshelf-compatible search shape:
//   GET /{region}/search?title=...&author=...  ->  { matches: [...] }
//
// Disable with LIBEX_ENABLED=0 to fall back to the legacy chain entirely.

const { TTLCache, pLimit } = require("./cache");

const BASE = (process.env.LIBEX_BASE_URL || "https://libexdb.com").replace(/\/+$/, "");
const REGION = (process.env.LIBEX_REGION || "us").toLowerCase();
const ENABLED = process.env.LIBEX_ENABLED !== "0";
const TIMEOUT_MS = parseInt(process.env.LIBEX_TIMEOUT_MS || "2500", 10);

const cache = new TTLCache(24 * 60 * 60 * 1000, 3000); // 24h — covers never really change
const limit = pLimit(3); // be a good citizen on a free community API

// -- field coercion -----------------------------------------------------------
// Libex returns `author`/`narrator` as plain strings today, but the upstream
// Audible shapes these as objects ({ name }). Handle both so a schema change
// upstream degrades into "slightly less metadata" rather than a crash.

function names(value) {
  if (!value) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr
    .map((v) => {
      if (typeof v === "string") return v.trim();
      if (v && typeof v === "object") {
        return String(v.name || v.title || "").trim();
      }
      return "";
    })
    .filter(Boolean);
}

// Audible narrators are one long comma-joined string; split on commas that are
// followed by a capitalised word so "Smith, John" style names survive.
function splitNarrators(raw) {
  return String(raw || "")
    .split(/,\s*(?=[A-Z\p{Lu}])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Libex returns series as [{ series, sequence }]. Pick the lowest sequence —
// Audible lists a book under both its own series ("Dune" #1) and the umbrella
// ("The Dune Sequence" #12); the tightest fit is the useful one.
function pickSeries(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const usable = list
    .map((s) => ({
      name: String((s && (s.series || s.name)) || "").trim(),
      sequence: parseFloat(s && s.sequence),
    }))
    .filter((s) => s.name);
  if (!usable.length) return null;
  usable.sort(
    (a, b) => (isFinite(a.sequence) ? a.sequence : 1e9) - (isFinite(b.sequence) ? b.sequence : 1e9)
  );
  const best = usable[0];
  return {
    name: best.name,
    index: isFinite(best.sequence) ? best.sequence : null,
  };
}

function clean(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

// Audible returns both coarse `genres` ("Science Fiction & Fantasy") and
// freeform `tags` ("Science Fiction", "Fantasy", "Epic"). Concatenated raw they
// produce near-duplicate chips on a Stremio card, so keep the coarse categories
// and drop any tag already covered by one of them.
function dedupeGenres(genres, tags) {
  const out = [];
  const seen = [];

  const add = (value) => {
    const label = clean(value);
    if (!label) return;
    const key = normTitle(label);
    if (!key || key.length < 2) return;
    if (seen.some((k) => k === key || k.includes(key) || key.includes(k))) return;
    seen.push(key);
    out.push(label);
  };

  for (const g of genres) add(g);
  for (const t of tags) {
    if (out.length >= 5) break;
    add(t);
  }
  return out;
}

// -- match scoring ------------------------------------------------------------
// Torrent filenames are noisy ("Dune (Unabridged) - Frank Herbert [M4B]"), so a
// raw equality check is useless. Score on token overlap instead and reject
// matches that share almost nothing with what we asked for.

function tokens(s) {
  return clean(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

// Title and author are scored separately on purpose: the author's name appears
// in match.author, never in the title, so folding both into one bag of tokens
// caps a perfect title match at 1/3 and rejects it.

const TITLE_FLOOR = 0.5; // title overlap required regardless of author

// Normalise for comparison: lowercase, strip accents/punctuation/space.
function normTitle(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

const ACCEPT = 0.7; // below this we return null and let the legacy chain try

function scoreMatch(match, title, author) {
  // Precision beats recall, hard. metadata.js already falls back to
  // iTunes/Google Books/Open Library, so a null costs nothing — but returning
  // the WRONG book puts a random cover on someone's shelf.
  //
  // Exact normalised equality only. Looser rules were tried and all misfire:
  //   token overlap -> "Foundation" matches "Forward the Foundation"
  //   prefix match  -> "Foundation" matches "Foundation's Edge" / "and Earth"
  // Audible titles are canonical, and torrent filenames usually echo them
  // exactly, so exact matching still catches the common case. Anything else
  // falls through to the legacy chain, which is the safe place to be wrong.
  const want = normTitle(title);
  if (want.length < 2) return 0;
  if (normTitle(match.title) !== want) return 0;

  let base = 1;

  // Audible serves many editions and /us happily returns Spanish or German
  // printings for English queries. Trust the record's language, not the URL.
  const lang = String(match.language || "").toLowerCase();
  if (lang && lang !== "english") base *= 0.25;
  else if (!lang) base *= 0.95; // unknown, mild discount

  // Author agreement is a tie-breaker only; it never rescues a title mismatch.
  const authorWant = tokens(author);
  if (authorWant.length) {
    const authorGot = new Set(tokens(match.author));
    let aHits = 0;
    for (const w of authorWant) if (authorGot.has(w)) aHits++;
    if (aHits / authorWant.length === 1) base = Math.min(1, base + 0.05);
  }

  return base;
}

// -- search -------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "bustaudio-addon/2.2.0 (+audiobook metadata)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return res.json();
}

/**
 * Look up a book by title/author.
 * Always resolves — returns null on any failure.
 */
async function lookup(title, author) {
  if (!ENABLED) return null;
  const t = clean(title);
  if (!t) return null;

  const key = `${REGION}:${t.toLowerCase()}|${clean(author).toLowerCase()}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const qs = new URLSearchParams({ title: t });
  if (author) qs.set("author", clean(author));

  const url = `${BASE}/${REGION}/search?${qs.toString()}`;

  let out = null;
  try {
    const data = await limit(() => fetchJson(url))();
    const matches = data && Array.isArray(data.matches) ? data.matches : [];
    if (matches.length) {
      const ranked = matches
        .map((m) => ({ m, s: scoreMatch(m, t, author) }))
        .sort((a, b) => b.s - a.s);
      if (ranked[0].s >= ACCEPT) {
        const m = ranked[0].m;
        const narratorList = m.narrator ? splitNarrators(m.narrator) : names(m.narrator);
        const series = pickSeries(m.series);
        const genres = dedupeGenres(names(m.genres), names(m.tags));
        out = {
          asin: m.asin || null,
          title: clean(m.title) || null,
          subtitle: clean(m.subtitle) || null,
          poster: m.cover || null,
          author: names(m.author)[0] || author || null,
          narrator: narratorList.length ? narratorList.join(", ") : null,
          description: clean(m.description) || null,
          publisher: clean(m.publisher) || null,
          year: m.publishedYear ? String(m.publishedYear).slice(0, 4) : null,
          duration: m.duration ? String(m.duration) : null,
          language: clean(m.language) || null,
          series: series ? series.name : null,
          seriesIndex: series ? series.index : null,
          genres: genres.slice(0, 5),
        };
      }
    }
  } catch (_) {
    out = null;
  }

  cache.set(key, out);
  return out;
}

module.exports = {
  lookup,
  ENABLED,
  REGION,
  _cache: cache,
  _scoreMatch: scoreMatch,
  _pickSeries: pickSeries,
  _splitNarrators: splitNarrators,
  _dedupeGenres: dedupeGenres,
};

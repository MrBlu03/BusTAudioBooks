// src/recs.js
// Read side of the personal recommendations: loads the list produced by
// `node scripts/refresh-recs.js` and exposes the playable releases in it.
//
// The write side deliberately lives in a script rather than in the request
// path. Two reasons, both learned the hard way:
//
//  1. Generation calls a model. A Stremio catalogue request must never block on
//     that, and must not be able to spend tokens.
//
//  2. Resolving a title to a release means a source request per book. Doing
//     that in the request handler fires them all at once, and AudiobookBay
//     answers a burst with an empty page or its front page rather than results.
//     Measured: "A Game of Thrones" resolves on its own and returns nothing in
//     a batch of sixteen.
//
// So the script resolves each suggestion once, politely, and stores the winning
// release. This module only reads that file, and a recommendation with no
// release is not shown — better a short row than a dead tile.

const fs = require("fs");
const path = require("path");
const { TTLCache } = require("./cache");
const { cleanTitle } = require("./metadata");

const RECS_FILE = process.env.RECS_FILE || path.join(__dirname, "..", ".recs.json");

// The file only changes when the script runs, but re-reading it is cheap and
// picking up a fresh list without a restart is convenient.
const cache = new TTLCache(30 * 1000, 4);

function readRecsFile() {
  try {
    const raw = fs.readFileSync(RECS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch (_) {
    return null; // absent or unreadable
  }
}

/**
 * The current recommendations, or an empty list when the feature has not been
 * set up yet. Never throws.
 *
 * Only entries that carry a resolved `release` are returned. The script looks
 * each suggestion up in the index and drops the ones it cannot find, so an
 * entry without a release is a recommendation that would render as a dead
 * tile. The addon does no searching of its own: see resolveRecs() in
 * scripts/refresh-recs.js for why that has to happen offline.
 *
 * @returns {{generatedAt: string|null, model: string|null, items: Array}}
 */
function getRecs() {
  const hit = cache.get("recs");
  if (hit !== undefined) return hit;

  const parsed = readRecsFile();
  const out = parsed
    ? {
        generatedAt: parsed.generatedAt || null,
        model: parsed.model || null,
        basedOnCount: parsed.basedOnCount || null,
        // The file is written by a model, so treat every field as untrusted:
        // entries can be null, or objects missing the keys we expect.
        items: (Array.isArray(parsed.items) ? parsed.items : [])
          .filter((r) => r && typeof r === "object" && r.release && typeof r.release === "object")
          .map((r) => ({
            title: String(r.title || "").trim(),
            author: r.author ? String(r.author).trim() : null,
            reason: r.reason ? String(r.reason).trim() : null,
            release: {
              name: String(r.release.name || "").trim(),
              infohash: r.release.infohash || null,
              magnet: r.release.magnet || null,
              // Jackett hands back a /dl/ endpoint with neither hash nor magnet and
              // resolves it to a torrent at play time, so it is a third valid way
              // for a release to be fetchable. Without this, every Jackett-only hit
              // was filtered out here and the row lost a third of its entries.
              torrentUrl: r.release.torrentUrl || null,
              size: Number(r.release.size) || 0,
              format: r.release.format || null,
              bitrate: r.release.bitrate || null,
            },
          }))
          // Needs some way to fetch the file. A release with no hash, no magnet and
          // no download link cannot be streamed.
          .filter(
            (r) => r.title.length >= 2 && (r.release.infohash || r.release.magnet || r.release.torrentUrl)
          ),
      }
    : { generatedAt: null, model: null, basedOnCount: null, items: [] };

  cache.set("recs", out);
  return out;
}

/** True when there is at least one recommendation to show. */
function hasRecs() {
  return getRecs().items.length > 0;
}

/**
 * Build the search term for a recommendation.
 *
 * AudiobookBay is a literal post-title search, so a clean bare title matches
 * best. Recommendation titles often carry a subtitle or an edition marker
 * ("Sapiens: A Brief History of Humankind", "The Way of Kings: Book One") that
 * the index will not have, and appending the author narrows results too far.
 */
function searchTermFor(rec) {
  const title = String(rec.title || "")
    .replace(/\s*[:–—-]\s*(book\s+(one|two|\d+|i{1,3}v?|first|second|third)\b.*|part\s+\w+\b.*|a brief history.*|the .* series\b.*)$/i, "")
    .replace(/\s*\((unabridged|abridged)[^)]*\)/gi, "")
    .trim();
  return title || String(rec.title || "").trim();
}

/** True when the feature is configured: Nuvio creds present and a recs file exists. */
function isConfigured() {
  return Boolean(process.env.NUVIO_EMAIL && process.env.NUVIO_PASSWORD) && hasRecs();
}

/** Lowercase, strip accents and punctuation, collapse to single spaces. */
function normaliseTitle(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // accents
    .toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Drop everything after the first subtitle separator: "Good Omens: The Nice and
 * Accurate Prophecies" -> "Good Omens".
 *
 * Applied to both sides of the comparison. cleanTitle cannot do this itself,
 * because it only splits on a colon that has whitespace on both sides
 * ("Kings: Book One" stays intact), and torrent releases rarely bother.
 */
function cutSubtitle(s) {
  const cut = String(s || "").split(/\s*[:–—]\s*/)[0];
  return (cut || String(s || "")).trim();
}

/**
 * Does a search hit actually correspond to the book we asked for?
 *
 * This is a safety net, not a ranking aid. AudiobookBay throttles bursts of
 * requests, and when it does it can answer with its generic front page instead
 * of search results. Serving that verbatim would put the reader's own library
 * (Foundation, Dune, Harry Potter) into a "Recommended For You" row, which is
 * worse than showing nothing.
 *
 * So require a whole-title match after normalisation, allowing only the common
 * release variants: a leading article dropped or moved to the end ("Hobbit, The"),
 * and a series/edition suffix on the hit ("The Hobbit: Unabridged").
 *
 * Deliberately strict. Token-overlap scoring was already found to be wrong for
 * series books: it matches "Forward the Foundation" against "Foundation and
 * Earth" on the token "Foundation".
 *
 * @param hitName  the release name returned by the source
 * @param wanted   the title we searched for
 */
function titleMatches(hitName, wanted) {
  // Both sides lose their subtitle, so a rec phrased with one still matches a
  // release that omits it, and vice versa.
  const want = normaliseTitle(cutSubtitle(wanted));
  if (!want) return false;

  // The hit is torrent noise, so reduce it to its title via the same parser the
  // rest of the addon uses, then drop any trailing series/edition fragment.
  let hit = normaliseTitle(cutSubtitle(cleanTitle(hitName)));
  if (!hit) return false;

  // "hobbit the" -> "the hobbit": releases flip the leading article.
  const flipped = hit.replace(/^(\w+)\s+the$/, "the $1");
  if (flipped !== hit) hit = flipped;

  // Drop a trailing "book 3", "part two", "unabridged" etc. from the hit so
  // "The Hobbit: Book 1" still matches "The Hobbit".
  hit = hit
    .replace(/\s+(book|booklet|volume|vol|part)\s+\S+$/, "")
    .replace(/\s+(unabridged|abridged|deluxe|complete)\s*$/, "")
    .trim();

  // Subtitle handling is done above, on both sides. Note what is NOT allowed:
  // any hit that merely *starts with* the wanted title. That accepted
  // "Foundation and Empire" as "Foundation".
  return hit === want;
}

module.exports = {
  getRecs,
  hasRecs,
  isConfigured,
  RECS_FILE,
  searchTermFor,
  titleMatches,
  _searchTermFor: searchTermFor,
  _readRecsFile: readRecsFile,
  _normaliseTitle: normaliseTitle,
  _cutSubtitle: cutSubtitle,
};

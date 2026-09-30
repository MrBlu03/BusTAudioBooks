// src/recs.js
// Read side of the personal recommendations: loads the list produced by
// `node scripts/refresh-recs.js` and exposes the playable releases in it.
//
// Supports per-user recommendations when a user's Nuvio profile is configured
// in their install URL segment, falling back to the default .recs.json.

const fs = require("fs");
const path = require("path");
const { TTLCache } = require("./cache");
const { cleanTitle } = require("./metadata");

const RECS_FILE = process.env.RECS_FILE || path.join(__dirname, "..", ".recs.json");

// The file only changes when the script runs, but re-reading it is cheap and
// picking up a fresh list without a restart is convenient.
const cache = new TTLCache(30 * 1000, 10);

function readRecsFile(filePath = RECS_FILE) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

/**
 * The current recommendations, or an empty list when the feature has not been
 * set up yet. Never throws.
 *
 * @param {object|null} cfg Optional user configuration segment
 * @returns {{generatedAt: string|null, model: string|null, items: Array}}
 */
function getRecs(cfg = null) {
  const profileId =
    cfg?.nuvioProfileId ||
    (cfg?.nuvio && cfg.nuvio.profileId) ||
    null;

  const cacheKey = profileId ? `recs:${profileId}` : "recs";
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;

  let parsed = null;
  if (profileId) {
    const userRecsFile = path.join(__dirname, "..", `.recs-${profileId}.json`);
    parsed = readRecsFile(userRecsFile);
  }
  if (!parsed) {
    parsed = readRecsFile(RECS_FILE);
  }

  const out = parsed
    ? {
        generatedAt: parsed.generatedAt || null,
        model: parsed.model || null,
        basedOnCount: parsed.basedOnCount || null,
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
              torrentUrl: r.release.torrentUrl || null,
              size: Number(r.release.size) || 0,
              format: r.release.format || null,
              bitrate: r.release.bitrate || null,
            },
          }))
          .filter(
            (r) => r.title.length >= 2 && (r.release.infohash || r.release.magnet || r.release.torrentUrl)
          ),
      }
    : { generatedAt: null, model: null, basedOnCount: null, items: [] };

  cache.set(cacheKey, out);
  return out;
}

/** True when there is at least one recommendation to show. */
function hasRecs(cfg = null) {
  return getRecs(cfg).items.length > 0;
}

/**
 * Build the search term for a recommendation.
 */
function searchTermFor(rec) {
  const title = String(rec.title || "")
    .replace(/\s*[:–—-]\s*(book\s+(one|two|\d+|i{1,3}v?|first|second|third)\b.*|part\s+\w+\b.*|a brief history.*|the .* series\b.*)$/i, "")
    .replace(/\s*\((unabridged|abridged)[^)]*\)/gi, "")
    .trim();
  return title || String(rec.title || "").trim();
}

/** True when the feature is configured: Nuvio creds present and a recs file exists. */
function isConfigured(cfg = null) {
  const hasEnv = Boolean(process.env.NUVIO_EMAIL && process.env.NUVIO_PASSWORD);
  const hasUser = Boolean(cfg && (cfg.nuvioEmail || (cfg.nuvio && cfg.nuvio.email)));
  return (hasEnv || hasUser) && hasRecs(cfg);
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
 * Drop everything after the first subtitle separator.
 */
function cutSubtitle(s) {
  const cut = String(s || "").split(/\s*[:–—]\s*/)[0];
  return (cut || String(s || "")).trim();
}

/**
 * Strict title matching safety net.
 */
function titleMatches(hitName, wanted) {
  const want = normaliseTitle(cutSubtitle(wanted));
  if (!want) return false;

  let hit = normaliseTitle(cutSubtitle(cleanTitle(hitName)));
  if (!hit) return false;

  const flipped = hit.replace(/^(\w+)\s+the$/, "the $1");
  if (flipped !== hit) hit = flipped;

  hit = hit
    .replace(/\s+(book|booklet|volume|vol|part)\s+\S+$/, "")
    .replace(/\s+(unabridged|abridged|deluxe|complete)\s*$/, "")
    .trim();

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

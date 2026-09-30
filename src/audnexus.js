// src/audnexus.js
// Audnexus + Audible API metadata provider.
// Architecture inspired by seanap/Audiobooks.bundle and djdembeck/Audnexus.bundle for Plex.
//
// 1. Searches Audible Catalog API (api.audible.com) to find the ASIN.
// 2. Fetches rich metadata, studio cover art, narrator, series numbering,
//    and ratings from Audnexus (api.audnex.us).
//
// Disable with AUDNEXUS_ENABLED=0 to bypass.

const { TTLCache, withTimeout, pLimit } = require("./cache");

const AUDIBLE_BASE = "https://api.audible.com/1.0/catalog/products";
const AUDNEXUS_BASE = "https://api.audnex.us/books";
const ENABLED = process.env.AUDNEXUS_ENABLED !== "0";

const cache = new TTLCache(24 * 60 * 60 * 1000, 3000); // 24h
const limit = pLimit(4); // Respect community API limits

function cleanTitleForSearch(title) {
  return String(title || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\b(?:complete|series|collection|saga|trilogy|set|audiobooks?|unabridged|abridged)\b/gi, " ")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Find ASIN from Audible Catalog API.
 * Tries with title + author first; falls back to title alone if needed.
 */
async function findAsin(title, author) {
  const cleanTitle = cleanTitleForSearch(title);
  if (!cleanTitle || cleanTitle.length < 2) return null;

  const tryQuery = async (t, a) => {
    const params = new URLSearchParams({
      title: t,
      num_results: "3",
      products_sort_by: "Relevance",
    });
    if (a) params.set("author", a);

    const res = await fetch(`${AUDIBLE_BASE}?${params.toString()}`, {
      headers: { Accept: "application/json", "User-Agent": "bustaudio-addon/2.4" },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const products = Array.isArray(data.products) ? data.products : [];
    if (!products.length) return null;
    return products[0].asin || null;
  };

  try {
    let asin = author ? await tryQuery(cleanTitle, author) : null;
    if (!asin) asin = await tryQuery(cleanTitle, null);
    return asin;
  } catch (_) {
    return null;
  }
}

/**
 * Fetch book details from Audnexus by ASIN.
 */
async function fetchAudnexusByAsin(asin) {
  if (!asin) return null;
  const res = await fetch(`${AUDNEXUS_BASE}/${encodeURIComponent(asin)}`, {
    headers: { Accept: "application/json", "User-Agent": "bustaudio-addon/2.4" },
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) return null;
  return await res.json();
}

// Clean and upscale Audible/Amazon artwork to uncompressed studio master resolution
function cleanAudiblePoster(url) {
  if (!url) return null;
  let clean = String(url).replace(/^http:/, "https:");
  if (/(?:media-amazon|ssl-images-amazon|audible)\.com/i.test(clean)) {
    // Strip downscaling modifiers like ._SL500_ or ._SX300_ to load full uncompressed studio art
    clean = clean.replace(/\._S[LXYZ]\d+.*?\.(jpg|jpeg|png)$/i, (m, ext) => "." + ext);
  }
  return clean;
}

// Clean HTML tags and trailing Audible copyright/disclaimer lines from plot summaries
function cleanSynopsis(raw) {
  if (!raw) return null;
  return String(raw)
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&#0?38;/g, "&")
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8211;/g, "\u2013")
    .replace(/&#8212;/g, "\u2014")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/©\d{4}.*$/i, "")
    .replace(/\(P\)\d{4}.*$/i, "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Lookup audiobook metadata via Audnexus / Audible pipeline.
 *
 * @param {string} title
 * @param {string} [author]
 * @returns {Promise<object|null>}
 */
async function lookupAudnexus(title, author) {
  if (!ENABLED || !title) return null;

  const cacheKey = `${String(title).toLowerCase()}|${String(author || "").toLowerCase()}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;

  const result = await limit(async () => {
    try {
      const asin = await withTimeout(findAsin(title, author), 3000, null);
      if (!asin) return null;

      const data = await withTimeout(fetchAudnexusByAsin(asin), 3000, null);
      if (!data) return null;

      // Extract high-res master art (often 2400x2400 Amazon studio file)
      const poster = cleanAudiblePoster(data.image) || null;

      // Extract author string
      const authorFound = Array.isArray(data.authors) && data.authors.length > 0
        ? data.authors.map((a) => a.name).filter(Boolean).join(", ")
        : author || null;

      // Extract narrators
      const narrator = Array.isArray(data.narrators) && data.narrators.length > 0
        ? data.narrators.map((n) => n.name).filter(Boolean).join(", ")
        : null;

      // Extract series info
      const s = data.seriesPrimary || (Array.isArray(data.series) ? data.series[0] : null);
      const series = s ? s.name : null;
      const seriesIndex = s ? s.position : null;

      // Extract description
      const description = cleanSynopsis(data.description || data.summary) || null;

      // Extract year
      const year = data.releaseDate ? String(data.releaseDate).slice(0, 4) : null;

      // Duration in minutes
      const duration = typeof data.runtimeLengthMin === "number" ? data.runtimeLengthMin : null;

      // Extract genres
      const genres = Array.isArray(data.genres)
        ? data.genres.map((g) => (typeof g === "object" ? g.name : g)).filter(Boolean)
        : [];

      // Extract rating
      const rating = data.rating ? String(data.rating).trim() : null;

      return {
        title: data.title || title,
        subtitle: data.subtitle ? cleanSynopsis(data.subtitle) : null,
        poster,
        author: authorFound,
        narrator,
        series,
        seriesIndex,
        description,
        year,
        duration,
        genres,
        rating,
        asin,
        source: "audnexus",
      };
    } catch (_) {
      return null;
    }
  })();

  cache.set(cacheKey, result);
  return result;
}

module.exports = {
  lookupAudnexus,
  cleanTitleForSearch,
  cleanAudiblePoster,
  cleanSynopsis,
  _cache: cache,
};

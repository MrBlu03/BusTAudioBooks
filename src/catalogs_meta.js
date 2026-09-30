// src/catalogs_meta.js
// Dynamic metadata-level catalog generation with scheduled regular refreshes.
// Pulls live bestsellers, genres, franchises, and author catalogs directly from
// Audible's official Catalog API and Open Library, with zero hardcoded fallbacks.

const { TTLCache, withTimeout, pLimit } = require("./cache");
const { cleanAudiblePoster, cleanSynopsis } = require("./audnexus");
const { cleanDisplayTitle, parseSeriesAndBook } = require("./series");

const AUDIBLE_API = "https://api.audible.com/1.0/catalog/products";
const OPEN_LIBRARY_SUBJECTS = "https://openlibrary.org/subjects";

// 6-hour cache TTL for catalog entries. Background refresher updates them periodically.
const CATALOG_TTL = 6 * 60 * 60 * 1000;
const catalogCache = new TTLCache(CATALOG_TTL, 200);

// Concurrency limiter for catalog queries
const fetchLimit = pLimit(2);

/**
 * Maps genre names to Audible query parameters:
 * - category_id: Canonical Audible category ID
 * - keywords: Target search keywords / sub-genres / author / franchise
 * - products_sort_by: BestSellers (or Relevance)
 */
const AUDIBLE_GENRE_MAP = {
  // -- default / featured ----------------------------------------------------
  "popular & trending": { products_sort_by: "BestSellers" },
  "popular series": { keywords: "series", products_sort_by: "BestSellers" },

  // -- fiction ---------------------------------------------------------------
  "science fiction": { category_id: "18580606011", keywords: "science fiction", products_sort_by: "BestSellers" },
  "fantasy & magic": { category_id: "18580606011", keywords: "fantasy", products_sort_by: "BestSellers" },
  "literary fiction": { category_id: "18574426011", products_sort_by: "BestSellers" },
  "mystery & detective": { category_id: "18574597011", keywords: "mystery", products_sort_by: "BestSellers" },
  "thriller & suspense": { category_id: "18574597011", keywords: "thriller", products_sort_by: "BestSellers" },
  "crime & true crime": { category_id: "18574597011", keywords: "true crime", products_sort_by: "BestSellers" },
  "horror": { category_id: "18574426011", keywords: "horror", products_sort_by: "BestSellers" },
  "romance": { category_id: "18580518011", products_sort_by: "BestSellers" },
  "historical fiction": { category_id: "18574426011", keywords: "historical fiction", products_sort_by: "BestSellers" },
  "dystopian & post-apocalyptic": { category_id: "18580606011", keywords: "dystopian", products_sort_by: "BestSellers" },
  "adventure & action": { category_id: "18574426011", keywords: "action adventure", products_sort_by: "BestSellers" },

  // -- non-fiction -----------------------------------------------------------
  "biographies & memoirs": { category_id: "18571951011", products_sort_by: "BestSellers" },
  "history": { category_id: "18573518011", products_sort_by: "BestSellers" },
  "politics & social science": { category_id: "18574641011", products_sort_by: "BestSellers" },
  "business, money & finance": { category_id: "18572029011", products_sort_by: "BestSellers" },
  "science & technology": { category_id: "18580540011", products_sort_by: "BestSellers" },
  "psychology & mental health": { category_id: "18573370011", keywords: "psychology", products_sort_by: "BestSellers" },
  "health, fitness & nutrition": { category_id: "18573370011", products_sort_by: "BestSellers" },
  "relationships & family": { category_id: "18574784011", products_sort_by: "BestSellers" },
  "self-help & personal development": { category_id: "18574784011", keywords: "self help", products_sort_by: "BestSellers" },
  "religion & spirituality": { category_id: "18574839011", products_sort_by: "BestSellers" },
  "art & design": { category_id: "18571910011", products_sort_by: "BestSellers" },
  "cooking & food": { category_id: "18573701011", keywords: "cookbook", products_sort_by: "BestSellers" },
  "travel & culture": { category_id: "18581095011", products_sort_by: "BestSellers" },
  "sports & recreation": { category_id: "18580648011", products_sort_by: "BestSellers" },

  // -- kids & teens ----------------------------------------------------------
  "teen & young adult": { category_id: "18580715011", products_sort_by: "BestSellers" },
  "children's audiobooks": { category_id: "18572091011", products_sort_by: "BestSellers" },

  // -- franchises ------------------------------------------------------------
  "star wars": { keywords: "Star Wars", products_sort_by: "BestSellers" },
  "harry potter": { keywords: "Harry Potter", products_sort_by: "BestSellers" },
  "discworld": { keywords: "Discworld", products_sort_by: "BestSellers" },
  "a song of ice & fire": { keywords: "A Song of Ice and Fire", products_sort_by: "BestSellers" },
  "the wheel of time": { keywords: "Wheel of Time", products_sort_by: "BestSellers" },
  "sherlock holmes": { keywords: "Sherlock Holmes", products_sort_by: "BestSellers" },
  "the expanse": { keywords: "The Expanse", products_sort_by: "BestSellers" },
  "red rising": { keywords: "Red Rising", products_sort_by: "BestSellers" },

  // -- popular authors -------------------------------------------------------
  "andy weir": { keywords: "Andy Weir", products_sort_by: "BestSellers" },
  "brandon sanderson": { keywords: "Brandon Sanderson", products_sort_by: "BestSellers" },
  "stephen king": { keywords: "Stephen King", products_sort_by: "BestSellers" },
  "agatha christie": { keywords: "Agatha Christie", products_sort_by: "BestSellers" },
  "j.r.r. tolkien": { keywords: "Tolkien", products_sort_by: "BestSellers" },
  "george r.r. martin": { keywords: "George R.R. Martin", products_sort_by: "BestSellers" },
};

/**
 * Maps openlibrary subjects as a graceful fallback when Audible is unavailable.
 */
const OPEN_LIBRARY_SUBJECT_MAP = {
  "science fiction": "science_fiction",
  "fantasy & magic": "fantasy",
  "mystery & detective": "mystery",
  "thriller & suspense": "thriller",
  "horror": "horror",
  "romance": "romance",
  "history": "history",
  "biographies & memoirs": "biography",
};

/**
 * Normalizes an Audible product into an addon catalog item.
 */
function normalizeAudibleProduct(p) {
  if (!p || !p.title) return null;
  // Discard non-English products to maintain clean audio catalogs
  if (p.language && !p.language.toLowerCase().includes("english")) return null;

  const author = (p.authors && p.authors[0] && p.authors[0].name) || null;
  const title = cleanDisplayTitle(p.title)
    .replace(/:\s*(?:A Novel|An Audible Original|A Memoir|A Thriller)$/i, "")
    .trim();
  const poster = cleanAudiblePoster(
    p.product_images && (p.product_images["500"] || p.product_images["1024"] || p.product_images[0])
  );
  const synopsis = cleanSynopsis(p.merchandising_summary || p.product_desc || p.publisher_summary);
  const year = p.release_date ? String(p.release_date).slice(0, 4) : null;

  const seriesObj = Array.isArray(p.series) && p.series[0];
  const sInfo = parseSeriesAndBook(p.title, author, seriesObj ? seriesObj.title : null);

  const seriesName = (seriesObj && seriesObj.title) || (sInfo && sInfo.seriesName) || null;
  const bookNumber = seriesObj && seriesObj.sequence ? parseFloat(seriesObj.sequence) : (sInfo ? sInfo.bookNumber : null);
  const isSeries = !!(sInfo && sInfo.isCollection);

  return {
    name: title,
    author,
    poster: poster || undefined,
    posterShape: "square",
    asin: p.asin || null,
    seriesName: seriesName || undefined,
    bookNumber: bookNumber != null && !isNaN(bookNumber) ? bookNumber : undefined,
    isSeries,
    description: synopsis || undefined,
    year: year || undefined,
  };
}

/**
 * Fetches dynamic catalog audiobooks from Audible Catalog API.
 */
async function fetchCatalogFromAudible(genreName, { limitCount = 50 } = {}) {
  const key = String(genreName || "").trim().toLowerCase();
  const queryConfig = AUDIBLE_GENRE_MAP[key] || {
    keywords: genreName,
    products_sort_by: "BestSellers",
  };

  const params = new URLSearchParams({
    num_results: String(Math.min(limitCount, 50)),
    response_groups: "product_desc,contributors,product_attrs,media,series",
    products_sort_by: queryConfig.products_sort_by || "BestSellers",
  });

  if (queryConfig.category_id) {
    params.set("category_id", queryConfig.category_id);
  }
  if (queryConfig.keywords) {
    params.set("keywords", queryConfig.keywords);
  }

  const res = await fetch(`${AUDIBLE_API}?${params.toString()}`, {
    headers: { Accept: "application/json", "User-Agent": "bustaudio-addon/2.5" },
    signal: AbortSignal.timeout(4500),
  });

  if (!res.ok) {
    throw new Error(`Audible API error ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();
  const products = Array.isArray(data.products) ? data.products : [];
  if (!products.length) return [];

  const items = [];
  const seen = new Set();

  for (const p of products) {
    const item = normalizeAudibleProduct(p);
    if (!item) continue;
    const dedupeKey = `${(item.name || "").toLowerCase()}|${(item.author || "").toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    items.push(item);
  }

  return items;
}

/**
 * Fallback to Open Library when Audible is temporarily unreachable.
 */
async function fetchCatalogFromOpenLibrary(genreName, { limitCount = 20 } = {}) {
  const key = String(genreName || "").trim().toLowerCase();
  const subject = OPEN_LIBRARY_SUBJECT_MAP[key] || key.replace(/\s+&?\s*/g, "_");

  const res = await fetch(`${OPEN_LIBRARY_SUBJECTS}/${subject}.json?limit=${limitCount}`, {
    headers: { "User-Agent": "bustaudio-addon/2.5" },
    signal: AbortSignal.timeout(3500),
  });

  if (!res.ok) return [];
  const data = await res.json();
  const works = Array.isArray(data.works) ? data.works : [];

  const items = [];
  for (const w of works) {
    if (!w.title) continue;
    const author = w.authors && w.authors[0] && w.authors[0].name ? w.authors[0].name : null;
    const poster = w.cover_id ? `https://covers.openlibrary.org/b/id/${w.cover_id}-L.jpg` : undefined;
    items.push({
      name: cleanDisplayTitle(w.title),
      author,
      poster,
      posterShape: "square",
      asin: null,
      isSeries: false,
    });
  }

  return items;
}

/**
 * Retrieve catalog audiobooks for a genre.
 * Serves immediately from cache if available and fresh.
 * Otherwise fetches dynamically and updates the cache.
 */
async function getCatalogBooks(genreName, { refresh = false } = {}) {
  const cacheKey = String(genreName || "").trim().toLowerCase();
  if (!cacheKey) return [];

  if (!refresh) {
    const cached = catalogCache.get(cacheKey);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      return cached;
    }
  }

  return fetchLimit(async () => {
    // Re-check after acquiring lock in case another request filled it
    if (!refresh) {
      const cached = catalogCache.get(cacheKey);
      if (cached && Array.isArray(cached) && cached.length > 0) {
        return cached;
      }
    }

    try {
      const items = await withTimeout(fetchCatalogFromAudible(genreName), 5000, null);
      if (Array.isArray(items) && items.length > 0) {
        catalogCache.set(cacheKey, items);
        return items;
      }
    } catch (err) {
      console.warn(`[catalog] Audible fetch failed for "${genreName}":`, err.message);
    }

    // Secondary fallback to Open Library if Audible query fails
    try {
      const olItems = await withTimeout(fetchCatalogFromOpenLibrary(genreName), 4000, null);
      if (Array.isArray(olItems) && olItems.length > 0) {
        catalogCache.set(cacheKey, olItems);
        return olItems;
      }
    } catch (_) {}

    // Fall back to stale cache if present
    const stale = catalogCache.get(cacheKey);
    if (stale) return stale;

    // Never return fake hardcoded placeholders
    return [];
  })();
}

/**
 * Background regular refresher for top featured home rows.
 * Periodically updates the metadata cache so users always get fresh, instant catalogs.
 */
let refresherTimer = null;

function startCatalogRefresher({ intervalMs = CATALOG_TTL } = {}) {
  if (refresherTimer) return;

  const FEATURED_REFRESH_ROWS = [
    "Popular & Trending",
    "Popular Series",
    "Science Fiction",
    "Fantasy & Magic",
    "Horror",
    "Mystery & Detective",
    "Thriller & Suspense",
    "History",
    "Biographies & Memoirs",
    "Teen & Young Adult",
  ];

  async function runRefresh() {
    for (const genre of FEATURED_REFRESH_ROWS) {
      try {
        await getCatalogBooks(genre, { refresh: true });
        // Polite 500ms delay between genre refreshes
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (err) {
        console.warn(`[refresher] background refresh error for "${genre}":`, err.message);
      }
    }
  }

  // Pre-warm asynchronously in background without blocking server startup
  setImmediate(() => {
    runRefresh().catch(() => {});
  });

  // Scheduled interval
  refresherTimer = setInterval(() => {
    runRefresh().catch(() => {});
  }, intervalMs);

  if (refresherTimer.unref) refresherTimer.unref();
}

function stopCatalogRefresher() {
  if (refresherTimer) {
    clearInterval(refresherTimer);
    refresherTimer = null;
  }
}

module.exports = {
  AUDIBLE_GENRE_MAP,
  getCatalogBooks,
  fetchCatalogFromAudible,
  fetchCatalogFromOpenLibrary,
  normalizeAudibleProduct,
  startCatalogRefresher,
  stopCatalogRefresher,
  catalogCache,
};

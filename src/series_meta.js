// src/series_meta.js
// Dynamic metadata-level book series generation and canonical episode ordering.
// Pulls series reading order, book titles, cover art, and descriptions from
// Audible Catalog API and Open Library, with zero hardcoded placeholders.

const { TTLCache, withTimeout, pLimit } = require("./cache");
const { cleanAudiblePoster, cleanSynopsis } = require("./audnexus");
const { cleanDisplayTitle, cleanEpisodeTitle, KNOWN_SERIES, parseSeriesAndBook } = require("./series");
const { encodeItemId } = require("./itemid");

const seriesCache = new TTLCache(24 * 60 * 60 * 1000, 500); // 24h
const limit = pLimit(4);

const AUDIBLE_API = "https://api.audible.com/1.0/catalog/products";

function cleanSeriesQuery(name) {
  return String(name || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(?:complete|series|collection|saga|trilogy|set|audiobooks?|box\s*set)\b/gi, " ")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Dynamically queries Audible Catalog API for products in a series.
 */
async function fetchSeriesFromAudible(seriesName, author = "") {
  const cleanName = cleanSeriesQuery(seriesName);
  if (!cleanName || cleanName.length < 2) return null;

  const q = author ? `${cleanName} ${author}` : cleanName;
  const params = new URLSearchParams({
    keywords: q,
    num_results: "30",
    response_groups: "product_desc,series,contributors,product_attrs,media",
    products_sort_by: "Relevance",
  });

  const res = await fetch(`${AUDIBLE_API}?${params.toString()}`, {
    headers: { Accept: "application/json", "User-Agent": "bustaudio-addon/2.5" },
    signal: AbortSignal.timeout(3500),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const products = Array.isArray(data.products) ? data.products : [];
  if (!products.length) return null;

  const lowerTarget = cleanName.toLowerCase();
  const lowerAuthor = String(author || "").toLowerCase().trim();

  // Filter products belonging to this series
  const candidates = [];
  for (const p of products) {
    if (!p.title) continue;
    // Filter out non-English translations
    if (p.language && !p.language.toLowerCase().includes("english")) continue;

    const seriesList = Array.isArray(p.series) ? p.series : [];
    // Prioritize exact series title match first, then substring
    const matchedSeries =
      seriesList.find((s) => String(s.title || "").toLowerCase() === lowerTarget) ||
      seriesList.find((s) => {
        const st = String(s.title || "").toLowerCase();
        return st.includes(lowerTarget) || lowerTarget.includes(st);
      }) ||
      (lowerAuthor && seriesList[0]);

    if (!matchedSeries || !matchedSeries.sequence) continue;

    const seq = parseFloat(matchedSeries.sequence);
    if (isNaN(seq) || seq <= 0) continue;

    const auth = (p.authors && p.authors[0] && p.authors[0].name) || author || null;
    const desc = cleanSynopsis(p.merchandising_summary || p.product_desc || p.publisher_summary);
    const poster = cleanAudiblePoster(p.product_images && (p.product_images[500] || p.product_images[1024] || p.product_images[0]));
    const year = p.release_date ? String(p.release_date).slice(0, 4) : null;

    const isDramatized = /dramatized|part \d of \d|sample/i.test(p.title);

    candidates.push({
      seq,
      title: cleanDisplayTitle(p.title),
      author: auth,
      asin: p.asin,
      poster,
      year,
      description: desc,
      isDramatized,
      seriesTitle: matchedSeries.title || seriesName,
    });
  }

  if (!candidates.length) return null;

  // Deduplicate by sequence number: prefer standard full edition over dramatized/parts
  const bySeq = new Map();
  for (const c of candidates) {
    const existing = bySeq.get(c.seq);
    if (!existing) {
      bySeq.set(c.seq, c);
    } else if (existing.isDramatized && !c.isDramatized) {
      bySeq.set(c.seq, c);
    }
  }

  const sortedBooks = Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
  const detectedSeriesName = (candidates.find((c) => c.seriesTitle) || {}).seriesTitle || seriesName;
  const detectedAuthor = (candidates.find((c) => c.author) || {}).author || author;

  return {
    seriesName: detectedSeriesName,
    author: detectedAuthor,
    books: sortedBooks,
    source: "audible",
  };
}

/**
 * Fallback to Open Library for series catalog search.
 */
async function fetchSeriesFromOpenLibrary(seriesName, author = "") {
  try {
    const cleanName = cleanSeriesQuery(seriesName);
    const q = `series:"${cleanName}"`;
    const res = await fetch(
      `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=25`,
      {
        headers: { "User-Agent": "bustaudio-addon/2.5" },
        signal: AbortSignal.timeout(3000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const docs = Array.isArray(data.docs) ? data.docs : [];
    if (!docs.length) return null;

    const books = [];
    const seen = new Set();

    for (const d of docs) {
      if (!d.title) continue;
      const lower = d.title.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);

      const parsed = parseSeriesAndBook(d.title, author, seriesName);
      const seq = parsed && parsed.bookNumber != null ? parsed.bookNumber : books.length + 1;
      const poster = d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null;

      books.push({
        seq,
        title: cleanDisplayTitle(d.title),
        author: (d.author_name && d.author_name[0]) || author || null,
        poster,
        year: d.first_publish_year ? String(d.first_publish_year) : null,
        description: null,
      });
    }

    if (!books.length) return null;
    books.sort((a, b) => a.seq - b.seq);

    return {
      seriesName,
      author: (docs[0].author_name && docs[0].author_name[0]) || author || null,
      books,
      source: "openlibrary",
    };
  } catch (_) {
    return null;
  }
}

/**
 * Fallback using KNOWN_SERIES regex rules when offline or APIs are unresponsive.
 */
function fetchSeriesFromKnown(seriesName, author = "") {
  const lower = String(seriesName || "").toLowerCase();
  const found = KNOWN_SERIES.find(
    (s) => s.name.toLowerCase() === lower || s.match.test(lower)
  );
  if (!found || !Array.isArray(found.books)) return null;

  const books = found.books.map((b) => ({
    seq: b.num,
    title: String(b.match.source || b.match)
      .replace(/[\\^$()|?+*\[\]{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(" "),
    author: author || null,
    poster: null,
    year: null,
    description: null,
  }));

  books.sort((a, b) => a.seq - b.seq);
  return {
    seriesName: found.name.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
    author,
    books,
    source: "known",
  };
}

/**
 * Dynamically search for the official series / box set / collection cover art.
 */
async function findCollectionCover(seriesName, author = "") {
  if (!seriesName) return null;
  const cleanName = cleanSeriesQuery(seriesName);

  // 1. Check Audible for a collection / box set / complete edition of this series
  try {
    const q = `${cleanName} collection`;
    const params = new URLSearchParams({
      keywords: q,
      num_results: "8",
      response_groups: "product_desc,media,contributors",
      products_sort_by: "Relevance",
    });
    const res = await fetch(`${AUDIBLE_API}?${params.toString()}`, {
      headers: { Accept: "application/json", "User-Agent": "bustaudio-addon/2.5" },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      const lower = cleanName.toLowerCase();
      const hit = (data.products || []).find((p) => {
        const title = String(p.title || "").toLowerCase();
        const hasColWord = /collection|box\s*set|complete|saga|trilogy|set|chronicles/i.test(title);
        const matchesSeries = title.includes(lower);
        return hasColWord && matchesSeries && p.product_images && (p.product_images[500] || p.product_images[1024] || p.product_images[0]);
      });
      if (hit && hit.product_images) {
        const img = hit.product_images[500] || hit.product_images[1024] || hit.product_images[0];
        if (img) return cleanAudiblePoster(img);
      }
    }
  } catch (_) {}

  // 2. Fallback to Open Library for Boxed Set / Collection
  try {
    const olUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(`${cleanName} Boxed Set`)}&limit=5`;
    const olRes = await fetch(olUrl, {
      headers: { "User-Agent": "bustaudio-addon/2.5" },
      signal: AbortSignal.timeout(3000),
    });
    if (olRes.ok) {
      const olData = await olRes.json();
      const hit = (olData.docs || []).find((d) => d.cover_i && /box|collection|trilogy|set|complete/i.test(d.title || ""));
      if (hit && hit.cover_i) {
        return `https://covers.openlibrary.org/b/id/${hit.cover_i}-L.jpg`;
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Fetch series metadata and canonical book reading order dynamically.
 */
async function fetchSeriesBooks(seriesName, author = "") {
  if (!seriesName) return null;
  const cacheKey = `${String(seriesName).toLowerCase()}|${String(author || "").toLowerCase()}`;
  const hit = seriesCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const result = await limit(async () => {
    let seriesObj = null;

    // 1. Audible Catalog API (gold standard for audiobooks)
    try {
      const aud = await withTimeout(fetchSeriesFromAudible(seriesName, author), 3500, null);
      if (aud && aud.books && aud.books.length > 0) seriesObj = aud;
    } catch (_) {}

    // 2. Open Library
    if (!seriesObj) {
      try {
        const ol = await withTimeout(fetchSeriesFromOpenLibrary(seriesName, author), 3000, null);
        if (ol && ol.books && ol.books.length > 0) seriesObj = ol;
      } catch (_) {}
    }

    // 3. Fallback known regex catalog
    if (!seriesObj) {
      seriesObj = fetchSeriesFromKnown(seriesName, author);
    }

    if (seriesObj) {
      const colCover = await withTimeout(findCollectionCover(seriesObj.seriesName, seriesObj.author), 2500, null);
      seriesObj.collectionPoster = colCover || (seriesObj.books[0] && seriesObj.books[0].poster) || null;
    }

    return seriesObj;
  })();

  seriesCache.set(cacheKey, result);
  return result;
}

/**
 * Builds the complete Stremio Series Meta object with canonical episode list.
 */
async function fetchSeriesMeta(seriesName, author = "", extraMeta = {}) {
  const seriesData = await fetchSeriesBooks(seriesName, author);
  const cleanName = seriesData ? seriesData.seriesName : seriesName;
  const effAuthor = (seriesData && seriesData.author) || author || "";
  const books = (seriesData && seriesData.books) || [];

  const displayName = effAuthor
    ? `${cleanName} Series — ${effAuthor}`
    : `${cleanName} (Audiobook Series)`;

  const masterPoster =
    extraMeta.poster ||
    (seriesData && seriesData.collectionPoster) ||
    (books[0] && books[0].poster) ||
    undefined;

  // Build Stremio videos (Episodes representing Book 1, Book 2... in reading order)
  const files = Array.isArray(extraMeta.files) ? extraMeta.files : [];
  const videos = books.map((book, idx) => {
    const bookNum = book.seq != null ? book.seq : idx + 1;
    const epNum = Number.isInteger(bookNum) && bookNum > 0 ? bookNum : idx + 1;

    // Check if a file in the parent torrent matches this specific book
    let matchedTargetFile = undefined;
    if (files.length > 0) {
      const lowerBookTitle = book.title.toLowerCase();
      const matched = files.find((f) => {
        const fn = (f.name || f.short_name || "").toLowerCase();
        if (fn.includes(lowerBookTitle)) return true;
        if (bookNum != null) {
          const numPadded = bookNum < 10 ? `0${bookNum}` : `${bookNum}`;
          const numRegex = new RegExp(`(?:^|[\\s._\\-])0?${bookNum}(?:[\\s._\\-]|$)`, "i");
          if (fn.includes(numPadded) || numRegex.test(fn)) return true;
        }
        return false;
      });
      if (matched) matchedTargetFile = matched.name || matched.short_name;
    }

    const epItemId = encodeItemId({
      type: "series",
      seriesName: cleanName,
      bookNumber: bookNum,
      name: book.title,
      author: book.author || effAuthor,
      parentInfohash: extraMeta.infohash || undefined,
      targetFile: matchedTargetFile,
      isSeries: true,
    });

    return {
      id: epItemId,
      title: `Book ${bookNum}: ${book.title}`,
      season: 1,
      episode: epNum,
      released: book.year || undefined,
      thumbnail: book.poster || masterPoster,
      overview: book.description || undefined,
    };
  });

  const descLines = [
    `📚 Canonical Audiobook Series (${books.length} Books in Reading Order)`,
  ];
  if (effAuthor) descLines.push(`By ${effAuthor}`);
  if (books.length > 0) {
    const bookList = books.slice(0, 10).map((b) => `• Book ${b.seq}: ${b.title}`).join("\n");
    descLines.push(`\nReading Order:\n${bookList}${books.length > 10 ? `\n...and ${books.length - 10} more` : ""}`);
  }

  return {
    type: "series",
    name: displayName,
    poster: masterPoster,
    background: masterPoster,
    posterShape: "square",
    description: descLines.filter(Boolean).join("\n\n"),
    releaseInfo: (books[0] && books[0].year) || undefined,
    genres: [cleanName, "Audiobook", "Series"],
    cast: effAuthor ? [effAuthor] : undefined,
    videos: videos.length > 0 ? videos : undefined,
  };
}

module.exports = {
  fetchSeriesBooks,
  fetchSeriesMeta,
  findCollectionCover,
  cleanSeriesQuery,
  _seriesCache: seriesCache,
};

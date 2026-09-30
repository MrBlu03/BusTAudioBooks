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

function cleanBookTitle(raw) {
  let s = cleanDisplayTitle(raw)
    .replace(/\s*[\(\[](?:Full-Cast|Dramatized|GraphicAudio|Special|Audible|Narrated|Collector's).*?[\)\]]/gi, "")
    .replace(/:\s*(?:unabridged|abridged|a novel|dramatized|full-cast).*$/i, "")
    .replace(/\s*\((?:un)?abridged\)/gi, "")
    .replace(/\s*\([^)]*(?:Series|Trilogy|Saga)[^)]*\)/gi, "");
  s = s.replace(/^.*?,\s*Book\s*\d+\s*:\s*/i, "");
  s = s.replace(/:\s*[^:]{3,40}\s*(?:Series|Trilogy|Saga|Collection|Chronicles|Sequence)\s*:\s*/i, ": ");
  s = s.replace(/:\s*[^:]{3,40},\s*Book\s*\d+.*$/i, "");
  s = s.replace(/\s*,\s*Book\s*\d+/i, "");
  s = s.replace(/\s*\(Book\s*\d+\)/i, "");
  return s.trim();
}

async function queryAudibleCatalog(qStr, numResults = "50") {
  const fetchProducts = async (paramKey) => {
    const params = new URLSearchParams({
      [paramKey]: qStr,
      num_results: String(numResults),
      response_groups: "product_desc,series,contributors,product_attrs,media",
      products_sort_by: "Relevance",
    });
    try {
      const res = await fetch(`${AUDIBLE_API}?${params.toString()}`, {
        headers: { Accept: "application/json", "User-Agent": "bustaudio-addon/2.5" },
        signal: AbortSignal.timeout(3500),
      });
      if (!res.ok) return [];
      const data = await res.json();
      return Array.isArray(data.products) ? data.products : [];
    } catch (_) {
      return [];
    }
  };

  const [byTitle, byKeywords] = await Promise.all([
    fetchProducts("title"),
    fetchProducts("keywords"),
  ]);

  const seenAsin = new Set();
  const combined = [];
  for (const p of [...byTitle, ...byKeywords]) {
    const key = p.asin || p.title;
    if (key && !seenAsin.has(key)) {
      seenAsin.add(key);
      combined.push(p);
    }
  }
  return combined;
}

function extractAudibleCandidates(products, normTarget, normAuthor, seriesName, author) {
  const candidates = [];
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/^(?:the|a|an)\s+/i, "")
      .replace(/\s*[\(\[][^()\[\]]*[\)\]]/g, " ")
      .replace(/[^a-z0-9]/g, "");

  for (const p of products) {
    if (!p.title) continue;
    // Filter out non-English translations
    if (p.language && !p.language.toLowerCase().includes("english")) continue;

    const rawTitle = String(p.title || "");
    // Filter out parodies, unofficial guides, summaries, reviews, study guides
    if (/\b(?:parody|unofficial|summary|review|analysis|guide|study\s+guide)\b/i.test(rawTitle)) {
      continue;
    }

    // Filter out box sets / multi-book collections / samplers
    if (/\b(?:collection|box\s*set|boxed\s*set|complete\s*(?:audio\s*)?collection|omnibus|sampler)\b/i.test(rawTitle)) {
      continue;
    }

    // Author filtering: if author is provided, ensure author compatibility
    const pAuthors = (p.authors || []).map((a) => norm(a.name));
    if (normAuthor && pAuthors.length > 0 && !pAuthors.some((a) => a.includes(normAuthor) || normAuthor.includes(a))) {
      continue;
    }

    const seriesList = Array.isArray(p.series) ? p.series : [];
    const pubSeries = seriesList.find((s) => /publication\s*order|release\s*order/i.test(s.title));
    const chronoSeries = seriesList.find((s) => /chronological|author'?s\s*(?:preferred\s*)?order/i.test(s.title));

    // Dynamic series match: exact normalized match first, then prefix/substring match
    const matchedSeries =
      seriesList.find((s) => norm(s.title) === normTarget) ||
      seriesList.find((s) => {
        const st = norm(s.title);
        if (!st || !normTarget) return false;
        if (st === normTarget || st.startsWith(normTarget)) return true;
        if (normTarget.startsWith(st) && st.length / normTarget.length >= 0.75) return true;
        return false;
      });

    if (!matchedSeries && !pubSeries && !chronoSeries) continue;

    // Skip multi-book collections where sequence is a range, e.g. "1-3" or "1-7"
    if (
      (matchedSeries && matchedSeries.sequence && String(matchedSeries.sequence).includes("-")) ||
      (pubSeries && pubSeries.sequence && String(pubSeries.sequence).includes("-")) ||
      (chronoSeries && chronoSeries.sequence && String(chronoSeries.sequence).includes("-"))
    ) {
      continue;
    }

    const baseSeq = matchedSeries && matchedSeries.sequence ? parseFloat(matchedSeries.sequence) : null;
    const pubSeq = pubSeries && pubSeries.sequence ? parseFloat(pubSeries.sequence) : null;
    const chronoSeq = chronoSeries && chronoSeries.sequence ? parseFloat(chronoSeries.sequence) : null;

    const seq = chronoSeq != null ? chronoSeq : (baseSeq != null ? baseSeq : pubSeq);
    if ((seq == null || isNaN(seq) || seq <= 0) && (pubSeq == null || isNaN(pubSeq) || pubSeq <= 0)) continue;

    const auth = (p.authors && p.authors[0] && p.authors[0].name) || author || null;
    const desc = cleanSynopsis(p.merchandising_summary || p.product_desc || p.publisher_summary);
    const poster = cleanAudiblePoster(p.product_images && (p.product_images[500] || p.product_images[1024] || p.product_images[0]));
    const year = p.release_date ? parseInt(String(p.release_date).slice(0, 4), 10) : null;

    const isDramatized = /dramatized|part \d of \d|sample/i.test(p.title);
    const cleanedTitle = cleanBookTitle(p.title);

    candidates.push({
      seq: seq != null && !isNaN(seq) ? seq : 999,
      chronoSeq: chronoSeq != null && !isNaN(chronoSeq) ? chronoSeq : seq,
      pubSeq: pubSeq != null && !isNaN(pubSeq) ? pubSeq : null,
      title: cleanedTitle,
      rawTitle: p.title,
      author: auth,
      asin: p.asin,
      poster,
      year: year || null,
      description: desc,
      isDramatized,
      seriesTitle: (matchedSeries && matchedSeries.title) || (chronoSeries && chronoSeries.title) || (pubSeries && pubSeries.title) || seriesName,
    });
  }
  return candidates;
}

/**
 * Dynamically queries Audible Catalog API for products in a series.
 */
async function fetchSeriesFromAudible(seriesName, author = "") {
  const cleanName = cleanSeriesQuery(seriesName);
  if (!cleanName || cleanName.length < 2) return null;

  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/^(?:the|a|an)\s+/i, "")
      .replace(/\s*[\(\[][^()\[\]]*[\)\]]/g, " ")
      .replace(/[^a-z0-9]/g, "");
  const normTarget = norm(cleanName);
  const normAuthor = norm(author);

  const q = author ? `${cleanName} ${author}` : cleanName;
  let products = await queryAudibleCatalog(q, "50");
  if (!products.length && author) {
    products = await queryAudibleCatalog(cleanName, "50");
  }
  if (!products.length) return null;

  let candidates = extractAudibleCandidates(products, normTarget, normAuthor, seriesName, author);

  // If query was a book title that belongs to a series (e.g. "Heir to the Empire" in "The Thrawn Trilogy"),
  // detect the canonical series title from the returned product's series list and fetch the full series.
  if (!candidates.length) {
    let detectedSeries = null;
    let detectedAuthor = null;
    for (const p of products) {
      if (Array.isArray(p.series) && p.series.length > 0) {
        const sMatch =
          p.series.find((s) => s.title && !/abridged/i.test(s.title) && (s.sequence === "1" || s.sequence === 1)) ||
          p.series.find((s) => s.title && !/abridged/i.test(s.title) && s.sequence);
        if (sMatch) {
          detectedSeries = sMatch.title.replace(/\s*-\s*Legends\b/i, "").trim();
          detectedAuthor = (p.authors && p.authors[0] && p.authors[0].name) || author;
          break;
        }
      }
    }
    if (detectedSeries) {
      const extraProducts = await queryAudibleCatalog(detectedSeries, "50");
      if (extraProducts.length > 0) {
        candidates = extractAudibleCandidates(
          extraProducts,
          norm(detectedSeries),
          norm(detectedAuthor || author),
          detectedSeries,
          detectedAuthor || author
        );
      }
    }
  }

  // If few books found but a canonical series title was detected (e.g. "Percy Jackson and the Olympians" for query "Percy Jackson"),
  // query Audible with the detected canonical title to retrieve all books in the series.
  const canonicalCandidate = candidates.find(
    (c) => c.seriesTitle && norm(c.seriesTitle) !== normTarget && norm(c.seriesTitle).startsWith(normTarget)
  );
  if (canonicalCandidate && candidates.length < 6) {
    const extraProducts = await queryAudibleCatalog(canonicalCandidate.seriesTitle, "50");
    if (extraProducts.length > 0) {
      const extraCandidates = extractAudibleCandidates(extraProducts, norm(canonicalCandidate.seriesTitle), normAuthor, canonicalCandidate.seriesTitle, author);
      candidates = candidates.concat(extraCandidates);
    }
  }

  if (!candidates.length) return null;

  // Author clustering: if author was not provided by caller, ensure books belong to the dominant series author
  if (!normAuthor && candidates.length > 1) {
    const authorCounts = new Map();
    for (const c of candidates) {
      const a = norm(c.author);
      if (a) authorCounts.set(a, (authorCounts.get(a) || 0) + 1);
    }
    let dominantAuthor = null;
    let maxCount = 0;
    for (const [a, count] of authorCounts.entries()) {
      if (count > maxCount) {
        maxCount = count;
        dominantAuthor = a;
      }
    }
    if (dominantAuthor && maxCount >= 2) {
      candidates = candidates.filter((c) => {
        const a = norm(c.author);
        return !a || a.includes(dominantAuthor) || dominantAuthor.includes(a);
      });
    }
  }

  // Deduplicate by clean book title: prefer standard full edition over dramatized/parts, and prefer entries with poster
  const byTitle = new Map();
  for (const c of candidates) {
    const key = c.title
      .toLowerCase()
      .replace(/’/g, "'")
      .replace(/^(?:star\s*wars\s*[:\-–—]?\s*)*/i, "")
      .replace(/^(?:the|a|an)\s+/i, "")
      .replace(/[:\-–—]\s*star\s*wars$/i, "")
      .replace(/[^a-z0-9]/g, "");
    if (!key) continue;
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, c);
    } else {
      // Merge sequences across editions
      if (existing.pubSeq == null && c.pubSeq != null) existing.pubSeq = c.pubSeq;
      if (existing.chronoSeq == null && c.chronoSeq != null) existing.chronoSeq = c.chronoSeq;
      if (existing.seq === 999 && c.seq !== 999) existing.seq = c.seq;
      if (!existing.year && c.year) existing.year = c.year;

      // Prefer unabridged / standard over abridged or dramatized
      const cIsAbridged = /abridged/i.test(c.rawTitle);
      const exIsAbridged = /abridged/i.test(existing.rawTitle);
      if (exIsAbridged && !cIsAbridged) {
        existing.title = c.title;
        existing.rawTitle = c.rawTitle;
        existing.asin = c.asin;
        if (c.poster) existing.poster = c.poster;
        if (c.description) existing.description = c.description;
      } else if (existing.isDramatized && !c.isDramatized) {
        existing.title = c.title;
        existing.rawTitle = c.rawTitle;
        existing.asin = c.asin;
        if (c.poster) existing.poster = c.poster;
        if (c.description) existing.description = c.description;
      } else if (!existing.poster && c.poster) {
        existing.poster = c.poster;
      }
    }
  }

  const sortedBooks = Array.from(byTitle.values()).sort((a, b) => a.seq - b.seq);
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

const pubYearCache = new TTLCache(24 * 60 * 60 * 1000, 2000);
const wikiSeriesCache = new TTLCache(24 * 60 * 60 * 1000, 500);

/**
 * Fast dynamic extraction of publication years directly from Wikipedia Series summary.
 * Resolves dates for an entire book series in a single HTTP request (~250ms).
 */
async function fetchSeriesWikiExtract(seriesName, author = "") {
  if (!seriesName) return null;
  const cleanName = cleanSeriesQuery(seriesName);
  const cacheKey = `${cleanName.toLowerCase()}|${String(author || "").toLowerCase()}`;
  const hit = wikiSeriesCache.get(cacheKey);
  if (hit !== undefined) return hit;

  const slugs = [
    cleanName.replace(/\s+/g, "_") + "_series",
    cleanName.replace(/\s+/g, "_") + "_(novel_series)",
    cleanName.replace(/\s+/g, "_") + "_(series)",
    cleanName.replace(/\s+/g, "_") + "_(franchise)",
    cleanName.replace(/\s+/g, "_"),
  ];

  for (const slug of slugs) {
    try {
      const res = await fetch(
        "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(slug),
        {
          headers: { "User-Agent": "bustaudio-addon/2.5 (contact@bustaudio.app)" },
          signal: AbortSignal.timeout(2000),
        }
      );
      if (res.ok) {
        const d = await res.json();
        if (d.extract && !d.extract.includes("may refer to:")) {
          wikiSeriesCache.set(cacheKey, d.extract);
          return d.extract;
        }
      }
    } catch (_) {}
  }

  wikiSeriesCache.set(cacheKey, null);
  return null;
}

/**
 * Dynamically queries Wikipedia Summary API and Open Library for a book's original publication year.
 */
async function fetchPublicationYear(title, author) {
  if (!title) return null;
  const key = `${String(title).toLowerCase().trim()}:${String(author || "").toLowerCase().trim()}`;
  const hit = pubYearCache.get(key);
  if (hit !== undefined) return hit;

  const lowerTitle = String(title).toLowerCase().trim();

  // 1. Wikipedia Summary API (high speed, accurate first publication date)
  try {
    const q = `"${title}" ${author || ""}`;
    const sRes = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=" + encodeURIComponent(q), {
      headers: { "User-Agent": "BusTAudioBooks/2.5 (contact@github.com)" },
      signal: AbortSignal.timeout(2500),
    });
    if (sRes.ok) {
      const sData = await sRes.json();
      const hits = (sData?.query?.search || []).filter((h) => !/\b(?:series|franchise|universe|adaptations?)\b/i.test(h.title));
      // Prioritize explicit novel/book pages first, then exact title, then substrings
      const matchHit =
        hits.find((h) => /\((?:novel|book|[a-z]+\s+novel)\)/i.test(h.title) && h.title.toLowerCase().includes(lowerTitle)) ||
        hits.find((h) => {
          const ht = h.title.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim();
          return ht === lowerTitle;
        }) ||
        hits.find((h) => {
          const ht = h.title.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim();
          return ht.includes(lowerTitle) || lowerTitle.includes(ht);
        }) ||
        hits[0];

      const orderedHits = matchHit ? [matchHit, ...hits.filter((x) => x !== matchHit)] : hits;

      for (const h of orderedHits.slice(0, 2)) {
        if (!h || !h.title) continue;
        const pRes = await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(h.title), {
          headers: { "User-Agent": "BusTAudioBooks/2.5 (contact@github.com)" },
          signal: AbortSignal.timeout(1800),
        });
        if (pRes.ok) {
          const pData = await pRes.json();
          const extract = pData?.extract || "";
          const pubMatch =
            extract.match(/(?:published|released|appeared)\s+(?:in\s+)?\b(18\d\d|19\d\d|20[0-2]\d)\b/i) ||
            extract.match(/\b(18\d\d|19\d\d|20[0-2]\d)\b(?:\s+novel|\s+science\s+fiction\s+novel|\s+dystopian|\s+fantasy)/i) ||
            extract.match(/\b(18\d\d|19\d\d|20[0-2]\d)\b/);
          if (pubMatch) {
            const yr = parseInt(pubMatch[1], 10);
            if (yr >= 1800 && yr <= new Date().getFullYear()) {
              pubYearCache.set(key, yr);
              return yr;
            }
          }
        }
      }
    }
  } catch (_) {}

  // 2. Open Library fallback
  try {
    const q = new URLSearchParams({ title: title, limit: "1" });
    if (author) q.set("author", author);
    const res = await fetch(`https://openlibrary.org/search.json?${q.toString()}`, {
      headers: { "User-Agent": "bustaudio-addon/2.5" },
      signal: AbortSignal.timeout(1200),
    });
    if (res.ok) {
      const data = await res.json();
      const doc = data.docs && data.docs[0];
      if (doc && doc.first_publish_year) {
        const year = parseInt(doc.first_publish_year, 10);
        if (!isNaN(year) && year >= 1800 && year <= new Date().getFullYear()) {
          pubYearCache.set(key, year);
          return year;
        }
      }
    }
  } catch (_) {}

  pubYearCache.set(key, null);
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

    if (seriesObj && Array.isArray(seriesObj.books) && seriesObj.books.length > 0) {
      const hasPubSeq = seriesObj.books.some((b) => b.pubSeq != null);
      if (!hasPubSeq) {
        // 1. Fast path: try Wikipedia series extract in a single call (~250ms)
        try {
          const wikiExtract = await withTimeout(
            fetchSeriesWikiExtract(seriesObj.seriesName || seriesName, seriesObj.author || author),
            1800,
            null
          );
          if (wikiExtract) {
            for (const b of seriesObj.books) {
              if (!b.originalYear) {
                const esc = b.title.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
                const m1 = wikiExtract.match(new RegExp(`${esc}\\s*\\((\\d{4})\\)`, "i"));
                const m2 = !m1 && wikiExtract.match(new RegExp(`${esc}[^.]{1,50}?\\b(18\\d\\d|19\\d\\d|20[0-2]\\d)\\b`, "i"));
                const yr = m1 ? parseInt(m1[1], 10) : (m2 ? parseInt(m2[1], 10) : null);
                if (yr && yr >= 1800 && yr <= new Date().getFullYear()) {
                  b.originalYear = yr;
                }
              }
            }
          }
        } catch (_) {}

        // 2. Secondary fallback: enrich remaining books concurrently with individual publication years
        const booksToEnrich = seriesObj.books.filter((b) => !b.originalYear).slice(0, 8);
        if (booksToEnrich.length > 0) {
          await Promise.all(
            booksToEnrich.map(async (b) => {
              const y = await withTimeout(
                fetchPublicationYear(b.title, b.author || seriesObj.author || author),
                3500,
                null
              );
              if (y) b.originalYear = y;
            })
          );
        }
      }

      // Chronological reading order (in-universe sequence)
      const chronoBooks = [...seriesObj.books].sort((a, b) => {
        const sa = a.chronoSeq != null ? a.chronoSeq : (a.seq != null ? a.seq : 999);
        const sb = b.chronoSeq != null ? b.chronoSeq : (b.seq != null ? b.seq : 999);
        return sa - sb;
      });

      // Release / publication order (by pubSeq or original publication year)
      const releaseBooks = [...seriesObj.books].sort((a, b) => {
        if (hasPubSeq) {
          const pa = a.pubSeq != null ? a.pubSeq : 999;
          const pb = b.pubSeq != null ? b.pubSeq : 999;
          if (pa !== pb) return pa - pb;
        }

        const ya = a.originalYear != null ? a.originalYear : null;
        const yb = b.originalYear != null ? b.originalYear : null;
        if (ya != null && yb != null && ya !== yb) {
          return ya - yb;
        }
        if (ya != null && yb == null) return -1;
        if (ya == null && yb != null) return 1;

        const sa = a.chronoSeq != null ? a.chronoSeq : (a.seq != null ? a.seq : 999);
        const sb = b.chronoSeq != null ? b.chronoSeq : (b.seq != null ? b.seq : 999);
        return sa - sb;
      });

      // Determine if reading orders differ
      const isDualOrder =
        chronoBooks.length >= 2 &&
        releaseBooks.length >= 2 &&
        chronoBooks.some((b, i) => {
          const rb = releaseBooks[i];
          return !rb || b.title.toLowerCase() !== rb.title.toLowerCase();
        });

      seriesObj.books = chronoBooks;
      seriesObj.releaseBooks = releaseBooks;
      seriesObj.isDualOrder = isDualOrder;

      const colCover = await withTimeout(findCollectionCover(seriesObj.seriesName, seriesObj.author), 2500, null);
      seriesObj.collectionPoster = colCover || (chronoBooks[0] && chronoBooks[0].poster) || null;
    }

    return seriesObj;
  })();

  seriesCache.set(cacheKey, result);
  return result;
}

function matchTargetFile(book, bookNum, files, recommendedBook, allBooks = []) {
  if (!Array.isArray(files) || files.length === 0) return undefined;
  const targetTitle = typeof book === "string" ? book : ((book && (book.title || book.name)) || "");
  const cleanTarget = cleanDisplayTitle(targetTitle).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!cleanTarget) return undefined;

  // Collect other distinguishing words from other books in the same series dynamically
  const otherWords = new Set();
  if (Array.isArray(allBooks) && allBooks.length > 1) {
    const targetWords = new Set(targetTitle.toLowerCase().split(/\W+/).filter(Boolean));
    for (const b of allBooks) {
      const bTitle = typeof b === "string" ? b : (b && b.title) || "";
      if (!bTitle || bTitle.toLowerCase() === targetTitle.toLowerCase()) continue;
      for (const w of bTitle.toLowerCase().split(/\W+/).filter((x) => x.length > 3)) {
        if (!targetWords.has(w)) otherWords.add(w);
      }
    }
  }

  let bestFile = null;
  let bestScore = -1;

  for (const f of files) {
    const rawName = String(f.name || f.short_name || "");
    const cleanFn = cleanEpisodeTitle(rawName).toLowerCase().replace(/[^a-z0-9]/g, "");
    const baseFn = rawName.split(/[/\\]/).pop().toLowerCase();
    let score = 0;

    // 1. Exact cleaned title match (highest confidence)
    if (cleanFn === cleanTarget) {
      score = 1000;
    } else if (cleanFn.startsWith(cleanTarget) || cleanTarget.startsWith(cleanFn)) {
      // Substring match: check length ratio to prevent 'foundation' matching 'preludetofoundation'
      const minLen = Math.min(cleanFn.length, cleanTarget.length);
      const maxLen = Math.max(cleanFn.length, cleanTarget.length);
      if (minLen / maxLen >= 0.75) {
        score = 800;
      }
    }

    // 2. Word-boundary regex match in basename
    if (score === 0) {
      const escaped = targetTitle.toLowerCase().replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
      if (new RegExp("\\b" + escaped + "\\b", "i").test(baseFn)) {
        // Penalty if it matches distinguishing words of other books in the same series
        const hasOther = [...otherWords].some((w) => baseFn.includes(w));
        if (!hasOther) {
          score = 600;
        }
      }
    }

    // 3. Fallback to canonical sequence number (e.g. book.seq)
    if (score === 0 && book && book.seq != null) {
      const numPadded = book.seq < 10 ? "0" + book.seq : "" + book.seq;
      const numRegex = new RegExp("(?:^|[\\s._\\-])0?" + book.seq + "(?:[\\s._\\-]|$)");
      if (baseFn.includes(numPadded) || numRegex.test(baseFn)) {
        score = 300;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestFile = f.name || f.short_name;
    }
  }

  if (bestScore >= 300) return bestFile;

  if (files.length === 1 && recommendedBook) {
    const recLower = String(recommendedBook).toLowerCase().trim();
    const tLower = targetTitle.toLowerCase();
    if (tLower.includes(recLower) || recLower.includes(tLower)) {
      return files[0].name || files[0].short_name;
    }
  }

  return undefined;
}

/**
 * Builds the complete Stremio Series Meta object with canonical episode list.
 */
async function fetchSeriesMeta(seriesName, author = "", extraMeta = {}) {
  const seriesData = await fetchSeriesBooks(seriesName, author);
  const cleanName = seriesData ? seriesData.seriesName : seriesName;
  const effAuthor = (seriesData && seriesData.author) || author || "";
  const isDualOrder = !!(seriesData && seriesData.isDualOrder);
  const chronoBooks = (seriesData && seriesData.books) || [];
  const releaseBooks = (seriesData && seriesData.releaseBooks) || chronoBooks;
  const files = Array.isArray(extraMeta.files) ? extraMeta.files : [];
  const recBook = extraMeta.recommendedBook || undefined;

  const displayName = effAuthor
    ? `${cleanName} Series — ${effAuthor}`
    : `${cleanName} (Audiobook Series)`;

  const masterPoster =
    (seriesData && seriesData.collectionPoster) ||
    (chronoBooks[0] && chronoBooks[0].poster) ||
    extraMeta.poster ||
    undefined;

  let videos = [];

  if (isDualOrder) {
    // Season 1: Release / Publication Order
    const s1Videos = releaseBooks.map((book, idx) => {
      const epNum = idx + 1;
      const yr = book.originalYear || book.year;
      const yearLabel = yr ? ` (${yr})` : "";
      return {
        id: encodeItemId({
          type: "series",
          seriesName: cleanName,
          bookNumber: book.seq != null ? book.seq : epNum,
          season: 1,
          name: book.title,
          author: book.author || effAuthor,
          parentInfohash: extraMeta.infohash || undefined,
          targetFile: matchTargetFile(book, epNum, files, recBook, chronoBooks),
          isSeries: true,
        }),
        title: `Book ${epNum}${yearLabel}: ${book.title}`,
        season: 1,
        episode: epNum,
        released: yr ? String(yr) : undefined,
        thumbnail: book.poster || masterPoster,
        overview: book.description || undefined,
      };
    });

    // Season 2: Chronological Story Order
    const s2Videos = chronoBooks.map((book, idx) => {
      const epNum = idx + 1;
      return {
        id: encodeItemId({
          type: "series",
          seriesName: cleanName,
          bookNumber: book.seq != null ? book.seq : epNum,
          season: 2,
          name: book.title,
          author: book.author || effAuthor,
          parentInfohash: extraMeta.infohash || undefined,
          targetFile: matchTargetFile(book, epNum, files, recBook, chronoBooks),
          isSeries: true,
        }),
        title: `Book ${epNum}: ${book.title}`,
        season: 2,
        episode: epNum,
        released: book.originalYear || book.year ? String(book.originalYear || book.year) : undefined,
        thumbnail: book.poster || masterPoster,
        overview: book.description || undefined,
      };
    });

    videos = [...s1Videos, ...s2Videos];
  } else {
    // Single canonical order -> Season 1 only (deduplicated)
    videos = chronoBooks.map((book, idx) => {
      const bookNum = book.seq != null ? book.seq : idx + 1;
      const epNum = Number.isInteger(bookNum) && bookNum > 0 ? bookNum : idx + 1;
      return {
        id: encodeItemId({
          type: "series",
          seriesName: cleanName,
          bookNumber: epNum,
          season: 1,
          name: book.title,
          author: book.author || effAuthor,
          parentInfohash: extraMeta.infohash || undefined,
          targetFile: matchTargetFile(book, epNum, files, recBook, chronoBooks),
          isSeries: true,
        }),
        title: `Book ${epNum}: ${book.title}`,
        season: 1,
        episode: epNum,
        released: book.originalYear || book.year ? String(book.originalYear || book.year) : undefined,
        thumbnail: book.poster || masterPoster,
        overview: book.description || undefined,
      };
    });
  }

  const descLines = [];
  if (isDualOrder) {
    descLines.push(
      `📚 Dual Reading Orders Available:\n• Season 1: Release / Publication Order (${releaseBooks.length} Books)\n• Season 2: Chronological Story Order (${chronoBooks.length} Books)`
    );
  } else {
    descLines.push(`📚 Canonical Audiobook Series (${chronoBooks.length} Books in Reading Order)`);
  }
  if (effAuthor) descLines.push(`By ${effAuthor}`);
  if (isDualOrder) {
    const s1List = releaseBooks.slice(0, 6).map((b, i) => `  ${i + 1}. ${b.title}${b.originalYear ? ` (${b.originalYear})` : ""}`).join("\n");
    const s2List = chronoBooks.slice(0, 6).map((b, i) => `  ${i + 1}. ${b.title}`).join("\n");
    descLines.push(`Season 1 (Release Order):\n${s1List}${releaseBooks.length > 6 ? `\n  ...and ${releaseBooks.length - 6} more` : ""}\n\nSeason 2 (Chronological Order):\n${s2List}${chronoBooks.length > 6 ? `\n  ...and ${chronoBooks.length - 6} more` : ""}`);
  } else if (chronoBooks.length > 0) {
    const bookList = chronoBooks.slice(0, 10).map((b, i) => `• Book ${b.seq != null ? b.seq : i + 1}: ${b.title}`).join("\n");
    descLines.push(`Reading Order:\n${bookList}${chronoBooks.length > 10 ? `\n...and ${chronoBooks.length - 10} more` : ""}`);
  }

  return {
    type: "series",
    name: displayName,
    poster: masterPoster,
    background: masterPoster,
    posterShape: "square",
    description: descLines.filter(Boolean).join("\n\n"),
    releaseInfo: (chronoBooks[0] && (chronoBooks[0].originalYear || chronoBooks[0].year)) || undefined,
    genres: [cleanName, "Audiobook", "Series"],
    cast: effAuthor ? [effAuthor] : undefined,
    videos: videos.length > 0 ? videos : undefined,
  };
}

module.exports = {
  fetchSeriesBooks,
  fetchSeriesMeta,
  fetchSeriesWikiExtract,
  findCollectionCover,
  cleanSeriesQuery,
  matchTargetFile,
  _seriesCache: seriesCache,
};

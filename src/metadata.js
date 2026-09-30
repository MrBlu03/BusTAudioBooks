// src/metadata.js
// Best-effort cover art, author, and description lookup so the catalog
// grid and details pages look like real audiobooks with official cover art
// and rich plot synopses.
//
// Sources:
//   1. iTunes Search (media=audiobook)  — purpose-built, 600x600 artwork, full descriptions
//   2. Google Books                     — huge catalogue incl. foreign titles
//   3. Open Library                     — free fallback

const { TTLCache, withTimeout } = require("./cache");
const { cleanDisplayTitle } = require("./series");
const libex = require("./libex");
const audnexus = require("./audnexus");

const metaCache = new TTLCache(24 * 60 * 60 * 1000, 5000); // 24h

const NOISE = new RegExp(
  "\\b(?:" +
    [
      "unabridged", "abridged", "audio ?books?", "audible",
      "mp3", "m4b", "m4a", "flac", "aac", "ogg", "opus", "wav", "vbr", "cbr",
      "\\d+\\s?kbps", "\\d+\\s?khz", "retail", "complete", "fully chaptered",
    ].join("|") +
    ")\\b",
  "gi"
);

const COMIC_NOISE = new RegExp(
  [
    "cbz", "cb7", "cbt", "digital", "webtoon", "scanlation",
    "\\bv\\d{1,3}\\b", "\\bc\\d{1,4}(?:-\\d{1,4})?\\b",
  ].join("|"),
  "gi"
);

function stripTags(s) {
  return (s || "").replace(/<[^>]*>/g, "").trim();
}

function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&#0?38;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#160;/g, " ")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8211;/g, "\u2013")
    .replace(/&#8212;/g, "\u2014")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function stripBrackets(s) {
  return String(s || "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\{[^}]*\}/g, " ");
}

// Release titles are not consistently "Title - Author":
//   "Foundation (Book 1) - Isaac Asimov"          -> title first
//   "City of Bones - The Mortal Instruments 1 - Cassandra Clare" -> author last, series in the middle
//   "Andy Weir - Project Hail Mary"               -> author FIRST
//   "Frank Herbert - Dune Messiah (2007) edition" -> author first
// So decide by looking at the parts rather than assuming position.
const NAME_STOPWORDS =
  /\b(book|books|series|vol|volume|part|chapter|edition|editions|audio|audiobook|audiobooks|narrated|unabridged|abridged|complete|collection|omnibus|box|set|cd|mp3|m4b|disc)\b/i;

/**
 * Heuristic: does this fragment read like a person's name?
 * Deliberately conservative — a false positive mislabels the title, so it
 * only fires on fragments that look like a real name and nothing else.
 */
function looksLikeAuthor(fragment) {
  const s = String(fragment || "").trim();
  if (!s || s.length > 60) return false;
  if (/[0-9]/.test(s)) return false; // "Book 1", "(2007)"
  if (/[:?!,;]/.test(s)) return false; // titles love punctuation
  if (NAME_STOPWORDS.test(s)) return false; // "Dune Messiah edition"
  const words = s.split(/\s+/);
  if (words.length < 2 || words.length > 4) return false; // one word = a title
  return words.every(
    (w) => /^[A-Z\p{Lu}]/.test(w) || /^(de|del|van|von|der|la|le|bin|al|da|di|dos|du)$/i.test(w)
  );
}

// Pull titles apart cleanly into { title, author }
function parseNameParts(raw, type = "audiobook") {
  let s = stripBrackets(raw)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\u00A0\u202F]/g, " ");
  s = s.replace(/narrated by.*$/i, " ").replace(NOISE, " ");
  if (type === "comic") s = s.replace(COMIC_NOISE, " ");
  s = s.replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  const parts = s.split(/\s+[-–—:]\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const first = parts[0];
    const last = parts[parts.length - 1];

    // Author-first: both ends read like names, and the trailing part is the
    // longer, more title-like fragment.
    if (looksLikeAuthor(first) && !looksLikeAuthor(last) && last.length > first.length) {
      return { title: last, author: first, series: null };
    }

    // Otherwise scan from the right for the first fragment that reads like a
    // name. Everything between the title and the author is a series/edition
    // fragment, which must not be folded into the author — "Dune - Frank
    // Herbert - Complete Series" used to yield "Frank Herbert Series".
    let authorIndex = -1;
    for (let i = parts.length - 1; i >= 1; i--) {
      if (looksLikeAuthor(parts[i])) {
        authorIndex = i;
        break;
      }
    }
    if (authorIndex !== -1) {
      const between = parts.slice(1, authorIndex).join(" - ").trim();
      return {
        title: first,
        author: parts[authorIndex],
        series: between || null,
      };
    }

    return { title: first, author: parts.slice(1).join(" ").trim() || null, series: null };
  }
  const byMatch = s.match(/^(.*?)\s+by\s+([A-Z][a-zA-Z\s.'-]+)$/i);
  if (byMatch) {
    return { title: byMatch[1].trim(), author: byMatch[2].trim() || null, series: null };
  }
  return { title: s, author: null, series: null };
}

function cleanTitle(raw) {
  return parseNameParts(raw).title;
}

// iTunes artwork comes as 100x100; bump it to a crisp 600x600.
function upscaleItunes(url) {
  if (!url) return null;
  return url.replace(/\/\d+x\d+bb?\.(jpg|png|jpeg)/i, "/600x600bb.$1");
}

async function fromItunes(title, author, raw = "") {
  const trySearch = async (term) => {
    if (!term || term.length < 2) return null;
    const url =
      "https://itunes.apple.com/search?media=audiobook&limit=1&term=" +
      encodeURIComponent(term);
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const j = await res.json();
    return j.results && j.results[0];
  };

  const cleanRaw = raw ? cleanDisplayTitle(raw) : "";
  const fullTerm = [title, author].filter(Boolean).join(" ");

  let d = null;
  if (cleanRaw) d = await trySearch(cleanRaw).catch(() => null);
  if (!d && fullTerm && fullTerm !== cleanRaw) d = await trySearch(fullTerm).catch(() => null);
  if (!d && title && title.length >= 3 && title !== cleanRaw && title !== fullTerm) {
    d = await trySearch(title).catch(() => null);
  }

  // If still no result, strip collection/boxset noise, brackets, and punctuation
  if (!d) {
    const strippedTerm = (raw || fullTerm || title)
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/\([^)]*\)/g, " ")
      .replace(/\{[^}]*\}/g, " ")
      .replace(
        /\b(?:complete|series|collection|saga|trilogy|set|audiobooks?|chapterized|all\s+\w+\s+books|\d+\s*books?)\b/gi,
        " "
      )
      .replace(/[^a-zA-Z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (strippedTerm && strippedTerm.length >= 3) {
      d = await trySearch(strippedTerm).catch(() => null);
    }
  }

  if (!d) return null;
  const poster = upscaleItunes(d.artworkUrl100 || d.artworkUrl60);
  const description = d.description
    ? decodeEntities(stripTags(d.description)).replace(/\s+/g, " ").trim()
    : null;

  return {
    poster: poster || null,
    author: (d && d.artistName) || author || null,
    description: description || null,
    year: d.releaseDate ? d.releaseDate.slice(0, 4) : null,
  };
}

const dns = require("dns");
try {
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {}

async function fromGoogleBooks(title, author) {
  try {
    const q = [title, author ? `inauthor:${author}` : ""].filter(Boolean).join("+");
    const apiKey = process.env.GOOGLE_BOOKS_API_KEY || "";
    const keyParam = apiKey ? `&key=${encodeURIComponent(apiKey)}` : "";
    const url =
      `https://www.googleapis.com/books/v1/volumes?maxResults=1&country=US&q=${encodeURIComponent(q)}${keyParam}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const j = await res.json();
    const v = j.items && j.items[0] && j.items[0].volumeInfo;
    if (!v) return null;
    let img =
      v.imageLinks &&
      (v.imageLinks.extraLarge ||
        v.imageLinks.large ||
        v.imageLinks.medium ||
        v.imageLinks.thumbnail ||
        v.imageLinks.smallThumbnail);
    if (img) {
      img = img
        .replace(/^http:/, "https:")
        .replace(/&edge=curl/, "")
        .replace(/&zoom=1/, "&zoom=2");
    }
    const description = v.description
      ? decodeEntities(stripTags(v.description)).replace(/\s+/g, " ").trim()
      : null;
    return {
      poster: img || null,
      author: (v.authors && v.authors[0]) || author || null,
      description: description || null,
      year: v.publishedDate ? v.publishedDate.slice(0, 4) : null,
      genres: Array.isArray(v.categories) ? v.categories : [],
    };
  } catch (_) {
    return null;
  }
}

async function fromOpenLibrary(title, author) {
  try {
    const q = [title, author].filter(Boolean).join(" ");
    const url =
      "https://openlibrary.org/search.json?limit=1&fields=title,author_name,cover_i,first_sentence,key,first_publish_year,subject&q=" +
      encodeURIComponent(q);
    const res = await fetch(url, {
      headers: { "User-Agent": "bustaudio-addon/1.0" },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const d = j.docs && j.docs[0];
    if (!d) return null;
    const poster = d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null;
    let description = d.first_sentence
      ? typeof d.first_sentence === "string"
        ? d.first_sentence
        : d.first_sentence.value
      : null;

    if (!description && d.key) {
      try {
        const wRes = await fetch(`https://openlibrary.org${d.key}.json`, {
          headers: { "User-Agent": "bustaudio-addon/1.0" },
          signal: AbortSignal.timeout(2000),
        });
        if (wRes.ok) {
          const w = await wRes.json();
          const wDesc = typeof w.description === "object" ? w.description.value : w.description;
          if (wDesc && typeof wDesc === "string") description = wDesc.trim();
        }
      } catch (_) {}
    }

    const genres = Array.isArray(d.subject)
      ? d.subject.slice(0, 4).filter((s) => typeof s === "string" && s.length <= 30)
      : [];

    return {
      poster,
      author: (d.author_name && d.author_name[0]) || author || null,
      description: description || null,
      year: d.first_publish_year ? String(d.first_publish_year) : null,
      genres,
    };
  } catch (_) {
    return null;
  }
}

async function fromWikipedia(title, author) {
  try {
    const q = [title, author].filter(Boolean).join(" ");
    const searchUrl =
      "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=1&srsearch=" +
      encodeURIComponent(q + " novel");
    const sRes = await fetch(searchUrl, {
      headers: { "User-Agent": "bustaudio-addon/1.0 (contact@bustaudio.app)" },
      signal: AbortSignal.timeout(2000),
    });
    if (!sRes.ok) return null;
    const sData = await sRes.json();
    const hit = sData.query && sData.query.search && sData.query.search[0];
    if (!hit) return null;

    const sumUrl =
      "https://en.wikipedia.org/api/rest_v1/page/summary/" +
      encodeURIComponent(hit.title.replace(/\s+/g, "_"));
    const sumRes = await fetch(sumUrl, {
      headers: { "User-Agent": "bustaudio-addon/1.0 (contact@bustaudio.app)" },
      signal: AbortSignal.timeout(2000),
    });
    if (!sumRes.ok) return null;
    const sumData = await sumRes.json();
    if (sumData.type === "disambiguation" || !sumData.extract) return null;
    return {
      description: sumData.extract.trim(),
      poster: (sumData.thumbnail && sumData.thumbnail.source) || null,
    };
  } catch (_) {
    return null;
  }
}

// NOTE: audiobookcovers.com used to be a poster source here and has been
// removed on purpose. Its /api/search returns 20 results for ANY input,
// including invented titles, and the records carry no title/author/isbn — only
// id, url, source, score and image URLs — so a match cannot be verified. Its
// "score" is not a relevance signal either: a nonexistent title scores 0.339
// while the real "Dune Frank Herbert" scores 0.305. Accepting results[0] meant
// attaching a random cover to books we knew nothing about, which is worse than
// showing no cover at all. Libex now covers the common cases with real Audible
// art, and the remaining providers return verifiable matches.

// Returns { poster, author, description, year, genres } — always resolves, never throws.
async function enrich(raw, type = "audiobook", hintAuthor = null) {
  const name = String(raw || "").toLowerCase().trim();
  const effHint = hintAuthor ? String(hintAuthor).trim() : null;
  if (!name) {
    return {
      poster: null, author: null, description: null, year: null, genres: [],
      narrator: null, duration: null, series: null, seriesIndex: null,
      publisher: null, asin: null, source: "none",
    };
  }

  const key = `${type}:${name}:${effHint ? effHint.toLowerCase() : ""}`;
  const hit = metaCache.get(key);
  if (hit !== undefined) return hit;

  const { title, author: parsedAuthor } = parseNameParts(raw, type);
  const author = parsedAuthor || effHint || null;
  let result = {
    poster: null, author: author || null, description: null, year: null, genres: [],
    narrator: null, duration: null, series: null, seriesIndex: null,
    publisher: null, asin: null, source: "none",
  };

  if (title.length >= 2 || raw.length >= 2) {
    if (type === "comic") {
      const [gb, ol] = await Promise.all([
        withTimeout(fromGoogleBooks(title, author).catch(() => null), 2500, null),
        withTimeout(fromOpenLibrary(title, author).catch(() => null), 2500, null),
      ]);
      const best = gb || ol;
      if (best) {
        // Comics have no narrator/series fields; keep the shape identical to the
        // audiobook branch so consumers never have to branch on `type`.
        result = {
          ...result,
          ...best,
          narrator: null, duration: null, series: null, seriesIndex: null,
          publisher: null, asin: null, source: best === gb ? "googlebooks" : "openlibrary",
        };
      }
    } else {
      // Audiobook lookup: Tiered resolution pipeline.
      // Audnexus (Audible API + Audnexus) is the gold standard used by Plex
      // Audiobooks.bundle / Audiobookshelf. When Audnexus returns an official match
      // with studio cover art, resolve immediately to minimize latency and avoid
      // hammering secondary APIs.
      let an = null;
      try {
        an = await withTimeout(audnexus.lookupAudnexus(title, author), 2500, null);
      } catch (_) {}

      if (an && an.poster) {
        result = {
          title: an.title || title,
          poster: an.poster,
          author: an.author || author || null,
          description: an.description || null,
          year: an.year || null,
          genres: an.genres || [],
          narrator: an.narrator || null,
          duration: an.duration || null,
          series: an.series || null,
          seriesIndex: an.seriesIndex || null,
          publisher: null,
          asin: an.asin || null,
          rating: an.rating || null,
          source: "audnexus",
        };
        metaCache.set(key, result);
        return result;
      }

      // Secondary fallback pipeline: query Libex, iTunes, Google Books, Open Library, and Wikipedia
      const [lx, it, gb, ol, wiki] = await Promise.all([
        withTimeout(libex.lookup(title, author).catch(() => null), 2500, null),
        withTimeout(fromItunes(title, author, raw).catch(() => null), 2000, null),
        withTimeout(fromGoogleBooks(title, author).catch(() => null), 2000, null),
        withTimeout(fromOpenLibrary(title, author).catch(() => null), 2500, null),
        withTimeout(fromWikipedia(title, author).catch(() => null), 2000, null),
      ]);

      const candidates = [lx, it, gb, ol, wiki].filter(Boolean);
      const poster =
        (lx && lx.poster) ||
        (it && it.poster) ||
        (candidates.find((c) => c.poster) || {}).poster ||
        null;
      const authorFound =
        (lx && lx.author) ||
        (candidates.find((c) => c.author) || {}).author ||
        author ||
        null;
      const description =
        (lx && lx.description) ||
        (it && it.description) ||
        (ol && ol.description) ||
        (gb && gb.description) ||
        (wiki && wiki.description) ||
        null;
      const year =
        (lx && lx.year) ||
        (it && it.year) ||
        (ol && ol.year) ||
        (gb && gb.year) ||
        null;
      // Prefer Audible genres from Libex when available
      const genres =
        (lx && lx.genres && lx.genres.length > 0 && lx.genres) ||
        (ol && ol.genres && ol.genres.length > 0 && ol.genres) ||
        (gb && gb.genres && gb.genres.length > 0 && gb.genres) ||
        (it && it.genres && it.genres.length > 0 && it.genres) ||
        [];

      result = {
        title: title,
        poster,
        author: authorFound,
        description,
        year,
        genres,
        narrator: (lx && lx.narrator) || null,
        duration: (lx && lx.duration) || null,
        series: (lx && lx.series) || null,
        seriesIndex: (lx && lx.seriesIndex) || null,
        publisher: (lx && lx.publisher) || null,
        asin: (lx && lx.asin) || null,
        rating: null,
        source: lx ? "libex" : "legacy",
      };
    }
  }

  metaCache.set(key, result);
  return result;
}

module.exports = {
  enrich,
  cleanTitle,
  parseNameParts,
  _upscaleItunes: upscaleItunes,
  _metaCache: metaCache,
};

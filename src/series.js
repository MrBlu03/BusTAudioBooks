// src/series.js
// Smart series detection, book-number parsing, and canonical ordering
// for audiobook releases.

const KNOWN_SERIES = [
  {
    name: "the mortal instruments",
    match: /mortal instruments|cassandra clare/i,
    books: [
      { num: 1, match: /city of bones/i },
      { num: 2, match: /city of ashes/i },
      { num: 3, match: /city of glass/i },
      { num: 4, match: /city of fallen angels/i },
      { num: 5, match: /city of lost souls/i },
      { num: 6, match: /city of heavenly fire/i },
    ],
  },
  {
    name: "harry potter",
    match: /harry potter/i,
    books: [
      { num: 1, match: /philosopher|sorcerer/i },
      { num: 2, match: /chamber of secrets/i },
      { num: 3, match: /prisoner of azkaban/i },
      { num: 4, match: /goblet of fire/i },
      { num: 5, match: /order of the phoenix/i },
      { num: 6, match: /half[- ]blood prince/i },
      { num: 7, match: /deathly hallows/i },
      { num: 8, match: /cursed child/i },
    ],
  },
  {
    name: "percy jackson",
    match: /percy jackson|olympians/i,
    books: [
      { num: 1, match: /lightning thief/i },
      { num: 2, match: /sea of monsters/i },
      { num: 3, match: /titan'?s curse/i },
      { num: 4, match: /battle of the labyrinth/i },
      { num: 5, match: /last olympian/i },
      { num: 6, match: /chalice of the gods/i },
      { num: 7, match: /triple goddess/i },
    ],
  },
  {
    name: "dune",
    match: /\bdunes?\b/i,
    books: [
      { num: 2, match: /dune messiah|messias/i },
      { num: 3, match: /children of dune/i },
      { num: 4, match: /god emperor of dune/i },
      { num: 5, match: /heretics of dune|herejes/i },
      { num: 6, match: /chapterhouse:? dune/i },
      { num: 1, match: /\bdune\b(?! messiah| saga| series| and| of| rpg)/i },
    ],
  },
  {
    name: "the hunger games",
    match: /hunger games/i,
    books: [
      { num: 1, match: /hunger games(?!.*(catching|mocking|ballad))/i },
      { num: 2, match: /catching fire/i },
      { num: 3, match: /mockingjay/i },
      { num: 4, match: /ballad of songbirds/i },
      { num: 5, match: /sunrise on the reaping/i },
    ],
  },
  {
    name: "the lord of the rings",
    match: /lord of the rings|lotr|tolkien/i,
    books: [
      { num: 0.5, match: /\bthe hobbit\b/i },
      { num: 1, match: /fellowship of the ring/i },
      { num: 2, match: /two towers/i },
      { num: 3, match: /return of the king/i },
    ],
  },
  {
    name: "a song of ice and fire",
    match: /song of ice and fire|game of thrones|george r\.? ?r\.? martin/i,
    books: [
      { num: 1, match: /game of thrones/i },
      { num: 2, match: /clash of kings/i },
      { num: 3, match: /storm of swords/i },
      { num: 4, match: /feast for crows/i },
      { num: 5, match: /dance with dragons/i },
      { num: 6, match: /winds of winter/i },
    ],
  },
  {
    name: "the witcher",
    match: /witcher|sapkowski/i,
    books: [
      { num: 1, match: /last wish/i },
      { num: 2, match: /sword of destiny/i },
      { num: 3, match: /blood of elves/i },
      { num: 4, match: /time of contempt/i },
      { num: 5, match: /baptism of fire/i },
      { num: 6, match: /tower of the swallow/i },
      { num: 7, match: /lady of the lake/i },
      { num: 8, match: /season of storms/i },
    ],
  },
  {
    name: "mistborn",
    match: /mistborn/i,
    books: [
      { num: 1, match: /final empire|mistborn(?!.*(well|hero|alloy|shadows|bands|lost))/i },
      { num: 2, match: /well of ascension/i },
      { num: 3, match: /hero of ages/i },
      { num: 4, match: /alloy of law/i },
      { num: 5, match: /shadows of self/i },
      { num: 6, match: /bands of mourning/i },
      { num: 7, match: /lost metal/i },
    ],
  },
  {
    name: "the stormlight archive",
    match: /stormlight|brandon sanderson/i,
    books: [
      { num: 1, match: /way of kings/i },
      { num: 2, match: /words of radiance/i },
      { num: 2.5, match: /edgedancer/i },
      { num: 3, match: /oathbringer/i },
      { num: 3.5, match: /dawnshard/i },
      { num: 4, match: /rhythm of war/i },
      { num: 5, match: /wind and truth/i },
    ],
  },
  {
    name: "the first law",
    match: /first law|joe abercrombie/i,
    books: [
      { num: 1, match: /blade itself/i },
      { num: 2, match: /before they are hanged/i },
      { num: 3, match: /last argument of kings/i },
      { num: 4, match: /best served cold/i },
      { num: 5, match: /the heroes/i },
      { num: 6, match: /red country/i },
      { num: 7, match: /a little hatred/i },
      { num: 8, match: /the trouble with peace/i },
      { num: 9, match: /the wisdom of crowds/i },
    ],
  },
  {
    name: "the expanse",
    match: /the expanse|james s\.? a\.? corey/i,
    books: [
      { num: 1, match: /leviathan wakes/i },
      { num: 2, match: /caliban'?s war/i },
      { num: 3, match: /abaddon'?s gate/i },
      { num: 4, match: /cibola burn/i },
      { num: 5, match: /nemesis games/i },
      { num: 6, match: /babylon'?s ashes/i },
      { num: 7, match: /persepolis rising/i },
      { num: 8, match: /tiamat'?s wrath/i },
      { num: 9, match: /leviathan falls/i },
    ],
  },
  {
    name: "the wheel of time",
    match: /wheel of time|robert jordan/i,
    books: [
      { num: 0, match: /new spring/i },
      { num: 1, match: /eye of the world/i },
      { num: 2, match: /great hunt/i },
      { num: 3, match: /dragon reborn/i },
      { num: 4, match: /shadow rising/i },
      { num: 5, match: /fires of heaven/i },
      { num: 6, match: /lord of chaos/i },
      { num: 7, match: /crown of swords/i },
      { num: 8, match: /path of daggers/i },
      { num: 9, match: /winter'?s heart/i },
      { num: 10, match: /crossroads of twilight/i },
      { num: 11, match: /knife of dreams/i },
      { num: 12, match: /gathering storm/i },
      { num: 13, match: /towers of midnight/i },
      { num: 14, match: /memory of light/i },
    ],
  },
  {
    name: "the dark tower",
    match: /dark tower|stephen king/i,
    books: [
      { num: 1, match: /the gunslinger/i },
      { num: 2, match: /drawing of the three/i },
      { num: 3, match: /the waste lands/i },
      { num: 4, match: /wizard and glass/i },
      { num: 4.5, match: /wind through the keyhole/i },
      { num: 5, match: /wolves of the calla/i },
      { num: 6, match: /song of susannah/i },
      { num: 7, match: /the dark tower(?!.*(gunslinger|drawing|waste|wizard|wolves|song))/i },
    ],
  },
  {
    name: "dungeon crawler carl",
    match: /dungeon crawler carl|matt dinniman/i,
    books: [
      { num: 1, match: /dungeon crawler carl(?!.*(scenario|cookbook|feral|masquerade|bride|ruin))/i },
      { num: 2, match: /doomsday scenario/i },
      { num: 3, match: /anarchist'?s cookbook/i },
      { num: 4, match: /feral gods/i },
      { num: 5, match: /butcher'?s masquerade/i },
      { num: 6, match: /bedlam bride/i },
      { num: 7, match: /inevitable ruin/i },
    ],
  },
  {
    name: "cradle",
    match: /cradle|will wight/i,
    books: [
      { num: 1, match: /unsouled/i },
      { num: 2, match: /soulsmith/i },
      { num: 3, match: /blackflame/i },
      { num: 4, match: /skysworn/i },
      { num: 5, match: /ghostwater/i },
      { num: 6, match: /underlord/i },
      { num: 7, match: /uncrowned/i },
      { num: 8, match: /wintersteel/i },
      { num: 9, match: /bloodline/i },
      { num: 10, match: /reaper/i },
      { num: 11, match: /dreadgod/i },
      { num: 12, match: /waybound/i },
    ],
  },
  {
    name: "red rising",
    match: /red rising|pierce brown/i,
    books: [
      { num: 1, match: /red rising(?!.*(golden|morning|iron|dark|light|god))/i },
      { num: 2, match: /golden son/i },
      { num: 3, match: /morning star/i },
      { num: 4, match: /iron gold/i },
      { num: 5, match: /dark age/i },
      { num: 6, match: /light bringer/i },
      { num: 7, match: /red god/i },
    ],
  },
  {
    name: "foundation",
    match: /\b(foundation|asimov)\b/i,
    books: [
      { num: 2, match: /\b(?:foundation\s*(?:and|&)\s*empire|empire\s*(?:and|&)\s*foundation)\b/i },
      { num: 8, match: /\bfoundation['\\]*s?\s*fear\b/i },
      { num: 9, match: /\bfoundation\s*(?:and|&)\s*chaos\b/i },
      { num: 10, match: /\bfoundation['\\]*s?\s*triumph\b/i },
      { num: 3, match: /\bsecond\s+foundation\b/i },
      { num: 4, match: /\bfoundation['\\]*s?\s*edge\b/i },
      { num: 5, match: /\bfoundation\s*(?:and|&)\s*earth\b|\bfoundation\s*0?7\b/i },
      { num: 6, match: /\bprelude\s+to\s+foundation\b/i },
      { num: 7, match: /\bforward\s+the\s+foundation\b/i },
      {
        num: 1,
        match: {
          test(title) {
            const s = String(title).toLowerCase();
            if (/\bfoundations\b/i.test(s)) return false;
            if (/\b(?:rossler|scp|gates|napoleon\s*hill|michel\s*thomas|trumpism|housing\s*crisis|models|buddhism|zen|mindfulness|roman\s*empire)\b/i.test(s)) return false;
            if (/asimov|азимов/i.test(s)) {
              if (/empire|second|edge|earth|prelude|forward|fear|chaos|triumph|trilog|series|saga/i.test(s)) return false;
              return /\bfoundation\b/i.test(s);
            }
            if (/^(?:the\s+)?foundation\b/i.test(s) || /asimov\s*[-–—]\s*foundation\b/i.test(s)) {
              if (/empire|second|edge|earth|prelude|forward|fear|chaos|triumph|trilog|series|saga/i.test(s)) return false;
              if (/\b(?:course|agenda|mystery|practices|learning|neuroscience|prosperity|crisis|models)\b/i.test(s)) return false;
              return true;
            }
            return false;
          },
        },
      },
    ],
  },
];

function cleanTitleForParsing(raw) {
  return String(raw || "")
    .replace(/\[(?:mp3|m4b|m4a|flac|aac|ogg|opus|wav|cbr|cbz)\]/gi, " ")
    .replace(/\[\d+\s?kbps\]/gi, " ")
    .replace(/\b\d+\s?kbps\b/gi, " ")
    .replace(/\b(19\d\d|20\d\d)\b/g, " ")
    .replace(/\b\d+\s*(?:cds?|discs?|disks?|hours?|hrs?)\b/gi, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\(\s*\)/g, " ")
    .replace(/\[\s*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Clean tracker noise, bracket tags, and foreign-language bilingual dual-titles
// for a crisp card display in Stremio/Nuvio
function cleanDisplayTitle(raw) {
  let s = String(raw || "")
    .replace(/\\'/g, "'")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\((?:un)?abridged\)/gi, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\(\d+\s*of\s*\d+\s*$/i, "")
    .replace(/\(\s*$/g, "")
    .replace(/\b(?:mp3|m4b|m4a|flac|aac|cbr|cbz)\b$/gi, "");

  // If title contains both Latin and Cyrillic text, strip the Cyrillic portion & dual-slashes
  if (/[a-zA-Z]/.test(s) && /[\u0400-\u04FF]/.test(s)) {
    s = s
      .replace(/[\u0400-\u04FF]+/g, " ")
      .replace(/\/\s*\//g, " - ")
      .replace(/\//g, " ")
      .replace(/[\s\-_]{2,}/g, " - ");
  }

  return s
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:,]+|[\s\-–—:,]+$/g, "")
    .trim();
}

function parseSeriesAndBook(title, author = "", query = "") {
  const cleaned = cleanTitleForParsing(title);
  const lowerTitle = cleaned.toLowerCase();
  const lowerQuery = String(query || "").toLowerCase().trim();

  // 1. Complete collection / box set / number ranges (e.g. 1-7, 1-5, Books 1-3)
  const rangeMatch = title.match(/\b0?([1-9]\d?)\s*[-–—to]+\s*0?([1-9]\d?)\b/);
  const isNumberRange = rangeMatch && parseInt(rangeMatch[1], 10) < parseInt(rangeMatch[2], 10);

  const isCollection =
    isNumberRange ||
    /\b(?:complete\s+(?:series|collection|audiobooks?|saga|trilogy|set)|all\s+\w+\s+books|whole\s+series|audio\s*books?\s*complete|audiobook\s+collection|box\s*set)\b/i.test(title) ||
    /\b(?:books?|vols?|volumes?|libros?|tom)\s*\d+\s*[-–—to]+\s*\d+\b/i.test(title) ||
    /\b\d+\s*[-–—to]+\s*\d+\s*(?:books?|vols?|volumes?|libros?)\b/i.test(title) ||
    /(?:^|[\s\-_])trio?log(?:y|ia|ie|ía)\b/i.test(title) ||
    /\(\d+\s*[-–—]\s*\d+\)/.test(title) ||
    (/\b\d+\s*[-–—]\s*\d+\b/.test(title) && /\b(?:series|collection|saga|trilogy)\b/i.test(title));

  // Check known series specific titles (books 2-10) BEFORE collection fallback so "Second Foundation Trilogy #3" -> Book 10
  for (const s of KNOWN_SERIES) {
    if (s.match.test(lowerTitle) || (lowerQuery && s.match.test(lowerQuery))) {
      for (const b of s.books) {
        if (b.num !== 1 && b.match.test(lowerTitle)) {
          return { seriesName: s.name, bookNumber: b.num, isCollection: false };
        }
      }
    }
  }

  if (isCollection) {
    let collectionType = "collection";
    if (/(?:^|[\s\-_])trio?log(?:y|ia|ie|ía)\b/i.test(title)) collectionType = "trilogy";
    else if (isNumberRange) collectionType = `range-${rangeMatch[1]}-${rangeMatch[2]}`;
    return { seriesName: lowerQuery || "collection", bookNumber: 9999, collectionType, isCollection: true };
  }

  // Check Book 1 of known series
  for (const s of KNOWN_SERIES) {
    if (s.match.test(lowerTitle) || (lowerQuery && s.match.test(lowerQuery))) {
      const b1 = s.books.find((b) => b.num === 1);
      if (b1 && b1.match.test(lowerTitle)) {
        return { seriesName: s.name, bookNumber: 1, isCollection: false };
      }
    }
  }

  // 3. Series prefix: e.g. "Beastborne, Book 7" -> if query was "dune", series is "Beastborne", not target
  const prefixMatch = cleaned.match(
    /(?:^|[:\-–—])\s*([^:\-–—,]+?)\s*[,:\-–—]\s*(?:book|bk|vol|volume|#)\s*0?([1-9]\d?(?:\.\d+)?)\b/i
  );
  if (prefixMatch) {
    const extractedSeries = prefixMatch[1].trim().toLowerCase();
    const bookNum = parseFloat(prefixMatch[2]);
    const cleanExtracted = extractedSeries.replace(/^(the|a|an)\s+/i, "").trim();
    const cleanQuery = lowerQuery.replace(/^(the|a|an)\s+/i, "").trim();
    const isTargetSeries =
      cleanExtracted === cleanQuery ||
      cleanExtracted.startsWith(cleanQuery + " ") ||
      cleanQuery.startsWith(cleanExtracted + " ");
    if (isTargetSeries) {
      return { seriesName: extractedSeries, bookNumber: bookNum, isCollection: false };
    }
    // If not matching query, do not treat as part of queried series
    return { seriesName: extractedSeries, bookNumber: null, isCollection: false };
  }

  // 4. 'Book X', 'Bk X', 'Vol X', 'Part X'
  const bookRegex = /\b(?:book|bk|vol|volume|part|pt|tom|libro|livro)\.?\s*(?:#\s*)?0?([1-9]\d?(?:\.\d+)?)\b/i;
  let m = cleaned.match(bookRegex);
  if (m) {
    return { seriesName: lowerQuery || "", bookNumber: parseFloat(m[1]), isCollection: false };
  }

  // 5. Hash number: #1, #02
  const hashRegex = /(?:^|[(\[\s,])#\s*0?([1-9]\d?)(?:[)\]\s,:]|$)/;
  m = cleaned.match(hashRegex);
  if (m) {
    return { seriesName: lowerQuery || "", bookNumber: parseInt(m[1], 10), isCollection: false };
  }

  // 6. Roman numerals: Book I, Vol II, etc.
  const romanRegex = /\b(?:book|bk|vol|volume|part|pt)\.?\s+(I|II|III|IV|V|VI|VII|VIII|IX|X|XI|XII|XIII|XIV|XV)\b/i;
  m = cleaned.match(romanRegex);
  if (m) {
    const romanMap = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15 };
    const num = romanMap[m[1].toLowerCase()];
    if (num) return { seriesName: lowerQuery || "", bookNumber: num, isCollection: false };
  }

  // 7. Word numbers: Book One, Book Two...
  const wordRegex = /\b(?:book|bk|vol|volume|part|pt)\.?\s+(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i;
  m = cleaned.match(wordRegex);
  if (m) {
    const wordMap = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
      eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
      eighteen: 18, nineteen: 19, twenty: 20,
    };
    const num = wordMap[m[1].toLowerCase()];
    if (num) return { seriesName: lowerQuery || "", bookNumber: num, isCollection: false };
  }

  // 8. Numbers in parentheses or brackets: (01), (02)
  const parenRegex = /[\(\[](0[1-9]|[1-9])[\)\]]/;
  m = cleaned.match(parenRegex);
  if (m) {
    return { seriesName: lowerQuery || "", bookNumber: parseInt(m[1], 10), isCollection: false };
  }

  // 9. Delimited number: "Series 01 - Title" or "01 - Title"
  const delimRegex = /(?:^|[\s,.\-–—\/])0?([1-9]\d?)\s*(?:[.\-–—:\/]|(?=[A-Z]))\s*/;
  m = cleaned.match(delimRegex);
  if (m) {
    const num = parseInt(m[1], 10);
    if (num <= 50) return { seriesName: lowerQuery || "", bookNumber: num, isCollection: false };
  }

  return { seriesName: "", bookNumber: null, isCollection: false };
}

// Generate deduplication key: releases of the same book share this key
function getBookKey(title, author = "", query = "") {
  const seriesInfo = parseSeriesAndBook(title, author, query);
  if (seriesInfo.seriesName && seriesInfo.bookNumber != null) {
    if (seriesInfo.isCollection) {
      return `${seriesInfo.seriesName}:collection:${seriesInfo.collectionType || "all"}`;
    }
    return `${seriesInfo.seriesName}:book:${seriesInfo.bookNumber}`;
  }

  // Fallback for standalones / unnumbered items: strip noise, author, and formatting
  let s = String(title || "")
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\b(chapterized|unabridged|abridged|complete|retail|edition|reup|mp3|m4b|m4a|flac|aac|audiobooks?|audio\s*book|narrated\s*by)\b/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (author) {
    const authorWords = String(author)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    for (const w of authorWords) {
      s = s.replace(new RegExp("\\b" + w + "\\b", "gi"), " ");
    }
  }
  s = s.replace(/\b(?:by|read\s+by|narrated\s+by)\b/gi, " ");
  return s.replace(/\s+/g, " ").trim() || String(title || "").toLowerCase();
}

// Sort deduplicated items in series order (Book 1, Book 2... Collections, Standalones)
function sortInSeriesOrder(items) {
  return [...items].sort((a, b) => {
    const na = a.seriesInfo ? a.seriesInfo.bookNumber : null;
    const nb = b.seriesInfo ? b.seriesInfo.bookNumber : null;

    if (na != null && nb != null) {
      if (na !== nb) return na - nb;
      return 0; // maintain quality order for identical numbers
    }
    if (na != null && nb == null) return -1; // Numbered books first
    if (na == null && nb != null) return 1;

    return 0; // maintain original quality/cached order for standalones
  });
}

// Dynamically clean raw torrent file paths into human-friendly episode titles.
// e.g. "Foundation Series/02 - Foundation and Empire.m4b" -> "Foundation and Empire"
// e.g. "01. Harry Potter and the Sorcerer's Stone [128kbps].mp3" -> "Harry Potter and the Sorcerer's Stone"
function cleanEpisodeTitle(fileName) {
  if (!fileName) return "Episode";
  let s = String(fileName).split(/[/\\]/).pop(); // basename
  s = s.replace(/\.[a-z0-9]{2,5}$/i, ""); // strip audio extension
  // Strip leading track or index numbers like "01 - ", "01. ", "01 ", "Track 01 - ", "CD 1 - "
  s = s.replace(/^(?:track|cd|disk|disc)?\s*0?([0-9]{1,3})\s*[-–—.:\s]\s*/i, "");
  s = s.replace(/[._]+/g, " "); // normalize dots and underscores
  // Strip release codec/bitrate noise and bracket tags
  s = s.replace(/\[[^\]]*\]/g, " ").replace(/\([^)]*\)/g, " ");
  s = s.replace(/\b(?:mp3|m4b|flac|aac|64kbps|128kbps|256kbps|unabridged|abridged|cd\s*\d+)\b/gi, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s || fileName;
}

// Pass-through without hardcoding: series packs are now handled dynamically as episodic series
function expandSeriesPacks(items) {
  return items || [];
}

module.exports = {
  KNOWN_SERIES,
  cleanTitleForParsing,
  cleanDisplayTitle,
  cleanEpisodeTitle,
  parseSeriesAndBook,
  getBookKey,
  sortInSeriesOrder,
  expandSeriesPacks,
};

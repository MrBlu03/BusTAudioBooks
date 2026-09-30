// src/genres.js
// The catalogue's browse categories.
//
// Two constraints shaped this table, and both are worth reading before editing:
//
// 1. AudiobookBay matches `?s=` against POST TITLES, not against a category
//    taxonomy. So Audible's literal category names are useless as search terms:
//    nothing is titled "Literature & Fiction", and searching that returns an
//    empty page. Every seed below is a phrase that actually shows up inside
//    audiobook release names ("... - Andy Weir", "Complete Series", "Box Set").
//
// 2. AudiobookBay rate-limits aggressively — a handful of rapid requests gets
//    the caller blocked for several minutes. So each genre is exactly ONE
//    search, never a fan-out across several seeds. Expanding the category list
//    is therefore free: a genre page costs the same as a normal search. Do not
//    "improve" relevance by adding more seeds per genre; it will get us banned.
//
// Jackett could support real Torznab category filtering, but no indexers are
// configured on this instance, so audiobooks come from ABB alone.

/** Browse the site's front page. `query: null` means "no search term". */
const BROWSE = "browse";
/** Enumerate the signed-in user's own TorBox list. */
const TORBOX = "torbox";
/** A single text search against ABB. */
const SEARCH = "search";
/** Personal recommendations generated from the Nuvio library. */
const RECS = "recs";

const GENRES = [
  // -- default / account ------------------------------------------------------
  { name: "Popular & Trending", kind: BROWSE, query: null },
  { name: "Recommended For You", kind: RECS, query: null },
  { name: "In Your TorBox", kind: TORBOX, query: null },
  { name: "Popular Series", kind: SEARCH, query: "complete series" },

  // -- fiction ----------------------------------------------------------------
  { name: "Science Fiction", kind: SEARCH, query: "science fiction" },
  { name: "Fantasy & Magic", kind: SEARCH, query: "fantasy" },
  { name: "Literary Fiction", kind: SEARCH, query: "literary fiction" },
  { name: "Mystery & Detective", kind: SEARCH, query: "mystery" },
  { name: "Thriller & Suspense", kind: SEARCH, query: "thriller" },
  { name: "Crime & True Crime", kind: SEARCH, query: "true crime" },
  { name: "Horror", kind: SEARCH, query: "horror" },
  { name: "Romance", kind: SEARCH, query: "romance" },
  { name: "Historical Fiction", kind: SEARCH, query: "historical fiction" },
  { name: "Dystopian & Post-Apocalyptic", kind: SEARCH, query: "dystopian" },
  { name: "Adventure & Action", kind: SEARCH, query: "adventure" },

  // -- non-fiction ------------------------------------------------------------
  { name: "Biographies & Memoirs", kind: SEARCH, query: "memoir" },
  { name: "History", kind: SEARCH, query: "history" },
  { name: "Politics & Social Science", kind: SEARCH, query: "politics" },
  { name: "Business, Money & Finance", kind: SEARCH, query: "business" },
  { name: "Science & Technology", kind: SEARCH, query: "science" },
  { name: "Psychology & Mental Health", kind: SEARCH, query: "psychology" },
  { name: "Health, Fitness & Nutrition", kind: SEARCH, query: "health" },
  { name: "Relationships & Family", kind: SEARCH, query: "relationships" },
  { name: "Self-Help & Personal Development", kind: SEARCH, query: "self help" },
  { name: "Religion & Spirituality", kind: SEARCH, query: "spirituality" },
  { name: "Art & Design", kind: SEARCH, query: "art of" },
  { name: "Cooking & Food", kind: SEARCH, query: "cookbook" },
  { name: "Travel & Culture", kind: SEARCH, query: "travel" },
  { name: "Sports & Recreation", kind: SEARCH, query: "sports" },

  // -- kids & teens -----------------------------------------------------------
  { name: "Teen & Young Adult", kind: SEARCH, query: "young adult" },
  { name: "Children's Audiobooks", kind: SEARCH, query: "children" },

  // -- franchises (very reliable: the name is in the title) -------------------
  { name: "Star Wars", kind: SEARCH, query: "Star Wars" },
  { name: "Harry Potter", kind: SEARCH, query: "Harry Potter" },
  { name: "Discworld", kind: SEARCH, query: "Discworld" },
  { name: "A Song of Ice & Fire", kind: SEARCH, query: "A Song of Ice and Fire" },
  { name: "The Wheel of Time", kind: SEARCH, query: "Wheel of Time" },
  { name: "Sherlock Holmes", kind: SEARCH, query: "Sherlock Holmes" },
  { name: "The Expanse", kind: SEARCH, query: "The Expanse" },
  { name: "Red Rising", kind: SEARCH, query: "Red Rising" },

  // -- popular authors --------------------------------------------------------
  { name: "Andy Weir", kind: SEARCH, query: "Andy Weir" },
  { name: "Brandon Sanderson", kind: SEARCH, query: "Brandon Sanderson" },
  { name: "Stephen King", kind: SEARCH, query: "Stephen King" },
  { name: "Agatha Christie", kind: SEARCH, query: "Agatha Christie" },
  { name: "J.R.R. Tolkien", kind: SEARCH, query: "Tolkien" },
  { name: "George R.R. Martin", kind: SEARCH, query: "George R.R. Martin" },
];

const BY_NAME = new Map(GENRES.map((g) => [g.name.toLowerCase(), g]));

/** Display names, in dropdown order, for the manifest. */
const GENRE_OPTIONS = GENRES.map((g) => g.name);

const DEFAULT_GENRE = GENRES[0];

/**
 * Look up a genre by its display name.
 * Unknown or missing names fall back to the default browse category, which
 * matches the old behaviour (an unrecognised genre just browsed the front page).
 */
function resolveGenre(name) {
  if (!name) return DEFAULT_GENRE;
  const key = String(name).trim().toLowerCase();
  return BY_NAME.get(key) || DEFAULT_GENRE;
}

module.exports = {
  GENRES,
  GENRE_OPTIONS,
  DEFAULT_GENRE,
  resolveGenre,
  BROWSE,
  TORBOX,
  SEARCH,
  RECS,
};

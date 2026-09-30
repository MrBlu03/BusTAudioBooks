// src/manifest.js

const { GENRE_OPTIONS } = require("./genres");

const ID_PREFIX = "tbab:"; // "TorBox AudioBook" — our custom stream/meta ids

// Featured categories exposed as top-level catalogs so they appear as individual
// horizontal scrolling rows directly on Stremio, Nuvio, and AIOMeta Home feeds.
const FEATURED_HOME_ROWS = [
  { id: "tbab-recs", name: "Audiobooks: Recommended For You", genre: "Recommended For You", recsOnly: true },
  { id: "tbab-popular", name: "Audiobooks: Popular & Trending", genre: "Popular & Trending" },
  { id: "tbab-torbox", name: "Audiobooks: In Your TorBox", genre: "In Your TorBox" },
  { id: "tbab-series", name: "Audiobooks: Popular Series", genre: "Popular Series" },
  { id: "tbab-scifi", name: "Audiobooks: Science Fiction", genre: "Science Fiction" },
  { id: "tbab-fantasy", name: "Audiobooks: Fantasy & Magic", genre: "Fantasy & Magic" },
  { id: "tbab-horror", name: "Audiobooks: Horror", genre: "Horror" },
  { id: "tbab-mystery", name: "Audiobooks: Mystery & Detective", genre: "Mystery & Detective" },
  { id: "tbab-thriller", name: "Audiobooks: Thriller & Suspense", genre: "Thriller & Suspense" },
  { id: "tbab-history", name: "Audiobooks: History & Non-Fiction", genre: "History" },
];

const CATALOG_ID_TO_GENRE = Object.fromEntries(
  FEATURED_HOME_ROWS.map((r) => [r.id, r.genre])
);

/**
 * Build the manifest.
 *
 * "Recommended For You" is only advertised when the generated file actually has
 * playable entries. This addon is shared, and the recommendations belong to
 * whoever set up Nuvio credentials — offering an empty row to everyone else
 * just makes the addon look broken. Bumping `version` is what makes Stremio
 * refetch this, so it stays in step with src/genres.js.
 */
function buildManifest({ withRecs = true } = {}) {
  // Primary discover catalog: kept as catalogs[0] with full 45-genre dropdown
  // and search, placed under "other" segment to unify all catalogs cleanly.
  const masterCatalog = {
    type: "other",
    id: "torbox-audiobooks",
    name: "Audiobooks",
    extra: [
      {
        name: "genre",
        options: withRecs ? GENRE_OPTIONS : GENRE_OPTIONS_WITHOUT_RECS,
      },
      { name: "search" },
      { name: "skip" },
    ],
  };

  // Top-level catalogs for the Home Feed / Board:
  // Placed strictly under "other" so Nuvio and Stremio display each row without
  // duplicating rows across multiple segments.
  const homeCatalogs = [];
  for (const row of FEATURED_HOME_ROWS) {
    if (row.recsOnly && !withRecs) continue;
    homeCatalogs.push({
      type: "other",
      id: row.id,
      name: row.name,
      extra: [{ name: "skip" }],
    });
  }

  return {
    id: "community.torbox.audiobooks",
    version: "2.5.1",
    name: "BusTAudioBooks",
    description:
      "Search audiobooks and stream or download them through your TorBox account.",
    types: ["other", "audiobook", "series"],
    // Only ids we mint get routed to this addon's meta/stream handlers.
    idPrefixes: [ID_PREFIX],
    resources: ["catalog", "meta", "stream"],
    catalogs: [masterCatalog, ...homeCatalogs],
    behaviorHints: {
      configurable: true,
      configurationRequired: true,
    },
  };
}

// Computed once: GENRE_OPTIONS filtered to drop the recommendations row.
const GENRE_OPTIONS_WITHOUT_RECS = GENRE_OPTIONS.filter((n) => n !== "Recommended For You");

// The plain object, for tests and anything that does not need a custom variant.
const manifest = buildManifest();

module.exports = {
  manifest,
  buildManifest,
  ID_PREFIX,
  FEATURED_HOME_ROWS,
  CATALOG_ID_TO_GENRE,
};

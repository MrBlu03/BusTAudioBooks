// src/manifest.js

const { GENRE_OPTIONS } = require("./genres");

const ID_PREFIX = "tbab:"; // "TorBox AudioBook" — our custom stream/meta ids

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
  return {
    id: "community.torbox.audiobooks",
    version: "2.4.0",
    name: "BusTAudioBooks",
    description:
      "Search audiobooks and stream or download them through your TorBox account.",
    types: ["audiobook", "other"],
    // Only ids we mint get routed to this addon's meta/stream handlers.
    idPrefixes: [ID_PREFIX],
    resources: ["catalog", "meta", "stream"],
    catalogs: [
      {
        type: "audiobook",
        id: "torbox-audiobooks",
        name: "Audiobooks",
        extra: [
          {
            name: "genre",
            // Populated from src/genres.js so the dropdown and the handler can
            // never drift apart. Stremio renders this as a flat list, so the
            // order there is the grouping: featured, fiction, non-fiction,
            // kids & teens, franchises, authors.
            options: withRecs ? GENRE_OPTIONS : GENRE_OPTIONS_WITHOUT_RECS,
          },
          { name: "search" },
          { name: "skip" },
        ],
      },
    ],
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

module.exports = { manifest, buildManifest, ID_PREFIX };

// src/manifest.js

const { GENRE_OPTIONS } = require("./genres");

const ID_PREFIX = "tbab:"; // "TorBox AudioBook" — our custom stream/meta ids

const manifest = {
  id: "community.torbox.audiobooks",
  version: "2.3.0",
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
          options: GENRE_OPTIONS,
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

module.exports = { manifest, ID_PREFIX };

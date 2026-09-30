// src/manifest.js

const ID_PREFIX = "tbab:"; // "TorBox AudioBook" — our custom stream/meta ids

const manifest = {
  id: "community.torbox.audiobooks",
  version: "2.2.0",
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
          options: [
            "Popular & Trending",
            "In Your TorBox",
            "Popular Series",
            "Science Fiction",
            "Fantasy & Magic",
            "Star Wars",
          ],
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

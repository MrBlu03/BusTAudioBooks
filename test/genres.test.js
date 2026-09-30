// test/genres.test.js
// The genre table drives both the manifest dropdown and the catalog handler,
// so the two drifting apart is the main failure mode worth guarding.

const test = require("node:test");
const assert = require("node:assert");

const { GENRES, GENRE_OPTIONS, DEFAULT_GENRE, resolveGenre, BROWSE, TORBOX, SEARCH, RECS } = require("../src/genres");
const { manifest } = require("../src/manifest");

test("manifest dropdown is generated from the genre table", () => {
  const opts = manifest.catalogs[0].extra.find((e) => e.name === "genre").options;
  assert.deepEqual(opts, GENRE_OPTIONS, "manifest options must equal GENRE_OPTIONS");
  assert.equal(opts.length, GENRES.length);
});

test("the manifest version was bumped so Stremio refetches it", () => {
  // Stremio caches manifests aggressively; without a bump the old 6-option
  // dropdown sticks around in the installed addon.
  assert.notEqual(manifest.version, "2.2.0", "bump manifest.version when genres change");
});

test("genre names are unique", () => {
  const seen = new Set();
  for (const g of GENRES) {
    const k = g.name.toLowerCase();
    assert.ok(!seen.has(k), `duplicate genre name: ${g.name}`);
    seen.add(k);
  }
});

test("display names are non-empty and reasonably short", () => {
  for (const g of GENRES) {
    assert.ok(g.name && g.name.trim().length > 0, "genre needs a name");
    assert.ok(g.name.length <= 32, `"${g.name}" is too long for a Stremio dropdown`);
  }
});

test("every genre has a valid kind", () => {
  for (const g of GENRES) {
    assert.ok([BROWSE, TORBOX, SEARCH, RECS].includes(g.kind), `${g.name} has kind "${g.kind}"`);
  }
});

test("exactly one recommendations category, listed near the top", () => {
  const recs = GENRES.filter((g) => g.kind === RECS);
  assert.equal(recs.length, 1, "expected exactly one RECS genre");
  // Beside the other account-specific categories, not buried in the fiction list.
  assert.ok(GENRE_OPTIONS.indexOf(recs[0].name) <= 3, "Recommended For You should sit near the top");
});

test("search genres carry a usable query; non-search genres do not", () => {
  for (const g of GENRES) {
    if (g.kind === SEARCH) {
      assert.ok(typeof g.query === "string" && g.query.trim().length >= 3, `${g.name} needs a query`);
    } else {
      assert.equal(g.query, null, `${g.name} is ${g.kind}, so query should be null`);
    }
  }
});

test("exactly one browse category and one torbox category", () => {
  assert.equal(GENRES.filter((g) => g.kind === BROWSE).length, 1);
  assert.equal(GENRES.filter((g) => g.kind === TORBOX).length, 1);
});

test("the default genre is the browse category and is listed first", () => {
  assert.equal(DEFAULT_GENRE, GENRES[0]);
  assert.equal(DEFAULT_GENRE.kind, BROWSE);
  assert.equal(GENRE_OPTIONS[0], DEFAULT_GENRE.name);
});

test("resolveGenre finds entries case- and whitespace-insensitively", () => {
  assert.equal(resolveGenre("Science Fiction").name, "Science Fiction");
  assert.equal(resolveGenre("  science fiction  ").name, "Science Fiction");
  assert.equal(resolveGenre("star wars").name, "Star Wars");
});

test("unknown and missing genres fall back to default browse", () => {
  // This preserves the pre-genres behaviour: a stale bookmark pointing at a
  // removed category should still render a catalogue rather than error.
  assert.equal(resolveGenre("Nonexistent Category"), DEFAULT_GENRE);
  assert.equal(resolveGenre(""), DEFAULT_GENRE);
  assert.equal(resolveGenre(undefined), DEFAULT_GENRE);
  assert.equal(resolveGenre(null), DEFAULT_GENRE);
});

test("the original six categories are all still present", () => {
  // Existing installs have these baked into saved catalogue requests.
  for (const name of [
    "Popular & Trending",
    "In Your TorBox",
    "Popular Series",
    "Science Fiction",
    "Fantasy & Magic",
    "Star Wars",
  ]) {
    assert.ok(GENRE_OPTIONS.includes(name), `regression: "${name}" was removed`);
  }
});

test("'Popular Series' no longer searches the bare word 'series'", () => {
  // Searching "series" matches any title containing the word series, which
  // includes non-fiction about series. "complete series" is the audiobook
  // naming convention for a box set.
  const g = resolveGenre("Popular Series");
  assert.equal(g.query, "complete series");
});

test("no search genre uses Audible category names as bare queries", () => {
  // ABB matches post titles, so a term like "Business, Money & Finance"
  // returns nothing. The display name may be Audible-styled but the query
  // must be a phrase that appears in release names.
  const pureTaxonomy = /^(literature & fiction|science fiction & fantasy|arts, crafts|business, money & finance)$/i;
  for (const g of GENRES) {
    if (g.kind !== SEARCH) continue;
    assert.ok(!pureTaxonomy.test(g.query), `${g.name} uses a taxonomy name as its query`);
    // Commas and ampersands are near-useless in an ABB title query.
    assert.ok(!/[,&]/.test(g.query), `${g.name} query contains punctuation: "${g.query}"`);
  }
});

test("the genre list actually grew beyond the original six", () => {
  assert.ok(GENRE_OPTIONS.length >= 30, `expected a much larger set, got ${GENRE_OPTIONS.length}`);
});

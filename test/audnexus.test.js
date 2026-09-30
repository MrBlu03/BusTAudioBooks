// test/audnexus.test.js
// Tests for Audnexus metadata parsing, provider integration, and home feed catalog manifests.

const test = require("node:test");
const assert = require("node:assert");

const { cleanTitleForSearch } = require("../src/audnexus");
const { buildManifest, FEATURED_HOME_ROWS, CATALOG_ID_TO_GENRE } = require("../src/manifest");

test("cleanTitleForSearch removes tags, series numbers, and brackets", () => {
  assert.equal(
    cleanTitleForSearch("The Way of Kings [M4B] (Stormlight Archive #1) [64 kbps]"),
    "The Way of Kings"
  );
  assert.equal(
    cleanTitleForSearch("Dune - Complete Series Unabridged"),
    "Dune -"
  );
  assert.equal(
    cleanTitleForSearch("Project Hail Mary"),
    "Project Hail Mary"
  );
});

test("manifest provides top-level home feed catalogs with other and audiobook types", () => {
  const man = buildManifest({ withRecs: true });
  assert.equal(man.version, "2.5.0");
  assert.ok(man.types.includes("other") && man.types.includes("audiobook"));

  // First catalog is master discover catalog
  assert.equal(man.catalogs[0].id, "torbox-audiobooks");

  // Subsequent catalogs are top-level home rows
  const homeCats = man.catalogs.slice(1);
  assert.ok(homeCats.length >= 10, "should have multiple home feed catalogs");

  const recsCat = homeCats.find((c) => c.id === "tbab-recs" && c.type === "other");
  assert.ok(recsCat, "tbab-recs must exist for home feed");

  const popularCat = homeCats.find((c) => c.id === "tbab-popular" && c.type === "other");
  assert.ok(popularCat, "tbab-popular must exist for home feed");

  const scifiCat = homeCats.find((c) => c.id === "tbab-scifi" && c.type === "other");
  assert.ok(scifiCat, "tbab-scifi must exist for home feed");
});

test("CATALOG_ID_TO_GENRE maps all featured catalog IDs to valid genre names", () => {
  assert.equal(CATALOG_ID_TO_GENRE["tbab-recs"], "Recommended For You");
  assert.equal(CATALOG_ID_TO_GENRE["tbab-popular"], "Popular & Trending");
  assert.equal(CATALOG_ID_TO_GENRE["tbab-scifi"], "Science Fiction");
  assert.equal(CATALOG_ID_TO_GENRE["tbab-fantasy"], "Fantasy & Magic");
  assert.equal(CATALOG_ID_TO_GENRE["tbab-horror"], "Horror");
  assert.equal(CATALOG_ID_TO_GENRE["tbab-history"], "History");
});

test("recs catalog is excluded from home feed when withRecs is false", () => {
  const man = buildManifest({ withRecs: false });
  const hasRecs = man.catalogs.some((c) => c.id === "tbab-recs");
  assert.equal(hasRecs, false, "tbab-recs should not appear when withRecs is false");
});

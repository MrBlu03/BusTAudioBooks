// test/audnexus.test.js
// Tests for Audnexus metadata parsing, provider integration, and home feed catalog manifests.

const test = require("node:test");
const assert = require("node:assert");

const { cleanTitleForSearch, cleanAudiblePoster, cleanSynopsis } = require("../src/audnexus");
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

test("cleanAudiblePoster upscales Amazon/Audible artwork to studio resolution", () => {
  assert.equal(
    cleanAudiblePoster("https://m.media-amazon.com/images/I/71-1WBgjGoL._SL500_.jpg"),
    "https://m.media-amazon.com/images/I/71-1WBgjGoL.jpg"
  );
  assert.equal(
    cleanAudiblePoster("http://images-na.ssl-images-amazon.com/images/I/51abcXYZ._SX300_.png"),
    "https://images-na.ssl-images-amazon.com/images/I/51abcXYZ.png"
  );
  assert.equal(cleanAudiblePoster(null), null);
});

test("cleanSynopsis strips HTML tags and Audible copyright disclaimers", () => {
  const dirty = "<p>A sweeping galactic epic.</p> ©2021 Frank Herbert (P)2021 Macmillan Audio";
  assert.equal(cleanSynopsis(dirty), "A sweeping galactic epic.");
});

test("manifest provides top-level home feed catalogs strictly under other with no duplicates", () => {
  const man = buildManifest({ withRecs: true });
  assert.equal(man.version, "2.5.1");
  assert.ok(man.types.includes("other") && man.types.includes("audiobook"));

  // First catalog is master discover catalog under "other"
  assert.equal(man.catalogs[0].id, "torbox-audiobooks");
  assert.equal(man.catalogs[0].type, "other");

  // Subsequent catalogs are top-level home rows under "other"
  const homeCats = man.catalogs.slice(1);
  assert.ok(homeCats.length >= 10, "should have multiple home feed catalogs");

  // Every catalog must strictly be type "other" to avoid duplicate rows in Nuvio
  for (const c of man.catalogs) {
    assert.equal(c.type, "other", `catalog ${c.id} must have type other`);
  }

  // Ensure NO duplicate catalog IDs exist
  const ids = man.catalogs.map((c) => c.id);
  const uniqueIds = new Set(ids);
  assert.equal(ids.length, uniqueIds.size, "manifest must not have duplicate catalog entries");

  const recsCat = homeCats.find((c) => c.id === "tbab-recs");
  assert.ok(recsCat, "tbab-recs must exist for home feed");

  const popularCat = homeCats.find((c) => c.id === "tbab-popular");
  assert.ok(popularCat, "tbab-popular must exist for home feed");

  const scifiCat = homeCats.find((c) => c.id === "tbab-scifi");
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

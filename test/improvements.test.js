// test/improvements.test.js
// Tests verifying the bug fixes and improvements:
// - Season discrimination in itemid
// - Series episode ID uniqueness across seasons
// - HTML entity decoding and zero-width/NBSP whitespace cleaning
// - Flexible sequence parsing in normalizeAudibleProduct

const test = require("node:test");
const assert = require("node:assert");

const { encodeItemId, decodeItemId } = require("../src/itemid");
const { cleanTitle } = require("../src/metadata");
const { _clean: clean } = require("../src/sources");
const { cleanTitleForParsing, cleanDisplayTitle } = require("../src/series");
const { cleanSynopsis } = require("../src/audnexus");
const { normalizeAudibleProduct } = require("../src/catalogs_meta");
const { fetchSeriesMeta } = require("../src/series_meta");

test("itemid encodes and decodes season cleanly with default to 1", () => {
  const itemS1 = {
    type: "series",
    seriesName: "Foundation",
    bookNumber: 1,
    season: 1,
    name: "Foundation",
    author: "Isaac Asimov",
  };
  const idS1 = encodeItemId(itemS1);
  const decodedS1 = decodeItemId(idS1);
  assert.equal(decodedS1.season, 1);
  assert.equal(decodedS1.seriesName, "Foundation");
  assert.equal(decodedS1.bookNumber, 1);

  const itemS2 = {
    type: "series",
    seriesName: "Foundation",
    bookNumber: 1,
    season: 2,
    name: "Foundation",
    author: "Isaac Asimov",
  };
  const idS2 = encodeItemId(itemS2);
  const decodedS2 = decodeItemId(idS2);
  assert.equal(decodedS2.season, 2);
  assert.notEqual(idS1, idS2, "Season 1 and Season 2 item IDs must be distinct even with identical book titles");

  // Backward compatibility: when season is not provided, defaults to 1
  const itemLegacy = {
    type: "series",
    seriesName: "Foundation",
    name: "Foundation",
  };
  const idLegacy = encodeItemId(itemLegacy);
  const decodedLegacy = decodeItemId(idLegacy);
  assert.equal(decodedLegacy.season, 1);
});

test("fetchSeriesMeta generates unique video IDs across Season 1 and Season 2", async () => {
  const meta = await fetchSeriesMeta("Foundation", "Isaac Asimov");
  assert.ok(meta);
  assert.ok(Array.isArray(meta.videos));
  assert.ok(meta.videos.length > 0);

  const s1Videos = meta.videos.filter((v) => v.season === 1);
  const s2Videos = meta.videos.filter((v) => v.season === 2);
  assert.ok(s1Videos.length >= 7, "Expected at least 7 release order books");
  assert.ok(s2Videos.length >= 7, "Expected at least 7 chronological order books");

  const videoIds = meta.videos.map((v) => v.id);
  const uniqueIds = new Set(videoIds);
  assert.equal(uniqueIds.size, videoIds.length, "All video IDs across both seasons must be globally unique");
});

test("cleanTitle and clean strip zero-width characters and non-breaking spaces", () => {
  const messy1 = "Dune\u200B\uFEFF - Frank\u00A0Herbert [MP3]";
  const cleaned1 = cleanTitle(messy1);
  assert.equal(cleaned1, "Dune");

  const messy2 = "Foundation&nbsp;&amp;&nbsp;Empire&#8212;Isaac&#160;Asimov";
  const cleaned2 = clean(messy2);
  assert.ok(!cleaned2.includes("&nbsp;"));
  assert.ok(!cleaned2.includes("&#160;"));
  assert.ok(cleaned2.includes("Foundation & Empire—Isaac Asimov") || cleaned2.includes("Foundation & Empire"));

  const parseCleaned = cleanTitleForParsing("The\u200C \u00A0Hobbit\uFEFF [128 kbps]");
  assert.equal(parseCleaned, "The Hobbit");

  const displayCleaned = cleanDisplayTitle("The\u200B \u00A0Fellowship of the Ring\uFEFF (unabridged)");
  assert.equal(displayCleaned, "The Fellowship of the Ring");
});

test("cleanSynopsis decodes HTML entities and strips zero-width/NBSP", () => {
  const raw = "<p>A great story&nbsp;&amp;&nbsp;epic tale&#8212;with &quot;quotes&quot; and &#8217;apostrophes&#8217;.\u200B</p>";
  const syn = cleanSynopsis(raw);
  assert.ok(!syn.includes("<p>"));
  assert.ok(!syn.includes("&nbsp;"));
  assert.ok(!syn.includes("&quot;"));
  assert.ok(syn.includes('"quotes"'));
  assert.ok(syn.includes("’apostrophes’"));
  assert.ok(syn.includes("epic tale—with"));
});

test("normalizeAudibleProduct extracts sequence from 'Book 1' and '#2'", () => {
  const sample1 = {
    title: "Children of Dune",
    authors: [{ name: "Frank Herbert" }],
    series: [{ title: "Dune", sequence: "Book 3" }],
    language: "English",
  };
  const item1 = normalizeAudibleProduct(sample1);
  assert.ok(item1);
  assert.equal(item1.bookNumber, 3);

  const sample2 = {
    title: "Dune Messiah",
    authors: [{ name: "Frank Herbert" }],
    series: [{ title: "Dune", sequence: "#2" }],
    language: "English",
  };
  const item2 = normalizeAudibleProduct(sample2);
  assert.ok(item2);
  assert.equal(item2.bookNumber, 2);
});

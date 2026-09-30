// test/series_order_search.test.js
// Tests series release orders for Foundation & Dune, series prioritization in search,
// and deduplication of search results.

const test = require("node:test");
const assert = require("node:assert");
const { fetchSeriesBooks, fetchSeriesMeta } = require("../src/series_meta");
const { getBookKey, sortInSeriesOrder, parseSeriesAndBook } = require("../src/series");

test("Foundation series has correct dual reading orders (Release 1951..1993 vs Chronological)", async () => {
  const meta = await fetchSeriesMeta("Foundation", "Isaac Asimov");
  assert.ok(meta, "Expected series meta for Foundation");
  assert.ok(Array.isArray(meta.videos), "Expected videos array");

  const s1Videos = meta.videos.filter((v) => v.season === 1);
  const s2Videos = meta.videos.filter((v) => v.season === 2);

  assert.equal(s1Videos.length, 7, "Expected 7 books in Season 1 (Release Order)");
  assert.equal(s2Videos.length, 7, "Expected 7 books in Season 2 (Chronological Order)");

  // Season 1: Release Order starts with Foundation (1951)
  assert.ok(
    s1Videos[0].title.includes("Foundation") && !s1Videos[0].title.includes("Prelude"),
    `Expected Season 1 Book 1 to be Foundation, got: ${s1Videos[0].title}`
  );
  assert.ok(s1Videos[0].title.includes("1951"), "Expected publication year 1951 in Season 1 Book 1");

  // Season 1 ends with Forward the Foundation (1993)
  assert.ok(
    s1Videos[6].title.includes("Forward the Foundation"),
    `Expected Season 1 Book 7 to be Forward the Foundation, got: ${s1Videos[6].title}`
  );
  assert.ok(s1Videos[6].title.includes("1993"), "Expected publication year 1993 in Season 1 Book 7");

  // Season 2: Chronological Order starts with Prelude to Foundation
  assert.ok(
    s2Videos[0].title.includes("Prelude to Foundation"),
    `Expected Season 2 Book 1 to be Prelude to Foundation, got: ${s2Videos[0].title}`
  );

  // Description advertises both orders
  assert.ok(meta.description.includes("Dual Reading Orders Available"), "Expected dual reading orders in description");
  assert.ok(meta.description.includes("Season 1: Release / Publication Order"), "Expected Season 1 description");
  assert.ok(meta.description.includes("Season 2: Chronological Story Order"), "Expected Season 2 description");

  // Ensure NO finance book metadata pollution
  assert.ok(!meta.description.includes("Scaling Your Business"), "Must not include finance book description");
  assert.ok(!meta.description.includes("A. C. Knapp"), "Must not include A. C. Knapp");
  assert.equal(meta.cast?.[0], "Isaac Asimov", "Cast must be Isaac Asimov");
});

test("fetchSeriesWikiExtract extracts Wikipedia series summary for Foundation", async () => {
  const { fetchSeriesWikiExtract } = require("../src/series_meta");
  const extract = await fetchSeriesWikiExtract("Foundation", "Isaac Asimov");
  assert.ok(extract, "Expected extract from Wikipedia series summary");
  assert.ok(extract.includes("1951"), "Expected 1951 in summary extract");
  assert.ok(extract.includes("Isaac Asimov"), "Expected Isaac Asimov in summary extract");
});

test("audnexus findAsin resolves Isaac Asimov's Foundation and rejects unrelated finance book", async () => {
  const audnexus = require("../src/audnexus");
  const m = await audnexus.lookupAudnexus("Foundation", "Isaac Asimov");
  assert.ok(m, "Expected Audnexus match for Foundation");
  assert.ok(m.title.toLowerCase().includes("foundation"), "Title should contain Foundation");
  assert.ok(m.author.toLowerCase().includes("asimov"), "Author must be Isaac Asimov");
  assert.ok(!m.author.includes("Knapp"), "Author must NOT be Knapp");
  assert.ok(!m.description?.includes("Scaling Your Business"), "Description must not be finance book");
});

test("fetchSeriesMeta prioritizes collectionPoster over extraMeta.poster", async () => {
  const fakeWrongPoster = "https://example.com/finance-book-cover.jpg";
  const meta = await fetchSeriesMeta("Foundation", "Isaac Asimov", {
    poster: fakeWrongPoster,
  });
  assert.ok(meta, "Expected series meta");
  assert.notEqual(meta.poster, fakeWrongPoster, "Series poster should be collection poster, not extraMeta.poster");
});

test("Dune series resolves Frank Herbert canonical 6 books without Brian Herbert duplicates", async () => {
  const dune = await fetchSeriesBooks("Dune", "Frank Herbert");
  assert.ok(dune, "Expected series data for Dune");
  assert.ok(Array.isArray(dune.books), "Expected books array");

  // Must have 6 canonical books
  assert.equal(dune.books.length, 6, `Expected exactly 6 canonical books, got ${dune.books.length}`);

  const expectedTitles = [
    "Dune",
    "Dune Messiah",
    "Children of Dune",
    "God Emperor of Dune",
    "Heretics of Dune",
    "Chapterhouse Dune",
  ];

  for (let i = 0; i < expectedTitles.length; i++) {
    assert.equal(dune.books[i].title, expectedTitles[i], `Expected Book ${i + 1} to be ${expectedTitles[i]}`);
    assert.equal(dune.books[i].seq, i + 1, `Expected Book ${i + 1} seq to be ${i + 1}`);
  }

  // Ensure no Brian Herbert spin-offs were admitted
  for (const b of dune.books) {
    assert.ok(!b.title.includes("Butlerian"), "Butlerian Jihad must not be in canonical Dune series");
    assert.ok(!b.title.includes("Caladan"), "Caladan spin-off must not be in canonical Dune series");
    assert.ok(!b.title.includes("Machine Crusade"), "Machine Crusade must not be in canonical Dune series");
  }
});

test("getBookKey deduplicates multiple releases of the same book using seriesCandidate", () => {
  const seriesCandidate = {
    seriesName: "Dune",
    author: "Frank Herbert",
    books: [
      { seq: 1, title: "Dune" },
      { seq: 2, title: "Dune Messiah" },
      { seq: 3, title: "Children of Dune" },
      { seq: 4, title: "God Emperor of Dune" },
      { seq: 5, title: "Heretics of Dune" },
      { seq: 6, title: "Chapterhouse Dune" },
    ],
  };

  // Multiple releases of Book 1 (Dune)
  const rel1 = "Frank Herbert - Dune (Unabridged)";
  const rel2 = "Frank Herbert - Dune [MP3 64kbps]";
  const rel3 = "Dune (1965) [Frank Herbert] [Audiobook]";

  const k1 = getBookKey(rel1, "Frank Herbert", "dune", seriesCandidate);
  const k2 = getBookKey(rel2, "Frank Herbert", "dune", seriesCandidate);
  const k3 = getBookKey(rel3, "Frank Herbert", "dune", seriesCandidate);

  assert.equal(k1, "dune:book:1");
  assert.equal(k2, "dune:book:1");
  assert.equal(k3, "dune:book:1");

  // Collection packs deduplicated to single collection key
  const col1 = "The Dune Saga - All Six Books, Fully Chaptered - Frank Herbert";
  const col2 = "The DUNE Saga - Frank Herbert";
  const col3 = "Dune Series (01 - 27)";

  const cKey1 = getBookKey(col1, "Frank Herbert", "dune", seriesCandidate);
  const cKey2 = getBookKey(col2, "Frank Herbert", "dune", seriesCandidate);
  const cKey3 = getBookKey(col3, "Frank Herbert", "dune", seriesCandidate);

  assert.equal(cKey1, "dune:collection:all");
  assert.equal(cKey2, "dune:collection:all");
  assert.equal(cKey3, "dune:collection:all");
});

test("sortInSeriesOrder places collections and series books ahead of standalones when query is of a series", () => {
  const items = [
    { name: "Stand Alone Spinoff", seriesInfo: null },
    { name: "Dune Messiah", seriesInfo: { seriesName: "dune", bookNumber: 2 } },
    { name: "The Dune Saga Complete", isSeries: true, seriesInfo: { seriesName: "dune", isCollection: true } },
    { name: "Dune", seriesInfo: { seriesName: "dune", bookNumber: 1 } },
  ];

  const sorted = sortInSeriesOrder(items, { prioritizeSeries: true });

  // Collections first, then Book 1, Book 2, then standalones
  assert.equal(sorted[0].name, "The Dune Saga Complete");
  assert.equal(sorted[1].name, "Dune");
  assert.equal(sorted[2].name, "Dune Messiah");
  assert.equal(sorted[3].name, "Stand Alone Spinoff");
});

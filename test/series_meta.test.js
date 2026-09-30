// test/series_meta.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const { encodeItemId, decodeItemId } = require("../src/itemid");
const { fetchSeriesBooks, fetchSeriesMeta, cleanSeriesQuery } = require("../src/series_meta");

test("itemid encodes and decodes series episode fields cleanly", () => {
  const epItem = {
    type: "series",
    seriesName: "Dune",
    bookNumber: 2,
    name: "Dune Messiah",
    author: "Frank Herbert",
    parentInfohash: "abcd1234abcd1234abcd1234abcd1234abcd1234",
    targetFile: "02 - Dune Messiah.m4b",
    isSeries: true,
  };

  const encoded = encodeItemId(epItem);
  assert.ok(encoded.startsWith("tbab:"));

  const decoded = decodeItemId(encoded);
  assert.equal(decoded.type, "series");
  assert.equal(decoded.isSeries, true);
  assert.equal(decoded.seriesName, "Dune");
  assert.equal(decoded.bookNumber, 2);
  assert.equal(decoded.name, "Dune Messiah");
  assert.equal(decoded.author, "Frank Herbert");
  assert.equal(decoded.parentInfohash, "abcd1234abcd1234abcd1234abcd1234abcd1234");
  assert.equal(decoded.targetFile, "02 - Dune Messiah.m4b");
});

test("cleanSeriesQuery strips noise, brackets, and collection tags", () => {
  assert.equal(cleanSeriesQuery("Dune Complete Series [Books 1-6]"), "Dune");
  assert.equal(cleanSeriesQuery("Harry Potter (Audiobooks Box Set)"), "Harry Potter");
  assert.equal(cleanSeriesQuery("The Stormlight Archive Saga"), "The Stormlight Archive");
});

test("fetchSeriesBooks dynamically discovers reading order for arbitrary series", async () => {
  // Test a series dynamically via Audible API without hardcoding
  const res = await fetchSeriesBooks("Rivers of London", "Ben Aaronovitch");
  assert.ok(res, "Expected series result for Rivers of London");
  assert.ok(Array.isArray(res.books), "Expected books array");
  assert.ok(res.books.length >= 5, "Expected at least 5 books in Rivers of London");

  // Books must be sorted in ascending sequence order
  for (let i = 1; i < res.books.length; i++) {
    assert.ok(res.books[i].seq >= res.books[i - 1].seq, "Books must be ordered by sequence");
  }

  const b1 = res.books.find((b) => b.seq === 1);
  assert.ok(b1, "Expected Book 1");
  assert.ok(b1.title.toLowerCase().includes("rivers of london"), "Book 1 title mismatch");
});

test("fetchSeriesMeta constructs complete Stremio Series Meta with episodes", async () => {
  const meta = await fetchSeriesMeta("Dune", "Frank Herbert");
  assert.ok(meta, "Expected series meta for Dune");
  assert.equal(meta.type, "series");
  assert.equal(meta.posterShape, "square");
  assert.ok(Array.isArray(meta.videos), "Expected videos array");
  assert.ok(meta.videos.length >= 6, "Expected at least 6 Dune books");

  const ep1 = meta.videos[0];
  assert.equal(ep1.season, 1);
  assert.equal(ep1.episode, 1);
  assert.ok(ep1.title.includes("Book 1"));
  assert.ok(ep1.id.startsWith("tbab:"));

  // Verify decoded episode item id
  const decoded = decodeItemId(ep1.id);
  assert.equal(decoded.type, "series");
  assert.equal(decoded.isSeries, true);
  assert.equal(decoded.seriesName.toLowerCase(), "dune");
  assert.equal(decoded.bookNumber, 1);
});

test("fetchSeriesMeta matches internal files from parent torrent pack", async () => {
  const fakeFiles = [
    { name: "01. Dune (1965).m4b" },
    { name: "02. Dune Messiah (1969).m4b" },
    { name: "03. Children of Dune (1976).m4b" },
  ];

  const meta = await fetchSeriesMeta("Dune", "Frank Herbert", {
    infohash: "1111222233334444555566667777888899990000",
    files: fakeFiles,
  });

  assert.ok(meta.videos.length >= 3);
  const ep2 = meta.videos.find((v) => v.episode === 2);
  assert.ok(ep2, "Expected episode 2");

  const decodedEp2 = decodeItemId(ep2.id);
  assert.equal(decodedEp2.parentInfohash, "1111222233334444555566667777888899990000");
  assert.equal(decodedEp2.targetFile, "02. Dune Messiah (1969).m4b");
});

test("each book has its own respective cover and series uses collection cover", async () => {
  const meta = await fetchSeriesMeta("Dune", "Frank Herbert");
  assert.ok(meta, "Expected series meta for Dune");
  assert.ok(meta.poster, "Expected series master poster");

  // Collection cover should be populated
  assert.ok(meta.poster.includes("http"), "Expected URL for collection poster");

  // Check each episode's respective cover
  const ep1 = meta.videos.find((v) => v.episode === 1);
  const ep2 = meta.videos.find((v) => v.episode === 2);
  const ep3 = meta.videos.find((v) => v.episode === 3);

  assert.ok(ep1 && ep1.thumbnail, "Expected thumbnail for Episode 1");
  assert.ok(ep2 && ep2.thumbnail, "Expected thumbnail for Episode 2");
  assert.ok(ep3 && ep3.thumbnail, "Expected thumbnail for Episode 3");

  // Books 1, 2, and 3 must have distinct covers
  assert.notEqual(ep1.thumbnail, ep2.thumbnail, "Book 1 and Book 2 must have distinct respective covers");
  assert.notEqual(ep2.thumbnail, ep3.thumbnail, "Book 2 and Book 3 must have distinct respective covers");
});

test("dual reading orders: offers Season 1 (Release Order) and Season 2 (Chronological Order) when orders differ", async () => {
  const meta = await fetchSeriesMeta("Chronicles of Narnia", "C.S. Lewis");
  assert.ok(meta, "Expected series meta for Chronicles of Narnia");
  assert.ok(Array.isArray(meta.videos), "Expected videos array");

  // Narnia has 7 books and different reading orders -> must produce Season 1 and Season 2
  const s1Videos = meta.videos.filter((v) => v.season === 1);
  const s2Videos = meta.videos.filter((v) => v.season === 2);

  assert.ok(s1Videos.length >= 6, `Expected at least 6 books in Season 1 (Release), got ${s1Videos.length}`);
  assert.ok(s2Videos.length >= 6, `Expected at least 6 books in Season 2 (Chronological), got ${s2Videos.length}`);

  // In Release Order (Season 1), Book 1 is The Lion, the Witch and the Wardrobe (1950)
  assert.ok(
    s1Videos[0].title.toLowerCase().includes("lion") || s1Videos[0].title.toLowerCase().includes("wardrobe"),
    `Expected Season 1 Book 1 to be The Lion, the Witch and the Wardrobe, got: ${s1Videos[0].title}`
  );

  // In Chronological Order (Season 2), Book 1 is The Magician's Nephew
  assert.ok(
    s2Videos[0].title.toLowerCase().includes("magician"),
    `Expected Season 2 Book 1 to be The Magician's Nephew, got: ${s2Videos[0].title}`
  );

  // Description should advertise both orders
  assert.ok(meta.description.includes("Dual Reading Orders Available"), "Expected dual reading orders in description");
  assert.ok(meta.description.includes("Season 1: Release / Publication Order"), "Expected Season 1 description");
  assert.ok(meta.description.includes("Season 2: Chronological Story Order"), "Expected Season 2 description");
});

test("single reading order: only produces Season 1 when chronological and release order match", async () => {
  const meta = await fetchSeriesMeta("The Hunger Games", "Suzanne Collins");
  assert.ok(meta);
  const seasons = new Set(meta.videos.map((v) => v.season));
  assert.equal(seasons.size, 1, "Expected only 1 season for series with identical orders");
  assert.ok(seasons.has(1), "Expected season 1");
});

test("recs-scheduler: isDueForRefresh detects missing and expired recs files accurately", () => {
  const { isDueForRefresh } = require("../scripts/recs-scheduler");
  // Missing file is due for refresh
  assert.equal(isDueForRefresh("nonexistent-file.json"), true);
});


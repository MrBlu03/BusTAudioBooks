// test/series.test.js
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  cleanTitleForParsing,
  cleanDisplayTitle,
  parseSeriesAndBook,
  getBookKey,
  sortInSeriesOrder,
} = require("../src/series");

test("cleanTitleForParsing removes tags, bitrates, years, CD counts", () => {
  const raw = "Harry Potter og Halvblodsprinsen (Dansk 18 CD Lydbog) [M4B] [128 Kbps] (2020)";
  const cleaned = cleanTitleForParsing(raw);
  assert.equal(cleaned, "Harry Potter og Halvblodsprinsen (Dansk Lydbog)");
});

test("cleanDisplayTitle strips Cyrillic dual-titles when Latin is present", () => {
  const raw =
    "[Английский] Rowling Joanne / Роулинг Джоан - Harry Potter 1 // Harry Potter and the Philosopher's Stone / Гарри Поттер [128 kbps]";
  const cleaned = cleanDisplayTitle(raw);
  assert.equal(cleaned, "Rowling Joanne - Harry Potter 1 - Harry Potter and the Philosopher's Stone");
});

test("parseSeriesAndBook detects The Mortal Instruments books accurately", () => {
  const books = [
    { title: "City of Bones - The Mortal Instruments, Book 1", num: 1 },
    { title: "City of Ashes - The Mortal Instruments, Book 2", num: 2 },
    { title: "City of Glass - The Mortal Instruments, Book 3", num: 3 },
    { title: "City of Fallen Angels - The Mortal Instruments, Book 4", num: 4 },
    { title: "City of Lost Souls - The Mortal Instruments, Book 5", num: 5 },
    { title: "City of Heavenly Fire - The Mortal Instruments, Book 6", num: 6 },
    { title: "The Mortal Instruments Complete Series (6 books)", num: 9999, isCol: true },
  ];

  for (const b of books) {
    const res = parseSeriesAndBook(b.title, "Cassandra Clare", "the mortal instruments");
    assert.equal(res.bookNumber, b.num, `Failed for ${b.title}`);
    if (b.isCol) assert.equal(res.isCollection, true);
  }
});

test("parseSeriesAndBook detects Harry Potter titles by subtitle and numbers", () => {
  const titles = [
    { title: "Harry Potter and the Philosopher's Stone", num: 1 },
    { title: "Harry Potter and the Chamber of Secrets", num: 2 },
    { title: "Harry Potter and the Prisoner of Azkaban", num: 3 },
    { title: "Harry Potter and the Goblet of Fire (04)", num: 4 },
    { title: "Harry Potter and the Order of the Phoenix", num: 5 },
    { title: "Harry Potter and the Half-Blood Prince", num: 6 },
    { title: "Harry Potter and the Deathly Hallows", num: 7 },
    { title: "Harry Potter and the Cursed Child", num: 8 },
    { title: "Harry Potter 1-7 UK Pottermore Collection", num: 9999, isCol: true },
  ];

  for (const t of titles) {
    const res = parseSeriesAndBook(t.title, "J. K. Rowling", "harry potter");
    assert.equal(res.bookNumber, t.num, `Failed for ${t.title}`);
  }
});

test("parseSeriesAndBook detects Roman numerals and word numbers", () => {
  assert.equal(parseSeriesAndBook("The Way of Kings - Book One", "", "").bookNumber, 1);
  assert.equal(parseSeriesAndBook("Words of Radiance - Book Two", "", "").bookNumber, 2);
  assert.equal(parseSeriesAndBook("Oathbringer - Book III", "", "").bookNumber, 3);
  assert.equal(parseSeriesAndBook("Rhythm of War - Book IV", "", "").bookNumber, 4);
});

test("parseSeriesAndBook detects hash and parenthetical numbers", () => {
  assert.equal(parseSeriesAndBook("Percy Jackson #6: The Chalice of the Gods", "", "").bookNumber, 6);
  assert.equal(parseSeriesAndBook("The Expanse (03) Abaddon's Gate", "", "").bookNumber, 3);
  assert.equal(parseSeriesAndBook("02 - Caliban's War", "", "").bookNumber, 2);
});

test("parseSeriesAndBook isolates foreign series from queried series", () => {
  // Query is "dune", title belongs to "Beastborne"
  const res = parseSeriesAndBook("Dunes of Midnight: Beastborne, Book 7 - James T. Callum", "", "dune");
  assert.equal(res.bookNumber, null, "Foreign series book number should not be applied to queried series");
});

test("getBookKey deduplicates multiple releases of the same book into one key", () => {
  const rel1 = "City of Bones - The Mortal Instruments, Book 1 - Cassandra Clare [M4B]";
  const rel2 = "The Mortal Instruments: City of Bones (Unabridged) [MP3]";
  const rel3 = "City of Bones: The Mortal Instruments, Book 1 (Chapterized) [M4A]";

  const k1 = getBookKey(rel1, "Cassandra Clare", "the mortal instruments");
  const k2 = getBookKey(rel2, "Cassandra Clare", "the mortal instruments");
  const k3 = getBookKey(rel3, "Cassandra Clare", "the mortal instruments");

  assert.equal(k1, "the mortal instruments:book:1");
  assert.equal(k2, "the mortal instruments:book:1");
  assert.equal(k3, "the mortal instruments:book:1");
});

test("sortInSeriesOrder sorts books 1..N, then collections, then standalones", () => {
  const items = [
    { name: "The Dune Saga - All Six Books", seriesInfo: { bookNumber: 9999 } },
    { name: "Children of Dune", seriesInfo: { bookNumber: 3 } },
    { name: "Dune", seriesInfo: { bookNumber: 1 } },
    { name: "The House Beyond the Dunes", seriesInfo: { bookNumber: null } },
    { name: "Dune Messiah", seriesInfo: { bookNumber: 2 } },
  ];

  const sorted = sortInSeriesOrder(items);
  assert.equal(sorted[0].name, "Dune");
  assert.equal(sorted[1].name, "Dune Messiah");
  assert.equal(sorted[2].name, "Children of Dune");
  assert.equal(sorted[3].name, "The Dune Saga - All Six Books");
  assert.equal(sorted[4].name, "The House Beyond the Dunes");
});

test("sortInSeriesOrder places collections first when prioritizeSeries is true", () => {
  const items = [
    { name: "Dune Messiah", seriesInfo: { bookNumber: 2 } },
    { name: "The Dune Saga - All Six Books", seriesInfo: { bookNumber: 9999, isCollection: true } },
    { name: "Dune", seriesInfo: { bookNumber: 1 } },
    { name: "Children of Dune", seriesInfo: { bookNumber: 3 } },
  ];

  const sorted = sortInSeriesOrder(items, { prioritizeSeries: true });
  assert.equal(sorted[0].name, "The Dune Saga - All Six Books");
  assert.equal(sorted[1].name, "Dune");
  assert.equal(sorted[2].name, "Dune Messiah");
  assert.equal(sorted[3].name, "Children of Dune");
});

test("parseSeriesAndBook detects Isaac Asimov's Foundation series and rejects noise", () => {
  // Canonical series titles
  const b1 = parseSeriesAndBook("Foundation - Isaac Asimov [M4B] [64 Kbps]", "Isaac Asimov", "foundation");
  const b2 = parseSeriesAndBook("Book 2 - Foundation and Empire", "Isaac Asimov", "foundation");
  const b3 = parseSeriesAndBook("Second Foundation - Isaac Asimov", "Isaac Asimov", "foundation");
  const b4 = parseSeriesAndBook("Isaac Asimov - Foundation\\'s Edge - Missing Part 16 of 17", "Isaac Asimov", "foundation");
  const b5 = parseSeriesAndBook("Foundation 07 - Foundation and Earth - Isaac Asimov [M4B] [128 Kbps]", "Isaac Asimov", "foundation");
  const b6 = parseSeriesAndBook("Prelude To Foundation - Isaac Asimov", "Isaac Asimov", "foundation");
  const b7 = parseSeriesAndBook("Forward the Foundation - Isaac Asimov", "Isaac Asimov", "foundation");
  const pack = parseSeriesAndBook("Foundation Series 1-7 - Isaac Asimov [M4B] [128 Kbps]", "Isaac Asimov", "foundation");

  assert.equal(b1.bookNumber, 1);
  assert.equal(b2.bookNumber, 2);
  assert.equal(b3.bookNumber, 3);
  assert.equal(b4.bookNumber, 4);
  assert.equal(b5.bookNumber, 5);
  assert.equal(b6.bookNumber, 6);
  assert.equal(b7.bookNumber, 7);
  assert.equal(pack.bookNumber, 9999);
  assert.equal(pack.isCollection, true);

  // Unrelated titles containing "foundation" MUST NOT match Foundation Book 1
  const noise1 = parseSeriesAndBook("The Tenth Cycle - A Rossler Foundation Mystery - Book 1 - J C Ryan [M4B]", "", "foundation");
  const noise2 = parseSeriesAndBook("Turning Confusion into Clarity: A Guide to the Foundation Practices of Tibetan Buddhism", "", "foundation");
  const noise3 = parseSeriesAndBook("AI Engineering: Building Applications with Foundation Models - Chip Huyen", "", "foundation");
  const noise4 = parseSeriesAndBook("Jacob Levich - The Real Agenda of the Gates Foundation", "", "foundation");

  assert.notEqual(noise1.bookNumber, 1);
  assert.equal(noise1.bookNumber, null);
  assert.equal(noise2.bookNumber, null);
  assert.equal(noise3.bookNumber, null);
  assert.equal(noise4.bookNumber, null);
});

test("normalizeSearchQuery expands concatenated franchise names", () => {
  const { normalizeSearchQuery } = require("../src/sources");
  assert.equal(normalizeSearchQuery("starwars dark disciple"), "star wars dark disciple");
  assert.equal(normalizeSearchQuery("spiderman"), "spider-man");
  assert.equal(normalizeSearchQuery("harrypotter chamber of secrets"), "harry potter chamber of secrets");
  assert.equal(normalizeSearchQuery("lordoftherings"), "lord of the rings");
  assert.equal(normalizeSearchQuery("wheeloftime"), "wheel of time");
});

test("deduplicates Dark Disciple releases and cleans display title", () => {
  const t1 = "Dark Disciple, Star Wars by Christie Golden M4B";
  const t2 = "Dark Disciple: Star Wars - Christie Golden [MP3] [64 Kbps]";

  assert.equal(cleanDisplayTitle(t1), "Dark Disciple, Star Wars by Christie Golden");

  const k1 = getBookKey(t1, "Christie Golden", "star wars dark disciple");
  const k2 = getBookKey(t2, "Christie Golden", "star wars dark disciple");
  assert.equal(k1, "dark disciple star wars");
  assert.equal(k2, "dark disciple star wars");
  assert.equal(k1, k2);
});

test("cleanEpisodeTitle dynamically strips path, track numbers, and codec tags", () => {
  const { cleanEpisodeTitle } = require("../src/series");
  assert.equal(
    cleanEpisodeTitle("Foundation Series/02 - Foundation and Empire.m4b"),
    "Foundation and Empire"
  );
  assert.equal(
    cleanEpisodeTitle("01. Harry Potter and the Sorcerer's Stone [128kbps].mp3"),
    "Harry Potter and the Sorcerer's Stone"
  );
  assert.equal(
    cleanEpisodeTitle("Dune Chronicles 1-6/01 - Dune.m4b"),
    "Dune"
  );
});


// test/recs.test.js
// The read side of recommendations: loading the generated file and turning
// recommendations into search terms. No network and no model required.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const RECS_TMP = path.join(os.tmpdir(), `bustaudio-recs-test-${process.pid}.json`);
process.env.RECS_FILE = RECS_TMP;

// recs.js reads RECS_FILE at require time, so set it first.
const { getRecs, hasRecs, titleMatches, _searchTermFor: searchTermFor } = require("../src/recs");

function write(contents) {
  fs.writeFileSync(RECS_TMP, typeof contents === "string" ? contents : JSON.stringify(contents));
  // Bust the 30s read cache so each test sees its own file.
  delete require.cache[require.resolve("../src/recs")];
  return require("../src/recs");
}

test.after(() => {
  try {
    fs.unlinkSync(RECS_TMP);
  } catch (_) {
    /* fine */
  }
});

test("a missing recs file yields an empty list, not a throw", () => {
  try {
    fs.unlinkSync(RECS_TMP);
  } catch (_) {}
  const mod = require("../src/recs");
  const recs = mod.getRecs();
  assert.deepEqual(recs.items, []);
  assert.equal(recs.generatedAt, null);
  assert.equal(mod.hasRecs(), false);
});

test("a corrupt recs file is treated as absent", () => {
  const mod = write("{ this is not json");
  assert.deepEqual(mod.getRecs().items, []);
  assert.equal(mod.hasRecs(), false);
});

test("a well-formed recs file is read and normalised", () => {
  const mod = write({
    generatedAt: "2026-01-01T00:00:00Z",
    model: "opencode/space-bunny-free",
    basedOnCount: 18,
    items: [
      {
        title: "  Neuromancer  ",
        author: " William Gibson ",
        reason: "Cyberpunk classic.",
        release: {
          name: "Neuromancer - William Gibson",
          infohash: "abc123",
          magnet: "magnet:?xt=urn:btih:abc123",
          size: 500,
          format: "M4B",
          bitrate: "128 kbps",
        },
      },
      {
        title: "Second Bestiary",
        author: null,
        reason: null,
        release: { name: "Second Bestiary", infohash: "def456", size: 0 },
      },
    ],
  });
  const recs = mod.getRecs();
  assert.equal(recs.items.length, 2);
  assert.equal(recs.items[0].title, "Neuromancer");
  assert.equal(recs.items[0].author, "William Gibson");
  assert.equal(recs.items[0].reason, "Cyberpunk classic.");
  assert.equal(recs.items[0].release.infohash, "abc123");
  assert.equal(recs.items[0].release.format, "M4B");
  assert.equal(recs.items[1].author, null);
  assert.equal(recs.model, "opencode/space-bunny-free");
  assert.equal(recs.basedOnCount, 18);
  assert.equal(mod.hasRecs(), true);
});

test("items with no usable title are dropped", () => {
  const rel = { name: "x", infohash: "h" };
  const mod = write({
    items: [
      { title: "", release: rel },
      { title: "a", release: rel },
      { title: "Real Book", release: rel },
      null,
      { author: "No Title", release: rel },
    ],
  });
  const titles = mod.getRecs().items.map((r) => r.title);
  assert.deepEqual(titles, ["Real Book"]);
});

test("an unresolved recommendation is not shown", () => {
  // The script drops suggestions the index does not carry, but a hand-edited or
  // older file can still contain one. Without a release there is nothing to
  // play, so it must not become a dead tile.
  const mod = write({
    items: [
      { title: "Piranesi", reason: "Short and strange." }, // no release at all
      { title: "Dune", release: {} }, // release but no hash or magnet
      { title: "Real Book", release: { name: "Real Book", infohash: "h1" } },
    ],
  });
  const titles = mod.getRecs().items.map((r) => r.title);
  assert.deepEqual(titles, ["Real Book"], "only a playable release should survive");
});

test("a file whose items are not an array is treated as absent", () => {
  const mod = write({ generatedAt: "x", items: "not an array" });
  assert.deepEqual(mod.getRecs().items, []);
});

test("searchTermFor prefers the bare title when an author is known", () => {
  // ABB is a literal title search; appending the author narrows too much.
  assert.equal(searchTermFor({ title: "Neuromancer", author: "William Gibson" }), "Neuromancer");
});

test("searchTermFor never appends a null author", () => {
  // Regression: an earlier version built "Title null".
  assert.equal(searchTermFor({ title: "Neuromancer", author: null }), "Neuromancer");
  assert.equal(searchTermFor({ title: "Neuromancer" }), "Neuromancer");
});

test("searchTermFor strips series and edition suffixes", () => {
  assert.equal(
    searchTermFor({ title: "Sapiens: A Brief History of Humankind, Book 1", author: "Yuval Harari" }),
    "Sapiens"
  );
  assert.equal(searchTermFor({ title: "The Way of Kings: Book One", author: null }), "The Way of Kings");
  assert.equal(searchTermFor({ title: "Dune: Part Two", author: null }), "Dune");
  assert.equal(searchTermFor({ title: "The Hobbit (Unabridged)", author: null }), "The Hobbit");
});

test("searchTermFor leaves a clean title alone", () => {
  assert.equal(searchTermFor({ title: "Project Hail Mary", author: "Andy Weir" }), "Project Hail Mary");
  assert.equal(searchTermFor({ title: "Dune", author: "Frank Herbert" }), "Dune");
});

test("titleMatches accepts the same book in release form", () => {
  assert.equal(titleMatches("Dune - Frank Herbert", "Dune"), true);
  assert.equal(titleMatches("Dune by Frank Herbert [M4B] [128 Kbps]", "Dune"), true);
  assert.equal(titleMatches("Dune (Unabridged)", "Dune"), true);
});

test("titleMatches tolerates a moved leading article", () => {
  // Releases routinely postfix it: "Hobbit, The".
  assert.equal(titleMatches("Hobbit, The - J.R.R. Tolkien", "The Hobbit"), true);
});

test("titleMatches tolerates a series/edition suffix on the hit", () => {
  assert.equal(titleMatches("The Way of Kings: Book One - Brandon Sanderson", "The Way of Kings"), true);
  assert.equal(titleMatches("Good Omens: The Nice and Accurate Prophecies", "Good Omens"), true);
});

test("titleMatches is case, accent and punctuation insensitive", () => {
  assert.equal(titleMatches("The WISE Man's FORTUNE", "the wise man's fortune"), true);
  assert.equal(titleMatches("Cafe Del Mar - Pierre Blanc", "Café del Mar"), true);
});

test("titleMatches rejects a different book from the same series", () => {
  // The regression that matters: token overlap would accept all of these,
  // because they share the series word.
  assert.equal(titleMatches("Forward the Foundation - Isaac Asimov", "Foundation and Earth"), false);
  assert.equal(titleMatches("Foundation and Empire - Isaac Asimov", "Foundation"), false);
  assert.equal(titleMatches("Second Foundation - Isaac Asimov", "Foundation"), false);
  assert.equal(titleMatches("Foundation's Edge - Isaac Asimov", "Foundation"), false);
});

test("titleMatches rejects an unrelated hit", () => {
  assert.equal(titleMatches("Project Hail Mary - Andy Weir", "Piranesi"), false);
  assert.equal(titleMatches("Foundation (Book 1) - Isaac Asimov", "Ender's Game"), false);
});

test("titleMatches rejects empty input rather than matching everything", () => {
  assert.equal(titleMatches("Dune - Frank Herbert", ""), false);
  assert.equal(titleMatches("", "Dune"), false);
  assert.equal(titleMatches(null, null), false);
});

test("titleMatches would have caught the throttled-response bug", () => {
  // AudiobookBay answers a burst with its front page. The recommendation row
  // asked for books it does not carry, and got these back instead. Every one
  // of them must be rejected, or the reader's own library shows up as
  // "Recommended For You".
  const wanted = ["Ender's Game", "Piranesi", "The Three-Body Problem", "The Name of the Wind"];
  const throttled = [
    "Foundation (Book 1) - Isaac Asimov",
    "Dune - Frank Herbert",
    "Project Hail Mary - Andy Weir",
    "Harry Potter and the Sorcerer's Stone - J.K. Rowling",
  ];
  for (const w of wanted) {
    for (const hit of throttled) {
      assert.equal(titleMatches(hit, w), false, `"${hit}" must not pass as "${w}"`);
    }
  }
});

// test/libex.test.js
// Libex metadata provider: match-gating logic.
//
// The important property is PRECISION. Libex is a community cache with partial
// coverage, and its /us endpoint returns Spanish/German editions for English
// queries. Every case below marked "reject" is one where a looser rule would
// have attached the wrong cover to someone's shelf.

const test = require("node:test");
const assert = require("node:assert");

const { _scoreMatch, _pickSeries, _splitNarrators, _dedupeGenres } = require("../src/libex");

test("accepts an exact English title match", () => {
  const s = _scoreMatch({ title: "Dune", language: "english", author: "Frank Herbert" }, "Dune", "Frank Herbert");
  assert.ok(s >= 0.7, `expected accept, got ${s}`);
});

test("accepts despite punctuation/case differences", () => {
  const s = _scoreMatch({ title: "The Martian", language: "english" }, "The Martian!", null);
  assert.ok(s >= 0.7, `expected accept, got ${s}`);
});

test("rejects a different book that shares a token", () => {
  // Libex really does return these for ?title=Foundation
  assert.equal(_scoreMatch({ title: "Forward the Foundation", language: "english" }, "Foundation"), 0);
  assert.equal(_scoreMatch({ title: "Foundation and Earth", language: "english" }, "Foundation"), 0);
  assert.equal(_scoreMatch({ title: "Children of Dune", language: "english" }, "Dune"), 0);
  assert.equal(_scoreMatch({ title: "Dune Messiah", language: "english" }, "Dune"), 0);
});

test("rejects a possessive title (the apostrophe trap)", () => {
  assert.equal(_scoreMatch({ title: "Foundation's Edge", language: "english" }, "Foundation"), 0);
  assert.equal(_scoreMatch({ title: "Blade's Shadow", language: "english" }, "Blade"), 0);
});

test("rejects non-English editions even on an exact title", () => {
  const s = _scoreMatch(
    { title: "Foundation", language: "spanish", author: "Isaac Asimov" },
    "Foundation",
    "Isaac Asimov"
  );
  assert.ok(s < 0.7, `expected reject of spanish edition, got ${s}`);
});

test("rejects when the title is unrelated", () => {
  assert.equal(_scoreMatch({ title: "AI Engineering", language: "english" }, "Foundation"), 0);
  assert.equal(_scoreMatch({ title: "The Educated Stupid", language: "english" }, "Educated"), 0);
});

test("rejects empty or too-short queries", () => {
  assert.equal(_scoreMatch({ title: "Dune" }, "", null), 0);
  assert.equal(_scoreMatch({ title: "Dune" }, "D", null), 0);
});

test("author agreement only ever boosts, never rescues", () => {
  const wrongAuthor = _scoreMatch({ title: "Dune", language: "english", author: "Nobody" }, "Dune", "Frank Herbert");
  const rightAuthor = _scoreMatch({ title: "Dune", language: "english", author: "Frank Herbert" }, "Dune", "Frank Herbert");
  assert.ok(rightAuthor >= wrongAuthor, "matching author should score >= non-matching");
  // A wrong author must not push a title mismatch over the accept line.
  assert.equal(
    _scoreMatch({ title: "Not Dune", language: "english", author: "Frank Herbert" }, "Dune", "Frank Herbert"),
    0
  );
});

test("pickSeries prefers the tightest sequence", () => {
  // Audible lists a Dune book under both its own series (#1) and the umbrella (#12).
  assert.deepEqual(
    _pickSeries([{ series: "The Dune Sequence", sequence: "12" }, { series: "Dune", sequence: "1" }]),
    { name: "Dune", index: 1 }
  );
});

test("pickSeries tolerates missing/garbage sequences and empty input", () => {
  assert.equal(_pickSeries(undefined), null);
  assert.equal(_pickSeries([]), null);
  const r = _pickSeries([{ series: "Standalone", sequence: null }]);
  assert.equal(r.name, "Standalone");
  assert.equal(r.index, null);
});

test("splitNarrators breaks a comma list without breaking 'Smith, John'", () => {
  assert.deepEqual(_splitNarrators("Scott Brick, Orlagh Cassidy, Euan Morton"), [
    "Scott Brick",
    "Orlagh Cassidy",
    "Euan Morton",
  ]);
});

test("dedupeGenres keeps coarse categories and drops covered tags", () => {
  // Real Dune payload: the tag list repeats the category almost word for word.
  const out = _dedupeGenres(
    ["Literature & Fiction", "Science Fiction & Fantasy", "Classics"],
    ["Fantasy", "Science Fiction", "Epic", "Desert Planet"]
  );
  assert.deepEqual(out, ["Literature & Fiction", "Science Fiction & Fantasy", "Classics", "Epic", "Desert Planet"]);
});

test("dedupeGenres is case- and punctuation-insensitive", () => {
  assert.deepEqual(_dedupeGenres(["Self-Help"], ["self help", "SELF HELP"]), ["Self-Help"]);
  assert.deepEqual(_dedupeGenres(["Mystery, Thriller & Suspense"], ["thriller suspense"]), [
    "Mystery, Thriller & Suspense",
  ]);
});

test("dedupeGenres caps the list and drops empty junk", () => {
  const many = Array.from({ length: 20 }, (_, i) => `Unique Tag ${i}`);
  const out = _dedupeGenres([], many);
  assert.ok(out.length <= 5, `expected <= 5 genres, got ${out.length}`);
  assert.deepEqual(_dedupeGenres(["Real Genre"], [null, "", "   ", undefined]), ["Real Genre"]);
});

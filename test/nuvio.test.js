// test/nuvio.test.js
// Deterministic parts of the Nuvio client: record normalisation, the
// change-detection hash, and profile-index validation.
// No network and no credentials required.

const test = require("node:test");
const assert = require("node:assert");

const nuvio = require("../src/nuvio");
const { _normaliseItem: normaliseItem, _hashContentIds: hashContentIds, summariseByType, parseProfileIndex } = nuvio;

test("normaliseItem keeps the fields the recommender needs", () => {
  const out = normaliseItem({
    content_id: "isbn:9780441013593",
    content_type: "audiobook",
    name: "Dune",
    release_info: "1965",
    genres: ["Science Fiction", 42, "Classics"],
  });
  assert.deepEqual(out, {
    contentId: "isbn:9780441013593",
    contentType: "audiobook",
    name: "Dune",
    year: "1965",
    genres: ["Science Fiction", "Classics"], // non-strings dropped
    watched: null,
    watchedAt: null,
  });
});

test("normaliseItem accepts a `title` alias and an `id` alias", () => {
  const out = normaliseItem({ id: "tmdb:550", content_type: "movie", title: "Fight Club" });
  assert.equal(out.contentId, "tmdb:550");
  assert.equal(out.name, "Fight Club");
});

test("normaliseItem returns null for rows with nothing to work with", () => {
  assert.equal(normaliseItem(null), null);
  assert.equal(normaliseItem("nonsense"), null);
  assert.equal(normaliseItem({}), null);
  assert.equal(normaliseItem({ genres: ["x"] }), null); // no id, no name
});

test("normaliseItem passes through watch fields when present", () => {
  const out = normaliseItem({ content_id: "x:1", name: "X", watched: true, watched_at: "2026-01-01T00:00:00Z" });
  assert.equal(out.watched, true);
  assert.equal(out.watchedAt, "2026-01-01T00:00:00Z");
});

test("summariseByType groups by content_type, largest first", () => {
  const items = [
    normaliseItem({ content_id: "a:1", content_type: "movie", name: "A" }),
    normaliseItem({ content_id: "b:1", content_type: "audiobook", name: "B" }),
    normaliseItem({ content_id: "c:1", content_type: "audiobook", name: "C" }),
    normaliseItem({ content_id: "d:1", name: "D" }), // no content_type
  ];
  const summary = summariseByType(items);
  assert.deepEqual(
    summary.map((g) => [g.contentType, g.count]),
    [
      ["audiobook", 2],
      ["movie", 1],
      ["(none)", 1],
    ]
  );
  assert.deepEqual(summary[0].sampleNames, ["B", "C"]);
});

test("hashContentIds is order-independent and duplicate-insensitive", () => {
  const a = hashContentIds(["isbn:1", "isbn:2", "isbn:3"]);
  const b = hashContentIds(["isbn:3", "isbn:1", "isbn:2"]);
  const c = hashContentIds(["isbn:3", "isbn:2", "isbn:3", "isbn:1", "isbn:2"]);
  assert.equal(a, b, "order must not matter");
  assert.equal(a, c, "duplicates must not matter");
});

test("hashContentIds changes when a book is added or removed", () => {
  const base = hashContentIds(["isbn:1", "isbn:2"]);
  assert.notEqual(base, hashContentIds(["isbn:1", "isbn:2", "isbn:3"]), "added book");
  assert.notEqual(base, hashContentIds(["isbn:1"]), "removed book");
});

test("hashContentIds ignores empty slots so a single blank id is not a change", () => {
  const base = hashContentIds(["isbn:1", "isbn:2"]);
  assert.equal(hashContentIds(["isbn:1", "isbn:2", null, "", undefined]), base);
});

test("hashContentIds of an empty library is stable and distinct", () => {
  const empty = hashContentIds([]);
  assert.equal(empty, hashContentIds([]));
  assert.notEqual(empty, hashContentIds(["isbn:1"]));
});

test("parseProfileIndex accepts 1..6 and rejects anything else", () => {
  for (const good of ["1", "3", 6, " 2 "]) assert.ok(parseProfileIndex(good), `should accept ${good}`);
  for (const bad of ["0", "7", "-1", "abc", "", null, undefined, 1.5]) {
    assert.equal(parseProfileIndex(bad), null, `should reject ${bad}`);
  }
});

test("the publishable key shipped in the source matches Nuvio's published one", () => {
  // Guard against an accidental edit to a value that must stay in sync with
  // their docs; override via NUVIO_PUBLISHABLE_KEY if they rotate it.
  assert.equal(nuvio.PUBLISHABLE_KEY, "sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN");
});

test("isConfigured() is false without credentials and never throws", () => {
  const hadEmail = process.env.NUVIO_EMAIL;
  const hadPassword = process.env.NUVIO_PASSWORD;
  delete process.env.NUVIO_EMAIL;
  delete process.env.NUVIO_PASSWORD;
  try {
    assert.equal(nuvio.isConfigured(), false);
    assert.equal(nuvio.getCredentials(), null);
  } finally {
    if (hadEmail !== undefined) process.env.NUVIO_EMAIL = hadEmail;
    if (hadPassword !== undefined) process.env.NUVIO_PASSWORD = hadPassword;
  }
});

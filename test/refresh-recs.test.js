// test/refresh-recs.test.js
// The generation side of recommendations: parsing whatever the model returned
// and rejecting titles that are not plain book names.
//
// No network, no model, no credentials — these call the exported functions only.

const test = require("node:test");
const assert = require("node:assert");

const { extractJson, normaliseRecs, isPlausibleTitle, buildPrompt, checkSourceReachable } = require("../scripts/refresh-recs");

// -- extractJson ---------------------------------------------------------------

test("extractJson pulls the array out of the CLI's JSONL stream", () => {
  const stream = [
    JSON.stringify({ type: "step_start", part: {} }),
    JSON.stringify({ type: "text", part: { text: '[{"title":"Dune"' } }),
    JSON.stringify({ type: "text", part: { text: ',"author":"Frank Herbert"}]' } }),
  ].join("\n");
  assert.deepEqual(extractJson(stream), [{ title: "Dune", author: "Frank Herbert" }]);
});

test("extractJson survives code fences and surrounding prose", () => {
  const reply = 'Here you go:\n```json\n[{"title":"Piranesi","author":"Susanna Clarke"}]\n```\nHope that helps!';
  assert.deepEqual(extractJson(reply), [{ title: "Piranesi", author: "Susanna Clarke" }]);
});

test("extractJson is not fooled by a brace inside a string", () => {
  const reply = '[{"title":"Sapiens","reason":"A {history} of everything"}]';
  assert.equal(extractJson(reply).length, 1);
});

test("extractJson returns null when there is no JSON at all", () => {
  assert.equal(extractJson("I cannot help with that."), null);
  assert.equal(extractJson(""), null);
});

test("extractJson salvages a response the model truncated mid-array", () => {
  // This is a real output: fifteen titles requested, the model ran out of tokens
  // and stopped mid-string. Strict parsing throws away the complete entries too.
  const truncated =
    '[{"title":"Leviathan Wakes","author":"James S.A. Corey","reason":"Grounded space opera."},' +
    '{"title":"The Martian","author":"Andy Weir","reason":"Same lone-';

  const out = extractJson(truncated);
  assert.ok(Array.isArray(out), "should salvage an array");
  assert.equal(out.length, 1, "only the complete entry survives");
  assert.equal(out[0].title, "Leviathan Wakes");
});

test("extractJson salvages several complete entries around a broken one", () => {
  const truncated =
    '[{"title":"Dune","author":"Frank Herbert"},' +
    '{"title":"Broken","reason":"unterminated ,' +
    '{"title":"Piranesi","author":"Susanna Clarke"}]';
  const out = extractJson(truncated);
  assert.ok(Array.isArray(out));
  const titles = out.map((r) => r.title);
  assert.ok(titles.includes("Dune"), "first entry kept");
  assert.ok(titles.includes("Piranesi"), "last entry kept");
  assert.ok(!titles.includes("Broken"), "the malformed entry is not invented");
});

test("extractJson prefers a well-formed array over salvaging", () => {
  const good = '[{"title":"Dune","author":"Frank Herbert"}]';
  const out = extractJson(good);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "Dune");
});

// -- isPlausibleTitle ----------------------------------------------------------

test("isPlausibleTitle accepts real titles", () => {
  for (const t of [
    "Dune",
    "The Name of the Wind",
    "Project Hail Mary",
    "A Game of Thrones",
    "The Wise Man's Fear",
    "Children of Time",
    "The Three-Body Problem",
  ]) {
    assert.equal(isPlausibleTitle(t), true, `${t} should be accepted`);
  }
});

test("isPlausibleTitle rejects the padding the small free models add", () => {
  // Every one of these is a real string the model actually produced.
  for (const t of [
    "Project Hail Mary's companion: The Martian",
    "The Hobbit illustrated edition narrated by Andy Serkis",
    "Children of the Vechta / The Rules of Magic — Six of Crows",
    "Sapiens: A Brief History of Humankind",
    "Dune: Book One",
    "The Silmarillion (unabridged)",
    "Neuromancer: 1984 Edition",
    "Foundation: The Complete Series",
    "Dune -- Frank Herbert",
  ]) {
    assert.equal(isPlausibleTitle(t), false, `${t} should be rejected`);
  }
});

test("isPlausibleTitle rejects junk", () => {
  assert.equal(isPlausibleTitle(""), false);
  assert.equal(isPlausibleTitle("a"), false);
  assert.equal(isPlausibleTitle(null), false);
  assert.equal(isPlausibleTitle("2019"), false);
  assert.equal(isPlausibleTitle("!!! ???"), false);
  assert.equal(isPlausibleTitle("x".repeat(200)), false);
});

// -- normaliseRecs -------------------------------------------------------------

test("normaliseRecs keeps clean entries and drops malformed ones", () => {
  const rows = [
    { title: "Piranesi", author: "Susanna Clarke", reason: "Short and strange." },
    { title: "The Hobbit illustrated edition narrated by Andy Serkis" },
    { title: "Red Rising", author: "Pierce Brown" },
  ];
  const out = normaliseRecs(rows, ["Dune"]);
  assert.deepEqual(out.map((r) => r.title), ["Piranesi", "Red Rising"]);
});

test("normaliseRecs never suggests a book already in the library", () => {
  const out = normaliseRecs(
    [{ title: "Dune", author: "Frank Herbert" }, { title: "Foundation" }, { title: "Neuromancer" }],
    ["Dune", "Foundation"]
  );
  assert.deepEqual(out.map((r) => r.title), ["Neuromancer"]);
});

test("normaliseRecs de-duplicates repeated titles", () => {
  const out = normaliseRecs(
    [{ title: "Piranesi" }, { title: "piranesi" }, { title: "Piranesi" }],
    []
  );
  assert.equal(out.length, 1);
});

test("normaliseRecs unwraps an object-wrapped array", () => {
  const out = normaliseRecs({ recommendations: [{ title: "Piranesi" }] }, []);
  assert.deepEqual(out.map((r) => r.title), ["Piranesi"]);
});

test("normaliseRecs tolerates bare strings and alternative field names", () => {
  const out = normaliseRecs(
    [{ name: "Piranesi", by: "Susanna Clarke", why: "Odd." }, "Red Rising"],
    []
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].author, "Susanna Clarke");
  assert.equal(out[0].reason, "Odd.");
});

test("normaliseRecs truncates an over-long reason", () => {
  const out = normaliseRecs([{ title: "Piranesi", reason: "x".repeat(500) }], []);
  assert.equal(out[0].reason.length, 200);
});

test("normaliseRecs returns an empty list rather than throwing", () => {
  assert.deepEqual(normaliseRecs(null, []), []);
  assert.deepEqual(normaliseRecs([], []), []);
  assert.deepEqual(normaliseRecs("nonsense", []), []);
  assert.deepEqual(normaliseRecs([null, undefined, 0, false], []), []);
});

// -- buildPrompt ---------------------------------------------------------------

test("buildPrompt lists the library and forbids owning books", () => {
  const prompt = buildPrompt([
    { title: "Foundation", author: "Isaac Asimov" },
    { title: "Dune", author: "Frank Herbert" },
  ]);
  assert.match(prompt, /Foundation . Isaac Asimov/);
  assert.match(prompt, /Dune . Frank Herbert/);
  assert.match(prompt, /Do not recommend anything already in the list/);
  // The observed failure modes have to be called out explicitly.
  assert.match(prompt, /companion to/);
  assert.match(prompt, /narrated by/);
  assert.match(prompt, /Never join two books/);
});

test("buildPrompt places consumed audiobooks in heavily weighted primary tier and library in secondary", () => {
  const prompt = buildPrompt({
    consumed: [
      { title: "Foundation", author: "Isaac Asimov", progressPercent: 28 },
    ],
    queued: [
      { title: "Dune", author: "Frank Herbert" },
    ],
  });
  assert.match(prompt, /ACTIVELY CONSUMED \/ LISTENED AUDIOBOOKS \(HEAVIEST WEIGHT/);
  assert.match(prompt, /SAVED IN LIBRARY \(SECONDARY TASTE CONTEXT\)/);
  assert.match(prompt, /Foundation — Isaac Asimov \(Listened: 28% completed\)/);
  assert.match(prompt, /Dune — Frank Herbert/);
  assert.match(prompt, /Do not recommend anything already in the list/);
});


// -- checkSourceReachable -----------------------------------------------------

test("checkSourceReachable reports an unreachable domain instead of throwing", async () => {
  // A reserved TLD that cannot resolve, so this is fast and offline-safe.
  const r = await checkSourceReachable("audiobookbay.invalid");
  assert.equal(r.ok, false);
  assert.match(r.detail, /unreachable/);
  assert.match(r.detail, /audiobookbay\.invalid/, "the message must name the domain");
});

test("checkSourceReachable reports a bad HTTP status", async () => {
  // example.com answers 200; a path that does not exist is not what we probe, so
  // instead assert the shape using a domain that resolves but refuses HTTP.
  const r = await checkSourceReachable("localhost:1");
  assert.equal(r.ok, false);
  assert.match(r.detail, /localhost:1/);
});

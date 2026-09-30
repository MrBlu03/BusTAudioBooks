// test/runtime.test.js
// formatRuntime() drives the "X hr Y min" chip in the meta description.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// formatRuntime is module-private in index.js, so lift it out of the source
// rather than starting the whole express app just to test one helper.
const src = fs.readFileSync(path.join(__dirname, "..", "src", "index.js"), "utf8");
const body = src.match(/function formatRuntime\(minutes\) \{[\s\S]*?\n\}/);
assert.ok(body, "could not find formatRuntime in src/index.js");
const formatRuntime = new Function(`${body[0]}; return formatRuntime;`)();

test("converts minutes to hours and minutes", () => {
  assert.equal(formatRuntime(1262), "21 hr 2 min"); // Dune
  assert.equal(formatRuntime(659), "10 hr 59 min"); // The Martian
});

test("drops the minutes component when it is zero", () => {
  assert.equal(formatRuntime(120), "2 hr");
  assert.equal(formatRuntime(45), "45 min");
});

test("returns null for missing or nonsense input", () => {
  for (const bad of [null, undefined, "", 0, -5, "abc", NaN]) {
    assert.equal(formatRuntime(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

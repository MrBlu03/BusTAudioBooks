// test/target_match.test.js
const test = require("node:test");
const assert = require("node:assert");
const { matchTargetFile } = require("../src/series_meta");

test("matchTargetFile accurately matches Foundation series books in Release and Chronological orders", () => {
  const foundationFiles = [
    { name: "Foundation Series/01 - Prelude to Foundation.m4b" },
    { name: "Foundation Series/02 - Forward the Foundation.m4b" },
    { name: "Foundation Series/03 - Foundation.m4b" },
    { name: "Foundation Series/04 - Foundation and Empire.m4b" },
    { name: "Foundation Series/05 - Second Foundation.m4b" },
    { name: "Foundation Series/06 - Foundations Edge.m4b" },
    { name: "Foundation Series/07 - Foundation and Earth.m4b" },
  ];

  // Season 1: Release Order
  const s1Books = [
    { seq: 3, title: "Foundation" },
    { seq: 4, title: "Foundation and Empire" },
    { seq: 5, title: "Second Foundation" },
    { seq: 6, title: "Foundation's Edge" },
    { seq: 7, title: "Foundation and Earth" },
    { seq: 1, title: "Prelude to Foundation" },
    { seq: 2, title: "Forward the Foundation" },
  ];

  assert.equal(matchTargetFile(s1Books[0], 1, foundationFiles, null, s1Books), "Foundation Series/03 - Foundation.m4b");
  assert.equal(matchTargetFile(s1Books[1], 2, foundationFiles, null, s1Books), "Foundation Series/04 - Foundation and Empire.m4b");
  assert.equal(matchTargetFile(s1Books[2], 3, foundationFiles, null, s1Books), "Foundation Series/05 - Second Foundation.m4b");
  assert.equal(matchTargetFile(s1Books[3], 4, foundationFiles, null, s1Books), "Foundation Series/06 - Foundations Edge.m4b");
  assert.equal(matchTargetFile(s1Books[4], 5, foundationFiles, null, s1Books), "Foundation Series/07 - Foundation and Earth.m4b");
  assert.equal(matchTargetFile(s1Books[5], 6, foundationFiles, null, s1Books), "Foundation Series/01 - Prelude to Foundation.m4b");
  assert.equal(matchTargetFile(s1Books[6], 7, foundationFiles, null, s1Books), "Foundation Series/02 - Forward the Foundation.m4b");
});

test("matchTargetFile accurately matches Dune canonical series books", () => {
  const duneFiles = [
    { name: "01 - Dune (1965).mp3" },
    { name: "02 - Dune Messiah (1969).mp3" },
    { name: "03 - Children of Dune (1976).mp3" },
    { name: "04 - God Emperor of Dune (1981).mp3" },
    { name: "05 - Heretics of Dune (1984).mp3" },
    { name: "06 - Chapterhouse Dune (1985).mp3" },
  ];

  const duneBooks = [
    { seq: 1, title: "Dune" },
    { seq: 2, title: "Dune Messiah" },
    { seq: 3, title: "Children of Dune" },
    { seq: 4, title: "God Emperor of Dune" },
    { seq: 5, title: "Heretics of Dune" },
    { seq: 6, title: "Chapterhouse Dune" },
  ];

  assert.equal(matchTargetFile(duneBooks[0], 1, duneFiles, null, duneBooks), "01 - Dune (1965).mp3");
  assert.equal(matchTargetFile(duneBooks[1], 2, duneFiles, null, duneBooks), "02 - Dune Messiah (1969).mp3");
  assert.equal(matchTargetFile(duneBooks[2], 3, duneFiles, null, duneBooks), "03 - Children of Dune (1976).mp3");
  assert.equal(matchTargetFile(duneBooks[3], 4, duneFiles, null, duneBooks), "04 - God Emperor of Dune (1981).mp3");
  assert.equal(matchTargetFile(duneBooks[4], 5, duneFiles, null, duneBooks), "05 - Heretics of Dune (1984).mp3");
  assert.equal(matchTargetFile(duneBooks[5], 6, duneFiles, null, duneBooks), "06 - Chapterhouse Dune (1985).mp3");
});

test("targetFile filtering selects only the targeted book file from a multi-file pack", () => {
  const matchedFiles = [
    { id: 1, name: "Foundation Series/01 - Prelude to Foundation.m4b", size: 500000000 },
    { id: 2, name: "Foundation Series/02 - Forward the Foundation.m4b", size: 520000000 },
    { id: 3, name: "Foundation Series/03 - Foundation.m4b", size: 480000000 },
    { id: 4, name: "Foundation Series/04 - Foundation and Empire.m4b", size: 510000000 },
  ];

  function filterByTarget(files, targetFile) {
    if (!targetFile) return files;
    const tfLower = String(targetFile).toLowerCase().replace(/\\/g, "/");
    const tfBase = tfLower.split("/").pop();
    const targeted = files.filter((f) => {
      const fn = String(f.name || f.short_name || "").toLowerCase().replace(/\\/g, "/");
      const bn = fn.split("/").pop();
      return fn === tfLower || bn === tfBase || fn.includes(tfBase) || tfLower.includes(bn);
    });
    return targeted.length > 0 ? targeted : files;
  }

  const res1 = filterByTarget(matchedFiles, "Foundation Series/03 - Foundation.m4b");
  assert.equal(res1.length, 1);
  assert.equal(res1[0].id, 3);

  const res2 = filterByTarget(matchedFiles, "01 - Prelude to Foundation.m4b");
  assert.equal(res2.length, 1);
  assert.equal(res2[0].id, 1);
});

test("handleStream filters multiple streams down to the exact single target book stream", () => {
  const streams = [
    { title: "01 - Prelude to Foundation.m4b\n500 MB", url: "https://torbox.app/dl/1", behaviorHints: { filename: "01 - Prelude to Foundation.m4b" } },
    { title: "02 - Forward the Foundation.m4b\n520 MB", url: "https://torbox.app/dl/2", behaviorHints: { filename: "02 - Forward the Foundation.m4b" } },
    { title: "03 - Foundation.m4b\n480 MB", url: "https://torbox.app/dl/3", behaviorHints: { filename: "03 - Foundation.m4b" } },
  ];

  function filterStreams(streams, targetFile) {
    if (streams.length <= 1) return streams;
    let filtered = streams;
    if (targetFile) {
      const tfLower = String(targetFile).toLowerCase().replace(/\\/g, "/");
      const tfBase = tfLower.split("/").pop();
      const getFn = (s) =>
        ((s.behaviorHints && s.behaviorHints.filename) || s.title || "")
          .split("\n")[0]
          .trim()
          .toLowerCase()
          .replace(/\\/g, "/");
      const exact = filtered.filter((s) => {
        const fn = getFn(s);
        const bn = fn.split("/").pop();
        return fn === tfLower || bn === tfBase;
      });
      if (exact.length > 0) return exact;
      const partial = filtered.filter((s) => {
        const fn = getFn(s);
        const bn = fn.split("/").pop();
        return fn.includes(tfBase) || tfLower.includes(bn);
      });
      if (partial.length > 0) return partial;
    }
    return filtered;
  }

  const s1 = filterStreams(streams, "Foundation Series/03 - Foundation.m4b");
  assert.equal(s1.length, 1);
  assert.equal(s1[0].behaviorHints.filename, "03 - Foundation.m4b");

  const s2 = filterStreams(streams, "01 - Prelude to Foundation.m4b");
  assert.equal(s2.length, 1);
  assert.equal(s2[0].behaviorHints.filename, "01 - Prelude to Foundation.m4b");
});

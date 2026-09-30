// test/recs_series.test.js
// Tests that recommended books belonging to a series default to showing the series
// container with reading order episodes, while standalone books remain single items,
// and multiple recommendations from the same series are deduplicated.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const RECS = path.join(ROOT, ".recs.json");
const PORT = process.env.SERVE_TEST_PORT || "7098";
const BASE = `http://127.0.0.1:${PORT}`;

const FAKE_RECS = {
  generatedAt: new Date().toISOString(),
  profileIndex: 3,
  model: "test/series-recs-model",
  basedOnCount: 15,
  count: 3,
  suggested: 3,
  items: [
    {
      title: "Leviathan Wakes",
      author: "James S. A. Corey",
      reason: "Hard science fiction noir exploring human factionalism across the solar system.",
      series: "The Expanse",
      seriesIndex: 1,
      release: {
        name: "Leviathan Wakes [Unabridged] - James S.A. Corey (Audiobook)",
        infohash: "3296194d3f965e50fb1ff89fe58e9ad8f790b5f1",
        magnet: "magnet:?xt=urn:btih:3296194d3f965e50fb1ff89fe58e9ad8f790b5f1",
        size: 551614164,
        format: "M4B",
        bitrate: "64 kbps",
      },
    },
    {
      // Second book in same series -> must be deduplicated so only 1 series card appears
      title: "Caliban's War",
      author: "James S. A. Corey",
      reason: "The direct sequel continuing the political escalation and protomolecule crisis.",
      series: "The Expanse",
      seriesIndex: 2,
      release: {
        name: "Caliban's War - James S.A. Corey",
        infohash: "b".repeat(40),
        magnet: "magnet:?xt=urn:btih:" + "b".repeat(40),
        size: 600000000,
        format: "M4B",
        bitrate: "64 kbps",
      },
    },
    {
      // Standalone book -> must remain a single standalone book
      title: "Piranesi",
      author: "Susanna Clarke",
      reason: "Labyrinthine mystery that stands alone as a singular philosophical work.",
      series: null,
      seriesIndex: null,
      release: {
        name: "Piranesi - Susanna Clarke",
        infohash: "c".repeat(40),
        magnet: "magnet:?xt=urn:btih:" + "c".repeat(40),
        size: 314572800,
        format: "M4B",
        bitrate: "128 kbps",
      },
    },
  ],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}/manifest.json`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch (_) {
      await sleep(300);
    }
  }
  return false;
}

test("recommended books: series books default to series cards with episodes, standalone books stay single", async () => {
  const had = fs.existsSync(RECS);
  const backup = had ? fs.readFileSync(RECS, "utf8") : null;
  let server = null;

  try {
    fs.writeFileSync(RECS, JSON.stringify(FAKE_RECS, null, 2));

    server = spawn(process.execPath, [path.join(ROOT, "src", "index.js")], {
      cwd: ROOT,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        PORT,
        TORBOX_API_KEY: "test-recs-api-key",
      },
    });

    const up = await waitForServer();
    assert.ok(up, "Expected server to start on port " + PORT);

    // 1. Fetch recommendations catalog
    const catRes = await fetch(`${BASE}/catalog/audiobook/torbox-audiobooks/genre=Recommended%20For%20You.json`);
    assert.ok(catRes.ok, "Expected 200 from recommendations catalog");
    const catData = await catRes.json();
    assert.ok(Array.isArray(catData.metas), "Expected metas array");

    // 2. Out of 3 items (2 in The Expanse, 1 Piranesi), we expect exactly 2 cards:
    //    1 deduplicated series card for The Expanse + 1 standalone card for Piranesi
    assert.equal(catData.metas.length, 2, `Expected 2 deduplicated cards, got ${catData.metas.length}`);

    // Card 1: The Expanse Series
    const seriesCard = catData.metas.find((m) => m.type === "series" || m.name.includes("Expanse"));
    assert.ok(seriesCard, "Expected series card for The Expanse in recommendations");
    assert.equal(seriesCard.type, "series", "Series card must have type: 'series'");
    assert.ok(seriesCard.name.includes("Expanse"), `Expected series name to include Expanse, got: ${seriesCard.name}`);
    assert.equal(seriesCard.posterShape, "square", "Series card must use square poster shape");
    assert.ok(seriesCard.description.includes("Full Series") || seriesCard.description.includes("Books in Reading Order"), "Expected series reading order in description");

    // Card 2: Piranesi (standalone)
    const singleCard = catData.metas.find((m) => m.name.includes("Piranesi"));
    assert.ok(singleCard, "Expected single card for Piranesi in recommendations");
    assert.notEqual(singleCard.type, "series", "Standalone book must NOT have type: 'series'");

    // 3. Opening the Series Card resolves the series meta with all episodes
    const metaRes = await fetch(`${BASE}/meta/series/${encodeURIComponent(seriesCard.id)}.json`);
    assert.ok(metaRes.ok, "Expected 200 from series meta endpoint");
    const metaData = await metaRes.json();
    assert.ok(metaData.meta, "Expected meta object");
    assert.equal(metaData.meta.type, "series");
    assert.ok(Array.isArray(metaData.meta.videos), "Expected videos array in series meta");
    assert.ok(metaData.meta.videos.length >= 6, `Expected at least 6 books/episodes in The Expanse, got ${metaData.meta.videos.length}`);

    // Verify Season 1 has episodes in order starting with Book 1
    const s1 = metaData.meta.videos.filter((v) => v.season === 1);
    assert.ok(s1.length >= 6, "Expected at least 6 episodes in Season 1");
    assert.ok(
      s1[0].title.toLowerCase().includes("leviathan") || s1[0].title.toLowerCase().includes("book 1"),
      `Expected Book 1 to be Leviathan Wakes, got: ${s1[0].title}`
    );

    // Each episode should have its own cover art
    assert.ok(s1[0].thumbnail, "Episode 1 must have thumbnail cover art");
    assert.ok(s1[1].thumbnail, "Episode 2 must have thumbnail cover art");

    // The recommendation reason should lead the series description
    assert.ok(
      metaData.meta.description.includes("Hard science fiction noir"),
      "Recommendation reason must be included in series description"
    );
  } finally {
    if (server) server.kill();
    if (had) fs.writeFileSync(RECS, backup);
    else if (fs.existsSync(RECS)) fs.unlinkSync(RECS);
  }
});

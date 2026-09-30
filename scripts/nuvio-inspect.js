// scripts/nuvio-inspect.js
// Dump the shape of a Nuvio profile's library, so we know what is actually
// stored before building anything on top of it.
//
//   node scripts/nuvio-inspect.js
//
// Prints a per-content_type summary plus one full sample record per type.
const fs = require("fs");
const path = require("path");
const nuvio = require("../src/nuvio");

(function loadDotEnv() {
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
})();

const profileIndex = nuvio.parseProfileIndex(process.env.NUVIO_PROFILE_ID);

(async () => {
  if (!nuvio.isConfigured()) {
    console.error("NUVIO_EMAIL / NUVIO_PASSWORD are not set. Add them to .env.");
    process.exit(1);
  }
  if (!profileIndex) {
    console.error(`NUVIO_PROFILE_ID is not a valid 1..6 index (got ${JSON.stringify(process.env.NUVIO_PROFILE_ID)}).`);
    process.exit(1);
  }

  const profiles = await nuvio.listProfiles();
  const me = profiles.find((p) => p.profile_index === profileIndex);
  console.log(`Profile [${profileIndex}] ${me ? me.name : "(unknown)"}\n`);

  const cursor = await nuvio.libraryDeltaCursor(profileIndex);
  console.log(`Library delta cursor: ${cursor}`);

  const { events, lastEventId } = await nuvio.pullLibraryDelta(profileIndex, 0);
  console.log(`Full library via delta replay: ${events.length} events (cursor now ${lastEventId})\n`);

  // The delta stream is upserts plus deletes; apply it to get final state.
  const state = new Map();
  for (const ev of events) {
    const key = ev.content_id || ev.id;
    if (!key) continue;
    if (ev.operation === "delete") state.delete(key);
    else state.set(key, ev);
  }
  console.log(`Live library items: ${state.size}\n`);

  const items = [...state.values()].map(nuvio.normaliseItem).filter(Boolean);
  const summary = nuvio.summariseByType(items);
  console.log("By content_type:");
  for (const g of summary) {
    console.log(`  ${String(g.count).padStart(4)}  ${g.contentType}`);
    for (const n of g.sampleNames) console.log(`          - ${n}`);
  }

  console.log("\nOne full record per content_type:");
  const seenTypes = new Set();
  for (const it of items) {
    const t = it.contentType || "(none)";
    if (seenTypes.has(t)) continue;
    seenTypes.add(t);
    console.log(`\n  [${t}]`);
    console.log("   ", JSON.stringify(it, null, 2).split("\n").join("\n    "));
  }
})().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});

// scripts/nuvio-list.js
// List every book in a Nuvio profile's library, newest last.
//
//   node scripts/nuvio-list.js
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

function decodeAddonId(contentId) {
  // "tbab:<base64url json>" — the payload our own src/itemid.js produces.
  if (!contentId || !contentId.startsWith("tbab:")) return null;
  try {
    const json = Buffer.from(contentId.slice(5), "base64url").toString("utf8");
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

(async () => {
  const { events } = await nuvio.pullLibraryDelta(profileIndex, 0);
  const state = new Map();
  for (const ev of events) {
    const key = ev.content_id || ev.id;
    if (!key) continue;
    if (ev.operation === "delete") state.delete(key);
    else state.set(key, ev);
  }

  const rows = [...state.values()].map(nuvio.normaliseItem).filter(Boolean);
  rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  console.log(`${rows.length} items in profile [${profileIndex}]\n`);
  const authors = new Map();
  for (const it of rows) {
    const decoded = decodeAddonId(it.contentId);
    const fmt = decoded ? `${decoded.f || "?"} ${decoded.b || ""}`.trim() : "-";
    const series = decoded && decoded.tf ? decoded.tf : "";
    console.log(`  ${String(it.name).padEnd(58)} ${fmt.padEnd(16)} ${series}`);

    // "Title - Author" is the release convention here.
    const m = String(it.name).match(/^(.*?)\s+-\s+(.+)$/);
    if (m) authors.set(m[2].trim(), (authors.get(m[2].trim()) || 0) + 1);
  }

  console.log(`\nAuthors (${authors.size}):`);
  for (const [a, n] of [...authors.entries()].sort((x, y) => y[1] - x[1])) {
    console.log(`  ${String(n).padStart(2)}  ${a}`);
  }
})().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});

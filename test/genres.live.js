// test/genres.live.js
// Verifies that every genre seed actually returns results from AudiobookBay.
//
// NOT part of `npm test` — it needs the network and it is slow and impolite.
// AudiobookBay rate-limits aggressively: a burst of requests gets the caller
// blocked for several minutes, so this walks the seeds one at a time with a
// delay and stops early if it notices throttling.
//
//   node test/genres.live.js            # check everything
//   node test/genres.live.js --delay=12000
const fs = require("fs");
const path = require("path");
const { GENRES, SEARCH } = require("../src/genres");
const { _searchAbb: searchAbb } = require("../src/sources");

function envFile(p) {
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const argDelay = process.argv.find((a) => a.startsWith("--delay="));
const DELAY = argDelay ? parseInt(argDelay.split("=")[1], 10) : 8000;
const MIN_RESULTS = 1; // below this, flag the seed as needing a better term

const env = envFile(path.join(__dirname, "..", ".env"));
const cfg = { abbDomain: env.ABB_DOMAIN || "" };
if (!cfg.abbDomain) {
  console.error("no ABB_DOMAIN in .env");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const seeds = GENRES.filter((g) => g.kind === SEARCH);
  console.log(`Checking ${seeds.length} genre seeds against ${cfg.abbDomain}`);
  console.log(`Delay between requests: ${DELAY}ms — do not lower this much.\n`);

  const empty = [];
  let blocked = false;

  for (const g of seeds) {
    if (blocked) break;
    process.stdout.write(`  ${g.name.padEnd(34)} `);
    let n = 0;
    try {
      const r = await searchAbb(cfg, g.query, 1);
      n = r.length;
    } catch (e) {
      console.log(`ERROR ${e.message}`);
      blocked = true;
      break;
    }
    if (n === 0) {
      console.log(`0 results  <-- seed "${g.query}" needs a better term`);
      empty.push(g);
    } else {
      console.log(`${n} results`);
    }
    await sleep(DELAY);
  }

  console.log("");
  if (blocked) {
    console.log("Stopped early: AudiobookBay looks rate-limited. Wait several minutes and re-run.");
  }
  if (empty.length) {
    console.log(`${empty.length} seed(s) returned nothing and should be reworked:`);
    for (const g of empty) console.log(`  ${g.name}  ->  "${g.query}"`);
  } else {
    console.log("All seeds returned results.");
  }
})();

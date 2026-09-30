// End-to-end check of the recommendations serving path.
//
// The catalogue branch reads .recs.json and does no network work, so a
// synthetic file with a resolved release exercises the whole route: manifest
// gating, the RECS branch, the id encode, and the meta handler that renders the
// model's "why this book". Starts and stops its own server.
//
//   node test/recs.serve.js
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const RECS = path.join(ROOT, ".recs.json");
// A high port so it cannot collide with a dev server on 7000.
const PORT = process.env.SERVE_TEST_PORT || "7099";
const BASE = `http://127.0.0.1:${PORT}`;

const FAKE = {
  generatedAt: new Date().toISOString(),
  profileIndex: 3,
  model: "test/fake",
  basedOnCount: 18,
  count: 3,
  suggested: 3,
  items: [
    {
      title: "Piranesi",
      author: "Susanna Clarke",
      reason: "Short, strange, and exactly the kind of thing your Asimov shelf leads to.",
      release: {
        name: "Piranesi - Susanna Clarke",
        infohash: "a".repeat(40),
        magnet: "magnet:?xt=urn:btih:" + "a".repeat(40) + "&dn=Piranesi",
        size: 314572800,
        format: "M4B",
        bitrate: "128 kbps",
      },
    },
    {
      // No release: must be dropped, never rendered as a dead tile.
      title: "Unresolvable Book",
      author: "Nobody",
      reason: "Should not appear.",
    },
    {
      // Release with neither hash nor magnet: unplayable, must be dropped.
      title: "Unplayable Book",
      release: { name: "Unplayable Book" },
    },
  ],
};

const get = (p) => JSON.parse(execFileSync("curl.exe", ["-s", "--max-time", "60", BASE + p], { encoding: "utf8" }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      get("/manifest.json");
      return true;
    } catch (_) {
      await sleep(400);
    }
  }
  return false;
}

const had = fs.existsSync(RECS);
const backup = had ? fs.readFileSync(RECS, "utf8") : null;
let failed = 0;
let server = null;

const check = (label, cond, detail) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failed++;
};

(async () => {
  try {
    // Write the file BEFORE the server starts. src/recs.js caches the parsed
    // list for 30s, and waitForServer() itself requests /manifest.json — so
    // writing afterwards would be read from a cache primed with the real
    // (empty) file.
    fs.writeFileSync(RECS, JSON.stringify(FAKE, null, 2));
    console.log("wrote synthetic .recs.json (3 entries, only 1 playable)\n");

    server = spawn(process.execPath, [path.join(ROOT, "src", "index.js")], {
      cwd: ROOT,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, PORT, TORBOX_API_KEY: process.env.TORBOX_API_KEY || "serve-test-fake-key" },
    });

    if (!(await waitForServer())) {
      console.error(`  FAIL server did not come up on ${BASE}`);
      process.exit(1);
    }

    const man = get("/manifest.json");
    const opts = man.catalogs[0].extra[0].options;
    check("manifest advertises the row", opts.includes("Recommended For You"), `v${man.version}`);
    check(
      "manifest kept every other genre",
      opts.length === 45,
      `${opts.length} genres`
    );

    const cat = get("/catalog/audiobook/torbox-audiobooks/genre=Recommended%20For%20You.json");
    check(
      "catalogue serves only the playable entry",
      cat.metas && cat.metas.length === 1,
      `${(cat.metas || []).length} metas`
    );

    const meta = (cat.metas || [])[0];
    if (meta) {
      check(
        "unresolved and unplayable entries were dropped",
        !/Unresolvable|Unplayable/.test(meta.name || ""),
        meta.name
      );
      check("id is ours", String(meta.id).startsWith("tbab:"), String(meta.id).slice(0, 12) + "...");
    }

    if (meta && meta.id) {
      const full = get(`/meta/audiobook/${meta.id}.json`).meta;
      check("meta resolves", !!full, full && full.name);
      if (full) {
        check(
          "the model's reason leads the description",
          /^Short, strange/.test(full.description || ""),
          (full.description || "").split("\n")[0].slice(0, 60)
        );
        check("author present", (full.cast || []).some((c) => /Clarke/.test(c)), JSON.stringify(full.cast));
      }
    }
  } catch (err) {
    console.error("  FAIL threw:", err.message);
    failed++;
  } finally {
    if (server) server.kill();
    if (had) fs.writeFileSync(RECS, backup);
    else if (fs.existsSync(RECS)) fs.unlinkSync(RECS);
    console.log(`\n${failed ? failed + " CHECK(S) FAILED" : "all checks passed"}; .recs.json restored`);
  }
  process.exit(failed ? 1 : 0);
})();

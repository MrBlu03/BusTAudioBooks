// scripts/nuvio-profiles.js
// List the Nuvio account's profiles, so the audiobook profile can be
// identified and NUVIO_PROFILE_ID set.
//
//   node scripts/nuvio-profiles.js
//
// Reads NUVIO_EMAIL / NUVIO_PASSWORD from the environment (put them in .env,
// which is gitignored — do not pass them as CLI arguments, they land in shell
// history).
const fs = require("fs");
const path = require("path");
const nuvio = require("../src/nuvio");

// Minimal .env loader so this script works without extra dependencies.
(function loadDotEnv() {
  const file = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
})();

(async () => {
  if (!nuvio.isConfigured()) {
    console.error("NUVIO_EMAIL / NUVIO_PASSWORD are not set. Add them to .env.");
    process.exit(1);
  }

  console.log("Signing in...");
  const token = await nuvio.getAccessToken();
  console.log("Signed in. Token valid for ~" + Math.round((nuvio._tokenExpiry({ expires_at: Math.floor(Date.now() / 1000) + 3600 }) - Date.now()) / 60000) + " min.\n");

  const profiles = await nuvio.listProfiles();
  if (!profiles.length) {
    console.log("No profiles returned.");
    process.exit(0);
  }

  console.log(`${profiles.length} profile(s):\n`);
  for (const p of profiles) {
    const idx = p.profile_index;
    const cur = process.env.NUVIO_PROFILE_ID && String(idx) === String(process.env.NUVIO_PROFILE_ID).trim();
    console.log(`  [${idx}] ${p.name}${cur ? "   <-- currently configured" : ""}`);
  }
  console.log("\nSet the audiobook one in .env as NUVIO_PROFILE_ID=<index>.");
})().catch((err) => {
  console.error("Failed:", err.message);
  if (/invalid|credential|password|401|403/i.test(err.message)) {
    console.error("That usually means the email or password is wrong.");
  }
  process.exit(1);
});

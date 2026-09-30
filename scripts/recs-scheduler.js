// scripts/recs-scheduler.js
// Background scheduler that keeps personal audiobook recommendations refreshed daily.
// Checks .recs.json age every 30 minutes, automatically regenerating when older than 24h.

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const RECS_FILE = process.env.RECS_FILE || path.join(ROOT, ".recs.json");
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = parseInt(process.env.RECS_CHECK_INTERVAL_MS || String(30 * 60 * 1000), 10);

function isDueForRefresh(filePath = RECS_FILE) {
  if (!fs.existsSync(filePath)) return true;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    if (!data || !data.generatedAt) return true;
    const genTime = new Date(data.generatedAt).getTime();
    if (isNaN(genTime)) return true;
    return Date.now() - genTime >= ONE_DAY_MS;
  } catch (_) {
    return true;
  }
}

async function runRefresh() {
  console.log(`[recs-scheduler] Triggering daily recommendations refresh at ${new Date().toISOString()}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, "refresh-recs.js")], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.on("close", (code) => {
      console.log(`[recs-scheduler] Refresh finished with code ${code}`);
      resolve(code);
    });
    child.on("error", (err) => {
      console.error(`[recs-scheduler] Refresh failed:`, err.message);
      resolve(1);
    });
  });
}

async function loop() {
  console.log(`[recs-scheduler] Daily recommendations scheduler started. Checking every ${CHECK_INTERVAL_MS / 60000}m.`);
  if (isDueForRefresh()) {
    await runRefresh();
  }
  setInterval(async () => {
    if (isDueForRefresh()) {
      await runRefresh();
    }
  }, CHECK_INTERVAL_MS);
}

if (require.main === module) {
  loop().catch((err) => {
    console.error("[recs-scheduler] Error:", err.message);
    process.exit(1);
  });
}

module.exports = { isDueForRefresh, runRefresh };

// src/index.js
const dns = require("dns");
try {
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {}

const express = require("express");
const crypto = require("crypto");
const { manifest, buildManifest, CATALOG_ID_TO_GENRE } = require("./manifest");
const genres = require("./genres");
const { resolveGenre } = genres;
const { getRecs, hasRecs } = require("./recs");
const { decodeConfig } = require("./config");
const { searchAudiobooks, searchComics, qualityScore, comicQualityScore } = require("./sources");
const { enrich } = require("./metadata");
const { encodeItemId, decodeItemId } = require("./itemid");
const { TTLCache, pLimit, withTimeout } = require("./cache");
const { makeAccess } = require("./access");
const { getBookKey, sortInSeriesOrder, parseSeriesAndBook, cleanDisplayTitle, cleanEpisodeTitle, expandSeriesPacks } = require("./series");
const { fetchSeriesMeta, fetchSeriesBooks, cleanSeriesQuery } = require("./series_meta");
const { getCatalogBooks, startCatalogRefresher } = require("./catalogs_meta");
const torbox = require("./torbox");
const nuvio = require("./nuvio");

const app = express();
const PORT = process.env.PORT || 7000;
const access = makeAccess(); // shared-token gate (off unless ACCESS_TOKENS set)

app.use(express.json());

const searchCache = new TTLCache(5 * 60 * 1000, 200); // resolved catalog results
const streamCache = new TTLCache(30 * 60 * 1000, 500); // resolved playable streams
const limitMeta = pLimit(6); // cap concurrent cover-art lookups

// Cache key for resolved streams: hash the API key so it never lands in a key.
// Includes the content type — the same torrent resolved as "comic" keeps a
// different file set than as "audiobook".
function streamKey(apiKey, type, infohash) {
  const kh = crypto.createHash("sha1").update(apiKey).digest("hex").slice(0, 12);
  return `${kh}:${type}:${infohash}`;
}

// Whitelist the content type; anything unknown falls back to audiobook.
function typeOf(x) {
  return x === "comic" ? "comic" : "audiobook";
}

// Instant-only can be set per-install (config) or globally (env).
function isInstantOnly(cfg) {
  return !!(cfg.instantOnly || process.env.INSTANT_ONLY === "1");
}

// ---- CORS (Stremio fetches these routes from the browser) -------------------
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Build a short "Format · Bitrate · Size" line for descriptions/titles.
function detailLine(parts) {
  return parts.filter(Boolean).join(" · ");
}

// Metadata providers report runtime in minutes; Audible shows "X hr Y min".
function formatRuntime(minutes) {
  const total = parseInt(minutes, 10);
  if (!Number.isFinite(total) || total <= 0) return null;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

// Format display titles cleanly for Stremio/Nuvio cards
const prettyName = cleanDisplayTitle;

// Read & validate the per-user config from the URL path segment (or env default).
function getConfig(req, res) {
  let cfg = req.params.config ? decodeConfig(req.params.config) : null;
  if (!cfg && process.env.TORBOX_API_KEY) {
    cfg = {
      apiKey: process.env.TORBOX_API_KEY,
      instantOnly: process.env.INSTANT_ONLY === "1",
    };
  }
  if (!cfg || !cfg.apiKey) {
    res.status(400).json({ err: "Missing or invalid configuration. Re-install the addon." });
    return null;
  }
  if (!access.valid(cfg.token)) {
    res.status(403).json({ err: "Invalid or missing access token for this instance." });
    return null;
  }
  return cfg;
}

// ---- Configure page (landing) ----------------------------------------------
const CONFIGURE_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>BusTAudioBooks — Configure</title>
<style>
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background:#15101c; color:#ece8f1;
         max-width:560px; margin:0 auto; padding:32px 20px; line-height:1.5; }
  h1 { font-size:1.5rem; margin-bottom:4px; }
  p.sub { color:#a99fb8; margin-top:0; }
  label { display:block; margin:18px 0 6px; font-weight:600; font-size:.92rem; }
  input { width:100%; padding:11px 12px; border-radius:9px; border:1px solid #3a3147;
          background:#221a2e; color:#fff; font-size:.95rem; box-sizing:border-box; }
  small { color:#8f859e; }
  button { margin-top:24px; width:100%; padding:13px; border:0; border-radius:10px;
           background:#8b5cf6; color:#fff; font-size:1rem; font-weight:600; cursor:pointer; }
  .out { margin-top:24px; display:none; }
  .row { display:flex; gap:8px; }
  .row input { font-size:.8rem; }
  .copy { width:auto; margin-top:0; padding:0 16px; background:#3a3147; }
  a.install { display:block; text-align:center; margin-top:12px; padding:13px;
              border-radius:10px; background:#22c55e; color:#062b14; font-weight:700;
              text-decoration:none; }
</style></head>
<body>
  <h1>BusTAudioBooks</h1>
  <p class="sub">Search &amp; stream audiobooks through your TorBox account.</p>

  <label>TorBox API key <small>(required)</small></label>
  <input id="apiKey" placeholder="from torbox.app → Settings → API"/>

  <div id="tokenCfg" style="display:none">
    <label>Access token <small>(required — ask whoever runs this instance)</small></label>
    <input id="accessToken" placeholder="access token"/>
  </div>

  <!-- NUVIO PERSONAL RECOMMENDATIONS SECTION -->
  <div style="margin-top:22px;padding:16px;background:#1e172a;border-radius:12px;border:1px solid #3d3151">
    <div style="display:flex;align-items:center;justify-content:space-between">
      <label style="margin:0;font-size:1rem;color:#f3e8ff">Personal Recommendations (Nuvio)</label>
      <span id="nuvioBadge" style="display:none;font-size:.78rem;background:#22c55e22;color:#4ade80;border:1px solid #22c55e66;padding:2px 8px;border-radius:99px;font-weight:600">Connected</span>
    </div>
    <p style="margin:4px 0 12px;color:#a99fb8;font-size:.85rem">
      Connect your Nuvio account to get recommendations heavily weighted by what you have actually listened to.
    </p>

    <label style="margin:8px 0 4px;font-size:.85rem">Nuvio Email</label>
    <input id="nuvioEmail" type="email" placeholder="you@email.com"/>

    <label style="margin:8px 0 4px;font-size:.85rem">Nuvio Password</label>
    <input id="nuvioPassword" type="password" placeholder="Nuvio account password"/>

    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="button" id="btnNuvioLogin" onclick="loginNuvio()" style="margin-top:0;padding:10px;font-size:.9rem;background:#7c3aed">Connect &amp; Select Profile</button>
      <button type="button" id="btnNuvioClear" onclick="clearNuvio()" style="display:none;margin-top:0;width:auto;padding:10px 14px;font-size:.9rem;background:#3a3147">Disconnect</button>
    </div>
    <div id="nuvioMsg" style="margin-top:8px;font-size:.85rem"></div>

    <div id="nuvioProfileDiv" style="display:none;margin-top:12px">
      <label style="margin:0 0 4px;font-size:.85rem">Audiobook Profile</label>
      <select id="nuvioProfile" style="width:100%;padding:10px;border-radius:9px;border:1px solid #3a3147;background:#221a2e;color:#fff;font-size:.92rem"></select>
      <div id="nuvioStats" style="margin-top:8px;font-size:.82rem;color:#94a3b8"></div>
    </div>
  </div>

  <p id="serverNote" style="display:none;margin-top:16px;color:#8f859e;font-size:.9rem">
    🔎 Search is provided by this server — just add your TorBox key above and install.
  </p>

  <div id="sourceCfg">
    <label>AudiobookBay domain <small>(enables search, no extra software)</small></label>
    <input id="abbDomain" placeholder="e.g. audiobookbay.lu — current working domain"/>

    <details style="margin-top:18px">
      <summary style="cursor:pointer;color:#a99fb8">Advanced: use Jackett/Prowlarr instead (optional)</summary>
      <label>Jackett / Prowlarr URL</label>
      <input id="jackettUrl" placeholder="http://localhost:9117"/>
      <label>Indexer API key</label>
      <input id="jackettApiKey" placeholder="Jackett/Prowlarr API key"/>
      <p style="margin-top:10px;color:#8f859e;font-size:.85rem">
        📚 Comics search in the mobile app also uses Jackett/Prowlarr
        (Torznab category 7030) — add an indexer that carries comics to enable it.
      </p>
    </details>
  </div>

  <label style="display:flex;align-items:center;gap:10px;margin-top:18px;font-weight:600;font-size:.92rem">
    <input type="checkbox" id="instantOnly" style="width:auto"/>
    Instant-only — only show titles already cached on TorBox
  </label>

  <button onclick="gen()">Generate install link</button>

  <div class="out" id="out">
    <label>Manifest URL</label>
    <div class="row">
      <input id="url" readonly/>
      <button class="copy" onclick="copy()">Copy</button>
    </div>
    <a class="install" id="install">Install in Stremio</a>
  </div>

<script>
function b64url(str){
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
}

var nuvioProfiles = [];

async function loginNuvio(){
  var email = document.getElementById('nuvioEmail').value.trim();
  var password = document.getElementById('nuvioPassword').value;
  var msg = document.getElementById('nuvioMsg');
  var btn = document.getElementById('btnNuvioLogin');
  if(!email || !password){
    msg.innerHTML = '<span style="color:#f87171">Please enter both Nuvio email and password.</span>';
    return;
  }
  msg.innerHTML = '<span style="color:#94a3b8">Connecting to Nuvio Cloud...</span>';
  btn.disabled = true;
  try {
    var res = await fetch('/api/nuvio/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    });
    var data = await res.json();
    if(!data.ok){
      msg.innerHTML = '<span style="color:#f87171">' + (data.error || 'Login failed') + '</span>';
      return;
    }
    nuvioProfiles = data.profiles || [];
    var sel = document.getElementById('nuvioProfile');
    sel.innerHTML = '';
    nuvioProfiles.forEach(function(p){
      var opt = document.createElement('option');
      opt.value = p.index;
      opt.textContent = p.name + ' (Profile ' + p.index + ')';
      if(p.index === data.defaultProfileId) opt.selected = true;
      sel.appendChild(opt);
    });
    document.getElementById('nuvioProfileDiv').style.display = 'block';
    document.getElementById('nuvioBadge').style.display = 'inline-block';
    document.getElementById('btnNuvioClear').style.display = 'inline-block';
    msg.innerHTML = '<span style="color:#4ade80">Connected! ' + nuvioProfiles.length + ' profile(s) found.</span>';
    checkNuvioStatus(email, password, sel.value);
  } catch(e) {
    msg.innerHTML = '<span style="color:#f87171">Connection error: ' + e.message + '</span>';
  } finally {
    btn.disabled = false;
  }
}

async function checkNuvioStatus(email, password, profileId){
  var stats = document.getElementById('nuvioStats');
  try {
    var res = await fetch('/api/nuvio/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password, profileId: profileId })
    });
    var data = await res.json();
    if(data.ok){
      stats.innerHTML = '🎧 <b>' + data.consumedCount + '</b> actively listened books · 📚 <b>' + data.libraryCount + '</b> library books';
    }
  } catch(_) {}
}

function clearNuvio(){
  document.getElementById('nuvioEmail').value = '';
  document.getElementById('nuvioPassword').value = '';
  document.getElementById('nuvioProfileDiv').style.display = 'none';
  document.getElementById('nuvioBadge').style.display = 'none';
  document.getElementById('btnNuvioClear').style.display = 'none';
  document.getElementById('nuvioMsg').innerHTML = '';
  nuvioProfiles = [];
}

function gen(){
  var apiKey=document.getElementById('apiKey').value.trim();
  if(!apiKey){ alert('TorBox API key is required'); return; }
  var cfg={ apiKey:apiKey };
  var abb=document.getElementById('abbDomain').value.trim();
  var ju=document.getElementById('jackettUrl').value.trim();
  var jk=document.getElementById('jackettApiKey').value.trim();
  if(abb) cfg.abbDomain=abb;
  if(ju) cfg.jackettUrl=ju;
  if(jk) cfg.jackettApiKey=jk;
  if(document.getElementById('instantOnly').checked) cfg.instantOnly=true;
  var tok=document.getElementById('accessToken').value.trim();
  if(tok) cfg.token=tok;

  var nEmail = document.getElementById('nuvioEmail').value.trim();
  var nPass = document.getElementById('nuvioPassword').value;
  var nProf = document.getElementById('nuvioProfile').value;
  if(nEmail && nPass){
    cfg.nuvio = {
      email: nEmail,
      password: nPass,
      profileId: parseInt(nProf, 10) || 1
    };
  }

  var seg=b64url(JSON.stringify(cfg));
  var base=location.origin+'/'+seg+'/manifest.json';
  document.getElementById('url').value=base;
  document.getElementById('install').href=base.replace(/^https?:/,'stremio:');
  document.getElementById('out').style.display='block';
}

function copy(){
  var f=document.getElementById('url'); f.select();
  navigator.clipboard.writeText(f.value);
}

if (window.__serverSearch) {
  document.getElementById('sourceCfg').style.display='none';
  document.getElementById('serverNote').style.display='block';
}
if (window.__requireToken) {
  document.getElementById('tokenCfg').style.display='block';
}
if (window.__initCfg) {
  var c = window.__initCfg;
  if (c.apiKey) document.getElementById('apiKey').value = c.apiKey;
  if (c.abbDomain) document.getElementById('abbDomain').value = c.abbDomain;
  if (c.jackettUrl) document.getElementById('jackettUrl').value = c.jackettUrl;
  if (c.jackettApiKey) document.getElementById('jackettApiKey').value = c.jackettApiKey;
  if (c.instantOnly) document.getElementById('instantOnly').checked = true;
  if (c.token) document.getElementById('accessToken').value = c.token;
  var n = c.nuvio || (c.nuvioEmail ? { email: c.nuvioEmail, password: c.nuvioPassword, profileId: c.nuvioProfileId } : null);
  if (n && n.email) {
    document.getElementById('nuvioEmail').value = n.email;
    if (n.password) document.getElementById('nuvioPassword').value = n.password;
    if (n.profileId) {
      var sel = document.getElementById('nuvioProfile');
      var opt = document.createElement('option');
      opt.value = n.profileId;
      opt.textContent = 'Profile ' + n.profileId;
      opt.selected = true;
      sel.appendChild(opt);
      document.getElementById('nuvioProfileDiv').style.display = 'block';
    }
    document.getElementById('nuvioBadge').style.display = 'inline-block';
    document.getElementById('btnNuvioClear').style.display = 'inline-block';
  }
}
</script>
</body></html>`;

// ---- Nuvio Auth & Profile API -----------------------------------------------
app.post("/api/nuvio/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Nuvio email and password are required." });
    }
    const creds = { email: String(email).trim(), password: String(password) };
    const profiles = await nuvio.listProfiles(creds);

    let defaultProfileId = 1;
    const audiobookProf = profiles.find((p) => /audiobook/i.test(p.name));
    if (audiobookProf) {
      defaultProfileId = audiobookProf.profile_index;
    } else if (profiles[0]) {
      defaultProfileId = profiles[0].profile_index;
    }

    res.json({
      ok: true,
      email: creds.email,
      profiles: profiles.map((p) => ({ id: p.id, index: p.profile_index, name: p.name })),
      defaultProfileId,
    });
  } catch (err) {
    console.warn("nuvio login failed:", err.message);
    let msg = "Failed to connect to Nuvio Cloud";
    if (/400|401|invalid|credential|password/i.test(err.message)) {
      msg = "Invalid Nuvio email or password";
    }
    res.status(401).json({ ok: false, error: msg });
  }
});

app.post("/api/nuvio/status", async (req, res) => {
  try {
    const { email, password, profileId } = req.body || {};
    const creds = nuvio.getCredentials({ email, password });
    if (!creds) {
      return res.status(400).json({ ok: false, error: "Nuvio credentials required." });
    }
    const profIndex = nuvio.parseProfileIndex(profileId) || 1;
    const activity = await nuvio.pullUserHistoryAndLibrary(profIndex, creds);
    res.json({
      ok: true,
      profileIndex: profIndex,
      consumedCount: activity.watchItems.length,
      libraryCount: activity.libraryItems.length,
      fingerprint: activity.fingerprint.slice(0, 12),
      sampleConsumed: activity.watchItems.slice(0, 3).map((w) => ({
        name: w.name,
        progress: `${w.progressPercent}%`,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

function sendConfigure(req, res) {
  const serverSearch =
    (!!process.env.JACKETT_URL && !!process.env.JACKETT_API_KEY) || !!process.env.ABB_DOMAIN;
  let initCfg = req.params.config ? decodeConfig(req.params.config) : null;
  const flag =
    `<script>window.__serverSearch=${serverSearch ? "true" : "false"};` +
    `window.__requireToken=${access.required ? "true" : "false"};` +
    `window.__initCfg=${initCfg ? JSON.stringify(initCfg) : "null"};</script>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(CONFIGURE_HTML.replace("</head>", `${flag}</head>`));
}
app.get("/", (_req, res) => res.redirect("/configure"));
app.get("/configure", sendConfigure);
// Stremio opens /<config>/configure for re-configuration.
app.get("/:config/configure", sendConfigure);

// ---- Manifest ---------------------------------------------------------------
function handleManifest(req, res) {
  const cfg = req.params.config ? decodeConfig(req.params.config) : (process.env.TORBOX_API_KEY ? { apiKey: process.env.TORBOX_API_KEY } : null);
  const man = buildManifest({ withRecs: hasRecs(cfg) });
  if (cfg && cfg.apiKey) {
    return res.json({ ...man, behaviorHints: { ...man.behaviorHints, configurationRequired: false } });
  }
  // If not configured yet, still serve manifest so Nuvio/Stremio can read metadata & configuration link
  return res.json(man);
}
app.get("/manifest.json", handleManifest);
app.get("/:config/manifest.json", handleManifest);

// ---- Shared search (used by both the Stremio catalog and the app API) -------
// Returns enriched result items: the raw source item plus { poster, author,
// cached }. Cached per query/page so both consumers share the heavy work.
async function runSearch(cfg, query, page, type = "audiobook") {
  const instantOnly = isInstantOnly(cfg);
  const effJackett = cfg.jackettUrl || process.env.JACKETT_URL || "";
  const cacheKey = `${type}|${cfg.abbDomain || ""}|${effJackett}|${instantOnly ? "I" : ""}|${query}|${page}`;
  const hit = searchCache.get(cacheKey);
  if (hit) return hit;

  let results = [];
  try {
    results =
      type === "comic"
        ? await searchComics(cfg, query, page)
        : await searchAudiobooks(cfg, query, page);
  } catch (err) {
    console.error("search error:", err.message);
  }
  results = results.slice(0, 100);

  let cachedSet = new Set();
  try {
    const hashes = results.map((r) => r.infohash).filter(Boolean);
    if (hashes.length) cachedSet = await torbox.checkCachedMany(cfg.apiKey, hashes);
  } catch (_) {
    /* non-critical */
  }

  if (instantOnly) results = results.filter((r) => r.infohash && cachedSet.has(r.infohash));

  results.sort((a, b) => {
    const ca = a.infohash && cachedSet.has(a.infohash) ? 1 : 0;
    const cb = b.infohash && cachedSet.has(b.infohash) ? 1 : 0;
    if (ca !== cb) return cb - ca;
    const score = type === "comic" ? comicQualityScore : qualityScore;
    const qa = score(a);
    const qb = score(b);
    if (qa !== qb) return qb - qa;
    return (b.seeders || 0) - (a.seeders || 0);
  });

  const enriched = await Promise.all(
    results.map((r) =>
      limitMeta(async () => {
        const meta = await withTimeout(enrich(r.name, type), 2500, { poster: null, author: null });
        return {
          ...r,
          poster: meta.poster || null,
          author: r.author || meta.author || null,
          cached: !!(r.infohash && cachedSet.has(r.infohash)),
        };
      })()
    )
  );

  searchCache.set(cacheKey, enriched);
  return enriched;
}

// ---- Catalog (search only) --------------------------------------------------
async function handleCatalog(req, res, extraRaw) {
  const cfg = getConfig(req, res);
  if (!cfg) return;

  // Parse extras like "search=foo&skip=20"
  const extra = {};
  if (extraRaw) {
    for (const pair of extraRaw.split("&")) {
      const idx = pair.indexOf("=");
      if (idx === -1) continue;
      extra[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1));
    }
  }

  // Support both extra path segment AND query parameters (e.g. ?search=dune&skip=12)
  const query = String(req.query.search || extra.search || "").trim();
  const catalogId = req.params.id;
  const mappedGenre = CATALOG_ID_TO_GENRE ? CATALOG_ID_TO_GENRE[catalogId] : null;
  const genre = String(req.query.genre || extra.genre || mappedGenre || "").trim();
  const PAGE_SIZE = 12;
  const skip = parseInt(req.query.skip || extra.skip, 10) || 0;

  let items = [];
  let searchQuery = query;
  // Set by the recommendations row below. It must not fall back to the
  // hardcoded FEATURED_AUDIOBOOKS list: those are arbitrary popular titles, and
  // presenting them as "Recommended For You" is simply a lie about what the
  // recommender chose. An empty row is the honest result.
  let isRecsRow = false;
  const g = resolveGenre(genre);

  if (query) {
    searchQuery = query;
    try {
      items = await runSearch(cfg, searchQuery, 1);
    } catch (_) {}
  } else if (g && g.kind === genres.TORBOX) {
    searchQuery = "";
    try {
      const list = await torbox.getMyList(cfg.apiKey);
      if (Array.isArray(list)) {
        const audioItems = list.filter(
          (t) =>
            torbox.isAudioFile(t.name) ||
            (Array.isArray(t.files) && t.files.some((f) => torbox.isAudioFile(f.name)))
        );
        items = audioItems.map((t) => ({
          name: t.name,
          infohash: (t.hash || "").toLowerCase(),
          magnet: t.magnet || torbox.magnetFromInfohash(t.hash, t.name),
          size: t.size || 0,
          seeders: 1,
          tracker: "TorBox Library",
          cached: true,
          format: (t.name.match(/\b(M4B|MP3|FLAC|AAC)\b/i) || [])[1] || "M4B",
          bitrate: null,
        }));
      }
    } catch (_) {}
  } else if (g && g.kind === genres.RECS) {
    // Personal recommendations. Fully resolved by scripts/refresh-recs.js: each
    // entry already carries the release to play, so this branch does no network
    // work at all. That matters — resolving here meant firing one source request
    // per book at once, which AudiobookBay answers with an empty page.
    const list = getRecs(cfg);
    searchQuery = "";
    isRecsRow = true;
    if (!list.items.length) {
      console.warn("Recommendations requested but .recs.json has no playable entries — run scripts/refresh-recs.js");
    }
    items = list.items.map((rec) => {
      const best = { ...rec.release, tracker: "AudiobookBay", seeders: 0 };
      // Prefer the clean book title from the recommendation over the messy release name
      best.name = rec.title || best.name;
      if (rec.author) best.author = rec.author;
      if (rec.poster) best.poster = rec.poster;
      if (rec.reason) best.reason = rec.reason;
      return best;
    });
  } else {
    // Dynamic metadata-driven catalog fetching with scheduled regular refreshes.
    // Pulls clean studio bestsellers directly from Audible / Open Library.
    searchQuery = "";
    try {
      const genreToFetch = g ? g.name : genre;
      const metaBooks = await getCatalogBooks(genreToFetch);
      if (Array.isArray(metaBooks) && metaBooks.length > 0) {
        const paged = metaBooks.slice(skip, skip + PAGE_SIZE);
        const metas = paged.map((r) => {
          const isSeries = !!r.isSeries;
          const itemData = {
            name: r.name,
            author: r.author || undefined,
            asin: r.asin || undefined,
            seriesName: r.seriesName || undefined,
            bookNumber: r.bookNumber != null ? r.bookNumber : undefined,
            isSeries,
            type: isSeries ? "series" : (req.params.type || "other"),
          };
          return {
            id: encodeItemId(itemData),
            type: isSeries ? "series" : (req.params.type || "other"),
            name: prettyName(r.name),
            poster: r.poster || undefined,
            posterShape: "square",
            description:
              detailLine([
                isSeries ? "📚 Series Collection" : null,
                r.seriesName ? (r.bookNumber ? `${r.seriesName} #${r.bookNumber}` : r.seriesName) : null,
                r.author ? `By ${r.author}` : null,
              ]) || (r.description ? r.description.slice(0, 160) : undefined),
          };
        });
        return res.json({ metas });
      }
    } catch (err) {
      console.warn(`[catalog] metadata catalog fetch failed for "${genre}":`, err.message);
    }
    // Absolute constraint: No hardcoded placeholders or fallbacks.
    return res.json({ metas: [] });
  }

  // Strict constraint: absolutely no hardcoded fallbacks or placeholder books.
  // Either real audiobooks are resolved dynamically or return empty.
  const finalItems = items || [];

  // Expand multi-book series packs into separate individual books and exclude omnibus bundles
  const expandedItems = expandSeriesPacks(finalItems, searchQuery);

  // Deduplicate releases so each distinct book appears only once (Option A),
  // keeping the highest quality / instant-cached release per book.
  const seenBooks = new Set();
  const deduped = [];
  for (const r of expandedItems) {
    if (!r.seriesInfo) r.seriesInfo = parseSeriesAndBook(r.name, r.author, searchQuery);
    const key = getBookKey(r.name, r.author, searchQuery);
    if (!seenBooks.has(key)) {
      seenBooks.add(key);
      deduped.push(r);
    }
  }

  let seriesCard = null;
  let isQueryingSeries = false;

  if (query) {
    try {
      const seriesCandidate = await withTimeout(fetchSeriesBooks(cleanSeriesQuery(query)), 2500, null);
      if (seriesCandidate && Array.isArray(seriesCandidate.books) && seriesCandidate.books.length >= 2) {
        const cleanQ = cleanSeriesQuery(query).toLowerCase();
        const snLower = seriesCandidate.seriesName.toLowerCase();
        isQueryingSeries =
          cleanQ === snLower ||
          snLower.includes(cleanQ) ||
          cleanQ.includes(snLower) ||
          /\b(?:series|saga|trilogy|collection|chronicles|sequence)\b/i.test(query);

        if (isQueryingSeries) {
          const sAuthor = seriesCandidate.author || "";
          const sPoster =
            seriesCandidate.collectionPoster ||
            (seriesCandidate.books[0] && seriesCandidate.books[0].poster) ||
            undefined;
          seriesCard = {
            id: encodeItemId({
              type: "series",
              isSeries: true,
              seriesName: seriesCandidate.seriesName,
              name: `${seriesCandidate.seriesName} (Series)`,
              author: sAuthor,
            }),
            type: "series",
            name: `${seriesCandidate.seriesName} Series${sAuthor ? ` — ${sAuthor}` : ""}`,
            poster: sPoster,
            posterShape: "square",
            description: `📚 Full Series (${seriesCandidate.books.length} Books in Reading Order)${sAuthor ? ` · By ${sAuthor}` : ""}`,
          };
        }
      }
    } catch (_) {}
  }

  // Sort books: series order if searching a series; prioritize collections/series if query is of a series
  const ordered = searchQuery
    ? sortInSeriesOrder(deduped, { prioritizeSeries: isQueryingSeries })
    : deduped;

  // Paginate according to skip so users can scroll infinitely through audiobooks
  const paged = query ? ordered : ordered.slice(skip, skip + PAGE_SIZE);

  // Guarantee every card in the current page has cover art and author populated
  await Promise.all(
    paged.map(async (r) => {
      if (!r.poster) {
        const meta = await withTimeout(enrich(r.name, "audiobook"), 2000, null).catch(() => null);
        if (meta && meta.poster) {
          r.poster = meta.poster;
          if (!r.author && meta.author) r.author = meta.author;
        }
      }
    })
  );

  const metas = paged.map((r) => {
    const sInfo = parseSeriesAndBook(r.name, r.author, searchQuery);
    const isSeries = !!(sInfo && sInfo.isCollection);
    const itemData = {
      ...r,
      isSeries,
      type: isSeries ? "series" : (req.params.type || "other"),
      seriesName: (sInfo && sInfo.seriesName) || undefined,
    };
    return {
      id: encodeItemId(itemData),
      type: isSeries ? "series" : (req.params.type || "other"),
      name: prettyName(r.name),
      poster: r.poster || undefined,
      posterShape: "square",
      description:
        detailLine([
          r.cached ? "⚡ Instant" : null,
          isSeries ? "📚 Series Collection" : null,
          r.format,
          r.bitrate,
          torbox.formatBytes(r.size),
          r.author,
        ]) || r.tracker,
    };
  });

  // If the query is of a book series, prepend the comprehensive Series card at the top
  if (seriesCard && skip === 0) {
    metas.unshift(seriesCard);
  }

  res.json({ metas });
}

app.get("/catalog/:type/:id.json", (req, res) => handleCatalog(req, res, null));
app.get("/catalog/:type/:id/:extra.json", (req, res) => handleCatalog(req, res, req.params.extra));
app.get("/:config/catalog/:type/:id.json", (req, res) => handleCatalog(req, res, null));
app.get("/:config/catalog/:type/:id/:extra.json", (req, res) =>
  handleCatalog(req, res, req.params.extra)
);

// ---- Meta -------------------------------------------------------------------
async function handleMeta(req, res) {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  const item = decodeItemId(req.params.id);
  if (!item) return res.json({ meta: null });

  const [meta, isCached, files] = await Promise.all([
    withTimeout(enrich(item.name), 3500, { poster: null, author: null, description: null, year: null }),
    item.infohash
      ? withTimeout(torbox.checkCached(cfg.apiKey, item.infohash), 4000, false)
      : Promise.resolve(false),
    item.infohash
      ? withTimeout(torbox.getTorrentFiles(cfg.apiKey, item.infohash), 4000, [])
      : Promise.resolve([]),
  ]);

  // Runtime: prefer the real figure from the metadata provider over any
  // "[128 kbps]" tag scraped out of the release filename.
  const runtime = formatRuntime(meta.duration);

  const sInfo = parseSeriesAndBook(item.name, item.author || (meta && meta.author));
  const isSeries = req.params.type === "series" || item.isSeries || !!(sInfo && sInfo.isCollection) || (Array.isArray(files) && files.length > 1);
  const detectedSeriesName = item.seriesName || (meta && meta.series) || (sInfo && sInfo.seriesName) || null;

  let videos = undefined;
  let seriesMeta = null;

  if (isSeries && detectedSeriesName) {
    try {
      seriesMeta = await withTimeout(
        fetchSeriesMeta(detectedSeriesName, item.author || (meta && meta.author), {
          infohash: item.infohash,
          poster: meta.poster,
          files,
        }),
        4500,
        null
      );
      if (seriesMeta && Array.isArray(seriesMeta.videos) && seriesMeta.videos.length > 0) {
        videos = seriesMeta.videos;
      }
    } catch (_) {}
  }

  // Fallback: If not fetched via metadata series, but torrent has multiple audio files, use file episodes
  if (!videos && Array.isArray(files) && files.length > 1) {
    videos = files.map((file, idx) => {
      const epNum = idx + 1;
      const fName = file.name || file.short_name || `Episode ${epNum}`;
      const epTitle = cleanEpisodeTitle(fName);
      const epItem = {
        ...item,
        targetFile: file.name || file.short_name,
        name: epTitle,
      };
      return {
        id: encodeItemId(epItem),
        title: epTitle,
        season: 1,
        episode: epNum,
        released: meta.year || undefined,
        thumbnail: meta.poster || undefined,
      };
    });
  }

  const facts = detailLine([
    meta.rating ? `⭐ ${meta.rating}/5` : null,
    item.infohash
      ? (isCached ? "⚡ Instant on TorBox" : "Will download to TorBox on play")
      : "Adds to TorBox on play",
    item.format,
    item.bitrate,
    runtime,
    torbox.formatBytes(item.size),
  ]);

  const descParts = [];
  if (seriesMeta && seriesMeta.description) {
    descParts.push(seriesMeta.description);
  } else if (videos && videos.length > 1) {
    descParts.push(`📖 Series / Multi-Part Audio Collection (${videos.length} Episodes/Books)`);
  }
  // The personal-recommendations row carries the model's "why this book". It is
  // the only thing distinguishing these tiles from a normal search result, so
  // it leads.
  if (item.reason) descParts.push(item.reason);
  if (meta.author) descParts.push(`By ${meta.author}`);
  if (meta.narrator) descParts.push(`Narrated by ${meta.narrator}`);
  if (meta.series) descParts.push(`Series: ${meta.seriesIndex ? `${meta.series} #${meta.seriesIndex}` : meta.series}`);
  if (meta.description) descParts.push(meta.description);
  if (facts) descParts.push(facts);
  const description = descParts.filter(Boolean).join("\n\n");

  // Stremio shows `genres` as chips, and the series name is the single most
  // useful chip for a series audiobook, so it leads.
  const genres = [];
  if (meta.series) {
    genres.push(meta.seriesIndex ? `${meta.series} #${meta.seriesIndex}` : meta.series);
  }
  genres.push("Audiobook");
  if (Array.isArray(meta.genres)) {
    for (const g of meta.genres) {
      if (typeof g === "string" && !genres.includes(g)) genres.push(g);
    }
  }

  res.json({
    meta: {
      id: req.params.id,
      type: isSeries ? "series" : (req.params.type || "audiobook"),
      name: (seriesMeta && seriesMeta.name) || prettyName(item.name) || "Audiobook",
      poster: (seriesMeta && seriesMeta.poster) || meta.poster || undefined,
      background: (seriesMeta && seriesMeta.background) || meta.poster || undefined,
      posterShape: "square",
      description,
      releaseInfo: (seriesMeta && seriesMeta.releaseInfo) || meta.year || undefined,
      genres: seriesMeta && Array.isArray(seriesMeta.genres) ? [...new Set([...seriesMeta.genres, ...genres])] : genres,
      // Stremio has no narrator field; `director` is the closest slot, and it
      // is what most audio addons abuse for this. `cast` keeps the author.
      director: meta.narrator ? [meta.narrator] : undefined,
      cast: meta.author ? [meta.author] : undefined,
      videos,
    },
  });
}
app.get("/meta/:type/:id.json", handleMeta);
app.get("/:config/meta/:type/:id.json", handleMeta);

// ---- Shared stream resolution (Stremio + app) -------------------------------
async function resolveForItem(cfg, item) {
  const type = typeOf(item.type);

  // If this item represents a series episode from a parent torrent pack, try parent torrent first
  if (item.parentInfohash && !item.infohash) {
    try {
      const parentResult = await resolveForItem(cfg, {
        ...item,
        infohash: item.parentInfohash,
        parentInfohash: undefined,
      });
      if (parentResult && parentResult.ready && Array.isArray(parentResult.streams) && parentResult.streams.length > 0) {
        return parentResult;
      }
    } catch (_) {}
  }

  // If this item represents a metadata catalog book or series episode without an infohash, dynamically search and resolve the best torrent
  if (!item.infohash && item.name) {
    const bookTitle = cleanDisplayTitle(item.name || "");
    const bookQuery = `${bookTitle} ${item.author || ""}`.trim();
    try {
      const searchResults = await searchAudiobooks(cfg, bookQuery, 1);
      if (Array.isArray(searchResults) && searchResults.length > 0) {
        const hashes = searchResults.map((r) => r.infohash).filter(Boolean);
        let cachedSet = new Set();
        try {
          if (hashes.length) cachedSet = await torbox.checkCachedMany(cfg.apiKey, hashes);
        } catch (_) {}

        searchResults.sort((a, b) => {
          const ca = a.infohash && cachedSet.has(a.infohash) ? 1 : 0;
          const cb = b.infohash && cachedSet.has(b.infohash) ? 1 : 0;
          if (ca !== cb) return cb - ca;
          const qa = qualityScore(a);
          const qb = qualityScore(b);
          if (qa !== qb) return qb - qa;
          return (b.seeders || 0) - (a.seeders || 0);
        });

        const best = searchResults[0];
        if (best) {
          return await resolveForItem(cfg, { ...best, targetFile: item.targetFile });
        }
      }
    } catch (err) {
      console.error("dynamic episode resolution error:", err.message);
    }
  }

  const key = streamKey(cfg.apiKey, type, item.infohash || item.torrentUrl || item.name);
  const cachedStreams = streamCache.get(key);
  if (cachedStreams) return { ready: true, status: "ok", streams: cachedStreams };

  const result = await torbox.resolveStreams(cfg.apiKey, {
    magnet: item.magnet,
    infohash: item.infohash,
    torrentUrl: item.torrentUrl,
    name: item.name,
    instantOnly: isInstantOnly(cfg),
    kind: type === "comic" ? "comic" : "audio",
  });
  if (result.ready) streamCache.set(key, result.streams);
  return result;
}

// ---- Stream -----------------------------------------------------------------
async function handleStream(req, res) {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  const item = decodeItemId(req.params.id);
  if (!item) return res.json({ streams: [] });

  const tag = detailLine([item.format, item.bitrate]);
  const decorate = (streams) =>
    streams.map((s) => ({ ...s, name: tag ? `BusTAudioBooks\n${tag}` : "BusTAudioBooks" }));

  try {
    const result = await resolveForItem(cfg, item);
    if (result.ready) {
      let streams = result.streams || [];
      if (item.targetFile && streams.length > 1) {
        const tf = item.targetFile.toLowerCase();
        const getFn = (s) =>
          ((s.behaviorHints && s.behaviorHints.filename) || s.title || "")
            .split("\n")[0]
            .trim()
            .toLowerCase();
        const exact = streams.filter((s) => getFn(s) === tf);
        if (exact.length > 0) {
          streams = exact;
        } else {
          const matched = streams.filter((s) => getFn(s).includes(tf));
          if (matched.length > 0) streams = matched;
        }
      }
      return res.json({ streams: decorate(streams) });
    }
    // Not cached yet: surface a non-playable info entry so the user knows to wait.
    // Do not pass externalUrl so Nuvio does not attempt to play external web URLs as media.
    return res.json({
      streams: [
        {
          name: "BusTAudioBooks",
          title: `⏳ ${result.status}`,
        },
      ],
    });
  } catch (err) {
    console.error("stream error:", err.message);
    return res.json({
      streams: [{ name: "BusTAudioBooks", title: `⚠️ ${err.message}` }],
    });
  }
}
app.get("/stream/:type/:id.json", handleStream);
app.get("/:config/stream/:type/:id.json", handleStream);

// ---- App JSON API (for the native app) --------------------------------------
// Simple, app-friendly endpoints backed by the same search + TorBox logic.

// GET /:config/app/search?q=...&page=1&type=audiobook|comic
app.get("/:config/app/search", async (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  const query = String(req.query.q || "").trim();
  if (!query) return res.json({ results: [] });
  const page = parseInt(req.query.page, 10) || 1;
  const type = typeOf(req.query.type);

  const items = await runSearch(cfg, query, page, type);
  const expandedItems = expandSeriesPacks(items, query);
  const seenBooks = new Set();
  const deduped = [];
  for (const r of expandedItems) {
    if (!r.seriesInfo) r.seriesInfo = parseSeriesAndBook(r.name, r.author, query);
    const key = getBookKey(r.name, r.author, query);
    if (!seenBooks.has(key)) {
      seenBooks.add(key);
      deduped.push(r);
    }
  }

  let seriesAppResult = null;
  let isQueryingSeries = false;

  if (type === "audiobook") {
    try {
      const seriesCandidate = await withTimeout(fetchSeriesBooks(cleanSeriesQuery(query)), 2500, null);
      if (seriesCandidate && Array.isArray(seriesCandidate.books) && seriesCandidate.books.length >= 2) {
        const cleanQ = cleanSeriesQuery(query).toLowerCase();
        const snLower = seriesCandidate.seriesName.toLowerCase();
        isQueryingSeries =
          cleanQ === snLower ||
          snLower.includes(cleanQ) ||
          cleanQ.includes(snLower) ||
          /\b(?:series|saga|trilogy|collection|chronicles|sequence)\b/i.test(query);

        if (isQueryingSeries) {
          const sAuthor = seriesCandidate.author || "";
          const sPoster =
            seriesCandidate.collectionPoster ||
            (seriesCandidate.books[0] && seriesCandidate.books[0].poster) ||
            null;
          seriesAppResult = {
            id: encodeItemId({
              type: "series",
              isSeries: true,
              seriesName: seriesCandidate.seriesName,
              name: `${seriesCandidate.seriesName} (Series)`,
              author: sAuthor,
            }),
            type: "series",
            title: `${seriesCandidate.seriesName} Series${sAuthor ? ` — ${sAuthor}` : ""}`,
            author: sAuthor || null,
            poster: sPoster,
            format: "Series",
            bitrate: null,
            size: 0,
            sizeText: `Full Series (${seriesCandidate.books.length} Books)`,
            cached: true,
            isSeries: true,
          };
        }
      }
    } catch (_) {}
  }

  const ordered = sortInSeriesOrder(deduped, { prioritizeSeries: isQueryingSeries });

  const appResults = ordered.map((r) => {
    const isCol = !!(r.seriesInfo && r.seriesInfo.isCollection);
    return {
      id: encodeItemId({
        ...r,
        isSeries: isCol,
        type: isCol ? "series" : type,
        seriesName: (r.seriesInfo && r.seriesInfo.seriesName) || undefined,
      }),
      type: isCol ? "series" : type,
      title: prettyName(r.name),
      author: r.author || null,
      poster: r.poster || null,
      format: r.format || null,
      bitrate: r.bitrate || null,
      size: r.size || 0,
      sizeText: torbox.formatBytes(r.size) || null,
      cached: !!r.cached,
      isSeries: isCol,
    };
  });

  if (seriesAppResult && page === 1) {
    appResults.unshift(seriesAppResult);
  }

  res.json({ results: appResults });
});

// GET /:config/app/streams/:id  -> playable files for a book
app.get("/:config/app/streams/:id", async (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  const item = decodeItemId(req.params.id);
  if (!item) return res.status(400).json({ ready: false, streams: [], status: "Bad item id" });

  try {
    const result = await resolveForItem(cfg, item);
    let streams = result.streams || [];
    if (item.targetFile && streams.length > 1) {
      const tf = item.targetFile.toLowerCase();
      const getFn = (s) =>
        ((s.behaviorHints && s.behaviorHints.filename) || s.title || "")
          .split("\n")[0]
          .trim()
          .toLowerCase();
      const exact = streams.filter((s) => getFn(s) === tf);
      if (exact.length > 0) {
        streams = exact;
      } else {
        const matched = streams.filter((s) => getFn(s).includes(tf));
        if (matched.length > 0) streams = matched;
      }
    }
    return res.json({
      ready: !!result.ready,
      status: result.status || (result.ready ? "ok" : "preparing"),
      title: prettyName(item.name),
      type: typeOf(item.type),
      format: item.format || null,
      bitrate: item.bitrate || null,
      streams: streams.map((s) => ({
        title: (s.behaviorHints && s.behaviorHints.filename) || s.title || item.name,
        url: s.url,
        filename: (s.behaviorHints && s.behaviorHints.filename) || null,
      })),
    });
  } catch (err) {
    console.error("app streams error:", err.message);
    return res.status(502).json({ ready: false, streams: [], status: err.message });
  }
});

// GET /:config/app/version  -> latest native APK info (for in-app update prompt)
app.get("/:config/app/version", (req, res) => {
  const cfg = getConfig(req, res);
  if (!cfg) return;
  res.json({
    latestVersion: process.env.APP_LATEST_VERSION || null,
    apkUrl: process.env.APP_APK_URL || null,
    minVersion: process.env.APP_MIN_VERSION || null,
  });
});

async function handleHealth(req, res) {
  const cfg = decodeConfig(req.params.config || "");
  const out = {
    ok: true,
    addon: manifest.name,
    version: manifest.version,
  };
  if (cfg && cfg.apiKey) {
    out.torboxKeyValid = await withTimeout(torbox.validateKey(cfg.apiKey), 5000, false);
    const hasJackett = !!(
      (cfg.jackettUrl || process.env.JACKETT_URL) &&
      (cfg.jackettApiKey || process.env.JACKETT_API_KEY)
    );
    out.sources = {
      audiobookbay: !!(cfg.abbDomain || process.env.ABB_DOMAIN),
      jackett: hasJackett,
      // Comics search rides on Jackett (Torznab category 7030), so its
      // availability IS Jackett's availability.
      comics: hasJackett,
      serverProvided: !!(process.env.JACKETT_URL && process.env.JACKETT_API_KEY) || !!process.env.ABB_DOMAIN,
    };
    out.abbDomain = cfg.abbDomain || process.env.ABB_DOMAIN || null;
    out.instantOnly = isInstantOnly(cfg);
    out.accessGate = access.required;
  } else {
    out.note = "No config in URL — append /<config>/health for a full check.";
  }
  res.json(out);
}
app.get("/health", handleHealth);
app.get("/:config/health", handleHealth);

// A Stremio addon that dies on one bad request is worse than one that returns
// an empty catalogue: Stremio gives up on the whole addon. Async route handlers
// are not wrapped by Express 4, so a throw inside one becomes an unhandled
// rejection and takes the process with it. Catch it here, answer with a valid
// but empty response, and log loudly.
app.use((err, req, res, next) => {
  console.error(`[500] ${req.method} ${req.path}:`, err && err.message);
  if (res.headersSent) return next(err);
  // Stremio understands these shapes: {metas} for a catalog, {meta} for a meta.
  if (req.path.startsWith("/catalog")) return res.json({ metas: [] });
  if (req.path.startsWith("/meta")) return res.json({ meta: null });
  if (req.path.startsWith("/stream")) return res.json({ streams: [] });
  res.status(500).json({ err: "Internal error" });
});

app.listen(PORT, () => {
  console.log(`BusTAudioBooks addon running on http://127.0.0.1:${PORT}`);
  console.log(`Open http://127.0.0.1:${PORT}/configure to generate your install link.`);
  startCatalogRefresher();
});

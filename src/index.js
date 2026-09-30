// src/index.js
const dns = require("dns");
try {
  dns.setDefaultResultOrder("ipv4first");
} catch (_) {}

const express = require("express");
const crypto = require("crypto");
const { manifest } = require("./manifest");
const genres = require("./genres");
const { resolveGenre } = genres;
const { decodeConfig } = require("./config");
const { searchAudiobooks, searchComics, qualityScore, comicQualityScore } = require("./sources");
const { enrich } = require("./metadata");
const { encodeItemId, decodeItemId } = require("./itemid");
const { TTLCache, pLimit, withTimeout } = require("./cache");
const { makeAccess } = require("./access");
const { getBookKey, sortInSeriesOrder, parseSeriesAndBook, cleanDisplayTitle, expandSeriesPacks } = require("./series");
const torbox = require("./torbox");

const app = express();
const PORT = process.env.PORT || 7000;
const access = makeAccess(); // shared-token gate (off unless ACCESS_TOKENS set)

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
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
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
// When the server already provides search (env vars), hide the source fields
// so users only need their TorBox key.
if (window.__serverSearch) {
  document.getElementById('sourceCfg').style.display='none';
  document.getElementById('serverNote').style.display='block';
}
if (window.__requireToken) {
  document.getElementById('tokenCfg').style.display='block';
}
</script>
</body></html>`;

function sendConfigure(_req, res) {
  const serverSearch =
    (!!process.env.JACKETT_URL && !!process.env.JACKETT_API_KEY) || !!process.env.ABB_DOMAIN;
  const flag =
    `<script>window.__serverSearch=${serverSearch ? "true" : "false"};` +
    `window.__requireToken=${access.required ? "true" : "false"};</script>`;
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
  if (cfg && cfg.apiKey) {
    return res.json({ ...manifest, behaviorHints: { ...manifest.behaviorHints, configurationRequired: false } });
  }
  // If not configured yet, still serve manifest so Nuvio/Stremio can read metadata & configuration link
  return res.json(manifest);
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
  const genre = String(req.query.genre || extra.genre || "").trim();
  const PAGE_SIZE = 12;
  const skip = parseInt(req.query.skip || extra.skip, 10) || 0;

  let items = [];
  let searchQuery = query;
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
  } else {
    // Every other category is one plain search. The genre table lives in
    // src/genres.js; an unknown name falls back to the default browse
    // category, which matches the old behaviour.
    searchQuery = g.query || "";
    try {
      items = await runSearch(cfg, searchQuery, 1);
    } catch (_) {}
  }

  const FEATURED_AUDIOBOOKS = [
    {
      name: "Foundation (Book 1) - Isaac Asimov",
      infohash: "ecef732d642e3c980dffbb8b335dc5f22cdfc4b0",
      magnet: "magnet:?xt=urn:btih:ecef732d642e3c980dffbb8b335dc5f22cdfc4b0&dn=Foundation+Series+1-7+-+Isaac+Asimov",
      format: "M4B",
      bitrate: "128 kbps",
      author: "Isaac Asimov",
      poster: "https://images.audiobookcovers.com/jpeg/640/1b11cb3d-4316-4a8f-9cf1-e3e5b3080f6a.jpg",
    },
    {
      name: "Dark Disciple, Star Wars by Christie Golden",
      infohash: "e8b9151ca7468ba934fc1cd83ea2837ce84ecb1a",
      magnet: "magnet:?xt=urn:btih:e8b9151ca7468ba934fc1cd83ea2837ce84ecb1a&dn=Dark+Disciple%2C+Star+Wars+by+Christie+Golden+M4B",
      format: "M4B",
      bitrate: "64 kbps",
      author: "Christie Golden",
      poster: "https://images.audiobookcovers.com/jpeg/640/550f5638-b509-4bc1-bf09-600c9f912e9d.jpg",
    },
    {
      name: "Dune - Frank Herbert",
      infohash: "061850ead3eb6f1c5c6d8420211b4bbf2d4ee3e2",
      magnet: "magnet:?xt=urn:btih:061850ead3eb6f1c5c6d8420211b4bbf2d4ee3e2&dn=Dune+-+Frank+Herbert",
      format: "M4B",
      bitrate: "64 kbps",
      author: "Frank Herbert",
      poster: "https://is1-ssl.mzstatic.com/image/thumb/Music122/v4/6a/c7/3a/6ac73abf-9b1c-0869-b9f0-3cc93de3f805/9781427201447.jpg/600x600bb.jpg",
    },
    {
      name: "Project Hail Mary - Andy Weir",
      infohash: "4a2b978d30e3860bb4d9fe67fc00632b512bb64d",
      magnet: "magnet:?xt=urn:btih:4a2b978d30e3860bb4d9fe67fc00632b512bb64d&dn=Project+Hail+Mary+-+Andy+Weir",
      format: "M4B",
      bitrate: "64 kbps",
      author: "Andy Weir",
      poster: "https://images.audiobookcovers.com/jpeg/640/36ba5fc6-81da-45e3-855f-8cbbdf995ad4.jpg",
    },
    {
      name: "The Fellowship of the Ring - J.R.R. Tolkien",
      infohash: "b0b2e352467d302c918c5e9dbd74ecae790f9cb2",
      magnet: "magnet:?xt=urn:btih:b0b2e352467d302c918c5e9dbd74ecae790f9cb2&dn=The+Fellowship+of+the+Ring",
      format: "M4B",
      bitrate: "64 kbps",
      author: "J.R.R. Tolkien",
      poster: "https://images.audiobookcovers.com/jpeg/640/599e557b-7b3b-48ae-94d7-ea762ff0ce3b.jpg",
    },
    {
      name: "Harry Potter and the Sorcerer's Stone - J.K. Rowling",
      infohash: "099a9b6c075191bf1cf89736c53e0eb6a7c47402",
      magnet: "magnet:?xt=urn:btih:099a9b6c075191bf1cf89736c53e0eb6a7c47402&dn=Harry+Potter+Book+1",
      format: "M4B",
      bitrate: "64 kbps",
      author: "J.K. Rowling",
      poster: "https://images.audiobookcovers.com/jpeg/640/d6ba5ea1-e5d4-48ee-8815-4fa7fcb4a8e2.jpg",
    },
    {
      name: "The Way of Kings - Brandon Sanderson",
      infohash: "e6f488ee273397ea9fae5e6e33db0e073c6a461b",
      magnet: "magnet:?xt=urn:btih:e6f488ee273397ea9fae5e6e33db0e073c6a461b&dn=The+Way+of+Kings",
      format: "M4B",
      bitrate: "64 kbps",
      author: "Brandon Sanderson",
      poster: "https://images.audiobookcovers.com/jpeg/640/d5f483c6-946e-44fa-a58d-fa66e2c07342.jpg",
    },
    {
      name: "A Game of Thrones - George R.R. Martin",
      infohash: "d425a8370125a1e7b2501a35561a1532454a329e",
      magnet: "magnet:?xt=urn:btih:d425a8370125a1e7b2501a35561a1532454a329e&dn=A+Game+of+Thrones",
      format: "M4B",
      bitrate: "64 kbps",
      author: "George R.R. Martin",
      poster: "https://images.audiobookcovers.com/jpeg/640/e6d506d1-496c-48c0-8339-ff748950d877.jpg",
    },
    {
      name: "Red Rising - Pierce Brown",
      infohash: "d8ef3f4c6e94a81b373fa839ee8a6c8e76cba945",
      magnet: "magnet:?xt=urn:btih:d8ef3f4c6e94a81b373fa839ee8a6c8e76cba945&dn=Red+Rising",
      format: "M4B",
      bitrate: "64 kbps",
      author: "Pierce Brown",
      poster: "https://images.audiobookcovers.com/jpeg/640/c87fe6f6-4999-4d64-a745-f09c855a90ad.jpg",
    },
    {
      name: "The Hitchhiker's Guide to the Galaxy - Douglas Adams",
      infohash: "74ec39ba5b1d9fa496a75f10b2d6a504ef3a7268",
      magnet: "magnet:?xt=urn:btih:74ec39ba5b1d9fa496a75f10b2d6a504ef3a7268&dn=Hitchhikers+Guide",
      format: "MP3",
      bitrate: "128 kbps",
      author: "Douglas Adams",
      poster: "https://images.audiobookcovers.com/jpeg/640/cf5668ef-c44d-44a7-b12e-1c4b7593c126.jpg",
    },
    {
      name: "1984 - George Orwell",
      infohash: "c25345a90e38101a1d94bf820658faee2e9573ad",
      magnet: "magnet:?xt=urn:btih:c25345a90e38101a1d94bf820658faee2e9573ad&dn=1984+-+George+Orwell",
      format: "MP3",
      bitrate: "128 kbps",
      author: "George Orwell",
      poster: "https://images.audiobookcovers.com/jpeg/640/bc5d9f0a-7b3b-4659-b1d7-21b8b809d3b4.jpg",
    },
    {
      name: "The Last Wish - Andrzej Sapkowski",
      infohash: "f46049ee17fa5b5f36e84db65a25ae45f92c10b7",
      magnet: "magnet:?xt=urn:btih:f46049ee17fa5b5f36e84db65a25ae45f92c10b7&dn=The+Last+Wish",
      format: "M4B",
      bitrate: "64 kbps",
      author: "Andrzej Sapkowski",
      poster: "https://images.audiobookcovers.com/jpeg/640/db16503c-8b77-4df6-a67b-1cb8ff8f79f8.jpg",
    },
  ];

  // When browsing catalog or when live search returns 0 results, fallback to featured items
  let finalItems = items;
  if (!finalItems || finalItems.length === 0) {
    if (query) {
      const q = query.toLowerCase();
      finalItems = FEATURED_AUDIOBOOKS.filter(
        (b) =>
          b.name.toLowerCase().includes(q) || (b.author && b.author.toLowerCase().includes(q))
      );
    } else {
      finalItems = FEATURED_AUDIOBOOKS;
    }
  }

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

  // Sort books: series order if searching a series; otherwise preserve cached/quality ranking
  const ordered = searchQuery ? sortInSeriesOrder(deduped) : deduped;

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

  const metas = paged.map((r) => ({
    id: encodeItemId(r),
    type: req.params.type || "audiobook",
    name: prettyName(r.name),
    poster: r.poster || undefined,
    posterShape: "square",
    description:
      detailLine([
        r.cached ? "⚡ Instant" : null,
        r.format,
        r.bitrate,
        torbox.formatBytes(r.size),
        r.author,
      ]) || r.tracker,
  }));
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

  const [meta, isCached] = await Promise.all([
    withTimeout(enrich(item.name), 3500, { poster: null, author: null, description: null, year: null }),
    item.infohash
      ? withTimeout(torbox.checkCached(cfg.apiKey, item.infohash), 4000, false)
      : Promise.resolve(false),
  ]);

  // Runtime: prefer the real figure from the metadata provider over any
  // "[128 kbps]" tag scraped out of the release filename.
  const runtime = formatRuntime(meta.duration);

  const facts = detailLine([
    item.infohash
      ? (isCached ? "⚡ Instant on TorBox" : "Will download to TorBox on play")
      : "Adds to TorBox on play",
    item.format,
    item.bitrate,
    runtime,
    torbox.formatBytes(item.size),
  ]);

  const descParts = [];
  if (meta.author) descParts.push(`By ${meta.author}`);
  if (meta.narrator) descParts.push(`Narrated by ${meta.narrator}`);
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
  if (Array.isArray(meta.genres)) genres.push(...meta.genres);

  res.json({
    meta: {
      id: req.params.id,
      type: req.params.type || "audiobook",
      name: prettyName(item.name) || "Audiobook",
      poster: meta.poster || undefined,
      background: meta.poster || undefined,
      posterShape: "square",
      description,
      releaseInfo: meta.year || undefined,
      genres,
      // Stremio has no narrator field; `director` is the closest slot, and it
      // is what most audio addons abuse for this. `cast` keeps the author.
      director: meta.narrator ? [meta.narrator] : undefined,
      cast: meta.author ? [meta.author] : undefined,
    },
  });
}
app.get("/meta/:type/:id.json", handleMeta);
app.get("/:config/meta/:type/:id.json", handleMeta);

// ---- Shared stream resolution (Stremio + app) -------------------------------
// Returns { ready, status, streams } where streams are raw {title,url,filename,
// behaviorHints}. Cached per (apiKey, item) so re-opens don't re-hit TorBox.
async function resolveForItem(cfg, item) {
  const type = typeOf(item.type);
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
  const ordered = sortInSeriesOrder(deduped);

  res.json({
    results: ordered.map((r) => ({
      id: encodeItemId(r),
      type,
      title: prettyName(r.name),
      author: r.author || null,
      poster: r.poster || null,
      format: r.format || null,
      bitrate: r.bitrate || null,
      size: r.size || 0,
      sizeText: torbox.formatBytes(r.size) || null,
      cached: !!r.cached,
    })),
  });
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

app.listen(PORT, () => {
  console.log(`BusTAudioBooks addon running on http://127.0.0.1:${PORT}`);
  console.log(`Open http://127.0.0.1:${PORT}/configure to generate your install link.`);
});

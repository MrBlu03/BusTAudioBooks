// src/nuvio.js
// Nuvio Cloud API client (https://api.nuvio.tv) — used to read the user's
// watch progress and library so the addon can build personal recommendations.
//
// AUTH
// The publishable key is public by design and published in Nuvio's own docs.
// The access token is exchanged via Supabase from the user's email + password,
// returning an access token (1 h) and a refresh token.
// Credentials can be supplied per-user via the configuration payload, or
// fall back to environment variables for local testing.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const { TTLCache, pLimit } = require("./cache");

const REST = (process.env.NUVIO_REST_URL || "https://api.nuvio.tv/rest/v1").replace(/\/+$/, "");
const AUTH = (process.env.NUVIO_AUTH_URL || "https://api.nuvio.tv/auth/v1").replace(/\/+$/, "");

// Published in Nuvio's documentation for public clients. Override only if they
// rotate it.
const PUBLISHABLE_KEY =
  process.env.NUVIO_PUBLISHABLE_KEY || "sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN";

const ENABLED = process.env.NUVIO_ENABLED !== "0";
const TOKEN_FILE =
  process.env.NUVIO_TOKEN_FILE || path.join(__dirname, "..", ".nuvio-auth.json");

// Refresh a little before the token actually expires.
const TOKEN_SKEW_MS = 5 * 60 * 1000;
const TIMEOUT_MS = parseInt(process.env.NUVIO_TIMEOUT_MS || "15000", 10);

const rateLimit = pLimit(3);
const authCache = new TTLCache(60 * 1000, 20); // dedupes concurrent sign-ins
const userTokens = new Map(); // in-memory session tokens isolated per email

// -- credentials --------------------------------------------------------------

/**
 * Read Nuvio credentials from the passed config or environment.
 * Returns null when either half is missing, so callers can degrade quietly.
 */
function getCredentials(cfg = null) {
  if (cfg && typeof cfg === "object") {
    const email = String(
      cfg.nuvioEmail || (cfg.nuvio && cfg.nuvio.email) || cfg.email || ""
    ).trim();
    const password =
      cfg.nuvioPassword || (cfg.nuvio && cfg.nuvio.password) || cfg.password || "";
    if (email && password) return { email, password };
  }
  const email = String(process.env.NUVIO_EMAIL || "").trim();
  const password = process.env.NUVIO_PASSWORD || "";
  if (!email || !password) return null;
  return { email, password };
}

function isConfigured(cfg = null) {
  return Boolean(getCredentials(cfg));
}

// -- token storage ------------------------------------------------------------

function readTokenFile() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.refresh_token === "string") return parsed;
  } catch (_) {
    /* absent or corrupt: just sign in again */
  }
  return null;
}

function writeTokenFile(data) {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn("nuvio: could not persist token:", err.message);
  }
}

// -- HTTP ---------------------------------------------------------------------

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey: PUBLISHABLE_KEY,
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(`Nuvio ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// -- auth ---------------------------------------------------------------------

function tokenExpiry(token) {
  const exp = token && token.expires_at;
  if (typeof exp === "number") return exp * 1000; // Supabase sends epoch seconds
  if (typeof exp === "string") {
    const t = Date.parse(exp);
    if (!Number.isNaN(t)) return t;
  }
  const inSec = token && token.expires_in;
  if (typeof inSec === "number") return Date.now() + inSec * 1000;
  return 0;
}

async function requestToken(grant, emailKey = "default") {
  const data = await post(
    `${AUTH}/token?grant_type=${grant.type}`,
    grant.body,
    grant.headers
  );
  if (!data || !data.access_token) throw new Error("Nuvio auth returned no access_token");
  const state = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };
  userTokens.set(emailKey, state);
  if (emailKey === "default" && process.env.NUVIO_EMAIL) {
    writeTokenFile(state);
  }
  return state;
}

/** Exchange the stored refresh token for a new access token. */
function refreshAccessToken(tokenState, emailKey = "default") {
  if (!tokenState || !tokenState.refresh_token) {
    return Promise.reject(new Error("no refresh token available"));
  }
  return requestToken(
    {
      type: "refresh_token",
      headers: {},
      body: { refresh_token: tokenState.refresh_token },
    },
    emailKey
  );
}

/** Sign in with email + password. Cached briefly so bursts share one call. */
function signIn(explicitCreds = null) {
  const creds = getCredentials(explicitCreds);
  if (!creds) {
    return Promise.reject(new Error("NUVIO_EMAIL / NUVIO_PASSWORD are not set"));
  }

  const emailKey = creds.email.toLowerCase();
  const cached = authCache.get(`signin:${emailKey}`);
  if (cached) return Promise.resolve(cached);

  const p = rateLimit(() =>
    requestToken(
      {
        type: "password",
        headers: {},
        body: { email: creds.email, password: creds.password },
      },
      emailKey
    )
  )()
    .then((tok) => {
      authCache.set(`signin:${emailKey}`, tok, 60 * 1000);
      return tok;
    })
    .catch((err) => {
      authCache.delete?.(`signin:${emailKey}`);
      throw err;
    });

  return p;
}

/** A valid access token, renewing via refresh_token when it is close to expiry. */
async function getAccessToken(explicitCreds = null) {
  const creds = getCredentials(explicitCreds);
  if (!creds) {
    throw new Error("NUVIO_EMAIL / NUVIO_PASSWORD are not set");
  }

  const emailKey = creds.email.toLowerCase();
  let tokenState = userTokens.get(emailKey);
  if (!tokenState && emailKey === String(process.env.NUVIO_EMAIL || "").toLowerCase()) {
    tokenState = readTokenFile();
    if (tokenState) userTokens.set(emailKey, tokenState);
  }

  if (
    tokenState &&
    tokenState.access_token &&
    tokenExpiry(tokenState) - TOKEN_SKEW_MS > Date.now()
  ) {
    return tokenState.access_token;
  }
  if (tokenState && tokenState.refresh_token) {
    try {
      const tok = await refreshAccessToken(tokenState, emailKey);
      return tok.access_token;
    } catch (err) {
      console.warn("nuvio: refresh failed, re-authenticating:", err.message);
    }
  }
  const tok = await signIn(creds);
  return tok.access_token;
}

// -- RPC ----------------------------------------------------------------------

/** POST an RPC function, retrying once on a 401 by re-authenticating. */
async function rpc(fn, body = {}, explicitCreds = null) {
  if (!ENABLED) throw new Error("Nuvio integration is disabled");
  const token = await getAccessToken(explicitCreds);
  try {
    return await rateLimit(() =>
      post(`${REST}/rpc/${fn}`, body, { Authorization: `Bearer ${token}` })
    )();
  } catch (err) {
    if (err.status === 401) {
      const fresh = await signIn(explicitCreds);
      return post(`${REST}/rpc/${fn}`, body, {
        Authorization: `Bearer ${fresh.access_token}`,
      });
    }
    throw err;
  }
}

/**
 * List the account's profiles (1..6 per user).
 * @returns {Promise<Array<{id:string, profile_index:number, name:string}>>}
 */
async function listProfiles(explicitCreds = null) {
  const rows = await rpc("sync_pull_profiles", {}, explicitCreds);
  return Array.isArray(rows) ? rows : [];
}

function parseProfileIndex(value) {
  const n = typeof value === "number" ? value : parseInt(String(value).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 6) return null;
  return n;
}

/**
 * Pull library changes after a cursor, following pagination to the end.
 * @returns {Promise<{events: object[], lastEventId: number}>}
 */
async function pullLibraryDelta(profileIndex, sinceEventId = 0, limit = 1000, explicitCreds = null) {
  const events = [];
  let cursor = Number(sinceEventId) || 0;
  for (;;) {
    const page = await rpc(
      "sync_pull_library_delta",
      {
        p_profile_id: profileIndex,
        p_since_event_id: cursor,
        p_limit: limit,
      },
      explicitCreds
    );
    const batch = Array.isArray(page) ? page : [];
    if (!batch.length) break;
    events.push(...batch);
    const last = batch[batch.length - 1].event_id;
    cursor = Number.isFinite(last) ? last : cursor;
    if (batch.length < limit) break;
  }
  return { events, lastEventId: cursor };
}

/** Full library snapshot (the bootstrap path, used on first run). */
async function pullLibrary(profileIndex, explicitCreds = null) {
  const rows = await rpc("sync_pull_library", { p_profile_id: profileIndex }, explicitCreds);
  return Array.isArray(rows) ? rows : [];
}

async function libraryDeltaCursor(profileIndex, explicitCreds = null) {
  const n = await rpc("sync_get_library_delta_cursor", { p_profile_id: profileIndex }, explicitCreds);
  const v = parseInt(n, 10);
  return Number.isFinite(v) ? v : 0;
}

// -- watch history & progress -------------------------------------------------

/**
 * Decode a tbab: content_id payload into its JSON metadata.
 */
function decodeTbabId(contentId) {
  if (!contentId || typeof contentId !== "string" || !contentId.startsWith("tbab:")) return null;
  try {
    const raw = Buffer.from(contentId.slice(5), "base64url").toString("utf8");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * Pull active watch progress and completed watched items for a profile.
 * Decodes tbab release payloads to identify the audiobooks actually listened to.
 *
 * @returns {Promise<Array<{contentId: string, name: string, contentType: string, position: number, duration: number, progressPercent: number, lastWatched: number, decoded: object|null}>>}
 */
async function pullWatchProgress(profileIndex, explicitCreds = null) {
  const items = [];
  try {
    const rows = await rpc(
      "sync_pull_watch_progress",
      {
        p_profile_id: profileIndex,
        p_since_last_watched: 0,
        p_limit: 100,
      },
      explicitCreds
    );
    if (Array.isArray(rows)) {
      items.push(...rows);
    }
  } catch (err) {
    console.warn("nuvio: error pulling watch progress:", err.message);
  }

  try {
    const watched = await rpc(
      "sync_pull_watched_items",
      {
        p_profile_id: profileIndex,
        p_page: 1,
        p_page_size: 100,
      },
      explicitCreds
    );
    if (Array.isArray(watched)) {
      for (const w of watched) {
        if (!items.some((it) => it.content_id === w.content_id)) {
          items.push({
            content_id: w.content_id,
            content_type: w.content_type || "audiobook",
            position: 1,
            duration: 1, // 100% completed
            last_watched: w.watched_at ? Date.parse(w.watched_at) : Date.now(),
          });
        }
      }
    }
  } catch (err) {
    console.warn("nuvio: error pulling watched items:", err.message);
  }

  const out = [];
  for (const row of items) {
    const contentId = row.content_id || row.id || "";
    const decoded = decodeTbabId(contentId);
    const rawName = decoded?.n || row.title || row.name || "";
    const position = Number(row.position) || 0;
    const duration = Number(row.duration) || 0;
    const progressPercent =
      duration > 0 ? Math.min(100, Math.round((position / duration) * 100)) : 0;
    const lastWatched =
      Number(row.last_watched) || (row.watched_at ? Date.parse(row.watched_at) : 0);

    out.push({
      contentId,
      name: rawName,
      contentType: row.content_type || "audiobook",
      position,
      duration,
      progressPercent,
      lastWatched,
      decoded,
    });
  }

  // Sort by most recently consumed first
  out.sort((a, b) => b.lastWatched - a.lastWatched);
  return out;
}

/**
 * Pull both watch progress (actively consumed) and library (saved).
 */
async function pullUserHistoryAndLibrary(profileIndex, explicitCreds = null) {
  const [watchItems, { events }] = await Promise.all([
    pullWatchProgress(profileIndex, explicitCreds),
    pullLibraryDelta(profileIndex, 0, 1000, explicitCreds),
  ]);

  const libraryState = new Map();
  for (const ev of events) {
    const key = ev.content_id || ev.id;
    if (!key) continue;
    if (ev.operation === "delete") libraryState.delete(key);
    else libraryState.set(key, ev);
  }

  const libraryItems = [...libraryState.values()].map(normaliseItem).filter(Boolean);

  return {
    watchItems,
    libraryItems,
    fingerprint: hashActivityFingerprint([...libraryState.keys()], watchItems),
  };
}

// -- normalisation ------------------------------------------------------------

/**
 * Reduce a library/history record to the few fields the recommender needs.
 * Defensive on purpose: field names come from Nuvio and may gain/rename keys.
 */
function normaliseItem(row) {
  if (!row || typeof row !== "object") return null;
  const contentId = row.content_id || row.id || null;
  const name = row.name || row.title || null;
  if (!contentId && !name) return null;
  return {
    contentId: contentId ? String(contentId) : null,
    contentType: row.content_type || null,
    name: name ? String(name) : null,
    year: row.release_info || null,
    genres: Array.isArray(row.genres) ? row.genres.filter((g) => typeof g === "string") : [],
    // Watch fields, present on history/progress rows only.
    watched: row.watched === undefined ? null : row.watched,
    watchedAt: row.watched_at || row.updated_at || null,
  };
}

/**
 * Group a set of Nuvio records by content_type and drop empty groups.
 */
function summariseByType(items) {
  const groups = new Map();
  for (const it of items) {
    const key = it.contentType || "(none)";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.entries()]
    .map(([contentType, rows]) => ({
      contentType,
      count: rows.length,
      sampleNames: rows.map((r) => r.name).filter(Boolean).slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Stable fingerprint of a set of content ids.
 */
function hashContentIds(ids) {
  const sorted = [...new Set(ids.filter(Boolean).map(String))].sort();
  return crypto.createHash("sha256").update(sorted.join("\n")).digest("hex");
}

/**
 * Combined activity fingerprint: detects additions/deletions in library
 * OR new listening progress / history.
 */
function hashActivityFingerprint(libraryIds, watchItems = []) {
  const libPart = [...new Set(libraryIds.filter(Boolean).map(String))].sort().join("\n");
  const watchPart = watchItems
    .filter((w) => w && w.contentId)
    .map((w) => `${w.contentId}:${w.progressPercent}:${w.lastWatched}`)
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(`${libPart}\n---\n${watchPart}`).digest("hex");
}

module.exports = {
  ENABLED,
  PUBLISHABLE_KEY,
  REST,
  getCredentials,
  isConfigured,
  signIn,
  getAccessToken,
  listProfiles,
  parseProfileIndex,
  pullLibrary,
  pullLibraryDelta,
  libraryDeltaCursor,
  pullWatchProgress,
  pullUserHistoryAndLibrary,
  decodeTbabId,
  hashActivityFingerprint,
  normaliseItem,
  summariseByType,
  hashContentIds,
  // exported for testing
  _normaliseItem: normaliseItem,
  _hashContentIds: hashContentIds,
  _tokenExpiry: tokenExpiry,
};

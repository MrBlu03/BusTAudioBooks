// src/nuvio.js
// Nuvio Cloud API client (https://api.nuvio.tv) — used to read the user's own
// library so the addon can build personal recommendations.
//
// WHY THE LIBRARY, NOT WATCH HISTORY
// The public API documents watch-history `content_type` as "movie or series"
// only. Audiobooks are not a first-class content type there. The library is
// generic, so audiobooks in the audiobook profile are expected to appear as
// library items (typically with a custom content_type and an ISBN/ASIN-shaped
// content_id). Nothing here assumes that: pullLibrary() reports whatever is
// actually stored, grouped by content_type, so the shape can be inspected
// before any recommendations are generated.
//
// AUTH
// The publishable key is public by design and published in Nuvio's own docs.
// The access token is not: we sign in with the account's email and password,
// which Supabase exchanges for an access token (1 h) plus a refresh token.
// Refresh tokens rotate, so they are cached on disk and renewed as needed.
// The password is only ever read from the environment.
//
// Disable entirely with NUVIO_ENABLED=0.

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
const authCache = new TTLCache(60 * 1000, 10); // dedupes concurrent sign-ins

// -- credentials --------------------------------------------------------------

/**
 * Read Nuvio credentials from the environment.
 * Returns null when either half is missing, so callers can degrade quietly.
 */
function getCredentials() {
  const email = String(process.env.NUVIO_EMAIL || "").trim();
  const password = process.env.NUVIO_PASSWORD || "";
  if (!email || !password) return null;
  return { email, password };
}

function isConfigured() {
  return Boolean(getCredentials());
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

let tokenState = readTokenFile();

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

async function requestToken(grant) {
  const data = await post(
    `${AUTH}/token?grant_type=${grant.type}`,
    grant.body,
    grant.headers
  );
  if (!data || !data.access_token) throw new Error("Nuvio auth returned no access_token");
  tokenState = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
  };
  writeTokenFile(tokenState);
  return tokenState;
}

/** Exchange the stored refresh token for a new access token. */
function refreshAccessToken() {
  if (!tokenState || !tokenState.refresh_token) {
    return Promise.reject(new Error("no refresh token available"));
  }
  return requestToken({
    type: "refresh_token",
    headers: {},
    body: { refresh_token: tokenState.refresh_token },
  });
}

/** Sign in with email + password. Cached briefly so bursts share one call. */
function signIn() {
  const cached = authCache.get("signin");
  if (cached) return Promise.resolve(cached);

  const creds = getCredentials();
  if (!creds) {
    return Promise.reject(new Error("NUVIO_EMAIL / NUVIO_PASSWORD are not set"));
  }

  const p = rateLimit(() =>
    requestToken({
      type: "password",
      headers: {},
      body: { email: creds.email, password: creds.password },
    })
  )()
    .then((tok) => {
      authCache.set("signin", tok, 60 * 1000);
      return tok;
    })
    .catch((err) => {
      authCache.delete?.("signin");
      throw err;
    });

  return p;
}

/** A valid access token, renewing via refresh_token when it is close to expiry. */
async function getAccessToken() {
  if (tokenState && tokenState.access_token && tokenExpiry(tokenState) - TOKEN_SKEW_MS > Date.now()) {
    return tokenState.access_token;
  }
  if (tokenState && tokenState.refresh_token) {
    try {
      const tok = await refreshAccessToken();
      return tok.access_token;
    } catch (err) {
      // A dead refresh token means the password was changed or revoked.
      // Fall through and re-authenticate from credentials.
      console.warn("nuvio: refresh failed, re-authenticating:", err.message);
    }
  }
  const tok = await signIn();
  return tok.access_token;
}

// -- RPC ----------------------------------------------------------------------

/** POST an RPC function, retrying once on a 401 by re-authenticating. */
async function rpc(fn, body = {}) {
  if (!ENABLED) throw new Error("Nuvio integration is disabled");
  const token = await getAccessToken();
  try {
    return await rateLimit(() => post(`${REST}/rpc/${fn}`, body, { Authorization: `Bearer ${token}` }))();
  } catch (err) {
    if (err.status === 401) {
      const fresh = await signIn();
      return post(`${REST}/rpc/${fn}`, body, { Authorization: `Bearer ${fresh.access_token}` });
    }
    throw err;
  }
}

/**
 * List the account's profiles (1..6 per user).
 * @returns {Promise<Array<{id:string, profile_index:number, name:string}>>}
 */
async function listProfiles() {
  const rows = await rpc("sync_pull_profiles");
  return Array.isArray(rows) ? rows : [];
}

function parseProfileIndex(value) {
  // Reject fractional input explicitly: parseInt would silently turn 1.5
  // into 1, and a profile index that is not exactly 1..6 is a config error.
  const n = typeof value === "number" ? value : parseInt(String(value).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 6) return null;
  return n;
}

/**
 * Pull library changes after a cursor, following pagination to the end.
 * @returns {Promise<{events: object[], lastEventId: number}>}
 */
async function pullLibraryDelta(profileIndex, sinceEventId = 0, limit = 1000) {
  const events = [];
  let cursor = Number(sinceEventId) || 0;
  for (;;) {
    const page = await rpc("sync_pull_library_delta", {
      p_profile_id: profileIndex,
      p_since_event_id: cursor,
      p_limit: limit,
    });
    const batch = Array.isArray(page) ? page : [];
    if (!batch.length) break;
    events.push(...batch);
    // Ordered by event_id ASC, so the last one is the new cursor.
    const last = batch[batch.length - 1].event_id;
    cursor = Number.isFinite(last) ? last : cursor;
    if (batch.length < limit) break;
  }
  return { events, lastEventId: cursor };
}

/** Full library snapshot (the bootstrap path, used on first run). */
async function pullLibrary(profileIndex) {
  const rows = await rpc("sync_pull_library", { p_profile_id: profileIndex });
  return Array.isArray(rows) ? rows : [];
}

async function libraryDeltaCursor(profileIndex) {
  const n = await rpc("sync_get_library_delta_cursor", { p_profile_id: profileIndex });
  const v = parseInt(n, 10);
  return Number.isFinite(v) ? v : 0;
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
 * Exposed so the caller can report what a profile actually contains before
 * spending tokens on generation.
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
 * Used to decide whether anything changed, so recommendations are only
 * regenerated when the library actually moves.
 */
function hashContentIds(ids) {
  const sorted = [...new Set(ids.filter(Boolean).map(String))].sort();
  return crypto.createHash("sha256").update(sorted.join("\n")).digest("hex");
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
  normaliseItem,
  summariseByType,
  hashContentIds,
  // exported for testing
  _normaliseItem: normaliseItem,
  _hashContentIds: hashContentIds,
  _tokenExpiry: tokenExpiry,
};

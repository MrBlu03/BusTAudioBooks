// src/itemid.js
// Encode/decode the compact payload carried in catalog/meta/stream ids, so the
// meta and stream handlers can render + resolve an item without re-scraping.
const { ID_PREFIX } = require("./manifest");

function encodeItemId(item) {
  const payload = Buffer.from(
    JSON.stringify({
      h: item.infohash,
      m: item.magnet || undefined,
      u: item.torrentUrl || undefined,
      n: item.name,
      f: item.format || undefined,
      b: item.bitrate || undefined,
      s: item.size || undefined,
      // Content-type discriminator. Absent = audiobook, so ids minted before
      // comics existed keep decoding exactly as they always did.
      t: item.type === "comic" ? "c" : (item.type === "series" || item.isSeries ? "s" : undefined),
      tf: item.targetFile || undefined,
      sn: item.seriesName || undefined,
      bn: item.bookNumber != null ? item.bookNumber : undefined,
      a: item.author || undefined,
      se: item.season != null ? item.season : undefined,
      is: item.isSeries ? 1 : undefined,
      ph: item.parentInfohash || undefined,
      // "Why we picked this" for the personal-recommendations row. Optional and
      // absent on every other id, so existing ids keep decoding unchanged.
      r: item.reason || undefined,
      rb: item.recommendedBook || undefined,
    }),
    "utf8"
  ).toString("base64url");
  return ID_PREFIX + payload;
}

function decodeItemId(id) {
  if (!id || !id.startsWith(ID_PREFIX)) return null;
  try {
    const obj = JSON.parse(
      Buffer.from(id.slice(ID_PREFIX.length), "base64url").toString("utf8")
    );
    return {
      infohash: obj.h,
      magnet: obj.m,
      torrentUrl: obj.u,
      name: obj.n,
      format: obj.f,
      bitrate: obj.b,
      size: obj.s,
      type: obj.is || obj.t === "s" ? "series" : obj.t === "c" ? "comic" : "audiobook",
      isSeries: !!(obj.is || obj.t === "s"),
      seriesName: obj.sn || null,
      bookNumber: obj.bn != null ? obj.bn : null,
      season: obj.se != null ? obj.se : 1,
      author: obj.a || null,
      parentInfohash: obj.ph || null,
      targetFile: obj.tf || null,
      reason: obj.r || null,
      recommendedBook: obj.rb || null,
    };
  } catch (_) {
    return null;
  }
}

module.exports = { encodeItemId, decodeItemId };

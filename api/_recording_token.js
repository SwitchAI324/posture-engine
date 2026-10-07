// api/_recording_token.js
// ----------------------------------------------------------------------
// HS256 token for the recordings page (2026-10-06, Recording).
// Standard JWT shape so any chat can mint one with the shared secret:
//   header  {"alg":"HS256","typ":"JWT"}
//   payload {"user_id":"<uuid>","exp":<unix seconds>}
// Secret: RECORDING_TOKEN_SECRET (Vercel env only, never in a response/log).
// verify() returns the payload or null — it never says WHY it failed.
// ----------------------------------------------------------------------
const crypto = require("crypto");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const b64u = (buf) => Buffer.from(buf).toString("base64url");

function sign(payload, secret) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(head + "." + body).digest("base64url");
  return head + "." + body + "." + sig;
}

function verify(token, secret, nowSeconds) {
  try {
    if (!token || !secret || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (!header || header.alg !== "HS256") return null; // rejects "none" and others
    const expected = crypto.createHmac("sha256", secret).update(parts[0] + "." + parts[1]).digest();
    const given = Buffer.from(parts[2], "base64url");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const now = nowSeconds != null ? nowSeconds : Math.floor(Date.now() / 1000);
    if (!payload || typeof payload.exp !== "number" || payload.exp <= now) return null;
    if (typeof payload.user_id !== "string" || !UUID_RE.test(payload.user_id)) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { sign, verify, UUID_RE };

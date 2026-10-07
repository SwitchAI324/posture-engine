// api/recordings-token.js
// ----------------------------------------------------------------------
// POST /api/recordings-token   header: x-phone-intake-secret
// body: { "user_id": "<uuid>", "ttl_seconds": 3600 }
// Mints the token /api/recordings expects. SERVER-TO-SERVER ONLY — same
// PHONE_INTAKE_SECRET gate as /api/recording-link; a browser must never hold
// that secret, so Mead Hall's server side (or Email's sender) calls this, or
// mints its own with RECORDING_TOKEN_SECRET using the same HS256 shape.
// Default ttl 1 hour; max 90 days (email links: use the retention window).
// ----------------------------------------------------------------------
const { sign, UUID_RE } = require("./_recording_token.js");

const DEFAULT_TTL = 60 * 60;
const MAX_TTL = 90 * 24 * 60 * 60;

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  return res.end(JSON.stringify(obj));
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let raw = "";
  for await (const chunk of req) raw += chunk;
  try { return raw ? JSON.parse(raw) : {}; } catch { return null; }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return send(res, 405, { error: "POST only" });
  }
  const SECRET = process.env.RECORDING_TOKEN_SECRET;
  const GATE = process.env.PHONE_INTAKE_SECRET;
  if (!SECRET || !GATE) return send(res, 500, { error: "not configured" });
  if (req.headers["x-phone-intake-secret"] !== GATE) {
    return send(res, 401, { error: "unauthorized" });
  }
  const body = await readBody(req);
  if (!body || typeof body.user_id !== "string" || !UUID_RE.test(body.user_id)) {
    return send(res, 400, { error: "user_id (uuid) required" });
  }
  let ttl = Number(body.ttl_seconds);
  if (!Number.isFinite(ttl) || ttl <= 0) ttl = DEFAULT_TTL;
  ttl = Math.min(Math.floor(ttl), MAX_TTL);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  return send(res, 200, { token: sign({ user_id: body.user_id, exp }, SECRET), exp });
};

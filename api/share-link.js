// api/share-link.js
// ----------------------------------------------------------------------
// GET /api/share-link?target_id=<uuid>&token=<director_token>
//
// Browser-safe wrapper for minting a watcher share link, per Mead Hall's
// security blocker (2026-09-05): the Mead Hall's "Share watch link"
// button is a browser page, and /api/mint-token takes mint_secret as a
// param — calling it directly from the browser would leak
// WATCHER_MINT_SECRET to anyone viewing the page, including watchers,
// who could then mint their own tokens. This endpoint is the fix: it
// holds the secret server-side, verifies the caller is a real,
// UNREVOKED director first, and only THEN calls mint-token
// server-to-server.
//
//   1. Verify ?token= is a valid DIRECTOR token AND — for any token
//      minted since the Aug-22 identity/did upgrade — check it hasn't
//      been revoked via director_tokens. Reject watcher/absent/forged/
//      revoked tokens, all -> 403. REVISED (2026-09-05): the first draft
//      of this file only checked signature+role, duplicating
//      call-stream.js's SIMPLER check — missed that control.js's real
//      director gate (requireDirector) also checks director_tokens
//      revocation for any token carrying a `did`. A revoked director's
//      token would have kept minting share links under that first
//      draft. Fixed by porting requireDirector's exact logic, confirmed
//      against the real control.js and the real mint-token.js (which
//      confirmed the {role,sub,did,iat} shape and the legacy
//      {role,iat}-no-did backward-compat case).
//   2. Call /api/mint-token server-to-server (role=watcher, that
//      target_id, created_by=the director's own sub for traceability),
//      attaching WATCHER_MINT_SECRET ourselves — the browser never sees
//      it, never holds it, never sends it. Param names and response
//      shape ({token, jti, target_id, expires_at}) CONFIRMED against
//      the real mint-token.js — no longer a guess.
//   3. Return { url, token, jti } — Mead Hall's button can use either
//      `url` directly or assemble its own from `token`; jti is shown to
//      the director for later revocation via watch_tokens.
// ----------------------------------------------------------------------

export const config = { runtime: "edge" };

const CONTROL_TOKEN_SECRET = process.env.CONTROL_TOKEN_SECRET;
const WATCHER_MINT_SECRET = process.env.WATCHER_MINT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DIRECTOR_TOKENS_TABLE = "director_tokens";
const WATCH_BASE_DEFAULT = "live.spamviking.com";
const MINT_TOKEN_PATH = "/api/mint-token";

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function b64urlEncodeBytes(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecodeToString(str) {
  let s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}
async function hmacSha256B64Url(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64urlEncodeBytes(sig);
}

// Identical to control.js's verifyControlToken — same secret, same
// token shape, confirmed byte-for-byte against the real file (not
// reinvented). Duplicated rather than imported since this codebase's
// convention (per mint-token.js's own comment) is each api/*.js file
// stays self-contained.
async function verifyControlToken(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  let expectedSig;
  try {
    expectedSig = await hmacSha256B64Url(secret, payloadB64);
  } catch {
    return null;
  }
  if (sig.length !== expectedSig.length || sig !== expectedSig) return null;
  let payload;
  try {
    payload = JSON.parse(b64urlDecodeToString(payloadB64));
  } catch {
    return null;
  }
  if (!payload || (payload.role !== "director" && payload.role !== "watcher")) {
    return null;
  }
  return payload;
}

// Ported from control.js's lookupDirectorToken — same table, same
// select, same shape.
async function lookupDirectorToken(did) {
  const url =
    `${SUPABASE_URL}/rest/v1/${DIRECTOR_TOKENS_TABLE}?did=eq.${encodeURIComponent(did)}` +
    `&select=did,sub,revoked`;
  const r = await fetch(url, {
    cache: "no-store",
    headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return (rows && rows[0]) || null;
}

// Ported from control.js's requireDirector — identical logic: a token
// with a `did` (minted since the Aug-22 upgrade) must resolve to a
// non-revoked director_tokens row; a LEGACY token (role=director, iat,
// no did) has nothing to check and is accepted as before, matching
// control.js's own deliberate one-way backward-compat path.
async function requireDirector(u) {
  if (!CONTROL_TOKEN_SECRET) {
    return { ok: false, status: 500, error: "control token secret not configured" };
  }
  const token = u.searchParams.get("token");
  const payload = await verifyControlToken(token, CONTROL_TOKEN_SECRET);
  if (!payload || payload.role !== "director") {
    return { ok: false, status: 403, error: "forbidden — director token required" };
  }
  if (payload.did) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return { ok: false, status: 500, error: "director revocation check misconfigured" };
    }
    const row = await lookupDirectorToken(payload.did).catch(() => null);
    if (!row || row.revoked) {
      return { ok: false, status: 403, error: "director grant not found or revoked" };
    }
  }
  return { ok: true, payload };
}

export default async function handler(req) {
  const u = new URL(req.url);
  if (req.method !== "GET") {
    return jsonRes({ error: "GET only" }, 405);
  }
  if (!CONTROL_TOKEN_SECRET || !WATCHER_MINT_SECRET) {
    return jsonRes({ error: "not configured" }, 500);
  }

  const targetId = u.searchParams.get("target_id");
  if (!targetId) {
    return jsonRes({ error: "target_id required" }, 400);
  }

  const gate = await requireDirector(u);
  if (!gate.ok) {
    return jsonRes({ error: gate.error }, gate.status);
  }
  const directorSub = gate.payload.sub || null;

  // Overridable per Mead Hall's own button config.
  const watchBase = u.searchParams.get("watch_base") || WATCH_BASE_DEFAULT;

  // CONFIRMED against the real mint-token.js: param names (mint_secret,
  // role, target_id, created_by, ttl_hours) and response shape
  // ({token, jti, target_id, expires_at}) both verified, not guessed.
  // ttl_hours deliberately OMITTED (not sent as 0) — per Onboarding's
  // no-expiry decision, mint-token.js only sets an expiry when ttl_hours
  // is present and > 0, so omitting it entirely yields expires_at: null,
  // exactly the "no expiry until revoked" policy.
  let mintResult;
  try {
    const mintUrl = new URL(MINT_TOKEN_PATH, u.origin);
    mintUrl.searchParams.set("mint_secret", WATCHER_MINT_SECRET);
    mintUrl.searchParams.set("role", "watcher");
    mintUrl.searchParams.set("target_id", targetId);
    if (directorSub) mintUrl.searchParams.set("created_by", directorSub);
    const r = await fetch(mintUrl.toString(), { method: "GET" });
    if (!r.ok) {
      return jsonRes({ error: "mint failed", status: r.status }, 502);
    }
    mintResult = await r.json();
  } catch (e) {
    return jsonRes({ error: String(e && e.message ? e.message : e) }, 500);
  }

  const token = mintResult && mintResult.token;
  const jti = mintResult && mintResult.jti;
  if (!token || !jti) {
    return jsonRes({ error: "mint response missing token/jti" }, 502);
  }

  const url = `https://${watchBase}/mead_hall_live.html?token=${encodeURIComponent(token)}`;
  return jsonRes({ url, token, jti });
}


// api/call-stream.js — SSE relay for Mead Hall's Path B live event feed.
// CommonJS + node req/res, matching hydrate.js / livekit-token.js / saytest.js
// (the working style in this api/ folder).
//
// WHY THIS EXISTS: Mead Hall's poll of /api/call-feed (400ms interval, see
// PE's earlier note) can only ever get CLOSE to live. This endpoint pushes
// engagement_events rows to the browser as they're inserted, via Server-Sent
// Events, using a SERVER-SIDE Supabase Realtime subscription (service-role
// key — never shipped to the browser; the table stays deny-by-default RLS,
// only this endpoint's service-role client can subscribe).
//
// USAGE: GET /api/call-stream?target_id=<uuid>   (or ?call_id=<room> when
// pinned to one specific call — call_id takes priority if both are given).
// Response: an SSE stream, one `data: <row JSON>\n\n` frame per INSERT on
// engagement_events, where the row shape matches what /api/call-feed already
// returns (id, seq, call_id, target_id, event_type, actor, layer, payload).
// A comment heartbeat (":\n\n") every 15s keeps the connection/any proxy
// alive. Mead Hall's client handles dedup/reconnect/teardown on its own —
// this endpoint just needs to stay open and relay.
//
// ENV NEEDED (Vercel): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — same two
// vars _store.js already uses, reused here as-is (server-side only).
//
// ★ TWO REAL RISKS, flagged plainly rather than discovered live:
// 1. VERCEL FUNCTION DURATION LIMIT — this endpoint holds the connection
//    open for as long as a call runs (potentially many minutes). Vercel
//    caps how long a function may run (varies by plan); this WILL very
//    likely get killed mid-call once that cap hits — that's the platform,
//    not a bug here. maxDuration below is set to 600s, matching Pro's
//    Fluid Compute ceiling (up to 800s GA) with headroom — CONFIRM Fluid
//    Compute is actually enabled on this project (Vercel dashboard →
//    project → Settings → Functions); without it, Pro's non-fluid default
//    is lower and this value gets silently capped at deploy. SAFE EITHER
//    WAY: Mead Hall's client already falls back to its 400ms poll on any
//    drop (per its own note), so a mid-call kill just means it stops
//    being push for the rest of that call, nothing breaks.
// 2. NEW DEPENDENCY — every other file in this codebase talks to Supabase
//    via plain fetch() to its REST API. Realtime specifically requires the
//    actual @supabase/supabase-js client (a websocket, not REST) — this is
//    the FIRST file here that needs it. Confirm it's in package.json (or
//    add it: npm install @supabase/supabase-js) before deploying, or this
//    404s/500s at the require() line and Mead Hall silently falls back to
//    polling (safe, but silently — worth actually checking rather than
//    finding out that way).

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = "engagement_events";
const WATCH_TOKENS_TABLE = "watch_tokens";
const HEARTBEAT_MS = 15000;

// ── WATCHER TOKEN RESOLUTION (Aug 21, Data's reconciled design) ─────────
// A watcher token ({role:"watcher", iat, jti}) does NOT carry target_id —
// that would be unrevocable (valid till expiry no matter what). Instead
// jti maps to a watch_tokens row {jti, target_id, created_by, revoked,
// expires_at}; THIS endpoint does the lookup and derives target_id from
// the row, never trusting a target_id passed directly alongside a
// watcher token (that would let a watcher spoof a different target while
// still presenting a validly-signed token for their own).
//
// Backward-compatible: if no ?token= is given at all, this endpoint keeps
// its original behavior — plain ?target_id=/?call_id=, no token required.
// That path stays open for the Director's own existing Mead Hall usage;
// only the token path is scoped/revocable. A director token ({role:
// "director", no jti}) is accepted too and behaves like the no-token
// case — sees whatever target_id/call_id is ALSO given in the query
// string, unrestricted (directors aren't scoped to one target).
//
// This file is plain Node.js (CommonJS), not Edge — unlike control.js/
// mint-token.js, so it uses Node's built-in `crypto` module rather than
// Web Crypto. VERIFIED these two implementations produce byte-identical
// signatures for the same secret+message (real cross-check run during
// development, not assumed) — a token minted by mint-token.js (Edge, Web
// Crypto) verifies correctly here (Node, node:crypto) and vice versa.
const crypto = require("crypto");
const CONTROL_TOKEN_SECRET = process.env.CONTROL_TOKEN_SECRET;

function b64urlEncodeBuffer(buf) {
  return buf.toString("base64url");
}
function b64urlDecodeToString(str) {
  return Buffer.from(str, "base64url").toString("utf8");
}
function hmacSha256B64Url(secret, message) {
  return b64urlEncodeBuffer(
    crypto.createHmac("sha256", secret).update(message).digest()
  );
}
function verifyControlToken(token, secret) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  let expectedSig;
  try {
    expectedSig = hmacSha256B64Url(secret, payloadB64);
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
// Same REST-read pattern _store.js already uses everywhere.
async function lookupWatchToken(jti) {
  const url =
    `${SUPABASE_URL}/rest/v1/${WATCH_TOKENS_TABLE}?jti=eq.${encodeURIComponent(jti)}` +
    `&select=jti,target_id,revoked,expires_at`;
  const r = await fetch(url, {
    cache: "no-store",
    headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return (rows && rows[0]) || null;
}
// Resolves the effective target_id/call_id for this request. Returns
// { ok: true, targetId, callId } or { ok: false, status, error }.
async function resolveScope(reqUrl) {
  const queryTargetId = reqUrl.searchParams.get("target_id");
  const queryCallId = reqUrl.searchParams.get("call_id");
  const token = reqUrl.searchParams.get("token");

  if (!token) {
    // Original, backward-compatible path — no token, trust the query
    // params directly (Director's own existing Mead Hall usage).
    if (!queryTargetId && !queryCallId) {
      return { ok: false, status: 400, error: "missing target_id or call_id" };
    }
    return { ok: true, targetId: queryTargetId, callId: queryCallId };
  }

  if (!CONTROL_TOKEN_SECRET) {
    return { ok: false, status: 500, error: "control token secret not configured" };
  }
  const payload = verifyControlToken(token, CONTROL_TOKEN_SECRET);
  if (!payload) {
    return { ok: false, status: 403, error: "invalid or forged token" };
  }

  if (payload.role === "director") {
    // Unscoped — sees whatever the query string asks for, same as the
    // no-token path.
    if (!queryTargetId && !queryCallId) {
      return { ok: false, status: 400, error: "missing target_id or call_id" };
    }
    return { ok: true, targetId: queryTargetId, callId: queryCallId };
  }

  // role === "watcher": target_id comes ONLY from the watch_tokens row,
  // never from the query string — a watcher cannot use their valid
  // signature to request a different target than the one they were
  // actually granted.
  if (!payload.jti) {
    return { ok: false, status: 403, error: "watcher token missing jti" };
  }
  const row = await lookupWatchToken(payload.jti).catch(() => null);
  if (!row) {
    return { ok: false, status: 403, error: "watch grant not found" };
  }
  if (row.revoked) {
    return { ok: false, status: 403, error: "watch grant revoked" };
  }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 403, error: "watch grant expired" };
  }
  return { ok: true, targetId: row.target_id, callId: null };
}
// ─────────────────────────────────────────────────────────────────────

async function handler(req, res) {
  if (!SUPABASE_URL || !KEY) {
    res.statusCode = 500;
    return res.end("Supabase env not configured");
  }

  let createClient;
  try {
    ({ createClient } = require("@supabase/supabase-js"));
  } catch (e) {
    res.statusCode = 500;
    return res.end(
      "@supabase/supabase-js not installed — see file header, risk #2"
    );
  }

  const reqUrl = new URL(req.url, "http://x");
  const scope = await resolveScope(reqUrl);
  if (!scope.ok) {
    res.statusCode = scope.status;
    return res.end(scope.error);
  }
  const targetId = scope.targetId;
  const callId = scope.callId;

  // SSE headers. x-accel-buffering:no + cache-control:no-transform guard
  // against a proxy layer buffering the stream into chunks instead of
  // relaying each write immediately.
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const supabase = createClient(SUPABASE_URL, KEY, {
    realtime: { params: { eventsPerSecond: 10 } },
  });

  let closed = false;
  const send = (row) => {
    if (closed) return;
    try {
      res.write(`data: ${JSON.stringify(row)}\n\n`);
    } catch {
      cleanup();
    }
  };

  // call_id is the more specific filter ("when pinned"), so it wins if
  // both params are present — matches Mead Hall's own stated priority.
  const filter = callId
    ? `call_id=eq.${callId}`
    : `target_id=eq.${targetId}`;

  const channelName =
    "call-stream-" + (callId || targetId) + "-" + Date.now();
  const channel = supabase
    .channel(channelName)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: TABLE, filter },
      (payload) => send(payload.new)
    )
    .subscribe();

  const heartbeat = setInterval(() => {
    if (closed) return;
    try {
      res.write(":\n\n");
    } catch {
      cleanup();
    }
  }, HEARTBEAT_MS);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      supabase.removeChannel(channel);
    } catch {
      /* best-effort teardown */
    }
    try {
      res.end();
    } catch {
      /* already closed */
    }
  }

  req.on("close", cleanup);
  req.on("aborted", cleanup);
}

// config attached to the FUNCTION ITSELF, then exported together in one
// statement — must happen in this order. Attaching .config to
// module.exports before reassigning module.exports to the function (the
// bug in the first draft) silently discards it: module.exports.config=
// sets a property on whatever object module.exports currently is, and a
// later `module.exports = handler` REPLACES that object entirely, taking
// the .config property with it. Confirmed via real execution — handler.
// config was undefined despite this looking correct at a glance.
handler.config = {
  maxDuration: 600, // Pro + Fluid Compute allows up to 800s GA; 600 leaves
                    // headroom under that. Confirm Fluid Compute is on
                    // (see risk #1 above) or this gets capped at deploy.
};
module.exports = handler;

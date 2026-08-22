// api/mint-token.js — mints signed control-tokens for control.js's
// Director/Watcher gate AND call-stream.js's watcher-scoped feed. Edge
// runtime, same as both those files.
//
// ★ DEPLOY ORDER, NOT OPTIONAL: this file MUST be deployed and confirmed
// working BEFORE control.js's director-token gate goes live. Andrew's own
// existing URLs carry no token — the instant that gate is live with no way
// to mint one, every control action 403s, including his own. Mint first.
//
// TWO DIFFERENT TOKEN SHAPES (Data's design, Aug 21 — reconciled with
// Mead Hall's watch_tokens table):
//   DIRECTOR: {role:"director", iat} — role-scoped, no jti, sees ALL their
//     own targets (resolved by identity/owner_email elsewhere, not here).
//     No watch_tokens row — a director isn't scoped to one target.
//   WATCHER:  {role:"watcher", iat, jti} — jti is a fresh random id that
//     maps to a `watch_tokens` row {jti (PK), target_id, created_by,
//     revoked, expires_at}. The jti is what makes a watcher link
//     REVOCABLE (director un-shares -> set revoked=true -> link dies
//     instantly) without needing target_id baked into the signed token
//     itself, which would be unrevocable until natural expiry.
//
// USAGE:
//   GET /api/mint-token?mint_secret=<SECRET>&role=director
//     -> { token: "<director token>" }
//   GET /api/mint-token?mint_secret=<SECRET>&role=watcher&target_id=<uuid>
//       [&created_by=<label>][&ttl_hours=<N>]
//     -> { token: "<watcher token>" }  (also writes the watch_tokens row)
//   role defaults to "director" if omitted (matches original v1 behavior).
//
// ENV NEEDED:
//   DIRECTOR_MINT_SECRET — gates WHO may call this endpoint at all. Only
//     Andrew should know this value.
//   CONTROL_TOKEN_SECRET — same value control.js/call-stream.js verify
//     against; this is what actually signs the minted token. Deliberately
//     a DIFFERENT secret from DIRECTOR_MINT_SECRET.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — same two vars _store.js
//     already uses, needed here only for the watcher path's watch_tokens
//     write.
//
// EDGE RUNTIME: no Node crypto/Buffer here, Web Crypto (crypto.subtle) +
// btoa only. Helpers duplicated from control.js deliberately (this
// codebase's convention: each api/*.js file is self-contained) — kept
// byte-for-byte equivalent so a token minted here verifies correctly
// wherever it's checked.

export const config = { runtime: "edge" };

const DIRECTOR_MINT_SECRET = process.env.DIRECTOR_MINT_SECRET;
const CONTROL_TOKEN_SECRET = process.env.CONTROL_TOKEN_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WATCH_TOKENS_TABLE = "watch_tokens";

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function b64urlEncodeBytes(bytes) {
  let binary = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// Only needed for the watcher-mint self-check below (decoding what we just
// signed to confirm it matches the DB row) — this file never needed to
// decode a token before, only produce one.
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
async function signPayload(payloadObj) {
  const payloadB64 = b64urlEncodeBytes(
    new TextEncoder().encode(JSON.stringify(payloadObj))
  );
  const sig = await hmacSha256B64Url(CONTROL_TOKEN_SECRET, payloadB64);
  return payloadB64 + "." + sig;
}

// Same REST-write pattern _store.js already uses everywhere (plain fetch
// to Supabase's PostgREST, not the @supabase/supabase-js client — this
// file doesn't need Realtime, only an INSERT, so no reason to pull in the
// heavier client library here).
async function insertWatchToken(row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${WATCH_TOKENS_TABLE}`, {
    cache: "no-store",
    method: "POST",
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    throw new Error(`watch_tokens insert failed: ${r.status} ${errBody.slice(0, 300)}`);
  }
}

export default async function handler(req) {
  if (!DIRECTOR_MINT_SECRET || !CONTROL_TOKEN_SECRET) {
    return jsonRes({ error: "mint secrets not configured" }, 500);
  }
  const u = new URL(req.url);
  const provided = u.searchParams.get("mint_secret");
  if (!provided || provided !== DIRECTOR_MINT_SECRET) {
    return jsonRes({ error: "forbidden" }, 403);
  }

  const role = u.searchParams.get("role") || "director";
  if (role === "director") {
    const token = await signPayload({ role: "director", iat: Date.now() });
    return jsonRes({ token });
  }

  if (role === "watcher") {
    if (!SUPABASE_URL || !KEY) {
      return jsonRes({ error: "Supabase env not configured" }, 500);
    }
    const targetId = u.searchParams.get("target_id");
    if (!targetId) {
      return jsonRes({ error: "target_id required for role=watcher" }, 400);
    }
    const createdBy = u.searchParams.get("created_by") || null;
    const ttlHours = u.searchParams.get("ttl_hours");
    const expiresAt =
      ttlHours && Number(ttlHours) > 0
        ? new Date(Date.now() + Number(ttlHours) * 3600 * 1000).toISOString()
        : null;
    const jti = crypto.randomUUID();

    try {
      await insertWatchToken({
        jti,
        target_id: targetId,
        created_by: createdBy,
        revoked: false,
        expires_at: expiresAt,
      });
    } catch (e) {
      return jsonRes({ error: "failed to create watch grant", detail: String(e).slice(0, 200) }, 502);
    }

    const token = await signPayload({ role: "watcher", iat: Date.now(), jti });

    // ★ EXPLICIT ASSERTION (Mead Hall's ask, Aug 21) — jti is the same
    // local `const` used for both the insert above and the sign here, so
    // this can't currently mismatch by construction. But this check stays
    // regardless: it's the guard against a FUTURE edit (someone splitting
    // this into two calls, or regenerating jti inside signPayload) silently
    // reintroducing the exact bug Mead Hall flagged — a watcher token whose
    // signed jti doesn't match any watch_tokens row, which fails SILENTLY
    // (a blank board, no error) rather than loudly. Decode what was just
    // signed and confirm it matches the jti actually written to the DB
    // before ever returning it.
    const [signedPayloadB64] = token.split(".");
    const signedJti = JSON.parse(b64urlDecodeToString(signedPayloadB64)).jti;
    if (signedJti !== jti) {
      return jsonRes(
        { error: "internal: signed jti does not match watch_tokens row — refusing to issue" },
        500
      );
    }

    return jsonRes({ token, jti, target_id: targetId, expires_at: expiresAt });
  }

  return jsonRes({ error: "unknown role — must be director or watcher" }, 400);
}


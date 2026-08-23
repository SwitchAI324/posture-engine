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

// TOKEN SHAPES:
//   DIRECTOR: {role:"director", sub, did, iat} — sub is an identity string
//     (e.g. email), did is a fresh random id mapping to a `director_tokens`
//     row {did (PK), sub, revoked, created_by, created_at}. This makes each
//     director token INDIVIDUALLY revocable, same mechanism watcher tokens
//     already use via jti/watch_tokens — added Aug 22 once a second real
//     person became plausible; a single shared secret with no identity or
//     revocation was fine for "just Andrew," not fine past that.
//   LEGACY DIRECTOR (still accepted, not minted by this file anymore):
//     {role:"director", iat} with no did/sub — control.js treats a missing
//     did as "skip the revocation check" for backward compatibility, so an
//     already-issued legacy token keeps working. Never mint this shape again.
//   WATCHER: {role:"watcher", iat, jti} — unchanged from before.
//
// TWO SEPARATE MINT SECRETS, DELIBERATELY:
//   DIRECTOR_MINT_SECRET — required for role=director. Stays with whoever
//     should be able to grant FULL control access. Never hand this to a
//     button backend or anything automated.
//   WATCHER_MINT_SECRET — required for role=watcher. Safe to hand to
//     Publishing/Ops's "Share watch link" button backend — it can only ever
//     produce a scoped, read-only, individually-revocable watcher link, never
//     director access, even if that backend is fully compromised.
//   (Both signed with the same CONTROL_TOKEN_SECRET regardless of which mint
//   secret gated the request — that part's unchanged.)
export const config = { runtime: "edge" };

const DIRECTOR_MINT_SECRET = process.env.DIRECTOR_MINT_SECRET;
const WATCHER_MINT_SECRET = process.env.WATCHER_MINT_SECRET;
const CONTROL_TOKEN_SECRET = process.env.CONTROL_TOKEN_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WATCH_TOKENS_TABLE = "watch_tokens";
const DIRECTOR_TOKENS_TABLE = "director_tokens";

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
// heavier client library here). Generic across both tables — same shape
// of call, different table name.
async function insertRow(table, row) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
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
    throw new Error(`${table} insert failed: ${r.status} ${errBody.slice(0, 300)}`);
  }
}

export default async function handler(req) {
  if (!CONTROL_TOKEN_SECRET) {
    return jsonRes({ error: "mint secrets not configured" }, 500);
  }
  const u = new URL(req.url);
  const provided = u.searchParams.get("mint_secret");
  const role = u.searchParams.get("role") || "director";

  // Gate by the SECRET MATCHING THE REQUESTED ROLE — a watcher-mint secret
  // can never authorize a director mint, even if someone tries role=director
  // with the wrong secret. Checked per-role rather than one shared gate.
  if (role === "director") {
    if (!DIRECTOR_MINT_SECRET) {
      return jsonRes({ error: "DIRECTOR_MINT_SECRET not configured" }, 500);
    }
    if (!provided || provided !== DIRECTOR_MINT_SECRET) {
      return jsonRes({ error: "forbidden" }, 403);
    }
    if (!SUPABASE_URL || !KEY) {
      return jsonRes({ error: "Supabase env not configured" }, 500);
    }
    const sub = u.searchParams.get("sub");
    if (!sub) {
      return jsonRes({ error: "sub required for role=director (an identity — e.g. an email)" }, 400);
    }
    const createdBy = u.searchParams.get("created_by") || null;
    const did = crypto.randomUUID();

    try {
      await insertRow(DIRECTOR_TOKENS_TABLE, {
        did,
        sub,
        revoked: false,
        created_by: createdBy,
      });
    } catch (e) {
      return jsonRes({ error: "failed to create director grant", detail: String(e).slice(0, 200) }, 502);
    }

    const token = await signPayload({ role: "director", sub, did, iat: Date.now() });

    // Same jti-style bridge assertion as the watcher path below — did is one
    // local const used for both the insert and the sign, can't currently
    // drift, but this guards a future edit that splits them.
    const [signedPayloadB64] = token.split(".");
    const signedDid = JSON.parse(b64urlDecodeToString(signedPayloadB64)).did;
    if (signedDid !== did) {
      return jsonRes(
        { error: "internal: signed did does not match director_tokens row — refusing to issue" },
        500
      );
    }

    return jsonRes({ token, did, sub });
  }

  if (role === "watcher") {
    if (!WATCHER_MINT_SECRET) {
      return jsonRes({ error: "WATCHER_MINT_SECRET not configured" }, 500);
    }
    if (!provided || provided !== WATCHER_MINT_SECRET) {
      return jsonRes({ error: "forbidden" }, 403);
    }
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
      await insertRow(WATCH_TOKENS_TABLE, {
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


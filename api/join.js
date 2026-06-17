// SpamViking — Posture Engine: JOIN BRIDGE (booking token -> Vapi call).
// ----------------------------------------------------------------------
// Closes the carrier-WRITE gap. Classification is written onto the booking
// token at booking time (by the Email layer, keyed by slug). At JOIN — on our
// own /join/:slug page, after Calendly is out of the path — this endpoint:
//
//   1. reads the token by slug
//   2. mints a Vapi call stamped with metadata.archetype  (+ slug)
//   3. writes vapi_call_id back onto the token
//
// metadata.archetype is exactly what the proxy reads (archetypeFromBody ->
// body.call.metadata.archetype) and hydrates into call_prefix, so the engine
// reads the real archetype every turn and themed bits get +3.
//
// CREATE-AT-JOIN (not at booking): a reschedule strands nothing — the token
// carries everything and the call is minted fresh when they actually show.
// vapi_call_id stays null until this runs. Idempotent: a refresh / re-join /
// post-reschedule re-entry reuses the existing call instead of minting a dupe.
//
//   GET  /api/join?slug=...  -> read-only: token + whether a call exists (no mint)
//   POST /api/join?slug=...  -> mint (or reuse) the call, write vapi_call_id back
//
// Minting happens at dial-in, BEFORE "hello" — pre-call setup, not the per-turn
// spoken path — so the lag rule doesn't apply.
// ----------------------------------------------------------------------

export const config = { runtime: "edge" };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VAPI_KEY = process.env.VAPI_API_KEY;
const ASSISTANT_ID =
  process.env.VAPI_ASSISTANT_ID || "c8917a9c-dee6-4044-bf20-39212d63937d";

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function sb(path, init = {}) {
  return fetch(SB_URL + "/rest/v1/" + path, {
    ...init,
    headers: {
      apikey: SB_KEY,
      authorization: "Bearer " + SB_KEY,
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
}

export default async function handler(req) {
  const u = new URL(req.url);
  const slug = u.searchParams.get("slug");
  if (!slug) return jsonRes({ error: "missing slug" }, 400);
  if (!SB_URL || !SB_KEY) return jsonRes({ error: "store not configured" }, 500);

  // read the token by slug
  const tRes = await sb(
    `booking_tokens?slug=eq.${encodeURIComponent(slug)}` +
      `&select=slug,archetype,booked_slot,vapi_call_id&limit=1`
  );
  if (!tRes.ok) return jsonRes({ error: "token read failed", status: tRes.status }, 502);
  const token = (await tRes.json())[0];
  if (!token) return jsonRes({ error: "unknown slug" }, 404);

  const archetype = token.archetype || "universal";

  // GET = read-only look (no mint). Lets the join page show state / pre-check
  // without a prefetch accidentally creating a call.
  if (req.method === "GET") {
    return jsonRes({
      slug,
      archetype,
      booked_slot: token.booked_slot || null,
      vapi_call_id: token.vapi_call_id || null,
      minted: !!token.vapi_call_id,
    });
  }

  if (req.method !== "POST") return jsonRes({ error: "method not allowed" }, 405);

  // idempotent: reuse an already-minted call (refresh / re-join / reschedule
  // re-entry on the same token) instead of minting a duplicate.
  if (token.vapi_call_id) {
    return jsonRes({ slug, archetype, reused: true, vapi_call_id: token.vapi_call_id });
  }

  if (!VAPI_KEY) return jsonRes({ error: "VAPI_API_KEY not set" }, 500);

  // mint the Vapi call, stamping the archetype as metadata the proxy will read.
  const createRes = await fetch("https://api.vapi.ai/call", {
    method: "POST",
    headers: {
      authorization: "Bearer " + VAPI_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      assistantId: ASSISTANT_ID,
      metadata: { archetype, slug }, // proxy: body.call.metadata.archetype
    }),
  });
  const created = await createRes.json().catch(() => ({}));
  if (!createRes.ok) {
    console.log("join mint FAILED " + createRes.status + " " + JSON.stringify(created));
    return jsonRes({ error: "vapi create failed", status: createRes.status, detail: created }, 502);
  }

  const vapiCallId = created.id || created.callId || null;
  console.log(
    "join slug=" + slug + " archetype=" + archetype + " vapi_call_id=" + vapiCallId
  );

  // write vapi_call_id back onto the token (the call<->booking link). Best-effort
  // but awaited here — it's pre-call, off the spoken path, so the cost is fine.
  if (vapiCallId) {
    await sb(`booking_tokens?slug=eq.${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { prefer: "return=minimal" },
      body: JSON.stringify({
        vapi_call_id: vapiCallId,
        joined_at: new Date().toISOString(),
      }),
    }).catch((e) => console.log("join writeback failed " + String(e)));
  }

  // hand the join page everything it needs to connect the scammer to THIS
  // session. `vapi` is the full create response so the page can pull whatever
  // web-call connection field Vapi returns (and so we can see its shape live).
  return jsonRes({
    slug,
    archetype,
    reused: false,
    vapi_call_id: vapiCallId,
    vapi: created,
  });
}

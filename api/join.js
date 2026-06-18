// SpamViking — Posture Engine: JOIN BRIDGE (record-only; web calls are
// client-started). ----------------------------------------------------------
// Real-world calls are zoom-like WEB meetings, started in the browser by the
// Vapi Web SDK — NOT server-minted (server /call is the phone path). So the
// metadata is stamped client-side at vapi.start(assistant, { metadata }). This
// endpoint's job is the two halves the server owns:
//
//   GET  /api/join?slug=...            -> serve the token's archetype to the
//                                         meeting page (it starts the call with it)
//   POST /api/join?slug=...&call_id=.. -> record the vapi_call_id the page got
//                                         back from vapi.start(), onto the token
//
// The proxy still reads body.call.metadata.archetype and hydrates call_prefix —
// PROVIDED the assistant's model.metadataSendMode is NOT "off".
//
// Create-at-join still holds: nothing is written until the scammer actually
// joins and the page starts the call. Reschedule strands nothing.
// ----------------------------------------------------------------------

export const config = { runtime: "edge" };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

  // read token (select=* so a canon column-name diff can't 400 the read)
  const tRes = await sb(
    `booking_tokens?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`
  );
  if (!tRes.ok) {
    const raw = await tRes.text();
    let detail;
    try { detail = JSON.parse(raw); } catch { detail = raw; }
    return jsonRes({ error: "token read failed", status: tRes.status, detail }, 502);
  }
  const token = (await tRes.json())[0];
  if (!token) return jsonRes({ error: "unknown slug" }, 404);
  const archetype = token.archetype || "universal";

  // GET: hand the archetype to the meeting page, which starts the web call with
  // it via vapi.start(assistant, { metadata: { archetype, slug } }).
  if (req.method === "GET") {
    return jsonRes({
      slug,
      archetype,
      booked_slot: token.booked_slot || null,
      joined_at: token.joined_at || null,
      joined: !!token.joined_at,
    });
  }
  if (req.method !== "POST") return jsonRes({ error: "method not allowed" }, 405);

  // POST: mark the token joined. The call carries `slug` in its metadata, so
  // call<->token correlation is by slug — no vapi_call_id column needed (and
  // Data's canon doesn't have one). We just stamp joined_at, and log the call
  // id for easy log correlation.
  const callId = u.searchParams.get("call_id") || u.searchParams.get("vapi_call_id") || null;
  const wRes = await sb(`booking_tokens?slug=eq.${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({ joined_at: new Date().toISOString() }),
  }).catch(() => null);
  if (!wRes || !wRes.ok) {
    const d = wRes ? await wRes.text().catch(() => "") : "network error";
    console.log("join writeback failed " + (wRes ? wRes.status : "") + " " + d);
    return jsonRes({ error: "writeback failed", detail: d }, 502);
  }
  console.log("join slug=" + slug + " archetype=" + archetype + " call_id=" + (callId || "none"));
  return jsonRes({ ok: true, slug, archetype, vapi_call_id: callId });
}

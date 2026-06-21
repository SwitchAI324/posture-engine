// SpamViking — Vapi end-of-call-report receiver -> Scouting's post-call lane.
// ----------------------------------------------------------------------
// Vapi POSTs the end-of-call-report here when a call ends (set the assistant's
// Server URL to this route and add "end-of-call-report" to its serverMessages).
// The report's `artifact` carries the FULL transcript — that's the channel that
// has it (the client-side call-end event does not). We forward it to Scouting's
// /api/scout/call, FIRE-AND-FORGET, so call teardown never waits on mining.
//
// Acts ONLY on end-of-call-report; every other server message is acked (200)
// and ignored. The target identifier rides in call.metadata, which PE stamps at
// call start (see api/join.js + api/meeting.js): target_id preferred, target_
// email as fallback. call.id is the join key Scouting stores as a column.
// ----------------------------------------------------------------------
import { waitUntil } from "@vercel/functions";

export const config = { runtime: "edge" };

const SCOUT_URL =
  process.env.SCOUT_CALL_URL ||
  "https://posture-engine.vercel.app/api/scout/call";
const SCOUT_TOKEN = process.env.SV_SCOUT_TOKEN || "";

function ok(body) {
  return new Response(JSON.stringify(body || { ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return ok({ ok: true, note: "POST Vapi end-of-call-report here" });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return ok({ ok: true, ignored: "bad json" });
  }

  const m = (body && body.message) || {};
  // Only the end-of-call report carries the transcript; ack & ignore the rest.
  if (m.type !== "end-of-call-report") {
    return ok({ ok: true, ignored: m.type || "unknown" });
  }

  const callId = m.call && m.call.id ? m.call.id : null;
  const meta = (m.call && m.call.metadata) || {};
  const artifact = m.artifact || {};
  const transcript =
    typeof artifact.transcript === "string" ? artifact.transcript : "";

  // Nothing to mine without a call id + a real transcript — ack and stop.
  if (!callId || !transcript.trim()) {
    return ok({ ok: true, skipped: "no call_id or transcript" });
  }

  // Target identifier was stamped into metadata at call start. Prefer the id;
  // include email as a fallback (Scouting accepts either).
  const payload = { call_id: callId, transcript };
  if (meta.target_id) payload.target_id = meta.target_id;
  if (meta.target_email) payload.target_email = meta.target_email;

  // Fire-and-forget: return 200 to Vapi immediately; the scout lane (which
  // processes synchronously on its side) runs in the background via waitUntil,
  // so call teardown is never blocked.
  const p = fetch(SCOUT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-sv-scout-token": SCOUT_TOKEN,
    },
    body: JSON.stringify(payload),
  }).catch(() => {});
  try {
    waitUntil(p);
  } catch {
    /* ignore — best effort */
  }

  return ok({
    ok: true,
    fired: true,
    call_id: callId,
    has_target: !!(meta.target_id || meta.target_email),
  });
}

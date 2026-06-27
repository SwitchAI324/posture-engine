// SpamViking — Posture Engine: MEAD HALL TRACE EMITTER
// ----------------------------------------------------------------------
// Emits live-call events into `engagement_events` for Mead Hall's Director's
// View. Physical row (Data's columns): call_id, event_type, actor, layer, ts,
// payload. Mead Hall reads: type=event_type, payload=payload, orders by seq.
//
// DARK BY DEFAULT: emits only when TRACE_ENABLED=1.
// ----------------------------------------------------------------------
import { envBool } from "./_env.js";
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ON = envBool("TRACE_ENABLED", false);
const TABLE = "engagement_events";

export async function bitFireCount(callId, bitId) {
  if (!ON || !URL || !KEY || !callId || !bitId) return null;
  try {
    const r = await fetch(
      `${URL}/rest/v1/${TABLE}?call_id=eq.${encodeURIComponent(callId)}&event_type=eq.bit_deployed&payload->>bit_id=eq.${encodeURIComponent(bitId)}&select=ts`,
      { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } }
    );
    if (r.ok) { const rows = await r.json(); return Array.isArray(rows) ? rows.length : 0; }
  } catch { /* ignore */ }
  return null;
}

export async function blowLandedTotal(callId) {
  if (!ON || !URL || !KEY || !callId) return null;
  try {
    const r = await fetch(
      `${URL}/rest/v1/${TABLE}?call_id=eq.${encodeURIComponent(callId)}&event_type=eq.blow_landed&select=ts`,
      { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } }
    );
    if (r.ok) { const rows = await r.json(); return Array.isArray(rows) ? rows.length : 0; }
  } catch { /* ignore */ }
  return null;
}

// emit is async and AWAITS its write so the Edge runtime can't discard the
// promise before it lands. layer="call" is REQUIRED (engagement_events.layer
// is NOT NULL) — its absence is what was silently killing every live event.
export function makeTrace(callId, turn, waitUntil) {
  async function emit(type, payload, actor) {
    if (!ON || !URL || !KEY || !callId) return;
    const row = {
      call_id: callId,
      event_type: type,
      actor: actor || "engine",
      layer: "call",
      ts: new Date().toISOString(),
      payload: payload || {},
    };
    try {
      const r = await fetch(`${URL}/rest/v1/${TABLE}`, {
        method: "POST",
        headers: {
          apikey: KEY,
          authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
          prefer: "return=minimal",
        },
        body: JSON.stringify(row),
      });
      if (waitUntil) { try { waitUntil(Promise.resolve(r)); } catch {} }
      return r;
    } catch { /* best-effort: telemetry must never break a call */ }
  }
  return { emit };
}

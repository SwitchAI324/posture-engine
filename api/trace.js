// SpamViking — Posture Engine: MEAD HALL TRACE EMITTER
// ----------------------------------------------------------------------
// Emits live-call events into `engagement_events` for Mead Hall's Director's
// View. Envelope per Mead Hall's contract: { type, seq, payload } with
// call_id = the Vapi call id. Physical row (Data's columns):
//   call_id  (the Vapi call id)
//   event_type  (= Mead Hall's `type`)
//   actor    (host | spammer | bench | director | engine)
//   ts       (ISO timestamp)
//   payload  (jsonb: { seq, ...type-specific fields }; gears live here too)
// So Mead Hall reads: type=event_type, seq=payload.seq, payload=payload.
//
// DARK BY DEFAULT: emits only when TRACE_ENABLED=1. Until Data confirms the
// `engagement_events.call_id` migration has run, leave the env unset and this
// writes nothing. Direct service-role write (same path _store.js uses); every
// emit is best-effort and swallowed — telemetry must never break a call. Pass
// waitUntil so writes run after the voice already has its turn.
// ----------------------------------------------------------------------

import { envBool } from "./_env.js";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Tolerant: "1" is the convention, but TRUE/true/yes/on also read as on, so a
// stray value can't silently leave trace dark.
const ON = envBool("TRACE_ENABLED", false);
const TABLE = "engagement_events";

// bitFireCount: how many times this bit has fired (bit_deployed) this call,
// read off the event log so running_total needs no extra column. null when dark.
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

// blowLandedTotal: how many blow_landed events this call already has, read off
// the event log itself — so total_blows needs no extra column. Returns null when
// dark or on error (caller emits total_blows:null and Mead Hall can still tally).
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

// makeTrace(callId, turn, waitUntil) -> { emit(type, payload, actor) }
// seq is NOT written here: engagement_events.seq is a top-level bigserial the DB
// auto-assigns on insert (monotonic across the table). Mead Hall orders by that
// top-level column, not by anything in payload. (turn is kept in the signature
// for call-site clarity but no longer drives ordering.)
export function makeTrace(callId, turn, waitUntil) {
  function emit(type, payload, actor) {
    if (!ON || !URL || !KEY || !callId) return;
    const row = {
      call_id: callId,
      event_type: type,
      actor: actor || "engine",
      layer: "call", // engagement_events.layer is NOT NULL (email|call|system)
      ts: new Date().toISOString(),
      payload: payload || {},
    };
    const p = fetch(`${URL}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: {
        apikey: KEY,
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    }).catch(() => {});
    if (waitUntil) { try { waitUntil(p); } catch { /* ignore */ } }
    return p;
  }
  return { emit };
}

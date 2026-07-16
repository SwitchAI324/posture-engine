// SpamViking — Posture Engine: MEAD HALL TRACE EMITTER
// ----------------------------------------------------------------------
// Emits live-call events into `engagement_events` for Mead Hall's Director's
// View. Envelope per Mead Hall's contract: { type, seq, payload } with
// call_id = the call id (on LiveKit: the room name, sv-<slug>-<rand>).
// Physical row (Data's columns):
//   call_id    (the call id)
//   target_id  (the target the booking token was minted for — see below)
//   event_type (= Mead Hall's `type`)
//   actor      (host | spammer | bench | director | engine)
//   ts         (ISO timestamp)
//   payload    (jsonb: { seq, ...type-specific fields }; gears live here too)
// So Mead Hall reads: type=event_type, seq=payload.seq, payload=payload.
//
// TARGET_ID (added Jul 15, for Mead Hall): real calls used to emit with
// target_id NULL, so the Director could not open the watch surface BEFORE a
// call — target_id is knowable in advance (it's on the booking token), the
// call_id is not (LiveKit mints the room name at join). Now the compiled
// target rides call_prefix (written by hydrate, read back by getCall) and is
// stamped on every event, so the board can subscribe by target and pick up
// whatever call starts. Passed as the 4th arg; omitting it stamps NULL, which
// is exactly the old behavior — so any call site that can't resolve a target
// degrades instead of breaking.
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

// makeTrace(callId, turn, waitUntil, targetId) -> { emit(type, payload, actor) }
// seq is NOT written here: engagement_events.seq is a top-level bigserial the DB
// auto-assigns on insert (monotonic across the table). Mead Hall orders by that
// top-level column, not by anything in payload. (turn is kept in the signature
// for call-site clarity but no longer drives ordering.)
// targetId is OPTIONAL and defaults to NULL — a call site that hasn't resolved
// the target emits exactly what it emitted before this was added.
export function makeTrace(callId, turn, waitUntil, targetId) {
  async function emit(type, payload, actor) {
    if (!ON || !URL || !KEY || !callId) {
      try {
        console.log(
          "trace skip type=" + type +
            " ON=" + ON +
            " hasURL=" + !!URL +
            " hasKEY=" + !!KEY +
            " callId=" + (callId || "MISSING")
        );
      } catch {}
      return;
    }
    console.log(
      "EMIT-ENTER type=" + type +
        " hasWaitUntil=" + (typeof waitUntil) +
        " target=" + (targetId || "NULL")
    );
    const row = {
      call_id: callId,
      event_type: type,
      actor: actor || "engine",
      layer: "call", // engagement_events.layer is NOT NULL (email|call|system)
      ts: new Date().toISOString(),
      payload: payload || {},
    };
    // Only send target_id when we actually have one. Omitting the key lets the
    // column keep its own default rather than us asserting NULL over it.
    if (targetId) row.target_id = targetId;
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
      if (!r.ok) {
        const t = await r.text().catch(() => "");
        console.log("trace write FAIL type=" + type + " status=" + r.status + " " + String(t).slice(0, 200));
      } else {
        console.log("trace write OK type=" + type + " status=" + r.status);
      }
      return r;
    } catch (e) {
      console.log("trace write THREW type=" + type + " " + (e && e.message ? e.message : e));
    }
  }
  return { emit };
}

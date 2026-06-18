// SpamViking — Posture Engine: call-prefix STORE
// ----------------------------------------------------------------------
// One row per call: the frozen assembled prefix + the current posture line.
// Pure fetch + process.env so it runs in BOTH the Edge proxy and the Node
// pre-snap function. Backed by Supabase REST.
//
// Table (run once):
//   create table if not exists call_prefix (
//     call_id text primary key,
//     prefix text not null,
//     posture_line text,
//     updated_at timestamptz default now()
//   );
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server-side; bypasses RLS).
// ----------------------------------------------------------------------

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = "call_prefix";
const EVENTS = "gear_events";

export function isConfigured() {
  return Boolean(URL && KEY);
}

// READ — the one sanctioned hot-path lookup (indexed PK, not an LLM call).
// Returns { prefix, postureLine } or null (not found / not configured).
export async function getCall(callId) {
  if (!isConfigured() || !callId) return null;
  const url =
    `${URL}/rest/v1/${TABLE}?call_id=eq.${encodeURIComponent(callId)}` +
    `&select=prefix,posture_line,gear,pressure,engagement,slip,last_bit_id,last_bit_turn,archetype`;
  const r = await fetch(url, {
    headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  if (!rows || !rows.length) return null;
  return {
    prefix: rows[0].prefix,
    postureLine: rows[0].posture_line,
    gear: rows[0].gear || "alive", // gear column = SUSPICION axis
    pressure: rows[0].pressure || "calm",
    engagement: rows[0].engagement || "hooked",
    slip: rows[0].slip ?? 0, // suspicion slip accumulator (hysteresis)
    lastBitId: rows[0].last_bit_id || null,
    lastBitTurn: rows[0].last_bit_turn ?? null,
    archetype: rows[0].archetype || null,
  };
}

// WRITE (upsert) — used at pre-snap to freeze the prefix, and later by the
// posture engine to update just the posture line.
export async function setCall(
  callId,
  { prefix, postureLine, gear, pressure, engagement, slip, lastBitId, lastBitTurn, archetype }
) {
  if (!isConfigured()) {
    throw new Error(
      "store not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  const row = { call_id: callId, updated_at: new Date().toISOString() };
  if (prefix !== undefined) row.prefix = prefix;
  if (postureLine !== undefined) row.posture_line = postureLine;
  if (gear !== undefined) row.gear = gear; // gear column = SUSPICION axis
  if (pressure !== undefined) row.pressure = pressure;
  if (engagement !== undefined) row.engagement = engagement;
  if (slip !== undefined) row.slip = slip;
  if (lastBitId !== undefined) row.last_bit_id = lastBitId;
  if (lastBitTurn !== undefined) row.last_bit_turn = lastBitTurn;
  if (archetype !== undefined) row.archetype = archetype;

  const r = await fetch(`${URL}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    throw new Error(`store write failed: ${r.status} ${await r.text()}`);
  }
  return true;
}

// APPEND a per-turn breadcrumb to gear_events — the history that powers the
// gear-trace graph. Append-only (one row per turn), best-effort, and only
// ever called via waitUntil() so it never touches the hot path. Failures are
// swallowed: telemetry must never break a call.
export async function appendGearEvent(
  callId,
  { turn, suspicion, pressure, engagement, slip, accusation, utterance }
) {
  if (!isConfigured() || !callId) return false;
  const row = {
    call_id: callId,
    turn,
    suspicion,
    pressure,
    engagement,
    slip,
    accusation: accusation || null,
    utterance: (utterance || "").slice(0, 500),
  };
  const r = await fetch(`${URL}/rest/v1/${EVENTS}`, {
    method: "POST",
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  return r.ok;
}

// APPEND a per-turn FIT read to bit_events — the top-ranked bit and its score
// breakdown, plus whether it fired. This is how fit becomes measurable: one row
// per turn, off the hot path, best-effort.
export async function appendBitEvent(
  callId,
  { turn, bit_id, name, score, fit, gear_bias, recency, fired, why }
) {
  if (!isConfigured() || !callId) return false;
  const row = {
    call_id: callId, turn, bit_id, name,
    score, fit, gear_bias, recency,
    fired: !!fired, why: (why || "").slice(0, 300),
  };
  const r = await fetch(`${URL}/rest/v1/bit_events`, {
    method: "POST",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json", prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  return r.ok;
}

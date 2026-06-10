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

export function isConfigured() {
  return Boolean(URL && KEY);
}

// READ — the one sanctioned hot-path lookup (indexed PK, not an LLM call).
// Returns { prefix, postureLine } or null (not found / not configured).
export async function getCall(callId) {
  if (!isConfigured() || !callId) return null;
  const url =
    `${URL}/rest/v1/${TABLE}?call_id=eq.${encodeURIComponent(callId)}` +
    `&select=prefix,posture_line,gear`;
  const r = await fetch(url, {
    headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  if (!rows || !rows.length) return null;
  return {
    prefix: rows[0].prefix,
    postureLine: rows[0].posture_line,
    gear: rows[0].gear || "alive",
  };
}

// WRITE (upsert) — used at pre-snap to freeze the prefix, and later by the
// posture engine to update just the posture line.
export async function setCall(callId, { prefix, postureLine, gear }) {
  if (!isConfigured()) {
    throw new Error(
      "store not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  const row = { call_id: callId, updated_at: new Date().toISOString() };
  if (prefix !== undefined) row.prefix = prefix;
  if (postureLine !== undefined) row.posture_line = postureLine;
  if (gear !== undefined) row.gear = gear;

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

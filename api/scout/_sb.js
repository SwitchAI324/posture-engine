// api/scout/_sb.js
// Minimal Supabase REST client for server-side (secret-key) use. Matches
// the _store.js pattern: direct sb_secret_ key, never exposed to a browser.
// RLS on scout_hooks is deny-by-default; the secret key bypasses RLS.
//
// Reads the env vars already present in this project, with the original
// SV_* names kept as fallbacks so nothing breaks if they're added later.
const SB_URL = process.env.SUPABASE_URL || process.env.SV_SUPABASE_URL;
const SB_SECRET =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SV_SUPABASE_SECRET ||
  process.env.SUPABASE_SECRET_KEY;

function headers(extra = {}) {
  return {
    apikey: SB_SECRET,
    Authorization: `Bearer ${SB_SECRET}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

export async function sbSelect(path) {
  // path e.g. "booking_tokens?slug=eq.abc&select=*"
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: headers() });
  if (!r.ok) throw new Error(`sbSelect ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function sbUpsert(table, rows, onConflict) {
  const qs = onConflict ? `?on_conflict=${onConflict}` : '';
  const r = await fetch(`${SB_URL}/rest/v1/${table}${qs}`, {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`sbUpsert ${r.status}: ${await r.text()}`);
  return true;
}

export async function sbPatch(table, filter, body) {
  // filter is a PostgREST query string, e.g. "email=eq.a%40b.com"
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: headers({ Prefer: 'return=minimal' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`sbPatch ${r.status}: ${await r.text()}`);
  return true;
}

// Case-insensitive exact match for PostgREST. User-entered data (emails,
// names) is matched indifferent to case — never use this for system ids or
// passwords. Escapes LIKE metachars so the value matches literally (no
// wildcards introduced), differing only by case.
export function ilikeEq(column, value) {
  const esc = String(value).replace(/([\\%_])/g, '\\$1');
  return `${column}=ilike.${encodeURIComponent(esc)}`;
}

// Plain append insert (no upsert). Used for scout_facts, where extracted_at
// is a retention clock and each run appends fresh rows.
export async function sbInsert(table, rows) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: headers({ Prefer: 'return=minimal' }),
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`sbInsert ${r.status}: ${await r.text()}`);
  return true;
}

// Reads the shared-secret header, tolerant of either name in use across
// callers (booking sends x-sv-scout-token; Email sends x-sv-token).
export function scoutToken(req) {
  const h = (req && req.headers) || {};
  return h['x-sv-scout-token'] || h['x-sv-token'] || null;
}

// SV_SCOUT_TOKEN doubles as a credential AND an on/off switch. Empty, "0", or
// "false" (any casing) means OFF — no guard. Any other value is the active
// secret. House-rule tolerance so setting it to 0/false to disable can't
// silently leave the guard armed with "0" as the password.
export function activeSecret(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (s === '' || s === '0' || s.toLowerCase() === 'false') return null;
  return s;
}

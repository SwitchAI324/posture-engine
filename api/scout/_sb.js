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

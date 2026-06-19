// SpamViking — scout_hooks read (the ammunition rack + fuel for a call).
// ----------------------------------------------------------------------
// Contract (owned by the Scouting Engine): table scout_hooks, PK (slug, hook_id).
// PE reads three columns by slug:
//   select hook_id, label, payload from scout_hooks where slug = :slug
// hook_id + label -> Mead Hall's ammunition rack [{hook_id, label}].
// payload -> byHook[hook_id], the fact a firing bit pulls.
// Only gate-passing hooks are ever written, so there is no filtering on read,
// and an empty rack is a safe default, not a failure.
// ----------------------------------------------------------------------

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export async function readAmmunition(slug) {
  const empty = { ammunition: [], byHook: {} };
  if (!SB_URL || !SB_KEY || !slug) return empty;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/scout_hooks?slug=eq.${encodeURIComponent(slug)}&select=hook_id,label,payload`,
      { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return empty;
    const rows = await r.json();
    if (!Array.isArray(rows)) return empty;
    const ammunition = [];
    const byHook = {};
    for (const row of rows) {
      if (!row.hook_id) continue;
      ammunition.push({ hook_id: row.hook_id, label: row.label || row.hook_id });
      byHook[row.hook_id] = row.payload || null;
    }
    return { ammunition, byHook };
  } catch {
    return empty;
  }
}

// POST /api/phone/mint-token
//
// Mints (or upserts) the minimal booking_tokens row a phone call hydrates off,
// for INBOUND calls (Voice's inbound-check) — so inbound and outbound both
// hydrate through the one prompt path. Reuses the exact token shape the outbound
// dispatcher mints (mintPhoneToken), so there's one mint contract, no drift.
//
// Slug conventions (caller supplies the slug):
//   outbound return calls : 'ph-<callback_job_id>'  (dispatcher mints these)
//   inbound house calls   : 'in-<house_call_id>'    (this endpoint, no job)
// Hydrate keys on the prefix: 'ph-' -> join callback_jobs for context; 'in-' ->
// no job, degrade to no-context. (PE hydrate must tolerate the 'in-' case.)
//
// Body: { slug, host_name?, target_id?, owner_email?, host_tz?, callback_job_id? }
//   - slug           required (caller-chosen; 'in-<house_call_id>' for inbound)
//   - host_name      the host persona name (nullable -> null)
//   - target_id      nullable (house calls have none)
//   - owner_email    for host_config voice resolution (nullable -> null)
//   - host_tz        nullable -> render falls back to Eastern
//   - callback_job_id  INBOUND return calls only: the matched job. The 'in-<house
//                    _call_id>' slug does NOT encode the job id (unlike 'ph-<job_id>'),
//                    so it's stamped on the token for hydrate to read context off.
//                    Null / omitted = house call, cold open (no context by design).
//
// Auth: x-phone-intake-secret (same secret the rest of the phone layer uses).
// Idempotent: on_conflict=slug merge, so re-minting the same slug is safe.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PHONE_INTAKE_SECRET = process.env.PHONE_INTAKE_SECRET;

const sb = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
    if (PHONE_INTAKE_SECRET && req.headers['x-phone-intake-secret'] !== PHONE_INTAKE_SECRET) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return res.status(500).json({ ok: false, error: 'supabase env missing' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const { slug, host_name, target_id, owner_email, host_tz, callback_job_id } = body;
    if (!slug) return res.status(400).json({ ok: false, error: 'missing slug' });

    // Same minimal shape as the outbound dispatcher's mintPhoneToken:
    // booking_tokens.target_email is NOT NULL (built for web), so a phone token
    // gets a synthetic, unique, obviously-not-real placeholder keyed off the slug.
    const row = {
      slug,
      channel: 'phone',
      target_email: `phone+${slug}@sv.local`,
      host_name: host_name || null,
      target_id: target_id || null,     // house calls: null; hydrate degrades safely
      owner_email: owner_email || null, // host_config voice resolution
    };
    if (host_tz) row.host_tz = host_tz;  // else render falls back to Eastern
    // Inbound return calls carry the matched job id here (the 'in-' slug doesn't
    // encode it). Hydrate reads context off this when present; null = cold open.
    if (callback_job_id) row.callback_job_id = callback_job_id;

    const r = await fetch(`${SUPABASE_URL}/rest/v1/booking_tokens?on_conflict=slug`, {
      method: 'POST',
      headers: {
        ...sb,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: `mint failed ${r.status}`, detail: (await r.text()).slice(0, 200) });
    }

    return res.status(200).json({ ok: true, slug });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

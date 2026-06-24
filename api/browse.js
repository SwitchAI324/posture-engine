// POST /api/browse   Body: { slug, tmi_id, tmi_label? }
//
// Thin server-side forwarder for calendar browse-capture. The page detects when
// the scammer pages to / clicks a blackout and posts { slug, tmi_id } here. This
// resolves the blackout's host_callback SERVER-SIDE (authoring is deterministic
// by slug, so we never send the host's scripted line to the browser), then
// relays to Scouting's /api/scout/browse with the scout token.
//
// Fire-and-forget on both legs — browse capture is pure upside; it must never
// block or surface anything to the scammer. Scouting handles dedupe +
// one-row-per-slug shaping and lands it in scout_hooks as browsed_tmi (keyed by
// slug); PE reads it in the call_started rack with no change on their end.

const { authorToken } = require('./_pools');

const SCOUT_BROWSE_URL =
  process.env.SCOUT_BROWSE_URL || 'https://posture-engine.vercel.app/api/scout/browse';
const SCOUT_TOKEN = process.env.SV_SCOUT_TOKEN || process.env.SV_PROXY_TOKEN;

// Resolve the host_callback for a (slug, tmi_id) by re-deriving the frozen
// authoring (deterministic by slug). Keeps the spoken line off the browser.
function resolveCallback(slug, tmiId, tmiLabel) {
  try {
    const a = authorToken(slug);
    const bks = (a.slot_pool && a.slot_pool.blackouts) || [];
    let hit = bks.find((b) => b.tmi_id === tmiId);
    if (!hit && tmiLabel) {
      const norm = String(tmiLabel).toLowerCase();
      hit = bks.find((b) => String(b.label).toLowerCase() === norm);
    }
    return hit ? { host_callback: hit.host_callback, label: hit.label, tmi_id: hit.tmi_id } : null;
  } catch (e) { return null; }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok: false });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const { slug, tmi_id, tmi_label } = body;
    if (!slug || !tmi_id) return res.status(200).json({ ok: true, skipped: true });

    const resolved = resolveCallback(slug, tmi_id, tmi_label);
    if (!resolved || !resolved.host_callback) {
      // nothing to arm — still 200 (fire-and-forget)
      return res.status(200).json({ ok: true, skipped: true });
    }

    // relay to Scouting with the token; don't block on it
    fetch(SCOUT_BROWSE_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-sv-scout-token': SCOUT_TOKEN || '',
        'x-sv-token': SCOUT_TOKEN || '',
      },
      body: JSON.stringify({
        slug,
        tmi_id: resolved.tmi_id,
        tmi_label: resolved.label,
        host_callback: resolved.host_callback,
        browsed_at: new Date().toISOString(),
      }),
    }).catch(() => {});

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true });
  }
};

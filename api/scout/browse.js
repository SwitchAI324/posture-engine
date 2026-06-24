// api/scout/browse.js
// Records which calendar blackout ("TMI") a scammer paged to on the booking
// page, so the host can call it back LIVE on the call ("saw you poking around
// my Fiji week"). Writes a browsed_tmi hook to scout_hooks keyed by slug — the
// same pre-call rack PE reads at call_started. Each blackout carries its own
// host_callback line, which becomes the hook's label: a ready-to-say sentence,
// no inference, no transcription.
//
// Called server-side by Booking (scout_hooks is service-key only, so the
// browser can't write it directly). Fire-and-forget; never blocks the page.
//
// Body: { slug, tmi_id, tmi_label?, host_callback, browsed_at? }

import { sbSelect, sbUpsert, activeSecret, scoutToken } from './_sb.js';
import { emitTrace } from './_hooks.js';

const MAX_ITEMS = 5;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const expected = activeSecret(process.env.SV_SCOUT_TOKEN);
  if (expected && scoutToken(req) !== expected)
    return res.status(401).json({ error: 'bad token' });

  const b = req.body || {};
  const slug = b.slug;
  const tmi_id = b.tmi_id;
  const host_callback = b.host_callback;
  if (!slug || !tmi_id || !host_callback)
    return res.status(400).json({ error: 'slug, tmi_id, host_callback required' });

  const item = {
    tmi_id,
    tmi_label: b.tmi_label || null,
    host_callback,
    browsed_at: b.browsed_at || new Date().toISOString(),
  };

  try {
    // One hook per slug, never one row per blackout: scout_hooks PK is
    // (slug, hook_id), so multiple browsed_tmi rows collide and the write
    // fails. Read the current row, merge the new blackout into payload.items
    // (dedupe by tmi_id, newest at top), upsert the single row.
    let items = [item];
    try {
      const rows = await sbSelect(
        `scout_hooks?slug=eq.${encodeURIComponent(slug)}` +
        `&hook_id=eq.browsed_tmi&select=payload`);
      const current = (rows && rows[0] && rows[0].payload) || {};
      const existing = Array.isArray(current.items) ? current.items : [];
      items = [item, ...existing.filter((x) => x && x.tmi_id !== tmi_id)].slice(0, MAX_ITEMS);
    } catch {}

    const payload = { ...item, items };
    await sbUpsert(
      'scout_hooks',
      [{
        slug,
        hook_id: 'browsed_tmi',
        label: String(host_callback).slice(0, 200),
        payload,
        confidence: 0.95, // observed page event, not inference
        source: 'page:browse',
      }],
      'slug,hook_id');

    await emitTrace('browse_recorded', { slug, tmi_id, total: items.length });
    return res.status(200).json({ slug, tmi_id, recorded: true, total: items.length });
  } catch (e) {
    // Never break the booking page over a missed callback capture.
    await emitTrace('browse_error', { slug, message: String((e && e.message) || e) });
    return res.status(200).json({ slug, recorded: false });
  }
}

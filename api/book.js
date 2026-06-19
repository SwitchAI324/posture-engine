// POST /api/book
// Body: { slug, first, last, email, slot }
//
// Forwards to the existing Apps Script Web App (/exec) in the native shape the
// email layer adds a branch for: { source:"sv_page", slug, email, slot, name }.
// markBooked_ then matches the target BY SLUG (the typed email is inert), marks
// booked, writes slot_time, emits booking_created, and fires the ICS invite
// (confirm, or reschedule SEQ+1). All of that proven machinery stays on Apps
// Script — this is just the server-to-server hop that triggers it.
//
// Server-to-server, so there's no browser CORS issue and the /exec URL is never
// exposed to the scammer.
//
// PENDING (email layer): the {source:"sv_page", ...} branch in doPost, and the
// markBooked_ match-by-slug change. Until those land, this returns whatever
// /exec replies; the page handles a non-OK gracefully.

const EXEC_URL = process.env.APPS_SCRIPT_EXEC_URL;

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const body =
      typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const { slug, first, last, email, slot } = body;
    if (!slug || !slot) return res.status(400).json({ error: 'missing slug or slot' });

    const name = [first, last].filter(Boolean).join(' ').trim();

    const upstream = await fetch(EXEC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'sv_page', slug, email, slot, name }),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      return res.status(502).json({ error: 'booking handoff failed', detail: text });
    }
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'book failed' });
  }
};

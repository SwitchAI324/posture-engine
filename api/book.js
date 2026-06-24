// POST /api/book
// Two intents on one endpoint:
//
//  Booking — Body: { slug, first, last, email, slot }
//    Forwards { source:"sv_page", slug, email, slot, name } to the Apps Script
//    /exec. markBooked_ matches the target BY SLUG (the typed email is inert),
//    marks booked, writes slot_time, emits booking_created, fires the ICS invite
//    (confirm, or reschedule SEQ+1). Proven machinery, untouched.
//
//  Help ("none of these times work") — Body: { slug, help:true }
//    The trapdoor. Bumps `round` on the booking_tokens row (widening what the
//    page reveals next time — the booking layer owns that column) and forwards
//    { source:"sv_help", slug } to /exec, which runs sendHelpWiderCalendar_ ->
//    helpWiderCalendarEmail_ (idempotent). Never touches markBooked_.
//
// Server-to-server, so no browser CORS and the /exec URL is never exposed.

const EXEC_URL = process.env.APPS_SCRIPT_EXEC_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Bump round by 1 (reveal one more open day next render). Bounded so a scammer
// spamming "help" can't reveal the whole pool — caps at 3.
async function bumpRound(slug) {
  if (!SUPABASE_URL || !SERVICE_KEY) return;
  const sb = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
  try {
    const url = `${SUPABASE_URL}/rest/v1/booking_tokens?slug=eq.${encodeURIComponent(slug)}&select=round`;
    const r = await fetch(url, { headers: { ...sb, Accept: 'application/json' } });
    const cur = r.ok ? ((await r.json())[0] || {}).round : null;
    const next = Math.min((Number.isFinite(cur) ? cur : 0) + 1, 3);
    await fetch(`${SUPABASE_URL}/rest/v1/booking_tokens?slug=eq.${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      headers: { ...sb, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ round: next }),
    });
  } catch (e) { /* widening is best-effort; the email is the real payoff */ }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const body =
      typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const { slug, first, last, email, slot, help } = body;
    if (!slug) return res.status(400).json({ error: 'missing slug' });

    // ── HELP branch (trapdoor) — checked BEFORE booking so it never misfires
    //    markBooked_. No slot required.
    if (help === true) {
      await bumpRound(slug);
      const up = await fetch(EXEC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'sv_help', slug }),
      });
      // Best-effort: the page always shows the scammer "I'll email you" regardless.
      if (!up.ok) return res.status(200).json({ ok: true, degraded: true });
      return res.status(200).json({ ok: true });
    }

    // ── BOOKING branch
    if (!slot) return res.status(400).json({ error: 'missing slot' });
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

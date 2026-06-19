// GET /api/render?slug=...
// Reads the booking_tokens row server-side with the Supabase service role,
// and returns ONLY render-safe fields to the browser.
//
// Never returned to the browser: archetype, difficulty, fakes_served
// (con-revealing), or any PII. Those stay server-side.
//
// Thin-slice note: slot_pool authoring (the "Fiji blackout" pools) isn't built
// yet, so when slot_pool is empty we generate a stable set of times seeded by
// the slug — same slug always shows the same times, so it reads as authored
// without needing a DB write. The real authored pools replace this later.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function hashSlug(slug) {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

// Deterministic, stable-per-slug set of open times for the next ~2 weeks.
function generateSlots(slug) {
  const seed = hashSlug(slug);
  const timesByDay = [
    ['10:00', '13:30', '16:00'],
    ['09:30', '15:00'],
    ['11:00', '14:00', '16:30'],
  ];
  const out = [];
  const now = new Date();
  let added = 0;
  for (let d = 1; d <= 16 && added < 6; d++) {
    const day = new Date(now);
    day.setDate(now.getDate() + d);
    const dow = day.getDay();
    if (dow === 0 || dow === 6) continue; // weekdays only in the thin slice
    const times = timesByDay[(seed + d) % timesByDay.length];
    const slots = times.map((t) => {
      const [hh, mm] = t.split(':').map(Number);
      const slot = new Date(day);
      slot.setHours(hh, mm, 0, 0);
      return slot.toISOString();
    });
    out.push({ date: day.toISOString().slice(0, 10), slots });
    added++;
  }
  return out;
}

async function readToken(slug) {
  const url =
    `${SUPABASE_URL}/rest/v1/booking_tokens` +
    `?slug=eq.${encodeURIComponent(slug)}` +
    `&select=slug,narrative,slot_pool,round,booked_slot`;
  const res = await fetch(url, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`supabase ${res.status}: ${body.slice(0, 300)}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

module.exports = async (req, res) => {
  try {
    // Diagnostic: confirm the env vars are actually present (without leaking
    // the key). Load /api/render?slug=test123 directly to read this.
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return res.status(500).json({
        error: 'config',
        detail: {
          SUPABASE_URL_set: !!SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY_set: !!SERVICE_KEY,
          key_len: SERVICE_KEY ? SERVICE_KEY.length : 0,
        },
      });
    }

    const slug = (req.query && req.query.slug) || '';
    if (!slug) return res.status(400).json({ error: 'missing slug' });

    const token = await readToken(slug);
    if (!token) return res.status(404).json({ error: 'not found', slug });

    // slot_pool authoring isn't built yet -> stable generated set per slug.
    const days =
      token.slot_pool && Array.isArray(token.slot_pool.days)
        ? token.slot_pool.days
        : generateSlots(slug);

    res.status(200).json({
      host: 'Andrew Mercer',
      narrative: token.narrative || null, // generic until pools are authored
      days,
      reschedule: !!token.booked_slot,
      booked_slot: token.booked_slot || null,
    });
  } catch (e) {
    res.status(500).json({ error: 'render failed', detail: String(e.message || e) });
  }
};

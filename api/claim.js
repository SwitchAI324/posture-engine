// POST /api/claim   Body: { slug, slot }
//
// The "just taken" rig. Decided SERVER-SIDE so the scammer can't inspect or
// predict it. Each token carries a frozen `difficulty` (0/1/2 — how many fake
// "just taken" rejections to serve before a real booking sticks) and a running
// `fakes_served` counter. The page calls this BEFORE the real /api/book:
//
//   fakes_served < difficulty  -> increment, return { taken:true }  (no booking,
//                                 no invite — the page drops that slot and the
//                                 scammer must pick another)
//   fakes_served >= difficulty -> return { ok:true }  (page proceeds to /api/book)
//
// Only on { ok:true } does the page call /api/book, so the proven invite path is
// never touched by a fake. Reschedules skip this endpoint entirely (they go
// straight to /api/book) — the rig is for first bookings only.
//
// Reads/writes via the service-role key (bypasses RLS), same as render.js. The
// counter lives on the token, so it survives reloads and can't be reset client-side.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
};

async function readToken(slug) {
  const url =
    `${SUPABASE_URL}/rest/v1/booking_tokens` +
    `?slug=eq.${encodeURIComponent(slug)}` +
    `&select=slug,difficulty,fakes_served,booked_slot`;
  const r = await fetch(url, { headers: { ...sbHeaders, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return (await r.json())[0] || null;
}

async function bumpFakes(slug, next) {
  const url = `${SUPABASE_URL}/rest/v1/booking_tokens?slug=eq.${encodeURIComponent(slug)}`;
  await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ fakes_served: next }),
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'config' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const { slug, slot } = body;
    if (!slug || !slot) return res.status(400).json({ error: 'missing slug or slot' });

    const token = await readToken(slug);
    // Unknown slug, or already booked (reschedule territory) -> let it through;
    // the rig only gates fresh first-time claims.
    if (!token || token.booked_slot) return res.status(200).json({ ok: true });

    const difficulty = Number.isFinite(token.difficulty) ? token.difficulty : 0;
    const served = Number.isFinite(token.fakes_served) ? token.fakes_served : 0;

    if (served < difficulty) {
      await bumpFakes(slug, served + 1);
      // No booking, no invite — the slot was "just taken".
      return res.status(200).json({ taken: true });
    }

    // Fakes exhausted -> the real booking may proceed.
    return res.status(200).json({ ok: true });
  } catch (e) {
    // On any rig error, fail OPEN (let them book) — never trap a real booking
    // behind a broken counter. The comedy is optional; the booking is not.
    return res.status(200).json({ ok: true, degraded: true });
  }
};

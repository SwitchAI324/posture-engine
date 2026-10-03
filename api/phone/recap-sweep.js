// api/phone/recap-sweep.js
// Catches the one case recap.js can't handle on its own: a completed call
// that should get a recap (recap or voicemail_left outcome) where the
// recording webhook's "ready" POST never arrives at all — egress failure,
// a dropped webhook, whatever. Without this, that job's recap would wait
// forever in the "awaiting recording" state recap.js returns.
//
// Intended trigger: Vercel Cron, every 1-2 minutes. NOT wired up yet — this
// file alone does nothing until a cron entry calls it. Flagging that as an
// open item rather than guessing at vercel.json ownership.
//
// What it does: finds completed jobs whose outcome maps to a recording-
// eligible kind (recap/voicemail_left), have no phone_recaps row yet, and
// are past the 5-minute fallback window (same ASSUMPTION as recap.js: keyed
// off job.updated_at, not a confirmed "call ended" column) — then POSTs
// each one to /api/phone/recap, same as the real triggers would. All the
// actual send logic (including the second recordingLink() check — a
// recording might have landed in the gap between this sweep running and
// the job aging past 5 minutes) stays in recap.js; this file only finds
// the stragglers and re-pokes them.
//
// Header: x-phone-intake-secret (both incoming, on this endpoint, and
// outgoing, when it calls /api/phone/recap).

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.PHONE_INTAKE_SECRET;
const RECAP_URL = process.env.PHONE_RECAP_URL || 'https://posture-engine.vercel.app/api/phone/recap';
const FALLBACK_MINUTES = 5;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${path} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const select = (table, filter) => sb(`${table}?${filter}`, { method: 'GET' });

export default async function handler(req, res) {
  if (!SECRET || req.headers['x-phone-intake-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'bad secret' });

  try {
    const cutoff = new Date(Date.now() - FALLBACK_MINUTES * 60000).toISOString();
    const candidates = await select('callback_jobs',
      `status=eq.completed&outcome=like.answered*&updated_at=lte.${cutoff}&select=id,outcome,updated_at&limit=200`);
    // outcome=like.answered* above only catches answered_*; voicemail_left
    // needs its own OR — PostgREST can't OR two different column filters in
    // one query string cleanly, so two passes instead of one clever one.
    const candidates2 = await select('callback_jobs',
      `status=eq.completed&outcome=eq.voicemail_left&updated_at=lte.${cutoff}&select=id,outcome,updated_at&limit=200`);
    const jobs = [...candidates, ...candidates2];

    let poked = 0;
    const results = [];
    for (const job of jobs) {
      // Skip jobs that already have ANY phone_recaps row — recap.js itself
      // re-derives kind from outcome, so we don't need to duplicate that
      // logic here; just avoid POSTing for jobs clearly already handled.
      const already = await select('phone_recaps', `job_id=eq.${job.id}&select=id&limit=1`);
      if (already.length) continue;
      try {
        await fetch(RECAP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-phone-intake-secret': SECRET },
          body: JSON.stringify({ job_id: job.id }),
          signal: AbortSignal.timeout(8000),
        });
        poked++;
      } catch (e) {
        results.push({ job_id: job.id, error: String(e.message || e) });
      }
    }

    return res.status(200).json({ ok: true, scanned: jobs.length, poked, errors: results });
  } catch (err) {
    console.error('phone-recap-sweep', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

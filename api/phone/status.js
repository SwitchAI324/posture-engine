// BUILD: phone-status-api v2 2026-10-07
// /api/phone/status — read-only health snapshot of the phone callback system.
// ----------------------------------------------------------------------
// Powers phone-status.html (the ops dashboard). Read-only: it never writes, never
// dials, never flips the kill switch — it just reports current state so Andrew can
// answer "is the dialer armed, what's queued, what happened lately" without SQL.
//
// AUTH: if env STATUS_SECRET is set, the caller must pass ?key=<secret> (or an
// x-status-secret header) that matches, else 401. If STATUS_SECRET is NOT set, it
// serves open (so it works the moment it's deployed) — but this page exposes
// operational data (queue sizes, outcomes), so SET STATUS_SECRET before relying
// on it. Falls back to DISPATCH_SECRET if STATUS_SECRET is absent.
//
// CROSS-ORIGIN: this endpoint lives in the posture-engine repo
// (posture-engine.vercel.app) but phone-status.html is served from
// live.spamviking.com (spamviking-web repo) — a different origin. So the page's
// fetch is cross-origin and we must return CORS headers or the browser blocks it.
// The ?key= secret is the real protection, so Allow-Origin:* is fine here
// (read-only, no cookies/credentials).
//
// CommonJS + node req/res, matching dispatch-callbacks.js (same api/ style).
// ----------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STATUS_SECRET = process.env.STATUS_SECRET || process.env.DISPATCH_SECRET || '';

const sb = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

// exact row count via PostgREST Content-Range (Prefer: count=exact, Range 0-0).
async function count(filter) {
  try {
    const url = `${SUPABASE_URL}/rest/v1/callback_jobs?${filter}&select=id`;
    const r = await fetch(url, {
      headers: { ...sb, Accept: 'application/json', Prefer: 'count=exact', Range: '0-0' },
    });
    const cr = r.headers.get('content-range') || '';   // e.g. "0-0/142"
    const total = cr.split('/')[1];
    return total && total !== '*' ? parseInt(total, 10) : 0;
  } catch (e) { return 0; }
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json');
  // CORS — page is on a different origin (live.spamviking.com). Secret-gated and
  // read-only, so * is acceptable.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'x-status-secret');
  const send = (obj, status = 200) => { res.statusCode = status; return res.end(JSON.stringify(obj)); };

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  // auth gate (only enforced when a secret is configured)
  if (STATUS_SECRET) {
    let key = null;
    try { key = new URL(req.url, 'http://x').searchParams.get('key'); } catch (e) {}
    key = key || req.headers['x-status-secret'];
    if (key !== STATUS_SECRET) return send({ error: 'unauthorized' }, 401);
  }
  if (!SUPABASE_URL || !SERVICE_KEY) return send({ error: 'supabase env missing' }, 500);

  const nowIso = new Date().toISOString();
  const dayAgo = new Date(Date.now() - 24 * 3600000).toISOString();

  try {
    // armed? (kill switch — same flag the dispatcher reads every run)
    let armed = false;
    try {
      const f = await fetch(`${SUPABASE_URL}/rest/v1/system_flags?select=dispatch_enabled&limit=1`,
        { headers: { ...sb, Accept: 'application/json' } });
      if (f.ok) { const rows = await f.json(); armed = !!(rows[0] && rows[0].dispatch_enabled === true); }
    } catch (e) {}

    // queue snapshot
    const [approvedDue, approvedFuture, dialing] = await Promise.all([
      count(`status=eq.approved&scheduled_at=lte.${encodeURIComponent(nowIso)}`),
      count(`status=eq.approved&scheduled_at=gt.${encodeURIComponent(nowIso)}`),
      count(`status=eq.dialing`),
    ]);

    // recent jobs (newest first)
    let recent = [];
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/callback_jobs?order=status_changed_at.desc&limit=12` +
        `&select=id,status,outcome,fail_reason,archetype,status_changed_at`,
        { headers: { ...sb, Accept: 'application/json' } });
      if (r.ok) recent = await r.json();
    } catch (e) {}

    // last-24h outcome tally
    let last24 = [];
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/callback_jobs?status_changed_at=gte.${encodeURIComponent(dayAgo)}` +
        `&select=outcome,status&limit=2000`,
        { headers: { ...sb, Accept: 'application/json' } });
      if (r.ok) last24 = await r.json();
    } catch (e) {}
    const counts24h = {};
    for (const j of last24) {
      const k = j.outcome || j.status || 'unknown';
      counts24h[k] = (counts24h[k] || 0) + 1;
    }

    return send({
      ok: true,
      now: nowIso,
      armed,
      queue: { approved_due: approvedDue, approved_future: approvedFuture, dialing },
      counts_24h: counts24h,
      recent,
    });
  } catch (e) {
    return send({ error: String(e.message || e) }, 500);
  }
};

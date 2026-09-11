// api/phone/call-live.js
// POST /api/phone/call-live
// Fired by the Voice agent the moment a call is confirmed live with a person
// (phone: after AMD resolves human/uncertain/ivr; web: at scammer join).
// Sends the SV user an SMS with a deep link to the Mead Hall listen page.
//
// Fire-and-forget contract: this endpoint ALWAYS answers 200 to a valid,
// authenticated request, even when it skips or the SMS fails. Nothing
// upstream should ever block or retry because of us. Every outcome is
// written to sms_log.
//
// Auth: header x-phone-intake-secret must equal env PHONE_INTAKE_SECRET
// (same secret Voice already uses for /api/phone/recap).
//
// Payload: { room, slug, channel, job_id, user_id, e164, amd }
//   channel: 'phone' | 'web'
//   amd:     'human' | 'uncertain' | 'ivr' | null (web sends null)
//
// Env (Vercel):
//   PHONE_INTAKE_SECRET          existing
//   TWILIO_ACCOUNT_SID           existing
//   TWILIO_AUTH_TOKEN            existing
//   TWILIO_SMS_FROM              NEW — sending number, E.164 (e.g. +18005551234)
//     or TWILIO_MESSAGING_SERVICE_SID (MG...) — used instead of FROM if set
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   existing (fallback names tolerated)
//   LISTEN_TOKEN_SECRET          NEW — shared with Voice's /api/livekit-listener-token.
//     When set, the link is listen=<JWT {room,user_id,exp +30min}> only.
//     When unset, falls back to call_id=<room> (Voice's mint rejects that).
//
// user_id resolution: payload user_id if present; otherwise, when job_id is
// a uuid, callback_jobs.user_id (Voice's phone payload omitted user_id on
// first test, Sep 11). Still missing → skip missing_room_or_user.
//
// Gates, in order (first hit wins, all logged with skip_reason):
//   amd_machine  amd not in human/uncertain/ivr/null
//   global_off   system_flags.call_live_sms_enabled = false
//   no_phone     sv_users.phone_e164 empty
//   global_off_user  sv_users.notify_global = false
//   user_off     phone_settings.notify_call_live = false
//   duplicate    an sms_log row with status 'sent' already exists for this room



import crypto from 'crypto';

const LISTEN_BASE = 'https://live.spamviking.com/mead_hall_live.html?view=listen';
const LISTEN_TTL_SEC = 30 * 60;
const ALLOWED_AMD = new Set(['human', 'uncertain', 'ivr']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function env(name, ...fallbacks) {
  for (const n of [name, ...fallbacks]) {
    if (process.env[n]) return process.env[n];
  }
  return '';
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

// ---------- listen token (HS256 JWT, no deps) ----------

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signListenToken(room, userId) {
  const secret = env('LISTEN_TOKEN_SECRET');
  if (!secret) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ room, user_id: userId, iat: now, exp: now + LISTEN_TTL_SEC }));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

// Signed link carries ONLY the JWT (room never appears in the URL — inbound
// room names contain the caller's phone number). Falls back to call_id when
// no LISTEN_TOKEN_SECRET is set.
function listenLink(room, userId) {
  const tok = signListenToken(room, userId);
  if (tok) return `${LISTEN_BASE}&listen=${tok}`;
  return `${LISTEN_BASE}&call_id=${encodeURIComponent(room)}`;
}

// ---------- Supabase (PostgREST via fetch, service role, no SDK) ----------

function sb() {
  const url = env('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY');
  if (!url || !key) throw new Error('supabase env missing');
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  return {
    async select(table, query) {
      const r = await fetch(`${url}/rest/v1/${table}?${query}`, { headers });
      if (!r.ok) throw new Error(`select ${table} ${r.status}`);
      return r.json();
    },
    async insert(table, row) {
      const r = await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      });
      if (!r.ok) throw new Error(`insert ${table} ${r.status}`);
    },
  };
}

// ---------- Twilio (REST via fetch, no SDK) ----------

async function twilioSend(to, body) {
  const sid = env('TWILIO_ACCOUNT_SID');
  const token = env('TWILIO_AUTH_TOKEN');
  const from = env('TWILIO_SMS_FROM');
  const svc = env('TWILIO_MESSAGING_SERVICE_SID');
  if (!sid || !token) throw new Error('twilio creds missing');
  if (!from && !svc) throw new Error('TWILIO_SMS_FROM or TWILIO_MESSAGING_SERVICE_SID missing');

  const form = new URLSearchParams({ To: to, Body: body });
  if (svc) form.set('MessagingServiceSid', svc); else form.set('From', from);

  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`twilio ${r.status}: ${data.message || 'unknown'}`);
    err.retryable = r.status >= 500 || r.status === 429;
    throw err;
  }
  return data.sid;
}

async function sendWithRetry(to, body) {
  try {
    return await twilioSend(to, body);
  } catch (e) {
    if (!e.retryable && e.message.indexOf('fetch') === -1) throw e;
    await new Promise((res) => setTimeout(res, 3000));
    return twilioSend(to, body);
  }
}

// ---------- handler ----------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }
  if (!safeEqual(req.headers['x-phone-intake-secret'], env('PHONE_INTAKE_SECRET'))) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const p = parseBody(req);
  const room = String(p.room || p.slug || '').trim();
  let userId = String(p.user_id || '').trim();
  const channel = String(p.channel || '').trim() || null;
  const jobId = p.job_id != null ? String(p.job_id) : null;
  const amd = p.amd == null || p.amd === '' ? null : String(p.amd);

  const base = { user_id: userId || null, room: room || null, job_id: jobId, channel };
  let db;
  const log = async (row) => {
    try { await db.insert('sms_log', { ...base, ...row }); } catch (e) {
      console.error('call-live: sms_log write failed', e.message);
    }
  };
  const skip = async (reason) => {
    await log({ status: 'skipped', skip_reason: reason });
    res.status(200).json({ ok: true, status: 'skipped', skip_reason: reason });
  };

  try {
    db = sb();
  } catch (e) {
    console.error('call-live:', e.message);
    res.status(200).json({ ok: true, status: 'failed', error: e.message });
    return;
  }

  if (!userId && jobId && UUID_RE.test(jobId)) {
    try {
      const jobs = await db.select(
        'callback_jobs',
        `select=user_id&id=eq.${encodeURIComponent(jobId)}&limit=1`
      );
      if (jobs[0] && jobs[0].user_id) {
        userId = String(jobs[0].user_id);
        base.user_id = userId;
      }
    } catch (e) {
      console.error('call-live: job lookup failed', e.message);
    }
  }

  if (!room || !userId) return skip('missing_room_or_user');
  if (amd !== null && !ALLOWED_AMD.has(amd)) return skip('amd_machine');

  try {
    const flags = await db.select('system_flags', 'select=call_live_sms_enabled&limit=1');
    if (!flags[0] || flags[0].call_live_sms_enabled !== true) return skip('global_off');

    const users = await db.select(
      'sv_users',
      `select=phone_e164,notify_global&id=eq.${encodeURIComponent(userId)}&limit=1`
    );
    const user = users[0];
    if (!user) return skip('no_user');
    if (!user.phone_e164) return skip('no_phone');
    if (user.notify_global === false) return skip('global_off_user');

    const prefs = await db.select(
      'phone_settings',
      `select=notify_call_live&user_id=eq.${encodeURIComponent(userId)}&limit=1`
    );
    if (prefs[0] && prefs[0].notify_call_live === false) return skip('user_off');

    const dupes = await db.select(
      'sms_log',
      `select=id&room=eq.${encodeURIComponent(room)}&status=eq.sent&limit=1`
    );
    if (dupes[0]) return skip('duplicate');

    const link = listenLink(room, userId);
    const body = `SpamViking: your host is live with a scammer right now. Tap to listen: ${link}`;

    try {
      const sid = await sendWithRetry(user.phone_e164, body);
      await log({ status: 'sent', to_e164: user.phone_e164, provider_sid: sid });
      res.status(200).json({ ok: true, status: 'sent' });
    } catch (e) {
      console.error('call-live: send failed', e.message);
      await log({ status: 'failed', to_e164: user.phone_e164, error: e.message });
      res.status(200).json({ ok: true, status: 'failed', error: e.message });
    }
  } catch (e) {
    console.error('call-live: lookup failed', e.message);
    await log({ status: 'failed', error: e.message });
    res.status(200).json({ ok: true, status: 'failed', error: e.message });
  }
}

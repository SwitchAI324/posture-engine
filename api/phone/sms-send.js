// api/phone/sms-send.js
// POST /api/phone/sms-send   { user_id, text }   header x-phone-intake-secret
// The ONE place any SpamViking chat/service sends a text. Phone Intake calls
// it for confirmations ("calling X in 30 min, reply SKIP"), skip/block acks,
// and for phone-only users the recap lines too. Twilio credentials live only
// here and in call-live.
//
// Gates, in order (first hit wins, all logged to sms_log with skip_reason):
//   global_off        system_flags.sms_enabled = false
//   no_user           user_id not found
//   no_phone          sv_users.phone_e164 empty
//   global_off_user   sv_users.notify_global = false
// Retries once after 3 s on Twilio 5xx / 429. Always answers 200 to a valid,
// authenticated request; { status: 'sent' | 'failed' | 'skipped' }.
//
// Optional body fields:
//   ref      free text stored in sms_log.job_id (job id, room, message sid)
//   channel  label stored in sms_log.channel (default 'sms_out')
//
// Env: PHONE_INTAKE_SECRET, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
//      TWILIO_SMS_FROM (or TWILIO_MESSAGING_SERVICE_SID),
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import crypto from 'crypto';

const MAX_LEN = 1000;

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

function sb() {
  const url = env('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY');
  if (!url || !key) throw new Error('supabase env missing');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  return {
    async select(table, query) {
      const r = await fetch(`${url}/rest/v1/${table}?${query}`, { headers });
      if (!r.ok) throw new Error(`select ${table} ${r.status}`);
      return r.json();
    },
    async insert(table, row) {
      const r = await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(row),
      });
      if (!r.ok) throw new Error(`insert ${table} ${r.status}`);
    },
  };
}

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
    if (!e.retryable) throw e;
    await new Promise((res) => setTimeout(res, 3000));
    return twilioSend(to, body);
  }
}

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
  const userId = String(p.user_id || '').trim();
  const text = String(p.text || '').trim().slice(0, MAX_LEN);
  const ref = p.ref != null ? String(p.ref) : null;
  const channel = String(p.channel || 'sms_out');

  if (!userId || !text) {
    res.status(400).json({ ok: false, error: 'user_id and text required' });
    return;
  }

  let db;
  try {
    db = sb();
  } catch (e) {
    res.status(200).json({ ok: true, status: 'failed', error: e.message });
    return;
  }
  const base = { user_id: userId, job_id: ref, channel, body: text };
  const log = async (row) => {
    try { await db.insert('sms_log', { ...base, ...row }); } catch (e) {
      console.error('sms-send: sms_log write failed', e.message);
    }
  };
  const skip = async (reason) => {
    await log({ status: 'skipped', skip_reason: reason });
    res.status(200).json({ ok: true, status: 'skipped', skip_reason: reason });
  };

  try {
    const flags = await db.select('system_flags', 'select=sms_enabled&limit=1');
    if (!flags[0] || flags[0].sms_enabled !== true) return skip('global_off');

    const users = await db.select(
      'sv_users', `select=phone_e164,notify_global&id=eq.${encodeURIComponent(userId)}&limit=1`
    );
    const user = users[0];
    if (!user) return skip('no_user');
    if (!user.phone_e164) return skip('no_phone');
    if (user.notify_global === false) return skip('global_off_user');

    try {
      const sid = await sendWithRetry(user.phone_e164, text);
      await log({ status: 'sent', to_e164: user.phone_e164, provider_sid: sid });
      res.status(200).json({ ok: true, status: 'sent' });
    } catch (e) {
      console.error('sms-send: send failed', e.message);
      await log({ status: 'failed', to_e164: user.phone_e164, error: e.message });
      res.status(200).json({ ok: true, status: 'failed', error: e.message });
    }
  } catch (e) {
    console.error('sms-send: lookup failed', e.message);
    await log({ status: 'failed', error: e.message });
    res.status(200).json({ ok: true, status: 'failed', error: e.message });
  }
}

// api/phone/sms-inbound.js
// POST /api/phone/sms-inbound — Twilio "A message comes in" webhook for the
// toll-free number +18336957726 (833-OWL-SPAM).
//
// What happens when a text (or picture) arrives:
//   1. Verify it really came from Twilio (X-Twilio-Signature: HMAC-SHA1 with
//      TWILIO_AUTH_TOKEN over the webhook URL + sorted POST params).
//   2. system_flags.sms_enabled must be true, else reply "not open yet".
//   3. Bare carrier/Twilio keywords (STOP, HELP, START ...) are handled
//      upstream; if one reaches us we log it and reply nothing.
//   4. Sender lookup on sv_users.phone_e164. Unknown → auto-enroll via the
//      enroll_phone_user(p_e164) RPC (create-or-return uuid; also provisions
//      phone_settings). Never a raw insert.
//   5. Media (MMS): each MediaUrlN is fetched with Twilio Basic auth, stored
//      in Supabase storage at sms/<MessageSid>/<n>.<ext>, and handed on as a
//      24-hour signed URL. Phone Intake never touches Twilio.
//   6. Hand off to Phone Intake (5 s budget):
//        POST PHONE_INTAKE_SMS_URL, header x-phone-intake-secret
//        {source:'sms', user_id, enrolled, from_e164, to_e164, message_sid,
//         text, command, media:[{url, content_type}], received_at}
//      command = SKIP | BLOCK | RETRY | GO when the whole message is that
//      word (case-insensitive), else null. Phone Intake owns what they mean.
//   7. Reply TwiML — same mechanism as Barbara's reply_body on the email
//      path: if Phone Intake's response JSON carries a non-empty
//      `reply_body`, THAT is texted back as the immediate reply. If it
//      doesn't answer in time, errors, or omits reply_body, a generic "got
//      it" goes back instead (nothing for a bare command). Anything Phone
//      Intake wants to say LATER (the warn-first line, recaps, acks) goes
//      through /api/phone/sms-send. Twilio needs an answer within ~15 s;
//      nothing here may hang. Every message is logged to sms_log (body +
//      media kept) so a failed handoff can be replayed.
//
// Env (Vercel):
//   TWILIO_AUTH_TOKEN, TWILIO_ACCOUNT_SID   existing
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY existing
//   PHONE_INTAKE_SECRET                     existing
//   PHONE_INTAKE_SMS_URL   optional; default
//     https://posture-engine.vercel.app/api/phone-intake
//   SMS_MEDIA_BUCKET       optional; default 'voicemails' (private bucket)
//   SMS_WEBHOOK_URL        optional; the exact URL configured in Twilio, used
//     for signature checking. Default is rebuilt from the request headers.
//
// Schema this relies on (additive SQL handed to Andrew Sep 28):
//   sms_log.body text, sms_log.media jsonb, system_flags.sms_enabled boolean

import crypto from 'crypto';

const RESERVED = new Set([
  'STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE',
  'OPTOUT', 'HELP', 'INFO', 'START', 'UNSTOP', 'YES',
]);
const COMMANDS = new Set(['SKIP', 'BLOCK', 'RETRY', 'GO']);
const MAX_MEDIA = 5;
const SIGNED_URL_TTL = 24 * 60 * 60;

function env(name, ...fallbacks) {
  for (const n of [name, ...fallbacks]) {
    if (process.env[n]) return process.env[n];
  }
  return '';
}

function parseForm(req) {
  const b = req.body;
  if (!b) return {};
  if (typeof b === 'object') return b;
  const out = {};
  for (const [k, v] of new URLSearchParams(String(b))) out[k] = v;
  return out;
}

function webhookUrl(req) {
  const fixed = env('SMS_WEBHOOK_URL');
  if (fixed) return fixed;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  return `${proto}://${host}${req.url}`;
}

function validTwilioSignature(req, params) {
  const token = env('TWILIO_AUTH_TOKEN');
  const given = String(req.headers['x-twilio-signature'] || '');
  if (!token || !given) return false;
  const url = webhookUrl(req);
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', token).update(data, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function twiml(res, message) {
  const body = message
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(message)}</Message></Response>`
    : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  res.status(200);
  res.setHeader('Content-Type', 'text/xml');
  res.end(body);
}

// ---------- Supabase (PostgREST + storage via fetch, no SDK) ----------

function sb() {
  const url = env('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY');
  if (!url || !key) throw new Error('supabase env missing');
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const json = { ...headers, 'Content-Type': 'application/json' };
  return {
    async select(table, query) {
      const r = await fetch(`${url}/rest/v1/${table}?${query}`, { headers: json });
      if (!r.ok) throw new Error(`select ${table} ${r.status}`);
      return r.json();
    },
    async insert(table, row) {
      const r = await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST', headers: { ...json, Prefer: 'return=minimal' }, body: JSON.stringify(row),
      });
      if (!r.ok) throw new Error(`insert ${table} ${r.status}`);
    },
    async rpc(fn, args) {
      const r = await fetch(`${url}/rest/v1/rpc/${fn}`, {
        method: 'POST', headers: json, body: JSON.stringify(args),
      });
      const text = await r.text();
      if (!r.ok) throw new Error(`rpc ${fn} ${r.status}: ${text}`);
      return text ? JSON.parse(text) : null;
    },
    async upload(bucket, path, bytes, contentType) {
      const r = await fetch(`${url}/storage/v1/object/${bucket}/${path}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': contentType, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!r.ok) throw new Error(`upload ${path} ${r.status}`);
    },
    async signedUrl(bucket, path, expiresIn) {
      const r = await fetch(`${url}/storage/v1/object/sign/${bucket}/${path}`, {
        method: 'POST', headers: json, body: JSON.stringify({ expiresIn }),
      });
      if (!r.ok) throw new Error(`sign ${path} ${r.status}`);
      const j = await r.json();
      return `${url}/storage/v1${j.signedURL}`;
    },
  };
}

// ---------- media ----------

function extFor(contentType) {
  const m = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/heic': 'heic', 'text/plain': 'txt', 'text/vcard': 'vcf',
    'text/x-vcard': 'vcf', 'application/pdf': 'pdf',
  };
  return m[(contentType || '').split(';')[0].trim().toLowerCase()] || 'bin';
}

async function rehostMedia(db, params, messageSid) {
  const n = Math.min(parseInt(params.NumMedia || '0', 10) || 0, MAX_MEDIA);
  if (!n) return [];
  const sid = env('TWILIO_ACCOUNT_SID');
  const token = env('TWILIO_AUTH_TOKEN');
  const bucket = env('SMS_MEDIA_BUCKET') || 'voicemails';
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
  const out = [];
  for (let i = 0; i < n; i++) {
    const src = params[`MediaUrl${i}`];
    const type = params[`MediaContentType${i}`] || 'application/octet-stream';
    if (!src) continue;
    try {
      const r = await fetch(src, { headers: { Authorization: auth }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`twilio media ${r.status}`);
      const bytes = Buffer.from(await r.arrayBuffer());
      const path = `sms/${messageSid}/${i}.${extFor(type)}`;
      await db.upload(bucket, path, bytes, type);
      const url = await db.signedUrl(bucket, path, SIGNED_URL_TTL);
      out.push({ url, content_type: type, path, bytes: bytes.length });
    } catch (e) {
      console.error('sms-inbound: media', i, e.message);
      out.push({ url: null, content_type: type, error: e.message });
    }
  }
  return out;
}

// ---------- handler ----------

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }
  const p = parseForm(req);
  if (!validTwilioSignature(req, p)) {
    res.status(403).json({ ok: false, error: 'bad signature' });
    return;
  }

  const from = String(p.From || '').trim();
  const to = String(p.To || '').trim();
  const messageSid = String(p.MessageSid || p.SmsSid || '').trim();
  const bodyText = String(p.Body || '').trim();
  const upper = bodyText.toUpperCase();

  let db;
  try {
    db = sb();
  } catch (e) {
    console.error('sms-inbound:', e.message);
    return twiml(res, null);
  }
  const log = async (row) => {
    try {
      await db.insert('sms_log', {
        channel: 'sms_in', to_e164: from, provider_sid: messageSid || null, body: bodyText || null, ...row,
      });
    } catch (e) { console.error('sms-inbound: sms_log write failed', e.message); }
  };

  if (!from || !messageSid) {
    await log({ status: 'inbound_bad_payload' });
    return twiml(res, null);
  }

  // Carrier / Twilio keywords: handled upstream; never ours.
  if (RESERVED.has(upper)) {
    await log({ status: 'inbound_keyword', skip_reason: upper });
    return twiml(res, null);
  }

  try {
    const flags = await db.select('system_flags', 'select=sms_enabled&limit=1');
    if (!flags[0] || flags[0].sms_enabled !== true) {
      await log({ status: 'inbound_skipped', skip_reason: 'sms_disabled' });
      return twiml(res, 'This number isn’t open yet. Email raid@spamviking.com instead.');
    }

    // Who is this?
    let userId = null;
    let enrolled = false;
    const users = await db.select(
      'sv_users', `select=id&phone_e164=eq.${encodeURIComponent(from)}&limit=1`
    );
    if (users[0]) {
      userId = users[0].id;
    } else {
      userId = await db.rpc('enroll_phone_user', { p_e164: from });
      enrolled = true;
    }

    const command = COMMANDS.has(upper) ? upper : null;
    const media = command ? [] : await rehostMedia(db, p, messageSid);

    const payload = {
      source: 'sms',
      user_id: userId,
      enrolled,
      from_e164: from,
      to_e164: to,
      message_sid: messageSid,
      text: bodyText,
      command,
      media: media.filter((m) => m.url).map(({ url, content_type }) => ({ url, content_type })),
      received_at: new Date().toISOString(),
    };

    let handoff = 'ok';
    let replyBody = null;
    try {
      const r = await fetch(env('PHONE_INTAKE_SMS_URL') || 'https://posture-engine.vercel.app/api/phone-intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-phone-intake-secret': env('PHONE_INTAKE_SECRET') },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) {
        handoff = `intake ${r.status}`;
      } else {
        const j = await r.json().catch(() => null);
        if (j && typeof j.reply_body === 'string' && j.reply_body.trim()) {
          replyBody = j.reply_body.trim().slice(0, 1000);
        }
      }
    } catch (e) {
      handoff = e.name === 'TimeoutError' ? 'intake timeout' : e.message;
    }

    await log({
      user_id: userId,
      status: handoff === 'ok' ? 'inbound' : 'inbound_handoff_failed',
      skip_reason: command ? `command:${command}` : (enrolled ? 'enrolled' : null),
      error: handoff === 'ok' ? null : handoff,
      media: media.length ? media : null,
    });

    if (replyBody) return twiml(res, replyBody);
    // No reply_body: commands stay silent (Phone Intake acks via sms-send).
    if (command) return twiml(res, null);
    if (enrolled) {
      return twiml(res, 'SpamViking: got it. We’ll take it from here and text you how it goes. Reply BLOCK any time to stop texts.');
    }
    return twiml(res, 'SpamViking: got it — checking that now.');
  } catch (e) {
    console.error('sms-inbound:', e.message);
    await log({ status: 'inbound_failed', error: e.message });
    return twiml(res, 'SpamViking: got it. Something hiccuped on our side — we saved your message and will follow up.');
  }
}

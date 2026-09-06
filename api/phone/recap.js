// api/phone/recap.js
// Builds the post-callback email for the SV user and queues it in
// phone_recaps for Barbara to send. Idempotent per (job_id, kind).
//
// Triggers:
//   - Recording webhook: POST {job_id} when recordings.status='ready'
//   - Dispatcher: POST {job_id} after mark_callback_job for any outcome
// Header: x-phone-intake-secret
// Returns: { ok, kind, queued:boolean, reason? }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PHONE_INTAKE_SECRET,
//      RECORDING_LINK_URL (optional; default posture-engine /api/recording-link)

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.PHONE_INTAKE_SECRET;
const RECORDING_LINK_URL = process.env.RECORDING_LINK_URL || 'https://posture-engine.vercel.app/api/recording-link';

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
const insert = (table, row, prefer) => sb(table, { method: 'POST', body: JSON.stringify(row), prefer });

const pretty = e164 => /^\+1\d{10}$/.test(e164 || '') ? `${e164.slice(2, 5)}-${e164.slice(5, 8)}-${e164.slice(8)}` : (e164 || 'unknown number');
const fmtTime = (iso, tz) => {
  try { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'America/New_York' }); }
  catch { return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }); }
};

async function recordingLink(jobId) {
  try {
    const r = await fetch(`${RECORDING_LINK_URL}?slug=ph-${jobId}`, {
      headers: { 'x-phone-intake-secret': SECRET },
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j?.url || j?.signed_url || j?.link || null;
  } catch { return null; }
}

function kindFor(outcome) {
  if (!outcome) return null;
  if (outcome.startsWith('answered')) return 'recap';
  if (outcome === 'voicemail_left') return 'voicemail_left';
  if (['no_answer', 'rang_out', 'busy'].includes(outcome)) return 'no_answer';
  return null; // failed, disconnected, rejected → no email
}

function aboutNumber(profile, userCount) {
  const bits = [];
  if (profile?.line_type) bits.push(profile.line_type === 'voip' ? 'VoIP line' : `${profile.line_type} line`);
  if (profile?.playbook?.claimed_org || profile?.claimed_org) bits.push(`claims to be ${profile.playbook?.claimed_org || profile.claimed_org}`);
  if (profile?.confidence && profile.confidence !== 'low' && profile?.playbook?.opening_move) bits.push(`reported online as: ${profile.playbook.opening_move}`);
  if (userCount > 1) bits.push(`has called ${userCount} SpamViking users`);
  return bits.length ? `About this number: ${bits.join('. ')}.` : '';
}

function compose(kind, ctx) {
  const { host, number, org, minutes, at, link, refCode, about, ringSeconds } = ctx;
  const who = org ? `"${org}"` : pretty(number);
  const lines = [];
  let subject;

  if (kind === 'recap') {
    subject = minutes ? `${host} wasted ${minutes} minutes of ${who}` : `${host} called ${who} back`;
    lines.push(`Your callback to ${pretty(number)} happened at ${at}. A human answered.`);
    if (minutes) lines.push(`${host} kept them on for ${minutes} minutes.`);
    lines.push('');
    lines.push(link ? `Listen: ${link}\n(link works for 7 days)` : 'Recording is still processing — we\'ll send the link when it\'s ready.');
  } else if (kind === 'voicemail_left') {
    subject = `${host} left ${who} a message`;
    lines.push(`Nobody picked up at ${pretty(number)} at ${at}, so ${host} left a voicemail.`);
    if (refCode) lines.push(`Reference number planted: ${refCode}. If they call back asking for it, we'll know it's them.`);
  } else {
    subject = `No answer at ${pretty(number)}`;
    lines.push(`We called ${pretty(number)} at ${at}${ringSeconds ? ` and it rang about ${ringSeconds} seconds` : ''} — no answer.`);
    lines.push('Reply RETRY to try again, or STOP to never call this number.');
  }

  if (about) { lines.push(''); lines.push(about); }
  if (kind === 'recap' && refCode) { lines.push(''); lines.push(`Reference number ${host} planted: ${refCode}.`); }
  lines.push('');
  lines.push('Reply STOP and we\'ll never call this number again.');
  lines.push('');
  lines.push('— SpamViking');
  return { subject, body: lines.join('\n') };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!SECRET || req.headers['x-phone-intake-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'bad secret' });
  const { job_id } = req.body || {};
  if (!job_id) return res.status(400).json({ ok: false, error: 'job_id required' });

  try {
    const [job] = await select('callback_jobs', `id=eq.${job_id}&select=*`);
    if (!job) return res.status(404).json({ ok: false, error: 'no such job' });

    const kind = req.body.kind || kindFor(job.outcome);
    if (!kind) return res.status(200).json({ ok: true, queued: false, reason: `no email for outcome ${job.outcome || 'null'}` });

    const dup = await select('phone_recaps', `job_id=eq.${job_id}&kind=eq.${kind}&select=id`);
    if (dup.length) return res.status(200).json({ ok: true, kind, queued: false, reason: 'already queued' });

    const [user] = await select('sv_users', `id=eq.${job.user_id}&select=email,host_name`);
    const [settings] = await select('phone_settings', `user_id=eq.${job.user_id}&select=*`);
    const toggle = { recap: 'notify_recap', voicemail_left: 'notify_voicemail_left', no_answer: 'notify_no_answer' }[kind];
    if (settings && settings[toggle] === false) return res.status(200).json({ ok: true, kind, queued: false, reason: 'user opted out' });

    const [num] = await select('callback_numbers', `id=eq.${job.callback_number_id}&select=e164,caller_profile_id`);
    const [profile] = num?.caller_profile_id ? await select('caller_profile', `e164=eq.${encodeURIComponent(num.caller_profile_id)}&select=*`) : [null];
    const others = num?.e164 ? await select('callback_numbers', `e164=eq.${encodeURIComponent(num.e164)}&select=user_id`) : [];
    const userCount = new Set(others.map(o => o.user_id)).size;
    const attempts = await select('call_attempts', `job_id=eq.${job_id}&order=dial_started_at.desc&limit=1&select=ring_seconds,answered_at,dial_started_at`);
    const link = kind === 'recap' ? await recordingLink(job_id) : null;

    const ctx = {
      host: job.host_name || user?.host_name || 'Your host',
      number: num?.e164,
      org: job.caller_context?.claimed_org || profile?.claimed_org || null,
      minutes: job.minutes_used || null,
      at: fmtTime(attempts[0]?.answered_at || attempts[0]?.dial_started_at || job.scheduled_at, settings?.tz),
      link,
      refCode: job.reference_code || null,
      about: aboutNumber(profile, userCount),
      ringSeconds: attempts[0]?.ring_seconds || null,
    };
    const { subject, body } = compose(kind, ctx);

    await insert('phone_recaps', {
      user_id: job.user_id, job_id, kind, to_email: user.email, subject, body,
    }, 'return=minimal');

    return res.status(200).json({ ok: true, kind, queued: true });
  } catch (err) {
    console.error('phone-recap', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

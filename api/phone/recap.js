// api/phone/recap.js
// Builds the post-callback email for the SV user and queues it in
// phone_recaps for Barbara to send. Idempotent per (job_id, kind).
//
// Triggers:
//   - Recording webhook: POST {job_id} when recordings.status='ready'
//   - Dispatcher: POST {job_id} after mark_callback_job for any outcome
// Neither documented trigger sends an explicit `kind` — kind is always
// derived from callback_jobs.outcome (see kindFor), never taken from the
// request body. An earlier version trusted a body-supplied `kind` when
// present, which let an outcome/kind mismatch slip through and produce an
// email claiming a human answered on a call that was actually a voicemail
// drop (fixed Sep 29, 2026, Recording's report on job d60efc68).
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
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
  // Voice confirmed (Sep 29, 2026) callback_jobs.outcome for phone calls is
  // never "uncertain" — Voice only ever writes answered_human,
  // voicemail_left, answered_ivr, or a failure outcome. The 'uncertain'
  // branch that briefly lived here is dead code for this endpoint; removed
  // rather than left inert, per Voice's ask. The real ambiguous case is
  // answered_human with no proof anyone actually spoke (see `unproven`,
  // computed in the handler from the transcript) — that's a variant of
  // 'recap', not a separate kind.
  if (outcome.startsWith('answered')) return 'recap';
  if (outcome === 'voicemail_left') return 'voicemail_left';
  if (['no_answer', 'rang_out', 'busy'].includes(outcome)) return 'no_answer';
  return null; // failed, disconnected, rejected → no email
}

// answered_human is unproven when the transcript has no caller-side turns
// at all — either the backstop's zero-turns case slipped through (transcript
// capture itself failed, so there was nothing for the backstop to check),
// or a legitimately empty/missing transcript. Treated identically: no
// caller turns means no proof, regardless of why.
function hasCallerTurns(transcript) {
  return Array.isArray(transcript) && transcript.some(t => t && t.role === 'user');
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
  const { host, number, org, minutes, at, link, refCode, about, ringSeconds, unproven } = ctx;
  const who = org ? `"${org}"` : pretty(number);
  const lines = [];
  let subject;

  if (kind === 'recap' && unproven) {
    // answered_human with no confirmed caller turns (Sep 29, 2026, Voice's
    // ask) — could be a real conversation whose transcript just failed to
    // capture, a bad connection, or a fast hangup. Don't claim certainty we
    // don't have, and lead with RETRY since that's the most useful action
    // here specifically — unlike a normal recap, there's real doubt this
    // one landed at all.
    subject = `Not sure how ${host}'s call to ${who} went`;
    lines.push(`Your callback to ${pretty(number)} happened at ${at}, but we can't confirm anyone actually spoke — could be a bad connection, a fast hangup, or our own recording missing the other side.`);
    lines.push('');
    lines.push(link ? `Listen for yourself: ${link}\n(link works for 7 days)` : 'Recording is still processing — we\'ll send the link when it\'s ready.');
    lines.push('');
    lines.push('Reply RETRY to try again, SKIP to cancel any follow-up call already queued, or BLOCK to never call this number again.');
  } else if (kind === 'recap') {
    subject = minutes ? `${host} wasted ${plural(minutes, 'minute')} of ${who}` : `${host} called ${who} back`;
    lines.push(`Your callback to ${pretty(number)} happened at ${at}. A human answered.`);
    if (minutes) lines.push(`${host} kept them on for ${plural(minutes, 'minute')}.`);
    lines.push('');
    lines.push(link ? `Listen: ${link}\n(link works for 7 days)` : 'Recording is still processing — we\'ll send the link when it\'s ready.');
    // Reference-code aside removed (Sep 29, 2026, Recording's ask) — it's
    // an internal matching device with nothing for the user to act on.
  } else if (kind === 'voicemail_left') {
    subject = `${host} left a voicemail for ${pretty(number)}`;
    lines.push(`${host} called ${pretty(number)} at ${at} — nobody picked up, so he left a message in character with a callback number.`);
    lines.push('');
    lines.push(`If they call back, ${host} answers and the real time-wasting starts.`);
    if (refCode) lines.push(`Reference number planted: ${refCode}. If they call back asking for it, we'll know it's them.`);
    if (ctx.moreTouches > 0) {
      lines.push(ctx.moreTouches === 1
        ? `If we don't hear from them, ${host} will try once more over the next week.`
        : `If we don't hear from them, ${host} will try ${ctx.moreTouches} more times over the next week.`);
    } else {
      lines.push(`If we don't hear from them, that's it for this one.`);
    }
    lines.push('');
    lines.push(`Recording to follow once it's processed.`);
  } else if (kind === 'recording_ready') {
    subject = `Recording ready — ${host}'s call to ${who}`;
    lines.push(`The recording from that call is ready.`);
    lines.push('');
    lines.push(`Listen: ${link}\n(link works for 7 days)`);
  } else {
    subject = `No answer at ${pretty(number)}`;
    lines.push(`We called ${pretty(number)} at ${at}${ringSeconds ? ` and it rang about ${ringSeconds} seconds` : ''} — no answer.`);
    lines.push('Reply RETRY to try again, or BLOCK to never call this number.');
  }

  if (about && kind !== 'recording_ready') { lines.push(''); lines.push(about); }
  if (kind !== 'recording_ready' && !unproven) {
    lines.push('');
    lines.push('Reply BLOCK and we\'ll never call this number again.');
  }
  lines.push('');
  lines.push('— SpamViking');
  lines.push('');
  lines.push('---');
  lines.push(`[SV-PHONE job:${ctx.jobId}]`);
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

    // kind comes from the job's actual outcome ONLY — never from the
    // request body. See the file-header note; this is the fix for the
    // "email said a human answered on a voicemail call" bug.
    const kind = kindFor(job.outcome);
    if (!kind) return res.status(200).json({ ok: true, queued: false, reason: `no email for outcome ${job.outcome || 'null'}` });

    const [user] = await select('sv_users', `id=eq.${job.user_id}&select=email,host_name`);
    const [settings] = await select('phone_settings', `user_id=eq.${job.user_id}&select=*`);
    const toggle = { recap: 'notify_recap', voicemail_left: 'notify_voicemail_left', no_answer: 'notify_no_answer' }[kind];
    if (settings && settings[toggle] === false) return res.status(200).json({ ok: true, kind, queued: false, reason: 'user opted out' });

    const existing = await select('phone_recaps', `job_id=eq.${job_id}&kind=eq.${kind}&select=id,body`);
    if (existing.length) {
      // The recap for this job/kind already went out. If its body still
      // shows the "recording not ready yet" placeholder — either branch,
      // human-answered OR voicemail-left both promise a link "to follow" —
      // and a link is now available, this call is the recording-ready
      // follow-up webhook firing. Queue it as a DISTINCT kind so it
      // doesn't hit the guard below and get silently dropped, which was
      // the "promised follow-up never arrived" bug (Sep 29, 2026). This
      // originally only covered kind==='recap' — extended to voicemail_left
      // too once a real voicemail job (d60efc68) showed the same gap: a
      // voicemail recap also promises "recording to follow" but never
      // called recordingLink() at all.
      const awaitingLinkMarker = { recap: 'Recording is still processing', voicemail_left: 'Recording to follow once it\'s processed' }[kind];
      const awaitingLink = awaitingLinkMarker && (existing[0].body || '').includes(awaitingLinkMarker);
      if (awaitingLink) {
        const link = await recordingLink(job_id);
        if (link) {
          const already = await select('phone_recaps', `job_id=eq.${job_id}&kind=eq.recording_ready&select=id`);
          if (!already.length) {
            const [num] = await select('callback_numbers', `id=eq.${job.callback_number_id}&select=e164,caller_profile_id`);
            const [profile] = num?.caller_profile_id ? await select('caller_profile', `e164=eq.${encodeURIComponent(num.caller_profile_id)}&select=claimed_org`) : [null];
            const { subject, body } = compose('recording_ready', {
              jobId: job_id,
              host: job.host_name || user?.host_name || 'Your host',
              number: num?.e164,
              org: job.caller_context?.claimed_org || profile?.claimed_org || null,
              link,
            });
            await insert('phone_recaps', {
              user_id: job.user_id, job_id, kind: 'recording_ready', to_email: user.email, subject, body,
            }, 'return=minimal');
            return res.status(200).json({ ok: true, kind: 'recording_ready', queued: true });
          }
        }
        return res.status(200).json({ ok: true, kind, queued: false, reason: 'recording not ready yet' });
      }
      return res.status(200).json({ ok: true, kind, queued: false, reason: 'already queued' });
    }

    const [flags] = await select('system_flags', 'select=max_campaign_touches&limit=1').catch(() => [null]);
    const [num] = await select('callback_numbers', `id=eq.${job.callback_number_id}&select=e164,caller_profile_id`);
    const [profile] = num?.caller_profile_id ? await select('caller_profile', `e164=eq.${encodeURIComponent(num.caller_profile_id)}&select=*`) : [null];
    const others = num?.e164 ? await select('callback_numbers', `e164=eq.${encodeURIComponent(num.e164)}&select=user_id`) : [];
    const userCount = new Set(others.map(o => o.user_id)).size;
    const attempts = await select('call_attempts', `job_id=eq.${job_id}&order=dial_started_at.desc&limit=1&select=ring_seconds,answered_at,dial_started_at`);
    const link = kind === 'recap' ? await recordingLink(job_id) : null;

    const ctx = {
      jobId: job_id,
      host: job.host_name || user?.host_name || 'Your host',
      number: num?.e164,
      org: job.caller_context?.claimed_org || profile?.claimed_org || null,
      minutes: job.minutes_used || null,
      at: fmtTime(attempts[0]?.answered_at || attempts[0]?.dial_started_at || job.scheduled_at, settings?.tz),
      link,
      refCode: job.reference_code || null,
      about: aboutNumber(profile, userCount),
      ringSeconds: attempts[0]?.ring_seconds || null,
      moreTouches: Math.max(0, (flags?.max_campaign_touches ?? 3) - (job.campaign_touch ?? 1)),
      unproven: kind === 'recap' && !hasCallerTurns(job.transcript),
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

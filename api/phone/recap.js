// BUILD: recap v1 2026-10-07
// api/phone/recap.js
// Builds the post-callback email for the SV user and queues it in
// phone_recaps for Barbara to send. Idempotent per (job_id, kind).
//
// Triggers:
//   - Recording webhook: POST {job_id, recording_status:'ready'} when
//     recordings.status='ready' (PE adds recording_status to the body,
//     Oct 6, 2026, Recording's answer). That field IS the ready signal.
//   - Dispatcher / agent: POST {job_id} after mark_callback_job for any
//     outcome (no recording_status)
//   - recap-sweep.js: POST {job_id} for stragglers (no recording_status)
// None of these sends an explicit `kind` — kind is always
// derived from callback_jobs.outcome (see kindFor), never taken from the
// request body. An earlier version trusted a body-supplied `kind` when
// present, which let an outcome/kind mismatch slip through and produce an
// email claiming a human answered on a call that was actually a voicemail
// drop (fixed Sep 29, 2026, Recording's report on job d60efc68).
// Header: x-phone-intake-secret
// Returns: { ok, kind, queued:boolean, reason? }
//
// Recording link (Oct 6, 2026, Andrew's ruling + Recording's contract): one
// link PER CALL, no login needed. When the recording is ready we mint a
// token scoped to that one recording (POST /api/recordings-token with
// {user_id, slug:'ph-<job_id>', ttl_seconds}) and email
// https://live.spamviking.com/recordings.html?token=<token>. The slug rides
// inside the signed token. TTL = 30 days = the recordings retention window;
// if Data/PE change retention, change RECORDING_LINK_TTL_SECONDS below (the
// "link works for N days" copy follows it). Tokens can't be revoked today
// (Recording's answer) — only rotating RECORDING_TOKEN_SECRET kills them all.
// We no longer call /api/recording-link at all (Recording asked: it's
// server-to-server only and shouldn't gain a second consumer).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PHONE_INTAKE_SECRET,
//      RECORDINGS_TOKEN_URL (optional; default posture-engine
//      /api/recordings-token), RECORDINGS_PAGE_URL (optional; default
//      https://live.spamviking.com/recordings.html)

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.PHONE_INTAKE_SECRET;
const RECORDINGS_TOKEN_URL = process.env.RECORDINGS_TOKEN_URL || 'https://posture-engine.vercel.app/api/recordings-token';
const RECORDINGS_PAGE_URL = process.env.RECORDINGS_PAGE_URL || 'https://live.spamviking.com/recordings.html';
// Keep equal to the recordings retention window (30 days as of Oct 6, 2026).
const RECORDING_LINK_TTL_SECONDS = 30 * 24 * 60 * 60;
const LINK_DAYS = Math.round(RECORDING_LINK_TTL_SECONDS / 86400);

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

// Subject-line fallback when the claimed-org quote would push the subject
// past a length a mail client truncates mid-word (Oct 1, 2026, Andrew's
// report on job e9aef2b2 — 'wasted 5 minutes of "business credit issuance
// tea…'). Minutes/outcome come first either way; the org quote is the part
// that gets dropped, never truncated mid-word.
function recapSubject(host, minutes, org, number) {
  const numOrOrg = org ? `"${org}"` : pretty(number);
  let subj = minutes ? `${host} wasted ${plural(minutes, 'minute')} of ${numOrOrg}` : `${host} called ${numOrOrg} back`;
  if (subj.length > 60) {
    subj = minutes ? `${host} wasted ${plural(minutes, 'minute')} of ${pretty(number)}` : `${host} called ${pretty(number)} back`;
  }
  return subj;
}

// Mints a token scoped to this one call's recording and returns the page
// URL, or null on ANY failure (not configured, network, bad response). A
// null just means this email goes out with no mention of a recording.
async function mintRecordingLink(userId, jobId) {
  try {
    const r = await fetch(RECORDINGS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-phone-intake-secret': SECRET },
      body: JSON.stringify({ user_id: userId, slug: `ph-${jobId}`, ttl_seconds: RECORDING_LINK_TTL_SECONDS }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) { console.warn('recordings-token', r.status); return null; }
    const j = await r.json().catch(() => null);
    if (!j?.token) return null;
    return `${RECORDINGS_PAGE_URL}?token=${encodeURIComponent(j.token)}`;
  } catch (e) {
    console.warn('recordings-token failed', String(e.message || e));
    return null;
  }
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
  // answered_ivr (Oct 5, 2026): Voice's IVR navigation now writes this ONLY
  // when a phone menu answered and navigation ended with no human reached
  // (fail_reason "ivr: no human reached (<reason>)"); a person reached
  // after the menu is answered_human. So it is NOT a conversation — it
  // gets the no-answer-style email, reworded (see compose). Must be
  // checked before the startsWith('answered') catch-all below.
  if (outcome === 'answered_ivr') return 'no_answer';
  // disconnected (Oct 7, 2026, Voice's answer): SIP 404/410/604 — the number
  // is invalid / not in service, and Voice marks it dead. This is the ONLY
  // outcome we treat as "your number is dead" — our own errors and carrier
  // errors are stamped no_answer (told apart only by fail_reason text) and
  // an answered "not in service" announcement lands as failed, so none of
  // those may claim the number is bad. Same email kind as no_answer, with its
  // own wording (see compose), so the notify_no_answer toggle and the
  // one-email-per-kind rule still apply and no schema change is needed.
  if (outcome === 'disconnected') return 'no_answer';
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
  const { host, number, org, minutes, at, link, refCode, about, ringSeconds, unproven, ivr, badNumber } = ctx;
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
    if (subject.length > 60) subject = `Not sure how ${host}'s call to ${pretty(number)} went`;
    lines.push(`Your callback to ${pretty(number)} happened at ${at}, but we can't confirm anyone actually spoke — could be a bad connection, a fast hangup, or our own recording missing the other side.`);
    // One email, no promises (Oct 1, 2026, Andrew's ruling): either this
    // carries a working link or it says nothing about a recording at all —
    // never "processing," never "we'll send it when it's ready."
    if (link) { lines.push(''); lines.push(`Listen to this call: ${link}\n(link works for ${LINK_DAYS} days)`); }
    lines.push('');
    lines.push('Reply RETRY to try again, SKIP to cancel any follow-up call already queued, or BLOCK to never call this number again.');
  } else if (kind === 'recap') {
    subject = recapSubject(host, minutes, org, number);
    lines.push(`Your callback to ${pretty(number)} happened at ${at}. A human answered.`);
    if (minutes) lines.push(`${host} kept them on for ${plural(minutes, 'minute')}.`);
    if (link) { lines.push(''); lines.push(`Listen to this call: ${link}\n(link works for ${LINK_DAYS} days)`); }
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
    if (link) { lines.push(''); lines.push(`Listen to this call: ${link}\n(link works for ${LINK_DAYS} days)`); }
    // No "recording to follow" promise here either — one email, same rule.
  } else if (badNumber) {
    // Dead number (outcome disconnected). No RETRY — re-dialing a number
    // that isn't in service is pointless, and Booking never re-dials it.
    subject = `Couldn't reach ${pretty(number)}`;
    lines.push(`We tried ${pretty(number)} at ${at}, but the number isn't in service, so we couldn't reach anyone.`);
    lines.push('Nothing more for us to do on this one.');
  } else if (ivr) {
    // Menu answered, nobody reached. Not "no answer" (it did pick up) and
    // not a recap (no human). Kind stays 'no_answer' so the user's
    // notify_no_answer toggle and the one-email-per-kind rule still apply.
    subject = `Only a phone menu at ${pretty(number)}`;
    lines.push(`We called ${pretty(number)} at ${at}. A phone menu answered, and we couldn't get through to a person.`);
    lines.push('Reply RETRY to try again, or BLOCK to never call this number.');
  } else {
    subject = `No answer at ${pretty(number)}`;
    lines.push(`We called ${pretty(number)} at ${at}${ringSeconds ? ` and it rang about ${ringSeconds} seconds` : ''} — no answer.`);
    lines.push('Reply RETRY to try again, or BLOCK to never call this number.');
  }

  if (about) { lines.push(''); lines.push(about); }
  // The no_answer branches already offer BLOCK in their own RETRY/BLOCK
  // line; adding this too made those emails mention BLOCK twice.
  if (!unproven && kind !== 'no_answer') {
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
  const { job_id, recording_status } = req.body || {};
  const recordingReady = recording_status === 'ready';
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

    // One email per (job_id, kind), period — no distinct "recording_ready"
    // follow-up anymore (Oct 1, 2026, Andrew's ruling: either the one email
    // has the recording, or it says nothing about one — never a promise of
    // a later link). If we already sent this job's email, we're done.
    const existing = await select('phone_recaps', `job_id=eq.${job_id}&kind=eq.${kind}&select=id`);
    if (existing.length) {
      return res.status(200).json({ ok: true, kind, queued: false, reason: 'already queued' });
    }

    // recap and voicemail_left are the two outcomes where a recording can
    // exist at all (no_answer never produces one). The ready signal is the
    // webhook POST's recording_status:'ready' (see header) — it only fires
    // when recordings.status='ready'. Cases:
    //   - ready POST: mint the per-call token and send with the link. If
    //     minting fails, send WITHOUT a link rather than hold the email.
    //   - any other POST (hangup, sweep) within 5 minutes of hangup: hold
    //     ("awaiting recording") — the ready POST is expected to follow.
    //   - any other POST past the 5-minute fallback window: send with no
    //     recording mention rather than hold it indefinitely. recap-sweep.js
    //     covers the case where the ready POST never arrives at all.
    // Known gap (flagged, not fixed): if the ready POST ever lands BEFORE
    // the job's outcome is written, it gets "no email for outcome null"
    // above and nothing re-pokes with recording_status, so that email goes
    // out without a link after the fallback window.
    //
    // ASSUMPTION flagged, not confirmed: job.updated_at is used as "when
    // this job's outcome was written" (i.e. hangup time). If Data/PE know
    // of a more precise column (a dedicated ended_at/completed_at), swap
    // it in here and in recap-sweep.js — updated_at is a guess at what's
    // actually available, not a confirmed contract.
    const recordingEligible = kind === 'recap' || kind === 'voicemail_left';
    let link = null;
    if (recordingEligible) {
      if (recordingReady) {
        link = await mintRecordingLink(job.user_id, job_id);
      } else {
        const hangupAt = job.updated_at ? new Date(job.updated_at).getTime() : null;
        const elapsedMs = hangupAt ? Date.now() - hangupAt : Infinity;
        if (elapsedMs < 5 * 60 * 1000) {
          return res.status(200).json({ ok: true, kind, queued: false, reason: 'awaiting recording' });
        }
        // else: fallback window elapsed — fall through and send without one.
      }
    }

    const [flags] = await select('system_flags', 'select=max_campaign_touches&limit=1').catch(() => [null]);
    const [num] = await select('callback_numbers', `id=eq.${job.callback_number_id}&select=e164,caller_profile_id`);
    const [profile] = num?.caller_profile_id ? await select('caller_profile', `e164=eq.${encodeURIComponent(num.caller_profile_id)}&select=*`) : [null];
    const others = num?.e164 ? await select('callback_numbers', `e164=eq.${encodeURIComponent(num.e164)}&select=user_id`) : [];
    const userCount = new Set(others.map(o => o.user_id)).size;
    const attempts = await select('call_attempts', `job_id=eq.${job_id}&order=dial_started_at.desc&limit=1&select=ring_seconds,answered_at,dial_started_at`);

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
      ivr: job.outcome === 'answered_ivr',
      badNumber: job.outcome === 'disconnected',
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

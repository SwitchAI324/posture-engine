// api/phone/cancel.js
// Called by Barbara's Apps Script on a user reply of CANCEL/SKIP, RETRY, or
// STOP/BLOCK. Email vocabulary now shows SKIP/BLOCK to the user (matching
// SMS) while accepting the old words too — see phone-intake.md. The action
// LOGIC lives in _actions.js, shared with the SMS command path in
// intake.js; this file only owns the email reply copy and the incoming
// action names, which are UNCHANGED ('cancel'|'retry'|'stop').
//
// POST JSON: { sender_email, action?: 'cancel'|'retry'|'stop'|'number', job_id?, number? }
//   action defaults to 'cancel'. job_id optional for cancel/retry/stop (if
//   absent, resolves to the user's newest relevant job); REQUIRED for
//   'number', where it means the phone_intakes.id carried in the
//   [SV-PHONE job:<uuid>] tag on a "we heard a number but couldn't read it"
//   acknowledgement — see intake.js's needs_number status. 'number' also
//   requires `number`, the digits the user typed in their reply; anything
//   Email can find (10 digits, with or without punctuation/leading 1) is
//   fine, it's normalized/validated in _actions.js. Added Sep 29, 2026 for
//   Email's garbled-number flow.
// Header:    x-phone-intake-secret
// Returns:   { ok, action, done:boolean, reply_subject, reply_body }

import { actionCancel, actionBlock, actionRetry, actionSupplyNumber } from './_actions.js';

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.PHONE_INTAKE_SECRET;

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
const rpc = (fn, args) => sb(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

const pretty = e164 => /^\+1\d{10}$/.test(e164 || '') ? `${e164.slice(2, 5)}-${e164.slice(5, 8)}-${e164.slice(8)}` : (e164 || 'that number');
const reply = (subject, body) => ({ reply_subject: subject, reply_body: `${body}\n\n— SpamViking` });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!SECRET || req.headers['x-phone-intake-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'bad secret' });
  const { sender_email } = req.body || {};
  const action = (req.body?.action || 'cancel').toLowerCase();
  const jobIdIn = req.body?.job_id || null;
  if (!sender_email) return res.status(400).json({ ok: false, error: 'sender_email required' });
  if (!['cancel', 'retry', 'stop', 'number'].includes(action)) return res.status(400).json({ ok: false, error: 'bad action' });
  if (action === 'number' && !jobIdIn) return res.status(400).json({ ok: false, error: 'job_id required for number' });

  try {
    const userId = await rpc('user_id_by_email', { p_email: sender_email });
    if (!userId) return res.status(404).json({ ok: false, error: 'unknown sender' });

    // ---- NUMBER: user replied with a callback number after a garbled-
    // number acknowledgement. job_id here is a phone_intakes.id, not a
    // callback_jobs.id — see the header comment. ----
    if (action === 'number') {
      const numberRaw = req.body?.number;
      if (!numberRaw) return res.status(200).json({ ok: true, action, done: false, ...reply('Re: your callback number', 'We didn\'t see a number in that reply — could you send just the digits?') });
      const r = await actionSupplyNumber(userId, jobIdIn, numberRaw);
      if (!r.done) {
        if (r.reason === 'invalid_number') {
          return res.status(200).json({ ok: true, action, done: false, ...reply('Re: your callback number', 'That didn\'t come through as a callable US number — could you send just the 10 digits?') });
        }
        if (r.reason === 'blocked') {
          return res.status(200).json({ ok: true, action, done: false, ...reply('Re: your callback number', `${pretty(r.number)} is on your do-not-call list, so we won't dial it.`) });
        }
        if (r.reason === 'wrong_status') {
          return res.status(200).json({ ok: true, action, done: false, ...reply('Re: your callback number', 'That one\'s already past the point of adding a number — nothing to do here.') });
        }
        return res.status(200).json({ ok: true, action, done: false, ...reply('Re: your callback number', 'We couldn\'t match that to a pending voicemail of yours.') });
      }
      return res.status(200).json({ ok: true, action, done: true, ...reply('Re: your callback number', `Got it — we'll call ${pretty(r.number)} ${r.phrase}. Reply SKIP to stop that.`) });
    }

    // ---- SKIP (action name: cancel) ----
    if (action === 'cancel') {
      const r = await actionCancel(userId, jobIdIn);
      if (!r.done) {
        return res.status(200).json({ ok: true, action, done: false, ...reply('Re: skip', 'Nothing is waiting to be called right now, so there was nothing to skip.') });
      }
      return res.status(200).json({ ok: true, action, done: true, ...reply('Re: skip', 'Skipped. We won\'t call that number.') });
    }

    // ---- BLOCK (action name: stop) ----
    if (action === 'stop') {
      const r = await actionBlock(userId, jobIdIn);
      if (!r.done) {
        return res.status(200).json({ ok: true, action, done: false, ...reply('Re: block', 'We couldn\'t find a recent call of yours to apply that to.') });
      }
      return res.status(200).json({ ok: true, action, done: true, ...reply('Re: block', `Done. We will never call ${pretty(r.number)} again.`) });
    }

    // ---- RETRY ----
    const r = await actionRetry(userId, jobIdIn);
    if (!r.done) {
      if (r.reason === 'blocked') {
        return res.status(200).json({ ok: true, action, done: false, ...reply('Re: retry', `${pretty(r.number)} is on your do-not-call list, so we won't dial it. Forward a new voicemail if that changes.`) });
      }
      return res.status(200).json({ ok: true, action, done: false, ...reply('Re: retry', 'We couldn\'t find a recent call of yours to apply that to.') });
    }
    return res.status(200).json({ ok: true, action, done: true, ...reply('Re: retry', `On it. We'll call ${pretty(r.number)} again in about ${r.minutes} minutes. Reply SKIP to stop that.`) });
  } catch (err) {
    console.error('phone-cancel', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

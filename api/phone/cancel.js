// api/phone/cancel.js
// Called by Barbara's Apps Script on a user reply of CANCEL/SKIP, RETRY, or
// STOP/BLOCK. Email vocabulary now shows SKIP/BLOCK to the user (matching
// SMS) while accepting the old words too — see phone-intake.md. The action
// LOGIC lives in _actions.js, shared with the SMS command path in
// intake.js; this file only owns the email reply copy and the incoming
// action names, which are UNCHANGED ('cancel'|'retry'|'stop').
//
// POST JSON: { sender_email, action?: 'cancel'|'retry'|'stop', job_id? }
//   action defaults to 'cancel'. job_id optional; if absent, resolves to
//   the user's newest relevant job.
// Header:    x-phone-intake-secret
// Returns:   { ok, action, done:boolean, reply_subject, reply_body }

import { actionCancel, actionBlock, actionRetry } from './_actions.js';

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
  if (!['cancel', 'retry', 'stop'].includes(action)) return res.status(400).json({ ok: false, error: 'bad action' });

  try {
    const userId = await rpc('user_id_by_email', { p_email: sender_email });
    if (!userId) return res.status(404).json({ ok: false, error: 'unknown sender' });

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

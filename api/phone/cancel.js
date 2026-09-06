// api/phone/cancel.js
// Called by Barbara's Apps Script on a user reply of CANCEL, RETRY, or STOP.
//
// POST JSON: { sender_email, action?: 'cancel'|'retry'|'stop', job_id? }
//   action defaults to 'cancel'. job_id optional; if absent, resolves to
//   the user's newest relevant job.
// Header:    x-phone-intake-secret
// Returns:   { ok, action, done:boolean, reply_subject, reply_body }
//
// cancel → newest pending/approved job → mark_callback_job cancelled
// retry  → newest completed/failed job (or job_id) → new approved job, same
//          number, scheduled after the user's delay window
// stop   → block the number on the user's allowlist (blocked=true)
//
// Data's RPC, named args: mark_callback_job(p_job_id, p_status, p_outcome,
//   p_fail_reason, p_minutes_used)

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
const select = (table, filter) => sb(`${table}?${filter}`, { method: 'GET' });
const insert = (table, row, prefer) => sb(table, { method: 'POST', body: JSON.stringify(row), prefer });
const update = (table, filter, row) => sb(`${table}?${filter}`, { method: 'PATCH', body: JSON.stringify(row) });
const rpc = (fn, args) => sb(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
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

    // Resolve the job. A supplied job_id must belong to this user.
    const byId = jobIdIn ? await select('callback_jobs', `id=eq.${jobIdIn}&user_id=eq.${userId}&select=*`) : [];
    let job = byId[0] || null;
    if (!job) {
      const statuses = action === 'cancel' ? 'pending,approved' : 'completed,failed,cancelled';
      const rows = await select('callback_jobs', `user_id=eq.${userId}&status=in.(${statuses})&order=created_at.desc&limit=1&select=*`);
      job = rows[0] || null;
    }

    // ---- CANCEL ----
    if (action === 'cancel') {
      if (!job || !['pending', 'approved'].includes(job.status)) {
        return res.status(200).json({ ok: true, action, done: false, ...reply('Re: cancel', 'Nothing is waiting to be called right now, so there was nothing to cancel.') });
      }
      await rpc('mark_callback_job', { p_job_id: job.id, p_status: 'cancelled', p_fail_reason: 'user_cancel' });
      return res.status(200).json({ ok: true, action, done: true, ...reply('Re: cancel', 'Cancelled. We won\'t call that number.') });
    }

    if (!job) {
      return res.status(200).json({ ok: true, action, done: false, ...reply(`Re: ${action}`, 'We couldn\'t find a recent call of yours to apply that to.') });
    }
    const [num] = await select('callback_numbers', `id=eq.${job.callback_number_id}&select=id,e164,blocked`);

    // ---- STOP ----
    if (action === 'stop') {
      if (num && !num.blocked) await update('callback_numbers', `id=eq.${num.id}`, { blocked: true });
      const open = await select('callback_jobs', `callback_number_id=eq.${job.callback_number_id}&status=in.(pending,approved)&select=id`);
      for (const o of open) await rpc('mark_callback_job', { p_job_id: o.id, p_status: 'cancelled', p_fail_reason: 'user_stop' });
      return res.status(200).json({ ok: true, action, done: true, ...reply('Re: stop', `Done. We will never call ${pretty(num?.e164)} again.`) });
    }

    // ---- RETRY ----
    if (num?.blocked) {
      return res.status(200).json({ ok: true, action, done: false, ...reply('Re: retry', `${pretty(num.e164)} is on your do-not-call list, so we won't dial it. Forward a new voicemail if that changes.`) });
    }
    const [settings] = await select('phone_settings', `user_id=eq.${userId}&select=callback_delay_min,callback_delay_max`);
    const minutes = rand(settings?.callback_delay_min ?? 20, settings?.callback_delay_max ?? 60);
    await insert('callback_jobs', {
      user_id: userId, intake_id: job.intake_id, callback_number_id: job.callback_number_id,
      archetype: job.archetype, scheduled_at: new Date(Date.now() + minutes * 60000).toISOString(),
      status: 'approved', approved_at: new Date().toISOString(),
      reference_code: job.reference_code, host_name: job.host_name,
      dial_extension: job.dial_extension, ask_for: job.ask_for, caller_context: job.caller_context,
      fail_reason: `retry_of:${job.id}`,
    }, 'return=minimal');
    return res.status(200).json({ ok: true, action, done: true, ...reply('Re: retry', `On it. We'll call ${pretty(num?.e164)} again in about ${minutes} minutes. Reply CANCEL to stop that.`) });
  } catch (err) {
    console.error('phone-cancel', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

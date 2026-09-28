// api/phone/_actions.js
// Shared job-control actions: skip a pending call, block a number, retry a
// completed/failed one, or (SMS only) go — stop waiting and dial now.
// Used by BOTH cancel.js (email: action names 'cancel'/'retry'/'stop',
// copy-facing as SKIP/RETRY/BLOCK) and intake.js's SMS command handling
// (SKIP/BLOCK/RETRY/GO). These functions return facts, never reply text —
// each caller owns its own copy (email vs SMS read very differently).

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

async function resolveJob(userId, jobIdIn, kind) {
  const byId = jobIdIn ? await select('callback_jobs', `id=eq.${jobIdIn}&user_id=eq.${userId}&select=*`) : [];
  if (byId[0]) return byId[0];
  const statuses = (kind === 'pending_only') ? 'pending,approved' : 'completed,failed,cancelled';
  const rows = await select('callback_jobs', `user_id=eq.${userId}&status=in.(${statuses})&order=created_at.desc&limit=1&select=*`);
  return rows[0] || null;
}

// ---- SKIP (email: cancel): drop the newest pending/approved job ----
export async function actionCancel(userId, jobIdIn = null) {
  const job = await resolveJob(userId, jobIdIn, 'pending_only');
  if (!job || !['pending', 'approved'].includes(job.status)) {
    return { done: false, reason: 'nothing_pending' };
  }
  await rpc('mark_callback_job', { p_job_id: job.id, p_status: 'cancelled', p_fail_reason: 'user_cancel' });
  return { done: true, job };
}

// ---- BLOCK (email: stop): block the number, cancel all open jobs on it ----
export async function actionBlock(userId, jobIdIn = null) {
  const job = await resolveJob(userId, jobIdIn, 'any');
  if (!job) return { done: false, reason: 'no_recent_job' };
  const [num] = await select('callback_numbers', `id=eq.${job.callback_number_id}&select=id,e164,blocked`);
  if (num && !num.blocked) await update('callback_numbers', `id=eq.${num.id}`, { blocked: true });
  const open = await select('callback_jobs', `callback_number_id=eq.${job.callback_number_id}&status=in.(pending,approved)&select=id`);
  for (const o of open) await rpc('mark_callback_job', { p_job_id: o.id, p_status: 'cancelled', p_fail_reason: 'user_stop' });
  return { done: true, job, number: num?.e164 };
}

// ---- RETRY: schedule a fresh job for the same number ----
export async function actionRetry(userId, jobIdIn = null) {
  const job = await resolveJob(userId, jobIdIn, 'any');
  if (!job) return { done: false, reason: 'no_recent_job' };
  const [num] = await select('callback_numbers', `id=eq.${job.callback_number_id}&select=id,e164,blocked`);
  if (num?.blocked) return { done: false, reason: 'blocked', number: num.e164 };
  const [settings] = await select('phone_settings', `user_id=eq.${userId}&select=callback_delay_min,callback_delay_max`);
  const minutes = rand(settings?.callback_delay_min ?? 20, settings?.callback_delay_max ?? 60);
  await insert('callback_jobs', {
    user_id: userId, intake_id: job.intake_id, callback_number_id: job.callback_number_id,
    archetype: job.archetype, scheduled_at: new Date(Date.now() + minutes * 60000).toISOString(),
    status: 'approved', approved_at: new Date().toISOString(),
    reference_code: job.reference_code, host_name: job.host_name,
    dial_extension: job.dial_extension, ask_for: job.ask_for, caller_context: job.caller_context,
    campaign_touch: 1, campaign_parent_id: null,
    fail_reason: `retry_of:${job.id}`,
  }, 'return=minimal');
  return { done: true, number: num?.e164, minutes };
}

// ---- GO (SMS only, no email equivalent): stop waiting, dial now ----
export async function actionGo(userId, jobIdIn = null) {
  const job = await resolveJob(userId, jobIdIn, 'pending_only');
  if (!job || !['pending', 'approved'].includes(job.status)) {
    return { done: false, reason: 'nothing_pending' };
  }
  await update('callback_jobs', `id=eq.${job.id}`, { scheduled_at: new Date().toISOString() });
  const [num] = await select('callback_numbers', `id=eq.${job.callback_number_id}&select=e164`);
  return { done: true, job, number: num?.e164 };
}

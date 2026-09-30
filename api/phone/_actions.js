// api/phone/_actions.js
// Shared job-control actions: skip a pending call, block a number, retry a
// completed/failed one, or (SMS only) go — stop waiting and dial now.
// Used by BOTH cancel.js (email: action names 'cancel'/'retry'/'stop',
// copy-facing as SKIP/RETRY/BLOCK) and intake.js's SMS command handling
// (SKIP/BLOCK/RETRY/GO). These functions return facts, never reply text —
// each caller owns its own copy (email vs SMS read very differently).

import { planCallback, lineTypeFor, refCode, normalizeUsNumber } from './_schedule.js';

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SCOUT_TOKEN = process.env.SV_SCOUT_TOKEN;
const SCOUT_URL = process.env.SCOUT_PHONE_URL || 'https://posture-engine.vercel.app/api/scout/phone';
const CODE_ARCHETYPES = ['b2b_saas', 'account_access', 'gov_threat']; // reference code ON — matches intake.js

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
    reference_code: job.reference_code, reference_code_origin: job.reference_code_origin, host_name: job.host_name,
    dial_extension: job.dial_extension, ask_for: job.ask_for, caller_context: job.caller_context,
    campaign_touch: 1, campaign_parent_id: null,
    fail_reason: `retry_of:${job.id}`,
  }, 'return=minimal');
  return { done: true, number: num?.e164, minutes };
}

async function pingScout(number) {
  if (!SCOUT_TOKEN) return;
  try {
    await fetch(SCOUT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sv-scout-token': SCOUT_TOKEN },
      body: JSON.stringify({ number }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    console.warn('scout ping failed (non-blocking)', String(e.message || e));
  }
}

// ---- NUMBER (email only, no SMS/command equivalent — Sep 29, 2026, Email's
// garbled-number ask): a user replies with a callback number after a "we
// heard a number but couldn't read it cleanly" acknowledgement. Keyed off
// phone_intakes.id, NOT callback_jobs — no job exists yet at that point,
// since intake.js never got a dialable number to create one with. This is
// the one action here that CREATES a job rather than acting on an existing
// one; everything else it needs (archetype, pitch, stated hours,
// reference_number, transcript, ...) was already saved to
// phone_intakes.classification/transcript at classify time, so nothing is
// re-derived or re-run through the LLM. ----
export async function actionSupplyNumber(userId, intakeIdIn, numberRaw) {
  if (!intakeIdIn) return { done: false, reason: 'no_intake_id' };
  const number = normalizeUsNumber(numberRaw);
  if (!number) return { done: false, reason: 'invalid_number' };

  const [intake] = await select('phone_intakes', `id=eq.${intakeIdIn}&user_id=eq.${userId}&select=*`);
  if (!intake) return { done: false, reason: 'not_found' };
  if (intake.status !== 'needs_number') return { done: false, reason: 'wrong_status', status: intake.status };

  const a = intake.classification || {};

  await rpc('upsert_caller_profile', {
    p_e164: number, p_org: a.claimed_org || null, p_summary: a.script_summary || null,
    p_archetype: a.archetype || 'generic', p_src: 'intake',
  });
  await sb('callback_numbers?on_conflict=user_id,e164', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, intake_id: intake.id, e164: number, provenance: 'stated_by_reply', caller_profile_id: number }),
    prefer: 'resolution=ignore-duplicates,return=minimal',
  });
  const [gate] = await select('callback_numbers', `user_id=eq.${userId}&e164=eq.${encodeURIComponent(number)}&select=id,blocked`);
  if (!gate || gate.blocked) return { done: false, reason: 'blocked', number };

  const [account] = await select('sv_users', `id=eq.${userId}&select=host_name`);
  const [settings] = await select('phone_settings', `user_id=eq.${userId}&select=*`);
  const rules = await select('callback_time_rules', 'active=eq.true&select=*').catch(() => []);
  const lineType = await lineTypeFor(number);
  const plan = planCallback({ number, a, settings, rules, lineType });

  await insert('callback_jobs', {
    user_id: userId, intake_id: intake.id, callback_number_id: gate.id,
    archetype: a.archetype || 'generic', scheduled_at: plan.scheduledAt.toISOString(), status: 'approved',
    dial_window: plan.window, approved_at: new Date().toISOString(),
    reference_code: a.reference_number || (CODE_ARCHETYPES.includes(a.archetype) ? refCode() : null),
    reference_code_origin: a.reference_number ? 'echoed' : (CODE_ARCHETYPES.includes(a.archetype) ? 'issued' : null),
    host_name: account?.host_name || null,
    dial_extension: a.extension || null, ask_for: a.ask_for || null,
    campaign_touch: 1, campaign_parent_id: null,
    caller_context: {
      caller_name: a.agent_label || null, claimed_org: a.claimed_org || null,
      pitch: a.pitch || null, the_ask: a.the_ask || null, account_refs: a.account_refs || [],
      reference_number: a.reference_number || null,
      stated_hours: a.stated_hours || null, stated_tz: a.stated_tz || null,
      transcript: intake.transcript || null,
    },
  }, 'return=minimal');
  await update('phone_intakes', `id=eq.${intake.id}`, { status: 'queued' });
  await pingScout(number);

  return { done: true, number, phrase: plan.phrase, pastHours: plan.pastHours, extension: a.extension || null, askFor: a.ask_for || null };
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

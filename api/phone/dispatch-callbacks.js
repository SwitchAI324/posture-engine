// /api/phone/dispatch-callbacks  — the phone callback dispatcher.
//
// Vercel cron (every minute). Picks a due, approved callback_job, checks
// can_dial(), mints a MINIMAL booking_tokens row (so the agent can hydrate the
// in-character host off the slug), then dispatches the LiveKit agent DIRECTLY
// via the server SDK (no intermediate outbound HTTP service). The agent dials,
// runs the call, and marks the final outcome itself at hangup.
//
// Handoff (Voice's ruling): the cron does NOT call an outbound function — it
// createDispatch()es the "spamviking" agent into room ph-<job_id> with the job
// metadata. The agent hydrates from the slug ~2s later and places the call.
//
// STATUS OWNERSHIP:
//   - cron marks 'dialing' after a successful createDispatch.
//   - cron marks 'failed' ONLY if createDispatch itself throws.
//   - the AGENT calls mark_callback_job at hangup on EVERY path (answered,
//     voicemail, no answer, crash) — so the cron never marks completed/failed.
//
// FREE-TIER: the agent is on LiveKit's free tier = 1 concurrent agent. So we
// dispatch at most ONE job per run AND skip if a job is already in flight
// ('dialing'), so overlapping cron ticks can't start a second agent. A job stuck
// dialing >30min (crashed agent) is reaped so it can't wedge the queue forever.
//
// ACCEPTED GAP (Voice, no action): the same 'spamviking' agent also serves booked
// WEB calls, which the cron can't see. So a phone dispatch during a live web call
// may fail at LiveKit (free-tier limit). Known and accepted for now.
//
// can_dial (Phone Intake, CONFIRMED): rpc/can_dial(p_job uuid) -> text; null =
// clear; else a reason (no_job|number_blocked|tenant_mismatch|no_settings|
// not_approved|minute_cap). Non-null => mark failed with that reason.
//
// Writes go through mark_callback_job (named args) which satisfies Data's
// app.system_write guard inside its own body.

import { AgentDispatchClient } from 'livekit-server-sdk';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;               // set by Vercel cron
const DISPATCH_SECRET = process.env.DISPATCH_SECRET;       // for manual test calls
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const AGENT_NAME = 'spamviking';

const sb = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

// ── is an agent already in flight? (free tier = 1 concurrent). A job stuck in
//    'dialing' means a call is live; skip this run so we never start a second.
// ── free-tier concurrency: is a live agent blocking the queue? A job in
//    'dialing' means a call is (or was) in flight. If it's been dialing < the
//    stale window, an agent is genuinely live -> block this run. If it's been
//    dialing longer (agent crashed without marking), fail it and PROCEED so a
//    dead agent can't wedge the queue forever.
//    Reads status_changed_at as the "entered dialing" time — mark_callback_job
//    stamps it on every status change (only on status change, so a mid-call
//    write like minutes_used can't reset the stale clock and hide a stuck job).
const STALE_MINUTES = 30;
const STALE_TS_COL = 'status_changed_at';
async function agentBusy() {
  const url =
    `${SUPABASE_URL}/rest/v1/callback_jobs` +
    `?status=eq.dialing&order=${STALE_TS_COL}.asc&limit=1` +
    `&select=id,${STALE_TS_COL}`;
  const r = await fetch(url, { headers: { ...sb, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`agentBusy ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rows = await r.json();
  if (rows.length === 0) return false;                 // queue clear

  const job = rows[0];
  const ts = job[STALE_TS_COL] ? new Date(job[STALE_TS_COL]).getTime() : 0;
  const ageMin = ts ? (Date.now() - ts) / 60000 : Infinity;
  if (ageMin > STALE_MINUTES) {
    // crashed agent — reap it and let the run continue
    try { await markJob(job.id, 'failed', 'failed', 'dialing timeout'); } catch (e) {}
    return false;
  }
  return true;                                         // a live agent is dialing
}

// ── the single oldest due + approved job (one per run for the free tier).
async function nextDueJob() {
  const nowIso = new Date().toISOString();
  const url =
    `${SUPABASE_URL}/rest/v1/callback_jobs` +
    `?status=eq.approved` +
    `&scheduled_at=lte.${encodeURIComponent(nowIso)}` +
    `&order=scheduled_at.asc` +
    `&limit=1` +
    `&select=id,callback_number_id,archetype,host_name,target_id,e164,scheduled_at,status`;
  const r = await fetch(url, { headers: { ...sb, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`nextDueJob ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rows = await r.json();
  return rows[0] || null;
}

// ── mark_callback_job (named args; p_outcome sits BETWEEN status and fail_reason).
async function markJob(jobId, status, outcome, failReason) {
  const body = { p_job_id: jobId, p_status: status };
  if (outcome !== undefined && outcome !== null) body.p_outcome = outcome;
  if (failReason !== undefined && failReason !== null) body.p_fail_reason = failReason;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/mark_callback_job`, {
    method: 'POST',
    headers: { ...sb, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`markJob ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return true;
}

// ── can_dial (CONFIRMED shape). null/empty => clear; non-null => reason.
async function canDial(jobId) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/can_dial`, {
    method: 'POST',
    headers: { ...sb, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_job: jobId }),
  });
  if (!r.ok) return { ok: false, reason: `can_dial_error_${r.status}` };
  let reason = null;
  try { reason = await r.json(); } catch (e) { reason = null; }
  if (reason === null || reason === '' || reason === false) return { ok: true };
  return { ok: false, reason: String(reason) };
}

// ── mint the minimal booking_tokens row the agent hydrates off. BARE fields
//    hydrate needs + channel classification. Deterministic slug per job.
async function mintPhoneToken(job) {
  const slug = 'ph-' + job.id;
  const row = {
    slug,
    channel: 'phone',
    archetype: job.archetype || null,
    host_name: job.host_name || null,
    target_id: job.target_id || null,
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/booking_tokens?on_conflict=slug`, {
    method: 'POST',
    headers: {
      ...sb,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`mintPhoneToken ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return slug;
}

// ── dispatch the LiveKit agent directly (Voice's mechanism). Room ph-<job_id>,
//    agent "spamviking", job metadata carried in the dispatch.
async function dispatchAgent(job, slug) {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    throw new Error('LIVEKIT env missing');
  }
  const client = new AgentDispatchClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  await client.createDispatch(slug, AGENT_NAME, {
    metadata: JSON.stringify({
      job_id: job.id,
      slug,
      e164: job.e164,
      callback_number_id: job.callback_number_id,
    }),
  });
  return true;
}

function authorized(req) {
  const auth = req.headers['authorization'] || '';
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  if (DISPATCH_SECRET && req.headers['x-dispatch-secret'] === DISPATCH_SECRET) return true;
  return !CRON_SECRET && !DISPATCH_SECRET; // dev: allow if no secret configured
}

export default async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env missing' });
  }

  try {
    // free-tier: never start a second agent while one is live
    if (await agentBusy()) {
      return res.status(200).json({ ok: true, skipped: 'agent_busy' });
    }

    const job = await nextDueJob();
    if (!job) return res.status(200).json({ ok: true, picked: 0 });

    // can_dial guard
    const gate = await canDial(job.id);
    if (!gate.ok) {
      await markJob(job.id, 'failed', 'failed', gate.reason || 'can_dial_declined');
      return res.status(200).json({ ok: true, id: job.id, action: 'failed', reason: gate.reason });
    }

    // mint BEFORE dispatch (agent hydrates off the slug ~2s later)
    const slug = await mintPhoneToken(job);

    // dispatch the agent. Only a createDispatch throw is the cron's to fail;
    // the agent owns completed/failed from here (marks at hangup on every path).
    try {
      await dispatchAgent(job, slug);
    } catch (e) {
      await markJob(job.id, 'failed', 'failed', `dispatch_error: ${String(e.message || e).slice(0, 120)}`);
      return res.status(200).json({ ok: false, id: job.id, action: 'failed', detail: String(e.message || e) });
    }

    await markJob(job.id, 'dialing');
    return res.status(200).json({ ok: true, id: job.id, action: 'dialing', room: slug });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

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

const { AgentDispatchClient, RoomServiceClient } = require('livekit-server-sdk');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;               // set by Vercel cron
const DISPATCH_SECRET = process.env.DISPATCH_SECRET;       // for manual test calls
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const AGENT_NAME = process.env.LIVEKIT_AGENT_NAME || 'spamviking';
const PHONE_INTAKE_SECRET = process.env.PHONE_INTAKE_SECRET;
const RECAP_URL = process.env.PHONE_RECAP_URL || 'https://posture-engine.vercel.app/api/phone/recap';
const PICK_TIME_URL = process.env.PHONE_PICK_TIME_URL || 'https://posture-engine.vercel.app/api/phone/pick-time';

// Supabase service-role auth headers. Declared here (before any function that
// uses it) — const is NOT hoisted, so a function calling `sb` before this line
// would throw "Cannot access 'sb' before initialization".
const sb = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

// After the dispatcher marks a FINAL outcome (its 'failed' paths — agent never
// ran, so the agent won't send its own recap), ping the recap route. Idempotent
// + decides internally whether an email is due, so fire-and-forget is safe. NOT
// fired on 'dialing' (not final — the agent marks the real outcome at hangup and
// fires recap there). The agent owns recap for all normal calls; this covers only
// the dispatcher-marked failures.
function recapPing(jobId) {
  try {
    fetch(RECAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-phone-intake-secret': PHONE_INTAKE_SECRET || '' },
      body: JSON.stringify({ job_id: jobId }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) {}
}

// GLOBAL KILL SWITCH — DB-backed so it's flippable instantly via SQL, no deploy
// (an env var would need a redeploy, wrong for a safety switch). The dispatcher
// reads it every run. Flag lives in system_flags.dispatch_enabled (Data). Fails
// SAFE: if the read errors or returns no flag, dialing stays OFF.
const KILL_TABLE = process.env.DISPATCH_FLAG_TABLE || 'system_flags';
const KILL_COL = process.env.DISPATCH_FLAG_COL || 'dispatch_enabled';
async function dispatchEnabled() {
  try {
    const url = `${SUPABASE_URL}/rest/v1/${KILL_TABLE}?select=${KILL_COL}&limit=1`;
    const r = await fetch(url, { headers: { ...sb, Accept: 'application/json' } });
    if (!r.ok) return false;                 // fail safe: no flag readable => off
    const rows = await r.json();
    if (!rows.length) return false;
    return rows[0][KILL_COL] === true;
  } catch (e) {
    return false;                            // fail safe on any error
  }
}

// ── LiveKit-level concurrency check
//    busy-guard below only sees PHONE jobs in 'dialing' — it can't see live WEB
//    calls. So also ask LiveKit directly: if any sv-* (web) or ph-* (phone) room
//    is active, skip this tick. Best-effort; on error we fall through to the DB
//    guard rather than block dialing entirely.
async function liveKitBusy() {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return false;
  try {
    const rs = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
    const rooms = await rs.listRooms();
    return (rooms || []).some((r) => {
      const n = r && r.name ? String(r.name) : '';
      return (n.startsWith('sv-') || n.startsWith('ph-')) &&
        (r.numParticipants > 0 || r.numPublishers > 0);
    });
  } catch (e) {
    return false; // don't let a listRooms hiccup wedge the queue
  }
}

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
    try { await markJob(job.id, 'failed', 'failed', 'dialing timeout'); recapPing(job.id); } catch (e) {}
    return false;
  }
  return true;                                         // a live agent is dialing
}

// ── the single oldest due + approved job (one per run for the free tier). The
//    phone number lives on callback_numbers (FK callback_number_id), so embed it
//    via PostgREST. target_id is NOT on callback_jobs, so it's not selected.
async function nextDueJob() {
  const nowIso = new Date().toISOString();
  const url =
    `${SUPABASE_URL}/rest/v1/callback_jobs` +
    `?status=eq.approved` +
    `&scheduled_at=lte.${encodeURIComponent(nowIso)}` +
    `&order=scheduled_at.asc` +
    `&limit=1` +
    `&select=id,user_id,callback_number_id,archetype,host_name,reference_code,dial_extension,ask_for,scheduled_at,status,callback_numbers(e164,blocked),sv_users(email)`;
  const r = await fetch(url, { headers: { ...sb, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`nextDueJob ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const rows = await r.json();
  const job = rows[0];
  if (!job) return null;
  // flatten the embedded number for convenience
  job.e164 = job.callback_numbers ? job.callback_numbers.e164 : null;
  job.owner_email = job.sv_users ? job.sv_users.email : null;   // for host_config voice resolution
  return job;
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
    // booking_tokens.target_email is NOT NULL (built for the web flow, which
    // always has a scammer email). A phone callback has a NUMBER, not an email,
    // so we set a synthetic, unique, obviously-not-real placeholder — greppable
    // as a phone-origin token and safe from collisions.
    target_email: `phone+${job.id}@sv.local`,
    archetype: job.archetype || null,
    host_name: job.host_name || null,
    target_id: null,   // callback_jobs has no target_id; hydrate degrades safely
    owner_email: job.owner_email || null,   // host_config voice dials resolve by this
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

// ── NO-ANSWER RETRY: when a call ends outcome='no_answer', re-arm it up to 2
//    retries (3 total dials) via Data's retry_callback_job RPC, which owns the
//    cap + attempt_count (we never touch attempt_count). Spacing is retry-number
//    aware: retry 1 = +2h, retry 2 = +1d (read attempt_count to pick it). Timing
//    goes through pick-time (plausible hour, avoids the hour it just failed at).
//    voicemail_left is NOT here — the campaign handles that.
//
//    Idempotency: filter status='completed' — a re-armed job flips to 'approved'
//    (outcome may stay stale 'no_answer'), so it won't re-match and double-bump.
//    attempt_count < 2 excludes already-capped jobs so we don't spam the RPC.
const RETRY_1_HOURS = 2;    // first retry: +2h
const RETRY_2_HOURS = 24;   // second retry: +1d
async function retryScan() {
  const url =
    `${SUPABASE_URL}/rest/v1/callback_jobs` +
    `?outcome=eq.no_answer&status=eq.completed&attempt_count=lt.2` +
    `&order=status_changed_at.asc&limit=25` +
    `&select=id,callback_number_id,scheduled_at,attempt_count`;
  const r = await fetch(url, { headers: { ...sb, Accept: 'application/json' } });
  if (!r.ok) return { rearmed: 0 };
  const jobs = await r.json();
  let rearmed = 0;

  for (const job of jobs) {
    try {
      const addHours = (job.attempt_count || 0) === 0 ? RETRY_1_HOURS : RETRY_2_HOURS;
      const base = new Date(job.scheduled_at || Date.now());
      const afterDate = new Date(base.getTime() + addHours * 3600000);

      // plausible time via pick-time; ok:false (dead/blocked) => don't retry (stop)
      let scheduledAt = null;
      try {
        const pt = await fetch(PICK_TIME_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-phone-intake-secret': PHONE_INTAKE_SECRET || '' },
          body: JSON.stringify({
            callback_number_id: job.callback_number_id,
            after_date: afterDate.toISOString(),
            avoid_after: base.toISOString(),
          }),
        });
        const pj = await pt.json().catch(() => ({}));
        if (!pj || pj.ok !== true || !pj.scheduled_at) continue; // dead/blocked/bad => stop
        scheduledAt = pj.scheduled_at;
      } catch (e) { continue; } // pick-time unreachable => retry next tick

      // re-arm via the guarded RPC (it caps at <2 and bumps attempt_count itself)
      const rr = await fetch(`${SUPABASE_URL}/rest/v1/rpc/retry_callback_job`, {
        method: 'POST',
        headers: { ...sb, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_job_id: job.id, p_next_scheduled_at: scheduledAt }),
      });
      if (rr.ok) {
        let out = null;
        try { out = await rr.json(); } catch (e) {}
        if (out === 're_armed') rearmed++;   // 'capped' / 'not_found' => nothing to do
      }
    } catch (e) { /* skip this job, continue */ }
  }
  return { rearmed };
}

function authorized(req) {
  const auth = req.headers['authorization'] || '';
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  if (DISPATCH_SECRET && req.headers['x-dispatch-secret'] === DISPATCH_SECRET) return true;
  return !CRON_SECRET && !DISPATCH_SECRET; // dev: allow if no secret configured
}

// ── VOICEMAIL CAMPAIGN: after a job ends outcome='voicemail_left', spawn the
//    next touch (leave another voicemail days later) up to max_campaign_touches.
//    Runs every cron tick as its own scan (the AGENT marks voicemail_left at
//    hangup, not us, so we can't hook it inline — we detect it here). Inserts
//    are NOT guarded, so a plain insert works; we never re-arm via this path.
//
//    Idempotent: only spawns if no next-touch child already exists for the chain.
//    Stop conditions (spec): touch cap; any 'answered*' outcome ever on this
//    number (a human ended it); caller_profile.status='dead' or number blocked.
//
//    TIME-OF-DAY: next-touch send time comes from Phone Intake's /api/phone/
//    pick-time (tz-aware plausible window in the scammer's zone), asked for the
//    day touch-1+N and told to AVOID the previous touch's local hour so touches
//    differ. pick-time returning {ok:false} (dead/blocked number) STOPS the
//    campaign.
async function campaignScan() {
  // system_flags campaign config (with safe defaults). Spacing is now in HOURS
  // from touch-1's scheduled_at (_hours columns supersede the old _days).
  let maxTouches = 3, t2hours = 72, t3hours = 192;
  try {
    const f = await fetch(
      `${SUPABASE_URL}/rest/v1/system_flags?select=max_campaign_touches,campaign_touch2_hours,campaign_touch3_hours&limit=1`,
      { headers: { ...sb, Accept: 'application/json' } });
    if (f.ok) { const r = (await f.json())[0] || {};
      if (Number.isFinite(r.max_campaign_touches)) maxTouches = r.max_campaign_touches;
      if (Number.isFinite(r.campaign_touch2_hours)) t2hours = r.campaign_touch2_hours;
      if (Number.isFinite(r.campaign_touch3_hours)) t3hours = r.campaign_touch3_hours;
    }
  } catch (e) { /* defaults */ }

  // jobs that just left a voicemail and are under the touch cap
  const url =
    `${SUPABASE_URL}/rest/v1/callback_jobs` +
    `?outcome=eq.voicemail_left` +
    `&campaign_touch=lt.${maxTouches}` +
    `&order=created_at.desc&limit=25` +
    `&select=id,user_id,intake_id,callback_number_id,archetype,reference_code,host_name,dial_extension,ask_for,caller_context,campaign_touch,campaign_parent_id,scheduled_at,callback_numbers(e164,blocked)`;
  const r = await fetch(url, { headers: { ...sb, Accept: 'application/json' } });
  if (!r.ok) return { spawned: 0 };
  const jobs = await r.json();
  let spawned = 0;

  for (const job of jobs) {
    try {
      const chainRoot = job.campaign_parent_id || job.id;
      const nextTouch = (job.campaign_touch || 1) + 1;

      // idempotency: skip if this chain already has the next touch
      const kids = await fetch(
        `${SUPABASE_URL}/rest/v1/callback_jobs?campaign_parent_id=eq.${chainRoot}&campaign_touch=eq.${nextTouch}&select=id&limit=1`,
        { headers: { ...sb, Accept: 'application/json' } });
      if (kids.ok && (await kids.json()).length > 0) continue;

      // STOP: number blocked
      if (job.callback_numbers && job.callback_numbers.blocked) continue;

      // STOP: any 'answered*' outcome ever on this number (a human ended it)
      const ans = await fetch(
        `${SUPABASE_URL}/rest/v1/callback_jobs?callback_number_id=eq.${job.callback_number_id}&outcome=like.answered*&select=id&limit=1`,
        { headers: { ...sb, Accept: 'application/json' } });
      if (ans.ok && (await ans.json()).length > 0) continue;

      // STOP: caller_profile.status='dead' for this number (best-effort)
      if (job.callback_numbers && job.callback_numbers.e164) {
        try {
          const cp = await fetch(
            `${SUPABASE_URL}/rest/v1/caller_profile?e164=eq.${encodeURIComponent(job.callback_numbers.e164)}&select=status&limit=1`,
            { headers: { ...sb, Accept: 'application/json' } });
          if (cp.ok) { const p = (await cp.json())[0]; if (p && p.status === 'dead') continue; }
        } catch (e) { /* profile unreachable -> don't block the campaign */ }
      }

      // target time for the next touch: touch-1's scheduled_at + N hours
      const addHours = nextTouch === 2 ? t2hours : t3hours;
      const base = new Date(job.scheduled_at || Date.now());
      const afterDate = new Date(base.getTime() + addHours * 3600000);

      // ask Phone Intake's pick-time for a plausible send time in the scammer's
      // window, on/after afterDate, avoiding the PREVIOUS touch's local hour. Pass
      // avoid_after (previous scheduled_at) and let pick-time convert to the
      // scammer's local hour — it owns the zone resolution. ok:false = STOP the
      // campaign (dead/blocked number), not a retry.
      let scheduledAt = null;
      let windowOut = null;
      try {
        const pt = await fetch(PICK_TIME_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-phone-intake-secret': PHONE_INTAKE_SECRET || '' },
          body: JSON.stringify({
            callback_number_id: job.callback_number_id,
            after_date: afterDate.toISOString(),
            avoid_after: base.toISOString(),   // previous touch's scheduled_at; PI converts to local hour
          }),
        });
        const pj = await pt.json().catch(() => ({}));
        if (!pj || pj.ok !== true || !pj.scheduled_at) continue; // ok:false or bad => STOP
        scheduledAt = pj.scheduled_at;
        windowOut = pj.window || null;         // carry tz forward for the NEXT touch
      } catch (e) { continue; } // pick-time unreachable => don't spawn this tick, retry next

      // insert the next touch (unguarded insert per Data). Stamp the returned
      // window onto dial_window so tz is available when THIS touch spawns the next.
      const ins = await fetch(`${SUPABASE_URL}/rest/v1/callback_jobs`, {
        method: 'POST',
        headers: { ...sb, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({
          user_id: job.user_id,
          intake_id: job.intake_id,
          callback_number_id: job.callback_number_id,
          archetype: job.archetype,
          reference_code: job.reference_code,
          host_name: job.host_name,
          dial_extension: job.dial_extension,
          ask_for: job.ask_for,
          caller_context: job.caller_context,
          campaign_touch: nextTouch,
          campaign_parent_id: chainRoot,
          status: 'approved',
          approved_at: new Date().toISOString(),
          scheduled_at: scheduledAt,
          dial_window: windowOut,              // tz carries down the chain
        }),
      });
      if (ins.ok) spawned++;
    } catch (e) { /* skip this job, continue the scan */ }
  }
  return { spawned };
}

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env missing' });
  }
  // global kill switch (DB-backed, read every run). Off unless explicitly true.
  if (!(await dispatchEnabled())) {
    return res.status(200).json({ ok: true, skipped: 'dispatch_disabled' });
  }

  try {
    // Voicemail campaign + no-answer retry: spawn next touches / re-arm no_answer
    // jobs. Run every tick regardless of busy state (they only schedule FUTURE
    // jobs, dial nothing). Wrapped so a hiccup never blocks dispatching.
    let campaign = { spawned: 0 };
    try { campaign = await campaignScan(); } catch (e) { campaign = { spawned: 0, error: String(e.message || e) }; }
    let retry = { rearmed: 0 };
    try { retry = await retryScan(); } catch (e) { retry = { rearmed: 0, error: String(e.message || e) }; }

    // free-tier concurrency: skip if a live LiveKit room (web sv-* OR phone ph-*)
    // is active, OR a phone job is still in 'dialing'. The LiveKit check covers
    // web calls the DB can't see; the DB check has the 30-min stale reaper.
    if (await liveKitBusy()) {
      return res.status(200).json({ ok: true, skipped: 'livekit_busy', campaign, retry });
    }
    if (await agentBusy()) {
      return res.status(200).json({ ok: true, skipped: 'agent_busy', campaign, retry });
    }

    const job = await nextDueJob();
    if (!job) return res.status(200).json({ ok: true, picked: 0, campaign, retry });

    // can_dial guard
    const gate = await canDial(job.id);
    if (!gate.ok) {
      await markJob(job.id, 'failed', 'failed', gate.reason || 'can_dial_declined');
      recapPing(job.id);
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
      recapPing(job.id);
      return res.status(200).json({ ok: false, id: job.id, action: 'failed', detail: String(e.message || e) });
    }

    await markJob(job.id, 'dialing');
    return res.status(200).json({ ok: true, id: job.id, action: 'dialing', room: slug, campaign, retry });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
};

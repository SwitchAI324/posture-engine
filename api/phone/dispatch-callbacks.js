// GET/POST /api/phone/dispatch-callbacks  — the phone callback dispatcher.
//
// Runs on a Vercel cron (every minute). Picks callback_jobs that are due and
// approved, checks can_dial() for each, mints a MINIMAL booking_tokens row
// (slug/archetype/host_name/target_id only — hydrate needs some token row to
// build the cached CORE prefix), hands the slug + number to Voice's outbound
// function, and marks status via the mark_callback_job RPC (guard satisfied
// inside the RPC). Phone-specific data (dial_extension, ask_for, phone_mode,
// amd, etc.) does NOT ride the token — Voice stamps it fresh per completion via
// the metadata channel.
//
// Scope (self-call test to Andrew's own number, host talks in character):
//   due approved jobs -> can_dial -> mint minimal token -> POST Voice(slug,number)
//   -> mark_callback_job. Voice hydrates off the slug for the compiled host.
//
// TWO EXTERNAL CONTRACTS are isolated as single-point adapters below —
// canDial() (CONFIRMED: p_job) and handToVoice() (URL/auth TBC by Voice).
//
// Cron auth: Vercel cron sends a bearer with CRON_SECRET when set; we also
// accept a manual call carrying x-dispatch-secret for hand-testing.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;               // set by Vercel cron
const DISPATCH_SECRET = process.env.DISPATCH_SECRET;       // for manual test calls
const VOICE_OUTBOUND_URL = process.env.VOICE_OUTBOUND_URL; // Voice's outbound function
const VOICE_OUTBOUND_SECRET = process.env.VOICE_OUTBOUND_SECRET;
const MAX_PER_RUN = Number(process.env.DISPATCH_MAX_PER_RUN || 5);

const sb = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };

// ── read: due + approved jobs (service-role REST read; callback_jobs reads are
//    not write-guarded). Oldest-due first, capped per run.
async function dueJobs() {
  const nowIso = new Date().toISOString();
  const url =
    `${SUPABASE_URL}/rest/v1/callback_jobs` +
    `?status=eq.approved` +
    `&scheduled_at=lte.${encodeURIComponent(nowIso)}` +
    `&order=scheduled_at.asc` +
    `&limit=${MAX_PER_RUN}` +
    `&select=id,callback_number_id,archetype,host_name,target_id,e164,scheduled_at,status`;
  const r = await fetch(url, { headers: { ...sb, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`dueJobs ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// ── write: status via the guarded RPC. NAMED args always — p_outcome sits
//    between p_status and p_fail_reason, so positional would misplace things.
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

// ── ADAPTER 1: can_dial (Phone Intake — CONFIRMED).
//    rpc/can_dial(p_job uuid) returns text: null = clear to dial; otherwise a
//    reason string (no_job | number_blocked | tenant_mismatch | no_settings |
//    not_approved | minute_cap). Any non-null => don't dial, mark failed with it.
//    Returns { ok:true } to dial, or { ok:false, reason } to skip+fail.
async function canDial(jobId) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/can_dial`, {
    method: 'POST',
    headers: { ...sb, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_job: jobId }),
  });
  if (!r.ok) {
    // treat an errored guard as "do not dial" (fail safe), with the error as reason
    return { ok: false, reason: `can_dial_error_${r.status}` };
  }
  // PostgREST returns the scalar directly for a function returning text
  let reason = null;
  try { reason = await r.json(); } catch (e) { reason = null; }
  if (reason === null || reason === '' || reason === false) return { ok: true };
  return { ok: false, reason: String(reason) };
}

// ── mint a minimal booking_tokens row so the phone call rides the SAME hydrate
//    path web calls use (hydrate needs SOME booking_tokens row to build the
//    cached CORE prefix — that's structural). BARE MINIMUM only: slug, archetype,
//    host_name, and target_id if the job genuinely has one (null-safe in hydrate
//    otherwise). Everything phone-specific (dial_extension, ask_for, phone_mode,
//    callback_number, amd, job_id) does NOT go here — Voice stamps that fresh on
//    every completion via the metadata channel. Slug is deterministic per job so
//    a re-run reuses the row instead of duplicating.
async function mintPhoneToken(job) {
  const slug = 'ph-' + job.id;
  const row = {
    slug,
    channel: 'phone',                    // row classification (Mead Hall / reporting /
                                         // phone-vs-web queries); hydrate ignores it
    archetype: job.archetype || null,
    host_name: job.host_name || null,
    target_id: job.target_id || null,   // null if phone intake has no real target
  };
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/booking_tokens?on_conflict=slug`,
    {
      method: 'POST',
      headers: {
        ...sb,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    }
  );
  if (!r.ok) throw new Error(`mintPhoneToken ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return slug;
}

// ── ADAPTER 2: hand to Voice's outbound function (Voice contract — CONFIRM
//    URL + AUTH). Target architecture: dispatch carries the SLUG; Voice hydrates
//    (/api/hydrate?slug=...) for host_name/archetype/prompt, same as web. We
//    also pass the number + job_id so Voice can place the call and report back.
async function handToVoice(job, slug) {
  if (!VOICE_OUTBOUND_URL) throw new Error('VOICE_OUTBOUND_URL not set');
  const r = await fetch(VOICE_OUTBOUND_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-voice-secret': VOICE_OUTBOUND_SECRET || '',
    },
    body: JSON.stringify({
      job_id: job.id,
      slug: slug,                            // Voice hydrates off this
      e164: job.e164 || null,                // the number to dial
      callback_number_id: job.callback_number_id,
    }),
  });
  if (!r.ok) throw new Error(`voice ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return true;
}

function authorized(req) {
  const auth = req.headers['authorization'] || '';
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;         // Vercel cron
  if (DISPATCH_SECRET && req.headers['x-dispatch-secret'] === DISPATCH_SECRET) return true; // manual
  // if neither secret is configured, allow (dev) — tighten by setting a secret
  return !CRON_SECRET && !DISPATCH_SECRET;
}

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env missing' });
  }

  const summary = { picked: 0, dialed: 0, skipped: 0, errors: 0, results: [] };
  try {
    const jobs = await dueJobs();
    summary.picked = jobs.length;

    for (const job of jobs) {
      try {
        const gate = await canDial(job.id);
        if (!gate.ok) {
          await markJob(job.id, 'failed', null, gate.reason || 'can_dial_declined');
          summary.skipped++;
          summary.results.push({ id: job.id, action: 'failed', reason: gate.reason });
          continue;
        }
        // mint the minimal token so Voice can hydrate the in-character host,
        // then hand off the slug + number. Order: mint -> hand to Voice ->
        // mark dialing only after Voice accepts, so a failure leaves it re-pickable.
        const slug = await mintPhoneToken(job);
        await handToVoice(job, slug);
        await markJob(job.id, 'dialing');
        summary.dialed++;
        summary.results.push({ id: job.id, action: 'dialing' });
      } catch (e) {
        summary.errors++;
        summary.results.push({ id: job.id, action: 'error', detail: String(e.message || e) });
        // best-effort: mark failed so a hard error doesn't wedge the job forever
        try { await markJob(job.id, 'failed', null, `dispatch_error: ${String(e.message || e).slice(0, 120)}`); } catch (e2) {}
      }
    }
    return res.status(200).json({ ok: true, ...summary });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e), ...summary });
  }
};

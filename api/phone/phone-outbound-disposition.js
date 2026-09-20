// api/phone/outbound-disposition.js
// ----------------------------------------------------------------------
// FILE LOCATION: this file goes in api/phone/, alongside cancel.js.
// _disposition.js is the single shared copy at api/_disposition.js
// (same folder as calls.js, which also imports it as "./_disposition.js")
// — NOT duplicated into api/phone/. That's why the import below is
// "../_disposition.js" (up one level from api/phone/ to api/), not
// "./_disposition.js". Two different relative paths pointing at one
// shared file living in two different places is exactly what broke the
// api/bits deploy (Vercel: "referencing unsupported modules" on
// api/calls.js's own "./_disposition.js", which resolved to a
// nonexistent api/_disposition.js once the real file only existed under
// api/phone/).
//
// POST /api/phone/outbound-disposition
// Header: x-phone-intake-secret: <PHONE_INTAKE_SECRET>
// Body:   { job_id }
//
// Locked chain (2026-09-20, Email/Voice/Phone Intake/Data, this session):
// the phone hangup chain runs, in strict order, inside one shutdown
// callback — mark_callback_job -> write transcript -> POST /api/phone/
// recap {job_id}. Phone Intake's recap endpoint, AFTER its own work,
// pings THIS endpoint with the same {job_id} — so by the time this fires,
// callback_jobs.transcript for that job is guaranteed already committed.
// Deliberately NOT triggered off LiveKit's egress_ended (Voice's own
// ruling): that fires on RECORDING finalization, which isn't sequenced
// against the transcript write, can land on either side of it, and never
// fires at all when RECORDING_ENABLED=0 or the call never reached
// egress — none of which stops a transcript from existing to classify.
//
// Phone Intake's ping is best-effort, 5s timeout, no retry, and only
// fires once per job per recap kind (never for no-answer/voicemail-left
// jobs, which have no transcript to classify) — so this endpoint doesn't
// need its own dedupe or retry logic; a dropped ping just means that
// one job never gets a disposition, which is the same "best-effort
// enrichment, not critical path" shape as the web classifier.
//
// callback_jobs.transcript is jsonb (Data reverted the brief TEXT
// conversion same-day, 2026-09-20 — the Sep 4-18 rows confirmed the
// jsonb shape survived intact) — an array of turns { ts, role, text },
// role:"user"=caller, role:"assistant"=host, written natively by Voice's
// write_phone_transcript. Per Phone Intake's explicit instruction, only
// CALLER (role:"user") turns are classified — see _disposition.js's
// callerLinesFromPhoneTranscript for why.
//
// Disposition write goes through set_phone_disposition(p_job_id,
// p_disposition, p_threat_target) (Data, 2026-09-20) — a DEDICATED
// function, not an overload of mark_callback_job. Voice's revised ask,
// for two reasons: (1) mark_callback_job has already thrown PGRST203
// (ambiguous function) on a signature change once; a distinct name can't
// collide that way. (2) This endpoint no longer has to re-read and
// re-affirm the job's own status just to write two unrelated columns —
// that dance only existed because the write was bolted onto a status
// function. SECURITY DEFINER, writes only disposition/threat_target on
// callback_jobs, execute granted to service_role. HOME is callback_jobs,
// decided (not phone_recaps — Phone Intake's outbound email queue has no
// disposition concept, PE has no access to it, and its rows are
// deleted-by-send).
// ----------------------------------------------------------------------

import { classifyDisposition, callerLinesFromPhoneTranscript } from "../_disposition.js";

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.PHONE_INTAKE_SECRET;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: opts.prefer || "return=representation",
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${path} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const select = (table, filter) => sb(`${table}?${filter}`, { method: "GET" });
const rpc = (fn, args) => sb(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }
  if (!SECRET || req.headers["x-phone-intake-secret"] !== SECRET) {
    return res.status(401).json({ ok: false, error: "bad secret" });
  }
  if (!SB || !SB_KEY) {
    return res.status(500).json({ ok: false, error: "store not configured" });
  }

  const jobId = req.body && req.body.job_id ? String(req.body.job_id).trim() : null;
  if (!jobId) {
    return res.status(400).json({ ok: false, error: "job_id required" });
  }

  try {
    // Single read: just the transcript to classify. No status re-read
    // needed anymore — set_phone_disposition doesn't touch p_status at
    // all, unlike the earlier mark_callback_job-overload plan.
    const [job] = await select(
      "callback_jobs",
      `id=eq.${encodeURIComponent(jobId)}&select=transcript&limit=1`
    );
    if (!job) {
      // No such job — respond ok:false but 200, not 404. Phone Intake's
      // ping is fire-and-forget/no-retry, so there's no meaningful
      // recovery on their side either way; a clean, quiet no-op beats a
      // confusing error on what could just be a race against their own
      // still-committing transaction.
      return res.status(200).json({ ok: false, job_id: jobId, error: "job not found" });
    }
    // jsonb array — check for empty/absent explicitly, since `[]` is
    // truthy and would otherwise slip past a bare `!job.transcript`.
    if (!Array.isArray(job.transcript) || !job.transcript.length) {
      return res.status(200).json({ ok: false, job_id: jobId, error: "no transcript on job" });
    }

    const callerLines = callerLinesFromPhoneTranscript(job.transcript);
    const result = await classifyDisposition(callerLines);
    if (!result) {
      return res.status(200).json({ ok: false, job_id: jobId, error: "classify failed" });
    }

    await rpc("set_phone_disposition", {
      p_job_id: jobId,
      p_disposition: result.disposition,
      p_threat_target: result.threatTarget,
    });

    return res.status(200).json({
      ok: true,
      job_id: jobId,
      disposition: result.disposition,
      threat_target: result.threatTarget,
    });
  } catch (e) {
    console.error("phone-outbound-disposition", e);
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }
}

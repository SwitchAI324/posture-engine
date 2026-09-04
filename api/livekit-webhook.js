// api/livekit-webhook.js
// ----------------------------------------------------------------------
// LiveKit webhook receiver (2026-09-03, Recording chat spec). Registered
// in LiveKit Cloud against this route — final path is /api/livekit-webhook
// (this file's own path, standard Vercel file-based routing; tell Andrew
// to register that exact URL).
//
// Handles ONLY egress_ended. Every other event type gets a 200 with no
// further processing — LiveKit's delivery semantics retry on non-200, so
// a plain ack for ignored types avoids unnecessary retry storms.
//
// On egress_ended: reads room_name (= slug, same identity already
// established throughout this codebase), the file result's location +
// duration, maps LiveKit's EgressStatus to this system's ready/failed,
// and runs the SAME upsert recording_ready uses — factored into the one
// shared upsertRecording() in _store.js rather than this file calling
// that endpoint over HTTP. Then, for a phone job (slug starts with ph-)
// that finished ready, fires a recap trigger — fire-and-forget, logs a
// non-2xx, never fails the webhook over it.
//
// ⚠ VERIFICATION STATUS — same standard as dial.js. I installed the real
// livekit-server-sdk/@livekit/protocol and confirmed every field path
// below against their actual TypeScript definitions (WebhookReceiver's
// constructor/receive() signature, WebhookEvent.egressInfo, EgressInfo.
// {roomName,status,fileResults}, FileInfo.{location,duration}, and the
// EgressStatus enum values) — real, not guessed. What's NOT verified:
// an actual live webhook delivery from LiveKit Cloud, and one real
// uncertainty flagged inline below (the unit of FileInfo.duration).
// ----------------------------------------------------------------------

const { WebhookReceiver, EgressStatus, authorizeHeader } = require("livekit-server-sdk");
const { upsertRecording } = require("./_store.js");

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const PHONE_INTAKE_SECRET = process.env.PHONE_INTAKE_SECRET;
const RECAP_URL = "https://posture-engine.vercel.app/api/phone/recap";

function jsonRes(res, obj, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

// LiveKit's status enum -> this system's two-value vocabulary. Anything
// not explicitly COMPLETE maps to failed, per Recording's spec
// (EGRESS_FAILED / EGRESS_ABORTED named explicitly; EGRESS_LIMIT_REACHED
// and any future status value fall into the same "not ready" bucket by
// the same logic, rather than silently defaulting to ready).
function mapEgressStatus(status) {
  return status === EgressStatus.EGRESS_COMPLETE ? "ready" : "failed";
}

// Fire-and-forget phone recap trigger. Never throws, never blocks the
// webhook response — logs non-2xx and moves on, exactly as specified.
async function triggerPhoneRecap(slug) {
  if (!slug.startsWith("ph-")) return;
  const jobId = slug.slice(3); // strip "ph-"
  if (!PHONE_INTAKE_SECRET) {
    console.log("livekit-webhook: PHONE_INTAKE_SECRET not configured, skipping recap trigger for " + slug);
    return;
  }
  try {
    const r = await fetch(RECAP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-phone-intake-secret": PHONE_INTAKE_SECRET,
      },
      body: JSON.stringify({ job_id: jobId }),
    });
    if (!r.ok) {
      console.log(
        "livekit-webhook: recap trigger non-2xx for job_id=" + jobId + " status=" + r.status
      );
    }
  } catch (e) {
    console.log(
      "livekit-webhook: recap trigger threw for job_id=" + jobId + ": " +
        (e && e.message ? e.message : e)
    );
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return jsonRes(res, { error: "POST only" }, 405);
  }
  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return jsonRes(res, { error: "livekit not configured" }, 500);
  }

  let rawBody = "";
  await new Promise((resolve) => {
    req.on("data", (c) => (rawBody += c));
    req.on("end", resolve);
    req.on("error", resolve);
  });

  const receiver = new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  let event;
  try {
    // receive() verifies the Authorize header signature against the raw
    // body — must be called with the EXACT raw body string, not a
    // re-serialized parse of it (signature is computed over the exact
    // bytes LiveKit sent). Header name confirmed against the SDK's own
    // exported authorizeHeader constant ("Authorize") — the method's own
    // doc comment says "Authorization", which is wrong; the actual
    // constant is the source of truth here, verified in the installed
    // package's real source, not assumed from the stale comment.
    event = await receiver.receive(rawBody, req.headers[authorizeHeader.toLowerCase()]);
  } catch (e) {
    console.log("livekit-webhook: signature verification FAILED: " + (e && e.message ? e.message : e));
    return jsonRes(res, { error: "invalid signature" }, 401);
  }

  if (event.event !== "egress_ended") {
    // Ignored event type — ack with 200, no processing, per spec.
    return jsonRes(res, { ok: true, ignored: event.event });
  }

  const egressInfo = event.egressInfo;
  if (!egressInfo || !egressInfo.roomName) {
    console.log("livekit-webhook: egress_ended with no egressInfo/roomName — nothing to do");
    return jsonRes(res, { ok: true, skipped: "no room_name" });
  }

  const slug = egressInfo.roomName;
  const status = mapEgressStatus(egressInfo.status);

  // fileResults is an array — LiveKit egress can emit multiple file
  // outputs per job. This system expects one recording per call, so this
  // takes the first result. ⚠ If a job ever produces multiple files
  // (e.g. separate audio/video egress), only the first is captured here
  // — not confirmed this call type only ever produces one.
  const file = Array.isArray(egressInfo.fileResults) ? egressInfo.fileResults[0] : null;
  const recordingUrl = file && file.location ? file.location : null;
  // ⚠ UNIT NOT EXPLICITLY DOCUMENTED in the protobuf definition — inferred
  // as nanoseconds by convention with this same message's own started_at/
  // ended_at fields (LiveKit's established convention for all its
  // timestamp/duration int64 fields). Converts to whole seconds for the
  // duration_sec column. Worth confirming against one real webhook
  // delivery before fully trusting this conversion.
  const durationSec =
    file && file.duration != null ? Math.round(Number(file.duration) / 1e9) : null;

  try {
    await upsertRecording({
      slug,
      recordingUrl,
      durationSec,
      status,
    });
  } catch (e) {
    console.log("livekit-webhook: upsertRecording failed for slug=" + slug + ": " + (e && e.message ? e.message : e));
    // Still ack 200 — LiveKit retrying won't fix a DB-side failure, and
    // per Recording's own framing this endpoint shouldn't fail loudly
    // back to LiveKit over a downstream write error.
    return jsonRes(res, { ok: false, error: "upsert failed" });
  }

  if (status === "ready") {
    // Fire-and-forget, does not block or affect this response.
    triggerPhoneRecap(slug);
  }

  return jsonRes(res, { ok: true, slug, status });
};

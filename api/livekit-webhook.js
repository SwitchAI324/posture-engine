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
    // REVISED (2026-09-07) — real, repeated production failures
    // ("authorization header is empty", 11+ consecutive deliveries)
    // proved the original assumption wrong: I trusted the SDK's own
    // exported authorizeHeader constant ("Authorize") over its doc
    // comment ("Authorization") when I first built this, based on
    // static inspection of the installed package. That inspection was
    // real, not guessed — but LiveKit's actual live webhook sender
    // apparently uses the standard "Authorization" header in practice,
    // not "Authorize". Rather than flip the guess a second time, this
    // now checks BOTH and logs which one (if either) actually arrived —
    // so the next real delivery gives a definitive answer instead of
    // another guess, and the endpoint works either way in the meantime.
    const authHeaderValue =
      req.headers[authorizeHeader.toLowerCase()] || req.headers["authorization"];
    if (!authHeaderValue) {
      console.log(
        "livekit-webhook: NEITHER 'Authorize' nor 'Authorization' header " +
        "present on this delivery — headers seen: " +
        JSON.stringify(Object.keys(req.headers))
      );
    } else {
      console.log(
        "livekit-webhook: auth header found via " +
        (req.headers[authorizeHeader.toLowerCase()] ? "'Authorize'" : "'Authorization'") +
        " (fallback)"
      );
    }
    // receive() verifies the header's signature against the raw body —
    // must be called with the EXACT raw body string, not a re-serialized
    // parse of it (signature is computed over the exact bytes LiveKit
    // sent).
    event = await receiver.receive(rawBody, authHeaderValue);
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

  const status = mapEgressStatus(egressInfo.status);

  // fileResults is an array — LiveKit egress can emit multiple file
  // outputs per job. This system expects one recording per call, so this
  // takes the first result. ⚠ If a job ever produces multiple files
  // (e.g. separate audio/video egress), only the first is captured here
  // — not confirmed this call type only ever produces one.
  const file = Array.isArray(egressInfo.fileResults) ? egressInfo.fileResults[0] : null;

  // SLUG + RECORDING_URL (2026-09-09, Recording — breaking change ahead
  // of Voice's main85). Egress files are being renamed from the LiveKit
  // room name to the actual hydrate slug (in-<house_call_id>.ogg,
  // ph-<job_id>.ogg, or the web slug) — so egressInfo.roomName, which
  // still returns the room and NOT the slug after main85, can no longer
  // be trusted as the slug. Deriving it instead from the egress file
  // result's own location/name, which main85 sets to the real slug.
  //
  // Same parse also fixes a separate, related bug Recording flagged:
  // recording_url was being stored as file.location directly — the
  // full, percent-encoded S3 endpoint URL, not the object key. Storing
  // the decoded object key only now.
  //
  // Real, honest caveat: file.location's exact shape (full https URL
  // with query string vs. a bucket-relative key already) isn't
  // confirmed against a real main85 delivery yet — this handles both
  // plausible shapes defensively (URL-parses if it looks like one,
  // falls back to treating the whole string as a path otherwise) rather
  // than assuming one specific format.
  function parseEgressLocation(location) {
    if (!location) return { objectKey: null, slug: null };
    let pathPart = location;
    try {
      // If it parses as an absolute URL, take just the pathname —
      // strips scheme/host/query string (the "percent-encoded S3
      // endpoint" Recording flagged) automatically.
      pathPart = new URL(location).pathname;
    } catch {
      // Not a full URL — treat the whole string as already being a
      // path/key, unchanged.
    }
    // Decode percent-encoding (S3 keys are commonly percent-encoded in
    // the path) and strip a leading slash so the stored key is clean.
    let objectKey;
    try {
      objectKey = decodeURIComponent(pathPart).replace(/^\/+/, "");
    } catch {
      objectKey = pathPart.replace(/^\/+/, "");
    }
    // The slug is the filename component, extension stripped —
    // "recordings/in-abc123.ogg" -> "in-abc123".
    const filename = objectKey.split("/").pop() || "";
    const slug = filename.replace(/\.[a-zA-Z0-9]+$/, "") || null;
    return { objectKey: objectKey || null, slug };
  }

  const parsed = parseEgressLocation(file && file.location ? file.location : null);
  // Fall back to roomName ONLY if the file result gave us nothing to
  // parse at all (e.g. an egress that failed before producing a file) —
  // never prefer roomName over a real parsed slug once main85 is live.
  const slug = parsed.slug || egressInfo.roomName;
  const recordingUrl = parsed.objectKey;
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

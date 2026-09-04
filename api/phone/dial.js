// api/phone/dial.js
// ----------------------------------------------------------------------
// OUTBOUND CALLBACK DISPATCH — the piece Voice flagged as missing
// (2026-09-03): Booking's dispatcher is built and POSTs here; nothing
// existed to receive that POST and turn it into an actual dialed call.
// Lives in this Vercel project (not spamviking-agent — that's a Docker
// container on LiveKit Cloud with no HTTP-serving capability of its own,
// per Voice).
//
// FLOW, per Voice's spec:
//   1. Read e164 + job metadata from Booking's POST body
//   2. Create a LiveKit room
//   3. Dispatch the `spamviking` agent into it, role='callback' + metadata
//   4. Create the SIP participant to actually place the call, via the
//      outbound trunk
//   Job ends at a 2xx once dispatch is ACCEPTED — this endpoint does not
//   wait for the call to connect, ring, or resolve. Write-back on how
//   the call actually goes is Voice's own mark_callback_job call once
//   the agent's session ends (confirmed separately, not this file's job).
//
// ⚠ VERIFICATION STATUS — read before trusting this file. Every other
// file shipped this session was verified with a real execution test
// (node --check + an actual run against fixtures/stubs). This one is
// PARTIALLY verified, not fully: I installed the real livekit-server-sdk
// and confirmed every call site below against its actual TypeScript
// definitions — RoomServiceClient.createRoom({name}), AgentDispatchClient
// .createDispatch(roomName, agentName, {metadata}), and SipClient
// .createSipParticipant(trunkId, number, roomName, {dtmf}) all match the
// real installed SDK exactly, including the (url, apiKey, apiSecret)
// constructor pattern all three clients share. That's real, not
// guessed — confirmed via the SDK's own .d.ts files, not memory. What's
// still NOT verified: an actual live call against real LiveKit
// infrastructure — I have no credentials or network access to LiveKit's
// API from this environment, and wouldn't want to place a real call even
// if I did. Run this against ONE real dispatch before trusting the live
// path — code-level correctness is confirmed, live behavior isn't.
//
// ASSUMPTIONS made without confirmation, flagged rather than silently
// baked in:
//   - Auth header name: x-agent-callback-secret (matches this codebase's
//     existing convention — phone-intake.js uses x-phone-intake-secret,
//     Scouting uses x-sv-scout-token — but Voice didn't specify the
//     exact header Booking's dispatcher will send. CONFIRM before relying
//     on this.)
//   - Agent metadata shape: JSON-stringified onto the LiveKit job's
//     metadata field, matching agent.py's existing read pattern for
//     slug/host_name (per livekit-migration.md) — extended with
//     role:'callback' plus the six job fields Voice listed. Whether the
//     agent's Python side actually reads `role` and branches on it yet
//     is Voice's build, not confirmed from here.
//   - Outbound trunk: Voice said "via the outbound trunk, once it's
//     live" — implying it may not be configured yet. This file reads
//     SIP_OUTBOUND_TRUNK_ID from env and fails with a clear, honest
//     error if it's missing, rather than silently no-op — a phone call
//     that was supposed to happen and didn't needs to be loud, not a
//     quiet degrade like the dossier-floor/sound-marker fail-open
//     patterns elsewhere in this codebase. This is the one place in
//     this system where "fail open" is the wrong instinct.
// ----------------------------------------------------------------------

const {
  RoomServiceClient,
  AgentDispatchClient,
  SipClient,
} = require("livekit-server-sdk");

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const AGENT_CALLBACK_SECRET = process.env.AGENT_CALLBACK_SECRET;
const SIP_OUTBOUND_TRUNK_ID = process.env.SIP_OUTBOUND_TRUNK_ID;
const AGENT_NAME = "spamviking"; // matches the live agent name (livekit-token.js's RoomAgentDispatch)

function jsonRes(res, obj, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function isValidE164(v) {
  return typeof v === "string" && /^\+[1-9]\d{1,14}$/.test(v);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return jsonRes(res, { error: "POST only" }, 405);
  }

  // AUTH — fails closed if the secret isn't configured, same posture as
  // every other guarded write path in this codebase (control.js's
  // control-token gate, phone-intake.js's shared-secret check).
  const providedSecret = req.headers["x-agent-callback-secret"];
  if (!AGENT_CALLBACK_SECRET || providedSecret !== AGENT_CALLBACK_SECRET) {
    return jsonRes(res, { error: "unauthorized" }, 401);
  }

  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return jsonRes(res, { error: "livekit not configured" }, 500);
  }
  if (!SIP_OUTBOUND_TRUNK_ID) {
    // Deliberately loud, not a quiet degrade — see file header. A
    // callback job that silently never dials is worse than one that
    // fails visibly and can be retried/alerted on.
    return jsonRes(
      res,
      { error: "outbound trunk not configured (SIP_OUTBOUND_TRUNK_ID missing)" },
      500
    );
  }

  let body;
  try {
    let raw = "";
    await new Promise((resolve) => {
      req.on("data", (c) => (raw += c));
      req.on("end", resolve);
      req.on("error", resolve);
    });
    body = raw ? JSON.parse(raw) : {};
  } catch {
    return jsonRes(res, { error: "bad json" }, 400);
  }

  const {
    e164,
    dial_extension,
    ask_for,
    host_name,
    reference_code,
    user_id,
    intake_id,
    job_id,
  } = body || {};

  if (!isValidE164(e164)) {
    return jsonRes(res, { error: "e164 required, must be a valid E.164 number" }, 400);
  }
  if (!job_id) {
    return jsonRes(res, { error: "job_id required" }, 400);
  }

  // Room name: unique per dispatch attempt, human-traceable (job_id is
  // stable and already the join key Booking/Data use elsewhere).
  const roomName = "callback-" + String(job_id);

  const roomService = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  const agentDispatch = new AgentDispatchClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  const sipClient = new SipClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);

  const jobMetadata = JSON.stringify({
    role: "callback",
    e164,
    dial_extension: dial_extension ?? null,
    ask_for: ask_for ?? null,
    host_name: host_name ?? null,
    reference_code: reference_code ?? null,
    user_id: user_id ?? null,
    intake_id: intake_id ?? null,
    job_id,
  });

  try {
    // STEP 1 — create the room. Signature confirmed against the real
    // installed SDK's RoomServiceClient.d.ts: createRoom({name}).
    await roomService.createRoom({ name: roomName });

    // STEP 2 — dispatch the agent into it, carrying the callback
    // metadata. Signature confirmed: createDispatch(roomName, agentName,
    // {metadata}). Matches the same job-metadata pattern livekit-token.js's
    // RoomAgentDispatch already uses for the web-call path (per
    // livekit-migration.md), just dispatched server-side here instead
    // of embedded in a participant token.
    await agentDispatch.createDispatch(roomName, AGENT_NAME, {
      metadata: jobMetadata,
    });

    // STEP 3 — create the SIP participant that actually places the
    // outbound call. Signature AND the dtmf field name both confirmed
    // against the real SDK's CreateSipParticipantOptions — its own doc
    // comment says dtmf is exactly "extension codes... when making a
    // call," which is precisely what dial_extension needs.
    await sipClient.createSipParticipant(
      SIP_OUTBOUND_TRUNK_ID,
      e164,
      roomName,
      dial_extension ? { dtmf: String(dial_extension) } : {}
    );

    console.log(
      "phone/dial: dispatched job_id=" + job_id + " room=" + roomName + " e164=" + e164
    );
    return jsonRes(res, { ok: true, room: roomName, job_id });
  } catch (e) {
    console.log("phone/dial FAILED job_id=" + job_id + ": " + (e && e.message ? e.message : e));
    return jsonRes(res, { error: String(e && e.message ? e.message : e) }, 500);
  }
};

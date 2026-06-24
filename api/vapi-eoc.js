// SpamViking — Vapi end-of-call-report receiver.
// ----------------------------------------------------------------------
// Two jobs on every call end, both keyed by target_id (from call.metadata,
// stamped at call start):
//
//   1. SCOUT LANE — forward the full transcript to /api/scout/call so Scouting
//      mines post-call facts. (fire-and-forget)
//
//   2. POST-CALL SIGNAL — the trigger the EMAIL follow-up engine waits on.
//      We compute and emit, per target:
//        - attended      (bool)  any dialogue at all -> true (joined-then-
//                                 dropped still counts as attended)
//        - call_outcome  ('completed' | 'dropped')  dropped = joined + dialogue
//                                 but ended early/abruptly
//        - next_steps[]  1-3 SHORT forward-looking action items (NOT a recap —
//                                 the call was a circus; recapping tips them off)
//      Emitted as a `call_outcome` event on engagement_events (keyed by
//      target_id + call_id). The email engine reads it and runs the post-call
//      vs. dropped cadence; it owns the state flip + counters (see FLAGS below).
//
// Acts ONLY on end-of-call-report; everything else is acked (200) and ignored.
// ----------------------------------------------------------------------
import { waitUntil } from "@vercel/functions";
import { getCall } from "./_store.js";

export const config = { runtime: "edge" };

const SCOUT_URL =
  process.env.SCOUT_CALL_URL ||
  "https://posture-engine.vercel.app/api/scout/call";
const SCOUT_TOKEN = process.env.SV_SCOUT_TOKEN || "";

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AKEY = process.env.ANTHROPIC_API_KEY;
const AMODEL =
  process.env.ANTHROPIC_SUMMARY_MODEL ||
  process.env.ANTHROPIC_MODEL ||
  "claude-haiku-4-5-20251001";

function ok(body) {
  return new Response(JSON.stringify(body || { ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

// attended = any real dialogue happened. Joined-then-dropped still counts.
function isAttended(transcript, messages) {
  if (transcript && transcript.trim()) return true;
  return Array.isArray(messages) && messages.length > 0;
}

// completed vs dropped. dropped = attended but ended early/abruptly (technical
// drop, or just a couple of turns then gone). Heuristic — the email side can
// refine the endedReason mapping.
function callOutcome(attended, endedReason, msgCount) {
  if (!attended) return "dropped";
  const r = String(endedReason || "").toLowerCase();
  if (/error|websocket|pipeline|fail|timeout|disconnect|closed|provider/.test(r)) {
    return "dropped";
  }
  if (msgCount > 0 && msgCount < 4) return "dropped"; // a word or two, then gone
  return "completed";
}

// 1-3 SHORT forward-looking next steps. Forward actions only — never a recap of
// the call (recapping the circus is a tip-off). Returns string[] (maybe empty).
async function generateNextSteps(transcript) {
  if (!AKEY || !transcript || !transcript.trim()) return [];
  const sys =
    "You are jotting 1-3 SHORT forward-looking next-step action items right " +
    "after a sales call, the kind that go in a follow-up email — e.g. " +
    "'circulate internally', 'send over the deck', 'set up a technical " +
    "deep-dive', 'loop in our finance lead'. FORWARD actions only: do NOT " +
    "recap, describe, or reference anything that happened on the call. Return " +
    "ONLY a JSON array of 1-3 short strings (3-6 words each), nothing else.";
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": AKEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: AMODEL,
        max_tokens: 200,
        system: sys,
        messages: [{ role: "user", content: transcript.slice(-8000) }],
      }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    let text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    text = text.replace(/```json|```/g, "").trim();
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return [];
    return arr.map((s) => String(s).trim()).filter(Boolean).slice(0, 3);
  } catch {
    return [];
  }
}

// Authoritative call record (Data owns `calls`). Written for calls that
// actually happened (attended completed/dropped); the email no-show sweep
// writes no_show rows, never us. Column names per Data's schema: vapi_call_id
// (not call_id), duration_seconds (not duration), started_at/ended_at (not
// timestamp). next_steps is jsonb. No recording ref — recordings FK back to
// calls.id, so a column here would be circular.
async function writeCallsRow(row) {
  if (!SB_URL || !SB_KEY) return false;
  const r = await fetch(`${SB_URL}/rest/v1/calls`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      authorization: `Bearer ${SB_KEY}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  }).catch(() => null);
  if (!r || !r.ok) {
    try { console.log("calls write failed", r ? r.status : "no-response"); } catch {}
    return false;
  }
  return true;
}

// Emit the post-call signal onto engagement_events, keyed by target_id + call_id.
// (target_id is NOT NULL on that table, so this needs target_id present.)
async function emitCallOutcome(targetId, callId, payload) {
  if (!SB_URL || !SB_KEY || !targetId) return false;
  const row = {
    target_id: targetId,
    call_id: callId || null,
    event_type: "call_outcome",
    actor: "engine",
    ts: new Date().toISOString(),
    payload,
  };
  const r = await fetch(`${SB_URL}/rest/v1/engagement_events`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      authorization: `Bearer ${SB_KEY}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  }).catch(() => null);
  return !!(r && r.ok);
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return ok({ ok: true, note: "POST Vapi end-of-call-report here" });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    console.log("vapi-eoc: bad json body");
    return ok({ ok: true, ignored: "bad json" });
  }

  const m = (body && body.message) || {};
  const type = m.type || "unknown";
  // Vapi POSTs SEVERAL message types to this one URL (status-update,
  // conversation-update, speech-update, end-of-call-report, ...). Log every
  // arrival so we can see what's coming, then act only on the end-of-call report.
  console.log("vapi-eoc: received type=" + type);
  if (type !== "end-of-call-report") {
    return ok({ ok: true, ignored: type });
  }

  const callId = (m.call && m.call.id) || m.callId || null;
  const meta = (m.call && m.call.metadata) || m.metadata || {};
  const artifact = m.artifact || {};

  // Transcript can live in a few places depending on transport — try them all,
  // and as a last resort rebuild it from the messages array.
  let transcript = "";
  if (typeof artifact.transcript === "string") transcript = artifact.transcript;
  else if (typeof m.transcript === "string") transcript = m.transcript;
  const messages =
    (Array.isArray(artifact.messages) && artifact.messages) ||
    (Array.isArray(m.messages) && m.messages) ||
    [];
  if (!transcript.trim() && messages.length) {
    transcript = messages
      .map((x) =>
        x && (x.role || x.message)
          ? (x.role || "?") + ": " + (x.message || x.content || "")
          : ""
      )
      .filter(Boolean)
      .join("\n");
  }

  const endedReason = m.endedReason || m.ended_reason || "";
  const attended = isAttended(transcript, messages);
  const outcome = callOutcome(attended, endedReason, messages.length);
  const targetId = meta.target_id || null;
  const targetEmail = meta.target_email || null;

  // The line the booking chat is watching for — proves target_id rode through.
  console.log(
    "vapi-eoc: EOC call_id=" + (callId || "none") +
      " transcriptLen=" + transcript.length +
      " msgs=" + messages.length +
      " attended=" + attended +
      " outcome=" + outcome +
      " has_target=" + !!targetId +
      (targetEmail ? " has_email=true" : "")
  );
  if (!targetId) {
    console.log(
      "vapi-eoc: no target_id — metadata keys=" +
        (Object.keys(meta).join(",") || "(none)")
    );
  }

  // Timing: prefer durationSeconds, else derive from timestamps.
  const startedAt = m.startedAt || (m.call && m.call.startedAt) || null;
  const endedAt = m.endedAt || null;
  let durationSeconds = null;
  if (m.durationSeconds != null) durationSeconds = Math.round(m.durationSeconds);
  else if (startedAt && endedAt) {
    const d = (new Date(endedAt) - new Date(startedAt)) / 1000;
    if (Number.isFinite(d) && d >= 0) durationSeconds = Math.round(d);
  }

  // Background work: scout lane + authoritative calls row + liveness event.
  const bg = (async () => {
    try {
      const callRow = callId ? await getCall(callId).catch(() => null) : null;

      // 1) SCOUT LANE — needs a real transcript to mine.
      if (callId && transcript.trim()) {
        const scoutBody = { call_id: callId, transcript };
        if (targetId) scoutBody.target_id = targetId;
        if (targetEmail) scoutBody.target_email = targetEmail;
        const sr = await fetch(SCOUT_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-sv-scout-token": SCOUT_TOKEN,
          },
          body: JSON.stringify(scoutBody),
        }).catch((e) => {
          console.log("vapi-eoc: scout fetch threw " + e);
          return null;
        });
        console.log("vapi-eoc: scout POST -> " + (sr ? sr.status : "no-response"));
      } else {
        console.log("vapi-eoc: scout skipped (no transcript)");
      }

      // 2) FORWARD-ONLY next steps.
      const nextSteps = attended ? await generateNextSteps(transcript) : [];
      console.log("vapi-eoc: next_steps count=" + nextSteps.length);

      // 3) AUTHORITATIVE calls row.
      const wrote = await writeCallsRow({
        target_id: targetId,
        vapi_call_id: callId,
        call_outcome: outcome,
        next_steps: nextSteps,
        host_posture: callRow ? callRow.characterId : null,
        duration_seconds: durationSeconds,
        transcript: transcript || null,
        archetype: meta.archetype || (callRow ? callRow.archetype : null) || null,
        started_at: startedAt,
        ended_at: endedAt,
        gear_suspicion_end: callRow ? callRow.gear : null,
        gear_pressure_end: callRow ? callRow.pressure : null,
        gear_engagement_end: callRow ? callRow.engagement : null,
      });
      console.log(
        "vapi-eoc: calls row written=" + wrote +
          " (target_id=" + (targetId || "null") + ")"
      );

      // 4) LIVENESS event (notification only — not the source of truth).
      const emitted = await emitCallOutcome(targetId, callId, {
        attended,
        call_outcome: outcome,
        next_steps: nextSteps,
      });
      console.log("vapi-eoc: liveness event emitted=" + emitted);
    } catch (e) {
      console.log("vapi-eoc: bg error " + (e && e.message ? e.message : e));
    }
  })();
  // Run after the 200 if possible; if waitUntil is unavailable, run inline so
  // the work still happens (and is still logged).
  try {
    waitUntil(bg);
  } catch {
    await bg;
  }

  return ok({
    ok: true,
    call_id: callId,
    attended,
    call_outcome: outcome,
    has_target: !!targetId,
  });
}

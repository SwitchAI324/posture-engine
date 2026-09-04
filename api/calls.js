// SpamViking — Posture Engine: CALL OUTCOME endpoint.
// ----------------------------------------------------------------------
// The agent (LiveKit worker) has no DB access — it talks only to PE and
// LiveKit. On a silence / bail / hangup close it POSTs here and PE writes the
// `calls` row that Barbara's post-call follow-up ladder branches on.
//
//   POST /api/calls?action=close
//     body: {
//       target_id,                 // REQUIRED — from the hydrate payload the
//                                  //   agent received (hydrate returns it).
//                                  //   calls.target_id is a NOT NULL FK; without
//                                  //   it the insert 400s. This is the real
//                                  //   failure mode, not the outcome value.
//       call_outcome,              // 'completed'|'dropped'|'no_show'|'hung_up'
//                                  //   plain text, no DB check — any value takes.
//                                  //   dropped = connected then silent;
//                                  //   no_show = never connected / bailed pre-join;
//                                  //   hung_up = caller actively hung up.
//       vapi_call_id?,             // the call id, if the agent has it
//       started_at?,               // omit if never connected
//       ended_at?,
//       duration_seconds?,
//       next_steps?,               // jsonb; omit to keep the [] default
//       host_posture?,
//       transcript?,
//       status?
//     }
//     -> inserts the calls row. 200 {ok:true} on success.
//     -> 400 if target_id is missing (the FK/NOT NULL guard).
//     -> 404 for an unknown/missing action.
//     -> 500 on a DB write error.
//
// OWNERSHIP: the agent writes rows for calls that ACTUALLY STARTED then died
// (dropped/hung_up) or that it saw bail pre-join (no_show). Barbara's sweep
// writes no_show ONLY for calls that never produced a row at all — the two sets
// don't overlap, so nobody double-writes.
// ----------------------------------------------------------------------

import { insertCallOutcome, saveTranscript, upsertRecording } from "./_store.js";

export const config = { runtime: "edge" };

// SCOUT FAN-OUT (2026-09-02) — Scouting's own fix for the "Channel-2
// written but call-lane content never reaches the host" gap: the
// transcript arrives here (this endpoint) but was never forwarded on to
// Scouting's own dissection. /api/scout/call is transport-agnostic
// (Scouting confirmed, code-checked their side) — it takes {target_id,
// messages, call_id} and produces call_claim/call_commitment/
// call_callback content in scout_facts. This endpoint already holds
// target_id (required, validated above) and the flattened conversation
// (body.conversation) in the SAME request — no new trigger, no new
// round trip to find either value, just one more outbound POST from an
// endpoint that already has everything it needs.
const SCOUT_CALL_URL =
  process.env.SCOUT_CALL_URL || "https://posture-engine.vercel.app/api/scout/call";
const SCOUT_TOKEN = process.env.SV_SCOUT_TOKEN;

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default async function handler(req) {
  const u = new URL(req.url);
  const action = u.searchParams.get("action");

  // POST ?action=close — write the call-outcome row.
  if (req.method === "POST" && action === "close") {
    let b;
    try {
      b = await req.json();
    } catch {
      return jsonRes({ error: "bad json" }, 400);
    }
    const targetId = b.target_id ? String(b.target_id).trim() : null;
    if (!targetId) {
      // The FK/NOT NULL guard — surfaced as a clean 400 so the agent sees the
      // real reason rather than a 500 from the DB. call_outcome value is never
      // the blocker (no check constraint); target_id always is.
      return jsonRes({ error: "target_id required" }, 400);
    }
    try {
      // RECORDING FIELDS (2026-09-03, Recording chat) — passed through to
      // _store.js's insertCallOutcome, same pattern as every other
      // optional field above. recording_url/recording_duration_sec arrive
      // only once egress actually finishes; recording_status is derived
      // here, not trusted from the agent (three states: 'ready' when a
      // URL genuinely arrived, 'failed' when egress never started,
      // 'pending' otherwise — covers the agent closing before egress
      // finishes, which is the normal case, not an error).
      //
      // FIELD RENAMED (2026-09-03, Recording/Voice): egress_start_failed,
      // not egress_failed — the old name collided with LiveKit's own
      // EGRESS_FAILED status, a DIFFERENT, LATER event delivered via the
      // egress_ended webhook (a recording that started, then failed
      // partway through). egress_start_failed means egress never started
      // at all — this close-time field can only ever know about that
      // earlier failure mode; anything after start is the webhook's job,
      // not this one's.
      //
      // insertCallOutcome() confirmed (2026-09-03) to actually persist
      // recordingUrl/recordingDurationSeconds/recordingStatus — verified
      // with a real captured-request test, not just assumed.
      const recordingStatus = b.recording_url
        ? "ready"
        : b.egress_start_failed
        ? "failed"
        : "pending";
      await insertCallOutcome({
        targetId,
        callOutcome: b.call_outcome,
        // vapi_call_id (2026-09-03, corrected per Data) — this IS the real,
        // only column on `calls` for the external call reference; it's
        // just named for the old system. Written from b.call_id (the
        // LiveKit room name, same value the transcript save below already
        // uses) rather than b.vapi_call_id — that field has documented
        // history of arriving empty (the Aug-8 call_transcripts fix), so
        // prefer the value already confirmed reliable, falling back to
        // b.vapi_call_id only if the agent genuinely doesn't send call_id
        // on some path. updateCallRecording (the recording_ready action
        // below) matches on this exact column later — its correctness
        // depends on this write actually landing a good value.
        vapiCallId: b.call_id ?? b.vapi_call_id ?? null,
        startedAt: b.started_at,
        endedAt: b.ended_at,
        durationSeconds: b.duration_seconds,
        nextSteps: b.next_steps,
        hostPosture: b.host_posture,
        transcript: b.transcript,
        status: b.status,
        recordingUrl: b.recording_url ?? null,
        recordingDurationSeconds: b.recording_duration_sec ?? null,
        recordingStatus,
      });
      // FINAL-CONVERSATION SAVE (Aug 8, Voice — race-proof by construction).
      // Separate write, separate table, from the calls-row insert above:
      // this saves to call_transcripts (what completions.js reads back for
      // dossier/recall context), not the `calls` table (Barbara's follow-up
      // ladder). Uses body.conversation — the agent's own session.history,
      // sent from its shutdown callback, which fires exactly once per call
      // on every close path. Unlike the per-turn early-save (only ever
      // catches up via a NEXT request that may not exist) or my reverted
      // finishUp attempt (raced against discarded preemptive-gen
      // candidates), this fires from a single, definitive, non-racing
      // event with the agent's own true record of what was actually
      // spoken — exactly the "discarded candidates excluded" data PE could
      // never get from the request stream alone.
      //
      // Guarded per Voice's own note: absent entirely on a no_show close
      // (nothing was ever said) — never a bug, never logged as one.
      //
      // Confirmed (Aug 8, live test) — vapi_call_id was empty and never had
      // this value at all; it's not the field for it. Voice added a new,
      // dedicated field: body.call_id, the LiveKit room name. That's the
      // real key call_transcripts needs (same identifier used everywhere
      // else this session — hydrate, the completions read path). Distinct
      // from target_id (identifies the TARGET, reusable across multiple
      // separate calls) — call_id identifies THIS specific call session.
      if (Array.isArray(b.conversation) && b.conversation.length) {
        const conversationCallId = b.call_id ? String(b.call_id).trim() : null;
        if (conversationCallId) {
          await saveTranscript(conversationCallId, b.slug || null, b.conversation).catch(() => {});
        } else {
          console.log("calls.js: body.conversation present but no call_id to save it under");
        }
        // SCOUT FAN-OUT (2026-09-02) — see header comment. Same
        // conversation array, same guard, one more consumer. Fails soft
        // exactly like saveTranscript above (.catch swallows) — a
        // Scouting-side outage must never break call-close for the
        // agent, which is already mid-shutdown by the time this fires.
        // No token = lane silently skipped (matches the phone lane's own
        // keyless-degrade convention in api/phone-intake.js), not an
        // error — SV_SCOUT_TOKEN just isn't configured yet in every env.
        if (SCOUT_TOKEN) {
          await fetch(SCOUT_CALL_URL, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-sv-scout-token": SCOUT_TOKEN,
            },
            body: JSON.stringify({
              target_id: targetId,
              call_id: b.call_id || null,
              messages: b.conversation,
            }),
          }).catch(() => {});
        }
      }
      return jsonRes({
        ok: true,
        action: "close",
        target_id: targetId,
        call_outcome: b.call_outcome ?? null,
      });
    } catch (e) {
      return jsonRes(
        { ok: false, error: String(e && e.message ? e.message : e) },
        500
      );
    }
  }

  // POST ?action=recording_ready — REPLACED (2026-09-03, Data's ruling).
  // Phone jobs never hit ?action=close on this file at all, so the
  // previous by-call_id UPDATE against `calls` could never work for
  // them — recordings now live in their own table (`recordings`, uuid id
  // + UNIQUE slug), upserted by slug, NOT mirrored into `calls`. The
  // existing calls.recording_* write in the close handler above is
  // untouched — that stays exactly as shipped, web-close-time only.
  // Genuine upsert means no 202/retry anymore: it can't match zero rows,
  // it creates the row if absent. 200 on every successful write.
  if (req.method === "POST" && action === "recording_ready") {
    let b;
    try {
      b = await req.json();
    } catch {
      return jsonRes({ error: "bad json" }, 400);
    }
    const slug = b.slug ? String(b.slug).trim() : null;
    if (!slug) {
      return jsonRes({ error: "slug required" }, 400);
    }
    try {
      const row = await upsertRecording({
        slug,
        recordingUrl: b.recording_url ?? null,
        durationSec: b.recording_duration_sec ?? null,
        status: b.status ?? null,
      });
      return jsonRes({ ok: true, slug, recording: row });
    } catch (e) {
      return jsonRes(
        { ok: false, error: String(e && e.message ? e.message : e) },
        500
      );
    }
  }

  // Unknown / missing action -> 404.
  return jsonRes({ error: `unknown action: ${action || "(none)"}` }, 404);
}

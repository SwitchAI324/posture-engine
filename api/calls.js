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

import { insertCallOutcome, saveTranscript } from "./_store.js";

export const config = { runtime: "edge" };

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
      await insertCallOutcome({
        targetId,
        callOutcome: b.call_outcome,
        vapiCallId: b.vapi_call_id,
        startedAt: b.started_at,
        endedAt: b.ended_at,
        durationSeconds: b.duration_seconds,
        nextSteps: b.next_steps,
        hostPosture: b.host_posture,
        transcript: b.transcript,
        status: b.status,
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
      // ⚠ FIELD-NAME UNCERTAINTY, flagging rather than silently assuming:
      // this reuses b.vapi_call_id as the real call_id/room name (there's
      // no separate call_id or slug field documented on this endpoint).
      // The name is a holdover from the pre-LiveKit era, but LiveKit room
      // names (sv-test-andy-...) are the only plausible value that could
      // actually be riding in it today. Worth Voice confirming directly
      // rather than PE assuming silently — if wrong, this save would
      // either no-op (empty callId) or, worse, write under the wrong key.
      if (Array.isArray(b.conversation) && b.conversation.length) {
        const conversationCallId = b.vapi_call_id ? String(b.vapi_call_id).trim() : null;
        if (conversationCallId) {
          await saveTranscript(conversationCallId, b.slug || null, b.conversation).catch(() => {});
        } else {
          console.log("calls.js: body.conversation present but no vapi_call_id to save it under");
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

  // Unknown / missing action -> 404.
  return jsonRes({ error: `unknown action: ${action || "(none)"}` }, 404);
}

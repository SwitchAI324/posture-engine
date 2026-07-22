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

import { insertCallOutcome } from "./_store.js";

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

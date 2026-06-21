// SpamViking — Posture Engine: PRE-SNAP endpoint  (Node runtime)
// ----------------------------------------------------------------------
// Called ONCE when the Director locks a call in the Mead Hall (posture +
// armed bench + bits chosen). It assembles the frozen prefix and stores it
// keyed by call_id. The per-turn proxy then just reads that prefix.
//
// Runs on the NODE runtime (not Edge) because the compiler/assembler are
// CommonJS with require()'d JSON — happy in Node, impossible in Edge. The
// two endpoints share only the store.
//
//   POST /api/presnap
//   { "call_id": "vapi-call-id", "posture": "skald",
//     "armedBench": ["conrad","bonnie"], "bits": ["echo"],
//     "target": "Marcus @ vendor", "tactic": "b2b_saas" }
// ----------------------------------------------------------------------

import * as assembleMod from "../compiler/assemble.js";
import { setCall, isConfigured } from "./_store.js";
import { summarizeEmails } from "./_emails.js";
import { envBool } from "./_env.js";

const assemblePrefix =
  assembleMod.assemblePrefix ?? assembleMod.default?.assemblePrefix;

// The call opens in the ALIVE doubt-gear. The posture engine overwrites
// this line per turn later (Phase 3); pre-snap just seeds the entry value.
const ENTRY_POSTURE_LINE =
  "ALIVE — the opportunity is real and moving; warm, forward, generous " +
  "with next steps.";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  if (!isConfigured()) {
    res.status(500).json({ error: "store not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)" });
    return;
  }

  const body = req.body || {};
  const callId = body.call_id || body.callId;
  if (!callId || !body.posture) {
    res.status(400).json({ error: "need call_id and posture" });
    return;
  }

  let assembled;
  try {
    assembled = assemblePrefix({
      posture: body.posture,
      armedBench: body.armedBench || body.armed_bench || [],
      bits: body.bits || [],
      target: body.target,
      tactic: body.tactic,
      secondCall: body.secondCall ?? body.second_call,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
    return;
  }

  // CALL MEMORY (dark unless CALL_MEMORY_ENABLED): if we have a target_id and an
  // email history, summarize it ONCE here and bake the brief into the frozen
  // prefix — so the host opens the call already remembering the email thread,
  // with no per-turn cost (it rides in the cached base). Skips cleanly when off,
  // when no target_id is passed, or when the thread is empty.
  let prefix = assembled.stablePrefix;
  if (envBool("CALL_MEMORY_ENABLED", false) && (body.target_id || body.targetId)) {
    const brief = await summarizeEmails(body.target_id || body.targetId).catch(() => null);
    if (brief) {
      prefix +=
        "\n\n## EMAIL HISTORY — you have already been corresponding with this " +
        "person by email before this call. Open already aware of it and reference " +
        "it naturally where it fits; do not pretend you have never heard of them.\n" +
        brief;
    }
  }

  try {
    await setCall(callId, {
      prefix,
      gear: "alive", // call opens in the ALIVE doubt-gear
      postureLine: body.postureLine || ENTRY_POSTURE_LINE,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
    return;
  }

  res.status(200).json({
    ok: true,
    call_id: callId,
    posture: assembled.posture,
    bench_armed: assembled.benchArmed,
    excluded: assembled.excluded,
    prefix_tokens: assembled.approxTokens,
    prefix_hash: assembled.hash,
  });
}

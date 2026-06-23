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
//   { "call_id": "vapi-call-id", "character_id": "skald",
//     "armedBench": ["conrad","bonnie"], "bits": ["echo"],
//     "target": "Marcus @ vendor", "target_id": "<targets.id>" }
//   character_id is authoritative (AI pick or Director override). target_id
//   feeds call memory. No tactic field — mechanism comes from the character.
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

// Normalize a character_id to the postures.json key: lowercase + strip
// diacritics, so "Völva"/"VOLVA"/"völva" all resolve to "volva" and a stray
// casing from Mead Hall can't throw "unknown posture".
function normChar(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

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
      // Mead Hall sends character_id (a posture IS a host character). Accept the
      // old `posture` field too for safety. Normalized so casing/diacritics never
      // break the postures.json lookup.
      posture: normChar(body.character_id || body.characterId || body.posture),
      armedBench: body.armedBench || body.armed_bench || [],
      bits: body.bits || [],
      target: body.target,
      // tactic dropped: it was never read by the assembler, and each character
      // already embodies its mechanism via its posture definition.
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
        "\n\n## EMAIL HISTORY & YOUR STANDING WITH THIS PERSON\n" +
        "Ground truth for this call — hold it firmly, it never changes:\n" +
        "- THEY came to YOU. This person cold-pitched you first; you are the " +
        "interested recipient who bit on their pitch.\n" +
        "- You are NOT a seller, broker, recruiter, or gatekeeper. You never " +
        "found, sourced, referred, or recruited them, and you are NOT offering " +
        "them an opportunity, allocation, deal, or access. THEY are pitching YOU.\n" +
        "- This call is happening because you replied with interest and they " +
        "wanted to talk. Your job on it is to HEAR MORE — curious, receptive, a " +
        "little eager — never to pitch, qualify, or grant them anything.\n" +
        "You already know the following from the email thread (reference it " +
        "naturally where it fits; do not recite it, and do not pretend you have " +
        "never heard of them):\n" +
        brief;
    }
  }

  try {
    await setCall(callId, {
      prefix,
      gear: "alive", // call opens in the ALIVE doubt-gear
      postureLine: body.postureLine || ENTRY_POSTURE_LINE,
      characterId: normChar(body.character_id || body.characterId || body.posture),
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

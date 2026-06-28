// SpamViking — SIM CALL: conductable host(PE)-vs-spammer bot loop.
// ----------------------------------------------------------------------
// PE is the HOST (the real engine, via runHostTurn). A second model call is the
// SPAMMER (via assembleSpammerPrompt). This endpoint is TURN-STEPPED, not a
// single long-running loop, because:
//   - Edge requests time out; a 20-turn loop in one request is fragile.
//   - "Conductable" REQUIRES gaps between turns where the Director can arm a bit
//     or fire the Death Blow (via /api/control). A stepped endpoint gives those
//     gaps for free: the next step's runHostTurn reads the controls, so Mead
//     Hall inputs bend the host's next turn — exactly like production.
//
// MODES:
//   POST ?action=start   body { archetype, temperament, beats?, decay?, host_name? }
//        -> mints a sim call_id, returns { call_id, target_id, catalog }, seeds
//           the opening spammer line. Watch by target_id like a real call.
//   POST ?action=step    body { call_id, history }
//        -> advances ONE exchange: spammer line -> host turn. Returns the new
//           lines + whether the host fired the Death Blow (call over).
//   GET  ?action=catalog -> the archetype/temperament picklists for the UI.
//
// The bus events (gear_state, utterance host+spammer, bit_deployed, call_ended)
// are emitted by runHostTurn / buildSystemBlocks internally — this endpoint adds
// call_started at start and the spammer-line plumbing. Mead Hall renders off the
// bus exactly as for a real call.
// ----------------------------------------------------------------------

export const config = { runtime: "edge" };

import { runHostTurn } from "../chat/completions.js";
import { assembleSpammerPrompt, SIM_CATALOG } from "./spammer.js";
import { makeTrace } from "../_trace.js";
import { waitUntil } from "@vercel/functions";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Generate one spammer line from the assembled persona + the conversation so far.
// history is OpenAI-shape from the HOST's perspective (user=spammer, assistant=
// host). For the spammer model we FLIP roles so it sees itself as the speaker.
async function spammerLine(cfg, history, turn) {
  const system = assembleSpammerPrompt({
    archetype: cfg.archetype,
    temperament: cfg.temperament,
    beats: cfg.beats,
    decay: cfg.decay,
    turn,
  });
  // Flip perspective: host's assistant turns become the spammer's "user"
  // (the person they're talking to), spammer's prior lines become "assistant".
  const flipped = history.map((m) => ({
    role: m.role === "assistant" ? "user" : "assistant",
    content: m.content,
  }));
  // Spammer must start; if nothing yet, seed with a nudge.
  const msgs = flipped.length ? flipped : [{ role: "user", content: "(the call connects)" }];
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify({ model: MODEL(), max_tokens: 300, system, messages: msgs }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("spammer upstream " + r.status + " " + t.slice(0, 200));
  }
  const data = await r.json();
  return (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
}

export default async function handler(req) {
  const u = new URL(req.url);
  const action = u.searchParams.get("action") || "catalog";

  if (req.method === "GET" || action === "catalog") {
    return json({ ok: true, catalog: SIM_CATALOG });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  if (action === "start") {
    const archetype = body.archetype || "generic";
    const temperament = body.temperament || "pushy_closer";
    const hostName = body.host_name || "Andrew";
    // Synthetic ids. target_id is what Mead Hall watches by; call_id keys the bus.
    const call_id = "sim-" + crypto.randomUUID();
    const target_id = "sim-" + crypto.randomUUID();

    // call_started on the bus so the Director's View opens the call.
    const trace = makeTrace(call_id, 0, waitUntil);
    await trace.emit(
      "call_started",
      { started_at: new Date().toISOString(), host_name: hostName, archetype, sim: true },
      "engine"
    );

    // Opening spammer line (turn 0).
    const cfg = { archetype, temperament, beats: body.beats || null, decay: !!body.decay };
    let opener = "";
    try { opener = await spammerLine(cfg, [], 0); } catch (e) { opener = "Hi! Thanks for hopping on."; }
    await trace.emit(
      "utterance",
      { speaker_role: "spammer", speaker_name: null, character_id: null, text: opener, turn_index: 0 },
      "spammer"
    );

    return json({
      ok: true,
      call_id,
      target_id,
      host_name: hostName,
      archetype,
      temperament,
      cfg,
      // history is HOST-perspective: the spammer's line is a "user" turn.
      history: [{ role: "user", content: opener }],
      catalog: SIM_CATALOG,
    });
  }

  if (action === "step") {
    const { call_id, history, cfg, host_name, archetype } = body;
    if (!call_id || !Array.isArray(history)) {
      return json({ error: "bad_request", detail: "need call_id + history" }, 400);
    }
    const meta = { hostName: host_name || "Andrew", archetype: archetype || (cfg && cfg.archetype) || "generic", slug: null };

    // 1) HOST turn on the current history (last entry is the spammer's line).
    //    runHostTurn does the REAL engine work + emits gear_state/host-utterance/
    //    bit_deployed to the bus, and reads /api/control so Director actions land.
    let host;
    try {
      host = await runHostTurn({ messages: history, callId: call_id, meta });
    } catch (e) {
      return json({ error: "host_turn_failed", detail: String(e).slice(0, 300) }, 502);
    }
    const newHistory = host.line
      ? history.concat([{ role: "assistant", content: host.line }])
      : history.slice();

    // Death Blow fired -> call is over, no spammer reply.
    if (host.deathBlowFiring) {
      return json({ ok: true, call_id, host_line: host.line, ended: true, ending: "death_blow", history: newHistory });
    }

    // 2) SPAMMER reply to the host.
    const turn = newHistory.filter((m) => m.role === "user").length;
    let reply = "";
    try { reply = await spammerLine(cfg || {}, newHistory, turn); }
    catch (e) { return json({ error: "spammer_failed", detail: String(e).slice(0, 300) }, 502); }

    // Emit the spammer utterance to the bus.
    const trace = makeTrace(call_id, turn, waitUntil);
    await trace.emit(
      "utterance",
      { speaker_role: "spammer", speaker_name: null, character_id: null, text: reply, turn_index: turn },
      "spammer"
    );
    const finalHistory = newHistory.concat([{ role: "user", content: reply }]);

    return json({ ok: true, call_id, host_line: host.line, spammer_line: reply, ended: false, history: finalHistory });
  }

  return json({ error: "unknown_action", detail: action }, 400);
}

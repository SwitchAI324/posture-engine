// SpamViking — BENCH AUTO-TRIGGER (the trunk)
// ----------------------------------------------------------------------
// Lets the CONVERSATION ITSELF surface a bench character or dangle a phantom —
// no Director required. Foundation for organic "populate" + situational phantoms.
//
// DATA-DRIVEN: invocation is driven by each character's AUTHORED
// invocationTriggers (in bench/<id>.json, read off BENCH[id].raw), NOT by
// hardcoded per-character rules here. This file's only job is to (1) detect
// which trigger SIGNALS are present this turn from conversation + gear state,
// and (2) match them against what each character declares, then fire organically.
// When the Bench chat edits a character's triggers, this picks them up for free.
//
// PHILOSOPHY (organic, not mechanical):
//   - A bench moment is EARNED by state: a character qualifies when the
//     conversation raises one of ITS declared triggers, and fires biased by
//     match strength. Self-regulating — no fixed "every call" rule.
//   - Turn count is used ONLY for light spacing, NEVER as a trigger.
//
// SAFETY:
//   - Ships DARK: does nothing unless env BENCH_AUTO=1.
//   - Auto is just another SOURCE feeding the existing arrival gate
//     (one-in-flight / ceiling / spacer), so it can't create a clown car.
// ----------------------------------------------------------------------

import { benchEntry, isPhantom, benchIds } from "./_bench_v2.js";

const ENABLED = () => process.env.BENCH_AUTO === "1";

// ---- SIGNAL DETECTION ----------------------------------------------------
// Map authored trigger NAMES (from the json) to detectable conditions over the
// current conversation + gear state. Single place trigger semantics live.
const SIGNALS = {
  push_for_decision: (s) => s.pressure === "pushing" || s.pressure === "extracting" || /\b(decision|sign off|sign-off|approve|budget|move forward|commit|deal|contract)\b/.test(s.text),
  asks_authority:    (s) => /\b(who decides|who approves|can you approve|do we have a deal|decision[- ]?maker|in charge)\b/.test(s.text),
  closing_pressure:  (s) => s.pressure === "extracting" || /\b(close|closing|sign|get started|move forward|next step|paperwork)\b/.test(s.text),
  asks_decision_maker: (s) => /\b(who signs|who else|anyone else|the boss|your manager|decision[- ]?maker|who approves|who's joining)\b/.test(s.text),
  advance_attempt:   (s) => s.pressure === "extracting" || /\b(let's|shall we|move forward|next step|get started|proceed|sign|close)\b/.test(s.text),
  asks_for_boss:     (s) => /\b(the boss|your boss|your manager|speak to|decision[- ]?maker|who's in charge|higher up)\b/.test(s.text),
  pressure_pushing_or_extracting: (s) => s.pressure === "pushing" || s.pressure === "extracting",
  caller_wants_decision: (s) => /\b(decision|decide|commit|move forward|deal)\b/.test(s.text),
  asks_commitment:   (s) => /\b(commit|can you do|will you|guarantee|promise|sign up|on board)\b/.test(s.text),
  caller_demands_specifics: (s) => /\b(how much|what's the price|exact|specifically|numbers|details|when exactly|which)\b/.test(s.text),
  caller_inflates:   (s) => /\b(best|leading|number one|guarantee|revolutionary|10x|millions|industry[- ]?leading)\b/.test(s.text),
  invokes_track_record: (s) => /\b(years of|experience|track record|we've done|our clients|proven|results)\b/.test(s.text),
  old_school_authority: (s) => s.engagement === "hooked" || s.engagement === "stunned",
  pitch_invites_yes: (s) => s.engagement === "hooked" && s.pressure !== "extracting",
  comic_over_eagerness: (s) => s.engagement === "hooked",
  offers_help:       (s) => /\b(problem|issue|need|help|struggling|challenge|pain point)\b/.test(s.text),
  personal_hook:     (s) => /\b(from|based in|calling from|our office|headquarters|located)\b/.test(s.text),
  warm_filler:       (s) => s.pressure === "calm" && s.engagement === "hooked",
  light_beat:        (s) => s.pressure === "calm" && s.engagement === "hooked",
  establish_the_team: (s) => s.arrivalsSoFar === 0 && s.pressure === "calm",
  join_struggle_draw: (s) => s.pressure === "calm" && s.engagement === "hooked",
  buzzword_theater:  (s) => s.pressure === "extracting",
  lull:              (s) => s.engagement === "bored" || s.pressure === "calm",
  wrap_or_sour:      (s) => s.slip === "slipping" || s.engagement === "bored" || /\b(not interested|gotta go|maybe later|think about it|call back)\b/.test(s.text),
  call_open:         (s) => s.arrivalsSoFar === 0 && s.benchTurn <= 3,
  feedback_moment:   (s) => /\b(barbara|your assistant|the email|your ea|calendar invite|booking)\b/.test(s.text),
  // Event-driven only (fired by the friction/event path, never conversational inference):
  host_conduct_slip: () => false, invoke_the_incident: () => false, stern_oversight: () => false,
  camera_issue: () => false, audio_glitch: () => false, connection_drop: () => false,
  background_oddity: () => false, anything_unexplained: () => false,
};

const STRENGTH = {
  call_open: 0.5, asks_decision_maker: 0.45, advance_attempt: 0.4, lull: 0.3,
  wrap_or_sour: 0.4, push_for_decision: 0.45, asks_authority: 0.45,
  closing_pressure: 0.4, asks_for_boss: 0.5, pressure_pushing_or_extracting: 0.35,
  caller_inflates: 0.35, invokes_track_record: 0.3, old_school_authority: 0.2,
  asks_commitment: 0.35, pitch_invites_yes: 0.25, comic_over_eagerness: 0.25,
  offers_help: 0.3, personal_hook: 0.3, warm_filler: 0.2, light_beat: 0.2,
  establish_the_team: 0.3, join_struggle_draw: 0.25, caller_demands_specifics: 0.35,
  caller_wants_decision: 0.35, buzzword_theater: 0.3, feedback_moment: 0.4,
};

// Strip parenthetical notes and PRECONDITION markers; return clean trigger names.
function triggerNames(entry) {
  const raw = entry && entry.raw && entry.raw.invocationTriggers;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => String(t).split("—")[0].trim())
    .filter((t) => t && !t.startsWith("("))
    .map((t) => t.replace(/^PRECONDITION\s+/, "").trim());
}

function lastSpammerText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content || "";
  }
  return "";
}

function rollFires(strength, seed) {
  if (strength <= 0) return false;
  if (strength >= 1) return true;
  let h = 0; const str = String(seed);
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return (h % 1000) / 1000 < strength;
}

function preconditionMet(id, state) {
  if (id === "gary") return !!state.barbaraEstablished; // no Barbara, no Gary
  return true;
}

function evaluate(state) {
  const ctx = {
    text: String(state.text || "").toLowerCase(),
    pressure: state.pressure, engagement: state.engagement, slip: state.slip,
    arrivalsSoFar: state.arrivalsSoFar, benchTurn: state.benchTurn,
    barbaraEstablished: state.barbaraEstablished,
  };
  const used = new Set((state.benchLog || []).map((e) => String(e.bench_id).toUpperCase()));
  const candidates = [];
  for (const tag of benchIds()) {
    const entry = benchEntry(tag);
    if (!entry) continue;
    if (!preconditionMet(entry.id, ctx)) continue;
    const phantom = entry.type === "phantom";
    if (!phantom && used.has(tag)) continue; // seen/audio arrive once
    let best = 0, bestWhy = null;
    for (const name of triggerNames(entry)) {
      const sig = SIGNALS[name];
      if (typeof sig === "function" && sig(ctx)) {
        const st = STRENGTH[name] || 0.25;
        if (st > best) { best = st; bestWhy = name; }
      }
    }
    if (best > 0) candidates.push({ type: phantom ? "phantom" : "arrive", who: tag, strength: best, why: bestWhy });
  }
  return candidates;
}

export function autoBenchAction(state) {
  if (!ENABLED()) return null;
  const st = {
    text: state.messages ? lastSpammerText(state.messages) : "",
    pressure: (state.gearState && state.gearState.pressure) || "calm",
    engagement: (state.gearState && state.gearState.engagement) || "hooked",
    slip: (state.gearState && state.gearState.slip) || null,
    arrivalsSoFar: (state.benchLog || []).length,
    benchTurn: state.benchTurn || 0,
    benchLog: state.benchLog,
    barbaraEstablished: state.barbaraEstablished,
  };
  const candidates = evaluate(st);
  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    (b.strength + (b.type === "phantom" ? 0.05 : 0)) -
    (a.strength + (a.type === "phantom" ? 0.05 : 0))
  );
  const top = candidates[0];
  if (!rollFires(top.strength, `${state.callId}:${st.benchTurn}:${top.who}`)) return null;
  return top;
}

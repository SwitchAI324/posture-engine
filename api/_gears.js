// SpamViking — Posture Engine: THE GEARS (Phase 3, FORCE-SET)
// ----------------------------------------------------------------------
// Three INDEPENDENT dials track the spammer. Andrew holds one position on
// each at all times; together they are his marching orders for the turn.
//
//   GEAR 1  SUSPICION   (defensive) does the cover hold?
//             alive -> slipping -> foregone   (->foregone is ONE-WAY)
//   GEAR 2  PRESSURE    (defensive) how hard are they pushing to extract?
//             calm <-> pushing <-> extracting (all reversible)
//   GEAR 3  ENGAGEMENT  (offensive) how hooked are they?
//             bored <-> hooked <-> stunned    (all reversible)
//
// FORCE-SET layer: instant keyword rules over the latest caller line, pure &
// synchronous, safe on the hot path. Subtle reads (windowed engagement DRIFT,
// quiet suspicion, tone) are the Governor's job (Phase 4) — async, never
// blocks the voice. See _governor_inputs note at the bottom.
//
// HARVESTED from the prompt doc this version:
//   * §5.6 slip ACCUMULATOR -> suspicion now needs sustained tells to flip
//     (hysteresis), with warmth_return cooling it. No more single-word flips.
//   * §5.8 engagement signal lists -> folded into the engagement tell-set.
// ----------------------------------------------------------------------

import { TELLS } from "./_gears_tells.js";

export const AXES = {
  // --- GEAR 1: SUSPICION (accumulator model, harvested from §5.6) --------
  suspicion: {
    default: "alive",
    states: {
      alive: {
        directive:
          "Cover intact — they believe you're a real person. Stay natural, " +
          "keep working the bait.",
        transitions: ["slipping", "foregone"],
      },
      slipping: {
        directive:
          "SALVAGE — they suspect an AI. Get human and imperfect, make a " +
          "small human aside, deflect casually and warmly. NEVER admit it, " +
          "never go robotic or defensive.",
        transitions: ["alive", "foregone"],
      },
      foregone: {
        directive:
          "Cover blown — they're sure, calling it out, or leaving. " +
          "Unrecoverable; don't fight it.",
        transitions: [], // one-way: terminal
      },
    },
    // Slip accumulator: tells add to a counter; flip only when it crosses the
    // threshold; warmth_return cools it; an explicit hard_exit bypasses the
    // counter and goes straight to FOREGONE (one-way).
    accumulator: {
      counter: "slip",
      threshold: 2, // explicit tell (w:2) flips at once; soft tells need two
      advance: { from: "alive", to: "slipping" },
      relax: { from: "slipping", to: "alive" }, // needs sustained warmth
      hardExit: {
        re: TELLS.suspicion.hardExit,
        to: "foregone",
      },
      warmth: {
        re: TELLS.suspicion.warmth,
      },
      tells: [
        // explicit accusation -> weight 2 (flips immediately at threshold 2)
        {
          w: 2,
          re: TELLS.suspicion.strong,
        },
        // soft / ambiguous tell -> weight 1 (needs two to flip)
        {
          w: 1,
          re: TELLS.suspicion.soft,
        },
      ],
    },
  },

  // --- GEAR 2: PRESSURE (rules model) -----------------------------------
  pressure: {
    default: "calm",
    states: {
      calm: {
        directive:
          "No real pressure yet — they're still pitching. Stay easy and " +
          "interested.",
        transitions: ["pushing", "extracting"],
      },
      pushing: {
        directive:
          "They're trying to close. Stall — sound willing, but keep putting " +
          "obstacles between them and the commitment.",
        transitions: ["calm", "extracting"],
      },
      extracting: {
        directive:
          "They want the payment/card/transfer NOW. Appear to comply but " +
          "fumble endlessly — never actually complete it.",
        transitions: ["calm", "pushing"],
      },
    },
    rules: [
      {
        re: TELLS.pressure.extracting,
        from: ["calm", "pushing"],
        to: "extracting",
      },
      {
        re: TELLS.pressure.pushing,
        from: ["calm"],
        to: "pushing",
      },
      {
        re: TELLS.pressure.calm,
        from: ["pushing", "extracting"],
        to: "calm",
      },
    ],
  },

  // --- GEAR 3: ENGAGEMENT (rules model; tells harvested from §5.8) -------
  engagement: {
    default: "hooked",
    states: {
      bored: {
        directive:
          "They're disengaging (shorter replies, exit pressure). Re-hook, " +
          "don't chase: warm back up and drop ONE genuinely intriguing hook " +
          "or question to restart momentum. If they re-engage, resume; if " +
          "they keep pulling away, let the close path take over — don't force " +
          "it.",
        transitions: ["hooked", "stunned"],
      },
      hooked: {
        directive: "They're engaged. Keep working the bait — normal.",
        transitions: ["bored", "stunned"],
      },
      stunned: {
        directive:
          "They're thrown, amused, or off-script. Milk it — go long, get " +
          "bolder; they'll stay.",
        transitions: ["hooked", "bored"],
      },
    },
    rules: [
      // NEGATIVE signals (§5.8) -> disengaging.
      {
        re: TELLS.engagement.bored,
        from: ["hooked", "stunned"],
        to: "bored",
      },
      // POSITIVE-but-THROWN (§5.8) -> amused / off-script. (Crude; the real
      // amusement read is the Governor's.)
      {
        re: TELLS.engagement.stunned,
        from: ["hooked", "bored"],
        to: "stunned",
      },
      // POSITIVE-engaged (§5.8) -> leaning back in.
      {
        re: TELLS.engagement.hooked,
        from: ["bored", "stunned"],
        to: "hooked",
      },
    ],
  },
};

// The neutral starting position on all three dials (+ the slip accumulator).
export function defaultState() {
  return {
    suspicion: AXES.suspicion.default,
    pressure: AXES.pressure.default,
    engagement: AXES.engagement.default,
    slip: 0,
  };
}

// One accumulator step for an axis (the suspicion model). Reads/writes its
// counter on `next`. Returns whether the gear flipped and whether anything
// (gear OR counter) changed (so the caller knows to persist).
function stepAccumulator(def, axis, next, text) {
  const a = def.accumulator;
  let cur = def.states[next[axis]] ? next[axis] : def.default;
  let count = next[a.counter] || 0;
  const before = cur, beforeCount = count;

  if (def.states[cur].transitions.length === 0) {
    return { changed: false, dirty: false }; // terminal, locked
  }
  if (a.hardExit.re.test(text)) {
    next[axis] = a.hardExit.to;
    next[a.counter] = 0;
    return { changed: true, from: before, to: a.hardExit.to, dirty: true };
  }
  if (a.warmth && a.warmth.re.test(text)) count = Math.max(0, count - 1);
  for (const t of a.tells) {
    if (t.re.test(text)) { count = Math.min(a.threshold, count + t.w); break; }
  }
  if (cur === a.advance.from && count >= a.threshold) cur = a.advance.to;
  else if (cur === a.relax.from && count <= 0) cur = a.relax.to;

  next[axis] = cur;
  next[a.counter] = count;
  const changed = cur !== before;
  return { changed, from: before, to: cur, dirty: changed || count !== beforeCount };
}

// Run FORCE-SET across all three axes for one caller utterance. Each axis is
// independent; a single line can move more than one. Returns the new state,
// the list of gear changes (for logging), and a dirty flag (persist if set).
export function applyForceAll(state, utterance) {
  const text = utterance || "";
  const next = { ...defaultState(), ...state };
  const changes = [];
  let dirty = false;

  for (const [axis, def] of Object.entries(AXES)) {
    if (def.accumulator) {
      const res = stepAccumulator(def, axis, next, text);
      if (res.changed) changes.push({ axis, from: res.from, to: res.to });
      if (res.dirty) dirty = true;
      continue;
    }
    let cur = def.states[next[axis]] ? next[axis] : def.default;
    if (def.states[cur].transitions.length === 0) { next[axis] = cur; continue; }
    for (const r of def.rules) {
      if (r.from && !r.from.includes(cur)) continue;
      if (!def.states[cur].transitions.includes(r.to)) continue;
      if (r.re.test(text)) {
        if (r.to !== cur) { changes.push({ axis, from: cur, to: r.to }); dirty = true; }
        cur = r.to;
        break;
      }
    }
    next[axis] = cur;
  }
  return { state: next, changes, dirty };
}

// Build the single mutable posture block injected after the cached prefix.
export function postureBlock(state) {
  const s = { ...defaultState(), ...state };
  const line = (axis) => {
    const pos = AXES[axis].states[s[axis]] ? s[axis] : AXES[axis].default;
    return `- ${axis} (${pos}): ${AXES[axis].states[pos].directive}`;
  };
  return (
    "CURRENT POSTURE — your read on the caller right now:\n" +
    [line("suspicion"), line("pressure"), line("engagement")].join("\n")
  );
}

// Director's Death Blow: force suspicion -> FOREGONE from any state.
export function deathBlow(state, finisher = "default") {
  return { ...state, suspicion: "foregone", slip: 0, _finisher: finisher };
}

// _governor_inputs (Phase 4, NOT built here — harvested spec from §5.6/§5.8).
// These curated signals have NO keyword and cannot live in FORCE-SET; they are
// trend/meta reads the async Governor must judge. Captured here so the prompt
// retirement loses nothing — they land in the Governor, not the keyword layer.
//   ENGAGEMENT drift (-> bored/hooked/stunned by meaning):
//     * reply length dropping turn over turn
//     * latency growing (longer gaps before replies)
//     * questions drying up; monosyllabic 3+ turns; silence 10+ sec
//     * warmth draining / tone flattening / energy no longer matched
//     * duration EXTENDING + curiosity on tangents (-> stunned, positive)
//     * audible note-taking / mentioning colleagues (-> hooked, positive)
//   QUIET SUSPICION (-> adds to the slip accumulator):
//     * repeated probing; fact-checking answers against earlier ones
//   TONE: angry / dismissive / playful -> fit tiebreaker + gear_bias.
// All run async, off the hot path, and only ever ADJUST the same state.

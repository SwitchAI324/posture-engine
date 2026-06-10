// SpamViking — Posture Engine: DOUBT-GEARS runtime (Phase 3, FORCE-SET)
// ----------------------------------------------------------------------
// The runtime counterpart to posture_engine_doubt_gears.md. Edge-safe:
// pure code, no I/O, no LLM. This is the FORCE-SET layer only — instant
// rules over the latest caller utterance. The nuanced drift read (the
// Governor) is Phase 4 and runs async; it is NOT here, by design, so this
// layer can never add latency.
//
// Gears: ALIVE (entry) <-> SLIPPING (active) -> FOREGONE (terminal).
// ALIVE<->SLIPPING reversible; ->FOREGONE one-way (terminal has no exits).
// ----------------------------------------------------------------------

export const GEARS = {
  alive: {
    directive:
      "The opportunity is real and moving. Warm, forward, generous with " +
      "next steps — keep them leaning in.",
    transitions: ["slipping", "foregone"],
  },
  slipping: {
    directive:
      "Let quiet doubt surface. Imply this might not come together; cool " +
      "slightly, hedge commitments — make them work to keep it alive.",
    transitions: ["alive", "foregone"],
  },
  foregone: {
    directive:
      "It is not happening. Signal the door closing — polite, final, " +
      "unhurried.",
    transitions: [], // one-way: terminal
  },
};

// Instant rules over the latest caller (spammer) utterance. Each rule fires
// only from an allowed `from` gear and only if the target is a legal
// transition. First match wins.
const RULES = [
  // Spammer gives up / wraps -> FOREGONE (the bait is foregone).
  {
    re: /\b(never ?mind|forget it|not worth|waste of (?:my )?time|i'?ll (?:just )?email|good ?bye|i'?m hanging up|lose my number)\b/i,
    to: "foregone",
  },
  // Spammer pushes to close/collect -> let doubt show (SLIPPING).
  {
    re: /\b(move forward|let'?s close|ready to sign|sign (?:you )?up|payment|credit card|card number|get you set up|send (?:me )?(?:your )?(?:card|details|payment|info))\b/i,
    from: ["alive"],
    to: "slipping",
  },
  // Spammer sweetens the deal -> re-warm (back to ALIVE).
  {
    re: /\b(still interested|great deal|special (?:price|offer)|discount|just for you|limited time|knock off)\b/i,
    from: ["slipping"],
    to: "alive",
  },
];

// FORCE-SET: (gear, latest utterance) -> { gear, changed, rule }.
// Pure, synchronous, microsecond-cheap. Safe on the hot path.
export function applyForce(gear, utterance) {
  const g = GEARS[gear] ? gear : "alive";
  if (g === "foregone") return { gear: g, changed: false, rule: null }; // terminal
  const text = utterance || "";
  for (const r of RULES) {
    if (r.from && !r.from.includes(g)) continue;
    if (!GEARS[g].transitions.includes(r.to)) continue;
    if (r.re.test(text)) {
      return { gear: r.to, changed: r.to !== g, rule: r.re.source.slice(0, 28) };
    }
  }
  return { gear: g, changed: false, rule: null };
}

// Director's Death Blow: force FOREGONE + a chosen rung, from any gear.
export function deathBlow(rung = "final") {
  return { gear: "foregone", rung, changed: true };
}

// Gear (+ optional rung) -> the one-line directive injected per turn.
export function directiveFor(gear, rung) {
  const g = GEARS[gear] ? gear : "alive";
  let d = GEARS[g].directive;
  if (g === "foregone" && rung) d += ` [rung: ${rung}]`;
  return d;
}

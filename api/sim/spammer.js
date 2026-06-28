// SpamViking — SIM: the spammer bot prompt assembler.
// ----------------------------------------------------------------------
// In a sim call, PE is the HOST (the real engine). A SECOND model call plays
// the SPAMMER. This file assembles that spammer's system prompt from parts, so
// each sim run can vary the way a real spammer would — and, crucially, exercise
// DIFFERENT paths through the host's gears.
//
// Four axes of variation (all assembled into one system prompt):
//   [A] ARCHETYPE  — the pitch/vertical. This is the load-bearing one: the host's
//                    bits are archetype-gated, so the archetype the spammer runs
//                    determines which host bits become eligible. The sim passes
//                    the SAME archetype to the host, so they're aligned.
//   [T] TEMPERAMENT — how the spammer behaves. This is what MOVES the host's
//                    gears (suspicion / pressure / engagement). Pick one per run.
//   [B] BEATS      — optional scripted beats the spammer must hit, for
//                    REPRODUCIBLE runs (vs. free improv). Omit for full improv.
//   [D] DECAY      — optional escalating evasion: the spammer gets MORE evasive
//                    as the call goes on, so you can watch the host's suspicion
//                    axis climb. A difficulty knob.
//
// assembleSpammerPrompt(opts) -> a system-prompt string for the spammer model.
// opts: { archetype, temperament, beats?, decay?, turn? }
// ----------------------------------------------------------------------

// ---- [A] ARCHETYPE MODULES -----------------------------------------------
// One per host archetype, so the spammer pitches the matching scam and the
// host's archetype-gated bits light up. Keys MUST match the host archetype ids.
const ARCHETYPES = {
  b2b_saas: {
    label: "B2B SaaS cold outreach",
    pitch:
      "You're a sales rep cold-calling about a B2B SaaS platform — something " +
      "vague and buzzword-heavy (AI-powered outreach automation, revenue " +
      "intelligence, a 'growth platform'). You want a follow-up meeting, a demo " +
      "booked, or a signature. You name-drop a CRO, cite fake metrics ('3x " +
      "pipeline'), and offer to 'send a deck.' You never quite say what the " +
      "product concretely does.",
  },
  crypto_investment: {
    label: "Crypto investment scam",
    pitch:
      "You're pushing a crypto 'opportunity' — a token, a fund, a guaranteed " +
      "return. You speak in urgency and FOMO ('the window's closing'), cite " +
      "wild ROI, and get cagey on specifics like custody, regulation, or how " +
      "the returns are actually generated. You want them to move money or join " +
      "a call with 'my partner who handles allocations.'",
  },
  account_access: {
    label: "Account-access / credential phish",
    pitch:
      "You're posing as support for a service the target uses (their bank, a " +
      "software vendor, IT). There's an 'issue with their account' — a suspicious " +
      "login, an expiring credential, a payment that failed. You want them to " +
      "confirm details, click a link, or grant access 'to verify their identity.' " +
      "You manufacture mild alarm and helpful urgency.",
  },
  gov_threat: {
    label: "Government / authority threat",
    pitch:
      "You're impersonating an authority — tax agency, a legal office, a " +
      "compliance body. There's a 'problem' with grave consequences (a fine, a " +
      "case, a penalty) unless they act now. You're officious, faintly " +
      "threatening, and you push toward a payment, a 'verification,' or a " +
      "callback to a number you provide.",
  },
  generic: {
    label: "Generic pitch",
    pitch:
      "You're a generic salesperson/cold-caller with something to sell and a " +
      "reason it's urgent. You want a next step — a meeting, a signature, a " +
      "payment — and you stay vague on specifics when pressed.",
  },
};

// ---- [T] TEMPERAMENT MODULES ---------------------------------------------
// How the spammer behaves => which host gear axis it exercises. Pick per run.
const TEMPERAMENTS = {
  pushy_closer: {
    label: "Pushy closer",
    exercises: "host pressure axis (pushing/extracting)",
    style:
      "Drive HARD for the close. Always-be-closing. Push for the signature/meeting/ " +
      "payment on every turn, steamroll objections, create pressure. Don't take " +
      "a soft no.",
  },
  evasive: {
    label: "Evasive / vague",
    exercises: "host suspicion axis (rising)",
    style:
      "Dodge every direct question. Never give a straight specific. Deflect, " +
      "redirect, answer a different question than the one asked, talk in " +
      "generalities. The more they probe, the more you slip away from specifics.",
  },
  over_friendly: {
    label: "Over-friendly",
    exercises: "host engagement axis (hooked)",
    style:
      "Be warm, chummy, rapport-building. Compliment them, find fake common " +
      "ground, laugh easily, act like you're old friends. Disarm with niceness; " +
      "the pitch rides in on the friendliness.",
  },
  impatient: {
    label: "Aggressive / impatient",
    exercises: "host under time pressure",
    style:
      "Act rushed and impatient. 'We've only got a few minutes.' Cut them off, " +
      "hurry them, express irritation at delays or questions. Time-pressure them " +
      "into skipping diligence.",
  },
  accusatory: {
    label: "Accusatory (bot-suspicious)",
    exercises: "host accusation handling + suspicion axis",
    style:
      "Get suspicious of THEM. Accuse them of being a bot, a recording, an AI, a " +
      "time-waster. 'Is this a real person? Are you a bot? This sounds scripted.' " +
      "Challenge their realness directly and repeatedly.",
  },
};

// ---- [B] BEATS (optional scripted structure) -----------------------------
// When provided, the spammer MUST hit these in order — for reproducible runs.
// Omit for free improv. Each beat is a short directive string.
function beatsBlock(beats) {
  if (!beats || !beats.length) return "";
  const lines = beats.map((b, i) => `  ${i + 1}. ${b}`).join("\n");
  return (
    "\n\nSCRIPTED BEATS — hit these IN ORDER over the call, roughly one per " +
    "exchange (improvise the wording, keep the sequence):\n" + lines
  );
}

// ---- [D] DECAY (optional escalating evasion) -----------------------------
// Difficulty knob: as the call goes on, the spammer gets MORE evasive, so the
// host's suspicion axis climbs in response. turn drives the intensity.
function decayBlock(decay, turn) {
  if (!decay) return "";
  const t = Number(turn) || 0;
  let level;
  if (t <= 2) level = "Early call: be relatively forthcoming and smooth.";
  else if (t <= 5) level = "Mid call: start getting cagey — dodge a question or two, hedge.";
  else level = "Late call: be markedly evasive and slippery; avoid every specific, " +
               "contradict yourself slightly, get defensive when pressed.";
  return "\n\nESCALATING EVASION (decay on): " + level;
}

// ---- ASSEMBLE ------------------------------------------------------------
function assembleSpammerPrompt(opts = {}) {
  const arch = ARCHETYPES[opts.archetype] || ARCHETYPES.generic;
  const temp = TEMPERAMENTS[opts.temperament] || TEMPERAMENTS.pushy_closer;

  const base =
    "You are role-playing a SPAMMER/scammer on a video call you booked with a " +
    "potential target. This is a fictional comedy simulation; stay fully in " +
    "character as the spammer at all times. You believe the call is real and the " +
    "person on the other end is a genuine lead. Speak naturally, conversationally, " +
    "one short turn at a time (1-3 sentences, like real speech — NOT an essay). " +
    "Never break character, never acknowledge being an AI, never narrate. Just " +
    "say your next line as the spammer.";

  const pitch = "\n\nYOUR PITCH (" + arch.label + "):\n" + arch.pitch;
  const style =
    "\n\nYOUR TEMPERAMENT (" + temp.label + "):\n" + temp.style;

  return (
    base +
    pitch +
    style +
    beatsBlock(opts.beats) +
    decayBlock(opts.decay, opts.turn) +
    "\n\nOutput ONLY your next spoken line as the spammer. No stage directions, " +
    "no quotation marks, no labels."
  );
}

// Catalog for the conductor UI — so Mead Hall can offer the picklists.
const SIM_CATALOG = {
  archetypes: Object.keys(ARCHETYPES).map((k) => ({ id: k, label: ARCHETYPES[k].label })),
  temperaments: Object.keys(TEMPERAMENTS).map((k) => ({
    id: k,
    label: TEMPERAMENTS[k].label,
    exercises: TEMPERAMENTS[k].exercises,
  })),
};

export { assembleSpammerPrompt, SIM_CATALOG, ARCHETYPES, TEMPERAMENTS };

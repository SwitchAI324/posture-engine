// SpamViking — Posture Engine: GEAR TELLS (recognition patterns)
// ----------------------------------------------------------------------
// TRIMMED (Stage-4). Division of labor between the two gear layers:
//
//   KEYWORD layer (this file, synchronous, THIS turn): kept ONLY for the SHARP,
//   UNAMBIGUOUS, INSTANT-REACTION signals where same-turn response matters and
//   the phrasing is explicit enough that regex nails it — i.e. SUSPICION
//   (accusations / hard exits) and ACCUSATION typing. These must move the gear
//   THIS turn so the host reacts to "are you a bot?" in its very next line.
//
//   SEMANTIC layer (readCall in completions.js, async, NEXT turn): owns the
//   GRADUAL signals — PRESSURE and ENGAGEMENT (and phase). These build over
//   turns, so the reader's one-turn lag is invisible, and meaning-reading beats
//   brittle archetype-specific keywords. So pressure/engagement keyword rules
//   below are intentionally NO-OP stubs — the reader moves those axes.
//
// Case-insensitive, phrase-favoring. Fires on the CALLER's line only.
// ----------------------------------------------------------------------
export const TELLS = {
  // GEAR 1: SUSPICION — unchanged (already working).
  suspicion: {
    hardExit: /\b(you'?re (?:definitely|clearly|obviously) (?:a bot|an ai|a robot|not (?:a )?real|a recording)|i know (?:this is|you'?re) (?:a bot|an ai|automated)|reporting (?:you|this)|this is a scam ?bot|good ?bye)\b/i,
    warmth: /\b(oh ok(?:ay)?|okay (?:great|good|cool|fine)|got it|gotcha|makes sense|that makes sense|my mistake|sorry to bother|never mind (?:then|about that))\b/i,
    strong: /\b(are you (?:a |an )?(?:ai|bot|robot|recording|machine)|is this (?:a |an )?(?:ai|bot|recording|automated)|am i (?:talking|speaking) (?:to|with) (?:a |an )?(?:bot|machine|ai|computer)|this is (?:automated|a recording|pre-?recorded)|you'?re (?:a )?(?:bot|ai|robot|recording))\b/i,
    soft: /\b(you sound (?:a (?:little|bit) )?(?:off|odd|strange|automated|robotic|scripted|weird|funny)|are you (?:even )?(?:real|there|listening))\b/i,
  },

  // GEAR 2: PRESSURE — TRIMMED. Keyword rules are intentionally no-op now.
  // The async meaning-reader (readCall) owns pressure: it reads INTENT across
  // all archetypes, and pressure builds gradually so the reader's one-turn lag
  // is invisible. Keywords were redundant + brittle here (archetype-specific
  // nouns, false-fires like "no deal, I have insurance"). Kept as stubs so the
  // axis structure is intact; the reader moves it.
  pressure: {
    extracting: /\bxxxneverxxx\b/i,
    pushing: /\bxxxneverxxx\b/i,
    calm: /\bxxxneverxxx\b/i,
  },

  // GEAR 3: ENGAGEMENT — TRIMMED. Same reasoning as pressure. Engagement drifts
  // gradually (bored/hooked/stunned build over turns), so the reader's one-turn
  // lag doesn't matter, and meaning beats keywords for "is the caller checking
  // out / genuinely thrown." The async reader owns this axis.
  engagement: {
    bored: /\bxxxneverxxx\b/i,
    stunned: /\bxxxneverxxx\b/i,
    hooked: /\bxxxneverxxx\b/i,
  },

  // ACCUSATION — tags the TYPE of accusation (used by suspicion + bit select).
  accusation: {
    ai: /\b(are you (?:a |an )?(?:ai|bot|robot|recording|machine|computer)|is this (?:a |an )?(?:ai|bot|recording|automated)|you'?re (?:a )?(?:bot|ai|robot|recording)|this is (?:automated|a recording|pre-?recorded)|talking to (?:a |an )?(?:bot|machine|ai))\b/i,
    scam: /\b(this is (?:a )?(?:scam|fraud|fake)|you'?re (?:scamming|a scammer|trying to scam)|(?:i'?m )?reporting (?:you|this)|fraud(?:ulent)?|(?:this is )?illegal|i'?m calling the (?:police|cops|authorities|bank))\b/i,
    time_waste: /\b(wasting my time|waste of (?:my )?time|is this a joke|are you (?:kidding|joking|serious)|stop wasting|this is ridiculous|you'?re wasting|i don'?t have time for this)\b/i,
  },
};

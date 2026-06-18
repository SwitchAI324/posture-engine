// SpamViking — the BENCH BRAIN (v1).
// ----------------------------------------------------------------------
// One engine, host leads, bench follows. On a trigger, the engine tells the
// LLM to bring a bench character into the call and tag their lines [[NAME]];
// the TTS proxy (tts.js) then voices that character. This file owns the two
// decisions: WHEN someone arrives, and WHO.
//
// v1 is the dumbest reliable trigger — a single deterministic arrival on a set
// turn — so we can prove a second voice on a live call. Gear-driven triggers
// (arrive when ENGAGEMENT hits stunned, or SUSPICION slips), persistence
// ("Conrad stays and interjects"), and multiple characters are v2.
//
// Tuning (Vercel env, no redeploy of logic needed):
//   BENCH_ARRIVE_TURN  which user-turn the arrival fires on   (default 2)
//   BENCH_ARRIVE_WHO   which character arrives                (default CONRAD)
// Names must match the VOICES map in _voices.js (HOST/CONRAD/BONNIE/ANDREA).
// ----------------------------------------------------------------------

export const BENCH = {
  CONRAD: {
    tag: "CONRAD",
    note: "Andrew's boss — blunt, impatient, openly suspicious this call is wasting his team's time",
  },
  BONNIE: {
    tag: "BONNIE",
    note: "a sharp, no-nonsense colleague who asks the pointed question Andrew is too polite to ask",
  },
  ANDREA: {
    tag: "ANDREA",
    note: "an over-eager junior who keeps trying to 'help' and talks over people",
  },
};

const ARRIVE_TURN = parseInt(process.env.BENCH_ARRIVE_TURN || "2", 10);
const ARRIVE_WHO = (process.env.BENCH_ARRIVE_WHO || "CONRAD").toUpperCase();

function cap(s) {
  return s.charAt(0) + s.slice(1).toLowerCase();
}

// Decide the bench move for THIS turn. Returns { tag, cue } to inject into the
// mutable system block, or null. v1: one deterministic arrival on ARRIVE_TURN.
export function benchCue(turn) {
  if (turn !== ARRIVE_TURN) return null;
  const c = BENCH[ARRIVE_WHO] || BENCH.CONRAD;
  const name = cap(c.tag);
  const cue =
    "\n\nBENCH ARRIVAL — " + name + ", " + c.note + ", joins the call right now. " +
    "In your next reply, give Andrew's own line first, then have " + name +
    " cut in. Tag EVERY " + name + " line EXACTLY like this: [[" + c.tag +
    "]] their words here. Do NOT tag Andrew's own lines. Keep it short and " +
    "in-world — never mention tags, bits, or that anyone 'joined,' and don't " +
    "narrate the arrival; just let " + name + " start talking.";
  return { tag: c.tag, cue };
}

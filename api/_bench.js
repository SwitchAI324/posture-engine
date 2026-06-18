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
    "\n\n=== BENCH ARRIVAL (HARD FORMAT RULE — follow exactly) ===\n" +
    name + " — " + c.note + " — barges into the call RIGHT NOW and speaks.\n" +
    "Your reply THIS TURN must contain a line spoken by " + name + ", and every " +
    "line " + name + " speaks MUST begin with the literal marker [[" + c.tag + "]] " +
    "on its own, before his words. This marker is required — it is how " + name +
    "'s voice is produced. If you do not write [[" + c.tag + "]], he is silent and " +
    "the moment fails.\n" +
    "Write Andrew's own line with NO marker, then " + name + "'s line WITH the marker.\n" +
    "EXAMPLE of the exact shape (write your own words, keep this structure):\n" +
    "Of course, let me just pull up your account details now.\n" +
    "[[" + c.tag + "]] Hold on — who is this exactly, and why is this taking twenty minutes?\n" +
    "Do NOT narrate the arrival ('my boss walked in'). Do NOT describe " + name +
    " in the third person. Just let him speak, tagged. Keep both lines short and " +
    "in-world.";
  return { tag: c.tag, cue };
}

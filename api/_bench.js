// SpamViking — the BENCH BRAIN (v1, engine-injected).
// ----------------------------------------------------------------------
// One engine, host leads, bench follows. We learned the model will NOT emit a
// [[NAME]] tag on request — the single-host persona is too strong, so it just
// ignores the cue. So the engine stops asking and WRITES the bench line itself:
// on an arrival turn it appends "[[CONRAD]] <line>" to the streamed output, so
// the marker is guaranteed and the TTS proxy voices Conrad. No model compliance
// required.
//
// v1 uses canned arrival lines (instant, guaranteed) to prove the second voice
// on a live call. v2: generate Conrad's line from the live conversation, let
// him persist and interject, and drive arrival off the gears (stunned/slipping)
// instead of a fixed turn.
//
// Tuning (Vercel env):
//   BENCH_ARRIVE_TURN  which user-turn the arrival fires on   (default 2)
//   BENCH_ARRIVE_WHO   CONRAD | BONNIE | ANDREA               (default CONRAD)
// Names must match the VOICES map in _voices.js.
//
// DIRECTOR OVERRIDE (added): benchSelect(benchId) resolves a Director-chosen
// character to the SAME {tag,note,line} shape as the auto inject, so a manually
// sent-in bench (via /api/control?action=bench) flows through the identical
// path. benchIds() lists the valid ids for the control endpoint to validate.
// ----------------------------------------------------------------------
export const BENCH = {
  CONRAD: {
    tag: "CONRAD",
    note: "Andrew's boss — blunt, impatient, suspicious this is wasting time",
    lines: [
      "Hold on, hold on. Who is this, and why is this taking so long?",
      "Andrew. Andrew. Is this that vendor call? What are we even looking at here?",
      "Wait a second. What exactly are we paying for? Because I'm not hearing it.",
      "Who am I talking to? Because so far this sounds like a whole lot of nothing.",
      "Let me jump in here. I've got about ninety seconds. Give me the real number.",
    ],
  },
  BONNIE: {
    tag: "BONNIE",
    note: "sharp, no-nonsense colleague who asks the pointed question",
    lines: [
      "Sorry to cut in — can you just tell us who you actually are first?",
      "Quick question before we go further: who referred you to us, exactly?",
      "Hang on. Before Andrew gets excited, what's this actually going to cost?",
    ],
  },
  ANDREA: {
    tag: "ANDREA",
    note: "over-eager junior who talks over people trying to help",
    lines: [
      "Oh! Oh, I can take notes! Wait, what did they just say? I missed it!",
      "Hi! Hi, sorry, I just joined — are we doing the thing? What thing are we doing?",
      "I love this already! Should I pull up the spreadsheet? I'll pull up the spreadsheet!",
    ],
  },
};
const ARRIVE_TURN = parseInt(process.env.BENCH_ARRIVE_TURN || "2", 10);
const ARRIVE_WHO = (process.env.BENCH_ARRIVE_WHO || "CONRAD").toUpperCase();
function pick(a) {
  return a[Math.floor(Math.random() * a.length)];
}
// Decide the bench move for THIS turn. Returns { tag, line } to append to the
// streamed output (tagged), or null. v1: one deterministic arrival.
export function benchInject(turn) {
  if (turn !== ARRIVE_TURN) return null;
  const c = BENCH[ARRIVE_WHO] || BENCH.CONRAD;
  return { tag: c.tag, note: c.note, line: pick(c.lines) };
}

// Director override: resolve a chosen bench id to the SAME shape benchInject
// returns, so a manually sent-in character flows through the identical inject
// path. Accepts any casing (BENCH keys are uppercase tags). Returns
// { tag, note, line } or null if the id isn't a known bench character.
export function benchSelect(benchId) {
  if (!benchId) return null;
  const key = String(benchId).toUpperCase();
  const c = BENCH[key];
  if (!c) return null;
  return { tag: c.tag, note: c.note, line: pick(c.lines) };
}

// The set of bench ids a Director may send in (uppercase tags). Used by the
// control endpoint to validate ?action=bench before writing.
export function benchIds() {
  return Object.keys(BENCH);
}

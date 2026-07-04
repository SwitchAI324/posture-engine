// SpamViking — the BENCH BRAIN v2 (staged, engine-injected).
// ----------------------------------------------------------------------
// v1 proved the second voice with one canned line. v2 makes JOINING A SCENE:
// a multi-turn staged arrival (entrance -> settling -> developing -> resolved),
// performed by a DEDICATED bench model call so the staging is actually carried
// out (v1 learned the single-host persona ignores a [[NAME]] cue, so we never
// ask the host to play the bench — we generate the bench line in its own call
// and append it tagged).
//
// MANIFESTATION (branch on the character's `type`):
//   seen    -> arrives on camera. Full staged arrival.
//   audio   -> on the line, camera off. Full staged arrival.
//   phantom -> NEVER arrives; host INVOKES/dangles them. No stages.
//
// JOIN MOVES are STAGING DIRECTIONS (not canned text) the dedicated bench call
// performs. Personality-typed (anxious | dominant | smooth); a character's own
// signature overrides the generic pool.
//
// ROSTER: 3 real characters today (CONRAD/BONNIE/ANDREA from v1) with typed
// slots ready for the full bench. Drop a character in with {type, personality,
// note, signature?} and the machine handles them. Per-character canon
// (phantom theAbsence, signatures) comes from the Bench chat's blocks.
// ----------------------------------------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

// ---- ROSTER (single-source from bench/*.json via compiler/bench/index.js) ---
// [OPTION B REFACTOR] The roster is no longer hardcoded here — it's LOADED from
// the same bench/<id>.json content the compiler uses, so there's ONE source of
// truth and no drift between the runtime roster and the authored content.
// Loaded once at module load (require, not per-turn), so zero hot-path cost.
//
// The json shape (id/name/role/manifestation/malleable/beats/passthrough) is
// mapped to the runtime shape PE's consumers read (tag/type/personality/note/
// signature), and the raw json is attached as `.raw` for rich content
// (theAbsence, hostCover, beats) the invoke/cover directives can draw on.
// The roster content is loaded from _bench_roster.js — a plain ES module
// GENERATED from compiler/bench/<id>.json by compiler/bench/build_roster.js.
// This keeps a single source of truth (the json) while being EDGE-SAFE (no
// require / createRequire / JSON-import attributes — just a JS import).
// Re-run the generator after any bench content change.
import { BENCH_RAW } from "./_bench_roster.js";
const BENCH_JSON = BENCH_RAW; // { id: {json}, ... } lowercase ids

// personality isn't in the json; it drives JOIN_MOVES for SEEN arrivals only.
// Phantoms never use join moves, so their value is cosmetic. Curated per char.
const PERSONALITY = {
  conrad: "dominant", bonnie: "smooth", andrea: "anxious", derek: "smooth",
  bea: "smooth", chip: "smooth", brent: "dominant", tyler: "anxious",
  gary: "smooth", no_show: "smooth", approver: "dominant", it_guy: "anxious",
};

// Build one runtime entry from a json character block.
function toEntry(id, j) {
  const type = j.manifestation || "seen"; // seen|audio|phantom (the discriminator)
  // note: a short description used by invoke/cover directives. role + the
  // absence (phantoms) or the connectionToHost gist (seen) gives the host
  // enough to characterize them.
  const absence = j.passthrough && j.passthrough.theAbsence;
  const note = absence
    ? `${j.role} — ${String(absence).split(".")[0]}.`
    : (j.role || j.name || id);
  // signature: SEEN chars' own entrance, from beats.joining if present.
  const signature = j.beats && j.beats.joining ? j.beats.joining : undefined;
  return {
    tag: id.toUpperCase(),
    id,
    type,
    personality: PERSONALITY[id] || "smooth",
    note,
    signature,
    raw: j, // full authored content: malleable/beats/passthrough (hostCover, theAbsence, invocation, ...)
  };
}

// The runtime roster, keyed by UPPERCASE tag (PE's convention).
export const BENCH = (() => {
  const out = {};
  for (const [id, j] of Object.entries(BENCH_JSON)) {
    if (!j || typeof j !== "object") continue;
    out[id.toUpperCase()] = toEntry(id, j);
  }
  return out;
})();

// ---- JOIN MOVES (staging directions, personality-typed) ------------------
// Each is a DIRECTION the dedicated bench call performs, not literal text.
const JOIN_MOVES = {
  anxious: [
    "joins flustered, talking before they're sure they're audible: 'hello? can you hear me? — okay, I think I'm on'",
    "a nervous cough and an apology for interrupting, fumbling to get settled",
    "struggles with the connection — 'is this the right call? am I muted?' — technical flailing",
  ],
  dominant: [
    "barges in mid-sentence with no greeting, as if they'd been on the whole time: '—as I was saying'",
    "arrives fresh and immediately puts the spammer on the back foot: 'so. who is this, exactly?'",
    "cuts in flat and unbothered, takes the floor without asking for it",
  ],
  smooth: [
    "slips in casually, already mid-chitchat with someone on their end about inside-company stuff, then turns to the call: 'sorry — hi, what'd I miss?'",
    "joins relaxed and a little late: 'hey, sorry I'm running behind — catch me up?'",
    "eases in with ambient office noise behind them, settling in like they joined from somewhere real",
  ],
};

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

// Resolve a chosen bench id to its roster entry (case-insensitive).
export function benchEntry(benchId) {
  if (!benchId) return null;
  return BENCH[String(benchId).toUpperCase()] || null;
}
export function benchIds() { return Object.keys(BENCH); }
export function isPhantom(benchId) {
  const e = benchEntry(benchId);
  return !!(e && e.type === "phantom");
}

// Choose the entrance direction for a character: their signature if defined,
// else a personality-matched generic move.
function entranceDirection(entry) {
  if (entry.signature) return entry.signature;
  const pool = JOIN_MOVES[entry.personality] || JOIN_MOVES.smooth;
  return pick(pool);
}

// ---- STAGE MACHINE -------------------------------------------------------
// Given the current arrival_state (or null) and whether a new bench is being
// sent in this turn, decide what happens. Returns { arrivalState, directive }
// where directive is the staging instruction for the dedicated bench call (or
// null = nothing bench-related this turn).
export const STAGES = ["entrance", "settling", "developing", "resolved"];

export function beginArrival(benchId, turn) {
  const entry = benchEntry(benchId);
  if (!entry) return null;
  if (entry.type === "phantom") {
    // Phantoms don't stage an arrival — they get invoked. Caller handles the
    // invoking flag separately; arrival_state stays null.
    return null;
  }
  return {
    bench_id: entry.tag,
    type: entry.type,
    personality: entry.personality,
    stage: "entrance",
    started_turn: turn,
    join_move: entranceDirection(entry),
  };
}

// Advance an in-progress arrival to its next stage. Returns the updated state
// (stage advanced) or a state with stage:"resolved" when the sequence ends.
export function advanceArrival(state) {
  if (!state) return null;
  const i = STAGES.indexOf(state.stage);
  const next = STAGES[Math.min(i + 1, STAGES.length - 1)];
  return { ...state, stage: next };
}

// Build the staging directive for the CURRENT stage — the instruction the
// dedicated bench call performs. The character's persona rides in `note`.
export function stageDirective(state) {
  if (!state) return null;
  const entry = benchEntry(state.bench_id);
  const who = entry ? entry.note : state.bench_id;
  const base = `You are ${state.bench_id}, joining a live call. Character: ${who}. ` +
    `Speak ONLY as ${state.bench_id}, one short in-character turn (1-3 sentences). ` +
    `Do not narrate stage directions; perform them in speech.`;
  switch (state.stage) {
    case "entrance":
      return base + ` THIS BEAT — your entrance: ${state.join_move}. ` +
        `The host is mid-call with a salesperson; make your arrival land.`;
    case "settling":
      return base + ` THIS BEAT — explain (briefly) why you're here, or why ` +
        `you shouldn't be. React to what's going on. Stay in character.`;
    case "developing":
      return base + ` THIS BEAT — pick ONE and commit: hijack the conversation ` +
        `and redirect it, OR start a side-conversation with the host/others as ` +
        `if the salesperson isn't there, OR settle in and pointedly question ` +
        `the salesperson. Whatever your character would actually do.`;
    case "resolved":
    default:
      return null; // arrival complete — no more forced bench beats
  }
}

// One dedicated bench model call — generates THIS stage's line in the bench
// character's voice (NOT the host's). This is how the staging is actually
// performed: a separate call, not a cue the host persona would ignore.
// Returns the tagged line "[[TAG]] <line>" or null on failure (best-effort).
export async function generateBenchBeat(state, history) {
  const directive = stageDirective(state);
  if (!directive) return null;
  // Give the bench model the recent conversation for context (host-perspective
  // history: spammer=user, host=assistant). The bench character is a third party
  // dropping in, so they see it as observers catching up.
  const recent = Array.isArray(history) ? history.slice(-6) : [];
  const ctx = recent
    .map((m) => (m.role === "user" ? "SALESPERSON: " : "HOST: ") + m.content)
    .join("\n");
  const messages = [
    { role: "user", content: (ctx ? "Recent call:\n" + ctx + "\n\n" : "") + "Your line now:" },
  ];
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({ model: MODEL(), max_tokens: 200, system: directive, messages }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const line = (data.content || [])
      .filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    if (!line) return null;
    return "\n\n[[" + state.bench_id + "]] " + line;
  } catch {
    return null;
  }
}

// PHANTOM invocation directive — for sent-in phantoms, the HOST (not a bench
// call) gets an instruction to invoke/dangle them. Returned to the caller to
// fold into the host's own posture block. No arrival, no bench call.
export function phantomInvokeDirective(benchId) {
  const entry = benchEntry(benchId);
  if (!entry || entry.type !== "phantom") return null;
  return `The Director has sent in ${entry.tag} — but ${entry.tag} never actually ` +
    `joins (${entry.note}). Begin INVOKING/dangling them: reference their imminent ` +
    `arrival, defer to them, promise they're about to join — but never produce them.`;
}

// ---- LEGACY v1 auto-inject (kept so existing behavior still fires) --------
// v1 fired one canned line on ARRIVE_TURN. v2 keeps a thin version: if no
// Director arrival is active, the auto schedule can still kick a character in
// by BEGINNING a staged arrival (not a canned line). Tunable as before.
const ARRIVE_TURN = parseInt(process.env.BENCH_ARRIVE_TURN || "0", 10); // 0 = off by default in v2
const ARRIVE_WHO = (process.env.BENCH_ARRIVE_WHO || "CONRAD").toUpperCase();

// Returns a bench_id to auto-begin an arrival for this turn, or null. v2 default
// is OFF (ARRIVE_TURN=0) — arrivals are Director/host-driven now. Set
// BENCH_ARRIVE_TURN>0 to re-enable an automatic scheduled arrival.
export function autoArrivalId(turn) {
  if (ARRIVE_TURN <= 0) return null;
  if (turn !== ARRIVE_TURN) return null;
  return BENCH[ARRIVE_WHO] ? ARRIVE_WHO : "CONRAD";
}

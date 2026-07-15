// SpamViking — Posture Engine: BIT SELECTION (scorer over the real registry)
// ----------------------------------------------------------------------
// One ranking mechanism for the whole library. Death-blow finishers (the 700s)
// are the special case — same scorer, triggered at the Director's break-glass,
// always-fire.
//
//   effective_score = fit_score + gear_bias - recency_penalty
//
//   fit_score      — about this caller? archetype > accusation > tone, PLUS a
//                    FUEL boost: a bit that can use a live dossier hook is by
//                    definition more precisely fitted to THIS caller, so it
//                    rises above generic bits. (Missing hook = still excluded.)
//   gear_bias      — does this moment want it? sum of the bit's per-state
//                    biases across whichever gear axes it declares.
//   recency        — suppress a just-used bit; decays over its cooldown.
//
// Two-stage pick: LOADOUT (per-turn candidacy — drop death blows, fuel-less,
// parked, and bits the CALL TURN has closed the door on) narrows the registry
// to a focused set; then we RANK that set. Narrow hard, pick easy.
//
// Engine PICKS; prompt/pack PERFORMS. Pure & synchronous — safe on the hot
// path; runs no LLM. Registry is compiled from the Bits Library — never
// hand-authored here (see api/_bits_registry.js).
// ----------------------------------------------------------------------
import { BITS } from "./_bits_registry.js";

export const WEIGHTS = {
  archetypeMatch: 3.0,
  universal: 1.0,
  accusation: 1.5,
  tone: 0.5,
  fuelBoost: 2.0, // a dossier-targeted bit rises above generic ones
  fuelExtraHook: 0.5, // each hook beyond the first = more specific = more boost
  chain: 1.5, // SEQUENCING: reward a bit that escalates from the last one
  categorySpacing: 1.0, // SEQUENCING: penalize same category back-to-back
  recencyBase: 3.0,
  phasePref: 1.5, // SOFT phase bias: a bit whose phase_pref matches the call
                  // phase (opening/pitching/probing/drifting — judged by the
                  // async phase reader) scores higher. Phase-neutral bits (no
                  // phase_pref) are unaffected. Bias, not a gate.
};

// Mid-call deploy bar: a bit fires only if its top score clears this (it must
// beat "just keep talking"). Death blows bypass it. Env-tunable (DEPLOY_THRESHOLD)
// so it can be dialed live from Vercel without a deploy — the third pacing dial
// alongside MIN_GAP and WARMUP_TURNS.
export const DEPLOY_THRESHOLD = parseFloat(process.env.DEPLOY_THRESHOLD || "1.5");

// OPENING GATE (Bits chat spec, Jul 15) — the last caller-turn on which an
// opening-only bit may still fire. Opening bits are about ARRIVING ("how are
// you", the commute, camera-off, the late arrival); at turn 12 they are
// nonsense no matter how they score, so this is an EXCLUSION, not a bias.
//
// Why both this AND WEIGHTS.phasePref exist, per Bits:
//   phase_pref bias  -> PREFERENCE. Soft (+1.5). Can be outranked. Says
//                       "this fits the opening better than other moments."
//   this turn gate   -> AVAILABILITY. Hard. Says "this bit no longer exists
//                       as an option." A soft bias alone cannot stop a strong
//                       opening bit from topping the ranking mid-pitch.
//
// Implemented as the RULE (phase_pref === "opening"), not a hardcoded ID list —
// Bits' explicit preference, so future opening bits inherit the gate with no
// PE change. Bits' reference list at time of writing: BIT-130 How Are You,
// BIT-131 Busy Escalation, BIT-132 Expansion News, BIT-133 Audio Verification,
// BIT-134 Six Degrees, BIT-135 Punctuality, BIT-232 Weather, BIT-309 Late
// Arrival, BIT-326 Commute, BIT-408 Camera Off. The rule only catches bits the
// REGISTRY tags phase_pref:"opening" — if 309/408 are meant to be gated, they
// must carry that tag in the compiled registry.
//
// Env-tunable so it can be dialed without a deploy, matching MIN_GAP /
// WARMUP_TURNS / DEPLOY_THRESHOLD.
export const OPENING_MAX_TURN = parseInt(process.env.OPENING_MAX_TURN || "3", 10);

// Death blows are the 700-series. Identified by id, not a separate `kind`.
const isDeathBlow = (b) => /^BIT-7\d\d$/.test(b.id);

// STALL-BREAKER family (per the Bits chat): these bits break an extended
// content-less/social stretch. When state.extended_stall is set, their score
// is multiplied so one lifts above the general pool. Add future stall-breakers
// here. STALL_MULTIPLIER is env-tunable.
// NOTE (Jul 15): none of these ids exist in the currently compiled registry —
// this whole family is a no-op until the Bits Library recompiles _bits_registry.js.
const STALL_BREAKERS = new Set(["BIT-128", "BIT-129", "BIT-230", "BIT-231", "BIT-324", "BIT-325"]);
const STALL_MULTIPLIER = parseFloat(process.env.STALL_MULTIPLIER || "2.5");

// --- sequencing helpers ---------------------------------------------------
const gv = (b, axis, st) => (b.gear && b.gear[axis] && b.gear[axis][st]) || 0;
// amplify level = how much a bit pushes toward STUNNED vs BORED (the X axis of
// the portfolio map). Chaining rewards bits that raise this vs the last one.
const amplifyLevel = (b) => gv(b, "engagement", "stunned") - gv(b, "engagement", "bored");
// category = the id hundreds digit (1xx Verbal, 2xx Structural, ...).
const category = (b) => b.id.split("-")[1][0];

// --- fuel as fit (the ammo system, graded) -------------------------------
// A bit with fuel_hooks needs those dossier fields populated for THIS call.
// Missing any -> unavailable (still excluded; can't joke about company_news
// with no company_news). All present -> available WITH a fit boost scaled by
// how many specific hooks it uses (more hooks = more targeted = higher boost).
function fuelFit(bit, state) {
  if (!bit.fuel_hooks || !bit.fuel_hooks.length) {
    return { available: true, boost: 0, count: 0 };
  }
  const status = state.fuel_hooks_status || {};
  const have = bit.fuel_hooks.filter((h) => status[h] === "populated");
  if (have.length < bit.fuel_hooks.length) {
    return { available: false, boost: 0, count: have.length };
  }
  const boost = WEIGHTS.fuelBoost + WEIGHTS.fuelExtraHook * (have.length - 1);
  return { available: true, boost, count: have.length };
}

// --- scoring --------------------------------------------------------------
function fitScore(bit, state) {
  const why = [];
  const arch = bit.archetypes;
  let s = 0;
  if (arch === "universal") {
    s += WEIGHTS.universal;
    why.push(`universal +${WEIGHTS.universal}`);
  } else if (Array.isArray(arch) && arch.includes(state.archetype)) {
    s += WEIGHTS.archetypeMatch;
    why.push(`archetype:${state.archetype} +${WEIGHTS.archetypeMatch}`);
  } else {
    return { score: -Infinity, why: ["archetype mismatch — excluded"] };
  }
  if (bit.accusations && state.accusation &&
      bit.accusations.includes(state.accusation)) {
    s += WEIGHTS.accusation;
    why.push(`accusation:${state.accusation} +${WEIGHTS.accusation}`);
  }
  if (bit.tones && state.tone && bit.tones.includes(state.tone)) {
    s += WEIGHTS.tone;
    why.push(`tone:${state.tone} +${WEIGHTS.tone}`);
  }
  return { score: s, why };
}

function gearBias(bit, state) {
  const why = [];
  let b = 0;
  if (bit.gear) {
    for (const [axis, map] of Object.entries(bit.gear)) {
      const st = state.gears?.[axis];
      if (st != null && map[st] != null) {
        b += map[st];
        why.push(`${axis}:${st} ${map[st] >= 0 ? "+" : ""}${map[st]}`);
      }
    }
  }
  return { bias: b, why };
}

function recencyPenalty(bit, state) {
  const since = state.recency?.[bit.id];
  if (since == null) return { pen: 0, why: [] };
  // Count bits are DESIGNED to fire repeatedly — the running tally IS the joke,
  // so a long cooldown starves them. Default them to 2; one-shots/running bits
  // keep 5. An explicit bit.cooldown still overrides either default.
  const dflt = bit.bit_type === "count" ? 2 : 5;
  const cd = bit.cooldown ?? dflt;
  const pen = WEIGHTS.recencyBase * Math.max(0, 1 - since / cd);
  return { pen, why: pen > 0 ? [`used ${since} call(s) ago -${pen.toFixed(1)}`] : [] };
}

// Score one bit -> full auditable breakdown. Death blows add their intensity
// as a mild ranking term (gear vitality still dominates soft-vs-scorched).
export function scoreBit(bit, state) {
  if (bit.status === "parked") {
    return {
      id: bit.id, name: bit.name, score: -Infinity,
      excluded: `parked: ${bit.park_reason || "inactive"}`, breakdown: {},
    };
  }
  const fuel = fuelFit(bit, state);
  if (!fuel.available) {
    return {
      id: bit.id, name: bit.name, score: -Infinity,
      excluded: `missing fuel: ${(bit.fuel_hooks || []).join(",")}`, breakdown: {},
    };
  }
  const f = fitScore(bit, state);
  if (f.score === -Infinity) {
    return { id: bit.id, name: bit.name, score: -Infinity,
      excluded: "archetype mismatch", breakdown: {} };
  }
  const g = gearBias(bit, state);
  const r = recencyPenalty(bit, state);
  const intent = isDeathBlow(bit) ? (bit.intensity || 0) : 0;
  // SEQUENCING — relative to the last bit fired, so a call BUILDS instead of
  // throwing independent gags. Chaining rewards escalation (toward stunned);
  // category spacing discourages the same kind of bit twice running.
  let seq = 0;
  const seqWhy = [];
  const last =
    state.lastBitId && state.lastBitId !== bit.id
      ? BITS.find((x) => x.id === state.lastBitId)
      : null;
  if (last) {
    if (amplifyLevel(bit) > amplifyLevel(last)) {
      seq += WEIGHTS.chain;
      seqWhy.push(`chains/escalates +${WEIGHTS.chain}`);
    }
    if (category(bit) === category(last)) {
      seq -= WEIGHTS.categorySpacing;
      seqWhy.push(`same category as last -${WEIGHTS.categorySpacing}`);
    }
  }
  const fitTotal = f.score + fuel.boost;
  // PHASE bias (soft): if the bit declares a phase_pref ("opening" or "engaged")
  // and it matches the call's current phase, give a small boost. Bits with no
  // phase_pref are phase-neutral (unaffected). This makes small-talk/opening
  // bits more likely before the pitch starts, without hard-gating anything.
  // (The HARD side of this is the opening turn gate in loadout(), below.)
  let phaseBias = 0;
  if (bit.phase_pref && state.phase && bit.phase_pref === state.phase) {
    phaseBias = WEIGHTS.phasePref;
  }
  // ARM (learning phase): a Director-armed bit gets an escalating boost — it
  // rises and crosses the bar sooner the longer it has waited, so even an
  // "unreasonable" bit eventually lands at a tolerable spot instead of never
  // firing. Spacing (MIN_GAP) still applies, so it waits for a reasonable spot.
  const ARM_BASE = 3, ARM_STEP = 2;
  const armWaited = state.armed ? state.armed[bit.id] : undefined;
  const armBoost = armWaited != null ? ARM_BASE + ARM_STEP * armWaited : 0;
  let score = fitTotal + g.bias - r.pen + intent + seq + armBoost + phaseBias;
  // EXTENDED_STALL: when the call has gone content-less/social too long
  // (state.extended_stall, set by the engine off the turns_since_pitch_or_ask
  // streak), lift the stall-breaker family above the general pool for this
  // cycle so one of them fires to break the silence. Normal scoring still
  // applies underneath — this is a multiplier ON TOP, per the Bits chat spec.
  let stallBoost = 0;
  if (state.extended_stall && STALL_BREAKERS.has(bit.id)) {
    const before = score;
    score = score * STALL_MULTIPLIER;
    stallBoost = score - before;
  }
  return {
    id: bit.id, name: bit.name, score, excluded: false,
    breakdown: {
      fit: fitTotal, gearBias: g.bias, recency: -r.pen,
      fuelBoost: fuel.boost || undefined,
      sequence: seq || undefined,
      intensity: intent || undefined,
      armed: armBoost || undefined,
      phase: phaseBias || undefined,
      stall: stallBoost ? +stallBoost.toFixed(2) : undefined,
      why: [...f.why,
            ...(fuel.boost ? [`fuel x${fuel.count} +${fuel.boost}`] : []),
            ...g.why, ...r.why, ...seqWhy,
            ...(intent ? [`intensity +${intent}`] : []),
            ...(armBoost ? [`armed (waited ${armWaited}) +${armBoost}`] : []),
            ...(phaseBias ? [`phase:${bit.phase_pref} +${phaseBias}`] : []),
            ...(stallBoost ? [`extended_stall x${STALL_MULTIPLIER}`] : [])],
    },
  };
}

// Rank a pool (default the whole registry) high to low, dropping excluded.
export function rankBits(state, { pool = BITS, deathBlow = false } = {}) {
  return pool
    .filter((b) => (deathBlow ? isDeathBlow(b) : !isDeathBlow(b)))
    .map((b) => scoreBit(b, state))
    .filter((r) => r.score !== -Infinity)
    .sort((a, b) => b.score - a.score);
}

// --- LOADOUT: per-turn candidacy ----------------------------------------
// GEAR IS A SCORING SIGNAL, NOT AN ELIGIBILITY GATE (per the Bits chat's
// pacing audit). Every active bit stays in the eligible pool; gear_bias
// adjusts the SCORE up or down inside scoreBit — it never removes a bit.
// The deploy THRESHOLD (not a candidacy filter) is what keeps a generic,
// low-scoring bit from firing when nothing fits — so a neutral universal is
// still eligible and WILL fire when it's the best available option, instead
// of being starved out of the pool. Only HARD exclusions live here: parked
// (no producer), death blows (700s, handled separately), missing fuel
// (genuinely can't joke about company_news with no company_news), and the
// opening turn gate (an arrival bit is not an option once the call is
// underway — see OPENING_MAX_TURN).
//
// [FIXED] Previously loadout required hasPull() — positive gear/fuel/accusation
// signal — which zeroed neutral bits OUT of the pool before ranking, the
// primary cause of under-firing. Removed: gear now only scores, never gates.
export function loadout(state, { pool = BITS } = {}) {
  return pool.filter((b) => {
    if (b.status === "parked") return false; // no producer for its fuel yet
    if (isDeathBlow(b)) return false;
    if (!fuelFit(b, state).available) return false; // missing ammo — hard gate
    // OPENING GATE: arrival-only bits leave the pool once the call is past its
    // opening turns. Fails OPEN — if the caller didn't pass a turn number
    // (state.turn undefined), nothing is gated, so this can never silently
    // starve the pool for a caller that predates the `turn` field.
    if (b.phase_pref === "opening" && (state.turn ?? 0) > OPENING_MAX_TURN) {
      return false;
    }
    return true; // everything else is eligible; gear/score decides ranking
  });
}

// Mid-call pick: rank the LOADOUT (not the whole registry) and take the top if
// it clears the deploy bar; else null ("just keep talking").
export function selectBit(state, { threshold = DEPLOY_THRESHOLD } = {}) {
  const pool = loadout(state);
  const ranked = rankBits(state, { pool });
  const top = ranked[0];
  if (!top || top.score < threshold) {
    return { bit: null, reason: "below deploy threshold", ranked, pool: pool.length };
  }
  return { bit: top, reason: "fires", ranked, pool: pool.length };
}

// Death Blow: the top 700-series finisher, always thrown (threshold bypassed).
// Special rules from the Bits handoff: BIT-704 (Colleague Pull) overrides all
// others when two spammers are present (+5); BIT-705 (Send-Off) is the natural
// default (its vitality bias wins when no stronger signal exists).
export function selectDeathBlow(state) {
  const ranked = rankBits(state, { deathBlow: true });
  if (state.spammers >= 2 || state.heads_mustered >= 2) {
    const i = ranked.findIndex((r) => r.id === "BIT-704");
    if (i >= 0) {
      ranked[i] = { ...ranked[i], score: ranked[i].score + 5,
        breakdown: { ...ranked[i].breakdown, why: [...(ranked[i].breakdown.why || []),
          "two-spammer override +5"] } };
      ranked.sort((a, b) => b.score - a.score);
    }
  }
  return { bit: ranked[0] || null, ranked };
}

// SpamViking — Posture Engine: BIT SELECTION (scorer over the real registry)
// ----------------------------------------------------------------------
// One ranking mechanism for the whole library (71 compiled bits). Death-blow
// finishers (the 700s) are the special case — same scorer, triggered at the
// Director's break-glass, always-fire.
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
// and bits the moment actively doesn't want) narrows the 71 to a focused set;
// then we RANK that set. Narrow hard, pick easy.
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
};

// Mid-call deploy bar: a bit fires only if its top score clears this (it must
// beat "just keep talking"). Death blows bypass it.
export const DEPLOY_THRESHOLD = 1.5;

// Death blows are the 700-series. Identified by id, not a separate `kind`.
const isDeathBlow = (b) => /^BIT-7\d\d$/.test(b.id);

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
  const cd = bit.cooldown ?? 5;
  const pen = WEIGHTS.recencyBase * Math.max(0, 1 - since / cd);
  return { pen, why: pen > 0 ? [`used ${since} call(s) ago -${pen.toFixed(1)}`] : [] };
}

// Score one bit -> full auditable breakdown. Death blows add their intensity
// as a mild ranking term (gear vitality still dominates soft-vs-scorched).
export function scoreBit(bit, state) {
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
  const score = fitTotal + g.bias - r.pen + intent + seq;
  return {
    id: bit.id, name: bit.name, score, excluded: false,
    breakdown: {
      fit: fitTotal, gearBias: g.bias, recency: -r.pen,
      fuelBoost: fuel.boost || undefined,
      sequence: seq || undefined,
      intensity: intent || undefined,
      why: [...f.why,
            ...(fuel.boost ? [`fuel x${fuel.count} +${fuel.boost}`] : []),
            ...g.why, ...r.why, ...seqWhy,
            ...(intent ? [`intensity +${intent}`] : [])],
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
// Narrow the 71 to the bits that actually fit THIS moment, so ranking picks
// among a focused set instead of a flat sea of universals. A bit is a
// candidate when it is: not a death blow, has its fuel (or needs none), is
// NOT actively anti-fit (negative gear_bias), AND has some positive pull this
// turn — a positive gear_bias, a live fuel boost, or an accusation match.
// Bits with zero signal are generic filler, not a precise pick, so they drop.
function hasPull(bit, state) {
  const g = gearBias(bit, state).bias;
  if (g < 0) return { ok: false }; // actively wrong for this moment
  const fuel = fuelFit(bit, state);
  const acc = !!(
    bit.accusations && state.accusation && bit.accusations.includes(state.accusation)
  );
  return { ok: g > 0 || fuel.boost > 0 || acc, anti: false };
}

export function loadout(state, { pool = BITS } = {}) {
  return pool.filter((b) => {
    if (isDeathBlow(b)) return false;
    if (!fuelFit(b, state).available) return false; // missing ammo
    return hasPull(b, state).ok;
  });
}

// Mid-call pick: rank the LOADOUT (not all 71) and take the top if it clears
// the deploy bar; else null ("just keep talking").
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

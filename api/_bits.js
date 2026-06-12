// SpamViking — Posture Engine: BIT SELECTION (scorer over the real registry)
// ----------------------------------------------------------------------
// One ranking mechanism for the whole library (71 compiled bits). Death-blow
// finishers (the 700s) are the special case — same scorer, triggered at the
// Director's break-glass, always-fire.
//
//   effective_score = fit_score + gear_bias - recency_penalty
//
//   fit_score      — about this caller? archetype (dominant) > accusation
//                    (conditional) > tone (tiebreaker). Themed bit on a
//                    non-matching call = EXCLUDED. (All current bits are
//                    `universal`, so fit is flat until themed bits land.)
//   gear_bias      — does this moment want it? sum of the bit's per-state
//                    biases across whichever gear axes it declares.
//   recency        — suppress a just-used bit; decays over its cooldown.
//   FUEL GATE      — a bit needing dossier "fuel_hooks" is excluded unless
//                    those hooks are populated for this call (the ammo system).
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
  recencyBase: 3.0,
};

// Mid-call deploy bar: a bit fires only if its top score clears this (it must
// beat "just keep talking"). Death blows bypass it.
export const DEPLOY_THRESHOLD = 1.5;

// Death blows are the 700-series. Identified by id, not a separate `kind`.
const isDeathBlow = (b) => /^BIT-7\d\d$/.test(b.id);

// --- fuel gate (the ammo system) -----------------------------------------
// A bit with fuel_hooks needs those dossier fields populated for THIS call.
// state.fuel_hooks_status maps hook -> "populated"; anything else = unavailable.
function fuelAvailable(bit, state) {
  if (!bit.fuel_hooks || !bit.fuel_hooks.length) return true;
  const status = state.fuel_hooks_status || {};
  return bit.fuel_hooks.every((h) => status[h] === "populated");
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
  if (!fuelAvailable(bit, state)) {
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
  const score = f.score + g.bias - r.pen + intent;
  return {
    id: bit.id, name: bit.name, score, excluded: false,
    breakdown: {
      fit: f.score, gearBias: g.bias, recency: -r.pen,
      intensity: intent || undefined,
      why: [...f.why, ...g.why, ...r.why,
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

// Mid-call pick: the top non-death-blow bit, only if it clears the deploy bar;
// else null ("just keep talking").
export function selectBit(state, { threshold = DEPLOY_THRESHOLD } = {}) {
  const ranked = rankBits(state, { deathBlow: false });
  const top = ranked[0];
  if (!top || top.score < threshold) {
    return { bit: null, reason: "below deploy threshold", ranked };
  }
  return { bit: top, reason: "fires", ranked };
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

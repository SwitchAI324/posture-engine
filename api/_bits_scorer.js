// SpamViking — Posture Engine: BIT SELECTION (scorer over the real registry)
// ----------------------------------------------------------------------
// One ranking mechanism for the whole library. Death-blow finishers (the 700s)
// are the special case — same scorer, triggered at the Director's break-glass,
// always-fire.
//
// SIMPLIFIED (Aug 5) — fit_score and gear_bias are no longer scored bonuses.
// Both were confirmed dead or reduced to a pure gate before being stripped:
//   - gear_bias: confirmed dead. It read bit.gear[axis][state], but the
//     registry moved to flat top-level pressure/engagement/suspicion fields
//     at some point and this was never updated to match — zero bits in the
//     registry have a .gear field, so this had already been contributing 0
//     to every score, for every bit, before it was ever touched here. Left
//     as a stub (not deleted outright) so breakdown.gearBias stays a stable
//     key for anything downstream still reading it.
//   - fit_score: was archetype-tier bonus + accusation bonus + tone bonus.
//     Checked directly — zero bits in the registry have an .accusations or
//     .tones field, so those two were also already inert everywhere. Only
//     archetype match was ever real, and it's now a pure ELIGIBILITY gate
//     (matches = eligible, score 0; doesn't match = excluded), not a scored
//     bonus — no more differentiation between "universal" and "specific
//     match."
//
// So today, ranking among ELIGIBLE bits comes entirely from: recency
// (suppress a just-used bit, decays over its cooldown), sequencing (reward
// escalation, penalize same-category-twice), phase bias (soft preference for
// a bit whose phase_pref matches the call phase), fuel boost (a dossier-
// targeted bit rises above generic ones), and arm boost (a Director-armed
// bit's learning-phase escalation). Eligibility itself — archetype match,
// cooldown, phase-pool, status, latest_turn, fuel availability — stays a set
// of hard gates, unchanged in kind, just no longer double as scored bonuses
// on top of being gates.
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
  // archetypeMatch/universal/accusation/tone REMOVED (Aug 5) — fitScore() no
  // longer scores these, archetype match is now a pure eligibility gate (see
  // that function's comment). Unused, deleted rather than left dead.
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
// Backstop only — NOT the boundary. Bits' ruling (Jul 15): if the reader says
// "opening" at turn 10 because the caller is genuinely still doing pleasantries,
// opening bits BELONG there; excluding "How Are You" from a call that is
// literally still in how-are-you territory is the wrong outcome, and a turn
// ceiling must not paper over reader mis-classification. So phase is the gate.
// This ceiling exists for ONE case: the reader never speaking at all. readCall
// returns null on every failure (upstream !ok, no JSON match, parse failure,
// throw), and getCall's fallback is `?? "opening"` — so a reader that never
// succeeds leaves phase="opening" for the whole call, and opening bits would
// fire forever. That's not a mis-read, it's silence defaulting onto the stuck
// state. 20 is deliberately far past any real opening. Set to 0 to disable
// entirely once reader failures are proven rare (see the callread FAILED log).
export const OPENING_MAX_TURN = parseInt(process.env.OPENING_MAX_TURN || "20", 10);
// TEST-MODE ONLY: bits whose archetype scoping is bypassed so they're scorable
// on EVERY call regardless of archetype. Comma-separated bit ids in an env var;
// empty/unset (production default) = normal archetype gating for all bits. This
// does NOT change any bit's registry entry — BIT-216's real scope stays
// ["b2b_saas"] for production; this only stops the archetype-mismatch exclusion
// from dropping the listed ids while evaluating the board's test set.
const TEST_UNSCOPE_BITS = new Set(
  (process.env.TEST_UNSCOPE_BITS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
// TEST-MODE ONLY: hard-cap the deployable pool to exactly these bit ids. When
// set, the Host can ONLY fire bits on this list — everything else is excluded
// from loadout() before any other gate runs, so the autonomous Host is
// restricted to the board's test set and every bit_deployed has a matching
// board row (no off-board fires). Comma-separated ids; empty/unset (production
// default) = NO cap, the Host ranks the whole registry as normal. This changes
// nothing in the registry and is fully reversible by clearing the env var.
// Pairs with TEST_UNSCOPE_BITS: cap decides WHICH bits are in play, unscope
// lets an archetype-scoped one (BIT-216) score on any call once it's in.
const TEST_POOL_CAP = new Set(
  (process.env.TEST_POOL_CAP || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
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
// ── TRIGGER-MATCH GATE (step b of the gears→triggers teardown) ────────────
// A bit may declare `trigger: "<name>"` in the registry. When TRIGGER_MATCH is
// on, a bit whose trigger is in EMITTED_TRIGGERS becomes an EVENT-GATED bit:
// eligible ONLY on turns where that named condition is present in call state,
// invisible otherwise — replacing the continuous gear score for that bit's
// eligibility. This runs PARALLEL to gears: a bit NOT gated here still ranks by
// gear/fit exactly as before, so the two systems coexist and we can prove
// trigger-selection on a live log before deleting any gear code (that deletion
// is a LATER step; nothing here touches _gears.js or the gear emits).
//
// EMITTED_TRIGGERS is the ALLOWLIST and the single source of truth for what is
// matchable. THE RULE: a bit is trigger-gated ONLY if its trigger is in this
// set. A bit whose trigger is NOT in the set (a Tier-3 trigger PE doesn't emit
// yet, OR the descriptive "ambient" lane tag) is IGNORED by this gate and falls
// straight through to gear-scoring, exactly as today. This is what guarantees
// NOTHING GOES DARK: a bit only becomes event-gated once PE actually emits its
// trigger. As PE lights up each new emitter (prior_contact, caller_pitched,
// caller_went_quiet, ...), add that trigger name here — one at a time, each
// provable on a live log — and those bits flip from gear-scored to event-gated.
//
// "ambient" is DELIBERATELY absent: per Bits it is a gag-LANE marker, not an
// event — its 14 bits stay on the existing gag-lane/gear path. The registry
// keeps the descriptive `trigger:"ambient"` tag for readability; this allowlist
// (not the tag) decides matchability, so the tag is inert here and harmless.
const TRIGGER_MATCH =
  !/^(0|false|no|off)$/i.test(String(process.env.TRIGGER_MATCH || "1"));
const EMITTED_TRIGGERS = new Set([
  // Tier 1 — PE emits these from the reader / call state every turn:
  "commitment_push",   // out.commitmentPush (the reader)
  "extended_stall",    // the stall path / state.extended_stall
  "phase:opening",     // out.phase === "opening"
  "phase:probing",     // out.phase === "probing"
  "pricing_raised",    // out.pricingRaised (the reader), ONE-WAY LATCH — see
                        // completions.js's blendRead comment. Added Aug 5 for
                        // BIT-210, which was already wired registry-side.
  // Tier 2 (trivial) — computed directly from turn count, no LLM cost:
  "call_turn_1",       // state.turn === 1
  // NOTE: call_phase_late is intentionally NOT here. It tags only the 700-series
  // death-blows, which never pass through normal loadout() — they fire via
  // selectDeathBlow() (separate end-of-call path, threshold bypassed). The
  // death-blow path already IS the "late call" mechanism, so call_phase_late
  // needs no PE emitter and no gate here; the tag is descriptive only.
  // NOT yet emitted (stay gear-scored until PE adds each emitter — do NOT add
  // here until the emitter is live and logged):
  //   prior_contact, browsed_tmi, caller_pitched, caller_made_claim,
  //   caller_named_competitor, caller_named_hobby, caller_went_quiet,
  //   caller_questioned_humanity
  // NOT an event (lane marker, never add): ambient
]);
// Is this bit's trigger PRESENT in the current call state? Only called for a
// bit whose trigger is in EMITTED_TRIGGERS (see loadout). Maps each allowlisted
// trigger name to the call-state field PE actually sets.
function triggerPresent(trigger, state) {
  switch (trigger) {
    case "commitment_push":
      return state.commitment_push === true || state.commitmentPush === true;
    case "extended_stall":
      return state.extended_stall === true;
    case "phase:opening":
      return state.phase === "opening";
    case "phase:probing":
      return state.phase === "probing";
    case "call_turn_1":
      return (state.turn ?? 0) === 1;
    case "pricing_raised":
      return state.pricing_raised === true;
    default:
      // Not an allowlisted trigger — should never reach here (loadout guards).
      // Fail SAFE toward eligibility so a mis-call can't silently blackhole a bit.
      return true;
  }
}
// ── TEXTURE ROTATION (step d of the gears→triggers teardown) ─────────────
// Bits' spec (Aug 3): replace continuous gear-scoring for the TEXTURE bits
// (the general-purpose filler pool — everything that isn't an event-triggered
// scenario bit and isn't a gag/stall-lane bit) with deterministic phase+
// cooldown LRU rotation. Behind TEXTURE_ROTATION, default OFF — until the flag
// is on and completions.js is wired to call selectTextureBit() below, this
// whole section is inert: loadout() includes texture bits in the gear-scored
// pool EXACTLY as it does today (see the one flag-gated line added there).
//
// TEXTURE BIT = the registry's IMPLICIT definition, no explicit marker needed:
// active AND no `trigger` field AND no `lane` field. A bit with BOTH a
// `trigger` and a `pool` is a SCENARIO bit (trigger wins, per Bits' ruling) —
// checking `!b.trigger` alone correctly excludes it here. `lane`-owned bits
// (gag/stall) keep their own separate mechanisms in completions.js untouched.
const TEXTURE_ROTATION =
  /^(1|true|yes|on)$/i.test(String(process.env.TEXTURE_ROTATION || ""));
// WEIGHTED LOTTERY (Aug 5, its own flag, default off — behind AND separate
// from TEXTURE_ROTATION itself, so the original deterministic-LRU behavior
// stays the default even once texture rotation is on): instead of ALWAYS
// handing the single longest-waiting candidate to the model, weight-
// randomize among the top TEXTURE_LOTTERY_TOP_N by wait time. Never-fired
// bits (wait = full turn count) still dominate the weighting, same
// novelty-first bias as today — this just stops it being perfectly
// deterministic among near-ties, so two calls with a similar history don't
// always produce the identical pick. Zero model involvement, zero new risk
// to anything downstream — selectTextureBit()'s return shape is unchanged.
const TEXTURE_LOTTERY =
  /^(1|true|yes|on)$/i.test(String(process.env.TEXTURE_LOTTERY || ""));
const TEXTURE_LOTTERY_TOP_N = parseInt(process.env.TEXTURE_LOTTERY_TOP_N || "4", 10);
const isTextureBit = (b) =>
  b.status !== "parked" && !isDeathBlow(b) && !b.trigger && !b.lane;
// PHASE -> which pool(s) are eligible this turn. No grace on a phase flip: a
// bit whose pool falls out of this set is immediately ineligible, per spec.
// An unrecognized/absent state.phase falls back to ["middle"] so nothing goes
// dark on a stuck or unfamiliar phase reading.
const POOL_FOR_PHASE = {
  opening: ["early"],
  pitching: ["middle"],
  probing: ["middle", "late"],
  drifting: ["middle", "late"],
};
// bit.pool default, per spec: absent -> "middle".
const bitPool = (b) => b.pool || "middle";
// bit.cooldown default for TEXTURE rotation specifically, per spec: absent ->
// 4 turns. (Separate from recencyPenalty's gear-era cooldown default above —
// that one still governs gear-scored bits; this is the rotation's own knob.)
const bitCooldown = (b) => b.cooldown ?? 4;
// Pick the next texture bit to fire this turn, or null. LRU within the
// phase's eligible pool(s): the bit that fired LONGEST ago wins; never-fired
// (last_fire_turn 0 or absent) always sorts first. No weights, no randomness
// — fully deterministic, per spec.
//
// EXPECTS (new state fields completions.js must supply once wired):
//   state.textureLastFire — { [bit.id]: <turn it last ACTUALLY fired> },
//     0 or absent = never fired.
//   state.turn  — current caller turn (already used elsewhere in this file).
//   state.phase — current call phase (already used elsewhere in this file).
//
// COOLDOWN IS NOT RESET HERE — this function only SELECTS. Per spec, when a
// scenario bit also wants the turn, the caller injects the scenario bit and
// suppresses texture for that turn WITHOUT touching textureLastFire, so the
// caller (completions.js) must stamp textureLastFire[bit.id] = turn ONLY on
// turns this pick was actually performed, never on a turn it was merely
// selected then suppressed.
//
// EDGE CASES (per spec, all handled here or explicitly left alone):
//   - no eligible bit -> null (the starvation guard elsewhere handles a dry
//     call; this function does not starve-fire on its own).
//   - phase flip -> handled by POOL_FOR_PHASE above; no grace turn.
//   - trigger + pool both present -> excluded (isTextureBit requires !b.trigger).
//   - escalation bits (BIT-117/138/146/147/515/516) get NO special casing —
//     they rotate through LRU like any other texture bit; which rung they
//     perform is a directive-side (prompt) decision, not a scorer one.
export function selectTextureBit(state, { pool = BITS } = {}) {
  if (!TEXTURE_ROTATION) return null;
  const eligiblePools = POOL_FOR_PHASE[state.phase] || ["middle"];
  const lastFire = state.textureLastFire || {};
  const turn = state.turn ?? 0;
  const candidates = pool.filter((b) => {
    if (!isTextureBit(b)) return false;
    if (!fuelFit(b, state).available) return false; // still needs its ammo if fueled
    if (!eligiblePools.includes(bitPool(b))) return false; // phase gate, no grace
    const last = lastFire[b.id] || 0;
    if (last > 0 && turn - last < bitCooldown(b)) return false; // still cooling down
    return true;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => (lastFire[a.id] || 0) - (lastFire[b.id] || 0));
  if (!TEXTURE_LOTTERY) return candidates[0];
  // WEIGHTED LOTTERY: take the top N by wait time (never-fired bits, lastFire
  // 0, naturally sort first and dominate here same as the deterministic path),
  // weight each by how long it's waited, pick randomly proportional to weight.
  const shortlist = candidates.slice(0, Math.max(1, TEXTURE_LOTTERY_TOP_N));
  const weights = shortlist.map((b) => Math.max(1, turn - (lastFire[b.id] || 0)));
  const total = weights.reduce((a, w) => a + w, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < shortlist.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return shortlist[i];
  }
  return shortlist[0]; // floating-point fallback, should never actually hit
}
// Debug/proof helper (same discipline as steps a-c: prove on a live log before
// flipping TEXTURE_ROTATION on). Not called by production selection — a quick
// way to confirm the registry's implicit texture set still matches Bits'
// count (73 at spec time) after any future registry recompile.
export function textureBitIds(pool = BITS) {
  return pool.filter(isTextureBit).map((b) => b.id);
}
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
  // SIMPLIFIED (Aug 5, Andrew: strip fit down to eligibility, drop the small
  // scored bonuses). Archetype match is now a pure binary gate — matches or
  // it's excluded, no differentiated bonus for universal-vs-specific match
  // anymore (both used to add a small score; now both just mean "eligible").
  // Accusation and tone bonuses removed entirely — they were fine-grained
  // tie-breakers built for a precise-scoring philosophy; the system is
  // moving toward eligible-pool + weighted/LRU selection instead (same
  // shape the texture lottery already uses), where these small bonuses
  // don't have an obvious job left. WEIGHTS.archetypeMatch/universal/
  // accusation/tone are now unused — removed from WEIGHTS below.
  const arch = bit.archetypes;
  const eligible =
    arch === "universal" ||
    (Array.isArray(arch) && arch.includes(state.archetype)) ||
    TEST_UNSCOPE_BITS.has(bit.id);
  if (!eligible) {
    return { score: -Infinity, why: ["archetype mismatch — excluded"] };
  }
  return { score: 0, why: [] };
}
function gearBias(bit, state) {
  // CONFIRMED DEAD (Aug 5, Bits: intentional, not a regression) — this used
  // to read bit.gear[axis][state], but the registry moved to flat top-level
  // pressure/engagement/suspicion fields at some point and this was never
  // updated to match. Verified directly: zero bits in the current registry
  // have a .gear field at all, so this has been contributing 0 to every
  // score, for every bit, for as long as that's been true. Left as a stub
  // (not deleted outright) so breakdown.gearBias stays a stable key for
  // anything downstream still reading it — always 0/undefined now, never
  // computed from anything.
  return { bias: 0, why: [] };
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
    // TEST POOL CAP (test-mode only): when set, ONLY these ids are deployable —
    // exclude everything else before any other gate. Empty = no cap (normal).
    if (TEST_POOL_CAP.size > 0 && !TEST_POOL_CAP.has(b.id)) return false;
    if (b.status === "parked") return false; // no producer for its fuel yet
    if (isDeathBlow(b)) return false;
    // TEXTURE ROTATION (step d): once on, the texture bits are OWNED by
    // selectTextureBit()'s phase+cooldown LRU rotation, not gear-scored here
    // anymore. Off (default) -> this line is a no-op and loadout is byte-for-
    // byte the same pool it was before this feature existed.
    if (TEXTURE_ROTATION && isTextureBit(b)) return false;
    if (!fuelFit(b, state).available) return false; // missing ammo — hard gate
    // TRIGGER GATE (step b) — event-gated eligibility, ALLOWLIST-scoped.
    // Only bits whose trigger is in EMITTED_TRIGGERS are gated here; a bit with
    // no trigger, or a trigger PE doesn't emit yet, or the "ambient" lane tag,
    // is skipped entirely and falls through to gear-scoring unchanged. So this
    // NARROWS the pool (removes an event-bit on turns its event is absent) and
    // never widens or blackholes: a non-allowlisted trigger is a no-op here.
    if (TRIGGER_MATCH && b.trigger && EMITTED_TRIGGERS.has(b.trigger)) {
      if (!triggerPresent(b.trigger, state)) return false;
    }
    // LATEST-TURN GATE (new registry field, Aug 4): a hard eligibility
    // cutoff, same shape as the phase_pref exclusion above — NOT a scoring
    // penalty, a bit past its latest_turn simply isn't in the pool anymore.
    // Generic (any bit can carry this field), not hardcoded to a specific
    // id — same rule-based philosophy as phase_pref above. First use:
    // BIT-110 (The Name Pronunciation Bit), latest_turn:8 — the bit only
    // makes sense early; past turn 8 it's excluded outright, same as an
    // opening bit once the call leaves opening.
    if (b.latest_turn != null && (state.turn ?? 0) > b.latest_turn) return false;
    // OPENING GATE — two rules, phase first (Bits ratified Jul 15).
    //
    // 1. PHASE is the real boundary: opening bits leave the pool the moment the
    //    reader says the call is no longer in its opening. This is an
    //    EXCLUSION, not the soft +1.5 phasePref bias — a bias can be outranked
    //    (all 10 opening bits clear the bar on gear alone), an exclusion can't.
    //    Fails OPEN when state.phase is absent, so a caller that predates the
    //    phase field is never silently starved.
    // 2. TURN CEILING is only a backstop for a SILENT reader — see
    //    OPENING_MAX_TURN above. It is not the boundary and must never be
    //    tuned as if it were.
    if (b.phase_pref === "opening") {
      if (state.phase && state.phase !== "opening") return false;
      if (OPENING_MAX_TURN > 0 && (state.turn ?? 0) > OPENING_MAX_TURN) return false;
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

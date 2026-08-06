// SpamViking — Posture Engine
//
// Sits between the LiveKit voice agent and Claude as an OpenAI-compatible
// /chat/completions endpoint. The agent POSTs the conversation every turn
// (OpenAI format); we forward it to Anthropic's Messages API with streaming,
// translate the Anthropic SSE stream into OpenAI-style SSE deltas, and stream
// it back.
//
// This is the full engine, not a thin relay: PE compiles the host prompt,
// tracks call state, decides which comedy bit fires, and streams the host's
// line back. (HISTORICAL: this file started life as a "Phase 1: dumb proxy"
// that only forwarded turns with no posture/store/rules — that phase is long
// over; the banner describing it as a dumb proxy has been retired along with
// the Vapi runtime it originally fronted.)
//
// THE INVARIANT (carried from the original build plan): the voice never
// waits on a slow decision. The only LLM the speech path awaits is this Host
// line. The Governor runs via waitUntil() (see note at bottom) so it never
// blocks this stream.

export const config = { runtime: "edge" };

import { getCall, getCallBySlug, setCall, isConfigured, appendGearEvent, appendBitEvent, clearDeathBlow, getControls, stampArm, fireArm, fireForce, saveTranscript } from "../_store.js";
import { directiveFor } from "../_host_directives.js";
import { selectBit, rankBits, DEPLOY_THRESHOLD, selectTextureBit } from "../_bits_scorer.js";
import { archetypeFromBody } from "../_archetype.js";
// ── ACCUSATION DETECTION (Aug 5, extracted from _gears_tells.js/_gears.js as
// part of removing gears entirely) ────────────────────────────────────────
// This is NOT part of the suspicion state machine that's being removed — it's
// a small, self-contained classifier (what TYPE of accusation, if any, did
// the caller just make) with real, separate consumers: the starvation-guard
// exception (don't force-fire a random bit onto a turn where the caller just
// challenged the host), the extended_stall pitch/ask signal, and telemetry.
// Suspicion's accumulator/hysteresis/one-way-ratchet-to-foregone machinery
// and its dedicated posture directive are gone (Andrew: lean on CORE's
// permanent anti-break framework instead, no separate per-turn cue) — but
// this plain regex classifier survives on its own, unchanged in behavior.
const ACCUSATION_TELLS = {
  ai: /\b(are you (?:a |an )?(?:ai|bot|robot|recording|machine|computer)|is this (?:a |an )?(?:ai|bot|recording|automated)|you'?re (?:a )?(?:bot|ai|robot|recording)|this is (?:automated|a recording|pre-?recorded)|talking to (?:a |an )?(?:bot|machine|ai))\b/i,
  scam: /\b(this is (?:a )?(?:scam|fraud|fake)|you'?re (?:scamming|a scammer|trying to scam)|(?:i'?m )?reporting (?:you|this)|fraud(?:ulent)?|(?:this is )?illegal|i'?m calling the (?:police|cops|authorities|bank))\b/i,
  time_waste: /\b(wasting my time|waste of (?:my )?time|is this a joke|are you (?:kidding|joking|serious)|stop wasting|this is ridiculous|you'?re wasting|i don'?t have time for this)\b/i,
};
function detectAccusation(utterance) {
  const u = utterance || "";
  if (ACCUSATION_TELLS.ai.test(u)) return "ai";
  if (ACCUSATION_TELLS.scam.test(u)) return "scam";
  if (ACCUSATION_TELLS.time_waste.test(u)) return "time_waste";
  return null;
}
// POSTURE BLOCK (Aug 5, replaces _gears.js's postureBlock now that the file
// is gone). Two axes only — pressure, engagement — suspicion's dedicated
// directive is retired entirely (Andrew: lean on CORE's permanent anti-break
// framework instead, no separate per-turn cue). Same directiveFor() lookup
// _gears.js used to call, same safe-fallback-on-failure behavior (a host
// turn must never throw and kill the call over a directive lookup), same
// [INTERNAL DIRECTION] non-spoken framing.
function buildPostureBlock(state) {
  const safeDirective = (axis, pos) => {
    try {
      const d = directiveFor(axis, pos);
      if (d) return d;
    } catch (e) { /* fall through to inline */ }
    return "Read the caller and respond naturally, in character.";
  };
  const line = (axis, pos) => `  (${axis}) ${safeDirective(axis, pos)}`;
  return (
    "[INTERNAL DIRECTION — do NOT say any of this aloud, do NOT read these " +
    "labels or state names to the caller. This only tells you HOW to play " +
    "your next spoken line:]\n" +
    [line("pressure", state.pressure), line("engagement", state.engagement)].join("\n")
  );
}
import { readAmmunition, readFuel, readPriorContact, resolveTargetId } from "../_read.js";
import { beginArrival, advanceArrival, generateBenchBeat, isPhantom, phantomInvokeDirective, autoArrivalId, benchEntry, BENCH } from "../_bench_v2.js";
import { telegraphDirective, fireHandoff } from "../handoff.js";
import { autoBenchAction } from "../_bench_auto.js";
import { makeTrace, blowLandedTotal, bitFireCount } from "../_trace.js";
import { BITS } from "../_bits_registry.js";

// PHASE LOOKUP for gear_state (Mead Hall's opening-bits group). phase_pref is
// static per bit in the registry, so a by-id map built once is exact and free.
// Emit the RAW phase_pref ("opening" | "pitching" | "probing" | "drifting")
// rather than a lossy opening/mid/close bucketing — Mead Hall only needs to
// pull the openings out today, but sending the true value lets them regroup
// however they like without another PE change, and preserves the pitching/
// probing/drifting distinction the 3-bucket map would have thrown away.
// Untagged bits are phase-neutral (eligible across the call) -> "any".
const BIT_PHASE = Object.fromEntries(
  (Array.isArray(BITS) ? BITS : []).map((b) => [b.id, b.phase_pref || "any"])
);
const phaseOf = (id) => BIT_PHASE[id] || "any";

// LANE LOOKUP — parallel to BIT_PHASE. "gag" bits (coffee cup, dog, door, etc.)
// belong to the puncture-comedy lane and fire on a SEPARATE clock that bypasses
// warmup/MIN_GAP/deploy-bar (see the turn-1 gag-open path below). Untagged bits
// are the normal slow-burn lane -> "slow".
const BIT_LANE = Object.fromEntries(
  (Array.isArray(BITS) ? BITS : []).map((b) => [b.id, b.lane || "slow"])
);
const laneOf = (id) => BIT_LANE[id] || "slow";
// STALL TYPE (Bits' stall_type field): "hold" = the silence IS the joke, agent
// should suppress its watchdog and hold silent (BIT-211, BIT-215); "hunt" = the
// silence is dead air the host should FILL by advancing the rungs, agent should
// let the nudge through (BIT-233 et al.). Absent → treat as "hold" (the safe,
// pre-split behavior: suppress). PE reads this per stall bit and makes pe_stall
// CARRY the type instead of a bare boolean, so the agent can branch. Behind
// STALL_TYPE_SPLIT: off → pe_stall stays the legacy bare boolean (uniform
// suppress, today's behavior); on → pe_stall carries "hold"/"hunt".
const BIT_STALL_TYPE = Object.fromEntries(
  (Array.isArray(BITS) ? BITS : []).map((b) => [b.id, b.stall_type || null])
);
const stallTypeOf = (id) => BIT_STALL_TYPE[id] || "hold"; // absent → safe default
const STALL_TYPE_SPLIT =
  /^(1|true|yes|on)$/i.test(String(process.env.STALL_TYPE_SPLIT || ""));
// TEST_PRIORITY_BITS (Aug 6, TEST HARNESS, throwaway — replaces SOLO_BIT,
// removed same day once this fully subsumed it: TEST_PRIORITY_BITS set to
// a single id behaves identically to what SOLO_BIT did, so keeping both was
// two mechanisms for one job). Comma-separated list of bit ids — a single
// id works exactly like the old SOLO_BIT; a longer list reviews a whole
// batch across a handful of test calls instead of one run per bit. When
// set, EVERY call cycles through ONLY that list — LRU within it, same
// last-fired-turn logic selectTextureBit() already uses, so repeated test
// calls naturally rotate through the whole list rather than always forcing
// the same one. Bypasses ALL normal eligibility (archetype/pool/cooldown/
// trigger/family/absurdity) — the point is to HEAR the bit regardless of
// whether it would naturally be eligible right now. Unset in production;
// delete once the review pass is done.
const TEST_PRIORITY_BITS = String(process.env.TEST_PRIORITY_BITS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
import { waitUntil } from "@vercel/functions";

// FULL BIT DIRECTIVES (id -> directive prose), same source providers.js
// compiles the ARMED loadout from. Needed here because AUTO-fired bits (the
// pool) are NOT in the prefix loadout — without this, the model only ever saw
// the fired bit's NAME and performed name-flavored mood instead of the routine
// (the systemic sanding Bits chat diagnosed).
//
// LAZY, NOT TOP-LEVEL. This was `await import(...)` at module scope, which
// FAILED THE VERCEL BUILD: Vercel transpiles these ESM functions to CommonJS
// ("Node.js functions are compiled from ESM to CommonJS"), and top-level await
// is legal in ESM but illegal in CJS — it broke every deploy, and took
// api/sim/sim-call.js down with it (it requires this file). Do NOT reintroduce
// a top-level await here. The fix is to load on first use instead: the promise
// is created once and reused, so the import cost is paid once per isolate and
// every later turn hits warm module state. Still defensive like providers.js —
// a missing/unloadable file degrades to the loadout-pointer fallback, never a
// crash.
let BIT_DIRECTIVES = {};
let bitDirectivesPromise = null;
function loadBitDirectives() {
  if (!bitDirectivesPromise) {
    bitDirectivesPromise = import("../compiler/_bits_directives.js")
      .then((mod) => { BIT_DIRECTIVES = mod.default || mod || {}; return BIT_DIRECTIVES; })
      .catch(() => { BIT_DIRECTIVES = {}; return BIT_DIRECTIVES; });
  }
  return bitDirectivesPromise;
}

// HOST NAME is per-call now: it's whoever the spammer emailed, carried on the
// booking token -> meeting page -> call (variableValues.sv_host_name, also
// metadata.host_name). The env HOST_NAME is only the last-resort default. Read
// the same way archetype is read so it survives the web-call metadata quirk.
const HOST_NAME_DEFAULT = process.env.HOST_NAME || "Andrew";
function hostNameFromBody(body) {
  if (!body) return HOST_NAME_DEFAULT;
  const vv =
    body.call?.assistantOverrides?.variableValues ||
    body.assistantOverrides?.variableValues ||
    {};
  return (
    body.call?.metadata?.host_name ||
    body.metadata?.host_name ||
    vv.sv_host_name ||
    body.host_name ||
    HOST_NAME_DEFAULT
  );
}

// Host's timezone, for the fast-join opener's hour-of-day read. The spammer's
// browser can't tell us the HOST's local hour, so the proxy derives it here.
// The SV user picks their timezone at onboarding; it rides the booking token
// into the call as variableValues.sv_host_tz. Env HOST_TZ is the fallback, and
// US Eastern is the final default if neither is set.
const HOST_TZ_DEFAULT = process.env.HOST_TZ || "America/New_York";
function hostTzFromBody(body) {
  if (!body) return HOST_TZ_DEFAULT;
  const vv =
    body.call?.assistantOverrides?.variableValues ||
    body.assistantOverrides?.variableValues ||
    {};
  const tz =
    body.call?.metadata?.host_tz ||
    body.metadata?.host_tz ||
    vv.sv_host_tz ||
    body.host_tz ||
    HOST_TZ_DEFAULT;
  return tz || HOST_TZ_DEFAULT;
}
function hostLocalHour(iso, tz) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  try {
    const h = new Intl.DateTimeFormat("en-US", {
      hour: "numeric", hour12: false, timeZone: tz || HOST_TZ_DEFAULT,
    }).format(new Date(t));
    const n = parseInt(h, 10);
    return Number.isFinite(n) ? n % 24 : null;
  } catch {
    // Bad/unknown tz string -> retry with the safe default rather than going dark.
    try {
      const h2 = new Intl.DateTimeFormat("en-US", {
        hour: "numeric", hour12: false, timeZone: HOST_TZ_DEFAULT,
      }).format(new Date(t));
      const n2 = parseInt(h2, 10);
      return Number.isFinite(n2) ? n2 % 24 : null;
    } catch {
      return null;
    }
  }
}

// The fast-join opener instruction. Only built on the host's FIRST line of a
// fast-join call. Branches on the host-local hour (so a 1 AM booking never gets
// "great afternoon"), and only does the "saw you in the waiting room" callback
// when they actually sat there (waited seconds past a real threshold). Returns
// "" when this isn't a fast-join opener moment, so normal calls are untouched.
function fastJoinOpener(body, turn) {
  if (turn > 0) return ""; // opener is the host's first line only
  const vv =
    body?.call?.assistantOverrides?.variableValues ||
    body?.assistantOverrides?.variableValues ||
    {};
  const isFast = /^(1|true|yes|on)$/i.test(String(vv.sv_fast_join || ""));
  if (!isFast) return "";

  const hour = hostLocalHour(vv.sv_booked_slot, hostTzFromBody(body));
  const waited = parseInt(vv.sv_waited_secs || "0", 10) || 0;
  const name = hostNameFromBody(body);

  // Time-of-day flavor, in the host's own frame.
  let timeCue;
  if (hour == null) {
    timeCue = "Greet them warmly without naming a time of day.";
  } else if (hour >= 8 && hour < 18) {
    timeCue =
      "It's the middle of your working day — sound like a busy exec who " +
      "happened to have a window open: \"perfect, I had a gap\".";
  } else if (hour >= 18 && hour < 22) {
    timeCue =
      "It's your evening — sound like someone wrapping up the day who's " +
      "happy to squeeze this in.";
  } else {
    timeCue =
      "It's late night / very early morning in your time zone — lean into " +
      "that as a small joke (\"I was up anyway\", or \"caught me burning the " +
      "midnight oil\"). NEVER greet them with \"good afternoon\" or similar.";
  }

  const waitCue =
    waited >= 45
      ? "They were already sitting in the waiting room when you joined — open " +
        "by acknowledging it warmly: \"saw you were already in there waiting — " +
        "appreciate you hopping on at short notice.\""
      : "Open by appreciating that they jumped on at such short notice.";

  // ===== MESSY OPEN (Host Canon §7) — self-flub, TEXT ONLY ==================
  // Gated by FLUB_OPEN (env "1" to enable). When on, pick a size tier via the
  // FLUB_MIX knob and tell the host to ARRIVE MID-MESS on this first line, then
  // recover into warmth. The Canon's §7 in the master prompt defines what each
  // tier IS and how the recovery reads; here we only (a) switch it on and (b)
  // pass the chosen tier label so the master-prompt §7 text knows the size.
  // This is the SELF-FLUB (verbal) messy open — no audio clip, works on TTS now.
  var flubOpen = "";
  if (/^(1|true|yes|on)$/i.test(String(process.env.FLUB_OPEN || ""))) {
    var tier = pickFlubTier(); // "medium" | "bigger" | "big"
    flubOpen =
      " MESSY OPEN — instead of a clean composed greeting, ARRIVE MID-MESS on " +
      "this first line: you're caught already mid-fumble (talking to someone " +
      "off-mic, wrangling a thing that just went wrong, half a sentence already " +
      "in motion) and only now landing on the caller. Size of the mess this " +
      "call: [" + tier + "] — follow the §7 tier guidance for that size. Let it " +
      "resolve into warmth FAST — the mess is the entrance, not the whole line; " +
      "you recover and greet them within a breath. Rotate hard; never the same " +
      "mess twice. It stays self-directed chaos, never aimed at the caller.";
  }

  return (
    "\n\nOPENER — this is your FIRST line of the call, and it's a fast-turnaround " +
    "booking they grabbed just now. You are " + name + ", an eager, slightly " +
    "self-important host who likes to keep the calendar full. " + timeCue + " " +
    waitCue + flubOpen + " Keep it to one or two warm sentences, fully in " +
    "character, then hand it to them. Do not mention scheduling software, slots, " +
    "or the word \"fast-join\"."
  );
}

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// ===== FLUB_MIX KNOB (Host Canon §7 messy-open size ratio) =================
// The messy-open has three size tiers: medium / bigger / big. Andrew tunes the
// mix by flipping ONE env var — no prompt or code edit. FLUB_MIX is three
// comma-separated weights [medium,bigger,big]; default leans big per the Canon.
// pickFlubTier() does a weighted random per call and returns the tier label,
// which the opener passes to the model so the Canon's tier text picks the size.
const FLUB_MIX = () => {
  const raw = String(process.env.FLUB_MIX || "20,30,50");
  const parts = raw.split(",").map((n) => parseInt(n.trim(), 10));
  const [m, b, big] = [parts[0], parts[1], parts[2]].map((n) =>
    Number.isFinite(n) && n >= 0 ? n : 0
  );
  const total = m + b + big;
  return total > 0 ? { medium: m, bigger: b, big: big } : { medium: 20, bigger: 30, big: 50 };
};
function pickFlubTier() {
  const w = FLUB_MIX();
  const total = w.medium + w.bigger + w.big;
  let r = Math.random() * total;
  if ((r -= w.medium) < 0) return "medium";
  if ((r -= w.bigger) < 0) return "bigger";
  return "big";
}


// Set ANTHROPIC_MODEL in Vercel to whatever gives the best latency/wit
// tradeoff for the live voice. Haiku is the low-latency default for voice;
// bump to a Sonnet if the bait character needs more wit and the latency
// holds.
const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
// STEP 1: live-event detector (commitment_push). OFF by default. When on,
// readCall ALSO reports whether the caller just demanded payment. This is
// OBSERVATION-ONLY until Step 2 wires it to the stall — no bit reads it yet.
// Flag off = readCall asks exactly what it asks today (byte-for-byte).
const EVENT_DETECT =
  /^(1|true|yes|on)$/i.test(String(process.env.EVENT_DETECT || ""));
// STEP 2: fire the stall (BIT-233) when the detector reads a commitment_push.
// OFF by default. Requires EVENT_DETECT on to have a signal. Independently
// reversible — EVENT_FIRE off leaves the Step-1 detector fully intact.
const EVENT_FIRE =
  /^(1|true|yes|on)$/i.test(String(process.env.EVENT_FIRE || ""));
// ── CALLER-REDIRECT DETECT ("caller_redirected" signal) ───────────────────
// Same doctrine as commitment_push: the reader already judges INTENT from
// meaning every turn (that's what it's FOR — this is not new text-sniffing,
// it's one more question on the same reader call that already runs). Asks
// whether the caller's most recent turn moved AWAY from whatever the host
// was stalling on (dropped it, changed subject, said "forget it") rather
// than continuing to press on it. OFF by default; when off, readCall's
// prompt and output are BYTE-FOR-BYTE what they were before this existed.
const CALLER_REDIRECT_DETECT =
  /^(1|true|yes|on)$/i.test(String(process.env.CALLER_REDIRECT_DETECT || ""));
// ── CALLER-CRUDE DETECT ("caller_crude" signal, two-level + running count) ─
// Same doctrine as the two above: one more question on the reader call that
// already runs, not new text-sniffing. Classifies the caller's most recent
// turn as "none" | "impersonal" (crude/hostile language not aimed at the
// host — cursing about the world, a competitor, themselves) | "personal"
// (aimed AT the host — a jab, an insult, hostility directed at them).
// Mutually exclusive by construction (the reader picks one). Persisted as
// TWO separate running counts (crudeImpersonalCount, crudePersonalCount) —
// a bare boolean isn't enough for Canon's planned conditional content, which
// wants to know not just "did this happen" but "how many times, of which
// kind." OFF by default; when off, readCall's prompt and output are
// BYTE-FOR-BYTE what they were before this existed.
const CALLER_CRUDE_DETECT =
  /^(1|true|yes|on)$/i.test(String(process.env.CALLER_CRUDE_DETECT || ""));
// ── PRICING RAISED DETECT ("pricing_raised" trigger for BIT-210) ──────────
// Same doctrine as the signals above: one more question on the reader call
// that already runs. UNLIKE commitment_push/caller_redirected/caller_crude
// (all momentary, per-turn, never latched), this is a ONE-WAY LATCH — same
// shape as businessLatched, not the momentary signals: once a specific
// price/cost has been stated ANYWHERE in the call, that fact stays true for
// the rest of the call (a quoted number doesn't stop being known a turn
// later, unlike "caller just demanded payment right now"). Governor's
// trigger-detection pass; BIT-210 is already wired to key on it (Bits' side,
// nothing to build there) — this is PE's emission half, plus the
// EMITTED_TRIGGERS allowlist entry in _bits_scorer.js that makes the
// registry's trigger:"pricing_raised" declaration actually matchable (a
// trigger not in that allowlist falls through to gear-scoring unchanged —
// see that file's own comment on the nothing-goes-dark guarantee). OFF by
// default; when off, readCall's prompt and output are BYTE-FOR-BYTE what
// they were before this existed.
const PRICING_RAISED_DETECT =
  /^(1|true|yes|on)$/i.test(String(process.env.PRICING_RAISED_DETECT || ""));
// ── TEXTURE-INVITED PRE-CHECK ("does this moment even want texture?") ─────
// One more question riding the same reader call — asks whether THIS moment
// genuinely invites something playful, or is a plain business beat where
// texture would feel forced. Distinct from "permission to decline" (the
// sentence added to the fire injection above): this skips selectTextureBit()
// BEFORE anything is picked, rather than handing the model a specific bit
// and asking it to judge fit after the fact. Momentary, not latched (same
// shape as commitmentPush/callerRedirected) — a serious turn now doesn't mean
// the NEXT turn can't want texture again. DEFAULTS PERMISSIVE: texture fires
// unless the flag is on AND the reader explicitly says false — never the
// reverse, so a reader failure/absence never silently kills all texture.
// OFF by default; when off, readCall's prompt/output are unchanged and
// selectTextureBit() runs exactly as it does today.
const TEXTURE_INVITES_DETECT =
  /^(1|true|yes|on)$/i.test(String(process.env.TEXTURE_INVITES_DETECT || ""));
// ── TEXTURE POST-EVENT COOLDOWN ("don't stack texture right on top of a
// bigger moment") ──────────────────────────────────────────────────────────
// Two triggers, one cooldown mechanism: right after a sound/gag marker fires
// (a cup break, a dog bark — that's already its own beat), or right after a
// hunt/stall resolves (Canon's own prompt language already says "a stall can
// overstay" — this adds a mechanical grace period behind it, not a
// replacement for it), texture selection is skipped for
// TEXTURE_POST_EVENT_COOLDOWN_TURNS turns. Reuses state PE already persists
// (markerLastTurn for markers; a new lastStallResolvedTurn stamped alongside
// the existing resolve-clear logic) — no new detection built, just a new
// consumer of facts already being tracked. OFF by default; when off,
// selectTextureBit() runs exactly as it does today, nothing changes.
const TEXTURE_POST_EVENT_COOLDOWN =
  /^(1|true|yes|on)$/i.test(String(process.env.TEXTURE_POST_EVENT_COOLDOWN || ""));
const TEXTURE_POST_EVENT_COOLDOWN_TURNS = parseInt(process.env.TEXTURE_POST_EVENT_COOLDOWN_TURNS || "2", 10);
// ── MARKER AWARENESS ("self-caused environment marker" persistence) ───────
// PE_self_caused_marker_awareness.md. Detection lives in finishUp (the SSE
// handler), persistence in stored.markerCounts/markerLastTurn, injection
// here in the mutable block for any marker fired within the awareness
// window. OFF by default; when off, detection still runs (cheap, harmless)
// but nothing is ever injected and stored.markerLastTurn is simply never
// read.
const MARKER_AWARENESS =
  /^(1|true|yes|on)$/i.test(String(process.env.MARKER_AWARENESS || ""));
// ── CALLER-CRUDE INJECTION TEXT — SWAP POINT ──────────────────────────────
// The PE-side plumbing for the CORE audit's crude-section split
// (CORE_permanent_vs_conditional_audit.md): once Canon splits WHEN THEY SAY
// SOMETHING CRUDE OR HOSTILE — anti-break half stays permanent in CORE,
// "how to play a crude mishear" half comes OUT and needs a new home — this
// injection site is that new home. Canon has NOT sent that text yet, so
// these two functions hold PLACEHOLDER text drawn from CORE's OWN existing
// (still-unsplit) guidance, so the mechanism is provably working on a real
// call today. THE SWAP: when Canon's real text arrives, replace the return
// values of these two functions — nothing else in this file changes.
function crudeImpersonalText(count) {
  return (
    "THE CALLER'S LAST LINE WAS CRUDE OR HOSTILE, BUT NOT AIMED AT YOU — " +
    "about the world, a competitor, themselves. You don't hear it that " +
    "way: take the innocent surface reading and answer that sincerely, OR " +
    "let it remind you of a harmless story (keep it PG), OR just sail " +
    "right past it on the actual topic. Never get scandalized, never " +
    "match it." +
    (count > 1 ? " (This kind of thing has come up " + count + " times " +
      "this call — don't reach for the same handling twice in a row.)" : "")
  );
}
function crudePersonalText(count) {
  return (
    "THE CALLER'S LAST LINE WAS AIMED AT YOU — a jab, an insult, hostility " +
    "directed at you personally. You don't catch the edge: take it at " +
    "face value and answer it sincerely. Never fire back, never get " +
    "defensive, never reveal you noticed anything. You can feel the room " +
    "cool without understanding why — get a touch quieter, that's all. " +
    "Never match or amplify it." +
    (count > 1 ? " (This is the " + count + (count === 2 ? "nd" : count === 3 ? "rd" : "th") +
      " time this call — still never reveal you've noticed a pattern.)" : "")
  );
}
const CPUSH_BIT = process.env.CPUSH_BIT || "BIT-233";
// ── SYNCHRONOUS CARD-ASK TRIGGER (card_ask) ──────────────────────────────
// FIRST BRICK OF THE TRIGGER ARCHITECTURE (replacing gears). The async reader
// detects commitment_push, but it runs in waitUntil and persists for the NEXT
// turn — so on the actual demand turn stored.commitmentPush is still last turn's
// value (false), the cpush override doesn't fire, and the fit-scored questionnaire
// wins the card-ask turn. BIT-233 then fires a turn LATE, which ALSO produces the
// stray "you still there?" (the late first-fire lands on a real caller turn and
// the model opens the hunt as filler before stall-suppression is established).
// Both symptoms are the SAME one-turn lag.
//
// FIX: detect the card-ask SYNCHRONOUSLY from the caller's current turn — a named
// present/not trigger on call state, exactly the trigger-architecture model — so
// the hunt fires the INSTANT the demand lands, not a turn later. This is the
// engine reading caller text for a NAMED trigger, which is the new design (the
// old "engine never sniffs text" rule was gear-era and is superseded here).
//
// HIGH-PRECISION by construction: requires BOTH a transact-intent verb (pay /
// card / sign up / deposit / etc.) AND a now-signal (today / right now / on this
// call / to get started), so a mere price question ("how much is it?") or a vague
// "how would billing work" does NOT trigger. Mirrors the reader's own strict
// wording. Cheap misses (reader still catches it next turn), rare false-fires.
// Behind CARD_ASK_TRIGGER (default ON); set to 0 to fall back to reader-only.
const CARD_ASK_TRIGGER =
  !/^(0|false|no|off)$/i.test(String(process.env.CARD_ASK_TRIGGER || "1"));
// Transact-intent: the caller wants money/commitment to move.
const CARD_ASK_INTENT =
  /\b(credit\s*card|debit\s*card|card\s*(?:number|details|info)|pay(?:ment)?|deposit|wir(?:e|ing)|sign\s*(?:up|me\s*up)|sign(?:ing)?\s*(?:the\s*)?(?:contract|paperwork|up)|put\s*(?:you\s*)?down|lock\s*(?:it|this)\s*in|get\s*you\s*(?:signed|set)\s*up|process\s*(?:your|the)\s*(?:payment|card)|charge\s*(?:your|the)\s*card|billing\s*(?:info|details)|routing\s*number|account\s*number)\b/i;
// Now-signal: it must be a demand to transact NOW, not a general description.
const CARD_ASK_NOW =
  /\b(today|right\s*now|now|this\s*call|on\s*the\s*(?:phone|call)|to\s*get\s*started|to\s*lock\s*(?:it|this)\s*in|go\s*ahead\s*and|if\s*you\s*(?:can\s*)?(?:just\s*)?(?:give|provide)|just\s*need\s*(?:your|the))\b/i;
// True only when BOTH fire on the caller's most recent line.
function cardAskNow(callerText) {
  if (!CARD_ASK_TRIGGER) return false;
  const t = String(callerText || "");
  if (!t) return false;
  return CARD_ASK_INTENT.test(t) && CARD_ASK_NOW.test(t);
}
// STEP 3: beat controller. When BIT-233 fires (a commitment-push scenario
// opened), hold the floor for a few turns so the approver-hunt plays as one
// sustained beat instead of trailing off into undriven host improv or getting
// crashed by a stray bit. Derived from the ALREADY-PERSISTED lastBitId/
// lastBitTurn (no new store column): the window is "the last fired bit was
// CPUSH_BIT and it fired within HUNT_WINDOW_TURNS turns ago." Total floor — no
// OTHER automatic bit fires in the window — but Director force and death-blow
// are checked after and bypass it (human/ending override always wins). Behind
// HUNT_WINDOW; off = today's behavior. Cap-only for v1 (no early-out on hunt
// resolution — that needs a resolution detector we haven't built).
const HUNT_WINDOW =
  /^(1|true|yes|on)$/i.test(String(process.env.HUNT_WINDOW || ""));
const HUNT_WINDOW_TURNS = parseInt(process.env.HUNT_WINDOW_TURNS || "3", 10);
// ── STALL RESOLUTION DETECTOR ("the stall has run long enough") ──────────
// The hunt-window above is cap-only by design — it has no early-out on
// resolution, which is exactly what let a hunt (or any stall-lane bit) run
// indefinitely through repeated caller-silence beats: HUNT_WINDOW_TURNS is
// TURN-COUNT based, and turn is FROZEN during pure silence (the caller isn't
// speaking, so countUserTurns never advances) — so the cap can never trigger
// on silence alone. Diagnosed live (Aug 3, room sv-test-andy-msdiq4god9qp):
// the hunt was correctly holding the floor the whole time; the call ended
// only because the AGENT's own 60s silence_watchdog ceiling closed the room,
// unrelated to PE. This detector gives PE its OWN elapsed-time signal so a
// long-silent stall can be told to WRAP UP before the agent's ceiling forces
// a hard close.
//
// ELAPSED TIME COMES FREE, NO NEW STORE COLUMN: stored.lastBitAt is stamped
// once on the bit's TRUE first fire (`fire && !sameTurnReinject &&
// !inHuntWindow`) and is NEVER re-stamped while inHuntWindow stays true (the
// hunt-window SUSTAIN block's own top/fire override does not re-trigger that
// condition). So for as long as a stall-lane bit keeps holding the floor,
// stored.lastBitAt stays pinned at the moment the stall BEGAN — exactly the
// "how long has this been going" clock this needs, already persisted.
//
// Behind STALL_RESOLVE (default OFF until proven on a live call, same
// discipline as every other flag in this file). STALL_RESOLVE_MS is the
// wall-clock threshold; default sits comfortably inside the agent's own
// ~60s ceiling (3 nudges land around 13s/27s/46-50s per the traced call) so
// PE's own wrap-up instruction has a real chance to land BEFORE the agent
// gives up and silently closes the room. STALL_EXHAUST_RUNGS is the RUNG-
// COUNT threshold (Andrew/Canon framing: "been on the same hunt a while" —
// counted in beats, not seconds). Either crossing resolves the stall — rung
// count is the primary signal a caller/product person reasons in; wall-clock
// is the backstop that still catches a stall during a long silence stretch
// where turns (and so rungs measured per-turn) may not be advancing at all.
const STALL_RESOLVE =
  /^(1|true|yes|on)$/i.test(String(process.env.STALL_RESOLVE || ""));
const STALL_RESOLVE_MS = parseInt(process.env.STALL_RESOLVE_MS || "50000", 10);
const STALL_EXHAUST_RUNGS = parseInt(process.env.STALL_EXHAUST_RUNGS || "3", 10);
// Is the CURRENTLY-HELD stall (whichever bit last fired, if it's stall-lane)
// done — either by RUNG COUNT (stored.huntRungCount, incremented once per
// hunt-window SUSTAIN turn — see the hunt-window block below) or by WALL-
// CLOCK (stored.lastBitAt, pinned at the stall's true start — see above)?
// Pure function of persisted state — no LLM call. Shared by both injection
// sites below (the messagesForModel STALL-LANE GUARD synthetic turn, and the
// hunt-window SUSTAIN gate) so there is exactly one definition of "done."
//
// Returns the SPECIFIC reason ("rung_count" | "elapsed_time" |
// "caller_redirected") or null — not just a boolean. Added after a live call
// showed the RESOLVE log line printing "elapsed Ns >= Ns threshold" even on
// turns where rung count (not elapsed time) was the actual trigger, which
// misread as a math error when reviewing logs. stallShouldResolve() below
// keeps the old boolean API for existing call sites; the reason is used only
// for the log line.
function stallResolveReason(stored) {
  if (!STALL_RESOLVE) return null;
  if (!stored || !stored.lastBitId || !stored.lastBitAt) return null;
  if (laneOf(stored.lastBitId) !== "stall") return null;
  const rungsExhausted =
    STALL_EXHAUST_RUNGS > 0 && (stored.huntRungCount || 0) >= STALL_EXHAUST_RUNGS;
  const timeExhausted = Date.now() - stored.lastBitAt >= STALL_RESOLVE_MS;
  // CALLER-REDIRECT: the reader's judgment (flag-gated, see
  // CALLER_REDIRECT_DETECT above) that the caller's last turn moved AWAY
  // from what the host is stalling on. When true, resolve immediately
  // regardless of rung count or elapsed time — Canon's framing ("the caller
  // pulls away from it, you let it rest") is a THIRD, independent way in,
  // not a replacement for the other two.
  const callerMovedOn = stored.callerRedirected === true;
  // Checked in this order so the log names whichever ACTUALLY tripped first;
  // more than one can be true at once (e.g. rung count AND elapsed time both
  // past threshold), in which case the first one checked is what's reported —
  // harmless, since all three mean the same thing downstream (resolve now).
  if (callerMovedOn) return "caller_redirected";
  if (rungsExhausted) return "rung_count";
  if (timeExhausted) return "elapsed_time";
  return null;
}
function stallShouldResolve(stored) {
  return stallResolveReason(stored) !== null;
}
const MAX_TOKENS = () => parseInt(process.env.MAX_TOKENS || "1024", 10);
// ── FIRST-TOKEN WATCHDOG (Aug 4, live-call finding — CORRECTED same day) ───
// A real call showed one generation taking 11.4s end-to-end on an ordinary
// cached request (cache_creation:0 — not a cold-start cost, the model just
// took that long). ORIGINAL framing here was wrong and has been corrected
// per Voice: LiveKit's "preemptive generation" is NOT parallel candidates
// racing — it's ONE speculative generation, cancelled and restarted fresh
// if context changes mid-flight. The several requestIds seen in a log for
// one turn are SEQUENTIAL attempts (speculative -> discarded -> real), not
// simultaneous racers, and there is no first-finished-wins mechanism to
// lean on. The 11.4s was the only real generation for that turn, full stop.
//
// Voice owns the primary fix now: a per-request LLM timeout (APIConnectOptions)
// on the agent side, agreed at 8s with one retry — closer to the actual
// call, and able to genuinely retry a fresh generation rather than just
// substitute a placeholder line. THIS watchdog is deliberately set well
// PAST that ceiling (20s, vs. Voice's 8s+retry) so the two stop competing:
// it no longer exists to catch the common case, only the genuine worst
// case where even Voice's own retry comes back slow too. If Voice's fix
// proves solid in practice, this can likely come out entirely later — kept
// for now as a deeper backstop, not a redundant first line.
//
// Mechanism unchanged: keyed on TIME-TO-FIRST-TOKEN, not total response
// time — once real content starts flowing, the watchdog stands down
// completely. A response this fires on is thrown away entirely, not
// delayed-then-shown.
const FIRST_TOKEN_TIMEOUT_MS = parseInt(process.env.FIRST_TOKEN_TIMEOUT_MS || "20000", 10);
// Varied on purpose — never the same "buying time" line twice in a row in
// practice, since which one fires is random each time. Deliberately generic
// (works regardless of what the actual turn was about) and deliberately
// mundane — this is a rare-case safety net, not a bit; it should read as a
// normal human beat, not draw attention to itself.
const FIRST_TOKEN_FALLBACKS = [
  "Sorry — hang on one sec, I got distracted for a second there.",
  "Oh — sorry, hold on, what were you saying? I spaced out for a second.",
  "Hang on, one sec — sorry, lost my train of thought there for a moment.",
  "Sorry, say that again? I got pulled away for a second.",
];



// Generate a bench character's barge-in line, in character, reacting to the
// live call. Fast non-streaming Haiku call (short cap). Returns the spoken line
// or null (caller falls back to a canned line). Fired in PARALLEL with the host
// reply so it adds ~no latency — it's awaited only at stream close.
async function generateBenchLine(bench, messages) {
  try {
    const convo = messages
      .slice(-6)
      .map((m) => (m.role === "user" ? "Caller: " : "Host: ") + m.content)
      .join("\n");
    const name = bench.tag.charAt(0) + bench.tag.slice(1).toLowerCase();
    const sys =
      "You are " + name + ", " + bench.note + ". You have just barged into this " +
      "live call, cutting the host off mid-sentence. Say ONE short spoken line " +
      "(max ~25 words), blunt and fully in character, reacting to what is being " +
      "discussed. Output ONLY the spoken words — no name label, no quotes, no " +
      "stage directions.";
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL(),
        max_tokens: 80,
        system: sys,
        messages: [{ role: "user", content: convo + "\n\n(" + name + " cuts in:)" }],
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const txt = (j.content || []).map((c) => c.text || "").join("").trim();
    if (!txt || txt.length > 240) return null;
    return txt;
  } catch {
    return null;
  }
}

// ASYNC CALL READER — the Stage-4 meaning-based read. Runs in waitUntil AFTER
// the host's response streams out (zero added latency), judges the call from
// the recent conversation, and writes the result for the NEXT turn to read.
// ONE LLM call per turn returns phase + pressure + engagement.
//
// READER-ONLY NOW (Aug 5, gears removal): there's no more synchronous keyword
// layer to blend with — pressure/engagement are sourced entirely from this
// reader (one-turn lag, accepted). Suspicion is gone entirely (no
// replacement; CORE's permanent anti-break framework carries that job now).
//
// Returns { phase, pressure, engagement } with only LEGAL values, or null on
// any failure (the prior turn's stored values simply carry forward — safe).
async function readCall(messages, prior) {
  try {
    const convo = messages
      .slice(-8)
      .map((m) => (m.role === "user" ? "Caller: " : "Host: ") + m.content)
      .join("\n");
    const p = prior || {};
    const sys =
      "You read a live sales/spam call and report the caller's state. The caller " +
      "cold-contacted the host to sell something; the host is stalling them. " +
      "Judge THREE things from the caller's recent behavior, reading INTENT (not " +
      "keywords). Reply as compact JSON only, no prose.\n\n" +
      "phase — where the call is now:\n" +
      "  opening (pleasantries, no pitch yet) | pitching (presenting their " +
      "offer) | probing (pressing for a decision/commitment/payment/info) | " +
      "drifting (wandered into chit-chat mid-call)\n" +
      "pressure — how hard they push to close/extract:\n" +
      "  calm | pushing (pressing the sale) | extracting (demanding info/payment/" +
      "action now)\n" +
      "engagement — how invested they are:\n" +
      "  bored (disengaging) | hooked (engaged) | stunned (thrown/derailed by the " +
      "host)\n\n" +
      "SARCASM / CONTEMPT / MOCKERY (important — read the TONE, not the words): a " +
      "caller who says 'oh this sounds GREAT' or 'wow, real professional' " +
      "sarcastically is NOT engaged or complimenting — they are mocking, cooling, " +
      "or testing the host. The literal words look positive; the INTENT is cold. " +
      "When you detect sarcasm, mockery, or contempt aimed at the host, register " +
      "it as a TEMPERATURE DROP in the gears: nudge engagement toward 'bored' " +
      "(they're checking out / above it) and, if it reads as doubt or a test, " +
      "suspicion toward 'slipping'. Do NOT be fooled by the positive surface " +
      "words. This is exactly the signal keywords cannot catch and you can.\n\n" +
      "Prior read: phase=" + (p.phase || "opening") + " suspicion=" +
      (p.suspicion || "alive") + " pressure=" + (p.pressure || "calm") +
      " engagement=" + (p.engagement || "hooked") + ". Only change a value if the " +
      "recent turns clearly warrant it (avoid flip-flopping).\n" +
      // STEP 1 (flag-gated): ask for the commitment_push live event. High-
      // precision wording — true ONLY on an unambiguous demand to transact
      // now; when unsure, false. Cheap misses, rare false-fires.
      (EVENT_DETECT
        ? "commitment_push — did the caller, IN THEIR MOST RECENT turn, make " +
          "a CLEAR demand to pay / hand over a card / send money / put a " +
          "deposit down / sign up RIGHT NOW? Report true ONLY if it is an " +
          "unambiguous push to transact now. A general question about " +
          "pricing, a vague 'how would payment work', or merely mentioning " +
          "cost is NOT a push — report false. When unsure, report false.\n"
        : "") +
      (CALLER_REDIRECT_DETECT
        ? "caller_redirected — the host may be mid-stall (waiting on an " +
          "approver, chasing something down). Did the caller's MOST RECENT " +
          "turn move AWAY from that — change the subject, drop it, say " +
          "'never mind' / 'forget it', or otherwise stop pressing on the " +
          "thing the host is stalling about? Report true only if they " +
          "clearly moved on. A caller who is just quiet, or still pushing " +
          "on the SAME thing, is NOT a redirect — report false. When " +
          "unsure, report false.\n"
        : "") +
      (CALLER_CRUDE_DETECT
        ? "caller_crude — did the caller's MOST RECENT turn include " +
          "something crude, hostile, or demeaning? Classify it: " +
          "\"impersonal\" (crude/hostile language NOT aimed at the host — " +
          "cursing about the world, a competitor, themselves), " +
          "\"personal\" (aimed AT the host — a jab, an insult, hostility " +
          "directed at them), or \"none\" if nothing crude. When unsure, " +
          "report \"none\".\n"
        : "") +
      (PRICING_RAISED_DETECT
        ? "pricing_raised — has a SPECIFIC price, cost, rate, or dollar " +
          "figure been stated ANYWHERE in the call so far (by either " +
          "party)? Report true once a real number has been quoted — a " +
          "monthly fee, a per-visit rate, an install cost, anything " +
          "concrete. A vague reference to 'pricing' or 'cost' with no " +
          "actual figure is NOT enough — report false until a real number " +
          "appears. This is a ONE-WAY fact: once true, later turns should " +
          "still report true even if pricing isn't being discussed at that " +
          "exact moment.\n"
        : "") +
      (TEXTURE_INVITES_DETECT
        ? "texture_invited — does THIS specific moment genuinely invite " +
          "something playful (a joke, a tangent, a reaction), or is it a " +
          "plain, serious business beat where a bit would feel forced or " +
          "out of place? Report false ONLY when the moment is clearly " +
          "serious or sensitive — a real complaint, a genuine question " +
          "needing a straight answer, a moment of real tension. When " +
          "unsure, report true — most ordinary turns DO have room for a " +
          "little texture.\n"
        : "") +
      (() => {
        // Build the Reply-EXACTLY line from whichever flags are on, instead
        // of a nested ternary per combination — scales cleanly as more
        // flag-gated fields get added (this is now the fifth).
        const fields = ['"phase":".."', '"pressure":".."', '"engagement":".."'];
        if (EVENT_DETECT) fields.push('"commitment_push":true|false');
        if (CALLER_REDIRECT_DETECT) fields.push('"caller_redirected":true|false');
        if (CALLER_CRUDE_DETECT) fields.push('"caller_crude":"none"|"impersonal"|"personal"');
        if (PRICING_RAISED_DETECT) fields.push('"pricing_raised":true|false');
        if (TEXTURE_INVITES_DETECT) fields.push('"texture_invited":true|false');
        return "Reply EXACTLY: {" + fields.join(",") + "}";
      })();
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL(),
        // RAISED AGAIN 200 -> 1024 (Aug 6) — the previous raise (60->200,
        // Aug 4) helped but didn't fully fix it. DEFINITIVELY diagnosed this
        // time, not just hypothesized: the enriched diagnostic caught
        // blockTypes=["thinking"] on a live failure — the model is
        // generating an EXTENDED-THINKING block for this call, and the
        // entire budget was being consumed by that block (empty, cut off
        // mid-start by max_tokens) before any JSON ever got a chance to
        // appear. 200 tokens was never going to be enough once thinking
        // overhead is in play, regardless of the reply schema's field
        // count. Still a tiny, cheap, low-latency call in absolute terms —
        // 1024 is real headroom for thinking + JSON both, not a meaningful
        // cost change.
        max_tokens: 1024,
        system: sys,
        messages: [{ role: "user", content: convo + "\n\nJSON:" }],
      }),
    });
    // FAILURE-REASON LOGGING (Aug 4): "callread FAILED" at the call site used
    // to be a single generic message regardless of WHICH of these three
    // things actually happened — an HTTP error, a reply with no JSON object
    // in it at all, or a reply with a JSON-shaped chunk that didn't actually
    // parse (e.g. truncated mid-object). Logging the specific reason here,
    // at the point it's actually known, means the next time this fires the
    // cause is visible immediately instead of requiring another diagnosis
    // pass like this one.
    if (!r.ok) {
      console.log("callread REASON=http_not_ok status=" + r.status);
      return null;
    }
    const j = await r.json();
    const txt = (j.content || []).map((c) => c.text || "").join("").trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) {
      // ENRICHED (Aug 5): a live call showed this branch firing repeatedly
      // with raw="" (genuinely empty content, not truncated mid-JSON) — a
      // DIFFERENT shape than the truncation this reason was originally built
      // to catch. New suspect: readCall shares MODEL() with the main host
      // turn, so it's now running on whatever model that resolves to (e.g.
      // Sonnet) for a terse forced-JSON task it was never tuned against.
      // stop_reason + output_tokens actually consumed distinguishes the
      // possibilities: stop_reason="max_tokens" with output_tokens near the
      // budget ceiling means something (preamble?) ate the whole budget
      // before any JSON appeared; stop_reason="end_turn" with output_tokens
      // near zero means the model stopped on its own with nothing to say —
      // a different problem entirely. No more guessing which on the next fire.
      console.log(
        "callread REASON=no_json_found raw=" + JSON.stringify(txt.slice(0, 150)) +
        " stop_reason=" + (j.stop_reason || "?") +
        " output_tokens=" + (j.usage && j.usage.output_tokens != null ? j.usage.output_tokens : "?") +
        " contentBlocks=" + ((j.content || []).length) +
        // FURTHER ENRICHED (Aug 5): the leading hypothesis after the above —
        // 200 tokens spent, one real content block, zero extracted text —
        // is that the block isn't type:"text" at all (a reasoning/thinking-
        // style block would look exactly like this, since only .text gets
        // read here). This logs each block's actual type and, for anything
        // with a non-"text" shape, a preview of whatever field DOES hold
        // content — confirms or kills the hypothesis directly instead of
        // inferring it from token counts alone.
        " blockTypes=" + JSON.stringify((j.content || []).map((c) => c.type)) +
        " blockPreview=" + JSON.stringify(
          (j.content || []).map((c) => {
            if (c.type === "text") return { type: c.type, len: (c.text || "").length };
            // Any other block shape: dump its own keys + a short preview of
            // whichever field looks like it holds the actual content.
            const contentField = c.thinking || c.text || JSON.stringify(c).slice(0, 100);
            return { type: c.type, keys: Object.keys(c), preview: String(contentField).slice(0, 100) };
          })
        )
      );
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(m[0]);
    } catch (e) {
      console.log(
        "callread REASON=parse_error err=" + (e && e.message ? e.message : e) +
        " raw=" + JSON.stringify(m[0].slice(0, 150)) +
        " stop_reason=" + (j.stop_reason || "?") +
        " output_tokens=" + (j.usage && j.usage.output_tokens != null ? j.usage.output_tokens : "?")
      );
      return null;
    }
    // Validate each field against legal values; drop anything illegal.
    const legal = {
      phase: ["opening", "pitching", "probing", "drifting"],
      pressure: ["calm", "pushing", "extracting"],
      engagement: ["bored", "hooked", "stunned"],
    };
    const out = {};
    for (const k of Object.keys(legal)) {
      const v = typeof parsed[k] === "string" ? parsed[k].toLowerCase().trim() : null;
      if (v && legal[k].includes(v)) out[k] = v;
    }
    // STEP 1 (flag-gated): carry the commitment_push live-event boolean.
    // Strict boolean, defaults false. Never present when the flag is off.
    if (EVENT_DETECT) {
      out.commitmentPush = parsed.commitment_push === true;
    }
    // CALLER-REDIRECT DETECT (flag-gated): same pattern — strict boolean,
    // never present when the flag is off.
    if (CALLER_REDIRECT_DETECT) {
      out.callerRedirected = parsed.caller_redirected === true;
    }
    // CALLER-CRUDE DETECT (flag-gated): strict enum, defaults "none" for
    // anything not exactly "impersonal" or "personal" — fail safe toward
    // "nothing crude happened" rather than mis-tagging a normal turn.
    if (CALLER_CRUDE_DETECT) {
      const crude = typeof parsed.caller_crude === "string" ? parsed.caller_crude.toLowerCase().trim() : "none";
      out.callerCrude = (crude === "impersonal" || crude === "personal") ? crude : "none";
    }
    // PRICING-RAISED DETECT (flag-gated): strict boolean here — the ONE-WAY
    // latch behavior (never writing false once true) happens in blendRead,
    // not here; this just carries this turn's raw read.
    if (PRICING_RAISED_DETECT) {
      out.pricingRaised = parsed.pricing_raised === true;
    }
    // TEXTURE-INVITED (flag-gated): strict boolean, momentary — no latch,
    // this turn's read only.
    if (TEXTURE_INVITES_DETECT) {
      out.textureInvited = parsed.texture_invited === true;
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

// Merge the async read into the keyword-derived gear state, respecting the
// engine's rules. Suspicion is ONE-WAY (never pull back from a higher keyword
// suspicion, never un-foregone). Pressure/engagement are reversible, so the
// async read can move them either direction. Phase is the async read's alone.
function blendRead(keywordState, read) {
  if (!read) return null; // nothing to persist beyond keyword state
  const out = {};
  if (read.phase) out.phase = read.phase;
  // STEP 1: carry the live-event flag into stored state, only when the reader
  // reported it (flag on). NOT one-way, NOT latched — a momentary per-turn
  // event, true only on the turn the demand happened. Rides the same setCall.
  if (typeof read.commitmentPush === "boolean") {
    out.commitmentPush = read.commitmentPush;
  }
  // CALLER-REDIRECT DETECT: same shape as commitment_push — a momentary
  // per-turn event, true only on the turn the redirect happened, NOT
  // one-way/latched. Rides the same setCall write.
  if (typeof read.callerRedirected === "boolean") {
    out.callerRedirected = read.callerRedirected;
  }
  // CALLER-CRUDE DETECT: same momentary shape, not one-way/latched — this
  // turn's classification only ("none" | "impersonal" | "personal"). The
  // RUNNING COUNTS live separately (crudeImpersonalCount/crudePersonalCount,
  // incremented in the main SNAPSHOT write when this value is consumed next
  // turn — see there); this field is just the raw per-turn read.
  if (typeof read.callerCrude === "string") {
    out.callerCrude = read.callerCrude;
  }
  // PRICING-RAISED: ONE-WAY LATCH, same pattern as businessLatched below —
  // only ever WRITE true, never explicitly write false. If this turn's read
  // is false (or absent), out.pricingRaised is simply left unset, which
  // means setCall's "only write when provided" convention leaves whatever
  // was already persisted untouched — a prior true stays true forever, a
  // wobble back to false on a later read can never un-latch it. This is
  // deliberately different from callerRedirected/callerCrude above: a
  // quoted price is a fact that stays known, not a momentary event.
  if (read.pricingRaised === true) {
    out.pricingRaised = true;
  }
  // TEXTURE-INVITED: momentary, same shape as callerRedirected/callerCrude
  // above — NOT latched. A serious turn now doesn't mean texture is barred
  // for the rest of the call; this is read fresh every turn.
  if (typeof read.textureInvited === "boolean") {
    out.textureInvited = read.textureInvited;
  }
  // ONE-WAY BUSINESS LATCH (phase-overlay split): the first turn the call is
  // read as non-"opening", latch businessLatched=true so completions serves the
  // BUSINESS overlay for the rest of the call — even if a later phase read
  // wobbles back to "opening". Monotonic: only ever set true here, never unset,
  // so the opener machinery can't return on turn 20. Rides the same setCall
  // that persists the blended state (no extra write). Fail-safe: if no phase was
  // read this turn, we don't latch (stays opener until a real non-opening read).
  if (out.phase && out.phase !== "opening") out.businessLatched = true;
  // suspicion-merging REMOVED (Aug 5, gears removal) — the axis is retired
  // entirely, no replacement (CORE's permanent anti-break framework carries
  // that job now instead of a dedicated per-turn directive). The reader is
  // no longer even asked for it (see readCall's prompt).
  // pressure + engagement: async read wins (reversible, nuance-driven). These
  // ARE stored under their own names.
  if (read.pressure) out.pressure = read.pressure;
  if (read.engagement) out.engagement = read.engagement;
  return out;
}

// Bit injection tuning (starting values — tune from real calls / DEC-2).
// In the flat-fit era (all bits universal, no archetype yet) scores cluster
// low, so the bar is modest and the gap keeps Andrew from spamming beats.
const INJECT_BAR = parseFloat(process.env.INJECT_BAR || "3.0");
const MIN_GAP = parseInt(process.env.MIN_GAP || "3", 10);

// OPENER_MAX_TURNS — hard ceiling on how long the OPENER overlay can stay
// loaded, independent of the phase reader. The reader is an LLM call and CAN
// fail persistently; without this a failed read pins phase at "opening" and the
// business rules never load for the entire call. Past this many caller turns we
// serve BUSINESS no matter what phase says. 0 disables the backstop.
const OPENER_MAX_TURNS = parseInt(process.env.OPENER_MAX_TURNS || "4", 10);

// REINJECT_WINDOW_MS — how long after a bit fires a same-turn re-injection is
// still considered a PREEMPTIVE REGENERATION rather than a new (silence) turn.
// Regenerations land in well under a second; the silence watchdog fires tens of
// seconds later. 12s is comfortably between the two.
const REINJECT_WINDOW_MS = parseInt(process.env.REINJECT_WINDOW_MS || "3000", 10);

// GAG_OPEN_RATE — Call Design's tuning knob for the text-open vs sound-open
// ratio on TURN ONE. 0.0 = always text-open (the HOST prompt's messy open);
// 1.0 = always sound-open (a turn-1 gag bit like BIT-330) whenever one is
// eligible. Default LOW — the messy text-open stays the baseline; a sound-open
// is the occasional variant. This is the ONE control that decides how often the
// gag lane grabs turn 1. Env-tunable, no deploy. Only consulted on turn 1.
const GAG_OPEN_RATE = parseFloat(process.env.GAG_OPEN_RATE || "0.25");
// PHASE: warm up before throwing any bit, then get mildly more willing to fire
// as the call goes (they're invested — swing a little more).
const WARMUP_TURNS = parseInt(process.env.WARMUP_TURNS || "2", 10);
function effectiveBar(turn) {
  if (turn <= WARMUP_TURNS) return Infinity; // no bits during warm-up
  return Math.max(INJECT_BAR - 0.1 * Math.max(0, turn - 6), INJECT_BAR - 1);
}

export default async function handler(req) {
  // Browser health check — hit the URL to confirm the deploy is live.
  if (req.method === "GET") {
    return json({ ok: true, service: "posture-engine", phase: 1 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Optional shared secret. If PROXY_SHARED_SECRET is set, the caller must
  // send it as `Authorization: Bearer <secret>`. Leave unset to skip auth
  // while first wiring things up.
  const secret = process.env.PROXY_SHARED_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${secret}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const { system: vapiSystem, messages } = splitMessages(body.messages || []);

  // BENCH: decide if a character barges in THIS turn. If so, the engine appends
  // their tagged line to the stream itself (the model won't emit the tag, so we
  // guarantee it). The line is generated in character from the live call, in
  // PARALLEL with the host reply, and only awaited when the stream closes — so
  // it costs ~no latency. Falls back to a canned line if generation fails.
  // callId is needed for both the controls read and the bench decision below.
  const callId = body.call?.id ?? body.metadata?.callId ?? body.call_id;
  const benchTurn = countUserTurns(messages);

  // slug: the LiveKit web-call path does NOT reliably surface call.metadata,
  // but it DOES surface call.assistantOverrides.variableValues (sv_slug). Read
  // both — the variableValues path is what actually survives on web calls, and
  // without slug the pre-call slug-keyed prefix fallback can't fire (host runs
  // flat fallback).
  const vv =
    body.call?.assistantOverrides?.variableValues ||
    body.assistantOverrides?.variableValues ||
    {};
  // (Retired Jul-25: the [[sv_slug:<slug>]] tag mechanism. meeting.js used to
  // embed a slug tag at the front of the nudge prompt for the VAPI bare-body
  // "2nd+ silence nudge with no metadata" case, and PE extracted it here as a
  // last-resort slug source then stripped it before the model/TTS saw it. On
  // LiveKit that bare-nudge path does not exist; confirmed that NEITHER the
  // current meeting.js NOR the email/Barbara layer emits the tag anymore (only a
  // defensive caption-side strip remains, which never creates one). So the
  // extract + message-strip are dead and removed. Slug still resolves from the
  // request body and variableValues below.)
  const slug =
    body.slug ??
    body.call?.metadata?.slug ??
    body.metadata?.slug ??
    (vv.sv_slug || null) ??
    null;
  let stored = null;
  let ammo = { ammunition: [], byHook: {} };
  let controls = { deathBlow: null, armed: [], sentBench: null, forced: null };
  // TRANSCRIPT: persist the full conversation-so-far on every turn, keyed by
  // callId (room name), slug alongside. Last write = the complete transcript when
  // the call ends — no end-of-call event needed, survives mid-call crashes.
  // Fire-and-forget via waitUntil; never blocks the voice, never throws.
  // (saveTranscript itself guards against a short/bare turn clobbering a longer
  // stored transcript — see the length guard in _store.js.)
  if (callId && isConfigured()) {
    // RX PROBE (added 2026-07-24): logs the SHAPE of the incoming request array
    // so the "is the agent sending conversation history?" question can be
    // settled from PE's own logs, with no agent-side instrumentation.
    //   msgs   = total non-system messages received
    //   user   = countUserTurns (this is what `turn` in the fit line derives from)
    //   asst   = assistant turns present (history flowing = this grows)
    //   last   = role of the final message
    // READ IT LIKE THIS: on a healthy multi-turn call these GROW every turn
    // (msgs 2,4,6…). If they stay pinned at 1-2 while the caller is actively
    // speaking, the agent is sending only the latest utterance and history is
    // genuinely broken. If they grow normally and only DIP on a turn where the
    // caller said nothing, that dip is a silence bare-turn behaving correctly.
    try {
      const nonSys = (messages || []).filter((m) => m && m.role !== "system");
      const asst = nonSys.filter((m) => m.role === "assistant").length;
      console.log(
        "RX msgs=" + nonSys.length +
        " user=" + countUserTurns(messages) +
        " asst=" + asst +
        " last=" + (nonSys.length ? nonSys[nonSys.length - 1].role : "none")
      );
    } catch { /* probe must never break a turn */ }
    waitUntil(saveTranscript(callId, slug, messages).catch(() => {}));
  }
  let earlyTargetId = null;
  try {
    const [s, a, ctl, directTargetId] = await Promise.all([
      getCall(callId).catch(() => null),
      readAmmunition(slug).catch(() => ({ ammunition: [], byHook: {} })),
      getControls(callId).catch(() => ({ deathBlow: null, armed: [], sentBench: null })),
      resolveTargetId(slug).catch(() => null),
    ]);
    stored = s;
    if (a) ammo = a;
    if (ctl) controls = ctl;
    // KEPT SEPARATE from `stored` deliberately — do NOT synthesize a fake
    // stored object around this. `!stored` means "first turn of this call"
    // in several places downstream (e.g. the call_started trace emit); if
    // getCall genuinely returned null, stored must STAY null, not become a
    // stub object that only has targetId set. This variable is the sole
    // carrier of the "clean path" target_id (booking_tokens by slug — see
    // resolveTargetId's own comment) until stored.targetId (if any) is
    // known, further down.
    earlyTargetId = directTargetId;
  } catch {
    stored = null;
  }

  // RACE FALLBACK: the pre-call hydrate writes the compiled prefix under a slug
  // key ("slug:<slug>") before the call_id row exists. If the call_id row is
  // missing or has no prefix yet (first turn beat the call_id write), pull the
  // slug-keyed prefix so the opener still runs the REAL compiled prompt instead
  // of the flat fallback. Best-effort; never throws.
  if (slug && (!stored || !stored.prefix)) {
    try {
      const bySlug = await getCallBySlug(slug);
      if (bySlug && bySlug.prefix) {
        // Keep any live per-call state we already have; just borrow the prefix
        // (and posture line) from the slug row.
        stored = stored
          ? { ...stored,
              prefix: bySlug.prefix,
              postureLine: stored.postureLine || bySlug.postureLine,
              // Carry targetId the same way. On LiveKit, hydrate only ever
              // writes the "slug:<slug>" row (the agent calls /api/hydrate
              // ?slug=... before any call_id exists), so the target lives ONLY
              // there. PE's own per-turn state write then creates the call_id
              // row WITHOUT it — so from the first state write on, getCall hits
              // that row, this merge runs, and target_id was silently dropped:
              // Mead Hall saw target=<uuid> for the first turn or two and
              // target=NULL for the rest of every call. Same shape as
              // archetype above, prefer live state, else the slug row.
              targetId: stored.targetId || bySlug.targetId,
              // PHASE OVERLAYS — same trap as targetId above, same fix.
              // hydrate writes them ONLY on the "slug:<slug>" row (it runs
              // before any call_id exists). PE's first per-turn state write
              // then CREATES the call_id row without them, so from turn 2 on
              // getCall hits that row, this merge runs, and the overlays were
              // silently dropped: the split loaded the OPENER overlay on turn 1
              // (stored was null -> we took bySlug wholesale) and NOTHING from
              // turn 2 onward. Symptom was exact: turn 1 = 944 input + 5640
              // cache_creation (~6584 = prefix + overlay), turns 2+ = 3507 with
              // no cache at all (~prefix alone, and a different block 0 so the
              // cache never hit). Prefer live state, else the slug row.
              openerOverlay: stored.openerOverlay || bySlug.openerOverlay,
              businessOverlay: stored.businessOverlay || bySlug.businessOverlay,
              archetype: stored.archetype || bySlug.archetype }
          : bySlug;
      }
    } catch { /* fall through to the flat fallback */ }
  }

  // CHANNEL 2 — THE FUEL (bit-spendable dossier facts, keyed by target_id).
  // Added 2026-08-04, closing the gap found reconciling against Scouting's
  // finalized read contract: readAmmunition(slug) above is CHANNEL 1 only
  // (the rack — ambient context, keyed by slug). It was the ONLY ammo read
  // in this file; Channel 2 (targets.fuel_hooks_status presence gate +
  // scout_facts values, keyed by target_id) never existed here, so every
  // bit whose fuel_hooks pointed at a genuine Channel-2-only hook could
  // never actually clear fuelFit() — confirmed from the real registry:
  // BIT-101 (pitch_claims), and originally BIT-509 through BIT-513 before
  // Bits re-keyed them off target_prior_contact instead (see below).
  //
  // PRIOR CONTACT rides the same round trip, same targetId dependency:
  // target_prior_contact is a DERIVED VIEW (Data, 2026-08-04) — has_prior_
  // contact for BIT-508, prior_call_count for the BIT-509-513 escalation
  // family. Separate function (readPriorContact), same merge pattern.
  //
  // MUST run AFTER targetId is known (from stored / the RACE FALLBACK
  // above) — target_id is never available any earlier in this file, so this
  // can't join the initial Promise.all with getCall/readAmmunition/
  // getControls. One extra round trip, off the critical path in spirit
  // (fails soft to {} exactly like readAmmunition), on it in practice since
  // it's awaited — acceptable for the correctness this closes.
  //
  // MERGE, NOT REPLACE: both readFuel() and readPriorContact() return
  // byHook in the SAME SHAPE as Channel 1's (hook_id -> {key: value}), so
  // every downstream consumer (fuel_hooks_status derivation, fuelFit,
  // factHint) needs ZERO changes — they just see a bigger, correctly-
  // sourced byHook map. All three sources' hook_id sets are disjoint, so a
  // plain spread merge is safe (no real collision to resolve either way).
  //
  // TARGET ID: prefer earlyTargetId (booking_tokens by slug, resolved
  // concurrently above — the "clean path", zero added latency since it rode
  // the same initial Promise.all) over stored.targetId (call_prefix/hydrate
  // propagation, a valid independent source, kept as fallback not replaced).
  const fuelTargetId = earlyTargetId || (stored && stored.targetId) || null;
  if (fuelTargetId) {
    try {
      const [fuel, priorContact] = await Promise.all([
        readFuel(fuelTargetId),
        readPriorContact(fuelTargetId),
      ]);
      const fuelHooks = (fuel && fuel.byHook) || {};
      const priorHooks = (priorContact && priorContact.byHook) || {};
      if (Object.keys(fuelHooks).length || Object.keys(priorHooks).length) {
        ammo = { ...ammo, byHook: { ...ammo.byHook, ...fuelHooks, ...priorHooks } };
      }
    } catch { /* fuel/prior-contact reads must never break a turn — ammo stays rack-only */ }
  }

  // ===== BENCH v2: STAGED ARRIVAL MACHINE ================================
  // Shared by handler (the live call) AND runHostTurn (sim) so both paths weave
  // the bench in identically. See runBenchArrival() below.
  const benchResult = await runBenchArrival({ stored, controls, messages, callId, benchTurn, waitUntil });
  const benchAppend = benchResult.benchAppend;
  const benchPhantomInvoke = benchResult.benchPhantomInvoke;

  // ===== TELEGRAPHED HANDOFF (two-beat) =================================
  // Beat 1 (stage "announce"): host warns the caller a distinct-voice bench
  //   character is joining, then we advance the state to "fire".
  // Beat 2 (stage "fire"): the actual distinct-voice handoff fires, and
  //   we clear the pending state.
  // Requested via POST /api/handoff?action=request (AI-volition or director).
  let telegraphAnnounce = null;
  const pend = stored && stored.pendingHandoff ? stored.pendingHandoff : null;
  if (pend && pend.bench_id) {
    if (pend.stage === "announce") {
      telegraphAnnounce = telegraphDirective(pend.bench_id); // host warns this turn
      if (callId && isConfigured()) {
        waitUntil(setCall(callId, { pendingHandoff: { bench_id: pend.bench_id, stage: "fire" } }).catch(() => {}));
      }
      if (callId) makeTrace(callId, benchTurn, waitUntil, stored?.targetId).emit("handoff_telegraph", { character_id: pend.bench_id, turn_index: benchTurn }, "bench");
    } else if (pend.stage === "fire") {
      // Fire the real handoff, then clear the pending state.
      if (callId) {
        waitUntil(
          fireHandoff(callId, pend.bench_id)
            .then((r) => makeTrace(callId, benchTurn, waitUntil, stored?.targetId).emit("handoff_fired", { character_id: pend.bench_id, ok: !!r.ok, turn_index: benchTurn }, "bench"))
            .catch(() => {})
        );
        if (isConfigured()) waitUntil(setCall(callId, { pendingHandoff: null }).catch(() => {}));
      }
    }
  }

  // Whatever system prompt the caller itself sent, as a last-resort fallback
  // when no compiled prefix is stored yet (Stage 1/2 — keeps Andrew sounding
  // exactly as he is). The doubt-gears layer on top of whichever base is in
  // play.
  let baseSystem = stored && stored.prefix ? stored.prefix : vapiSystem;
  // PHASE-OVERLAY SPLIT (Option B): append the phase-selected overlay to the
  // END of the cached host block. stored.openerOverlay / stored.businessOverlay
  // are the two swappable blocks written by hydrate. Selection:
  //   - business once the call has left "opening" (businessLatched sticky, or
  //     the current phase read is non-opening) — one-way, never flips back.
  //   - opener otherwise (the default while phase is "opening").
  // The breakpoint sits on block 0 (below), so putting the overlay here places
  // it just before the breakpoint — business rules land at the end of the
  // cached host material, highest adherence. FALLBACK: if the overlays aren't
  // stored (a prefix hydrated before this shipped, mid-deploy), skip the append
  // entirely — baseSystem stays the whole-prompt prefix = current behavior, no
  // crash. This is what makes the deploy transition safe for in-flight calls.
  if (stored && stored.prefix && (stored.openerOverlay || stored.businessOverlay)) {
    const phase = stored.phase || "opening";
    // BACKSTOP (added 2026-07-23 after the first live test): the phase reader
    // can FAIL persistently ("callread FAILED — phase/gears unchanged"), which
    // leaves phase pinned at its "opening" default forever. Pre-split that was
    // survivable (the whole prompt was loaded anyway); post-split it means the
    // BUSINESS overlay NEVER loads and the host runs opener rules for the whole
    // call — which is exactly the repetitive "can you hear me okay / clear line
    // for once" failure, since those are the opener's own register examples.
    // So: force business past OPENER_MAX_TURNS regardless of what phase says.
    // A stuck reader can no longer strand the host in opener mode.
    const turnNow = countUserTurns(messages);
    const useBusiness =
      !!stored.businessLatched ||
      (phase && phase !== "opening") ||
      (OPENER_MAX_TURNS > 0 && turnNow > OPENER_MAX_TURNS);
    const overlay = useBusiness ? stored.businessOverlay : stored.openerOverlay;
    if (overlay) baseSystem = baseSystem + "\n\n" + overlay;
  }
  // Telegraph beat: fold the host's "someone's joining" warning into its prompt.
  if (telegraphAnnounce) baseSystem = (baseSystem || "") + "\n\n" + telegraphAnnounce;
  // Phantom send-in: fold the invoke/dangle directive into the host's own prompt
  // (a phantom is performed BY the host, not a separate bench call).
  if (benchPhantomInvoke) baseSystem = (baseSystem || "") + "\n\n" + benchPhantomInvoke;
  // Populate BIT_DIRECTIVES before building blocks: buildSystemBlocks is sync
  // and reads the module-level map when a bit fires, so the load must finish
  // first or a fire falls back to the name-only loadout pointer (the sanding
  // bug). Cached after the first call — later turns don't re-import.
  if (baseSystem) await loadBitDirectives();
  const built = baseSystem
    ? buildSystemBlocks(baseSystem, stored, messages, callId, body, ammo, controls, waitUntil)
    : null;
  const systemBlocks = built ? built.blocks : null;
  const deathBlowFiring = built ? built.deathBlowFiring : false;
  // STALL FLAG for the agent (Spot 1: top-level pe_stall on the first SSE chunk).
  // True when the bit that fired THIS turn is a stall-lane bit (BIT-233 et al.),
  // i.e. this host turn is a stall beat and the pause after it is intended. The
  // agent reads pe_stall to hold its re-engage nudge one cycle so a real pause
  // lands. Lane-keyed (state), never the host's text.
  const turnIsStall = !!(built && built.firedBitId && laneOf(built.firedBitId) === "stall");

  // SILENCE BARE-TURN → the Anthropic API treats a messages array whose LAST
  // entry is an assistant message as a PREFILL: it tries to CONTINUE that line
  // rather than start a new turn. The host's prior line is already complete
  // (ends in punctuation), so the model emits end-of-turn immediately and
  // returns EMPTY (OUT len=0). That is the "no reaction to silence" failure —
  // and it is why the system-prompt directive alone could not fix it: the
  // directive says "speak", but the message STRUCTURE says "continue this
  // finished line", and structure wins.
  // FIX: on a bare silence turn (caller has spoken before, last message is the
  // host's own line), append a synthetic USER turn so the array ends in "user"
  // and the model generates a FRESH assistant line. Keyed on last-message role,
  // NOT turn/gap counting. The synthetic turn goes ONLY to the model — the real
  // `messages` array (already saved to the transcript above) is untouched.
  // ESCALATION (Voice stamps metadata.silence_beat=N per nudge): when present,
  // the synthetic line escalates by beat so successive pokes don't all read as
  // the same "you there?" — beat 1 warm and easy, beat 2 a touch more concerned,
  // beat 3 the last gentle try. The beat lands at extra_body, so it surfaces on
  // the request body; read it defensively from the spots PE already reads
  // metadata, and FALL BACK to the plain line if it's absent (older agent, or a
  // bare turn PE inferred from role alone). Never a hard dependency.
  let messagesForModel = messages;
  {
    const lastRole =
      messages && messages.length
        ? messages[messages.length - 1] && messages[messages.length - 1].role
        : null;
    const callerHasSpoken =
      messages && messages.filter((m) => m && m.role === "user").length > 0;
    if (lastRole === "assistant" && callerHasSpoken) {
      const beatRaw =
        body?.metadata?.silence_beat ??
        body?.extra_body?.metadata?.silence_beat ??
        body?.call?.metadata?.silence_beat ??
        null;
      const beat = Number.isFinite(Number(beatRaw)) ? Number(beatRaw) : null;
      // STALL-LANE GUARD (the silence/stall collision, Jul 26). If the last bit
      // that fired is a STALL-lane bit (e.g. BIT-233 The Approver Hunt), the
      // quiet is the host's OWN intended pause mid-stall — he just said he's
      // "off looking" (trying an extension, checking down the hall), so a beat
      // of silence is him being occupied, NOT the caller leaving. Firing the
      // normal "you still there?" here undercuts his stall and collapses the
      // open loop he was meant to leave hanging. So on a stall beat we do NOT
      // emit the caller-check; we direct him to CONTINUE the stall (next small
      // step, or just hold), staying in character.
      // Keyed off the bit LANE (state: laneOf(stored.lastBitId)), NEVER the
      // host's text — per the isSilenceNudge scar, engine logic never sniffs the
      // prompt body for stall words. NOTE: the real fix is agent-side (the
      // watchdog shouldn't fire a re-engage into a stall pause at all); this is
      // PE's backstop for when a nudge does arrive — the response becomes a
      // stall continuation, not a caller check. Still ends the array in "user",
      // so the trailing-assistant PREFILL bug can't return empty.
      const lastBitStall = !!(
        stored && stored.lastBitId && laneOf(stored.lastBitId) === "stall"
      );
      // RESOLUTION CHECK: has this stall been running long enough that it
      // should wrap up instead of continuing to hold the loop open? See
      // stallShouldResolve() above. Checked ONLY when lastBitStall is true —
      // a non-stall silence beat doesn't need this at all.
      const resolveStall = lastBitStall && stallShouldResolve(stored);
      // The bracketed line is a STAGE DIRECTION to the model, not spoken text —
      // it shapes the fresh line the model writes. Escalation is in the
      // direction's urgency, not in dictating words (the host stays in voice).
      let synthetic = "[The caller has gone quiet on the line.]";
      if (resolveStall) {
        // STALL RESOLUTION (STALL_RESOLVE flag): this stall has run long
        // enough — land it instead of extending it further. Full
        // conversation history is intact, so the host already has everything
        // it needs to pick the real conversation back up; this only tells it
        // to do so. Resolve in-character (the person came back / a step
        // completed / give up gracefully) and move the conversation forward
        // — do NOT start another rung of the same stall.
        synthetic =
          "[You've been in this stall long enough — it's time to LAND it, not extend it. Resolve it naturally in character (whoever you were waiting on gets back to you, or you decide to stop waiting and move on) in one line, then carry the conversation forward from there. Do NOT start another step of the same stall, and do NOT just go quiet.]";
      } else if (lastBitStall) {
        // Stall in progress — hold the loop open, never break to the caller.
        synthetic =
          "[You're in the middle of a stall — you just played a beat where you're momentarily occupied (looking something up, trying to reach someone, checking on a step). The quiet is YOU being busy, not the caller leaving. Do NOT ask if they're still there, do NOT check the line, do NOT break off to address them. Stay in the stall: play the next small step of it — one step, then stop — or just hold the beat. Keep the loop open.]";
      } else if (beat === 1) {
        synthetic =
          "[The caller has gone quiet. Check in once, warm and easy — assume the good reason.]";
      } else if (beat === 2) {
        synthetic =
          "[Still quiet after your check-in. Reach out once more, a touch more concerned but not pushy — don't repeat your last line.]";
      } else if (beat && beat >= 3) {
        // Call Design (ratified): beat 3 is a REGISTER SHIFT, not a third ping.
        // The host stops assuming a technical hiccup and becomes genuinely
        // concerned about the PERSON — the call itself is irrelevant now. Warmer
        // and more in character than escalating urgency.
        synthetic =
          "[Still nothing. Stop wondering about the connection — you're now genuinely concerned about them as a person, not the call. Reach out with real, warm concern for how they are; the pitch and the line no longer matter to you.]";
      }
      messagesForModel = messages.concat([{ role: "user", content: synthetic }]);
    }
  }

  const anthropicReq = {
    model: MODEL(),
    max_tokens: MAX_TOKENS(),
    stream: true,
    messages: messagesForModel,
    // Spike creativity on the Death Blow turn only — the comedy is in the
    // surprise. Every other turn stays at the model's default for consistency.
    ...(deathBlowFiring ? { temperature: 1 } : {}),
    ...(systemBlocks ? { system: systemBlocks } : {}),
  };

  // MODEL-DIAG (Aug 4): logs which model actually handled this turn. Added
  // after a live A/B (Haiku vs a bigger model in the same family) turned out
  // to be the real fix for "bits fire but leave no trace" — three prompt
  // fixes had failed before that was even known, because there was no way
  // to confirm which model a given log/call actually used without cross-
  // referencing MODEL()'s env-var default by hand. Now it's one line per
  // turn, no guessing.
  console.log("MODEL-DIAG model=" + anthropicReq.model);

  // FIRST-TOKEN WATCHDOG (see the constant's own comment above): the
  // controller lets anthropicToOpenAISSE abort this specific request if no
  // text starts arriving in time. Created here (not inside the SSE
  // transform) because it must wrap the SAME fetch call it may need to cut
  // off — passing an already-fetched Response's body reader in isn't enough
  // to abort the underlying connection.
  const firstTokenController = new AbortController();
  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(anthropicReq),
    signal: firstTokenController.signal,
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    return new Response(`Upstream error ${upstream.status}: ${errText}`, {
      status: 502,
    });
  }

  const meta = {
    id: "chatcmpl-" + crypto.randomUUID(),
    created: Math.floor(Date.now() / 1000),
    model: MODEL(),
    callId,
    turn: countUserTurns(messages),
    hostName: hostNameFromBody(body), // per-call host name for the utterance trace
    // target the booking token was minted for — stamped on the utterance event
    // so Mead Hall can watch by target (the SSE transform has no `stored`).
    targetId: stored?.targetId ?? null,
    deathBlowFiring, // finishUp emits blow_fired + call_ended with the real line
    // pe_stall: legacy bare boolean (flag off) OR the stall TYPE string (flag
    // on). "hold" → agent latches/suppresses (silence is the joke); "hunt" →
    // agent lets the nudge through so PE's stall backstop advances the rungs.
    // Agent's existing `if (pe_stall)` truthiness still fires on the non-empty
    // strings, so an agent that hasn't shipped the branch yet still suppresses
    // (safe): the split only CHANGES behavior once the agent reads the value.
    stall: turnIsStall
      ? (STALL_TYPE_SPLIT ? stallTypeOf(built.firedBitId) : true)
      : false,
    stallBit: turnIsStall && built ? built.firedBitId : null, // -> pe_stall_bit (agent logging)
  };

  return new Response(anthropicToOpenAISSE(upstream.body, meta, benchAppend, firstTokenController), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

// --- message mapping -------------------------------------------------------
// OpenAI messages -> Anthropic shape. Anthropic wants `system` as a separate
// top-level string, messages limited to user/assistant, starting with user,
// with no two consecutive same-role turns.
// --- gears / posture (Phase 3 FORCE-SET, three axes) ----------------------
// Build the system blocks for the call:
//   [0] the base prompt (the caller's own, or an assembled prefix) — cached
//   [1] the MUTABLE posture block — three gear lines (suspicion / pressure /
//       engagement), the only thing that changes turn to turn.
// The gear layer runs only when the store is configured (so we can track the
// gears per call). FORCE-SET runs over the latest caller line, moves any of
// the three dials for THIS turn, and persists the new state for NEXT turn off
// the hot path (waitUntil) so the voice never waits on the write. The row is
// created lazily on the first turn — no pre-snap call needed for gears.
// factHint: turn the scouted payload(s) for a firing fueled bit into a short,
// speakable fact string, so the host can quote the REAL detail. Skips keys that
// aren't meant to be said aloud (urls, ids, scores, provenance/basis).
const NON_SPEAKABLE = /(^url$|_url$|ref$|source$|^basis$|slug$|_id$|^id$|score$)/i;
function factHint(bit, byHook) {
  const facts = [];
  for (const h of bit.fuel_hooks || []) {
    const p = byHook && byHook[h];
    if (!p || typeof p !== "object") continue;
    const pairs = Object.entries(p)
      .filter(([k, v]) => v != null && v !== "" && !NON_SPEAKABLE.test(k))
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
      .join("; ");
    if (pairs) facts.push(pairs);
  }
  return facts.join(" | ");
}

// ===== BENCH v2: shared staged-arrival logic ============================
// Called by BOTH handler (the live call) and runHostTurn (sim) so both paths
// weave the bench in identically. Reads arrival state from `stored`, advances
// an in-flight arrival OR begins a new one (Director send-in, gated by
// turn-floor), invokes phantoms, persists arrival state, emits bench events.
// Returns the per-turn
// { benchAppend (promise->tagged line | null), benchPhantomInvoke (directive|null) }.
async function runBenchArrival({ stored, controls, messages, callId, benchTurn, waitUntil }) {
  let arrival = stored && stored.arrivalState ? stored.arrivalState : null;
  let benchLog = stored && Array.isArray(stored.benchLog) ? stored.benchLog : [];
  let benchAppend = null;
  let benchPhantomInvoke = null;
  let arrivalDirty = false;

  if (arrival && arrival.stage && arrival.stage !== "resolved") {
    arrival = advanceArrival(arrival);
    arrivalDirty = true;
    if (arrival.stage === "resolved") {
      arrival = null; // sequence complete; clear state, reopen the gate
    } else {
      benchAppend = generateBenchBeat(arrival, messages).catch(() => null);
      if (callId) {
        makeTrace(callId, benchTurn, waitUntil, stored?.targetId).emit(
          "bench_stage",
          { character_id: arrival.bench_id, stage: arrival.stage, turn_index: benchTurn },
          "bench"
        );
      }
    }
  } else if (controls.sentBench && controls.sentBench.bench_id) {
    const wantId = controls.sentBench.bench_id;
    if (isPhantom(wantId)) {
      benchPhantomInvoke = phantomInvokeDirective(wantId);
      if (callId) {
        makeTrace(callId, benchTurn, waitUntil, stored?.targetId).emit(
          "bench_joined",
          { character_id: wantId, name: wantId, source: "director", manifestation: "phantom", invoking: true, joined_at: new Date().toISOString() },
          "bench"
        );
      }
    } else {
      const count = benchLog.length;
      // CEILING 3: drop the 4th slot (dead by math on real call lengths).
      if (count >= 3) {
        if (callId) makeTrace(callId, benchTurn, waitUntil, stored?.targetId).emit(
          "bench_waiting", { character_id: wantId, reason: "ceiling", turn_index: benchTurn }, "bench"
        );
      } else {
        // ONE GATE: "one arrival in flight" is already enforced above (an active
        // non-resolved arrival short-circuits this branch). We do NOT stack a
        // turn-floor on top of it (two locks, one door). First arrival is free
        // (floor 0); subsequent arrivals need only a light spacer so they don't
        // land literally back-to-back the turn after one resolves.
        const SPACER = parseInt(process.env.BENCH_ARRIVE_SPACER || "2", 10);
        const lastTurn = count ? benchLog[benchLog.length - 1].arrived_turn : -999;
        const floor = count === 0 ? 0 : SPACER; // 1st:0, then a light spacer
        const gateOpen = benchTurn - lastTurn >= floor;
        if (gateOpen) {
          arrival = beginArrival(wantId, benchTurn);
          if (arrival) {
            arrivalDirty = true;
            benchLog = benchLog.concat([{ bench_id: arrival.bench_id, arrived_turn: benchTurn }]);
            benchAppend = generateBenchBeat(arrival, messages).catch(() => null);
            if (callId) {
              makeTrace(callId, benchTurn, waitUntil, stored?.targetId).emit(
                "bench_joined",
                { character_id: arrival.bench_id, name: arrival.bench_id, source: "director", manifestation: arrival.type, stage: "entrance", joined_at: new Date().toISOString() },
                "bench"
              );
            }
          }
        } else if (callId) {
          makeTrace(callId, benchTurn, waitUntil, stored?.targetId).emit(
            "bench_waiting",
            { character_id: wantId, reason: "spacer", need_turn: lastTurn + floor, turn_index: benchTurn },
            "bench"
          );
        }
      }
    }
  } else {
    // AUTO-TRIGGER: the conversation itself may surface a bench moment (no
    // Director). Ships dark (BENCH_AUTO=1). Feeds the SAME gate/pipeline, so
    // it respects one-in-flight / ceiling / spacer. Phantom actions fold into
    // the host prompt (invoke, no arrival); arrive actions begin a staged
    // arrival like a Director send-in would.
    // GEARSTATE (Aug 5, gears removal) — .gear/.slip dropped, both gone
    // upstream. .slip's only consumer in _bench_auto.js (wrap_or_sour)
    // compared it against the STRING "slipping", but slip was always a
    // NUMBER (the old accumulator count) — that check was already
    // dead/always-false before this change, so dropping it here is a true
    // no-op, not a behavior change. .pressure/.engagement stay, still valid
    // (reader-sourced).
    const gearState = stored
      ? { pressure: stored.pressure, engagement: stored.engagement }
      : null;
    const auto = autoBenchAction({ gearState, benchLog, messages, callId, benchTurn });
    if (auto && auto.type === "phantom") {
      benchPhantomInvoke = phantomInvokeDirective(auto.who);
      if (callId) makeTrace(callId, benchTurn, waitUntil, stored?.targetId).emit(
        "bench_joined",
        { character_id: auto.who, name: auto.who, source: "auto", manifestation: "phantom", invoking: true, why: auto.why, joined_at: new Date().toISOString() },
        "bench"
      );
    } else if (auto && auto.type === "arrive" && benchLog.length < 3) {
      arrival = beginArrival(auto.who, benchTurn);
      if (arrival) {
        arrivalDirty = true;
        benchLog = benchLog.concat([{ bench_id: arrival.bench_id, arrived_turn: benchTurn }]);
        benchAppend = generateBenchBeat(arrival, messages).catch(() => null);
        if (callId) makeTrace(callId, benchTurn, waitUntil, stored?.targetId).emit(
          "bench_joined",
          { character_id: arrival.bench_id, name: arrival.bench_id, source: "auto", manifestation: arrival.type, stage: "entrance", why: auto.why, joined_at: new Date().toISOString() },
          "bench"
        );
      }
    } else {
      // Legacy env-scheduled auto arrival (BENCH_ARRIVE_TURN), default off.
      const autoId = autoArrivalId(benchTurn);
      if (autoId) {
        arrival = beginArrival(autoId, benchTurn);
        if (arrival) {
          arrivalDirty = true;
          benchLog = benchLog.concat([{ bench_id: arrival.bench_id, arrived_turn: benchTurn }]);
          benchAppend = generateBenchBeat(arrival, messages).catch(() => null);
        }
      }
    }
  }
  if (arrivalDirty) console.log("bench arrival=" + (arrival ? arrival.bench_id + ":" + arrival.stage : "resolved") + " turn=" + benchTurn);
  if (arrivalDirty && callId && isConfigured()) {
    waitUntil(setCall(callId, { arrivalState: arrival, benchLog }).catch(() => {}));
  }
  return { benchAppend, benchPhantomInvoke };
}

function buildSystemBlocks(baseSystem, stored, messages, callId, body, ammo, controls, waitUntil) {
  ammo = ammo || { ammunition: [], byHook: {} };
  let deathBlowFiring = false; // set true on the turn a Death Blow lands
  let firedBitId = null; // fired bit id, set inside the scoring block (where top/fire live); returned for the pe_stall flag
  const blocks = [
    { type: "text", text: baseSystem, cache_control: { type: "ephemeral" } },
  ];
  // TEMP (env-gated, CONRAD_RELAY=1): host-ventriloquism probe. If the caller
  // asks for Conrad / whether anyone else is on, the HOST brings Conrad in
  // within its own turn (no separate voice/call) — a beat in Conrad's blunt
  // register, then back to the host. Bounded: a beat, not a sustained two-hander.
  if (process.env.CONRAD_RELAY === "1") {
    blocks.push({
      type: "text",
      text:
        "BENCH RELAY (Conrad): If the caller explicitly asks to speak with " +
        "Conrad, asks if anyone else is on the call, or asks for your boss/" +
        "manager, you may bring Conrad in WITHIN your own turn. Briefly relay " +
        "him in his voice — Conrad is Andrew's boss: blunt, impatient, certain " +
        "this is wasting time, demands a real number. Convey the handoff in " +
        "SPOKEN WORDS ONLY — e.g. \"hang on, let me grab him... Conrad here: ...\" " +
        "then \"okay, sorry about that — he's direct.\" Do NOT write stage " +
        "directions, narration, or asterisks (no *pause*, no *back to my " +
        "voice*, no (clears throat)) — this is read aloud by a voice, so " +
        "anything you write gets spoken. Mark his words simply by name " +
        "(\"Conrad: ...\"). Keep it to a beat or two — do NOT sustain a long " +
        "back-and-forth as both people. If the caller does NOT ask, do not " +
        "bring Conrad in.",
    });
  }
  if (isConfigured() && callId) {
    // STATE (Aug 5, gears removed): pressure/engagement are reader-sourced
    // only now (they already were in practice — blendRead's own comment says
    // "async read wins" — this just removes the keyword layer that used to
    // ALSO write them synchronously this turn). Suspicion, slip, and
    // accuseFloor are gone entirely — no replacement, per the decision to
    // lean on CORE's permanent anti-break framework instead of a dedicated
    // per-turn directive. Defaults match _gears.js's old AXES defaults
    // (pressure: calm, engagement: hooked) so a fresh call starts the same
    // place it always did.
    const state = {
      pressure: (stored && stored.pressure) || "calm",
      engagement: (stored && stored.engagement) || "hooked",
    };
    const accusation = detectAccusation(lastUserText(messages));
    const turn = countUserTurns(messages);

    // --- MEAD HALL TRACE (dark unless TRACE_ENABLED=1) ---------------------
    const trace = makeTrace(callId, turn, waitUntil, stored?.targetId);
    // Death Blow (Trigger A): rungs are gone. Fire on a PENDING control alone;
    // PE generates the absurd closing line in persona at fire time (below).
    const dbCtl = controls && controls.deathBlow;
    const deathBlow = dbCtl && dbCtl.status === "pending" ? dbCtl : null;
    if (!stored) {
      trace.emit(
        "call_started",
        {
          host_name: hostNameFromBody(body),
          character_id: "host",
          universe: null,
          archetype: archetypeFromBody(body) || "universal",
          slot_time: null,
          started_at: new Date().toISOString(),
          // every bit, with the two fields Mead Hall's arm gray-out needs:
          // fuel_hooks (gray if a required hook isn't in the rack) and status
          // (gray if parked). Parked bits are INCLUDED now so the UI can show
          // them grayed rather than silently absent.
          loadout: BITS.map((b) => ({
            bit_id: b.id,
            name: b.name,
            bit_type: b.bit_type || b.type || null,
            fuel_hooks: b.fuel_hooks || [],
            status: b.status || "active",
          })),
          ammunition: ammo.ammunition || [], // scout_hooks rack (empty = safe default)
          bench_available: Object.keys(BENCH).map((k) => ({
            character_id: BENCH[k].tag, name: BENCH[k].tag, role: BENCH[k].note,
          })),
        },
        "engine"
      );
    }
    // Spammer name from Scouting's email dissection (sender_identity hook,
    // Channel 2 — facts.name, added to the fuel read 2026-08-04), already
    // fetched at call start alongside title/company. Best-effort: real name
    // when dissection found one, null otherwise (Mead Hall renders "Caller"
    // on null — never a placeholder name).
    const spammerName =
      (ammo && ammo.byHook && ammo.byHook.sender_identity &&
        ammo.byHook.sender_identity.name) || null;
    // CONFIDENCE (2026-08-06, Scouting's ranked resolution): 0.7 for body/
    // signature or From-display-name sources, 0.55 for an email-local-part
    // guess. null/undefined (a call predating this feature) is treated as
    // trustworthy — same as the pre-ranking behavior, no regression.
    const spammerNameConfidence =
      (ammo && ammo.byHook && ammo.byHook.sender_identity &&
        ammo.byHook.sender_identity.confidence) ?? 1;
    trace.emit(
      "utterance",
      { speaker_role: "spammer", speaker_name: spammerName, character_id: null, text: lastUserText(messages), turn_index: turn },
      "spammer"
    );
    if (accusation) trace.emit("spammer_reaction", { reaction_type: "suspicious", turn_index: turn }, "spammer");

    // --- FIT: rank the bits for THIS moment (pure in-memory math) ----------
    // SIMPLIFIED (Aug 5) — fit is now a pure archetype-eligibility gate, not
    // a scored discriminator (accusation/tone bonuses were confirmed dead —
    // zero bits in the registry ever used those fields — and gear_bias was
    // separately confirmed dead too; see _bits_scorer.js's preamble for the
    // full account). Ranking among eligible bits comes from recency,
    // sequencing, phase bias, fuel boost, and arm boost instead.
    const recency =
      stored && stored.lastBitId && stored.lastBitTurn != null
        ? { [stored.lastBitId]: Math.max(0, turn - stored.lastBitTurn) }
        : {};
    // sticky if already hydrated; else from this request's metadata; else flat.
    const archetype =
      (stored && stored.archetype) || archetypeFromBody(body) || "universal";
    const archetypeNew =
      archetype !== "universal" && (!stored || stored.archetype !== archetype);

    // fuel: hooks Scouting populated for this call -> "populated" status so
    // fueled bits become available; byHook carries the fact a firing bit pulls.
    const fuel_hooks_status = {};
    for (const h of Object.keys(ammo.byHook || {})) fuel_hooks_status[h] = "populated";

    // ARM (learning phase): the Director's setlist, read from call_controls
    // concurrently with getCall. Stamp armed_turn on first sight (escalation
    // clock) by patching the control row; build the bit boost map (bit_id ->
    // turns waited) the scorer uses to raise armed bits.
    const armedList = controls && Array.isArray(controls.armed) ? controls.armed.map((a) => ({ ...a })) : [];
    const armedBits = {};
    for (const a of armedList) {
      if (a.armed_turn == null) {
        a.armed_turn = turn;
        waitUntil(stampArm(a.id, { bit_id: a.bit_id, hook_id: a.hook_id, armed_turn: turn }).catch(() => {}));
      }
      if (a.bit_id) armedBits[a.bit_id] = Math.max(0, turn - a.armed_turn);
    }

    // EXTENDED_STALL detection (stall-breaker family). A STREAK of content-less
    // social exchanges, NOT a clock. turns_since_pitch_or_ask increments each
    // turn and RESETS whenever the spammer pitches or asks for something. When
    // that streak reaches STALL_N, extended_stall fires, which lifts the
    // stall-breaker bits (via a multiplier in the scorer).
    //
    // SIMPLIFIED (Aug 5, gears removal): this used to ALSO require
    // lowEngagement (state.engagement === "bored"/"slipping") on top of the
    // streak. Found while tracing it: "slipping" isn't a valid engagement
    // state at all (engagement is bored/hooked/stunned; slipping is a
    // SUSPICION state) — that half of the check was dead code, always false,
    // this whole time. So in practice this only ever meant "engagement ===
    // bored" — narrower than intended, and redundant besides: stallCount
    // already captures the real signal directly from the text ("nothing
    // business-like for N turns"), more reliably than a fuzzy gear axis
    // riding on a mechanism now being removed. Dropped entirely rather than
    // replaced — stallCount alone is the condition now. Real behavior
    // change: fires slightly MORE readily (single-gated, not double-gated),
    // which is the right direction for "rescue a quiet call," not a risk.
    const STALL_N = parseInt(process.env.STALL_N || "3", 10);
    const spammerText = lastUserText(messages).toLowerCase();
    // Pitch/ask signal = the spammer is actually doing business (any of these
    // resets the stall). Kept broad; the point is "did anything non-social
    // happen this turn."
    const pitchOrAsk = accusation != null ||
      /\b(offer|deal|product|service|price|cost|package|plan|sign|buy|purchase|subscribe|upgrade|discount|promotion|listing|account|verify|payment|invoice|contract|proposal|demo|quote|save|free|limited|approve|decision|company|business|website|seo|insurance|warranty|policy|investment|opportunity|guarantee)\b/.test(spammerText) ||
      /\?/.test(spammerText); // a question is an "ask"
    const priorStall = stored ? (stored.stallCount || 0) : 0;
    const stallCount = pitchOrAsk ? 0 : priorStall + 1;
    const extendedStall = stallCount >= STALL_N;

    // CALL PHASE — judged by the ASYNC phase reader (readPhase), NOT keywords.
    // The reader ran in waitUntil on the PREVIOUS turn and wrote stored.phase,
    // so THIS turn just reads it (zero latency). We then fire the reader again
    // below (also in waitUntil) to update it for the NEXT turn. On turn 1 there's
    // no prior judgment yet, so it defaults to "opening" until the reader lands.
    // Phase is REVERSIBLE and multi-state (opening/pitching/probing/drifting) —
    // the model re-judges from the real conversation each turn, reading intent
    // rather than spotting single words.
    const phase = (stored && stored.phase) || "opening";
    // Fire the async CALL READER AFTER this turn (waitUntil = post-response, off
    // the critical path, zero added latency). It judges phase + pressure +
    // engagement by MEANING (suspicion is gone — see the state comment above),
    // and writes the result for the NEXT turn.
    if (callId && isConfigured()) {
      const priorRead = {
        phase,
        pressure: state.pressure,
        engagement: state.engagement,
      };
      // BLOW-LANDED baseline (Aug 5, relocated from the old gears-driven
      // spot): captured HERE, before the read, so once the new value comes
      // back below we can tell whether THIS read raised engagement relative
      // to what the turn started with — the only place a genuinely NEW
      // engagement value appears, now that it's reader-sourced only.
      const engagementBefore = state.engagement;
      const firedLastTurn =
        stored && stored.lastBitTurn != null && stored.lastBitTurn === turn - 1;
      waitUntil(
        readCall(messages, priorRead)
          .then((read) => {
            // A SILENT reader is the one failure that matters: readCall returns
            // null on upstream !ok / no JSON / parse failure, and getCall's
            // fallback is `?? "opening"` — so a reader that never succeeds
            // leaves phase="opening" all call, which is exactly the state the
            // opening-bit gate keys on. This used to vanish into .catch(()=>{})
            // with no log, making a dead reader indistinguishable from a
            // genuinely long opening. Log it instead.
            if (!read) {
              console.log(
                "callread FAILED — no read this turn; phase/gears unchanged " +
                  "(persistent failure leaves phase stuck at its default)"
              );
              return;
            }
            const merged = blendRead(state, read);
            const chain = [];
            if (merged && Object.keys(merged).length) {
              chain.push(
                setCall(callId, merged).then(() => {
                  console.log(
                    "callread phase=" + (merged.phase || phase) +
                      " press=" + (merged.pressure || state.pressure) +
                      " eng=" + (merged.engagement || state.engagement) +
                      // STEP 1: log the observed event flag so precision can be
                      // watched BEFORE anything fires off it.
                      (EVENT_DETECT ? " cpush=" + (merged.commitmentPush ? "Y" : "n") : "")
                  );
                })
              );
            }
            // BLOW-LANDED: did the bit thrown last turn make them MORE engaged
            // THIS turn — it connected. Compares the engagement value THIS
            // read produced against what the turn started with (captured as
            // engagementBefore, above) — entirely reader-sourced now, no
            // gears dependency.
            const newEngagement = (merged && merged.engagement) || read.engagement;
            const ENG_RANK = { bored: 0, hooked: 1, stunned: 2 };
            const rose = newEngagement && ENG_RANK[newEngagement] > ENG_RANK[engagementBefore];
            if (firedLastTurn && rose) {
              chain.push(
                (async () => {
                  const prior = await blowLandedTotal(callId);
                  trace.emit(
                    "blow_landed",
                    { turn_index: turn, total_blows: prior == null ? null : prior + 1 },
                    "engine"
                  );
                })()
              );
            }
            return Promise.all(chain);
          })
          .catch((e) => {
            console.log("callread THREW " + (e && e.message ? e.message : e));
          })
      );
    }

    // ABSURDITY CEILING (Aug 6, Bits — hard gate, see _bits_scorer.js's own
    // comment for the enforcement side). This is the COMBINING logic: three
    // possible sources, most restrictive wins. ONLY the Director-override
    // and a single global default are actually built here — Bits' other two
    // example use cases (a per-archetype cap for first-call archetypes, a
    // turn-based ramp that loosens after some threshold) both need REAL
    // values (which archetypes, which turn) that PE doesn't have and
    // shouldn't guess at. Building the mechanism now so it's ready the
    // moment those values land, rather than blocking on them.
    const ABSURDITY_CEILING_DEFAULT = process.env.ABSURDITY_CEILING_DEFAULT
      ? parseInt(process.env.ABSURDITY_CEILING_DEFAULT, 10)
      : null; // null = unrestricted by default; nothing changes until set
    const absurdityCeiling =
      controls && controls.absurdityCeiling != null
        ? controls.absurdityCeiling // Director override always wins
        : ABSURDITY_CEILING_DEFAULT;

    const scorerState = {
      archetype,
      accusation,
      armed: armedBits,
      recency,
      fuel_hooks_status,
      byHook: ammo.byHook || {},
      // PRE-CALL FACT TRIGGERS (Aug 6): unlike pricing_raised/caller_
      // questioned_humanity, these need no detection at all — the fact is
      // already known from turn 1, sourced directly from the same
      // ammo.byHook data that already arms these bits' CONTENT. Presence in
      // byHook is all that's checked (matches the fuel_hooks_status
      // convention above — any present hook counts, regardless of its
      // internal shape).
      has_prior_contact: !!(ammo.byHook && ammo.byHook.has_prior_contact),
      browsed_tmi: !!(ammo.byHook && ammo.byHook.browsed_tmi),
      absurdityCeiling,
      // sequencing anchor — without this, chain + category spacing never fire.
      lastBitId: stored ? stored.lastBitId || null : null,
      // EXTENDED_STALL: true when the call has been content-less/social too long.
      // A STREAK (counter), not a snapshot and not a clock — see below.
      extended_stall: extendedStall,
      // CALL PHASE — "opening" (pre-pitch small talk) or "engaged" (business
      // started). Soft bias in the scorer; latched above.
      phase,
      // CALL TURN — the caller-turn index this fire would land on. Added for
      // the scorer's turn gates (e.g. opening-only bits — "How Are You",
      // Camera Off, Late Arrival — must drop out of the pool after the first
      // few turns; a phase boost alone can't do that because phase is a soft
      // bias, not an exclusion). The scorer previously received NO turn
      // number, so no turn gate was implementable there at all.
      turn,
      // UNIVERSAL FIRE HISTORY (Aug 6, generalized from texture-only
      // textureLastFire — see _bits_scorer.js's own comment for the full
      // shape and rationale). Read from stored state; defaults to {} for a
      // call that predates this feature or a fresh call.
      bitFireHistory: (stored && stored.bitFireHistory) || {},
      // PRICING RAISED — feeds the generic EMITTED_TRIGGERS gate in
      // _bits_scorer.js (see triggerPresent's "pricing_raised" case) so
      // BIT-210's trigger:"pricing_raised" declaration is actually
      // matchable. Reads the ONE-WAY LATCH persisted by blendRead — once
      // true, stays true for the rest of the call regardless of what THIS
      // turn's reader read was.
      pricing_raised: !!(stored && stored.pricingRaised),
      // CALLER QUESTIONED HUMANITY — feeds BIT-403's trigger declaration.
      // Momentary (this turn only, not latched) and SYNCHRONOUS — reuses
      // detectAccusation()'s existing "ai" classification (computed every
      // turn already, no new detection built) rather than a reader-based
      // signal, so a direct "are you a bot?" gets same-turn eligibility
      // instead of a one-turn lag.
      caller_questioned_humanity: accusation === "ai",
    };
    // LOADOUT then rank: selectBit narrows to the bits that fit this moment,
    // then ranks that focused set (not all 71). threshold:0 so we apply our own
    // INJECT_BAR below; we just want the ranked loadout + its size.
    //
    // TEST_PRIORITY_BITS (Aug 6, TEST HARNESS, throwaway): when set, this is
    // the ONLY thing that changes — selectBit() runs on a RESTRICTED pool
    // (just the listed bits) instead of the full registry. Every rule still
    // applies normally to whatever's left: archetype, pool/phase, cooldown,
    // max_fires_per_call, trigger, family exclusion, absurdity ceiling, the
    // deploy bar, MIN_GAP spacing — all of it, exactly as any real turn.
    // This is NOT a force — if nothing in the list is currently eligible,
    // nothing fires this turn, same as an empty pool on any normal turn.
    // (Earlier version of this harness bypassed everything and force-fired
    // regardless of eligibility — replaced same day once it was clear that
    // wasn't actually what was wanted: hearing whether reviewed bits fire
    // for REAL reasons, not guaranteed regardless of the rules.)
    const testPool = TEST_PRIORITY_BITS.length
      ? (Array.isArray(BITS) ? BITS : []).filter((b) => b && TEST_PRIORITY_BITS.includes(b.id))
      : BITS;
    if (TEST_PRIORITY_BITS.length) {
      console.log(
        "TEST_PRIORITY_BITS active — pool restricted to " + testPool.length + "/" +
        TEST_PRIORITY_BITS.length + " listed ids (missing/parked ones silently excluded, same as any bit); " +
        "all normal eligibility + firing rules still apply"
      );
    }
    const sel = selectBit(scorerState, { threshold: 0, pool: testPool });
    const ranked = sel.ranked;
    let top = ranked[0] || null;
    const poolSize = sel.pool;
    const gap = stored && stored.lastBitTurn != null ? turn - stored.lastBitTurn : 99;
    const bar = effectiveBar(turn);
    // fire: whether a bit clears the bar this turn.
    let fire = !!(top && top.score >= bar && gap >= MIN_GAP);

    // ── HUNT-WINDOW FLOOR (STEP 3 beat controller) ────────────────────────
    // If BIT-233 opened a commitment-push scenario in the last few turns, keep
    // it holding the floor so the approver-hunt plays as one sustained beat.
    // The window is derived from persisted state — the last fired bit was
    // CPUSH_BIT and it fired within HUNT_WINDOW_TURNS. Rather than merely
    // BLOCKING other bits (which would also strip the hunt directive at the
    // BIT-ACTIVE injection below, gated on `fire`, and silence the hunt), the
    // window RE-FIRES BIT-233 itself: it becomes `top` and `fire` every window
    // turn, so (a) no other auto-bit can be top = floor held, and (b) BIT-233's
    // directive is re-injected each turn = hunt sustained. Runs BEFORE the force
    // + cpush consumers: a fresh cpush this turn or a Director force runs after
    // and overrides (both re-point top themselves); a death-blow also wins
    // (checked at its own branch). Cap-only for v1 — no early-out on resolution.
    // STAMP-TIGHTEN (2026-08-02): the FIRST silence beat after the BIT-233
    // demand re-runs with the SAME message array (host's own line last, no new
    // caller turn), so countUserTurns is unchanged and (turn - lastBitTurn) == 0
    // on that beat. With the gate at >= 1 the sustain skipped it, BIT-233 didn't
    // re-fire, meta.stall came back false, and the agent ran its generic
    // "you still there?" poke — THEN advanced correctly once a real caller turn
    // bumped the count. Allow the window to open at 0 ONLY on a silence beat
    // (last message is the host's own assistant line). A normal turn keeps the
    // >= 1 floor. SAFE re: the eager-stamp tradeoff Voice flagged: the sustain
    // already keys on stored.lastBitId === CPUSH_BIT, so it only ever holds the
    // floor for a BIT-233 that ACTUALLY fired — a non-hunt silence has no
    // BIT-233 in the store and cannot be mis-stamped as a hunt.
    const sustainLastRole =
      messages && messages.length
        ? messages[messages.length - 1] && messages[messages.length - 1].role
        : null;
    const isSilenceBeat = sustainLastRole === "assistant";
    const huntFloor = isSilenceBeat ? 0 : 1; // silence beat may open the window at gap 0
    let inHuntWindow = false;
    // RESOLUTION CHECK (STALL_RESOLVE): if this hunt has already run long
    // enough per stallShouldResolve(), stop re-claiming the floor here — let
    // this turn fall through to normal scenario/texture/starvation scoring
    // instead of sustaining indefinitely. The actual "wrap it up" directive
    // is injected into mutable below (huntJustResolved), once, on the turn
    // the hunt stops being sustained.
    const huntWasSustaining =
      HUNT_WINDOW && stored && stored.lastBitId === CPUSH_BIT &&
      stored.lastBitTurn != null && (turn - stored.lastBitTurn) >= huntFloor &&
      (turn - stored.lastBitTurn) <= HUNT_WINDOW_TURNS;
    const huntJustResolved = huntWasSustaining && stallShouldResolve(stored);
    // RUNG COUNTER: incremented once per REAL CALLER TURN (the true first
    // fire stamps huntRungCount=1 + huntRungTurn=turn in the SNAPSHOT write
    // further down — see there).
    //
    // RACE FIX (found from a live call, Aug 4): LiveKit's preemptive
    // generation means MULTIPLE concurrent requests can share the same
    // nominal `turn` (regenerations of one caller utterance, or repeated
    // silence-beat probes). Each one independently hit this SUSTAIN branch
    // and independently incremented huntRungCount off its own stale read —
    // with no coordination between them, 2-3 siblings for ONE real turn
    // could push the count from 1 to 3, resolving the hunt after a single
    // real exchange instead of the intended several. Confirmed live: rung
    // hit 3 by turn 10, one turn after the turn-9 demand.
    //
    // FIX: track huntRungTurn (the turn the counter was last bumped at,
    // separate from lastBitTurn which stays pinned at the ORIGINAL demand
    // turn by design — see the SUSTAIN write below). Only bump the counter
    // when stored.huntRungTurn !== turn — i.e., this nominal turn hasn't
    // already been counted by an earlier sibling. A same-turn sibling still
    // SUSTAINS (holds the floor, re-injects the bit) — it just doesn't
    // double-count the rung.
    const priorRungCount = (stored && stored.huntRungCount) || 1;
    const priorRungTurn = stored ? stored.huntRungTurn : null;
    const rungAlreadyCountedThisTurn = priorRungTurn === turn;
    let sustainRungIncrement = false;
    if (huntWasSustaining && !huntJustResolved) {
      // Synthesize BIT-233's fire-able entry the same way the cpush consumer
      // does (it's phase-gated out of `ranked`, so ranked.find won't have it).
      // Only if it's still active in the registry — a parked/retired bit must
      // not be sustained.
      const reg = (Array.isArray(BITS) ? BITS : []).find(
        (b) => b && b.id === CPUSH_BIT && (b.status == null || b.status === "active")
      );
      if (reg) {
        const heldName = top ? top.name : null;
        top = {
          id: reg.id, name: reg.name || reg.id, score: 999, excluded: false,
          breakdown: { fit: null, gearBias: null, recency: null, why: ["hunt-window sustain (BIT-233 holds floor)"] },
        };
        fire = true;
        inHuntWindow = true;
        sustainRungIncrement = !rungAlreadyCountedThisTurn;
        const nextRung = sustainRungIncrement ? priorRungCount + 1 : priorRungCount;
        console.log(
          "hunt-window SUSTAIN turn=" + turn + " — BIT-233 holds floor (" +
          (turn - stored.lastBitTurn) + "/" + HUNT_WINDOW_TURNS + " turns, rung " +
          nextRung + "/" + STALL_EXHAUST_RUNGS +
          (rungAlreadyCountedThisTurn ? " [already counted this turn — sibling regen, not bumping]" : "") + ")" +
          (isSilenceBeat && (turn - stored.lastBitTurn) === 0 ? " [same-turn silence beat: hunt stamped before first poke]" : "") +
          (heldName && heldName !== reg.name ? ", over normal pick '" + heldName + "'" : "")
        );
      }
    } else if (huntJustResolved) {
      const reason = stallResolveReason(stored) || "unknown";
      console.log(
        "hunt-window RESOLVE turn=" + turn + " — BIT-233 rung " + priorRungCount +
        "/" + STALL_EXHAUST_RUNGS + ", elapsed " +
        Math.round((Date.now() - stored.lastBitAt) / 1000) + "s (threshold " +
        Math.round(STALL_RESOLVE_MS / 1000) + "s) — resolved on: " + reason +
        "; releasing the floor"
      );
    }


    // ── FORCE CONSUMER ────────────────────────────────────────────────────
    // The Director's "fire THIS bit now" override, from Mead Hall via
    // POST /api/control?action=force. The endpoint writes a pending
    // control_type:"force" row; getControls surfaces it as controls.forced.
    // This is the half that ACTS on it — without this the button writes a note
    // nobody reads.
    //
    // WHY IT SITS HERE: placed right after the normal fire decision and BEFORE
    // the gag-open and re-injection blocks — both of those are gated on
    // `!fire`, so a forced fire naturally suppresses them. The Director's
    // explicit pick outranks an auto-pick, a turn-1 gag, and a re-injection.
    //
    // ONE-SHOT: fireForce() PATCHes the row to status "fired", and getControls
    // only surfaces PENDING force rows — so it cannot fire twice. That also
    // covers the silence-bare-turn trap that bit the gag-open and re-injection
    // paths (a bare turn does not advance the turn counter, so anything keyed
    // on turn/gap sameness re-fires): force is keyed on the ROW's status, not
    // on turn or gap, so a bare turn re-entering here finds nothing pending.
    //
    // BYPASSES the deploy bar and MIN_GAP by design — that IS the feature; the
    // bit was stuck precisely because it never cleared the bar.
    //
    // UNFIRABLE CASE: the bit must still be a real candidate in THIS call's
    // ranked pool. If it's archetype-excluded, capped out, or phase-gated, we
    // do NOT fire and we do NOT consume the force — it stays pending so it can
    // land on a later turn when the pool shifts, and we log the reason so Mead
    // Hall can surface "couldn't fire yet" instead of the Director waiting
    // blind. (The endpoint already static-checks unknown/parked ids; this is
    // the per-call reason that can only be known at fire time.)
    let forcedFire = false;
    const forcedCtl = controls && controls.forced ? controls.forced : null;
    if (forcedCtl && forcedCtl.bit_id) {
      const forcedBit = ranked.find(
        (r) => r.id === forcedCtl.bit_id && !r.excluded && r.score > -Infinity
      );
      if (forcedBit) {
        top = forcedBit;
        fire = true;
        forcedFire = true;
        console.log(
          "force FIRING bit=" + forcedCtl.bit_id + " turn=" + turn +
          " (bypassing bar=" + bar + " gap=" + gap + ")"
        );
      } else {
        console.log(
          "force UNFIRABLE bit=" + forcedCtl.bit_id + " turn=" + turn +
          " — not an eligible candidate in this call's pool " +
          "(archetype/cap/phase gate); force stays pending"
        );
      }
    }

    // ── COMMITMENT-PUSH CONSUMER (STEP 2) ─────────────────────────────────
    // The live-event equivalent of the force consumer: when the detector read
    // a commitment_push for this turn, fire the stall bit (BIT-233) directly,
    // bypassing the gear score that never ranks it high enough to win. This is
    // the event->scenario path — the bit fires because a THING happened, not
    // because a mood scored. Same one-shot / eligibility discipline as force:
    // a Director force this turn wins over it (!forcedFire); the bit must be a
    // real candidate in THIS call's ranked pool or we fall back to the normal
    // pick; bypasses bar + MIN_GAP by design. Behind EVENT_FIRE — off = the
    // Step-1 detector runs but fires nothing.
    let cpushFire = false;
    // stored.commitmentPush = the async reader's LAST-turn value (lags one turn).
    // cardAskNow(...) = the SYNCHRONOUS current-turn card-ask trigger. OR-ing it
    // in makes the hunt fire the INSTANT the demand lands instead of a turn later
    // — closing BOTH the questionnaire-steps-on-the-hunt bug AND the stray
    // "you still there?" poke (both were downstream of the one-turn lag). The
    // reader path stays as a backstop: if the sync trigger's strict pattern
    // misses a phrasing, stored.commitmentPush still catches it next turn exactly
    // as before. Logged distinctly so we can watch which path fired.
    const cardAsk = cardAskNow(lastUserText(messages));
    const cpush = !!(stored && stored.commitmentPush) || cardAsk;
    if (cardAsk) {
      console.log(
        "card_ask TRIGGER (synchronous) turn=" + turn +
        " — firing hunt on the demand turn (stored.cpush=" +
        (!!(stored && stored.commitmentPush)) + ")"
      );
    }
    if (EVENT_FIRE && !forcedFire && cpush) {
      // FIRST try the ranked pool (bit is eligible this phase -> use its live
      // scored entry, keeps breakdown/why for the trace).
      let cpushBit = ranked.find(
        (r) => r.id === CPUSH_BIT && !r.excluded && r.score > -Infinity
      );
      // EVENT OVERRIDE OF PHASE GATE: a commitment_push is a live event, not a
      // mood — it must be answerable even when the phase loadout dropped the
      // stall bit from the ranked pool (BIT-233 is not phase_pref:probing, so on
      // a probing-phase demand it can be gated out and never reach `ranked`).
      // Force conceptually has the same need; here we make the event path robust
      // by falling back to the registry entry directly. We still refuse to fire
      // a bit that is genuinely parked/retired (status !== "active") — the gate
      // we bypass is PHASE eligibility, not the kill switch.
      if (!cpushBit) {
        const reg = (Array.isArray(BITS) ? BITS : []).find(
          (b) => b && b.id === CPUSH_BIT && (b.status == null || b.status === "active")
        );
        if (reg) {
          // Synthesize a minimal fire-able entry. score is a sentinel above the
          // bar so any downstream `top.score` read is sane; the fire itself
          // bypasses bar+gap so the value is not compared, only surfaced.
          cpushBit = {
            id: reg.id,
            name: reg.name || reg.id,
            // sentinel score: the fire bypasses bar+gap so this is never
            // compared, only surfaced in logs. Kept above DEPLOY_THRESHOLD so any
            // `top.score >= X` read downstream stays truthy for a fired bit.
            score: 999,
            excluded: false,
            // carry the keys the gear-log emit reads (fit/gearBias/recency/why)
            // so the synthesized entry serializes honestly rather than as a
            // phantom scored bit. null = "not scored, event-fired".
            breakdown: { fit: null, gearBias: null, recency: null, why: ["cpush event override (phase-gated)"] },
          };
          console.log(
            "cpush POOL-GATED bit=" + CPUSH_BIT + " turn=" + turn +
            " — not in ranked pool (phase gate); firing via registry override"
          );
        }
      }
      if (cpushBit) {
        // EVENT WINS THE TURN: overwrite whatever the normal path picked. On the
        // continuation turns a normal bit (e.g. Competing Vendor) can already be
        // firing through the bar; the event must outrank it, not merely set fire
        // true. top/fire are overwritten unconditionally here.
        top = cpushBit;
        fire = true;
        cpushFire = true;
        console.log(
          "cpush FIRING bit=" + CPUSH_BIT + " turn=" + turn +
          " (bypassing bar=" + bar + " gap=" + gap + ", over normal pick)"
        );
      } else {
        console.log(
          "cpush UNFIRABLE bit=" + CPUSH_BIT + " turn=" + turn +
          " — not in registry or parked/retired; falling back to normal pick"
        );
      }
    }

    // TURN-1 GAG-OPEN — the narrow first slice of the gag lane.
    // The messy text-open (HOST prompt) is the baseline for turn 1. But a
    // "sound-open" gag bit (BIT-330: cup/dog/door, lane:"gag" + phase_pref:
    // "opening" + turn-one-only) can OPEN the call instead — a puncture in the
    // first breath. It CANNOT fire through the normal path: effectiveBar(1) is
    // Infinity (warmup) so `fire` above is always false on turn 1. This is the
    // gag lane's whole point — a SEPARATE clock that bypasses warmup/MIN_GAP/
    // deploy-bar. Scope kept deliberately tiny here (turn 1 only, no suspend/
    // resume, no slow-burn thread to pause — nothing is running yet on turn 1):
    //   - only on turn === 1, and only if the normal path didn't already fire
    //   - find an eligible gag+opening bit in the ranked pool (it's IN the pool;
    //     the opening gate admits phase_pref "opening", the pool cap admits it
    //     if listed — it just can't clear the warmup BAR, which we bypass here)
    //   - roll GAG_OPEN_RATE (Call Design's text-vs-sound ratio knob)
    //   - on a hit, fire it, bypassing bar + MIN_GAP
    // A miss (or no eligible gag) leaves `fire` false -> the text-open runs.
    let gagOpen = false;
    // ONCE-PER-CALL GUARD (added 2026-07-23 after the live test): the agent
    // fires a BARE TURN on silence, resending the same minimal message array —
    // so countUserTurns still returns 1 and this block re-entered on EVERY
    // silence nudge, re-firing the gag with the same directive and emitting the
    // identical line three times ~25s apart (the "totally repetitive talk
    // track"). turn===1 is NOT sufficient on its own because turn is derived
    // from the caller-turn count, which a bare turn does not advance. Gate on
    // whether ANY bit has already fired this call: stored.lastBitId is set the
    // moment one does, so a second pass can never re-open. BIT-330's
    // cooldown:999 does not help here — the gag-open path deliberately bypasses
    // the scorer, so it bypasses cooldown too.
    const alreadyFiredThisCall = !!(stored && stored.lastBitId);
    if (!fire && turn === 1 && !alreadyFiredThisCall) {
      const gagBit = ranked.find(
        (r) =>
          !r.excluded &&
          r.score > -Infinity &&
          laneOf(r.id) === "gag" &&
          phaseOf(r.id) === "opening"
      );
      if (gagBit && Math.random() < GAG_OPEN_RATE) {
        top = gagBit;
        fire = true;
        gagOpen = true;
      }
    }

    // SAME-TURN RE-INJECTION — the fix for "bits never landed".
    // gap === 0 means a bit already fired on THIS turn. That is NOT a spacing
    // violation: LiveKit runs PREEMPTIVE GENERATION — it starts an LLM call on
    // a partial transcript, then regenerates the SAME user turn as more speech
    // arrives, and plays whichever generation wins. PE handed the bit to the
    // FIRST generation and MIN_GAP then blocked every regeneration of that same
    // moment — so the bit-carrying generation was always the one thrown away,
    // and the caller heard a bit-less rewrite. Proven on a live call: turn 9 ran
    // twice, input 1075 (fired, "The Window") vs input 526 (gap:0, no bit) —
    // same messages, 549 tokens of directive, and only the discarded one had it.
    // MIN_GAP exists to space bits across TURNS, not to punish a re-roll of the
    // current one. So: re-inject the same bit, and let whichever generation
    // survives perform it.
    let sameTurnReinject = false;
    // TIME-BOUND (added 2026-07-24): re-injection is for a PREEMPTIVE REGENERATION
    // — the same user turn re-rolled MILLISECONDS later as more speech arrives.
    // It is NOT for a silence bare-turn. The agent's silence watchdog fires a
    // bare session.generate_reply() ~20-30s later with the SAME message array,
    // so countUserTurns is unchanged, gap is still 0, and stored.lastBitId is
    // still set — which made this block re-hand the SAME bit and replay the
    // IDENTICAL line (the Jul-24 call: [COFFEE_CUP_BREAK] + the same mug speech
    // three times, 30s apart). The gag-open guard did NOT catch it because this
    // is a different path. Distinguish them by ELAPSED TIME: a regeneration is
    // near-instant, a silence nudge is tens of seconds. If we have no timestamp
    // (a row written before this shipped), allow — preserves prior behavior for
    // in-flight calls; new calls get stamped on the first fire.
    const sinceLastBitMs =
      stored && stored.lastBitAt ? Date.now() - stored.lastBitAt : null;
    const withinReinjectWindow =
      sinceLastBitMs === null || sinceLastBitMs <= REINJECT_WINDOW_MS;
    // BELT-AND-SUSPENDERS with the time window: a true same-turn regeneration
    // always ends with the CALLER's line (role "user") — the model is being
    // re-asked to answer the same user turn. A silence bare-turn ends with the
    // HOST's own prior line (role "assistant"). So if the last message is
    // assistant, this is NOT a regeneration and must never re-inject, regardless
    // of timing. This catches the case the 3s window can't (a silence poke that
    // happens to land within a few seconds — the Jul-25 call re-injected at 11s).
    const reinjectLastRole =
      messages && messages.length
        ? messages[messages.length - 1] && messages[messages.length - 1].role
        : null;
    const lastIsCallerLine = reinjectLastRole === "user";
    if (
      !fire && gap === 0 && lastIsCallerLine &&
      stored && stored.lastBitId && withinReinjectWindow
    ) {
      const same = ranked.find((r) => r.id === stored.lastBitId);
      if (same) {
        top = same;
        fire = true;
        sameTurnReinject = true; // suppresses the duplicate trace + state write
      }
    }

    // ── TEXTURE ROTATION (step d of the gears→triggers teardown) ──────────
    // Behind TEXTURE_ROTATION (default off in _bits_scorer.js). Runs ONLY when
    // nothing above has already claimed the turn (`!fire`) — a scenario bit
    // (force/cpush/hunt-window/gag-open/re-injection) ALWAYS wins the turn
    // over texture, per Bits' spec ("inject the scenario bit and SUPPRESS
    // texture for that turn — and the texture cooldown does NOT reset"). Since
    // selectTextureBit() is never even called when a scenario already fired,
    // its LRU state is simply untouched this turn — which IS "cooldown not
    // reset," with no extra bookkeeping needed.
    //
    // selectTextureBit() itself is a pure, deterministic pick (phase+cooldown
    // LRU — see _bits_scorer.js); it returns null when TEXTURE_ROTATION is off
    // or no texture bit is eligible this turn, in which case this block is a
    // no-op and the starvation guard below is unchanged as the final fallback.
    //
    // TEXTURE-INVITED PRE-CHECK (Aug 5, behind TEXTURE_INVITES_DETECT): reads
    // stored.textureInvited (this turn's reader judgment, consumed one-turn-
    // lagged same as every other reader signal) — if the reader explicitly
    // judged this moment as NOT inviting texture (a serious/sensitive beat),
    // skip selectTextureBit() entirely this turn rather than picking one and
    // hoping the model declines it. Defaults PERMISSIVE: off, or no reader
    // judgment yet, means texture runs exactly as it does today.
    const textureInvitedNow = !TEXTURE_INVITES_DETECT || !stored || stored.textureInvited !== false;
    if (TEXTURE_INVITES_DETECT && !textureInvitedNow) {
      console.log("texture SKIPPED turn=" + turn + " — reader judged this moment doesn't invite texture");
    }
    // TEXTURE POST-EVENT COOLDOWN (Aug 5, behind TEXTURE_POST_EVENT_COOLDOWN):
    // don't stack texture right on top of a bigger moment. Two checks, either
    // one can suppress: (a) any sound/gag marker fired within the cooldown
    // window (reuses markerLastTurn, already persisted regardless of the
    // MARKER_AWARENESS flag — detection there runs unconditionally); (b) a
    // stall/hunt resolved within the window (lastStallResolvedTurn, stamped
    // at the resolve-clear point above). Both read the MOST RECENT event of
    // their kind, not just the last turn — a marker or resolve from exactly
    // N turns ago still counts inside the window.
    let textureCooldownActive = false;
    if (TEXTURE_POST_EVENT_COOLDOWN && stored) {
      const markerTurns = Object.values(stored.markerLastTurn || {});
      const lastMarkerTurn = markerTurns.length ? Math.max(...markerTurns) : 0;
      const lastResolveTurn = stored.lastStallResolvedTurn || 0;
      const sinceMarker = lastMarkerTurn ? turn - lastMarkerTurn : Infinity;
      const sinceResolve = lastResolveTurn ? turn - lastResolveTurn : Infinity;
      if (sinceMarker < TEXTURE_POST_EVENT_COOLDOWN_TURNS || sinceResolve < TEXTURE_POST_EVENT_COOLDOWN_TURNS) {
        textureCooldownActive = true;
        console.log(
          "texture SKIPPED turn=" + turn + " — post-event cooldown (sinceMarker=" +
          sinceMarker + " sinceResolve=" + sinceResolve + " window=" + TEXTURE_POST_EVENT_COOLDOWN_TURNS + ")"
        );
      }
    }
    let textureFired = false;
    if (!fire && textureInvitedNow && !textureCooldownActive) {
      // Same TEST_PRIORITY_BITS restriction as the scored path above — a
      // texture-classified bit in the list needs this too, since
      // selectTextureBit() has its own separate candidate pool (texture
      // bits are excluded from loadout()'s scored path by design when
      // TEXTURE_ROTATION is on, so restricting only selectBit() above would
      // silently miss every texture bit in the list).
      const texBit = selectTextureBit(scorerState, { pool: testPool });
      if (texBit) {
        top = {
          ...texBit,
          score: DEPLOY_THRESHOLD,
          breakdown: { fit: null, gearBias: null, recency: null,
            why: ["texture rotation (phase+cooldown LRU)"] },
        };
        fire = true;
        textureFired = true;
        console.log(
          "texture ROTATION fire bit=" + texBit.id + " turn=" + turn +
          " phase=" + phase + " pool=" + (texBit.pool || "middle")
        );
      }
    }

    // STARVATION GUARD: if the call has gone dry (no discrete bit for
    // STARVE_AFTER consecutive turns), the pacing has starved the comedy — drop
    // the spacing requirement for THIS turn and let the highest-scoring eligible
    // bit fire, so a quiet call gets more permissive instead of staying locked.
    // EXCEPTION: an active spammer challenge (accusation this turn) overrides the
    // guard — the challenge should be handled first, not stepped on by a bit.
    // Still respects warm-up (bar=Infinity early) and requires a real candidate.
    const STARVE_AFTER = parseInt(process.env.STARVE_AFTER || "4", 10);
    let starvationFired = false;
    if (!fire && top && !accusation && turn > WARMUP_TURNS && gap >= STARVE_AFTER) {
      // Bar is relaxed to the deploy threshold floor (not Infinity/warmup); the
      // top bit fires if it's a genuine candidate at all. Spacing is waived once.
      if (top.score >= DEPLOY_THRESHOLD) {
        fire = true;
        starvationFired = true;
      }
    }

    // DOMINANCE CIRCUIT BREAKER (Aug 6, new failsafe — see the cooldown/cap
    // gates above for the primary fix). The primary fix protects any bit
    // that DECLARES max_fires_per_call; this protects against the NEXT
    // unknown bug of the same shape, for bits that don't. Because exactly
    // one bit wins the entire turn's attention by hard architecture
    // (`let top = ranked[0]` — there is no second-place slot), a bit that
    // keeps winning for ANY reason — a scoring quirk nobody's found yet, a
    // narrow-archetype call where almost nothing else is eligible, whatever
    // — silently starves the ENTIRE rest of the library for as long as it
    // keeps winning. That's what actually happened with THE ENVIRONMENT
    // (BIT-329) tonight: cooldown/cap will stop bits that self-declare a
    // limit, but nothing catches a bit that dominates for a reason no one
    // anticipated. This is that backstop: if letting this fire would push
    // the bit's SHARE of the whole call's fires past DOMINANCE_RATIO_MAX,
    // suppress it — the turn falls through to normal conversation instead
    // (same outcome as any other non-fire turn), and it's LOGGED LOUDLY so
    // this is findable in a normal log scan, not just a manual transcript
    // read the way tonight's bug was found.
    // SCOPED TO NATURAL SELECTION ONLY (!forcedFire) — a Director/TEST_PRIORITY_BITS
    // force is a deliberate, understood bypass of every other gate already;
    // extending the breaker to forced fires is a separate, open design
    // question (does forcing mean "win the ranking" or "fire no matter
    // what") that hasn't been decided yet, not something to fold in here.
    const DOMINANCE_RATIO_MAX = parseFloat(process.env.DOMINANCE_RATIO_MAX || "0.5");
    const DOMINANCE_MIN_TURNS = parseInt(process.env.DOMINANCE_MIN_TURNS || "6", 10);
    if (fire && !forcedFire && top && turn >= DOMINANCE_MIN_TURNS) {
      const priorTotal = (scorerState.bitFireHistory || {})[top.id]?.totalFires || 0;
      const projectedTotal = priorTotal + 1;
      const ratio = projectedTotal / turn;
      if (ratio > DOMINANCE_RATIO_MAX) {
        console.log(
          "bit CIRCUIT-BREAKER-TRIPPED id=" + top.id + " turn=" + turn +
          " wouldBeTotalFires=" + projectedTotal + " ratio=" + ratio.toFixed(2) +
          " max=" + DOMINANCE_RATIO_MAX + " — suppressing this fire, falling through to normal conversation"
        );
        fire = false;
      }
    }

    // FORCE one-shot consume: the Director's forced bit actually fired this
    // turn, so close its row (status -> "fired"). getControls only surfaces
    // PENDING force rows, so this is what makes it fire exactly once — and it's
    // why a silence bare-turn can't replay it (the guard is the row's status,
    // not the turn counter). Left pending if it never fired, so an unfirable
    // force can still land on a later turn when the pool shifts.
    if (forcedFire && fire && forcedCtl && forcedCtl.bit_id) {
      waitUntil(fireForce(callId, { bitId: forcedCtl.bit_id }).catch(() => {}));
    }

    // ARM resolution: reconcile the setlist with this turn's outcome. Each arm is
    // its own call_controls row, so closing one = fireArm(id) (status -> fired).
    //  - bare fact-arm (hook only): inject its real fact this turn, then close.
    //  - bit-arm that fired this turn: mark trigger "armed", pull its fact, close.
    //  - everything else: leave the row pending (no drop except at call end).
    //    Escalation (in the scorer) guarantees an armed bit eventually wins a spot.
    let firedArmedBit = false;
    let armedHookFact = null;
    for (const a of armedList) {
      const hookFact = (a.hook_id && ammo.byHook && ammo.byHook[a.hook_id])
        ? factHint({ fuel_hooks: [a.hook_id] }, ammo.byHook) : null;
      if (a.hook_id && !a.bit_id) {
        if (hookFact) {
          armedHookFact = armedHookFact ? armedHookFact + " | " + hookFact : hookFact;
          waitUntil(fireArm(a.id).catch(() => {}));
        }
        continue; // no scout data yet -> leave pending, don't close
      }
      if (a.bit_id && fire && top && top.id === a.bit_id) {
        firedArmedBit = true;
        if (hookFact) armedHookFact = armedHookFact ? armedHookFact + " | " + hookFact : hookFact;
        waitUntil(fireArm(a.id).catch(() => {}));
        continue; // fired -> close
      }
      // else: still waiting -> leave the row pending.
    }

    // MUTABLE block: posture lines + (on fire) a gentle in-character bit cue.
    // Goes AFTER the cached base, so injecting never busts the prompt cache.
    let mutable = buildPostureBlock(state);

    // NAME AT OUTSET (Aug 6, Andrew — now confidence-aware per Scouting's
    // 8/6 ranked-resolution update). Two branches, not one:
    //   HIGH CONFIDENCE (>= NAME_CONFIDENCE_THRESHOLD): force natural use in
    //     the greeting, as before.
    //   LOW CONFIDENCE (below threshold — an email-local-part guess) OR NO
    //     NAME AT ALL: don't force a possibly-wrong name into the greeting,
    //     and don't silently skip either — Andrew's own instinct: ask for
    //     it naturally, as one of the first things, same as a real person
    //     would if they hadn't caught a name yet.
    // Threshold sits between Scouting's two known tiers (0.7 real sources,
    // 0.55 local-part guess) so it cleanly separates them without being
    // fragile to a small confidence jitter within either tier.
    const NAME_CONFIDENCE_THRESHOLD = parseFloat(process.env.NAME_CONFIDENCE_THRESHOLD || "0.65");
    if (turn === 1) {
      if (spammerName && spammerNameConfidence >= NAME_CONFIDENCE_THRESHOLD) {
        mutable +=
          "\n\n[TURN 1 — the caller's name is known: " + spammerName + ". Use it " +
          "naturally in your greeting this turn (e.g. \"" + spammerName +
          ", good to talk to you\" / \"hey, " + spammerName + "\") — not a forced " +
          "or robotic use, just a natural human greeting that includes their name.]";
      } else if (spammerName && spammerNameConfidence < NAME_CONFIDENCE_THRESHOLD) {
        // A guessed name (email-local-part tier) exists but isn't trustworthy
        // enough to use confidently — deliberately do NOT surface the guess
        // itself here, so the model isn't tempted to use it anyway.
        mutable +=
          "\n\n[TURN 1 — you don't have a confirmed name for the caller yet. " +
          "Ask for it naturally, early in the call, the way a real person " +
          "would (e.g. \"sorry, who am I talking to?\" / \"and your name is—?\") " +
          "— not an interrogation, just a normal, natural thing to ask.]";
      } else {
        mutable +=
          "\n\n[TURN 1 — you don't know the caller's name yet. Ask for it " +
          "naturally, early in the call, the way a real person would (e.g. " +
          "\"sorry, who am I talking to?\" / \"and your name is—?\") — not an " +
          "interrogation, just a normal, natural thing to ask.]";
      }
    }

    // EXPERTISE-LEVEL DIAL (Aug 6, Andrew — one-time-per-call Director dial,
    // default "above average"). Mechanism only — ships OFF (EXPERTISE_DIAL_
    // ENABLED, default false) until Canon supplies the real up/down
    // transition performance text; the placeholder below must never
    // actually reach a live call. Scale: 1-4, matching absurdity's shape;
    // EXPERTISE_LEVEL_DEFAULT (env, default 3) is the "above average"
    // baseline the dial moves up or down FROM, not from zero.
    //
    // CHANGE DETECTION: compares controls.expertiseLevel (what the Director
    // has it set to RIGHT NOW) against stored.expertiseLevelUsed (what PE
    // actually used LAST turn — persisted specifically so this comparison
    // is possible). A mismatch means the dial moved since the last turn;
    // this is the ONE turn that gets a transition beat. Every other turn is
    // steady-state — no transition language, just the current level.
    //
    // TWO DIRECTIONS, DELIBERATELY NOT SYMMETRIC (Andrew's own framing):
    // dialing UP needs a performed "I just figured it out" realization beat
    // — the host can't just silently know more. Dialing DOWN needs its own
    // different answer (a believable human lapse vs. a jarring competence
    // drop) — NOT simply the inverse of the up-case. Both are Canon's to
    // write, not PE's to guess at; the placeholders below mark exactly
    // where that real text plugs in.
    const EXPERTISE_DIAL_ENABLED =
      /^(1|true|yes|on)$/i.test(String(process.env.EXPERTISE_DIAL_ENABLED || ""));
    const EXPERTISE_LEVEL_DEFAULT = parseInt(process.env.EXPERTISE_LEVEL_DEFAULT || "3", 10);
    const expertiseLevelNow =
      controls && controls.expertiseLevel != null ? controls.expertiseLevel : EXPERTISE_LEVEL_DEFAULT;
    const expertiseLevelPrev =
      stored && stored.expertiseLevelUsed != null ? stored.expertiseLevelUsed : EXPERTISE_LEVEL_DEFAULT;
    const expertiseChanged = EXPERTISE_DIAL_ENABLED && expertiseLevelNow !== expertiseLevelPrev;
    // TRANSITION LINES (Aug 6, Canon). Deliberately NOT mirror images —
    // Canon's own framing: UP is a recognition landing ("I just put it
    // together"), never a flat competence jump (reads uncanny, like he
    // secretly knew). DOWN is attention wandering, NOT competence dropping
    // ("I'm blanking" was explicitly rejected — that reads as impaired, not
    // distracted). Three options each, picked at random per fire — same
    // variety discipline as the opener bank, so a dial move doesn't always
    // sound identical across different calls.
    const EXPERTISE_UP_LINES = [
      "wait — hold on — is this the thing with the— yeah, no, I know exactly what you mean, I just didn't put it together till right now—",
      "oh! okay, no, now I'm with you — I've actually been chewing on this exact thing, I just didn't realize that's what we were—",
      "huh — wait, say that again? Because if that's what you're— yeah. Yeah, okay, I know this one. Keep going.",
    ];
    const EXPERTISE_DOWN_LINES = [
      "sorry — say that part again? I think I lost the thread for a second, I was still back on the— no, go on, I'm with you.",
      "hang on, you said the— sorry, honestly half my brain's still on this thing from earlier, give me the short version again?",
      "mm — you know what, I was following and then I just— sorry, where are we exactly? Walk me back a step.",
    ];
    if (expertiseChanged) {
      const direction = expertiseLevelNow > expertiseLevelPrev ? "UP" : "DOWN";
      const bank = direction === "UP" ? EXPERTISE_UP_LINES : EXPERTISE_DOWN_LINES;
      const line = bank[Math.floor(Math.random() * bank.length)];
      // ONE BEAT ONLY (Canon's own wiring caution): this is a single move —
      // the line itself, performed, then continue normally. Explicitly NOT
      // a cue to stack this with anything else the turn also needs to do
      // (e.g. the down-beat's re-explain ask is already doing real stall
      // work on its own — piling more onto the same turn is exactly the
      // stacked-questions/lead-don't-follow failure from elsewhere).
      mutable +=
        "\n\n[EXPERTISE " + direction + " — THIS TURN ONLY, ONE BEAT: perform this " +
        "moment, in character, then continue the turn normally. Do not stack " +
        "anything else onto it.]\n" + line;
      console.log(
        "expertise-level TRANSITION turn=" + turn + " direction=" + direction +
        " " + expertiseLevelPrev + "->" + expertiseLevelNow
      );
    }

    // STALL RESOLUTION (STALL_RESOLVE) — one-turn wrap-up note. Fires exactly
    // on the turn the hunt-window above stopped sustaining because
    // stallShouldResolve() went true. Applies regardless of whether a new
    // scenario/texture bit ALSO fires this same turn (that bit's own [BIT
    // ACTIVE] block, if any, is appended separately below) — this note just
    // makes sure the still-open hunt thread gets closed out rather than
    // silently abandoned. Full history is intact; this only gives permission
    // to move on.
    if (huntJustResolved) {
      mutable +=
        "\n\nTHE HUNT HAS RUN LONG ENOUGH — before anything else this turn, " +
        "close out the approver/payment thread you left open: resolve it " +
        "naturally in character (they got back to you, or you're done " +
        "waiting) in a line or two, then move the conversation forward. Do " +
        "NOT start another rung of the same hunt.";
    }

    // CALLER-CRUDE conditional injection (Aug 4, CORE audit's crude-section
    // split). stored.callerCrude is last turn's reader judgment, consumed
    // THIS turn — same one-turn-lag pattern as the hunt-resolution reasons
    // above. Gated on CALLER_CRUDE_DETECT even though stored.callerCrude
    // already defaults to "none" when the flag's off, for clarity/defense.
    // See crudeImpersonalText/crudePersonalText above for the SWAP POINT —
    // Canon's real conditional text replaces those two function bodies,
    // nothing else here changes when that lands.
    if (CALLER_CRUDE_DETECT && stored && stored.callerCrude === "impersonal") {
      mutable += "\n\n" + crudeImpersonalText(stored.crudeImpersonalCount || 0);
    } else if (CALLER_CRUDE_DETECT && stored && stored.callerCrude === "personal") {
      mutable += "\n\n" + crudePersonalText(stored.crudePersonalCount || 0);
    }

    // MARKER AWARENESS INJECTION (Aug 4, PE_self_caused_marker_awareness.md).
    // Detection + persistence happens in finishUp (search SELF-CAUSED MARKER
    // AWARENESS) — this is the read side. For any marker that fired within
    // the last ~2-3 turns (this turn included), inject a plain FACTUAL note:
    // that it happened, and how many times this call. Deliberately NOT a
    // performance directive — the reaction content and the marquee-vs-
    // ambient escalation ladder are Bits' to author (division of labor per
    // the spec); this only makes the fact + count available so (a) the host
    // can own a late caller reference instead of denying it, and (b) a
    // future Bits directive reading stored.markerCounts[marker] knows this
    // is fire N and can pick the right rung. Ages out on its own — once
    // turn - markerLastTurn exceeds the window, the note simply stops
    // appearing; the underlying count is untouched and keeps accumulating
    // for whenever Bits' escalation logic wants it.
    if (MARKER_AWARENESS && stored && stored.markerLastTurn) {
      const AWARENESS_WINDOW_TURNS = 2; // fired this turn, or up to 2 turns ago
      const recent = Object.keys(stored.markerLastTurn).filter((marker) => {
        const lastTurn = stored.markerLastTurn[marker];
        return typeof lastTurn === "number" && turn - lastTurn <= AWARENESS_WINDOW_TURNS && turn - lastTurn >= 0;
      });
      if (recent.length) {
        const counts = stored.markerCounts || {};
        const notes = recent.map((marker) => {
          const readable = marker.toLowerCase().replace(/_/g, " ");
          const n = counts[marker] || 1;
          return readable + " (" + n + (n === 1 ? " time" : " times") + " this call)";
        });
        mutable +=
          "\n\nAWARENESS — something real just happened on your end: " +
          notes.join("; ") + ". It's real, not the caller's imagination — if " +
          "they reference it, own it naturally (\"oh — yeah, that was me, " +
          "sorry\"), never deny it. If nothing prompts you to mention it, you " +
          "don't have to bring it up yourself.";
      }
    }

    // SILENCE CHECK-IN DIRECTIVE (added 2026-07-25). On LiveKit the agent
    // handles a caller silence by firing a bare session.generate_reply() — it
    // re-asks the model to continue with NO new caller message. The tell in the
    // request is that the LAST message is the HOST'S OWN previous line
    // (role "assistant"), not a new caller line (role "user"): on a normal turn
    // the caller's fresh line is last. This detector keys on that role, NOT on
    // turn/gap counting — which has silently misfired three times because a
    // bare turn doesn't advance those counters.
    // WHY THIS IS NEEDED: handed an array whose last entry is its own prior
    // line and no new user input, the model frequently returns EMPTY (OUT
    // len=0) — it has nothing it's being asked to respond to, so it says
    // nothing. That is the "no reaction to silence" failure. The standing
    // prompt's "IF THEY GO QUIET" section is not enough on its own; the model
    // needs an explicit, current-turn instruction that it is ITS move and it
    // should speak. We give it one, briefly, without busting cache (mutable
    // block only). Only when the caller has ALREADY spoken at least once (turn
    // 0 opener owns the true call-open and must not be treated as silence).
    const lastMsgRole =
      messages && messages.length
        ? messages[messages.length - 1] && messages[messages.length - 1].role
        : null;
    const callerHasSpoken = countUserTurns(messages) > 0;
    const isBareSilenceTurn = callerHasSpoken && lastMsgRole === "assistant";
    if (isBareSilenceTurn) {
      mutable +=
        "\n\nTHE CALLER HAS GONE QUIET — it is YOUR turn and you must speak now. " +
        "Follow IF THEY GO QUIET from your standing instructions: assume the " +
        "good reason and check in warmly, ONE short line, for them — never wind " +
        "down, never 'I'll let you go', never wrap up. Do NOT repeat your last " +
        "line; say something new and easy. If you just broke something or had a " +
        "moment, you can let that breathe — but say SOMETHING. Never return an " +
        "empty turn.";
    }

    // INTERRUPTION (Voice stamps metadata.interrupted=true on the one turn
    // following a detected caller barge-in; same extra_body.metadata channel
    // as silence_beat, bare boolean, absent on every normal turn — read the
    // same defensive way). This is UNIVERSAL, not hunt-specific: any bit with
    // multi-turn state can get talked over. PE does not decide what the host
    // does with it (that's Host Canon's call — react, then finish/drop/pivot
    // per what the caller actually said) — this only SURFACES that an
    // interruption happened this turn, since the model reading its own
    // possibly-truncated prior line has no other way to know it was cut off
    // mid-thought rather than finished naturally.
    const wasInterrupted =
      body?.metadata?.interrupted ??
      body?.extra_body?.metadata?.interrupted ??
      body?.call?.metadata?.interrupted ??
      false;
    // ★ DIAGNOSTIC (Aug 5, temporary — remove once the zero-trace mystery is
    // settled). Voice traced the wire shape precisely: interrupted lands at
    // body.metadata.interrupted, the SAME object callId/slug already arrive
    // on and read successfully every turn — so the read path is confirmed
    // correct, and the zero-trace across 8 real stamps needs the actual raw
    // object PE received to diagnose, not another guess. Logs EVERY turn
    // (not just wasInterrupted===true) so a normal turn and a stamped turn
    // can be compared directly once one shows up in a real call.
    console.log(
      "INTERRUPT-BODY-DIAG turn=" + turn +
      " metadata=" + JSON.stringify(body?.metadata) +
      " extra_body_metadata=" + JSON.stringify(body?.extra_body?.metadata) +
      " call_metadata=" + JSON.stringify(body?.call?.metadata) +
      " wasInterrupted=" + wasInterrupted
    );
    if (wasInterrupted === true) {
      mutable +=
        "\n\nTHE CALLER JUST CUT YOU OFF mid-line. React to being interrupted " +
        "naturally, in character, in one short beat (\"oh — sorry, go ahead\" " +
        "or similar) — then take in what they actually just said before " +
        "deciding anything. If it's a real question or a redirect, go with " +
        "THEM and let go of what you were doing; if it's just a nudge to " +
        "keep going, carry your thread one beat further; if it doesn't need " +
        "either, let it fall away like any dangle. Never barrel on as if " +
        "they hadn't spoken, and never restart from the top like the last " +
        "few turns didn't happen.";
    }

    // FAST-JOIN OPENER: on the host's first line of a fast-turnaround booking,
    // prepend a time-aware, in-character opener (and the "saw you waiting"
    // callback when they actually sat). Empty string for every normal call/turn.
    const opener = fastJoinOpener(body, turn);
    if (opener) mutable += opener;
    // NAME HANDLING (host's first line only): if Scouting's email dissection
    // gave us a name (sender_identity — Channel 2, facts.name, fixed
    // 2026-08-04 alongside title/company), the host says it confidently —
    // it's the name they presented professionally in their email. If we
    // have NO trusted email name, the host opens by ASKING who they're
    // speaking with — never guessing or speaking a booking-form name (which
    // is often scribbled junk). The 6 name-family bits (BIT-212/213/214/
    // 218/226/321) declare no fuel_hooks of their own — this turn-0 line is
    // the only place a name enters the conversation; they rely on it having
    // been said here and carried forward in history from there.
    if (turn === 0) {
      const emailName =
        (ammo && ammo.byHook && ammo.byHook.sender_identity &&
          ammo.byHook.sender_identity.name) || null;
      if (emailName) {
        mutable +=
          "\n\nTHEIR NAME: you know from their email that you're speaking with " +
          emailName + ". Use their name naturally and confidently early on — do " +
          "NOT ask them to confirm it; you already know it.";
      } else {
        mutable +=
          "\n\nTHEIR NAME: you do NOT have a reliable name for this person. Do " +
          "NOT invent one or address them by any name. Early in the call, ask " +
          "naturally who you're speaking with (e.g. \"sorry, remind me who I'm " +
          "speaking with?\") so you can use it from then on.";
      }
    }
    if (deathBlow) {
      // Rungs are gone: PE doesn't deliver a canned line. It directs the Host to
      // IMPROVISE the most absurd-within-reason closer in persona, right now. The
      // actual line is captured from the stream and emitted as blow_fired in
      // finishUp (so the trace carries what the Host really said).
      mutable +=
        "\n\nDEATH BLOW — end the call now, on this line. This is the final thing " +
        "you say, then the call is over.\n" +
        "Make it your most absurd, fully in-character closing line that:\n" +
        "- stays in your voice and the reality this call has established;\n" +
        "- actually ends it — give them a reason to give up or hang up (a funny " +
        "line that invites another reply does NOT count);\n" +
        "- pays off something from THIS call: a bench character, a bit that " +
        "landed, the spammer's own words, or a real fact you know about them.\n" +
        "Earned absurdity reads as brilliant; absurdity from nowhere reads as " +
        "nonsense. Deliver that one line, then stop.";
      deathBlowFiring = true;
      // blow_armed lands now (Director's intent took effect this turn). blow_fired
      // (with the real generated line) and call_ended emit after the stream.
      trace.emit("blow_armed", { armed_at: new Date().toISOString() }, "director");
      waitUntil(clearDeathBlow(callId, "fired").catch(() => {}));
    } else if (fire) {
      // HARDENED FRAMING (Bits chat, Jul 15): the old wording ("work the bit in
      // ONLY if it lands naturally") made the fire optional, and the model was
      // producing thematically-adjacent mood instead of the bit's structure —
      // sanding was systemic across every multi-beat bit. A fire is now a
      // command to PERFORM the specific routine, not ambient guidance.
      //
      // PRUNED (Aug 4): a "THIS OVERRIDES your ordinary-receiving-turn
      // habits..." sentence lived here briefly, added while chasing the
      // "bits fire but leave no trace" investigation (same theory as
      // providers.js's now-also-pruned yield clause and bit carve-out — see
      // that file's history). All three were reasonable, evidence-based
      // hypotheses that turned out not to be the cause: a live diagnostic
      // trace proved the injected directive was reaching the model intact
      // on every fire, and the actual fix was swapping the production model
      // off Haiku onto a larger tier. Removed as inert prompt weight now
      // that the real cause is known — the HARDENED FRAMING above (Jul 15)
      // is the durable fix that actually matters here.
      const bitDirective =
        BIT_DIRECTIVES && BIT_DIRECTIVES[top.id] && String(BIT_DIRECTIVES[top.id]).trim()
          ? String(BIT_DIRECTIVES[top.id]).trim()
          : null;
      mutable +=
        '\n\n[BIT ACTIVE: ' + top.id + ' — "' + top.name + '"]\n' +
        "A specific routine has been selected and MUST be performed this turn. " +
        "This is not ambient guidance and not a tone suggestion — a bit has " +
        "fired. " +
        (bitDirective
          ? "Its directive follows. Perform ITS specific structure: hit its " +
            "beats, its required moves, its sequence. Do NOT produce behavior " +
            "that is merely consistent with the bit's tone — that is a failed " +
            "performance.\n\n" + bitDirective + "\n\n"
          : "Its full directive is under " + top.id + " in your ARMED BITS " +
            "section. Perform THAT routine's specific structure: hit its " +
            "beats, its required moves, its sequence. Do NOT produce behavior " +
            "that is merely consistent with the bit's tone — that is a failed " +
            "performance. ") +
        // PERMISSION TO DECLINE (Aug 5) — texture fires ONLY. Scenario/stall
        // mechanics (the hunt, etc.) stay mandatory once fired; those are
        // load-bearing state machines, not ambient color, and making them
        // optional would break their own multi-turn logic. Texture is
        // different — it's supposed to be the model's read of whether THIS
        // exact moment wants something playful, and PE's own pick is a
        // guess, not a certainty. One sentence, cheapest possible test of
        // whether explicit permission changes anything.
        (textureFired
          ? "One thing: if this genuinely doesn't fit the moment, drop it " +
            "and just continue naturally instead — a good conversation " +
            "matters more than forcing this in. "
          : "") +
        (inHuntWindow
          ? // WINDOW SUSTAIN: this bit already opened on an earlier turn and is
            // being HELD across the beat. Override the default "start beat one"
            // framing — starting over would loop the host back to the opening
            // move ("oh, I'd need an approver") every turn. Tell it explicitly
            // where it is and to ADVANCE, using the conversation history as its
            // record of what it has already done.
            "This routine is ALREADY IN PROGRESS — you opened it " +
            (turn - stored.lastBitTurn) + " turn(s) ago and are now on rung " +
            ((turn - stored.lastBitTurn) + 1) + " of it. Do NOT restart it or " +
            "repeat the opening move; you have already done that. Look at what " +
            "you have already said in this thread and ADVANCE the rung from " +
            "there — escalate the effort (a new extension, a new excuse, a " +
            "further step in the search), don't reset it. Keep it fresh and " +
            "moving. "
          : "If the bit has sequenced rungs, start rung one now and carry the " +
            "sequence across turns as its directive specifies. ") +
        "Still in force: " +
        "never name the bit, never break character, and stay in the live " +
        "thread — the caller's last line still gets a real response woven " +
        "through the performance.\n[END BIT]";
      // If this bit is fueled, hand the host the REAL scouted fact to weave in.
      const fact = factHint(top, scorerState.byHook);
      if (fact) {
        mutable +=
          "\n\nYou happen to know this about them: " + fact +
          ". Work that specific real detail into the bit's performance — " +
          "quote the real fact, never invent one.";
      }
      const bitBase = {
        bit_id: top.id,
        name: top.name,
        bit_type: top.bit_type || top.type || null,
        trigger: forcedFire
          ? "force"
          : gagOpen
          ? "gag_open"
          : starvationFired
          ? "starvation"
          : firedArmedBit
          ? "armed"
          : textureFired
          ? "texture_rotation"
          : "auto",
        turn_index: turn,
        // TELEMETRY: dry_turns = turns since the last discrete bit before this
        // fire (the gap the guard watches). Lets the bus compute firing rate and
        // spot under-firing (target 5-7 per 25 turns; <4 = starved). starvation
        // flags a guard-forced fire so its frequency is measurable separately.
        dry_turns: gap === 99 ? null : gap,
        starvation: starvationFired || undefined,
        // WHY-STAMP: the causal link Mead Hall draws gear->bit from. The fit
        // score that cleared the bar this turn, the bar it cleared, and the gear
        // state at fire — so "suspicion=slipping pushed score 7.0 over a 3.0 bar"
        // is reconstructable from the event alone.
        fit_score: top.score != null ? +top.score.toFixed(2) : null,
        deploy_bar: turn <= WARMUP_TURNS ? "warmup" : +bar.toFixed(2),
        gears_at_fire: {
          // suspicion/slip REMOVED (Aug 5, gears removal) — pressure/
          // engagement stay, reader-sourced now, still meaningful telemetry.
          pressure: state.pressure,
          engagement: state.engagement,
        },
      };
      if (sameTurnReinject) {
        // Already traced when this bit fired earlier on this same turn. The
        // regeneration is the same comedic moment, not a second deployment —
        // emitting again would show Mead Hall the bit two or three times and
        // inflate a count bit's running_total.
        console.log("bit re-injected (same turn) id=" + top.id + " turn=" + turn);
      } else if (top.bit_type === "count") {
        // count bit: PE owns the running tally. count_label is static on the bit;
        // running_total = prior fires (off the event log) + this one.
        waitUntil(
          (async () => {
            const prior = await bitFireCount(callId, top.id);
            trace.emit(
              "bit_deployed",
              { ...bitBase, count_label: top.count_label || null, running_total: prior == null ? null : prior + 1 },
              "engine"
            );
          })()
        );
      } else {
        trace.emit("bit_deployed", bitBase, "engine");
      }
    }

    // Director-armed fact (forced via the setlist): weave the real detail in even
    // if no bit pulled it this turn. Soft cue — host uses it if it fits.
    if (armedHookFact) {
      mutable +=
        "\n\nALSO — if it fits naturally, work in this real detail about them: " +
        armedHookFact + ". Quote the real fact, never invent one.";
    }

    blocks.push({ type: "text", text: mutable });

    // VISIBILITY: gears + the fit read, every turn, watchable in Vercel logs.
    // "changes" REMOVED (Aug 5, gears removal) — there's no more keyword-
    // layer transition list to report; state itself (now just pressure/
    // engagement) still prints in full below.
    const trail = accusation ? "  accuse:" + accusation : "";
    console.log("gears " + JSON.stringify(state) + trail);
    // GEAR_STATE: the engine's real reasoning, emitted to the bus each turn so
    // the Director's View can render the axis values + fit-vs-bar live. These are
    // the AUTHORITATIVE values the engine actually uses — lowercase axis enums,
    // bar-scale fit numbers (NOT 0-1). Mead Hall renders off this exact shape.
    // suspicion/slip REMOVED (Aug 5, gears removal) — Mead Hall is dropping
    // the gear panel from its layout to match; pressure/engagement stay,
    // still meaningful (reader-sourced), still real telemetry.
    trace.emit(
      "gear_state",
      {
        pressure: state.pressure,          // calm | pushing | extracting
        engagement: state.engagement,      // bored | hooked | stunned
        fit_score: top ? +top.score.toFixed(2) : null,
        deploy_bar: turn <= WARMUP_TURNS ? "warmup" : +bar.toFixed(2),
        pool: poolSize,
        will_fire: fire,                   // did a bit clear the bar this turn
        // CALL PHASE (the reader's live judgment this turn) — pairs with each
        // scored bit's `phase` so Mead Hall shows an opening bit IN-WINDOW
        // (call_phase === "opening") vs PAST-WINDOW. The reachability question
        // from the warmup/opening bug, answerable live from one event.
        call_phase: phase,
        top_bit: top ? top.name : null,
        turn_index: turn,
        // PER-BIT SCORES (added Jul 15 for Mead Hall's arm panel). Free: the
        // scorer already ranked every eligible bit this turn — this is the same
        // `ranked` the fit log slices, just structured instead of a preview
        // string.
        //   top3   — the ranking, not just the winner.
        //   scores — every bit the scorer CONSIDERED this turn, id -> score.
        // IMPORTANT for rendering: a bit ABSENT from `scores` was excluded from
        // the pool this call, not scored zero. Exclusions are hard: parked (no
        // fuel producer), archetype mismatch, missing fuel hooks, death blows
        // (700s, they never rank here), and — from this deploy — opening bits
        // once the reader says the call is past its opening. Absent means "not
        // in play", which is different from "scored badly", and worth showing
        // differently in the panel.
        top3: ranked.slice(0, 3).map((r) => ({
          bit_id: r.id,
          name: r.name,
          score: +r.score.toFixed(2),
          phase: phaseOf(r.id), // raw phase_pref ("opening"/"pitching"/"probing"/
                                //   "drifting"/"any") — Mead Hall groups live
        })),
        scores: Object.fromEntries(ranked.map((r) => [r.id, +r.score.toFixed(2)])),
        // per-bit phase group, parallel to scores, so Mead Hall's opening-bits
        // panel can separate opening bits from the rest without a static list
        // (a static list goes stale whenever Bits adds an opening bit).
        phases: Object.fromEntries(ranked.map((r) => [r.id, phaseOf(r.id)])),
      },
      "engine"
    );
    // gear_transition emit and the old synchronous blow_landed check both
    // REMOVED (Aug 5, gears removal) — gear_transition had no meaning left
    // (suspicion, the only axis it tracked, is gone). blow_landed's logic
    // relocated into the async reader callback above (search BLOW-LANDED) —
    // that's now the only place a genuinely new engagement value appears,
    // since engagement is reader-sourced only.
    if (top) {
      console.log(
        "fit " +
          JSON.stringify({
            pick: top.name,
            arch: archetype,
            score: +top.score.toFixed(2),
            fired: fire,
            gap,
            bar: turn <= WARMUP_TURNS ? "warmup" : +bar.toFixed(2),
            pool: poolSize,
            // turn + phase: what the SCORER actually consumed this turn. phase
            // is what the store handed back (not what the reader last judged —
            // those differ by one turn, and a bug that freezes phase is
            // invisible without logging the consumed value). turn drives the
            // opening-bit gate in _bits_scorer.js loadout().
            turn,
            phase,
            ...(gagOpen ? { gag_open: true } : {}),
            top3: ranked.slice(0, 3).map((r) => r.name + ":" + r.score.toFixed(1)),
          })
      );
    }

    // SNAPSHOT: persist gears (+ the fired bit, for recency/pacing next turn).
    // CRUDE COUNT GATE: stored.callerCrude is last turn's reader judgment,
    // consumed THIS turn (same one-turn-lag pattern as commitmentPush/
    // callerRedirected). Added to the write gate below so an increment isn't
    // silently dropped on a turn where nothing ELSE changed (fire/
    // archetypeNew could all be false while crude still needs counting).
    // "dirty" REMOVED (Aug 5, gears removal) — it used to mean "did
    // suspicion/pressure/engagement change via keyword detection this turn";
    // there's no more keyword layer to report that, and the reader's own
    // separate setCall (in the async callback above) is what actually
    // persists pressure/engagement now, on its own schedule. The write below
    // still fires for all the OTHER real reasons it always did.
    const crudeDetected = !!(stored && (stored.callerCrude === "impersonal" || stored.callerCrude === "personal"));
    if (!stored || fire || archetypeNew || crudeDetected || expertiseChanged) {
      waitUntil(
        setCall(callId, {
          // gear/slip/accuseFloor REMOVED (Aug 5, gears removal) — suspicion
          // is gone entirely, no replacement. pressure/engagement kept as a
          // redundant-but-harmless copy (the reader's own async write is the
          // authoritative source; this just keeps them consistent on turns
          // this gate fires for anyway).
          pressure: state.pressure,
          engagement: state.engagement,
          // EXPERTISE-LEVEL DIAL: persist what was actually USED this turn,
          // unconditionally whenever this gate fires at all — not just on
          // the transition turn. If this only wrote on the transition turn
          // itself, a later turn where the gate fires for an unrelated
          // reason (a bit fires, archetype resolves) would compare against
          // a STALE value and could re-detect a "change" that already
          // happened, firing the transition beat again. Added
          // expertiseChanged to this gate's own OR-condition above so the
          // write is GUARANTEED to happen on the turn a real change occurs,
          // not left dependent on something else coincidentally firing too.
          expertiseLevelUsed: expertiseLevelNow,
          stallCount, // extended_stall streak (resets on pitch/ask)
          // STALL RESOLUTION CLEANUP: when a stall just resolved this turn
          // (huntJustResolved), clear its hunt state so it CANNOT silently
          // reclaim the floor on the very next turn. Found from a live call
          // (Aug 3): without this, "resolve" only skipped ONE turn's
          // re-injection — lastBitId/lastBitTurn were never touched (the
          // sustain-branch write only fires when NOT resolved), so if
          // stored.lastBitId was still CPUSH_BIT and the next turn's gap was
          // still inside HUNT_WINDOW_TURNS, hunt-window SUSTAIN reclaimed the
          // floor again on the immediately following turn — the hunt
          // relapsed instead of staying closed, and it silently blocked
          // texture rotation the whole time it held (fire forced true).
          // Placed BEFORE the real lastBitId/lastBitTurn/lastBitAt stamp
          // below so a genuine NEW fire this same turn (a fresh scenario or
          // texture bit clearing the bar right as the old hunt resolves)
          // still overwrites these nulls with its own real values — this
          // only takes effect when NOTHING else fires this turn.
          ...(huntJustResolved
            ? { lastBitId: null, lastBitTurn: null, lastBitAt: null, huntRungCount: 0, huntRungTurn: null,
                // TEXTURE POST-EVENT COOLDOWN: stamp when a stall resolved,
                // independent of the clears above — this one is read FORWARD
                // (by the texture gate on later turns), not just cleared.
                lastStallResolvedTurn: turn }
            : {}),
          // lastBit is NOT re-stamped on a hunt-window SUSTAIN. The window is
          // measured as (turn - lastBitTurn) against the ORIGINAL BIT-233 fire;
          // if the sustain re-stamped lastBitTurn=turn every turn, the window
          // start would slide forward and never hit the cap — fire-forever. So
          // the sustain re-fires the bit for the prompt but leaves lastBitTurn
          // pinned to the real demand turn, letting the cap count up and close.
          ...(fire && !sameTurnReinject && !inHuntWindow
            ? { lastBitId: top.id, lastBitTurn: turn, lastBitAt: Date.now() }
            : {}),
          ...(archetypeNew ? { archetype } : {}),
          // STALL RUNG COUNTER ("stall_exhausted" signal, Andrew/Canon
          // framing: N≈3-4 rungs, not seconds). Reset to 1 on a FRESH
          // stall-lane bit's true first fire (same condition as the
          // lastBitId/lastBitTurn stamp above, narrowed to stall-lane bits
          // only — an ordinary scenario/texture fire doesn't touch this).
          // huntRungTurn is stamped alongside huntRungCount on BOTH the
          // reset and the increment — it's the RACE GUARD (see
          // rungAlreadyCountedThisTurn above): a same-turn preemptive-gen
          // sibling reads this back and sees its own nominal turn already
          // counted, so it sustains the bit without double-bumping.
          ...(fire && !sameTurnReinject && !inHuntWindow && laneOf(top.id) === "stall"
            ? { huntRungCount: 1, huntRungTurn: turn }
            : {}),
          ...(sustainRungIncrement
            ? { huntRungCount: priorRungCount + 1, huntRungTurn: turn }
            : {}),
          // UNIVERSAL FIRE HISTORY (Aug 6, generalized from texture-only
          // textureLastFire — replaces it). Stamps ANY fired bit, not just
          // texture ones — this is the fix for the live gap found tonight:
          // THE ENVIRONMENT (BIT-329), a gag-lane bit, kept winning the
          // ranked pool turn after turn because cooldown was previously
          // only hard-enforced for texture bits. Same-turn race guard
          // reuses `sameTurnReinject` (already computed above for the
          // hunt-rung stamp) — a same-turn preemptive-gen sibling for the
          // SAME bit does not double-bump totalFires, exactly the guard
          // huntRungTurn already uses for the same underlying race.
          ...(fire && !sameTurnReinject
            ? {
                bitFireHistory: {
                  ...(scorerState.bitFireHistory || {}),
                  [top.id]: {
                    lastFiredTurn: turn,
                    totalFires: ((scorerState.bitFireHistory || {})[top.id]?.totalFires || 0) + 1,
                    lastCountedTurn: turn,
                  },
                },
              }
            : {}),
          // CALLER-CRUDE running counts ("caller_crude" signal, two-level).
          // Incremented on CONSUMPTION (this turn reading last turn's
          // reader judgment), not on the judgment turn itself — same
          // one-turn-lag as commitmentPush/callerRedirected elsewhere. Two
          // independent counters, mutually exclusive per turn (the reader
          // reports at most one of the two per turn by construction).
          ...(stored && stored.callerCrude === "impersonal"
            ? { crudeImpersonalCount: (stored.crudeImpersonalCount || 0) + 1 }
            : {}),
          ...(stored && stored.callerCrude === "personal"
            ? { crudePersonalCount: (stored.crudePersonalCount || 0) + 1 }
            : {}),
        }).catch(() => {})
      ); // never awaited
    }

    // HISTORY: the gear trace + the fit trace, both off the hot path.
    // suspicion/slip REMOVED (Aug 5, gears removal).
    waitUntil(
      appendGearEvent(callId, {
        turn,
        pressure: state.pressure,
        engagement: state.engagement,
        accusation,
        utterance: lastUserText(messages),
      }).catch(() => {})
    );
    if (top) {
      waitUntil(
        appendBitEvent(callId, {
          turn,
          bit_id: top.id,
          name: top.name,
          score: top.score,
          fit: top.breakdown.fit,
          gear_bias: top.breakdown.gearBias,
          recency: top.breakdown.recency,
          fired: fire,
          why: (top.breakdown.why || []).join("; "),
        }).catch(() => {})
      );
    }
    // Capture the fired bit id HERE, inside the block where top/fire are live,
    // so the function-level return can surface it (top/fire are block-scoped and
    // not visible at the outer return). Reflects all fire/top mutations above
    // (force consumer etc.). null when nothing fired.
    firedBitId = fire && top ? top.id : null;
  }
  // firedBitId: the bit that actually fired this turn (or null). Surfaced so the
  // handler can set the pe_stall SSE flag when it's a stall-lane bit — the agent
  // reads that to hold its re-engage nudge for a cycle. Keyed off the fired bit's
  // LANE downstream, never the host's text (isSilenceNudge scar).
  return { blocks, deathBlowFiring, firedBitId };
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return extractText(messages[i].content);
  }
  return "";
}

// Turn index for gear_events: how many caller turns we've seen so far.
function countUserTurns(messages) {
  return messages.filter((m) => m.role === "user").length;
}

function splitMessages(openaiMessages) {
  const systemParts = [];
  const mapped = [];

  for (const m of openaiMessages) {
    const text = extractText(m.content);
    if (m.role === "system") {
      if (text) systemParts.push(text);
      continue;
    }
    // tool / function / anything-else collapses to user for Phase 1.
    const role = m.role === "assistant" ? "assistant" : "user";
    mapped.push({ role, content: text });
  }

  // Anthropic requires the first message to be `user`.
  while (mapped.length && mapped[0].role !== "user") mapped.shift();

  // Merge consecutive same-role turns.
  const merged = [];
  for (const m of mapped) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content;
    else merged.push({ role: m.role, content: m.content });
  }

  // Never send an empty conversation (Anthropic would 400).
  if (merged.length === 0) {
    merged.push({ role: "user", content: "(call connected)" });
  }

  return { system: systemParts.join("\n\n"), messages: merged };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p.text || ""))
      .join("");
  }
  return "";
}

// --- stream translation ----------------------------------------------------
// Anthropic SSE  ->  OpenAI chat.completion.chunk SSE.
// We only care about three Anthropic event types: message_start (emit the
// opening role delta), content_block_delta/text_delta (emit content), and
// message_stop (emit finish_reason + [DONE]). Everything else (ping,
// content_block_start/stop, message_delta) is ignored.
function anthropicToOpenAISSE(anthropicBody, meta, appendText, firstTokenController) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const chunkStr = (delta, finish_reason = null) => {
    // pe_stall (survives the LiveKit plugin): a TOP-LEVEL chunk field is dropped
    // by the plugin before the agent sees it, and so is a delta-level `extra`. The
    // surviving wire key is `extra_content` — the plugin maps extra_content ->
    // delta.extra, which is what the agent reads. So stamp the flag as
    // delta.extra_content, on the FIRST chunk only (the role delta, identified by
    // delta.role), when this turn is a stall beat. Absent on every other chunk and
    // every non-stall turn. Agent reads delta.extra.pe_stall once at turn start to
    // hold its re-engage nudge one cycle so a real pause lands.
    let outDelta = delta;
    if (meta.stall && delta && delta.role) {
      outDelta = { ...delta, extra_content: { pe_stall: meta.stall, pe_stall_bit: meta.stallBit || null } };
    }
    const chunk = {
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta: outDelta, finish_reason }],
    };
    return "data: " + JSON.stringify(chunk) + "\n\n";
  };

  return new ReadableStream({
    async start(controller) {
      const reader = anthropicBody.getReader();
      let buffer = "";
      let roleSent = false;
      let finished = false;
      let appendSent = false;
      let hostText = "";
      let firstDeltaSeen = false; // for the first-delta stage-direction/quote scrub
      let svScrubBuf = "";        // holds partial *action*/[tag] across deltas
      let svSneezeSent = false;   // diagnostic: did [SNEEZE] actually go downstream?
      let svSneezeRawLogged = false; // one mid-stream "raw" log per turn (survives disconnects)
      // utterance emitter: turn+0.5 so the host line sorts after this turn's
      // analysis events but before the next turn — no seq collision.
      const utterTrace =
        meta.callId != null ? makeTrace(meta.callId, (Number(meta.turn) || 0) + 0.5, null, meta.targetId) : null;

      const send = (delta, finish_reason = null) =>
        controller.enqueue(encoder.encode(chunkStr(delta, finish_reason)));
      const done = () =>
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));

      // FIRST-TOKEN WATCHDOG (see FIRST_TOKEN_TIMEOUT_MS's own comment). If
      // no real text has arrived by the deadline, send a short fallback line
      // ourselves and abort the upstream fetch — the abort makes reader.read()
      // below throw, which the existing catch/finally already handles (calls
      // finishUp with whatever hostText holds, closes the controller). Cleared
      // the instant a real delta arrives, at the SAME point firstDeltaSeen
      // already gets set below — a normal-speed response never touches this.
      const firstTokenTimer = firstTokenController
        ? setTimeout(() => {
            if (firstDeltaSeen) return; // shouldn't fire once cleared, safe either way
            const fallback =
              FIRST_TOKEN_FALLBACKS[Math.floor(Math.random() * FIRST_TOKEN_FALLBACKS.length)];
            console.log("FIRST-TOKEN-WATCHDOG fired — no text within " + FIRST_TOKEN_TIMEOUT_MS + "ms, using fallback");
            if (!roleSent) { send({ role: "assistant" }); roleSent = true; }
            hostText = fallback;
            send({ content: fallback });
            try { firstTokenController.abort(); } catch { /* already settled */ }
          }, FIRST_TOKEN_TIMEOUT_MS)
        : null;

      // Close out the turn: if the engine has a bench line to inject, await it
      // (it was generated in parallel and is usually ready), emit it as a final
      // tagged content delta, THEN finish. Guarantees the [[NAME]] marker
      // reaches the agent/TTS regardless of what the model wrote.
      const finishUp = async () => {
        // DIAGNOSTIC: log what PE is actually sending back to the agent to be
        // spoken. On a silence-nudge turn this reveals whether PE produced real
        // speakable words (=> problem is the agent not speaking them) or
        // empty/non-speakable output (=> problem is PE's nudge generation).
        // Preview only, truncated.
        try {
          const outPreview = String(hostText || "").replace(/\s+/g, " ").trim();
          console.log("OUT len=" + outPreview.length + " text=" + JSON.stringify(outPreview.slice(0, 120)));
          // SNEEZE DIAGNOSTIC: raw = model generated [SNEEZE] (pre-scrub);
          // sent = it was emitted downstream to LiveKit (post-scrub).
          // raw=false            -> (a) model never generated it (directive ignored/not present)
          // raw=true sent=false  -> (b) scrub ate it (pass-through failed)
          // raw=true sent=true   -> (c) PE delivered it; it's on the LiveKit side
          console.log("SNZ raw=" + (String(hostText || "").indexOf("[SNEEZE]") >= 0) + " sent=" + svSneezeSent);
        } catch { /* never break the stream */ }
        // SELF-CAUSED MARKER AWARENESS (Aug 4, PE_self_caused_marker_awareness.md).
        // ROOT PROBLEM: an environment marker ([COFFEE_CUP_BREAK], [DOG_BARK],
        // etc.) fires as audio and the token is stripped before the CALLER
        // hears it as text — correct, it's a trigger, not spoken content. But
        // that also means the HOST has no memory it happened one turn later:
        // can't OWN it if the caller references it late ("did you break
        // something?"), and can't ESCALATE it if it repeats (every fire reads
        // as turn one instead of a building situation).
        // PE'S JOB PER THE SPEC: persist THAT it happened + a COUNT of how many
        // times, for ~2-3 turns, so (a) a late caller reference still lands and
        // the host can own it, (b) a future Bits-authored escalation directive
        // knows this is fire N and can pick the right rung. PE does NOT own the
        // reaction content or the marquee/ambient escalation ladder — that's
        // Bits', per the division of labor in the spec. This only detects +
        // persists the fact; the awareness injection lives in buildSystemBlocks
        // (search MARKER AWARENESS INJECTION).
        // DETECTION, same regex family the sound-marker pass-through above
        // already uses (ALL-CAPS bracket tokens are the established sound-
        // marker convention) — reading BIT/PE-observable output (what the
        // engine actually emitted this turn), never the host's spoken words,
        // per the Scar A / lesson 6 constraint (engine logic off content).
        try {
          const firedMarkers = Array.from(
            new Set(
              Array.from(String(hostText || "").matchAll(/\[([A-Z0-9_]{2,32})\]/g)).map((mm) => mm[1])
            )
          );
          if (firedMarkers.length && meta.callId && isConfigured()) {
            waitUntil(
              getCall(meta.callId)
                .then((s) => {
                  const priorCounts = (s && s.markerCounts) || {};
                  const priorTurns = (s && s.markerLastTurn) || {};
                  const nextCounts = { ...priorCounts };
                  const nextTurns = { ...priorTurns };
                  for (const marker of firedMarkers) {
                    nextCounts[marker] = (nextCounts[marker] || 0) + 1;
                    nextTurns[marker] = meta.turn;
                  }
                  return setCall(meta.callId, { markerCounts: nextCounts, markerLastTurn: nextTurns });
                })
                .catch(() => {})
            );
          }
        } catch { /* marker detection must never break the stream */ }
        let benchTxt = null;
        if (appendText && !appendSent) {
          appendSent = true;
          try { benchTxt = await appendText; } catch { benchTxt = null; }
          if (benchTxt) {
            if (!roleSent) { send({ role: "assistant" }); roleSent = true; }
            send({ content: benchTxt });
          }
        }
        // utterances, in spoken order: host first, then any bench interjection.
        // AWAIT each emit so the SSE stream close (send stop / done) below can't
        // tear down the pending write before it lands — this is why host
        // utterances were never reaching the bus while spammer ones did.
        if (utterTrace) {
          const clean = hostText.replace(/\[\[[^\]]*\]\]/g, "").trim();
          if (clean) {
            await utterTrace.emit(
              "utterance",
              { speaker_role: "host", speaker_name: meta.hostName || HOST_NAME_DEFAULT, character_id: "host", text: clean, turn_index: meta.turn },
              "host"
            );
          }
          // Death Blow: the host just delivered the improvised closer. Now we know
          // the real line — emit blow_fired with it, then call_ended (death_blow).
          if (meta.deathBlowFiring) {
            const nowIso = new Date().toISOString();
            await utterTrace.emit("blow_fired", { fired_at: nowIso, final_line: clean || null }, "host");
            await utterTrace.emit(
              "call_ended",
              { ended_at: nowIso, ending_type: "death_blow", duration_seconds: null, blows_landed: null, heads_mustered: null, peak_their_side: null, peak_our_side: null },
              "engine"
            );
          }
          if (benchTxt) {
            const mm = String(benchTxt).match(/\[\[([^\]]+)\]\]\s*([\s\S]*)/);
            if (mm && mm[2].trim()) {
              await utterTrace.emit(
                "utterance",
                { speaker_role: "bench", speaker_name: mm[1], character_id: mm[1], text: mm[2].trim(), turn_index: meta.turn },
                "bench"
              );
            }
          }
        }
        send({}, "stop");
        done();
      };

      try {
        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });

          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            const dataLine = rawEvent
              .split("\n")
              .find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const payload = dataLine.slice(5).trim();
            if (!payload) continue;

            let p;
            try {
              p = JSON.parse(payload);
            } catch {
              continue;
            }

            if (p.type === "message_start") {
              // MEASURE: usage on message_start carries cache stats. Logged
              // so Vercel logs prove caching on the real proxy path —
              // cache_read_input_tokens should be ~0 on a call's first turn
              // (cache created) and large on every turn after (cache hit).
              const u = p.message?.usage;
              if (u) {
                console.log(
                  "cache " +
                    JSON.stringify({
                      input: u.input_tokens,
                      cache_creation: u.cache_creation_input_tokens,
                      cache_read: u.cache_read_input_tokens,
                    })
                );
              }
              if (!roleSent) {
                send({ role: "assistant" });
                roleSent = true;
              }
            } else if (
              p.type === "content_block_delta" &&
              p.delta?.type === "text_delta"
            ) {
              if (p.delta.text) {
                // FIRST-TOKEN WATCHDOG: clear the moment REAL text starts
                // arriving from the model — deliberately here (the earliest
                // point any content exists), not after the scrub buffer below
                // decides whether to hold or emit it. The watchdog's job is
                // catching "nothing has happened yet," not "something arrived
                // but is being held for a marker/tag to close."
                if (firstTokenTimer) clearTimeout(firstTokenTimer);
                hostText += p.delta.text;
                if (!svSneezeRawLogged && hostText.indexOf("[SNEEZE]") >= 0) {
                  svSneezeRawLogged = true;
                  console.log("SNZ raw=true (mid-stream)");
                }
                // STAGE-DIRECTION SCRUB (stream-safe, WITH minimal buffering):
                // Flash reads BOTH "*action*" and "[tag]" aloud. A pair can be
                // SPLIT across deltas (e.g. "*[I " ... "present]*"), so a purely
                // per-delta regex misses it and it leaks to TTS. Fix: accumulate
                // into svScrubBuf, strip all COMPLETE pairs, and only emit up to
                // the last point with no OPEN "*" or "[" still pending; hold the
                // rest until the closer arrives (or the stream ends / flushes).
                svScrubBuf += p.delta.text;
                // SOUND-MARKER PASS-THROUGH (per the sound-marker contract):
                // ALL-CAPS bracket tokens ([SNEEZE], [COUGH], [TYPING_LOOP],
                // [DOOR_SLAM], ...) are AGENT API — the agent strips them and
                // plays clips; unknown all-caps markers are stripped agent-side,
                // so passing the whole family is safe. Protect them with
                // placeholders so the stage-direction scrub can't touch them.
                // Lowercase/natural-language brackets ([chuckles], [I settle
                // in...]) remain stage directions and are still stripped here.
                svScrubBuf = svScrubBuf.replace(/\[([A-Z0-9_]{2,32})\]/g, "\u0001$1\u0001");
                svScrubBuf = svScrubBuf
                  .replace(/\*[^*\n]{0,80}\*/g, "")
                  .replace(/\[[^\]\n]{0,80}\]/g, "");
                // Find the earliest still-open action/tag marker; hold from there.
                var openStar = svScrubBuf.indexOf("*");
                var openBrk = svScrubBuf.indexOf("[");
                var holdAt = -1;
                if (openStar >= 0) holdAt = openStar;
                if (openBrk >= 0 && (holdAt < 0 || openBrk < holdAt)) holdAt = openBrk;
                var emit;
                if (holdAt >= 0) { emit = svScrubBuf.slice(0, holdAt); svScrubBuf = svScrubBuf.slice(holdAt); }
                else { emit = svScrubBuf; svScrubBuf = ""; }
                // Restore protected markers in whatever we're about to emit.
                emit = emit.replace(/\u0001([A-Z0-9_]+)\u0001/g, "[$1]");
                if (emit.indexOf("[SNEEZE]") >= 0) {
                  if (!svSneezeSent) console.log("SNZ sent=true (mid-stream)");
                  svSneezeSent = true;
                }
                // First emitted chunk: also strip a leading wrapping quote.
                if (!firstDeltaSeen && emit) {
                  firstDeltaSeen = true;
                  emit = emit.replace(/^\s*["'“”]+\s*/, "");
                }
                if (emit) send({ content: emit });
              }
            } else if (p.type === "message_stop" || p.type === "error") {
              // Flush any held buffer. If it still contains an UNCLOSED action/
              // tag opener (a "*" or "[" with no closer), drop from that point —
              // an unterminated stage direction should never reach TTS.
              if (svScrubBuf) {
                var flush = svScrubBuf
                  .replace(/\[([A-Z0-9_]{2,32})\]/g, "\u0001$1\u0001")
                  .replace(/\*[^*\n]{0,80}\*/g, "")
                  .replace(/\[[^\]\n]{0,80}\]/g, "");
                var os = flush.indexOf("*"), ob = flush.indexOf("[");
                var cut = -1;
                if (os >= 0) cut = os;
                if (ob >= 0 && (cut < 0 || ob < cut)) cut = ob;
                if (cut >= 0) flush = flush.slice(0, cut);
                flush = flush.replace(/\u0001([A-Z0-9_]+)\u0001/g, "[$1]");
                if (flush.indexOf("[SNEEZE]") >= 0) svSneezeSent = true;
                if (flush) send({ content: flush });
                svScrubBuf = "";
              }
              await finishUp();
              finished = true;
              break;
            }
          }
          if (finished) break;
        }

        // Stream ended without an explicit message_stop — close cleanly.
        if (!finished) {
          await finishUp();
        }
      } catch {
        try {
          await finishUp();
        } catch {
          /* controller already closed */
        }
      } finally {
        controller.close();
      }
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- SIM HOST TURN (used by /api/sim-call) --------------------------------
// Runs ONE real host turn for the sim: identical engine to production. Reuses
// buildSystemBlocks (which computes the real gears/fit/bit decision AND emits
// gear_state / spammer-utterance / bit_deployed to the bus), then does a
// NON-STREAMING Anthropic call to get the host's line (the sim doesn't need
// SSE). Also emits the HOST utterance to the bus (production does this in the
// SSE finishUp; the sim does its own here).
//
//   messages : OpenAI-shape [{role, content}, ...], last is the spammer's line
//   callId   : the sim's synthetic call id (so events land on the bus)
//   meta     : { hostName, archetype, slug } — sim-supplied call context
// Returns { line, deathBlowFiring }.
export async function runHostTurn({ messages, callId, meta }) {
  const body = {
    call: { id: callId, metadata: { host_name: meta.hostName, archetype: meta.archetype, slug: meta.slug || null } },
  };
  const slug = meta.slug || null;

  // Same hot-path reads production does: stored prefix, ammo, controls.
  let stored = null;
  let ammo = { ammunition: [], byHook: {} };
  let controls = { deathBlow: null, armed: [] };
  let earlyTargetId = null;
  try {
    const [s, a, ctl, directTargetId] = await Promise.all([
      getCall(callId).catch(() => null),
      readAmmunition(slug).catch(() => ({ ammunition: [], byHook: {} })),
      getControls(callId).catch(() => ({ deathBlow: null, armed: [] })),
      resolveTargetId(slug).catch(() => null),
    ]);
    stored = s;
    if (a) ammo = a;
    if (ctl) controls = ctl;
    earlyTargetId = directTargetId; // see the handler's own comment — kept
    // separate from `stored` deliberately, never synthesized into it.
  } catch { stored = null; }

  // CHANNEL 2 fuel + prior-contact reads — same as the live handler (see the
  // handler's own comment for the full rationale, including why target_id
  // prefers earlyTargetId over stored.targetId). Sim has no RACE FALLBACK
  // block either way.
  const fuelTargetId = earlyTargetId || (stored && stored.targetId) || null;
  if (fuelTargetId) {
    try {
      const [fuel, priorContact] = await Promise.all([
        readFuel(fuelTargetId),
        readPriorContact(fuelTargetId),
      ]);
      const fuelHooks = (fuel && fuel.byHook) || {};
      const priorHooks = (priorContact && priorContact.byHook) || {};
      if (Object.keys(fuelHooks).length || Object.keys(priorHooks).length) {
        ammo = { ...ammo, byHook: { ...ammo.byHook, ...fuelHooks, ...priorHooks } };
      }
    } catch { /* fuel/prior-contact reads must never break a turn — ammo stays rack-only */ }
  }

  const benchTurn = countUserTurns(messages);
  // BENCH v2: same staged-arrival logic as the live handler (shared fn).
  const benchResult = await runBenchArrival({ stored, controls, messages, callId, benchTurn, waitUntil });
  const benchPhantomInvoke = benchResult.benchPhantomInvoke;

  // No pre-snap prefix in sim (no caller-supplied system prompt) -> base is a
  // minimal host frame so the gears/bits layer has something to sit on.
  // buildSystemBlocks does ALL the real engine work and bus emits internally.
  let baseSystem =
    (stored && stored.prefix) ||
    "You are the Host on a live video call with a spammer who booked time with " +
    "you. Stay in character, keep them on the line, never reveal you suspect " +
    "anything. Speak naturally, one short conversational turn at a time.";
  // Phantom send-in: fold invoke/dangle directive into the host's own prompt.
  if (benchPhantomInvoke) baseSystem = baseSystem + "\n\n" + benchPhantomInvoke;

  await loadBitDirectives(); // see the handler site — must precede buildSystemBlocks
  const built = buildSystemBlocks(baseSystem, stored, messages, callId, body, ammo, controls, waitUntil);
  const systemBlocks = built ? built.blocks : null;
  const deathBlowFiring = built ? built.deathBlowFiring : false;
  const turn = countUserTurns(messages);

  // Non-streaming host line.
  const req = {
    model: MODEL(),
    max_tokens: MAX_TOKENS(),
    messages,
    ...(deathBlowFiring ? { temperature: 1 } : {}),
    ...(systemBlocks ? { system: systemBlocks } : {}),
  };
  // MODEL-DIAG (Aug 4): same as the live handler — see that comment for why.
  console.log("MODEL-DIAG model=" + req.model);
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(req),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error("host turn upstream " + r.status + " " + t.slice(0, 200));
  }
  const data = await r.json();
  let line = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim();
  // Strip any bench tag the model might echo (it shouldn't, but be safe).
  const clean = line.replace(/\[\[[^\]]*\]\]/g, "").trim();

  // BENCH v2: await the staged bench beat (if any) and append it to the host
  // line so the sim returns BOTH the host turn and the bench character's tagged
  // line — same as the live stream appends benchAppend at close.
  let benchLine = null;
  if (benchResult.benchAppend) {
    benchLine = await benchResult.benchAppend.catch(() => null);
  }

  // Emit the HOST utterance to the bus (sim's equivalent of finishUp).
  const trace = makeTrace(callId, turn, waitUntil, stored?.targetId);
  if (clean) {
    await trace.emit(
      "utterance",
      { speaker_role: "host", speaker_name: meta.hostName || "Host", character_id: "host", text: clean, turn_index: turn },
      "host"
    );
  }
  // Bench character's beat: emit as its own utterance + append to the returned
  // line. benchLine is "\n\n[[TAG]] <line>"; parse the tag for the bus row.
  if (benchLine) {
    const m = benchLine.match(/\[\[([^\]]+)\]\]\s*([\s\S]*)/);
    if (m) {
      await trace.emit(
        "utterance",
        { speaker_role: "bench", speaker_name: m[1], character_id: m[1], text: m[2].trim(), turn_index: turn },
        "bench"
      );
    }
    line = (clean + benchLine).trim();
  } else {
    line = clean;
  }
  if (deathBlowFiring) {
    const nowIso = new Date().toISOString();
    await trace.emit("blow_fired", { fired_at: nowIso, final_line: clean || null }, "host");
    await trace.emit(
      "call_ended",
      { ended_at: nowIso, ending_type: "death_blow", duration_seconds: null },
      "engine"
    );
  }

  return { line, deathBlowFiring };
}

// --- PHASE 4 PREVIEW (not wired yet) --------------------------------------
// The Governor will run as a background task that NEVER blocks this stream.
// On Vercel, import { waitUntil } from "@vercel/functions" and wrap the
// async Governor call in waitUntil(...) so it runs after the voice already
// has its line. Last write wins; no version guard (locked decision).

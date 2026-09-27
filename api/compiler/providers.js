// SpamViking — Posture Engine: compile-input PROVIDERS
// ----------------------------------------------------------------------
// The four-document merge needs four inputs. TWO are now real:
//   [2] BIT LOADOUT  -> reads api/compiler/_bits_directives.js (BIT-xxx -> directive prose)
//   [3] reframed bench -> compiler/compile.js (in assemble.js)
// The other two — HOST BASE and CALL CONTEXT — are still STUBBED here behind a
// stable interface, so when their threads ship compiled output they drop in
// without touching assemble.js.
//
// HOST BASE and CALL CONTEXT bodies below are LOUD PLACEHOLDERS. Replace the
// bodies, keep the signatures.
// ----------------------------------------------------------------------
// CUT (Aug 10, PE code-cut certification) — POSTURES require() removed. The
// host is now a single constant character (the Innocent); nothing selects
// from "the Eight" anymore. See hostBaseFor()/postureSuffix() below for the
// rest of this cut.
// BIT LOADOUT source: prose directives keyed by canonical BIT-xxx id.
// Authored by the Bits chat from the Bits Library (v5.6+). Parked bits
// (BIT-601..608) are intentionally ABSENT (no producer) — a missing id is
// skipped, never fatal: the call still runs, that bit just doesn't load.
let BITS = {};
try {
  BITS = require("./_bits_directives.js");
} catch (e) {
  // _bits_directives.js not present yet — loadout falls back to a visible notice rather
  // than crashing the whole prefix assembly.
  BITS = {};
}
// [1] HOST BASE — the universal Master Host Prompt (SHIPPABLE, real now).
// Source of truth: SpamViking_Master_Host_Prompt.md (Prompt Library v2.14 §5.1
// = v3.0 opening fix + restraint + returning-after-a-bit + phrase-selection +
// plant-and-leave). Per that doc's compiler notes: this base is UNIVERSAL and
// CONSTANT across postures — it does NOT vary per posture. The per-posture
// register (The Six) is a SEPARATE layer added on top (the posture line below).
// Source-first: the .md is canonical; if it changes, re-transcribe HERE (never
// edit here and back-port). Inlined (edge-safe) — no runtime file read.
// MASTER_HOST_PROMPT — render v2.1 SECTIONED (2026-08-09), from HOST_CANON.
// Supersedes v2.0. ONE isolated change, confirmed via direct diff against
// the live file before splicing (not assumed from Canon's description
// alone): the opener-recovery "already-talking" line expanded from a
// short phrase into an explicit call-out of the failure mode — landing
// the recovery on ONE thing is not the same as ALSO greeting, ALSO saying
// their name, AND ALSO handing them the floor in the same breath ("that
// stack is the failure"). Greeting, name, and floor-handoff are each their
// own later turn now, explicitly. This is the "Canon half" of the
// opener-stack fix Canon flagged (Aug 9) — the complementary "mechanical
// clamp for stacking on business turns" is still real, outstanding PE
// work, not solved by this prompt change.
//
// v2.0 SECTIONED (2026-08-07), from HOST_CANON.
// Supersedes v1.9. TWO changes bundled in Canon's paste — flagging both
// explicitly since only one was described in the cover note:
//
// 1. THE MARKER-NARRATION FIX (what Canon's message described). Three
// moves against the [LAUGHS]-hallucination / prose-narration-instead-of-
// marker bug: (a) IMPERATIVE — "emitting it verbatim is REQUIRED — it is
// the correct, in-character move" (was softer "the ban does not apply to
// it"); (b) INVERTED-BREAK — prose narration is now explicitly NAMED as
// the failure ("that prose narration IS the failure, the thing that
// breaks the moment"), flipping which behavior reads as the actual break;
// (c) SILENT-CONTROL-TOKEN reframe — "a silent control token, like a
// lighting cue in a script" replaces "technical trigger," AND the literal
// string "[LAUGHS]" is removed from both mentions (replaced with "never as
// a bracketed token") — directly addresses the diagnosis that showing the
// model a specific forbidden bracket-shaped string, even as a negative
// example, risked reinforcing the exact pattern it was banning.
//
// 2. UNDISCLOSED SECOND CHANGE — a full time/day anchoring rule, not
// mentioned in Canon's cover note at all. New REMEMBER bullet ("You don't
// know what time or day it is..."), plus every time/day reference
// stripped from CORE and OPENER (afternoon, "the hour," "Long day
// already?", "it's Monday, it's late afternoon"), replaced with
// content-neutral alternatives (a complaint about their printer instead
// of "long day," the sound/feel of the line instead of the hour). Real,
// reasonable-looking content — but bundled in without being called out,
// worth Andrew knowing it wasn't just the marker fix.
//
// v1.9 SECTIONED (2026-08-06), from HOST_CANON.
// Supersedes v1.8. Canon sent a full doc re-sync; diffing it against the
// live v1.8 body surfaced REAL drift, not just a confirmation paste — the
// BUSINESS overlay was missing the entire Barbara paragraph (the colleague
// who handles scheduling/booking, kept explicitly separate from the
// approver stall) and the "vary the gatekeeper role every call, never say
// the bare word 'approver' out loud" instruction. Both now correctly
// present. CORE itself (the anti-break/never-refuse frame Canon's message
// described) was confirmed byte-identical already — that part really had
// synced cleanly; the drift was isolated to BUSINESS. Found by diffing the
// actual live file against Canon's paste line-for-line rather than trusting
// "sources match" at face value.
//
// v1.8 SECTIONED (2026-08-06), from HOST_CANON.
// Supersedes v1.7. ONE change: the CORE-slimming audit's third and final
// item, unblocked today. Removed the static "WHEN THEY SAY SOMETHING CRUDE
// OR HOSTILE" paragraph entirely — it's now fully redundant with the
// dynamic caller_crude injection (Canon's real text, shipped the same day),
// which only fires on the turns crude language actually appears, with
// count-aware escalation the static paragraph could never do. Every call
// was previously paying the token cost of this paragraph whether or not
// crude ever came up. DEPLOY-COUPLED DECISION: CALLER_CRUDE_DETECT MUST be
// flipped to 1 in the SAME deploy as this prefix change — cutting the
// static text without the dynamic replacement active would leave the host
// with zero crude-handling guidance at all, a real behavioral gap, not a
// clean swap. Two of the CORE audit's three recommended moves were already
// resolved as "stays as-is" (IF-THEY-GO-QUIET, WHEN-YOUR-WORLD-INTRUDES);
// this was the one genuinely waiting on real content, and now it's done.
//
// v1.7 (2026-08-05), from HOST_CANON. Supersedes v1.6 (the prune). Two real
// fixes, both a direct response to
// live-call findings from the same test session, not speculative this time:
//
// 1. FOLLOW-DON'T-LEAD ON TOPIC SELECTION. A live call (Sonnet, confirmed
// via MODEL-DIAG — not a capacity artifact) showed the host repeatedly
// closing its own tangents with "anyway—" and pivoting to a topic it chose,
// instead of handing the floor back to the caller — the caller explicitly
// flagged it: "He said anyway and moved to another topic. I don't like
// that." New language in CORE's CONNECT-WHAT-THEY-SAY-TO-YOUR-OWN-WORLD
// section names the failure mode directly: "The one thing you never do
// coming off a tangent is grab the wheel and drive to a fresh topic of your
// own — that leads instead of follows, and it leaves them nothing to push
// against," with a concrete handoff line ("—sorry, I got going there. You
// were saying?"). Matching tightening in BUSINESS overlay's DANGLE section.
// NOTE: this does NOT touch the OTHER violation found in the same call —
// stacked questions in one turn (ONE BEAT THEN STOP) — confirmed BYTE-
// IDENTICAL, untouched on purpose; Canon is deliberately holding that one
// until PE and Canon can be sure it's a real adherence gap and not another
// per-call capacity read.
//
// 2. OPENER VARIETY. Separately, the opener's MEDIUM/BIGGER/BIG example
// bank (OPENER overlay) had fixed, quotable example LINES — and across
// today's test calls the host was visibly reusing near-identical phrasing
// call to call ("—oh no, no no— okay. Sorry. Hi!" showing up repeatedly).
// Rewritten to describe the SHAPE of each tier rather than hand the model
// literal lines to fall back on, with explicit new instruction to vary the
// whole MOOD of the open (not just the words) and a named rut-check: "If
// you notice yourself reaching for 'okay — sorry — hi' or 'there we go,'
// that's the rut; go somewhere else entirely."
//
// All prior content through v1.6 carries forward unchanged underneath both
// additions — this is pure addition/rewrite of the two sections above, no
// other section touched.
//
// Body carries three ## ===== CORE/OPENER/BUSINESS delimiters for the
// phase-overlay split. splitHostPrompt() parses them; the delimiter lines
// are NOT shipped to the model. Zero asterisks in body (v0.6+ rule).
//
// TO ANSWER "what's actually deployed?" IN 5 SECONDS: this comment tells you
// what the FILE says; it does NOT prove what's LIVE. hydrate recompiles the
// prefix on every call and logs it: "hydrate OK slug=... hash=<hash>". A
// changed hash after this deploy means this render is live.
//
// v2.2 SECTIONED (2026-08-12), from HOST_CANON, rebuilt from
// Host_Prompt_SOURCE_for_providers_rebuild.md. Supersedes v2.1. This is
// the "consolidated batch" rebuild Canon flagged as the highest-leverage
// item on the board — confirmed via direct diff against the prior
// embedded content (not assumed from Canon's summary alone), every item
// Canon named is actually present:
//   - "ha" removed from the laugh-sound bank and the brush-off line
//     ("what? sorry, it's been one of those mornings" — was "ha — what?").
//   - Esq./no-honorifics: never speaks titles/suffixes off a name (no
//     "Esquire," "PhD," "CPA," job titles) — never sounds like reading a
//     name off a card.
//   - Marker-carve-out reframe: the DOG_BARK worked example changed from
//     "he loses it every time the phone connects" to "she's got opinions
//     about the mailman." WORTH RE-TESTING POST-DEPLOY: every real call
//     tonight where DOG_BARK fired had the host recite the OLD example
//     nearly verbatim, not improvise fresh flavor — that's a "model
//     echoes the literal example" pattern, not a per-call novelty
//     problem, and swapping which line is offered doesn't obviously fix
//     the underlying pattern. Check whether the host now recites the
//     mailman line verbatim across multiple calls.
//   - Join-a-call-not-answer-a-phone: new explicit section — no ring, no
//     click, no dial tone, no "picking up," you're just already on the
//     line.
//   - Barbara (scheduling/booking colleague, kept separate from the
//     approver stall) and bench-familiarity framing ("you know this
//     person: <line>" delivered warmly, never like a roster entry).
//   - Approver-freshening: explicit instruction to vary WHO the
//     gatekeeper is every call and never say the bare word "approver."
//   - No-clock: host doesn't know the time/day/season at all now.
//   - Energy revision and the rest of the accumulated batch per Canon's
//     summary — not itemized individually here, but the whole file is a
//     verbatim byte-for-byte embed of the source doc (verified via diff
//     after embedding), so whatever Canon's source contains is what
//     shipped, not a hand-transcribed subset.
// splitHostPrompt() re-run against this content directly (not assumed) —
// core/opener/business all extract cleanly, business overlay correctly
// ends on the "ALWAYS, EVEN HERE" tail echo.
//
// v2.3 SECTIONED (2026-08-14), from HOST_CANON, rebuilt from
// Host_Prompt_SOURCE_for_providers_rebuild.md. Supersedes v2.2. Two
// real changes, confirmed via direct diff against the prior embedded
// content (not assumed):
//   - Name-usage tightened: was "first name, or first-and-last" —
//     now FIRST NAME ONLY, ever. Never "William Goldberg," never
//     "William Goldberg, Esq." — just "William." One step further
//     than v2.2's Esq./no-honorifics rule, same underlying goal (never
//     sound like reading a name off a card).
//   - New section added to the BUSINESS overlay, right before the
//     "ALWAYS, EVEN HERE" tail echo: "WHEN YOUR WORLD INTRUDES" — the
//     first time the comedy-design gag-arc (react as yourself → one
//     beat, stop → turn outward with a bid a turn or two later →
//     dangle, never front-load) has actually landed in the live Host
//     Prompt itself, not just the design doc. Also adds an explicit
//     split for what happens when an interruption lands MID-BIT
//     (stall/hunt/stepped thing in progress) vs. mid-ramble: mid-bit,
//     hear what they said and either go with them, carry the thread a
//     beat further, or let it fall away — never barrel on as if they
//     hadn't spoken, never restart the bit from the top.
// splitHostPrompt() re-run again against THIS content — core/opener/
// business all extract cleanly, business overlay confirmed to contain
// the new section and still correctly ends on the tail echo. Verified
// via exact diff match against the source (not just spot-checked).
//
const MASTER_HOST_PROMPT = require("./host_prompt_source.json").prompt;
// [1] HOST BASE — the universal master prompt + this posture's register layer.
// The master prompt is constant; the posture register (name/stance) is the
// separate per-posture layer added on top, per the source doc's instruction.
// PHASE-OVERLAY SPLIT — parse MASTER_HOST_PROMPT into its three blocks on the
// "## =====" delimiter lines. The delimiter lines are removed from the emitted
// pieces (they are cut-markers, never shipped to the model). CORE is true all
// call; OPENER/BUSINESS are the swappable overlays selected by phase in
// completions.js. Returns { core, opener, business }, each blank-trimmed.
function splitHostPrompt(raw) {
  const lines = String(raw).split("\n");
  const buckets = { core: [], opener: [], business: [] };
  let cur = null;
  for (const line of lines) {
    if (/^##\s*=+\s*CORE/i.test(line)) { cur = "core"; continue; }
    if (/^##\s*=+\s*OPENER/i.test(line)) { cur = "opener"; continue; }
    if (/^##\s*=+\s*BUSINESS/i.test(line)) { cur = "business"; continue; }
    if (cur) buckets[cur].push(line);
  }
  const clean = (arr) => arr.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return {
    core: clean(buckets.core),
    opener: clean(buckets.opener),
    business: clean(buckets.business),
  };
}

// TURN-AWARE OPENER SPLIT (2026-09-23) — structural fix for the recurring
// turn-2+ re-mess/re-open bug (double-open, repeated "arrive out of a
// mess" landing). ROOT CAUSE, confirmed via two real-call transcripts even
// AFTER a correctly-worded, transcript-evidenced carve-out was added and
// deployed: the OPENER overlay stays in the model's context for every turn
// where phase=opening (often turns 1-3, not just turn 1), so the "arrive
// out of a mess, fumble, apologize, land on a greeting" content — several
// thousand words of it, reinforced multiple times through the section —
// keeps getting resent every one of those turns. A single carve-out
// paragraph saying "but only do this on turn one" was structurally
// outnumbered by the surrounding reinforcement it was trying to override.
// Same "negative instruction can't out-argue strong positive reinforcement"
// pattern already confirmed elsewhere (word bans, host-initiates-business).
//
// FIX: stop asking the model to resist the temptation — remove the
// temptation from what it's shown once it's already spoken. Canon marks
// the turn-1-only content (the "arrive out of a mess" block and anything
// else genuinely specific to the very first utterance) inside the OPENER
// section using two sub-markers:
//   ### OPENER SUBSECTION: TURN-ONE-ONLY
//   ### OPENER SUBSECTION: CONTINUING
// Content before the first marker, or outside either marker, is treated as
// "continuing" (shown every turn) — safe default. Everything under
// TURN-ONE-ONLY is shown ONLY on turn 1 (before the host has spoken);
// everything under CONTINUING is shown every turn while phase=opening.
//
// BACKWARD COMPATIBLE BY CONSTRUCTION: if Canon's source doc has neither
// marker yet, turnOneOnly comes back empty and continuing is the ENTIRE
// opener text — completions.js's turn-1 prompt (turnOneOnly + continuing)
// equals today's full opener unchanged, and turn-2+ also gets the full
// opener unchanged (same as today) until the markers are actually added.
// Nothing regresses by shipping this ahead of Canon's source-doc update.
function splitOpenerByTurn(openerText) {
  const lines = String(openerText || "").split("\n");
  const buckets = { turnOneOnly: [], continuing: [] };
  let cur = "continuing"; // default bucket: anything before/outside a marker
  for (const line of lines) {
    if (/^###\s*OPENER SUBSECTION:\s*TURN-ONE-ONLY/i.test(line)) { cur = "turnOneOnly"; continue; }
    if (/^###\s*OPENER SUBSECTION:\s*CONTINUING/i.test(line)) { cur = "continuing"; continue; }
    buckets[cur].push(line);
  }
  const clean = (arr) => arr.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  return {
    turnOneOnly: clean(buckets.turnOneOnly),
    continuing: clean(buckets.continuing),
  };
}

// ARCHETYPE MECHANISM — REMOVED (2026-09-06), corrected within the same
// session it was built. The placeholder 5-way block-selector I built
// here assumed Canon would ship archetype content as five SEPARATE
// marked sections, chosen server-side (one injected per call, matching
// how phase overlays work). Canon's real delivery (v8 of the source
// doc) shipped something structurally different: ALL FIVE "IF THE
// ARCHETYPE IS X" conditionals as ONE integrated block, inside CORE
// itself, titled "WHICH EMOTIONAL REGISTER YOU'RE REACTING FROM — SET
// BY ARCHETYPE" — meant to ship together, every call, with the MODEL
// reading all five and self-selecting. That needs a plain FACT
// statement ("this call's archetype is X"), not a server-side content
// selector — same shape as the channel signal, now built in hydrate.js
// as formatArchetypeSignal(). No selection mechanism needed here at
// all; the real content already lives in MASTER_HOST_PROMPT via the
// normal CORE rebuild, same as everything else in CORE.

// CUT (Aug 10, PE code-cut certification) — postureSuffix() removed
// entirely. It appended a per-posture "ACTIVE POSTURE REGISTER" line
// (name/stance from POSTURES[postureId]) on top of CORE. With the host
// now a single constant character, there is no register to select or
// append — CORE alone carries the full, permanent characterization.
// hostBaseFor now returns CORE ONLY, unconditionally — the phase-independent
// character block that caches for the whole call. The OPENER/BUSINESS overlays
// are supplied separately by hostOverlaysFor and appended at send time by phase.
// Signature intentionally takes no argument anymore (was postureId) — kept
// callable with a stray argument without breaking (JS ignores extras), so
// this is safe even before every caller is confirmed updated.
function hostBaseFor() {
  const { core } = splitHostPrompt(MASTER_HOST_PROMPT);
  return core;
}
// hostOverlaysFor returns the two swappable overlays. CUT (Aug 10): no
// longer takes a postureId param at all — the prior signature kept one
// "for symmetry" with hostBaseFor's postureId, which no longer exists.
// Overlay content was already posture-independent in practice; this just
// removes the now-meaningless parameter.
function hostOverlaysFor() {
  const { opener, business } = splitHostPrompt(MASTER_HOST_PROMPT);
  // TURN-AWARE OPENER SPLIT (2026-09-23) — see splitOpenerByTurn's own
  // comment for the full rationale. `opener` stays the FULL opener text
  // (turnOneOnly + continuing), unchanged in meaning from before this
  // change — used on turn 1. `openerContinuing` is the new, leaner
  // turn-2+ version with the turn-one-only content structurally absent.
  const { turnOneOnly, continuing } = splitOpenerByTurn(opener);
  return { opener, openerContinuing: continuing, openerTurnOneOnly: turnOneOnly, business };
}
// [2] BIT LOADOUT — the armed bits as in-call directives, REAL now.
// Reads each armed bit id's prose from _bits_directives.js. Ids are canonical BIT-xxx
// (matching bits_registry PKs and bit_deployments). Unknown/parked ids are
// listed quietly at the end so a missing producer is visible but non-fatal.
function loadoutFor(bitIds) {
  if (!bitIds || bitIds.length === 0) {
    return "ARMED BITS: none for this call.";
  }
  const lines = [];
  const missing = [];
  for (const id of bitIds) {
    const directive = BITS[id];
    if (directive && String(directive).trim()) {
      lines.push(`- ${id}:\n${String(directive).trim()}`);
    } else {
      missing.push(id);
    }
  }
  let out =
    "ARMED BITS (Let It Breathe — deploy only on a real opening, never to " +
    "fill a quota, never over the spammer's line):";
  if (lines.length) {
    out += "\n\n" + lines.join("\n\n");
  } else {
    out += "\n(none of the armed bits have a directive available)";
  }
  if (missing.length) {
    // Visible but harmless: these ids had no entry in _bits_directives.js (parked, or a
    // bad id). They simply don't load; the call is unaffected.
    out += `\n\n[unloaded bit ids (no directive in _bits_directives.js): ${missing.join(", ")}]`;
  }
  return out;
}
// [3] is the reframed bench — supplied by the REAL compiler in assemble.js.
// [4] CALL CONTEXT — the call-stable fragments of Data + Product Logic
// (target dossier summary, tactic/roster routing, second-call flag, etc.).
// Real source: Data doc + Product Logic compile.
// DOSSIER FLOOR (2026-08-05, Data's scoping — see hydrate.js's readDossierFloor
// for the read side). cfg.dossierFloor is the condensed ~50-token identity +
// prior-contact string, computed once at hydrate from scout_facts and passed
// straight through here — this function does no fetching, no logic beyond
// picking which text to show. Falls back to the old placeholder when absent
// (a fresh target with no scout_facts yet, or the read failing safely) so a
// call NEVER ships with an empty/broken CALL CONTEXT line.
function callStableContext(cfg) {
  // SOUND MARKER INVENTORY (Aug 7, Voice's live boot-time scan). Built
  // separately from the CALL CONTEXT line below (own sentence, own clear
  // framing) so it reads as ground truth, not buried inside the dossier
  // text. Empty/absent soundMarkers degrades to nothing added — never
  // blocks, never fabricates a list. This is the fix for the [LAUGHS]-
  // style hallucination: giving the host an explicit, authoritative list
  // instead of letting it infer valid markers piecemeal from whichever
  // bit directive happens to mention one.
  const markerSection =
    Array.isArray(cfg.soundMarkers) && cfg.soundMarkers.length
      ? ` VALID SOUND MARKERS THIS CALL — these are the ONLY real markers ` +
        `that exist; never emit one not on this list: [` +
        cfg.soundMarkers.join(", ") + `].`
      : "";
  // HOST'S REAL WORK EMAIL (Aug 25, Andrew's ask) — same discipline as
  // dossierFloor/soundMarkers: computed once at hydrate, passed straight
  // through, no fetching or invention here. This closes a real gap — the
  // host previously had NO true email to draw from if it ever decided to
  // give out the real one (as opposed to the fake/personal-email gag,
  // which is intentionally left improvised, not structured, per Andrew's
  // narrowed scope). Absent/empty degrades to nothing added — a host with
  // no hostEmail configured just never has grounds to claim a real
  // address, matching the "never fabricate" discipline this whole file
  // already follows for dossierFloor/soundMarkers.
  const emailSection = cfg.host_email
    ? ` HOST'S REAL WORK EMAIL (ground truth, only use if genuinely giving ` +
      `out the real one, not the personal-email gag): ${cfg.host_email}.`
    : "";
  return (
    `CALL CONTEXT: ` +
    (cfg.dossierFloor
      ? cfg.dossierFloor
      : `target=${cfg.target || "<dossier summary>"}; ` +
        `[[ no dossier floor yet for this target ]]`) +
    ` tactic=${cfg.tactic || "<classifier output>"}; ` +
    `second_call=${cfg.secondCall ? "yes" : "no"}.` +
    markerSection +
    emailSection
  );
}
module.exports = { hostBaseFor, hostOverlaysFor, splitHostPrompt, splitOpenerByTurn, loadoutFor, callStableContext };

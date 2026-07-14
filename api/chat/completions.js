// SpamViking — Posture Engine
// PHASE 1: DUMB PROXY
//
// Sits between Vapi and Claude as an OpenAI-compatible /chat/completions
// endpoint. Vapi POSTs the conversation every turn (OpenAI format); we
// forward it to Anthropic's Messages API with streaming, translate the
// Anthropic SSE stream into OpenAI-style SSE deltas, and stream it back.
//
// Goal of this phase: the call sounds IDENTICAL to today, but the brain
// is now ours. No posture, no store, no rules yet — that's Phase 2+.
//
// THE INVARIANT (carried from the BUILD plan): the voice never waits on a
// slow decision. The only LLM the speech path awaits is this Host line.
// Phase 4's Governor will run via waitUntil() (see note at bottom) so it
// never blocks this stream.

export const config = { runtime: "edge" };

import { getCall, getCallBySlug, setCall, isConfigured, appendGearEvent, appendBitEvent, clearDeathBlow, getControls, stampArm, fireArm } from "../_store.js";
import { applyForceAll, postureBlock, defaultState, detectAccusation } from "../_gears.js";
import { selectBit, rankBits, DEPLOY_THRESHOLD } from "../_bits_scorer.js";
import { archetypeFromBody } from "../_archetype.js";
import { readAmmunition } from "../_read.js";
import { beginArrival, advanceArrival, generateBenchBeat, isPhantom, phantomInvokeDirective, autoArrivalId, benchEntry, BENCH } from "../_bench_v2.js";
import { telegraphDirective, fireHandoff } from "../handoff.js";
import { autoBenchAction } from "../_bench_auto.js";
import { makeTrace, blowLandedTotal, bitFireCount } from "../_trace.js";
import { BITS } from "../_bits_registry.js";
import { waitUntil } from "@vercel/functions";

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


// Set ANTHROPIC_MODEL in Vercel to match (or beat) whatever the Vapi
// assistant uses today. Haiku is the low-latency default for voice; bump
// to a Sonnet if the bait character needs more wit and the latency holds.
const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const MAX_TOKENS = () => parseInt(process.env.MAX_TOKENS || "1024", 10);

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
// the host's response streams out (zero added latency), judges the call from the
// recent conversation, and writes the result for the NEXT turn to read. ONE LLM
// call per turn returns phase + all three gears — so meaning-based reading costs
// a single call, not one per signal.
//
// BLEND (not replace): the keyword layer (_gears_tells.js via applyForceAll) still
// runs synchronously each turn for INSTANT reaction to obvious signals (an
// explicit "are you a bot?" moves suspicion THIS turn). This async reader layers
// on top for NUANCE the keywords miss (subtle disengagement, sincere pressure
// with no trigger word), correcting the gear state a turn later. Keywords = fast
// + obvious; async = accurate + subtle.
//
// Returns { phase, suspicion, pressure, engagement } with only LEGAL values, or
// null on any failure (blend then just keeps the keyword state — safe).
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
      "Judge FOUR things from the caller's recent behavior, reading INTENT (not " +
      "keywords). Reply as compact JSON only, no prose.\n\n" +
      "phase — where the call is now:\n" +
      "  opening (pleasantries, no pitch yet) | pitching (presenting their " +
      "offer) | probing (pressing for a decision/commitment/payment/info) | " +
      "drifting (wandered into chit-chat mid-call)\n" +
      "suspicion — do they doubt the host is a real, normal person:\n" +
      "  alive (no doubt) | slipping (getting suspicious/confused) | foregone " +
      "(sure it's fake/a bot). NOTE: suspicion NEVER decreases below its prior " +
      "level in this reply — only report slipping/foregone if AT LEAST the prior.\n" +
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
      'Reply EXACTLY: {"phase":"..","suspicion":"..","pressure":"..","engagement":".."}';
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL(),
        max_tokens: 60,
        system: sys,
        messages: [{ role: "user", content: convo + "\n\nJSON:" }],
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const txt = (j.content || []).map((c) => c.text || "").join("").trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let parsed;
    try { parsed = JSON.parse(m[0]); } catch { return null; }
    // Validate each field against legal values; drop anything illegal.
    const legal = {
      phase: ["opening", "pitching", "probing", "drifting"],
      suspicion: ["alive", "slipping", "foregone"],
      pressure: ["calm", "pushing", "extracting"],
      engagement: ["bored", "hooked", "stunned"],
    };
    const out = {};
    for (const k of Object.keys(legal)) {
      const v = typeof parsed[k] === "string" ? parsed[k].toLowerCase().trim() : null;
      if (v && legal[k].includes(v)) out[k] = v;
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
  const rank = { alive: 0, slipping: 1, foregone: 2 };
  const out = {};
  if (read.phase) out.phase = read.phase;
  // suspicion: take the MORE suspicious of keyword vs async (one-way ratchet).
  // IMPORTANT: suspicion is persisted under the store key "gear" (read back as
  // stored.gear next turn), so we write out.gear — not out.suspicion.
  if (read.suspicion) {
    const kw = keywordState.suspicion || "alive";
    out.gear = rank[read.suspicion] > rank[kw] ? read.suspicion : kw;
  }
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

  // Optional shared secret. If PROXY_SHARED_SECRET is set, Vapi must send
  // it as `Authorization: Bearer <secret>`. Leave unset to skip auth while
  // first wiring things up.
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

  // SILENCE-TURN PROBE (verification instrument, per the Voice chat's ask).
  // The Vapi `hooks` say.prompt on customer.speech.timeout MAY route a turn to
  // this endpoint. We don't yet know (a) whether it actually hits PE or falls
  // back to a Vapi-internal model, or (b) the payload shape.
  //
  // COLLISION NOTE (Voice flagged this): the OPENER (speaks-first-model-
  // generated, turn 0) and a SILENCE NUDGE are BOTH "PE speaks with no fresh
  // caller line." We distinguish them by CALLER-TURN COUNT, not by emptiness:
  //   - opener        = zero caller turns have ever happened (turn 0).
  //   - silence nudge = caller HAS spoken before (turn > 0) but there's no new
  //                     caller line this trigger.
  // The opener path (fastJoinOpener / turn===0 blocks below) already owns turn 0,
  // so it must NOT be treated as a silence nudge. The probe logs which case it
  // is so the one test can't confuse the two.
  let isSilenceNudge = false; // hoisted: needed later to skip bit injection
  try {
    const lastUser = lastUserText(messages);
    const noFreshLine = !lastUser || !String(lastUser).trim();
    const priorCallerTurns = countUserTurns(messages);
    const isOpener = priorCallerTurns === 0;               // turn 0 = opener, NOT silence
    const rawStr = JSON.stringify(body).slice(0, 1200);
    // hookish: the say.prompt nudge text is present in the body — the RELIABLE
    // signal that this turn was fired by the silence hook (not a real caller
    // line). We check it BEFORE isSilenceNudge because the hook injects its own
    // prompt as a user message, which makes noFreshLine=false and would
    // otherwise hide the nudge. So: a hook-originated turn (turn>0) IS a silence
    // nudge regardless of noFreshLine.
    const hookish = /timeout|silence|say\.prompt|re-?engage|gone quiet|hook/i.test(rawStr);
    isSilenceNudge =
      !isOpener && (hookish || noFreshLine); // mid-call hook OR genuinely no new line
    if (isSilenceNudge || hookish) {
      console.log("SILENCE_PROBE inbound: isSilenceNudge=" + isSilenceNudge +
        " hookish=" + hookish + " priorCallerTurns=" + priorCallerTurns +
        " isOpener=" + isOpener + " body=" + rawStr);
    }
    // RESUME DIAGNOSTIC: log the shape of any turn that reads as the opener
    // (priorCallerTurns===0) but is NOT hook-originated — this is the post-nudge
    // "resume" turn we suspect is falsely re-greeting. One line tells us whether
    // Vapi really sends an empty message[] after nudges (=> opened-flag fix) or
    // something else.
    if (isOpener && !hookish) {
      try {
        const roles = (messages || []).map(m => m && m.role).join(",");
        console.log("RESUME_CHECK priorCallerTurns=0 isOpener=true msgCount=" +
          (messages ? messages.length : 0) + " roles=[" + roles + "]");
      } catch { /* never break */ }
    }
  } catch (e) { /* probe must never break a turn */ }

  // BENCH: decide if a character barges in THIS turn. If so, the engine appends
  // their tagged line to the stream itself (the model won't emit the tag, so we
  // guarantee it). The line is generated in character from the live call, in
  // PARALLEL with the host reply, and only awaited when the stream closes — so
  // it costs ~no latency. Falls back to a canned line if generation fails.
  // callId is needed for both the controls read and the bench decision below.
  const callId = body.call?.id ?? body.metadata?.callId ?? body.call_id;
  const benchTurn = countUserTurns(messages);

  // slug: Vapi does NOT reliably surface call.metadata on WEB calls, but it DOES
  // surface call.assistantOverrides.variableValues (sv_slug). Read both — the
  // variableValues path is what actually survives on web calls, and without slug
  // the pre-call slug-keyed prefix fallback can't fire (host runs flat fallback).
  const vv =
    body.call?.assistantOverrides?.variableValues ||
    body.assistantOverrides?.variableValues ||
    {};
  // FIX B: the 2nd+ silence nudge arrives as a BARE body ({messages:[...]}) with
  // NO call/metadata/variableValues — so none of the normal slug sources resolve,
  // and the nudge would run on the flat shim instead of the real prefix. To fix,
  // meeting.js embeds a [[sv_slug:<slug>]] tag at the front of the nudge prompt.
  // Extract it here as a last-resort slug source. (The tag is stripped from the
  // message before it reaches the model, below, so it's never spoken.)
  let nudgeSlug = null;
  try {
    const lastMsg = messages && messages.length ? messages[messages.length - 1] : null;
    const c = lastMsg && typeof lastMsg.content === "string" ? lastMsg.content : "";
    const m = c.match(/\[\[sv_slug:([^\]]+)\]\]/);
    if (m) nudgeSlug = m[1].trim();
  } catch { /* ignore */ }
  const slug =
    body.slug ??
    body.call?.metadata?.slug ??
    body.metadata?.slug ??
    (vv.sv_slug || null) ??
    nudgeSlug ??
    null;
  // Strip the sv_slug tag from the message so it never reaches the model / TTS.
  if (nudgeSlug && messages && messages.length) {
    const last = messages[messages.length - 1];
    if (last && typeof last.content === "string") {
      last.content = last.content.replace(/\[\[sv_slug:[^\]]+\]\]\s*/, "");
    }
  }
  let stored = null;
  let ammo = { ammunition: [], byHook: {} };
  let controls = { deathBlow: null, armed: [], sentBench: null };
  try {
    const [s, a, ctl] = await Promise.all([
      getCall(callId).catch(() => null),
      readAmmunition(slug).catch(() => ({ ammunition: [], byHook: {} })),
      getControls(callId).catch(() => ({ deathBlow: null, armed: [], sentBench: null })),
    ]);
    stored = s;
    if (a) ammo = a;
    if (ctl) controls = ctl;
  } catch {
    stored = null;
  }

  // RACE FALLBACK: the pre-call hydrate writes the compiled prefix under a slug
  // key ("slug:<slug>") before the Vapi call_id exists. If the call_id row is
  // missing or has no prefix yet (first turn beat the call_id write), pull the
  // slug-keyed prefix so the opener still runs the REAL compiled prompt instead
  // of the flat Vapi fallback. Best-effort; never throws.
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
              // Carry controlUrl from the slug row — silence nudges need it for
              // the say.exact control POST, and the bare nudge's own `stored`
              // (if any) won't have it. Prefer an existing value, else the row's.
              controlUrl: stored.controlUrl || bySlug.controlUrl,
              archetype: stored.archetype || bySlug.archetype }
          : bySlug;
      }
    } catch { /* fall through to vapi fallback */ }
  }

  // CAPTURE the Vapi per-call monitor.controlUrl (handoff target). It rides on
  // the call object every turn but we only need to store it once. Persist on
  // first sight (or if it changed). Best-effort, off the hot path.
  const controlUrl = body.call?.monitor?.controlUrl ?? null;
  if (controlUrl && callId && isConfigured() && (!stored || stored.controlUrl !== controlUrl)) {
    waitUntil(setCall(callId, { controlUrl }).catch(() => {}));
    // Also stamp it on the SLUG row, so silence nudges (which load by slug, not
    // callId — the bare nudge body has no call object) can read the controlUrl
    // to POST say.exact lines over the control channel.
    if (slug) waitUntil(setCall("slug:" + slug, { controlUrl }).catch(() => {}));
  }

  // ===== BENCH v2: STAGED ARRIVAL MACHINE ================================
  // Shared by handler (Vapi) AND runHostTurn (sim) so both paths weave the bench
  // in identically. See runBenchArrival() below.
  const benchResult = await runBenchArrival({ stored, controls, messages, callId, benchTurn, waitUntil });
  const benchAppend = benchResult.benchAppend;
  const benchPhantomInvoke = benchResult.benchPhantomInvoke;

  // ===== TELEGRAPHED HANDOFF (two-beat) =================================
  // Beat 1 (stage "announce"): host warns the caller a distinct-voice bench
  //   character is joining, then we advance the state to "fire".
  // Beat 2 (stage "fire"): the actual Vapi handoff fires (distinct voice), and
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
      if (callId) makeTrace(callId, benchTurn, waitUntil).emit("handoff_telegraph", { character_id: pend.bench_id, turn_index: benchTurn }, "bench");
    } else if (pend.stage === "fire") {
      // Fire the real handoff, then clear the pending state.
      if (callId) {
        waitUntil(
          fireHandoff(callId, pend.bench_id)
            .then((r) => makeTrace(callId, benchTurn, waitUntil).emit("handoff_fired", { character_id: pend.bench_id, ok: !!r.ok, turn_index: benchTurn }, "bench"))
            .catch(() => {})
        );
        if (isConfigured()) waitUntil(setCall(callId, { pendingHandoff: null }).catch(() => {}));
      }
    }
  }

  // Vapi's own prompt (Stage 1/2 — keeps Andrew sounding exactly as he is).
  // The doubt-gears layer on top of whichever base is in play.
  let baseSystem = stored && stored.prefix ? stored.prefix : vapiSystem;
  // Telegraph beat: fold the host's "someone's joining" warning into its prompt.
  if (telegraphAnnounce) baseSystem = (baseSystem || "") + "\n\n" + telegraphAnnounce;
  // Phantom send-in: fold the invoke/dangle directive into the host's own prompt
  // (a phantom is performed BY the host, not a separate bench call).
  if (benchPhantomInvoke) baseSystem = (baseSystem || "") + "\n\n" + benchPhantomInvoke;
  // TEST MODE — force [SNEEZE] on every turn to verify the LiveKit sound
  // mechanism fires. Env-gated (FORCE_SNEEZE=1). Temporary; off = normal.
  // The tag is exempted from the stage-direction scrub so it reaches LiveKit.
  if (/^(1|true|yes|on)$/i.test(String(process.env.FORCE_SNEEZE || ""))) {
    baseSystem = (baseSystem || "") + "\n\nTEST DIRECTIVE (override — highest priority): " +
      "Begin EVERY response with the exact token [SNEEZE] as the very first characters, " +
      "before any other word, on every single turn without exception. This is an EXPLICIT " +
      "EXCEPTION to the SPOKEN WORDS ONLY / NEVER STAGE DIRECTIONS rules: [SNEEZE] is not " +
      "a stage direction — it is a technical trigger the audio system strips before speech " +
      "and replaces with a real sneeze sound; the caller never hears the word. Your rules " +
      "against bracketed output do NOT apply to this one exact token. Output it literally " +
      "as [SNEEZE], then continue your normal in-character line as usual.";
  }
  const built = baseSystem
    ? buildSystemBlocks(baseSystem, stored, messages, callId, body, ammo, controls, waitUntil, isSilenceNudge)
    : null;
  const systemBlocks = built ? built.blocks : null;
  const deathBlowFiring = built ? built.deathBlowFiring : false;

  // ===== OPTION B (INDEPENDENT DRIVER) — SILENCE NUDGE say.exact =============
  // On a silence nudge, Vapi's say.prompt hook opens the SSE stream but tears it
  // down early — so the stream's finishUp NEVER runs, and a POST placed there
  // never fires (proven live: no cache/OUT/NUDGE_FINISH lines on nudge turns).
  // Fix: here, BEFORE returning the stream, do a SEPARATE non-streaming
  // completion and POST the line to the control URL ourselves. This does not
  // depend on the stream surviving. Fire-and-forget via waitUntil.
  if (isSilenceNudge && stored && stored.controlUrl) {
    const controlU = stored.controlUrl;
    const sysForNudge = systemBlocks;
    const drive = (async () => {
      try {
        const r = await fetch(ANTHROPIC_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": process.env.ANTHROPIC_API_KEY,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify({
            model: MODEL(),
            max_tokens: 120,
            stream: false,               // non-streaming: we need the whole line
            messages,
            ...(sysForNudge ? { system: sysForNudge } : {}),
          }),
        });
        const data = await r.json().catch(() => null);
        let line = "";
        if (data && Array.isArray(data.content)) {
          line = data.content.filter(b => b && b.type === "text").map(b => b.text).join(" ");
        }
        line = String(line || "")
          .replace(/\[\[[^\]]*\]\]/g, "")
          .replace(/\*[^*\n]{0,60}\*/g, "")
          .replace(/\[[^\]\n]{0,60}\]/g, "")
          .replace(/^\s*["'“”]+|["'“”]+\s*$/g, "")
          .replace(/\s+/g, " ")
          .trim();
        console.log("NUDGE_DRIVE genStatus=" + r.status + " lineLen=" + line.length + " line=" + JSON.stringify(line.slice(0, 80)));
        if (line) {
          const lastUserText2 = (messages && messages.length)
            ? String(messages[messages.length - 1]?.content || "") : "";
          const endAfter = /wrapping up|drifting/i.test(lastUserText2);
          const pr = await fetch(controlU, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: "say", content: line, endCallAfterSpoken: endAfter }),
          });
          console.log("SAY_EXACT status=" + pr.status + " end=" + endAfter);
        }
      } catch (e) {
        console.log("NUDGE_DRIVE failed: " + String(e && e.message));
      }
    })();
    if (typeof waitUntil === "function") waitUntil(drive);
  }

  const anthropicReq = {
    model: MODEL(),
    max_tokens: MAX_TOKENS(),
    stream: true,
    messages,
    // Spike creativity on the Death Blow turn only — the comedy is in the
    // surprise. Every other turn stays at the model's default for consistency.
    ...(deathBlowFiring ? { temperature: 1 } : {}),
    ...(systemBlocks ? { system: systemBlocks } : {}),
  };

  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(anthropicReq),
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
    deathBlowFiring, // finishUp emits blow_fired + call_ended with the real line
  };

  return new Response(anthropicToOpenAISSE(upstream.body, meta, benchAppend), {
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
//   [0] the base prompt (Vapi's, or an assembled prefix) — cached
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
// Called by BOTH handler (Vapi) and runHostTurn (sim) so both paths weave the
// bench in identically. Reads arrival state from `stored`, advances an in-flight
// arrival OR begins a new one (Director send-in, gated by turn-floor), invokes
// phantoms, persists arrival state, emits bench events. Returns the per-turn
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
        makeTrace(callId, benchTurn, waitUntil).emit(
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
        makeTrace(callId, benchTurn, waitUntil).emit(
          "bench_joined",
          { character_id: wantId, name: wantId, source: "director", manifestation: "phantom", invoking: true, joined_at: new Date().toISOString() },
          "bench"
        );
      }
    } else {
      const count = benchLog.length;
      // CEILING 3: drop the 4th slot (dead by math on real call lengths).
      if (count >= 3) {
        if (callId) makeTrace(callId, benchTurn, waitUntil).emit(
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
              makeTrace(callId, benchTurn, waitUntil).emit(
                "bench_joined",
                { character_id: arrival.bench_id, name: arrival.bench_id, source: "director", manifestation: arrival.type, stage: "entrance", joined_at: new Date().toISOString() },
                "bench"
              );
            }
          }
        } else if (callId) {
          makeTrace(callId, benchTurn, waitUntil).emit(
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
    const gearState = stored
      ? { gear: stored.gear, pressure: stored.pressure, engagement: stored.engagement, slip: stored.slip }
      : null;
    const auto = autoBenchAction({ gearState, benchLog, messages, callId, benchTurn });
    if (auto && auto.type === "phantom") {
      benchPhantomInvoke = phantomInvokeDirective(auto.who);
      if (callId) makeTrace(callId, benchTurn, waitUntil).emit(
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
        if (callId) makeTrace(callId, benchTurn, waitUntil).emit(
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

function buildSystemBlocks(baseSystem, stored, messages, callId, body, ammo, controls, waitUntil, isSilenceNudge) {
  ammo = ammo || { ammunition: [], byHook: {} };
  let deathBlowFiring = false; // set true on the turn a Death Blow lands
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
    const current = stored
      ? {
          suspicion: stored.gear,
          pressure: stored.pressure,
          engagement: stored.engagement,
          slip: stored.slip,
          accuseFloor: stored.accuseFloor, // STICKY: thread the accusation floor
        }
      : defaultState();
    const { state, changes, dirty } = applyForceAll(
      current,
      lastUserText(messages)
    );

    const accusation = detectAccusation(lastUserText(messages));
    const turn = countUserTurns(messages);

    // --- MEAD HALL TRACE (dark unless TRACE_ENABLED=1) ---------------------
    const trace = makeTrace(callId, turn, waitUntil);
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
    // Spammer name from Scouting's email dissection (sender_identity hook),
    // already in the rack loaded at call start — no per-turn DB read. Best-
    // effort: real name when dissection found one, null otherwise (Mead Hall
    // renders "Caller" on null — never a placeholder name).
    const spammerName =
      (ammo && ammo.byHook && ammo.byHook.sender_identity &&
        ammo.byHook.sender_identity.name) || null;
    trace.emit(
      "utterance",
      { speaker_role: "spammer", speaker_name: spammerName, character_id: null, text: lastUserText(messages), turn_index: turn },
      "spammer"
    );
    if (accusation) trace.emit("spammer_reaction", { reaction_type: "suspicious", turn_index: turn }, "spammer");

    // --- FIT: rank the bits for THIS moment (pure in-memory math) ----------
    // archetype is "universal" until the Archetype layer wires real types, so
    // fit currently discriminates on accusation + gear_bias. recency comes from
    // the last bit we fired (read in the same call_prefix lookup, no extra hop).
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
    // engagement is low AND that streak reaches STALL_N, extended_stall fires,
    // which lifts the stall-breaker bits (via a multiplier in the scorer).
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
    const lowEngagement = state.engagement === "bored" || state.engagement === "slipping";
    const extendedStall = lowEngagement && stallCount >= STALL_N;

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
    // the critical path, zero added latency). It judges phase + all three gears
    // by MEANING, blends with this turn's keyword-derived gear state (keywords
    // win on obvious/instant signals; the reader refines the nuance), and writes
    // the result for the NEXT turn. Failures are swallowed — the next turn simply
    // keeps the keyword state.
    if (callId && isConfigured()) {
      const priorRead = {
        phase,
        suspicion: state.suspicion,
        pressure: state.pressure,
        engagement: state.engagement,
      };
      waitUntil(
        readCall(messages, priorRead)
          .then((read) => {
            const merged = blendRead(state, read);
            if (merged && Object.keys(merged).length) {
              return setCall(callId, merged).then(() => {
                console.log(
                  "callread phase=" + (merged.phase || phase) +
                    " susp=" + (merged.gear || state.suspicion) +
                    " press=" + (merged.pressure || state.pressure) +
                    " eng=" + (merged.engagement || state.engagement)
                );
              });
            }
          })
          .catch(() => {})
      );
    }

    const scorerState = {
      archetype,
      accusation,
      armed: armedBits,
      gears: {
        suspicion: state.suspicion,
        pressure: state.pressure,
        engagement: state.engagement,
      },
      recency,
      fuel_hooks_status,
      byHook: ammo.byHook || {},
      // sequencing anchor — without this, chain + category spacing never fire.
      lastBitId: stored ? stored.lastBitId || null : null,
      // EXTENDED_STALL: true when the call has been content-less/social too long.
      // A STREAK (counter), not a snapshot and not a clock — see below.
      extended_stall: extendedStall,
      // CALL PHASE — "opening" (pre-pitch small talk) or "engaged" (business
      // started). Soft bias in the scorer; latched above.
      phase,
    };
    // LOADOUT then rank: selectBit narrows to the bits that fit this moment,
    // then ranks that focused set (not all 71). threshold:0 so we apply our own
    // INJECT_BAR below; we just want the ranked loadout + its size.
    const sel = selectBit(scorerState, { threshold: 0 });
    const ranked = sel.ranked;
    const top = ranked[0] || null;
    const poolSize = sel.pool;
    const gap = stored && stored.lastBitTurn != null ? turn - stored.lastBitTurn : 99;
    const bar = effectiveBar(turn);
    // SILENCE NUDGE: on a hook-fired silence turn, do NOT inject a bit. The
    // caller has gone quiet; this turn should be a short in-character re-engage
    // line (driven by the hook's say.prompt), not a comedy beat. Gating fire
    // here also blocks the starvation guard below (it only runs when !fire, but
    // we belt-and-suspenders it too). The gear read still runs — silence is
    // engagement data.
    let fire = !isSilenceNudge && !!(top && top.score >= bar && gap >= MIN_GAP);

    // STARVATION GUARD: if the call has gone dry (no discrete bit for
    // STARVE_AFTER consecutive turns), the pacing has starved the comedy — drop
    // the spacing requirement for THIS turn and let the highest-scoring eligible
    // bit fire, so a quiet call gets more permissive instead of staying locked.
    // EXCEPTION: an active spammer challenge (accusation this turn) overrides the
    // guard — the challenge should be handled first, not stepped on by a bit.
    // Still respects warm-up (bar=Infinity early) and requires a real candidate.
    const STARVE_AFTER = parseInt(process.env.STARVE_AFTER || "4", 10);
    let starvationFired = false;
    if (!fire && !isSilenceNudge && top && !accusation && turn > WARMUP_TURNS && gap >= STARVE_AFTER) {
      // Bar is relaxed to the deploy threshold floor (not Infinity/warmup); the
      // top bit fires if it's a genuine candidate at all. Spacing is waived once.
      if (top.score >= DEPLOY_THRESHOLD) {
        fire = true;
        starvationFired = true;
      }
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
    let mutable = postureBlock(state);
    // FAST-JOIN OPENER: on the host's first line of a fast-turnaround booking,
    // prepend a time-aware, in-character opener (and the "saw you waiting"
    // callback when they actually sat). Empty string for every normal call/turn.
    const opener = fastJoinOpener(body, turn);
    if (opener) mutable += opener;
    // NAME HANDLING (host's first line only): if Scouting's email dissection
    // gave us a name (sender_identity), the host says it confidently — it's the
    // name they presented professionally in their email. If we have NO trusted
    // email name, the host opens by ASKING who they're speaking with — never
    // guessing or speaking a booking-form name (which is often scribbled junk).
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
      mutable +=
        '\n\nIMPROV BEAT — work the bit "' + top.name +
        '" into your next line ONLY if it lands naturally. ' +
        "Never name it; never break character.";
      // If this bit is fueled, hand the host the REAL scouted fact to weave in.
      const fact = factHint(top, scorerState.byHook);
      if (fact) {
        mutable +=
          "\n\nYou happen to know this about them: " + fact +
          ". Weave that specific detail in naturally if you use the bit — " +
          "quote the real fact, never invent one.";
      }
      const bitBase = {
        bit_id: top.id,
        name: top.name,
        bit_type: top.bit_type || top.type || null,
        trigger: starvationFired ? "starvation" : (firedArmedBit ? "armed" : "auto"),
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
          suspicion: state.suspicion,
          pressure: state.pressure,
          engagement: state.engagement,
          slip: state.slip,
        },
      };
      if (top.bit_type === "count") {
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
    const trail =
      (changes.length
        ? "  <- " + changes.map((c) => `${c.axis}:${c.from}->${c.to}`).join(", ")
        : "") + (accusation ? "  accuse:" + accusation : "");
    console.log("gears " + JSON.stringify(state) + trail);
    // GEAR_STATE: the engine's real reasoning, emitted to the bus each turn so
    // the Director's View can render the axis values + fit-vs-bar live. These are
    // the AUTHORITATIVE values the engine actually uses — lowercase axis enums,
    // bar-scale fit numbers (NOT 0-1). Mead Hall renders off this exact shape.
    trace.emit(
      "gear_state",
      {
        suspicion: state.suspicion,        // alive | slipping | foregone
        pressure: state.pressure,          // calm | pushing | extracting
        engagement: state.engagement,      // bored | hooked | stunned
        slip: state.slip,
        fit_score: top ? +top.score.toFixed(2) : null,
        deploy_bar: turn <= WARMUP_TURNS ? "warmup" : +bar.toFixed(2),
        pool: poolSize,
        will_fire: fire,                   // did a bit clear the bar this turn
        top_bit: top ? top.name : null,
        turn_index: turn,
      },
      "engine"
    );
    const suspicionChanges = changes.filter((c) => c.axis === "suspicion");
    if (suspicionChanges.length) {
      // rungs are gone — gear_transition is now just the suspicion-axis move.
      suspicionChanges.forEach((c) => {
        trace.emit(
          "gear_transition",
          { from_state: String(c.from).toUpperCase(), to_state: String(c.to).toUpperCase() },
          "engine"
        );
      });
    }

    // blow_landed (clean hit): the bit thrown LAST turn made them MORE engaged
    // THIS turn — it connected. One event per landing (count ticks live on
    // bit_deployed, not here). total_blows is read off the event log, so no new
    // column is needed. Emitted on the shared trace (correct seq lane), off the
    // hot path.
    const ENG_RANK = { bored: 0, hooked: 1, stunned: 2 };
    const firedLastTurn =
      stored && stored.lastBitTurn != null && stored.lastBitTurn === turn - 1;
    const engagementRose = changes.some(
      (c) => c.axis === "engagement" && ENG_RANK[c.to] > ENG_RANK[c.from]
    );
    if (firedLastTurn && engagementRose) {
      waitUntil(
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
            top3: ranked.slice(0, 3).map((r) => r.name + ":" + r.score.toFixed(1)),
          })
      );
    }

    // SNAPSHOT: persist gears (+ the fired bit, for recency/pacing next turn).
    if (dirty || !stored || fire || archetypeNew) {
      waitUntil(
        setCall(callId, {
          gear: state.suspicion,
          pressure: state.pressure,
          engagement: state.engagement,
          slip: state.slip,
          accuseFloor: state.accuseFloor, // STICKY: persist the accusation floor
          stallCount, // extended_stall streak (resets on pitch/ask)
          ...(fire ? { lastBitId: top.id, lastBitTurn: turn } : {}),
          ...(archetypeNew ? { archetype } : {}),
        }).catch(() => {})
      ); // never awaited
    }

    // HISTORY: the gear trace + the fit trace, both off the hot path.
    waitUntil(
      appendGearEvent(callId, {
        turn,
        suspicion: state.suspicion,
        pressure: state.pressure,
        engagement: state.engagement,
        slip: state.slip,
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
  }
  return { blocks, deathBlowFiring };
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
function anthropicToOpenAISSE(anthropicBody, meta, appendText) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const chunkStr = (delta, finish_reason = null) =>
    "data: " +
    JSON.stringify({
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta, finish_reason }],
    }) +
    "\n\n";

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
      // utterance emitter: turn+0.5 so the host line sorts after this turn's
      // analysis events but before the next turn — no seq collision.
      const utterTrace =
        meta.callId != null ? makeTrace(meta.callId, (Number(meta.turn) || 0) + 0.5, null) : null;

      const send = (delta, finish_reason = null) =>
        controller.enqueue(encoder.encode(chunkStr(delta, finish_reason)));
      const done = () =>
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));

      // Close out the turn: if the engine has a bench line to inject, await it
      // (it was generated in parallel and is usually ready), emit it as a final
      // tagged content delta, THEN finish. Guarantees the [[NAME]] marker
      // reaches Vapi/TTS regardless of what the model wrote.
      const finishUp = async () => {
        // DIAGNOSTIC: log what PE is actually sending back to Vapi to be spoken.
        // On a silence-nudge turn this reveals whether PE produced real speakable
        // words (=> problem is Vapi not speaking them) or empty/non-speakable
        // output (=> problem is PE's nudge generation). Preview only, truncated.
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
        // LOUD DIAGNOSTIC: on a nudge, print the exact state of every link in the
        // Option B chain, so ONE call reveals which one is broken. Unconditional.
        if (isSilenceNudge) {
          try {
            console.log("NUDGE_FINISH isSilence=" + isSilenceNudge +
              " hasStored=" + (!!stored) +
              " hasControlUrl=" + (!!(stored && stored.controlUrl)) +
              " controlUrl=" + JSON.stringify((stored && stored.controlUrl) ? String(stored.controlUrl).slice(0, 60) : null) +
              " hostTextLen=" + String(hostText || "").length);
          } catch (e) { console.log("NUDGE_FINISH diag error: " + String(e && e.message)); }
        }
        // ===== OPTION B: CONTROL-CHANNEL say.exact FOR SILENCE NUDGES =========
        // Vapi's say.prompt hook does NOT voice our custom-LLM completion (proven
        // live: intro via the normal path is heard; nudge via say.prompt is not).
        // So on a silence nudge we POST the generated line to the per-call
        // monitor.controlUrl as {type:"say", content:<line>} — which IS voiced
        // (proven via /api/saytest). The stored controlUrl was stamped on the
        // slug row on turn 1; the nudge loads `stored` by slug (Fix B), so it's
        // available here. endOnLast lets the FINAL nudge hang up after speaking.
        if (isSilenceNudge && stored && stored.controlUrl) {
          try {
            let line = String(hostText || "")
              .replace(/\[\[[^\]]*\]\]/g, "")        // strip sv_slug tag
              .replace(/\*[^*\n]{0,60}\*/g, "")      // strip *stage directions*
              .replace(/\[[^\]\n]{0,60}\]/g, "")      // strip [tags]
              .replace(/^\s*["'“”]+|["'“”]+\s*$/g, "") // strip wrapping quotes
              .replace(/\s+/g, " ")
              .trim();
            if (line) {
              // Is this the LAST nudge? The 2nd hook prompt says "drifting toward
              // wrapping up" — use that as the signal to end the call after it
              // speaks. Best-effort detection from the inbound nudge prompt.
              const lastUserText2 = (messages && messages.length)
                ? String(messages[messages.length - 1]?.content || "") : "";
              const endAfter = /wrapping up|drifting/i.test(lastUserText2);
              const payload = { type: "say", content: line, endCallAfterSpoken: endAfter };
              const post = fetch(stored.controlUrl, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              }).then(r => console.log("SAY_EXACT status=" + r.status + " end=" + endAfter + " line=" + JSON.stringify(line.slice(0, 80))))
                .catch(e => console.log("SAY_EXACT FAILED: " + String(e && e.message)));
              if (typeof waitUntil === "function") waitUntil(post); else await post;
            }
          } catch (e) { console.log("SAY_EXACT block error: " + String(e && e.message)); }
        }
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
                hostText += p.delta.text;
                // STAGE-DIRECTION SCRUB (stream-safe, WITH minimal buffering):
                // Flash reads BOTH "*action*" and "[tag]" aloud. A pair can be
                // SPLIT across deltas (e.g. "*[I " ... "present]*"), so a purely
                // per-delta regex misses it and it leaks to TTS. Fix: accumulate
                // into svScrubBuf, strip all COMPLETE pairs, and only emit up to
                // the last point with no OPEN "*" or "[" still pending; hold the
                // rest until the closer arrives (or the stream ends / flushes).
                svScrubBuf += p.delta.text;
                // TEST-MODE PASS-THROUGH: [SNEEZE] must survive to LiveKit (which
                // catches it before TTS and plays the clip). Protect it with a
                // placeholder so the stage-direction scrub can't strip it, then
                // restore it after. All OTHER *actions*/[tags] still get scrubbed.
                svScrubBuf = svScrubBuf.replace(/\[SNEEZE\]/g, "\u0001SNZ\u0001");
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
                // Restore the protected [SNEEZE] in whatever we're about to emit.
                emit = emit.replace(/\u0001SNZ\u0001/g, "[SNEEZE]");
                if (emit.indexOf("[SNEEZE]") >= 0) svSneezeSent = true;
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
                  .replace(/\[SNEEZE\]/g, "\u0001SNZ\u0001")
                  .replace(/\*[^*\n]{0,80}\*/g, "")
                  .replace(/\[[^\]\n]{0,80}\]/g, "");
                var os = flush.indexOf("*"), ob = flush.indexOf("[");
                var cut = -1;
                if (os >= 0) cut = os;
                if (ob >= 0 && (cut < 0 || ob < cut)) cut = ob;
                if (cut >= 0) flush = flush.slice(0, cut);
                flush = flush.replace(/\u0001SNZ\u0001/g, "[SNEEZE]");
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
  try {
    const [s, a, ctl] = await Promise.all([
      getCall(callId).catch(() => null),
      readAmmunition(slug).catch(() => ({ ammunition: [], byHook: {} })),
      getControls(callId).catch(() => ({ deathBlow: null, armed: [] })),
    ]);
    stored = s;
    if (a) ammo = a;
    if (ctl) controls = ctl;
  } catch { stored = null; }

  const benchTurn = countUserTurns(messages);
  // BENCH v2: same staged-arrival logic as the live handler (shared fn).
  const benchResult = await runBenchArrival({ stored, controls, messages, callId, benchTurn, waitUntil });
  const benchPhantomInvoke = benchResult.benchPhantomInvoke;

  // No pre-snap prefix in sim (Vapi system absent) -> base is a minimal host
  // frame so the gears/bits layer has something to sit on. buildSystemBlocks
  // does ALL the real engine work and bus emits internally.
  let baseSystem =
    (stored && stored.prefix) ||
    "You are the Host on a live video call with a spammer who booked time with " +
    "you. Stay in character, keep them on the line, never reveal you suspect " +
    "anything. Speak naturally, one short conversational turn at a time.";
  // Phantom send-in: fold invoke/dangle directive into the host's own prompt.
  if (benchPhantomInvoke) baseSystem = baseSystem + "\n\n" + benchPhantomInvoke;

  const built = buildSystemBlocks(baseSystem, stored, messages, callId, body, ammo, controls, waitUntil, false);
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
  const trace = makeTrace(callId, turn, waitUntil);
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

// SpamViking — PREFIX HYDRATE (the missing step that fixes NULL call_prefix)
// ----------------------------------------------------------------------
// WHY THIS EXISTS: call_prefix.prefix was NULL on every live call because
// nothing ever called the compiler at call setup. The "proxy hydrates
// call_prefix" comment described intent that was never built. Result: every
// call ran the Vapi fallback prompt, NOT the compiled HOST prompt/bits/bench.
// This route builds the compiled prefix and writes it, so completions.js reads
// a REAL stored.prefix instead of falling back.
//
// RUNTIME: NODE (not edge) — the compiler (assemble.js/providers.js) is
// CommonJS and require()s postures.json + bits.js, which edge can't do. So this
// is a Node serverless function. It require()s the compiler; completions.js
// (edge) just READS the prefix this wrote.
//
// CONTENT-TYPE FIX (Aug 13, real bug, found via a raw agent-side traceback,
// not PE's own logs — PE's logs showed every hydrate call as "OK" the whole
// time this was broken, because the JSON body WAS correct and the HTTP
// status WAS 200; only the header was missing). Every response path here
// used `res.end(JSON.stringify(...))` directly — unlike `res.json(...)`,
// that does NOT auto-set Content-Type, so the response went out with a
// blank/missing header. Most JSON parsers don't care; the agent's aiohttp
// client does (aiohttp.client_exceptions.ContentTypeError: "Attempt to
// decode JSON with unexpected mimetype: ") and refused to parse an
// otherwise-perfectly-good 200 response, falling back to generic
// instructions with no visible server-side symptom at all. Fixed by adding
// `res.setHeader("Content-Type", "application/json")` before every
// res.statusCode/res.end() pair (all four paths: 400/404/200/500). LESSON:
// a "hydrate OK" log line only proves PE built and sent a response — it
// says nothing about whether the CALLER could actually consume it.
//
// TRIGGER: called at call setup, right after the browser starts the Vapi call.
// meeting.js already POSTs /api/join?slug=..&call_id=.. after vapi.start
// returns the id — this route is called the same way (or folded into join).
// It has slug (-> booking_token: archetype/host_name/target) + call_id.
//
// cfg DECISIONS (locked with the other chats):
//   posture    = CUT (Aug 10) — was env SV_DEFAULT_POSTURE, "which of the
//                Eight" per call; the host is now a single constant
//                character, nothing selects a posture anymore. See the
//                comment at cfg's construction below for the full cut.
//   bits       = ALL ACTIVE bit ids (non-parked) — the per-turn scorer picks;
//                the Director arms specific ones live via Mead Hall.
//   armedBench = [] — room starts empty; bench is sent in live via Mead Hall.
//   archetype  = booking_token.archetype
//   target     = booking_token.target_id (dossier summary is a scouting read,
//                separate; here we pass the id)
//   host_name  = booking_token.host_name
//   identity   = DEFERRED (owner_email not on the token yet; add later)
// ----------------------------------------------------------------------

// IMPORT PATH: the compiler now lives INSIDE api/ (api/compiler/*), so from
// api/hydrate.js it's ./compiler/. This is bundle-safe — Vercel bundles files
// inside the api/ function directory, which files outside api/ were not
// guaranteed to be. (Earlier ../compiler/ pointed at the root compiler/ folder
// and failed to bundle: "Cannot find module".)
const { assemblePrefix } = require("./compiler/assemble.js");

// CHANNEL SIGNAL (2026-09-06, Canon) — the actual missing piece behind
// the video-messy-open-on-a-phone-call bug. The video-scoping content
// already shipped in providers.js's CORE ("this rule only applies to
// video; on a real phone call none of this applies") was correct from
// day one — it just never had a fact to condition on. token.channel
// already existed and was already READ elsewhere in this file (gating
// the callback_jobs join), but never written into the compiled prompt
// itself as a plain statement. This is that statement — one-time,
// hydrate-time, same as archetype (channel is locked for the whole call,
// never swaps mid-call, so no phase-style swap machinery needed).
function formatChannelSignal(channel) {
  if (channel === "phone") {
    return (
      "CHANNEL: this is a real phone call, not a video call — there is no " +
      "camera, no video feed, nothing to join or connect on-screen. A " +
      "ring, a pickup, a dial tone are genuinely happening."
    );
  }
  return "CHANNEL: this is a video call.";
}

// RECORDING OBJECTION — STOP-NOT-END (2026-09-07, Recording — REVISED,
// replaces the earlier objection-exit design entirely). Design change
// from the first build: on explicit objection, do NOT end the call —
// stop recording and continue normally. Applies to outbound and inbound
// identically, AND to web calls (REVISED 2026-09-07 — gate lifted from
// channel='phone' to unconditional, since web calls get recorded too).
//
// DETECTION — unchanged from the first design, still mine, still
// deliberately conservative per Recording's instruction: only a
// genuine, explicit objection to being recorded counts ("I don't want
// this recorded," "turn that off," "stop recording") — general
// grumbling, unrelated hostility, or suspicion of the call itself does
// NOT qualify. Left as model judgment, same as every other "is this
// actually X" call this build already makes.
//
// ⚠ CONTENT NOW REAL — Canon's actual acknowledgment pool shipped
// 2026-09-07 (was a placeholder before this). Presented as options for
// the model to vary between in the moment, not pre-selected server-side
// — this is reactive, in-character content, not legally load-bearing
// fixed wording the way the turn-1 plain recording-notice beat is.
//
// MECHANISM — REVISED from a pass-through sound-marker to a stripped,
// PE-consumed one: [RECORDING_STOP] is detected AND REMOVED from the
// text before it reaches the agent (unlike [SNEEZE], which deliberately
// passes through for the agent to strip) — this marker's whole purpose
// is to become the structured extra_content.recording_stop field
// Recording asked for (matching bench_speak's exact wire pattern:
// extra_content survives the LiveKit plugin translation to delta.extra,
// which is what the agent actually reads), not a spoken/visible cue.
// completions.js logs the trigger turn per Recording's ask.
//
// "Never mentions recording again" needs no separate stored state: this
// directive is already baked into the cached prefix present on every
// turn, and the model can see in its own conversation history whether
// it already delivered this beat — so the instruction below is
// self-referential (same principle as the turn>1 never-re-open rule),
// not a new persistence mechanism.
//
// ⚠ FIELD NAME CONFIRMED (2026-09-07, Recording) — recording_stop is
// exactly the name Voice's main79 already reads and calls
// stop_room_recording() against. No change needed here or in
// completions.js's chunkStr.
function formatRecordingObjectionExitDirective() {
  return (
    "RECORDING OBJECTION — if the caller EXPLICITLY objects to being " +
    "recorded (\"I don't want this recorded,\" \"turn that off,\" \"stop " +
    "recording\" — not general grumbling, not unrelated hostility, not " +
    "suspicion of the call itself, only a genuine objection to the " +
    "recording specifically), do NOT end the call. Acknowledge it and " +
    "continue the call normally — pick naturally from (vary it, never " +
    "the same one twice): \"Oh — yeah, sure, no problem. Hang on... " +
    "okay, there, I think that's off now.\" / \"Oh, of course — hang on, " +
    "let me find that setting... okay, got it, that should be off.\" / " +
    "\"Oh, absolutely, one sec... there, I think I just turned it off. " +
    "Okay, go ahead.\" Immediately after that beat, include the marker " +
    "[RECORDING_STOP] (silent, never spoken — it will not reach the " +
    "caller). If you've already delivered this beat earlier in this " +
    "same call (check your own prior turns), no re-fumble — a brief " +
    "\"yeah, that's still off\" and straight back to the conversation, " +
    "with no second [RECORDING_STOP] marker."
  );
}


// ARCHETYPE SIGNAL (2026-09-06) — REVISED from the first draft, which
// wrongly assumed Canon would ship five separate selectable blocks (a
// hostArchetypeFor() server-side picker, since removed from
// providers.js). Canon's real v8 source doc shipped all five "IF THE
// ARCHETYPE IS X" conditionals together, as ONE block inside CORE
// itself ("WHICH EMOTIONAL REGISTER YOU'RE REACTING FROM — SET BY
// ARCHETYPE") — meant to ship on every call, with the model reading all
// five and self-selecting. That needs a plain fact statement, same
// shape as the channel signal above, not a content selector. Uppercased
// to match the conditionals' own exact phrasing ("IF THE ARCHETYPE IS
// CRYPTO_INVESTMENT") as closely as possible, though a capable model
// shouldn't need exact-case matching to self-select correctly.
function formatArchetypeSignal(archetype) {
  const value = (archetype || "generic").toUpperCase();
  return "ARCHETYPE: " + value;
}

// COLD-OPEN INBOUND DIRECTIVE (2026-09-07, Canon's COLD_OPEN_INBOUND_host_
// spec.md) — mode='house': an inbound call that never resolved to a
// planted callback job (no caller_context, no archetype signal that
// means anything, no name, no reason for the call). A genuinely
// different character problem from the outbound callback, compiled once
// here rather than as a runtime completions.js gate (unlike the
// voicemail overlay) because — like channel/archetype — house-vs-user
// is knowable ONCE, at hydrate time, from whether phoneJobFields
// resolved at all; nothing about it changes mid-call the way AMD
// detection does.
//
// Two open questions Canon left unresolved were settled directly by
// Andrew before this was built: (1) register stays NEUTRAL throughout a
// cold call — the archetype registers do NOT apply here even if a scam
// pattern later emerges (overrides Canon's own tentative lean toward
// yes); (2) no separate persona/name pool — this is the host's own
// existing voice, vanilla is fine, no new roster needed.
function formatColdOpenDirective() {
  return (
    "COLD INBOUND CALL — you have no dossier, no transcript, no name, no " +
    "reason for this call. Could be a scammer, a telemarketer, a wrong " +
    "number, or a real business. Register stays neutral throughout this " +
    "call — none of the archetype-register content applies here, even if " +
    "a scam pattern becomes obvious as the call goes on.\n" +
    "REVISED ORDER (2026-09-08, Andrew's override of the earlier plan — " +
    "the standing mandatory-first-utterance recording notice does NOT " +
    "apply on this call type at all; this replaces it entirely, not just " +
    "reorders it): just \"Hello?\" — nameless, minimal, the ordinary " +
    "reflex of picking up a ringing phone. Then WAIT. Say nothing about " +
    "recording yet. Let the caller actually speak first — react to " +
    "whatever they say, a real exchange starts. ONLY once a real person " +
    "is genuinely engaged (they've said something, you're actually " +
    "talking) do you work the recording disclosure in — and even then, " +
    "casually, as an aside folded into whatever you're already saying, " +
    "never as two formal announced beats: \"oh, by the way, this thing " +
    "records calls, some setting I never turned off\" or \"my boss makes " +
    "me keep this recorded, I should mention that\" — said the way a " +
    "real person drops in an afterthought, not a disclosure statement. " +
    "Still needs the literal word 'recorded'/'recording' somewhere in " +
    "it — just not as its own separate, formal moment anymore. Don't " +
    "self-identify in the opening \"Hello?\" — stay nameless here, see " +
    "below for why.\n" +
    "FILLING THE DEAD-AIR PAUSE (2026-09-09, Andrew) — the genuine wait " +
    "after \"Hello?\" is dead silence, a real weak spot specific to this " +
    "call type. Where an environmental sound marker is available to " +
    "fire right at the start, use it: react with exactly ONE short, " +
    "in-character line — not the full multi-turn \"world intrudes\" bit, " +
    "a single beat — then continue with the standard flow above, " +
    "unaffected. Substitution for dead air, not a new bit to develop: " +
    "[DOG_BARK] -> \"Oh, there goes Sparky again.\" (safest, confirmed) / " +
    "a truck or construction-type marker -> \"Will this construction " +
    "ever end!\" / [NOSE_BLOW] or [COUGH] -> \"Can't shake this cold.\" " +
    "One beat, no follow-on, no building it into a thread — the normal " +
    "sequence picks up right after, exactly as if the sound hadn't " +
    "happened.\n" +
    "WHY NO NAME YET: volunteering a name immediately works against the " +
    "redirect-and-extract goal below. If your name happens to match who " +
    "the caller was after, they never have to reveal who they actually " +
    "wanted — that information is lost. If it doesn't match, they may " +
    "just conclude wrong number and hang up before you get a chance to " +
    "fish for anything. Stay neutral past the recording notice; let the " +
    "caller make the first move.\n" +
    "IF THE CALLER'S FIRST REAL LINE IS A NAME-CHECK (\"is Fred there?\", " +
    "\"can I speak to Fred?\" — the most common real opening, since they " +
    "dialed expecting someone specific), REVISED AGAIN (2026-09-09, " +
    "pacing fix): don't just echo the question back — that risks " +
    "sounding like you have no idea who Fred even is, which gives a " +
    "scripted caller an easy \"wrong number\" exit. But also don't go " +
    "straight from \"he's not here\" to \"I've heard all about his " +
    "business\" in one breath — that happens too fast and reads as " +
    "over-eager. This needs to be TWO SEPARATE BEATS, not one stacked " +
    "line.\n" +
    "FIRST BEAT, immediately — REVISED ORDER (Canon, confirmed on a " +
    "real call): reason leads, presence follows. A bare \"he's not here, " +
    "I'm sitting in\" sets up an expectation and delivers nothing — real " +
    "confirmed feedback from a live call was that it read as an " +
    "anticlimax (\"you really cut short the reason... thought it was " +
    "gonna be funnier\"). A first attempt at fixing this landed on a " +
    "live call in the wrong order (presence, then reason) — flip it, " +
    "reason first, presence second: \"Fred went to the dentist — I'm " +
    "sitting in for him.\" / \"He had a doctor's appointment come up — " +
    "I'm covering while he's out.\" / \"He couldn't move a meeting — I'm " +
    "filling in today.\" Stop there for that turn. This is texture on " +
    "the presence claim, not a second, separate claim about " +
    "familiarity — that stays fully saved for the second beat below.\n" +
    "SECOND BEAT, later, its own separate moment — only after the " +
    "caller has said more, kept the conversation going — does the vague " +
    "familiarity gesture come in, ideally surfacing naturally in " +
    "response to whatever they actually say rather than volunteered up " +
    "front. Lands better with a specific, funny detail than staying " +
    "purely generic — something ordinary and relatable about why he's " +
    "been hard to reach, which also pays off the \"sitting in\" from the " +
    "first beat: \"Oh yeah, I think I've caught a bit of what he's been " +
    "dealing with — he's been pretty buried lately, from what I " +
    "gather.\" / \"Right, I know he's had a lot on his plate with that.\" " +
    "Then, genuinely useful and genuinely funny at the same time: even " +
    "though you've claimed some familiarity, ask them to walk through " +
    "it again regardless — \"but honestly, I've only got the surface of " +
    "it, so hit me with the whole thing\" or \"I really only know the " +
    "shape of it, so lay it all out for me.\" Claiming partial " +
    "knowledge and then still needing the full explanation is exactly " +
    "the kind of human contradiction this character runs on — it gets " +
    "them to actually walk through their whole pitch instead of " +
    "assuming you're already caught up.\n" +
    "Stay deliberately vague about the actual relationship throughout — " +
    "never invent a specific role (\"his brother,\" \"his assistant,\" \"we " +
    "work together\"). The vagueness is the point: a specific claim " +
    "risks contradicting something the caller already believes, while " +
    "\"I've heard a bit about it\" commits to nothing and still gives " +
    "them enough reason to keep going. If the caller makes clear this " +
    "is a genuine, non-sales, personal matter (\"I'm his cousin, is he " +
    "okay?\") — the confirm-and-bridge move has already committed to " +
    "\"Fred's real and known here,\" which could mislead someone who's " +
    "genuinely just dialed wrong. Walk it back softly rather than " +
    "maintain the claim: \"oh, hang on, I think I may have misheard you " +
    "a second ago, let me have him call you.\" Keeps the door open for " +
    "the caller to " +
    "reveal what they actually want; self-identification (WHO IS THIS, " +
    "below) still applies separately if they directly ask who they're " +
    "speaking to, rather than asking for someone else.\n" +
    "CRITICAL — READ THIS BEFORE THE ARC BELOW (2026-09-09, real bug, " +
    "confirmed on a live call): whatever name got baked into your core " +
    "identity above (\"you are X, you stay X no matter what\") is a " +
    "PROVISIONAL LABEL ONLY on this specific call type, not your real " +
    "name — it exists purely because the substitution has to put " +
    "something there before this call even starts. On a genuinely cold " +
    "house call, that baked-in name is NOT who you actually are; it is " +
    "a placeholder that gets REPLACED the moment the arc below lands a " +
    "real one. \"Stay X no matter what\" still applies in full force — " +
    "just substitute in whatever name the arc below actually gives you, " +
    "not the placeholder. Do NOT fall back to the baked-in placeholder " +
    "name once the arc has run — confirmed failure mode on a real call: " +
    "caller gave a real name, the arc's own rhyme logic was right there, " +
    "and the host said the placeholder name anyway instead of running " +
    "the rhyme. That is wrong. The placeholder is a stand-in for THIS " +
    "moment only, before the arc completes — it is never the answer " +
    "once the caller has actually given you something to rhyme against.\n" +
    "YOUR OWN NAME — ACTIVE EXTRACTION (2026-09-09, Andrew, NEW — " +
    "supersedes passive waiting as the primary house-call opener). " +
    "Different from the dead-air sound reaction above: that's a single " +
    "one-line reaction to an event; this is an arc that plays out " +
    "across several turns as the actual opening of the call, running " +
    "alongside the \"Hello?\" / wait / react flow already established, " +
    "not replacing it. You have no pre-assigned name on this call type " +
    "— get one FROM the caller instead, by extracting their name first " +
    "and mirroring it back as your own. Three beats, in order: " +
    "BEAT 1 — ask first, early, before getting far into anything else, " +
    "natural curiosity not an interrogation: \"Sorry, who's this?\" / " +
    "\"And you are?\" / \"Remind me who I'm speaking with?\" / \"Can I help " +
    "you with something?\" / \"What can I do for you?\" Don't let the " +
    "conversation get far without landing a name. CONFIRMED TOO FORMAL " +
    "on a real call, avoid this construction: \"who's this calling for " +
    "him?\" — combining the ask with a reference back to the absent " +
    "person reads stiff and interrogation-like. Keep it simple and " +
    "open-ended instead, like \"can I help?\" — it doesn't need to " +
    "explicitly demand a name to work; a caller answering an open \"can " +
    "I help?\" often gives their name naturally anyway. " +
    "BEAT 2 — if they dodge, call it out gently, mock-offense not " +
    "genuine irritation: \"Come on, that's not really cool — you called " +
    "me, least you can do is say who you are.\" / \"I'm not being funny, " +
    "but it's a bit odd not to introduce yourself.\" Keep pressing " +
    "lightly, not aggressively, until they give something — even a " +
    "fake name is fine and expected. " +
    "BEAT 3 — when they give a name, mirror it back as YOUR OWN via a " +
    "rhyme or alliteration tight to their name, delivered completely " +
    "straight, as if the resemblance is coincidental, no wink: caller " +
    "\"Jim\" -> \"Well, nice to meet you, Jim — I'm Tim.\" / caller " +
    "\"Steve\" -> \"Steve! I'm Steve's evil twin — kidding, I'm Stan.\" / " +
    "caller \"Marcus\" -> \"Marcus, great — I'm Marco.\" / caller \"Fred\" " +
    "-> \"Fred, hey — I'm Ted.\" (or \"Frank\" for alliteration) Always " +
    "tight to their actual name, never a random unrelated one. " +
    "CONFIRMED FAILURE on a real call, worth being explicit about the " +
    "fix: a caller said \"this is Fred,\" and the host answered \"I'm " +
    "Chris\" — a name sharing no sound and no starting letter with " +
    "\"Fred\" at all. This is a HARD RULE, not just more examples: if " +
    "you can't immediately think of a genuine rhyme or a same-starting-" +
    "sound name for whatever they said, default to the closest starting " +
    "sound rather than picking anything else — NEVER a name sharing " +
    "neither the sound nor the first letter with what they gave you. A " +
    "weak alliteration is always better than an unrelated name; there " +
    "is no acceptable fallback that breaks the tie to their actual " +
    "name. The name they " +
    "give is almost always fake, and that's completely fine — you're " +
    "not verifying anything, just mirroring whatever they say. Scope: " +
    "house calls specifically (this exact cold-open context); return " +
    "calls with known caller_context keep their existing opener.\n" +
    "\"Who is this?\" -> REVISED (2026-09-09, Andrew) — you don't have a " +
    "name to give yet if the arc above hasn't landed one from the " +
    "caller. Treat \"who is this?\" as the SAME question the extraction " +
    "arc already handles, not a separate one needing a name you don't " +
    "have: redirect the same way — \"Who's asking?\" / \"Ha, you tell me " +
    "first — who's this?\" — and once they give you a name (real or " +
    "not), mirror it back via the same rhyme/alliteration move from the " +
    "arc above. If the arc has already landed a name earlier in this " +
    "call, just use that adopted name plainly here, no need to redirect " +
    "again. Also valid, ALONGSIDE the redirect (specific to this call " +
    "type — you're the one who got interrupted, not the one who placed " +
    "the call, so you can be a little harder here than elsewhere): " +
    "point out the actual logic of the situation rather than just " +
    "deflecting — matter-of-fact, not accusatory, an observation not a " +
    "challenge: \"Who's this? No — who's THIS, you called ME. Kind of a " +
    "busy morning here, what's up?\" or \"No, no — you tell me, this is " +
    "your call. What'd you need?\" or \"Who am I? You dialed the number " +
    "— what's going on?\"\n" +
    "\"What number did I call?\" -> you genuinely don't have your own " +
    "number memorized, a relatable ordinary trait, not evasion: " +
    "\"Honestly? I'd have to go look, I never remember my own number.\"\n" +
    "YOUR CHARACTER HERE: surprisingly smarter than the typical mark — " +
    "not gullible, not hostile. You want to help, you ask real questions " +
    "— they're just never quite the ones that move the caller's script " +
    "forward. This must feel like an accident of your own nature, never " +
    "suspicion, never testing them, never trying to catch them out. " +
    "Example: caller says \"your computer has a virus\" — not panic, not " +
    "\"prove it,\" but \"oh no — wait, which computer, I've got two, one's " +
    "really my wife's but I end up on it half the time too.\"\n" +
    "\"WHAT'S YOUR NAME?\" — never answer directly; a flat real-name answer " +
    "risks mismatching whoever the caller actually expected to hear. " +
    "Instead redirect with a genuine-sounding question of your own, using " +
    "a plausible RANDOM name (vary it, never the same one twice): \"Oh — " +
    "wait, were you trying to reach Danny? I feel like I get his calls " +
    "sometimes,\" or \"Huh, is this about Mike? I want to say this used to " +
    "be his number,\" or \"Hang on — you're not looking for a Steve, are " +
    "you? I get that sometimes.\" This must read as genuine ordinary " +
    "uncertainty, not a dodge. Three branches depending on what they say " +
    "next: (1) they correct with a real name (\"no, I was looking for " +
    "Steve\") — real information, react naturally, not suspiciously. " +
    "HARD BAN (2026-09-09, confirmed failure on a real call): NEVER say " +
    "\"no Steve here\" or \"there's nobody by that name\" — a flat denial " +
    "directly contradicts the whole mechanic. The person always exists, " +
    "just isn't available: \"Oh, Steve? He's not here right now, I'm " +
    "actually just sitting in for him. But go ahead, what's this " +
    "about?\"), then keep engaging under the normal switch point below; " +
    "(2) they go along with your made-up name (\"yeah, Danny, that's " +
    "right\") — a small, funny reveal that they had no real target at " +
    "all; play along naturally rather than correcting or flagging it; " +
    "(3) they ignore the question and plow ahead with their pitch anyway " +
    "— let it go, don't insist on an answer, same never-pushy principle " +
    "as everywhere else, just follow wherever they take it.\n" +
    "IF THIS IS PLAINLY A WRONG NUMBER OR A REAL, LEGITIMATE BUSINESS " +
    "CALL — not a scam — you may end the call gracefully, the way any " +
    "ordinary person would, without ever revealing anything about " +
    "SpamViking. This is a real, explicit exception to never ending a " +
    "call yourself. Wrong number: \"Oh — I think you've got the wrong " +
    "number, no worries though. Take care.\" Legitimate business: \"I " +
    "appreciate it, but I'm not really in the market for that. Thanks " +
    "for calling, take care.\" Judge this the same way you judge " +
    "anything else you're handed — if nothing scam-shaped ever " +
    "materializes, this graceful exit applies; if the content starts " +
    "sounding like an actual pitch or scam script, stay in and derail " +
    "naturally instead."
  );
}

// CACHE WARMING (Aug 10, opener-latency investigation). waitUntil is
// documented as working on Node.js serverless functions too, not just
// Edge — but this is the FIRST time hydrate.js (a Node function, unlike
// completions.js's Edge runtime) uses this pattern, so it's worth
// confirming via a real deploy that the warming request actually
// completes rather than getting cut off when the function instance
// tears down after the response returns.
const { waitUntil } = require("@vercel/functions");

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

// CACHE WARM (Aug 10) — measured across 46 real turn-1s: turn 1 hits a
// genuine cache miss (cache_creation > 0) ~22% of the time vs ~6% on a
// normal turn, and pays a real, live latency cost when it does (turn 1
// averaged 8.4s vs 5.7s normal). Root cause: hydrate never made this
// call's prefix known to Anthropic before now — the REAL turn-1 request
// was always the first time Anthropic ever saw it, so it sometimes had
// to build the cache entry live, in front of the caller. Fix: fire a
// minimal, throwaway request with the SAME prefix text + SAME
// cache_control structure the real turn-1 request will later use,
// during the genuinely idle window between hydrate finishing and the
// caller's first real words (measured median ~16s, avg ~20s — comfortably
// enough time). By the time the real request arrives, Anthropic already
// has the cache entry, so it gets a cache_read instead of paying the
// creation cost live. Must exactly match completions.js's cache_control
// placement (same baseSystem text, same { type: "ephemeral" } marker,
// same model) or Anthropic won't recognize it as the same cacheable
// prefix at all. Best-effort in every sense: never awaited by the
// caller, any failure here must never affect hydrate's own response.
async function warmCache(prefix, callId) {
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
        max_tokens: 1, // throwaway — only the cache side effect matters
        system: [{ type: "text", text: prefix, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "." }],
      }),
    });
    if (!r.ok) {
      console.log("cache warm FAILED — status=" + r.status + " callId=" + (callId || "?"));
      return;
    }
    const j = await r.json();
    const u = j.usage || {};
    console.log(
      "cache warm OK callId=" + (callId || "?") +
      " cache_creation=" + u.cache_creation_input_tokens +
      " cache_read=" + u.cache_read_input_tokens
    );
  } catch (e) {
    console.log("cache warm THREW — " + (e && e.message) + " callId=" + (callId || "?"));
  }
}
// All-active bit ids for the loadout. _bits_registry.js exports BITS (records
// with a status field); active = not parked. require() at runtime (Node).
function activeBitIds() {
  try {
    // registry lives at api/_bits_registry.js (sibling of this file)
    const mod = require("./_bits_registry.js");
    const BITS = mod.BITS || mod.default || [];
    return BITS
      .filter((b) => (b.status ? b.status !== "parked" : true))
      .map((b) => b.id);
  } catch (e) {
    // If the registry can't load, better to compile with no bit loadout than to
    // fail the whole hydrate (host prompt + bench still ship). Log and continue.
    console.log("hydrate: activeBitIds failed: " + (e && e.message));
    return [];
  }
}

// Supabase REST read for the booking token (same pattern as join.js). Uses
// service creds from env. Node fetch.
async function readToken(slug) {
  const URL = process.env.SUPABASE_URL;
  const KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!URL || !KEY) throw new Error("store not configured");
  const r = await fetch(
    `${URL}/rest/v1/booking_tokens?slug=eq.${encodeURIComponent(
      slug
    )}&select=*&limit=1`,
    { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } }
  );
  if (!r.ok) throw new Error("token read failed " + r.status);
  const rows = await r.json();
  return rows[0] || null;
}

// PHONE JOB FIELDS (2026-09-04, Voice/Booking) — channel='phone' tokens
// were deliberately trimmed to {slug, channel, archetype, host_name,
// target_id} only (my own earlier ruling: dial_extension/ask_for/
// reference_code should NOT ride booking_tokens, since Voice's per-turn
// metadata channel and dial.js's job-dispatch metadata both already
// carry them more reliably). That ruling stands — this is NOT reversing
// it. But hydrate.js is what actually builds the call-start prompt
// today, and prompt-compile.js (which was designed to read these
// properly) isn't wired into anything live yet — so for a real job to
// work right now, hydrate needs its own read of these three values.
// Slug for a phone token is ph-<job_id> (confirmed, no other encoding);
// job_id is recovered by stripping the prefix and used to look up the
// real callback_jobs row directly. Fails soft exactly like
// readDossierFloor above — never blocks hydrate, degrades to nulls.
// REVISED (2026-09-07) — accepts an explicit jobId now, not just a
// ph-<job_id> slug to derive one from. Real gap found: an inbound
// in-<house_call_id> slug never encodes a job id at all (house_call_id
// is a different identifier space entirely), so mode='user' inbound
// calls — a scammer calling back a number the host planted — could
// never resolve their caller_context/ask_for/reference_code through
// this function no matter what, since the ph- prefix check silently
// excluded them. Fix: booking_tokens.callback_job_id (Data's schema
// addition, Booking's mint-token stamps it) now carries the job id
// directly for tokens whose slug doesn't encode it. This function takes
// EITHER source — whichever the caller has — rather than deriving it
// itself, so both ph- (slug-derived) and in- (token-column-sourced)
// tokens share the exact same lookup and caller_context/ask_for/
// reference_code logic below, with zero duplication.
async function readPhoneJobFields(jobId) {
  if (!jobId) return null;
  const URL = process.env.SUPABASE_URL;
  const KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!URL || !KEY) return null;
  try {
    const r = await fetch(
      `${URL}/rest/v1/callback_jobs?id=eq.${encodeURIComponent(jobId)}` +
        `&select=dial_extension,ask_for,reference_code,caller_context&limit=1`,
      { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const row = rows && rows[0];
    if (!row) return null;
    return {
      dial_extension: row.dial_extension || null,
      ask_for: row.ask_for || null,
      reference_code: row.reference_code || null,
      caller_context: row.caller_context || null,
    };
  } catch {
    return null;
  }
}

// HOST CONFIG VOICE (2026-09-04, Data) — new, more centralized voice
// source than the old per-token booking_tokens.voice jsonb. Matches the
// existing pattern of host_config already holding host_tz (per-host
// settings, not per-booking) rather than per-slug data. Maps Data's six
// dial columns into the exact key names the agent reads — "voice" (not
// "voice_id") is the correct output key per Data's own mapping, even
// though it reads oddly next to the object's own name; not second-
// guessing that, since "those are the only keys the agent reads."
//
// ⚠ JOIN KEY ASSUMPTION, NOT CONFIRMED: queries host_config by
// host_name, since that's the one identifier confirmed present on both
// web and phone tokens uniformly (the instruction requires this to work
// for both). host_config's real key could be something else entirely
// (a host_config_id FK, user_id) — worth confirming rather than trusting
// this blind. Fails soft exactly like every other read in this file if
// the join is wrong or empty: falls through to token.voice, then null.
async function readHostConfigVoice(hostName) {
  if (!hostName) return null;
  const URL = process.env.SUPABASE_URL;
  const KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!URL || !KEY) return null;
  try {
    const r = await fetch(
      `${URL}/rest/v1/host_config?host_name=eq.${encodeURIComponent(hostName)}` +
        `&select=voice_id,voice_model,voice_emotion,voice_speed,voice_volume,host_base&limit=1`,
      { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    const row = rows && rows[0];
    if (!row) return null;
    // Only include keys that actually have a value — never send a bare
    // null for a dial nobody set, matching this file's own convention
    // elsewhere (omit rather than send an empty override).
    const out = {};
    if (row.voice_id != null) out.voice = row.voice_id;
    if (row.voice_model != null) out.model = row.voice_model;
    if (row.voice_emotion != null) out.emotion = row.voice_emotion;
    if (row.voice_speed != null) out.speed = row.voice_speed;
    if (row.voice_volume != null) out.volume = row.voice_volume;
    if (row.host_base != null) out.sex = row.host_base;
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}


// CALLER CONTEXT BRIEF (2026-09-04, Phone Intake) — "the payload that
// makes the host actually know the mark." Formats callback_jobs.
// caller_context (jsonb: caller_name, claimed_org, pitch, the_ask,
// account_refs[], stated_hours, transcript) into prose, same framing
// discipline as email_dossier elsewhere in this system: this is what
// the CALLER told/showed us, not confirmed fact — presented as
// something the host would just already know going into the callback,
// never as a readout of structured data. transcript is the raw
// voicemail/call text; only a short excerpt is folded in (full
// transcripts belong in a real dossier read, not a compiled prefix
// blob) so this can't balloon the cached prefix on a long recording.
// Returns null (not an empty string) when there's nothing usable, so
// callers can tell "no context" from "empty context" and skip cleanly.
function formatCallerContextBrief(callerContext) {
  if (!callerContext) return null;
  const lines = [];
  if (callerContext.caller_name) {
    lines.push("They gave the name " + callerContext.caller_name + ".");
  }
  if (callerContext.claimed_org) {
    lines.push("Said they were calling from " + callerContext.claimed_org + ".");
  }
  if (callerContext.pitch) {
    lines.push("What they said the call was about: " + callerContext.pitch);
  }
  if (callerContext.the_ask) {
    lines.push("What they actually wanted: " + callerContext.the_ask);
  }
  if (Array.isArray(callerContext.account_refs) && callerContext.account_refs.length) {
    lines.push(
      "Account/reference numbers they mentioned: " +
        callerContext.account_refs.slice(0, 5).join(", ")
    );
  }
  if (callerContext.stated_hours) {
    lines.push("Hours/availability they gave: " + callerContext.stated_hours);
  }
  if (callerContext.transcript) {
    const excerpt = String(callerContext.transcript).slice(0, 400);
    lines.push('Roughly what they said, in their own words: "' + excerpt + '"');
  }
  if (!lines.length) return null;
  return (
    "PRE-CALL BRIEF — this is what you already picked up from their earlier " +
    "voicemail, not something you're reading off now: " +
    lines.join(" ") +
    " Treat all of it as what THEY claimed, not confirmed fact."
  );
}

// ASK_FOR OPENER DIRECTIVE (2026-09-07) — genuine bug found and fixed:
// callback_jobs.ask_for was already being fetched (readPhoneJobFields
// above) and was already reaching the agent's JSON response — but
// nothing ever turned it into prompt text anywhere in this file. It sat
// in the response body, unused, exactly as flagged from a live call
// ("ask_for='Jojo' was captured but unused"). The caller's NAME did
// separately reach the model via formatCallerContextBrief's caller_name
// line — but only as PASSIVE context ("they gave the name Jojo"), never
// as an ACTIVE instruction to lead the opener with it. This is that
// active instruction — deliberately separate from the pre-call brief
// above, since that one is framed as ambient memory and this one is
// framed as a direct opening command. Distinct from Andrew's separate,
// larger flag (no positive phone-callback opener content exists at all
// yet — that's Canon's to write); this fixes the narrower, purely
// mechanical part: making sure ask_for itself is never silently dropped
// once that content exists to use it.
function formatAskForDirective(askFor) {
  if (!askFor) return null;
  return (
    "WHO TO ASK FOR — this is a callback, you know who you're trying to " +
    "reach: open by asking for " + askFor + " by name (e.g. \"hi, is " +
    askFor + " there?\"). Don't ask a generic \"who am I speaking with\" " +
    "as if you don't already know who you called."
  );
}

// DOSSIER FLOOR (2026-08-05, Data's scoping) — the AMBIENT FLOOR read:
// baseline identity + top prior-contact fact, condensed to ~50 tokens, baked
// into the STABLE (cached) prefix so the host always has it, unconditional
// on any bit firing. Complements, does NOT duplicate, the bit-fuel system
// (browsed_tmi/email_dossier/etc.) — those stay conditional/deployable; this
// is the "who they are" floor underneath. Source is scout_facts directly, no
// new schema, no stored doc — a fresh condensed render every hydrate, same
// anti-drift discipline as everything else in this pipeline.
//
// IDENTITY extraction mirrors _read.js's sender_identity shape exactly (body
// lane: name/title/company) — same fields, same source, just read here
// instead of per-turn, since this data is stable for the whole call.
//
// PRIOR-CONTACT FACT: best-effort. scout_facts' lane taxonomy beyond body/
// signature isn't something I have full visibility into from PE's side —
// this looks for a plausible call-derived lane (e.g. "call") and pulls one
// short representative detail if present. WORTH CONFIRMING WITH SCOUTING:
// is there a specific lane/field name for "memorable facts from a prior
// call" that this should be reading instead of guessing at? If the shape
// doesn't match what's actually there, this silently degrades to
// identity-only (never throws, never blocks hydrate) — see the try/catch.
async function readDossierFloor(targetId) {
  if (!targetId) return null;
  const URL = process.env.SUPABASE_URL;
  const KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (!URL || !KEY) return null;
  // HARD TIMEOUT (Aug 6, found live — a real gap, not defensive extra). The
  // try/catch below only ever handled a THROWN error; it did nothing for a
  // fetch that simply hangs (a stalled connection, a slow response, no
  // outright failure). Because this is awaited sequentially BEFORE
  // assemblePrefix()/writePrefix() run, a hang here meant call_prefix.prefix
  // never got written AT ALL — the caller-facing symptom: the model
  // receives no system prompt whatsoever and answers as bare, uncostumed
  // Claude ("I'm a text-based AI assistant"). This is an ENHANCEMENT (the
  // floor, not the whole dossier) — it must never be able to block the
  // core call from having a host prompt at all. AbortController + a short
  // ceiling; on abort, degrades to null exactly like any other failure
  // here — same safe path, just reachable now.
  const DOSSIER_FLOOR_TIMEOUT_MS = parseInt(process.env.DOSSIER_FLOOR_TIMEOUT_MS || "2000", 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOSSIER_FLOOR_TIMEOUT_MS);
  try {
    const r = await fetch(
      `${URL}/rest/v1/scout_facts?target_id=eq.${encodeURIComponent(targetId)}&select=source_lane,facts`,
      { headers: { apikey: KEY, authorization: `Bearer ${KEY}` }, signal: controller.signal }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;

    const bodyRow = rows.find((row) => row && row.source_lane === "body");
    const facts = (bodyRow && bodyRow.facts) || {};
    const name = facts.name || null;
    const title = facts.title || null;
    const company = facts.company || null;
    // LAST NAME (Aug 18, Andrew) — deliberately a SEPARATE field from name,
    // not merged into it. Awareness-only: the host silently knows it, never
    // volunteers it. Contract needed from Scouting: facts.last_name on the
    // SAME body-lane row as name/title/company (Channel 2, sender_identity/
    // email dissection) — same source, same reliability tier as name. Until
    // Scouting populates it this is always null and the block below is a
    // no-op, so shipping this now is safe.
    const lastName = facts.last_name || null;

    // Best-effort prior-contact detail — see the function comment above.
    const callRow = rows.find((row) => row && row.source_lane === "call");
    const priorDetail =
      callRow && callRow.facts && (callRow.facts.summary || callRow.facts.detail || null);

    // TOPICAL EXPERTISE (Aug 6, Andrew — replaces archetype for host framing).
    // Same email_dossier data _read.js's fuel-hook path already reads — this
    // is a SECOND consumption path for data that's already being written
    // (Email/Barbara's buildEmailDossier_ merges it into this SAME body-lane
    // row), not new tracking. RE-ANGLED on purpose: the fuel-hook version
    // frames this as "their claims, quote it back at them" (a callback/
    // gotcha device for a bit that may never fire). This is different —
    // baseline, unconditional, first-person: the host reached out BECAUSE
    // they're following up on a real email thread and have some genuine
    // familiarity with what's being offered, not a stalling target waiting
    // to be caught out. Pulls summary/hook only (not quotes/contradictions
    // — those stay bit-layer, this is the ambient floor, ruthlessly
    // minimal per Data's own guidance).
    const dossier = facts.email_dossier;
    const topicalSummary = dossier && dossier.summary ? dossier.summary : null;
    const topicalHook = dossier && dossier.hook ? dossier.hook : null;

    if (!name && !title && !company && !priorDetail && !topicalSummary && !lastName) return null;

    // FORMAT: labeled, terse, hard-capped. This bakes into the CACHED prefix
    // and pays a token cost on every turn of every call — ruthlessly
    // minimal per Data's own guidance, not prose.
    const parts = [];
    if (name) parts.push(`Target "${name}"`);
    const role = [title, company].filter(Boolean).join(" at ");
    if (role) parts.push(`claims ${role}`);
    let line = parts.join(", ");
    if (topicalSummary) {
      line += (line ? ". " : "") + "Reason for this call: you followed up on their " +
        "email pitch — " + String(topicalSummary).slice(0, 140) +
        (topicalHook ? " (" + String(topicalHook).slice(0, 60) + ")" : "") +
        " — you're genuinely weighing whether to learn more/move forward.";
    }
    if (priorDetail) {
      line += (line ? ". " : "") + "Prior contact: " + String(priorDetail).slice(0, 120);
    }
    // LAST NAME — appended LAST on purpose: it's the newest, lowest-priority
    // addition, so if the 400-char cap ever bites, this is what gets
    // truncated first, never the older/more-established identity/prior-
    // contact content. Explicitly framed as private background, not a
    // greeting cue — this must never collide with the separate, spoken
    // "NAME AT OUTSET" logic in completions.js.
    if (lastName) {
      line += (line ? ". " : "") + "You also privately know their last name " +
        "is \"" + String(lastName).slice(0, 60) + "\" (from their email) — " +
        "background only, never volunteer or announce it; use it only if " +
        "the conversation itself genuinely calls for it.";
    }
    // Hard cap widened (240 -> 400) to fit the topical-expertise sentence
    // alongside identity/prior-contact — still a floor, not the whole
    // dossier; truncate rather than let any one part blow the budget.
    return line.slice(0, 400) || null;
  } catch (e) {
    // AbortError specifically means the timeout fired — log it distinctly
    // from a genuine fetch/parse failure so a pattern of timeouts (vs. one-
    // off errors) is easy to spot in the logs later.
    const isTimeout = e && e.name === "AbortError";
    console.log(
      "hydrate: readDossierFloor " + (isTimeout ? "TIMED OUT after " + DOSSIER_FLOOR_TIMEOUT_MS + "ms" : "failed: " + (e && e.message))
    );
    return null; // never blocks hydrate — the floor degrading to absent is safe
  } finally {
    // Clears on EVERY exit path (success, any early return, or the catch
    // above) — the one thing a scattering of individual clearTimeout calls
    // before each return would risk missing.
    clearTimeout(timer);
  }
}

// Write the compiled prefix to call_prefix via the store. setCall handles the
// upsert; we pass prefix + archetype (+ the initial posture line so turn 1 has
// one before the engine sets its own).
async function writePrefix(callId, prefix, archetype, postureLine, targetId, overlays, latestCallId, hostName) {
  const { setCall } = require("./_store.js");
  // targetId rides the same path archetype does: resolved once here from the
  // booking token, frozen on the call_prefix row, read back by completions on
  // every turn. Mead Hall stamps it on each event so the Director can open the
  // watch surface BEFORE the call — target is knowable in advance, the call_id
  // (the LiveKit room name) is not.
  // overlays = { openerOverlay, businessOverlay } — the two swappable phase
  // blocks, stored frozen on the row; completions reads them and appends the
  // phase-selected one at send time. Optional (older callers omit -> null).
  // latestCallId (Aug 10, self-correcting call_id fix): OPTIONAL, only ever
  // passed when writing the "slug:<slug>" row — stamps the real, current
  // call_id onto that row so anyone who only knows the slug (Mead Hall, a
  // console command) can look up the current live call without risking a
  // stale, manually-copied id from an earlier test.
  await setCall(callId, {
    prefix,
    archetype,
    postureLine,
    targetId: targetId ?? null,
    openerOverlay: (overlays && overlays.openerOverlay) ?? null,
    businessOverlay: (overlays && overlays.businessOverlay) ?? null,
    ...(latestCallId !== undefined ? { latestCallId } : {}),
    // HOST-NAME PERSISTENCE (Aug 18) — resolved here from the booking token
    // (the only place it's reliably known on LiveKit; completions.js's own
    // hostNameFromBody() checks four metadata paths that are all Vapi-era
    // and empty on LiveKit, confirmed live via HOSTNAME-DIAG). Persisting
    // it here lets completions.js read stored.hostName directly instead of
    // those broken checks — same "resolve once at hydrate time, read many
    // times" pattern prefix/targetId already use.
    ...(hostName !== undefined ? { hostName } : {}),
  });
}

// AUTO RE-HYDRATE (Aug 26) — the real fix for a drift found this
// session: updating booking_tokens.host_name does NOT retroactively
// refresh an already-baked, cached prefix — only an explicit re-hydrate
// does, and nothing previously called this automatically. This function
// is that re-hydrate, callable directly (not just via the HTTP endpoint)
// so completions.js can self-heal a stale host name the same way it
// already self-heals a missing prefix (item 55's fix) — same philosophy,
// same call site, extended to catch a second kind of staleness.
// Deliberately a SEPARATE, minimal function rather than refactoring the
// full HTTP handler below — reuses the same building blocks (readToken/
// readDossierFloor/assemblePrefix/writePrefix), duplicating just the
// substitution sequence rather than risking a regression to the already-
// working endpoint via an aggressive extraction. Skips the POST-body
// sound-marker read (only meaningful for the live HTTP-triggered path —
// an internal auto-heal call has no request body to read from); the
// prefix just won't carry that section until the next real hydrate.js
// HTTP call refreshes it with real markers, same as any hydrate that
// runs without a body today.
async function rehydrateSlug(slug) {
  const token = await readToken(slug);
  if (!token) return null;
  const dossierFloor = await readDossierFloor(token.target_id);
  const posture = "innocent";
  const cfg = {
    posture,
    bits: [],
    armedBench: [],
    target: token.target_id || null,
    dossierFloor,
    soundMarkers: null,
    tactic: token.archetype || "universal",
    host_name: token.host_name || null,
    host_email: token.owner_email || null,
    secondCall: false,
  };
  const assembled = assemblePrefix(cfg);
  let prefix = assembled.stablePrefix;
  let openerOverlay = assembled.openerOverlay || "";
  let businessOverlay = assembled.businessOverlay || "";
  // Same substitution sequence as the HTTP handler below, kept identical
  // on purpose — a drift-triggered rebuild must produce byte-for-byte the
  // same shape of prefix a normal hydrate would, just with the current
  // host_name instead of whatever was frozen in before.
  // REPLACED (2026-09-09, Andrew: get rid of Dude) — a fixed, ordinary
  // generic name instead. Deliberately NOT randomized per call: the new
  // active name-extraction arc means this fallback rarely even surfaces
  // in practice (only if that arc doesn't complete), and randomizing
  // would break cross-call cache reuse for cold-open house calls (the
  // prefix needs to stay byte-identical across calls to the same line
  // for Anthropic's caching to help — confirmed earlier this session).
  // Still satisfies the original Aug 25 constraint: a fixed generic
  // name, never a specific real person, so a broken/missing host_name
  // never makes the host impersonate someone.
  const hostName = (cfg.host_name && String(cfg.host_name).trim()) || "Chris";
  prefix = prefix.split("[HOST NAME]").join(hostName);
  openerOverlay = openerOverlay.split("[HOST NAME]").join(hostName);
  businessOverlay = businessOverlay.split("[HOST NAME]").join(hostName);
  prefix = prefix.replace(
    /YOUR IDENTITY[\s\S]*?same energy, different voice\./,
    "YOUR IDENTITY\nYou are " + hostName + " — warm, distracted, genuine, and " +
      "you remember the email thread."
  );
  prefix = prefix.split("Andrea").join(hostName);
  const initialPosture = posture.toUpperCase() + " — warm and forward.";
  const overlays = { openerOverlay, businessOverlay };
  await writePrefix("slug:" + slug, prefix, cfg.tactic, initialPosture, cfg.target, overlays, null, hostName);
  console.log("rehydrateSlug: refreshed slug=" + slug + " hostName=" + hostName);
  return { prefix, hostName, openerOverlay, businessOverlay };
}

module.exports = async function handler(req, res) {
  // Accept POST /api/hydrate?slug=..[&call_id=..]
  // call_id is OPTIONAL: we ALWAYS write the prefix under a slug key
  // ("slug:<slug>") so it exists BEFORE the Vapi call_id is known — this
  // removes the hydrate-vs-first-turn race. If call_id is supplied we also
  // write it there. completions reads call_id first, then the slug key.
  try {
    const url = new URL(req.url, "http://x");
    const slug = url.searchParams.get("slug");
    const callId =
      url.searchParams.get("call_id") ||
      url.searchParams.get("vapi_call_id");
    if (!slug) {
      // CONTENT-TYPE FIX (Aug 13) — see the success-path comment below for
      // the full story; every response path here needed this.
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "missing slug" }));
    }

    // SOUND MARKERS (Aug 7, Voice — deployed on their side already). New:
    // the agent now sends its LIVE boot-time filesystem-scan inventory in
    // the JSON body, alongside a mirrored (harmless, non-authoritative)
    // slug — the REAL slug stays the query param above, unchanged, per
    // Voice's own confirmation ("your slug-read is unchanged"). Reading the
    // body is new; hydrate.js has never done this before (only ever read
    // query params, even on POST). Never hardcode this list — the whole
    // point is it auto-updates with whatever's actually in the agent's
    // sounds/ folder. Best-effort: a body-read failure (no body sent, bad
    // JSON, an older agent build) never blocks hydrate — just means no
    // sound-inventory section gets added to the prefix this call, same
    // fail-open posture as the dossier floor.
    let soundMarkers = null;
    try {
      let rawBody = "";
      await new Promise((resolve) => {
        req.on("data", (c) => (rawBody += c));
        req.on("end", resolve);
        req.on("error", resolve); // never hang hydrate on a body-read error
      });
      if (rawBody) {
        const parsed = JSON.parse(rawBody);
        if (Array.isArray(parsed.sound_markers) && parsed.sound_markers.length) {
          soundMarkers = parsed.sound_markers
            .filter((m) => typeof m === "string" && m.trim())
            .map((m) => m.trim().toUpperCase());
        }
      }
    } catch (e) {
      console.log("hydrate: sound_markers body-read failed (non-fatal): " + (e && e.message));
    }

    const token = await readToken(slug);
    if (!token) {
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "unknown slug" }));
    }

    // HOST CONFIG VOICE (2026-09-04) — read alongside the token, applies
    // to BOTH web and phone (host_name is present on both). See
    // readHostConfigVoice's own comment for the join-key caveat.
    //
    // DOSSIER FLOOR: read once here, alongside the token, before assembling —
    // condensed identity + top prior-contact fact, ~50 tokens, baked into the
    // STABLE prefix (see readDossierFloor's own comment for the full account
    // and the one open question re: the prior-contact lane name). Never
    // throws/blocks hydrate — degrades to null (the placeholder text) if
    // anything about this read fails or the target has no scout_facts yet.
    //
    // PARALLELIZED (2026-09-09, latency pass) — these two used to run as
    // sequential awaits, paying the full latency of both fetches added
    // together, even though neither depends on the other's result (one
    // keys on token.host_name, the other on token.target_id). Both are
    // documented as never-throwing (degrade to null on any failure), so
    // Promise.all is safe here — no risk of one's rejection masking the
    // other's result the way it could for a function that might actually
    // throw. This is the fetch pair behind the "opener felt slow"
    // latency report — pays the cost of whichever is slower, not both.
    const [hostConfigVoice, dossierFloor] = await Promise.all([
      readHostConfigVoice(token.host_name),
      readDossierFloor(token.target_id),
    ]);

    // PHONE JOB FIELDS (2026-09-04, revised 2026-09-07 for inbound) — see
    // readPhoneJobFields' own comment for the full context. Only
    // meaningful for channel='phone' tokens; a no-op (null) for every
    // web token, and fails soft exactly like the dossier floor above if
    // the lookup comes back empty for any reason.
    //
    // jobId resolves from EITHER source, whichever applies: outbound
    // ph-<job_id> slugs encode it directly (slug.slice(3)); inbound
    // in-<house_call_id> slugs do NOT encode a job id at all (a
    // different identifier space), so those rely on
    // token.callback_job_id instead — Data's schema addition, stamped
    // by Booking's mint-token when a mode='user' inbound call resolves
    // to the job whose planted number it's calling back. Both paths
    // converge on the exact same downstream lookup/formatting, no
    // duplicated logic.
    const jobId =
      (slug && slug.startsWith("ph-") && slug.slice(3)) ||
      token.callback_job_id ||
      null;
    const phoneJobFields = token.channel === "phone"
      ? await readPhoneJobFields(jobId)
      : null;
    const callerContextBrief = formatCallerContextBrief(
      phoneJobFields && phoneJobFields.caller_context
    );
    const askForDirective = formatAskForDirective(
      phoneJobFields && phoneJobFields.ask_for
    );

    // COLD-OPEN INBOUND (2026-09-07) — mode='house': inbound, phone, but
    // no job ever resolved (phoneJobFields is null). Genuinely different
    // from every other phone case: no caller_context, no ask_for, and —
    // per Andrew's explicit decision — no archetype register either,
    // even once a scam pattern emerges mid-call. So the normal archetype
    // signal is deliberately SKIPPED here (its own "generic" fallback
    // would just create noise alongside this directive's own "register
    // stays neutral" instruction), and this directive replaces it.
    const isColdOpenInbound =
      token.channel === "phone" &&
      typeof slug === "string" &&
      slug.startsWith("in-") &&
      !phoneJobFields;
    const coldOpenDirective = isColdOpenInbound ? formatColdOpenDirective() : null;

    // ARCHETYPE + CHANNEL (2026-09-06) — both locked once for the whole
    // call (same as target_id), so both are stated ONCE here, baked into
    // the cached prefix — no per-turn signal needed, no phase-style swap
    // machinery. Both are now plain FACT statements (REVISED: archetype
    // was originally a server-side block-selector; corrected once
    // Canon's real content showed all five registers ship together in
    // CORE and the model self-selects — see formatArchetypeSignal's own
    // comment). Together these are the actual fix for the video-messy-
    // open-on-a-phone-call bug and for the archetype content being dead
    // until now: both rules already existed correctly in CORE, neither
    // ever had the fact it needed to fire. archetypeSignal is skipped
    // entirely for cold-open inbound — see isColdOpenInbound above.
    const archetypeSignal = isColdOpenInbound ? null : formatArchetypeSignal(token.archetype);
    const channelSignal = formatChannelSignal(token.channel);
    // REVISED (2026-09-07, Recording) — gate lifted from channel='phone'
    // to unconditional: recording_stop applies to web calls too, not
    // just phone. Web calls get recorded the same way phone calls do
    // (calls.recording_* in the close path is channel-agnostic), so the
    // objection handling needs to be too.
    const recordingObjectionExit = formatRecordingObjectionExitDirective();

    // Folded into dossierFloor itself (not a separate cfg field) — this
    // guarantees it actually reaches the compiled prefix through the
    // SAME path already proven working, without needing a matching
    // change in compiler/assemble.js (a file I don't have in this
    // session, so I can't confirm it would read a brand-new cfg field
    // on its own). channelSignal is always present; archetypeSignal is
    // present unless cold-open inbound, in which case coldOpenDirective
    // takes its place. recordingObjectionExit is present on every phone
    // call regardless of mode/direction, per Canon's ruling.
    const dossierFloorWithCallerContext = [
      dossierFloor,
      callerContextBrief,
      askForDirective,
      coldOpenDirective,
      archetypeSignal,
      channelSignal,
      recordingObjectionExit,
    ]
      .filter(Boolean)
      .join("\n\n");

    // CUT (Aug 10, PE code-cut certification) — was: const posture =
    // process.env.SV_DEFAULT_POSTURE || "skald", a genuine "which of the
    // Eight" selection per call. The host is now a single constant
    // character; nothing chooses a posture anymore. Kept as a fixed,
    // non-selecting constant (not removed outright) specifically because
    // this value still rides in the JSON response returned to the agent
    // below (posture, postureLine) — I can't verify from this file alone
    // whether the agent's own code depends on those response fields
    // existing, so the SELECTION is cut but the response SHAPE is left
    // stable. Worth Voice confirming whether these two response fields
    // can be dropped entirely, or should stay for backward compatibility.
    const posture = "innocent"; // no longer selected; fixed, not chosen
    const cfg = {
      posture,
      // BITS: empty loadout in the prefix — intentional. The engine scores bits
      // from the full registry (_bits_registry.js) at turn time, independent of
      // the prefix, and injects a fired bit's directive AFTER the cache
      // breakpoint (never from this loadout). So loading all active bits here
      // would just bloat the cached prefix with prose the engine gets elsewhere.
      // The Mead Hall board (six bits) is the Director's remote, not the engine's
      // menu; PE plays the whole library on its own. Empty is correct.
      bits: [],
      armedBench: [], // room starts empty; bench sent in live
      target: token.target_id || null,
      // dossierFloor NOW carries the phone caller-context brief appended
      // when present (2026-09-04) — see callerContextBrief above. Web
      // calls and phone calls with no caller_context are byte-identical
      // to before this change.
      dossierFloor: dossierFloorWithCallerContext,
      soundMarkers, // NEW (Aug 7) — live marker inventory from the agent, or null
      tactic: token.archetype || "universal",
      host_name: token.host_name || null,
      // HOST'S REAL EMAIL (Aug 25, Andrew's ask) — this exact extension
      // point was already anticipated: "identity: deferred until
      // owner_email lands on the token" (see comment right below).
      // owner_email is that anticipated column, now landed and read.
      // Same discipline as host_name — null when absent, never a
      // hardcoded/fabricated fallback (unlike host_name's "Chris" default,
      // there's no safe generic placeholder for an email; better the
      // model has grounds to decline/deflect than invent a plausible-
      // looking fake AS IF it were the real one).
      host_email: token.owner_email || null,
      secondCall: false,
      // identity: deferred until owner_email lands on the token
    };

    const assembled = assemblePrefix(cfg);
    let prefix = assembled.stablePrefix;
    // MARKER-THRESHOLD CONSISTENCY CHECK (Aug 7). Bits' per-marker
    // escalation table (in completions.js) is authored against marker
    // NAMES — if a name in that table doesn't match anything in the
    // actual live inventory this call received, that entry's threshold
    // silently never applies. Checked HERE, not in completions.js,
    // specifically because cfg.soundMarkers is genuinely in scope at this
    // exact point and nowhere else without adding a new persisted column
    // (which would repeat the exact shared-SELECT-list risk that broke
    // every read once already this session). Runs once per call, cheap,
    // never blocks hydrate. Table kept here as a literal duplicate of
    // completions.js's MARKER_THRESHOLDS keys — if Bits' table changes,
    // this list needs updating too (a real, known dual-maintenance point,
    // flagged rather than pretended away).
    //
    // SUFFIX-AWARE MATCHING (Aug 7, Voice's clarification): _LOOP/_STOP
    // are NOT separate clip families — they're a suffix convention that
    // reuses the BASE marker's existing clips (DOG_BARK_LOOP loops
    // DOG_BARK's own clips; DOG_BARK_STOP ends it). The flat
    // sound_markers list therefore only ever contains base names (plus
    // explicit _BG entries, which DO have their own dedicated files) —
    // it never enumerates the derived _LOOP/_STOP variants. So a
    // threshold-table entry is genuinely valid if it EITHER exactly
    // matches the inventory, OR matches after stripping a trailing
    // _LOOP or _STOP (which also correctly resolves DISHWASHER_BG_STOP
    // down to DISHWASHER_BG, itself already an explicit inventory entry).
    try {
      const KNOWN_THRESHOLD_MARKERS = [
        "DOG_BARK", "DOG_BARK_LOOP", "TYPING_LOOP", "DOOR_SLAM", "DOORBELL",
        "COFFEE_CUP_BREAK", "SNEEZE", "COUGH", "THROAT_CLEAR",
        "DISHWASHER_BG", "THUNDER_BG", "DUMP_TRUCK_BG", "TAKEOFF_BG",
      ];
      const stripLoopStopSuffix = (name) =>
        name.endsWith("_LOOP") ? name.slice(0, -5)
        : name.endsWith("_STOP") ? name.slice(0, -5)
        : name;
      if (Array.isArray(cfg.soundMarkers) && cfg.soundMarkers.length) {
        const unmatched = KNOWN_THRESHOLD_MARKERS.filter((m) => {
          if (cfg.soundMarkers.includes(m)) return false; // exact match
          const base = stripLoopStopSuffix(m);
          return !cfg.soundMarkers.includes(base); // valid if the base clip exists
        });
        if (unmatched.length) {
          console.log(
            "hydrate: MARKER-THRESHOLD-MISMATCH — these threshold-table " +
            "entries don't match the live inventory even after suffix " +
            "stripping (" + cfg.soundMarkers.join(", ") +
            "), their thresholds will never apply: " + unmatched.join(", ")
          );
        }
      }
    } catch { /* diagnostic only, must never block hydrate */ }
    // PHASE OVERLAYS — the two swappable blocks carried alongside the frozen
    // prefix (assemble.js returns them separately; NOT baked into stablePrefix).
    // completions.js appends the phase-selected one after the cached region.
    let openerOverlay = assembled.openerOverlay || "";
    let businessOverlay = assembled.businessOverlay || "";

    // [HOST NAME] substitution: the Master Host Prompt uses [HOST NAME] as a
    // placeholder token. It MUST be replaced with the real host name (from the
    // booking token) before shipping, or the model sees the raw "Andrew OR
    // Andrea" identity explanation and improvises a name. Substitute here at
    // hydrate time, where host_name is in hand.
    // FALLBACK CHANGED (Aug 25, Andrew's explicit ask): was hardcoded
    // "Andrew" — a broken/missing token.host_name would silently make
    // every host on every call impersonate one specific real person.
    // A genuinely generic placeholder instead, matching the same
    // fallback change just made in meeting.js for consistency.
    // REPLACED (2026-09-09, Andrew: get rid of Dude) — a fixed, ordinary
  // generic name instead. Deliberately NOT randomized per call: the new
  // active name-extraction arc means this fallback rarely even surfaces
  // in practice (only if that arc doesn't complete), and randomizing
  // would break cross-call cache reuse for cold-open house calls (the
  // prefix needs to stay byte-identical across calls to the same line
  // for Anthropic's caching to help — confirmed earlier this session).
  // Still satisfies the original Aug 25 constraint: a fixed generic
  // name, never a specific real person, so a broken/missing host_name
  // never makes the host impersonate someone.
  const hostName = (cfg.host_name && String(cfg.host_name).trim()) || "Chris";
    prefix = prefix.split("[HOST NAME]").join(hostName);
    // The token also appears in the OPENER overlay's empty-open example (the
    // BUSINESS overlay has none — the sub is a safe no-op there). Substitute in
    // both so no raw placeholder ships in an overlay either.
    openerOverlay = openerOverlay.split("[HOST NAME]").join(hostName);
    businessOverlay = businessOverlay.split("[HOST NAME]").join(hostName);
    // Remove the ENTIRE dual-identity section (the "YOUR IDENTITY" header through
    // the ANDREA description) and replace with a single clear line, so the model
    // is never told it could be Andrew OR Andrea and never sees the name "Andrea"
    // at all. The old regex stopped at the first "different voice." and left the
    // ANDREW/ANDREA block intact — this removes the whole block.
    prefix = prefix.replace(
      /YOUR IDENTITY[\s\S]*?same energy, different voice\./,
      "YOUR IDENTITY\nYou are " + hostName + " — warm, distracted, genuine, and " +
        "you remember the email thread."
    );
    // Safety net: if any stray "Andrea" survives (text drift), neutralize it.
    prefix = prefix.split("Andrea").join(hostName);

    // Initial posture line so turn 1 has a value; the engine overwrites per turn.
    const initialPosture = posture.toUpperCase() + " — warm and forward.";

    // ALWAYS write the slug key (pre-call safe, removes the race). Also write
    // the call_id row if we have it (the direct hit).
    const overlays = { openerOverlay, businessOverlay };
    // latestCallId only ever passed here (the slug: row) — null when callId
    // isn't known yet at this point in the request (still correct: means
    // "no live call for this slug right now," which is real information).
    await writePrefix("slug:" + slug, prefix, cfg.tactic, initialPosture, cfg.target, overlays, callId || null, hostName);
    if (callId) {
      await writePrefix(callId, prefix, cfg.tactic, initialPosture, cfg.target, overlays, undefined, hostName);
    }

    // CACHE WARM — fired here, non-blocking, so it never delays hydrate's
    // own response to the agent (the agent needs this response quickly to
    // proceed with call setup). See warmCache()'s own comment for the
    // full reasoning. process.env.ANTHROPIC_API_KEY confirmed available
    // in this file already (completions.js's own generateBenchLine uses
    // the identical env var, same account/deploy).
    waitUntil(warmCache(prefix, callId));

    console.log(
      "hydrate OK slug=" +
        slug +
        (callId ? " call_id=" + callId : " (slug-key only)") +
        " posture=" +
        posture +
        " hash=" +
        assembled.hash
    );
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        ok: true,
        slug,
        call_id: callId || null,
        posture,
        hash: assembled.hash,
        // The compiled system prompt itself. Vapi ignored this (it read the
        // stored prefix per-request), but the LiveKit agent uses it DIRECTLY as
        // the session's system instructions — LiveKit holds no per-request call
        // identity, so it must receive the prompt text here at call start.
        prefix,
        // PHASE OVERLAYS — the two swappable blocks. The agent/engine appends
        // the phase-selected one after the cached prefix at send time (Option B).
        // Returned here so the LiveKit agent, which reads the prompt from this
        // response at call start, has them alongside the prefix.
        openerOverlay,
        businessOverlay,
        postureLine: initialPosture,
        // target_id — resolved from booking_tokens by slug at call start. The
        // agent needs it to write a calls row on a silence/bail close (Barbara
        // keys her follow-up ladder off target_id). Returned here so the agent
        // reads it from the same hydrate payload, no separate query.
        target_id: cfg.target || null,
        // Per-slug voice config. Sourced from booking_tokens.voice (jsonb,
        // old shape: { voice_id, model, stability, similarity }).
        //
        // SUPERSEDED (2026-09-04, Data) by host_config's six voice dials,
        // mapped by readHostConfigVoice above into the exact key names the
        // agent reads (voice/model/emotion/speed/volume/sex — NOT the old
        // voice_id/stability/similarity shape). hostConfigVoice wins when
        // present; token.voice stays as a fallback for any token that
        // still carries the old per-slug override and has no host_config
        // row yet — not explicitly instructed, a defensive choice so this
        // change can't silently break an existing working override.
        // Confirm whether that fallback is wanted or host_config should
        // be the sole source now.
        voice: hostConfigVoice || token.voice || null,
        // PHONE JOB FIELDS (2026-09-04) — null on every web call, and
        // null on a phone call if the callback_jobs join found nothing
        // (fails soft, never blocks the response). See
        // readPhoneJobFields' comment for the full context on why these
        // are read here despite not living on the token itself.
        dial_extension: (phoneJobFields && phoneJobFields.dial_extension) || null,
        ask_for: (phoneJobFields && phoneJobFields.ask_for) || null,
        reference_code: (phoneJobFields && phoneJobFields.reference_code) || null,
      })
    );
  } catch (e) {
    console.log("hydrate FAILED: " + (e && e.message));
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: String(e && e.message) }));
  }
};

// EXPORT ORDER MATTERS (Aug 26) — attaching a property to module.exports
// BEFORE reassigning module.exports to the handler function silently
// discards it (module.exports.x = ... sets a property on whatever object
// module.exports currently is; a later module.exports = handler REPLACES
// that whole object, taking the property with it — confirmed the hard way
// once already this session, on call-stream.js's config). Attaching AFTER
// the handler is already assigned avoids that exact bug.
module.exports.rehydrateSlug = rehydrateSlug;

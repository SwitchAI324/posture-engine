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

    // DOSSIER FLOOR: read once here, alongside the token, before assembling —
    // condensed identity + top prior-contact fact, ~50 tokens, baked into the
    // STABLE prefix (see readDossierFloor's own comment for the full account
    // and the one open question re: the prior-contact lane name). Never
    // throws/blocks hydrate — degrades to null (the placeholder text) if
    // anything about this read fails or the target has no scout_facts yet.
    const dossierFloor = await readDossierFloor(token.target_id);

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
      dossierFloor, // NEW (Aug 5) — the condensed ambient-floor string, or null
      soundMarkers, // NEW (Aug 7) — live marker inventory from the agent, or null
      tactic: token.archetype || "universal",
      host_name: token.host_name || null,
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
    const hostName = (cfg.host_name && String(cfg.host_name).trim()) || "Andrew";
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
        // Per-slug voice config (optional). Sourced from booking_tokens.voice
        // (jsonb), shape: { voice_id, model, stability, similarity }. The agent
        // merges this over its code defaults and falls back safely if null —
        // changing a host's voice = editing the Supabase row, zero deploys.
        voice: token.voice || null,
      })
    );
  } catch (e) {
    console.log("hydrate FAILED: " + (e && e.message));
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: String(e && e.message) }));
  }
};

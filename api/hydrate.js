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
// TRIGGER: called at call setup, right after the browser starts the Vapi call.
// meeting.js already POSTs /api/join?slug=..&call_id=.. after vapi.start
// returns the id — this route is called the same way (or folded into join).
// It has slug (-> booking_token: archetype/host_name/target) + call_id.
//
// cfg DECISIONS (locked with the other chats):
//   posture    = env SV_DEFAULT_POSTURE (neutral/warm default) — gears move it
//                per turn; the token carries no posture.
//   bits       = ALL ACTIVE bit ids (non-parked) — the per-turn scorer picks;
//                the Director arms specific ones live via Mead Hall.
//   armedBench = [] — room starts empty; bench is sent in live via Mead Hall.
//   archetype  = booking_token.archetype
//   target     = booking_token.target_id (dossier summary is a scouting read,
//                separate; here we pass the id)
//   host_name  = booking_token.host_name
//   identity   = DEFERRED (owner_email not on the token yet; add later)
// ----------------------------------------------------------------------

// IMPORT PATHS (resolved to the ACTUAL repo layout):
// - The LIVE compiler is in the ROOT compiler/ folder (assemble.js, providers.js,
//   bits.js, postures.json all live there). From api/hydrate.js that's
//   ../compiler/. (api/compiler/ held only a stray providers.js and is being
//   removed — do NOT import from there.)
// - The bits registry + store are siblings of this file under api/.
const { assemblePrefix } = require("../compiler/assemble.js");

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

// Write the compiled prefix to call_prefix via the store. setCall handles the
// upsert; we pass prefix + archetype (+ the initial posture line so turn 1 has
// one before the engine sets its own).
async function writePrefix(callId, prefix, archetype, postureLine) {
  const { setCall } = require("./_store.js");
  await setCall(callId, { prefix, archetype, postureLine });
}

module.exports = async function handler(req, res) {
  // Accept POST /api/hydrate?slug=..&call_id=..
  try {
    const url = new URL(req.url, "http://x");
    const slug = url.searchParams.get("slug");
    const callId =
      url.searchParams.get("call_id") ||
      url.searchParams.get("vapi_call_id");
    if (!slug || !callId) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "missing slug or call_id" }));
    }

    const token = await readToken(slug);
    if (!token) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "unknown slug" }));
    }

    const posture = process.env.SV_DEFAULT_POSTURE || "skald"; // neutral/warm
    const cfg = {
      posture,
     // BITS: empty loadout in the prefix — the engine scores from the full
      // registry at turn time and injects fired directives after the cache
      // breakpoint, not from this loadout. Loading all bits here just bloats
      // the cached prefix. Empty is correct.
      bits: [],
      armedBench: [], // room starts empty; bench sent in live
      target: token.target_id || null,
      tactic: token.archetype || "universal",
      host_name: token.host_name || null,
      secondCall: false,
      // identity: deferred until owner_email lands on the token
    };

    const assembled = assemblePrefix(cfg);
    const prefix = assembled.stablePrefix;

    // Initial posture line so turn 1 has a value; the engine overwrites per turn.
    const initialPosture = posture.toUpperCase() + " — warm and forward.";

    await writePrefix(callId, prefix, cfg.tactic, initialPosture);

    console.log(
      "hydrate OK call_id=" +
        callId +
        " slug=" +
        slug +
        " posture=" +
        posture +
        " bits=" +
        cfg.bits.length +
        " hash=" +
        assembled.hash
    );
    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        ok: true,
        call_id: callId,
        posture,
        bits: cfg.bits.length,
        hash: assembled.hash,
      })
    );
  } catch (e) {
    console.log("hydrate FAILED: " + (e && e.message));
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: String(e && e.message) }));
  }
};

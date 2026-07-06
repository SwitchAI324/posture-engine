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

const { assemblePrefix } = require("./compiler/assemble.js");

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
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "missing slug" }));
    }

    const token = await readToken(slug);
    if (!token) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "unknown slug" }));
    }

    const posture = process.env.SV_DEFAULT_POSTURE || "skald"; // neutral/warm
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
      tactic: token.archetype || "universal",
      host_name: token.host_name || null,
      secondCall: false,
      // identity: deferred until owner_email lands on the token
    };

    const assembled = assemblePrefix(cfg);
    let prefix = assembled.stablePrefix;

    // [HOST NAME] substitution: the Master Host Prompt uses [HOST NAME] as a
    // placeholder token. It MUST be replaced with the real host name (from the
    // booking token) before shipping, or the model sees the raw "Andrew OR
    // Andrea" identity explanation and improvises a name. Substitute here at
    // hydrate time, where host_name is in hand.
    const hostName = (cfg.host_name && String(cfg.host_name).trim()) || "Andrew";
    prefix = prefix.split("[HOST NAME]").join(hostName);
    // Also collapse the dual-identity explainer to just the chosen name, so the
    // model isn't told it could be either. Keep it simple + safe.
    prefix = prefix.replace(
      /Andrew and Andrea are two sides of the same coin[\s\S]*?different voice\./,
      "You are " + hostName + " — warm, distracted, genuine; you remember the " +
        "email thread."
    );

    // Initial posture line so turn 1 has a value; the engine overwrites per turn.
    const initialPosture = posture.toUpperCase() + " — warm and forward.";

    // ALWAYS write the slug key (pre-call safe, removes the race). Also write
    // the call_id row if we have it (the direct hit).
    await writePrefix("slug:" + slug, prefix, cfg.tactic, initialPosture);
    if (callId) {
      await writePrefix(callId, prefix, cfg.tactic, initialPosture);
    }

    console.log(
      "hydrate OK slug=" +
        slug +
        (callId ? " call_id=" + callId : " (slug-key only)") +
        " posture=" +
        posture +
        " hash=" +
        assembled.hash
    );
    res.statusCode = 200;
    return res.end(
      JSON.stringify({
        ok: true,
        slug,
        call_id: callId || null,
        posture,
        hash: assembled.hash,
      })
    );
  } catch (e) {
    console.log("hydrate FAILED: " + (e && e.message));
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: String(e && e.message) }));
  }
};

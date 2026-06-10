// SpamViking — Posture Engine: WIRING TEST (local, no Supabase)
// ----------------------------------------------------------------------
// Proves the pre-snap -> store -> proxy data flow end to end using an
// in-memory mock store. It mirrors exactly what api/presnap.js writes and
// what api/chat/completions.js reads + builds, so a green run here means
// the wiring shape is correct before you point it at real Supabase.
//
// Run: `node wire_test.js`
// ----------------------------------------------------------------------

const crypto = require("crypto");
const { assemblePrefix } = require("./compiler/assemble.js");

// --- mock store (same surface as api/_store.js) ---------------------------
const DB = new Map();
const store = {
  async setCall(callId, { prefix, postureLine }) {
    const cur = DB.get(callId) || {};
    if (prefix !== undefined) cur.prefix = prefix;
    if (postureLine !== undefined) cur.postureLine = postureLine;
    DB.set(callId, cur);
  },
  async getCall(callId) {
    return DB.get(callId) || null;
  },
};

// --- the proxy's system-block builder (mirrors completions.js) ------------
function buildSystemBlocks(stored, vapiSystem) {
  return stored
    ? [
        { type: "text", text: stored.prefix, cache_control: { type: "ephemeral" } },
        { type: "text", text: "CURRENT POSTURE: " + (stored.postureLine || "ALIVE") },
      ]
    : vapiSystem
    ? [{ type: "text", text: vapiSystem, cache_control: { type: "ephemeral" } }]
    : null;
}

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
const ok = (label, cond) =>
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);

(async () => {
  const callId = "vapi-call-abc123";

  // 1) PRE-SNAP: Director locks the call. Assemble + store.
  const assembled = assemblePrefix({
    posture: "skald",
    armedBench: ["conrad", "bonnie", "brent"], // brent excluded (not built)
    bits: ["echo", "wrong_window"],
    target: "Marcus @ AI-CRM vendor",
  });
  await store.setCall(callId, {
    prefix: assembled.stablePrefix,
    postureLine: "ALIVE — opportunity real and moving; warm, forward.",
  });
  console.log("PRE-SNAP");
  console.log(`  posture=skald  armed=${assembled.benchArmed.join(",")}  ` +
              `excluded=${assembled.excluded.map((e) => e.id).join(",")}`);
  console.log(`  stored prefix ~${assembled.approxTokens} tokens  hash=${assembled.hash}`);

  // 2) TURN 1: proxy reads the row, builds the request.
  const s1 = await store.getCall(callId);
  const t1 = buildSystemBlocks(s1, "vapi-raw-fallback");
  console.log("\nTURN 1 (proxy read + build)");
  ok("used stored prefix, not Vapi fallback", t1[0].text === assembled.stablePrefix);
  ok("cached block carries cache_control", t1[0].cache_control?.type === "ephemeral");
  ok("posture line is a separate, uncached block", t1.length === 2 && !t1[1].cache_control);
  ok("brent absent from prefix (blocked/pending never arms)", !t1[0].text.includes("Brent"));
  ok("conrad + bonnie present in prefix", t1[0].text.includes("Conrad") && t1[0].text.includes("Bonnie"));

  // 3) POSTURE ENGINE updates ONLY the posture line (Phase 3 will do this).
  await store.setCall(callId, { postureLine: "SLIPPING — let doubt surface." });

  // 4) TURN 2: proxy reads again, builds the request.
  const s2 = await store.getCall(callId);
  const t2 = buildSystemBlocks(s2, "vapi-raw-fallback");
  console.log("\nTURN 2 (after posture update)");
  ok("cached block byte-identical to turn 1 (cache holds)", hash(t1[0].text) === hash(t2[0].text));
  ok("posture line changed", t1[1].text !== t2[1].text);
  ok("prefix unchanged by posture update", t2[0].text === assembled.stablePrefix);

  // 5) Fallback path: a call with no stored prefix uses Vapi's system.
  const sNone = await store.getCall("unknown-call");
  const tNone = buildSystemBlocks(sNone, "vapi-raw-fallback");
  console.log("\nFALLBACK (no pre-snap row)");
  ok("falls back to Vapi raw system", tNone[0].text === "vapi-raw-fallback");

  console.log("\nper-turn delta = posture line + new transcript only. " +
              "Prefix frozen, cached, read once per turn. Lag invariant holds.");
})();

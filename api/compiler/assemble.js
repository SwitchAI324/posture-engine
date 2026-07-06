// SpamViking — Posture Engine: THE FOUR-DOCUMENT MERGE
// ----------------------------------------------------------------------
// Folds the four compile inputs into ONE frozen prefix per call:
//
//   [1] HOST BASE      (The Six)            \
//   [2] BIT LOADOUT    (Bits Library)        |  one cached block,
//   [3] REFRAMED BENCH (the real compiler)   |  cache_control breakpoint
//   [4] CALL CONTEXT   (Data/Product Logic) /   at the very end
//   --------------------------------------------------------------------
//   CURRENT POSTURE: <line>   <- the ONLY mutable element, per turn,
//   <rolling transcript>          AFTER the breakpoint (never cached)
//
// Invariants this file enforces structurally:
//   * The frozen prefix is byte-identical across every turn of a call, so
//     it caches. (proved at the bottom: same hash on two different turns)
//   * Non-armable bench cells (blocked / pending) are EXCLUDED — they can
//     never enter the prefix, so they can never be woken.
//   * Per turn, only the posture line changes. buildTurn() physically
//     cannot touch the cached block.
//
// No per-turn LLM, no per-turn compile. All assembly is pre-snap.
// Run: `node assemble.js`
// ----------------------------------------------------------------------

const crypto = require("crypto");
const POSTURES = require("./postures.json");
const { compile, render } = require("./compile.js");
const { hostBaseFor, loadoutFor, callStableContext } = require("./providers.js");

const rule = (t) => `\n----- ${t} ${"-".repeat(Math.max(0, 56 - t.length))}`;

// ---- ASSEMBLE (pre-snap, once per call) ----------------------------------
function assemblePrefix(cfg) {
  const posture = POSTURES[cfg.posture];
  if (!posture) throw new Error(`unknown posture: ${cfg.posture}`);

  // [3] reframed bench — from the REAL compiler. Armable only.
  const benchBlocks = [];
  const excluded = [];
  for (const id of cfg.armedBench || []) {
    const out = compile(cfg.posture, id);
    if (out.armable) benchBlocks.push(render(out));
    else excluded.push({ id, status: out.status, why: out.reason || out.note });
  }

  const benchSection = benchBlocks.length
    ? "These bench members are ARMED for this call but NOT YET PRESENT. " +
      "They join only when woken — a fictional surprise in the story, not a " +
      "new instruction. Do not act as if they are already here.\n\n" +
      benchBlocks.join("\n\n")
    : "No bench members armed for this call.";

  // Assemble ONE stable block, in the locked order.
  const stablePrefix = [
    "=== SPAMVIKING FROZEN CALL PREFIX (stable for the whole call) ===",
    rule(`1 · HOST BASE — ${posture.name} (${posture.gender})`),
    hostBaseFor(cfg.posture),
    rule("2 · BIT LOADOUT"),
    loadoutFor(cfg.bits || []),
    rule("3 · BENCH (armed, dormant)"),
    benchSection,
    rule("4 · CALL CONTEXT"),
    callStableContext(cfg),
  ].join("\n\n");

  return {
    posture: cfg.posture,
    stablePrefix,
    benchArmed: (cfg.armedBench || []).filter(
      (id) => !excluded.find((e) => e.id === id)
    ),
    excluded,
    hash: crypto.createHash("sha256").update(stablePrefix).digest("hex").slice(0, 16),
    approxTokens: Math.round(stablePrefix.length / 4),
  };
}

// ---- PER TURN (the only thing that moves) --------------------------------
// Takes the frozen prefix + this turn's posture line + transcript and
// returns the exact Anthropic request. The cached block is passed straight
// through, untouched; only system[1] (the posture line) varies.
function buildTurn(assembled, postureLine, transcript, opts = {}) {
  return {
    model: opts.model || "claude-haiku-4-5-20251001",
    max_tokens: opts.maxTokens || 1024,
    stream: true,
    system: [
      // FROZEN + CACHED — identical every turn.
      { type: "text", text: assembled.stablePrefix, cache_control: { type: "ephemeral" } },
      // MUTABLE — after the breakpoint, so changing it never busts the cache.
      { type: "text", text: "CURRENT POSTURE: " + postureLine },
    ],
    messages: transcript || [],
  };
}

// ---- DEMO ----------------------------------------------------------------
if (require.main === module) {
  const cfg = {
    posture: "skald",
    armedBench: ["conrad", "bonnie", "brent"], // brent isn't built -> excluded
    bits: ["echo", "wrong_window", "extensive_typing"],
    target: "Marcus @ AI-CRM vendor",
    tactic: "b2b_saas",
    secondCall: false,
  };

  const A = assemblePrefix(cfg);

  console.log("=".repeat(72));
  console.log(`ASSEMBLED PREFIX for posture=${cfg.posture}`);
  console.log("=".repeat(72));
  console.log(`  bench armed:   ${A.benchArmed.join(", ") || "(none)"}`);
  console.log(`  bench excluded:`);
  for (const e of A.excluded) console.log(`     - ${e.id}: ${e.status} (${e.why})`);
  console.log(`  prefix size:   ~${A.approxTokens} tokens`);
  console.log(`  prefix hash:   ${A.hash}`);

  // Two turns of the SAME call, different posture line.
  const t1 = buildTurn(A, "ALIVE — warm and forward.", [
    { role: "user", content: "Hi, is this a good time?" },
  ]);
  const t2 = buildTurn(A, "SLIPPING — let doubt surface.", [
    { role: "user", content: "Hi, is this a good time?" },
    { role: "assistant", content: "Mm. Go on." },
    { role: "user", content: "So our platform automates outreach—" },
  ]);

  const h1 = crypto.createHash("sha256").update(t1.system[0].text).digest("hex");
  const h2 = crypto.createHash("sha256").update(t2.system[0].text).digest("hex");

  console.log("\n" + "=".repeat(72));
  console.log("CACHE-STABILITY CHECK (across two turns of the call)");
  console.log("=".repeat(72));
  console.log(`  turn 1 cached-block hash: ${h1.slice(0, 16)}`);
  console.log(`  turn 2 cached-block hash: ${h2.slice(0, 16)}`);
  console.log(`  identical cached block?   ${h1 === h2 ? "YES — caches" : "NO — BUG"}`);
  console.log(`  posture line changed?     ${t1.system[1].text !== t2.system[1].text ? "YES" : "NO"}`);
  console.log(
    `  => per-turn delta is ONLY the posture line + the new transcript line. ` +
    `The ${A.approxTokens}-token prefix is reused from cache.\n`
  );

  // Emit the assembled prefix as a tangible artifact.
  const fs = require("fs");
  const path = require("path");
  const out = path.join(__dirname, "..", "compiled_call_prefix_example.md");
  fs.writeFileSync(
    out,
    `# Assembled frozen call prefix — example\n` +
      `*Emitted by compiler/assemble.js for posture=${cfg.posture}, ` +
      `armed=[${cfg.armedBench.join(", ")}] (brent excluded — not built). ` +
      `Sections 1/2/4 are placeholders from their threads; section 3 is real ` +
      `compiler output. The whole block below is ONE cached prefix; only the ` +
      `posture line varies per turn.*\n\n` +
      "```\n" + A.stablePrefix + "\n\n" +
      "CURRENT POSTURE: <-- the only mutable line, swapped each turn -->\n" +
      "```\n"
  );
  console.log("wrote compiled_call_prefix_example.md");
}

module.exports = { assemblePrefix, buildTurn };

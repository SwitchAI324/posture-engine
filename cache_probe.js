// SpamViking — Posture Engine cache probe
// ----------------------------------------------------------------------
// Closes the genuinely-unproven half of the proof point: that the stable
// prefix actually CACHES on the Anthropic path. Caching is NOT automatic —
// it engages only because of the cache_control breakpoint, and only if the
// prefix clears the model's minimum cacheable length.
//
// Method: build a realistic stable prefix (a real compiled Bench block +
// a stand-in compiled bible/bits pad), send it as a cache_control'd system
// block twice, varying ONLY the trailing posture line between calls. Read
// usage. Call 1 should CREATE cache; call 2 should READ it.
//
// Run:  ANTHROPIC_API_KEY=sk-ant-... node cache_probe.js
//       (optional) ANTHROPIC_MODEL=claude-haiku-4-5-20251001
// ----------------------------------------------------------------------

const { compile, render } = require("./compiler/compile.js");

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

if (!KEY) {
  console.error(
    "\nNo ANTHROPIC_API_KEY set — cannot measure caching.\n" +
      "This is the one step that needs a live key. Run:\n\n" +
      "  ANTHROPIC_API_KEY=sk-ant-... node cache_probe.js\n"
  );
  process.exit(1);
}

// --- build the stable prefix ---------------------------------------------
// Real compiled Bench block (proves it's the actual compiler output)...
const compiledBlock = render(compile("volva", "conrad"));

// ...plus a stand-in for the compiled bible + bits. The real prefix is far
// larger; this pad just guarantees we clear the min cacheable length so the
// probe is meaningful. Replace with the true four-document compile output
// once that merge exists (see INTEGRATION.md).
const padUnit =
  "COMPILED IN-CALL BIBLE / BITS (stand-in). The frozen prefix carries " +
  "the host base, the active loadout cards, and every armable reframed " +
  "bench block for this posture, resolved once at pre-snap and never " +
  "recomputed per turn. Only the posture line varies. ";
const pad = padUnit.repeat(60); // ~ a few thousand tokens

const STABLE_PREFIX =
  "=== SPAMVIKING FROZEN PREFIX (stable for the whole call) ===\n\n" +
  compiledBlock +
  "\n\n=== BIBLE + BITS ===\n" +
  pad;

const approxTokens = Math.round(STABLE_PREFIX.length / 4);

// --- one call -------------------------------------------------------------
async function callOnce(postureLine) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8,
      // The cached block: identical across both calls.
      system: [
        { type: "text", text: STABLE_PREFIX, cache_control: { type: "ephemeral" } },
      ],
      // The ONLY thing that differs is this trailing line — the per-turn
      // posture/transcript. It sits after the cache breakpoint, so it never
      // busts the cache.
      messages: [{ role: "user", content: postureLine + " Reply with: ok" }],
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.usage;
}

(async () => {
  console.log(`\nmodel: ${MODEL}`);
  console.log(`stable prefix: ~${approxTokens} tokens (${STABLE_PREFIX.length} chars)\n`);

  console.log("call 1 (posture: ALIVE) — expect cache CREATION ...");
  const u1 = await callOnce("CURRENT POSTURE: ALIVE — warm and forward.");
  console.log("  usage:", JSON.stringify(u1));

  console.log("call 2 (posture: SLIPPING) — expect cache READ ...");
  const u2 = await callOnce("CURRENT POSTURE: SLIPPING — let doubt surface.");
  console.log("  usage:", JSON.stringify(u2));

  const created = u1.cache_creation_input_tokens || 0;
  const read = u2.cache_read_input_tokens || 0;
  console.log("\n--- verdict ---");
  console.log(`  call 1 cache_creation_input_tokens: ${created}`);
  console.log(`  call 2 cache_read_input_tokens:     ${read}`);

  if (created > 0 && read > 0 && read >= created * 0.8) {
    console.log(
      `\n  PASS — the stable prefix cached. Call 2 re-read ${read} tokens ` +
        `from cache instead of re-prefilling them.\n` +
        `  Changing the posture line did NOT bust the cache.\n`
    );
  } else {
    console.log(
      `\n  NOT PROVEN — cache_read was ${read}. Common causes: prefix below ` +
        `the model's min cacheable length, model mismatch between calls, or ` +
        `the prefix text differing between calls.\n`
    );
  }
})().catch((e) => {
  console.error("\nprobe error:", e.message, "\n");
  process.exit(1);
});

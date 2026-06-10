// SpamViking — cache probe (STANDALONE, zero dependencies)
// ----------------------------------------------------------------------
// Proves the stable prefix actually CACHES on the Anthropic path. No other
// files needed — just Node 18+ and your API key. It builds a large prefix,
// sends it as a cache_control block twice (varying only the trailing line),
// and reads usage: call 1 should CREATE cache, call 2 should READ it.
//
// macOS / Linux:
//   ANTHROPIC_API_KEY=sk-ant-... node cache_probe_standalone.js
// Windows PowerShell:
//   $env:ANTHROPIC_API_KEY="sk-ant-..."; node cache_probe_standalone.js
// ----------------------------------------------------------------------

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

if (!KEY) {
  console.error(
    "\nNo ANTHROPIC_API_KEY set. Run it like this:\n\n" +
      "  macOS/Linux:  ANTHROPIC_API_KEY=sk-ant-... node cache_probe_standalone.js\n" +
      "  Windows PS:   $env:ANTHROPIC_API_KEY=\"sk-ant-...\"; node cache_probe_standalone.js\n"
  );
  process.exit(1);
}

// A stand-in for the compiled "frozen prefix" (bible + bits + reframed
// bench). The real one is bigger; this just needs to be identical across
// both calls and large enough to clear the model's min cacheable length.
const blockSample =
  "### Conrad (The Boss) — frozen for Völva · Reframed\n" +
  "CONNECTION TO HOST: The Host is a Völva — outside the org chart, never " +
  "on the ladder Conrad climbs. He holds no authority over someone who was " +
  "never beneath him, and she foresaw his arrival. The dynamic inverts: " +
  "she unsettles him.\nTHE PRESSURE: Pressure bounces off and rebounds — " +
  "each grave line meets a quiet foreknowledge that unnerves. Conrad " +
  "reaches for leverage and finds the ground has moved.\n";

const pad =
  ("COMPILED IN-CALL BIBLE / BITS (stand-in). The frozen prefix carries the " +
   "host base, the active loadout cards, and every armable reframed bench " +
   "block for this posture, resolved once at pre-snap and never recomputed " +
   "per turn. Only the posture line varies between turns. ").repeat(60);

const STABLE_PREFIX =
  "=== SPAMVIKING FROZEN PREFIX (stable for the whole call) ===\n\n" +
  blockSample + "\n=== BIBLE + BITS ===\n" + pad;

const approxTokens = Math.round(STABLE_PREFIX.length / 4);

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
      system: [
        { type: "text", text: STABLE_PREFIX, cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: postureLine + " Reply with: ok" }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).usage;
}

(async () => {
  console.log(`\nmodel: ${MODEL}`);
  console.log(`stable prefix: ~${approxTokens} tokens\n`);

  console.log("call 1 (posture ALIVE)    — expect cache CREATION ...");
  const u1 = await callOnce("CURRENT POSTURE: ALIVE — warm and forward.");
  console.log("  usage:", JSON.stringify(u1));

  console.log("call 2 (posture SLIPPING) — expect cache READ ...");
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
      `from cache instead of re-prefilling them. Changing the posture line ` +
      `did NOT bust the cache.\n`
    );
  } else {
    console.log(
      `\n  NOT PROVEN — cache_read was ${read}. Causes: prefix below the ` +
      `model's min cacheable length, model differs between calls, or the ` +
      `prefix text differs between calls.\n`
    );
  }
})().catch((e) => {
  console.error("\nprobe error:", e.message);
  console.error("(401 = bad or missing key · 400 = check model name)\n");
  process.exit(1);
});

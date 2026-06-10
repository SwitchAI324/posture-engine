// SpamViking — doubt-gears simulation (STANDALONE, zero dependencies)
// ----------------------------------------------------------------------
// Watch the posture line MOVE while the cached prefix stays frozen. Feeds
// a scripted spammer conversation through the same FORCE-SET rules the live
// proxy uses, and prints the gear each turn. No key, no Supabase, one file.
//
// Run:  node gear_sim_standalone.js
// ----------------------------------------------------------------------

// ---- the doubt-gears engine (mirrors api/_gears.js) ----------------------
const GEARS = {
  alive:    { directive: "Real and moving — warm, forward, keep them leaning in.",
              transitions: ["slipping", "foregone"] },
  slipping: { directive: "Let doubt surface — cool slightly, make them work for it.",
              transitions: ["alive", "foregone"] },
  foregone: { directive: "Not happening — signal the door closing, polite and final.",
              transitions: [] },
};
const RULES = [
  { re: /\b(never ?mind|forget it|not worth|waste of (?:my )?time|i'?ll (?:just )?email|good ?bye|lose my number)\b/i, to: "foregone" },
  { re: /\b(move forward|let'?s close|ready to sign|sign (?:you )?up|payment|credit card|card number|get you set up|send (?:me )?(?:your )?(?:card|details|payment|info))\b/i, from: ["alive"], to: "slipping" },
  { re: /\b(still interested|great deal|special (?:price|offer)|discount|just for you|limited time)\b/i, from: ["slipping"], to: "alive" },
];
function applyForce(gear, utterance) {
  const g = GEARS[gear] ? gear : "alive";
  if (g === "foregone") return { gear: g, changed: false };
  for (const r of RULES) {
    if (r.from && !r.from.includes(g)) continue;
    if (!GEARS[g].transitions.includes(r.to)) continue;
    if (r.re.test(utterance || "")) return { gear: r.to, changed: r.to !== g };
  }
  return { gear: g, changed: false };
}

// ---- a scripted spammer call --------------------------------------------
const FROZEN_PREFIX = "<<frozen prefix: host base + bits + reframed bench>>";
const transcript = [
  "Hi! Is this a good time to chat about our outreach platform?",
  "Great — so we automate cold email at massive scale.",
  "Honestly it's a great deal, special price just for you today.",
  "So to get you set up, I just need a credit card to start the trial.",
  "It'll only take a second, can you send me your card details?",
  "Come on, it's a limited time discount, still interested right?",
  "...you know what, forget it. This is a waste of my time.",
  "I'll just email you. Goodbye.",
];

// ---- run it --------------------------------------------------------------
let gear = "alive";
const prefixHashes = [];
const hash = (s) => require("crypto").createHash("sha256").update(s).digest("hex").slice(0, 8);

console.log(`\nstart gear: ${gear.toUpperCase()}\n`);
transcript.forEach((line, i) => {
  const before = gear;
  const r = applyForce(gear, line);
  gear = r.gear;
  // the cached prefix block the proxy would send THIS turn:
  prefixHashes.push(hash(FROZEN_PREFIX));
  const arrow = r.changed ? `  ${before.toUpperCase()} -> ${gear.toUpperCase()}` : "";
  console.log(`turn ${i + 1}  spammer: "${line}"`);
  console.log(`         gear: ${gear.toUpperCase()}${arrow}`);
  console.log(`         posture line: ${GEARS[gear].directive}\n`);
});

const allSame = prefixHashes.every((h) => h === prefixHashes[0]);
console.log("--- checks ---");
console.log(`  cached prefix identical every turn? ${allSame ? "YES" : "NO"} (hash ${prefixHashes[0]})`);
console.log(`  ended in: ${gear.toUpperCase()} ${gear === "foregone" ? "(one-way: locked, the spammer bailed)" : ""}`);
console.log(
  `\nThe gear moved ALIVE -> SLIPPING -> FOREGONE from the spammer's own ` +
  `words.\nOnly the posture line changed each turn; the ${prefixHashes[0]} ` +
  `prefix never did.\nThat's the whole engine: frozen prefix, one mutable ` +
  `line, zero per-turn LLM.\n`
);

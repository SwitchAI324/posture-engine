// SpamViking — Bench compiler (v4, POSTURE RETIRED — Aug 10)
// ----------------------------------------------------------------------
// CUT (Aug 10, PE code-cut certification): v3's whole reason to exist was
// the posture×bench REFRAME — registry.json/overrides/ops all answered
// "how does THIS posture reframe THIS bench member." With the host now a
// single constant character (the Innocent), there is no posture to key
// that lookup on, so the entire registry/override/ops machinery is
// removed, not just bypassed. What's left: each bench member's own clean,
// authored data, unreframed — matching the prompt's own instruction ("if
// the bench survives at all, it relates to the one constant host with no
// posture reframe"). This is a real architectural cut, not a stub —
// registry.json/registry_overrides.json/registry_ops.json/postures.json
// are no longer read by this file at all.
//
// Inputs now:
//   bench/*.json           one structured file per bench member — the
//                           ONLY input; nothing else feeds compile() now.
//
// Run: `node compile.js`
// ----------------------------------------------------------------------

const BENCH = require("./bench/index.js"); // { id: characterData, ... }

// ---- THE COMPILER --------------------------------------------------------
// No postureId parameter anymore — every bench member compiles the same
// way: clean, unreframed, straight from their own authored file. The old
// verdict/override/ops branches (blocked/reframe/reframe_pending_ops) are
// gone with them — those only ever existed to decide HOW a posture would
// reframe a member, a question that no longer has an answer to compute.
function compile(benchId) {
  const base = BENCH[benchId];

  if (!base) {
    return { benchId, status: "bench_pending",
             armable: false, note: `no structured bench file for '${benchId}' yet` };
  }

  // Clone the malleable surface so the source file is never touched (STAR).
  // manifestation (seen|audio|phantom) rides onto the block so downstream
  // (PE handoff gating) can read it off the compiled prefix, not just the roster.
  const block = {
    id: base.id, name: base.name, role: base.role, itAffinity: base.itAffinity,
    manifestation: base.manifestation,
    malleable: { ...base.malleable },
    beats: { ...base.beats },
    passthrough: { ...base.passthrough },
  };

  return { benchId, status: "clean", armable: true, block };
}

// ---- RENDER (generic over whatever fields the character carries) ---------
const headerize = (k) =>
  k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toUpperCase();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function render(out) {
  if (out.status === "bench_pending") {
    return `### ${cap(out.benchId)} — PENDING  [${out.status}]\n${out.note}\n`;
  }
  const b = out.block;
  const lines = [
    `### ${b.name} (${b.role})   ·   Clean pass-through`,
    `IT Affinity: ${b.itAffinity}`,
    ``,
  ];
  for (const [k, v] of Object.entries(b.malleable)) { lines.push(headerize(k), v, ``); }
  for (const [k, v] of Object.entries(b.beats))     { lines.push(headerize(k), v, ``); }
  for (const [k, v] of Object.entries(b.passthrough)) { lines.push(`${headerize(k)}  (pass-through)`, v, ``); }
  return lines.join("\n").trimEnd();
}

const banner = (t) => `\n${"=".repeat(72)}\n${t}\n${"=".repeat(72)}`;

// ---- DEMO ----------------------------------------------------------------
function emitMember(benchId, label) {
  const o = compile(benchId);
  console.log(banner(`${label} — compiled from bench/${benchId}.json (no posture, no reframe)`));
  console.log(`  status: ${o.status}`);
  let md = `# Frozen Bench block — ${cap(benchId)}\n` +
    `*Emitted by compiler/compile.js from bench/${benchId}.json alone —\n` +
    `no posture, no reframe. Each block is what freezes into the call's\n` +
    `stable prefix at pre-snap; nothing is per-turn.*\n\n` +
    "```\n" + render(o) + "\n```\n";
  const fs = require("fs");
  const path = require("path");
  const file = path.join(__dirname, "..", `compiled_${benchId}.md`);
  fs.writeFileSync(file, md);
  console.log(banner(`wrote ${path.basename(file)}`));
}

if (require.main === module) {
  for (const b of Object.keys(BENCH)) emitMember(b, cap(b).toUpperCase());
}

module.exports = { compile, render };

// SpamViking — Posture × Bench compiler (v3, data-driven + overrides)
// ----------------------------------------------------------------------
// v3 adds: (1) per-character fields — render is generic, so each bench
// member carries its OWN malleable sections + beats, not Conrad's; and
// (2) VERDICT OVERRIDES — a non-destructive way to revise a registry cell
// (e.g. blocked -> reframe) without editing the pristine registry export.
//
// Inputs (all data, no inlined rows):
//   postures.json          name + authority stance per posture
//   registry.json          the pristine export: verdicts + instructions
//   registry_overrides.json revised verdicts, applied OVER the export
//   registry_ops.json      authored recast/suppress/repoint ops per cell
//   bench/*.json           one structured file per bench member
//
// Run: `node compile.js`
// ----------------------------------------------------------------------

// Data loaded via require() so it's static and bundler-traceable (Vercel
// Node functions bundle required JSON; fs.readFileSync of loose files is
// not traced). New bench members are added to bench/index.js (one line).
const POSTURES = require("./postures.json");
const OPS = require("./registry_ops.json");
const REGISTRY_RAW = require("./registry.json");
let OVERRIDES = {};
try { OVERRIDES = require("./registry_overrides.json"); } catch { /* optional */ }
const BENCH = require("./bench/index.js"); // { id: characterData, ... }

const REG = {};
for (const e of REGISTRY_RAW.entries) REG[`${e.posture_id}__${e.bench_id}`] = e;

// Effective verdict: an override wins; else the export; else CLEAN (absent).
function verdictFor(key) {
  if (OVERRIDES[key] && OVERRIDES[key] !== "_") return OVERRIDES[key];
  return REG[key] ? REG[key].verdict : "clean";
}

// ---- THE COMPILER --------------------------------------------------------
function compile(postureId, benchId) {
  const posture = POSTURES[postureId];
  if (!posture) throw new Error(`unknown posture: ${postureId}`);

  const key = `${postureId}__${benchId}`;
  const verdict = verdictFor(key);
  const row = REG[key];
  const base = BENCH[benchId];
  const overridden = Boolean(OVERRIDES[key]);

  if (!base) {
    return { key, postureId, benchId, verdict, overridden, status: "bench_pending",
             armable: false, note: `no structured bench file for '${benchId}' yet` };
  }
  if (verdict === "blocked") {
    return { key, postureId, benchId, verdict, overridden, status: "blocked",
             armable: false, reason: (row && row.instruction) || "blocked by override" };
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

  if (verdict === "clean") {
    return { key, postureId, benchId, verdict, overridden, status: "clean",
             armable: true, applied: [], block };
  }

  // REFRAME -> apply authored ops. No ops yet => pending (never fabricate).
  const ops = OPS[key];
  if (!ops) {
    return { key, postureId, benchId, verdict, overridden, status: "reframe_pending_ops",
             armable: false, instruction: row && row.instruction,
             note: "verdict=reframe but no authored ops for this cell yet" };
  }
  const applied = [];
  for (const op of ops) {
    if (op.type === "recast")   { block.malleable[op.target] = op.text;        applied.push(`recast:${op.target}`); }
    if (op.type === "suppress") { block.beats[op.target]     = op.replacement; applied.push(`suppress:${op.target}`); }
    if (op.type === "repoint")  { block.beats[op.target]     = op.text;        applied.push(`repoint:${op.target}`); }
  }
  return { key, postureId, benchId, verdict, overridden, status: "reframe", armable: true, applied, block };
}

// ---- RENDER (generic over whatever fields the character carries) ---------
const headerize = (k) =>
  k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toUpperCase();
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function render(out) {
  const pName = POSTURES[out.postureId].name;
  if (out.status === "blocked") {
    return `### ${cap(out.benchId)} — BLOCKED for ${pName}\n` +
           `(Mead Hall greys this out — cannot be armed.)\nReason: ${out.reason}\n`;
  }
  if (out.status === "bench_pending" || out.status === "reframe_pending_ops") {
    return `### ${cap(out.benchId)} — PENDING for ${pName}  [${out.status}]\n${out.note}\n` +
           (out.instruction ? `Instruction: ${out.instruction}\n` : "");
  }
  const b = out.block;
  const tag = out.status === "clean" ? "Clean pass-through" : `Reframed [${out.applied.join(", ")}]`;
  const mark = out.overridden ? "  · VERDICT REVISED" : "";
  const lines = [
    `### ${b.name} (${b.role}) — frozen for ${pName}   ·   ${tag}${mark}`,
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
function column(benchId) {
  return Object.keys(POSTURES)
    .map((pid) => compile(pid, benchId))
    .filter((o) => REG[o.key] || OVERRIDES[o.key] || o.status === "clean");
}

function emitColumn(benchId, label) {
  console.log(banner(`${label} COLUMN — compiled from registry.json (+ overrides)`));
  for (const o of column(benchId)) {
    const ov = o.overridden ? "  <- REVISED" : "";
    console.log(`  ${o.postureId.padEnd(8)} -> ${o.verdict.toUpperCase().padEnd(8)} (${o.status})${ov}`);
  }
  let md = `# Frozen Bench blocks — ${cap(benchId)}, compiled per posture\n` +
    `*Emitted by compiler/compile.js from bench/${benchId}.json + the real\n` +
    `registry.json + overrides + authored ops. Each block is what freezes\n` +
    `into that call's stable prefix at pre-snap; nothing is per-turn.*\n`;
  for (const o of column(benchId)) {
    md += `\n\n## ${POSTURES[o.postureId].name} × ${cap(benchId)} — ${o.verdict}` +
          `${o.overridden ? " (revised)" : ""}\n\n` + "```\n" + render(o) + "\n```\n";
  }
  const fs = require("fs");
  const path = require("path");
  const file = path.join(__dirname, "..", `compiled_${benchId}_columns.md`);
  fs.writeFileSync(file, md);
  console.log(banner(`wrote ${path.basename(file)}`));
}

if (require.main === module) {
  for (const b of Object.keys(BENCH)) emitColumn(b, cap(b).toUpperCase());
}

module.exports = { compile, render, verdictFor };

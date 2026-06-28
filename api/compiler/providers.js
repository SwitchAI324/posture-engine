// SpamViking — Posture Engine: compile-input PROVIDERS
// ----------------------------------------------------------------------
// The four-document merge needs four inputs. TWO are now real:
//   [2] BIT LOADOUT  -> reads api/compiler/bits.js (BIT-xxx -> directive prose)
//   [3] reframed bench -> compiler/compile.js (in assemble.js)
// The other two — HOST BASE and CALL CONTEXT — are still STUBBED here behind a
// stable interface, so when their threads ship compiled output they drop in
// without touching assemble.js.
//
// HOST BASE and CALL CONTEXT bodies below are LOUD PLACEHOLDERS. Replace the
// bodies, keep the signatures.
// ----------------------------------------------------------------------
const POSTURES = require("./postures.json");

// BIT LOADOUT source: prose directives keyed by canonical BIT-xxx id.
// Authored by the Bits chat from the Bits Library (v5.6+). Parked bits
// (BIT-601..608) are intentionally ABSENT (no producer) — a missing id is
// skipped, never fatal: the call still runs, that bit just doesn't load.
let BITS = {};
try {
  BITS = require("./bits.js");
} catch (e) {
  // bits.js not present yet — loadout falls back to a visible notice rather
  // than crashing the whole prefix assembly.
  BITS = {};
}

// [1] HOST BASE — the persona/register for the locked posture.
// Real source: The Six §profile, compiled to the in-call ~50-line form.
function hostBaseFor(postureId) {
  const p = POSTURES[postureId];
  if (!p) throw new Error(`unknown posture: ${postureId}`);
  const voice = p.gender === "female" ? "Andrea" : "Andrew";
  return (
    `You are the Host, running this call in the ${p.name.toUpperCase()} ` +
    `posture — authority stance: ${p.stance}; voice: ${voice} (${p.gender}).\n` +
    `[[ HOST BASE PLACEHOLDER — the real ${p.name} register/persona compiles ` +
    `from The Six profile (core personality, mechanism, voice & cadence, ` +
    `call behavior). This stub only fixes the seam. ]]`
  );
}

// [2] BIT LOADOUT — the armed bits as in-call directives, REAL now.
// Reads each armed bit id's prose from bits.js. Ids are canonical BIT-xxx
// (matching bits_registry PKs and bit_deployments). Unknown/parked ids are
// listed quietly at the end so a missing producer is visible but non-fatal.
function loadoutFor(bitIds) {
  if (!bitIds || bitIds.length === 0) {
    return "ARMED BITS: none for this call.";
  }
  const lines = [];
  const missing = [];
  for (const id of bitIds) {
    const directive = BITS[id];
    if (directive && String(directive).trim()) {
      lines.push(`- ${id}:\n${String(directive).trim()}`);
    } else {
      missing.push(id);
    }
  }
  let out =
    "ARMED BITS (Let It Breathe — deploy only on a real opening, never to " +
    "fill a quota, never over the spammer's line):";
  if (lines.length) {
    out += "\n\n" + lines.join("\n\n");
  } else {
    out += "\n(none of the armed bits have a directive available)";
  }
  if (missing.length) {
    // Visible but harmless: these ids had no entry in bits.js (parked, or a
    // bad id). They simply don't load; the call is unaffected.
    out += `\n\n[unloaded bit ids (no directive in bits.js): ${missing.join(", ")}]`;
  }
  return out;
}

// [3] is the reframed bench — supplied by the REAL compiler in assemble.js.

// [4] CALL CONTEXT — the call-stable fragments of Data + Product Logic
// (target dossier summary, tactic/roster routing, second-call flag, etc.).
// Real source: Data doc + Product Logic compile.
function callStableContext(cfg) {
  return (
    `CALL CONTEXT: target=${cfg.target || "<dossier summary>"}; ` +
    `tactic=${cfg.tactic || "<classifier output>"}; ` +
    `second_call=${cfg.secondCall ? "yes" : "no"}.\n` +
    `[[ DATA / PRODUCT LOGIC PLACEHOLDER — call-stable context compiles ` +
    `from the Data doc + Product Logic. ]]`
  );
}

module.exports = { hostBaseFor, loadoutFor, callStableContext };

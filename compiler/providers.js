// SpamViking — Posture Engine: compile-input PROVIDERS
// ----------------------------------------------------------------------
// The four-document merge needs four inputs. ONE of them — the reframed
// bench — is real (compiler/compile.js). The other three compile in their
// own threads and are STUBBED here behind a stable interface, so when each
// thread ships its compiled output it drops in without touching assemble.js.
//
// Every string below is a LOUD PLACEHOLDER. Replace the bodies, keep the
// signatures.
// ----------------------------------------------------------------------

const POSTURES = require("./postures.json");

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

// [2] BIT LOADOUT — the ~3 armed bits as one-line directives.
// Real source: the Bits Library (v5.6+), compiled to in-call directives.
function loadoutFor(bitIds) {
  if (!bitIds || bitIds.length === 0) {
    return "ARMED BITS: none for this call.";
  }
  const lines = bitIds.map(
    (id) => `- ${id.toUpperCase()}: [[ directive placeholder — compiles from ` +
            `the Bits Library entry for ${id} ]]`
  );
  return (
    "ARMED BITS (Let It Breathe — deploy only on a real opening, never to " +
    "fill a quota, never over the spammer's line):\n" + lines.join("\n")
  );
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

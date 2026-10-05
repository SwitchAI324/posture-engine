// SpamViking — Posture Engine: archetype carrier read (single source).
// ----------------------------------------------------------------------
// Reads the classified archetype off the inbound request. Classification is
// PRE-CALL (Email layer, from the cold email) and rides into the call as Vapi
// metadata — because call_prefix is keyed by the Vapi call_id, which doesn't
// exist until the call connects, so nothing can write the carrier directly
// before then. The proxy reads it here, then hydrates call_prefix so it's
// sticky for the rest of the call. Absent -> null -> "universal" (flat fit).
//
// Shared by api/chat/completions.js (live) and api/verify.js (the archetype
// verification endpoint) so the test reads metadata EXACTLY as prod does.
// ----------------------------------------------------------------------
export function archetypeFromBody(body) {
  if (!body) return null;
  return (
    body.call?.metadata?.archetype ||
    body.metadata?.archetype ||
    body.call?.assistantOverrides?.variableValues?.archetype ||
    body.archetype ||
    null
  );
}

// KNOWN ARCHETYPES (2026-10-03, PE) — NOT a schema enum, not enforced
// anywhere, nothing here blocks an unrecognized value from writing or
// running. This exists purely so a mismatch between layers (Email's
// classifier output, Data's column, Canon's prompt conditionals) shows up
// as a log line instead of silently doing nothing. Andrew's own call:
// the pipeline has no real enum anywhere today (Email's classifier is a
// soft JS whitelist, PE's columns are plain text, unconfirmed whether
// Data's DB has a CHECK constraint) — this is a cheap visibility net, not
// a fix for that.
//
// Includes tax_refund/business_loan already (2026-10-03, Canon's register
// text is written and the hold is lifted) even though Email hasn't
// flipped its classifier to emit them yet and Data hasn't confirmed
// whether a DB constraint needs updating — intentional, so flipping
// either of those on later doesn't trip a false warning here. Update this
// list if the agreed set changes.
export const KNOWN_ARCHETYPES = [
  "crypto_investment",
  "b2b_saas",
  "account_access",
  "gov_threat",
  "tax_refund",
  "business_loan",
];

// Fire-and-forget: logs once, never throws, never changes control flow.
// `where` is a short caller tag (e.g. "completions" / "hydrate") so a log
// search can tell which read path saw the unrecognized value.
export function logIfUnknownArchetype(value, where) {
  if (!value) return; // null/undefined/"" = universal, not a mismatch
  if (KNOWN_ARCHETYPES.includes(value)) return;
  try {
    console.log(
      `ARCHETYPE-UNKNOWN (${where}): "${value}" not in KNOWN_ARCHETYPES — ` +
      `check Email's classifier output and Canon's prompt conditionals ` +
      `for a spelling/case mismatch before assuming the register is dead.`
    );
  } catch { /* logging must never break the call */ }
}

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

// api/scout/call.js
// Post-call dissection endpoint. After a baiting call ends, the caller POSTs
// the transcript inline; we extract callbacks/claims/commitments, append them
// to scout_facts as source_lane 'call', and register them as fuel hooks in
// targets.fuel_hooks_status. Those facts then arm follow-ups (Barbara's email,
// the re-engagement cadence) AND the second call. Never persists raw audio.
//
// Body: {
//   target_id?: uuid,            // preferred
//   target_email? | email?,      // fallback to resolve target_id
//   call_id?: string,            // optional, stored with the facts
//   transcript?: string,         // plain transcript, OR
//   messages?: [{ role, content }]   // structured turns (flattened to text)
// }

import { dissectCall } from './_calldissect.js';
import { writeFacts } from './_facts.js';
import { gate, dedupeHooks, registerStatus, emitTrace } from './_hooks.js';
import { sbSelect, ilikeEq, activeSecret, scoutToken } from './_sb.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const expected = activeSecret(process.env.SV_SCOUT_TOKEN);
  if (expected && scoutToken(req) !== expected)
    return res.status(401).json({ error: 'bad token' });

  const b = req.body || {};
  const targetId = await resolveTargetId(b);
  if (!targetId)
    return res.status(400).json({ error: 'target_id or known email required' });

  const transcript = flattenTranscript(b);
  const started = Date.now();
  await emitTrace('call_dissect_started', { target_id: targetId, call_id: b.call_id || null });

  let written = 0;
  try {
    const { factRows, hooks } = await dissectCall({ transcript, call_id: b.call_id || null });

    await writeFacts(targetId, factRows);

    const live = dedupeHooks(gate(hooks));
    for (const h of live)
      await emitTrace('hook_enriched', {
        target_id: targetId,
        hook_id: h.hook_id,
        confidence: h.confidence,
        source: h.source,
        label: h.label,
      });

    await registerStatus(targetId, `id=eq.${encodeURIComponent(targetId)}`, live);
    written = live.length;
  } catch (e) {
    await emitTrace('call_dissect_error', { target_id: targetId, message: String((e && e.message) || e) });
  }

  await emitTrace('call_dissect_complete', {
    target_id: targetId,
    hooks_written: written,
    duration_ms: Date.now() - started,
  });
  return res.status(200).json({ target_id: targetId, hooks_written: written });
}

function flattenTranscript(b) {
  if (typeof b.transcript === 'string' && b.transcript.trim()) return b.transcript;
  if (Array.isArray(b.messages))
    return b.messages
      .map((m) => `${m.role || m.speaker || ''}: ${m.content || m.text || m.message || ''}`.trim())
      .join('\n');
  return '';
}

// Prefer an explicit target_id; otherwise resolve from a known email
// (case-insensitive, per the house rule).
async function resolveTargetId(b) {
  if (b.target_id) return b.target_id;
  const email = b.target_email || b.email;
  if (email) {
    try {
      const rows = await sbSelect(`targets?${ilikeEq('email', email)}&select=id&limit=1`);
      if (rows && rows[0]) return rows[0].id;
    } catch {}
  }
  return null;
}

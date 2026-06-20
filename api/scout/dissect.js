// api/scout/dissect.js
// Inbound dissection endpoint. Email's ingest POSTs the body and attachment
// bytes INLINE; we extract volunteered facts, append them to scout_facts,
// register them as fuel hooks in targets.fuel_hooks_status, and trace. We
// never touch Gmail and never persist the raw body or the file.
//
// Body: {
//   target_id?: uuid,            // preferred — FK to targets.id
//   email?: string,              // fallback to resolve target_id
//   body: string,
//   signature?: string,
//   attachments?: [{ filename, mime, content_base64 }]
// }

import { dissect } from './_dissect.js';
import { writeFacts } from './_facts.js';
import { gate, registerStatus, emitTrace } from './_hooks.js';
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

  const started = Date.now();
  await emitTrace('dissect_started', { target_id: targetId });

  let written = 0;
  try {
    const { factRows, hooks } = await dissect({
      body: b.body || '',
      signature: b.signature || '',
      subject: b.subject || '',
      attachments: Array.isArray(b.attachments) ? b.attachments : [],
    });

    // Store the facts (never the raw body/file).
    await writeFacts(targetId, factRows);

    // Gate, then advertise as fuel hooks so armable(bit, rack) can consume.
    const live = gate(hooks);
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
    await emitTrace('dissect_error', { target_id: targetId, message: String((e && e.message) || e) });
  }

  await emitTrace('dissect_complete', {
    target_id: targetId,
    hooks_written: written,
    duration_ms: Date.now() - started,
  });
  return res.status(200).json({ target_id: targetId, hooks_written: written });
}

// Prefer an explicit target_id; otherwise resolve from a known email
// (Email sends target_email; accept email too). Case-insensitive per the
// house rule.
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

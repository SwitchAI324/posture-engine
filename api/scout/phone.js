// api/scout/phone.js
// Phone lane endpoint. Phone Intake POSTs an E.164 number at voicemail intake;
// we look up line type (Twilio), gather + judge web complaints into a
// corroborated playbook, and COLUMN-SCOPED upsert our fields onto the shared
// caller_profile row keyed by e164.
//
// CO-WRITER RULE: this row is shared with Phone Intake. We write ONLY our
// columns (line_type, web_reports, playbook, confidence, last_seen) and never
// include theirs (claimed_org, script_summary, archetype_votes) — sbUpsert
// uses merge-duplicates, so unlisted columns are preserved.
//
// SCAMMER-ONLY: nothing written here references any SpamViking user.
//
// Body: { number: "<E.164>" }

import { lookupLineType, gatherReports, judgeReports } from './_phone.js';
import { sbUpsert, activeSecret, scoutToken } from './_sb.js';
import { emitTrace } from './_hooks.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const expected = activeSecret(process.env.SV_SCOUT_TOKEN);
  if (expected && scoutToken(req) !== expected)
    return res.status(401).json({ error: 'bad token' });

  const e164 = normalizeE164((req.body || {}).number);
  if (!e164) return res.status(400).json({ error: 'valid E.164 number required' });

  const started = Date.now();
  await emitTrace('phone_started', { e164 });

  try {
    // Line type and web reports in parallel (independent lookups).
    const [line_type, rawReports] = await Promise.all([
      lookupLineType(e164),
      gatherReports(e164),
    ]);

    const { playbook, confidence, reports } = await judgeReports(e164, rawReports);

    // Column-scoped write: ONLY our fields + e164 + last_seen. Never theirs.
    const row = {
      e164,
      line_type,            // may be null (no Twilio creds) — that's fine
      web_reports: reports, // raw evidence rows (array)
      playbook,             // null below medium confidence (precision gate)
      confidence,           // 'low' | 'medium' | 'high'
      last_seen: new Date().toISOString(),
    };
    await sbUpsert('caller_profile', [row], 'e164');

    await emitTrace('phone_complete', {
      e164,
      line_type,
      confidence,
      has_playbook: !!playbook,
      reports: reports.length,
      duration_ms: Date.now() - started,
    });
    return res.status(200).json({
      e164,
      line_type,
      confidence,
      has_playbook: !!playbook,
      reports: reports.length,
    });
  } catch (e) {
    await emitTrace('phone_error', { e164, message: String((e && e.message) || e) });
    return res.status(200).json({ e164, recorded: false });
  }
}

// Accept a number that's already E.164, or coax an obvious one into shape.
// Conservative: returns null if it can't be confident, so we never key a
// garbage row.
function normalizeE164(input) {
  if (!input) return null;
  let s = String(input).trim().replace(/[\s()\-.]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s; // already valid E.164
  // Bare 10-digit US number -> +1. Anything else we don't guess.
  if (/^\d{10}$/.test(s)) return `+1${s}`;
  if (/^1\d{10}$/.test(s)) return `+${s}`;
  return null;
}

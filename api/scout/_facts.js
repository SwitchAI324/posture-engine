// api/scout/_facts.js
// Writes extracted facts to scout_facts (Data's table). Append model:
// extracted_at is a retention clock, so each run INSERTS fresh rows rather
// than upserting. Writes facts ONLY — never the raw body or the file.
//
// SCHEMA SEAM — confirm column names with Data:
//   target_id    FK -> targets.id   (assumed name)
//   source_lane  'body' | 'signature' | 'attachment' | 'web'
//   facts        jsonb
//   extracted_at timestamptz (retention clock)
import { sbInsert } from './_sb.js';

// Writes extracted facts. Accepts a shared `now` so the caller can stamp
// related derived state (last_call_scouted_at) with the identical timestamp.
export async function writeFacts(targetId, factRows, now = new Date().toISOString()) {
  if (!targetId || !factRows.length) return 0;
  const rows = factRows.map((r) => ({
    target_id: targetId,
    source_lane: r.lane,
    facts: r.facts,
    call_id: r.call_id || null, // real column, consistent with engagement_events.call_id
    extracted_at: now,
  }));
  await sbInsert('scout_facts', rows);
  return rows.length;
}

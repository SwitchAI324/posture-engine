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

export async function writeFacts(targetId, factRows) {
  if (!targetId || !factRows.length) return 0;
  const now = new Date().toISOString();
  const rows = factRows.map((r) => ({
    target_id: targetId,
    source_lane: r.lane,
    facts: r.facts,
    extracted_at: now,
  }));
  await sbInsert('scout_facts', rows);
  return rows.length;
}

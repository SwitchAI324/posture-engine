// api/scout/_hooks.js
import { sbUpsert } from './_sb.js';

// Per-hook confidence gates (from SCOUTING_ENGINE.md). Precision over recall:
// a fact (registration date, corpus match) gates low; an inference (news,
// negation) gates high. Anything below its gate is dropped silently.
export const GATES = {
  prior_contact: 0.60,
  domain_age: 0.60,
  template_match: 0.70,
  geo_mismatch: 0.70,
  company_news: 0.85,
  dossier_negation: 0.85,
  stock_photo: 0.95,
};

export function gate(hooks) {
  return hooks.filter(
    (h) =>
      h &&
      typeof h.confidence === 'number' &&
      h.confidence >= (GATES[h.hook_id] ?? 1));
}

export async function writeHooks(slug, hooks) {
  if (!hooks.length) return 0;
  const rows = hooks.map((h) => ({
    slug,
    hook_id: h.hook_id,
    label: String(h.label).slice(0, 40),
    payload: h.payload || {},
    confidence: Math.round(h.confidence * 100) / 100,
    source: h.source || 'scout',
  }));
  await sbUpsert('scout_hooks', rows, 'slug,hook_id');
  return rows.length;
}

// Trace seam — point SV_TRACE_URL at your existing trace.js sink. Always
// logs; the POST is best-effort and never throws.
export async function emitTrace(event, data) {
  const payload = { event, ts: new Date().toISOString(), ...data };
  try { console.log('[scout]', JSON.stringify(payload)); } catch {}
  const url = process.env.SV_TRACE_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {}
}

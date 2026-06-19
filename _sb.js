// api/scout/_hooks.js
import { sbSelect, sbUpsert, sbPatch } from './_sb.js';

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

// Registers live hooks in targets.fuel_hooks_status — the field everyone
// reads to know a hook is live. A hook present in scout_hooks but missing
// here reads as dormant, so this is NOT silent on failure: it emits a
// status_register_failed trace. It still never throws (the call isn't
// blocked), but the failure is visible.
//
// Merge, don't overwrite: preserve keys from prior runs and other producers.
// Dormant hooks are simply absent keys, per Data's model.
export async function registerStatus(slug, targetRef, hooks) {
  if (!targetRef || !hooks.length) return;
  try {
    const rows = await sbSelect(`targets?${targetRef}&select=fuel_hooks_status`);
    const current = (rows && rows[0] && rows[0].fuel_hooks_status) || {};
    const merged = { ...current };
    for (const h of hooks) {
      merged[h.hook_id] = { present: true, confidence: h.confidence };
    }
    await sbPatch('targets', targetRef, { fuel_hooks_status: merged });
  } catch (e) {
    await emitTrace('status_register_failed', {
      slug,
      message: String((e && e.message) || e),
    });
  }
}
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

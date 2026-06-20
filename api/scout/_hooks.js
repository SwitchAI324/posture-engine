// api/scout/_hooks.js
import { sbSelect, sbUpsert, sbPatch } from './_sb.js';

// Per-hook confidence gates (from SCOUTING_ENGINE.md). Precision over recall:
// a fact (registration date, corpus match) gates low; an inference (news,
// negation) gates high. Anything below its gate is dropped silently.
export const GATES = {
  // research lanes
  prior_contact: 0.60,
  domain_age: 0.60,
  template_match: 0.70,
  company_news: 0.85,
  dossier_negation: 0.85,
  stock_photo: 0.95,
  // dissection lane (volunteered data — gates low, they said it themselves)
  pitch_claims: 0.50,
  sender_identity: 0.55,
  sender_linkedin: 0.50,
  sender_social: 0.50,
  office_location: 0.55,
  attachment_facts: 0.70,
  // post-call lane (transcript callbacks — ASR can mangle, gate moderate)
  call_callback: 0.55,
  call_claim: 0.60,
  call_commitment: 0.60,
};

export function gate(hooks) {
  return hooks.filter(
    (h) =>
      h &&
      typeof h.confidence === 'number' &&
      h.confidence >= (GATES[h.hook_id] ?? 1));
}

// Collapse multiple hooks sharing a hook_id into one. scout_hooks is keyed
// (slug, hook_id), so a lane that returns several of the same hook — e.g. the
// web lane returning several company_news items — must become a single row,
// or the batch upsert errors and NOTHING lands. Keep the highest-confidence
// entry; fold up to 3 of the payloads into payload.items for the host to pick.
export function dedupeHooks(hooks) {
  const groups = new Map();
  for (const h of hooks || []) {
    if (!h || !h.hook_id) continue;
    const g = groups.get(h.hook_id) || [];
    g.push(h);
    groups.set(h.hook_id, g);
  }
  const out = [];
  for (const g of groups.values()) {
    g.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const top = g[0];
    if (g.length === 1) {
      out.push(top);
      continue;
    }
    out.push({
      ...top,
      payload: { ...(top.payload || {}), items: g.slice(0, 3).map((x) => x.payload) },
    });
  }
  return out;
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

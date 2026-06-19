// api/scout/_read.js
// The call-start read path. PE imports readAmmunition(slug) and calls it when
// it builds call_started, to populate ammunition. Scouting owns this because
// it owns the scout_hooks table shape; PE just calls it.
//
// Only gate-passing hooks are ever written, so there is no confidence filter
// here. On any error or empty result it returns an empty rack — the call runs
// clean, never blocked.

import { sbSelect } from './_sb.js';

export async function readAmmunition(slug) {
  if (!slug) return { ammunition: [], byHook: {} };
  try {
    const rows = await sbSelect(
      `scout_hooks?slug=eq.${encodeURIComponent(slug)}` +
      `&select=hook_id,label,payload`);
    // The rack the host sees: just {hook_id, label}.
    const ammunition = (rows || []).map((r) => ({ hook_id: r.hook_id, label: r.label }));
    // The payloads a bit pulls by hook_id when it actually fires.
    const byHook = Object.fromEntries((rows || []).map((r) => [r.hook_id, r.payload]));
    return { ammunition, byHook };
  } catch {
    return { ammunition: [], byHook: {} };
  }
}

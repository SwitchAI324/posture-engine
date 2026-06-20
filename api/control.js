// SpamViking — Posture Engine: DEATH BLOW CONTROL (Trigger A, manual)
// ----------------------------------------------------------------------
// Mead Hall's only write into the call runtime. The Director POSTs a pending
// kill; the turn loop reads it (folded into the call_prefix read it already
// does), force-sets the rung line, emits blow_armed/blow_fired/call_ended, and
// clears it — all within one turn.
//
//   POST /api/control?action=deathblow
//     body: { call_id, rung_id, director_user_id, idempotency_key,
//             final_line?, rung_name? }
//     -> idempotent: one pending per call. Re-POST with the SAME
//        idempotency_key is a no-op (safe retry).
//
//   GET  /api/control?call_id=...   -> current pending status (to confirm)
//
// final_line is OPTIONAL but recommended: Mead Hall already has the rung's
// line, and passing it lets PE force the exact finisher. If omitted, PE forces
// a generic firm sign-off.
//
// Note: the engine detects the FOREGONE death blow (Trigger B) itself — this
// endpoint is ONLY the Director's manual Trigger A.
// ----------------------------------------------------------------------

import { getControls, setDeathBlow, addArm } from "./_store.js";
import { makeTrace } from "./_trace.js";
import { BITS } from "./_bits_registry.js";

const CANON_HOOKS = new Set([
  "company_news", "dossier_negation", "domain_age", "geo_mismatch",
  "prior_contact", "template_match", "stock_photo",
]);

export const config = { runtime: "edge" };

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default async function handler(req) {
  const u = new URL(req.url);

  if (req.method === "GET") {
    const callId = u.searchParams.get("call_id");
    if (!callId) return jsonRes({ error: "missing call_id" }, 400);
    const c = await getControls(callId).catch(() => null);
    const db = c && c.deathBlow ? c.deathBlow : null;
    if (!db) return jsonRes({ call_id: callId, pending: false });
    return jsonRes({
      call_id: callId,
      pending: db.status === "pending",
      status: db.status || null,
      rung_id: db.rung_id || null,
      idempotency_key: db.idem || null,
    });
  }

  if (req.method === "POST" && u.searchParams.get("action") === "deathblow") {
    let b;
    try { b = await req.json(); } catch { return jsonRes({ error: "bad json" }, 400); }
    const callId = String(b.call_id || "").trim();
    const rungId = String(b.rung_id || "").trim();
    const idem = String(b.idempotency_key || "").trim();
    if (!callId || !rungId || !idem) {
      return jsonRes({ error: "call_id, rung_id, idempotency_key required" }, 400);
    }
    // idempotency: if a pending with this exact key already exists, no-op.
    const cur = await getControls(callId).catch(() => null);
    if (cur && cur.deathBlow && cur.deathBlow.idem === idem) {
      return jsonRes({ ok: true, idempotent: true, status: cur.deathBlow.status || "pending" });
    }
    try {
      await setDeathBlow(callId, {
        rungId,
        rungName: b.rung_name ? String(b.rung_name) : null,
        finalLine: b.final_line ? String(b.final_line) : null,
        idem,
        director: b.director_user_id ? String(b.director_user_id) : null,
      });
    } catch (e) {
      return jsonRes({ error: "set failed", detail: String(e).slice(0, 200) }, 502);
    }
    return jsonRes({ ok: true, call_id: callId, rung_id: rungId, status: "pending" });
  }

  if (req.method === "POST" && u.searchParams.get("action") === "callend") {
    let b;
    try { b = await req.json(); } catch { return jsonRes({ error: "bad json" }, 400); }
    const callId = String(b.call_id || "").trim();
    if (!callId) return jsonRes({ error: "call_id required" }, 400);
    // If the Director's death blow already fired, the turn loop already emitted
    // call_ended(death_blow) — don't double-emit a natural ending.
    const cur = await getControls(callId).catch(() => null);
    if (cur && cur.deathBlow && cur.deathBlow.status === "fired") {
      return jsonRes({ ok: true, skipped: "death_blow already ended this call" });
    }
    const ending_type = String(b.ending_type || "hung_up");
    const duration = b.duration_seconds != null ? Number(b.duration_seconds) : null;
    // high seq base so call_ended sorts after every per-turn event
    const trace = makeTrace(callId, 99999, null);
    await trace.emit(
      "call_ended",
      {
        ended_at: new Date().toISOString(),
        ending_type,
        finishing_rung_id: null,
        duration_seconds: duration,
        blows_landed: null,
        heads_mustered: null,
        peak_their_side: null,
        peak_our_side: null,
      },
      "engine"
    );
    return jsonRes({ ok: true, call_id: callId, ending_type });
  }

  if (req.method === "POST" && u.searchParams.get("action") === "arm") {
    let b;
    try { b = await req.json(); } catch { return jsonRes({ error: "bad json" }, 400); }
    const callId = String(b.call_id || "").trim();
    if (!callId) return jsonRes({ error: "call_id required" }, 400);
    const bitId = b.bit_id ? String(b.bit_id).trim() : null;
    const hookId = b.hook_id ? String(b.hook_id).trim() : null;
    if (!bitId && !hookId) return jsonRes({ error: "arm needs bit_id and/or hook_id" }, 400);

    // visible-failure validation (static checks; fuel/scout presence is per-call,
    // surfaced at fire time if the armed item can't land).
    if (bitId) {
      const bit = BITS.find((x) => x.id === bitId);
      if (!bit) return jsonRes({ error: `unknown bit ${bitId}` }, 404);
      if (bit.status === "parked") return jsonRes({ error: `can't arm ${bitId} — parked (${bit.park_reason || "inactive"})` }, 409);
    }
    if (hookId && !CANON_HOOKS.has(hookId)) {
      return jsonRes({ error: `unknown hook ${hookId} — not one of the canonical seven` }, 404);
    }

    const cur = await getControls(callId).catch(() => null);
    const armed = (cur && Array.isArray(cur.armed) ? cur.armed : []).slice();
    const idem = b.idempotency_key ? String(b.idempotency_key) : null;
    if (idem && armed.some((a) => a.idem === idem)) {
      return jsonRes({ ok: true, idempotent: true, armed }); // already queued
    }
    if (armed.length >= 3) return jsonRes({ error: "setlist full (max 3) — wait for one to fire" }, 409);

    try { await addArm(callId, { bitId, hookId, idem, director: b.director_user_id || null }); }
    catch (e) { return jsonRes({ error: "arm write failed", detail: String(e).slice(0, 200) }, 502); }
    return jsonRes({ ok: true, armed: [...armed, { bit_id: bitId, hook_id: hookId, idem }] });
  }

  return jsonRes({ error: "method not allowed" }, 405);
}

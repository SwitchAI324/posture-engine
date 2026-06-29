// SpamViking — Posture Engine: DEATH BLOW CONTROL (Trigger A, manual)
// ----------------------------------------------------------------------
// Mead Hall's only write into the call runtime. The Director POSTs a pending
// kill; the turn loop reads it (folded into the call_prefix read it already
// does), force-sets the rung line, emits blow_armed/blow_fired/call_ended, and
// clears it — all within one turn.
//
//   POST /api/control?action=deathblow
//     body: { call_id, director_user_id, idempotency_key }
//     -> instant kill. PE generates the absurd closing line in persona at
//        fire time (no rung, no canned line). idempotent: one per call.
//
//   POST /api/control?action=bench
//     body: { call_id, bench_id, director_user_id?, idempotency_key? }
//     -> Director sends in a specific bench character; the next host turn
//        weaves them in (overrides the auto inject schedule). idempotent.
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

import { getControls, setDeathBlow, addArm, setBench } from "./_store.js";
import { makeTrace } from "./_trace.js";
import { BITS } from "./_bits_registry.js";
import { benchIds } from "./_bench_v2.js";

// Hooks a Director may arm. Kept in sync with what the Scouting lanes actually
// produce + register today (see api/scout/_hooks.js GATES and _dissect.js /
// _calldissect.js outputs). The old "canonical seven" was stale — it still
// listed the retired geo_mismatch and omitted every dissection/call/browsed
// hook, so arming a real live hook 404'd. Add new hook_ids here as Scouting
// ships them.
const CANON_HOOKS = new Set([
  // research / corpus lanes
  "company_news", "dossier_negation", "domain_age",
  "prior_contact", "template_match", "stock_photo",
  // inbound dissection lane
  "pitch_claims", "sender_identity", "sender_linkedin",
  "sender_social", "office_location", "attachment_facts",
  // post-call transcript lane
  "call_callback", "call_claim", "call_commitment",
  // booking-side browsed-calendar TMI (Fiji week) callback
  "browsed_tmi",
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
    const idem = String(b.idempotency_key || "").trim();
    if (!callId || !idem) {
      return jsonRes({ error: "call_id, idempotency_key required" }, 400);
    }
    // idempotency: if a pending with this exact key already exists, no-op.
    const cur = await getControls(callId).catch(() => null);
    if (cur && cur.deathBlow && cur.deathBlow.idem === idem) {
      return jsonRes({ ok: true, idempotent: true, status: cur.deathBlow.status || "pending" });
    }
    // No rung. PE generates the absurd closing line in persona at fire time.
    try {
      await setDeathBlow(callId, {
        idem,
        director: b.director_user_id ? String(b.director_user_id) : null,
      });
    } catch (e) {
      return jsonRes({ error: "set failed", detail: String(e).slice(0, 200) }, 502);
    }
    return jsonRes({ ok: true, call_id: callId, status: "pending" });
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
      return jsonRes({ error: `unknown hook ${hookId} — not a known scout hook` }, 404);
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

  if (req.method === "POST" && u.searchParams.get("action") === "bench") {
    let b;
    try { b = await req.json(); } catch { return jsonRes({ error: "bad json" }, 400); }
    const callId = String(b.call_id || "").trim();
    if (!callId) return jsonRes({ error: "call_id required" }, 400);
    const benchId = b.bench_id ? String(b.bench_id).trim().toUpperCase() : null;
    if (!benchId) return jsonRes({ error: "bench needs bench_id" }, 400);

    // visible-failure validation: bench_id must be a known character.
    const valid = benchIds(); // uppercase tags, e.g. CONRAD/BONNIE/ANDREA
    if (!valid.includes(benchId)) {
      return jsonRes({ error: `unknown bench ${benchId} — valid: ${valid.join(", ")}` }, 404);
    }

    const cur = await getControls(callId).catch(() => null);
    const idem = b.idempotency_key ? String(b.idempotency_key) : null;
    if (cur && cur.sentBench && idem && cur.sentBench.idem === idem) {
      return jsonRes({ ok: true, idempotent: true, sentBench: cur.sentBench }); // already queued
    }

    try { await setBench(callId, { benchId, idem, director: b.director_user_id || null }); }
    catch (e) { return jsonRes({ error: "bench write failed", detail: String(e).slice(0, 200) }, 502); }
    return jsonRes({ ok: true, call_id: callId, sent_bench: benchId });
  }

  return jsonRes({ error: "method not allowed" }, 405);
}

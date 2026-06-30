// SpamViking — Posture Engine: BENCH HANDOFF (Option B, distinct-voice barge).
// ----------------------------------------------------------------------
// Fires a Vapi `handoff` to a bench assistant (e.g. Conrad) SERVER-SIDE, so the
// caller hears a genuinely different voice. The browser can't POST to Vapi's
// per-call controlUrl directly (cross-origin / CORS), so PE does it here:
// browser -> /api/handoff (same origin) -> Vapi controlUrl (server-to-server).
//
//   POST /api/handoff?action=fire   body: { call_id, bench_id? }
//     -> looks up the stored monitor.controlUrl for the call (captured by
//        completions.js), POSTs the handoff, returns Vapi's response.
//   GET  /api/handoff?call_id=...    -> shows the stored controlUrl (debug).
//
// Conrad carries a handoff tool BACK to the host, so PE only fires host->bench.
// This is the manual-test + the trigger primitive: once it works, the trigger
// (e.g. spammer asks for the boss) calls fireHandoff() directly.
// ----------------------------------------------------------------------

import { getCall } from "./_store.js";
import { isPhantom, benchEntry } from "./_bench_v2.js";

export const config = { runtime: "edge" };

// Bench assistant IDs (from the Vapi dashboard). These are Vapi EXECUTION detail
// (the runtime voice), so they live here, not in the content roster. CONRAD is
// the first/default. Add a character's Vapi assistantId here when it's built.
const BENCH_ASSISTANTS = {
  CONRAD: "23a3bebb-e8ee-476f-bbfa-82886cd9b665",
};
const DEFAULT_BENCH = "CONRAD";

function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Fire the handoff to a bench assistant on a live call. Exported so the trigger
// can call it directly (not just via the endpoint). Returns { ok, status, ... }.
export async function fireHandoff(callId, benchId = DEFAULT_BENCH) {
  if (!callId) return { ok: false, error: "missing call_id" };
  const key = String(benchId).toUpperCase();

  // MANIFESTATION GATE: only seen/audio characters get a handoff + voice.
  // Phantoms (no_show/approver/it_guy) are host-prefix invocation only — they
  // NEVER hold the mic, so a handoff to them is invalid. barbara isn't a bench
  // character at all. benchEntry/isPhantom read the v2 roster (type field).
  const entry = benchEntry(key);
  if (!entry) return { ok: false, error: `unknown bench ${key} — not a handoff-able character` };
  if (isPhantom(key)) {
    return { ok: false, error: `${key} is a phantom (manifestation) — phantoms are invoked via the host prefix, never handed off` };
  }

  const assistantId = BENCH_ASSISTANTS[key];
  if (!assistantId) return { ok: false, error: `no Vapi assistantId configured for ${key} (built in roster but not wired in BENCH_ASSISTANTS)` };

  const stored = await getCall(callId).catch(() => null);
  const controlUrl = stored && stored.controlUrl ? stored.controlUrl : null;
  if (!controlUrl) {
    return { ok: false, error: "no controlUrl stored for this call (not live, or not captured yet)" };
  }

  const payload = {
    type: "handoff",
    destination: {
      type: "assistant",
      assistantId,
      contextEngineeringPlan: { type: "none" },
    },
    content: "",
  };

  try {
    const r = await fetch(controlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await r.text().catch(() => "");
    let body = text;
    try { body = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, bench_id: benchId.toUpperCase(), control_url: controlUrl, vapi_response: body };
  } catch (e) {
    return { ok: false, error: "handoff POST failed", detail: String(e).slice(0, 200), control_url: controlUrl };
  }
}

export default async function handler(req) {
  const u = new URL(req.url);

  // GET — two modes:
  //   ?fire=CALL_ID  -> fire the handoff from the address bar (browser-friendly).
  //   ?call_id=...   -> debug: show the stored controlUrl for a call.
  if (req.method === "GET") {
    const fireId = u.searchParams.get("fire");
    if (fireId) {
      const benchId = u.searchParams.get("bench_id") || DEFAULT_BENCH;
      const result = await fireHandoff(fireId.trim(), benchId);
      return jsonRes(result, result.ok ? 200 : 502);
    }
    const callId = u.searchParams.get("call_id");
    if (!callId) return jsonRes({ error: "missing call_id (or use ?fire=CALL_ID to fire)" }, 400);
    const stored = await getCall(callId).catch(() => null);
    return jsonRes({
      call_id: callId,
      control_url: stored && stored.controlUrl ? stored.controlUrl : null,
      has_control_url: !!(stored && stored.controlUrl),
    });
  }

  // POST ?action=fire — fire the handoff.
  if (req.method === "POST" && u.searchParams.get("action") === "fire") {
    let b;
    try { b = await req.json(); } catch { return jsonRes({ error: "bad json" }, 400); }
    const callId = String(b.call_id || "").trim();
    if (!callId) return jsonRes({ error: "call_id required" }, 400);
    const benchId = b.bench_id ? String(b.bench_id).trim() : DEFAULT_BENCH;
    const result = await fireHandoff(callId, benchId);
    return jsonRes(result, result.ok ? 200 : 502);
  }

  return jsonRes({ error: "method not allowed (POST ?action=fire)" }, 405);
}

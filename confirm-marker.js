// api/confirm-marker.js — the actual fix for the race-proof-signal gap
// flagged (and never built) in an older comment in completions.js, and
// confirmed live Aug 24: markerCounts (fed by finishUp, which runs on
// EVERY generation attempt including discarded preemptive-gen candidates)
// was the signal item 47's rung math and item 48's arc-protection both
// depend on — meaning a marker that was WRITTEN but never actually SPOKEN
// could get credited as "confirmed." Real, confirmed case: a dog-bark
// candidate lost its race to a different (no-bark) winning generation,
// but still got counted toward rung advancement.
//
// THE ACTUAL FIX: PE cannot know which generation wins — that decision
// happens entirely agent-side, after PE has already returned its
// response. So the only genuinely race-proof signal has to come FROM the
// agent, at the exact moment it already, correctly, resolves this same
// race for its OWN purposes — right before it actually fires a sound
// marker (the same point the agent already logs "sound: _fire ENTER
// marker=[X]" and already knows to skip a marker "from a discarded
// generation"). This endpoint is what the agent calls at that exact
// point — genuinely confirming "this marker was really about to play,"
// not "some generation somewhere mentioned it."
//
// USAGE: POST /api/confirm-marker
//   body: { call_id, marker } OR { call_id, markers: ["X","Y"] }
//   header: x-agent-secret: <AGENT_CALLBACK_SECRET>
//   -> { ok: true, counts: { <marker>: N, ... } }
//
// STORAGE: writes to a NEW, separate field — stored.confirmedMarkerCounts
// — deliberately NOT the same field (markerCounts) the existing marker-
// awareness feature already uses. That feature (telling the host "you
// caused X a moment ago") is lower-stakes and works fine on the existing
// signal; no reason to touch or risk it. Rung/arc-protection's
// confirmedFireCount() helper (completions.js) now prefers this new
// field per-marker when it has data, falling back to the old field for
// any marker Voice hasn't wired up yet — safe, gradual rollout, no
// regression while this deploys.
//
// ENV NEEDED: AGENT_CALLBACK_SECRET (new, separate from every other
// secret in this codebase — this one authenticates server-to-server
// calls FROM the agent, not from a browser/Director/Watcher, so it
// deliberately doesn't reuse control.js's token system at all).
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY — read indirectly via
// _store.js's own getCall/setCall, same as every other consumer.
//
// Plain Node runtime, ES import/export — matching completions.js's own
// confirmed-working style for importing _store.js (which is itself an
// ES module — `export function`/`export async function` throughout, no
// CommonJS anywhere in it). Two real import-path bugs caught before
// shipping, not assumed correct: a first draft used require()/CJS
// (wrong — _store.js has no CJS exports); the fix then used '../
// _store.js' (also wrong — that path is only correct for a file living
// one level DOWN from api/, like completions.js in api/compiler/; this
// file sits directly in api/, same directory as _store.js, so needs
// './_store.js' — same exact mistake already caught once on bits.js
// earlier, repeated here, caught again by actually testing rather than
// assuming the second draft was right just because it changed).

import { getCall, setCall, isConfigured } from "./_store.js";

const AGENT_CALLBACK_SECRET = process.env.AGENT_CALLBACK_SECRET;

export default async function handler(req, res) {
  res.setHeader("content-type", "application/json");
  const send = (obj, status = 200) => {
    res.statusCode = status;
    return res.end(JSON.stringify(obj));
  };

  if (req.method !== "POST") {
    return send({ error: "POST only" }, 405);
  }
  if (!AGENT_CALLBACK_SECRET) {
    return send({ error: "AGENT_CALLBACK_SECRET not configured" }, 500);
  }
  const providedSecret = req.headers["x-agent-secret"];
  if (!providedSecret || providedSecret !== AGENT_CALLBACK_SECRET) {
    return send({ error: "forbidden" }, 403);
  }
  if (!isConfigured()) {
    return send({ error: "store not configured" }, 500);
  }

  let body = "";
  await new Promise((resolve) => {
    req.on("data", (c) => (body += c));
    req.on("end", resolve);
  });
  let parsed;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return send({ error: "invalid JSON body" }, 400);
  }

  const callId = parsed.call_id;
  const markers = Array.isArray(parsed.markers)
    ? parsed.markers
    : parsed.marker
    ? [parsed.marker]
    : [];
  if (!callId || !markers.length) {
    return send({ error: "call_id and marker/markers required" }, 400);
  }

  const stored = await getCall(callId).catch(() => null);
  const prior = (stored && stored.confirmedMarkerCounts) || {};
  const next = { ...prior };
  for (const m of markers) {
    if (typeof m !== "string" || !m) continue;
    next[m] = (next[m] || 0) + 1;
  }

  try {
    await setCall(callId, { confirmedMarkerCounts: next });
  } catch (e) {
    return send({ error: "write failed", detail: String(e).slice(0, 200) }, 502);
  }

  return send({ ok: true, counts: next });
}

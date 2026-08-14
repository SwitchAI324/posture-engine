// SpamViking — Posture Engine: call-prefix STORE
// ----------------------------------------------------------------------
// One row per call: the frozen assembled prefix + the current posture line.
// Pure fetch + process.env so it runs in BOTH the Edge proxy and the Node
// pre-snap function. Backed by Supabase REST.
//
// Table (run once):
//   create table if not exists call_prefix (
//     call_id text primary key,
//     prefix text not null,
//     posture_line text,
//     updated_at timestamptz default now()
//   );
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (server-side; bypasses RLS).
// ----------------------------------------------------------------------
const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TABLE = "call_prefix";
const CONTROLS = "call_controls"; // canonical home for death_blow + arm + bench controls
const CALLS = "calls"; // post-call outcome rows (Barbara's follow-up ladder keys off these)
const EVENTS = "gear_events";
export function isConfigured() {
  return Boolean(URL && KEY);
}
// READ BY SLUG KEY — fallback for the pre-call hydrate. The hydrate can run
// BEFORE the Vapi call_id exists, writing the prefix under call_id="slug:<slug>"
// (a pseudo-key). When the real first turn arrives and its call_id row has no
// prefix yet (the hydrate raced and lost, or hasn't been re-keyed), completions
// reads this slug row instead. This removes the hydrate-vs-first-turn race:
// the prefix is guaranteed present before the call starts, keyed by slug.
// No schema change — same call_prefix table, a row whose call_id is "slug:...".
export async function getCallBySlug(slug) {
  if (!slug) return null;
  return getCall("slug:" + slug);
}
// READ — the one sanctioned hot-path lookup (indexed PK, not an LLM call).
// Returns { prefix, postureLine } or null (not found / not configured).
export async function getCall(callId) {
  if (!isConfigured() || !callId) return null;
  const url =
    `${URL}/rest/v1/${TABLE}?call_id=eq.${encodeURIComponent(callId)}` +
   `&select=prefix,posture_line,pressure,engagement,phase,target_id,arrival_state,bench_log,control_url,pending_handoff,stall_count,last_bit_id,last_bit_turn,last_bit_at,business_latched,opener_overlay,business_overlay,archetype,character_id,commitment_push,bit_fire_history,hunt_rung_count,caller_redirected,hunt_rung_turn,caller_crude,crude_impersonal_count,crude_personal_count,marker_counts,marker_last_turn,pricing_raised,texture_invited,last_stall_resolved_turn,expertise_level_used,pending_bench_awareness,latest_call_id,active_generation,bench_present`;
  const r = await fetch(url, {
    cache: "no-store",
    headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) {
    // SURFACE THE REAL ERROR (Aug 6, found live — this exact silence hid a
    // missing-column bug for the entire debugging session). A non-ok
    // response was being treated identically to "zero rows found," which
    // made a genuine query failure (a 400, a schema mismatch, anything)
    // indistinguishable from an empty result. Log the actual body so the
    // next failure like this is visible in one log line, not a full
    // Supabase log export.
    const errBody = await r.text().catch(() => "");
    console.log("getCall FAILED status=" + r.status + " callId=" + callId + " body=" + errBody.slice(0, 300));
    return null;
  }
  const rows = await r.json();
  if (!rows || !rows.length) return null;
  return {
    prefix: rows[0].prefix,
    postureLine: rows[0].posture_line,
    // gear/slip/accuseFloor REMOVED (Aug 5, gears removal) — suspicion axis
    // retired entirely, no replacement. The gear/slip/accuse_floor DB columns
    // are left as-is (harmless unused legacy), just no longer read/written.
    pressure: rows[0].pressure || "calm",
    engagement: rows[0].engagement || "hooked",
    phase: rows[0].phase ?? "opening", // Stage-4 call phase (async read)
    targetId: rows[0].target_id ?? null, // the target the booking token was
                                         // minted for; compiled at hydrate,
                                         // stamped on every Mead Hall event so
                                         // the board can watch by target before
                                         // the call_id exists
    arrivalState: rows[0].arrival_state ?? null, // v2 bench: in-progress arrival (jsonb)
    benchLog: rows[0].bench_log ?? [], // v2 bench: [{bench_id,arrived_turn}] for pacing/cap
    controlUrl: rows[0].control_url ?? null, // Vapi per-call monitor.controlUrl (for handoff)
    pendingHandoff: rows[0].pending_handoff ?? null, // telegraph->handoff two-beat state
    stallCount: rows[0].stall_count ?? 0, // turns_since_pitch_or_ask (extended_stall)
    lastBitId: rows[0].last_bit_id || null,
    lastBitTurn: rows[0].last_bit_turn ?? null,
    // Number() because PostgREST can hand bigint back as a string; the
    // re-injection window does arithmetic on it.
    lastBitAt: rows[0].last_bit_at != null ? Number(rows[0].last_bit_at) : null,
    businessLatched: rows[0].business_latched ?? false,
    openerOverlay: rows[0].opener_overlay ?? null,
    businessOverlay: rows[0].business_overlay ?? null,
    archetype: rows[0].archetype || null,
    characterId: rows[0].character_id || null, // host_posture for the calls record
    // STEP 1 live-event flag (commitment_push). Persisted per turn so the
    // completions consumer can read the PRIOR turn's detector result. Defaults
    // false when the column is absent/null — a call that never saw a payment
    // demand reads false, same as the detector-off case.
    commitmentPush: rows[0].commitment_push ?? false,
    // UNIVERSAL FIRE HISTORY (Aug 6, generalized from texture-only
    // textureLastFire, replaces it — see _bits_scorer.js's own comment for
    // the full shape: { [bitId]: { lastFiredTurn, totalFires,
    // lastCountedTurn } }). jsonb column, defaults {} for a call that
    // predates this feature (or a fresh row where it's null). An
    // absent/never-fired entry reads as "eligible" everywhere it's checked.
    bitFireHistory: rows[0].bit_fire_history ?? {},
    // STALL RESOLUTION SIGNALS (rung count + caller-redirect). Both default
    // to their "nothing has happened yet" state so a call that predates
    // these reads exactly as if the feature didn't exist.
    huntRungCount: rows[0].hunt_rung_count ?? 0,
    // huntRungTurn: the turn the rung counter was last bumped at — the race
    // guard so same-turn preemptive-gen siblings don't each independently
    // increment. null = never bumped (fresh call, or just resolved).
    huntRungTurn: rows[0].hunt_rung_turn ?? null,
    // TEXTURE POST-EVENT COOLDOWN: the turn a stall/hunt last resolved, read
    // FORWARD by the texture gate (not cleared on read, unlike the hunt-state
    // fields above). null = never resolved / fresh call.
    lastStallResolvedTurn: rows[0].last_stall_resolved_turn ?? null,
    // EXPERTISE-LEVEL DIAL (Aug 6): the level PE actually USED last turn —
    // separate from the Director's live control (getControls), which is
    // "what SHOULD it be now." Comparing these two each turn is how a
    // change gets detected (this persisted value lags one turn behind by
    // definition). null = never set yet (fresh call, uses the default).
    expertiseLevelUsed: rows[0].expertise_level_used ?? null,
    // BENCH TAKEOVER AWARENESS (Aug 8) — the last takeover's {character,
    // line}, consumed exactly once by the NEXT turn (injected as an
    // awareness note, then cleared). Without this the host has zero
    // knowledge a bench character even spoke — the line only ever rode in
    // metadata to the agent, never into the model's own context.
    pendingBenchAwareness: rows[0].pending_bench_awareness ?? null,
    callerRedirected: rows[0].caller_redirected ?? false,
    // CALLER-CRUDE signal: raw per-turn classification + two running counts.
    // Defaults match "nothing crude has happened yet" for a call that
    // predates this feature or a fresh row.
    callerCrude: rows[0].caller_crude ?? "none",
    crudeImpersonalCount: rows[0].crude_impersonal_count ?? 0,
    crudePersonalCount: rows[0].crude_personal_count ?? 0,
    // MARKER AWARENESS: per-marker running counts + per-marker last-fired
    // turn (both jsonb objects keyed by marker token, e.g. "COFFEE_CUP_
    // BREAK"). Empty objects for a call that predates this feature or a
    // fresh row — same "nothing has happened yet" default as everything else.
    markerCounts: rows[0].marker_counts ?? {},
    markerLastTurn: rows[0].marker_last_turn ?? {},
    // PRICING RAISED: one-way latch, default false (nothing quoted yet).
    pricingRaised: rows[0].pricing_raised ?? false,
    // TEXTURE INVITED: momentary, defaults PERMISSIVE (true) — a missing/
    // absent read must never silently suppress all texture; only an
    // explicit false (this turn's reader judgment) does that.
    textureInvited: rows[0].texture_invited ?? true,
    // LATEST CALL ID (Aug 12, completing the Aug 10 self-correcting
    // call_id fix — was written by hydrate.js's writePrefix() this whole
    // time but never actually persisted: missing from setCall()'s own
    // destructured params below, AND missing from this function's SELECT
    // clause above, so control.js's `?slug=` lookup always got null no
    // matter what the caller did right. Only meaningful on the
    // "slug:<slug>" row (stamped there by hydrate.js); null everywhere
    // else, which is correct — nothing else should set or read it.
    latestCallId: rows[0].latest_call_id ?? null,
    // ACTIVE GENERATION (Aug 12, uncancelled-stacking fix) — a random
    // token stamped by whichever completions.js request most recently
    // STARTED for this call_id. Every request stamps its own token when
    // it begins (see setCall's own comment on the write side), then
    // re-reads this field right before the expensive Anthropic fetch —
    // if it no longer matches the token it stamped, a NEWER request has
    // since started for the same call, and this one abandons itself
    // rather than burning a full generation nobody will use. Best-
    // effort, not airtight (the write is async/waitUntil, so a rare
    // ordering race could let a stale request "win") — but the failure
    // mode is only ever "didn't cancel something it should have," never
    // worse than the current baseline of cancelling nothing at all.
    // null = no request has stamped this call yet (fresh call, or a
    // call this feature predates).
    activeGeneration: rows[0].active_generation ?? null,
    // BENCH PRESENCE (Aug 14, Voice's join/continue/drop proposal) —
    // per-call map of bench tag -> "present" | "dropped". Absent key =
    // never joined this call (same as "not present" for read purposes).
    // Only ever written by the takeover branch in completions.js's
    // runBenchArrival — join/continue set "present", drop sets
    // "dropped". Empty object, not null, when nothing has joined yet —
    // simpler truthy checks downstream than distinguishing null/{}.
    benchPresent: rows[0].bench_present ?? {},
  };
}
// WRITE (upsert) — used at pre-snap to freeze the prefix, and later by the
// posture engine to update just the posture line.
export async function setCall(
  callId,
  { prefix, postureLine, pressure, engagement, phase, targetId, arrivalState, benchLog, controlUrl, pendingHandoff, stallCount, lastBitId, lastBitTurn, lastBitAt, businessLatched, openerOverlay, businessOverlay, archetype, characterId, commitmentPush, bitFireHistory, huntRungCount, callerRedirected, huntRungTurn, callerCrude, crudeImpersonalCount, crudePersonalCount, markerCounts, markerLastTurn, pricingRaised, textureInvited, lastStallResolvedTurn, expertiseLevelUsed, pendingBenchAwareness, latestCallId, activeGeneration, benchPresent }
) {
  if (!isConfigured()) {
    throw new Error(
      "store not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  const row = { call_id: callId, updated_at: new Date().toISOString() };
  if (prefix !== undefined) row.prefix = prefix;
  if (postureLine !== undefined) row.posture_line = postureLine;
  // gear/slip/accuseFloor REMOVED (Aug 5, gears removal) — suspicion axis
  // retired entirely, no replacement.
  if (pressure !== undefined) row.pressure = pressure;
  if (engagement !== undefined) row.engagement = engagement;
  if (phase !== undefined) row.phase = phase; // Stage-4 call phase (async read)
  if (targetId !== undefined) row.target_id = targetId; // booking_tokens.target_id,
                                                        // written once at hydrate
  if (arrivalState !== undefined) row.arrival_state = arrivalState; // v2 bench (jsonb, nullable)
  if (benchLog !== undefined) row.bench_log = benchLog; // v2 bench arrival log (jsonb array)
  if (controlUrl !== undefined) row.control_url = controlUrl; // Vapi monitor.controlUrl
  if (pendingHandoff !== undefined) row.pending_handoff = pendingHandoff; // telegraph->handoff state
  if (stallCount !== undefined) row.stall_count = stallCount; // extended_stall counter
  if (lastBitId !== undefined) row.last_bit_id = lastBitId;
  if (lastBitTurn !== undefined) row.last_bit_turn = lastBitTurn;
  // lastBitAt: ms-epoch of the last REAL bit fire. Powers REINJECT_WINDOW_MS in
  // completions — re-injection is only valid for a preemptive regeneration
  // (sub-second), never for a silence bare-turn (tens of seconds later).
  if (lastBitAt !== undefined) row.last_bit_at = lastBitAt;
  // businessLatched: one-way phase-overlay latch. Once the call leaves
  // "opening" this pins the BUSINESS overlay for the rest of the call so a
  // wobbling phase read can't drag the opener machinery back on turn 20.
  if (businessLatched !== undefined) row.business_latched = businessLatched;
  // opener/business overlays: the two swappable phase blocks, written once at
  // hydrate. completions appends the phase-selected one after the cached
  // prefix. WITHOUT THESE PERSISTED THE SPLIT SILENTLY FALLS BACK TO CORE-ONLY.
  if (openerOverlay !== undefined) row.opener_overlay = openerOverlay;
  if (businessOverlay !== undefined) row.business_overlay = businessOverlay;
  if (archetype !== undefined) row.archetype = archetype;
  if (characterId !== undefined) row.character_id = characterId; // host_posture source
  // commitmentPush: STEP 1 live-event flag. Only written when provided (the
  // detector-off case never passes it, so the column stays at its default).
  // Persisting it is what lets the NEXT turn's consumer read the demand — the
  // field was previously dropped here, so stored.commitmentPush was always
  // undefined and the consumer guard never passed.
  if (commitmentPush !== undefined) row.commitment_push = commitmentPush;
  // bitFireHistory: universal per-bit fire-history map (jsonb), generalized
  // Aug 6 from texture-only textureLastFire. Only written when provided —
  // same pattern as every other field here.
  if (bitFireHistory !== undefined) row.bit_fire_history = bitFireHistory;
  // STALL RESOLUTION SIGNALS: rung counter (huntRungCount) and the reader's
  // caller-redirect judgment (callerRedirected). Same "only write when
  // provided" pattern as every other field here.
  if (huntRungCount !== undefined) row.hunt_rung_count = huntRungCount;
  // huntRungTurn: the race-guard companion to huntRungCount (see completions.js
  // for why) — only written when provided, same pattern as every field here.
  if (huntRungTurn !== undefined) row.hunt_rung_turn = huntRungTurn;
  // TEXTURE POST-EVENT COOLDOWN: same "only write when provided" pattern.
  if (lastStallResolvedTurn !== undefined) row.last_stall_resolved_turn = lastStallResolvedTurn;
  // EXPERTISE-LEVEL DIAL: the level PE actually used THIS turn, persisted so
  // NEXT turn can compare against it to detect a change. Same "only write
  // when provided" pattern as everything else here.
  if (expertiseLevelUsed !== undefined) row.expertise_level_used = expertiseLevelUsed;
  // BENCH TAKEOVER AWARENESS: written with the {character, line} object
  // when a takeover fires; written with null by the VERY NEXT turn once
  // it's consumed (one-shot, same pattern as the expertise-dial transition
  // note — never re-injects after the first read).
  if (pendingBenchAwareness !== undefined) row.pending_bench_awareness = pendingBenchAwareness;
  // LATEST CALL ID (Aug 12 fix — see getCall()'s own comment on this same
  // field for the full story). Only ever passed by hydrate.js's
  // writePrefix() on the "slug:<slug>" row. "only write when provided"
  // pattern like everything else here — undefined leaves any existing
  // value alone, explicit null clears it.
  if (latestCallId !== undefined) row.latest_call_id = latestCallId;
  // ACTIVE GENERATION: see getCall()'s own comment for the full
  // mechanism. Written unconditionally by EVERY completions.js request
  // as it starts (always overwrites — that's the point: "most recent
  // write wins" is what makes an older request detect it's been
  // superseded). "only write when provided" pattern like everything
  // else here.
  if (activeGeneration !== undefined) row.active_generation = activeGeneration;
  if (benchPresent !== undefined) row.bench_present = benchPresent;
  if (callerRedirected !== undefined) row.caller_redirected = callerRedirected;
  // CALLER-CRUDE: raw classification + the two running counts. Same "only
  // write when provided" pattern as every other field here.
  if (callerCrude !== undefined) row.caller_crude = callerCrude;
  if (crudeImpersonalCount !== undefined) row.crude_impersonal_count = crudeImpersonalCount;
  if (crudePersonalCount !== undefined) row.crude_personal_count = crudePersonalCount;
  // MARKER AWARENESS: both jsonb, same "only write when provided" pattern.
  if (markerCounts !== undefined) row.marker_counts = markerCounts;
  if (markerLastTurn !== undefined) row.marker_last_turn = markerLastTurn;
  // PRICING RAISED: only ever written as true (see blendRead's one-way-latch
  // comment) — "only write when provided" naturally means a false/absent
  // read never overwrites an existing true.
  if (pricingRaised !== undefined) row.pricing_raised = pricingRaised;
  // TEXTURE INVITED: momentary boolean, same "only write when provided"
  // pattern — no latch logic needed here, blendRead already handles that
  // this field is per-turn, not sticky.
  if (textureInvited !== undefined) row.texture_invited = textureInvited;
  const r = await fetch(`${URL}/rest/v1/${TABLE}`, {
    cache: "no-store",
    method: "POST",
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) {
    throw new Error(`store write failed: ${r.status} ${await r.text()}`);
  }
  return true;
}
// CONTROLS — Director's live commands (death_blow + arms + bench) live in
// call_controls, one row each, distinguished by control_type. PE owns the row
// shape: control-specific fields ride in payload; rung_id is the only death-
// blow-specific column. getControls reads them all in one query (run
// concurrently with getCall, so no added hot-path latency). Only pending/armed
// rows are "live"; fired/cleared drop.
export async function getControls(callId) {
  const empty = { deathBlow: null, armed: [], sentBench: null, forced: null, absurdityCeiling: null, expertiseLevel: null };
  if (!isConfigured() || !callId) return empty;
  const r = await fetch(
    `${URL}/rest/v1/${CONTROLS}?call_id=eq.${encodeURIComponent(callId)}` +
      `&select=id,control_type,rung_id,status,idempotency_key,payload`,
    { cache: "no-store", headers: { apikey: KEY, authorization: `Bearer ${KEY}` } }
  );
  if (!r.ok) return empty;
  const rows = await r.json();
  if (!Array.isArray(rows)) return empty;
  const live = (s) => s === "pending" || s === "armed";
  let deathBlow = null;
  const armed = [];
  let sentBench = null;
  let forced = null;
  let absurdityCeiling = null;
  let expertiseLevel = null;
  for (const row of rows) {
    const p = row.payload || {};
    if (row.control_type === "death_blow") {
      // return regardless of status (turn loop guards on pending; callend needs
      // to see "fired" to avoid double-emitting a natural ending).
      deathBlow = {
        id: row.id, rung_id: row.rung_id, rung_name: p.rung_name ?? null,
        final_line: p.final_line ?? null, idem: row.idempotency_key || null,
        status: row.status,
      };
    } else if (row.control_type === "arm" && live(row.status)) {
      armed.push({
        id: row.id, bit_id: p.bit_id ?? null, hook_id: p.hook_id ?? null,
        armed_turn: p.armed_turn ?? null, idem: row.idempotency_key || null,
      });
    } else if (row.control_type === "bench" && live(row.status)) {
      // Director sent in a specific bench character. Last live one wins.
      // mode (Aug 8): "weave" (default, absent on any pre-mode row — those
      // read as weave, exactly their existing behavior, zero regression)
      // or "takeover".
      sentBench = {
        id: row.id, bench_id: p.bench_id ?? null,
        sent_turn: p.sent_turn ?? null, idem: row.idempotency_key || null,
        mode: p.mode === "takeover" ? "takeover" : "weave",
      };
    } else if (row.control_type === "force" && row.status === "pending") {
      // Director forced a bit to fire next turn. Last pending one wins.
      forced = {
        id: row.id, bit_id: p.bit_id ?? null,
        forced_turn: p.forced_turn ?? null, idem: row.idempotency_key || null,
      };
    } else if (row.control_type === "absurdity_ceiling" && live(row.status)) {
      // Director-set session-level absurdity cap (Aug 6). Last live one wins,
      // same pattern as sentBench. null = no Director override; the caller
      // falls back to whatever default/archetype logic applies.
      absurdityCeiling = p.ceiling ?? null;
    } else if (row.control_type === "expertise_level" && live(row.status)) {
      // Director-set topical-expertise level (Aug 6, one-time-per-call dial —
      // "above average" default, dial turns it up or down). Last live one
      // wins, same pattern as absurdityCeiling. null = no Director override;
      // the caller falls back to the default level.
      expertiseLevel = p.level ?? null;
    }
  }
  return { deathBlow, armed, sentBench, forced, absurdityCeiling, expertiseLevel };
}
// DEATH BLOW (Trigger A) — insert one pending death_blow row. The partial unique
// index keeps it to one per call_id; a duplicate (same call or same idem) comes
// back 409, which we treat as already-armed (idempotent). rung_id is a column;
// rung_name + final_line ride in payload.
export async function setDeathBlow(callId, { rungId, rungName, finalLine, idem, director } = {}) {
  if (!isConfigured() || !callId) throw new Error("store not configured");
  const row = {
    call_id: callId,
    control_type: "death_blow",
    rung_id: rungId ?? null, // rungs are gone; column kept nullable for the row
    director_user_id: director ?? null,
    idempotency_key: idem ?? null,
    status: "pending",
    payload: { rung_name: rungName ?? null, final_line: finalLine ?? null },
  };
  const r = await fetch(`${URL}/rest/v1/${CONTROLS}`, {
    cache: "no-store",
    method: "POST",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json", prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (r.status === 409) return true; // already armed for this call — idempotent
  if (!r.ok) throw new Error(`death-blow set failed: ${r.status} ${await r.text()}`);
  return true;
}
export async function clearDeathBlow(callId, status = "fired") {
  if (!isConfigured() || !callId) return false;
  const r = await fetch(
    `${URL}/rest/v1/${CONTROLS}?call_id=eq.${encodeURIComponent(callId)}` +
      `&control_type=eq.death_blow`,
    {
    cache: "no-store",
      method: "PATCH",
      headers: {
        apikey: KEY, authorization: `Bearer ${KEY}`,
        "content-type": "application/json", prefer: "return=minimal",
      },
      body: JSON.stringify({ status }),
    }
  );
  return r.ok;
}
// ARM — one row per armed item. addArm inserts (idempotency_key collapses double
// clicks via 409). stampArm writes armed_turn into payload on first sight (the
// escalation clock). fireArm marks a row fired when its bit lands. Setlist max-3
// is enforced in the arm endpoint (product rule), not here.
export async function addArm(callId, { bitId, hookId, idem, director }) {
  if (!isConfigured() || !callId) throw new Error("store not configured");
  const row = {
    call_id: callId,
    control_type: "arm",
    director_user_id: director ?? null,
    idempotency_key: idem ?? null,
    status: "pending",
    payload: { bit_id: bitId ?? null, hook_id: hookId ?? null, armed_turn: null },
  };
  const r = await fetch(`${URL}/rest/v1/${CONTROLS}`, {
    cache: "no-store",
    method: "POST",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json", prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (r.status === 409) return true; // duplicate idem — idempotent
  if (!r.ok) throw new Error(`arm set failed: ${r.status} ${await r.text()}`);
  return true;
}
// UNARM / DISARM — free a setlist slot. getControls counts an arm as live only
// while status is "pending" or "armed"; setting it to "disarmed" drops it from
// the live count immediately, so a stuck Director (3 armed, none firing) can
// re-choose. We PATCH the arm rows for this call+bit that are still live
// (status in pending,armed) to status "disarmed". Idempotent: if no live arm
// matches (already disarmed, already fired, or never armed) it's a no-op that
// still returns ok — disarm is "make sure this bit is not armed", not "there
// must have been an arm". Fired arms are left alone (they already happened); we
// only clear ones that never landed, which is exactly the stuck case.
export async function removeArm(callId, { bitId }) {
  if (!isConfigured() || !callId) throw new Error("store not configured");
  const q =
    `${URL}/rest/v1/${CONTROLS}` +
    `?call_id=eq.${encodeURIComponent(callId)}` +
    `&control_type=eq.arm` +
    `&status=in.(pending,armed)` +
    `&payload->>bit_id=eq.${encodeURIComponent(bitId)}`;
  const r = await fetch(q, {
    cache: "no-store",
    method: "PATCH",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json", prefer: "return=minimal",
    },
    body: JSON.stringify({ status: "disarmed" }),
  });
  // 200/204 = patched (or matched zero rows, still ok — idempotent no-op).
  if (!r.ok) throw new Error(`unarm failed: ${r.status} ${await r.text()}`);
  return true;
}
// FORCE — Director forces ONE bit to fire on the next host turn, bypassing the
// score/deploy-bar gate (the pick is stuck because it never clears the bar).
// One row, control_type "force"; payload carries bit_id. getControls surfaces
// it as `forced` while status is pending. completions.js reads it next turn,
// fires the bit bypassing the bar (like the gag-open path), then calls
// fireForce to mark it fired (one-shot — never re-fires). Mirrors setBench.
export async function forceBit(callId, { bitId, idem, director }) {
  if (!isConfigured() || !callId) throw new Error("store not configured");
  const row = {
    call_id: callId,
    control_type: "force",
    director_user_id: director ?? null,
    idempotency_key: idem ?? null,
    status: "pending",
    payload: { bit_id: bitId ?? null, forced_turn: null },
  };
  const r = await fetch(`${URL}/rest/v1/${CONTROLS}`, {
    cache: "no-store",
    method: "POST",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json", prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (r.status === 409) return true; // duplicate idem — idempotent
  if (!r.ok) throw new Error(`force set failed: ${r.status} ${await r.text()}`);
  return true;
}
// Mark a force row fired (one-shot). completions.js calls this the turn it
// fires the forced bit, so it can't fire again. PATCHes the live force row for
// this call+bit to status "fired".
export async function fireForce(callId, { bitId }) {
  if (!isConfigured() || !callId) throw new Error("store not configured");
  const q =
    `${URL}/rest/v1/${CONTROLS}` +
    `?call_id=eq.${encodeURIComponent(callId)}` +
    `&control_type=eq.force` +
    `&status=eq.pending` +
    `&payload->>bit_id=eq.${encodeURIComponent(bitId)}`;
  const r = await fetch(q, {
    cache: "no-store",
    method: "PATCH",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json", prefer: "return=minimal",
    },
    body: JSON.stringify({ status: "fired" }),
  });
  if (!r.ok) throw new Error(`fireForce failed: ${r.status} ${await r.text()}`);
  return true;
}
// BENCH — Director sends in a specific bench character mid-call. One row,
// control_type "bench"; payload carries the chosen bench_id. Mirrors addArm.
// The next host turn reads it (via getControls.sentBench) and weaves that
// character in, overriding the automatic arrival schedule.
export async function setBench(callId, { benchId, idem, mode, director }) {
  if (!isConfigured() || !callId) throw new Error("store not configured");
  const row = {
    call_id: callId,
    control_type: "bench",
    director_user_id: director ?? null,
    idempotency_key: idem ?? null,
    status: "pending",
    // mode (Aug 8): "weave" (default, folds the line into the host's own
    // turn) or "takeover" (the bench character's own voice speaks, host
    // silent that turn). Stored in payload alongside bench_id — no schema
    // change, same jsonb column every other control already uses.
    payload: { bench_id: benchId ?? null, sent_turn: null, mode: mode || "weave" },
  };
  const r = await fetch(`${URL}/rest/v1/${CONTROLS}`, {
    cache: "no-store",
    method: "POST",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json", prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (r.status === 409) return true; // duplicate idem — idempotent
  if (!r.ok) throw new Error(`bench set failed: ${r.status} ${await r.text()}`);
  return true;
}
// CLEAR BENCH (Aug 8, found live — a real gap, not defensive extra). Same
// pattern as clearDeathBlow: PATCH the row's status once it's actually
// been consumed. Before this, nothing anywhere ever marked a sentBench row
// non-live again — weave-in mostly got away with it because the
// multi-turn arrival sequence and benchLog's 3-slot ceiling happened to
// limit how often it could re-fire, but a takeover has no such natural
// limit and would silently re-trigger every turn until someone noticed.
// Called immediately once a takeover's line is generated (fire-and-forget
// is NOT safe here — this has to land before the next turn reads
// getControls again, so it's awaited, not waitUntil'd).
export async function clearBench(callId, status = "fired") {
  if (!isConfigured() || !callId) return false;
  const r = await fetch(
    `${URL}/rest/v1/${CONTROLS}?call_id=eq.${encodeURIComponent(callId)}` +
      `&control_type=eq.bench`,
    {
      cache: "no-store",
      method: "PATCH",
      headers: {
        apikey: KEY, authorization: `Bearer ${KEY}`,
        "content-type": "application/json", prefer: "return=minimal",
      },
      body: JSON.stringify({ status }),
    }
  );
  return r.ok;
}
export async function stampArm(id, payload) {
  if (!isConfigured() || !id) return false;
  const r = await fetch(`${URL}/rest/v1/${CONTROLS}?id=eq.${encodeURIComponent(id)}`, {
    cache: "no-store",
    method: "PATCH",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json", prefer: "return=minimal",
    },
    body: JSON.stringify({ payload }),
  });
  return r.ok;
}
export async function fireArm(id) {
  if (!isConfigured() || !id) return false;
  const r = await fetch(`${URL}/rest/v1/${CONTROLS}?id=eq.${encodeURIComponent(id)}`, {
    cache: "no-store",
    method: "PATCH",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json", prefer: "return=minimal",
    },
    body: JSON.stringify({ status: "fired" }),
  });
  return r.ok;
}
// APPEND a per-turn breadcrumb to gear_events — the history that powers the
// gear-trace graph. Append-only (one row per turn), best-effort, and only
// ever called via waitUntil() so it never touches the hot path. Failures are
// swallowed: telemetry must never break a call.
// suspicion/slip REMOVED from the payload (Aug 5, gears removal) — the
// gear_events TABLE/columns are left as-is (harmless unused legacy), the
// call site simply no longer sends them.
export async function appendGearEvent(
  callId,
  { turn, pressure, engagement, accusation, utterance }
) {
  if (!isConfigured() || !callId) return false;
  const row = {
    call_id: callId,
    turn,
    pressure,
    engagement,
    accusation: accusation || null,
    utterance: (utterance || "").slice(0, 500),
  };
  const r = await fetch(`${URL}/rest/v1/${EVENTS}`, {
    cache: "no-store",
    method: "POST",
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  return r.ok;
}
// APPEND a per-turn FIT read to bit_events — the top-ranked bit and its score
// breakdown, plus whether it fired. This is how fit becomes measurable: one row
// per turn, off the hot path, best-effort.
export async function appendBitEvent(
  callId,
  { turn, bit_id, name, score, fit, gear_bias, recency, fired, why }
) {
  if (!isConfigured() || !callId) return false;
  const row = {
    call_id: callId, turn, bit_id, name,
    score, fit, gear_bias, recency,
    fired: !!fired, why: (why || "").slice(0, 300),
  };
  const r = await fetch(`${URL}/rest/v1/bit_events`, {
    cache: "no-store",
    method: "POST",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json", prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  return r.ok;
}
// TRANSCRIPT — upsert the full conversation-so-far every turn, keyed by
// call_id (the LiveKit room name). Last write wins, so the row always holds
// the complete transcript up to the latest turn — including when the call
// ends or crashes, with no end-of-call event needed. The system prompt is
// EXCLUDED (it's the ~4,700-token prefix resent every turn; storing it per
// call would bloat every row with a copy of the same prompt — the prefix
// already lives in call_prefix). Best-effort, only ever called via
// waitUntil(): telemetry must never break a call.
// Table (run once):
//   create table if not exists call_transcripts (
//     call_id    text primary key,
//     slug       text,
//     messages   jsonb,
//     updated_at timestamptz default now()
//   );
export async function saveTranscript(callId, slug, messages) {
  if (!isConfigured() || !callId || !Array.isArray(messages)) return false;
  const convo = messages.filter((m) => m && m.role !== "system");
  if (!convo.length) return false;
  // CLOBBER GUARD: saveTranscript upserts the whole incoming array by call_id
  // (merge-duplicates), so the LAST write wins. A bare/short turn — e.g. a
  // silence poke whose array is truncated, or any regeneration carrying fewer
  // messages — would overwrite a longer, good transcript and make it vanish.
  // Before writing, read the stored row's length and SKIP the write only when
  // the incoming array is strictly shorter. Growing/equal always writes.
  // Defensive: if the read fails or returns nothing, fall through and write —
  // the guard only suppresses a write it can POSITIVELY confirm would shrink
  // the record; it never blocks a legitimate save. Best-effort (called under
  // waitUntil), so the read-then-write race is harmless.
  try {
    const g = await fetch(
      `${URL}/rest/v1/call_transcripts?call_id=eq.${encodeURIComponent(
        callId
      )}&select=messages`,
      {
    cache: "no-store", headers: { apikey: KEY, authorization: `Bearer ${KEY}` } }
    );
    if (g.ok) {
      const rows = await g.json().catch(() => null);
      const stored =
        Array.isArray(rows) && rows[0] && Array.isArray(rows[0].messages)
          ? rows[0].messages.length
          : 0;
      if (stored > convo.length) return true; // would shrink — skip, not an error
    }
  } catch {
    /* read failed — fall through and write */
  }
  const row = {
    call_id: callId,
    slug: slug || null,
    messages: convo,
    updated_at: new Date().toISOString(),
  };
  const r = await fetch(`${URL}/rest/v1/call_transcripts`, {
    cache: "no-store",
    method: "POST",
    headers: {
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
  return r.ok;
}
// INSERT CALL OUTCOME — Barbara's post-call follow-up ladder keys off a `calls`
// row's call_outcome. Written on a silence/bail/hangup close by the agent, via
// POST /api/calls?action=close (the agent has no DB access; PE writes the row).
// Schema (confirmed): calls requires only target_id (NOT NULL FK to targets.id);
// id auto-defaults; every other column is nullable. call_outcome is plain text
// with NO check constraint, so any value inserts (canonical set:
// completed|dropped|no_show|hung_up). We write ONLY the fields provided — a
// minimal write is just { target_id, call_outcome }. targetId is REQUIRED here;
// without it the insert fails the FK/NOT NULL (the real 400 risk, not the
// outcome value). Mirrors the addArm POST shape.
export async function insertCallOutcome({
  targetId,
  callOutcome,
  vapiCallId,
  startedAt,
  endedAt,
  durationSeconds,
  nextSteps,
  hostPosture,
  transcript,
  status,
}) {
  if (!isConfigured()) throw new Error("store not configured");
  if (!targetId) throw new Error("target_id required");
  // Build the row from ONLY the provided fields — omit undefined so we never
  // send a null that overwrites a column default (e.g. next_steps default []).
  const row = { target_id: targetId };
  if (callOutcome !== undefined) row.call_outcome = callOutcome;
  if (vapiCallId !== undefined) row.vapi_call_id = vapiCallId;
  if (startedAt !== undefined) row.started_at = startedAt;
  if (endedAt !== undefined) row.ended_at = endedAt;
  if (durationSeconds !== undefined) row.duration_seconds = durationSeconds;
  if (nextSteps !== undefined) row.next_steps = nextSteps;
  if (hostPosture !== undefined) row.host_posture = hostPosture;
  if (transcript !== undefined) row.transcript = transcript;
  if (status !== undefined) row.status = status;
  const r = await fetch(`${URL}/rest/v1/${CALLS}`, {
    cache: "no-store",
    method: "POST",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json", prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`calls insert failed: ${r.status} ${await r.text()}`);
  return true;
}
// CANCEL a pending force — the Director's in-flight un-fire. Same shape as
// fireForce but the terminal status is "cancelled" rather than "fired", so the
// two are distinguishable in the control history (did it land, or did the
// Director pull it?). getControls only surfaces PENDING force rows, so once
// this lands the consumer can never pick the bit up.
// Idempotent: if no pending force matches (already fired, already cancelled,
// or never forced) it PATCHes zero rows and still returns ok — cancel means
// "make sure this is not in flight", not "there must have been one".
// NOTE ON THE RACE: if the bit fires in the same instant, fireForce may win and
// set "fired" first; this then matches nothing and no-ops. That is correct —
// the endpoint reports already-fired and the UI jumps to the fired state.
export async function cancelForce(callId, { bitId } = {}) {
  if (!isConfigured() || !callId) throw new Error("store not configured");
  let q =
    `${URL}/rest/v1/${CONTROLS}` +
    `?call_id=eq.${encodeURIComponent(callId)}` +
    `&control_type=eq.force` +
    `&status=eq.pending`;
  // bitId optional: omit to cancel whatever is in flight for this call (the
  // one-in-flight model means there is at most one).
  if (bitId) q += `&payload->>bit_id=eq.${encodeURIComponent(bitId)}`;
  const r = await fetch(q, {
    cache: "no-store",
    method: "PATCH",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json", prefer: "return=minimal",
    },
    body: JSON.stringify({ status: "cancelled" }),
  });
  if (!r.ok) throw new Error(`cancelForce failed: ${r.status} ${await r.text()}`);
  return true;
}

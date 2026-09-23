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

export async function getHouseCallBySlug(slug) {
  if (!isConfigured() || !slug) return null;
  const url =
    `${URL}/rest/v1/house_calls?recording_slug=eq.${encodeURIComponent(slug)}` +
    `&select=started_at,transcript&order=started_at.desc&limit=1`;
  const r = await fetch(url, {
    cache: "no-store",
    headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) {
    console.log("getHouseCallBySlug: non-ok response for slug=" + slug + ": " + r.status);
    return null;
  }
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
export async function getCallBySlug(slug) {
  if (!slug) return null;
  return getCall("slug:" + slug);
}
const CALL_PREFIX_COLUMNS = "prefix,posture_line,pressure,engagement,phase,target_id,arrival_state,bench_log,control_url,pending_handoff,stall_count,last_bit_id,last_bit_turn,last_bit_at,business_latched,opener_overlay,opener_overlay_continuing,business_overlay,archetype,character_id,commitment_push,bit_fire_history,hunt_rung_count,caller_redirected,hunt_rung_turn,caller_crude,crude_impersonal_count,crude_personal_count,marker_counts,marker_last_turn,pricing_raised,texture_invited,last_stall_resolved_turn,expertise_level_used,pending_bench_awareness,latest_call_id,active_generation,bench_present,first_seen_at,caller_presenting,pitch_summary,host_name,recording_notice_given,host_turn_count,history_rev_seen,opener_served";
export async function getCall(callId) {
  if (!isConfigured() || !callId) return null;
  const baseUrl = `${URL}/rest/v1/${TABLE}?call_id=eq.${encodeURIComponent(callId)}`;
  let r = await fetch(baseUrl + `&select=${CALL_PREFIX_COLUMNS}`, {
    cache: "no-store",
    headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    console.log("getCall FAILED status=" + r.status + " callId=" + callId + " body=" + errBody.slice(0, 300));
    // SCHEMA-MISMATCH FALLBACK (2026-09-23) — built after a real incident: a
    // pending migration (opener_overlay_continuing) hadn't been run yet when
    // a test call went live, and PostgREST's "column does not exist" (42703)
    // fails the ENTIRE select — not just the missing field — so getCall()
    // returned null for EVERY turn of that call, silently starving it of its
    // whole host prompt (CORE/OPENER/BUSINESS all empty). That's a much
    // worse failure than "one new field is temporarily missing." If the
    // failure looks like a missing-column error specifically, retry once
    // with select=* so a forgotten migration degrades to "new fields default
    // via ??" instead of "the whole call runs blind." Any other failure
    // (auth, network, a genuinely bad callId) is NOT retried — this only
    // catches the specific 42703 schema-mismatch shape.
    if (r.status === 400 && /42703/.test(errBody)) {
      console.log("getCall SCHEMA MISMATCH — retrying with select=* (a migration is likely pending) callId=" + callId);
      r = await fetch(baseUrl + `&select=*`, {
        cache: "no-store",
        headers: { apikey: KEY, authorization: `Bearer ${KEY}` },
      });
      if (!r.ok) {
        const retryErrBody = await r.text().catch(() => "");
        console.log("getCall FALLBACK ALSO FAILED status=" + r.status + " callId=" + callId + " body=" + retryErrBody.slice(0, 300));
        return null;
      }
    } else {
      return null;
    }
  }
  const rows = await r.json();
  if (!rows || !rows.length) return null;
  return {
    prefix: rows[0].prefix,
    postureLine: rows[0].posture_line,
    pressure: rows[0].pressure || "calm",
    engagement: rows[0].engagement || "hooked",
    phase: rows[0].phase ?? "opening",
    targetId: rows[0].target_id ?? null,
    arrivalState: rows[0].arrival_state ?? null,
    benchLog: rows[0].bench_log ?? [],
    controlUrl: rows[0].control_url ?? null,
    pendingHandoff: rows[0].pending_handoff ?? null,
    stallCount: rows[0].stall_count ?? 0,
    lastBitId: rows[0].last_bit_id || null,
    lastBitTurn: rows[0].last_bit_turn ?? null,
    lastBitAt: rows[0].last_bit_at != null ? Number(rows[0].last_bit_at) : null,
    businessLatched: rows[0].business_latched ?? false,
    openerOverlay: rows[0].opener_overlay ?? null,
    // TURN-AWARE OPENER SPLIT (2026-09-23, structural fix for the recurring
    // turn-2+ re-mess/re-open bug) — openerOverlay above is the FULL opener
    // content (used on turn 1 / before the host has spoken). This is the
    // leaner version for every turn after that: the "arrive out of a mess"
    // content is structurally absent rather than present-but-banned, so the
    // model never sees the temptation to begin with. null on any call
    // hydrated before this shipped, or if Canon's source doc hasn't added
    // the TURN-ONE-ONLY/CONTINUING sub-markers yet — completions.js falls
    // back to the full openerOverlay in that case (old behavior, no
    // regression).
    openerOverlayContinuing: rows[0].opener_overlay_continuing ?? null,
    businessOverlay: rows[0].business_overlay ?? null,
    archetype: rows[0].archetype || null,
    characterId: rows[0].character_id || null,
    commitmentPush: rows[0].commitment_push ?? false,
    bitFireHistory: rows[0].bit_fire_history ?? {},
    huntRungCount: rows[0].hunt_rung_count ?? 0,
    huntRungTurn: rows[0].hunt_rung_turn ?? null,
    lastStallResolvedTurn: rows[0].last_stall_resolved_turn ?? null,
    expertiseLevelUsed: rows[0].expertise_level_used ?? null,
    pendingBenchAwareness: rows[0].pending_bench_awareness ?? null,
    callerRedirected: rows[0].caller_redirected ?? false,
    callerCrude: rows[0].caller_crude ?? "none",
    crudeImpersonalCount: rows[0].crude_impersonal_count ?? 0,
    crudePersonalCount: rows[0].crude_personal_count ?? 0,
    markerCounts: rows[0].marker_counts ?? {},
    markerLastTurn: rows[0].marker_last_turn ?? {},
    pricingRaised: rows[0].pricing_raised ?? false,
    textureInvited: rows[0].texture_invited ?? true,
    latestCallId: rows[0].latest_call_id ?? null,
    activeGeneration: rows[0].active_generation ?? null,
    benchPresent: rows[0].bench_present ?? {},
    firstSeenAt: rows[0].first_seen_at != null ? Number(rows[0].first_seen_at) : null,
    callerPresenting: rows[0].caller_presenting ?? false,
    pitchSummary: rows[0].pitch_summary ?? "",
    hostName: rows[0].host_name || null,
    recordingNoticeGiven: rows[0].recording_notice_given ?? false,
    hostTurnCount: rows[0].host_turn_count ?? 0,
    // HISTORY-REV / OPENER-SERVED (2026-09-23, Voice's fix for the shared-
    // speculative-generation-state bug) — see completions.js's own comment
    // at the overlay-selection site for the full rationale. historyRevSeen
    // is the highest metadata.history_rev this call has ever reported;
    // openerServed is PE's OWN durable record that the opener has genuinely
    // been served at least once, set only from evidence PE trusts (a
    // non-stale request whose messages array actually shows an assistant
    // turn) — never from a single request's shape alone, so a later request
    // with a corrupted/reset messages array can't un-teach PE what it
    // already confirmed.
    historyRevSeen: rows[0].history_rev_seen ?? null,
    openerServed: rows[0].opener_served ?? false,
  };
}
export async function setCall(
  callId,
  { prefix, postureLine, pressure, engagement, phase, targetId, arrivalState, benchLog, controlUrl, pendingHandoff, stallCount, lastBitId, lastBitTurn, lastBitAt, businessLatched, openerOverlay, openerOverlayContinuing, businessOverlay, archetype, characterId, commitmentPush, bitFireHistory, huntRungCount, callerRedirected, huntRungTurn, callerCrude, crudeImpersonalCount, crudePersonalCount, markerCounts, markerLastTurn, pricingRaised, textureInvited, lastStallResolvedTurn, expertiseLevelUsed, pendingBenchAwareness, latestCallId, activeGeneration, benchPresent, firstSeenAt, callerPresenting, pitchSummary, hostName, recordingNoticeGiven, hostTurnCount, historyRevSeen, openerServed }
) {
  if (!isConfigured()) {
    throw new Error(
      "store not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY"
    );
  }
  const row = { call_id: callId, updated_at: new Date().toISOString() };
  if (prefix !== undefined) row.prefix = prefix;
  if (postureLine !== undefined) row.posture_line = postureLine;
  if (pressure !== undefined) row.pressure = pressure;
  if (engagement !== undefined) row.engagement = engagement;
  if (phase !== undefined) row.phase = phase;
  if (targetId !== undefined) row.target_id = targetId;
  if (arrivalState !== undefined) row.arrival_state = arrivalState;
  if (benchLog !== undefined) row.bench_log = benchLog;
  if (controlUrl !== undefined) row.control_url = controlUrl;
  if (pendingHandoff !== undefined) row.pending_handoff = pendingHandoff;
  if (stallCount !== undefined) row.stall_count = stallCount;
  if (lastBitId !== undefined) row.last_bit_id = lastBitId;
  if (lastBitTurn !== undefined) row.last_bit_turn = lastBitTurn;
  if (lastBitAt !== undefined) row.last_bit_at = lastBitAt;
  if (businessLatched !== undefined) row.business_latched = businessLatched;
  if (openerOverlay !== undefined) row.opener_overlay = openerOverlay;
  if (openerOverlayContinuing !== undefined) row.opener_overlay_continuing = openerOverlayContinuing;
  if (businessOverlay !== undefined) row.business_overlay = businessOverlay;
  if (archetype !== undefined) row.archetype = archetype;
  if (characterId !== undefined) row.character_id = characterId;
  if (commitmentPush !== undefined) row.commitment_push = commitmentPush;
  if (bitFireHistory !== undefined) row.bit_fire_history = bitFireHistory;
  if (huntRungCount !== undefined) row.hunt_rung_count = huntRungCount;
  if (huntRungTurn !== undefined) row.hunt_rung_turn = huntRungTurn;
  if (lastStallResolvedTurn !== undefined) row.last_stall_resolved_turn = lastStallResolvedTurn;
  if (expertiseLevelUsed !== undefined) row.expertise_level_used = expertiseLevelUsed;
  if (pendingBenchAwareness !== undefined) row.pending_bench_awareness = pendingBenchAwareness;
  if (latestCallId !== undefined) row.latest_call_id = latestCallId;
  if (activeGeneration !== undefined) row.active_generation = activeGeneration;
  if (benchPresent !== undefined) row.bench_present = benchPresent;
  if (firstSeenAt !== undefined) row.first_seen_at = firstSeenAt;
  if (callerPresenting !== undefined) row.caller_presenting = callerPresenting;
  if (pitchSummary !== undefined) row.pitch_summary = pitchSummary;
  if (hostName !== undefined) row.host_name = hostName;
  if (recordingNoticeGiven !== undefined) row.recording_notice_given = recordingNoticeGiven;
  if (hostTurnCount !== undefined) row.host_turn_count = hostTurnCount;
  if (historyRevSeen !== undefined) row.history_rev_seen = historyRevSeen;
  if (openerServed !== undefined) row.opener_served = openerServed;
  if (callerRedirected !== undefined) row.caller_redirected = callerRedirected;
  if (callerCrude !== undefined) row.caller_crude = callerCrude;
  if (crudeImpersonalCount !== undefined) row.crude_impersonal_count = crudeImpersonalCount;
  if (crudePersonalCount !== undefined) row.crude_personal_count = crudePersonalCount;
  if (markerCounts !== undefined) row.marker_counts = markerCounts;
  if (markerLastTurn !== undefined) row.marker_last_turn = markerLastTurn;
  if (pricingRaised !== undefined) row.pricing_raised = pricingRaised;
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
      sentBench = {
        id: row.id, bench_id: p.bench_id ?? null,
        sent_turn: p.sent_turn ?? null, idem: row.idempotency_key || null,
        mode: p.mode === "takeover" ? "takeover" : "weave",
      };
    } else if (row.control_type === "force" && row.status === "pending") {
      forced = {
        id: row.id, bit_id: p.bit_id ?? null,
        forced_turn: p.forced_turn ?? null, idem: row.idempotency_key || null,
      };
    } else if (row.control_type === "absurdity_ceiling" && live(row.status)) {
      absurdityCeiling = p.ceiling ?? null;
    } else if (row.control_type === "expertise_level" && live(row.status)) {
      expertiseLevel = p.level ?? null;
    }
  }
  return { deathBlow, armed, sentBench, forced, absurdityCeiling, expertiseLevel };
}
export async function setDeathBlow(callId, { rungId, rungName, finalLine, idem, director } = {}) {
  if (!isConfigured() || !callId) throw new Error("store not configured");
  const row = {
    call_id: callId,
    control_type: "death_blow",
    rung_id: rungId ?? null,
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
  if (r.status === 409) return true;
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
  if (r.status === 409) return true;
  if (!r.ok) throw new Error(`arm set failed: ${r.status} ${await r.text()}`);
  return true;
}
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
  if (!r.ok) throw new Error(`unarm failed: ${r.status} ${await r.text()}`);
  return true;
}
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
  if (r.status === 409) return true;
  if (!r.ok) throw new Error(`force set failed: ${r.status} ${await r.text()}`);
  return true;
}
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
export async function setBench(callId, { benchId, idem, mode, director }) {
  if (!isConfigured() || !callId) throw new Error("store not configured");
  const row = {
    call_id: callId,
    control_type: "bench",
    director_user_id: director ?? null,
    idempotency_key: idem ?? null,
    status: "pending",
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
  if (r.status === 409) return true;
  if (!r.ok) throw new Error(`bench set failed: ${r.status} ${await r.text()}`);
  return true;
}
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
// CONFIRMED LIVE (2026-09-23, Andrew checked information_schema) — this
// table already exists in Supabase and already has real data (BIT-233,
// BIT-106, BIT-330 fire counts in the hundreds) — it predates this file's
// own CREATE TABLE comment further up (call_prefix's), which is why one
// never existed here. It does NOT have a created_at column yet. Migration
// to run once in the Supabase SQL editor (safe/idempotent either way):
//   alter table bit_events add column if not exists family text;
//   alter table bit_events add column if not exists lane text;
//   alter table bit_events add column if not exists archetype text;
//   alter table bit_events add column if not exists channel text;
//   alter table bit_events add column if not exists created_at timestamptz;
// One row per scored turn (the TOP-ranked candidate that turn, whether or
// not it actually fired) — `fired=true` rows are the cross-call bit-fire
// analytics Andrew asked for (2026-09-23): count/categorize which bits
// actually fired, by id, family, lane, archetype, channel, or date, across
// any number of calls, with plain SQL in the Supabase editor instead of
// hand-collecting BIT-INJECT log lines per call. Deliberately extending
// the EXISTING table rather than adding a second one — Andrew's explicit
// ask was no Supabase clutter.
export async function appendBitEvent(
  callId,
  { turn, bit_id, name, score, fit, gear_bias, recency, fired, why, family, lane, archetype, channel }
) {
  if (!isConfigured() || !callId) return false;
  const row = {
    call_id: callId, turn, bit_id, name,
    score, fit, gear_bias, recency,
    fired: !!fired, why: (why || "").slice(0, 300),
    // family/lane (2026-09-23) — denormalized registry category, so cross-
    // call analysis ("which bit categories fire too much/too little") can
    // be a plain SQL group-by in Supabase instead of cross-referencing the
    // registry JS file. null for either is a valid, expected state (not
    // every bit has a lane).
    family: family || null,
    lane: lane || null,
    // archetype/channel/created_at (2026-09-23, Andrew — "by date, by
    // channel, by archetype" combo request). Stamped explicitly here
    // (not left to a DB default) so this works the moment the columns
    // exist, regardless of whether a default was set on them.
    archetype: archetype || null,
    channel: channel || null,
    created_at: new Date().toISOString(),
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
export async function saveTranscript(callId, slug, messages) {
  if (!isConfigured() || !callId || !Array.isArray(messages)) return false;
  const convo = messages.filter((m) => m && m.role !== "system");
  if (!convo.length) return false;
  let storedMessages = [];
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
      storedMessages =
        Array.isArray(rows) && rows[0] && Array.isArray(rows[0].messages)
          ? rows[0].messages
          : [];
      if (storedMessages.length > convo.length) return true;
    }
  } catch {
    /* read failed — fall through and write; storedMessages stays [] */
  }
  const nowIso = new Date().toISOString();
  const stamped = convo.map((m, i) => {
    const prior = storedMessages[i];
    const reuseTs = prior && prior.role === m.role && prior.timestamp;
    return { ...m, timestamp: reuseTs || nowIso };
  });
  const row = {
    call_id: callId,
    slug: slug || null,
    messages: stamped,
    updated_at: nowIso,
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
  recordingUrl,
  recordingDurationSeconds,
  recordingStatus,
}) {
  if (!isConfigured()) throw new Error("store not configured");
  if (!targetId) throw new Error("target_id required");
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
  // recording_url and recording_status are NOT columns on `calls` (confirmed
  // against Data's information_schema paste) — removed 2026-09-22 after
  // Recording found every web close was 500ing because of this.
  // recording_duration_sec DOES exist and stays.
  if (recordingDurationSeconds !== undefined) row.recording_duration_sec = recordingDurationSeconds;
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

export async function updateCallDisposition(vapiCallId, { disposition, threatTarget } = {}) {
  if (!isConfigured() || !vapiCallId) return false;
  const row = {};
  if (disposition !== undefined) row.disposition = disposition;
  if (threatTarget !== undefined) row.threat_target = threatTarget;
  if (!Object.keys(row).length) return false;
  const r = await fetch(
    `${URL}/rest/v1/${CALLS}?vapi_call_id=eq.${encodeURIComponent(vapiCallId)}`,
    {
      cache: "no-store",
      method: "PATCH",
      headers: {
        apikey: KEY, authorization: `Bearer ${KEY}`,
        "content-type": "application/json", prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    }
  );
  if (!r.ok) throw new Error(`calls disposition update failed: ${r.status} ${await r.text()}`);
  return true;
}

export async function cancelForce(callId, { bitId } = {}) {
  if (!isConfigured() || !callId) throw new Error("store not configured");
  let q =
    `${URL}/rest/v1/${CONTROLS}` +
    `?call_id=eq.${encodeURIComponent(callId)}` +
    `&control_type=eq.force` +
    `&status=eq.pending`;
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

export async function upsertRecording({ slug, recordingUrl, durationSec, status, userId }) {
  if (!isConfigured()) throw new Error("store not configured");
  if (!slug) throw new Error("slug required");
  const channel = /^(ph-|in-)/.test(String(slug)) ? "phone" : "web";
  const row = { slug, channel };
  if (recordingUrl !== undefined) row.recording_url = recordingUrl;
  if (durationSec !== undefined) row.duration_sec = durationSec;
  if (status !== undefined) row.status = status;
  if (userId !== undefined) row.user_id = userId;
  const r = await fetch(`${URL}/rest/v1/recordings?on_conflict=slug`, {
    cache: "no-store",
    method: "POST",
    headers: {
      apikey: KEY, authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`upsertRecording failed: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function getCallbackJobOwner(jobId) {
  if (!isConfigured() || !jobId) return null;
  const r = await fetch(
    `${URL}/rest/v1/callback_jobs?id=eq.${encodeURIComponent(jobId)}&select=user_id&limit=1`,
    { cache: "no-store", headers: { apikey: KEY, authorization: `Bearer ${KEY}` } }
  );
  if (!r.ok) {
    console.log("getCallbackJobOwner: non-ok response for jobId=" + jobId + ": " + r.status);
    return null;
  }
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) && rows[0] && rows[0].user_id ? rows[0].user_id : null;
}

export async function getHouseCallMatchedJobId(houseCallId) {
  if (!isConfigured() || !houseCallId) return null;
  const r = await fetch(
    `${URL}/rest/v1/house_calls?id=eq.${encodeURIComponent(houseCallId)}&select=matched_job_id&limit=1`,
    { cache: "no-store", headers: { apikey: KEY, authorization: `Bearer ${KEY}` } }
  );
  if (!r.ok) {
    console.log("getHouseCallMatchedJobId: non-ok response for houseCallId=" + houseCallId + ": " + r.status);
    return null;
  }
  const rows = await r.json().catch(() => null);
  return Array.isArray(rows) && rows[0] ? rows[0].matched_job_id || null : null;
}

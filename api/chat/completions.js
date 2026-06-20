// SpamViking — Posture Engine
// PHASE 1: DUMB PROXY
//
// Sits between Vapi and Claude as an OpenAI-compatible /chat/completions
// endpoint. Vapi POSTs the conversation every turn (OpenAI format); we
// forward it to Anthropic's Messages API with streaming, translate the
// Anthropic SSE stream into OpenAI-style SSE deltas, and stream it back.
//
// Goal of this phase: the call sounds IDENTICAL to today, but the brain
// is now ours. No posture, no store, no rules yet — that's Phase 2+.
//
// THE INVARIANT (carried from the BUILD plan): the voice never waits on a
// slow decision. The only LLM the speech path awaits is this Host line.
// Phase 4's Governor will run via waitUntil() (see note at bottom) so it
// never blocks this stream.

export const config = { runtime: "edge" };

import { getCall, setCall, isConfigured, appendGearEvent, appendBitEvent, clearDeathBlow, getControls, stampArm, fireArm } from "../_store.js";
import { applyForceAll, postureBlock, defaultState, detectAccusation } from "../_gears.js";
import { selectBit, rankBits } from "../_bits.js";
import { archetypeFromBody } from "../_archetype.js";
import { readAmmunition } from "../_read.js";
import { benchInject, BENCH } from "../_bench.js";
import { makeTrace, blowLandedTotal, bitFireCount } from "../_trace.js";
import { BITS } from "../_bits_registry.js";
import { waitUntil } from "@vercel/functions";
const HOST_NAME = process.env.HOST_NAME || "Andrew";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Set ANTHROPIC_MODEL in Vercel to match (or beat) whatever the Vapi
// assistant uses today. Haiku is the low-latency default for voice; bump
// to a Sonnet if the bait character needs more wit and the latency holds.
const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const MAX_TOKENS = () => parseInt(process.env.MAX_TOKENS || "1024", 10);

// Generate a bench character's barge-in line, in character, reacting to the
// live call. Fast non-streaming Haiku call (short cap). Returns the spoken line
// or null (caller falls back to a canned line). Fired in PARALLEL with the host
// reply so it adds ~no latency — it's awaited only at stream close.
async function generateBenchLine(bench, messages) {
  try {
    const convo = messages
      .slice(-6)
      .map((m) => (m.role === "user" ? "Caller: " : "Host: ") + m.content)
      .join("\n");
    const name = bench.tag.charAt(0) + bench.tag.slice(1).toLowerCase();
    const sys =
      "You are " + name + ", " + bench.note + ". You have just barged into this " +
      "live call, cutting the host off mid-sentence. Say ONE short spoken line " +
      "(max ~25 words), blunt and fully in character, reacting to what is being " +
      "discussed. Output ONLY the spoken words — no name label, no quotes, no " +
      "stage directions.";
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: MODEL(),
        max_tokens: 80,
        system: sys,
        messages: [{ role: "user", content: convo + "\n\n(" + name + " cuts in:)" }],
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const txt = (j.content || []).map((c) => c.text || "").join("").trim();
    if (!txt || txt.length > 240) return null;
    return txt;
  } catch {
    return null;
  }
}

// Bit injection tuning (starting values — tune from real calls / DEC-2).
// In the flat-fit era (all bits universal, no archetype yet) scores cluster
// low, so the bar is modest and the gap keeps Andrew from spamming beats.
const INJECT_BAR = parseFloat(process.env.INJECT_BAR || "3.0");
const MIN_GAP = parseInt(process.env.MIN_GAP || "3", 10);
// PHASE: warm up before throwing any bit, then get mildly more willing to fire
// as the call goes (they're invested — swing a little more).
const WARMUP_TURNS = parseInt(process.env.WARMUP_TURNS || "2", 10);
function effectiveBar(turn) {
  if (turn <= WARMUP_TURNS) return Infinity; // no bits during warm-up
  return Math.max(INJECT_BAR - 0.1 * Math.max(0, turn - 6), INJECT_BAR - 1);
}

export default async function handler(req) {
  // Browser health check — hit the URL to confirm the deploy is live.
  if (req.method === "GET") {
    return json({ ok: true, service: "posture-engine", phase: 1 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // Optional shared secret. If PROXY_SHARED_SECRET is set, Vapi must send
  // it as `Authorization: Bearer <secret>`. Leave unset to skip auth while
  // first wiring things up.
  const secret = process.env.PROXY_SHARED_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${secret}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const { system: vapiSystem, messages } = splitMessages(body.messages || []);

  // BENCH: decide if a character barges in THIS turn. If so, the engine appends
  // their tagged line to the stream itself (the model won't emit the tag, so we
  // guarantee it). The line is generated in character from the live call, in
  // PARALLEL with the host reply, and only awaited when the stream closes — so
  // it costs ~no latency. Falls back to a canned line if generation fails.
  const benchTurn = countUserTurns(messages);
  const bench = benchInject(benchTurn);
  const benchAppend = bench
    ? generateBenchLine(bench, messages)
        .then((line) => "\n\n[[" + bench.tag + "]] " + (line || bench.line))
        .catch(() => "\n\n[[" + bench.tag + "]] " + bench.line)
    : null;
  if (bench) console.log("bench inject=" + bench.tag + " turn=" + benchTurn);

  // PRE-SNAP PREFIX: if a frozen prefix was assembled for this call at
  // pre-snap (POST /api/presnap) and stored, use it as the cached block and
  // the stored posture line as the mutable block. This is the ONE sanctioned
  // hot-path read (a single indexed row, NOT an LLM call). If there's no
  // stored prefix, fall back to Vapi's raw system prompt (Phase 1 behavior),
  // so nothing breaks before pre-snap is wired into the Mead Hall.
  const callId = body.call?.id ?? body.metadata?.callId ?? body.call_id;
  if (bench && callId) {
    makeTrace(callId, benchTurn, waitUntil).emit(
      "bench_joined",
      { character_id: bench.tag, name: bench.tag, role: bench.note, joined_at: new Date().toISOString() },
      "bench"
    );
  }

  const slug = body.call?.metadata?.slug ?? body.metadata?.slug ?? null;
  let stored = null;
  let ammo = { ammunition: [], byHook: {} };
  let controls = { deathBlow: null, armed: [] };
  try {
    const [s, a, ctl] = await Promise.all([
      getCall(callId).catch(() => null),
      readAmmunition(slug).catch(() => ({ ammunition: [], byHook: {} })),
      getControls(callId).catch(() => ({ deathBlow: null, armed: [] })),
    ]);
    stored = s;
    if (a) ammo = a;
    if (ctl) controls = ctl;
  } catch {
    stored = null;
  }

  // Base system: the assembled prefix if one was frozen at pre-snap, else
  // Vapi's own prompt (Stage 1/2 — keeps Andrew sounding exactly as he is).
  // The doubt-gears layer on top of whichever base is in play.
  const baseSystem = stored && stored.prefix ? stored.prefix : vapiSystem;
  const systemBlocks = baseSystem
    ? buildSystemBlocks(baseSystem, stored, messages, callId, body, ammo, controls)
    : null;

  const anthropicReq = {
    model: MODEL(),
    max_tokens: MAX_TOKENS(),
    stream: true,
    messages,
    ...(systemBlocks ? { system: systemBlocks } : {}),
  };

  const upstream = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(anthropicReq),
  });

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    return new Response(`Upstream error ${upstream.status}: ${errText}`, {
      status: 502,
    });
  }

  const meta = {
    id: "chatcmpl-" + crypto.randomUUID(),
    created: Math.floor(Date.now() / 1000),
    model: MODEL(),
    callId,
    turn: countUserTurns(messages),
  };

  return new Response(anthropicToOpenAISSE(upstream.body, meta, benchAppend), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

// --- message mapping -------------------------------------------------------
// OpenAI messages -> Anthropic shape. Anthropic wants `system` as a separate
// top-level string, messages limited to user/assistant, starting with user,
// with no two consecutive same-role turns.
// --- gears / posture (Phase 3 FORCE-SET, three axes) ----------------------
// Build the system blocks for the call:
//   [0] the base prompt (Vapi's, or an assembled prefix) — cached
//   [1] the MUTABLE posture block — three gear lines (suspicion / pressure /
//       engagement), the only thing that changes turn to turn.
// The gear layer runs only when the store is configured (so we can track the
// gears per call). FORCE-SET runs over the latest caller line, moves any of
// the three dials for THIS turn, and persists the new state for NEXT turn off
// the hot path (waitUntil) so the voice never waits on the write. The row is
// created lazily on the first turn — no pre-snap call needed for gears.
// factHint: turn the scouted payload(s) for a firing fueled bit into a short,
// speakable fact string, so the host can quote the REAL detail. Skips keys that
// aren't meant to be said aloud (urls, ids, scores, provenance/basis).
const NON_SPEAKABLE = /(^url$|_url$|ref$|source$|^basis$|slug$|_id$|^id$|score$)/i;
function factHint(bit, byHook) {
  const facts = [];
  for (const h of bit.fuel_hooks || []) {
    const p = byHook && byHook[h];
    if (!p || typeof p !== "object") continue;
    const pairs = Object.entries(p)
      .filter(([k, v]) => v != null && v !== "" && !NON_SPEAKABLE.test(k))
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
      .join("; ");
    if (pairs) facts.push(pairs);
  }
  return facts.join(" | ");
}

function buildSystemBlocks(baseSystem, stored, messages, callId, body, ammo, controls) {
  ammo = ammo || { ammunition: [], byHook: {} };
  const blocks = [
    { type: "text", text: baseSystem, cache_control: { type: "ephemeral" } },
  ];
  if (isConfigured() && callId) {
    const current = stored
      ? {
          suspicion: stored.gear,
          pressure: stored.pressure,
          engagement: stored.engagement,
          slip: stored.slip,
        }
      : defaultState();
    const { state, changes, dirty } = applyForceAll(
      current,
      lastUserText(messages)
    );

    const accusation = detectAccusation(lastUserText(messages));
    const turn = countUserTurns(messages);

    // --- MEAD HALL TRACE (dark unless TRACE_ENABLED=1) ---------------------
    const trace = makeTrace(callId, turn, waitUntil);
    // Death Blow (Trigger A) pending, read from call_controls concurrently with
    // getCall. Only act on a PENDING row (fired/cleared are history).
    const dbCtl = controls && controls.deathBlow;
    const deathBlow =
      dbCtl && dbCtl.status === "pending" && dbCtl.rung_id
        ? {
            rung_id: dbCtl.rung_id,
            name: dbCtl.rung_name || dbCtl.rung_id,
            line: dbCtl.final_line || "",
          }
        : null;
    if (!stored) {
      trace.emit(
        "call_started",
        {
          host_name: HOST_NAME,
          character_id: "host",
          universe: null,
          archetype: archetypeFromBody(body) || "universal",
          slot_time: null,
          started_at: new Date().toISOString(),
          // every bit, with the two fields Mead Hall's arm gray-out needs:
          // fuel_hooks (gray if a required hook isn't in the rack) and status
          // (gray if parked). Parked bits are INCLUDED now so the UI can show
          // them grayed rather than silently absent.
          loadout: BITS.map((b) => ({
            bit_id: b.id,
            name: b.name,
            bit_type: b.bit_type || b.type || null,
            fuel_hooks: b.fuel_hooks || [],
            status: b.status || "active",
          })),
          ammunition: ammo.ammunition || [], // scout_hooks rack (empty = safe default)
          bench_available: Object.keys(BENCH).map((k) => ({
            character_id: BENCH[k].tag, name: BENCH[k].tag, role: BENCH[k].note,
          })),
        },
        "engine"
      );
    }
    trace.emit(
      "utterance",
      { speaker_role: "spammer", speaker_name: null, character_id: null, text: lastUserText(messages), turn_index: turn },
      "spammer"
    );
    if (accusation) trace.emit("spammer_reaction", { reaction_type: "suspicious", turn_index: turn }, "spammer");

    // --- FIT: rank the bits for THIS moment (pure in-memory math) ----------
    // archetype is "universal" until the Archetype layer wires real types, so
    // fit currently discriminates on accusation + gear_bias. recency comes from
    // the last bit we fired (read in the same call_prefix lookup, no extra hop).
    const recency =
      stored && stored.lastBitId && stored.lastBitTurn != null
        ? { [stored.lastBitId]: Math.max(0, turn - stored.lastBitTurn) }
        : {};
    // sticky if already hydrated; else from this request's metadata; else flat.
    const archetype =
      (stored && stored.archetype) || archetypeFromBody(body) || "universal";
    const archetypeNew =
      archetype !== "universal" && (!stored || stored.archetype !== archetype);

    // fuel: hooks Scouting populated for this call -> "populated" status so
    // fueled bits become available; byHook carries the fact a firing bit pulls.
    const fuel_hooks_status = {};
    for (const h of Object.keys(ammo.byHook || {})) fuel_hooks_status[h] = "populated";

    // ARM (learning phase): the Director's setlist, read from call_controls
    // concurrently with getCall. Stamp armed_turn on first sight (escalation
    // clock) by patching the control row; build the bit boost map (bit_id ->
    // turns waited) the scorer uses to raise armed bits.
    const armedList = controls && Array.isArray(controls.armed) ? controls.armed.map((a) => ({ ...a })) : [];
    const armedBits = {};
    for (const a of armedList) {
      if (a.armed_turn == null) {
        a.armed_turn = turn;
        waitUntil(stampArm(a.id, { bit_id: a.bit_id, hook_id: a.hook_id, armed_turn: turn }).catch(() => {}));
      }
      if (a.bit_id) armedBits[a.bit_id] = Math.max(0, turn - a.armed_turn);
    }

    const scorerState = {
      archetype,
      accusation,
      armed: armedBits,
      gears: {
        suspicion: state.suspicion,
        pressure: state.pressure,
        engagement: state.engagement,
      },
      recency,
      fuel_hooks_status,
      byHook: ammo.byHook || {},
      // sequencing anchor — without this, chain + category spacing never fire.
      lastBitId: stored ? stored.lastBitId || null : null,
    };
    // LOADOUT then rank: selectBit narrows to the bits that fit this moment,
    // then ranks that focused set (not all 71). threshold:0 so we apply our own
    // INJECT_BAR below; we just want the ranked loadout + its size.
    const sel = selectBit(scorerState, { threshold: 0 });
    const ranked = sel.ranked;
    const top = ranked[0] || null;
    const poolSize = sel.pool;
    const gap = stored && stored.lastBitTurn != null ? turn - stored.lastBitTurn : 99;
    const bar = effectiveBar(turn);
    const fire = !!(top && top.score >= bar && gap >= MIN_GAP);

    // ARM resolution: reconcile the setlist with this turn's outcome. Each arm is
    // its own call_controls row, so closing one = fireArm(id) (status -> fired).
    //  - bare fact-arm (hook only): inject its real fact this turn, then close.
    //  - bit-arm that fired this turn: mark trigger "armed", pull its fact, close.
    //  - everything else: leave the row pending (no drop except at call end).
    //    Escalation (in the scorer) guarantees an armed bit eventually wins a spot.
    let firedArmedBit = false;
    let armedHookFact = null;
    for (const a of armedList) {
      const hookFact = (a.hook_id && ammo.byHook && ammo.byHook[a.hook_id])
        ? factHint({ fuel_hooks: [a.hook_id] }, ammo.byHook) : null;
      if (a.hook_id && !a.bit_id) {
        if (hookFact) {
          armedHookFact = armedHookFact ? armedHookFact + " | " + hookFact : hookFact;
          waitUntil(fireArm(a.id).catch(() => {}));
        }
        continue; // no scout data yet -> leave pending, don't close
      }
      if (a.bit_id && fire && top && top.id === a.bit_id) {
        firedArmedBit = true;
        if (hookFact) armedHookFact = armedHookFact ? armedHookFact + " | " + hookFact : hookFact;
        waitUntil(fireArm(a.id).catch(() => {}));
        continue; // fired -> close
      }
      // else: still waiting -> leave the row pending.
    }

    // MUTABLE block: posture lines + (on fire) a gentle in-character bit cue.
    // Goes AFTER the cached base, so injecting never busts the prompt cache.
    let mutable = postureBlock(state);
    if (deathBlow) {
      mutable +=
        "\n\nDEATH BLOW — this is your final line. Deliver it, then end the call:\n" +
        (deathBlow.line || "End the call now — firm, final, done.");
      const nowIso = new Date().toISOString();
      trace.emit("blow_armed", { rung_id: deathBlow.rung_id, name: deathBlow.name, armed_at: nowIso }, "director");
      trace.emit("blow_fired", { rung_id: deathBlow.rung_id, name: deathBlow.name, fired_at: nowIso, final_line: deathBlow.line || null }, "host");
      trace.emit(
        "call_ended",
        { ended_at: nowIso, ending_type: "death_blow", finishing_rung_id: deathBlow.rung_id, duration_seconds: null, blows_landed: null, heads_mustered: null, peak_their_side: null, peak_our_side: null },
        "engine"
      );
      waitUntil(clearDeathBlow(callId, "fired").catch(() => {}));
    } else if (fire) {
      mutable +=
        '\n\nIMPROV BEAT — work the bit "' + top.name +
        '" into your next line ONLY if it lands naturally. ' +
        "Never name it; never break character.";
      // If this bit is fueled, hand the host the REAL scouted fact to weave in.
      const fact = factHint(top, scorerState.byHook);
      if (fact) {
        mutable +=
          "\n\nYou happen to know this about them: " + fact +
          ". Weave that specific detail in naturally if you use the bit — " +
          "quote the real fact, never invent one.";
      }
      const bitBase = {
        bit_id: top.id,
        name: top.name,
        bit_type: top.bit_type || top.type || null,
        trigger: firedArmedBit ? "armed" : "auto",
        turn_index: turn,
      };
      if (top.bit_type === "count") {
        // count bit: PE owns the running tally. count_label is static on the bit;
        // running_total = prior fires (off the event log) + this one.
        waitUntil(
          (async () => {
            const prior = await bitFireCount(callId, top.id);
            trace.emit(
              "bit_deployed",
              { ...bitBase, count_label: top.count_label || null, running_total: prior == null ? null : prior + 1 },
              "engine"
            );
          })()
        );
      } else {
        trace.emit("bit_deployed", bitBase, "engine");
      }
    }

    // Director-armed fact (forced via the setlist): weave the real detail in even
    // if no bit pulled it this turn. Soft cue — host uses it if it fits.
    if (armedHookFact) {
      mutable +=
        "\n\nALSO — if it fits naturally, work in this real detail about them: " +
        armedHookFact + ". Quote the real fact, never invent one.";
    }

    blocks.push({ type: "text", text: mutable });

    // VISIBILITY: gears + the fit read, every turn, watchable in Vercel logs.
    const trail =
      (changes.length
        ? "  <- " + changes.map((c) => `${c.axis}:${c.from}->${c.to}`).join(", ")
        : "") + (accusation ? "  accuse:" + accusation : "");
    console.log("gears " + JSON.stringify(state) + trail);
    const suspicionChanges = changes.filter((c) => c.axis === "suspicion");
    if (suspicionChanges.length) {
      // rung_fit: fit-ranked death-blow rungs for THIS moment, so Mead Hall
      // never re-derives the ranking (same scorer, deathBlow pool).
      const rungFit = rankBits(scorerState, { deathBlow: true }).map((r) => ({
        rung_id: r.id, name: r.name, fit: +Number(r.score).toFixed(2),
      }));
      suspicionChanges.forEach((c) => {
        trace.emit(
          "gear_transition",
          { from_state: String(c.from).toUpperCase(), to_state: String(c.to).toUpperCase(), rung_fit: rungFit },
          "engine"
        );
      });
    }

    // blow_landed (clean hit): the bit thrown LAST turn made them MORE engaged
    // THIS turn — it connected. One event per landing (count ticks live on
    // bit_deployed, not here). total_blows is read off the event log, so no new
    // column is needed. Emitted on the shared trace (correct seq lane), off the
    // hot path.
    const ENG_RANK = { bored: 0, hooked: 1, stunned: 2 };
    const firedLastTurn =
      stored && stored.lastBitTurn != null && stored.lastBitTurn === turn - 1;
    const engagementRose = changes.some(
      (c) => c.axis === "engagement" && ENG_RANK[c.to] > ENG_RANK[c.from]
    );
    if (firedLastTurn && engagementRose) {
      waitUntil(
        (async () => {
          const prior = await blowLandedTotal(callId);
          trace.emit(
            "blow_landed",
            { turn_index: turn, total_blows: prior == null ? null : prior + 1 },
            "engine"
          );
        })()
      );
    }
    if (top) {
      console.log(
        "fit " +
          JSON.stringify({
            pick: top.name,
            arch: archetype,
            score: +top.score.toFixed(2),
            fired: fire,
            gap,
            bar: turn <= WARMUP_TURNS ? "warmup" : +bar.toFixed(2),
            pool: poolSize,
            top3: ranked.slice(0, 3).map((r) => r.name + ":" + r.score.toFixed(1)),
          })
      );
    }

    // SNAPSHOT: persist gears (+ the fired bit, for recency/pacing next turn).
    if (dirty || !stored || fire || archetypeNew) {
      waitUntil(
        setCall(callId, {
          gear: state.suspicion,
          pressure: state.pressure,
          engagement: state.engagement,
          slip: state.slip,
          ...(fire ? { lastBitId: top.id, lastBitTurn: turn } : {}),
          ...(archetypeNew ? { archetype } : {}),
        }).catch(() => {})
      ); // never awaited
    }

    // HISTORY: the gear trace + the fit trace, both off the hot path.
    waitUntil(
      appendGearEvent(callId, {
        turn,
        suspicion: state.suspicion,
        pressure: state.pressure,
        engagement: state.engagement,
        slip: state.slip,
        accusation,
        utterance: lastUserText(messages),
      }).catch(() => {})
    );
    if (top) {
      waitUntil(
        appendBitEvent(callId, {
          turn,
          bit_id: top.id,
          name: top.name,
          score: top.score,
          fit: top.breakdown.fit,
          gear_bias: top.breakdown.gearBias,
          recency: top.breakdown.recency,
          fired: fire,
          why: (top.breakdown.why || []).join("; "),
        }).catch(() => {})
      );
    }
  }
  return blocks;
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return extractText(messages[i].content);
  }
  return "";
}

// Turn index for gear_events: how many caller turns we've seen so far.
function countUserTurns(messages) {
  return messages.filter((m) => m.role === "user").length;
}

function splitMessages(openaiMessages) {
  const systemParts = [];
  const mapped = [];

  for (const m of openaiMessages) {
    const text = extractText(m.content);
    if (m.role === "system") {
      if (text) systemParts.push(text);
      continue;
    }
    // tool / function / anything-else collapses to user for Phase 1.
    const role = m.role === "assistant" ? "assistant" : "user";
    mapped.push({ role, content: text });
  }

  // Anthropic requires the first message to be `user`.
  while (mapped.length && mapped[0].role !== "user") mapped.shift();

  // Merge consecutive same-role turns.
  const merged = [];
  for (const m of mapped) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += "\n" + m.content;
    else merged.push({ role: m.role, content: m.content });
  }

  // Never send an empty conversation (Anthropic would 400).
  if (merged.length === 0) {
    merged.push({ role: "user", content: "(call connected)" });
  }

  return { system: systemParts.join("\n\n"), messages: merged };
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "string" ? p : p.text || ""))
      .join("");
  }
  return "";
}

// --- stream translation ----------------------------------------------------
// Anthropic SSE  ->  OpenAI chat.completion.chunk SSE.
// We only care about three Anthropic event types: message_start (emit the
// opening role delta), content_block_delta/text_delta (emit content), and
// message_stop (emit finish_reason + [DONE]). Everything else (ping,
// content_block_start/stop, message_delta) is ignored.
function anthropicToOpenAISSE(anthropicBody, meta, appendText) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const chunkStr = (delta, finish_reason = null) =>
    "data: " +
    JSON.stringify({
      id: meta.id,
      object: "chat.completion.chunk",
      created: meta.created,
      model: meta.model,
      choices: [{ index: 0, delta, finish_reason }],
    }) +
    "\n\n";

  return new ReadableStream({
    async start(controller) {
      const reader = anthropicBody.getReader();
      let buffer = "";
      let roleSent = false;
      let finished = false;
      let appendSent = false;
      let hostText = "";
      // utterance emitter: turn+0.5 so the host line sorts after this turn's
      // analysis events but before the next turn — no seq collision.
      const utterTrace =
        meta.callId != null ? makeTrace(meta.callId, (Number(meta.turn) || 0) + 0.5, null) : null;

      const send = (delta, finish_reason = null) =>
        controller.enqueue(encoder.encode(chunkStr(delta, finish_reason)));
      const done = () =>
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));

      // Close out the turn: if the engine has a bench line to inject, await it
      // (it was generated in parallel and is usually ready), emit it as a final
      // tagged content delta, THEN finish. Guarantees the [[NAME]] marker
      // reaches Vapi/TTS regardless of what the model wrote.
      const finishUp = async () => {
        let benchTxt = null;
        if (appendText && !appendSent) {
          appendSent = true;
          try { benchTxt = await appendText; } catch { benchTxt = null; }
          if (benchTxt) {
            if (!roleSent) { send({ role: "assistant" }); roleSent = true; }
            send({ content: benchTxt });
          }
        }
        // utterances, in spoken order: host first, then any bench interjection.
        if (utterTrace) {
          const clean = hostText.replace(/\[\[[^\]]*\]\]/g, "").trim();
          if (clean) {
            utterTrace.emit(
              "utterance",
              { speaker_role: "host", speaker_name: HOST_NAME, character_id: "host", text: clean, turn_index: meta.turn },
              "host"
            );
          }
          if (benchTxt) {
            const mm = String(benchTxt).match(/\[\[([^\]]+)\]\]\s*([\s\S]*)/);
            if (mm && mm[2].trim()) {
              utterTrace.emit(
                "utterance",
                { speaker_role: "bench", speaker_name: mm[1], character_id: mm[1], text: mm[2].trim(), turn_index: meta.turn },
                "bench"
              );
            }
          }
        }
        send({}, "stop");
        done();
      };

      try {
        while (true) {
          const { done: streamDone, value } = await reader.read();
          if (streamDone) break;
          buffer += decoder.decode(value, { stream: true });

          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);

            const dataLine = rawEvent
              .split("\n")
              .find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            const payload = dataLine.slice(5).trim();
            if (!payload) continue;

            let p;
            try {
              p = JSON.parse(payload);
            } catch {
              continue;
            }

            if (p.type === "message_start") {
              // MEASURE: usage on message_start carries cache stats. Logged
              // so Vercel logs prove caching on the real proxy path —
              // cache_read_input_tokens should be ~0 on a call's first turn
              // (cache created) and large on every turn after (cache hit).
              const u = p.message?.usage;
              if (u) {
                console.log(
                  "cache " +
                    JSON.stringify({
                      input: u.input_tokens,
                      cache_creation: u.cache_creation_input_tokens,
                      cache_read: u.cache_read_input_tokens,
                    })
                );
              }
              if (!roleSent) {
                send({ role: "assistant" });
                roleSent = true;
              }
            } else if (
              p.type === "content_block_delta" &&
              p.delta?.type === "text_delta"
            ) {
              if (p.delta.text) { hostText += p.delta.text; send({ content: p.delta.text }); }
            } else if (p.type === "message_stop" || p.type === "error") {
              await finishUp();
              finished = true;
              break;
            }
          }
          if (finished) break;
        }

        // Stream ended without an explicit message_stop — close cleanly.
        if (!finished) {
          await finishUp();
        }
      } catch {
        try {
          await finishUp();
        } catch {
          /* controller already closed */
        }
      } finally {
        controller.close();
      }
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// --- PHASE 4 PREVIEW (not wired yet) --------------------------------------
// The Governor will run as a background task that NEVER blocks this stream.
// On Vercel, import { waitUntil } from "@vercel/functions" and wrap the
// async Governor call in waitUntil(...) so it runs after the voice already
// has its line. Last write wins; no version guard (locked decision).

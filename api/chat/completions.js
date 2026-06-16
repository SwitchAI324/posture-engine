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

import { getCall, setCall, isConfigured, appendGearEvent, appendBitEvent } from "../_store.js";
import { applyForceAll, postureBlock, defaultState, detectAccusation } from "../_gears.js";
import { selectBit } from "../_bits.js";
import { archetypeFromBody } from "../_archetype.js";
import { waitUntil } from "@vercel/functions";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// Set ANTHROPIC_MODEL in Vercel to match (or beat) whatever the Vapi
// assistant uses today. Haiku is the low-latency default for voice; bump
// to a Sonnet if the bait character needs more wit and the latency holds.
const MODEL = () => process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const MAX_TOKENS = () => parseInt(process.env.MAX_TOKENS || "1024", 10);

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

  // PRE-SNAP PREFIX: if a frozen prefix was assembled for this call at
  // pre-snap (POST /api/presnap) and stored, use it as the cached block and
  // the stored posture line as the mutable block. This is the ONE sanctioned
  // hot-path read (a single indexed row, NOT an LLM call). If there's no
  // stored prefix, fall back to Vapi's raw system prompt (Phase 1 behavior),
  // so nothing breaks before pre-snap is wired into the Mead Hall.
  const callId = body.call?.id ?? body.metadata?.callId ?? body.call_id;

  let stored = null;
  try {
    stored = await getCall(callId);
  } catch {
    stored = null;
  }

  // Base system: the assembled prefix if one was frozen at pre-snap, else
  // Vapi's own prompt (Stage 1/2 — keeps Andrew sounding exactly as he is).
  // The doubt-gears layer on top of whichever base is in play.
  const baseSystem = stored && stored.prefix ? stored.prefix : vapiSystem;
  const systemBlocks = baseSystem
    ? buildSystemBlocks(baseSystem, stored, messages, callId, body)
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
  };

  return new Response(anthropicToOpenAISSE(upstream.body, meta), {
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
function buildSystemBlocks(baseSystem, stored, messages, callId, body) {
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

    const scorerState = {
      archetype,
      accusation,
      gears: {
        suspicion: state.suspicion,
        pressure: state.pressure,
        engagement: state.engagement,
      },
      recency,
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

    // MUTABLE block: posture lines + (on fire) a gentle in-character bit cue.
    // Goes AFTER the cached base, so injecting never busts the prompt cache.
    let mutable = postureBlock(state);
    if (fire) {
      mutable +=
        '\n\nIMPROV BEAT — work the bit "' + top.name +
        '" into your next line ONLY if it lands naturally. ' +
        "Never name it; never break character.";
    }
    blocks.push({ type: "text", text: mutable });

    // VISIBILITY: gears + the fit read, every turn, watchable in Vercel logs.
    const trail =
      (changes.length
        ? "  <- " + changes.map((c) => `${c.axis}:${c.from}->${c.to}`).join(", ")
        : "") + (accusation ? "  accuse:" + accusation : "");
    console.log("gears " + JSON.stringify(state) + trail);
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
function anthropicToOpenAISSE(anthropicBody, meta) {
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

      const send = (delta, finish_reason = null) =>
        controller.enqueue(encoder.encode(chunkStr(delta, finish_reason)));
      const done = () =>
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));

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
              if (p.delta.text) send({ content: p.delta.text });
            } else if (p.type === "message_stop" || p.type === "error") {
              send({}, "stop");
              done();
              finished = true;
              break;
            }
          }
          if (finished) break;
        }

        // Stream ended without an explicit message_stop — close cleanly.
        if (!finished) {
          send({}, "stop");
          done();
        }
      } catch {
        try {
          send({}, "stop");
          done();
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

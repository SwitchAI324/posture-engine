// SpamViking — custom TTS proxy (multi-voice: host + bench in one call).
// ----------------------------------------------------------------------
// Vapi's voice provider points here. Per spoken chunk, Vapi POSTs:
//   { message: { type:"voice-request", text, sampleRate, ... } }
// We split the text on [[SPEAKER]] markers into ordered segments and render
// each in that character's ElevenLabs voice, as raw 16-bit mono PCM at the
// requested sample rate (Vapi's required format).
//
// Single-speaker chunk (the common case) -> stream ElevenLabs straight through
// (fast path, unchanged). A chunk that spans a speaker change -> render each
// segment and concatenate the PCM, so the voice switches mid-turn correctly.
//
// Unmarked text -> host voice. The engine emits [[CONRAD]] etc. when the bench
// speaks; this is what gives each character its own voice with no squad handoff.
//
// Env: ELEVENLABS_API_KEY (req), ELEVENLABS_MODEL (opt), VAPI_TTS_SECRET (opt),
// VOICE_<NAME> (opt per-voice overrides).
// ----------------------------------------------------------------------

import { parseSegments, voiceFor } from "./_voices.js";

export const config = { runtime: "edge" };

const EL_KEY = process.env.ELEVENLABS_API_KEY;
const EL_MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
const TTS_SECRET = process.env.VAPI_TTS_SECRET || "";

const RATE_FMT = {
  16000: "pcm_16000",
  22050: "pcm_22050",
  24000: "pcm_24000",
  44100: "pcm_44100",
};

function err(status, msg) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Optional voice tuning from env — only applied if set, so default behavior
// (the current good sound) is untouched. Tune these live in /api/soundboard.
function voiceSettings() {
  const s = {};
  if (process.env.VOICE_STABILITY) s.stability = parseFloat(process.env.VOICE_STABILITY);
  if (process.env.VOICE_SIMILARITY) s.similarity_boost = parseFloat(process.env.VOICE_SIMILARITY);
  if (process.env.VOICE_STYLE) s.style = parseFloat(process.env.VOICE_STYLE);
  if (process.env.VOICE_SPEAKER_BOOST) s.use_speaker_boost = process.env.VOICE_SPEAKER_BOOST === "true";
  return Object.keys(s).length ? s : null;
}

function elFetch(voiceId, text, fmt) {
  const vs = voiceSettings();
  const body = { text, model_id: EL_MODEL };
  if (vs) body.voice_settings = vs;
  return fetch(
    "https://api.elevenlabs.io/v1/text-to-speech/" + voiceId + "/stream?output_format=" + fmt,
    {
      method: "POST",
      headers: { "xi-api-key": EL_KEY, "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

export default async function handler(req) {
  if (req.method !== "POST") return err(405, "POST only");

  if (TTS_SECRET) {
    const got =
      req.headers.get("x-vapi-secret") ||
      req.headers.get("x-vapi-signature") || "";
    if (got !== TTS_SECRET) return err(401, "bad secret");
  }
  if (!EL_KEY) return err(500, "ELEVENLABS_API_KEY not set");

  let body;
  try { body = await req.json(); } catch { return err(400, "bad json"); }
  const msg = body && body.message ? body.message : body;
  if (!msg || msg.type !== "voice-request") return err(400, "expected voice-request");

  const text = String(msg.text || "");
  if (!text.trim()) return err(400, "empty text");
  const sampleRate = msg.sampleRate || 24000;
  const fmt = RATE_FMT[sampleRate] || "pcm_24000";

  const segments = parseSegments(text);
  const t0 = Date.now();

  // FAST PATH: one speaker for the whole chunk — stream straight through.
  if (segments.length === 1) {
    const seg = segments[0];
    const el = await elFetch(voiceFor(seg.speaker), seg.text, fmt).catch(() => null);
    if (!el || !el.ok || !el.body) {
      const d = el ? await el.text().catch(() => "") : "fetch error";
      console.log("tts EL fail " + (el ? el.status : "") + " " + String(d).slice(0, 160));
      return err(502, "tts upstream");
    }
    const ttfb = Date.now() - t0;
    console.log(
      "tts speaker=" + seg.speaker + " rate=" + sampleRate +
      " chars=" + seg.text.length + " ttfb=" + ttfb + "ms"
    );
    return new Response(el.body, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "x-tts-speaker": seg.speaker,
        "x-tts-ttfb-ms": String(ttfb),
      },
    });
  }

  // MULTI-SPEAKER: render each segment in its voice, concat the PCM in order.
  const parts = [];
  for (const seg of segments) {
    const el = await elFetch(voiceFor(seg.speaker), seg.text, fmt).catch(() => null);
    if (!el || !el.ok) {
      const d = el ? await el.text().catch(() => "") : "fetch error";
      console.log("tts EL fail seg " + (el ? el.status : "") + " " + String(d).slice(0, 120));
      continue;
    }
    parts.push(new Uint8Array(await el.arrayBuffer()));
  }
  if (!parts.length) return err(502, "tts all segments failed");

  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }

  const ttfb = Date.now() - t0;
  console.log(
    "tts segs=" + segments.length +
    " voices=" + segments.map((s) => s.speaker).join("/") +
    " rate=" + sampleRate + " ttfb=" + ttfb + "ms"
  );
  return new Response(out, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "x-tts-speaker": segments.map((s) => s.speaker).join("+"),
      "x-tts-ttfb-ms": String(ttfb),
    },
  });
}

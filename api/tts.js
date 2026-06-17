// SpamViking — custom TTS proxy (the bench's voice-switch).
// ----------------------------------------------------------------------
// Vapi's voice provider points here. Per line, Vapi POSTs:
//   { message: { type:"voice-request", text, sampleRate, ... } }
// We read a leading [[SPEAKER]] marker, pick that character's ElevenLabs voice,
// and STREAM raw 16-bit mono PCM back at the requested sample rate (Vapi's
// required format). The engine already wrote the line, so this is a voice-
// switch, not a brain-handoff — no second LLM, no squad handoff.
//
// Unmarked text -> host voice, so the host works with zero engine change. Bench
// markers ([[CONRAD]] ...) get added later by the engine's orchestration.
//
// LAG: this sits in the spoken-audio path. We stream ElevenLabs' body straight
// through (no buffering) and log ttfb (time to first audio) every call so the
// latency is measured, not assumed. Uses the flash model for lowest latency.
//
// Env: ELEVENLABS_API_KEY (required), ELEVENLABS_MODEL (opt), VAPI_TTS_SECRET
// (opt shared secret), VOICE_<NAME> (opt per-voice overrides).
// ----------------------------------------------------------------------

import { parseSpeaker, voiceFor } from "./_voices.js";

export const config = { runtime: "edge" };

const EL_KEY = process.env.ELEVENLABS_API_KEY;
const EL_MODEL = process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5";
const TTS_SECRET = process.env.VAPI_TTS_SECRET || "";

// Vapi sample rate -> ElevenLabs PCM output_format (must match exactly).
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

export default async function handler(req) {
  if (req.method !== "POST") return err(405, "POST only");

  if (TTS_SECRET) {
    const got =
      req.headers.get("x-vapi-secret") ||
      req.headers.get("x-vapi-signature") ||
      "";
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

  const { speaker, line } = parseSpeaker(text);
  const voiceId = voiceFor(speaker);
  const speakText = (line || "").trim() || text;

  const t0 = Date.now();
  const url =
    "https://api.elevenlabs.io/v1/text-to-speech/" +
    voiceId +
    "/stream?output_format=" +
    fmt;

  let el;
  try {
    el = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": EL_KEY, "content-type": "application/json" },
      body: JSON.stringify({ text: speakText, model_id: EL_MODEL }),
    });
  } catch (e) {
    console.log("tts upstream error " + String(e));
    return err(502, "tts upstream error");
  }

  if (!el.ok || !el.body) {
    const detail = await el.text().catch(() => "");
    console.log("tts EL fail " + el.status + " " + detail.slice(0, 200));
    return err(502, "tts upstream " + el.status);
  }

  const ttfb = Date.now() - t0;
  console.log(
    "tts speaker=" + speaker + " rate=" + sampleRate +
    " chars=" + speakText.length + " ttfb=" + ttfb + "ms"
  );

  // stream ElevenLabs' PCM straight back to Vapi (no buffering)
  return new Response(el.body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "x-tts-speaker": speaker,
      "x-tts-ttfb-ms": String(ttfb),
    },
  });
}

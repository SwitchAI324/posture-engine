// SpamViking — speaker -> ElevenLabs voice id (the casting table).
// ----------------------------------------------------------------------
// The engine tags a line with [[SPEAKER]]; the TTS proxy looks the speaker up
// here and renders the line in that voice. Placeholders are public ElevenLabs
// voices so the test page works out of the box — replace each id with your real
// cast (accent-driven), or override per-speaker with env vars VOICE_<NAME>.
// ----------------------------------------------------------------------

export const VOICES = {
  HOST:   process.env.VOICE_HOST   || "21m00Tcm4TlvDq8ikWAM", // placeholder: Rachel
  ANDREA: process.env.VOICE_ANDREA || "EXAVITQu4vr4xnSDxMaL", // placeholder: Bella
  CONRAD: process.env.VOICE_CONRAD || "pNInz6obpgDQGcFmaJgB", // placeholder: Adam
  BONNIE: process.env.VOICE_BONNIE || "AZnzlk1XvdvUeBnXmlld", // placeholder: Domi
};

export const DEFAULT_SPEAKER = "HOST";

// leading [[NAME]] marker -> { speaker, line }. No marker -> the host speaks.
export function parseSpeaker(text) {
  const m = String(text).match(/^\s*\[\[\s*([A-Za-z0-9_\- ]+?)\s*\]\]\s*([\s\S]*)$/);
  if (m) return { speaker: m[1].trim().toUpperCase(), line: m[2] };
  return { speaker: DEFAULT_SPEAKER, line: String(text) };
}

export function voiceFor(speaker) {
  return VOICES[speaker] || VOICES[DEFAULT_SPEAKER];
}

// Remove stage directions the model sometimes writes (*pauses*, [sighs]) so the
// voice never reads them aloud. Keeps parentheses (a real spoken aside). MUST be
// called AFTER [[NAME]] markers are split out, so it never eats a speaker tag.
export function stripStage(text) {
  return String(text)
    .replace(/\*[^*]*\*/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Split a turn into ordered segments by [[NAME]] markers, so a single chunk
// that spans a speaker change still gets each part in the right voice. Text
// before the first marker is the default speaker (host).
export function parseSegments(text) {
  const s = String(text);
  const re = /\[\[\s*([A-Za-z0-9_\- ]+?)\s*\]\]/g;
  const segs = [];
  let lastIdx = 0;
  let speaker = DEFAULT_SPEAKER;
  let m;
  while ((m = re.exec(s)) !== null) {
    const before = s.slice(lastIdx, m.index).trim();
    if (before) segs.push({ speaker, text: before });
    speaker = m[1].trim().toUpperCase();
    lastIdx = re.lastIndex;
  }
  const tail = s.slice(lastIdx).trim();
  if (tail) segs.push({ speaker, text: tail });
  return segs.length ? segs : [{ speaker: DEFAULT_SPEAKER, text: s.trim() }];
}

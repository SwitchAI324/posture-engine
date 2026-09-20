// SpamViking — Posture Engine: DISPOSITION CLASSIFIER (shared)
// ----------------------------------------------------------------------
// EXTRACTED (2026-09-20) from calls.js so the same classifier can be
// reused by the phone-outbound path once it exists (see Phone Intake's
// proposed chain: Voice posts the outbound conversation to Phone
// Intake at hangup, Phone Intake stores it on callback_jobs.transcript
// then pings a PE endpoint with {job_id}, PE reads the transcript and
// classifies here, then writes via the extended mark_callback_job RPC).
// Without this extraction, that new endpoint would have had to
// duplicate the whole classifier — same prompt, same parsing, same
// validation — with the two copies free to drift apart over time.
//
// A small, cheap, post-call-only classifier, same shape as
// completions.js's readCall() (compact forced-JSON reply, thinking
// disabled so the whole budget can't get eaten by a reasoning block —
// see readCall's own comment for why that fix exists).
//
// Category boundary is Voice's own ruling, not PE's invention:
// "threatening" = a genuine threat of harm, exposure, or retaliation,
// REGARDLESS of who it's aimed at; ordinary abuse/swearing/insults stay
// "hostile" even when aimed squarely at the host — the host's persona
// invites that, so hostile is expected to be common and mostly noise.
// threat_target only matters when disposition is "threatening": Email's
// branch pages a human only on threat_target='user' (a real threat
// against the SpamViking account holder), not on 'host' or 'other'.
//
// Callers pass a plain [{role, content}, ...] array — for web calls
// that's body.conversation (calls.js); for phone outbound calls it will
// be whatever callback_jobs.transcript actually stores once Phone
// Intake's new column exists (shape not yet confirmed — the caller is
// responsible for normalizing to {role, content} before calling this).
// ----------------------------------------------------------------------

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DISPOSITION_MODEL = () => process.env.MODEL || "claude-sonnet-5";

// PHONE TRANSCRIPT NORMALIZER (2026-09-20, Phone Intake) — callback_jobs.
// transcript is TEXT (Data converted it from the earlier, never-actually-
// live jsonb plan), one line per turn, speaker-labelled by Voice's
// writer: "HOST: ..." / "CALLER: ...". Phone Intake's own explicit
// instruction: classify the CALLER's disposition only — HOST lines are
// PE's own agent and including them would skew the result (same
// normalization Phone Intake already applies before classifying inbound
// transcripts). So this extracts ONLY the caller-labelled lines and
// returns them as a bare [{role:"user", content}] array — deliberately
// NOT including any assistant/host entries at all, unlike the web path
// (calls.js), which passes the full two-sided conversation because
// there the model is told to focus on caller demeanor from within full
// context. Phone Intake wants the host physically absent from the input,
// not just instructed-around, so this drops those lines rather than
// keeping-and-hoping the model ignores them.
export function callerLinesFromPhoneTranscript(transcriptText) {
  if (typeof transcriptText !== "string" || !transcriptText.trim()) return [];
  return transcriptText
    .split(/\r?\n/)
    .map((line) => {
      const m = line.match(/^\s*CALLER:\s*(.*)$/i);
      return m ? m[1].trim() : null;
    })
    .filter((line) => line && line.length)
    .map((content) => ({ role: "user", content }));
}

export async function classifyDisposition(conversation) {
  try {
    if (!Array.isArray(conversation)) return null;
    const convo = conversation
      .filter((m) => m && m.role !== "system" && m.content)
      .map((m) => (m.role === "user" ? "Caller: " : "Host: ") + m.content)
      .join("\n");
    if (!convo.trim()) return null;
    const sys =
      "You read a FINISHED scam-baiting phone/video call transcript. The " +
      "HOST is an AI persona wasting a scammer's time; the CALLER is the " +
      "scammer. Classify the caller's overall demeanor across the WHOLE " +
      "call as exactly one category:\n" +
      "friendly — warm, cooperative, no hostility.\n" +
      "neutral — business-like, unremarkable, nothing notable either way.\n" +
      "hostile — rude, cursing, demeaning, aggressive, insulting — " +
      "whether aimed at the host or general. This is the common, " +
      "low-stakes bucket; the host's own persona regularly invites this, " +
      "so default here rather than to threatening when in doubt.\n" +
      "threatening — a GENUINE threat of harm, exposure, or retaliation " +
      "(e.g. \"I know where you live,\" \"I'll report/dox/hurt you or " +
      "your family,\" a real promise of consequences) — regardless of " +
      "who it targets. Reserve this for real threats; swearing or " +
      "insults alone are hostile, not threatening. Be conservative.\n" +
      "unknown — transcript too short, garbled, or unclear to judge.\n\n" +
      "If disposition is \"threatening\", also report threat_target — " +
      "who the threat is actually aimed at: \"host\" (the AI persona), " +
      "\"user\" (the real SpamViking account holder behind the host — " +
      "their home, family, personal information, safety, or identity), " +
      "or \"other\" (someone/something else — law enforcement, a third " +
      "party, etc). threat_target is null whenever disposition is not " +
      "\"threatening\".\n\n" +
      "Reply EXACTLY, compact JSON only, no prose: " +
      "{\"disposition\":\"friendly\"|\"neutral\"|\"hostile\"|\"threatening\"|\"unknown\"," +
      "\"threat_target\":\"host\"|\"user\"|\"other\"|null}";
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: DISPOSITION_MODEL(),
        max_tokens: 256,
        // THINKING DISABLED — same fix, same reasoning as readCall's own
        // comment in completions.js: a terse forced-JSON classifier task
        // never wants deliberation, and letting it think risks the whole
        // budget getting consumed by a reasoning block before any JSON
        // ever appears.
        thinking: { type: "disabled" },
        system: sys,
        messages: [{ role: "user", content: convo + "\n\nJSON:" }],
      }),
    });
    if (!r.ok) {
      console.log("classifyDisposition REASON=http_not_ok status=" + r.status);
      return null;
    }
    const j = await r.json();
    const txt = (j.content || []).map((c) => c.text || "").join("").trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) {
      console.log("classifyDisposition REASON=no_json_found raw=" + JSON.stringify(txt.slice(0, 150)));
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(m[0]);
    } catch (e) {
      console.log("classifyDisposition REASON=parse_error err=" + (e && e.message ? e.message : e));
      return null;
    }
    const VALID_DISPOSITIONS = ["friendly", "neutral", "hostile", "threatening", "unknown"];
    const VALID_TARGETS = ["host", "user", "other"];
    const disposition = VALID_DISPOSITIONS.includes(parsed.disposition) ? parsed.disposition : null;
    if (!disposition) {
      console.log("classifyDisposition REASON=invalid_disposition raw=" + JSON.stringify(parsed.disposition));
      return null;
    }
    // threat_target is only ever meaningful when disposition IS
    // "threatening" — enforced here, not just trusted from the model, so
    // a model slip (e.g. reporting a target on a "hostile" call) can
    // never write a stray threat_target that Email's branch would then
    // misread as an actual threat.
    const threatTarget =
      disposition === "threatening" && VALID_TARGETS.includes(parsed.threat_target)
        ? parsed.threat_target
        : null;
    return { disposition, threatTarget };
  } catch (e) {
    console.log("classifyDisposition REASON=threw err=" + (e && e.message ? e.message : e));
    return null;
  }
}

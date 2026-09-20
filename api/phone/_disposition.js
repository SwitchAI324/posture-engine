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
// branch pages a human only on threat_target='customer' (a real threat
// against the SpamViking account holder), not on 'host' or 'other'.
//
// NAMING NOTE (2026-09-20, Voice's catch): threat_target uses 'customer',
// NOT 'user', even though "the account holder" is what everyone calls
// the SpamViking user elsewhere. That's deliberate: transcript turns use
// role:"user" for the SCAMMER (fixed by the LLM API's own vocabulary,
// can't be renamed) and role:"assistant" for the host. If threat_target
// also used 'user' for the account holder, "pull the transcript for
// threat_target='user' calls" would silently mean two different people
// depending which column you're reading. Kept apart on purpose.
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

// PHONE TRANSCRIPT NORMALIZER (2026-09-20, Data/PE — REVISED same day,
// supersedes the TEXT-format version) — callback_jobs.transcript is
// jsonb, an array of turns shaped { ts, role, text }; role:"user" is the
// caller/scammer, role:"assistant" is the AI host. Data confirmed this
// shape against the 19 surviving Sep 4–18 rows and is reverting the
// earlier TEXT conversion, which was premature; write_phone_transcript
// already produces this shape natively. Phone Intake's instruction still
// stands regardless of encoding: classify the CALLER's disposition only
// — HOST turns are PE's own agent and including them would skew the
// result. So this filters to role:"user" turns and returns them as a
// bare [{role:"user", content}] array — deliberately NOT including any
// assistant/host entries, unlike the web path (calls.js), which passes
// the full two-sided conversation because there the model is told to
// focus on caller demeanor from within full context. Phone Intake wants
// the host physically absent from the input, not just instructed-around,
// so this drops those turns rather than keeping-and-hoping the model
// ignores them.
export function callerLinesFromPhoneTranscript(transcriptTurns) {
  if (!Array.isArray(transcriptTurns)) return [];
  return transcriptTurns
    .filter(
      (t) => t && t.role === "user" && typeof t.text === "string" && t.text.trim()
    )
    .map((t) => ({ role: "user", content: t.text.trim() }));
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
      "\"customer\" (the real SpamViking account holder behind the host " +
      "— their home, family, personal information, safety, or identity), " +
      "or \"other\" (someone/something else — law enforcement, a third " +
      "party, etc). threat_target is null whenever disposition is not " +
      "\"threatening\".\n\n" +
      "Reply EXACTLY, compact JSON only, no prose: " +
      "{\"disposition\":\"friendly\"|\"neutral\"|\"hostile\"|\"threatening\"|\"unknown\"," +
      "\"threat_target\":\"host\"|\"customer\"|\"other\"|null}";
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
    const VALID_TARGETS = ["host", "customer", "other"];
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

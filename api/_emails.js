// SpamViking — Posture Engine: CALL MEMORY (email history -> opening brief)
// ----------------------------------------------------------------------
// At call lock (pre-snap), the host should already "remember" the email
// relationship. The email layer persists every turn to `emails` keyed by
// target_id. We read that thread, ordered by seq, and summarize it ONCE into a
// compact brief that gets baked into the frozen prefix (cached, no per-turn
// cost). We summarize rather than raw-inject because threads can be long; the
// host needs the gist + specific callbacks, not a transcript wall. The `signal`
// column flags the meaningful turns (tried to book, got suspicious, etc.).
//
// Text only by design — no attachments. target_id is the join key throughout.
// ----------------------------------------------------------------------

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AKEY = process.env.ANTHROPIC_API_KEY;
const AMODEL =
  process.env.ANTHROPIC_SUMMARY_MODEL ||
  process.env.ANTHROPIC_MODEL ||
  "claude-haiku-4-5-20251001";

// Ordered read of the full thread for a target.
export async function readEmails(targetId) {
  if (!URL || !KEY || !targetId) return [];
  const r = await fetch(
    `${URL}/rest/v1/emails?target_id=eq.${encodeURIComponent(targetId)}` +
      `&select=direction,body,signal,seq&order=seq.asc`,
    { headers: { apikey: KEY, authorization: `Bearer ${KEY}` } }
  ).catch(() => null);
  if (!r || !r.ok) return [];
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

// Read + summarize into a short brief addressed to the host. Returns the brief
// string, or null if there's nothing to summarize / the summary call fails.
export async function summarizeEmails(targetId) {
  const rows = await readEmails(targetId);
  if (!rows.length) return null;
  if (!AKEY) return null;

  // Compact transcript for the summarizer; THEM = inbound (spammer), US = our
  // side. The signal tag rides along so the model can weight the key turns.
  const lines = rows.map((r) => {
    const who = r.direction === "inbound" ? "THEM" : "US";
    const sig = r.signal ? ` [${r.signal}]` : "";
    const text = String(r.body || "").replace(/\s+/g, " ").trim();
    return `${who}${sig}: ${text}`;
  });
  let convo = lines.join("\n");
  // Defensive cap — keep the most recent exchange if a thread is huge.
  if (convo.length > 12000) convo = convo.slice(-12000);

  const sys =
    "You brief a call host who is about to speak live with this person, having " +
    "already corresponded with them by email. In 4-6 tight sentences, summarize " +
    "the email exchange so the host walks in remembering it: what THEY pitched, " +
    "the specific claims they made, any rapport or objections, and anything they " +
    "committed to. Address it to the host as direct context (\"They pitched X; " +
    "claimed Y; were hesitant about Z; agreed to W\"). No preamble, no lists — " +
    "just the brief.";

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": AKEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: AMODEL,
        max_tokens: 400,
        system: sys,
        messages: [{ role: "user", content: convo }],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

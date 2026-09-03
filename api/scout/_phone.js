// api/scout/_phone.js
// Phone lane helpers. Given an E.164 number:
//   (a) line_type via Twilio Lookup — voip = scam signal, landline/mobile =
//       slow-down signal. Degrades to null without Twilio creds (like Tavily).
//   (b) web complaint reports via Tavily, then ONE Claude judgment pass that
//       emits a structured playbook ONLY when reports corroborate — precision
//       over recall, a wrong playbook is worse than none.
//   (c) confidence bucket 'low'|'medium'|'high'; playbook only at medium+.
// Scammer-only: nothing here touches or emits any SpamViking-user data.

const MODEL =
  process.env.SCOUT_JUDGE_MODEL ||
  process.env.ANTHROPIC_MODEL ||
  'claude-haiku-4-5-20251001';

// ---- line type (Twilio Lookup v2) --------------------------------------
// Keyless-degrade: no creds -> null, lane's web half still works.
export async function lookupLineType(e164) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !e164) return null;
  try {
    const url =
      `https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}` +
      `?Fields=line_type_intelligence`;
    const r = await fetch(url, {
      headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}` },
    });
    if (!r.ok) return null;
    const data = await r.json();
    const t = data && data.line_type_intelligence && data.line_type_intelligence.type;
    if (!t) return null;
    // Normalize Twilio's types to our three buckets.
    const s = String(t).toLowerCase();
    if (s.includes('voip') || s.includes('nonFixedVoip'.toLowerCase()) || s.includes('fixedvoip')) return 'voip';
    if (s.includes('landline')) return 'landline';
    if (s.includes('mobile')) return 'mobile';
    return s; // pass through anything unexpected rather than lose it
  } catch {
    return null;
  }
}

// ---- web complaint reports (Tavily) ------------------------------------
// Returns raw report rows for the row's web_reports column AND as the judge's
// input. Degrades to [] without a key.
export async function gatherReports(e164) {
  const key = process.env.TAVILY_API_KEY;
  if (!key || !e164) return [];
  const out = [];
  for (const q of [`${e164} scam`, `${e164} who called`, `${e164} complaint`]) {
    try {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: key,
          query: q,
          max_results: 5,
          include_answer: false,
        }),
      });
      if (!r.ok) continue;
      const data = await r.json();
      for (const res of data.results || [])
        out.push({
          source: hostOf(res.url),
          url: res.url,
          seen_at: new Date().toISOString(),
          claimed_org: null, // filled by the judge if the text names one
          summary: (res.content || res.title || '').slice(0, 300),
          tags: [],
        });
    } catch {}
  }
  // Dedupe by url.
  const seen = new Set();
  return out.filter((x) => x.url && !seen.has(x.url) && seen.add(x.url));
}

// ---- judgment pass: corroboration -> playbook + confidence -------------
// Emits a structured playbook ONLY when multiple reports agree. One-off or
// contradictory reports -> no playbook, low confidence. Precision over recall.
export async function judgeReports(e164, reports) {
  const empty = { playbook: null, confidence: 'low', reports };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !reports.length) return empty;

  const SYSTEM = `You analyze public complaint reports about a phone number to
build an "expected playbook" the host can use when calling the scammer back.
CORROBORATION IS REQUIRED: only describe a script element if MULTIPLE reports
agree on it. A single report, or contradictory reports, is NOT enough — leave
those fields null and set confidence low. A wrong playbook is worse than none.

Return ONLY this JSON, no prose, no fences:
{
  "playbook": {
    "opening_move": string|null,      // how the call/script opens, if corroborated
    "the_ask": string|null,           // what they ultimately want, if corroborated
    "pressure_moves": string[]        // tactics multiple reports mention (may be [])
  },
  "claimed_orgs": string[],           // orgs reports say the caller claims to be
  "confidence": "low" | "medium" | "high"
}
confidence: high = many consistent reports; medium = a few that agree; low =
sparse/one-off/contradictory. If confidence is low, playbook fields should be
null/empty. NEVER invent details not in the reports.`;

  const input =
    `Number: ${e164}\n\nReports:\n` +
    reports.map((r, i) => `[${i + 1}] ${r.source}: ${r.summary}`).join('\n');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: SYSTEM,
        messages: [{ role: 'user', content: input.slice(0, 8000) }],
      }),
    });
    if (!r.ok) return empty;
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const s = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const j = JSON.parse(s);
    const confidence = ['low', 'medium', 'high'].includes(j.confidence) ? j.confidence : 'low';

    // Precision gate: no playbook below medium, regardless of what the model returned.
    let playbook = null;
    if (confidence === 'medium' || confidence === 'high') {
      const p = j.playbook || {};
      const moves = Array.isArray(p.pressure_moves) ? p.pressure_moves : [];
      if (p.opening_move || p.the_ask || moves.length)
        playbook = {
          opening_move: p.opening_move || null,
          the_ask: p.the_ask || null,
          pressure_moves: moves,
        };
    }

    // Fold any corroborated claimed_orgs back onto the report rows (evidence).
    const orgs = Array.isArray(j.claimed_orgs) ? j.claimed_orgs : [];
    const enriched = reports.map((rep) => ({ ...rep, claimed_org: orgs[0] || rep.claimed_org }));

    return { playbook, confidence, reports: enriched };
  } catch {
    return empty;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

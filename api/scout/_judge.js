// api/scout/_judge.js
// The single judgment pass. One Claude call turns gathered raw material into
// the two web-derived hooks. Precision over recall: a wrong "fact" makes the
// host sound deranged, so the model is told to return [] unless it's sure.
// Output is strict JSON, parsed defensively.
//
// Default model is haiku (cheap, matches the PE stack). If dossier_negation
// precision disappoints, set SCOUT_JUDGE_MODEL=claude-sonnet-4-6.
const MODEL = process.env.SCOUT_JUDGE_MODEL || 'claude-haiku-4-5-20251001';

const SYSTEM = `You score scouted material about a scam operation and emit \
"hooks" — real facts a caller can reference to sound specifically informed \
about this operation. Precision over recall: only emit a hook you are \
confident is true and about THIS company. A wrong fact is worse than none.

Emit only these hook ids:
- company_news: a real, recent, attributable news item about the claimed \
company. payload: {headline, date, url}.
- dossier_negation: a public fact that flatly contradicts a specific claim \
in their pitch. payload: {claim, contradicting_fact, basis}.

Return ONLY a JSON array of objects {hook_id, label, payload, confidence} \
where confidence is 0..1 and label is at most 40 characters. No prose, no \
code fences. If nothing qualifies, return [].`;

export async function judge(raw) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return [];
  if (!raw.claimed_company && !(raw.news || []).length) return [];

  const user = JSON.stringify({
    claimed_company: raw.claimed_company,
    pitch_text: (raw.pitch_text || '').slice(0, 4000),
    news: raw.news,
  });

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
        max_tokens: 600,
        system: SYSTEM,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!r.ok) return [];
    const data = await r.json();
    const text = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return parseHooks(text);
  } catch {
    return [];
  }
}

function parseHooks(text) {
  if (!text) return [];
  const s = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  try {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (h) =>
          h &&
          (h.hook_id === 'company_news' || h.hook_id === 'dossier_negation') &&
          typeof h.confidence === 'number' &&
          h.label)
      .map((h) => ({ ...h, source: 'web+judge', payload: h.payload || {} }));
  } catch {
    return [];
  }
}

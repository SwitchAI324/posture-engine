// api/scout/_calldissect.js
// Post-call dissection. Reads the transcript of a baiting call and extracts
// CALLBACKS — personal details, claims, and commitments that were actually
// said on the call — so follow-ups can reference what happened. Same
// principle as email dissection (repeat volunteered material, never invent),
// pointed at the transcript. Transcription mangles words, so gates sit a
// touch higher and the prompt is told to lower confidence on garbled text.
//
// These facts are the richest, most personal ammunition in the system: a pet,
// a kid's recital, a holiday, a hobby — referenced later, it sounds like we
// listened, because we did.

const MODEL =
  process.env.SCOUT_JUDGE_MODEL ||
  process.env.ANTHROPIC_MODEL ||
  'claude-haiku-4-5-20251001';

const SYSTEM = `You read a transcript of a phone call. One speaker is our host
(who is deliberately wasting a scammer's time); the other is the scammer.
Extract ONLY things actually said — extraction, NOT inference. Never invent.

Return ONLY this JSON, no prose, no code fences:
{
  "callbacks": [
    { "topic": short label, "detail": the specific thing said, "whose": "them" | "host" | "shared" }
  ],
  "claims":      [ short strings: claims the scammer made about themselves or their offer ],
  "commitments": [ short strings: next steps either side said they would do ],
  "confidence": { "callbacks": 0..1, "claims": 0..1, "commitments": 0..1 }
}

callbacks are personal, warm, memorable details we could reference later to
sound like we were paying attention (a pet's name, a child's event, a trip, a
hobby, an aside). "whose" marks who the detail is about: them (the scammer),
host (our side), or shared (something the conversation built together). If the
transcript looks garbled or you are unsure a detail is real, lower confidence
or omit it. Precision over recall — a wrong callback is worse than none.`;

export async function dissectCall({ transcript = '', call_id = null } = {}) {
  const llm = await extractCall(transcript);
  const c = llm.confidence || {};

  const facts = {
    callbacks: llm.callbacks || [],
    claims: llm.claims || [],
    commitments: llm.commitments || [],
  };
  // call_id is a real scout_facts column now — carried on the row, not the blob.

  const factRows = [];
  if (
    (facts.callbacks && facts.callbacks.length) ||
    (facts.claims && facts.claims.length) ||
    (facts.commitments && facts.commitments.length)
  ) {
    factRows.push({ lane: 'call', facts, call_id });
  }

  const hooks = [];
  if (facts.callbacks.length)
    hooks.push({
      hook_id: 'call_callback',
      label: callbackLabel(facts.callbacks),
      payload: { callbacks: facts.callbacks },
      confidence: num(c.callbacks, 0.7),
      source: 'call:transcript',
    });
  if (facts.claims.length)
    hooks.push({
      hook_id: 'call_claim',
      label: `On-call claim: ${facts.claims[0]}`.slice(0, 40),
      payload: { claims: facts.claims },
      confidence: num(c.claims, 0.7),
      source: 'call:transcript',
    });
  if (facts.commitments.length)
    hooks.push({
      hook_id: 'call_commitment',
      label: `Next step: ${facts.commitments[0]}`.slice(0, 40),
      payload: { commitments: facts.commitments },
      confidence: num(c.commitments, 0.7),
      source: 'call:transcript',
    });

  return { factRows, hooks };
}

async function extractCall(transcript) {
  const empty = { callbacks: [], claims: [], commitments: [], confidence: {} };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !transcript || !transcript.trim()) return empty;
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
        max_tokens: 900,
        system: SYSTEM,
        messages: [{ role: 'user', content: String(transcript).slice(0, 24000) }],
      }),
    });
    if (!r.ok) return empty;
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const s = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' ? { ...empty, ...parsed } : empty;
  } catch {
    return empty;
  }
}

function num(v, d) {
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : d;
}
function callbackLabel(list) {
  const them = list.find((x) => x.whose === 'them') || list[0];
  return `Callback: ${them.topic || them.detail || 'detail'}`.slice(0, 40);
}

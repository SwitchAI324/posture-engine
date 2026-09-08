// api/phone/inbound-complete.js
// Called by the LiveKit agent at hangup on an inbound call. Writes the
// record, classifies the transcript after the fact, updates the house
// budget or the user's minute ledger, and fires a recap for return calls.
//
// POST JSON: { house_call_id, transcript?, minutes_used?, outcome?,
//              recording_slug?, user_id?, job_id? }
// Header:    x-phone-intake-secret
// Returns:   { ok, mode, archetype?, recap_queued? }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PHONE_INTAKE_SECRET,
//      ANTHROPIC_API_KEY, ANTHROPIC_MODEL (optional), RECAP_URL (optional)

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.PHONE_INTAKE_SECRET;
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const RECAP_URL = process.env.RECAP_URL || 'https://posture-engine.vercel.app/api/phone/recap';

const ARCHETYPES = ['b2b_saas', 'crypto_investment', 'account_access', 'gov_threat', 'generic'];

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${path} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const select = (table, filter) => sb(`${table}?${filter}`, { method: 'GET' });
const insert = (table, row, prefer) => sb(table, { method: 'POST', body: JSON.stringify(row), prefer });
const update = (table, filter, row) => sb(`${table}?${filter}`, { method: 'PATCH', body: JSON.stringify(row) });
const rpc = (fn, args) => sb(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

const monthStart = () => { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`; };

// After-the-fact classification. The host never saw this — it's for the feed.
async function classify(transcript) {
  if (!ANTHROPIC || !transcript || transcript.length < 40) return null;
  const system = `You classify inbound scam calls from a transcript. Respond with a single JSON object, no prose, no code fences.
- archetype: one of ${ARCHETYPES.join(', ')}. Precision over recall: "generic" unless clearly one of the others.
- confidence: 0..1
- claimed_org: the organization the caller claimed to be from, or null.
- agent_label: the name the caller gave, or null.
- script_summary: one sentence, the pitch and the ask.
- likely_legitimate: true if this reads like a real business or personal call rather than a scam.`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 500, system, messages: [{ role: 'user', content: transcript }] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const raw = (await r.json()).content?.map(c => c.text || '').join('') || '{}';
    const j = JSON.parse(raw.replace(/```json|```/g, '').trim());
    if (!ARCHETYPES.includes(j.archetype)) j.archetype = 'generic';
    return j;
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!SECRET || req.headers['x-phone-intake-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'bad secret' });

  const { house_call_id, transcript, minutes_used, outcome, recording_slug, user_id, job_id } = req.body || {};
  if (!house_call_id) return res.status(400).json({ ok: false, error: 'house_call_id required' });
  const minutes = Number.isFinite(minutes_used) ? minutes_used : 0;

  try {
    const [call] = await select('house_calls', `id=eq.${house_call_id}&select=*`);
    if (!call) return res.status(404).json({ ok: false, error: 'no such call' });

    const a = await classify(transcript);

    await update('house_calls', `id=eq.${house_call_id}`, {
      ended_at: new Date().toISOString(),
      minutes_used: minutes,
      transcript: transcript || null,
      outcome: outcome || null,
      recording_slug: recording_slug || `in-${house_call_id}`,
      archetype: a?.archetype || null,
      classification: a || null,
      claimed_org: a?.claimed_org || null,
    });

    // Feed the shared scammer profile (column-scoped RPC; vote append).
    if (a && call.from_e164) {
      await rpc('upsert_caller_profile', {
        p_e164: call.from_e164, p_org: a.claimed_org || null,
        p_summary: a.script_summary || null, p_archetype: a.archetype, p_src: 'inbound',
      }).catch(() => {});
    }

    const matchedUser = user_id || null;
    const matchedJob = job_id || call.matched_job_id || null;

    if (matchedUser) {
      // Return call: minutes belong to the user, and they get a recap.
      await insert('minute_ledger', {
        user_id: matchedUser, job_id: matchedJob, kind: 'callback', minutes,
      }, 'return=minimal').catch(() => {});
      let queued = false;
      if (matchedJob) {
        try {
          const r = await fetch(RECAP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-phone-intake-secret': SECRET },
            body: JSON.stringify({ job_id: matchedJob, kind: 'recap' }),
            signal: AbortSignal.timeout(8000),
          });
          queued = r.ok;
        } catch { /* recap is best-effort */ }
      }
      return res.status(200).json({ ok: true, mode: 'user', archetype: a?.archetype || null, recap_queued: queued });
    }

    // House call: minutes come out of the shared budget.
    await insert('house_budget', { month_start: monthStart() }, 'resolution=ignore-duplicates,return=minimal');
    const [budget] = await select('house_budget', `month_start=eq.${monthStart()}&select=*`);
    await update('house_budget', `month_start=eq.${monthStart()}`, {
      minutes_used: (budget?.minutes_used || 0) + minutes,
    });

    return res.status(200).json({ ok: true, mode: 'house', archetype: a?.archetype || null });
  } catch (err) {
    console.error('inbound-complete', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

// api/phone/inbound-check.js
// Called by the LiveKit agent the moment an inbound call arrives, BEFORE it
// answers. Decides whether to pick up at all and whether this is a house
// (demo-line) call or a return call belonging to a specific SV user.
//
// POST JSON: { from_e164, to_e164, livekit_room? }
// Header:    x-phone-intake-secret
// Returns:   { answer: bool, reason, mode: 'house'|'user', slug?,
//              job_id?, user_id?, host_name?, reference_code?,
//              caller_context?, house_call_id? }
// The slug ('in-<house_call_id>') is minted via Booking's /api/phone/mint-token
// so the agent hydrates through the one prompt path. Return calls carry
// callback_job_id on the token; house calls don't (cold open by design).
//
// Guardrails checked, in order: kill switch → blocklist → return-call match
// → per-number daily caps → house monthly budget.
// A refused call should be hung up immediately (no greeting, no notice).

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.PHONE_INTAKE_SECRET;
const MINT_URL = process.env.MINT_TOKEN_URL || 'https://posture-engine.vercel.app/api/phone/mint-token';
// Numbers that are ALWAYS a cold house call, never a return match (Andrew's
// ruling: a call to the public demo line has no context, ever). Comma-separated.
const DEMO_LINES = (process.env.DEMO_LINE_E164 || '+18143287726').split(',').map(x => x.trim()).filter(Boolean);

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

// Booking owns the mint; we just hand it the fields. Idempotent on slug.
async function mintToken(body) {
  const r = await fetch(MINT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-phone-intake-secret': SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.ok) throw new Error(`mint-token ${r.status}: ${j?.error || 'unknown'}`);
  return j.slug;
}

const monthStart = () => { const d = new Date(); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`; };
const dayAgoISO = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!SECRET || req.headers['x-phone-intake-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'bad secret' });

  const { from_e164, to_e164, livekit_room } = req.body || {};
  if (!from_e164) return res.status(400).json({ ok: false, error: 'from_e164 required' });

  try {
    // 1. Global inbound kill switch
    const [flags] = await select('system_flags', 'select=*&limit=1');
    if (!flags?.inbound_enabled) {
      return res.status(200).json({ answer: false, reason: 'inbound_disabled', mode: 'house' });
    }

    // 2. Blocklist (a number we've decided never to talk to again)
    const [profile] = await select('caller_profile', `e164=eq.${encodeURIComponent(from_e164)}&select=status,claimed_org`);
    if (profile?.status === 'blocked') {
      return res.status(200).json({ answer: false, reason: 'blocked_number', mode: 'house' });
    }

    // 3. Return call? Only if we actually LEFT this number a voicemail
    //    recently — that's the only reason a scammer would be calling us
    //    back. Anything else is a cold house call.
    //    (callback_numbers.e164 is the scammer's number, i.e. the number we
    //    dial AND the number they'd call back from — same value by design.)
    const isDemoLine = to_e164 && DEMO_LINES.includes(to_e164);
    const gate = isDemoLine ? [] : await select('callback_numbers',
      `e164=eq.${encodeURIComponent(from_e164)}&blocked=eq.false&order=first_seen.desc&limit=1&select=id,user_id`);
    const RETURN_WINDOW_DAYS = 30;
    const since = new Date(Date.now() - RETURN_WINDOW_DAYS * 864e5).toISOString();
    const candidates = gate.length ? await select('callback_jobs',
      `callback_number_id=eq.${gate[0].id}&outcome=eq.voicemail_left&status=eq.completed`
      + `&created_at=gte.${since}&order=created_at.desc&limit=1`
      + `&select=id,host_name,reference_code,caller_context,archetype`) : [];
    if (candidates.length) {
      const userId = gate[0].user_id;
      const job = candidates[0];
      const [settings] = await select('phone_settings', `user_id=eq.${userId}&select=*`);
      if (settings?.minute_cap_enabled) {
        const led = await select('minute_ledger',
          `user_id=eq.${userId}&created_at=gte.${monthStart()}T00:00:00Z&select=minutes`);
        const used = led.reduce((n, r) => n + (r.minutes || 0), 0);
        if (used >= (settings.minute_cap_monthly ?? 60)) {
          return res.status(200).json({ answer: false, reason: 'user_minute_cap', mode: 'user', user_id: userId });
        }
      }
      const [row] = await insert('house_calls', {
        from_e164, to_e164, livekit_room, matched_job_id: job?.id || null,
      }, 'return=representation');
      const [owner] = await select('sv_users', `id=eq.${userId}&select=email,host_name`);
      const slug = await mintToken({
        slug: `in-${row.id}`,
        callback_job_id: job?.id || null,
        host_name: job?.host_name || owner?.host_name || null,
        owner_email: owner?.email || null,
      });
      return res.status(200).json({
        answer: true, reason: 'return_call', mode: 'user', slug,
        user_id: userId, job_id: job?.id || null,
        host_name: job?.host_name || null,
        reference_code: job?.reference_code || null,
        caller_context: job?.caller_context || null,
        archetype: job?.archetype || null,
        house_call_id: row.id,
      });
    }

    // 4. Per-number daily caps (one robodialer can't drain the budget)
    const recent = await select('house_calls',
      `from_e164=eq.${encodeURIComponent(from_e164)}&started_at=gte.${dayAgoISO()}&select=minutes_used`);
    if (recent.length >= (flags.inbound_per_number_daily_calls ?? 3)) {
      return res.status(200).json({ answer: false, reason: 'per_number_call_cap', mode: 'house' });
    }
    const numMinutes = recent.reduce((n, r) => n + (r.minutes_used || 0), 0);
    if (numMinutes >= (flags.inbound_per_number_daily_minutes ?? 30)) {
      return res.status(200).json({ answer: false, reason: 'per_number_minute_cap', mode: 'house' });
    }

    // 5. House monthly budget
    await insert('house_budget', { month_start: monthStart() }, 'resolution=ignore-duplicates,return=minimal');
    const [budget] = await select('house_budget', `month_start=eq.${monthStart()}&select=*`);
    if ((budget?.minutes_used ?? 0) >= (budget?.minutes_cap ?? 300)) {
      return res.status(200).json({ answer: false, reason: 'house_budget', mode: 'house' });
    }

    // 6. Answer as a house call — host knows nothing about this caller.
    const [row] = await insert('house_calls', { from_e164, to_e164, livekit_room }, 'return=representation');
    const slug = await mintToken({ slug: `in-${row.id}` });   // no job, no owner → cold open
    return res.status(200).json({
      answer: true, reason: 'house_call', mode: 'house', slug, house_call_id: row.id,
    });
  } catch (err) {
    console.error('inbound-check', err);
    // Fail closed: if we can't verify the guardrails, don't answer.
    return res.status(500).json({ answer: false, reason: 'error', mode: 'house', error: String(err.message || err) });
  }
}

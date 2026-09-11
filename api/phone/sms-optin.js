// api/phone/sms-optin.js
// POST /api/phone/sms-optin   { email, phone, consent: true }
// Public endpoint behind the sms-optin.html form. Saves the SV user's mobile
// number on their sv_users row and records the consent in sms_log
// (status 'opt_in'), so there is an audit trail of when consent was given.
//
// Rules:
//   - email must match an existing sv_users row (lowercased). No user → 404.
//     We never create accounts here.
//   - phone must normalise to a US number (+1 + 10 digits). Anything else →
//     400 with a plain message ("US numbers only for now").
//   - consent must be true.
//   - phone_verified_at is NOT set here: this is consent, not verification.
//     The call-live gate only requires phone_e164, so texts start immediately.
//
// KNOWN LIMIT (flagged, accepted for v1 while Andrew is the only user):
// there is no login on the platform, so anyone who knows a user's email could
// attach a phone number to that account. The fix is an SMS confirmation code
// before saving — deferred until toll-free verification is approved, since
// that step can't send texts before then anyway.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

function env(name, ...fallbacks) {
  for (const n of [name, ...fallbacks]) {
    if (process.env[n]) return process.env[n];
  }
  return '';
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

function toE164US(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function sb() {
  const url = env('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL').replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY');
  if (!url || !key) throw new Error('supabase env missing');
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  return {
    async select(table, query) {
      const r = await fetch(`${url}/rest/v1/${table}?${query}`, { headers });
      if (!r.ok) throw new Error(`select ${table} ${r.status}`);
      return r.json();
    },
    async patch(table, query, row) {
      const r = await fetch(`${url}/rest/v1/${table}?${query}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      });
      if (!r.ok) throw new Error(`patch ${table} ${r.status}`);
    },
    async insert(table, row) {
      const r = await fetch(`${url}/rest/v1/${table}`, {
        method: 'POST',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(row),
      });
      if (!r.ok) throw new Error(`insert ${table} ${r.status}`);
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }

  const p = parseBody(req);
  const email = String(p.email || '').trim().toLowerCase();
  const phone = toE164US(p.phone);

  if (!email || !email.includes('@')) {
    res.status(400).json({ ok: false, error: 'Enter the email on your SpamViking account.' });
    return;
  }
  if (!phone) {
    res.status(400).json({ ok: false, error: 'US mobile numbers only for now.' });
    return;
  }
  if (p.consent !== true) {
    res.status(400).json({ ok: false, error: 'Tick the box to agree to receive texts.' });
    return;
  }

  try {
    const db = sb();
    const users = await db.select(
      'sv_users',
      `select=id&email=eq.${encodeURIComponent(email)}&limit=1`
    );
    const user = users[0];
    if (!user) {
      res.status(404).json({ ok: false, error: 'No SpamViking account with that email.' });
      return;
    }

    await db.patch('sv_users', `id=eq.${encodeURIComponent(user.id)}`, { phone_e164: phone });
    await db.insert('sms_log', {
      user_id: user.id,
      channel: 'web_form',
      to_e164: phone,
      status: 'opt_in',
    });

    const pretty = `(${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`;
    res.status(200).json({ ok: true, phone: pretty });
  } catch (e) {
    console.error('sms-optin:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong. Try again in a minute.' });
  }
}

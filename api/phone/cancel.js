// api/phone/cancel.js
// Called by Barbara's Apps Script when a user replies CANCEL on a
// phone-intake thread. Cancels that user's newest pending/approved job.
//
// POST JSON: { sender_email }
// Header:    x-phone-intake-secret: <PHONE_INTAKE_SECRET>
// Returns:   { ok, cancelled, reply_subject, reply_body }
//
// Status changes on callback_jobs are guarded, so this goes through Data's
// mark_callback_job RPC (service role). Named args, exact live signature:
//   mark_callback_job(p_job_id uuid, p_status text,
//                     p_outcome text default null, p_fail_reason text default null)

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.PHONE_INTAKE_SECRET;

async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${path} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const select = (table, filter) => sb(`${table}?${filter}`, { method: 'GET' });
const rpc = (fn, args) => sb(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!SECRET || req.headers['x-phone-intake-secret'] !== SECRET) {
    return res.status(401).json({ ok: false, error: 'bad secret' });
  }
  const { sender_email } = req.body || {};
  if (!sender_email) return res.status(400).json({ ok: false, error: 'sender_email required' });

  try {
    const userId = await rpc('user_id_by_email', { p_email: sender_email });
    if (!userId) return res.status(404).json({ ok: false, error: 'unknown sender' });

    const [job] = await select('callback_jobs',
      `user_id=eq.${userId}&status=in.(pending,approved)&order=created_at.desc&limit=1&select=id`);

    if (!job) {
      return res.status(200).json({
        ok: true, cancelled: false,
        reply_subject: 'Re: cancel',
        reply_body: 'Nothing is waiting to be called right now, so there was nothing to cancel.\n\n— SpamViking',
      });
    }

    await rpc('mark_callback_job', {
      p_job_id: job.id,
      p_status: 'cancelled',
      p_fail_reason: 'user_cancel',
    });

    return res.status(200).json({
      ok: true, cancelled: true,
      reply_subject: 'Re: cancel',
      reply_body: 'Cancelled. We won\'t call that number.\n\n— SpamViking',
    });
  } catch (err) {
    console.error('phone-cancel', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

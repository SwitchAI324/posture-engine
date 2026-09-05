// api/phone/intake.js
// Phone Intake v1 (voicemail share). Called by Barbara's Apps Script when a
// message to raid@spamviking.com carries a voicemail — either as an audio
// attachment or as a carrier text transcript in the body.
//
// POST JSON (audio): { sender_email, subject, attachment_base64,
//                      attachment_mime, host_name, message_id?,
//                      voicemail_datetime? }
// POST JSON (text):  { sender_email, subject, transcript, host_name,
//                      message_id?, voicemail_datetime? }
// Duplicate (same sender + message_id already seen) → 200
//   { ok:true, status:'duplicate', reply_body:null } — send nothing.
// Header:            x-phone-intake-secret: <PHONE_INTAKE_SECRET>
// Returns:           { ok, intake_id, status, reply_subject, reply_body }
//                    Apps Script sends reply_body back to the user.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEEPGRAM_API_KEY,
//      ANTHROPIC_API_KEY, ANTHROPIC_MODEL (optional), PHONE_INTAKE_SECRET,
//      SV_SCOUT_TOKEN (for the Scouting ping)
//
// Writes only INSERTs to guarded tables (guard is BEFORE UPDATE), plus
// updates to phone_intakes (unguarded) and Data's two RPCs. caller_profile
// is written ONLY via upsert_caller_profile (column-scoped, vote append).

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEEPGRAM = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const SECRET = process.env.PHONE_INTAKE_SECRET;
const SCOUT_TOKEN = process.env.SV_SCOUT_TOKEN;
const SCOUT_URL = process.env.SCOUT_PHONE_URL || 'https://posture-engine.vercel.app/api/scout/phone';

const ARCHETYPES = ['b2b_saas', 'crypto_investment', 'account_access', 'gov_threat', 'generic'];
const CODE_ARCHETYPES = ['b2b_saas', 'account_access', 'gov_threat']; // reference code ON
const BUCKET = 'voicemails';

export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

// ---------- Supabase helpers (REST, service role) ----------
async function sb(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${path} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const insert = (table, row, prefer) => sb(table, { method: 'POST', body: JSON.stringify(row), prefer });
const update = (table, filter, row) => sb(`${table}?${filter}`, { method: 'PATCH', body: JSON.stringify(row) });
const select = (table, filter) => sb(`${table}?${filter}`, { method: 'GET' });
const rpc = (fn, args) => sb(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

async function uploadAudio(path, buf, mime) {
  const r = await fetch(`${SB}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': mime },
    body: buf,
  });
  if (!r.ok) throw new Error(`storage upload ${r.status}: ${await r.text()}`);
  return path;
}

// ---------- Deepgram (pre-recorded transcription) ----------
async function transcribe(buf, mime) {
  const r = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true', {
    method: 'POST',
    headers: { Authorization: `Token ${DEEPGRAM}`, 'Content-Type': mime },
    body: buf,
  });
  if (!r.ok) throw new Error(`deepgram ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}

// ---------- Anthropic (classification + number extraction) ----------
async function analyze(transcript) {
  const system = `You classify scam voicemails. Respond with a single JSON object and nothing else — no prose, no code fences.
Fields:
- archetype: one of ${ARCHETYPES.join(', ')}. Precision over recall: use "generic" unless clearly one of the others.
- confidence: number 0..1 that the archetype is right.
- stated_numbers: phone numbers the SPEAKER explicitly gives as a number to call back, in E.164 with country code (+1XXXXXXXXXX for US/Canada, +44... etc). Only numbers actually spoken in the recording. Empty array if none.
- number_count: how many times the primary callback number is spoken.
- extension: digits the caller says to enter after the number connects ("press 4", "extension 204"), as a digit string, or null.
- ask_for: the person and/or department the caller says to ask for ("Jim in the fraud department"), or null.
- claimed_org: the organization the caller claims to be from, or null.
- agent_label: the name the caller gives for themselves ("this is Steve"), or null.
- account_refs: any account, case, reference, or invoice numbers the caller cites, as strings. Empty array if none.
- stated_hours: the hours the caller says to call back, verbatim ("8AM to 5PM Pacific"), or null.
- pitch: one short sentence, what the caller claims is going on.
- the_ask: one short sentence, what the caller wants the listener to do.
- script_summary: one sentence, the pitch and the ask.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: `Voicemail transcript:\n\n${transcript}` }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${await r.text()}`);
  const raw = (await r.json()).content?.map(c => c.text || '').join('') || '{}';
  const j = JSON.parse(raw.replace(/```json|```/g, '').trim());
  if (!ARCHETYPES.includes(j.archetype)) j.archetype = 'generic';
  const all = (j.stated_numbers || []).filter(n => /^\+\d{8,15}$/.test(n));
  j.stated_numbers = all.filter(n => /^\+1\d{10}$/.test(n));            // dialable: +1 only for v1
  j.international_numbers = all.filter(n => !/^\+1\d{10}$/.test(n));    // heard, not dialed
  j.extension = typeof j.extension === 'string' && /^\d{1,6}$/.test(j.extension) ? j.extension : null;
  j.ask_for = typeof j.ask_for === 'string' && j.ask_for.trim() ? j.ask_for.trim().slice(0, 80) : null;
  j.agent_label = typeof j.agent_label === 'string' && j.agent_label.trim() ? j.agent_label.trim().slice(0, 60) : null;
  if (!j.ask_for && j.agent_label) j.ask_for = j.agent_label;   // "this is Steve" → ask for Steve
  j.account_refs = Array.isArray(j.account_refs) ? j.account_refs.map(String).slice(0, 10) : [];
  return j;
}

// ---------- Scouting ping (fire-and-forget, 3s cap, never blocks) ----------
async function pingScout(number) {
  if (!SCOUT_TOKEN) return;
  try {
    await fetch(SCOUT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sv-scout-token': SCOUT_TOKEN },
      body: JSON.stringify({ number }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (e) {
    console.warn('scout ping failed (non-blocking)', String(e.message || e));
  }
}

// ---------- helpers ----------
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const refCode = () => String(rand(1000, 9999));
const pretty = e164 => `${e164.slice(2, 5)}-${e164.slice(5, 8)}-${e164.slice(8)}`;

function replyFor(status, ctx) {
  const subj = 'Re: ' + (ctx.subject || 'your forwarded voicemail');
  if (status === 'queued') {
    return {
      reply_subject: subj,
      reply_body:
`Got it. Here's what we heard:

"${ctx.transcript}"

We're going to call ${pretty(ctx.number)}${ctx.extension ? `, extension ${ctx.extension}` : ''}${ctx.askFor ? `, asking for ${ctx.askFor}` : ''} in about ${ctx.minutes} minutes.
If that's the wrong number or you'd rather we didn't, reply CANCEL.

— SpamViking`,
    };
  }
  if (status === 'international') {
    return {
      reply_subject: subj,
      reply_body:
`Got it. Here's what we heard:

"${ctx.transcript}"

The callback number in that message is ${ctx.number}, which is outside
the US. We're US-only right now — international is coming. Nothing will
be dialed.

— SpamViking`,
    };
  }
  if (status === 'rejected') {
    return {
      reply_subject: subj,
      reply_body:
`Got it. Here's what we heard:

"${ctx.transcript}"

We didn't hear a callback number in the recording, so there's nothing for
us to dial. We only ever call numbers a scammer says out loud.

— SpamViking`,
    };
  }
  return { reply_subject: subj, reply_body: 'Something went wrong on our side. We\'ll look into it.' };
}

// ---------- handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!SECRET || req.headers['x-phone-intake-secret'] !== SECRET) {
    return res.status(401).json({ ok: false, error: 'bad secret' });
  }

  const { sender_email, subject, attachment_base64, attachment_mime, host_name,
          message_id, voicemail_datetime } = req.body || {};
  const textTranscript = typeof req.body?.transcript === 'string' ? req.body.transcript.trim() : '';
  const isAudio = !!attachment_base64;
  if (!sender_email || (!isAudio && !textTranscript)) {
    return res.status(400).json({ ok: false, error: 'sender_email plus attachment_base64 or transcript required' });
  }
  const mime = attachment_mime || 'audio/m4a';
  const provenance = isAudio ? 'stated_in_audio' : 'stated_in_text';

  let intakeId = null;
  try {
    // 1. Who is this user?
    const userId = await rpc('user_id_by_email', { p_email: sender_email });
    if (!userId) return res.status(404).json({ ok: false, error: 'unknown sender' });

    // 1b. Exact duplicate? (same email forwarded twice)
    if (message_id) {
      const dup = await select('phone_intakes',
        `user_id=eq.${userId}&message_id=eq.${encodeURIComponent(message_id)}&select=id,status`);
      if (dup.length) {
        return res.status(200).json({ ok: true, intake_id: dup[0].id, status: 'duplicate', reply_subject: null, reply_body: null });
      }
    }

    // 2. Settings row (insert-if-missing; inserts are not guarded)
    await insert('phone_settings', { user_id: userId }, 'resolution=ignore-duplicates,return=minimal');
    const [settings] = await select('phone_settings', `user_id=eq.${userId}&select=*`);

    // 3. Open the intake; store audio if we have it
    const [intake] = await insert('phone_intakes', {
      user_id: userId, source: 'voicemail_share', status: 'received',
      message_id: message_id || null,
      voicemail_at: voicemail_datetime || null,
    });
    intakeId = intake.id;

    let transcript;
    if (isAudio) {
      const buf = Buffer.from(attachment_base64, 'base64');
      const audioPath = await uploadAudio(`${userId}/${intakeId}.${mime.includes('wav') ? 'wav' : 'm4a'}`, buf, mime);
      await update('phone_intakes', `id=eq.${intakeId}`, { audio_path: audioPath });
      // 4a. Transcribe
      transcript = await transcribe(buf, mime);
      await insert('minute_ledger', { user_id: userId, intake_id: intakeId, kind: 'transcription', minutes: 1 }, 'return=minimal');
    } else {
      // 4b. Carrier transcript supplied as text
      transcript = textTranscript;
    }
    await update('phone_intakes', `id=eq.${intakeId}`, { transcript, status: 'transcribed' });

    // 5. Classify (every forward is treated as a scam by design)
    const a = await analyze(transcript);
    await update('phone_intakes', `id=eq.${intakeId}`, {
      archetype: a.archetype, confidence: a.confidence, is_scam: true,
      stated_numbers: a.stated_numbers, classification: { ...a, provenance }, status: 'classified',
    });

    // 6. No dialable number → nothing to dial
    if (!a.stated_numbers.length && a.international_numbers.length) {
      await update('phone_intakes', `id=eq.${intakeId}`, { status: 'rejected' });
      return res.status(200).json({ ok: true, intake_id: intakeId, status: 'international', ...replyFor('international', { subject, transcript, number: a.international_numbers[0] }) });
    }
    if (!a.stated_numbers.length) {
      await update('phone_intakes', `id=eq.${intakeId}`, { status: 'rejected' });
      return res.status(200).json({ ok: true, intake_id: intakeId, status: 'rejected', ...replyFor('rejected', { subject, transcript }) });
    }
    const number = a.stated_numbers[0];

    // 7. Shared scammer profile (+ archetype vote, column-scoped RPC), then the gate row
    await rpc('upsert_caller_profile', {
      p_e164: number, p_org: a.claimed_org || null, p_summary: a.script_summary || null,
      p_archetype: a.archetype, p_src: 'intake',
    });
    // Allowlist row is one-per-(user, number); many jobs may point at it.
    await sb('callback_numbers?on_conflict=user_id,e164', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, intake_id: intakeId, e164: number, provenance, caller_profile_id: number }),
      prefer: 'resolution=ignore-duplicates,return=minimal',
    });
    const [gate] = await select('callback_numbers', `user_id=eq.${userId}&e164=eq.${encodeURIComponent(number)}&select=id,blocked`);
    if (!gate || gate.blocked) {
      await update('phone_intakes', `id=eq.${intakeId}`, { status: 'rejected' });
      return res.status(200).json({ ok: true, intake_id: intakeId, status: 'rejected', ...replyFor('rejected', { subject, transcript }) });
    }

    // 8. The job. Delay window doubles as the user's cancel window.
    const minutes = rand(settings.callback_delay_min, settings.callback_delay_max);
    const scheduledAt = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    await insert('callback_jobs', {
      user_id: userId, intake_id: intakeId, callback_number_id: gate.id,
      archetype: a.archetype, scheduled_at: scheduledAt, status: 'approved',
      approved_at: new Date().toISOString(),
      reference_code: CODE_ARCHETYPES.includes(a.archetype) ? refCode() : null,
      host_name: host_name || null,
      dial_extension: a.extension,
      ask_for: a.ask_for,
      caller_context: {
        caller_name: a.agent_label || null,
        claimed_org: a.claimed_org || null,
        pitch: a.pitch || null,
        the_ask: a.the_ask || null,
        account_refs: a.account_refs,
        stated_hours: a.stated_hours || null,
        transcript,
      },
    }, 'return=minimal');
    await update('phone_intakes', `id=eq.${intakeId}`, { status: 'queued' });

    // 9. Tell Scouting about the number (non-blocking)
    await pingScout(number);

    return res.status(200).json({
      ok: true, intake_id: intakeId, status: 'queued',
      ...replyFor('queued', { subject, transcript, number, minutes, extension: a.extension, askFor: a.ask_for }),
    });
  } catch (err) {
    console.error('phone-intake', err);
    if (intakeId) { try { await update('phone_intakes', `id=eq.${intakeId}`, { status: 'rejected' }); } catch {} }
    return res.status(500).json({ ok: false, error: String(err.message || err), ...replyFor('error', {}) });
  }
}

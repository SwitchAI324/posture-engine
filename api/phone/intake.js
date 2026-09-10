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
const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;

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
- stated_hours_start: those hours as 24h "HH:MM" start, or null.
- stated_hours_end: those hours as 24h "HH:MM" end, or null.
- stated_tz: the time zone the caller named, as an IANA zone ("America/Los_Angeles", "America/New_York", "America/Chicago", "America/Denver"), or null if none named.
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

// ---------- Twilio line-type lookup (scheduling only; Scouting owns the profile column) ----------
async function lineTypeFor(e164) {
  if (!TWILIO_SID || !TWILIO_TOKEN) return null;
  try {
    const r = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`, {
      headers: { Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64') },
      signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return null;
    const t = (await r.json())?.line_type_intelligence?.type || '';
    if (t === 'mobile') return 'mobile';
    if (/voip/i.test(t)) return 'voip';
    if (t === 'landline') return 'landline';
    if (/tollfree/i.test(t)) return 'tollfree';
    return t || null;
  } catch { return null; }
}

// ---------- Call-window scheduling ----------
// Area code → IANA zone (US + Canada, NANP). Toll-free handled separately.
const AC = {};
const zone = (tz, codes) => codes.forEach(c => { AC[String(c)] = tz; });
zone('America/New_York', [201,202,203,207,212,215,216,220,223,234,239,240,267,272,276,301,302,304,305,321,326,330,331,332,336,339,340,347,351,352,380,386,401,404,407,410,412,413,419,434,440,443,470,475,478,484,502,508,513,516,517,518,551,561,570,571,585,586,603,606,607,609,610,614,616,617,631,646,678,681,689,703,704,706,716,717,718,724,727,732,734,740,743,754,757,762,770,772,774,781,786,787,802,803,804,810,813,814,828,838,843,845,848,854,856,857,859,860,862,863,864,878,904,906,908,910,912,914,917,919,929,931,934,937,939,941,947,954,959,970,971,973,978,980,984,989]);
zone('America/Chicago', [205,210,214,218,225,228,251,254,256,262,270,281,309,312,314,316,318,319,320,325,331,334,337,346,361,364,402,405,409,414,417,430,432,469,479,501,504,507,512,515,563,573,574,580,601,608,612,615,618,620,629,630,636,641,651,660,662,682,708,712,713,715,731,737,763,769,773,779,785,806,815,816,817,819,830,832,847,850,854,870,872,901,903,913,918,920,930,936,938,940,952,956,972,979,985]);
zone('America/Denver', [303,307,385,406,435,505,575,719,720,801,915,970]);
zone('America/Phoenix', [480,520,602,623,928]);
zone('America/Los_Angeles', [206,209,213,253,279,310,323,341,360,408,415,424,442,458,503,509,510,530,541,559,562,619,626,628,650,657,661,669,707,714,725,747,760,775,805,818,820,831,858,909,916,925,949,951,971,986]);
zone('America/Boise', [208]);
zone('America/Anchorage', [907]);
zone('Pacific/Honolulu', [808]);
zone('America/Toronto', [226,249,289,343,365,416,437,519,548,613,647,705,807,905]);
zone('America/Vancouver', [236,250,604,672,778]);
zone('America/Edmonton', [403,587,780,825]);
zone('America/Winnipeg', [204,431]);
zone('America/Regina', [306,639]);
zone('America/Halifax', [506,782,902]);
zone('America/Montreal', [418,438,450,514,579,581,819,873]);
const TOLLFREE = new Set(['800','833','844','855','866','877','888']);
const TZ_LABEL = {
  'America/New_York': 'Eastern', 'America/Toronto': 'Eastern', 'America/Montreal': 'Eastern',
  'America/Chicago': 'Central', 'America/Winnipeg': 'Central', 'America/Regina': 'Central',
  'America/Denver': 'Mountain', 'America/Phoenix': 'Arizona', 'America/Boise': 'Mountain', 'America/Edmonton': 'Mountain',
  'America/Los_Angeles': 'Pacific', 'America/Vancouver': 'Pacific',
  'America/Anchorage': 'Alaska', 'Pacific/Honolulu': 'Hawaii', 'America/Halifax': 'Atlantic',
};
const tzLabel = tz => TZ_LABEL[tz] || tz;

function partsInTz(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const o = {};
  for (const p of f.formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute, ss: +o.second, wd: o.weekday.toLowerCase() };
}
function zoned(y, m, d, hh, mm, tz) {  // local wall time in tz → Date
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const p = partsInTz(new Date(guess), tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return new Date(guess - (asUtc - guess));
}
const addDays = (y, m, d, n) => { const t = new Date(Date.UTC(y, m - 1, d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const hm = str => { const [h, m] = String(str || '').split(':').map(Number); return Number.isFinite(h) ? { h, m: m || 0 } : null; };
const clampHM = (t, lo, hi) => (t.h * 60 + t.m < lo * 60) ? { h: lo, m: 0 } : (t.h * 60 + t.m > hi * 60) ? { h: hi, m: 0 } : t;
const fmtHM = t => { const h12 = ((t.h + 11) % 12) + 1; return `${h12}:${String(t.m).padStart(2, '0')} ${t.h < 12 ? 'AM' : 'PM'}`; };
const dayName = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

function pickRule(rules, group, lineType) {
  const g = rules.filter(r => r.active && r.tz_source === group && (!r.line_type || r.line_type === lineType));
  if (!g.length) return null;
  const top = Math.min(...g.map(r => r.priority));
  const pool = g.filter(r => r.priority === top);
  const total = pool.reduce((n, r) => n + Math.max(1, r.weight || 1), 0);
  let roll = Math.random() * total;
  for (const r of pool) { roll -= Math.max(1, r.weight || 1); if (roll <= 0) return r; }
  return pool[pool.length - 1];
}

// Returns { scheduledAt: Date, window: {...}, phrase: string }
function planCallback({ number, a, settings, rules, lineType = null, now = new Date() }) {
  const delayMin = settings?.callback_delay_min ?? 20;
  const delayMax = settings?.callback_delay_max ?? 60;
  const delay = rand(delayMin, delayMax);
  const earliest = new Date(now.getTime() + delayMin * 60000);

  // Test override: tiny delay → ignore windows.
  if (delayMax <= 5) {
    const at = new Date(now.getTime() + delay * 60000);
    return { scheduledAt: at, window: { rule: 'test_override', tz: settings?.tz || 'America/New_York' }, phrase: `in about ${delay} minutes` };
  }

  const ac = /^\+1(\d{3})/.exec(number || '')?.[1];
  const hasStated = !!(a.stated_hours_start && a.stated_hours_end);
  let group, tz;
  if (hasStated) { group = 'stated'; tz = a.stated_tz || (ac && AC[ac]) || settings?.tz || 'America/New_York'; }
  else if (ac && TOLLFREE.has(ac)) { group = 'user'; tz = settings?.tz || 'America/New_York'; }
  else { group = 'area_code'; tz = (ac && AC[ac]) || settings?.tz || 'America/New_York'; }

  let rule = pickRule(rules, group, lineType) || pickRule(rules, 'area_code', lineType) || pickRule(rules, 'area_code', null)
    || { name: 'fallback_business', tz_source: 'area_code', start_local: '09:00', end_local: '16:30', target: 'random', target_minutes: null, days: ['mon','tue','wed','thu','fri'] };

  let start = hasStated && rule.tz_source === 'stated' ? hm(a.stated_hours_start) : hm(rule.start_local);
  let end = hasStated && rule.tz_source === 'stated' ? hm(a.stated_hours_end) : hm(rule.end_local);
  if (!start || !end) { start = { h: 9, m: 0 }; end = { h: 16, m: 30 }; }
  start = clampHM(start, 8, 21); end = clampHM(end, 8, 21);
  if (end.h * 60 + end.m <= start.h * 60 + start.m) end = { h: Math.min(21, start.h + 8), m: start.m };
  const days = (rule.days && rule.days.length) ? rule.days : ['mon','tue','wed','thu','fri'];

  const today = partsInTz(now, tz);
  for (let i = 0; i < 10; i++) {
    const d = addDays(today.y, today.m, today.d, i);
    const wd = partsInTz(zoned(d.y, d.m, d.d, 12, 0, tz), tz).wd;
    if (!days.includes(wd)) continue;
    const winStart = zoned(d.y, d.m, d.d, start.h, start.m, tz);
    const winEnd = zoned(d.y, d.m, d.d, end.h, end.m, tz);

    let target = null, phraseTime = null;
    if (rule.target === 'end_minus') {
      target = new Date(winEnd.getTime() - (rule.target_minutes || 5) * 60000);
      if (target < earliest) continue;
      phraseTime = fmtHM(partsInTz(target, tz) && { h: partsInTz(target, tz).hh, m: partsInTz(target, tz).mm });
    } else if (rule.target === 'start_plus') {
      target = new Date(winStart.getTime() + (rule.target_minutes || 0) * 60000);
      if (target < earliest) continue;
      phraseTime = fmtHM({ h: partsInTz(target, tz).hh, m: partsInTz(target, tz).mm });
    } else {
      const lo = Math.max(winStart.getTime(), earliest.getTime());
      const hi = winEnd.getTime();
      if (lo >= hi) continue;
      target = new Date(lo + Math.random() * (hi - lo));
    }

    const isToday = i === 0;
    const isTomorrow = i === 1;
    const dayWord = isToday ? 'today' : isTomorrow ? 'tomorrow' : dayName[wd];
    const fromHM = i === 0 && earliest > winStart ? { h: partsInTz(earliest, tz).hh, m: partsInTz(earliest, tz).mm } : start;
    const phrase = phraseTime
      ? `${dayWord} at ${phraseTime} ${tzLabel(tz)}`
      : `${dayWord} between ${fmtHM(fromHM)} and ${fmtHM(end)} ${tzLabel(tz)}`;
    const window = { rule: rule.name, tz, tz_source: group, line_type: lineType, start: `${String(start.h).padStart(2,'0')}:${String(start.m).padStart(2,'0')}`, end: `${String(end.h).padStart(2,'0')}:${String(end.m).padStart(2,'0')}`, day: `${d.y}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`, stated: hasStated ? a.stated_hours : null };
    return { scheduledAt: target, window, phrase, pastHours: hasStated && i > 0 };
  }
  // Nothing fit in 10 days (shouldn't happen): fall back to delay.
  const at = new Date(now.getTime() + delay * 60000);
  return { scheduledAt: at, window: { rule: 'fallback_delay', tz }, phrase: `in about ${delay} minutes` };
}

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

${ctx.pastHours ? `They said ${ctx.stated} and it's past that, so we'll` : `We'll`} call ${pretty(ctx.number)}${ctx.extension ? `, extension ${ctx.extension}` : ''}${ctx.askFor ? `, asking for ${ctx.askFor}` : ''} ${ctx.phrase}.
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
    // 1. Who is this user? The allowlist (sv_users.is_test_user) is created
    //    by Andrew's add-tester query, so a tester's row already exists by
    //    the time they forward. An unknown sender is refused outright.
    const email = String(sender_email).trim().toLowerCase();
    const userId = await rpc('user_id_by_email', { p_email: email });
    if (!userId) return res.status(404).json({ ok: false, error: 'unknown sender' });
    const [account] = await select('sv_users', `id=eq.${userId}&select=is_test_user,daily_job_cap,host_name`);

    // 1a. Per-user daily cap — jobs created in the last 24h.
    const cap = account?.daily_job_cap ?? 10;
    const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const todays = await select('callback_jobs',
      `user_id=eq.${userId}&created_at=gte.${since24}&select=id`).catch(() => []);
    if (todays.length >= cap) {
      return res.status(200).json({
        ok: true, status: 'rejected',
        reply_subject: 'Re: ' + (subject || 'your forwarded voicemail'),
        reply_body: `You've hit today's limit of ${cap} callbacks. Try again tomorrow.\n\n— SpamViking`,
      });
    }

    // 1b. Exact duplicate? (same email forwarded twice)
    if (message_id) {
      const dup = await select('phone_intakes',
        `user_id=eq.${userId}&message_id=eq.${encodeURIComponent(message_id)}&select=id,status`);
      if (dup.length) {
        return res.status(200).json({ ok: true, intake_id: dup[0].id, status: 'duplicate', reply_subject: null, reply_body: null });
      }
    }

    // 2. Settings row, defensively (the add-tester query also creates it;
    //    both are idempotent). Delay comes from whatever is on the row.
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

    // 8. The job. Window from callback_time_rules; the wait doubles as the cancel window.
    const rules = await select('callback_time_rules', 'active=eq.true&select=*').catch(() => []);
    const lineType = await lineTypeFor(number);
    const plan = planCallback({ number, a, settings, rules, lineType });
    const scheduledAt = plan.scheduledAt.toISOString();
    await insert('callback_jobs', {
      user_id: userId, intake_id: intakeId, callback_number_id: gate.id,
      archetype: a.archetype, scheduled_at: scheduledAt, status: 'approved',
      dial_window: plan.window,
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
        stated_tz: a.stated_tz || null,
        transcript,
      },
    }, 'return=minimal');
    await update('phone_intakes', `id=eq.${intakeId}`, { status: 'queued' });

    // 9. Tell Scouting about the number (non-blocking)
    await pingScout(number);

    return res.status(200).json({
      ok: true, intake_id: intakeId, status: 'queued',
      ...replyFor('queued', { subject, transcript, number, phrase: plan.phrase, pastHours: plan.pastHours, stated: a.stated_hours, extension: a.extension, askFor: a.ask_for }),
    });
  } catch (err) {
    console.error('phone-intake', err);
    if (intakeId) { try { await update('phone_intakes', `id=eq.${intakeId}`, { status: 'rejected' }); } catch {} }
    return res.status(500).json({ ok: false, error: String(err.message || err), ...replyFor('error', {}) });
  }
}

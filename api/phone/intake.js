// BUILD: intake v1 2026-10-07
// api/phone/intake.js
// Phone Intake v1 (voicemail share) + text/screenshot/SMS link reading and
// dial-with-warn-first (v1.2).
//
// Three intake shapes hit this one endpoint:
//
// (A) Voicemail share — called when a message to raid@spamviking.com
//     carries a voicemail, either as an audio attachment or a carrier text
//     transcript in the body:
//   POST JSON (audio): { sender_email, subject, attachment_base64,
//                        attachment_mime, host_name, message_id?,
//                        voicemail_datetime? }
//   POST JSON (text):  { sender_email, subject, transcript, host_name,
//                        message_id?, voicemail_datetime? }
//   Full pipeline: transcribe (if audio) -> classify -> find a dialable
//   callback number -> schedule a callback job.
//
// (B) raid@ scam text/screenshot share — called for a forwarded text
//     message (screenshot and/or pasted) that isn't a voicemail:
//   POST JSON: { sender_email, subject, text_message?, media?, host_name,
//                message_id? }
//     text_message — typed/pasted text, may be empty if it's screenshot-only
//     media[]      — [{content_type, filename, data_base64}], bytes already
//                    in hand, up to 4 images, normalized in _ocr.js.
//   Every image in media[] is OCR'd (_ocr.js, Claude vision, in order — a
//   scam text split across several screenshots reassembles correctly) and
//   combined with text_message. From there, two independent things happen
//   (shared with path C below, see analyze()/processLinks() calls there):
//     - Links (always, read-only): up to 3 links are read server-side
//       (phone UA, no forms/downloads), summarized by Claude, and stored in
//       link_reads for Andrew to review. A phone number found ON A LINKED
//       PAGE is reference only — never a dial target, never touches
//       callback_numbers/callback_jobs. Whether that ever changes is an
//       open decision, not something this code assumes.
//     - A number stated directly IN THE TEXT (not from a link) — dial-
//       eligible, gated by phone_settings.slip_guard_screenshot (defaults
//       ON/true if the column is missing or null). When eligible, it goes
//       through the exact same callback_numbers/callback_jobs pipeline as
//       a voicemail: same delay-window-doubles-as-cancel-window mechanic.
//   Reply delivery: reply_body, relayed verbatim by Barbara's Apps Script.
//
// (C) SMS (source:'sms') — handled entirely by handleSms(), a different
//     payload shape (user_id given directly, no email lookup):
//   POST JSON: { source:'sms', user_id, enrolled, from_e164, to_e164,
//                message_sid, text, command, media?, received_at }
//     command  — SKIP | BLOCK | RETRY | GO when the whole text was that
//                word (case-insensitive); acts on an existing job, creates
//                no intake. GO = stop waiting out the cancel window, dial
//                now. Unknown/other words are never in this field — SMS
//                chat only forwards those four.
//     no command — content forward, same OCR + link-read + dial-eligible-
//                number pipeline as path B, just with SMS-length reply
//                copy (smsReplyForContent) instead of the email templates.
//                Never dials from_e164 — only a number stated IN the text.
//   media[]  — [{url, content_type}], a signed URL already downloaded from
//              Twilio; same _ocr.js normalizes both shapes.
//   Reply delivery: reply_body is used ONLY if this endpoint answers within
//   ~4s (SMS_REPLY_BUDGET_MS) — SMS chat gives up waiting at 5s and shows
//   its own generic "got it" instead. OCR/link-reading can easily run
//   longer than that, so when it does, this code skips reply_body (it
//   would be ignored anyway) and instead POSTs the real result to
//   /api/phone/sms-send as a follow-up text. Command replies are fast
//   (one DB read/write) and always go via reply_body.
//
// Duplicate (same sender + message_id, or same user_id + message_sid,
// already seen) -> 200 { ok:true, status:'duplicate', reply_body:null }.
// Header: x-phone-intake-secret: <PHONE_INTAKE_SECRET> (all three paths).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEEPGRAM_API_KEY,
//      ANTHROPIC_API_KEY, ANTHROPIC_MODEL (optional), PHONE_INTAKE_SECRET,
//      SV_SCOUT_TOKEN (for the Scouting ping), PHONE_SMS_SEND_URL (optional,
//      defaults to the posture-engine host).
//
// Writes only INSERTs to guarded tables (guard is BEFORE UPDATE), plus
// updates to phone_intakes (unguarded) and Data's two RPCs. caller_profile
// is written ONLY via upsert_caller_profile (column-scoped, vote append).
// link_reads is INSERT-only from here, keyed on intake_id (a link-only
// intake creates no callback job). Requires phone_settings to have a
// slip_guard_screenshot boolean column (nullable/missing = treated as
// true/on) — confirm with Data before deploying if unsure it exists.

import { planCallback, lineTypeFor, rand, refCode } from './_schedule.js';
import { processLinks } from './_links.js';
import { ocrMedia } from './_ocr.js';
import { actionCancel, actionBlock, actionRetry, actionGo } from './_actions.js';

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEEPGRAM = process.env.DEEPGRAM_API_KEY;
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const SECRET = process.env.PHONE_INTAKE_SECRET;
const SCOUT_TOKEN = process.env.SV_SCOUT_TOKEN;
const SCOUT_URL = process.env.SCOUT_PHONE_URL || 'https://posture-engine.vercel.app/api/scout/phone';
const SMS_SEND_URL = process.env.PHONE_SMS_SEND_URL || 'https://posture-engine.vercel.app/api/phone/sms-send';
const SMS_REPLY_BUDGET_MS = 4000; // stay under SMS chat's 5s immediate-reply window

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
// kind: 'voicemail' (spoken audio/carrier transcript) or 'text' (a typed
// message and/or OCR'd screenshot text). Wording adjusts to match; the
// output shape is identical either way.
//
// pitch_topic and amount_mentioned (added Sep 29, 2026, Recording's ask)
// exist to build the intake acknowledgement email's subject/summary line
// without ever showing the carrier's raw attachment filename or restating
// the full one-sentence `pitch` field, which reads fine in a body but is
// too long/formal for a subject line or a one-line "here's what we pulled"
// summary.
async function analyze(content, kind = 'voicemail') {
  const noun = kind === 'text' ? 'message' : 'voicemail';
  const speaker = kind === 'text' ? 'sender' : 'speaker';
  const system = `You classify scam ${noun}s. Respond with a single JSON object and nothing else — no prose, no code fences.
Fields:
- archetype: one of ${ARCHETYPES.join(', ')}. Precision over recall: use "generic" unless clearly one of the others.
- confidence: number 0..1 that the archetype is right.
- stated_numbers: phone numbers the ${speaker.toUpperCase()} explicitly gives as a number to call back, in E.164 with country code (+1XXXXXXXXXX for US/Canada, +44... etc). Only numbers actually written/spoken in the ${noun} itself — never a number that only appears as part of a URL or link. Empty array if none.
- number_count: how many times the primary callback number appears.
- extension: digits to try if a menu answers the callback number: either digits the ${speaker} says to enter after the number connects ("press 4", "extension 204"), OR a digit offered during THIS ${noun} as an alternative to calling the number ("press 2 or call me back at 555-0100" → extension "2") — that second case is a same-call option, not a confirmed menu step on the callback line itself, so only capture it when it's the one digit mentioned (don't guess if multiple digits are offered for different purposes). As a digit string, or null.
- ask_for: the person and/or department the ${speaker} says to ask for ("Jim in the fraud department"), or null.
- claimed_org: the organization the ${speaker} claims to be from, or null.
- agent_label: the name the ${speaker} gives for themselves ("this is Steve"), or null.
- account_refs: any account, case, reference, or invoice numbers the ${speaker} cites, as strings. Empty array if none.
- reference_number: if one specific reference/case/claim/file number is the one the recipient should quote back when calling ("your case number is 520014695395"), that number as a string, or null. Usually one of the values in account_refs — pulled out here so it's easy to quote verbatim instead of picking through a list.
- amount_mentioned: a specific dollar amount the ${speaker} mentions, written naturally as it would appear in a sentence (e.g. "$215,000"), or null if no specific amount is stated.
- garbled_number: true if the ${speaker} says or references a callback number but it comes through unclear, cut off, talked-over, or otherwise unparseable — you can tell a number was meant but can't confidently produce digits for it. False if no number was mentioned at all, or if a number came through cleanly.
- stated_hours: the hours the ${speaker} says to call back, verbatim ("8AM to 5PM Pacific"), or null.
- stated_hours_start: those hours as 24h "HH:MM" start, or null.
- stated_hours_end: those hours as 24h "HH:MM" end, or null.
- stated_tz: the time zone the ${speaker} named, as an IANA zone ("America/Los_Angeles", "America/New_York", "America/Chicago", "America/Denver"), or null if none named.
- pitch_topic: a short 2-4 word label for what's being pitched, in plain everyday words a recipient would recognize at a glance ("business financing", "irs back taxes", "crypto investment", "amazon account issue"), or null if it doesn't cleanly reduce to a short label.
- pitch: one short sentence, what the ${speaker} claims is going on.
- the_ask: one short sentence, what the ${speaker} wants the recipient to do.
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
      messages: [{ role: 'user', content: `${kind === 'text' ? 'Message text' : 'Voicemail transcript'}:\n\n${content}` }],
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
  j.reference_number = typeof j.reference_number === 'string' && j.reference_number.trim() ? j.reference_number.trim().slice(0, 40) : null;
  j.pitch_topic = typeof j.pitch_topic === 'string' && j.pitch_topic.trim() ? j.pitch_topic.trim().slice(0, 40) : null;
  j.amount_mentioned = typeof j.amount_mentioned === 'string' && j.amount_mentioned.trim() ? j.amount_mentioned.trim().slice(0, 20) : null;
  j.garbled_number = j.garbled_number === true;
  return j;
}

// refCode() now lives in _schedule.js (imported above) — shared with
// _actions.js's actionSupplyNumber(), which also plants a reference code
// when it creates a job. Was previously duplicated here and, before that,
// called without being defined anywhere.

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

// ---------- SMS follow-up send (used when a result arrives too late for
// SMS chat's 5s immediate-reply window, and for anything that's always a
// follow-up by nature — none of those live in this file yet, but the
// command replies below could time out too on a slow DB). ----------
async function smsSend(userId, text) {
  try {
    await fetch(SMS_SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-phone-intake-secret': SECRET },
      body: JSON.stringify({ user_id: userId, text }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.warn('sms-send failed (non-fatal)', String(e.message || e));
  }
}

// Compact, SMS-length reply for a content forward (text and/or screenshots,
// no command word). Mirrors replyForTextShare's logic but much shorter —
// no "here's what we read" quote, no email sign-off.
function smsReplyForContent(linkRows, dial, skippedImages) {
  const parts = [];
  if (linkRows.length) {
    const first = linkRows[0];
    if (first.fetch_status === 'skipped_non_web') parts.push('Link check: not a webpage, skipped.');
    else if (first.fetch_status === 'error') parts.push('Link check: couldn\'t load it.');
    else if (first.summary) parts.push(`Link check: ${first.summary}`);
    if (first.phone_found) parts.push(`Phone shown: ${first.phone_found} (not calling it).`);
    if (linkRows.length > 1) parts.push(`(+${linkRows.length - 1} more link${linkRows.length > 2 ? 's' : ''} checked.)`);
  } else {
    parts.push('No link found.');
  }
  if (dial.kind === 'queued') {
    parts.push(`We'll call ${pretty(dial.number)} soon. Reply SKIP to stop, GO to stop waiting, BLOCK to never call it.`);
  } else if (dial.kind === 'international') {
    parts.push(`Number found (${dial.number}) is outside the US — not calling it.`);
  } else if (dial.kind === 'blocked') {
    parts.push(`${pretty(dial.number)} is on your block list — not calling.`);
  }
  if (skippedImages) parts.push(`(${skippedImages} image${skippedImages > 1 ? 's' : ''} unreadable.)`);
  return parts.join(' ');
}

// ---------- SMS entry point (source:'sms') ----------
// Separate payload shape from raid@: user_id is given directly (no email
// lookup — SMS chat has already resolved/enrolled the user), message_sid
// stands in for message_id, and a bare command word (SKIP/BLOCK/RETRY/GO)
// means act on an existing job rather than intake new content. Reply
// delivery: fast results go back as reply_body (SMS chat relays it if it
// arrives within ~5s); anything slower is pushed via sms-send instead, so
// the user gets it as a follow-up text rather than losing it to the
// timeout.
async function handleSms(req, res) {
  const t0 = Date.now();
  const { user_id: userId, from_e164, message_sid, text, command, media } = req.body || {};
  if (!userId) return res.status(400).json({ ok: false, error: 'user_id required' });
  const mediaArr = Array.isArray(media) ? media : [];
  const textIn = typeof text === 'string' ? text.trim() : '';
  const cmd = typeof command === 'string' ? command.toUpperCase() : null;

  try {
    const [account] = await select('sv_users', `id=eq.${userId}&select=id,daily_job_cap,host_name`);
    if (!account) return res.status(404).json({ ok: false, error: 'unknown user_id' });

    // Dedup on message_sid, same idea as raid@'s message_id dedup.
    if (message_sid) {
      const dup = await select('phone_intakes', `user_id=eq.${userId}&message_id=eq.${encodeURIComponent(message_sid)}&select=id`);
      if (dup.length) return res.status(200).json({ ok: true, intake_id: dup[0].id, status: 'duplicate', reply_body: null });
    }

    // ---------------------------------------------------------------
    // Command words act on an existing job — never create an intake.
    // ---------------------------------------------------------------
    if (cmd) {
      if (cmd === 'SKIP') {
        const r = await actionCancel(userId);
        return res.status(200).json({ ok: true, status: 'action', reply_body: r.done ? 'Skipped — we won\'t call that number.' : 'Nothing pending to skip.' });
      }
      if (cmd === 'BLOCK') {
        const r = await actionBlock(userId);
        return res.status(200).json({ ok: true, status: 'action', reply_body: r.done ? `Blocked — we'll never call ${pretty(r.number)} again.` : 'Nothing recent to block.' });
      }
      if (cmd === 'RETRY') {
        const r = await actionRetry(userId);
        if (!r.done) {
          return res.status(200).json({ ok: true, status: 'action', reply_body: r.reason === 'blocked' ? `${pretty(r.number)} is on your block list — not calling.` : 'Nothing recent to retry.' });
        }
        return res.status(200).json({ ok: true, status: 'action', reply_body: `On it — calling ${pretty(r.number)} again in about ${r.minutes} min.` });
      }
      if (cmd === 'GO') {
        const r = await actionGo(userId);
        return res.status(200).json({ ok: true, status: 'action', reply_body: r.done ? `On it — calling ${pretty(r.number)} ${r.soon ? 'now' : r.phrase}.` : 'Nothing pending to call now.' });
      }
      // Contract says only SKIP/BLOCK/RETRY/GO arrive here — don't silently
      // drop an unrecognized word, surface it instead.
      return res.status(400).json({ ok: false, error: `unknown command: ${cmd}` });
    }

    // ---------------------------------------------------------------
    // Content forward — same OCR + link-read + dial-eligible-number
    // pipeline as raid@'s path (B), just with SMS-length reply copy.
    // ---------------------------------------------------------------
    if (!textIn && !mediaArr.length) {
      return res.status(400).json({ ok: false, error: 'text or media required' });
    }
    await insert('phone_settings', { user_id: userId }, 'resolution=ignore-duplicates,return=minimal');
    const [settings] = await select('phone_settings', `user_id=eq.${userId}&select=*`);

    const [intake] = await insert('phone_intakes', {
      user_id: userId, source: 'sms', status: 'received', message_id: message_sid || null,
    });
    const intakeId = intake.id;

    let ocrPages = [];
    let combinedText = textIn;
    if (mediaArr.length) {
      const ocrResult = await ocrMedia(mediaArr, { anthropicKey: ANTHROPIC, model: MODEL });
      ocrPages = ocrResult.pages;
      combinedText = [textIn, ocrResult.combined_text].filter(Boolean).join('\n\n');
    }
    await update('phone_intakes', `id=eq.${intakeId}`, { transcript: combinedText || null });

    const linkRows = combinedText
      ? await processLinks(combinedText, { anthropicKey: ANTHROPIC, model: MODEL })
      : [];
    if (linkRows.length) {
      await insert('link_reads', linkRows.map(row => ({ ...row, intake_id: intakeId })), 'return=minimal');
    }

    const slipGuardOn = settings?.slip_guard_screenshot !== false;
    let dial = { kind: 'none' };
    if (combinedText && slipGuardOn) {
      const b = await analyze(combinedText, 'text');
      await update('phone_intakes', `id=eq.${intakeId}`, {
        archetype: b.archetype, confidence: b.confidence, is_scam: true,
        stated_numbers: b.stated_numbers, classification: { ...b, provenance: 'stated_in_sms' },
      });

      if (!b.stated_numbers.length && b.international_numbers.length) {
        dial = { kind: 'international', number: b.international_numbers[0] };
      } else if (b.stated_numbers.length && b.stated_numbers[0] !== from_e164) {
        // Guard restated: never dial the number this message came FROM,
        // only a number stated in its content.
        const number = b.stated_numbers[0];
        await rpc('upsert_caller_profile', {
          p_e164: number, p_org: b.claimed_org || null, p_summary: b.script_summary || null,
          p_archetype: b.archetype, p_src: 'intake',
        });
        await sb('callback_numbers?on_conflict=user_id,e164', {
          method: 'POST',
          body: JSON.stringify({ user_id: userId, intake_id: intakeId, e164: number, provenance: 'stated_in_sms', caller_profile_id: number }),
          prefer: 'resolution=ignore-duplicates,return=minimal',
        });
        const [gate] = await select('callback_numbers', `user_id=eq.${userId}&e164=eq.${encodeURIComponent(number)}&select=id,blocked`);
        if (!gate || gate.blocked) {
          dial = { kind: 'blocked', number };
        } else {
          const rules = await select('callback_time_rules', 'active=eq.true&select=*').catch(() => []);
          const lineType = await lineTypeFor(number);
          const plan = planCallback({ number, a: b, settings, rules, lineType });
          await insert('callback_jobs', {
            user_id: userId, intake_id: intakeId, callback_number_id: gate.id,
            archetype: b.archetype, scheduled_at: plan.scheduledAt.toISOString(), status: 'approved',
            dial_window: plan.window, approved_at: new Date().toISOString(),
            reference_code: b.reference_number || (CODE_ARCHETYPES.includes(b.archetype) ? refCode() : null),
            reference_code_origin: b.reference_number ? 'echoed' : (CODE_ARCHETYPES.includes(b.archetype) ? 'issued' : null),
            host_name: account.host_name || null, dial_extension: b.extension, ask_for: b.ask_for,
            campaign_touch: 1, campaign_parent_id: null,
            caller_context: {
              caller_name: b.agent_label || null, claimed_org: b.claimed_org || null,
              pitch: b.pitch || null, the_ask: b.the_ask || null, account_refs: b.account_refs,
              reference_number: b.reference_number || null,
              stated_hours: b.stated_hours || null, stated_tz: b.stated_tz || null, transcript: combinedText,
            },
          }, 'return=minimal');
          await pingScout(number);
          dial = { kind: 'queued', number, phrase: plan.phrase, pastHours: plan.pastHours, extension: b.extension, askFor: b.ask_for };
        }
      }
    }

    const status = dial.kind === 'queued' ? 'queued' : (linkRows.length ? 'link_read' : 'no_links');
    await update('phone_intakes', `id=eq.${intakeId}`, { status });

    const skippedImages = ocrPages.filter(p => p.skipped_reason).length;
    const smsText = smsReplyForContent(linkRows, dial, skippedImages);
    const elapsed = Date.now() - t0;
    if (elapsed > SMS_REPLY_BUDGET_MS) {
      // Too slow for their immediate-reply window — SMS chat has already
      // shown its own generic ack by now, so deliver the real content as a
      // follow-up text instead of a reply_body that would be ignored.
      await smsSend(userId, smsText);
      return res.status(200).json({ ok: true, intake_id: intakeId, status, reply_body: null });
    }
    return res.status(200).json({ ok: true, intake_id: intakeId, status, reply_body: smsText });
  } catch (err) {
    console.error('phone-intake (sms)', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

// ---------- helpers ----------

// Used in reply copy (existing 'queued' template already called this
// without it being defined anywhere in this file — same bug class as
// refCode above). Matches the copy already used in recap.js/cancel.js.
const pretty = e164 => /^\+1\d{10}$/.test(e164 || '') ? `${e164.slice(2, 5)}-${e164.slice(5, 8)}-${e164.slice(8)}` : (e164 || 'that number');

const firstName = label => {
  const s = (label || '').trim();
  return s ? s.split(/\s+/)[0] : null;
};

// Subject line for the voicemail-intake acknowledgement (Sep 29, 2026,
// Recording's ask). Built from what the classifier pulled out of the
// transcript — never the carrier's raw attachment filename. Falls back to
// a plain line when pitch_topic didn't parse, rather than guessing at
// content we didn't actually extract.
function queuedSubject(a) {
  if (!a.pitch_topic) return "Got it — we're on it.";
  const who = firstName(a.agent_label);
  let subj = who ? `Got it — ${who}, ${a.pitch_topic}. The raid begins.` : `Got it — ${a.pitch_topic}. The raid begins.`;
  if (subj.length > 60) subj = who ? `Got it — ${who}, ${a.pitch_topic}.` : `Got it — ${a.pitch_topic}.`;
  if (subj.length > 60) subj = subj.slice(0, 57) + '...';
  return subj;
}

function replyFor(status, ctx) {
  if (status === 'queued') {
    const {
      subject, transcript, number, extension, askFor, pastHours, stated, phrase,
      minutesUntil, callerName, pitchTopic, amount,
    } = ctx;
    const reply_subject = queuedSubject({ agent_label: callerName, pitch_topic: pitchTopic });

    // Extraction failed to produce a usable pitch topic — fall back to the
    // original transcript-first body wholesale rather than guessing at a
    // summary we don't actually have.
    if (!pitchTopic) {
      return {
        reply_subject,
        reply_body:
`Got it. Here's what we heard:

"${transcript}"

${pastHours ? `They said ${stated} and it's past that, so we'll` : `We'll`} call ${pretty(number)}${extension ? `, extension ${extension}` : ''}${askFor ? `, asking for ${askFor}` : ''} ${phrase}.
If that's the wrong number or you'd rather we didn't, reply SKIP.

— SpamViking`,
      };
    }

    const intro = `SpamViking received your voicemail${callerName ? ` from ${firstName(callerName)}` : ''} about ${pitchTopic}. The raid begins now.`;
    const detailsLine = `${callerName || 'The caller'}, claiming to offer ${pitchTopic}${amount ? ` up to ${amount}` : ''}, asking you to call ${pretty(number)}${extension ? `, extension ${extension}` : ''}${askFor ? `, and to ask for ${askFor}` : ''}.`;
    const nextSteps = `${pastHours ? `They said ${stated} and it's past that, so ` : ''}Your host will call them back ${phrase}, in character — we'll email you when the call is done.`;
    const cancelLine = `Don't want us to call? Reply SKIP in the next ${minutesUntil} minute${minutesUntil === 1 ? '' : 's'} and we'll drop it.`;

    return {
      reply_subject,
      reply_body: [
        intro,
        detailsLine,
        nextSteps,
        cancelLine,
        '---',
        'What they actually said:',
        `"${transcript}"`,
      ].join('\n\n') + '\n\n— SpamViking',
    };
  }

  const subj = 'Re: ' + (ctx.subject || 'your forwarded voicemail');
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
  if (status === 'needs_number') {
    return {
      reply_subject: subj,
      reply_body:
`Got it. Here's what we heard:

"${ctx.transcript}"

We heard a number in there but couldn't read it cleanly — just reply to
this email with the number and we'll call it.

— SpamViking

---
[SV-PHONE job:${ctx.intakeId}]`,
    };
  }
  return { reply_subject: subj, reply_body: 'Something went wrong on our side. We\'ll look into it.' };
}

// Reply for the text/screenshot path (B): link findings (always read-only)
// plus, when applicable, the warn-before-dial line for a number found
// directly in the text (dial.kind: 'none' | 'queued' | 'international' |
// 'blocked'). Untouched by the Sep 29, 2026 intake-acknowledgement rework
// — that was scoped to the voicemail-share path only.
function replyForTextShare(subject, textMessage, linkRows, skippedImages, dial) {
  const subj = 'Re: ' + (subject || 'your forwarded text');
  const skippedNote = skippedImages
    ? `\n\n(${skippedImages} image${skippedImages > 1 ? 's' : ''} couldn't be read — unsupported format or too large.)`
    : '';

  if (!textMessage) {
    return {
      reply_subject: subj,
      reply_body:
`Got it, but we couldn't read any text out of what you sent (no readable
text on the image${skippedImages > 1 ? 's' : ''}, or nothing came through).${skippedNote}

— SpamViking`,
    };
  }

  const linkBlocks = linkRows.map((row, i) => {
    if (row.fetch_status === 'skipped_non_web') {
      return `${i + 1}. ${row.url}\n   (not a webpage — skipped, e.g. an app install file or PDF)`;
    }
    if (row.fetch_status === 'error') {
      return `${i + 1}. ${row.url}\n   (couldn't load it)`;
    }
    const lines = [`${i + 1}. ${row.url}`];
    if (row.page_title) lines.push(`   Page: ${row.page_title}`);
    if (row.summary) lines.push(`   What it looks like: ${row.summary}`);
    if (row.phone_found) lines.push(`   Phone number shown on the page: ${row.phone_found} (not being called — for your review only)`);
    return lines.join('\n');
  });
  const linkSection = linkRows.length
    ? `Here's what we found at the link${linkRows.length > 1 ? 's' : ''}:\n\n${linkBlocks.join('\n\n')}`
    : `We didn't find a link in that.`;

  let dialSection = '';
  if (dial.kind === 'queued') {
    dialSection = `\n\n${dial.pastHours ? `They said ${dial.stated} and it's past that, so we'll` : `We'll`} call ${pretty(dial.number)}${dial.extension ? `, extension ${dial.extension}` : ''}${dial.askFor ? `, asking for ${dial.askFor}` : ''} ${dial.phrase}.\nIf that's the wrong number or you'd rather we didn't, reply SKIP.`;
  } else if (dial.kind === 'international') {
    dialSection = `\n\nThe number in that message, ${dial.number}, is outside the US. We're US-only right now — international is coming. Nothing will be dialed.`;
  } else if (dial.kind === 'blocked') {
    dialSection = `\n\n${pretty(dial.number)} is on your do-not-call list, so we won't dial it.`;
  }

  return {
    reply_subject: subj,
    reply_body:
`Got it. Here's what we read:

"${textMessage}"

${linkSection}

${linkRows.length ? 'Nothing has been called or contacted off a link — we\'re just showing you what\'s there so you can decide how to handle it.' : ''}${dialSection}${skippedNote}

— SpamViking`,
  };
}

// ---------- handler ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!SECRET || req.headers['x-phone-intake-secret'] !== SECRET) {
    return res.status(401).json({ ok: false, error: 'bad secret' });
  }

  // SMS payloads are shaped completely differently (user_id direct, no
  // sender_email, message_sid, command words) — route them off separately
  // rather than threading a third shape through the raid@ destructuring
  // below.
  if (req.body?.source === 'sms') {
    return handleSms(req, res);
  }

  const { sender_email, subject, attachment_base64, attachment_mime, host_name,
          message_id, voicemail_datetime } = req.body || {};
  const textTranscript = typeof req.body?.transcript === 'string' ? req.body.transcript.trim() : '';
  const textMessage = typeof req.body?.text_message === 'string' ? req.body.text_message.trim() : '';
  const media = Array.isArray(req.body?.media) ? req.body.media : [];
  const isAudio = !!attachment_base64;
  if (!sender_email || (!isAudio && !textTranscript && !textMessage && !media.length)) {
    return res.status(400).json({ ok: false, error: 'sender_email plus attachment_base64, transcript, text_message, or media required' });
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

    // 1a. Per-user daily cap — jobs created in the last 24h. Applies to both
    //     paths so one user can't flood either the dialer or the link reader.
    const cap = account?.daily_job_cap ?? 10;
    const since24 = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const todays = await select('phone_intakes',
      `user_id=eq.${userId}&created_at=gte.${since24}&select=id`).catch(() => []);
    if (todays.length >= cap) {
      return res.status(200).json({
        ok: true, status: 'rejected',
        reply_subject: 'Re: ' + (subject || 'your forwarded message'),
        reply_body: `You've hit today's limit of ${cap} forwards. Try again tomorrow.\n\n— SpamViking`,
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

    // Settings row, defensively (the add-tester query also creates it; both
    // are idempotent). Both paths below need it — the delay/cancel window
    // for path A, and the slip_guard_screenshot gate + same delay window
    // for path B's dial branch.
    await insert('phone_settings', { user_id: userId }, 'resolution=ignore-duplicates,return=minimal');
    const [settings] = await select('phone_settings', `user_id=eq.${userId}&select=*`);

    // ---------------------------------------------------------------
    // PATH (B): scam text (typed and/or screenshots). Link-reading is
    // always read-only. A number stated directly in the text (not from a
    // link) is dial-eligible, warn-first, gated by slip_guard_screenshot —
    // defaults ON. Never dials a number found only on a linked page, and
    // never dials the message's own from_e164 (relevant once the SMS
    // source is wired in — email forwards have no from_e164 to guard
    // against, so this only matters there).
    // ---------------------------------------------------------------
    if ((textMessage || media.length) && !isAudio && !textTranscript) {
      const [intake] = await insert('phone_intakes', {
        user_id: userId, source: 'text_share', status: 'received',
        message_id: message_id || null,
      });
      intakeId = intake.id;

      // OCR every screenshot first (in order), then combine with any typed
      // text — a scam link or number can land in either.
      let ocrPages = [];
      let combinedText = textMessage;
      if (media.length) {
        const ocrResult = await ocrMedia(media, { anthropicKey: ANTHROPIC, model: MODEL });
        ocrPages = ocrResult.pages;
        combinedText = [textMessage, ocrResult.combined_text].filter(Boolean).join('\n\n');
      }
      await update('phone_intakes', `id=eq.${intakeId}`, { transcript: combinedText || null });

      // Links — always read-only, regardless of slip_guard_screenshot.
      const linkRows = combinedText
        ? await processLinks(combinedText, { anthropicKey: ANTHROPIC, model: MODEL })
        : [];
      if (linkRows.length) {
        await insert('link_reads', linkRows.map(row => ({ ...row, intake_id: intakeId })), 'return=minimal');
      }
      const skippedImages = ocrPages.filter(p => p.skipped_reason).length;

      // A number stated directly in the text — dial-eligible, warn-first.
      // slip_guard_screenshot defaults ON (undefined/missing settings
      // column behaves as enabled, not disabled).
      const slipGuardOn = settings?.slip_guard_screenshot !== false;
      let dial = { kind: 'none' };
      let b = null;
      if (combinedText && slipGuardOn) {
        b = await analyze(combinedText, 'text');
        await update('phone_intakes', `id=eq.${intakeId}`, {
          archetype: b.archetype, confidence: b.confidence, is_scam: true,
          stated_numbers: b.stated_numbers, classification: { ...b, provenance: 'stated_in_text_share' },
        });

        if (!b.stated_numbers.length && b.international_numbers.length) {
          dial = { kind: 'international', number: b.international_numbers[0] };
        } else if (b.stated_numbers.length) {
          const number = b.stated_numbers[0];
          await rpc('upsert_caller_profile', {
            p_e164: number, p_org: b.claimed_org || null, p_summary: b.script_summary || null,
            p_archetype: b.archetype, p_src: 'intake',
          });
          await sb('callback_numbers?on_conflict=user_id,e164', {
            method: 'POST',
            body: JSON.stringify({ user_id: userId, intake_id: intakeId, e164: number, provenance: 'stated_in_text_share', caller_profile_id: number }),
            prefer: 'resolution=ignore-duplicates,return=minimal',
          });
          const [gate] = await select('callback_numbers', `user_id=eq.${userId}&e164=eq.${encodeURIComponent(number)}&select=id,blocked`);
          if (!gate || gate.blocked) {
            dial = { kind: 'blocked', number };
          } else {
            const rules = await select('callback_time_rules', 'active=eq.true&select=*').catch(() => []);
            const lineType = await lineTypeFor(number);
            const plan = planCallback({ number, a: b, settings, rules, lineType });
            await insert('callback_jobs', {
              user_id: userId, intake_id: intakeId, callback_number_id: gate.id,
              archetype: b.archetype, scheduled_at: plan.scheduledAt.toISOString(), status: 'approved',
              dial_window: plan.window,
              approved_at: new Date().toISOString(),
              reference_code: b.reference_number || (CODE_ARCHETYPES.includes(b.archetype) ? refCode() : null),
              reference_code_origin: b.reference_number ? 'echoed' : (CODE_ARCHETYPES.includes(b.archetype) ? 'issued' : null),
              host_name: host_name || null,
              dial_extension: b.extension,
              ask_for: b.ask_for,
              campaign_touch: 1,
              campaign_parent_id: null,
              caller_context: {
                caller_name: b.agent_label || null, claimed_org: b.claimed_org || null,
                pitch: b.pitch || null, the_ask: b.the_ask || null,
                account_refs: b.account_refs, reference_number: b.reference_number || null,
                stated_hours: b.stated_hours || null,
                stated_tz: b.stated_tz || null, transcript: combinedText,
              },
            }, 'return=minimal');
            await pingScout(number);
            dial = { kind: 'queued', number, phrase: plan.phrase, pastHours: plan.pastHours, stated: b.stated_hours, extension: b.extension, askFor: b.ask_for };
          }
        }
      }

      const status = dial.kind === 'queued' ? 'queued' : (linkRows.length ? 'link_read' : 'no_links');
      await update('phone_intakes', `id=eq.${intakeId}`, { status });

      return res.status(200).json({
        ok: true, intake_id: intakeId, status,
        // Inline rows for raid@'s Apps Script — no job_id exists when
        // dial.kind !== 'queued' (no callback job created), so this is the
        // only way for it to see what was read.
        link_reads: linkRows.map(r => ({
          page_title: r.page_title, summary: r.summary, phone_found: r.phone_found,
        })),
        ...replyForTextShare(subject, combinedText, linkRows, skippedImages, dial),
      });
    }

    // ---------------------------------------------------------------
    // PATH (A): voicemail share — unchanged pipeline below.
    // ---------------------------------------------------------------

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

    // 6. No dialable number → nothing to dial (yet). A garbled/unparseable
    // number (Sep 29, 2026, Email's ask) is distinct from no number ever
    // being stated: we know a callback was wanted, we just couldn't read
    // the digits, so we ask the sender to retype it instead of dropping the
    // lead. This reply is tagged with the phone_intakes id, not a
    // callback_jobs id — no job exists yet. If they reply with a number,
    // Email routes it to the new 'number' action (_actions.js's
    // actionSupplyNumber), which creates the job for the first time,
    // reconstructing everything from the classification saved below.
    if (!a.stated_numbers.length && a.international_numbers.length) {
      await update('phone_intakes', `id=eq.${intakeId}`, { status: 'rejected' });
      return res.status(200).json({ ok: true, intake_id: intakeId, status: 'international', ...replyFor('international', { subject, transcript, number: a.international_numbers[0] }) });
    }
    if (!a.stated_numbers.length && a.garbled_number) {
      await update('phone_intakes', `id=eq.${intakeId}`, { status: 'needs_number' });
      return res.status(200).json({ ok: true, intake_id: intakeId, status: 'needs_number', ...replyFor('needs_number', { subject, transcript, intakeId }) });
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
    // Real minutes until dial, for the acknowledgement email's cancel line
    // — was previously omitted entirely; the delay window IS the cancel
    // window, so the user should see the actual number, not a vague "soon".
    const minutesUntil = Math.max(1, Math.round((plan.scheduledAt.getTime() - Date.now()) / 60000));
    await insert('callback_jobs', {
      user_id: userId, intake_id: intakeId, callback_number_id: gate.id,
      archetype: a.archetype, scheduled_at: scheduledAt, status: 'approved',
      dial_window: plan.window,
      approved_at: new Date().toISOString(),
      reference_code: a.reference_number || (CODE_ARCHETYPES.includes(a.archetype) ? refCode() : null),
      reference_code_origin: a.reference_number ? 'echoed' : (CODE_ARCHETYPES.includes(a.archetype) ? 'issued' : null),
      host_name: host_name || null,
      dial_extension: a.extension,
      ask_for: a.ask_for,
      campaign_touch: 1,          // touches 2 and 3 are created by the dispatcher
      campaign_parent_id: null,
      caller_context: {
        caller_name: a.agent_label || null,
        claimed_org: a.claimed_org || null,
        pitch: a.pitch || null,
        the_ask: a.the_ask || null,
        account_refs: a.account_refs,
        reference_number: a.reference_number || null,
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
      ...replyFor('queued', {
        subject, transcript, number, phrase: plan.phrase, pastHours: plan.pastHours,
        stated: a.stated_hours, extension: a.extension, askFor: a.ask_for,
        callerName: a.agent_label, pitchTopic: a.pitch_topic, amount: a.amount_mentioned,
        minutesUntil,
      }),
    });
  } catch (err) {
    console.error('phone-intake', err);
    if (intakeId) { try { await update('phone_intakes', `id=eq.${intakeId}`, { status: 'rejected' }); } catch {} }
    return res.status(500).json({ ok: false, error: String(err.message || err), ...replyFor('error', {}) });
  }
}

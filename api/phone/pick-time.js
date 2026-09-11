// api/phone/pick-time.js
// Returns a plausible scheduled_at for a campaign touch, using the same
// call-window logic as first-touch scheduling (callback_time_rules,
// stated hours, area-code time zone, mobile inconvenient-hours) so the
// dispatcher never has to fork it.
//
// POST JSON: { callback_number_id, after_date, avoid_hour? }
//   after_date  ISO date or timestamp — don't schedule before this.
//   avoid_hour  0-23, local to the scammer — the previous touch's hour.
//   avoid_after ISO timestamp of the previous touch; we convert it to the
//               scammer's local hour ourselves. avoid_hour wins if both sent.
// Header:    x-phone-intake-secret
// Returns:   { ok: true, scheduled_at, window } | { ok: false, error }
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PHONE_INTAKE_SECRET,
//      TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN (line type; optional)

import { planCallback, lineTypeFor, partsInTz } from './_schedule.js';

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SECRET = process.env.PHONE_INTAKE_SECRET;

async function sb(path) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${path} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const select = (table, filter) => sb(`${table}?${filter}`);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!SECRET || req.headers['x-phone-intake-secret'] !== SECRET) return res.status(401).json({ ok: false, error: 'bad secret' });

  const { callback_number_id, after_date, avoid_hour, avoid_after } = req.body || {};
  if (!callback_number_id) return res.status(400).json({ ok: false, error: 'callback_number_id required' });

  try {
    const [num] = await select('callback_numbers', `id=eq.${callback_number_id}&select=e164,user_id,caller_profile_id`);
    if (!num) return res.status(404).json({ ok: false, error: 'no such callback_number' });

    const [settings] = await select('phone_settings', `user_id=eq.${num.user_id}&select=*`);
    const rules = await select('callback_time_rules', 'active=eq.true&select=*').catch(() => []);

    // Stated hours live on the shared profile (written at intake from the
    // voicemail). Shape matches what planCallback expects.
    const [profile] = num.caller_profile_id
      ? await select('caller_profile', `e164=eq.${encodeURIComponent(num.caller_profile_id)}&select=stated_hours,line_type,status`)
      : [null];
    if (profile?.status === 'dead' || profile?.status === 'blocked') {
      return res.status(200).json({ ok: false, error: `number is ${profile.status}` });
    }
    const sh = profile?.stated_hours || {};
    const a = {
      stated_hours: sh.text || null,
      stated_hours_start: sh.start || null,
      stated_hours_end: sh.end || null,
      stated_tz: sh.tz || null,
    };

    const lineType = profile?.line_type || await lineTypeFor(num.e164);
    const notBefore = after_date ? new Date(after_date) : null;
    if (notBefore && Number.isNaN(notBefore.getTime())) {
      return res.status(400).json({ ok: false, error: 'after_date is not a valid date' });
    }
    // Resolve the zone the same way planCallback will, so avoid_after
    // converts to the hour the scammer actually experiences.
    let avoidHour = Number.isInteger(avoid_hour) ? avoid_hour : null;
    if (avoidHour === null && avoid_after) {
      const prev = new Date(avoid_after);
      if (!Number.isNaN(prev.getTime())) {
        const probe = planCallback({ number: num.e164, a, settings, rules, lineType, notBefore });
        const tz = probe.window?.tz || settings?.tz || 'America/New_York';
        avoidHour = partsInTz(prev, tz).hh;
      }
    }

    // TEST BYPASS — mirrors intake: a user whose delay window is <=5 minutes
    // is in test mode, so campaign touches fire minutes apart instead of
    // waiting for a plausible business-hours window.
    if ((settings?.callback_delay_max ?? 60) <= 5) {
      const lo = settings?.callback_delay_min ?? 1;
      const hi = settings?.callback_delay_max ?? 2;
      const mins = lo + Math.floor(Math.random() * (hi - lo + 1));
      const base = notBefore && notBefore > new Date() ? notBefore : new Date();
      const at = new Date(base.getTime() + mins * 60000);
      return res.status(200).json({
        ok: true,
        scheduled_at: at.toISOString(),
        window: { rule: 'test_override', tz: settings?.tz || 'America/New_York' },
        phrase: `in about ${mins} minutes`,
      });
    }

    const plan = planCallback({
      number: num.e164, a, settings, rules, lineType,
      notBefore, avoidHour,
    });

    return res.status(200).json({
      ok: true,
      scheduled_at: plan.scheduledAt.toISOString(),
      window: plan.window,
      phrase: plan.phrase,
    });
  } catch (err) {
    console.error('pick-time', err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}

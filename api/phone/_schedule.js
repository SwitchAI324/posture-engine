// api/phone/_schedule.js
// Shared call-window scheduling. Imported by intake.js (first touch) and
// pick-time.js (campaign touches 2 and 3) so the two can never drift.
// Underscore prefix keeps Vercel from exposing it as a route.

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;

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
// opts.avoidHour  — don't land in this local hour (previous touch's hour)
// opts.notBefore   — Date; don't schedule before this instant (campaign day offset)
function planCallback({ number, a, settings, rules, lineType = null, now = new Date(), avoidHour = null, notBefore = null }) {
  const delayMin = settings?.callback_delay_min ?? 20;
  const delayMax = settings?.callback_delay_max ?? 60;
  const delay = rand(delayMin, delayMax);
  let earliest = new Date(now.getTime() + delayMin * 60000);
  if (notBefore && notBefore > earliest) earliest = notBefore;

  // Test override: tiny delay → ignore windows. Never for campaign touches.
  if (delayMax <= 5 && !notBefore) {
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

  const today = partsInTz(earliest, tz);
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
      // Consecutive touches shouldn't land in the same hour — a number that
      // screens at 10am may not at 6pm. Try a few draws, then give up rather
      // than push the call outside a plausible window.
      if (avoidHour !== null) {
        for (let k = 0; k < 12 && partsInTz(target, tz).hh === avoidHour; k++) {
          target = new Date(lo + Math.random() * (hi - lo));
        }
      }
    }
    if (avoidHour !== null && rule.target !== 'random' && partsInTz(target, tz).hh === avoidHour) {
      continue;   // fixed-time rule collides with the previous touch: try the next day
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


export { planCallback, lineTypeFor, rand, partsInTz, tzLabel, fmtHM };

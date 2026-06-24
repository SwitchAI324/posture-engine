// GET /api/render?slug=...
// Reads the booking_tokens row server-side (service role, bypasses RLS) and
// returns ONLY render-safe fields. Never returns archetype / difficulty /
// fakes_served / PII.
//
// First-load authoring: if narrative/slot_pool are null, draw a frozen story
// from the pools (seeded by slug), write it back, and render from it. After
// that the stored story is reused — materialize-if-null.

const { authorToken } = require('./_pools');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// The host's real time zone. Authored slot hours (e.g. "10:00") mean 10:00 in
// THIS zone — the host's actual business hours — and are emitted as true UTC
// instants. The booker's browser then localizes them to the booker's own zone
// (what every real scheduler does). Anchoring to a real zone is what keeps an
// authored "10:00" from localizing into an absurd hour; UTC anchoring was the
// tell. Override per-deploy with HOST_TZ if the host isn't US Eastern.
const HOST_TZ = process.env.HOST_TZ || 'America/New_York';

const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
};

// Offset (ms) between HOST_TZ wall-clock and UTC at a given instant — DST-aware.
function zoneOffsetMs(date, timeZone) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second);
  return asUTC - date.getTime();
}

// Build the true UTC instant for a wall-clock time on a calendar date IN HOST_TZ.
// Two-pass so DST transitions resolve correctly.
function hostWallToUTC(y, m, d, hh, mm, timeZone) {
  let ts = Date.UTC(y, m - 1, d, hh, mm, 0);
  const off1 = zoneOffsetMs(new Date(ts), timeZone);
  ts = Date.UTC(y, m - 1, d, hh, mm, 0) - off1;
  const off2 = zoneOffsetMs(new Date(ts), timeZone);
  if (off2 !== off1) ts = Date.UTC(y, m - 1, d, hh, mm, 0) - off2;
  return new Date(ts);
}

// "Today" as a calendar date in HOST_TZ (so day-offsets count host days).
function hostToday(timeZone) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return { y: +p.year, m: +p.month, d: +p.day };
}

// Add n days to a calendar date, returning {y,m,d}. Pure UTC date math — no zone
// drift because only the calendar date matters here.
function addDays(base, n) {
  const t = Date.UTC(base.y, base.m - 1, base.d) + n * 86400000;
  const dt = new Date(t);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
function ymdStr(c) {
  return c.y + '-' + String(c.m).padStart(2, '0') + '-' + String(c.d).padStart(2, '0');
}

// Display name for the host, mirroring Barbara.gs hostDisplay_ so the page and
// the invite name the host identically. Known shorthands get canonical casing;
// a custom/SV-user host is title-cased; empty falls back to the launch default.
function hostDisplay(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'Andrew';
  const low = s.toLowerCase();
  if (low === 'andrew') return 'Andrew';
  if (low === 'andrea') return 'Andrea';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function readToken(slug) {
  const url =
    `${SUPABASE_URL}/rest/v1/booking_tokens` +
    `?slug=eq.${encodeURIComponent(slug)}` +
    `&select=slug,narrative,slot_pool,difficulty,round,booked_slot,host_name`;
  const res = await fetch(url, { headers: { ...sbHeaders, Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`supabase ${res.status}: ${body.slice(0, 300)}`);
  }
  const rows = await res.json();
  return rows[0] || null;
}

// Freeze the authored story onto the token (first load only).
async function materialize(slug) {
  const authored = authorToken(slug);
  const url = `${SUPABASE_URL}/rest/v1/booking_tokens?slug=eq.${encodeURIComponent(slug)}`;
  await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(authored),
  });
  return authored;
}

// Open days: calendar date in HOST_TZ, slots as true UTC instants for the
// authored wall-clock hour in HOST_TZ. The browser localizes them for display.
function openDays(slot_pool, round) {
  const base = hostToday(HOST_TZ);
  const reveal = 2 + (round || 0); // base 2, +1 per reopened round
  const picked = [...(slot_pool.open || [])].sort((a, b) => a.offset - b.offset).slice(0, reveal);
  return picked.map((o) => {
    const c = addDays(base, o.offset);
    return {
      date: ymdStr(c),
      slots: o.times.map((t) => {
        const [hh, mm] = t.split(':').map(Number);
        return hostWallToUTC(c.y, c.m, c.d, hh, mm, HOST_TZ).toISOString();
      }),
    };
  });
}

// Blackout runs as HOST_TZ calendar dates (labels on the grid). Date-only, so
// no instant/zone conversion needed — just the host's calendar days.
function blackoutRuns(slot_pool) {
  const base = hostToday(HOST_TZ);
  return (slot_pool.blackouts || []).map((b) => ({
    label: b.label,
    from: ymdStr(addDays(base, b.from)),
    to: ymdStr(addDays(base, b.to)),
    tint: b.tint || 'grey',
  }));
}

module.exports = async (req, res) => {
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return res.status(500).json({
        error: 'config',
        detail: {
          SUPABASE_URL_set: !!SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY_set: !!SERVICE_KEY,
          key_len: SERVICE_KEY ? SERVICE_KEY.length : 0,
        },
      });
    }

    const slug = (req.query && req.query.slug) || '';
    if (!slug) return res.status(400).json({ error: 'missing slug' });

    const token = await readToken(slug);
    if (!token) return res.status(404).json({ error: 'not found', slug });

    // Materialize-if-null: author + freeze the story on first load.
    let narrative = token.narrative;
    let slot_pool = token.slot_pool;
    if (!narrative || !slot_pool) {
      const authored = await materialize(slug);
      narrative = authored.narrative;
      slot_pool = authored.slot_pool;
    }

    res.status(200).json({
      host: hostDisplay(token.host_name),
      // page-safe lead line; host_callback stays out of the browser.
      narrative: narrative && narrative.discreet
        ? `${hostDisplay(token.host_name)}'s ${narrative.discreet} this week — here's when ${hostDisplay(token.host_name)} is free.`
        : null,
      days: openDays(slot_pool, token.round),
      blackouts: blackoutRuns(slot_pool),
      reschedule: !!token.booked_slot,
      booked_slot: token.booked_slot || null,
    });
  } catch (e) {
    res.status(500).json({ error: 'render failed', detail: String(e.message || e) });
  }
};

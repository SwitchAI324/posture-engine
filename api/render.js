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
  const base = `${SUPABASE_URL}/rest/v1/booking_tokens?slug=eq.${encodeURIComponent(slug)}`;
  const full = `${base}&select=slug,narrative,slot_pool,difficulty,round,booked_slot,host_name,fast_join`;
  let res = await fetch(full, { headers: { ...sbHeaders, Accept: 'application/json' } });
  if (!res.ok) {
    // fast_join may not exist yet — retry with the columns that always exist so
    // render keeps working until Data adds it (no ordering dependency).
    const safe = `${base}&select=slug,narrative,slot_pool,difficulty,round,booked_slot,host_name`;
    res = await fetch(safe, { headers: { ...sbHeaders, Accept: 'application/json' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`supabase ${res.status}: ${body.slice(0, 300)}`);
    }
  }
  const rows = await res.json();
  return rows[0] || null;
}

// Host timezone is a per-HOST setting on host_config (NOT per-booking on the
// token — that would re-stamp every booking and drift if the host moves zones).
// Resolve it by host_name; fall back to the deploy default. Best-effort: if
// host_config isn't reachable or has no row, the env default is fine for display.
async function readHostTz(hostName) {
  if (!hostName) return HOST_TZ;
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/host_config` +
      `?host_name=eq.${encodeURIComponent(hostName)}&select=host_tz&limit=1`;
    const res = await fetch(url, { headers: { ...sbHeaders, Accept: 'application/json' } });
    if (!res.ok) return HOST_TZ;
    const rows = await res.json();
    return (rows[0] && rows[0].host_tz) || HOST_TZ;
  } catch (e) { return HOST_TZ; }
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
function openDays(slot_pool, round, tz) {
  const base = hostToday(tz);
  const all = [...(slot_pool.open || [])].sort((a, b) => a.offset - b.offset);
  const NEAR = 16;                       // near-term window (days)
  const nearLimit = 2 + (round || 0);    // near-term stays scarce; widens on help
  let nearShown = 0;
  const picked = all.filter((o) => {
    if (o.offset <= NEAR) {
      if (nearShown < nearLimit) { nearShown++; return true; }
      return false;                      // hold back extra near-term days
    }
    return true;                         // later months always show their options
  });
  return picked.map((o) => {
    const c = addDays(base, o.offset);
    return {
      date: ymdStr(c),
      slots: o.times.map((t) => {
        const [hh, mm] = t.split(':').map(Number);
        return hostWallToUTC(c.y, c.m, c.d, hh, mm, tz).toISOString();
      }),
    };
  });
}

// "Today — next available": live slots anchored to the clock half-hour, so they
// read as clean times. Rule: the next :00 or :30 boundary if it's >15 min away;
// otherwise the boundary after that; then 1–2 more at 30-min steps. Computed off
// NOW (not the frozen pool) so there's always an immediate option whenever the
// page opens — even at 1 AM. Host plays the quick join; the time-of-day reaction
// is PE's (off booked_slot). 3 slots so a future "just taken" never dead-ends the
// fast path (note: the page skips the rig on fast-join anyway).
function immediateSlots() {
  const now = new Date();
  // next half-hour boundary
  const b = new Date(now);
  b.setSeconds(0, 0);
  const min = b.getMinutes();
  let firstBoundary;
  if (min < 30) firstBoundary = 30;
  else firstBoundary = 60;
  b.setMinutes(firstBoundary);
  // if that boundary is <=15 min away, skip to the one after
  if ((b.getTime() - now.getTime()) <= 15 * 60000) {
    b.setMinutes(b.getMinutes() + 30);
  }
  const out = [];
  for (let i = 0; i < 3; i++) {
    const t = new Date(b.getTime() + i * 30 * 60000);
    out.push(t.toISOString());
  }
  return out;
}

// Blackout runs as HOST_TZ calendar dates (labels on the grid). Date-only, so
// no instant/zone conversion needed — just the host's calendar days.
function blackoutRuns(slot_pool, tz) {
  const base = hostToday(tz);
  return (slot_pool.blackouts || []).map((b) => ({
    label: b.label,
    tmi_id: b.tmi_id || null,   // page sends this on browse; host_callback stays server-side
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

    // per-host timezone from host_config (NOT the token); env default fallback
    const tz = await readHostTz(token.host_name);

    res.status(200).json({
      host: hostDisplay(token.host_name),
      host_tz: tz,
      fast_join: token.fast_join === true,
      // page-safe lead line; host_callback stays out of the browser.
      narrative: narrative && narrative.discreet
        ? `${hostDisplay(token.host_name)}'s ${narrative.discreet} this week — here's when ${hostDisplay(token.host_name)} is free.`
        : null,
      days: openDays(slot_pool, token.round, tz),
      today: immediateSlots(),
      blackouts: blackoutRuns(slot_pool, tz),
      reschedule: !!token.booked_slot,
      booked_slot: token.booked_slot || null,
    });
  } catch (e) {
    res.status(500).json({ error: 'render failed', detail: String(e.message || e) });
  }
};

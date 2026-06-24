// Authored content pools for the booking page.
//
// Each target's narrative (the "what's Andrew up to" story), difficulty (how
// many "just taken" fakes), and slot_pool (the availability fiction) are
// materialized ONCE at first page-load from these pools, seeded by the slug so
// the same target always gets the same story, then frozen onto the token.
// Archetype-independent — generically funny, not scam-type-aware.
//
// Edit the content arrays below to add/adjust the comedy. No logic changes
// needed — the picker just draws from whatever's here.

// --- stable per-slug randomness (same slug -> same story, every time) ---
function seedFromSlug(slug) {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

// --- narratives: why the host is hard to pin down ---
//   label         plainly stated on the calendar over the blackout run
//   span          realistic length of that blackout in days (Fiji ~2 weeks, etc.)
//   discreet      what Barbara hints at in email (composed, email-safe)
//   host_callback what the host says live on the call (PE reads this off the token)
const NARRATIVES = [
  { id: 'fiji', label: 'In Fiji', span: 14, discreet: 'traveling',
    host_callback: "sorry — got back from Fiji last night, still on island time, bear with me" },
  { id: 'tokyo', label: 'In Tokyo', span: 9, discreet: 'traveling for work',
    host_callback: "just flew back from the Tokyo office, my body has no idea what time it is" },
  { id: 'offsite', label: 'Sales offsite', span: 4, discreet: 'an offsite',
    host_callback: "I'm at the sales offsite — somebody's doing a trust fall behind me as we speak" },
  { id: 'recital', label: 'Daughter\u2019s recital', span: 1, discreet: 'a family commitment',
    host_callback: "came straight from my kid's recital — I may still have glitter on me" },
  { id: 'procedure', label: 'Out — medical', span: 3, discreet: 'a personal appointment',
    host_callback: "bit out of it today, had a little procedure Thursday — doctor says I'm fine" },
  { id: 'boiler', label: 'Contractor at house', span: 2, discreet: 'a contractor visit',
    host_callback: "there's a guy replacing my boiler, so if you hear banging that isn't me" },
  { id: 'jury', label: 'Jury duty', span: 5, discreet: 'a civic obligation',
    host_callback: "just got out of jury duty, riveting stuff, legally can't tell you about it" },
  { id: 'cleanse', label: 'Wellness retreat', span: 6, discreet: 'a wellness thing',
    host_callback: "day six of a juice cleanse, so if I trail off it's just the lack of solid food" },
];

// Secondary blackouts scattered around the primary one — also plainly stated,
// each with a light host callback so a browsed one can still arm a bit.
const SIDE_BLACKOUTS = [
  { label: 'Board meeting', span: 1, host_callback: "the board meeting ran long — they always do, don't they" },
  { label: 'On a flight', span: 1, host_callback: "I was wheels-up most of that day, terrible wifi at altitude" },
  { label: 'Dentist', span: 1, host_callback: "had the dentist that morning, still a bit numb on one side" },
  { label: 'Kids off school', span: 2, host_callback: "the kids were off school, so it was chaos at home those days" },
  { label: 'Conference', span: 3, host_callback: "I was at a conference, lanyard and bad coffee, the whole thing" },
  { label: 'Out of office', span: 2, host_callback: "I was fully out those days, tried very hard not to check email" },
  { label: 'Client onsite', span: 2, host_callback: "I was onsite with a client, you know how those run over" },
  { label: 'Moving house', span: 3, host_callback: "we were moving house — half my things are still in boxes" },
];

// future-month lore: nobody books these, pure payoff if the scammer pages ahead
const FUTURE_LORE = [
  { label: 'Safari', span: 10, host_callback: "hope you didn't page out to the fall — that's the safari, fully off-grid" },
  { label: 'Sabbatical', span: 21, host_callback: "the long block later in the year is my sabbatical, HR insisted, don't ask" },
  { label: 'In Patagonia', span: 12, host_callback: "if you scrolled ahead — yeah, Patagonia, my wife's idea, no signal at all" },
];

// difficulty: how many "just taken" fakes before the real slot sticks. Always
// exactly 1 — every target hits the gag once, then books.
function pickDifficulty(rand) {
  return 1;
}

// open-slot time menus (incl. deliberately odd hours — busy-exec character)
const TIME_MENUS = [
  ['10:00', '13:30', '16:00'],
  ['09:30', '15:00'],
  ['08:00', '11:30', '17:30'],
  ['07:30', '12:00', '18:30'],
];

function inBlackout(off, blackouts) {
  return blackouts.some((b) => off >= b.from && off <= b.to);
}

// stable tmi_id from a label (for browse-capture keying)
function tmiId(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Horizon for the seeded calendar: ~10 weeks so this month + the next two each
// carry blackouts and open days (so the forward arrow always has somewhere to go).
const HORIZON = 70;

// slot_pool uses day OFFSETS from the render date (so the calendar always shows
// future days while the *story* stays frozen). round is the reveal dial, applied
// at render — not here. Blackouts are plainly stated and span realistic lengths;
// they're scattered across the whole horizon, not just the first week. Each
// carries a tmi_id + host_callback so a browsed blackout can arm a host bit.
function buildSlotPool(rand, narrative) {
  const blackouts = [];

  // 1) the PRIMARY narrative block — the headline reason, realistic length,
  //    placed a few days to ~2.5 weeks out.
  const primaryStart = 4 + Math.floor(rand() * 14);
  blackouts.push({
    label: narrative.label,
    from: primaryStart,
    to: primaryStart + (narrative.span || 3),
    tint: 'amber',
    primary: true,
    tmi_id: narrative.id,
    host_callback: narrative.host_callback,
  });

  // 2) SIDE blackouts scattered across the horizon — pick 4–6 distinct ones,
  //    spaced out, each plainly stated.
  const sideCount = 4 + Math.floor(rand() * 3);
  const usedLabels = {};
  let guard = 0;
  while (blackouts.length < 1 + sideCount && guard < 60) {
    guard++;
    const s = pick(rand, SIDE_BLACKOUTS);
    if (usedLabels[s.label]) continue;
    const from = 2 + Math.floor(rand() * (HORIZON - 4));
    const to = from + (s.span - 1);
    if (from <= blackouts[0].to + 1 && to >= blackouts[0].from - 1) continue;
    usedLabels[s.label] = true;
    blackouts.push({ label: s.label, from, to, tint: 'grey', tmi_id: tmiId(s.label), host_callback: s.host_callback });
  }

  // 3) one FUTURE-LORE block out past the near term — the deep-scroll payoff.
  const lore = pick(rand, FUTURE_LORE);
  const loreStart = 38 + Math.floor(rand() * 20);
  blackouts.push({
    label: lore.label,
    from: loreStart,
    to: loreStart + (lore.span || 10),
    tint: 'amber',
    lore: true,
    tmi_id: tmiId(lore.label),
    host_callback: lore.host_callback,
  });

  // OPEN days: a handful per month-ish window so every month has availability
  // and the forward arrow stays live. Near term gets a few; mid and far each get
  // some too. All avoid blackout runs.
  const open = [];
  const windows = [[1, 16], [17, 40], [41, HORIZON]];
  windows.forEach((w, wi) => {
    const want = wi === 0 ? 3 : 2;
    let t = 0;
    let placed = 0;
    while (placed < want && t < 50) {
      t++;
      const off = w[0] + Math.floor(rand() * (w[1] - w[0]));
      if (inBlackout(off, blackouts)) continue;
      if (open.some((o) => o.offset === off)) continue;
      open.push({ offset: off, times: pick(rand, TIME_MENUS) });
      placed++;
    }
  });
  open.sort((a, b) => a.offset - b.offset);

  return { narrative_id: narrative.id, open, blackouts };
}

// The one entry point: given a slug, return the frozen story to stamp on the token.
function authorToken(slug) {
  const rand = rng(seedFromSlug(slug));
  const narrative = pick(rand, NARRATIVES);
  const difficulty = pickDifficulty(rand);
  const slot_pool = buildSlotPool(rand, narrative);
  return {
    narrative: {
      id: narrative.id,
      label: narrative.label,
      discreet: narrative.discreet,
      host_callback: narrative.host_callback,
    },
    difficulty,
    slot_pool,
  };
}

module.exports = { authorToken, NARRATIVES, FUTURE_LORE };

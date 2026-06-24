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

// --- narratives: why Andrew is hard to pin down ---
//   label         what shows on the calendar over the blackout run
//   discreet      what Barbara hints at (composed, email-safe, never graphic)
//   host_callback what Andrew says live on the call (PE reads this off the token)
const NARRATIVES = [
  { id: 'fiji', label: 'Fiji', discreet: 'traveling',
    host_callback: "sorry — got back from Fiji last night, still on island time, bear with me" },
  { id: 'procedure', label: 'Personal', discreet: 'a personal appointment',
    host_callback: "bit out of it today, had a little procedure Thursday — doctor says I'm fine" },
  { id: 'cleaning', label: 'Out', discreet: 'something at the house',
    host_callback: "the cleaning lady locked herself in my garage this morning, total circus" },
  { id: 'cleanse', label: 'Wellness', discreet: 'a wellness thing',
    host_callback: "day six of a juice cleanse, so if I trail off it's just the lack of solid food" },
  { id: 'dog', label: 'Out', discreet: 'a family thing',
    host_callback: "had the dog at the vet all morning — he ate a sock, he's fine, the sock didn't make it" },
  { id: 'boiler', label: 'At home', discreet: 'a contractor visit',
    host_callback: "there's a guy replacing my boiler, so if you hear banging that isn't me" },
  { id: 'recital', label: 'Family', discreet: 'a family commitment',
    host_callback: "came straight from my kid's recital — I may still have glitter on me" },
  { id: 'jury', label: 'Civic', discreet: 'a civic obligation',
    host_callback: "just got out of jury duty, riveting stuff, legally can't tell you about it" },
  { id: 'offsite', label: 'Offsite', discreet: 'an offsite',
    host_callback: "I'm at a team offsite — somebody's doing a trust fall behind me as we speak" },
  { id: 'movers', label: 'Out', discreet: 'something at home',
    host_callback: "movers are doing the new place, half my office is in a box right now" },
];

// future-month lore: nobody books these, pure payoff if the scammer scrolls out
const FUTURE_LORE = [
  { label: 'Congo', host_callback: "hope you didn't scroll out to the fall — that's the Congo vaccination trip" },
  { label: 'Sabbatical', host_callback: "the long block later in the year is my sabbatical, HR insisted, don't ask" },
];

// difficulty: how many "just taken" fakes before the real slot sticks. Always
// 1 or 2 (50/50) — every target hits the gag once or twice, never zero. Seeded
// by slug, so it's frozen and consistent for a given target across reloads.
function pickDifficulty(rand) {
  return rand() < 0.5 ? 1 : 2;
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

// slot_pool uses day OFFSETS from the render date (so the calendar always shows
// future days while the *story* stays frozen). round is the reveal dial, applied
// at render — not here.
function buildSlotPool(rand, narrative) {
  const bigStart = 5 + Math.floor(rand() * 4); // ~next week
  const bigLen = 4 + Math.floor(rand() * 4); // a working-week-ish block
  const smallStart = 1 + Math.floor(rand() * 3);
  const blackouts = [
    { label: narrative.label, from: bigStart, to: bigStart + bigLen, tint: 'amber' },
    { label: 'Personal', from: smallStart, to: smallStart + (rand() < 0.4 ? 1 : 0), tint: 'grey' },
  ];

  const open = [];
  let tries = 0;
  while (open.length < 4 && tries < 40) {
    tries++;
    const off = 1 + Math.floor(rand() * 16);
    if (inBlackout(off, blackouts)) continue;
    if (open.some((o) => o.offset === off)) continue;
    open.push({ offset: off, times: pick(rand, TIME_MENUS) });
  }
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

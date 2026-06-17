// SpamViking — Posture Engine: ARCHETYPE VERIFICATION endpoint.
// ----------------------------------------------------------------------
// Proves the archetype fit path end-to-end against the REAL registry + the
// REAL scorer, faking exactly what Email's metadata will eventually send —
// without putting test-tagged bits in the live registry (which could fire on
// real calls) or needing a live Vapi call.
//
//   GET /api/verify                         -> forces archetype "crypto_investment"
//   GET /api/verify?archetype=romance       -> force any archetype to flip it
//
// It (1) reads the archetype the EXACT way the proxy reads Email's metadata
// (shared archetypeFromBody), (2) builds the scorerState the proxy builds,
// (3) scores the real 71 bits + two synthetic themed test bits, and shows:
//   - the crypto test bit getting +3 (themed match, dominant)
//   - the romance test bit EXCLUDED on a crypto call
//   - a couple of real universal bits still at +1
// Read-only, no DB, no live traffic. Delete this file to remove.
// ----------------------------------------------------------------------

export const config = { runtime: "edge" };

import { rankBits, scoreBit } from "./_bits.js";
import { BITS } from "./_bits_registry.js";
import { archetypeFromBody } from "./_archetype.js";

// Synthetic test bits — ONLY in this endpoint's pool, never the registry.
const TEST_BITS = [
  { id: "BIT-901", name: "TEST · crypto-themed",
    archetypes: ["crypto_investment", "crypto_recovery"],
    gear: { engagement: { hooked: 1 } } },
  { id: "BIT-902", name: "TEST · romance-themed",
    archetypes: ["romance"],
    gear: { engagement: { hooked: 1 } } },
];

export default async function handler(req) {
  const u = new URL(req.url);
  const forced = u.searchParams.get("archetype") || "crypto_investment";

  // Read it the PROD way — simulate Vapi's metadata payload exactly.
  const fakeBody = { call: { metadata: { archetype: forced } } };
  const resolved = archetypeFromBody(fakeBody) || "universal";

  // The scorerState the proxy builds (alive/calm/hooked, no accusation).
  const state = {
    archetype: resolved,
    accusation: null,
    gears: { suspicion: "alive", pressure: "calm", engagement: "hooked" },
    recency: {},
    lastBitId: null,
  };

  const pool = [...BITS, ...TEST_BITS];
  const ranked = rankBits(state, { pool }); // excluded bits drop out here

  const crypto = scoreBit(TEST_BITS[0], state); // expect fit incl. +3
  const romance = scoreBit(TEST_BITS[1], state); // expect excluded on crypto
  const realUniversal = ranked.filter((r) => !r.id.startsWith("BIT-9")).slice(0, 3);

  // Grade each test bit against ITS OWN expected outcome for the forced
  // archetype: a themed bit should get +3 when the call matches one of its
  // archetypes, and be EXCLUDED otherwise. (The earlier banner hard-coded the
  // crypto scenario, so romance/universal read as false failures.)
  const expectMatch = (bit) => bit.archetypes.includes(resolved);
  const gradeThemed = (scored, bit) =>
    expectMatch(bit) ? scored.breakdown.fit >= 3 : scored.score === -Infinity;
  const expectText = (bit) =>
    expectMatch(bit) ? "fit +3 (themed match)" : "EXCLUDED (wrong call)";

  const cryptoOk = gradeThemed(crypto, TEST_BITS[0]);
  const romanceOk = gradeThemed(romance, TEST_BITS[1]);
  const realsOk = realUniversal.length > 0 && realUniversal.every((r) => r.breakdown.fit >= 1);
  const pass = cryptoOk && romanceOk && realsOk;

  // --- YOUR REAL TAGGED BITS -----------------------------------------------
  // Graded against the INTENDED tags (what Bits said they assigned), so this
  // is a true diff: does the DEPLOYED registry actually carry the tag, and does
  // the bit behave on this call? A bit that's missing, or still "universal",
  // shows as a tagging/sync failure — distinct from a scorer failure.
  const REAL = [
    { id: "BIT-119", expect: "crypto_investment" },
    { id: "BIT-120", expect: "crypto_investment", note: "Bits marked marginal — watch" },
    { id: "BIT-304", expect: "crypto_investment" },
    { id: "BIT-206", expect: "b2b_saas" },
    { id: "BIT-216", expect: "b2b_saas" },
  ];
  const byId = Object.fromEntries(BITS.map((b) => [b.id, b]));
  const realChecks = REAL.map((spec) => {
    const bit = byId[spec.id];
    if (!bit) {
      return { ...spec, present: false, ok: false, name: "(missing)",
        tag: "—", result: "NOT IN REGISTRY",
        why: "bit id absent from the deployed registry — tags never compiled in" };
    }
    const tag = Array.isArray(bit.archetypes) ? bit.archetypes.join(",") : bit.archetypes;
    const scored = scoreBit(bit, state);
    const isMatchCall = spec.expect === resolved; // this call should make it rise
    const ok = isMatchCall ? scored.breakdown.fit >= 3 : scored.score === -Infinity;
    return {
      ...spec, present: true, ok, name: bit.name, tag,
      result: scored.score === -Infinity ? "EXCLUDED"
        : "score " + scored.score.toFixed(1) + " (fit " + scored.breakdown.fit + ")",
      why: scored.score === -Infinity ? (scored.excluded || "archetype mismatch")
        : (scored.breakdown.why || []).join("; "),
      expectThisCall: isMatchCall ? "fit +3 (should rise)" : "EXCLUDED (wrong call)",
    };
  });
  const realAllOk = realChecks.every((c) => c.ok);

  const realRowsReal = realChecks.map((c) => {
    const mark = c.ok ? '<span class="ok-mark">&#10003;</span>' : '<span class="x">&#10007;</span>';
    const note = c.note ? ` <span class="note">(${c.note})</span>` : "";
    const cls = c.id === "BIT-120" ? ' class="spot"' : "";
    return `<tr${cls}><td>${c.id} — ${c.name} ${mark}${note}</td>` +
      `<td>${c.present ? "tag: " + c.tag : '<span class="x">missing</span>'}</td>` +
      `<td>${c.present ? c.result : '<span class="x">NOT IN REGISTRY</span>'}</td>` +
      `<td>${c.present ? c.expectThisCall : "—"}</td>` +
      `<td class="why">${c.why}</td></tr>`;
  }).join("");

  const row = (label, r, bit) => {
    const ok = gradeThemed(r, bit);
    return `<tr><td>${label}</td><td>${
      r.score === -Infinity ? '<span class="x">EXCLUDED</span>' : "score " + r.score.toFixed(1)
    }</td><td class="why">${
      r.score === -Infinity ? (r.excluded || "archetype mismatch") : (r.breakdown.why || []).join("; ")
    }</td><td>${expectText(bit)} ${
      ok ? '<span class="ok-mark">&#10003;</span>' : '<span class="x">&#10007;</span>'
    }</td></tr>`;
  };

  const realRows = realUniversal
    .map((r) => `<tr><td>${r.name}</td><td>score ${r.score.toFixed(1)}</td><td class="why">${(r.breakdown.why || []).join("; ")}</td><td>+1 universal</td></tr>`)
    .join("");

  const html = `<!doctype html><meta charset="utf-8">
<title>Archetype verify</title>
<style>
  body{background:#14110d;color:#efe7da;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:880px;margin:30px auto;padding:0 18px}
  h1{font:600 24px/1 ui-serif,Georgia,serif}
  .verdict{font:700 22px/1 ui-serif,Georgia,serif;padding:14px 18px;border-radius:10px;margin:16px 0}
  .ok{background:#1c2a1e;color:#7fd6a0;border:1px solid #2f5d3f}
  .bad{background:#2a1715;color:#e09080;border:1px solid #6b2f24}
  table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13.5px}
  td,th{text-align:left;padding:8px 10px;border-bottom:1px solid #2a2118;vertical-align:top}
  th{color:#a99b85;font-weight:600;font-size:11.5px;letter-spacing:.5px;text-transform:uppercase}
  .why{color:#a99b85}
  .x{color:#d4583b;font-weight:700}
  .ok-mark{color:#7fd6a0;font-weight:700}
  .note{color:#caa23a;font-size:12px}
  .spot{background:#211a10}
  .meta{color:#a99b85;font-size:13px}
  code{background:#241d15;padding:2px 6px;border-radius:4px}
</style>
<h1>Archetype fit — end-to-end verify</h1>
<p class="meta">Faked metadata <code>archetype: ${forced}</code> &middot; read by the proxy's own
<code>archetypeFromBody</code> &rarr; resolved <code>state.archetype = ${resolved}</code>.
Scored against the real ${BITS.length}-bit registry + 2 synthetic test bits.</p>

<h2 style="font:600 15px/1 ui-sans-serif,system-ui;color:#a99b85;letter-spacing:.5px;text-transform:uppercase;margin-top:24px">1 · Mechanism (synthetic bits)</h2>
<div class="verdict ${pass ? "ok" : "bad"}">${pass ? "&#10003; PASS — the scorer fires +3 / exclusions correctly" : "&#10007; FAIL — see rows below"}</div>
<table>
<tr><th>Bit</th><th>Result</th><th>Why</th><th>Expected</th></tr>
${row("TEST · crypto-themed (BIT-901)", crypto, TEST_BITS[0])}
${row("TEST · romance-themed (BIT-902)", romance, TEST_BITS[1])}
${realRows}
</table>

<h2 style="font:600 15px/1 ui-sans-serif,system-ui;color:#a99b85;letter-spacing:.5px;text-transform:uppercase;margin-top:28px">2 · Your real tagged bits (vs intended tags)</h2>
<div class="verdict ${realAllOk ? "ok" : "bad"}">${realAllOk
  ? "&#10003; PASS — all five real bits carry their tags and behave on this call"
  : "&#10007; NOT YET — the deployed registry doesn't match the intended tags (see rows)"}</div>
<table>
<tr><th>Bit</th><th>Registry tag</th><th>On this call</th><th>Expected</th><th>Why</th></tr>
${realRowsReal}
</table>
<p class="meta">Flip it: <code>?archetype=romance</code> &rarr; the romance bit should get +3 and the
crypto bit should flip to EXCLUDED. <code>?archetype=universal</code> &rarr; both test bits excluded,
reals stay +1.</p>`;

  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

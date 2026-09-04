// SpamViking — scout_hooks + scout_facts read (the rack + fuel for a call).
// ----------------------------------------------------------------------
// TWO CHANNELS, TWO READS (Scouting's finalized read contract, 2026-08-04).
//
// CHANNEL 1 — THE RACK (context/ambient), keyed by SLUG. Table scout_hooks,
// PK (slug, hook_id). readAmmunition(slug):
//   select hook_id, label, payload from scout_hooks where slug = :slug
// hook_id + label -> Mead Hall's ammunition rack [{hook_id, label}].
// payload -> byHook[hook_id], a fact a firing bit pulls. A few Channel-1
// hooks (dossier_negation, browsed_tmi, company_news) also double as fuel —
// a bit can declare one of them in fuel_hooks and it resolves through this
// same rack read, no Channel-2 involvement needed. Only gate-passing hooks
// are ever written, so there is no filtering on read, and an empty rack is
// a safe default, not a failure.
//
// CHANNEL 2 — THE FUEL (bit-spendable), keyed by TARGET_ID. Presence gate
// at targets.fuel_hooks_status (jsonb: {hook_id:{present,confidence}}),
// values at scout_facts (one row per source_lane — body/signature/call/
// attachment — each row's `facts` jsonb blob shaped differently depending
// on lane; see FUEL_HOOKS below for exactly where each hook's string lives).
// readFuel(targetId) returns byHook in the SAME SHAPE as Channel 1's, so
// completions.js can merge the two byHook maps with a plain object spread
// and every downstream consumer (fuelFit, factHint, the fuel_hooks_status
// derivation) needs zero changes.
//
// readFuel is NEW (added 2026-08-04, closing the gap found reconciling
// against Scouting's contract — this file previously only ever implemented
// Channel 1, so every bit whose fuel_hooks pointed at a genuine
// Channel-2-only hook was structurally unfireable; confirmed from the live
// registry: BIT-101, BIT-509 through BIT-513).
//
// CALL_* PROXY DROPPED (2026-08-04, Data): call_callback / call_claim /
// call_commitment / office_location / attachment_facts have been REMOVED
// from FUEL_HOOKS — Bits re-keyed BIT-508 through BIT-513 off a new derived
// view (target_prior_contact, see readPriorContact below) which supersedes
// them; confirmed zero bits in the fresh registry reference any of the five
// anymore. Pure dead-code removal, not a behavior change for anything live.
//
// PRIOR CONTACT — NEW, separate from the fuel/rack split (2026-08-04,
// Data): target_prior_contact is a DERIVED VIEW (Data's own anti-drift
// ruling, same as the leaderboard — counts live, can never go stale),
// sourced from the calls table itself, NOT last_call_scouted_at (that
// means "scout lane ran," a different fact that would misfire as
// prior-contact). readPriorContact(targetId) returns has_prior_contact,
// prior_call_count, last_call_started_at. BIT-508 (Have We Spoken) fuels on
// has_prior_contact; BIT-509-513 (the escalation family) fuel on
// prior_call_count.
//
// sender_identity CONTRACT UPDATE (2026-08-04, Scouting confirmed): the
// caller's name WAS always populated, just never read — it lives in the
// SAME body-lane scout_facts row as title/company, at facts.name (zero
// extra query). Fixed here; completions.js's existing "say the caller's
// name confidently" mechanism needed no changes once this read was correct.
//
// EIGHT HOOKS CONFIRMED DEAD (2026-08-04, Scouting): connection_count,
// employer_dates, company_rating, school, relocation_trail, otw_badge,
// headline_buzzwords, prior_contact. Scouting produces NONE of these —
// LinkedIn page reads are blocked (fetch-barred) AND out of bounds (the
// "no dossier on the person" line); sender_linkedin captures the URL only
// ({platform, handle, url}, no profile breakdown). Deliberately NOT in
// FUEL_HOOKS below —
// there is no source now and none coming for the 7 LinkedIn-shaped ones.
// The bits keyed to them (per Bits' registry) need to be unkeyed on Bits'
// side — nothing to build here, they will simply never resolve.
// ----------------------------------------------------------------------

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// TARGET ID RESOLUTION — the canonical source for the dossier reads below
// (readFuel, readPriorContact) is booking_tokens.target_id, stamped at mint
// (Email's pending write), keyed by the SAME slug PE already has from turn
// 1 — no dependency on stored.targetId's propagation through call_prefix/
// hydrate, which has a documented history of being dropped in edge cases
// (the slug-merge race, already fixed once — but this removes the
// indirection entirely rather than trusting the fix held). "Direct
// target_id is the clean path" (Data, 2026-08-04). Returns null (never
// throws) if the token's target_id was never stamped at mint — the caller
// falls back to stored.targetId, which is still a valid independent source.
export async function resolveTargetId(slug) {
  if (!SB_URL || !SB_KEY || !slug) return null;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/booking_tokens?slug=eq.${encodeURIComponent(slug)}&select=target_id`,
      { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows[0] && rows[0].target_id ? rows[0].target_id : null;
  } catch {
    return null;
  }
}

export async function readAmmunition(slug) {
  const empty = { ammunition: [], byHook: {} };
  if (!SB_URL || !SB_KEY || !slug) return empty;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/scout_hooks?slug=eq.${encodeURIComponent(slug)}&select=hook_id,label,payload`,
      { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return empty;
    const rows = await r.json();
    if (!Array.isArray(rows)) return empty;
    const ammunition = [];
    const byHook = {};
    for (const row of rows) {
      if (!row.hook_id) continue;
      ammunition.push({ hook_id: row.hook_id, label: row.label || row.hook_id });
      byHook[row.hook_id] = row.payload || null;
    }
    return { ammunition, byHook };
  } catch {
    return empty;
  }
}

// CHANNEL 2 — per-hook extraction, one entry per Scouting's path table.
// Each extract() receives the `facts` jsonb blob for THAT hook's
// source_lane row and returns either an object (merged into
// byHook[hook_id], same {key: value} shape factHint() already expects) or
// null when the expected shape isn't actually there — fails soft per hook,
// never throws, never fabricates a value the data doesn't support.
const FUEL_HOOKS = {
  pitch_claims: {
    lane: "body",
    extract: (facts) => {
      const claims = Array.isArray(facts?.claims) ? facts.claims : [];
      return claims.length ? { claims: claims.slice(0, 3).join(" | ") } : null;
    },
  },
  sender_identity: {
    lane: "body",
    extract: (facts) => {
      const out = {};
      // facts.name (2026-08-04 contract update): same body-lane row as
      // title/company, no extra query — this is what completions.js's
      // NAME HANDLING / spammerName reads actually needed all along.
      if (facts?.name) out.name = facts.name;
      if (facts?.title) out.title = facts.title;
      if (facts?.company) out.company = facts.company;
      // CONFIDENCE-RANKED NAME RESOLUTION (2026-08-06, Scouting): name may
      // now come from body/signature (LLM, ~0.7), the From display name
      // (0.7), or the email local-part (0.55, name-shaped addresses only —
      // role/noise addresses like info@ already return null upstream).
      // name_source tells you WHICH; confidence tells you how much to
      // trust it. Both pass through unchanged — PE's job is deciding what
      // to DO with a low-confidence guess, not re-deriving trust here.
      if (facts?.confidence != null) out.confidence = facts.confidence;
      if (facts?.name_source) out.name_source = facts.name_source;
      return Object.keys(out).length ? out : null;
    },
  },
  sender_linkedin: {
    lane: "signature",
    extract: (facts) => {
      const socials = Array.isArray(facts?.sender_socials) ? facts.sender_socials : [];
      const li = socials.find((s) => s && s.platform === "linkedin");
      // _url suffix is deliberate: NON_SPEAKABLE in completions.js's factHint()
      // filters any key matching /_url$/ — a raw URL should never be read
      // aloud by the host, only used as provenance/basis if ever needed.
      return li && li.url ? { linkedin_url: li.url } : null;
    },
  },
  sender_social: {
    lane: "signature",
    extract: (facts) => {
      const socials = Array.isArray(facts?.sender_socials) ? facts.sender_socials : [];
      const other = socials.find((s) => s && s.platform !== "linkedin");
      if (!other) return null;
      const out = {};
      if (other.handle) out.handle = other.handle;
      if (other.url) out.social_url = other.url; // filtered non-speakable, see above
      return Object.keys(out).length ? out : null;
    },
  },
  // EMAIL DOSSIER (2026-08-05, Email/Barbara): a summary of the pre-call email
  // thread, written at markBooked_ — same body lane as pitch_claims/
  // sender_identity, per their contract. shape: {summary, quotes, hook,
  // contradictions}. quotes capped to 4 here even though their own writer
  // already caps at 2-4 — belt and suspenders, never trust a single layer to
  // enforce a length constraint. ALL of this is THEIR CLAIMS, not verified
  // fact — factHint's own framing ("You happen to know this about them")
  // already reads naturally as "what they told you," but if this hook ever
  // gets a bespoke injection instead of the generic factHint path, that
  // framing must be made explicit there too (quote their pitch back, never
  // treat it as confirmed truth).
  email_dossier: {
    lane: "body",
    extract: (facts) => {
      const d = facts?.email_dossier;
      if (!d) return null;
      const out = {};
      if (d.summary) out.summary = d.summary;
      if (Array.isArray(d.quotes) && d.quotes.length) out.quotes = d.quotes.slice(0, 4).join(" | ");
      if (d.hook) out.hook = d.hook;
      if (d.contradictions) out.contradictions = d.contradictions;
      return Object.keys(out).length ? out : null;
    },
  },
  // OFFICE_LOCATION (2026-09-02, Scouting) — RESTORED, not new. Dropped
  // from this table in the Aug-4 CALL_* PROXY cleanup as presumed
  // dead-code alongside four genuinely-dead hooks — but _dissect.js was
  // producing facts.location on the body lane the whole time, and
  // registering the office_location fuel-hook gate to match. The write
  // side was never actually dead; only this read-side entry was
  // (mistakenly) removed with it. Same body lane as pitch_claims/
  // sender_identity/email_dossier, no new query.
  office_location: {
    lane: "body",
    extract: (facts) => {
      const loc = facts?.location;
      return loc ? { location: loc } : null;
    },
  },
};

export async function readFuel(targetId) {
  const empty = { byHook: {} };
  if (!SB_URL || !SB_KEY || !targetId) return empty;
  try {
    const [presenceRes, factsRes] = await Promise.all([
      fetch(
        `${SB_URL}/rest/v1/targets?id=eq.${encodeURIComponent(targetId)}&select=fuel_hooks_status`,
        { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } }
      ),
      fetch(
        `${SB_URL}/rest/v1/scout_facts?target_id=eq.${encodeURIComponent(targetId)}&select=source_lane,facts,call_id`,
        { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } }
      ),
    ]);
    if (!presenceRes.ok || !factsRes.ok) return empty;
    const presenceRows = await presenceRes.json();
    const factsRows = await factsRes.json();
    if (!Array.isArray(presenceRows) || !presenceRows.length) return empty;
    if (!Array.isArray(factsRows)) return empty;

    const presence = presenceRows[0].fuel_hooks_status || {};
    // Index scout_facts rows by source_lane — the presence gate is checked
    // FIRST below, so a hook that isn't gated present never even looks at
    // facts data (matches Scouting's "presence check is the cheap gate").
    const factsByLane = {};
    for (const row of factsRows) {
      if (row && row.source_lane) factsByLane[row.source_lane] = row.facts || {};
    }

    const byHook = {};
    for (const [hookId, spec] of Object.entries(FUEL_HOOKS)) {
      const gate = presence[hookId];
      if (!gate || gate.present !== true) continue; // presence gate — skip, don't guess
      const lane = factsByLane[spec.lane];
      if (!lane) continue; // gated present but the lane row hasn't landed yet — skip, don't throw
      const value = spec.extract(lane);
      if (value) byHook[hookId] = value;
    }
    return { byHook };
  } catch {
    return empty;
  }
}

// PRIOR CONTACT — separate from the fuel/rack split above (see the header
// comment). target_prior_contact is a DERIVED VIEW, not a table: it counts
// straight off the calls table itself, so it can never drift from the real
// call history (same anti-drift discipline as the leaderboard). NOT sourced
// from last_call_scouted_at — that column means "the scout lane ran for
// this target," a different fact that would misfire as prior-contact.
//
// Returns the same {byHook} shape as readFuel so completions.js merges all
// three sources (rack, fuel, prior-contact) identically. Only surfaces a
// hook when it has something real to say: has_prior_contact is added ONLY
// when true (a target who's never called has nothing for BIT-508 to work
// with); prior_call_count is added ONLY when > 0, for the same reason.
// last_call_started_at is fetched but deliberately NOT surfaced into
// byHook by default — it's a raw timestamp, not a speakable string, and no
// bit today asks for it; a future bit wanting recency should format it
// (e.g. "N days ago") rather than have the host read an ISO string aloud.
export async function readPriorContact(targetId) {
  const empty = { byHook: {} };
  if (!SB_URL || !SB_KEY || !targetId) return empty;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/target_prior_contact?target_id=eq.${encodeURIComponent(targetId)}&select=has_prior_contact,prior_call_count,last_call_started_at`,
      { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } }
    );
    if (!r.ok) return empty;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return empty;
    const row = rows[0];
    const byHook = {};
    if (row.has_prior_contact === true) {
      byHook.has_prior_contact = { spoken_before: "yes" };
    }
    const count = Number(row.prior_call_count) || 0;
    if (count > 0) {
      byHook.prior_call_count = { count: String(count) };
    }
    return { byHook };
  } catch {
    return empty;
  }
}

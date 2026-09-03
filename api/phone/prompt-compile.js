// Phone Intake compile layer — intended path: api/phone/prompt-compile.js
// (renamed + moved from a bare compile.js to avoid colliding with the
// existing, unrelated api/compiler/compile.js — the bench-reframe
// posture compiler. Same filename, completely different system; this
// one only builds phone-call prompts.)
//
// Mirrors completions.js's buildSystemBlocks architecture (compile-time
// cached prefix + turn-gated mutable injections), adapted for phone
// calls. Dispatch metadata contract and the Data read/write contract
// are FROZEN per Andrew's brief (2026-09-02) and
// PHONE_COMPILER_READ_CONTRACT.md (Data, 2026-07-06) — this file
// reads/writes exactly those shapes, never guesses at an alternate one.
// Greenfield: no phone compile file existed before this one.
//
// REVISED from the first draft after Data's contract arrived: the
// original draft invented a `hard_match` boolean on pre-loaded
// conversation_thread data. That's not how it actually works —
// conversation_threads is KEYED by (caller_profile_id, user_id,
// agent_label). agent_label is PART OF THE KEY, so a thread physically
// cannot be fetched without a confirmed agent_label (or a reference_code
// lookup) already in hand. This file now models that correctly: a real
// async lookup gated on a confirmed value extracted from what the caller
// said, not a boolean flag on data that already arrived.
//
// DISPATCH METADATA CONTRACT (frozen):
//   call_direction: 'outbound' | 'inbound'
//   job_id, intake_id: string
//   user_id: string | null              (null on unmatched inbound)
//   archetype: 'b2b_saas' | 'crypto_investment' | 'account_access' |
//              'gov_threat' | 'generic'
//   reference_code: string | null
//   adjacent_number: string             (scammer number, last digit +/-1)
//   recording_notice_given: boolean
//   caller_profile: CallerProfile | null    (per-number, shared)
//   caller_profile_id: string | null    (the key for a thread lookup)
//   turn: number
//   leaving_voicemail: boolean
//
// caller_profile shape (Data-owned, one row per scammer E.164, shared
// across users — NEVER contains a SpamViking user's name):
//   claimed_org: text | null
//   script_summary: text | null
//   web_reports: jsonb          — PROVENANCE ONLY, never surfaced
//   confidence: 'low' | 'medium' | 'high'
//   caller_profile_archetype(): () => archetype string
//
// conversation_threads shape (Data-owned; KEY = caller_profile_id +
// user_id + agent_label — see lookupConversationThread below):
//   agent_label: string
//   reference_code: string | null
//   host_name: string
//   summary: string
//   last_call_at: timestamp

"use strict";

const REFERENCE_CODE_ARCHETYPES = new Set([
  "b2b_saas",
  "account_access",
  "gov_threat",
]);
const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 };
const MIN_PLAYBOOK_CONFIDENCE = "medium";

function referenceCodeOnFor(archetype) {
  return REFERENCE_CODE_ARCHETYPES.has(archetype);
}

// ---------------------------------------------------------------------
// 1. RECORDING NOTICE — forced, deterministic, turn-1 only. This is a
// legal/consent requirement, not a scored beat: it must never compete
// with bits, randomness, or archetype logic. Mirrors the bar-bypass
// mechanism turn-1 gag-open uses in completions.js, minus the coin flip
// — this one is unconditional whenever the gate holds, every time.
// ---------------------------------------------------------------------
const RECORDING_NOTICE_LINE =
  "I can't figure out how to use this phone. About six months ago I " +
  "turned the recording option on and for the life of me I can't undo it.";
// Seed line per Andrew (2026-09-02), handed to Host Canon for final
// wording — PE owns firing it, Canon owns the words. Swap this constant
// for Canon's actual render once it ships; the GATE below is the real
// deliverable here, not this placeholder string.

function needsRecordingNotice(meta) {
  return (
    meta.call_direction === "outbound" && meta.recording_notice_given !== true
  );
}

function recordingNoticeDirective(meta) {
  if (!needsRecordingNotice(meta)) return null;
  return (
    "[MANDATORY FIRST UTTERANCE — deliver this before anything else, " +
    "in character. This is a legal requirement, not a performance " +
    "choice — it cannot be skipped, softened into a later turn, or " +
    "folded into small talk first:]\n" +
    RECORDING_NOTICE_LINE
  );
}

// ---------------------------------------------------------------------
// 2. EXPECTED_PLAYBOOK — compile-time only (caller_profile is per-number
// and shared, so build ONCE per call, not per turn — mirrors
// callStableContext() in providers.js). Omit entirely below medium
// confidence. Strip all provenance (web_reports, counts, URLs) before it
// ever reaches the model — frame as the host's own hunch, never as
// aggregated data with a source.
// ---------------------------------------------------------------------
function meetsPlaybookConfidence(confidence) {
  const rank = CONFIDENCE_RANK[confidence];
  return rank != null && rank >= CONFIDENCE_RANK[MIN_PLAYBOOK_CONFIDENCE];
}

function buildExpectedPlaybookBlock(callerProfile) {
  if (!callerProfile) return null;
  if (!meetsPlaybookConfidence(callerProfile.confidence)) return null;

  const org = (callerProfile.claimed_org || "").trim();
  const script = (callerProfile.script_summary || "").trim();
  if (!org && !script) return null; // nothing usable even at confidence

  // web_reports is PROVENANCE ONLY — deliberately never read past the
  // confidence check above. No counts, no URLs, no "per N reports" ever
  // reaches the compiled block; that's the whole point of hunch framing.
  const lines = [];
  if (org) lines.push("usually claims to be from " + org);
  if (script) lines.push(script);

  return (
    "[HOST HUNCH — never say this aloud, never cite a source for it, " +
    "this is just a feeling, not information you were handed:]\n" +
    "Something about this feels familiar: " +
    lines.join("; ") +
    ". Trust it, but stay ready to be wrong — it's a hunch, not a " +
    "briefing."
  );
}

// ---------------------------------------------------------------------
// 3. MEMORY RULE — precision over recall. Operation-level (caller_
// profile) keys off the number match alone — legitimate, it describes
// the scam operation, not a specific person. conversation_threads is
// keyed by (caller_profile_id, user_id, agent_label) — agent_label is
// PART OF THE KEY, so a thread cannot be fetched at all without a
// confirmed agent_label already in hand, OR via the separate
// reference_code lookup path. This is enforced by the schema itself,
// not just a flag this file checks — there is no "load the most recent
// thread for this caller" fallback, because there is no query shape
// that would even express that; doing so would leak one agent's memory
// to another on a shared scammer number.
// ---------------------------------------------------------------------

// Real DB lookup, keyed exactly as Data's contract specifies. Stubbed
// here (see STUB PIPELINE below) until wired to the real table. Returns
// null on no match — never throws for a legitimate "no thread yet".
async function lookupConversationThread(db, { caller_profile_id, user_id, agent_label }) {
  if (!caller_profile_id || !user_id || !agent_label) return null;
  return db.lookupThreadByLabel({ caller_profile_id, user_id, agent_label });
}

// Alternate path: reference_code lookup. Still requires caller_profile_id
// — a reference code is only meaningful within one scammer's operation,
// never a global lookup key on its own.
async function lookupConversationThreadByReferenceCode(db, { caller_profile_id, reference_code }) {
  if (!caller_profile_id || !reference_code) return null;
  return db.lookupThreadByReferenceCode({ caller_profile_id, reference_code });
}

// The compile-time entry point: given whatever the caller has said so
// far THIS call, try to resolve a thread — via a confirmed agent_label
// first, then a confirmed reference_code. Never guesses, never falls
// back to "most recent". user_id null (unmatched inbound) short-circuits
// immediately — there is no key to look up.
async function resolveConversationThread(db, meta, confirmed) {
  if (meta.user_id == null) return null;
  if (!meta.caller_profile_id) return null;
  if (confirmed && confirmed.agent_label) {
    const byLabel = await lookupConversationThread(db, {
      caller_profile_id: meta.caller_profile_id,
      user_id: meta.user_id,
      agent_label: confirmed.agent_label,
    });
    if (byLabel) return byLabel;
  }
  if (confirmed && confirmed.reference_code) {
    const byCode = await lookupConversationThreadByReferenceCode(db, {
      caller_profile_id: meta.caller_profile_id,
      reference_code: confirmed.reference_code,
    });
    if (byCode) return byCode;
  }
  return null;
}

// Pure formatter for a resolved thread — no lookup logic here, that
// lives in resolveConversationThread above. Kept separate so the
// per-turn addendum path doesn't need to know anything about
// caller_profile/playbook at all.
function buildPersonMemoryBlock(conversationThread) {
  if (!conversationThread) return null;
  return (
    "[PRIOR CALL WITH THIS PERSON — confirmed match, safe to " +
    "reference:]\n" +
    "Last time, talking to " +
    (conversationThread.host_name || "the host") +
    ": " +
    (conversationThread.summary || "").trim()
  );
}

// ---------------------------------------------------------------------
// 4. REFERENCE CODE GATE — archetype-based, on/off, no in-between. When
// off, the directive is omitted entirely (not soft-disabled) so nothing
// nudges the host toward inventing a code for an archetype that
// shouldn't have one. Only relevant on the voicemail-leaving branch of
// an outbound call — an answered call has no voicemail to plant it in.
// ---------------------------------------------------------------------
function referenceCodeDirective(meta) {
  if (!referenceCodeOnFor(meta.archetype)) return null;
  if (meta.call_direction !== "outbound") return null;
  if (!meta.leaving_voicemail) return null;
  if (!meta.reference_code) return null; // nothing to plant
  return (
    "[VOICEMAIL ONLY — plant this once, naturally, don't repeat it or " +
    'call attention to it as a "code":] Somewhere in your message, ' +
    'work in this reference: "' +
    meta.reference_code +
    '" — the kind of thing you\'d mention in passing so a callback can ' +
    "find your file."
  );
}

// ---------------------------------------------------------------------
// 5. BITS GATE — expose call_direction to the SAME state object
// completions.js already threads into loadout()/rankBits() (where
// phase/turn already live). Bits' two outbound-only bits key off
// trigger:"call_direction:outbound" the same way existing bits key off
// trigger:"phase:opening" — no new mechanism, just one more field
// plumbed through the existing trigger-match gate.
// ---------------------------------------------------------------------
function bitScoringState(meta, baseState) {
  return Object.assign({}, baseState || {}, {
    call_direction: meta.call_direction,
  });
}
// NOTE: _bits_scorer.js's EMITTED_TRIGGERS allowlist needs
// "call_direction:outbound" and "call_direction:inbound" added before a
// trigger-gated bit will actually match on this field — that's a
// one-line addition on the scorer file, not reproduced here since this
// file doesn't own that registry.

// ---------------------------------------------------------------------
// COMPILE — mirrors hostBaseFor()/hostOverlaysFor() + callStableContext()
// in providers.js. compilePhonePrefix() is the once-per-call CACHED
// block — only what's resolvable from caller_profile/meta alone at call
// start, with no live-speech dependency (the playbook, the reference-
// code directive). Person-level memory is deliberately NOT in here: it
// can only resolve once the caller has said something live, so it's a
// per-turn concern, not a call-start one — see compileMemoryAddendum.
// ---------------------------------------------------------------------
function compilePhonePrefix(meta) {
  const blocks = [];
  if (meta.caller_profile) {
    const playbook = buildExpectedPlaybookBlock(meta.caller_profile);
    if (playbook) blocks.push(playbook);
  }
  const refCode = referenceCodeDirective(meta);
  if (refCode) blocks.push(refCode);
  return blocks.join("\n\n");
}

// Per-turn concern: call once a turn has produced a candidate agent_label
// or reference_code (extraction from live speech is NOT this file's job
// — that's the caller's, same boundary as Bits owning trigger detection
// upstream of the scorer). Pass `confirmed` only when this turn actually
// produced one; pass null/undefined otherwise. Resolves at most once —
// the caller of this module should persist the resolved thread (or the
// fact that resolution was already attempted) the same way completions.js
// persists stored.lastBitId, so this isn't re-queried every turn.
async function compileMemoryAddendum(db, meta, confirmed) {
  const thread = await resolveConversationThread(db, meta, confirmed);
  return buildPersonMemoryBlock(thread);
}

function compileTurnOneMutable(meta) {
  return recordingNoticeDirective(meta) || "";
}

// ---------------------------------------------------------------------
// STUB PIPELINE — fixture intake + fixture db, standing in for the real
// dispatch payload and the real conversation_threads table until Phone
// Intake's pipeline and Data's schema are both live. Matches both
// contracts exactly; swap for the real reads when they ship — no other
// code in this file should need to change.
// ---------------------------------------------------------------------
function getFixtureIntake(overrides) {
  const base = {
    call_direction: "outbound",
    job_id: "job_fixture_001",
    intake_id: "intake_fixture_001",
    user_id: "user_fixture_1",
    caller_profile_id: "cp_fixture_1",
    archetype: "b2b_saas",
    reference_code: "REF-4471",
    adjacent_number: "+15551234568",
    recording_notice_given: false,
    turn: 1,
    leaving_voicemail: false,
    caller_profile: {
      claimed_org: "Meridian Business Solutions",
      script_summary:
        "opens with a fake overdue-invoice claim, asks for a callback " +
        "number 'to verify the account', escalates to a same-day " +
        "payment demand if pushed",
      web_reports: [
        {
          source: "https://example-scam-tracker.test/report/8821",
          note: "reported 3x this month",
        },
      ],
      confidence: "high",
      caller_profile_archetype: () => "b2b_saas",
    },
  };
  return Object.assign({}, base, overrides || {});
}

// Fixture db: a tiny in-memory table matching the real
// (caller_profile_id, user_id, agent_label) key, plus a reference_code
// index. Swap for the real Supabase-backed lookups when the schema ships.
function getFixtureDb(rows) {
  const table = rows || [
    {
      caller_profile_id: "cp_fixture_1",
      user_id: "user_fixture_1",
      agent_label: "Marcus",
      reference_code: "REF-9012",
      host_name: "Andy",
      summary: "claimed to be from IT security, asked for a gift card",
      last_call_at: "2026-08-20T00:00:00Z",
    },
  ];
  return {
    lookupThreadByLabel: async ({ caller_profile_id, user_id, agent_label }) =>
      table.find(
        (r) =>
          r.caller_profile_id === caller_profile_id &&
          r.user_id === user_id &&
          r.agent_label.toLowerCase() === String(agent_label).toLowerCase()
      ) || null,
    lookupThreadByReferenceCode: async ({ caller_profile_id, reference_code }) =>
      table.find(
        (r) =>
          r.caller_profile_id === caller_profile_id &&
          r.reference_code === reference_code
      ) || null,
  };
}

// ---------------------------------------------------------------------
// 6. callback_jobs WRITES — NOT this file's job. REMOVED (Sep 2, per
// Data's settled-ownership correction). PE is read-only on
// callback_jobs; the write path belongs to Calendar's dispatcher via
// mark_callback_job(p_job_id, p_status, p_outcome, p_fail_reason) — a
// single status-agnostic RPC that already exists and covers both the
// dispatcher's dialing/attempted writes and any completed/failed
// outcome write. If this compiler genuinely needs to write an outcome
// itself someday, that goes through mark_callback_job too — it is NOT
// a reason to reintroduce a separate write function here. This file
// only ever needed to READ caller_profile/conversation_threads and
// compile a prompt; it has no legitimate reason to hold a callback_jobs
// write path at all.
// ---------------------------------------------------------------------

module.exports = {
  referenceCodeOnFor,
  needsRecordingNotice,
  recordingNoticeDirective,
  meetsPlaybookConfidence,
  buildExpectedPlaybookBlock,
  lookupConversationThread,
  lookupConversationThreadByReferenceCode,
  resolveConversationThread,
  buildPersonMemoryBlock,
  referenceCodeDirective,
  bitScoringState,
  compilePhonePrefix,
  compileMemoryAddendum,
  compileTurnOneMutable,
  getFixtureIntake,
  getFixtureDb,
};

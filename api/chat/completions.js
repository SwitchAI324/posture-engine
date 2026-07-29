# SpamViking — Silence / Stall / Firing Reference

The single reference for the area where PE, the agent, and the bits
registry meet to decide "what does the host do on a turn — especially
a silent one during a stall."

Two parts:
  PART 1 — DICTIONARY: what every load-bearing word means (so the
           same word stops meaning two things across four files).
  PART 2 — THE MAP: what actually happens on a turn, who owns each
           piece, and why each scar exists.

Read Part 1 first; Part 2 uses its vocabulary. Produced with ZERO
code changes — this is documentation, plus the agreement for what to
rename TO in a later flagged pass.

Confidence note up front: the PE side (completions.js) was read
verbatim and is HIGH confidence. The AGENT side (spamviking-agent /
main7.py) was CONFIRMED Jul 29 by Voice reading the actual main7.py
(not comments) — every former [CONFIRM-AGENT] line is now marked
[AGENT-CONFIRMED Jul 29]. The whole reference is now code-verified end
to end. Remaining open caveat: the plugin `extra_content` mapping was
verified against Voice's sandbox plugin version, not the deployed
worker's — the `silence: pe_stall seen` log on the first live stall is
the real confirmation it survives on the deployed version.

════════════════════════════════════════════════════════════════════
# PART 1 — DICTIONARY
════════════════════════════════════════════════════════════════════

Built from the terms actually in the code. Where a term collides or
is ambiguous, COLLISION says so and RULING gives the one meaning to
keep. PROPOSED — nothing renamed in code yet.

--------------------------------------------------------------------
## GROUP A — WHO/WHAT FIRES A TURN

TURN
  One request/response cycle through completions.js. Either
  caller-driven or a silence nudge. The atomic unit.

CALLER TURN
  A turn triggered because the caller spoke. Array ends in a `user`
  line with real caller text.

SILENCE NUDGE  (agent: the watchdog "fires a nudge")
  A turn the AGENT fires on its own because the caller went quiet.
  No new caller text. PE infers it from role + history.
  COLLISION: "nudge" gets used loosely for any re-engage.
  RULING: NUDGE = specifically an agent-fired silence turn. Nothing
  else is a nudge.

WATCHDOG  (agent: silence_watchdog)
  The agent-side loop that detects quiet and fires nudges on a
  backoff schedule. Owns WHETHER a silence turn happens. Does NOT
  decide what the host says (that's PE).

KEY FACT (corrects a common misread): on LiveKit there is NO "PE
fires its own turn" path. PE is a RESPONDER — it runs only when the
agent calls it, and never schedules itself. So "the host froze and
wouldn't come back" is ALWAYS about the agent's watchdog, never PE
failing to self-fire (PE can't self-fire).

--------------------------------------------------------------------
## GROUP B — THE TWO "STEP" LADDERS  ← the #1 collision

Two different step-sequences exist and both have been called "beat."
Split permanently:

BEAT  → RESERVED for the SILENCE WATCHDOG's backoff steps ONLY.
  beat 1 = first re-engage (warm), beat 2 = second (concerned),
  beat 3 = register shift — Call Design's scapegoat check-in copy
  (blame the line/wifi, concern for the PERSON). Agent stamps
  `silence_beat=N` (values 1/2/3). About RE-ENGAGING A QUIET CALLER.

RUNG  → RESERVED for a BIT LADDER's steps.
  rung 1 = cold open, rung 2 = next escalation, … to the ceiling.
  About ADVANCING A BIT'S ROUTINE (approver hunt: Slack → rings out
  → in a meeting → ping-pong → dead-end).
  COLLISION (current): BIT-233's directive and PE's hint BOTH say
  "beat". RULING: rename those to "rung". `silence_beat` stays
  "beat" (it's the other ladder).

  Mnemonic: BEAT = the clock ticking on a silent caller.
            RUNG = the host climbing a bit's own ladder.

BACKOFF
  The widening GAPS between watchdog BEATS are 5/8/15s → fire at
  ~5s/13s/28s of continuous quiet. A property
  of the beat ladder, not the rung ladder.

--------------------------------------------------------------------
## GROUP C — STALL: THE WORD THAT IS SECRETLY TWO THINGS

"Stall" means two OPPOSITE behaviors depending which build you read.
This ambiguity IS the BIT-233 freeze bug.

STALL  (umbrella)
  Any bit on `lane: "stall"` — a time-wasting move that keeps the
  spammer on the line. Umbrella only; every stall is one type below.

HOLD-STALL
  A stall where THE SILENCE IS THE JOKE. The host deliberately goes
  quiet and the payload is the host NOT talking — the spammer is
  meant to sit in it or fill it. Behavior: SUPPRESS nudges, hold
  silent, let it hang.
  REAL-WORLD EXAMPLE — BIT-211, The Silence / The Pile-Up: the host
  finishes a thought and just stops. The whole bit is that the
  unnerved spammer fills the silence — walking back their pitch,
  over-explaining. If the watchdog poked "you still there?" into
  that, it would DESTROY the bit: the host isn't absent, the host is
  weaponizing the silence. Suppress is correct here.

HUNT-STALL
  A stall where THE SILENCE IS DEAD AIR the host should FILL by
  advancing the RUNGS ("still trying her… not at her desk…"). The
  host does busywork so the SPAMMER waits. Behavior: ADVANCE the rung
  ladder on silence; do NOT suppress.
  REAL-WORLD EXAMPLE — BIT-233, The Approver Hunt: host says "let me
  go find the approver" and then owes a continuation. Nobody's
  weaponizing anything; the host just needs to keep working so the
  spammer holds. Freezing here is the bug Andrew heard.

  THE DISTINCTION IN ONE LINE:
    hold-stall = the silence is the joke (stay quiet on purpose).
    hunt-stall = the silence is dead air (fill it with rungs).

  COLLISION (current, = the bug): both types are just `lane:"stall"`
  and both stamp the same `pe_stall` flag, so the agent SUPPRESSES
  both — correct for BIT-211, WRONG for BIT-233 (freezes the hunt).
  The system literally cannot tell them apart today.
  RULING: a bit must DECLARE its type (`stall_type: hold|hunt`,
  Group F), and the flag must carry it so the agent holds hold-stalls
  and advances hunt-stalls. Naming the two types IS the fix.

--------------------------------------------------------------------
## GROUP D — THE SIGNALS ON THE WIRE (PE → agent)

pe_stall  (PE emits; agent reads)  [AGENT-CONFIRMED Jul 29: latch]
  Current: boolean "this turn was a stall beat, hold your nudge."
  Rides `delta.extra_content` INSIDE the delta (NOT top-level).
  RULING (later): carry the STALL TYPE (hold vs hunt), not a bare
  boolean, so the agent knows whether to suppress or advance.

silence_beat=N  (agent emits; PE reads)  [AGENT-CONFIRMED Jul 29]
  Which watchdog BEAT this nudge is. Lets PE escalate the re-engage
  line. Optional; PE falls back if absent.

extra_content
  The ONLY delta field that survives the LiveKit OpenAI plugin to
  the agent. Every PE→agent signal must ride inside it. A top-level
  field is silently dropped.

--------------------------------------------------------------------
## GROUP E — HOW A BIT GETS PICKED / FIRED  (mostly clean)

FIRE / FIRED
  A bit was selected AND injected as an active directive this turn
  ("fired:true"). NOT "the caller heard it" — preemptive generation
  can discard a fired turn. Never judge a fire from the OUT line.

POOL
  Bits eligible to be scored this turn (after phase/lane gates).

BAR / GAP / SCORE
  BAR = threshold to fire. GAP = turns since last fire (spacing).
  SCORE = fit this turn. Fire ≈ score ≥ bar AND gap ≥ min.

GATE / GATED
  A rule that removes a bit from the pool before scoring.
  "POOL-GATED" = gated out but fired anyway via override (how
  BIT-233 fires despite the phase gate).

RE-INJECT vs SUSTAIN  (both re-apply a bit — keep distinct)
  RE-INJECT = the SAME bit re-applied on a regenerated SAME-TURN
    roll (preemptive-gen fix) so the re-roll isn't bit-less.
  SUSTAIN = re-firing BIT-233 across SUBSEQUENT turns to hold the
    floor (hunt-window). Same-turn vs across-turn.

FLOOR / HOLD THE FLOOR  (hunt-window)
  FLOOR = the window suppressing OTHER bits so BIT-233 owns the turn.
  COLLISION: "hold" also = "stay silent" (hold-stall). RULING: say
  "hold the floor" (bits) vs "hold silent / hold-stall" (silence).
  Never bare "hold" in cross-file text.

--------------------------------------------------------------------
## GROUP F — PER-BIT DECLARED FIELDS (registry, Bits) — data that should own behavior

The goal: move behavior OUT of scattered code INTO these fields.

lane: "stall" | "gag" | ...   — category. EXISTING.
beats  — MISNAMED: it's the RUNG count. RULING: rename to `rungs`
  when touched. EXISTING (inert; PE consumer not built).
ceiling: "soft_dead_end"  — top-rung behavior. Clean. EXISTING
  (inert).
PROPOSED NEW:
  stall_type: "hold" | "hunt"  — which stall behavior (Group C).
    The field that fixes the freeze.
  silence_fills: N  — how many RUNGS the host may advance on its own
    during silence before giving up (bounded).

--------------------------------------------------------------------
## THE COLLISIONS, IN ONE LIST

1. BEAT = both watchdog-step and bit-ladder-step.
   → BEAT = watchdog only; bit ladder = RUNG.
2. STALL = both deliberate-pause and active-hunt.
   → umbrella "stall"; declare HOLD-STALL vs HUNT-STALL. THE BUG.
3. HOLD = both "stay silent" and "own the floor".
   → "hold silent / hold-stall" vs "hold the floor". Never bare.
4. RE-INJECT vs SUSTAIN both "re-apply same bit".
   → RE-INJECT = same-turn; SUSTAIN = across-turn.
5. Registry `beats` actually counts RUNGS.
   → rename to `rungs` on next Bits touch.

Clean (no action): ceiling, pool, bar, gap, score, gate/gated, fire,
lane, watchdog, nudge (once ruled), silence_beat, extra_content.

════════════════════════════════════════════════════════════════════
# PART 2 — THE MAP
════════════════════════════════════════════════════════════════════

## 1. What triggers a host turn at all

Two ways completions.js runs:
  (a) CALLER TURN — the caller spoke; array ends in a real `user`
      line.
  (b) SILENCE NUDGE — the agent's watchdog noticed quiet and fired a
      turn on its own. [AGENT-CONFIRMED Jul 29] Watchdog polls session state
      every 0.25s (SILENCE_POLL_SEC), 3-BEAT backoff gaps 5/8/15 →
      fire ~5s/13s/28s, caps at 3,
      then holds silent to a 60s ceiling → silent close.

No third path. PE can't self-fire (Group A key fact).

## 2. How PE recognizes a silence nudge  (completions.js ~887)

PE infers it from TWO conditions together:
  - array's LAST role is `assistant` (host spoke last, no new caller
    line), AND
  - the caller HAS spoken earlier (not the opener).
PE does NOT sniff text for silence words (isSilenceNudge scar, §6).
Optional: agent may stamp `silence_beat=N` in request metadata; PE
reads it defensively from 3 spots, falls back if absent.

## 3. What PE says on a silence nudge  (completions.js ~918-943)

PE appends ONE synthetic `user` stage-direction telling the model how
to fill the silence. Which one depends on whether the LAST FIRED BIT
was a stall:

  IF last bit was STALL-lane (`lastBitStall`):
    "You're mid-stall, YOU're occupied (looking something up / trying
    to reach someone). The quiet is you being busy, not the caller
    leaving. Do NOT ask if they're there. Play the next small step,
    one step, then stop — or hold. Keep the loop open."
    => host ADVANCES/HOLDS the routine. What a HUNT-STALL wants.

  ELSE (normal silence), by BEAT:
    beat 1 → check in once, warm, assume good reason.
    beat 2 → reach out once more, a touch concerned, don't repeat.
    beat 3+ → REGISTER SHIFT: concern for the PERSON, not the call.

So PE's INTENT on a stall silence is already "advance/hold, never
caller-check." That part is built and correct.

## 4. THE COLLISION — why the host still froze on the live test

TWO stall mechanisms point OPPOSITE ways, built at different times:

  MECHANISM 1 — PE's stall SILENCE backstop (§3, Jul 26): if a nudge
    arrives during a stall, redirect the host to CONTINUE. ADVANCES.

  MECHANISM 2 — PE's `pe_stall` SUPPRESS flag (~806, emitted ~985):
    on ANY stall-bit fire, PE stamps pe_stall → [AGENT-CONFIRMED Jul 29] the
    agent LATCHES and SUPPRESSES the watchdog — host stays SILENT
    until the caller speaks or the 60s ceiling closes.

The conflict: Mechanism 2 stops the silence turn from firing at all,
so Mechanism 1 (which only runs "if a nudge arrives") NEVER RUNS. Net
effect: host fires a stall beat, then SILENCE, held until the caller
speaks. = exactly what Andrew heard.

WHY (scar origin, Jul 26): back then "stall" = DELIBERATE DEAD PAUSE
(a HOLD-STALL, in today's words), and the watchdog was poking into
it; suppress was the correct fix. WHAT CHANGED: Step 3 introduced the
HUNT-STALL, which wants the opposite. The scar isn't wrong — it's
solving the hold-stall problem. The hunt-stall didn't exist when it
was written. (This is dictionary collision #2, live.)

## 5. Who owns each piece

  REGISTRY (_bits_registry.js, Bits) — declares WHAT a bit is:
    lane:"stall", beats(→rungs):5, ceiling — DATA.
  PE (completions.js) — decides WHAT THE HOST SAYS + emits signals:
    ~806 turnIsStall · ~985 emit pe_stall (Mech 2) · ~887 nudge
    detect · ~918 stall backstop (Mech 1) · ~1426 HUNT_WINDOW
    (advance on CALLER turns, the Step-3 proven part). Signals ride
    delta.extra_content, never top-level.
  AGENT (main7.py, Voice) [AGENT-CONFIRMED Jul 29]: decides WHETHER a turn
    fires on silence — watchdog, pe_stall suppress latch (Mech 2),
    silence_beat stamp, 60s ceiling → silent close.

## 6. The scars — what each PROTECTS (do not remove blind)

Each looks like cruft; each is load-bearing (fixed a real bug).

  - isSilenceNudge scar: engine NEVER sniffs prompt/host TEXT for
    content words (forced false). BAD IT FIXED: text-sniffing once
    made fire=false every turn → NO bit could ever fire. NOW: keys
    off ROLE/LANE (state), never text.

  - top-level-await ban in api/: a top-level await breaks the WHOLE
    site build (Vercel transpiles ESM→CJS where it's illegal). BAD:
    one such await took down every deploy site-wide. NOW: lazy-load.

  - extra_content-not-top-level: signals must sit INSIDE delta or the
    LiveKit OpenAI plugin silently DROPS them. BAD: a top-level
    pe_stall never reached the agent (verified in plugin source).
    NOW: wire-key extra_content inside the delta.

  - pe_stall suppress latch (Mechanism 2): protects HOLD-STALLS (e.g.
    BIT-211) from the watchdog poking into a deliberate pause. BAD:
    "you still there?" fired into a hanging silence and killed the
    bit. This is the one now fighting the HUNT-STALL — real for hold,
    wrong for hunt.

  - trailing-assistant prefill guard: the synthetic silence line
    always ends the array in `user`. BAD: a trailing-assistant array
    returned empty output.

  - cache-wall renames (agent): entrypoint filename must match the
    Dockerfile CMD exactly or the worker won't spawn (main7 now).
    BAD: mismatched name → "Failed to spawn" → no deploy.

## 7. What this says the fix is  (for LATER, not now)

The BIT-233 freeze is NOT a missing mechanism. It's collision #2
live: one word ("stall") doing two opposite jobs. Mechanism 1 already
wants to advance the hunt on silence but never runs, because
Mechanism 2 suppresses the silence turn.

Fix shape: make the two agree for hunt-stalls — EITHER BIT-233 stops
stamping the suppress flag (let the nudge through so Mechanism 1
advances), OR the flag splits to carry `stall_type` so each bit
declares hold vs hunt. Both are one-flag-shaped, cross PE↔agent, and
must be flagged + proven live. The dictionary's `stall_type` field is
the clean version.

## 8. Confidence / verify before trusting

- PE side: read verbatim this session. HIGH.
- Agent side: CONFIRMED Jul 29 by Voice reading main7.py directly
  (not comments). Every former [CONFIRM-AGENT] line verified true.
- RESOLVED Jul 29: the agent DOES latch on pe_stall and suppress the
  watchdog — FULLY latched (not one-cycle), clears only on caller
  speech or the 60s ceiling. §4/§7 confirmed from the agent side, not
  inferred. The freeze is the latch working as built for a HOLD-stall,
  applied wrongly to a HUNT-stall.
- REMAINING open caveat: the delta.extra_content plugin mapping was
  verified against Voice's sandbox plugin, not the deployed worker's.
  The `silence: pe_stall seen` log on the first live stall confirms it
  survives on the deployed version.

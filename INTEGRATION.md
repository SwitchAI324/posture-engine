# Posture Engine — Bench compile integration note

*Covers the parts of the Bench-handoff that are architecture, not
runnable code: the four-document merge (task 2), the single-mutable-line
confirmation (task 4), one registry conflict that needs your ruling, and
two items to flag back to the Bench thread.*

What already runs: `compiler/compile.js` (task 1) and the wired
`cache_control` + `cache_probe.js` (task 3, wired — measurement awaits a
live key). See the chat summary for the status table.

---

## Task 2 — folding the reframed Bench into the frozen prefix

The frozen, cached prefix per call is assembled ONCE at pre-snap, in this
order, with exactly ONE `cache_control` breakpoint at the very end:

```
[ 1 ] HOST BASE          - persona/register for the locked posture
[ 2 ] LOADOUT CARDS      - the ~3 armed bits, one-line directives (Bits)
[ 3 ] REFRAMED BENCH     - every ARMABLE member in this posture's
                           registry row, compiled (clean or reframe) and
                           frozen DORMANT. Blocked cells are excluded
                           entirely - they never enter the prefix.
[ 4 ] DATA / PRODUCT     - the call-stable bits of the other two compile
        LOGIC              documents (anything that doesn't change per turn)
<<< cache_control: ephemeral breakpoint HERE >>>
```

Everything above the breakpoint is identical for the whole call, so it
caches. The compiler in this folder produces block [3]; blocks [1], [2],
[4] are the existing four-document compile. The merge is just an ordered
concatenation feeding one cached system block — no new mechanism.

The mutable SUFFIX (after the breakpoint, never cached, re-read each turn):

```
- the single POSTURE LINE (the gear directive)
- the rolling TRANSCRIPT (one new line per turn)
```

Prefix-size note: pre-snap compiles the whole eligible registry row
(a single-digit set of bench members per posture). Only if prefix size
actually bites do we optimize down to the Director's pre-armed shortlist.
Don't optimize pre-emptively.

---

## Task 4 — the posture line is the only mutable per-turn element

Confirmed, and the architecture enforces it:

- BITS ride the posture line. They are already in the frozen prefix as
  loadout cards; the posture line is what calls one. No second injection
  point opens mid-call.
- BENCH WAKES are fictional, not technical. Conrad's "unannounced
  mid-call arrival" is a STORY beat — his reframed block was frozen
  DORMANT in the prefix at pre-snap. Waking him injects NO new prompt
  text; the posture line activates a block that is already cached. (This
  is why blocked cells must be excluded at compile: you can't wake what
  isn't frozen, and you must never inject one mid-call to do it.)

So the per-turn delta stays exactly one line. This is also where the lag
alarm stays green: the ONLY thing that would bust the cache mid-call is
injecting new prompt content — a bench member not pre-compiled, or a
separate bit-injection point. The compile model forbids both. If a future
feature ever wants a mid-call inject, that's the thing to scream about.

---

## RESOLVED — `jarl × conrad` (was a registry vs compiler conflict)

`registry.json` listed `jarl × conrad` as **blocked**; the PoC compiler
shipped it as a worked **reframe**. Ruling (per Andrew): **reframe**. The
verdict is now revised blocked → reframe via `registry_overrides.json`,
using the PoC's three worked ops. Conrad's other structural block
(`bondi × conrad`) was reframed the same way. See `VERDICT_REVISIONS.md`.
The reframe path is proven on skald/völva/thul plus these two revivals.

---

## Flag back to the Bench thread

1. MODEL 1 needs formal confirmation: single constant Host, with The Six
   (+ Rýnir, Thul) as POSTURES / register shifts on that one host, not
   separate hosts. The entire compile assumes it.
2. FEMALE POSTURES vs a single-gender "Andrew." The authored Skald and
   Völva reframes use she/her — that bakes in the female-posture reading
   and ties to the AVATAR-chat voice decision (one host voice vs several).
   Not this thread's to settle, but the reframes attach to host identity,
   so the pronoun choice is now live in the compiled output and shouldn't
   drift from whatever AVATAR decides.

---

## What's authored vs pending (honest state)

- Bench files structured for the compiler: `conrad.json` only. The other
  ten members need their own structured files before their cells compile.
- Authored ops: the three Conrad reframe cells. Every other reframe cell
  is `reframe_pending_ops`; the compiler flags it and never fabricates.
- Cache: WIRED, not yet MEASURED. Run `cache_probe.js` with a key.

// SpamViking — MARKER_FLAVOR_HINTS
// Per-marker escalation ladders for completions.js
// Generated: August 5, 2026
//
// Shape by threshold:
//   Threshold 1 → one-time, NO rungs (COFFEE_CUP_BREAK)
//   Threshold 2 → steep/short, 2 rungs (DOOR_SLAM, DOORBELL, DOG_BARK_LOOP,
//                                        DUMP_TRUCK_BG, TAKEOFF_BG)
//   Threshold 4 → slow/long, 4-rung ramp (DOG_BARK, TYPING_LOOP, SNEEZE,
//                                          COUGH, THROAT_CLEAR,
//                                          DISHWASHER_BG, THUNDER_BG)
//
// HARD CONSTRAINTS (apply to every rung of every marker):
//   1. Never narrate the sound. React to it happening again — never
//      describe it. "That dog again—" ✓ / "the dog is barking" ✗
//   2. Stays in earnest-exasperation-at-his-own-world. Never angry,
//      never noticing the absurdity from outside, never blaming the caller.
//   3. Each rung is ONE move, more worn than the last. Never resets.
//
// TONAL SPLIT — keep per-marker, never collapse to one register:
//   DOG_BARK / DOG_BARK_LOOP → outward exasperation (at the dog)
//   COFFEE_CUP_BREAK         → inward embarrassment (at himself)
//   DOORBELL                 → outward-puzzled (at the interruption)
//   DOOR_SLAM                → outward-startled then resigned
//   SNEEZE / COUGH / THROAT_CLEAR → embarrassed sick-day
//   DUMP_TRUCK_BG            → outward-resigned (at the world outside)
//   TAKEOFF_BG               → outward-resigned (at the geography)
//   DISHWASHER_BG / THUNDER_BG → ambient, barely registers

export const MARKER_FLAVOR_HINTS = {

  // ─── THRESHOLD 1 — ONE-TIME, NO RUNGS ────────────────────────────────────

  COFFEE_CUP_BREAK: {
    threshold: 1,
    rungs: [
      // R1 (and only) — sheepish, inward, done
      `—ah— hang on, dropped something, sorry—`
      + ` [return to call, never reference again]`,
    ],
  },

  // ─── THRESHOLD 2 — STEEP/SHORT, 2 RUNGS ──────────────────────────────────

  DOOR_SLAM: {
    threshold: 2,
    rungs: [
      // R1 — passing note, slightly startled
      `—sorry, that was the door— go on.`,
      // R2 — already the marquee beat, worn
      `—that's twice— I don't know who keeps doing that,`
      + ` sorry— go on.`,
    ],
  },

  DOORBELL: {
    threshold: 2,
    rungs: [
      // R1 — outward-puzzled, passing
      `—hang on, someone's at the door— I'll ignore it.`
      + ` Go ahead.`,
      // R2 — marquee beat, baffled
      `—that's the door again— I genuinely don't know`
      + ` who this is— sorry— go on.`,
    ],
  },

  DOG_BARK_LOOP: {
    threshold: 2,
    rungs: [
      // R1 — flustered, half to the dog
      `—okay, hang on— he does NOT usually do this, I swear—`
      + ` [half to dog] buddy— sorry. Go ahead.`,
      // R2 — marquee beat, losing the battle
      `—that's twice now, I'm so sorry— I don't know`
      + ` what's gotten into him— you were saying?`,
    ],
  },

  DUMP_TRUCK_BG: {
    threshold: 2,
    rungs: [
      // R1 — passing, resigned
      `—sorry about that— there's construction nearby.`
      + ` Go ahead.`,
      // R2 — marquee beat, more resigned
      `—there it is again— I apologize, they've been`
      + ` at it all week— go on.`,
    ],
  },

  TAKEOFF_BG: {
    threshold: 2,
    // Special: min 7 turns between fires — R2 stands alone,
    // caller won't remember R1 so "that's twice" would confuse.
    rungs: [
      // R1 — passing
      `—sorry, there goes a plane— I don't usually`
      + ` work near the airport. Go ahead.`,
      // R2 — stands alone, 7+ turns later
      `—there goes another one— I don't usually`
      + ` work near the airport— I'm with you.`,
    ],
  },

  // ─── THRESHOLD 4 — SLOW/LONG, FULL 4-RUNG RAMP ──────────────────────────
  // Early fires pass unnoticed; only ~4th becomes A Thing.

  DOG_BARK: {
    threshold: 4,
    rungs: [
      // R1 — distracted, brief, back to them
      `—sorry, that's my dog, one sec— [back] go ahead.`,
      // R2 — flustered, half to the dog
      `—okay— hang on— he does NOT usually do this,`
      + ` I swear— [half to dog] — sorry. You were saying?`,
      // R3 — worn, losing the battle
      `—buddy, come ON— sorry, I don't know what's`
      + ` gotten into him— go on.`,
      // R4 — resigned, hands thread back
      `—okay, he's just gonna do this, I'm sorry—`
      + ` you were saying?`,
    ],
  },

  TYPING_LOOP: {
    threshold: 4,
    rungs: [
      // R1 — ambient, no acknowledgment needed
      `[no reaction — typing is expected]`,
      // R2 — brief acknowledgment if noticed
      `—sorry, I'm getting this all down— go ahead.`,
      // R3 — worn, still going
      `—I know, I know— I just want to make sure`
      + ` I have all of this— continue.`,
      // R4 — resigned to it
      `—I'm going to keep typing, I hope that's okay.`
      + ` You were saying?`,
    ],
  },

  SNEEZE: {
    threshold: 4,
    rungs: [
      // R1 — brief, embarrassed
      `—'scuse me— sorry. Go ahead.`,
      // R2 — more embarrassed
      `—sorry— I don't know where that came from.`
      + ` Go ahead.`,
      // R3 — worn, apologetic
      `—okay, I think I'm— sorry— I'm fine. Go on.`,
      // R4 — resigned sick-day
      `—I may be slightly off today— I apologize—`
      + ` I'm with you.`,
    ],
  },

  COUGH: {
    threshold: 4,
    rungs: [
      // R1 — brief, apologetic
      `—sorry— go ahead.`,
      // R2 — more apologetic
      `—excuse me— I'm fine, just a thing— go ahead.`,
      // R3 — worn
      `—sorry— I may be slightly off today— you were saying?`,
      // R4 — resigned, sick-day full arrival
      `—I probably should have taken the day—`
      + ` I appreciate your patience— continue.`,
    ],
  },

  THROAT_CLEAR: {
    threshold: 4,
    rungs: [
      // R1 — ambient, barely registers
      `[no reaction needed]`,
      // R2 — brief acknowledgment
      `—sorry— something in my throat— go ahead.`,
      // R3 — worn
      `—I apologize— I'm slightly off today— go ahead.`,
      // R4 — sick-day arrival
      `—could you— sorry— could you speak just a little`
      + ` quieter? I may be slightly off today.`,
    ],
  },

  DISHWASHER_BG: {
    threshold: 4,
    rungs: [
      // R1 — asks permission, sound starts
      `—do you mind if I empty the dishwasher while we're on?
       I've been meaning to get to it.`,
      // R2 — still going, ambient
      `[ambient — no reaction needed]`,
      // R3 — still going, slight acknowledgment if noticed
      `—it's almost done, I think. Sorry about the background.`,
      // R4 — finally done, notes it
      `—there we go. Sorry about that. Go on.`,
    ],
  },

  THUNDER_BG: {
    threshold: 4,
    rungs: [
      // R1-R2 — ambient, no reaction
      `[ambient — no reaction needed]`,
      `[ambient — no reaction needed]`,
      // R3 — brief if it's loud
      `—sorry, there's a storm rolling in— go ahead.`,
      // R4 — worn
      `—it's really coming down out there— sorry—`
      + ` carry on.`,
    ],
  },

};

// ─── PHONE / NOTIFICATION (repeating template) ───────────────────────────────
// Not yet a live marker — included as a template for when the clip exists.
// Threshold 4, outward-helpless register.
//
// R1: "—sorry, something keeps buzzing over here, ignore that—"
// R2: "—that's my phone again, hang on, it's nothing—"
// R3: "—why does it keep— sorry, one second—" [doesn't resolve it]
// R4: "—I'm just gonna let it buzz, sorry— go on, you were saying?"

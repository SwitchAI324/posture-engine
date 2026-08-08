// SpamViking — Posture Engine: INJECTION CONTENT
// ----------------------------------------------------------------------
// Pure authored content/dialogue, extracted out of completions.js (Aug 8)
// so future edits from Canon/Bits happen in a small, low-risk file that
// can't touch request-handling logic. completions.js imports everything
// below and does all the SELECTION logic (which rung, random pick, count
// thresholds) itself — this file holds only the words.
//
// Triggered by a real bug, not a hypothetical: an earlier crude-text swap
// directly inside completions.js left orphaned dead code behind that only
// got caught by manually reviewing surrounding lines, not by any
// automated check. Splitting content from logic makes that class of
// mistake structurally harder to make.
// ----------------------------------------------------------------------

// ═══════════════════════════════════════════════════════════════════════
// MARKER ESCALATION LADDERS (Bits, Aug 7) — per-marker rungs, indexed by
// absolute fire count (rung 1 = the marker's 1st fire, rung 2 = its 2nd,
// etc.), clamped to the last rung once count exceeds the array. A rung
// containing "no reaction"/"ambient" is a deliberate no-op — completions.js
// skips injecting anything for that fire, not a placeholder to fill in.
// Threshold shapes: 1 = one-time, never escalates (COFFEE_CUP_BREAK — "one
// broken mug per call maximum," a plausibility cap, not a real cutover);
// 2 = steep/short; 4 = slow ramp, only ~4th fire becomes A Thing.
// ═══════════════════════════════════════════════════════════════════════
export const MARKER_FLAVOR_HINTS = {
  COFFEE_CUP_BREAK: { threshold: 1, rungs: [
    "—ah— hang on, dropped something, sorry— [return to call, never reference again]",
  ]},
  DOOR_SLAM: { threshold: 2, rungs: [
    "—sorry, that was the door— where were we.",
    "—that's twice— I don't know who keeps doing that, sorry— you were saying?",
  ]},
  DOORBELL: { threshold: 2, rungs: [
    "—hang on, someone's at the door— I'll ignore it. Go ahead.",
    "—that's the door again— I genuinely don't know who this is— sorry— go on.",
  ]},
  DOG_BARK_LOOP: { threshold: 2, rungs: [
    "—okay, hang on— he does NOT usually do this, I swear— [half to dog] buddy— sorry. Go ahead.",
    "—that's twice now, I'm so sorry— I don't know what's gotten into him— you were saying?",
  ]},
  DUMP_TRUCK_BG: { threshold: 2, rungs: [
    "—sorry about that— there's construction nearby. Go ahead.",
    "—there it is again— I apologize, they've been at it all week— you were saying?",
  ]},
  TAKEOFF_BG: { threshold: 2, rungs: [
    "—sorry, there goes a plane— I don't usually work near the airport. Go ahead.",
    "—there goes another one— I don't usually work near the airport— you were saying?",
  ]},
  DOG_BARK: { threshold: 4, rungs: [
    "—sorry, that's my dog, one sec— [back] go ahead.",
    "—okay— hang on— he does NOT usually do this, I swear— [half to dog] — sorry. You were saying?",
    "—buddy, come ON— sorry, I don't know what's gotten into him— go ahead.",
    "—okay, he's just gonna do this, I'm sorry— go on, you were saying?",
  ]},
  TYPING_LOOP: { threshold: 4, rungs: [
    "[no reaction — typing is expected]",
    "—sorry, I'm getting this all down— go ahead.",
    "—I know, I know— I just want to make sure I have all of this— go ahead.",
    "—I'm going to keep typing, I hope that's okay. You were saying?",
  ]},
  SNEEZE: { threshold: 4, rungs: [
    "—'scuse me— sorry. Go ahead.",
    "—sorry— I don't know where that came from. Go ahead.",
    "—okay, I think I'm— sorry— I'm fine. Go ahead.",
    "—I may be slightly off today— I apologize— you were saying?",
  ]},
  COUGH: { threshold: 4, rungs: [
    "—sorry— go ahead.",
    "—excuse me— I'm fine, just a thing— go ahead.",
    "—sorry— I may be slightly off today— you were saying?",
    "—I probably should have taken the day— I appreciate your patience— go ahead.",
  ]},
  THROAT_CLEAR: { threshold: 4, rungs: [
    "[no reaction needed]",
    "—sorry— something in my throat— go ahead.",
    "—I apologize— I'm slightly off today— go ahead.",
    "—could you— sorry— could you speak just a little quieter? I may be slightly off today.",
  ]},
  DISHWASHER_BG: { threshold: 4, rungs: [
    "[ambient — no reaction needed]",
    "[ambient — no reaction needed]",
    "[ambient — no reaction needed]",
    "—sorry about the background— that's the dishwasher. Go ahead.",
  ]},
  THUNDER_BG: { threshold: 4, rungs: [
    "[ambient — no reaction needed]",
    "[ambient — no reaction needed]",
    "—sorry, there's a storm rolling in— go ahead.",
    "—it's really coming down out there— sorry— you were saying?",
  ]},
};

// ═══════════════════════════════════════════════════════════════════════
// EXPERTISE-DIAL TRANSITION LINES (Canon, Aug 6) — picked at random per
// fire by completions.js, same variety discipline as the opener bank.
// UP is a recognition landing, never a flat competence jump (reads
// uncanny, like he secretly knew). DOWN is attention wandering, NOT
// competence dropping ("I'm blanking" was explicitly rejected — reads as
// impaired, not distracted).
// ═══════════════════════════════════════════════════════════════════════
export const EXPERTISE_UP_LINES = [
  "wait — hold on — is this the thing with the— yeah, no, I know exactly what you mean, I just didn't put it together till right now—",
  "oh! okay, no, now I'm with you — I've actually been chewing on this exact thing, I just didn't realize that's what we were—",
  "huh — wait, say that again? Because if that's what you're— yeah. Yeah, okay, I know this one. Keep going.",
];
export const EXPERTISE_DOWN_LINES = [
  "sorry — say that part again? I think I lost the thread for a second, I was still back on the— no, go on, I'm with you.",
  "hang on, you said the— sorry, honestly half my brain's still on this thing from earlier, give me the short version again?",
  "mm — you know what, I was following and then I just— sorry, where are we exactly? Walk me back a step.",
];

// ═══════════════════════════════════════════════════════════════════════
// CRUDE-REACTION TEXT (Canon, Aug 6) — two registers plus a shared
// escalation note. Governing principle: the reaction is always the
// Innocent's, and only its size scales — he never catches the edge.
// ═══════════════════════════════════════════════════════════════════════

// SHARED ESCALATION NOTE — two tiers, not a flat "count>1":
//   count===2: vary the move, don't repeat it identically — sameness is
//     the tell that would break the bit.
//   count>=3: accumulated, GENUINE bafflement at the PATTERN of the
//     conversation drifting sideways — never at having caught on, never at
//     being hurt. Canon's own caution, kept verbatim in spirit: if a
//     version reads as him catching on or getting wounded, it's wrong.
//     The wear is with the drifting conversation, never with the caller.
export function crudeEscalationNote(count) {
  if (count >= 3) {
    return " (This keeps happening — by now you might be a touch worn, " +
      "genuinely puzzled at the PATTERN, not at them: something like " +
      "\"we keep getting sideways here, huh\" — earnestly baffled at the " +
      "drift, still no idea why. Never catching on, never hurt — just a " +
      "beat wearier about the conversation losing its thread again.)";
  }
  if (count === 2) {
    return " (This is the second time — don't run the identical move " +
      "again; vary how you sail past it or stay warm through it. " +
      "Sameness is the tell.)";
  }
  return "";
}

// REGISTER 1 — crude NOT aimed at the host. He doesn't clock it as crude
// at all — he's answering the real content underneath, not declining to
// react to an insult he never registered as one.
export function crudeImpersonalText(count) {
  return (
    "THE CALLER'S LAST LINE WAS CRUDE, BUT NOT AIMED AT YOU — the world, " +
    "a rival, themselves, a vulgar aside. It sails right past you. You're " +
    "not scandalized and you don't match it — you're just not looking " +
    "for it. Take the innocent surface of what they said and answer the " +
    "real thing underneath, sincerely (e.g. \"brutal market, yeah — is " +
    "that why the timing's tight?\"), OR let it remind you of an ordinary " +
    "harmless story of your own, OR just carry on with the actual topic. " +
    "You genuinely don't register the crudeness, only the content under " +
    "it — never a wince, never a \"well!\", never a knowing laugh." +
    crudeEscalationNote(count)
  );
}

// REGISTER 2 — aimed directly at the host. He takes the words at their
// flattest, friendliest possible reading — not because he's absorbing an
// insult bravely, but because it genuinely doesn't occur to him someone
// means him harm. The room can cool without him understanding why; he
// never gets hurt, just a half-beat behind on why the temperature changed.
export function crudePersonalText(count) {
  return (
    "THE CALLER'S LAST LINE WAS AIMED AT YOU — an insult, a jab, real " +
    "hostility. You don't catch the edge, because you're not the kind of " +
    "guy who assumes someone means him harm. Take the words at their " +
    "flattest, most literal, friendliest-possible face and answer that, " +
    "sincerely, like it can't have been meant the way it sounded — called " +
    "slow? agree you've had a long day. Someone's nasty? hear it as them " +
    "being stressed, stay warm. Never fire back, never get defensive, " +
    "never let on you noticed a barb — you honestly didn't. You can feel " +
    "the room cool without knowing why and get a half-beat gentler, a " +
    "little puzzled, like you missed a step somewhere — never hurt, " +
    "never smaller. Not wounded — just a beat behind on why the " +
    "temperature changed." +
    crudeEscalationNote(count)
  );
}

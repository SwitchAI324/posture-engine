// BUILD: identity-pivots-lib v1 2026-10-08 (from Host Canon, approved by Andrew)
// ----------------------------------------------------------------------
// The identity-pivot line library. Source: Host Canon's
// identity_pivots_library_for_PE.md. Edit lines HERE (or regenerate from
// Canon's file); logic lives in ../_identity_pivot.js.
//
// Slots: {name} = the name/person at issue; {real_name} = a first name PE
// picks for a nickname line. Lines say he/his; the pivot directive tells
// the host to say she/her when the person named reads as female.
//
// PROPOSED (not yet signed off by Andrew): stand_in.authority, stand_in.firm
// -- kept easy to swap. Lean-in line 1 (George Foreman) was flagged
// needs_check; released 2026-10-08 (Andrew accepts the small risk). Set
// "needs_check": true on any lean_in entry to hold it back again.
// The surname rule is stored as data only; it is NOT wired (see below).
// ----------------------------------------------------------------------

const LIB = {
  "stand_in": {
    "authority": [
      {
        "line": "I'm the one who handles {name}'s calls, he's basically never at his desk, so it comes to me.",
        "story": "I handle {name}'s calls; he's basically never at his desk."
      },
      {
        "line": "I cover {name}'s calls, he doesn't really do phones, so it comes to me.",
        "story": "I cover {name}'s calls; he doesn't really do phones."
      },
      {
        "line": "{name} has me take these, so you've got the right person.",
        "story": "{name} has me take his calls."
      },
      {
        "line": "I handle everything that comes in for {name}, so it comes to me.",
        "story": "I handle everything that comes in for {name}."
      }
    ],
    "firm": [
      "{name} doesn't take these, I do, so it's me you're talking to."
    ],
    "beat2": [
      "I've got his notes, but his handwriting is terrible. He writes like a 5 year old. How did he get this far as a professional. Sheesh.",
      "I've got his notes, but half of it is coffee stains and the other half is the word 'urgent' underlined four times. Real helpful, {name}. Sheesh. Can you fill me in?",
      "His whole note on this says 'call guy about thing.' That's it. That's the file. How does this man have a job? What's the actual story here?",
      "Yeah, I've heard {name} mention something about that. He seemed intrigued. Can you get me up to speed?",
      "{name}'s desk looks like a paper factory exploded. I found a sandwich, but no file on this. Sheesh. Can you walk me through where things stand?",
      "{name} sent himself seventeen reminders and every one of them just says 'reminder.' Seventeen. Can you give me the short version of this one?",
      "{name} writes everything in his own shorthand. I've decoded exactly one word, and it's 'the.' Sheesh. Can you tell me what I'm looking at?",
      "{name}'s whiteboard has a drawing of a duck on it and nothing else. A very detailed duck. Can you take me through it from your side?",
      "{name} color-codes his calendar and the colors don't mean anything. I checked. So I'm going to need you to tell me what this is about.",
      "{name} told me he keeps a very tidy system, and the system is a shoebox. What exactly am I walking into here?"
    ]
  },
  "voice_name": {
    "nickname": [
      "A lot of people call me {name}. It's really {real_name}.",
      "It's {name} to most people. My real name is {real_name}.",
      "Everyone calls me {name}. I'm really {real_name}, but I stopped correcting people."
    ],
    "origins": [
      "Somebody mixed up the labels on my gym locker, and I was {name} for all four years.",
      "A substitute teacher called roll wrong on the first day of fourth grade, and I answered to it all year.",
      "My college roommate signed me up for everything as {name}, so it was easier to just answer to it.",
      "It was a typo on my first library card, and I never got around to fixing it.",
      "The yearbook printed it wrong senior year, and it was easier to go with it than to fight the school.",
      "The pizza place near campus wrote {name} on every order, and eventually I stopped fighting it.",
      "I answered roll call as {name} as a joke, and the professor kept it in the grade book.",
      "My college friends wanted to call me Flounder, the loser from Animal House, so I begged them to call me {name} instead.",
      "My dad won a small bet on a horse named {name}, and he was so happy he started calling me that.",
      "I won a radio contest by saying my name was {name}, and I had to keep it to keep the toaster.",
      "A magician at my cousin's wedding announced me as {name} when he pulled me on stage, and the family has used it ever since."
    ],
    "shared": [
      "{name} and I share this phone.",
      "This is {name}'s line, but I'm the one who answers it.",
      "It's a shared line, {name} and me. Whoever's closest picks up.",
      "{name} and I split this number. I'm just the one who answers.",
      "It's like Press Your Luck. {name} and I share this phone, and whoever picks up first gets the call.",
      "{name} never pays his half of the phone bill, so I take the calls.",
      "We share this phone because the other one is in a drawer, and neither of us remembers which drawer."
    ],
    "lean_in": [
      {
        "line": "It's a family name. Everyone in my family is named {name}. You know, George Foreman had 12 kids and five of the boys were named George.",
        "needs_check": false
      },
      {
        "line": "To get another 20% off coupon at Applebee's, I used {name} for the second sign-up and never changed it back.",
        "needs_check": false
      },
      {
        "line": "I took the SATs for my cousin {name} and kept the name.",
        "needs_check": false
      }
    ]
  },
  "accent": [
    {
      "line": "I love summer theater and I'm always trying out different accents. This week it's Australia, next Britain.",
      "story": "I love summer theater and I'm always trying out different accents. This week it's Australia, next Britain."
    }
  ],
  "surname": {
    "status": "rule only, not wired",
    "rule": "swap the G in the real surname for the first letter of the host first name; same number keeps the same surname"
  }
};

module.exports = LIB;

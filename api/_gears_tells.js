// SpamViking — Posture Engine: GEAR TELLS (recognition patterns)
// ----------------------------------------------------------------------
// Regex "tells" the FORCE-SET gear engine (_gears.js) runs over each caller
// line to move gear states. Case-insensitive, phrase-favoring.
//
// DESIGN: ARCHETYPE-AGNOSTIC. These key on the universal LANGUAGE OF PRESSURE,
// HANDOVER, DISENGAGEMENT, and BEING THROWN — not on scam-specific nouns (card,
// contract, credentials). The NOUN varies by archetype (a payment scam wants a
// card, a legal one wants a signature, a SaaS one wants credentials); the
// PHRASING of the pressure is the same across all of them ("send me", "I need
// you to", "who signs off", "just confirm your ___"). We match the phrasing and
// let the noun be anything. This works for archetypes we haven't enumerated.
//
// The gears drive the host's POSTURE, not a detailed classification — the host
// fumbles/stalls the same way whether the caller wants a card or a signature,
// so it only needs to know "the caller is pressing me to hand something over,"
// not what the thing is.
//
// Fires on the CALLER's line only (a spammer / cold-caller / salesperson).
// ----------------------------------------------------------------------
export const TELLS = {
  // GEAR 1: SUSPICION — unchanged (already working).
  suspicion: {
    hardExit: /\b(you'?re (?:definitely|clearly|obviously) (?:a bot|an ai|a robot|not (?:a )?real|a recording)|i know (?:this is|you'?re) (?:a bot|an ai|automated)|reporting (?:you|this)|this is a scam ?bot|good ?bye)\b/i,
    warmth: /\b(oh ok(?:ay)?|okay (?:great|good|cool|fine)|got it|gotcha|makes sense|that makes sense|my mistake|sorry to bother|never mind (?:then|about that))\b/i,
    strong: /\b(are you (?:a |an )?(?:ai|bot|robot|recording|machine)|is this (?:a |an )?(?:ai|bot|recording|automated)|am i (?:talking|speaking) (?:to|with) (?:a |an )?(?:bot|machine|ai|computer)|this is (?:automated|a recording|pre-?recorded)|you'?re (?:a )?(?:bot|ai|robot|recording))\b/i,
    soft: /\b(you sound (?:a (?:little|bit) )?(?:off|odd|strange|automated|robotic|scripted|weird|funny)|are you (?:even )?(?:real|there|listening))\b/i,
  },

  // GEAR 2: PRESSURE — is the caller pushing to close / pulling something out?
  pressure: {
    // EXTRACTING: pressing you to HAND OVER / DO the specific thing that closes
    // their deal — whatever it is (info, signature, access, payment, a form,
    // a decision NOW). Archetype-agnostic: keys on the handover PHRASING, not
    // the noun. "give me / send me / read me / confirm your / provide the /
    // go to / fill out / I need you to ___".
    extracting: /\b((?:can you |could you |please |i (?:need|want) you to |just )?(?:give|send|read|provide|share|confirm|verify|enter|fill(?: out)?|submit|forward|hand over|pass (?:me |along )|get me|email me|text me)\b.{0,30}\b(?:me|your|the|it|that|this|over|details|info(?:rmation)?|number|code|form|link|access|now)|go to (?:this |the )?(?:website|link|url|page|site)|(?:click|open|download|install) (?:this|the|that)|what'?s your \w+|need (?:your|the) \w+ (?:number|details|info|code)|log ?in (?:to|with)|remote (?:access|session|support))\b/i,
    // PUSHING: pressing toward the SALE / COMMITMENT / next step — wants a yes,
    // a decision, a signer, a timeline. The "close the deal" pressure.
    // Archetype-agnostic: "sign", "approve", "commit", "who decides", "move
    // forward", "get started", "ready to ___", "budget", "when can we ___".
    pushing: /\b(let'?s (?:get started|move forward|do this|close|proceed|move ahead|make it happen|get going|lock (?:this |it )?in)|can we (?:get started|move forward|proceed|close|finalize|move ahead|set (?:this|it) up)|are you ready to|ready to (?:sign|start|buy|commit|move|proceed|go|begin)|(?:go ahead and )?sign(?: up| off| the| this| today| now| here)?|approve (?:this|it|the|today|now)|who (?:signs off|approves|makes the (?:call|decision)|handles (?:the )?(?:budget|contract|purchasing|procurement)|(?:the )?decision(?:-| )?maker|do i (?:talk|speak) to)|(?:just )?need your (?:approval|sign|signature|decision|commitment|yes|go(?:-| )?ahead)|when can (?:we|you) (?:start|begin|close|meet|move)|(?:can|could) you commit|make (?:a|the) decision|move (?:this |it )?(?:forward|ahead)|what'?s your (?:budget|timeline|price range)|how (?:soon|quickly) can (?:we|you)|(?:let'?s )?get (?:the )?(?:paperwork|contract|agreement|deal) (?:going|started|signed|done))\b/i,
    // CALM: neutral default; the axis sits at calm unless pushing/extracting
    // fires. No matcher (default state).
    calm: /\bxxxneverxxx\b/i,
  },

  // GEAR 3: ENGAGEMENT — how invested is the caller right now?
  engagement: {
    // BORED: disengaging, flat, impatient, trying to wrap. Universal.
    bored: /\b(uh ?huh|mm ?hmm|ok(?:ay)? sure|sure sure|yeah yeah|whatever|any(?:ways?)?|look,?|get to the point|(?:can we )?(?:speed|hurry|move) (?:this|it) (?:up|along)|i don'?t have (?:time|all day)|(?:i'?m|we'?re) (?:busy|in a hurry|pressed for time)|is (?:that|this) (?:it|all)|are we (?:done|finished|good)|so anyway|cut to the chase|wrap (?:this|it) up|(?:can you )?keep it (?:short|brief)|fine\.?|k\.?)\b/i,
    // STUNNED: thrown off, derailed, confused by the host's absurdity. Trophy
    // state — the host broke the caller's script. Universal.
    stunned: /\b(wait,? what|what\?|huh\??|i'?m sorry\??|excuse me\??|hold on|hang on|come again|what does that have to do|i'?m (?:confused|lost)|what are you (?:talking about|on about|saying)|that'?s (?:weird|strange|unusual|odd|random|bizarre)|why (?:would|are|do) you|where did that come from|i don'?t (?:understand|follow|get it)|say that again|you lost me|what the|that came out of nowhere|how is that (?:relevant|related))\b/i,
    // HOOKED: engaged, curious, playing along, reacting. Universal.
    hooked: /\b(oh (?:interesting|nice|wow|really|cool|neat)|tell me more|(?:that'?s |how )interesting|really\?|go on|how does (?:that|it) work|what do you mean|tell me (?:about|more)|(?:that|this) sounds (?:good|great|interesting|nice)|i'?d (?:love|like) to|(?:ha){2,}|haha|lol|that'?s (?:funny|great|amazing|hilarious|wild)|no way|you'?re kidding|wait really|(?:that'?s |sounds )(?:cool|awesome))\b/i,
  },

  // ACCUSATION — tags the TYPE of accusation (used by suspicion + bit select).
  accusation: {
    ai: /\b(are you (?:a |an )?(?:ai|bot|robot|recording|machine|computer)|is this (?:a |an )?(?:ai|bot|recording|automated)|you'?re (?:a )?(?:bot|ai|robot|recording)|this is (?:automated|a recording|pre-?recorded)|talking to (?:a |an )?(?:bot|machine|ai))\b/i,
    scam: /\b(this is (?:a )?(?:scam|fraud|fake)|you'?re (?:scamming|a scammer|trying to scam)|(?:i'?m )?reporting (?:you|this)|fraud(?:ulent)?|(?:this is )?illegal|i'?m calling the (?:police|cops|authorities|bank))\b/i,
    time_waste: /\b(wasting my time|waste of (?:my )?time|is this a joke|are you (?:kidding|joking|serious)|stop wasting|this is ridiculous|you'?re wasting|i don'?t have time for this)\b/i,
  },
};

// AUTO-GENERATED from registry/gear_tells.json — do NOT hand-edit.
// Edit the JSON and run `python3 compile_tells.py` to regenerate.

export const TELLS = {
  suspicion: {
    hardExit: /\b(you'?re (?:definitely|clearly|obviously) (?:a bot|an ai|a robot|not (?:a )?real|a recording)|i know (?:this is|you'?re) (?:a bot|an ai|automated)|reporting (?:you|this)|this is a scam ?bot|good ?bye)\b/i,
    warmth: /\b(oh ok(?:ay)?|okay (?:great|good|cool|fine)|got it|gotcha|makes sense|that makes sense|my mistake|sorry to bother|never mind (?:then|about that))\b/i,
    strong: /\b(are you (?:a |an )?(?:ai|bot|robot|recording|machine)|is this (?:a |an )?(?:ai|bot|recording|automated)|am i (?:talking|speaking) (?:to|with) (?:a |an )?(?:bot|machine|ai|computer)|this is (?:automated|a recording|pre-?recorded)|you'?re (?:a )?(?:bot|ai|robot|recording))\b/i,
    soft: /\b(you sound (?:a (?:little|bit) )?(?:off|odd|strange|automated|robotic|scripted|weird|funny)|are you (?:even )?(?:real|there|listening)|is (?:anyone|someone) (?:there|listening)|hello\?+|wait,? (?:what|huh)|why do you keep|are you reading|this (?:feels|seems) (?:a (?:little|bit) )?off|feels off|send me (?:your |a )?(?:website|linkedin)|do you have (?:a )?(?:website|linkedin)|how do i know (?:you'?re|this is) real|can you prove|prove (?:it|you'?re real))\b/i,
  },
  pressure: {
    extracting: /\b(credit card|card number|debit card|payment|wallet address|seed phrase|send (?:me )?(?:the )?(?:money|funds|payment|crypto|eth|ethereum|bitcoin|btc)|gift card|wire (?:the )?(?:money|funds)|bank account|routing number|account number|cvv|expiration date)\b/i,
    pushing: /\b(let'?s (?:get started|move forward|do this|proceed)|sign (?:up|you up)|get you (?:set up|signed up|started)|next step|ready to (?:commit|proceed|start)|move forward|lock (?:this|it) in|just need (?:your|a)|fill out)\b/i,
    calm: /\b(no rush|no pressure|think about it|whenever you'?re ready|take your time|let me explain (?:more|that) first|no worries)\b/i,
  },
  engagement: {
    bored: /\b(i have to go|gotta (?:go|run)|not interested|i'?m (?:busy|in a meeting)|call me (?:back )?later|i'?ll think about it|need to think|send me an email|email me (?:instead|that)|take me off|remove me|another time|not a good time|wrap (?:this )?up|in a hurry|(?:got|have) another call|running (?:short on|out of) time|short on time|we'?ll be in touch|i'?ll get back to you|how did you get my number|what'?s this (?:regarding|about))\b/i,
    stunned: /\b(ha ?ha|lol|that'?s (?:funny|hilarious|ridiculous|wild|insane|absurd)|you'?re (?:funny|hilarious|ridiculous|killing me|something else)|wait,? what|what are you (?:talking about|saying|on about)|what (?:is happening|on earth)|i'?m (?:confused|so confused|lost)|you lost me|i don'?t (?:understand|get it)|are you (?:serious|kidding|for real|pranking|punking)|no way|excuse me\?|come again|huh\?|i can'?t (?:even|believe))\b/i,
    hooked: /\b(tell me more|go on|interesting|i'?m listening|how does (?:that|it) work|sounds (?:good|great)|okay (?:so )?(?:what|how)|really\?|what else|as i was saying|let'?s (?:hear it|continue)|next steps?|send me (?:a )?(?:proposal|quote|contract)|what'?s the (?:price|pricing|cost|timeline)|how much|my (?:colleague|team|boss|partner)|loop (?:in|her|him|them)|set up a (?:call|meeting|demo)|schedule (?:a|the))\b/i,
  },
};

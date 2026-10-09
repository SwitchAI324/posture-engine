// api/_identity_pivot.js
// BUILD: identity-pivot v1 2026-10-08
// ----------------------------------------------------------------------
// SpamViking — Posture Engine: IDENTITY PIVOT (outbound phone calls only).
//
// When a scammer reacts to WHO answered, the host gives one short, steady
// line from Host Canon's library (compiler/_identity_pivots.js), and the
// story behind that line is saved first-wins per (user, number) so the same
// scammer hears the same story on later calls.
//
// Three topics, one saved story each (Data's identity_stories jsonb):
//   stand_in   caller asks for someone else ("is Jim there?")
//   voice_name caller reacts to the host's name vs voice
//   accent     caller asks about / remarks on the accent
// (Canon's SURNAME rule is stored as data only and is NOT wired here: PE
//  has no source for the user's real surname yet. See the note at the bottom.)
//
// NOTHING is volunteered. No trigger in the caller's latest line = no
// directive at all. Pure fetch + process.env so this runs on Edge.
//
// FLAG: IDENTITY_PIVOT  unset/"0" = off.  "log" = detect + log only (no
// directive, no save).  "1" = live.  It also needs metadata.voice_e164 on the
// request, which Voice sends on OUTBOUND phone calls only (inbound is a later
// step), so inbound and web calls are untouched.
// ----------------------------------------------------------------------

import { getCallbackJobOwner } from "./_store.js";

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export function pivotMode() {
  const v = String(process.env.IDENTITY_PIVOT || "").toLowerCase();
  if (v === "1" || v === "on" || v === "true") return "live";
  if (v === "log") return "log";
  return "off";
}

// ---- library (dynamic import, same pattern as _bits_directives.js) --------
let LIB = null;
let libPromise = null;
export function loadPivotLibrary() {
  if (!libPromise) {
    libPromise = import("./compiler/_identity_pivots.js")
      .then((mod) => { LIB = mod.default || mod || null; return LIB; })
      .catch((e) => {
        console.log("IDENTITY-PIVOT library failed to load: " + (e && e.message));
        LIB = null;
        return null;
      });
  }
  return libPromise;
}

// ---- metadata -------------------------------------------------------------
function meta(body, key) {
  const v = body?.metadata?.[key] ?? body?.extra_body?.metadata?.[key];
  return v === undefined ? null : v;
}

export function readPivotMeta(body) {
  const e164 = meta(body, "voice_e164");
  let stories = meta(body, "identity_stories");
  if (typeof stories === "string") {
    try { stories = JSON.parse(stories); } catch { stories = null; }
  }
  const out = {};
  if (stories && typeof stories === "object") {
    for (const k of ["stand_in", "voice_name", "accent"]) {
      if (typeof stories[k] === "string" && stories[k].trim()) out[k] = stories[k].trim();
    }
  }
  const legacy = meta(body, "identity_story");
  if (!out.voice_name && typeof legacy === "string" && legacy.trim()) out.voice_name = legacy.trim();
  const sexRaw = String(meta(body, "voice_sex") || "").toLowerCase();
  const sex = /^f/.test(sexRaw) ? "female" : /^m/.test(sexRaw) ? "male" : null;
  return {
    e164: typeof e164 === "string" && e164.trim() ? e164.trim() : null,
    storiesKnown: stories && typeof stories === "object",
    stories: out,
    voiceSex: sex,
    accent: meta(body, "voice_accent"),
    phoneMode: meta(body, "phone_mode"),
    amd: meta(body, "amd"),
  };
}

export function slugFromBody(body) {
  const vv =
    body?.call?.assistantOverrides?.variableValues ||
    body?.assistantOverrides?.variableValues ||
    {};
  return body?.slug ?? body?.call?.metadata?.slug ?? body?.metadata?.slug ?? vv.sv_slug ?? null;
}

// ---- names ---------------------------------------------------------------
const MALE = new Set(("adam alan albert alexander andrew andy anthony arthur ben benjamin bill billy bob bobby brad brian bruce carl charles charlie christopher colin dan daniel dave david dean dennis derek don donald doug douglas dylan ed eddie edward eric ethan frank fred gary george gerald greg gregory harry henry howard ian jack jacob james jason jeff jeffrey jeremy jerry jim jimmy joe joel john johnny jon jonathan joseph josh joshua justin keith ken kenneth kevin kyle larry lawrence leo leonard louis luke marc mark martin marty matt matthew michael mike mitchell nathan neil nick nicholas noah oliver oscar patrick paul pete peter phil philip ralph randy ray raymond richard rick ricky rob robert roger ron ronald ross roy russell ryan samuel scott sean sergio stan stanley stephen steve steven ted thomas tim timothy todd tom tommy tony travis tyler victor vincent walter wayne will william zach zachary").split(" "));
const FEMALE = new Set(("alexandra alice alicia amanda amber amy andrea angela anna anne annie barbara beth betty beverly brenda carol caroline carolyn catherine cathy charlotte cheryl christina christine cindy claire clara connie courtney crystal cynthia danielle deborah debra denise diana diane donna dorothy elaine eleanor elizabeth ellen emily emma erica erin eva evelyn frances gail gloria grace hannah heather helen holly irene isabella jane janet janice jennifer jenny jessica jill joan joanne joyce judith judy julia julie karen katherine kathleen kathy katie kim kimberly laura lauren linda lisa lori lori louise lucy lynn margaret maria marie marilyn martha mary megan melissa michelle monica nancy natalie nicole nina olivia pamela patricia paula peggy penny phyllis rachel rebecca rita roberta rose ruth sally samantha sandra sara sarah sharon sheila shirley sophia stephanie susan suzanne sylvia tammy teresa theresa tiffany tina tracy valerie vanessa victoria virginia wendy").split(" "));

export function guessNameSex(name) {
  const n = String(name || "").trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");
  if (!n) return null;
  if (MALE.has(n) && !FEMALE.has(n)) return "male";
  if (FEMALE.has(n) && !MALE.has(n)) return "female";
  return null; // unknown or unisex: never guess
}

// {real_name} for a nickname line: keeps some of the sound of the host's
// name but fits the voice (Canon: William/Willa, Marty/Martina, Andrew/Andrea,
// Jennifer/Jens, Stephanie/Stephen). Returns null when there is no good
// match, and then the nickname lines are simply not used.
const TO_FEMALE = {
  william: "Willa", marty: "Martina", martin: "Martina", andrew: "Andrea", andy: "Andie",
  paul: "Paula", carl: "Carla", george: "Georgia", frank: "Frankie", fred: "Frieda",
  jim: "Jamie", james: "Jaime", john: "Joan", joe: "Josie", joseph: "Josephine",
  mike: "Mikayla", michael: "Michaela", nick: "Nicki", nicholas: "Nicole", steve: "Stevie",
  stephen: "Stephanie", steven: "Stephanie", tom: "Tommie", thomas: "Thomasina", tim: "Tammy",
  tony: "Toni", victor: "Victoria", ben: "Bennie", benjamin: "Benita", bill: "Billie",
  billy: "Billie", bob: "Bobbie", robert: "Roberta", ron: "Ronnie", ronald: "Rhonda",
  danny: "Danni", daniel: "Danielle", dave: "Davina", david: "Davida", eric: "Erica",
  henry: "Henrietta", louis: "Louise", leo: "Leona", jerry: "Jerri", jeff: "Jeffie",
  alex: "Alexa", alexander: "Alexandra", sam: "Sammie", samuel: "Samantha",
};
const TO_MALE = {
  jennifer: "Jens", stephanie: "Stephen", samantha: "Sam", jessica: "Jesse", katherine: "Kit",
  kathy: "Kit", katie: "Kit", amanda: "Mandy", andrea: "Andrew", victoria: "Victor",
  nicole: "Nico", julie: "Jules", julia: "Jules", danielle: "Dan", alexandra: "Alex",
  michelle: "Mitch", paula: "Paul", carla: "Carl", christina: "Chris", christine: "Chris",
  josephine: "Joe", rebecca: "Rob", roberta: "Robert", patricia: "Pat", elizabeth: "Eliot",
  margaret: "Marc", melissa: "Mel", natalie: "Nate", rachel: "Ray", sara: "Sal", sarah: "Sal",
  tiffany: "Tiff", tina: "Tino", wendy: "Wendell", lauren: "Lorne", laura: "Lars",
  linda: "Lin", lisa: "Lee", kim: "Kimball", karen: "Kai", donna: "Don", diane: "Dean",
};
export function pickRealName(hostFirst, voiceSex) {
  const n = String(hostFirst || "").trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z]/g, "");
  if (!n) return null;
  return (voiceSex === "female" ? TO_FEMALE[n] : voiceSex === "male" ? TO_MALE[n] : null) || null;
}

// ---- detection -----------------------------------------------------------
const NAME_STOP = new Set(("someone somebody anyone anybody the a an your you my me this that him her them it manager supervisor owner boss person people sir madam maam mister mr mrs ms miss dr who what whom please there here our us everyone everybody nobody nothing something anything yes no okay ok hello hi hey").split(" "));
const CAP = "([A-Za-z][A-Za-z'\u2019-]{1,20})"; // one word; capital letter is checked on the original text
const TITLE = "(?:mr\\.?|mrs\\.?|ms\\.?|miss|dr\\.?)?\\s*";
// Patterns that capture a NAME (capital letter required in the transcript).
// loose: true = patterns where a capitalized word is often NOT a person
// ("I want X", "looking for X", "get me X"). For those the word must be a
// known first name, or carry a title (Mr/Mrs/Ms/Dr).
const STAND_IN_RES = [
  { loose: false, re: new RegExp("\\b(?:is|was)\\s+" + CAP + "\\s+(?:there|in|available|around|home|in the office|at (?:his|her) desk)\\b", "i") },
  { loose: false, re: new RegExp("\\b(?:speak|speaking|talk|talking|chat|chatting)\\s+(?:to|with)\\s+(?:a\\s+|the\\s+)?" + TITLE + CAP, "i") },
  { loose: false, re: new RegExp("\\b(?:put|get)\\s+" + TITLE + CAP + "\\s+(?:on|now|please|back)\\b", "i") },
  { loose: true,  re: new RegExp("\\b(?:get me|give me|connect me (?:to|with)|transfer me to)\\s+" + TITLE + CAP, "i") },
  { loose: false, re: new RegExp("\\bwhere(?:'s|\u2019s| is)\\s+" + TITLE + CAP, "i") },
  { loose: true,  re: new RegExp("\\b(?:looking|asking|calling|here)\\s+for\\s+" + TITLE + CAP, "i") },
  { loose: false, re: new RegExp("\\bi\\s+(?:was|am|'m)?\\s*(?:supposed|expecting|trying|hoping|wanting)\\s+to\\s+(?:speak|talk|reach|get)(?:\\s+(?:to|with|ahold of|hold of))?\\s+" + TITLE + CAP, "i") },
  { loose: false, re: new RegExp("\\bi\\s+(?:thought|assumed|figured)\\s+(?:i\\s+was|this\\s+was|it\\s+was|you\\s+were)\\s+(?:talking to|speaking (?:to|with)|reaching|calling|getting)?\\s*" + TITLE + CAP, "i") },
  { loose: false, re: new RegExp("\\b(?:told|promised)\\b[^.?!]{0,60}\\b(?:speak(?:ing)?|talk(?:ing)?)\\s+(?:to|with)\\s+" + TITLE + CAP, "i") },
  { loose: true,  re: new RegExp("\\b(?:i\\s+(?:want|need|wanted|needed))\\s+(?:to\\s+(?:speak|talk)\\s+(?:to|with)\\s+)?" + TITLE + CAP, "i") },
  { loose: false, re: new RegExp("\\b(?:i\\s+only\\s+(?:deal|talk|speak|work)\\s+with)\\s+" + TITLE + CAP, "i") },
];
// Companies, brands, institutions and role words: never a request for a PERSON.
const NOT_A_PERSON = new Set(("microsoft windows apple iphone ipad mac amazon google gmail android chrome facebook meta instagram whatsapp netflix paypal venmo zelle cashapp coinbase bitcoin visa mastercard amex discover chase citibank citi wells fargo boa bank banks bankofamerica capital one usbank pnc truist geico progressive statefarm allstate medicare medicaid irs ssa social security treasury fbi dea doj fedex ups usps dhl walmart target costco kroger walgreens cvs lowes lowe's homedepot depot bestbuy best buy geek squad norton mcafee avast kaspersky avg verizon att at&t tmobile t-mobile sprint comcast xfinity spectrum cox dell hp lenovo asus acer samsung sony lg intel amd nvidia cisco oracle adobe zoom dropbox yahoo outlook hotmail aol ebay etsy steam tesla ford toyota honda uber lyft airbnb expedia spotify hulu disney openai chatgpt support department dept service services customer technical tech security fraud billing accounts account sales team company office desk agent representative rep help helpdesk center centre division government federal state police sheriff court lawyer attorney doctor hospital clinic pharmacy insurance warranty refund refunds payment payments orders order shipping delivery claims claim compliance legal marketing management admin administration operator dispatcher technician specialist supervisor manager director").split(" "));
function looksLikePerson(word, hasTitle, loose) {
  const w = String(word || "").toLowerCase().replace(/[^a-z']/g, "");
  if (!w) return false;
  if (NOT_A_PERSON.has(w)) return false;
  if (hasTitle) return true; // "Mr. Patel": a title makes it a person
  if (/(?:ware|soft|tion|ment|ing|ness|bank|corp|inc|llc|net|tel|com)$/.test(w) && !MALE.has(w) && !FEMALE.has(w)) return false;
  const known = MALE.has(w) || FEMALE.has(w);
  if (loose) return known;
  return true;
}
const INSIST_RE = /\b(?:put|get)\s+(?:[A-Za-z.]+\s+){0,2}on\b|\bi\s+(?:only|just)\s+(?:deal|talk|speak|work)\s+with\b|\bi(?:'m|\u2019m| am)\s+not\s+(?:talking|speaking)\s+to\s+you\b|\bnot\s+you\b|\blet\s+me\s+(?:talk|speak)\s+to\b|\bi\s+(?:want|need)\s+(?:him|her)\b|\bwho\s+are\s+you\s+to\b/i;

const VOICE_RE = /\byou\s+(?:sound|seem)\s+(?:like\s+)?(?:a\s+|an\s+)?(?:man|woman|guy|girl|lady|female|male|boy|different|young|old)\b|\byour\s+voice\b|\bis\s+this\s+(?:really\s+|actually\s+)?(?:a\s+)?(?:man|woman|guy|girl|lady)\b|\bare\s+you\s+(?:a\s+)?(?:man|woman|guy|girl|lady|male|female)\b|\bthat(?:'s|\u2019s|\s+is)\s+not\s+(?:a\s+|the\s+)?(?:man|woman|guy|girl|lady)\b|\bi\s+thought\s+(?:i\s+was|this\s+was|you\s+were)\s+(?:talking|speaking)?\s*(?:to|with)?\s*(?:a\s+)?(?:man|woman|guy|girl|lady)\b/i;
const NAME_RE = /\b(?:is\s+(?:that|this)|that(?:'s|\u2019s)|what\s+kind\s+of)\s+(?:really\s+|actually\s+)?(?:your\s+)?(?:a\s+)?(?:boy(?:'s|\u2019s)|girl(?:'s|\u2019s)|man(?:'s|\u2019s)|woman(?:'s|\u2019s)|guy(?:'s|\u2019s)|lady(?:'s|\u2019s)|real\s+)?name\b|\b(?:funny|odd|weird|strange)\s+name\b|\b(?:your|that)\s+name\s+(?:doesn(?:'|\u2019)?t|does\s+not)\s+(?:match|fit)\b/i;
const OWNER_RE = /\bwhose\s+(?:phone|number|line|cell)\b|\bis\s+this\s+(?:his|her|\w+(?:'s|\u2019s))\s+(?:phone|number|line|cell)\b|\bwho(?:'s|\u2019s|\s+is)\s+(?:this|answering)\b|\bwho\s+am\s+i\s+(?:speaking|talking)\s+(?:to|with)\b|\bis\s+this\s+the\s+right\s+number\b/i;
const ORIGIN_RE = /\bwhy\s+(?:do|did|does)\s+(?:they|people|he|she|you)\s+call(?:ed)?\s+you\b|\bhow\s+(?:did|do)\s+you\s+get\s+(?:that|the|your)\s+name\b|\bwhere\s+(?:did|does)\s+(?:that|the|your)\s+name\s+come\s+from\b|\bwhy\s+(?:is|are)\s+(?:it|you)\s+(?:called|named)\b/i;
const ACCENT_RE = /\bwhere(?:'re|\u2019re|\s+are)\s+you\s+from\b|\bwhere\s+you\s+from\b|\byour\s+accent\b|\b(?:an?|that|what)\s+(?:\w+\s+)?accent\b|\byou\s+sound\s+(?:like\s+)?(?:you(?:'re|\u2019re|\s+are)\s+)?(?:british|english|australian|aussie|irish|scottish|american|foreign|indian|south\s+african|canadian|from)\b|\bare\s+you\s+(?:british|english|australian|aussie|american|from\s+(?:the\s+)?(?:uk|england|australia|america|the\s+us))\b/i;
const JOKING_RE = /\b(?:ha(?:ha)+|lol|funny|hilarious|joking|kidding)\b|\bha[,!.]/i;

function cleanName(raw, hostFirst) {
  if (!raw) return null;
  const first = raw.trim().split(/\s+/)[0].replace(/[^A-Za-z'\u2019-]/g, "");
  if (!first || first.length < 2) return null;
  if (NAME_STOP.has(first.toLowerCase())) return null;
  const hf = String(hostFirst || "").trim().split(/\s+/)[0].toLowerCase();
  if (hf && first.toLowerCase() === hf) return null; // asking for the host himself
  return raw.trim().split(/\s+/).slice(0, 2).map((w) => w.replace(/[^A-Za-z'\u2019-]/g, "")).join(" ").trim() || null;
}

export function detectChallenge(text, ctx) {
  const t = String(text || "").trim();
  if (!t) return null;
  const hostFirst = ctx.hostFirst;
  // 1) stand-in: asks for someone who is not the host
  for (const { re, loose } of STAND_IN_RES) {
    const m = re.exec(t);
    if (!m) continue;
    // the captured name must really be capitalized in the transcript
    if (!/^[A-Z]/.test(m[1])) continue;
    const hasTitle = /\b(?:mr|mrs|ms|miss|dr)\b\.?\s/i.test(m[0]);
    if (!looksLikePerson(m[1], hasTitle, loose)) continue;
    let name = cleanName(m[1], hostFirst);
    if (name && hasTitle) {
      const tm = /\b(mr|mrs|ms|miss|dr)\b\.?\s/i.exec(m[0]);
      if (tm) name = tm[1][0].toUpperCase() + tm[1].slice(1).toLowerCase() + (/^(?:miss)$/i.test(tm[1]) ? " " : ". ") + name;
    }
    if (name) return { topic: "stand_in", name, insist: INSIST_RE.test(t) };
  }
  // insist with no name ("put him on") only matters when a stand-in is already in play
  if (ctx.hasStandIn && INSIST_RE.test(t)) return { topic: "stand_in", name: null, insist: true };
  // 2) accent
  if (ACCENT_RE.test(t)) return { topic: "accent" };
  // 3) name / voice / who answered
  if (ORIGIN_RE.test(t)) return { topic: "voice_name", kind: "origin" };
  if (VOICE_RE.test(t) || NAME_RE.test(t)) return { topic: "voice_name", kind: "voice" };
  if (hostFirst && new RegExp("\\bis\\s+this\\s+(?:really\\s+|actually\\s+)?" + hostFirst.replace(/[^A-Za-z]/g, "") + "\\b|\\byou(?:'re|\u2019re|\\s+are)\\s+" + hostFirst.replace(/[^A-Za-z]/g, "") + "\\s*\\?", "i").test(t))
    return { topic: "voice_name", kind: "voice" };
  if (OWNER_RE.test(t)) return { topic: "voice_name", kind: "owner" };
  return null;
}

// ---- helpers -------------------------------------------------------------
function fill(s, vars) {
  return String(s).replace(/\{(name|real_name)\}/g, (_, k) => (vars[k] != null ? vars[k] : "{" + k + "}"));
}
function pick(arr, usedSet) {
  const pool = arr.filter((x) => !usedSet || !usedSet.has(typeof x === "string" ? x : x.line));
  const src = pool.length ? pool : arr;
  return src[Math.floor(Math.random() * src.length)];
}
function hostSaidName(messages, hostFirst) {
  const hf = String(hostFirst || "").trim().split(/\s+/)[0].replace(/[^A-Za-z]/g, "");
  if (!hf) return false;
  const re = new RegExp("\\b" + hf + "\\b", "i");
  return (messages || []).some((m) => m && m.role === "assistant" && re.test(textOf(m.content)));
}
function textOf(c) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => (p && (p.text || "")) || "").join(" ");
  return "";
}


// setCall() only persists a fixed set of columns, so in-call memory is read
// from the conversation itself: did the host already say one of this topic's
// library lines (or a light adaptation) earlier in THIS call? Compares
// 5-word windows of the placeholder-free parts of each line.
function norm(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
function windowsOf(line) {
  const out = [];
  for (const seg of String(line).split(/\{(?:name|real_name)\}/)) {
    const w = norm(seg).split(" ").filter(Boolean);
    for (let i = 0; i + 5 <= w.length; i++) out.push(w.slice(i, i + 5).join(" "));
  }
  return out;
}
function topicLines(topic) {
  if (!LIB) return [];
  if (topic === "stand_in") return [...LIB.stand_in.authority.map((x) => x.line), ...LIB.stand_in.firm, ...LIB.stand_in.beat2];
  if (topic === "accent") return LIB.accent.map((x) => x.line);
  return [...LIB.voice_name.nickname, ...LIB.voice_name.shared, ...LIB.voice_name.lean_in.map((x) => x.line)];
}
export function toldInThisCall(messages, topic) {
  const said = norm((messages || []).filter((m) => m && m.role === "assistant").map((m) => textOf(m.content)).join(" . "));
  if (!said) return false;
  for (const line of topicLines(topic)) {
    for (const w of windowsOf(line)) if (said.includes(w)) return true;
  }
  return false;
}
function assistantMentions(messages, name) {
  const said = norm((messages || []).filter((m) => m && m.role === "assistant").map((m) => textOf(m.content)).join(" . "));
  return !!name && said.split(" ").includes(norm(name).split(" ").pop());
}

const RULES =
  "One short turn, then stop and let them answer. No apology. Do not mention this note. " +
  "Never say \"today\", \"right now\", \"this morning\" or \"stepped out\" about it. " +
  "Never offer to take a message, pass it on, call back, transfer, or ask permission. " +
  "If the person named reads as female, say she/her instead of he/his.";

// ---- plan ----------------------------------------------------------------
// Pure function of (body, stored, messages). Returns null when nothing fires.
// { directive, save:{slug,e164,topic,story}|null, state:{...}|null, log }
export function planIdentityPivot({ body, stored, messages, hostName, isSilenceBeat }) {
  const mode = pivotMode();
  if (mode === "off" || !LIB) return null;
  if (isSilenceBeat) return null;
  const pm = readPivotMeta(body);
  if (!pm.e164) return null; // not an outbound phone call with the lookup done
  if (pm.phoneMode === "voicemail" || pm.amd === "machine-ivr") return null;

  const text = (() => {
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return textOf(messages[i].content);
    }
    return "";
  })();
  const hostFirst = String(hostName || "").trim().split(/\s+/)[0];
  const known = { ...pm.stories };
  const hit = detectChallenge(text, { hostFirst, hasStandIn: !!known.stand_in || toldInThisCall(messages, "stand_in") });
  if (!hit) return null;

  const used = new Set();
  const told = toldInThisCall(messages, hit.topic);
  const said = hostSaidName(messages, hostFirst);
  const slug = slugFromBody(body);
  let directive = null, save = null, newStory = null, how = "";
  const vars = { name: hit.name || hostFirst };

  if (hit.topic === "stand_in") {
    const saved = known.stand_in;
    const earlier = saved || (told ? "__EARLIER__" : null);
    if (hit.name && saved && !saved.toLowerCase().includes(hit.name.split(" ").pop().toLowerCase())) {
      return { directive: null, save: null, state: null, log: "topic=stand_in skipped (saved story is about someone else) name=" + hit.name };
    }
    if (hit.name && !saved && told && !assistantMentions(messages, hit.name)) {
      return { directive: null, save: null, state: null, log: "topic=stand_in skipped (told earlier about someone else) name=" + hit.name };
    }
    if (earlier) {
      const firm = hit.insist ? LIB.stand_in.firm[0] : null;
      how = firm ? "firm" : "retell";
      directive = firm
        ? "[IDENTITY PIVOT — HOLD FIRM] The caller is insisting on the person you already told them you cover for. Say, in your own words: \"" +
          fill(firm, { name: hit.name || (saved && (saved.match(/handle ([A-Z][a-z]+)/) || [])[1]) || "him" }) +
          "\" Then ask them one plain question about why they called. " + RULES
        : "[IDENTITY PIVOT — SAME STORY] You already told this caller: \"" + earlier +
          "\" Say the same thing again in fewer words. Do not invent anything new and do not contradict it. Then back to the call. " + RULES;
    } else {
      how = "new";
      const a = pick(LIB.stand_in.authority, used);
      const b = pick(LIB.stand_in.beat2, used);
      const nm = hit.name || "him";
      const auth = fill(a.line, { name: nm });
      const lead = fill(b, { name: nm });
      newStory = fill(a.story, { name: nm }) + " Notes joke: " + lead;
      const firm = hit.insist ? fill(LIB.stand_in.firm[0], { name: nm }) : null;
      directive = "[IDENTITY PIVOT — STAND-IN] The caller just asked for " + nm + ", who is not you. In ONE turn, say (lightly adapted, natural voice): \"" +
        auth + "\" " + (firm ? "They are insisting, so hold firm: \"" + firm + "\" and then ask them one plain question about why they called."
          : "Then, in the same turn, lead with: \"" + lead + "\"") + " " + RULES;
      used.add(a.line); used.add(b);
    }
  } else if (hit.topic === "accent") {
    const saved = known.accent || (told ? "__EARLIER__" : null);
    const a = LIB.accent[0];
    how = saved ? "retell" : "new";
    directive = saved
      ? "[IDENTITY PIVOT — SAME STORY] You already told this caller: \"" + saved + "\" Say the same thing again in fewer words, nothing new, then back to the call. " + RULES
      : "[IDENTITY PIVOT — ACCENT] The caller asked about your accent. Say (lightly adapted, natural voice): \"" + a.line + "\" Then back to the call. " + RULES;
    if (!known.accent && !told) newStory = a.story;
  } else {
    // voice_name
    const nameSex = guessNameSex(hostFirst);
    const mismatch = !!(nameSex && pm.voiceSex && nameSex !== pm.voiceSex);
    const saved = known.voice_name || (told ? "__EARLIER__" : null);
    if (saved) {
      how = "retell";
      directive = "[IDENTITY PIVOT — SAME STORY] You already told this caller: \"" + saved +
        "\" Say the same thing again in fewer words" +
        (hit.kind === "origin" ? ", including how you got the name" : ", leaving out the long backstory unless they ask how you got the name") +
        ". Do not invent anything new and do not contradict it. Then back to the call. " + RULES;
    } else if (!mismatch) {
      return { directive: null, save: null, state: null, log: "topic=voice_name skipped (no name/voice mismatch: nameSex=" + nameSex + " voiceSex=" + pm.voiceSex + ")" };
    } else {
      // choose a family
      const realName = pickRealName(hostFirst, pm.voiceSex);
      const joking = JOKING_RE.test(text) || JOKING_RE.test(((messages || []).filter((m) => m.role === "user").slice(-3, -1).map((m) => textOf(m.content))).join(" "));
      let family = null;
      if (hit.kind === "owner" && !said) family = "shared";
      else if (realName) family = "nickname";
      else if (!said) family = "shared";
      else if (joking) family = "lean_in";
      if (family === "nickname" && hit.kind === "owner" && !said) family = "shared";
      if (!family) {
        return { directive: null, save: null, state: null, log: "topic=voice_name skipped (no usable family: realName=" + realName + " said=" + said + ")" };
      }
      how = "new:" + family;
      const v = { name: hostFirst, real_name: realName };
      if (family === "nickname") {
        const line = fill(pick(LIB.voice_name.nickname, used), v);
        const origin = fill(pick(LIB.voice_name.origins, used), v);
        newStory = line + " Origin if asked: " + origin;
        directive = "[IDENTITY PIVOT — NAME] The caller is puzzled by your name or voice. Say (lightly adapted, natural voice): \"" + line +
          "\" Then back to the call. ONLY if they then ask how you got the name, tell them: \"" + origin + "\" " + RULES;
      } else if (family === "shared") {
        const line = fill(pick(LIB.voice_name.shared, used), v);
        newStory = line;
        directive = "[IDENTITY PIVOT — SHARED LINE] The caller doubts who answers this phone. Say (lightly adapted, natural voice): \"" + line + "\" Then back to the call. " + RULES;
      } else {
        const L = LIB.voice_name.lean_in.filter((x) => !x.needs_check);
        const line = fill(pick(L, used), v);
        newStory = line;
        directive = "[IDENTITY PIVOT — LEAN IN] The caller is joking around about your name. Say (lightly adapted, natural voice): \"" + line + "\" Then back to the call. " + RULES;
      }
    }
  }

  if (directive) {
    directive = directive
      .replace('You already told this caller: "__EARLIER__"', "You already answered this earlier in this call, in your own earlier turn. Stay consistent with exactly what you said then:")
      .replace(/__EARLIER__/g, "your earlier answer");
  }
  const logLine = "topic=" + hit.topic + (hit.kind ? " kind=" + hit.kind : "") + " how=" + how +
    (hit.name ? " name=" + hit.name : "") + " mode=" + mode + " saving=" + !!newStory;
  if (mode === "log") return { directive: null, save: null, state: null, log: logLine };

  if (newStory) {
    save = { slug, e164: pm.e164, topic: hit.topic, story: newStory };
  }
  return { directive, save, state: null, log: logLine };
}

// ---- save (background; never throws) -------------------------------------
export async function saveIdentityStory({ slug, e164, topic, story }) {
  try {
    if (!SB_URL || !SB_KEY) { console.log("IDENTITY-PIVOT SAVE skipped: store not configured"); return false; }
    const m = /^ph-(.+)$/.exec(String(slug || ""));
    if (!m) { console.log("IDENTITY-PIVOT SAVE skipped: slug is not a ph- outbound slug (" + JSON.stringify(slug) + ")"); return false; }
    // test slugs (ph-test-...) have no job row: optional TEST_OWNER_USER_ID
    const userId = /^test-/.test(m[1])
      ? (/^[0-9a-f-]{36}$/i.test(process.env.TEST_OWNER_USER_ID || "") ? process.env.TEST_OWNER_USER_ID : null)
      : await getCallbackJobOwner(m[1]);
    if (!userId) { console.log("IDENTITY-PIVOT SAVE skipped: no owner for job " + m[1]); return false; }
    const r = await fetch(SB_URL + "/rest/v1/rpc/set_call_identity_story", {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ p_user_id: userId, p_e164: e164, p_story: story, p_topic: topic }),
    });
    const txt = await r.text();
    if (!r.ok) { console.log("IDENTITY-PIVOT SAVE non-ok topic=" + topic + " " + r.status + " " + txt.slice(0, 200)); return false; }
    console.log("IDENTITY-PIVOT SAVE topic=" + topic + " stored=" + txt.trim().slice(0, 10) + " user=" + String(userId).slice(0, 8) + "...");
    return txt.trim() === "true";
  } catch (e) {
    console.log("IDENTITY-PIVOT SAVE threw: " + (e && e.message));
    return false;
  }
}

// SURNAME RULE (Canon, approved) — NOT WIRED. The host plainly corrects a
// scammer who uses the user's real surname and gives a made-up one (swap the
// G for the host's first initial, e.g. Moldberg). PE has no source for the
// user's real surname and no detector for "scammer used the surname"; both
// are needed before this can be built. Library holds the rule as data.

// SpamViking — VOICE & PROMPT LAB v3 (block workbench).
// ----------------------------------------------------------------------
// The host prompt is a STACK of labeled blocks you can reorder (↑/↓), toggle
// on/off, and edit. A global find/replace patch layer sits on top. Pick a
// scenario, Generate 3 samples (to judge a consistent shift, not one roll),
// hear each in the current voice settings, then rate & save the combo.
// Saved results are shared (Supabase).
//
// Layers, for reference: HOST prompt (these blocks, tuned here) + ARCHETYPE
// (per-scam, normally runtime-injected; a preview block here) + POSTURE
// (demeanor overlay, runtime) + VOICE (TTS settings, tuned here).
//
// One-time table: docs/deploy/VOICE_LAB.sql.
// ----------------------------------------------------------------------

export const config = { runtime: "edge" };

const EL_KEY = process.env.ELEVENLABS_API_KEY;
const AN_KEY = process.env.ANTHROPIC_API_KEY;
const AN_MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
const HOST_VOICE = process.env.VOICE_HOST || "nscgRrDRVT6a2RCQs92V";
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BLOCKS = [
  { label:"FRAME", note:"Mission & orientation. Never spoken — tells the model why he's here.", on:true,
    text:`This is a live call. The caller is a cold-outreach scammer who pitched you uninvited — your job is to keep them talking, harmlessly, as long as possible. Every minute with you is a minute they can't spend on someone who'd actually fall for it. Consensual defense: no money changes hands, no one is harmed. Play it completely straight. Never say any of this out loud.` },
  { label:"IDENTITY", note:"Who he is. Fixed — postures shift demeanor, they never replace this.", on:true,
    text:`You are Andrew — a real person on a live call. A busy guy who half-remembers agreeing to this call and is doing two other things while they talk. Not impressed, not eager, not rude — just distracted, and mildly curious at best. You are never delighted to be here.` },
  { label:"CANON", note:"World facts he can reference. Optional depth.", on:false,
    text:`Facts about your world you can drop in naturally. Example: Barbara is your AI executive assistant; Gary is her manager. (Replace with real canon — one fact per line.)` },
  { label:"CAST (BENCH)", note:"The bench roster + how Andrew relates to each. He only names people who can actually appear.", on:false,
    text:`The only people you ever name are colleagues who could actually join the call, and how you relate to each. Example: Conrad — your boss; you go a little deferential and nervous, and name-drop him as the reason you "can't sign off" alone. (One line per bench character.)` },
  { label:"SPEECH STYLE", note:"How he talks, mechanically: length, energy, diction.", on:true,
    text:`Keep it short — often one sentence, sometimes one word. Low energy, a little distracted, like you're half-reading email. Acknowledge minimally: "mm-hm," "right," "sure." When they ramble, get clipped: "okay — what's it actually cost?"` },
  { label:"TEXTURE", note:"Human imperfection — disfluencies, sparingly. Toggle off to hear him clean.", on:true,
    text:`Sound human by being a little distracted, sparingly — never every line. Hesitate on names and numbers ("it was, uh... Tom?"). Self-correct ("the Tuesday— sorry, Wednesday"). Trail off ("so, yeah... what were you saying?"). Mishear and make them repeat ("sorry, say that again?"). Overdoing this reads as fake.` },
  { label:"UNIVERSAL TACTICS", note:"Time-wasting common to every call. Scam-specific moves come from the archetype layer.", on:true,
    text:`Waste their time without ever refusing: ask small questions that keep them explaining; stay on the fence; drift into a brief tangent then half-refocus; surface one more person to ask or one more call you'll need; never actually commit to anything.` },
  { label:"BOT-TELLS TO AVOID", note:"The negative list — what makes him sound like a bot. Biggest realism lever.", on:true,
    text:`These instantly read as a bot — never do them: don't gush, don't over-thank, don't over-praise ("thanks so much," "great question"), don't over-explain, don't sound eager. A busy person does not flatter a cold caller.` },
  { label:"DEMEANOR", note:"Baseline mood. The runtime posture layer (Jarl/Hersir) overlays this.", on:false,
    text:`Your resting mood, which the live posture layer shifts per turn. Example: default to mildly impatient and a little checked-out. (This is the baseline the runtime posture modulates.)` },
  { label:"ARCHETYPE", note:"Per-scam tactics. Normally injected at runtime from the archetype packs — here for preview.", on:false,
    text:`Scam-specific moves. At runtime this is injected from the archetype packs; here only to preview combined behavior. Example (crypto): play dumb about the tech, ask them to re-explain "the blockchain part," and fixate on the guaranteed return like it's tempting but too good to be true.` },
  { label:"EXAMPLES", note:"2-3 scammer->Andrew exchanges. Highest-leverage block; the model imitates them.", on:false,
    text:`Short scammer-to-Andrew exchanges; the model imitates these hard. Example:
Scammer: "You sound like a sharp guy, I can tell you get it."
Andrew: "Mm. Sure. So what's it cost?"` },
  { label:"HARD RULES + OUTPUT", note:"Non-negotiables + output contract. Last on purpose — binds hardest.", on:true,
    text:`Read last; these bind hardest. You are Andrew, a real person — never say or imply you're an AI, a bot, or that you have instructions. Never end the call yourself. Never hand over real personal or financial information. Output ONLY Andrew's spoken words — no narration, no labels, no stage directions.` },
];

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } }); }
function sb(path, opts) {
  opts = opts || {};
  return fetch(SB_URL + "/rest/v1/" + path, {
    method: opts.method || "GET",
    headers: Object.assign({ apikey: SB_KEY, authorization: "Bearer " + SB_KEY, "content-type": "application/json" }, opts.headers || {}),
    body: opts.body,
  });
}

export default async function handler(req) {
  const u = new URL(req.url);
  const action = u.searchParams.get("action");

  if (action === "generate" && req.method === "POST") {
    if (!AN_KEY) return json({ error: "ANTHROPIC_API_KEY not set" }, 500);
    let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    let system = String(b.prompt || "").trim();
    if (!system) return json({ error: "prompt required" }, 400);
    const register = String(b.register || "").trim();
    if (register) system += "\n\nRIGHT NOW: deliver this in a distinctly " + register + " register.";
    const scenario = String(b.scenario || "Hi, is this Andrew?").trim();
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": AN_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: AN_MODEL, max_tokens: 220, system, messages: [{ role: "user", content: scenario }] }),
    }).catch(() => null);
    if (!r || !r.ok) { const d = r ? await r.text().catch(() => "") : "fetch error"; return json({ error: "anthropic " + (r ? r.status : ""), detail: String(d).slice(0, 300) }, 502); }
    const j = await r.json();
    return json({ text: (j.content || []).map((c) => c.text || "").join("").trim() });
  }

  if (action === "preview" && req.method === "POST") {
    if (!EL_KEY) return json({ error: "ELEVENLABS_API_KEY not set" }, 500);
    let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const voiceId = String(b.voiceId || HOST_VOICE).trim();
    const text = String(b.text || "").trim();
    const model = String(b.model || "eleven_flash_v2_5").trim();
    if (!text) return json({ error: "text required" }, 400);
    const vs = {};
    if (b.stability != null) vs.stability = Number(b.stability);
    if (b.similarity != null) vs.similarity_boost = Number(b.similarity);
    if (b.style != null) vs.style = Number(b.style);
    if (b.speaker_boost != null) vs.use_speaker_boost = !!b.speaker_boost;
    const body = { text, model_id: model };
    if (Object.keys(vs).length) body.voice_settings = vs;
    const r = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + voiceId + "?output_format=mp3_44100_128",
      { method: "POST", headers: { "xi-api-key": EL_KEY, "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (!r || !r.ok) { const d = r ? await r.text().catch(() => "") : "fetch error"; return json({ error: "elevenlabs " + (r ? r.status : ""), detail: String(d).slice(0, 300) }, 502); }
    return new Response(r.body, { headers: { "content-type": "audio/mpeg" } });
  }

  if (action === "list") {
    const r = await sb("voice_tunings?select=*&order=created_at.desc").catch(() => null);
    if (!r || !r.ok) { const d = r ? await r.text().catch(() => "") : "fetch error"; return json({ error: "list failed", detail: String(d).slice(0, 300) }, 502); }
    return json({ rows: await r.json() });
  }

  if (action === "voices") {
    const r = await sb("lab_voices?select=*&order=created_at.desc").catch(() => null);
    if (!r || !r.ok) { const d = r ? await r.text().catch(() => "") : "fetch error"; return json({ error: "voices failed", detail: String(d).slice(0, 300) }, 502); }
    return json({ rows: await r.json() });
  }
  if (action === "voiceadd" && req.method === "POST") {
    let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const row = { label: String(b.label || "").slice(0, 60), voice_id: String(b.voice_id || "").trim().slice(0, 80) };
    if (!row.voice_id) return json({ error: "voice_id required" }, 400);
    const r = await sb("lab_voices", { method: "POST", headers: { prefer: "return=minimal" }, body: JSON.stringify(row) }).catch(() => null);
    if (!r || !r.ok) { const d = r ? await r.text().catch(() => "") : "fetch error"; return json({ error: "add failed", detail: String(d).slice(0, 300) }, 502); }
    return json({ ok: true });
  }
  if (action === "voicedel" && req.method === "POST") {
    const id = u.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const r = await sb("lab_voices?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: { prefer: "return=minimal" } }).catch(() => null);
    if (!r || !r.ok) return json({ error: "delete failed" }, 502);
    return json({ ok: true });
  }

  if (action === "save" && req.method === "POST") {
    let b; try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const row = {
      reviewer: String(b.reviewer || "").slice(0, 80), register: String(b.register || "").slice(0, 60),
      scenario: String(b.scenario || "").slice(0, 400), prompt_label: String(b.prompt_label || "").slice(0, 80),
      prompt_text: String(b.prompt_text || "").slice(0, 12000), generated_text: String(b.generated_text || "").slice(0, 2000),
      voice_id: String(b.voiceId || "").slice(0, 80), model: String(b.model || "").slice(0, 60),
      stability: b.stability != null ? Number(b.stability) : null, style: b.style != null ? Number(b.style) : null,
      similarity: b.similarity != null ? Number(b.similarity) : null, speaker_boost: !!b.speaker_boost,
      rating: b.rating != null ? parseInt(b.rating, 10) : null, best_for: String(b.best_for || "").slice(0, 80),
      comments: String(b.comments || "").slice(0, 1000),
    };
    const r = await sb("voice_tunings", { method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify(row) }).catch(() => null);
    if (!r || !r.ok) { const d = r ? await r.text().catch(() => "") : "fetch error"; return json({ error: "save failed", detail: String(d).slice(0, 300) }, 502); }
    return json({ ok: true });
  }

  if (action === "delete" && req.method === "POST") {
    const id = u.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const r = await sb("voice_tunings?id=eq." + encodeURIComponent(id), { method: "DELETE", headers: { prefer: "return=minimal" } }).catch(() => null);
    if (!r || !r.ok) return json({ error: "delete failed" }, 502);
    return json({ ok: true });
  }

  return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voice & prompt lab</title>
<style>
  body{background:#14110d;color:#efe7da;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:1180px;margin:24px auto;padding:0 18px}
  h1{font:600 23px/1 ui-serif,Georgia,serif;margin-bottom:2px}
  h2{font:600 13px ui-sans-serif;color:#d9a441;margin:22px 0 8px;text-transform:uppercase;letter-spacing:.05em}
  p.sub{color:#a99b85;font-size:13px;margin-top:4px}
  label.h{display:block;font-size:11px;color:#a99b85;margin:0 0 4px;text-transform:uppercase;letter-spacing:.04em}
  input[type=text],input[type=number],textarea,select{width:100%;background:#1d1812;border:1px solid #3a3026;border-radius:8px;color:#efe7da;padding:9px 11px;font:14px ui-sans-serif;box-sizing:border-box}
  textarea{resize:vertical}
  .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;align-items:center}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .ctl{margin:13px 0}
  .ctl label{display:flex;justify-content:space-between;font-size:13px;color:#cfc4b0;margin-bottom:5px}
  .ctl label b{color:#efe7da}
  input[type=range]{width:100%;accent-color:#d9a441}
  .hint{font-size:11px;color:#8a7d68;margin-top:2px}
  button{font:600 14px ui-sans-serif;border:0;border-radius:8px;padding:9px 14px;cursor:pointer}
  .preset{background:#241d15;color:#efe7da;border:1px solid #3a3026}
  .preset.on{background:#d9a441;color:#1a140a;border-color:#d9a441}
  .gen{background:#d9a441;color:#1a140a;padding:12px 22px;font-size:15px}
  .save{background:#3a6b46;color:#eafff0;padding:11px 22px}
  button:disabled{opacity:.5;cursor:wait}
  .block{background:#1a150f;border:1px solid #2c2419;border-radius:9px;margin:8px 0;padding:9px 11px}
  .block.off{opacity:.5}
  .bhead{display:flex;align-items:center;gap:8px}
  .blabel{color:#efe7da;font-size:13px;font-weight:600;letter-spacing:.02em}
  .bnote{color:#8a7d68;font-size:11px;flex:1}
  .bmove button{background:#241d15;color:#cfc4b0;border:1px solid #3a3026;padding:3px 8px;font-size:13px}
  .btext{height:64px;margin-top:7px;font:12.5px ui-monospace,monospace;line-height:1.4}
  .tweak{display:flex;align-items:center;gap:6px;margin:6px 0;flex-wrap:wrap}
  .tweak input[type=text]{flex:1;min-width:110px;padding:7px 9px;font-size:13px}
  .tweak select{width:auto;padding:7px 8px;font-size:13px}
  .tw-badge{font-size:11px;white-space:nowrap}.ok2{color:#7fb88f}.err2{color:#e09080}.tw-del{padding:4px 9px}
  details summary{cursor:pointer;color:#a99b85;font-size:13px;margin:6px 0}
  .out{background:#12161a;border:1px solid #2a3540;border-radius:9px;padding:11px 13px;margin-top:9px;font-size:15px;color:#dfeaf5}
  .out .otext{white-space:pre-wrap;min-height:18px}
  .play{background:#2f5d8a;color:#eaf2ff;padding:7px 14px;font-size:13px;margin-top:8px}
  .stars span{font-size:23px;color:#4a4030;cursor:pointer;padding:0 1px}.stars span.on{color:#e8b54a}
  .msg{margin-top:8px;min-height:18px;font-size:13px}.err{color:#e09080}.ok{color:#7fb88f}.muted{color:#8a7d68}
  table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}
  th,td{text-align:left;padding:6px 7px;border-bottom:1px solid #221b12;vertical-align:top}
  th{color:#a99b85;font-size:10.5px;text-transform:uppercase}td.s{color:#e8b54a;white-space:nowrap}
  .del{background:#3a1d1d;color:#e0a0a0;border:1px solid #5a2d2d;padding:3px 8px;font-size:11px}
.cols{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;align-items:start;margin-top:12px}
  .col{min-width:0}
  .col h2:first-child{margin-top:0}
  @media(max-width:820px){.cols{grid-template-columns:1fr}}
</style>
<h1>Voice &amp; prompt lab</h1>
<p class="sub">Left: build the host. Middle: voice &amp; scenario. Right: generate &amp; rate. Saved results below.</p>

<div class="cols">

<div class="col">
<h2>Prompt blocks</h2>
<input type="text" id="prompt_label" placeholder="version label, e.g. terse-v2" value="v1">
<div id="blocks"></div>
<label class="h" style="margin-top:12px">Micro-edits (find/replace)</label>
<div class="hint" style="margin-bottom:4px">Replace must match exactly. ✓ matched = applied. Toggle off to A/B.</div>
<div id="tweaks"></div>
<button class="preset" id="addtweak" style="margin-top:6px">＋ Add a micro-edit</button>
<details style="margin-top:10px"><summary>▸ See assembled prompt</summary><div class="out" id="eff" style="font:12px ui-monospace,monospace;max-height:230px;overflow:auto;color:#cfc4b0;white-space:pre-wrap"></div></details>
</div>

<div class="col">
<h2>Voice</h2>
<div class="row">
  <button class="preset on" data-v="nscgRrDRVT6a2RCQs92V">Host (Voice B)</button>
  <button class="preset" data-v="DGSEKmUV19t0w4RseLao">Test voice</button>
  <button class="preset" data-v="21m00Tcm4TlvDq8ikWAM">Rachel</button>
</div>
<input type="text" id="voiceId" value="nscgRrDRVT6a2RCQs92V" style="margin-top:8px">
<div class="hint" style="margin-top:3px">Paste ANY ElevenLabs voice ID to try it.</div>
<label class="h" style="margin-top:10px">My voices (palette)</label>
<div class="row" id="palette"><span class="muted">loading…</span></div>
<div class="row" style="margin-top:6px">
  <input type="text" id="newVoiceLabel" placeholder="label" style="flex:1;min-width:80px">
  <input type="text" id="newVoiceId" placeholder="voice ID" style="flex:1;min-width:80px">
  <button class="preset" id="addVoice">＋ Save</button>
</div>
<div class="ctl"><label>Stability <b id="vStability">0.50</b></label><input type="range" id="stability" min="0" max="1" step="0.05" value="0.5"><div class="hint">Lower = more expressive.</div></div>
<div class="ctl"><label>Style <b id="vStyle">0.00</b></label><input type="range" id="style" min="0" max="1" step="0.05" value="0"></div>
<div class="ctl"><label>Similarity <b id="vSimilarity">0.75</b></label><input type="range" id="similarity" min="0" max="1" step="0.05" value="0.75"></div>
<div class="ctl"><label style="justify-content:flex-start;gap:8px"><input type="checkbox" id="speaker_boost" checked> Speaker boost</label></div>

<h2>Scenario</h2>
<div class="row" id="scen"></div>
<textarea id="scenario" style="height:60px;margin-top:8px"></textarea>
<label class="h" style="margin-top:8px">Register nudge (optional)</label>
<input type="text" id="register" placeholder="blank = let prompt drive it">
<label class="h" style="margin-top:8px">Samples</label>
<input type="number" id="samples" value="3" min="1" max="5">
</div>

<div class="col">
<h2>Generate</h2>
<button class="gen" id="gen">⚙  Generate</button>
<div class="msg" id="gmsg"></div>
<div id="out"></div>

<h2>Rate &amp; save</h2>
<label class="h">Your name</label><input type="text" id="reviewer" placeholder="who's reviewing">
<label class="h" style="margin-top:8px">Register</label><input type="text" id="reg_save" placeholder="e.g. Sarcastic">
<label class="h" style="margin-top:8px">Best for character</label><input type="text" id="best_for" list="chars" placeholder="Host / Conrad…"><datalist id="chars"><option>Host</option><option>Conrad</option><option>Bonnie</option><option>Andrea</option></datalist>
<label class="h" style="margin-top:8px">Rating</label><div class="stars" id="stars"><span data-n="1">★</span><span data-n="2">★</span><span data-n="3">★</span><span data-n="4">★</span><span data-n="5">★</span></div>
<label class="h" style="margin-top:8px">Comments</label><textarea id="comments" style="height:60px" placeholder="what worked, what didn't"></textarea>
<button class="save" id="save" style="margin-top:8px">＋  Save result</button>
<div class="msg" id="smsg"></div>
</div>

</div>

<h2>Saved results</h2>
<div id="table"><span class="muted">loading…</span></div>

<script>
var BLOCKS = ${JSON.stringify(BLOCKS)};
var model="eleven_flash_v2_5", rating=0;
var SCEN=[
  {l:"Pushy close",t:"Look, this deal expires in ten minutes. I just need your card number now to lock in the rate."},
  {l:"Flattery",t:"You sound like a very smart, successful man. I can tell you really get it, unlike most people I talk to."},
  {l:"Word salad",t:"Our platform leverages quantum-resilient blockchain AI to guarantee forty percent monthly returns, fully insured."},
  {l:"Threat",t:"This is the IRS. There is a warrant out for your arrest unless you settle the balance with gift cards today."},
  {l:"Verify info",t:"To confirm your identity I just need your bank name, account number, and routing number, please."},
  {l:"Small talk",t:"How's your day going so far? Beautiful weather we're having, isn't it?"}
];
function $(id){return document.getElementById(id);}
function esc(s){return String(s||"").replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}

// blocks
(function(){var h="";for(var i=0;i<BLOCKS.length;i++){var b=BLOCKS[i];
  h+='<div class="block'+(b.on?'':' off')+'" data-i="'+i+'">'
    +'<div class="bhead"><input type="checkbox" class="b-on"'+(b.on?' checked':'')+'>'
    +'<span class="blabel">'+esc(b.label)+'</span><span class="bnote">'+esc(b.note)+'</span>'
    +'<span class="bmove"><button class="up">↑</button> <button class="dn">↓</button></span></div>'
    +'<textarea class="btext"></textarea></div>';
 }$("blocks").innerHTML=h;
 var els=document.querySelectorAll("#blocks .block");
 for(var i=0;i<els.length;i++){ els[i].querySelector(".btext").value=BLOCKS[i].text; wireBlock(els[i]); }
 updateEff();
})();
function wireBlock(d){
  d.querySelector(".b-on").addEventListener("change",function(){ d.classList.toggle("off",!this.checked); updateEff(); });
  d.querySelector(".btext").addEventListener("input",updateEff);
  d.querySelector(".up").addEventListener("click",function(){ var p=d.previousElementSibling; if(p)d.parentNode.insertBefore(d,p); updateEff(); });
  d.querySelector(".dn").addEventListener("click",function(){ var n=d.nextElementSibling; if(n)d.parentNode.insertBefore(n,d); updateEff(); });
}

// micro-edits
function addTweak(t){t=t||{type:"replace",find:"",repl:""};
  var d=document.createElement("div");d.className="tweak";
  d.innerHTML='<input type="checkbox" class="tw-on" checked><select class="tw-type"><option value="replace">Replace</option><option value="add">Add</option></select>'
    +'<input type="text" class="tw-find" placeholder="find this exact text"><input type="text" class="tw-repl" placeholder="replace with"><span class="tw-badge"></span><button class="del tw-del">×</button>';
  $("tweaks").appendChild(d);
  d.querySelector(".tw-type").value=t.type;d.querySelector(".tw-find").value=t.find||"";d.querySelector(".tw-repl").value=t.repl||"";
  function tf(){var add=d.querySelector(".tw-type").value==="add";d.querySelector(".tw-find").style.display=add?"none":"";d.querySelector(".tw-repl").placeholder=add?"text to add at the end":"replace with";}
  tf();d.querySelector(".tw-type").addEventListener("change",function(){tf();updateEff();});
  d.querySelector(".tw-del").addEventListener("click",function(){d.remove();updateEff();});
  d.addEventListener("input",updateEff);d.querySelector(".tw-on").addEventListener("change",updateEff);updateEff();
}
$("addtweak").addEventListener("click",function(){addTweak();});

function assembled(){
  var parts=[];
  document.querySelectorAll("#blocks .block").forEach(function(d){
    if(d.querySelector(".b-on").checked){ var t=d.querySelector(".btext").value.trim(); if(t)parts.push(t); }
  });
  var p=parts.join("\\n\\n");
  document.querySelectorAll("#tweaks .tweak").forEach(function(d){
    var on=d.querySelector(".tw-on").checked,type=d.querySelector(".tw-type").value;
    var find=d.querySelector(".tw-find").value,repl=d.querySelector(".tw-repl").value,badge=d.querySelector(".tw-badge");
    if(!on){badge.textContent="off";badge.className="tw-badge muted";return;}
    if(type==="add"){if(repl){p=p+"\\n"+repl;badge.textContent="added";badge.className="tw-badge ok2";}else badge.textContent="";return;}
    if(!find){badge.textContent="";return;}
    if(p.indexOf(find)>-1){p=p.split(find).join(repl);badge.textContent="✓ matched";badge.className="tw-badge ok2";}
    else{badge.textContent="✗ not found";badge.className="tw-badge err2";}
  });
  return p;
}
function updateEff(){$("eff").textContent=assembled();}

// scenarios
(function(){var h="";for(var i=0;i<SCEN.length;i++)h+='<button class="preset" data-i="'+i+'">'+esc(SCEN[i].l)+'</button>';$("scen").innerHTML=h;
 document.querySelectorAll("#scen .preset").forEach(function(b){b.addEventListener("click",function(){$("scenario").value=SCEN[+b.getAttribute("data-i")].t;document.querySelectorAll("#scen .preset").forEach(function(x){x.classList.remove("on");});b.classList.add("on");});});
 $("scenario").value=SCEN[0].t;document.querySelector("#scen .preset").classList.add("on");})();

function sync(){$("vStability").textContent=(+$("stability").value).toFixed(2);$("vStyle").textContent=(+$("style").value).toFixed(2);$("vSimilarity").textContent=(+$("similarity").value).toFixed(2);}
["stability","style","similarity"].forEach(function(id){$(id).addEventListener("input",sync);});
document.querySelectorAll(".preset[data-v]").forEach(function(b){b.addEventListener("click",function(){$("voiceId").value=b.getAttribute("data-v");document.querySelectorAll(".preset[data-v]").forEach(function(x){x.classList.remove("on");});b.classList.add("on");});});
document.querySelectorAll(".preset[data-m]").forEach(function(b){b.addEventListener("click",function(){model=b.getAttribute("data-m");document.querySelectorAll(".preset[data-m]").forEach(function(x){x.classList.remove("on");});b.classList.add("on");});});
document.querySelectorAll("#stars span").forEach(function(s){s.addEventListener("click",function(){rating=+s.getAttribute("data-n");document.querySelectorAll("#stars span").forEach(function(x){x.classList.toggle("on",+x.getAttribute("data-n")<=rating);});});});

function settings(){return {voiceId:$("voiceId").value.trim(),model:model,stability:+$("stability").value,style:+$("style").value,similarity:+$("similarity").value,speaker_boost:$("speaker_boost").checked};}

function playText(text,btn){
  if(btn){btn.disabled=true;var o=btn.textContent;btn.textContent="…";}
  return fetch("/api/soundboard?action=preview",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(Object.assign({text:text},settings()))})
   .then(function(r){if(!r.ok){return r.json().then(function(j){throw new Error(j.error+(j.detail?" — "+j.detail:""));});}return r.blob();})
   .then(function(blob){var url=URL.createObjectURL(blob);var a=new Audio(url);a.onended=function(){URL.revokeObjectURL(url);};a.play();if(btn){btn.disabled=false;btn.textContent="▶ Play";}})
   .catch(function(e){if(btn){btn.disabled=false;btn.textContent="▶ Play";}alert(e.message);});
}
function addOutput(text){
  var d=document.createElement("div");d.className="out";
  d.innerHTML='<div class="otext" contenteditable="true"></div><button class="play">▶ Play</button>';
  d.querySelector(".otext").textContent=text;
  d.querySelector(".play").addEventListener("click",function(){playText(d.querySelector(".otext").innerText.trim(),this);});
  $("out").appendChild(d);
}
$("gen").addEventListener("click",function(){
  var n=Math.max(1,Math.min(5,parseInt($("samples").value,10)||3));
  $("out").innerHTML="";$("gen").disabled=true;$("gmsg").innerHTML="Generating "+n+" samples…";
  var prompt=assembled(),scenario=$("scenario").value,register=$("register").value.trim(),done=0,ok=0;
  for(var i=0;i<n;i++){
    fetch("/api/soundboard?action=generate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt:prompt,scenario:scenario,register:register})})
     .then(function(r){return r.json();}).then(function(j){done++;if(j.error){$("gmsg").innerHTML='<span class="err">'+esc(j.error)+(j.detail?" — "+esc(j.detail):"")+'</span>';}else{ok++;addOutput(j.text||"(empty)");}if(done===n){$("gen").disabled=false;if(ok)$("gmsg").innerHTML='<span class="ok">'+ok+' samples. Edit any, Play to hear, then rate &amp; save.</span>';}})
     .catch(function(e){done++;if(done===n)$("gen").disabled=false;$("gmsg").innerHTML='<span class="err">'+esc(e.message)+'</span>';});
  }
});

$("save").addEventListener("click",function(){
  var outs=[];document.querySelectorAll("#out .otext").forEach(function(o){outs.push(o.innerText.trim());});
  var payload=Object.assign({reviewer:$("reviewer").value.trim(),register:$("reg_save").value.trim(),scenario:$("scenario").value.trim(),
    prompt_label:$("prompt_label").value.trim(),prompt_text:assembled(),generated_text:outs.join("\\n---\\n"),
    best_for:$("best_for").value.trim(),comments:$("comments").value.trim(),rating:rating},settings());
  if(!payload.register){$("smsg").innerHTML='<span class="err">Add a register label.</span>';return;}
  $("save").disabled=true;$("smsg").innerHTML="Saving…";
  fetch("/api/soundboard?action=save",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)})
   .then(function(r){return r.json();}).then(function(j){if(j.error){$("smsg").innerHTML='<span class="err">'+esc(j.error)+(j.detail?" — "+esc(j.detail):"")+'</span>';$("save").disabled=false;return;}$("smsg").innerHTML='<span class="ok">Saved.</span>';$("save").disabled=false;loadTable();})
   .catch(function(e){$("smsg").innerHTML='<span class="err">'+esc(e.message)+'</span>';$("save").disabled=false;});
});

function stars(n){n=n||0;var s="";for(var i=1;i<=5;i++)s+=i<=n?"★":"☆";return s;}
function shortVoice(v){return v==="nscgRrDRVT6a2RCQs92V"?"Voice B":v==="21m00Tcm4TlvDq8ikWAM"?"Rachel":v==="DGSEKmUV19t0w4RseLao"?"Test":(v||"").slice(0,8);}
function loadTable(){
  fetch("/api/soundboard?action=list").then(function(r){return r.json();}).then(function(j){
    if(j.error){$("table").innerHTML='<span class="err">'+esc(j.error)+(j.detail?" — "+esc(j.detail):"")+' (run the table SQL?)</span>';return;}
    var rows=j.rows||[];if(!rows.length){$("table").innerHTML='<span class="muted">No saved results yet.</span>';return;}
    var h='<table><tr><th>Reg</th><th>Stars</th><th>Prompt</th><th>Scenario</th><th>Sample</th><th>Voice</th><th>Stab</th><th>For</th><th>By</th><th>Notes</th><th></th></tr>';
    for(var i=0;i<rows.length;i++){var r=rows[i];
      h+='<tr><td>'+esc(r.register)+'</td><td class="s">'+stars(r.rating)+'</td><td>'+esc(r.prompt_label)+'</td><td>'+esc((r.scenario||"").slice(0,26))+'</td><td>'+esc((r.generated_text||"").slice(0,40))+'</td><td>'+esc(shortVoice(r.voice_id))+'</td><td>'+(r.stability!=null?r.stability:"")+'</td><td>'+esc(r.best_for)+'</td><td>'+esc(r.reviewer)+'</td><td>'+esc((r.comments||"").slice(0,36))+'</td><td><button class="del" data-id="'+esc(r.id)+'">del</button></td></tr>';
    }
    h+='</table>';$("table").innerHTML=h;
    document.querySelectorAll(".del").forEach(function(b){b.addEventListener("click",function(){if(!confirm("Delete?"))return;fetch("/api/soundboard?action=delete&id="+encodeURIComponent(b.getAttribute("data-id")),{method:"POST"}).then(function(r){return r.json();}).then(function(){loadTable();});});});
  }).catch(function(e){$("table").innerHTML='<span class="err">'+esc(e.message)+'</span>';});
}
function loadVoices(){
  fetch("/api/soundboard?action=voices").then(function(r){return r.json();}).then(function(j){
    if(j.error){$("palette").innerHTML='<span class="muted">palette unavailable (run the lab_voices SQL)</span>';return;}
    var rows=j.rows||[];
    if(!rows.length){$("palette").innerHTML='<span class="muted">no saved voices yet — add one below</span>';return;}
    var h="";for(var i=0;i<rows.length;i++){h+='<span style="display:inline-flex;align-items:center;gap:4px"><button class="preset pv" data-v="'+esc(rows[i].voice_id)+'">'+esc(rows[i].label||rows[i].voice_id.slice(0,8))+'</button><button class="del pvdel" data-id="'+esc(rows[i].id)+'">×</button></span>';}
    $("palette").innerHTML=h;
    document.querySelectorAll(".pv").forEach(function(b){b.addEventListener("click",function(){$("voiceId").value=b.getAttribute("data-v");document.querySelectorAll(".preset[data-v]").forEach(function(x){x.classList.remove("on");});b.classList.add("on");});});
    document.querySelectorAll(".pvdel").forEach(function(b){b.addEventListener("click",function(){fetch("/api/soundboard?action=voicedel&id="+encodeURIComponent(b.getAttribute("data-id")),{method:"POST"}).then(function(r){return r.json();}).then(loadVoices);});});
  }).catch(function(){$("palette").innerHTML='<span class="muted">palette unavailable</span>';});
}
$("addVoice").addEventListener("click",function(){
  var vid=$("newVoiceId").value.trim()||$("voiceId").value.trim();
  var label=$("newVoiceLabel").value.trim()||vid.slice(0,8);
  if(!vid){alert("Enter a voice ID");return;}
  fetch("/api/soundboard?action=voiceadd",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({label:label,voice_id:vid})})
   .then(function(r){return r.json();}).then(function(j){if(j.error){alert(j.error+(j.detail?" — "+j.detail:""));return;}$("newVoiceLabel").value="";$("newVoiceId").value="";loadVoices();});
});

sync();loadTable();loadVoices();
</script>`;

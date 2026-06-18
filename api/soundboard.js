// SpamViking — VOICE LAB (soundboard + rated, shared results).
// ----------------------------------------------------------------------
// Audition register-tagged lines (angry, sarcastic, giggly…) through any voice
// + settings, then SAVE a rated result (stars, reviewer, comments, best-for
// character). Results persist in Supabase so you and others can review them.
//
// Endpoints:
//   GET                       -> the page
//   POST ?action=preview      -> render mp3 with given voice/model/settings
//   GET  ?action=list         -> all saved tunings (newest first)
//   POST ?action=save         -> insert a rated tuning
//   POST ?action=delete&id=   -> delete one
//
// Needs a one-time table (run the SQL in docs/deploy/VOICE_LAB.sql in Supabase).
// Uses ELEVENLABS_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (all set).
// Test artifact — delete when the voices are locked.
// ----------------------------------------------------------------------

export const config = { runtime: "edge" };

const EL_KEY = process.env.ELEVENLABS_API_KEY;
const HOST_VOICE = process.env.VOICE_HOST || "nscgRrDRVT6a2RCQs92V";
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
}
function sb(path, opts) {
  opts = opts || {};
  return fetch(SB_URL + "/rest/v1/" + path, {
    method: opts.method || "GET",
    headers: Object.assign(
      { apikey: SB_KEY, authorization: "Bearer " + SB_KEY, "content-type": "application/json" },
      opts.headers || {}
    ),
    body: opts.body,
  });
}

export default async function handler(req) {
  const u = new URL(req.url);
  const action = u.searchParams.get("action");

  if (action === "preview" && req.method === "POST") {
    if (!EL_KEY) return json({ error: "ELEVENLABS_API_KEY not set" }, 500);
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
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
    const r = await fetch(
      "https://api.elevenlabs.io/v1/text-to-speech/" + voiceId + "?output_format=mp3_44100_128",
      { method: "POST", headers: { "xi-api-key": EL_KEY, "content-type": "application/json" }, body: JSON.stringify(body) }
    ).catch(() => null);
    if (!r || !r.ok) {
      const d = r ? await r.text().catch(() => "") : "fetch error";
      return json({ error: "elevenlabs " + (r ? r.status : ""), detail: String(d).slice(0, 300) }, 502);
    }
    return new Response(r.body, { headers: { "content-type": "audio/mpeg" } });
  }

  if (action === "list") {
    const r = await sb("voice_tunings?select=*&order=created_at.desc").catch(() => null);
    if (!r || !r.ok) {
      const d = r ? await r.text().catch(() => "") : "fetch error";
      return json({ error: "list failed", detail: String(d).slice(0, 300) }, 502);
    }
    return json({ rows: await r.json() });
  }

  if (action === "save" && req.method === "POST") {
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const row = {
      reviewer: String(b.reviewer || "").slice(0, 80),
      register: String(b.register || "").slice(0, 60),
      line_text: String(b.line_text || "").slice(0, 600),
      voice_id: String(b.voiceId || "").slice(0, 80),
      model: String(b.model || "").slice(0, 60),
      stability: b.stability != null ? Number(b.stability) : null,
      style: b.style != null ? Number(b.style) : null,
      similarity: b.similarity != null ? Number(b.similarity) : null,
      speaker_boost: !!b.speaker_boost,
      rating: b.rating != null ? parseInt(b.rating, 10) : null,
      best_for: String(b.best_for || "").slice(0, 80),
      comments: String(b.comments || "").slice(0, 1000),
    };
    const r = await sb("voice_tunings", {
      method: "POST", headers: { prefer: "return=representation" }, body: JSON.stringify(row),
    }).catch(() => null);
    if (!r || !r.ok) {
      const d = r ? await r.text().catch(() => "") : "fetch error";
      return json({ error: "save failed", detail: String(d).slice(0, 300) }, 502);
    }
    return json({ ok: true, row: (await r.json())[0] });
  }

  if (action === "delete" && req.method === "POST") {
    const id = u.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const r = await sb("voice_tunings?id=eq." + encodeURIComponent(id), {
      method: "DELETE", headers: { prefer: "return=minimal" },
    }).catch(() => null);
    if (!r || !r.ok) return json({ error: "delete failed" }, 502);
    return json({ ok: true });
  }

  return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voice lab</title>
<style>
  body{background:#14110d;color:#efe7da;font:15px/1.5 ui-sans-serif,system-ui,sans-serif;max-width:780px;margin:28px auto;padding:0 18px}
  h1{font:600 23px/1 ui-serif,Georgia,serif;margin-bottom:2px}
  h2{font:600 13px ui-sans-serif;color:#d9a441;margin:24px 0 8px;text-transform:uppercase;letter-spacing:.05em}
  p.sub{color:#a99b85;font-size:13px;margin-top:4px}
  .line{display:flex;align-items:flex-start;gap:9px;padding:7px 0;border-bottom:1px solid #221b12}
  .line input{margin-top:3px}
  .tag{display:inline-block;background:#2a2114;color:#d9a441;font-size:11px;padding:1px 7px;border-radius:5px;margin-right:7px;white-space:nowrap}
  .ltext{color:#dcd2bf;font-size:13.5px}
  .ctl{margin:14px 0}
  .ctl label{display:flex;justify-content:space-between;font-size:13px;color:#cfc4b0;margin-bottom:5px}
  .ctl label b{color:#efe7da}
  input[type=range]{width:100%;accent-color:#d9a441}
  .hint{font-size:11px;color:#8a7d68;margin-top:2px}
  input[type=text],textarea,select{width:100%;background:#1d1812;border:1px solid #3a3026;border-radius:8px;color:#efe7da;padding:9px 11px;font:14px ui-sans-serif;box-sizing:border-box}
  textarea{height:52px;resize:vertical}
  .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  button{font:600 14px ui-sans-serif;border:0;border-radius:8px;padding:9px 15px;cursor:pointer}
  .preset{background:#241d15;color:#efe7da;border:1px solid #3a3026}
  .preset.on{background:#d9a441;color:#1a140a;border-color:#d9a441}
  .play{background:#d9a441;color:#1a140a;padding:12px 24px;font-size:15px;margin-top:10px}
  .save{background:#3a6b46;color:#eafff0;padding:11px 22px;margin-top:6px}
  button:disabled{opacity:.5;cursor:wait}
  .toggle{display:inline-flex;align-items:center;gap:8px;font-size:14px;color:#cfc4b0}
  .stars span{font-size:24px;color:#4a4030;cursor:pointer;padding:0 1px}
  .stars span.on{color:#e8b54a}
  .msg{margin-top:8px;min-height:18px;font-size:13px}
  .err{color:#e09080}.ok{color:#7fb88f}
  table{width:100%;border-collapse:collapse;margin-top:10px;font-size:12.5px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #221b12;vertical-align:top}
  th{color:#a99b85;font-size:11px;text-transform:uppercase;letter-spacing:.03em}
  td.s{color:#e8b54a;white-space:nowrap}
  .del{background:#3a1d1d;color:#e0a0a0;border:1px solid #5a2d2d;padding:4px 9px;font-size:12px}
  .muted{color:#8a7d68}
</style>
<h1>Voice lab</h1>
<p class="sub">Pick register lines, dial the voice, hear it, then save a rated result. Saved tunings are shared — anyone with the link sees the table.</p>

<h2>1 · Register lines (check what to hear)</h2>
<div id="lines"></div>

<h2>2 · Voice &amp; performance</h2>
<div class="ctl">
  <input type="text" id="voiceId" value="nscgRrDRVT6a2RCQs92V" placeholder="voice ID">
  <div class="row">
    <button class="preset on" data-v="nscgRrDRVT6a2RCQs92V">Host (Voice B)</button>
    <button class="preset" data-v="DGSEKmUV19t0w4RseLao">Test voice</button>
    <button class="preset" data-v="21m00Tcm4TlvDq8ikWAM">Rachel</button>
  </div>
  <div class="row" style="margin-top:8px">
    <button class="preset on" data-m="eleven_flash_v2_5">Flash</button>
    <button class="preset" data-m="eleven_multilingual_v2">Multilingual v2</button>
  </div>
</div>
<div class="ctl"><label>Stability <b id="vStability">0.50</b></label>
  <input type="range" id="stability" min="0" max="1" step="0.05" value="0.5">
  <div class="hint">Lower = more expressive/varied. Higher = steadier/flatter.</div></div>
<div class="ctl"><label>Style <b id="vStyle">0.00</b></label>
  <input type="range" id="style" min="0" max="1" step="0.05" value="0"></div>
<div class="ctl"><label>Similarity <b id="vSimilarity">0.75</b></label>
  <input type="range" id="similarity" min="0" max="1" step="0.05" value="0.75"></div>
<div class="ctl"><label class="toggle"><input type="checkbox" id="speaker_boost" checked> Speaker boost</label></div>

<button class="play" id="play">▶  Play checked lines</button>
<div class="msg" id="pmsg"></div>

<h2>3 · Rate &amp; save this combo</h2>
<div class="grid">
  <div><label class="hint">Your name</label><input type="text" id="reviewer" placeholder="who's reviewing"></div>
  <div><label class="hint">Register</label><input type="text" id="register" placeholder="e.g. Sarcastic"></div>
  <div><label class="hint">Best for character</label><input type="text" id="best_for" placeholder="Host / Conrad / Bonnie…" list="chars">
    <datalist id="chars"><option>Host</option><option>Conrad</option><option>Bonnie</option><option>Andrea</option></datalist></div>
  <div><label class="hint">Rating</label><div class="stars" id="stars"><span data-n="1">★</span><span data-n="2">★</span><span data-n="3">★</span><span data-n="4">★</span><span data-n="5">★</span></div></div>
</div>
<div class="ctl"><label class="hint">Comments</label><textarea id="comments" placeholder="what worked, what didn't"></textarea></div>
<button class="save" id="save">＋  Save result</button>
<div class="msg" id="smsg"></div>

<h2>4 · Saved results</h2>
<div id="table"><span class="muted">loading…</span></div>

<script>
var model = "eleven_flash_v2_5", rating = 0;
var LINES = [
  { reg: "Distracted", text: "Yeah, mm-hm. Sorry, say that again? I was just— okay, go ahead." },
  { reg: "Impatient", text: "Okay, okay— what's it cost? Just give me the number." },
  { reg: "Sarcastic", text: "Oh, fantastic. Another once-in-a-lifetime opportunity. Can't wait." },
  { reg: "Angry", text: "No. You listen to me. I've been on hold twenty minutes and I am done." },
  { reg: "Giggly", text: "Ha— sorry, I can't— okay, okay, go on, I'm listening, I swear." },
  { reg: "Confused", text: "Wait, I'm— hang on. Which account? I don't… what are we talking about?" },
  { reg: "Suspicious", text: "Mm. And how'd you get this number, exactly? Just curious." },
  { reg: "Excited", text: "Oh, no kidding? That's— okay yeah, tell me more, that actually sounds great." },
  { reg: "Deadpan", text: "Sure. Love it. Sounds like a real solid plan. Riveting." },
  { reg: "Warm", text: "Hey, no— it's good to hear from you. How've you been, seriously?" }
];

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s||"").replace(/[&<>"]/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]; }); }

// render lines
(function(){
  var h = "";
  for (var i=0;i<LINES.length;i++){
    h += '<div class="line"><input type="checkbox" class="lc" data-i="'+i+'"'+(i===2?' checked':'')+'>'
       + '<div><span class="tag">'+esc(LINES[i].reg)+'</span><span class="ltext">'+esc(LINES[i].text)+'</span></div></div>';
  }
  $("lines").innerHTML = h;
  // prefill register from first checked
  syncRegister();
  document.querySelectorAll(".lc").forEach(function(c){ c.addEventListener("change", syncRegister); });
})();

function checkedLines(){
  var out = [];
  document.querySelectorAll(".lc").forEach(function(c){ if(c.checked) out.push(LINES[+c.getAttribute("data-i")]); });
  return out;
}
function syncRegister(){
  var c = checkedLines();
  if(c.length === 1) $("register").value = c[0].reg;
  else if(c.length > 1 && !$("register").value) $("register").value = "Mixed";
}

function sync(){
  $("vStability").textContent = Number($("stability").value).toFixed(2);
  $("vStyle").textContent = Number($("style").value).toFixed(2);
  $("vSimilarity").textContent = Number($("similarity").value).toFixed(2);
}
["stability","style","similarity"].forEach(function(id){ $(id).addEventListener("input", sync); });

document.querySelectorAll(".preset[data-v]").forEach(function(b){ b.addEventListener("click", function(){
  $("voiceId").value = b.getAttribute("data-v");
  document.querySelectorAll(".preset[data-v]").forEach(function(x){ x.classList.remove("on"); }); b.classList.add("on"); }); });
document.querySelectorAll(".preset[data-m]").forEach(function(b){ b.addEventListener("click", function(){
  model = b.getAttribute("data-m");
  document.querySelectorAll(".preset[data-m]").forEach(function(x){ x.classList.remove("on"); }); b.classList.add("on"); }); });

document.querySelectorAll("#stars span").forEach(function(s){ s.addEventListener("click", function(){
  rating = +s.getAttribute("data-n");
  document.querySelectorAll("#stars span").forEach(function(x){ x.classList.toggle("on", +x.getAttribute("data-n") <= rating); }); }); });

function settings(){
  return { voiceId: $("voiceId").value.trim(), model: model,
    stability: Number($("stability").value), style: Number($("style").value),
    similarity: Number($("similarity").value), speaker_boost: $("speaker_boost").checked };
}

function playOne(text){
  return fetch("/api/soundboard?action=preview", { method:"POST", headers:{"content-type":"application/json"},
    body: JSON.stringify(Object.assign({ text: text }, settings())) })
    .then(function(r){ if(!r.ok){ return r.json().then(function(j){ throw new Error(j.error+(j.detail?" — "+j.detail:"")); }); } return r.blob(); })
    .then(function(blob){ return new Promise(function(res){
      var url = URL.createObjectURL(blob); var a = new Audio(url);
      a.onended = function(){ URL.revokeObjectURL(url); res(); }; a.onerror = function(){ res(); }; a.play();
    }); });
}

$("play").addEventListener("click", function(){
  var lines = checkedLines();
  if(!lines.length){ $("pmsg").innerHTML = '<span class="err">Check at least one line.</span>'; return; }
  $("play").disabled = true; $("pmsg").innerHTML = "Playing…";
  (function next(i){
    if(i >= lines.length){ $("pmsg").innerHTML = '<span class="ok">Done.</span>'; $("play").disabled = false; return; }
    $("pmsg").innerHTML = 'Playing: <span class="muted">'+esc(lines[i].reg)+'</span>';
    playOne(lines[i].text).then(function(){ next(i+1); }).catch(function(e){ $("pmsg").innerHTML = '<span class="err">'+esc(e.message)+'</span>'; $("play").disabled = false; });
  })(0);
});

$("save").addEventListener("click", function(){
  var lines = checkedLines();
  var s = settings();
  var payload = Object.assign({
    reviewer: $("reviewer").value.trim(), register: $("register").value.trim(),
    best_for: $("best_for").value.trim(), comments: $("comments").value.trim(),
    rating: rating, line_text: lines.map(function(l){ return l.text; }).join("  |  ")
  }, s);
  if(!payload.register){ $("smsg").innerHTML = '<span class="err">Add a register label.</span>'; return; }
  $("save").disabled = true; $("smsg").innerHTML = "Saving…";
  fetch("/api/soundboard?action=save", { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(payload) })
    .then(function(r){ return r.json(); }).then(function(j){
      if(j.error){ $("smsg").innerHTML = '<span class="err">'+esc(j.error)+(j.detail?" — "+esc(j.detail):"")+'</span>'; $("save").disabled=false; return; }
      $("smsg").innerHTML = '<span class="ok">Saved.</span>'; $("save").disabled = false; loadTable();
    }).catch(function(e){ $("smsg").innerHTML = '<span class="err">'+esc(e.message)+'</span>'; $("save").disabled=false; });
});

function stars(n){ n = n||0; var s=""; for(var i=1;i<=5;i++) s += i<=n ? "★" : "☆"; return s; }
function shortVoice(v){ return v === "nscgRrDRVT6a2RCQs92V" ? "Voice B" : v === "21m00Tcm4TlvDq8ikWAM" ? "Rachel" : v === "DGSEKmUV19t0w4RseLao" ? "Test" : (v||"").slice(0,8); }

function loadTable(){
  fetch("/api/soundboard?action=list").then(function(r){ return r.json(); }).then(function(j){
    if(j.error){ $("table").innerHTML = '<span class="err">'+esc(j.error)+(j.detail?" — "+esc(j.detail):"")+' (did you run the table SQL?)</span>'; return; }
    var rows = j.rows||[];
    if(!rows.length){ $("table").innerHTML = '<span class="muted">No saved results yet.</span>'; return; }
    var h = '<table><tr><th>Register</th><th>Rating</th><th>Voice</th><th>Model</th><th>Stab</th><th>Style</th><th>Sim</th><th>Boost</th><th>Best for</th><th>By</th><th>Comments</th><th></th></tr>';
    for(var i=0;i<rows.length;i++){ var r = rows[i];
      h += '<tr>'
        + '<td>'+esc(r.register)+'</td>'
        + '<td class="s">'+stars(r.rating)+'</td>'
        + '<td>'+esc(shortVoice(r.voice_id))+'</td>'
        + '<td>'+esc((r.model||"").replace("eleven_",""))+'</td>'
        + '<td>'+(r.stability!=null?r.stability:"")+'</td>'
        + '<td>'+(r.style!=null?r.style:"")+'</td>'
        + '<td>'+(r.similarity!=null?r.similarity:"")+'</td>'
        + '<td>'+(r.speaker_boost?"on":"off")+'</td>'
        + '<td>'+esc(r.best_for)+'</td>'
        + '<td>'+esc(r.reviewer)+'</td>'
        + '<td>'+esc(r.comments)+'</td>'
        + '<td><button class="del" data-id="'+esc(r.id)+'">delete</button></td>'
        + '</tr>';
    }
    h += '</table>';
    $("table").innerHTML = h;
    document.querySelectorAll(".del").forEach(function(b){ b.addEventListener("click", function(){
      if(!confirm("Delete this result?")) return;
      fetch("/api/soundboard?action=delete&id="+encodeURIComponent(b.getAttribute("data-id")), { method:"POST" })
        .then(function(r){ return r.json(); }).then(function(){ loadTable(); });
    }); });
  }).catch(function(e){ $("table").innerHTML = '<span class="err">'+esc(e.message)+'</span>'; });
}

sync(); loadTable();
</script>`;

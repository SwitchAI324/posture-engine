// SpamViking — voice auditioner.
// ----------------------------------------------------------------------
// Casting tool: paste any ElevenLabs voice ID (must be added to your account),
// type a line, hear it instantly. Toggle the model to hear the fast/production
// voice vs the warm one. Lets you cast the host (and bench) in minutes instead
// of redeploying per voice.
//
// Test artifact — delete api/voicetry.js once voices are cast.
// Needs ELEVENLABS_API_KEY in Vercel env (already set).
// ----------------------------------------------------------------------

export const config = { runtime: "edge" };

const EL_KEY = process.env.ELEVENLABS_API_KEY;

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
}

export default async function handler(req) {
  const u = new URL(req.url);

  if (req.method === "POST" && u.searchParams.get("action") === "say") {
    if (!EL_KEY) return json({ error: "ELEVENLABS_API_KEY not set" }, 500);
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const voiceId = String(b.voiceId || "").trim();
    const text = String(b.text || "").trim();
    const model = String(b.model || "eleven_flash_v2_5").trim();
    if (!voiceId || !text) return json({ error: "voiceId and text required" }, 400);

    const r = await fetch(
      "https://api.elevenlabs.io/v1/text-to-speech/" + voiceId + "?output_format=mp3_44100_128",
      {
        method: "POST",
        headers: { "xi-api-key": EL_KEY, "content-type": "application/json" },
        body: JSON.stringify({ text, model_id: model }),
      }
    ).catch(() => null);

    if (!r || !r.ok) {
      const d = r ? await r.text().catch(() => "") : "fetch error";
      return json({ error: "elevenlabs " + (r ? r.status : ""), detail: String(d).slice(0, 300) }, 502);
    }
    return new Response(r.body, { headers: { "content-type": "audio/mpeg" } });
  }

  return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Voice auditioner</title>
<style>
  body{background:#14110d;color:#efe7da;font:15px/1.55 ui-sans-serif,system-ui,sans-serif;max-width:640px;margin:36px auto;padding:0 18px}
  h1{font:600 22px/1 ui-serif,Georgia,serif;margin-bottom:4px}
  p.sub{color:#a99b85;font-size:13px;margin-top:4px}
  label{display:block;font-size:12px;color:#a99b85;margin:16px 0 5px;text-transform:uppercase;letter-spacing:.04em}
  input,textarea,select{width:100%;background:#1d1812;border:1px solid #3a3026;border-radius:8px;color:#efe7da;padding:11px 12px;font:14px ui-sans-serif,system-ui;box-sizing:border-box}
  textarea{height:70px;resize:vertical}
  .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  button{font:600 14px ui-sans-serif,system-ui;border:0;border-radius:8px;padding:11px 18px;cursor:pointer}
  .preset{background:#241d15;color:#efe7da;border:1px solid #3a3026}
  .preset.on{background:#d9a441;color:#1a140a;border-color:#d9a441}
  .play{background:#d9a441;color:#1a140a;padding:13px 26px;font-size:15px;margin-top:18px}
  button:disabled{opacity:.5;cursor:wait}
  .msg{margin-top:14px;min-height:20px;font-size:13px}
  .err{color:#e09080}.ok{color:#7fb88f}
  .seg{display:inline-flex;border:1px solid #3a3026;border-radius:8px;overflow:hidden;margin-top:8px}
  .seg button{background:#1d1812;color:#cfc4b0;border-radius:0;border-right:1px solid #3a3026}
  .seg button:last-child{border-right:0}
  .seg button.on{background:#3a2f1c;color:#efe7da}
</style>
<h1>Voice auditioner</h1>
<p class="sub">Paste a voice ID (added to your ElevenLabs account), pick a line, hear it. Same pipeline as your calls.</p>

<label>Voice ID</label>
<input id="vid" placeholder="paste an ElevenLabs voice ID" autocomplete="off">
<div class="row">
  <button class="preset" data-v="NxGA8X3YhTrnf3TRQf6Q">Voice A</button>
  <button class="preset" data-v="nscgRrDRVT6a2RCQs92V">Voice B</button>
  <button class="preset" data-v="21m00Tcm4TlvDq8ikWAM">Rachel (current)</button>
</div>

<label>Model</label>
<div class="seg" id="model">
  <button data-m="eleven_flash_v2_5" class="on">Flash (fast / production)</button>
  <button data-m="eleven_multilingual_v2">Multilingual v2 (warm)</button>
</div>

<label>Line to speak</label>
<textarea id="text">Hey, thanks for hopping on. Give me one second, I'm just pulling up your account here. Okay — so walk me through what you've got, I want to make sure I'm getting the details right.</textarea>

<button class="play" id="play">▶  Play</button>
<div class="msg" id="msg"></div>

<script>
var model = "eleven_flash_v2_5";
function $(id){ return document.getElementById(id); }
function msg(s, cls){ $("msg").innerHTML = '<span class="' + (cls||"") + '">' + s + '</span>'; }

document.querySelectorAll(".preset").forEach(function(b){
  b.addEventListener("click", function(){
    $("vid").value = b.getAttribute("data-v");
    document.querySelectorAll(".preset").forEach(function(x){ x.classList.remove("on"); });
    b.classList.add("on");
  });
});
document.querySelectorAll("#model button").forEach(function(b){
  b.addEventListener("click", function(){
    model = b.getAttribute("data-m");
    document.querySelectorAll("#model button").forEach(function(x){ x.classList.remove("on"); });
    b.classList.add("on");
  });
});

$("play").addEventListener("click", function(){
  var voiceId = $("vid").value.trim();
  var text = $("text").value.trim();
  if(!voiceId){ msg("Paste or pick a voice ID first.", "err"); return; }
  if(!text){ msg("Type a line to speak.", "err"); return; }
  $("play").disabled = true; msg("Generating\\u2026");
  fetch("/api/voicetry?action=say", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ voiceId: voiceId, text: text, model: model })
  }).then(function(r){
    if(!r.ok){ return r.json().then(function(j){ throw new Error((j.error||"failed") + (j.detail ? " — " + j.detail : "")); }); }
    return r.blob();
  }).then(function(blob){
    var url = URL.createObjectURL(blob);
    var a = new Audio(url);
    a.onended = function(){ URL.revokeObjectURL(url); };
    a.play();
    msg("Playing (" + model.replace("eleven_","") + ").", "ok");
    $("play").disabled = false;
  }).catch(function(e){
    msg("Error: " + e.message, "err");
    $("play").disabled = false;
  });
});
</script>`;

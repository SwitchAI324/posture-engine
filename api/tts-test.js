// SpamViking — TTS proxy test page (hear it + measure latency, pre-live).
// ----------------------------------------------------------------------
// POSTs a voice-request to /api/tts exactly like Vapi will, plays the returned
// PCM through Web Audio so you can HEAR the character voice, and shows the
// server first-byte latency (x-tts-ttfb-ms) plus total render time. Use this to
// check voices and latency BEFORE pointing the live assistant at the proxy.
// Test artifact — delete api/tts-test.js when done.
// ----------------------------------------------------------------------

export const config = { runtime: "edge" };

export default async function handler() {
  return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TTS proxy test</title>
<style>
  body{background:#14110d;color:#efe7da;font:15px/1.55 ui-sans-serif,system-ui,sans-serif;max-width:680px;margin:34px auto;padding:0 18px}
  h1{font:600 22px/1 ui-serif,Georgia,serif}
  label{display:block;color:#a99b85;font-size:12px;letter-spacing:.5px;text-transform:uppercase;margin:16px 0 6px}
  textarea,select{width:100%;font:15px ui-sans-serif,system-ui;color:#efe7da;background:#1d1812;border:1px solid #3a3026;border-radius:8px;padding:11px 13px;box-sizing:border-box}
  textarea{height:78px;resize:vertical}
  .row{display:flex;gap:12px}.row>div{flex:1}
  button{margin-top:16px;font:600 15px ui-sans-serif,system-ui;color:#1a140a;background:#d9a441;border:0;border-radius:9px;padding:12px 22px;cursor:pointer}
  button:disabled{opacity:.5;cursor:wait}
  .metrics{margin-top:22px;display:none;background:#1d1812;border:1px solid #3a3026;border-radius:8px;padding:14px}
  .metrics .big{font:700 30px ui-serif,Georgia,serif;color:#d9a441}
  .kv{margin:4px 0;color:#cfc4b0;font-size:13px}.kv b{color:#a99b85;font-weight:600;display:inline-block;min-width:150px}
  .err{color:#e09080}
</style>
<h1>TTS proxy test</h1>
<p style="color:#a99b85;font-size:13px">Sends a voice-request to <code>/api/tts</code> the way Vapi will, plays the
voice, and times it. Add <code>[[CONRAD]]</code> etc. in the text, or use the speaker picker (it prepends the marker).</p>

<label for="text">Line</label>
<textarea id="text">You call this a discovery call? I've seen better discovery in a kids' magic kit.</textarea>
<div class="row">
  <div><label for="speaker">Speaker</label>
    <select id="speaker"><option>HOST</option><option>ANDREA</option><option>CONRAD</option><option>BONNIE</option></select></div>
  <div><label for="rate">Sample rate</label>
    <select id="rate"><option>24000</option><option>16000</option><option>44100</option></select></div>
</div>
<button id="go">Speak it</button>

<div class="metrics" id="metrics"></div>

<script>
var btn = document.getElementById("go");
var metrics = document.getElementById("metrics");
var audioCtx = null;

btn.addEventListener("click", function(){
  var text = document.getElementById("text").value.trim();
  var speaker = document.getElementById("speaker").value;
  var rate = parseInt(document.getElementById("rate").value, 10);
  if(!/^\\s*\\[\\[/.test(text)) text = "[[" + speaker + "]] " + text;

  btn.disabled = true;
  metrics.style.display = "block";
  metrics.innerHTML = '<div class="kv">requesting\\u2026</div>';

  var t0 = performance.now();
  fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: { type: "voice-request", text: text, sampleRate: rate, timestamp: Date.now() } })
  }).then(function(resp){
    var headerTtfb = resp.headers.get("x-tts-ttfb-ms");
    var spk = resp.headers.get("x-tts-speaker") || speaker;
    if(!resp.ok){ return resp.text().then(function(t){ throw new Error("HTTP " + resp.status + " " + t); }); }
    return resp.arrayBuffer().then(function(buf){
      var total = Math.round(performance.now() - t0);
      var pcm = new Int16Array(buf);
      var secs = (pcm.length / rate);
      if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var ab = audioCtx.createBuffer(1, pcm.length, rate);
      var ch = ab.getChannelData(0);
      for(var i=0;i<pcm.length;i++) ch[i] = pcm[i] / 32768;
      var src = audioCtx.createBufferSource(); src.buffer = ab; src.connect(audioCtx.destination); src.start();
      metrics.innerHTML =
        '<div class="big">' + (headerTtfb || "?") + ' ms</div>' +
        '<div class="kv"><b>first audio (server)</b>' + (headerTtfb || "?") + ' ms &mdash; ElevenLabs first chunk</div>' +
        '<div class="kv"><b>total render+download</b>' + total + ' ms</div>' +
        '<div class="kv"><b>voice used</b>' + spk + '</div>' +
        '<div class="kv"><b>audio length</b>' + secs.toFixed(1) + ' s (' + pcm.length + ' samples @ ' + rate + 'Hz)</div>' +
        '<div class="kv" style="color:#7fb88f">playing\\u2026</div>';
    });
  }).catch(function(e){
    metrics.innerHTML = '<div class="kv err">' + String(e) + '</div>';
  }).finally(function(){ btn.disabled = false; });
});
</script>`;

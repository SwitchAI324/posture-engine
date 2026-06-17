// SpamViking — Posture Engine: SMOKE-TEST (real Web-SDK path).
// ----------------------------------------------------------------------
// Mirrors what the real zoom-like meeting page does: reads the token's
// archetype from /api/join, starts a Vapi WEB call in the browser with
// metadata { archetype, slug } stamped on it, lets you talk into your mic,
// and records the call id back. This exercises the genuine carrier path —
// metadata set client-side at vapi.start — so you can watch the `arch:` flip
// in the proxy logs as you speak.
//
// Needs VAPI_PUBLIC_KEY (browser-safe Vapi public key) in Vercel env, and the
// assistant's model.metadataSendMode NOT set to "off".
// Test artifact — delete api/smoke.js when done.
// ----------------------------------------------------------------------

export const config = { runtime: "edge" };

const PUBLIC_KEY = process.env.VAPI_PUBLIC_KEY || "";
const ASSISTANT_ID =
  process.env.VAPI_ASSISTANT_ID || "c8917a9c-dee6-4044-bf20-39212d63937d";

export default async function handler() {
  return new Response(PAGE(PUBLIC_KEY, ASSISTANT_ID), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function PAGE(pub, asst) {
  return `<!doctype html><meta charset="utf-8">
<title>Carrier smoke-test (web call)</title>
<style>
  body{background:#14110d;color:#efe7da;font:15px/1.55 ui-sans-serif,system-ui,sans-serif;max-width:760px;margin:34px auto;padding:0 18px}
  h1{font:600 23px/1 ui-serif,Georgia,serif}
  .meta{color:#a99b85;font-size:13px}
  label{display:block;color:#a99b85;font-size:12px;letter-spacing:.5px;text-transform:uppercase;margin:18px 0 6px}
  input{width:100%;font:15px ui-monospace,monospace;color:#efe7da;background:#1d1812;border:1px solid #3a3026;border-radius:8px;padding:11px 13px;box-sizing:border-box}
  button{margin:16px 8px 0 0;font:600 15px ui-sans-serif,system-ui;color:#1a140a;background:#d9a441;border:0;border-radius:9px;padding:12px 20px;cursor:pointer}
  button.ghost{background:#241d15;color:#efe7da;border:1px solid #3a3026}
  button:disabled{opacity:.5;cursor:not-allowed}
  #log{margin-top:22px;background:#1d1812;border:1px solid #3a3026;border-radius:8px;padding:12px;font:13px ui-monospace,monospace;color:#cfc4b0;height:300px;overflow:auto;white-space:pre-wrap}
  .warn{color:#e0a060}
</style>
<h1>Carrier smoke-test &middot; web call</h1>
<p class="meta">Starts a real browser voice call to the assistant with <code>metadata{archetype,slug}</code>
stamped on it — the same way the real meeting page will. Allow mic access when asked, then speak.
Watch the proxy logs for <code>"arch":"crypto_investment"</code>.</p>

<label for="slug">Token slug</label>
<input id="slug" value="smoke-test-001">
<button id="start">Start web call</button>
<button id="stop" class="ghost" disabled>End call</button>

<div id="log"></div>

<script type="module">
import Vapi from "https://esm.sh/@vapi-ai/web";
var PUB = ${JSON.stringify(pub)};
var ASST = ${JSON.stringify(asst)};

var slugInput = document.getElementById("slug");
var startBtn = document.getElementById("start");
var stopBtn = document.getElementById("stop");
var logEl = document.getElementById("log");
var vapi = null, currentSlug = null;

function line(s){ var d = document.createElement("div"); d.textContent = s; logEl.appendChild(d); logEl.scrollTop = logEl.scrollHeight; }

if(!PUB){ line("[!] VAPI_PUBLIC_KEY not set on the server — add it in Vercel env and redeploy."); startBtn.disabled = true; }

try { vapi = new Vapi(PUB); line("SDK ready."); } catch(e){ line("SDK init failed: " + e); }

if(vapi){
  vapi.on("call-start", function(){ line("> call-start"); });
  vapi.on("call-end", function(){ line("> call-end"); stopBtn.disabled = true; startBtn.disabled = false; });
  vapi.on("speech-start", function(){ line("  (assistant speaking)"); });
  vapi.on("message", function(m){ if(m && m.type === "transcript" && m.transcriptType === "final"){ line("  " + m.role + ": " + m.transcript); } });
  vapi.on("error", function(e){ line("ERROR: " + (e && e.message ? e.message : JSON.stringify(e))); });
}

startBtn.addEventListener("click", function(){
  currentSlug = slugInput.value.trim();
  startBtn.disabled = true;
  line("reading archetype for slug=" + currentSlug + " ...");
  fetch("/api/join?slug=" + encodeURIComponent(currentSlug))
    .then(function(r){ return r.json(); })
    .then(function(j){
      if(j.error){ line("token read error: " + JSON.stringify(j)); startBtn.disabled = false; return; }
      var arch = j.archetype || "universal";
      line("archetype = " + arch + " -- starting web call with metadata ...");
      return vapi.start(ASST, { metadata: { archetype: arch, slug: currentSlug } })
        .then(function(call){
          stopBtn.disabled = false;
          var id = call && (call.id || call.callId);
          line("call started" + (id ? " id=" + id : " (no id returned by SDK)"));
          line(">>> SPEAK now: say 'are you a real person?'");
          if(id){
            fetch("/api/join?slug=" + encodeURIComponent(currentSlug) + "&call_id=" + encodeURIComponent(id), { method: "POST" })
              .then(function(r){ return r.json(); })
              .then(function(w){ line("recorded id back to token: " + JSON.stringify(w)); });
          }
        });
    })
    .catch(function(e){ line("start failed: " + e); startBtn.disabled = false; });
});

stopBtn.addEventListener("click", function(){ if(vapi){ vapi.stop(); } });
</script>`;
}

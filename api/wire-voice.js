// SpamViking — one-click: point the live assistant's voice at our TTS proxy.
// ----------------------------------------------------------------------
// Wiring custom-voice is an API change, not a dashboard dropdown. This does it
// for you, server-side, so you never touch curl or JSON: open the page, click
// "Wire in custom TTS." An "Undo" button restores the previous voice. A
// fallback voice is included so a proxy hiccup can't kill a call.
//
// Needs VAPI_API_KEY (private Vapi key) in Vercel env. Test artifact — you can
// delete api/wire-voice.js once the voice is wired and confirmed.
// ----------------------------------------------------------------------

export const config = { runtime: "edge" };

const VAPI_KEY = process.env.VAPI_API_KEY;
const ASSISTANT_ID =
  process.env.VAPI_ASSISTANT_ID || "c8917a9c-dee6-4044-bf20-39212d63937d";
const TTS_URL = process.env.TTS_URL || "https://posture-engine.vercel.app/api/tts";

const WIRE_VOICE = {
  provider: "custom-voice",
  server: { url: TTS_URL, timeoutSeconds: 30 },
  fallbackPlan: { voices: [{ provider: "11labs", voiceId: "21m00Tcm4TlvDq8ikWAM" }] },
};
const WIRE_VOICE_NO_FALLBACK = {
  provider: "custom-voice",
  server: { url: TTS_URL, timeoutSeconds: 30 },
};
const DEFAULT_RESTORE = { provider: "11labs", voiceId: "21m00Tcm4TlvDq8ikWAM" };

function j(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
}
async function vapiGet() {
  return fetch("https://api.vapi.ai/assistant/" + ASSISTANT_ID, {
    headers: { authorization: "Bearer " + VAPI_KEY },
  });
}
async function vapiPatchVoice(voice) {
  return fetch("https://api.vapi.ai/assistant/" + ASSISTANT_ID, {
    method: "PATCH",
    headers: { authorization: "Bearer " + VAPI_KEY, "content-type": "application/json" },
    body: JSON.stringify({ voice }),
  });
}

export default async function handler(req) {
  const u = new URL(req.url);
  const action = u.searchParams.get("action");

  if (action === "status") {
    if (!VAPI_KEY) return j({ error: "VAPI_API_KEY not set" }, 500);
    const r = await vapiGet();
    if (!r.ok) return j({ error: "vapi read failed", status: r.status, detail: await r.text().catch(() => "") }, 502);
    const a = await r.json();
    return j({ voice: a.voice || null });
  }

  if (req.method === "POST" && action === "wire") {
    if (!VAPI_KEY) return j({ error: "VAPI_API_KEY not set" }, 500);
    const cur = await vapiGet();
    const prev = cur.ok ? (await cur.json()).voice : null;
    let r = await vapiPatchVoice(WIRE_VOICE);
    let withFallback = true;
    if (!r.ok) { r = await vapiPatchVoice(WIRE_VOICE_NO_FALLBACK); withFallback = false; }
    if (!r.ok) return j({ error: "wire failed", status: r.status, detail: await r.text().catch(() => "") }, 502);
    return j({ ok: true, withFallback, previous: prev });
  }

  if (req.method === "POST" && action === "restore") {
    if (!VAPI_KEY) return j({ error: "VAPI_API_KEY not set" }, 500);
    let voice = DEFAULT_RESTORE;
    try { const b = await req.json(); if (b && b.voice) voice = b.voice; } catch {}
    const r = await vapiPatchVoice(voice);
    if (!r.ok) return j({ error: "restore failed", status: r.status, detail: await r.text().catch(() => "") }, 502);
    return j({ ok: true });
  }

  return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
}

const PAGE = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Wire in custom TTS</title>
<style>
  body{background:#14110d;color:#efe7da;font:15px/1.55 ui-sans-serif,system-ui,sans-serif;max-width:600px;margin:40px auto;padding:0 18px}
  h1{font:600 22px/1 ui-serif,Georgia,serif}
  .now{background:#1d1812;border:1px solid #3a3026;border-radius:8px;padding:12px 14px;margin:16px 0;font-size:14px;color:#cfc4b0}
  .now b{color:#a99b85}
  button{font:600 15px ui-sans-serif,system-ui;border:0;border-radius:9px;padding:13px 22px;cursor:pointer;margin:6px 8px 0 0}
  .wire{background:#d9a441;color:#1a140a}
  .undo{background:#241d15;color:#efe7da;border:1px solid #3a3026}
  button:disabled{opacity:.5;cursor:wait}
  .msg{margin-top:18px;min-height:20px;font-size:14px}
  .ok{color:#7fb88f}.err{color:#e09080}
</style>
<h1>Wire in custom TTS</h1>
<p style="color:#a99b85;font-size:13px">Points the live assistant's voice at your TTS proxy so the host speaks through
it on real calls. Reversible — "Undo" puts the old voice back.</p>

<div class="now" id="now">Checking current voice&hellip;</div>
<button class="wire" id="wire">Wire in custom TTS</button>
<button class="undo" id="undo" disabled>Undo (restore previous)</button>
<div class="msg" id="msg"></div>

<script>
var prevVoice = null;
function $(id){ return document.getElementById(id); }
function msg(s, cls){ $("msg").innerHTML = '<span class="' + (cls||"") + '">' + s + '</span>'; }

fetch("/api/wire-voice?action=status").then(function(r){ return r.json(); }).then(function(j){
  if(j.error){ $("now").innerHTML = '<b>Current voice:</b> could not read (' + j.error + ')'; return; }
  var p = j.voice && j.voice.provider ? j.voice.provider : "unknown";
  $("now").innerHTML = '<b>Current voice provider:</b> ' + p + (p === "custom-voice" ? '  &mdash; already wired to your proxy' : '');
}).catch(function(){ $("now").innerHTML = '<b>Current voice:</b> could not read'; });

$("wire").addEventListener("click", function(){
  $("wire").disabled = true; msg("Wiring\\u2026");
  fetch("/api/wire-voice?action=wire", { method: "POST" }).then(function(r){ return r.json(); }).then(function(j){
    if(j.error){ msg("Failed: " + j.error + (j.detail ? " &mdash; " + j.detail : ""), "err"); $("wire").disabled = false; return; }
    prevVoice = j.previous || null;
    $("undo").disabled = false;
    $("now").innerHTML = '<b>Current voice provider:</b> custom-voice &mdash; wired to your proxy';
    msg("Done. The host now speaks through your TTS proxy" + (j.withFallback ? " (with a safety fallback voice)." : ".") + " Make a test call to hear it.", "ok");
  }).catch(function(e){ msg("Error: " + e, "err"); $("wire").disabled = false; });
});

$("undo").addEventListener("click", function(){
  $("undo").disabled = true; msg("Restoring\\u2026");
  fetch("/api/wire-voice?action=restore", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ voice: prevVoice })
  }).then(function(r){ return r.json(); }).then(function(j){
    if(j.error){ msg("Restore failed: " + j.error, "err"); $("undo").disabled = false; return; }
    $("now").innerHTML = '<b>Current voice provider:</b> restored to previous';
    $("wire").disabled = false;
    msg("Restored the previous voice.", "ok");
  }).catch(function(e){ msg("Error: " + e, "err"); $("undo").disabled = false; });
});
</script>`;

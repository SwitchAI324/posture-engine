// SpamViking — the meeting the scammer joins. Zoom-like shell, audio-only.
// ----------------------------------------------------------------------
// NORTH STAR: give a zoom-like meeting experience, but video is LOCKED OFF for
// everyone. In-world cover: the host keeps their camera off, so cameras are
// disabled for the meeting (no one is put on the spot). The Zoom shell is
// theater; the only live channel is Vapi audio. No real video infra, no Daily
// rooms of our own — the camera button just sits locked.
//
// Token-driven: reads the archetype from /api/join, starts the Vapi audio call
// with metadata { archetype, slug } (the carrier), records the call id back.
// Host tile lights up when the AI speaks (Vapi speech events); live captions
// come from transcript messages.
//
//   scammer link -> /api/meeting?slug=<token>
//
// Needs VAPI_PUBLIC_KEY (browser-safe) in env; assistant model.metadataSendMode
// must NOT be "off" or the proxy won't see the archetype.
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
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SpamViking Meeting</title>
<style>
  :root{--bg:#1c1d21;--stage:#0e0e10;--tile:#2a2b30;--ink:#f2f3f7;--mut:#a3a6b0;--bar:#26272c;--line:#34353c;--leave:#e0483d;--spk:#37d07a}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;height:100vh;overflow:hidden}
  /* lobby */
  #consent,#lobby{height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .consent-body{font-size:13.5px;color:#d4d6de;max-height:42vh;overflow:auto;margin:6px 0 14px;text-align:left}
  .consent-body p{margin-bottom:10px}
  .consent-body .fineprint{color:var(--mut);font-size:12px;font-style:italic}
  .agree{display:flex;align-items:center;gap:9px;font-size:13px;color:var(--ink);text-align:left;margin-bottom:6px;cursor:pointer}
  .agree input{width:17px;height:17px}
  .lobby-card{background:var(--bar);border:1px solid var(--line);border-radius:14px;max-width:420px;width:100%;padding:30px;text-align:center}
  .lobby-card h1{font-size:20px;margin-bottom:4px}
  .lobby-card .sub{color:var(--mut);font-size:13px;margin-bottom:22px}
  .preview{background:var(--tile);border-radius:12px;height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;margin-bottom:8px}
  .vbadge{color:var(--mut);font-size:12px;display:flex;align-items:center;gap:6px}
  .joinbtn{margin-top:18px;width:100%;background:#2d8cff;color:#fff;font:600 16px ui-sans-serif,system-ui;border:0;border-radius:10px;padding:13px;cursor:pointer}
  .joinbtn:disabled{opacity:.5;cursor:wait}
  .note{color:var(--mut);font-size:12px;margin-top:12px;min-height:16px}
  .note.err{color:#ff8b8b}
  /* meeting */
  #meeting{display:none;height:100vh;flex-direction:column}
  .topbar{height:44px;background:var(--stage);display:flex;align-items:center;justify-content:space-between;padding:0 16px;font-size:13px;color:var(--mut);border-bottom:1px solid #000}
  .topbar .secure{display:flex;align-items:center;gap:6px}
  .stage{flex:1;background:var(--stage);display:flex;align-items:center;justify-content:center;gap:16px;padding:18px;flex-wrap:wrap}
  .tile{background:var(--tile);border-radius:14px;width:min(46%,460px);aspect-ratio:16/10;display:flex;flex-direction:column;align-items:center;justify-content:center;position:relative;border:3px solid transparent;transition:border-color .15s}
  .tile.speaking{border-color:var(--spk)}
  .pfp{width:84px;height:84px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:600;color:#fff}
  .pfp.host{background:linear-gradient(135deg,#3a4a7a,#2d8cff)}
  .pfp.you{background:linear-gradient(135deg,#4a3a5a,#8a5cc0)}
  .name{position:absolute;left:12px;bottom:10px;background:rgba(0,0,0,.55);padding:3px 9px;border-radius:6px;font-size:13px;display:flex;align-items:center;gap:6px}
  .micoff{color:#ff7a6e}
  .caption{position:absolute;left:0;right:0;bottom:84px;text-align:center;pointer-events:none}
  .caption span{background:rgba(0,0,0,.72);padding:6px 14px;border-radius:8px;font-size:15px;max-width:80%;display:inline-block}
  /* toolbar */
  .toolbar{height:72px;background:var(--bar);border-top:1px solid var(--line);display:flex;align-items:center;justify-content:center;gap:6px}
  .ctrl{background:none;border:0;color:var(--ink);font:11px ui-sans-serif,system-ui;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 14px;border-radius:8px;cursor:pointer;min-width:64px}
  .ctrl:hover{background:#33343a}
  .ctrl svg{width:22px;height:22px}
  .ctrl.locked{color:var(--mut);cursor:not-allowed;position:relative}
  .ctrl.locked:hover{background:none}
  .ctrl.leave{color:var(--leave)}
  .ctrl .lockpin{position:absolute;top:2px;right:14px;font-size:10px}
  .toast{position:fixed;left:50%;top:56px;transform:translateX(-50%);background:#000;border:1px solid var(--line);color:var(--ink);padding:10px 16px;border-radius:10px;font-size:13px;max-width:90%;opacity:0;transition:opacity .3s;pointer-events:none}
  .toast.show{opacity:1}
</style>

<!-- CONSENT (entry point after clicking the join link) -->
<div id="consent">
  <div class="lobby-card" style="max-width:520px">
    <h1>Before you join</h1>
    <p class="sub">Please review and accept to continue</p>
    <div class="consent-body">
      <p><b>This meeting will be recorded.</b> By joining, you acknowledge and
      agree that audio &mdash; and any screen content you choose to share &mdash;
      will be recorded, and that the host may use, reproduce, edit, distribute,
      and publish the recording and any content from this meeting, including on
      public platforms and social media, in any media now known or later
      developed, worldwide, in perpetuity, without further notice, compensation,
      or approval.</p>
      <p>You confirm you are authorized to participate and consent to this
      recording and use. If you do not agree, please do not join.</p>
      <p class="fineprint">[Placeholder consent language &mdash; replace with your
      reviewed legal copy before launch.]</p>
    </div>
    <label class="agree"><input type="checkbox" id="agree"> I have read and agree to the above.</label>
    <button class="joinbtn" id="continue" disabled>Continue</button>
  </div>
</div>

<!-- LOBBY -->
<div id="lobby" style="display:none">
  <div class="lobby-card">
    <h1 id="mtgTitle">SpamViking &middot; Discovery Call</h1>
    <p class="sub">Audio meeting</p>
    <div class="preview">
      <div class="pfp you" style="width:64px;height:64px;font-size:24px">Y</div>
      <div class="vbadge">${cam_off_svg()} Your camera is off</div>
    </div>
    <button class="joinbtn" id="join">Join now</button>
    <p class="note" id="note">The host has video off for this meeting, so cameras stay off for everyone.</p>
  </div>
</div>

<!-- MEETING -->
<div id="meeting">
  <div class="topbar">
    <span id="mtgName">SpamViking &middot; Discovery Call</span>
    <span class="secure">${lock_svg()} <span id="timer">connecting&hellip;</span></span>
  </div>
  <div class="stage">
    <div class="tile" id="hostTile">
      <div class="pfp host" id="hostPfp">A</div>
      <div class="name"><span id="hostName">Andrew</span> ${micon_svg()}</div>
    </div>
    <div class="tile" id="youTile">
      <div class="pfp you">Y</div>
      <div class="name">You <span id="youMic">${micon_svg()}</span></div>
    </div>
    <div class="caption" id="caption" style="display:none"><span id="captionText"></span></div>
  </div>
  <div class="toolbar">
    <button class="ctrl" id="muteCtrl">${micon_svg()}<span id="muteLbl">Mute</span></button>
    <button class="ctrl locked" id="camCtrl" title="The host has video turned off for this meeting">${cam_off_svg()}<span>Start Video</span><span class="lockpin">&#128274;</span></button>
    <button class="ctrl" id="partCtrl">${people_svg()}<span>Participants</span></button>
    <button class="ctrl leave" id="leaveCtrl">${leave_svg()}<span>Leave</span></button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script type="module">
import Vapi from "https://esm.sh/@vapi-ai/web";
var PUB = ${JSON.stringify(pub)};
var ASST = ${JSON.stringify(asst)};

var slug = new URLSearchParams(location.search).get("slug");
var vapi = null, started = null, tick = null, muted = false;

var $ = function(id){ return document.getElementById(id); };
function toast(s){ var t = $("toast"); t.textContent = s; t.classList.add("show"); setTimeout(function(){ t.classList.remove("show"); }, 4200); }
function note(s, err){ var n = $("note"); n.textContent = s; n.className = "note" + (err ? " err" : ""); }

// consent gate (entry point) -> reveal lobby
$("agree").addEventListener("change", function(e){ $("continue").disabled = !e.target.checked; });
$("continue").addEventListener("click", function(){ $("consent").style.display = "none"; $("lobby").style.display = "flex"; });

if(!slug){ $("join").disabled = true; note("This meeting link looks invalid.", true); }
if(!PUB){ $("join").disabled = true; note("Meeting not configured yet.", true); }

try { vapi = new Vapi(PUB); } catch(e){ note("Could not load the meeting: " + e, true); }

if(vapi){
  vapi.on("call-start", function(){
    $("lobby").style.display = "none";
    $("meeting").style.display = "flex";
    started = Date.now();
    tick = setInterval(function(){
      var s = Math.floor((Date.now()-started)/1000);
      $("timer").textContent = Math.floor(s/60) + ":" + ("0"+(s%60)).slice(-2);
    }, 1000);
    setTimeout(function(){ toast("The host has video off for this meeting, so everyone's camera stays off."); }, 700);
  });
  vapi.on("speech-start", function(){ $("hostTile").classList.add("speaking"); });
  vapi.on("speech-end", function(){ $("hostTile").classList.remove("speaking"); });
  vapi.on("call-end", function(){
    if(tick) clearInterval(tick);
    $("timer").textContent = "Call ended";
    $("hostTile").classList.remove("speaking");
    toast("The meeting has ended. You can close this window.");
  });
  vapi.on("message", function(m){
    if(m && m.type === "transcript" && m.transcriptType === "final" && m.transcript){
      $("caption").style.display = "block";
      $("captionText").textContent = m.transcript;
    }
  });
  vapi.on("error", function(e){ toast("Call error: " + (e && e.message ? e.message : "see console")); });
}

$("join").addEventListener("click", function(){
  $("join").disabled = true; note("Connecting\\u2026");
  fetch("/api/join?slug=" + encodeURIComponent(slug))
    .then(function(r){ return r.json(); })
    .then(function(j){
      if(j.error){ note("Could not start: " + j.error, true); $("join").disabled = false; return; }
      var arch = j.archetype || "universal";
      return vapi.start(ASST, { metadata: { archetype: arch, slug: slug } })
        .then(function(call){
          var id = call && (call.id || call.callId);
          if(id){ fetch("/api/join?slug=" + encodeURIComponent(slug) + "&call_id=" + encodeURIComponent(id), { method:"POST" }).catch(function(){}); }
        });
    })
    .catch(function(e){ note("Could not connect: " + e, true); $("join").disabled = false; });
});

$("muteCtrl").addEventListener("click", function(){
  if(!vapi) return;
  muted = !muted; vapi.setMuted(muted);
  $("muteLbl").textContent = muted ? "Unmute" : "Mute";
  $("youMic").innerHTML = muted ? ${JSON.stringify(micoff_svg())} : ${JSON.stringify(micon_svg())};
});
$("camCtrl").addEventListener("click", function(){ toast("The host has turned video off for this meeting."); });
$("partCtrl").addEventListener("click", function(){ toast("In this meeting: the host and you."); });
$("leaveCtrl").addEventListener("click", function(){ if(vapi) vapi.stop(); });
</script>`;
}

// --- inline icons (kept tiny) ---
function micon_svg(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>'; }
function micoff_svg(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18M9 9v2a3 3 0 0 0 4.5 2.6M15 11V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11 5.4M12 18v3"/></svg>'; }
function cam_off_svg(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3l18 18M10 6h6a2 2 0 0 1 2 2v3l3-2v8M16 16H6a2 2 0 0 1-2-2V8"/></svg>'; }
function people_svg(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 5a3 3 0 0 1 0 6M21 20a6 6 0 0 0-3.5-5.5"/></svg>'; }
function leave_svg(){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5M16 17l5-5-5-5M21 12H9"/></svg>'; }
function lock_svg(){ return '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'; }

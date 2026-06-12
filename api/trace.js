// SpamViking — Posture Engine: GEAR TRACE (read-only ops view)
// ----------------------------------------------------------------------
// A page + tiny JSON API on the proxy itself, so the Supabase service key
// stays server-side and there's nothing extra to host. Reads gear_events
// and renders the three gears + slip as a per-turn track you can actually
// watch — the thing the Vapi log view buries one layer down.
//
//   GET /api/trace                     -> the page
//   GET /api/trace?data=calls          -> recent calls (JSON)
//   GET /api/trace?data=trace&call_id= -> one call's turns (JSON)
//
// Pure reads, separate endpoint — never on the call hot path.
// ----------------------------------------------------------------------

export const config = { runtime: "edge" };

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path) {
  const r = await fetch(SB_URL + "/rest/v1/" + path, {
    headers: { apikey: SB_KEY, authorization: "Bearer " + SB_KEY },
  });
  if (!r.ok) throw new Error("supabase " + r.status);
  return r.json();
}

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default async function handler(req) {
  const u = new URL(req.url);
  const data = u.searchParams.get("data");

  if (data) {
    if (!SB_URL || !SB_KEY) return jsonRes({ error: "store not configured" }, 500);
    try {
      if (data === "calls") {
        const rows = await sb(
          "gear_events?select=call_id,ts,turn&order=ts.desc&limit=3000"
        );
        const m = new Map();
        for (const r of rows) {
          const e = m.get(r.call_id) || { call_id: r.call_id, last: r.ts, turns: 0 };
          if ((r.turn || 0) > e.turns) e.turns = r.turn || 0;
          if (r.ts > e.last) e.last = r.ts;
          m.set(r.call_id, e);
        }
        const calls = Array.from(m.values())
          .sort((a, b) => (a.last < b.last ? 1 : -1))
          .slice(0, 60);
        return jsonRes({ calls });
      }
      if (data === "trace") {
        const callId = u.searchParams.get("call_id");
        if (!callId) return jsonRes({ error: "call_id required" }, 400);
        const events = await sb(
          "gear_events?call_id=eq." +
            encodeURIComponent(callId) +
            "&select=turn,ts,suspicion,pressure,engagement,slip,utterance&order=turn.asc"
        );
        return jsonRes({ events });
      }
      return jsonRes({ error: "unknown data type" }, 400);
    } catch (e) {
      return jsonRes({ error: String(e) }, 500);
    }
  }

  return new Response(PAGE, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gear Trace — Posture Engine</title>
<style>
  :root{
    --bg:#14110d; --panel:#1d1812; --panel2:#241d15; --line:#3a3026;
    --ink:#efe7da; --muted:#a99b85; --faint:#7e7363;
    --alive:#4a8c5f; --slip:#d9a441; --gone:#c14a32;
    --calm:#4f7ea8; --push:#d9a441; --extr:#c14a32;
    --bored:#6b6457; --hook:#4a8c5f; --stun:#9b7bd4;
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:
      radial-gradient(1200px 500px at 70% -10%, #20180f 0%, transparent 60%),
      var(--bg);
    color:var(--ink);
    font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    min-height:100vh;
  }
  .wrap{max-width:1180px;margin:0 auto;padding:22px 20px 60px}
  header{display:flex;align-items:baseline;gap:18px;flex-wrap:wrap;
    border-bottom:1px solid var(--line);padding-bottom:16px}
  h1{font:600 27px/1 ui-serif,Georgia,"Times New Roman",serif;
    letter-spacing:.3px;margin:0}
  h1 .rune{color:var(--slip);margin-right:10px}
  .sub{color:var(--faint);font-size:12.5px;letter-spacing:.4px;text-transform:uppercase}
  .controls{margin-left:auto;display:flex;gap:10px;align-items:center}
  select,button{font:inherit;font-size:13px;color:var(--ink);
    background:var(--panel);border:1px solid var(--line);border-radius:7px;
    padding:7px 11px;cursor:pointer}
  select{max-width:260px}
  button:hover{border-color:var(--faint)}
  .live{display:flex;align-items:center;gap:7px;color:var(--muted);
    font-size:13px;user-select:none;cursor:pointer}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--faint)}
  .live.on .dot{background:var(--alive);box-shadow:0 0 0 0 rgba(74,140,95,.6);
    animation:pulse 1.8s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(74,140,95,.55)}
    70%{box-shadow:0 0 0 7px rgba(74,140,95,0)}100%{box-shadow:0 0 0 0 rgba(74,140,95,0)}}

  /* current stance */
  .eyebrow{font-size:11.5px;letter-spacing:1.5px;text-transform:uppercase;
    color:var(--faint);margin:26px 0 12px}
  .now{display:grid;grid-template-columns:repeat(3,1fr) auto;gap:12px;align-items:stretch}
  .tile{background:var(--panel);border:1px solid var(--line);border-radius:11px;
    padding:14px 16px;position:relative;overflow:hidden}
  .tile .k{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--faint)}
  .tile .v{font:600 23px/1.1 ui-serif,Georgia,serif;margin-top:7px;text-transform:capitalize}
  .tile .bar{position:absolute;left:0;bottom:0;height:4px;width:100%}
  .tile.slip{display:flex;flex-direction:column;justify-content:center;min-width:150px}
  .pips{display:flex;gap:5px;margin-top:9px}
  .pip{width:16px;height:16px;border-radius:4px;background:#2a2118;border:1px solid var(--line)}
  .pip.on{background:var(--slip);border-color:var(--slip)}
  .meta{color:var(--faint);font-size:12.5px;margin-top:9px}

  /* the track */
  .trackwrap{display:flex;border:1px solid var(--line);border-radius:11px;
    background:var(--panel);overflow:hidden}
  .labels{flex:0 0 auto;border-right:1px solid var(--line);background:var(--panel2)}
  .labels .row,.col .cell,.col .turn,.labels .turn{height:34px;display:flex;
    align-items:center}
  .labels .turn,.col .turn{height:26px;font-size:11px;color:var(--faint);justify-content:center}
  .labels .row{padding:0 14px;font-size:12px;color:var(--muted);letter-spacing:.5px;
    justify-content:flex-end;min-width:92px}
  .scroll{overflow-x:auto;display:flex;scroll-behavior:smooth}
  .col{flex:0 0 58px;border-right:1px solid #271f17;text-align:center}
  .col:hover{background:#241c14}
  .col.sel{background:#2c2114;box-shadow:inset 0 0 0 1px var(--slip)}
  .col .turn{cursor:pointer}
  .cell{justify-content:center;font-size:10px;letter-spacing:.3px;
    text-transform:uppercase;color:#0e0b08;font-weight:600;
    border-bottom:1px solid #271f17;cursor:pointer}
  .cell.empty{background:transparent;color:var(--faint)}
  .s-alive{background:var(--alive)} .s-slipping{background:var(--slip)} .s-foregone{background:var(--gone);color:#f0d8d0}
  .p-calm{background:var(--calm)} .p-pushing{background:var(--push)} .p-extracting{background:var(--extr);color:#f0d8d0}
  .e-bored{background:#6b6457;color:#e8e0d2} .e-hooked{background:var(--hook)} .e-stunned{background:var(--stun);color:#f1ebfb}
  .slipcell{height:34px;display:flex;align-items:flex-end;justify-content:center;
    padding-bottom:4px;border-bottom:1px solid #271f17}
  .slipbar{width:14px;background:var(--slip);border-radius:2px 2px 0 0;min-height:2px;
    position:relative}
  .slipbar span{position:absolute;top:-15px;left:50%;transform:translateX(-50%);
    font-size:10px;color:var(--muted)}
  .change{outline:2px solid #efe7da55;outline-offset:-2px}

  /* detail */
  .detail{margin-top:16px;background:var(--panel);border:1px solid var(--line);
    border-radius:11px;padding:16px 18px;min-height:64px}
  .detail .t{color:var(--faint);font-size:12px;letter-spacing:.5px;text-transform:uppercase}
  .detail .said{font:400 17px/1.45 ui-serif,Georgia,serif;margin-top:6px;color:var(--ink)}
  .detail .states{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
  .chip{font-size:11px;padding:3px 9px;border-radius:20px;border:1px solid var(--line);
    color:var(--muted);text-transform:capitalize}

  /* legend + empty */
  .legend{margin-top:24px;display:flex;gap:24px;flex-wrap:wrap;color:var(--faint);font-size:12px}
  .legend .grp{display:flex;gap:8px;align-items:center}
  .sw{width:12px;height:12px;border-radius:3px;display:inline-block}
  .empty{padding:50px 20px;text-align:center;color:var(--muted)}
  .empty b{color:var(--ink);font-weight:600}
  .err{color:var(--gone)}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1><span class="rune">&#5792;</span>Gear Trace</h1>
      <div class="sub">Posture Engine &middot; one host, holding the line</div>
    </div>
    <div class="controls">
      <select id="calls"><option>Loading calls&hellip;</option></select>
      <button id="refresh">Refresh</button>
      <div class="live" id="live"><span class="dot"></span> Live</div>
    </div>
  </header>

  <div id="body">
    <div class="empty">Choose a call to see its gears.</div>
  </div>
</div>

<script>
(function(){
  var callsSel = document.getElementById("calls");
  var refreshBtn = document.getElementById("refresh");
  var liveBtn = document.getElementById("live");
  var body = document.getElementById("body");
  var current = null, events = [], selected = null, live = false, timer = null;

  function esc(s){return (s||"").replace(/[&<>"]/g,function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}

  function ago(ts){
    if(!ts) return "";
    var d = (Date.now() - new Date(ts).getTime())/1000;
    if(d<60) return Math.round(d)+"s ago";
    if(d<3600) return Math.round(d/60)+"m ago";
    return Math.round(d/3600)+"h ago";
  }
  function shortId(id){ return id ? id.slice(0,8) : "(none)"; }

  function loadCalls(keep){
    fetch("?data=calls").then(function(r){return r.json();}).then(function(d){
      if(d.error){ body.innerHTML='<div class="empty err">Could not read calls: '+esc(d.error)+'</div>'; return; }
      var calls = d.calls||[];
      if(!calls.length){
        callsSel.innerHTML='<option>No calls yet</option>';
        body.innerHTML='<div class="empty"><b>No calls yet.</b><br>Place a call and the gears will appear here, turn by turn.</div>';
        return;
      }
      callsSel.innerHTML = calls.map(function(c){
        return '<option value="'+esc(c.call_id)+'">'+shortId(c.call_id)+
          ' &middot; '+c.turns+' turns &middot; '+ago(c.last)+'</option>';
      }).join("");
      if(keep && current){ callsSel.value = current; }
      else { current = calls[0].call_id; callsSel.value = current; }
      loadTrace();
    }).catch(function(e){
      body.innerHTML='<div class="empty err">Network error reading calls.</div>';
    });
  }

  function loadTrace(){
    if(!current) return;
    fetch("?data=trace&call_id="+encodeURIComponent(current)).then(function(r){return r.json();})
    .then(function(d){
      if(d.error){ body.innerHTML='<div class="empty err">'+esc(d.error)+'</div>'; return; }
      events = d.events||[];
      render();
    });
  }

  function stateCell(prefix, val, prev){
    if(val==null) return '<div class="cell empty">&middot;</div>';
    var ab = val.length>5 ? val.slice(0,4) : val;
    var ch = (prev!=null && prev!==val) ? " change" : "";
    return '<div class="cell '+prefix+'-'+val+ch+'">'+ab+'</div>';
  }

  function render(){
    if(!events.length){ body.innerHTML='<div class="empty">No turns recorded for this call yet.</div>'; return; }
    var last = events[events.length-1];
    var maxSlip = Math.max(2, events.reduce(function(m,e){return Math.max(m,e.slip||0);},0));

    // current stance
    var pips = "";
    for(var i=0;i<Math.max(3,maxSlip);i++){ pips += '<div class="pip'+((last.slip||0)>i?" on":"")+'"></div>'; }
    var now =
      '<div class="eyebrow">Current stance &middot; turn '+last.turn+' &middot; '+ago(last.ts)+'</div>'+
      '<div class="now">'+
        tile("Suspicion", last.suspicion, "s") +
        tile("Pressure", last.pressure, "p") +
        tile("Engagement", last.engagement, "e") +
        '<div class="tile slip"><div class="k">Slip</div><div class="pips">'+pips+'</div>'+
          '<div class="meta">'+(last.slip||0)+' / flips at 2</div></div>'+
      '</div>';

    // the track
    var labels = '<div class="labels"><div class="turn">turn</div>'+
      '<div class="row">Suspicion</div><div class="row">Pressure</div>'+
      '<div class="row">Engagement</div><div class="row">Slip</div></div>';
    var cols = "";
    for(var j=0;j<events.length;j++){
      var e = events[j], pr = events[j-1] || {};
      var h = Math.max(2, Math.round((e.slip||0)/maxSlip*30));
      cols +=
        '<div class="col" data-i="'+j+'">'+
          '<div class="turn">'+e.turn+'</div>'+
          stateCell("s", e.suspicion, pr.suspicion)+
          stateCell("p", e.pressure, pr.pressure)+
          stateCell("e", e.engagement, pr.engagement)+
          '<div class="slipcell"><div class="slipbar" style="height:'+h+'px">'+
            '<span>'+(e.slip||0)+'</span></div></div>'+
        '</div>';
    }
    var track = '<div class="eyebrow">The track &middot; '+events.length+' turns &middot; left to right</div>'+
      '<div class="trackwrap">'+labels+'<div class="scroll" id="scroll">'+cols+'</div></div>';

    var legend =
      '<div class="legend">'+
        '<div class="grp"><span class="sw" style="background:var(--alive)"></span>alive / calm / hooked</div>'+
        '<div class="grp"><span class="sw" style="background:var(--slip)"></span>slipping / pushing</div>'+
        '<div class="grp"><span class="sw" style="background:var(--gone)"></span>foregone / extracting</div>'+
        '<div class="grp"><span class="sw" style="background:var(--stun)"></span>stunned (winning)</div>'+
        '<div class="grp"><span class="sw" style="background:#6b6457"></span>bored</div>'+
        '<div class="grp">white edge = a gear changed this turn</div>'+
      '</div>';

    body.innerHTML = now + track +
      '<div class="detail" id="detail"><div class="t">Pick a turn</div>'+
      '<div class="said">Tap any column to read what the caller said.</div></div>' + legend;

    // wire selection
    var scroll = document.getElementById("scroll");
    scroll.querySelectorAll(".col").forEach(function(col){
      col.addEventListener("click", function(){ selectTurn(parseInt(col.dataset.i,10)); });
    });
    scroll.scrollLeft = scroll.scrollWidth; // newest in view
    if(selected!=null && selected<events.length) markSel();
  }

  function tile(k, val, p){
    var v = val || "—";
    return '<div class="tile"><div class="k">'+k+'</div><div class="v">'+v+'</div>'+
      '<div class="bar '+p+'-'+(val||"")+'"></div></div>';
  }

  function selectTurn(i){
    selected = i; markSel();
    var e = events[i];
    var det = document.getElementById("detail");
    det.innerHTML =
      '<div class="t">Turn '+e.turn+' &middot; '+ago(e.ts)+'</div>'+
      '<div class="said">&ldquo;'+(esc(e.utterance)||"<em>(no transcript)</em>")+'&rdquo;</div>'+
      '<div class="states">'+
        '<span class="chip">suspicion: '+esc(e.suspicion)+'</span>'+
        '<span class="chip">pressure: '+esc(e.pressure)+'</span>'+
        '<span class="chip">engagement: '+esc(e.engagement)+'</span>'+
        '<span class="chip">slip: '+(e.slip||0)+'</span>'+
      '</div>';
  }
  function markSel(){
    var cols = document.querySelectorAll(".col");
    cols.forEach(function(c){ c.classList.remove("sel"); });
    if(cols[selected]) cols[selected].classList.add("sel");
  }

  function setLive(on){
    live = on; liveBtn.classList.toggle("on", on);
    if(timer){ clearInterval(timer); timer=null; }
    if(on){ timer = setInterval(function(){ loadTrace(); loadCalls(true); }, 4000); }
  }

  callsSel.addEventListener("change", function(){ current = callsSel.value; selected=null; loadTrace(); });
  refreshBtn.addEventListener("click", function(){ loadCalls(true); });
  liveBtn.addEventListener("click", function(){ setLive(!live); });

  loadCalls(false);
})();
</script>
</body>
</html>`;

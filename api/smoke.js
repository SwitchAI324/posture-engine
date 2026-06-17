// SpamViking — Posture Engine: SMOKE-TEST page (browser-only mint button).
// ----------------------------------------------------------------------
// A no-command-line way to fire POST /api/join from a browser. Typing the
// /api/join URL in the address bar sends a GET (read-only by design, no mint),
// so this page does the POST for you on a button click and shows the result —
// the archetype it read off the token and the vapi_call_id it minted, plus the
// raw Vapi response so we can see how the call can be joined.
//
//   open  /api/smoke   ->   type slug   ->   click Mint
//
// Test artifact — delete api/smoke.js when the smoke-test is done.
// ----------------------------------------------------------------------

export const config = { runtime: "edge" };

export default async function handler() {
  return new Response(PAGE, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const PAGE = `<!doctype html><meta charset="utf-8">
<title>Carrier smoke-test</title>
<style>
  body{background:#14110d;color:#efe7da;font:15px/1.55 ui-sans-serif,system-ui,sans-serif;max-width:760px;margin:36px auto;padding:0 18px}
  h1{font:600 24px/1 ui-serif,Georgia,serif}
  .meta{color:#a99b85;font-size:13px}
  label{display:block;color:#a99b85;font-size:12px;letter-spacing:.5px;text-transform:uppercase;margin:18px 0 6px}
  input{width:100%;font:15px ui-monospace,monospace;color:#efe7da;background:#1d1812;border:1px solid #3a3026;border-radius:8px;padding:11px 13px;box-sizing:border-box}
  button{margin-top:16px;font:600 15px ui-sans-serif,system-ui;color:#1a140a;background:#d9a441;border:0;border-radius:9px;padding:12px 20px;cursor:pointer}
  button:disabled{opacity:.5;cursor:wait}
  .out{margin-top:22px;display:none}
  .verdict{font:700 18px/1.3 ui-serif,Georgia,serif;padding:13px 16px;border-radius:10px;margin-bottom:14px}
  .ok{background:#1c2a1e;color:#7fd6a0;border:1px solid #2f5d3f}
  .bad{background:#2a1715;color:#e09080;border:1px solid #6b2f24}
  .kv{margin:4px 0}.kv b{color:#a99b85;font-weight:600;display:inline-block;min-width:130px}
  .gold{color:#d9a441;font-weight:700}
  pre{background:#1d1812;border:1px solid #3a3026;border-radius:8px;padding:12px;overflow:auto;font-size:12.5px;color:#cfc4b0;max-height:340px}
  a{color:#7fb0e0}
</style>
<h1>Carrier smoke-test</h1>
<p class="meta">Clicking Mint sends <code>POST /api/join?slug=…</code> — it reads the booking token,
mints a Vapi call stamped with the archetype, and writes the call id back. This mints a <b>real</b> Vapi call
(re-clicking the same slug reuses it).</p>

<label for="slug">Token slug</label>
<input id="slug" value="smoke-test-001">
<button id="go">Mint call</button>

<div class="out" id="out"></div>

<script>
document.getElementById("go").addEventListener("click", function(){
  var slug = document.getElementById("slug").value.trim();
  var out = document.getElementById("out");
  var btn = document.getElementById("go");
  btn.disabled = true; btn.textContent = "Minting…";
  out.style.display = "block";
  out.innerHTML = '<p class="meta">Calling /api/join…</p>';
  fetch("/api/join?slug=" + encodeURIComponent(slug), { method: "POST" })
    .then(function(r){ return r.json().then(function(j){ return {status:r.status, j:j}; }); })
    .then(function(res){
      var j = res.j || {};
      var good = res.status === 200 && (j.vapi_call_id || j.reused);
      var arch = j.archetype || "(none)";
      var archGood = arch === "crypto_investment";
      // hunt the Vapi response for anything that looks like a join URL
      var url = null, v = j.vapi || {};
      ["webCallUrl","url","monitorUrl","callUrl","joinUrl"].forEach(function(k){ if(!url && v[k]) url = v[k]; });
      var html = '<div class="verdict ' + (good?"ok":"bad") + '">' +
        (good ? "&#10003; Minted (HTTP "+res.status+")" : "&#10007; Failed (HTTP "+res.status+")") + '</div>';
      html += '<div class="kv"><b>archetype read</b> <span class="' + (archGood?"gold":"") + '">' + arch + '</span>' +
        (archGood ? "  &#10003; token carried it" : "  — expected crypto_investment") + '</div>';
      html += '<div class="kv"><b>vapi_call_id</b> ' + (j.vapi_call_id || "(none)") + (j.reused?"  (reused)":"") + '</div>';
      if(url) html += '<div class="kv"><b>join link</b> <a href="' + url + '" target="_blank">' + url + '</a></div>';
      html += '<div class="kv"><b>raw response</b></div><pre>' + JSON.stringify(j, null, 2).replace(/</g,"&lt;") + '</pre>';
      if(!url && good) html += '<p class="meta">No obvious join URL in the response — paste the raw block above to PE and we\\'ll find how this call type is joined.</p>';
      out.innerHTML = html;
    })
    .catch(function(e){
      out.innerHTML = '<div class="verdict bad">&#10007; Request error</div><pre>' + String(e) + '</pre>';
    })
    .finally(function(){ btn.disabled = false; btn.textContent = "Mint call"; });
});
</script>`;

// api/saytest.js — STANDALONE de-risk probe for the control-channel say.exact
// silence approach. CommonJS + node req/res, matching hydrate.js (the working
// endpoint style in this api/ folder). Self-contained: queries Supabase inline
// for the stored controlUrl, so it has NO cross-module import (the earlier
// crashes were an ESM import + wrong path; this avoids both).
//
// USAGE: while a call is LIVE, open in a browser:
//   https://posture-engine.vercel.app/api/saytest?slug=test-andy
// HEAR the line -> control channel works. Hear nothing -> read the JSON: it says
// whether the POST was egress-blocked, errored, or 200-but-silent.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  res.setHeader("content-type", "application/json");
  const send = (obj, status = 200) => { res.statusCode = status; return res.end(JSON.stringify(obj, null, 2)); };

  let slug, line;
  try {
    // Parse query params directly from req.url without the URL constructor —
    // on Vercel the URL ctor with a synthetic base can throw (ERR_INVALID_URL).
    // req.url looks like "/api/saytest?slug=test-andy". Also accept req.query
    // if the runtime already parsed it.
    const rawUrl = typeof req.url === "string" ? req.url : "";
    const qIndex = rawUrl.indexOf("?");
    const qs = qIndex >= 0 ? rawUrl.slice(qIndex + 1) : "";
    const params = new URLSearchParams(qs);
    slug = (req.query && req.query.slug) || params.get("slug");
    line = (req.query && req.query.line) || params.get("line") ||
      "Sorry — you still there? I think the line went quiet for a second.";
  } catch (e) {
    return send({ error: "param parse failed: " + String(e && e.message) }, 400);
  }

  if (!slug) return send({ error: "missing ?slug=" }, 400);
  if (!SUPABASE_URL || !SUPABASE_KEY) return send({ error: "supabase env not configured" }, 500);

  const out = { slug, line, steps: {} };

  // 1. Read the stored controlUrl for this call from the slug row (control_url
  //    column on the call_prefix table, written by completions.js on turn 1).
  let controlUrl = null;
  try {
    const q = SUPABASE_URL + "/rest/v1/call_prefix?call_id=eq." +
      encodeURIComponent("slug:" + slug) + "&select=control_url";
    const r = await fetch(q, {
      headers: { apikey: SUPABASE_KEY, authorization: "Bearer " + SUPABASE_KEY },
    });
    const rows = await r.json().catch(() => []);
    controlUrl = Array.isArray(rows) && rows[0] ? rows[0].control_url : null;
    out.steps.lookup = controlUrl ? "found controlUrl" : "NO control_url on slug row (rows=" + JSON.stringify(rows).slice(0,150) + ")";
  } catch (e) {
    return send({ result: "LOOKUP_FAILED", error: String(e && e.message), ...out });
  }

  if (!controlUrl) {
    return send({
      result: "NO_CONTROL_URL",
      hint: "Is a call live under this slug? control_url is written on turn 1. " +
            "If missing, completions.js slug-row write hasn't run, or wrong slug.",
      ...out,
    });
  }
  out.controlUrl = controlUrl;

  // 2. POST the say.exact line to the control URL (Voice's exact shape).
  try {
    const r = await fetch(controlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "say", content: line, endCallAfterSpoken: false }),
    });
    const text = await r.text().catch(() => "");
    out.steps.post = "status=" + r.status;
    out.responseBody = text.slice(0, 300);
    return send({ result: r.ok ? "POSTED_OK_did_you_hear_it" : "POST_NON_2XX", ...out });
  } catch (e) {
    out.steps.post = "FETCH FAILED: " + String(e && e.message);
    return send({
      result: "POST_FAILED_likely_egress_blocked",
      hint: "PE could not reach the Vapi control URL. Likely *.vapi.ai is not in " +
            "the egress allowlist — must be fixed before any control-channel build.",
      ...out,
    });
  }
};

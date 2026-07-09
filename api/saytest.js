// api/saytest.js — STANDALONE de-risk probe for the control-channel say.exact
// silence approach (Voice's Item-1 fix). NOT the silence feature; a throwaway
// test to answer two unknowns cheaply BEFORE the full build:
//   (1) can PE reach the Vapi control URL at all (egress allowlist)?
//   (2) does a say.exact POST actually voice a line mid-call?
//
// USAGE: while a call is LIVE, open in a browser:
//   https://posture-engine.vercel.app/api/saytest?slug=test-andy
// HEAR the line -> control channel works, build the full thing.
// Hear nothing -> read the JSON: it says whether the POST was egress-blocked,
// errored, or returned 200-but-silent. Surfaces the unknown for ~30 lines.

import { getCallBySlug } from "./_store.js";

export default async function handler(req) {
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");
  const line =
    url.searchParams.get("line") ||
    "Sorry — you still there? I think the line went quiet for a second.";

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj, null, 2), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (!slug) return json({ error: "missing ?slug=" }, 400);

  const out = { slug, line, steps: {} };

  // 1. Look up the stored controlUrl (written to the slug row by completions.js).
  let controlUrl = null;
  try {
    const stored = await getCallBySlug(slug);
    controlUrl = stored && stored.controlUrl ? stored.controlUrl : null;
    out.steps.lookup = controlUrl ? "found controlUrl" : "NO controlUrl on slug row";
  } catch (e) {
    out.steps.lookup = "lookup error: " + (e && e.message ? e.message : String(e));
  }

  if (!controlUrl) {
    return json({
      result: "NO_CONTROL_URL",
      hint: "Is a call live under this slug? controlUrl is written on turn 1 of " +
            "the call. If missing, the completions.js slug-row write hasn't run.",
      ...out,
    });
  }
  out.controlUrl = controlUrl;

  // 2. POST the say.exact line to the control URL (Voice's exact shape).
  const payload = { type: "say", content: line, endCallAfterSpoken: false };
  try {
    const r = await fetch(controlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await r.text().catch(() => "");
    out.steps.post = "status=" + r.status;
    out.responseBody = text.slice(0, 300);
    return json({
      result: r.ok ? "POSTED_OK_did_you_hear_it" : "POST_NON_2XX",
      ...out,
    });
  } catch (e) {
    out.steps.post = "FETCH FAILED: " + (e && e.message ? e.message : String(e));
    return json({
      result: "POST_FAILED_likely_egress_blocked",
      hint: "PE could not reach the Vapi control URL. Likely *.vapi.ai is not in " +
            "the egress allowlist — that must be fixed before any control-channel " +
            "silence build can work.",
      ...out,
    });
  }
}

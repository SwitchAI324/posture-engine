// api/recording-link.js
// ----------------------------------------------------------------------
// GET /api/recording-link?slug=<slug>
// Reads the `recordings` row for the given slug, checks auth, generates
// a 7-day signed URL from recording_url via Supabase's storage API
// (service role), and returns { url, expires_at }.
//
// 404 if no row exists, or the row exists but status != 'ready' (an
// in-progress or failed recording has nothing to serve — same 404 for
// both, don't leak which case it is).
//
// AUTH — two modes, per Recording's spec:
//   1. Server-to-server: x-phone-intake-secret header, reusing the exact
//      pattern already live in phone-intake.js/phone-cancel.js
//      (PHONE_INTAKE_SECRET). Used by Barbara/Phone Intake.
//   2. User session, for Mead Hall: require the session's user to match
//      recordings.user_id.
//
// ⚠ MODE 2 IS NOT IMPLEMENTED — flagged honestly, not silently guessed.
// Every session/token mechanism I've seen anywhere in this codebase
// (call-stream.js's director/watcher tokens) is scoped by target_id, not
// user_id — it has no concept of "which SpamViking user is logged in"
// at all, so it can't be reused for an ownership check against
// recordings.user_id. I don't have visibility into whatever the real
// end-user login/session system is (a Supabase Auth JWT cookie? A
// separate session table? Something else?), and building against a
// guess here would mean shipping an ownership check that either always
// fails (safe but useless) or — worse — could be trivially wrong in a
// way that looks like it works. verifyUserSession() below is a clearly
// marked stub that always returns null (no session) until someone
// confirms the real mechanism and fills it in. Mode 1 (server-to-server)
// is fully real and working; that's most of what this route needs today
// given only Phone Intake/Barbara are consuming it so far.
// ----------------------------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PHONE_INTAKE_SECRET = process.env.PHONE_INTAKE_SECRET;
const SIGNED_URL_EXPIRES_SECONDS = 7 * 24 * 60 * 60; // 7 days
const BUCKET = "recordings"; // ⚠ inferred to match the table name — not
                              // independently confirmed as the actual
                              // Supabase storage bucket name.

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase ${path} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// STUB — see file header. Always returns null (no authenticated session)
// until the real mechanism is confirmed and this is filled in for real.
async function verifyUserSession(req) {
  return null; // { userId } when implemented
}

async function generateSignedUrl(objectPath) {
  const r = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${objectPath}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_EXPIRES_SECONDS }),
    }
  );
  if (!r.ok) {
    throw new Error(`storage sign failed ${r.status}: ${await r.text()}`);
  }
  const data = await r.json();
  // Supabase returns a RELATIVE path (/object/sign/{bucket}/{path}?token=...)
  // — must be prefixed with the project URL to be directly usable.
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "GET only" }));
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "store not configured" }));
  }

  const url = new URL(req.url, "http://x");
  const slug = url.searchParams.get("slug");
  if (!slug) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "slug required" }));
  }

  // AUTH — try server-to-server first (the only mode that's real today),
  // then user-session (currently always fails — see file header).
  const providedSecret = req.headers["x-phone-intake-secret"];
  const isServerToServer =
    !!PHONE_INTAKE_SECRET && providedSecret === PHONE_INTAKE_SECRET;

  let authedUserId = null;
  if (!isServerToServer) {
    const session = await verifyUserSession(req);
    if (session) authedUserId = session.userId;
  }

  if (!isServerToServer && !authedUserId) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }

  let rows;
  try {
    rows = await sb(
      `recordings?slug=eq.${encodeURIComponent(slug)}&select=recording_url,user_id,status&limit=1`
    );
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
  }

  const row = rows && rows[0];
  if (!row || row.status !== "ready") {
    // Same 404 whether the row is missing entirely or just not ready
    // yet — don't leak which case it is.
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "not found" }));
  }

  // Ownership check — only meaningful once mode 2 is real. isServerToServer
  // bypasses this (Barbara/Phone Intake act on behalf of the system, not
  // a specific browsing user).
  if (!isServerToServer && authedUserId !== row.user_id) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ error: "unauthorized" }));
  }

  if (!row.recording_url) {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "not found" }));
  }

  try {
    const url_ = await generateSignedUrl(row.recording_url);
    const expiresAt = new Date(Date.now() + SIGNED_URL_EXPIRES_SECONDS * 1000).toISOString();
    res.setHeader("Content-Type", "application/json");
    res.statusCode = 200;
    return res.end(JSON.stringify({ url: url_, expires_at: expiresAt }));
  } catch (e) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
  }
};

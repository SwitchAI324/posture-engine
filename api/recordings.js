// api/recordings.js
// ----------------------------------------------------------------------
// GET /api/recordings?token=<jwt>   (or Authorization: Bearer <jwt>)
// The recordings-page endpoint (2026-10-06, Recording / Data / Mead Hall).
//
//  - Token: HS256 JWT, payload {user_id, exp}, secret RECORDING_TOKEN_SECRET
//    (see _recording_token.js). 401 on anything wrong, with no detail.
//  - Rows come from public.recordings_for_user(p_user_id) (Data,
//    SECURITY DEFINER, service_role only). The function TRUSTS its argument,
//    so p_user_id is taken ONLY from inside the verified token — no query
//    param, header or body value can ever reach it.
//  - For rows with purged_at null a short-lived signed URL is produced from
//    recording_url with the shared tolerant key helper (_recording_key.js),
//    which also handles older display-style / malformed values.
//  - Displayed channel is derived from the slug prefix (ph- / in- / sv-),
//    NOT the channel column (inbound rows can report phone or web there).
//  - The raw recording_url / storage path is never returned.
// ----------------------------------------------------------------------
const { objectKeyFromRecordingUrl, signObjectKey } = require("./_recording_key.js");
const { verify } = require("./_recording_token.js");

const PLAY_URL_SECONDS = 60 * 60; // short-lived: 1 hour
const MAX_ROWS = 500;

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.end(JSON.stringify(obj));
}

// Display channel from the slug prefix. ph- = outbound callback phone call,
// in- = inbound phone call, anything else (sv-… / web slugs) = web.
function channelFromSlug(slug) {
  const s = String(slug || "");
  if (s.startsWith("ph-")) return "phone";
  if (s.startsWith("in-")) return "inbound";
  return "web";
}

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "authorization");
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return send(res, 405, { error: "GET only" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SECRET = process.env.RECORDING_TOKEN_SECRET;
  if (!SUPABASE_URL || !SUPABASE_KEY || !SECRET) {
    return send(res, 500, { error: "not configured" });
  }

  const url = new URL(req.url, "http://x");
  let token = url.searchParams.get("token");
  if (!token) {
    const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
    if (/^Bearer /i.test(auth)) token = auth.slice(7).trim();
  }
  const claims = verify(token, SECRET);
  if (!claims) return send(res, 401, { error: "unauthorized" });
  const userId = claims.user_id; // ONLY source of the id handed to the function

  let rows;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/recordings_for_user`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user_id: userId }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`rpc ${r.status}: ${text.slice(0, 300)}`);
    rows = text ? JSON.parse(text) : [];
  } catch (e) {
    console.error("recordings: rpc failed err=" + String(e && e.message ? e.message : e));
    return send(res, 500, { error: "could not load recordings" });
  }
  if (!Array.isArray(rows)) rows = [];
  rows = rows.slice(0, MAX_ROWS);

  const recordings = await Promise.all(
    rows.map(async (row) => {
      const purged = !!row.purged_at;
      let playUrl = null;
      let playError = null;
      if (!purged && row.playable !== false) {
        const key = objectKeyFromRecordingUrl(row.recording_url);
        if (key) {
          try {
            playUrl = await signObjectKey(key, PLAY_URL_SECONDS);
          } catch (e) {
            playError = "sign_failed";
            console.error("recordings: sign failed slug=" + row.slug + " key=" + key + " err=" + String(e && e.message ? e.message : e));
          }
        } else {
          playError = "no_recording";
        }
      }
      return {
        slug: row.slug,
        channel: channelFromSlug(row.slug),
        started_at: row.started_at,
        host_name: row.host_name,
        number: row.number,
        claimed_org: row.claimed_org,
        outcome: row.outcome,
        duration_seconds: row.duration_seconds,
        target_email: row.target_email,
        job_id: row.job_id,
        playable: !!playUrl,
        play_url: playUrl,
        play_error: playError,
        purged,
        purged_at: row.purged_at || null,
        clip_flag: !!row.clip_flag,
      };
    })
  );

  return send(res, 200, {
    ok: true,
    generated_at: new Date().toISOString(),
    play_url_expires_in_seconds: PLAY_URL_SECONDS,
    count: recordings.length,
    recordings,
  });
};

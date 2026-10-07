// api/_recording_key.js
// ----------------------------------------------------------------------
// Shared by /api/recording-link and /api/recordings (2026-10-06, Recording).
// Underscore prefix = not routed by Vercel (same pattern as _store.js).
//
// Object key inside the "recordings" bucket = the FILE NAME at the end of
// recordings.recording_url. recording_url may be a bare key
// ("ph-<id>.mp3"), a bucket-prefixed key, the full storage URL, or an older
// display-style / malformed value — never rebuild the key from the slug plus
// a guessed extension (.mp3 now, older files are .ogg). Returns null when
// there is nothing usable.
// ----------------------------------------------------------------------

const BUCKET = "recordings";

function objectKeyFromRecordingUrl(u) {
  if (!u) return null;
  let p = String(u);
  try { p = new URL(p).pathname; } catch { p = p.split("?")[0]; }
  try { p = decodeURIComponent(p); } catch { /* keep as-is */ }
  const name = p.replace(/\/+$/, "").split("/").pop();
  return name || null;
}

// Signs one object in the recordings bucket (service role). Returns a full
// URL, or throws with the storage error text.
async function signObjectKey(objectKey, expiresInSeconds) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${encodeURIComponent(objectKey)}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: expiresInSeconds }),
    }
  );
  if (!r.ok) throw new Error(`storage sign failed ${r.status}: ${await r.text()}`);
  const data = await r.json();
  // Supabase returns a RELATIVE path (/object/sign/{bucket}/{path}?token=...)
  return `${SUPABASE_URL}/storage/v1${data.signedURL}`;
}

module.exports = { BUCKET, objectKeyFromRecordingUrl, signObjectKey };

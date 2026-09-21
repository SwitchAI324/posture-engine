// api/cron/purge-recordings.js
// ----------------------------------------------------------------------
// Vercel Cron target (daily). Not called by any other PE code or by any
// other chat's endpoint — Vercel's own scheduler hits this on the cron
// schedule set in vercel.json (Andrew still needs to add that entry;
// this file alone does nothing until it's wired up).
//
// SOURCE OF TRUTH FOR "WHAT TO PURGE": the recordings_pending_purge view
// (Data — already built, confirmed live). This endpoint does not
// reimplement the retention_expires_at/clip_flag/status filter logic;
// it just reads whatever the view currently says is due, so the purge
// criteria stay defined in exactly one place (the view), not duplicated
// here and liable to drift. View is filtered to purged_at IS NULL
// already (Recording, 2026-09-20) and exposes slug + channel + id.
//
// STORAGE KEY: recordings/<slug>.ogg, universally — same extension and
// same path shape for both web and phone rows (Recording confirmed
// against real bucket contents, both channels, 2026-09-20). No
// per-channel branching needed despite the view exposing `channel`.
//
// ORDER: storage delete FIRST, then the DB update (purged_at=now(),
// recording_url=null). This is Recording's own explicit ordering
// (2026-09-20): a mid-run failure should leave an orphan ROW (still
// pointing at a file that's actually already gone, or not attempted
// yet) rather than an orphan FILE with no row pointing at it — a
// dangling row is visible and re-attempted on the next run; a dangling
// file with no row is invisible and never gets cleaned up.
//
// KEEP-ROW, NOT DELETE-ROW: Recording's design (locked, superseding an
// earlier "delete the row" draft), because transcripts/clip history
// reference recordings rows and losing the row loses the record that
// the call happened. So this only ever UPDATEs, never DELETEs a
// `recordings` row.
//
// AUTH: Vercel Cron invocations carry `Authorization: Bearer
// $CRON_SECRET` when CRON_SECRET is set as a project env var (Vercel's
// own documented pattern for verifying a request actually came from
// their scheduler, not an open public GET). Enforced here; set
// CRON_SECRET in the Vercel dashboard once this ships.
//
// BEST-EFFORT PER ROW: one row's storage-delete or DB-update failure
// does not stop the run — it's logged and the run continues to the next
// row, so one bad row can't block every other row's purge that day. The
// endpoint always returns 200 with a summary; a real infra failure
// (missing env, view unreachable) is the only thing that 500s.
// ----------------------------------------------------------------------

const SB = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const BUCKET = "recordings";

async function sbRest(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: opts.prefer || "return=representation",
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`supabase rest ${path} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// Supabase Storage's remove endpoint: POST /storage/v1/object/remove
// with { prefixes: [...] } — plural even for one object.
async function storageRemove(objectKey) {
  const r = await fetch(`${SB}/storage/v1/object/remove`, {
    method: "POST",
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefixes: [`${BUCKET}/${objectKey}`] }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`storage remove ${objectKey} ${r.status}: ${text}`);
  return true;
}

export default async function handler(req, res) {
  if (!SB || !SB_KEY) {
    return res.status(500).json({ ok: false, error: "store not configured" });
  }
  if (CRON_SECRET) {
    const auth = req.headers["authorization"] || "";
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: "bad cron secret" });
    }
  }

  let rows;
  try {
    rows = await sbRest(
      "recordings_pending_purge?select=id,slug,channel",
      { method: "GET" }
    );
  } catch (e) {
    console.error("purge-recordings: view read failed", e);
    return res.status(500).json({ ok: false, error: String(e && e.message ? e.message : e) });
  }

  if (!Array.isArray(rows) || !rows.length) {
    return res.status(200).json({ ok: true, purged: 0, failed: 0, results: [] });
  }

  const results = [];
  for (const row of rows) {
    const { id, slug, channel } = row || {};
    if (!id || !slug) {
      results.push({ id: id || null, ok: false, error: "row missing id or slug" });
      continue;
    }
    const objectKey = `${slug}.ogg`;
    try {
      await storageRemove(objectKey);
      await sbRest(`recordings?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify({ purged_at: new Date().toISOString(), recording_url: null }),
      });
      results.push({ id, slug, channel, ok: true });
    } catch (e) {
      console.error(`purge-recordings: row ${id} (${slug}) failed`, e);
      results.push({ id, slug, channel, ok: false, error: String(e && e.message ? e.message : e) });
    }
  }

  const purged = results.filter((r) => r.ok).length;
  const failed = results.length - purged;
  console.log(`purge-recordings: ${purged} purged, ${failed} failed, ${results.length} total`);

  return res.status(200).json({ ok: true, purged, failed, results });
}

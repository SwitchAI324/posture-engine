// api/call-feed.js
// Mead Hall live reader. Server-side ONLY — holds the service-role key.
// engagement_events is RLS-locked: a browser/anon read returns nothing,
// so the browser polls THIS endpoint, never Supabase directly.
//
// Two modes (Data confirmed both query patterns indexed):
//   live poll : GET ?call_id=<vapi_id>&after_seq=<cursor>
//               -> where call_id = :c and seq > :cursor order by seq
//   arc/stream: GET ?target_id=<uuid>&after_seq=<cursor>
//               -> where target_id = :t and seq > :cursor order by seq
//               (omit after_seq for the whole arc; with it, streams the
//                email -> booking -> call timeline incrementally)
//
// Real columns (Data-confirmed): id, target_id, seq, ts, call_id,
//   event_type, actor, layer, channel, thread_id, message_id,
//   idem_key, payload, created_at.   (NOT event_id / type / source.)
//
// Env (server-side, never shipped to the browser):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Only the columns the Director's View renders. seq drives ordering and
// the client cursor; payload carries the per-event fields (§1/§4).
const SELECT =
  "id,seq,ts,call_id,target_id,event_type,actor,layer,payload";

const MAX_ROWS = 500; // generous; a single call won't approach this

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return res
      .status(500)
      .json({ error: "server_misconfigured", detail: "missing supabase env" });
  }

  const { call_id, target_id, after_seq } = req.query;

  if (!call_id && !target_id) {
    return res
      .status(400)
      .json({ error: "bad_request", detail: "need call_id or target_id" });
  }

  // Build the PostgREST query for whichever mode we're in.
  const params = new URLSearchParams();
  params.set("select", SELECT);
  params.set("order", "seq.asc");
  params.set("limit", String(MAX_ROWS));

  if (call_id) {
    // live poll: one call, rows past the cursor
    params.set("call_id", `eq.${call_id}`);
    const cursor = Number.parseInt(after_seq, 10);
    if (Number.isFinite(cursor) && cursor >= 0) {
      params.set("seq", `gt.${cursor}`);
    }
  } else {
    // arc + live stream: the target's history, incrementally past the cursor.
    // With after_seq this streams email -> booking -> call on one target_id;
    // without it (after_seq absent/0) it returns the whole arc so far.
    params.set("target_id", `eq.${target_id}`);
    const cursor = Number.parseInt(after_seq, 10);
    if (Number.isFinite(cursor) && cursor >= 0) {
      params.set("seq", `gt.${cursor}`);
    }
  }

  const url = `${SUPABASE_URL}/rest/v1/engagement_events?${params.toString()}`;

  try {
    const r = await fetch(url, {
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Accept: "application/json",
      },
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return res
        .status(502)
        .json({ error: "upstream", status: r.status, detail: body.slice(0, 500) });
    }

    const rows = await r.json();
    const events = Array.isArray(rows) ? rows : [];
    // cursor = highest seq returned, so the client resumes cleanly.
    const cursor = events.length ? events[events.length - 1].seq : (after_seq ?? null);

    // Don't let intermediaries cache a live feed.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ events, cursor });
  } catch (err) {
    return res
      .status(502)
      .json({ error: "fetch_failed", detail: String(err).slice(0, 500) });
  }
}

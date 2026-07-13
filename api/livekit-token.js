// api/livekit-token.js — mint a LiveKit access token for a browser caller.
// CommonJS + node req/res, matching hydrate.js / saytest.js (the working style
// in this api/ folder).
//
// WHY THIS EXISTS: the browser can't mint its own LiveKit token (needs the API
// secret). meeting.js calls this at call start with the slug; we sign a token
// whose ROOM METADATA carries the slug, so agent.py's entrypoint() can read it
// and hydrate the host prompt before session.start().
//
// ENV NEEDED (Vercel): LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL (wss://).
//
// USAGE (from meeting.js): GET /api/livekit-token?slug=<slug>&identity=<who>
//   -> { token, url, room }
// The room name is derived from the slug so each caller gets their own room and
// the agent auto-dispatches into it.

const {
  AccessToken,
  RoomConfiguration,
  RoomAgentDispatch,
} = require("livekit-server-sdk");

// The agent uses agent_name="spamviking", which makes it EXPLICIT-DISPATCH only
// (it no longer auto-joins rooms). LiveKit's Console dispatches it for you, which
// is why console tests worked — but a real caller's room got no agent. So the
// token must carry a dispatch request for this agent name.
const AGENT_NAME = process.env.LIVEKIT_AGENT_NAME || "spamviking";

const LK_KEY = process.env.LIVEKIT_API_KEY;
const LK_SECRET = process.env.LIVEKIT_API_SECRET;
const LK_URL = process.env.LIVEKIT_URL; // wss://your-project.livekit.cloud

module.exports = async function handler(req, res) {
  res.setHeader("content-type", "application/json");
  const send = (obj, status = 200) => {
    res.statusCode = status;
    return res.end(JSON.stringify(obj));
  };

  try {
    if (!LK_KEY || !LK_SECRET || !LK_URL) {
      return send({ error: "LiveKit env not configured" }, 500);
    }

    // slug from query (?slug=) or POST body { slug }.
    let slug = null, identity = null, hostName = null;
    const url = new URL(req.url, "http://x");
    slug = url.searchParams.get("slug");
    identity = url.searchParams.get("identity");
    hostName = url.searchParams.get("host_name");
    if (!slug && req.method === "POST") {
      let body = "";
      await new Promise((r) => { req.on("data", (c) => (body += c)); req.on("end", r); });
      try {
        const j = JSON.parse(body || "{}");
        slug = slug || j.slug;
        identity = identity || j.identity;
        hostName = hostName || j.host_name;
      } catch { /* ignore */ }
    }
    if (!slug) return send({ error: "missing slug" }, 400);

    // Unique room per SESSION (not per slug). Dispatch-via-token only fires when
    // the room is first CREATED — reusing a slug-derived name (e.g. always
    // "sv-test-andy") means the 2nd+ attempt hits an existing room and the agent
    // is NOT re-dispatched. A random suffix guarantees a fresh room each call, so
    // the agent dispatch always fires. The slug still travels via participant
    // metadata, so identity is unaffected by the room name being unique.
    const room = "sv-" + String(slug).replace(/[^a-zA-Z0-9_-]/g, "-") +
                 "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const who = identity || ("caller-" + Math.random().toString(36).slice(2, 8));

    // The slug (and optional host_name) ride in the token as PARTICIPANT
    // metadata (the `metadata` field on AccessToken attaches to the joining
    // identity). agent.py reads it off the PARTICIPANT object once they connect
    // (participant.metadata -> JSON.parse), NOT from ctx.job.metadata — this is
    // participant metadata, not room/job metadata.
    const at = new AccessToken(LK_KEY, LK_SECRET, {
      identity: who,
      metadata: JSON.stringify({ slug, host_name: hostName || null }),
    });
    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    // Request explicit dispatch of the "spamviking" agent into this room when it
    // is created. Without this, an agent with agent_name set never joins a
    // token-created room. We also pass the slug as dispatch metadata so the agent
    // can read it from the job (ctx.job.metadata) as a fallback to participant
    // metadata — whichever the agent code reads, the slug is available.
    at.roomConfig = new RoomConfiguration({
      agents: [
        new RoomAgentDispatch({
          agentName: AGENT_NAME,
          metadata: JSON.stringify({ slug, host_name: hostName || null }),
        }),
      ],
    });

    const token = await at.toJwt();
    return send({ token, url: LK_URL, room, slug });
  } catch (e) {
    return send({ error: "token mint failed: " + (e && e.message) }, 500);
  }
};

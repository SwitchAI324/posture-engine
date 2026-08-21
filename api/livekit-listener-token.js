// api/livekit-listener-token.js
//
// Mints a HIDDEN, SUBSCRIBE-ONLY LiveKit token so Mead Hall's Director can
// join a live call's room and hear real room audio - never seen by the
// caller/agent as a participant, and never able to publish into the call.
//
// Deliberately a SEPARATE endpoint from api/livekit-token.js (which mints
// the real caller/agent join token, with RoomAgentDispatch etc.). Keeping
// this isolated means a bug here can only fail to connect a listener - it
// has no path to touching the real join flow or granting publish on a
// live call.
//
// USAGE (from the browser, Mead Hall's "Listen" button):
//   GET /api/livekit-listener-token?room=<call_id>
//   -> { token: "<jwt>", url: "<livekit ws url>" }
//
// ENV VARS EXPECTED (adjust names here if your existing livekit-token.js
// uses different ones - I don't have that file in front of me, so these
// are the LiveKit-SDK-conventional names; check against the working file
// before deploying):
//   LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL

const { AccessToken } = require("livekit-server-sdk");

module.exports = async (req, res) => {
  const room = req.query?.room || req.query?.call_id;

  if (!room || typeof room !== "string") {
    res.status(400).json({ error: "missing required query param: room (call_id)" });
    return;
  }

  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const livekitUrl = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !livekitUrl) {
    console.error(
      "livekit-listener-token: missing LIVEKIT_API_KEY/API_SECRET/URL in env"
    );
    res.status(500).json({ error: "server misconfigured" });
    return;
  }

  // Identity is unique per listener session so multiple directors/tabs
  // could listen to the same room without colliding. Not shown to anyone -
  // hidden below - but LiveKit still requires a unique identity per
  // connection within a room.
  const identity = `mead-hall-listener-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const token = new AccessToken(apiKey, apiSecret, {
    identity,
    // Short-lived on purpose - a listener token only needs to last long
    // enough to open the connection; re-fetch on reconnect rather than
    // minting something long-lived that outlives the "Listen" click.
    ttl: "10m",
  });

  token.addGrant({
    room,
    roomJoin: true,
    canPublish: false,      // never allowed to push audio/video into the call
    canPublishData: false,  // no data-channel messages into the room either
    canSubscribe: true,     // can hear/see published tracks
    hidden: true,           // invisible to other participants - the whole point
  });

  const jwt = await token.toJwt();

  res.status(200).json({ token: jwt, url: livekitUrl });
};

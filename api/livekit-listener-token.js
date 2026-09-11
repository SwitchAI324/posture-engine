// api/livekit-listener-token.js
// ----------------------------------------------------------------------
// Mint a LiveKit access token for an SV user to LISTEN to a live call.
//
// The listener is HIDDEN and SUBSCRIBE-ONLY: they hear the host and the
// scammer, cannot speak, cannot publish data, and do not appear to anyone
// else in the room (hidden: true is a LiveKit grant - it is the actual
// mechanism, not a UI trick; Booking's tile-filtering is only a safety
// net on top).
//
// ACCESS (Sep 10, Andrew's ruling that identifiers must not reveal
// anything): the caller presents an opaque token, never a room name. The
// SMS chat signs an HS256 JWT at notification time carrying
// {room, user_id, iat, exp} with exp = +30 min, using LISTEN_TOKEN_SECRET.
// This endpoint verifies it and resolves the room SERVER-SIDE, so:
//   - the room never appears in a URL, an SMS, or a screenshot
//     (inbound room names used to embed the caller's phone number)
//   - a forwarded link dies on its own after 30 minutes
//   - no storage, no lookup table - the JWT carries everything
//
// The response returns `room` so Mead Hall's page can take it from here
// instead of from the URL, which is what lets the SMS chat drop the
// legacy call_id param.
//
// GET /api/livekit-listener-token?listen=<jwt>     (also accepts ?token=)
//   -> { token, url, room, identity, expiresIn }
//
// DIRECTOR PATH (Sep 10): the director watching the board has no listen JWT -
// they never came through an SMS - so they present their DIRECTOR CONTROL
// token instead, with the room named in the URL:
//   GET /api/livekit-listener-token?director=<control-token>&room=<room>
// Rationale (Mead Hall's, agreed): someone already authorized to FIRE and
// DEATHBLOW a call is certainly authorized to hear it. Deliberately a
// SEPARATE param from ?token= - that one means a listen JWT signed with
// LISTEN_TOKEN_SECRET, this one a control token signed with
// CONTROL_TOKEN_SECRET; same name for two secrets would mean guessing.
// KNOWN PROPERTY, not an oversight: the director token's payload is
// {role, iat} - no exp, not room-scoped - so any valid director token
// authorizes listening to any room indefinitely. Accepted because a
// director can already control any call; PE has the exp claim on their list.
//
// ENV: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL, LISTEN_TOKEN_SECRET,
//      CONTROL_TOKEN_SECRET
//
// LEGACY: ?room=<room> is accepted ONLY when ALLOW_UNSIGNED_LISTEN=1, for
// the outbound slug-based test rooms during the transition. Leave it unset
// in production - with it on, anyone holding a room name can listen.
// ----------------------------------------------------------------------

const { AccessToken } = require("livekit-server-sdk");
const crypto = require("crypto");

const LK_KEY = process.env.LIVEKIT_API_KEY;
const LK_SECRET = process.env.LIVEKIT_API_SECRET;
const LK_URL = process.env.LIVEKIT_URL;
const LISTEN_TOKEN_SECRET = process.env.LISTEN_TOKEN_SECRET;
const CONTROL_TOKEN_SECRET = process.env.CONTROL_TOKEN_SECRET;
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED_LISTEN === "1";

// How long the LiveKit token itself is good for. Short - it only needs to
// survive the join; the media session continues after it expires.
const LK_TOKEN_TTL_SEC = 10 * 60;

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

// Verify an HS256 JWT with a constant-time signature compare. Returns the
// payload, or throws with a reason. `requireRoom`/`requireExp` are off for
// the director token, whose payload is {role, iat} by design.
function verifyListenJwt(jwt, secret, opts) {
  const requireRoom = !opts || opts.requireRoom !== false;
  const requireExp = !opts || opts.requireExp !== false;
  const parts = String(jwt).split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h64, p64, s64] = parts;

  let header;
  try {
    header = JSON.parse(b64urlToBuf(h64).toString("utf8"));
  } catch {
    throw new Error("malformed header");
  }
  if (header.alg !== "HS256") throw new Error("unexpected alg: " + header.alg);

  const expected = crypto
    .createHmac("sha256", secret)
    .update(h64 + "." + p64)
    .digest();
  const got = b64urlToBuf(s64);
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    throw new Error("bad signature");
  }

  let payload;
  try {
    payload = JSON.parse(b64urlToBuf(p64).toString("utf8"));
  } catch {
    throw new Error("malformed payload");
  }

  const now = Math.floor(Date.now() / 1000);
  if (requireExp && typeof payload.exp !== "number") throw new Error("no exp");
  if (typeof payload.exp === "number" && payload.exp <= now) throw new Error("expired");
  // Tolerate a little clock skew on iat, reject anything far in the future.
  if (typeof payload.iat === "number" && payload.iat > now + 300) {
    throw new Error("issued in the future");
  }
  if (requireRoom && !payload.room) throw new Error("no room in token");
  return payload;
}

module.exports = async function handler(req, res) {
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  const send = (obj, status = 200) => {
    res.statusCode = status;
    return res.end(JSON.stringify(obj));
  };

  try {
    if (!LK_KEY || !LK_SECRET || !LK_URL) {
      return send({ error: "livekit not configured" }, 500);
    }

    const url = new URL(req.url, "http://x");
    const jwt = url.searchParams.get("listen") || url.searchParams.get("token");
    const directorToken = url.searchParams.get("director");
    const urlRoom = url.searchParams.get("room") || url.searchParams.get("call_id");

    let room = null;
    let userId = null;

    if (directorToken) {
      // Director listening to their own board. Room comes from the URL; the
      // control token is what authorizes it.
      if (!CONTROL_TOKEN_SECRET) {
        return send({ error: "director auth not configured" }, 500);
      }
      if (!urlRoom) return send({ error: "missing room" }, 400);
      let payload;
      try {
        payload = verifyListenJwt(directorToken, CONTROL_TOKEN_SECRET, {
          requireRoom: false,
          requireExp: false,
        });
      } catch (e) {
        console.log("listener-token: director rejected: " + (e && e.message ? e.message : e));
        return send({ error: "not authorized to listen" }, 401);
      }
      if (payload.role !== "director") {
        console.log("listener-token: director token has role=" + payload.role);
        return send({ error: "not authorized to listen" }, 401);
      }
      room = urlRoom;
      userId = "director";
    } else if (jwt) {
      if (!LISTEN_TOKEN_SECRET) {
        return send({ error: "listen tokens not configured" }, 500);
      }
      let payload;
      try {
        payload = verifyListenJwt(jwt, LISTEN_TOKEN_SECRET);
      } catch (e) {
        // Deliberately vague to the caller; the reason goes to the log only.
        console.log("listener-token: rejected: " + (e && e.message ? e.message : e));
        return send({ error: "invalid or expired link" }, 401);
      }
      room = payload.room;
      userId = payload.user_id || payload.userId || null;
    } else if (urlRoom && ALLOW_UNSIGNED) {
      // Transition path for outbound slug-based test rooms only.
      console.log("listener-token: UNSIGNED join allowed for room=" + urlRoom);
      room = urlRoom;
    } else {
      return send({ error: "missing listen token" }, 400);
    }

    // Identity convention: listen-<user_id>. Booking filters this prefix out
    // of the scammer-facing tile rendering; `hidden` already keeps them out
    // of the room for every other participant.
    const identity =
      "listen-" + (userId || "anon-" + crypto.randomBytes(4).toString("hex"));

    const at = new AccessToken(LK_KEY, LK_SECRET, {
      identity,
      name: "listener",
      ttl: LK_TOKEN_TTL_SEC,
    });
    at.addGrant({
      room,
      roomJoin: true,
      canSubscribe: true,
      canPublish: false,
      canPublishData: false,
      canUpdateOwnMetadata: false,
      hidden: true,
    });

    const token = await at.toJwt();
    // `room` is returned so the client can stop reading it from the URL -
    // that is what lets the SMS chat drop the legacy call_id param.
    return send({ token, url: LK_URL, room, identity, expiresIn: LK_TOKEN_TTL_SEC });
  } catch (e) {
    console.log("listener-token: mint failed: " + (e && e.message ? e.message : e));
    return send({ error: "token mint failed" }, 500);
  }
};

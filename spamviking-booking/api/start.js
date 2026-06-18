// POST /api/start  Body: { slug }
//
// The /join bridge. Calls PE's already-built /api/join on the Posture Engine
// project (server-to-server), which reads the token by slug, mints (or reuses)
// the Vapi call with metadata.archetype, writes vapi_call_id + joined_at back,
// and returns the call connection info. We pass that back to the join page.
//
// This hop is why the raw Vapi URL is never exposed: the scammer only ever
// sees spamviking.io/join/<slug>; the Vapi details are read and minted here,
// out of their view.
//
// The exact shape of PE's response is being locked via the smoke-test (the
// "arch: flips to crypto_investment" check). We pass the whole response through
// so the join page can use whatever connection field it returns.

const PE_BASE = process.env.POSTURE_ENGINE_BASE; // e.g. https://posture-engine.vercel.app

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

    const body =
      typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const slug = body.slug;
    if (!slug) return res.status(400).json({ error: 'missing slug' });

    const upstream = await fetch(
      `${PE_BASE}/api/join?slug=${encodeURIComponent(slug)}`,
      { method: 'POST' }
    );
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      return res.status(502).json({ error: 'join mint failed', detail: data });
    }
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: 'start failed' });
  }
};

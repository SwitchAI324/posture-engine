// POST /api/trapline   Body: { host }
//
// Generates Barbara's pithy trapdoor overshare (the "none of these worked" beat)
// via the LLM, server-side so the API key + prompt never touch the browser.
// Hard-constrained: fixed system prompt, tiny token cap, must reference checking
// with the host about opening the schedule. Falls back to a fixed line on any
// failure, so the page never hangs or breaks.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.TRAPLINE_MODEL || 'claude-sonnet-4-6';

function fallbackLine(host) {
  return `So sorry — none of those worked. It's been a week; ${host}'s calendar is a jigsaw right now. ` +
    `Let me check with ${host} about opening up more time, then email you fresh options.`;
}

const SYS =
  'You are Barbara, an electronic executive assistant, writing ONE short message on a ' +
  'booking page after the visitor clicked "none of these times work." Voice: warm, ' +
  'lightly flustered, faintly oversharing about how busy it has been — but composed and ' +
  'professional, never silly. Hard rules: 2 sentences, under 38 words total, plain text ' +
  'only (no markdown, no greeting, no sign-off). You MUST end by saying you will check ' +
  'with the host about opening up more time and then email fresh options. Refer to the ' +
  'host by the given name. Output ONLY the message.';

module.exports = async (req, res) => {
  let host = 'the host';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    if (body.host && /^[A-Za-z][A-Za-z .'-]{0,40}$/.test(body.host)) host = body.host;

    if (!ANTHROPIC_KEY) return res.status(200).json({ line: fallbackLine(host) });

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 90,
        system: SYS,
        messages: [{ role: 'user', content: `Host name: ${host}. Write Barbara's line.` }],
      }),
    });
    if (!r.ok) return res.status(200).json({ line: fallbackLine(host) });
    const data = await r.json();
    let out = '';
    if (data && Array.isArray(data.content)) {
      for (const blk of data.content) if (blk.type === 'text') out += blk.text;
    }
    out = (out || '').trim();
    // sanity gate: non-empty, not absurdly long, mentions the host -> use it; else fallback
    if (!out || out.length > 320 || out.indexOf(host) === -1) {
      return res.status(200).json({ line: fallbackLine(host) });
    }
    return res.status(200).json({ line: out });
  } catch (e) {
    return res.status(200).json({ line: fallbackLine(host) });
  }
};

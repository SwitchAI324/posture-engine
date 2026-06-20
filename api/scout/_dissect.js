// api/scout/_dissect.js
// The inbound dissection extractor. Reads what the scammer mailed us — body,
// signature, and attachment text — and extracts ONLY volunteered facts. The
// LLM step is extraction, not inference, so hallucination risk is near zero.
// Returns facts + canonical hooks. Never persists the raw body or the file.

const MODEL =
  process.env.SCOUT_JUDGE_MODEL ||
  process.env.ANTHROPIC_MODEL ||
  'claude-haiku-4-5-20251001';

const SYSTEM = `You dissect an email a scammer sent us. Extract ONLY facts \
they explicitly stated — this is extraction, NOT inference. Never invent or \
infer. If something is not stated, use null or [].

Return ONLY this JSON, no prose, no code fences:
{
  "name": string|null,
  "title": string|null,
  "company": string|null,
  "location": string|null,
  "claims": [short strings: their key claims and urgency, in their words],
  "urgency_line": string|null,
  "pdf_facts": [facts explicitly stated in the attached document],
  "confidence": { "identity": 0..1, "location": 0..1, "claims": 0..1, "attachment": 0..1 }
}
confidence reflects how clearly they stated each group (1 = verbatim).`;

// Social handles are regex-extractable with no model. Carried as the URLs
// they gave us — never fetched (Option A). One entry per handle, tagged by
// platform; the facts blob keeps them all, the hook layer surfaces two.
const SOCIAL_PATTERNS = [
  { platform: 'linkedin', re: /https?:\/\/(?:[a-z0-9.]+\.)?linkedin\.com\/(?:in|company)\/([A-Za-z0-9\-_%.]+)/ig },
  { platform: 'instagram', re: /https?:\/\/(?:[a-z0-9.]+\.)?instagram\.com\/([A-Za-z0-9_.]+)/ig },
  { platform: 'tiktok', re: /https?:\/\/(?:[a-z0-9.]+\.)?tiktok\.com\/@([A-Za-z0-9_.]+)/ig },
  { platform: 'x', re: /https?:\/\/(?:[a-z0-9.]+\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]+)/ig },
  { platform: 'facebook', re: /https?:\/\/(?:[a-z0-9.]+\.)?facebook\.com\/([A-Za-z0-9.\-]+)/ig },
];

const NON_HANDLE = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'home',
  'search', 'intent', 'share', 'sharer', 'watch', 'channel', 'login', 'signup',
  'about', 'help', 'tr', 'plugins', 'i']);

function extractSocials(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();
  for (const { platform, re } of SOCIAL_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const handle = (m[1] || '').replace(/[/.,)\]]+$/, '');
      if (!handle || NON_HANDLE.has(handle.toLowerCase())) continue;
      const url = m[0].replace(/[).,\]]+$/, '');
      const k = `${platform}:${handle.toLowerCase()}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ platform, handle, url });
    }
  }
  return out;
}

export async function dissect({ body = '', signature = '', subject = '', attachments = [] } = {}) {
  const sigText = signature || body;
  const socials = extractSocials(`${body}\n${signature}`);

  // Born-digital PDFs only. Scanned/image PDFs (no embedded text) are skipped
  // — OCR is deferred. pdf-parse is imported lazily so the body lane deploys
  // even before that dependency is added to package.json.
  let attachmentText = '';
  let attachmentName = null;
  for (const a of attachments) {
    const text = await extractPdfText(a);
    if (text && text.trim().length > 40) {
      attachmentText += `\n\n[${a.filename}]\n${text}`;
      attachmentName = attachmentName || a.filename;
    }
  }

  const llm = await extractFacts(subject, body, sigText, attachmentText);
  const c = llm.confidence || {};

  // Per-lane fact rows for scout_facts (Data's shape).
  const factRows = [];
  const bodyFacts = {
    name: llm.name || null,
    title: llm.title || null,
    company: llm.company || null,
    location: llm.location || null,
    // NOTE: claims/urgency_line are added pending Data confirming the facts
    // shape — Data's enumerated shape omitted them, but pitch_claims is the
    // highest-value hook and its content needs a home.
    claims: llm.claims || [],
    urgency_line: llm.urgency_line || null,
  };
  if (anyValue(bodyFacts)) factRows.push({ lane: 'body', facts: bodyFacts });
  if (socials.length)
    factRows.push({ lane: 'signature', facts: { sender_socials: socials } });
  if (attachmentText)
    factRows.push({ lane: 'attachment', facts: { pdf_facts: llm.pdf_facts || [] } });

  // Canonical hooks for gating + fuel_hooks_status registration.
  const hooks = [];
  if ((llm.claims && llm.claims.length) || llm.urgency_line)
    hooks.push({
      hook_id: 'pitch_claims',
      label: 'Their own urgency to parrot',
      payload: { claims: llm.claims || [], urgency_line: llm.urgency_line || null },
      confidence: num(c.claims, 0.8),
      source: 'email:body',
    });
  if (llm.name || llm.title || llm.company)
    hooks.push({
      hook_id: 'sender_identity',
      label: identityLabel(llm),
      payload: { name: llm.name || null, title: llm.title || null, company: llm.company || null },
      confidence: num(c.identity, 0.7),
      source: 'email:body',
    });
  const linkedin = socials.find((s) => s.platform === 'linkedin') || null;
  const nonLinkedin = socials.filter((s) => s.platform !== 'linkedin');
  if (linkedin)
    hooks.push({
      hook_id: 'sender_linkedin',
      label: `LinkedIn: ${linkedin.handle}`.slice(0, 40),
      payload: linkedin,
      confidence: 0.95,
      source: 'email:signature',
    });
  if (nonLinkedin.length)
    hooks.push({
      hook_id: 'sender_social',
      label: socialLabel(nonLinkedin),
      payload: { socials: nonLinkedin },
      confidence: 0.95,
      source: 'email:signature',
    });
  if (llm.location)
    hooks.push({
      hook_id: 'office_location',
      label: `Stated location: ${llm.location}`.slice(0, 40),
      payload: { location: llm.location, raw: llm.location },
      confidence: num(c.location, 0.7),
      source: 'email:body',
    });
  if (llm.pdf_facts && llm.pdf_facts.length)
    hooks.push({
      hook_id: 'attachment_facts',
      label: (attachmentName ? `From ${attachmentName}` : 'From attachment').slice(0, 40),
      payload: { filename: attachmentName, facts: llm.pdf_facts },
      confidence: num(c.attachment, 0.75),
      source: 'email:attachment',
    });

  return { factRows, hooks };
}

async function extractFacts(subject, body, signature, attachmentText) {
  const empty = { claims: [], pdf_facts: [], confidence: {} };
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return empty;
  const user = JSON.stringify({
    subject: (subject || '').slice(0, 300),
    body: (body || '').slice(0, 6000),
    signature: (signature || '').slice(0, 1000),
    attachment_text: (attachmentText || '').slice(0, 6000),
  });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: SYSTEM,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!r.ok) return empty;
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const s = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(s);
    return parsed && typeof parsed === 'object' ? { ...empty, ...parsed } : empty;
  } catch {
    return empty;
  }
}

async function extractPdfText(a) {
  if (!a || !a.content_base64) return '';
  const mime = (a.mime || '').toLowerCase();
  const name = (a.filename || '').toLowerCase();
  if (!mime.includes('pdf') && !name.endsWith('.pdf')) return '';
  try {
    const pdfParse = (await import('pdf-parse')).default;
    const buf = Buffer.from(a.content_base64, 'base64');
    const out = await pdfParse(buf);
    return out && out.text ? out.text : '';
  } catch {
    return ''; // dependency absent, or scanned/unsupported → skip (OCR deferred)
  }
}

function anyValue(o) {
  return Object.values(o).some((v) => v && (!Array.isArray(v) || v.length));
}
function num(v, d) {
  return typeof v === 'number' && v >= 0 && v <= 1 ? v : d;
}
function identityLabel(l) {
  const who = [l.name, l.title].filter(Boolean).join(', ');
  const co = l.company ? ` @ ${l.company}` : '';
  return (who + co || 'Sender identity').slice(0, 40);
}
function socialLabel(list) {
  const plats = [...new Set(list.map((s) => s.platform))];
  return `Socials: ${plats.join(', ')}`.slice(0, 40);
}

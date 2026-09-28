// api/phone/_ocr.js
// Shared screenshot-text extraction for BOTH intake sources:
//   - raid@ (Email/Barbara): media items carry { content_type, filename,
//     data_base64 } — bytes already in hand.
//   - SMS inbound: media items carry { url, content_type } — a signed
//     Supabase URL already downloaded from Twilio, fetched here.
// Reads images in the order given (a long scam text split across several
// screenshots stays in order) and returns the extracted text, one string
// per image plus a single concatenated string for downstream use (link
// extraction, stated-number extraction). Never throws for one bad image —
// a page that fails to read just contributes empty text and is logged.

const MAX_IMAGES = 4;
const MAX_COMBINED_BYTES = 3 * 1024 * 1024; // ~3MB pre-base64, matches raid@'s cap
const FETCH_TIMEOUT_MS = 8000;
const SUPPORTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

// HEIC and anything else unsupported by Claude's vision input is skipped,
// not attempted — matches raid@ already skipping HEIC before it gets here.
function isSupported(contentType) {
  return SUPPORTED.has((contentType || '').toLowerCase());
}

async function toBase64(item) {
  if (item.data_base64) return item.data_base64;
  if (item.url) {
    const r = await fetch(item.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`media fetch ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.toString('base64');
  }
  throw new Error('media item has neither data_base64 nor url');
}

async function ocrOne(b64, contentType, { anthropicKey, model }) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 800,
      system: 'Transcribe all visible text in this screenshot exactly as written, top to bottom. Output the text only — no description of the image, no commentary, no markdown. If there is no readable text, output nothing.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: contentType, data: b64 } },
          { type: 'text', text: 'Transcribe the text in this image.' },
        ],
      }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic (ocr) ${r.status}: ${await r.text()}`);
  const raw = (await r.json()).content?.map(c => c.text || '').join('') || '';
  return raw.trim();
}

// Runs OCR over up to MAX_IMAGES media items, in order. Returns
// { pages: [{ index, text, skipped_reason? }], combined_text }.
// combined_text joins non-empty pages with a blank line, preserving order
// - this is what a multi-screenshot scam text reassembles into.
export async function ocrMedia(mediaArray, { anthropicKey, model }) {
  const items = (Array.isArray(mediaArray) ? mediaArray : []).slice(0, MAX_IMAGES);
  const pages = [];
  let combinedBytes = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i] || {};
    if (!isSupported(item.content_type)) {
      pages.push({ index: i, text: '', skipped_reason: 'unsupported_type' });
      continue;
    }
    try {
      const b64 = await toBase64(item);
      combinedBytes += Math.ceil((b64.length * 3) / 4); // approx decoded size
      if (combinedBytes > MAX_COMBINED_BYTES) {
        pages.push({ index: i, text: '', skipped_reason: 'over_size_cap' });
        continue;
      }
      const text = await ocrOne(b64, item.content_type, { anthropicKey, model });
      pages.push({ index: i, text });
    } catch (e) {
      console.warn('ocr failed for one image (non-fatal)', i, String(e.message || e));
      pages.push({ index: i, text: '', skipped_reason: 'error' });
    }
  }

  const combined_text = pages
    .map(p => p.text)
    .filter(Boolean)
    .join('\n\n');

  return { pages, combined_text };
}

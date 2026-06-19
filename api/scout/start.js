// api/scout/start.js
// Scouting Engine orchestrator. Triggered by booking.created as a fire-and-
// forget POST {slug}. Runs the deterministic lane + raw gather in parallel,
// then one judgment pass, gates, upserts scout_hooks, emits trace. It never
// throws to the caller and never blocks the call: worst case it writes
// nothing and the call runs with an empty ammo rack.

import {
  fetchRdap,
  collectDomainAge,
  collectGeoMismatch,
  collectPriorContact,
  collectTemplateMatch,
  gatherRaw,
} from './_collectors.js';
import { judge } from './_judge.js';
import { gate, writeHooks, emitTrace } from './_hooks.js';
import { sbSelect } from './_sb.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Shared-secret guard so only the booking layer can trigger scouting.
  const expected = process.env.SV_SCOUT_TOKEN;
  if (expected && req.headers['x-sv-scout-token'] !== expected)
    return res.status(401).json({ error: 'bad token' });

  const slug = (req.body && req.body.slug) || (req.query && req.query.slug);
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const started = Date.now();
  await emitTrace('scout_started', { slug, trigger: 'booking.created' });

  let written = 0;
  try {
    const target = await loadTarget(slug);
    if (!target) {
      await emitTrace('scout_complete', { slug, hooks_written: 0, reason: 'no_target' });
      return res.status(200).json({ slug, hooks_written: 0 });
    }

    const rdap = await fetchRdap(target.domain);

    // Lane A (deterministic) + Lane B raw-gather run in parallel.
    const [det, raw] = await Promise.all([
      Promise.allSettled([
        Promise.resolve(collectDomainAge(target, rdap)),
        Promise.resolve(collectGeoMismatch(target, rdap)),
        collectPriorContact(target),
        collectTemplateMatch(target),
      ]),
      gatherRaw(target),
    ]);

    const detHooks = det
      .filter((r) => r.status === 'fulfilled' && r.value)
      .map((r) => r.value);

    // One judgment pass over the gathered material → web-derived hooks.
    const webHooks = await judge(raw);

    const live = gate([...detHooks, ...webHooks]);
    for (const h of live) {
      await emitTrace('hook_enriched', {
        slug,
        hook_id: h.hook_id,
        confidence: h.confidence,
        source: h.source,
        label: h.label,
      });
    }

    written = await writeHooks(slug, live);
  } catch (e) {
    await emitTrace('scout_error', { slug, message: String((e && e.message) || e) });
  }

  await emitTrace('scout_complete', {
    slug,
    hooks_written: written,
    duration_ms: Date.now() - started,
  });
  return res.status(200).json({ slug, hooks_written: written });
}

// SCHEMA SEAM — the one place Scouting touches your schema. Map your
// booking_tokens / targets columns into the shape the engine needs. Adjust
// the select and the field names; everything downstream depends only on the
// returned object. If target facts live on a related row, fetch and merge
// it here.
async function loadTarget(slug) {
  try {
    const rows = await sbSelect(
      `booking_tokens?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`);
    const b = rows && rows[0];
    if (!b) return null;
    return {
      slug,
      scammer_email: b.scammer_email || b.email || null,
      domain: b.domain || domainFromEmail(b.scammer_email || b.email) || null,
      claimed_company: b.claimed_company || b.company || null,
      claimed_geo: b.claimed_geo || b.geo || null,
      pitch_text: b.pitch_text || b.pitch || '',
    };
  } catch {
    return null;
  }
}

function domainFromEmail(e) {
  if (!e || !e.includes('@')) return null;
  return e.split('@')[1].toLowerCase();
}

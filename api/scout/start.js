// api/scout/start.js
// Scouting Engine orchestrator. Triggered by booking.created as a fire-and-
// forget POST {slug}. Runs the deterministic lane + raw gather in parallel,
// then one judgment pass, gates, upserts scout_hooks, emits trace. It never
// throws to the caller and never blocks the call: worst case it writes
// nothing and the call runs with an empty ammo rack.

import {
  fetchRdap,
  collectDomainAge,
  collectPriorContact,
  collectTemplateMatch,
  gatherRaw,
} from './_collectors.js';
import { judge } from './_judge.js';
import { gate, dedupeHooks, writeHooks, emitTrace, registerStatus } from './_hooks.js';
import { sbSelect, ilikeEq, activeSecret, scoutToken } from './_sb.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Shared-secret guard so only the booking layer can trigger scouting.
  const expected = activeSecret(process.env.SV_SCOUT_TOKEN);
  if (expected && scoutToken(req) !== expected)
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

    const live = dedupeHooks(gate([...detHooks, ...webHooks]));
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

    // Advertise the live hooks in targets.fuel_hooks_status AFTER the data
    // is written — data before advertisement, so readers never see a hook
    // marked live whose row isn't there yet.
    await registerStatus(slug, resolveTargetRef(target), live);
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

// SCHEMA SEAM — mapped to the real booking_tokens columns. The table has no
// domain/company columns, so both are derived from target_email. Swap in
// dedicated columns here if you add them later.
async function loadTarget(slug) {
  try {
    const rows = await sbSelect(
      `booking_tokens?slug=eq.${encodeURIComponent(slug)}&select=*&limit=1`);
    const b = rows && rows[0];
    if (!b) return null;
    const email = b.target_email || null;
    const domain = domainFromEmail(email);
    return {
      slug,
      scammer_email: email,
      domain,
      claimed_company: companyFromDomain(domain),
      pitch_text: b.narrative || '',
    };
  } catch {
    return null;
  }
}

function domainFromEmail(e) {
  if (!e || !e.includes('@')) return null;
  return e.split('@')[1].toLowerCase();
}

// SCHEMA SEAM #2 — CONFIRMED: targets keys on email, matched to
// booking_tokens.target_email. Case-insensitive per the universal rule for
// user-entered data.
function resolveTargetRef(target) {
  if (target.scammer_email) return ilikeEq('email', target.scammer_email);
  return null;
}

// Rough company guess from the domain (second-level label, title-cased).
// switchyardai.com → "Switchyardai". Replace with a real column when you have one.
function companyFromDomain(domain) {
  if (!domain) return null;
  const label = domain.split('.')[0];
  if (!label) return null;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

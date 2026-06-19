// api/scout/_collectors.js
// The collection lane. Everything here is deterministic code — no model.
// Each collector returns a hook {hook_id,label,payload,confidence,source}
// or null. confidence is the collector's own certainty; the per-hook gate
// in _hooks.js applies the threshold.

import { sbSelect } from './_sb.js';

// ---- RDAP (shared by domain_age + geo_mismatch) -------------------------
// Public, keyless. rdap.org redirects to the authoritative registry server
// and returns JSON with an "events" array.
export async function fetchRdap(domain) {
  if (!domain) return null;
  try {
    const r = await fetch(
      `https://rdap.org/domain/${encodeURIComponent(domain)}`,
      { headers: { Accept: 'application/rdap+json' } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ---- domain_age ---------------------------------------------------------
export function collectDomainAge(t, rdap) {
  if (!rdap) return null;
  const reg = (rdap.events || []).find((e) => e.eventAction === 'registration');
  if (!reg || !reg.eventDate) return null;
  const ageDays = Math.floor((Date.now() - new Date(reg.eventDate)) / 86400000);
  if (!Number.isFinite(ageDays) || ageDays < 0) return null;
  // Only weaponizable when the domain is young. Older than ~4 months = noise.
  if (ageDays > 120) return null;
  return {
    hook_id: 'domain_age',
    label: `Domain registered ${ageDays}d ago`,
    payload: { domain: t.domain, registered_date: reg.eventDate, age_days: ageDays },
    confidence: 0.95, // RDAP registration date is an authoritative record
    source: 'rdap',
  };
}

// ---- geo_mismatch -------------------------------------------------------
export function collectGeoMismatch(t, rdap) {
  if (!t.claimed_geo) return null;
  const signal = rdapCountry(rdap) || ccTldCountry(t.domain);
  const claimed = normCountry(t.claimed_geo);
  // Precision over recall: only fire when both sides resolve and differ.
  if (!signal || !claimed || claimed === signal) return null;
  return {
    hook_id: 'geo_mismatch',
    label: `Claims ${claimed}, registered ${signal}`,
    payload: { claimed_geo: t.claimed_geo, signal_geo: signal, basis: 'rdap/cctld' },
    confidence: 0.75,
    source: 'rdap',
  };
}

// ---- prior_contact ------------------------------------------------------
// SCHEMA SEAM: same identity seen in a prior target. Adjust table/columns
// to your corpus. Wrapped so a schema mismatch yields null, never a throw.
export async function collectPriorContact(t) {
  if (!t.scammer_email) return null;
  try {
    const rows = await sbSelect(
      `targets?scammer_email=eq.${encodeURIComponent(t.scammer_email)}` +
      `&slug=neq.${encodeURIComponent(t.slug)}` +
      `&select=slug,created_at&order=created_at.asc&limit=1`);
    if (!rows || !rows.length) return null;
    return {
      hook_id: 'prior_contact',
      label: 'Seen before in SpamViking',
      payload: { prior_slug: rows[0].slug, first_seen: rows[0].created_at },
      confidence: 0.9,
      source: 'corpus',
    };
  } catch {
    return null;
  }
}

// ---- template_match -----------------------------------------------------
// SCHEMA SEAM: same pitch text reused across identities. Pull a window of
// prior pitches and score trigram overlap. Similarity doubles as confidence.
export async function collectTemplateMatch(t) {
  if (!t.pitch_text) return null;
  try {
    const rows = await sbSelect(
      `targets?slug=neq.${encodeURIComponent(t.slug)}` +
      `&select=template_id,pitch_text&order=created_at.desc&limit=200`);
    const mine = shingles(t.pitch_text);
    let best = null;
    for (const r of rows || []) {
      if (!r.pitch_text) continue;
      const score = jaccard(mine, shingles(r.pitch_text));
      if (!best || score > best.score) best = { score, template_id: r.template_id };
    }
    if (!best || best.score < 0.55) return null;
    return {
      hook_id: 'template_match',
      label: 'Reused pitch template',
      payload: {
        template_id: best.template_id || null,
        match_score: Number(best.score.toFixed(2)),
      },
      confidence: best.score,
      source: 'corpus',
    };
  } catch {
    return null;
  }
}

// ---- raw gather (feeds the judgment pass) -------------------------------
export async function gatherRaw(t) {
  const news = await searchWeb(t.claimed_company);
  return {
    claimed_company: t.claimed_company || null,
    pitch_text: t.pitch_text || '',
    news,
  };
}

// Provider-agnostic search seam. Until SCOUT_SEARCH_URL + SCOUT_SEARCH_KEY
// are set, the web lane stays dark and returns [] — the designed safe
// default (the deterministic lane still produces hooks).
async function searchWeb(company) {
  if (!company) return [];
  const key = process.env.SCOUT_SEARCH_KEY;
  const endpoint = process.env.SCOUT_SEARCH_URL;
  if (!key || !endpoint) return [];
  try {
    const r = await fetch(
      `${endpoint}?q=${encodeURIComponent(company + ' news')}`,
      { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return [];
    const data = await r.json();
    const items = data.results || (data.web && data.web.results) || [];
    return items.slice(0, 6).map((x) => ({
      title: x.title,
      snippet: x.description || x.snippet || '',
      url: x.url,
      date: x.age || x.date || null,
    }));
  } catch {
    return [];
  }
}

// ---- small deterministic helpers ----------------------------------------
function rdapCountry(rdap) {
  if (!rdap) return null;
  try {
    for (const ent of rdap.entities || []) {
      const v = ent.vcardArray && ent.vcardArray[1];
      const adr = v && v.find((f) => f[0] === 'adr');
      if (adr && adr[3] && adr[3][6]) return normCountry(adr[3][6]);
    }
  } catch {}
  return null;
}

const CCTLD = { uk: 'GB', ru: 'RU', ng: 'NG', cn: 'CN', in: 'IN', de: 'DE',
  fr: 'FR', au: 'AU', ca: 'CA', us: 'US' };
function ccTldCountry(domain) {
  if (!domain) return null;
  const tld = domain.split('.').pop().toLowerCase();
  return CCTLD[tld] || null;
}

const COUNTRY = { 'united states': 'US', usa: 'US', us: 'US', america: 'US',
  'united kingdom': 'GB', uk: 'GB', england: 'GB', britain: 'GB', gb: 'GB',
  russia: 'RU', ru: 'RU', nigeria: 'NG', ng: 'NG', china: 'CN', cn: 'CN',
  india: 'IN', germany: 'DE', france: 'FR', australia: 'AU', canada: 'CA' };
function normCountry(s) {
  if (!s) return null;
  const k = String(s).trim().toLowerCase();
  if (COUNTRY[k]) return COUNTRY[k];
  // pull a trailing 2-letter code, e.g. "London, UK"
  const m = k.match(/\b([a-z]{2})\b\s*$/);
  if (m && COUNTRY[m[1]]) return COUNTRY[m[1]];
  return null;
}

function shingles(text) {
  const norm = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  const toks = norm.split(' ');
  const set = new Set();
  for (let i = 0; i + 2 < toks.length; i++) set.add(toks[i] + ' ' + toks[i + 1] + ' ' + toks[i + 2]);
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

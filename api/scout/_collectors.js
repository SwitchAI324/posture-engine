// api/scout/_collectors.js
// The collection lane. Everything here is deterministic code — no model.
// Each collector returns a hook {hook_id,label,payload,confidence,source}
// or null. confidence is the collector's own certainty; the per-hook gate
// in _hooks.js applies the threshold.

import { sbSelect } from './_sb.js';

// ---- RDAP (feeds domain_age) --------------------------------------------
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
// Emits whenever RDAP returns a registration date. No age cutoff — the
// registration date is the fact; "young vs old" is not a signal.
export function collectDomainAge(t, rdap) {
  if (!rdap) return null;
  const reg = (rdap.events || []).find((e) => e.eventAction === 'registration');
  if (!reg || !reg.eventDate) return null;
  const ageDays = Math.floor((Date.now() - new Date(reg.eventDate)) / 86400000);
  return {
    hook_id: 'domain_age',
    label: `Registered ${String(reg.eventDate).slice(0, 10)}`,
    payload: {
      domain: t.domain,
      registered_date: reg.eventDate,
      age_days: Number.isFinite(ageDays) && ageDays >= 0 ? ageDays : null,
    },
    confidence: 0.95, // RDAP registration date is an authoritative record
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

// Web search via Tavily (https://tavily.com), the news lane's source. Set
// TAVILY_API_KEY to light it up; without the key this returns [] and the
// lane stays dark — the deterministic lane still produces hooks. News topic
// + last-month window is tuned for the company_news / dossier_negation hooks.
async function searchWeb(company) {
  if (!company) return [];
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: `${company} news`,
        topic: 'news',
        time_range: 'month',
        max_results: 6,
        include_answer: false,
      }),
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.results || []).slice(0, 6).map((x) => ({
      title: x.title,
      snippet: x.content || '',
      url: x.url,
      date: x.published_date || null,
    }));
  } catch {
    return [];
  }
}

// ---- small deterministic helpers ----------------------------------------
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

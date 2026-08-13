#!/usr/bin/env node
/**
 * SpamViking — Bits Validator
 * Lints _bits_registry.js and _bits_directives.js before deploy.
 * Exit 0 = clean. Exit 1 = errors found.
 */

const fs = require('fs');

let exitCode = 0;
const fail = (msg) => { console.error('[FAIL] ' + msg); exitCode = 1; };
const warn = (msg) => console.warn('[WARN] ' + msg);
const ok   = (msg) => console.log('[OK]   ' + msg);

// ─── Registry ─────────────────────────────────────────────────────────────────

const registrySrc = fs.readFileSync('_bits_registry.js', 'utf8');
const arrMatch = registrySrc.match(/export const BITS = (\[[\s\S]*?\]);/);

if (!arrMatch) {
  fail('_bits_registry.js: cannot find "export const BITS = [...]"');
} else {
  let bits;
  try {
    bits = JSON.parse(arrMatch[1]);
    ok(`Registry parses: ${bits.length} entries`);
  } catch (e) {
    fail(`_bits_registry.js JSON error: ${e.message}`);
    bits = null;
  }

  if (bits) {
    const seenIds = new Set();

    for (const b of bits) {
      if (seenIds.has(b.id)) fail(`Duplicate id: ${b.id}`);
      seenIds.add(b.id);

      for (const f of ['id','name','status','cooldown']) {
        if (b[f] === undefined) fail(`${b.id}: missing "${f}"`);
      }

      if (!['active','parked','retired'].includes(b.status)) {
        fail(`${b.id}: invalid status "${b.status}"`);
      }

      // Dead fields
      const dead = ['gear','pressure','engagement','suspicion','accusations',
                    'tones','latest_turn','earliest_turn'];
      for (const f of dead) {
        if (b[f] !== undefined) fail(`${b.id}: dead field "${f}" — strip it`);
      }

      // rung_spacing brace bug detection
      if (b.rung_spacing) {
        const illegal = ['pool','phase_pref','trigger','lane','stall_type','ceiling'];
        for (const f of illegal) {
          if (b.rung_spacing[f] !== undefined) {
            fail(`${b.id}: rung_spacing contains illegal field "${f}" — brace bug`);
          }
        }
      }
    }

    const active = bits.filter(b=>b.status==='active').length;
    const parked = bits.filter(b=>b.status==='parked').length;
    ok(`Status breakdown: ${active} active, ${parked} parked`);
    ok('No stale gear fields');
    ok('All required fields present');
  }
}

// ─── Directives ───────────────────────────────────────────────────────────────

const dirSrc = fs.readFileSync('_bits_directives.js', 'utf8');

if (!dirSrc.includes('export default {')) {
  fail('_bits_directives.js: missing "export default {"');
}

// Missing commas between entries
const missingCommas = [];
const commaRe = /`\s*\n\n"BIT-/g;
let cm;
while ((cm = commaRe.exec(dirSrc)) !== null) {
  const lineNo = dirSrc.slice(0, cm.index).split('\n').length;
  missingCommas.push(lineNo);
}
if (missingCommas.length) {
  fail(`_bits_directives.js: ${missingCommas.length} missing commas between entries`);
} else {
  ok('Directives: no missing comma errors');
}

const keyMatches = [...dirSrc.matchAll(/"(BIT-[0-9]+[a-z]?)"\s*:/g)];
ok(`Directives: ${keyMatches.length} entries found`);

// Split into lines for per-line checks
const dirLines = dirSrc.split('\n');

// Lines that are prohibition text — skip for content checks
const PROHIBITION_RE = /hard:|never\s|do not|banned|not.*say|avoid|no[t]?\s["']|prohibited|do not emit|not a real marker|^\/\//i;

// ─── [LAUGHS] — HARD FAIL ─────────────────────────────────────────────────────
// [LAUGHS] is not a real sound marker. Nothing plays. Zero tolerance.
const laughsRe = /\[LAUGHS\]/i;
const laughsHits = [];
for (let i = 0; i < dirLines.length; i++) {
  const line = dirLines[i];
  if (PROHIBITION_RE.test(line)) continue;
  if (laughsRe.test(line)) {
    laughsHits.push(`Line ${i+1}: ${line.trim().slice(0,70)}`);
  }
}
if (laughsHits.length) {
  laughsHits.forEach(h => fail(`[LAUGHS] token — not a real marker, nothing plays: ${h}`));
} else {
  ok('No [LAUGHS] tokens in directives');
}

// ─── Banned phrases — WARNING ─────────────────────────────────────────────────
const BANNED = [
  'happy to help', 'glad to help', 'great question', 'good question',
  "that's a great point", 'I understand your concern', 'I appreciate that',
  'how can I help you today', 'is there anything else', 'let me assist',
  'heads down', 'heads-down', 'circle back', 'touch base',
  "that makes sense", "I'm here", "phew", "\"ha\"",
  'anyway,', 'anyways', 'where were we', 'okay, so',
  "I'll let you go", 'that about covers it', 'thanks for your time',
  "I should let you get back", 'have a good one',
  'great to reconnect', 'good to hear your voice again',
  '*laughs*', '*pauses*', '*sighs*',
];

const bannedHits = [];
for (let i = 0; i < dirLines.length; i++) {
  const line = dirLines[i];
  if (PROHIBITION_RE.test(line)) continue;
  for (const phrase of BANNED) {
    if (line.toLowerCase().includes(phrase.toLowerCase())) {
      bannedHits.push(`Line ${i+1}: "${phrase}" — ${line.trim().slice(0,60)}`);
    }
  }
}
if (bannedHits.length) {
  bannedHits.forEach(h => warn(`Banned phrase in directive: ${h}`));
} else {
  ok('No banned phrases found in directives');
}

// ─── Result ───────────────────────────────────────────────────────────────────

console.log('');
if (exitCode === 0) {
  console.log('✓ Validation passed — safe to deploy');
} else {
  console.log('✗ Validation FAILED — do not deploy until errors are fixed');
}

process.exit(exitCode);

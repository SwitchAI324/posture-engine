#!/usr/bin/env node
/**
 * SpamViking — Bits Validator
 * 
 * Lints _bits_registry.js and _bits_directives.js before deploy.
 * Run this before every upload to catch structural bugs that would
 * break Vercel's build.
 * 
 * Usage:
 *   node validate_bits.js
 * 
 * Exit code 0 = clean. Exit code 1 = errors found (do not deploy).
 * Warnings are printed but do not block deploy.
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
    let gearCount = 0;
    let missingFields = 0;

    for (const b of bits) {
      // Duplicate IDs
      if (seenIds.has(b.id)) fail(`Duplicate id: ${b.id}`);
      seenIds.add(b.id);

      // Required fields
      for (const f of ['id','name','status','cooldown']) {
        if (b[f] === undefined) { fail(`${b.id}: missing "${f}"`); missingFields++; }
      }

      // Status values
      if (!['active','parked','retired'].includes(b.status)) {
        fail(`${b.id}: invalid status "${b.status}"`);
      }

      // Stale/dead fields — confirmed non-functional per PE Aug 5
      const dead = ['gear','pressure','engagement','suspicion','accusations',
                    'tones','latest_turn','earliest_turn'];
      for (const f of dead) {
        if (b[f] !== undefined) fail(`${b.id}: dead field "${f}" — strip it`);
      }

      // Brace bug detection: check that rung_spacing doesn't contain pool/phase_pref etc
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
    if (gearCount === 0) ok('No stale gear fields');
    if (missingFields === 0) ok('All required fields present');
  }
}

// ─── Directives ───────────────────────────────────────────────────────────────

const dirSrc = fs.readFileSync('_bits_directives.js', 'utf8');

// Check export default exists
if (!dirSrc.includes('export default {')) {
  fail('_bits_directives.js: missing "export default {"');
}

// Check for missing commas between entries (the reported bug)
// Pattern: backtick end of entry, blank line, then next key without comma
const missingCommas = [];
const commaRe = /`\s*\n\n"BIT-/g;
let cm;
while ((cm = commaRe.exec(dirSrc)) !== null) {
  const lineNo = dirSrc.slice(0, cm.index).split('\n').length;
  missingCommas.push(lineNo);
}
if (missingCommas.length) {
  fail(`_bits_directives.js: ${missingCommas.length} missing commas between entries (lines: ${missingCommas.slice(0,5).join(', ')}${missingCommas.length>5?'...':''})`);
} else {
  ok('Directives: no missing comma errors');
}

// Count directives
const keyMatches = [...dirSrc.matchAll(/"(BIT-[0-9]+[a-z]?)"\s*:/g)];
ok(`Directives: ${keyMatches.length} entries found`);

// Check for banned phrases in directive text
// Skip lines that are prohibition text (hard rules telling host NOT to say something)
const BANNED = [
  // B - model voice
  'happy to help', 'glad to help', 'great question', 'good question',
  "that's a great point", 'I understand your concern', 'I appreciate that',
  'how can I help you today', 'is there anything else', 'let me assist',
  // B - office status jargon
  'heads down', 'heads-down', 'circle back', 'touch base',
  // C - dead air
  "that makes sense", "I'm here",
  // D - reset tics
  'anyway,', 'anyways', 'where were we', 'okay, so',
  // E - call ending
  "I'll let you go", 'that about covers it', 'thanks for your time',
  "I should let you get back", 'have a good one',
  // F - false familiarity
  'great to reconnect', 'good to hear your voice again',
  // G - stage directions
  '*laughs*', '*pauses*', '*sighs*', '[LAUGHS]',
];

// Lines that are prohibition text — skip them
const PROHIBITION_RE = /hard:|never\s|do not|banned|not.*say|avoid|no[t]?\s["']|prohibited/i;

const bannedHits = [];
const dirLines = dirSrc.split('\n');
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

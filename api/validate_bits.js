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

      // Stale gear fields
      if (b.gear) { fail(`${b.id}: stale "gear" field — remove`); gearCount++; }

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
const BANNED = [
  'where were we', 'anyway,', 'anyways', "I'm here",
  "that makes sense", "mm-hmm", "uh-huh", "yep yep",
  "I'll let you go", "great to reconnect", "happy to help",
  "of course,", "certainly,", "absolutely,"
];
const bannedHits = [];
for (const phrase of BANNED) {
  const re = new RegExp(phrase, 'gi');
  const matches = [...dirSrc.matchAll(re)];
  if (matches.length) {
    matches.forEach(m => {
      const lineNo = dirSrc.slice(0, m.index).split('\n').length;
      bannedHits.push(`Line ${lineNo}: "${phrase}"`);
    });
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

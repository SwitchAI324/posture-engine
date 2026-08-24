// api/bits.js — serves the bits registry as browser-readable JSON, so
// Mead Hall can resolve bit metadata (name, family, rungs, sound_markers,
// arc_protection, etc.) without hardcoding any of it client-side.
// Edge runtime, matching control.js/mint-token.js/call-stream.js's style
// in this api/ folder.
//
// USAGE:
//   GET /api/bits          -> the full registry array
//   GET /api/bits?id=BIT-302 -> just that one bit, as a single-element array
//
// IMPLEMENTATION NOTE (Publishing's original spec had this pointed at
// '../api/_bits_registry.js' — that path is wrong for a file living in
// api/ itself. _bits_registry.js sits in api/ directly (confirmed:
// completions.js, one level down in api/compiler/, imports it as
// '../_bits_registry.js') — so a file at api/bits.js needs the same-
// directory path, './_bits_registry.js', not a path that walks back into
// a nonexistent nested api/ folder. Fixed here, not copied as given.
//
// No DB, no new dependency — BITS is already a plain, JSON-serializable
// array (confirmed: no functions, no circular structure), so this is
// pure pass-through. Cached client-side for 60s via Cache-Control,
// matching the spec's original intent.

import { BITS } from "./_bits_registry.js";

export const config = { runtime: "edge" };

export default function handler(req) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const result = id ? BITS.filter((b) => b.id === id) : BITS;
  return new Response(JSON.stringify(result), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}

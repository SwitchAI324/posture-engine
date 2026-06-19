// api/scout/ammo.js
// Read-only test endpoint for the ammo rack. GET /api/scout/ammo?slug=...
// returns exactly what PE would see at call start. Lets you verify the read
// path in the browser, the same way you tested the write.
//
// This is scaffolding. PE itself should import readAmmunition from _read.js
// (a function call, no HTTP hop) rather than fetch this endpoint. Safe to
// delete once PE is wired.

import { readAmmunition } from './_read.js';

export default async function handler(req, res) {
  // Same optional guard as start.js. If SV_SCOUT_TOKEN is unset, open.
  const expected = process.env.SV_SCOUT_TOKEN;
  if (expected && req.headers['x-sv-scout-token'] !== expected)
    return res.status(401).json({ error: 'bad token' });

  const slug = req.query && req.query.slug;
  if (!slug) return res.status(400).json({ error: 'slug required' });

  const { ammunition, byHook } = await readAmmunition(slug);
  return res.status(200).json({ slug, ammunition, byHook });
}

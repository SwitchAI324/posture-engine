// api/voice/set-voice.js — saves the caller's chosen host voice_id
// Auth: Supabase Bearer session token in Authorization header.
// Expects body: { voice_id: string }
// Never accepts user_id from the request body.

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://live.spamviking.com')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // 1. Verify session token
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  if (!token) return res.status(401).json({ error: 'Missing auth token' })

  const anonClient = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  const { data: { user }, error: authErr } = await anonClient.auth.getUser(token)
  if (authErr || !user) return res.status(401).json({ error: 'Invalid session' })

  const email = user.email
  if (!email) return res.status(401).json({ error: 'No email on session' })

  // 2. Validate voice_id from body
  const { voice_id } = req.body || {}
  if (!voice_id || typeof voice_id !== 'string') {
    return res.status(400).json({ error: 'voice_id is required' })
  }

  // 3. Service-key client for privileged RPCs
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  // 4. Resolve SpamViking user_id from verified email
  const { data: uid, error: uidErr } = await sb.rpc('user_id_by_email', { p_email: email })
  if (uidErr) return res.status(500).json({ error: 'user_id lookup failed: ' + uidErr.message })
  if (!uid) return res.status(404).json({ error: 'No SpamViking account for this email' })

  // 5. Save voice choice
  const { error: setErr } = await sb.rpc('set_user_host_voice', {
    p_user_id: uid,
    p_voice_id: voice_id
  })
  if (setErr) return res.status(500).json({ error: 'set_user_host_voice failed: ' + setErr.message })

  return res.status(200).json({ ok: true })
}

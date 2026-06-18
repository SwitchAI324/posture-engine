# SpamViking booking page — engine-first slice

This is the working skeleton of the booking page that replaces Calendly. It does
the three jobs Calendly did: shows times, takes the booking, and hands off to the
call. It's deliberately plain — the Fiji-blackout calendar, the "just taken"
trick, and the Barbara chat get layered on later. The point of this version is
that the whole path runs end to end and the raw-Vapi-URL leak is gone.

You upload these files as-is. No build step, nothing to install.

## What's in here

- `book.html` — the page the scammer sees at `spamviking.io/book/<slug>`.
- `join.html` — the page they hit to join the call, at `.../join/<slug>`.
- `api/render.js` — reads the booking token and returns only the safe-to-show
  bits (never the scam type or the rigged numbers).
- `api/book.js` — when they pick a time, hands the booking to your Apps Script
  so the existing invite/ICS machinery fires. Your invite code does NOT move.
- `api/start.js` — the join bridge: calls PE's `/api/join`, which mints the
  Vapi call. The scammer never sees a Vapi URL.
- `vercel.json` — makes the clean `/book/<slug>` and `/join/<slug>` web
  addresses work.

## How to put it live (all in the browser)

1. Put these files in a GitHub repo (drag-and-drop upload is fine). Keep the
   folder layout exactly — `api` stays a folder.
2. In Vercel, create a new project from that repo. It deploys automatically.
3. Point your domain at it: Vercel project → Settings → Domains → add
   `spamviking.io` (or a subdomain). Follow Vercel's on-screen DNS step.
4. Add four settings: Vercel project → Settings → Environment Variables. Add
   each, scope = Production, then redeploy:
   - `SUPABASE_URL` — your Supabase project URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — the Supabase service-role key (the private
     one). This stays server-side; it's never sent to the browser.
   - `APPS_SCRIPT_EXEC_URL` — your Apps Script Web App `/exec` URL.
   - `POSTURE_ENGINE_BASE` — PE's site, e.g. `https://posture-engine.vercel.app`.
5. Redeploy once (Deployments → latest → Redeploy) so the settings load.

## Two pieces that have to be wired on the other side first

This page is ready, but two things it talks to need a small change before the
full path works end to end:

- **Email layer (Apps Script):** add the small branch in `doPost` that accepts
  `{ source:"sv_page", slug, email, slot, name }` and runs `markBooked_`, and
  change `markBooked_` to match the target **by slug** (not email). Until then,
  `api/book.js` will reach `/exec` but the booking won't be recorded.
- **PE (`/api/join`):** the smoke-test ("does it say crypto or universal") locks
  the exact response shape. `join.html` already handles the common cases; the
  one marked spot finalizes once that's confirmed.

## What still comes later (the "paint")

- The authored "Andrew's in Fiji" blacked-out calendar (real `slot_pool` pools).
- The "that slot was just taken" trick.
- The Barbara "nothing works for me" chat.
- These all sit on top of this skeleton — none of it gets rebuilt.

## Don't flip `USE_BOOKING_TOKENS` until this is live

Turning that flag on makes Barbara email the `book/<slug>` link. That link only
works once this page is deployed. So: deploy this first, confirm a test booking
works, then flip the flag.

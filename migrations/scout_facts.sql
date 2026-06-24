-- migrations/scout_facts.sql
-- The dissection-lane fact store. Append model: extracted_at is a retention
-- clock, so each dissection run inserts fresh rows. Holds extracted facts
-- only — never the raw email body or the attachment file.
--
-- Data may have already created this. If so, confirm the column names match
-- what _facts.js writes: target_id, source_lane, facts, extracted_at. Only
-- run this block if the table does NOT already exist.

create table if not exists public.scout_facts (
  id           uuid primary key default gen_random_uuid(),
  target_id    uuid not null references public.targets(id),
  source_lane  text not null,          -- 'body' | 'signature' | 'attachment' | 'web' | 'call'
  facts        jsonb not null default '{}'::jsonb,
  call_id      text,                   -- join key, matches engagement_events.call_id
  extracted_at timestamptz not null default now()
);

create index if not exists scout_facts_target_idx
  on public.scout_facts(target_id);

-- Partial index: call_id is only set on the post-call lane.
create index if not exists scout_facts_call_idx
  on public.scout_facts(call_id) where call_id is not null;

-- Derived state on targets, stamped in the same write as the call's facts:
--   alter table public.targets add column if not exists
--     last_call_scouted_at timestamptz;
-- (Data owns the targets table; this is here for reference, already applied.)

-- Service-role only, same as scout_hooks. The Node functions use the secret
-- key (RLS bypass); browsers get nothing.
alter table public.scout_facts enable row level security;

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
  source_lane  text not null,          -- 'body' | 'signature' | 'attachment' | 'web'
  facts        jsonb not null default '{}'::jsonb,
  extracted_at timestamptz not null default now()
);

create index if not exists scout_facts_target_idx
  on public.scout_facts(target_id);

-- Service-role only, same as scout_hooks. The Node functions use the secret
-- key (RLS bypass); browsers get nothing.
alter table public.scout_facts enable row level security;

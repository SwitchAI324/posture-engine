-- migrations/scout_hooks.sql
-- The ammunition table PE reads at call start. One live row per hook per
-- slug; re-scouting upserts. Only gate-passing hooks are ever written.

create table if not exists public.scout_hooks (
  slug        text         not null,
  hook_id     text         not null,
  label       text         not null,
  payload     jsonb        not null default '{}'::jsonb,
  confidence  numeric(3,2) not null,
  source      text         not null,
  created_at  timestamptz  not null default now(),
  primary key (slug, hook_id)
);

-- The PK (slug, hook_id) already serves `where slug = ...` reads, so no
-- separate index is needed.

-- Deny-by-default. No anon/authenticated policies, so browsers get nothing.
-- The Node functions (Scouting writes, PE reads) use the secret key, which
-- bypasses RLS. Consistent with CONFIG_REGISTRY: scout_hooks is server-only.
alter table public.scout_hooks enable row level security;

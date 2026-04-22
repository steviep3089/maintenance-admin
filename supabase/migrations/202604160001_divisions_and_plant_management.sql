-- Divisions, user assignments, and plant assets (non-breaking rollout)

create extension if not exists pgcrypto;

create table if not exists public.divisions (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  constraint divisions_name_unique unique (name)
);

create table if not exists public.user_divisions (
  user_id uuid not null references auth.users (id) on delete cascade,
  division_id uuid not null references public.divisions (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, division_id)
);

create table if not exists public.plant_assets (
  id uuid primary key default gen_random_uuid(),
  asset_code text not null,
  display_name text,
  division_id uuid not null references public.divisions (id) on delete restrict,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint plant_assets_asset_code_unique unique (asset_code)
);

-- Add optional references to defects for scoped filtering while preserving current fields.
alter table public.defects
  add column if not exists division_id uuid references public.divisions (id),
  add column if not exists plant_asset_id uuid references public.plant_assets (id);

-- Seed default division for existing Sitebatch data.
insert into public.divisions (name)
select 'Sitebatch'
where not exists (
  select 1 from public.divisions where lower(name) = 'sitebatch'
);

-- Backfill existing defects to Sitebatch division where empty.
update public.defects d
set division_id = s.id
from (
  select id
  from public.divisions
  where lower(name) = 'sitebatch'
  limit 1
) s
where d.division_id is null;

-- Seed plant assets from existing defect asset values where possible.
insert into public.plant_assets (asset_code, display_name, division_id)
select distinct
  trim(d.asset) as asset_code,
  trim(d.asset) as display_name,
  s.id as division_id
from public.defects d
cross join (
  select id
  from public.divisions
  where lower(name) = 'sitebatch'
  limit 1
) s
where coalesce(trim(d.asset), '') <> ''
on conflict (asset_code) do nothing;

-- RLS policies
alter table public.divisions enable row level security;
alter table public.user_divisions enable row level security;
alter table public.plant_assets enable row level security;

-- Divisions can be read by all authenticated users.
drop policy if exists divisions_select_authenticated on public.divisions;
create policy divisions_select_authenticated
on public.divisions
for select
to authenticated
using (true);

-- Users can read only their own division assignments.
drop policy if exists user_divisions_select_own on public.user_divisions;
create policy user_divisions_select_own
on public.user_divisions
for select
to authenticated
using (auth.uid() = user_id);

-- Plant assets can be read by authenticated users.
drop policy if exists plant_assets_select_authenticated on public.plant_assets;
create policy plant_assets_select_authenticated
on public.plant_assets
for select
to authenticated
using (is_active = true);

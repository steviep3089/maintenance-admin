-- Support assigning one plant asset to multiple divisions.

create table if not exists public.plant_asset_divisions (
  asset_id uuid not null references public.plant_assets (id) on delete cascade,
  division_id uuid not null references public.divisions (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (asset_id, division_id)
);

-- Backfill mappings from existing single division_id column.
insert into public.plant_asset_divisions (asset_id, division_id)
select pa.id, pa.division_id
from public.plant_assets pa
where pa.division_id is not null
on conflict (asset_id, division_id) do nothing;

alter table public.plant_asset_divisions enable row level security;

-- Authenticated users can read mappings.
drop policy if exists plant_asset_divisions_select_authenticated on public.plant_asset_divisions;
create policy plant_asset_divisions_select_authenticated
on public.plant_asset_divisions
for select
to authenticated
using (true);

-- Admin and manager users can manage mappings.
drop policy if exists plant_asset_divisions_insert_admin on public.plant_asset_divisions;
create policy plant_asset_divisions_insert_admin
on public.plant_asset_divisions
for insert
to authenticated
with check (
  exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'manager')
  )
);

drop policy if exists plant_asset_divisions_delete_admin on public.plant_asset_divisions;
create policy plant_asset_divisions_delete_admin
on public.plant_asset_divisions
for delete
to authenticated
using (
  exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'manager')
  )
);

-- Fix Plant Management write access and seed full Sitebatch defaults.

-- Ensure all original Sitebatch assets exist.
with sitebatch as (
  select id
  from public.divisions
  where lower(name) = 'sitebatch'
  limit 1
)
insert into public.plant_assets (asset_code, display_name, division_id, is_active)
select seed.asset_code, seed.display_name, sitebatch.id, true
from sitebatch
cross join (
  values
    ('BX22', 'BX22'),
    ('BX33', 'BX33'),
    ('BX64', 'BX64'),
    ('MM2', 'MM2'),
    ('MM3', 'MM3'),
    ('RMX1', 'RMX1'),
    ('FOAM MIX PLANT', 'FOAM MIX PLANT'),
    ('TWIN SILO', 'TWIN SILO'),
    ('CEMENT TANKER', 'CEMENT TANKER')
) as seed(asset_code, display_name)
on conflict (asset_code) do nothing;

-- Read access (keep existing behavior for authenticated users).
drop policy if exists plant_assets_select_authenticated on public.plant_assets;
create policy plant_assets_select_authenticated
on public.plant_assets
for select
to authenticated
using (is_active = true);

-- Allow only admin/manager users in user_roles to manage plant assets.
drop policy if exists plant_assets_insert_admin on public.plant_assets;
create policy plant_assets_insert_admin
on public.plant_assets
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

drop policy if exists plant_assets_update_admin on public.plant_assets;
create policy plant_assets_update_admin
on public.plant_assets
for update
to authenticated
using (
  exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'manager')
  )
)
with check (
  exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'manager')
  )
);

drop policy if exists plant_assets_delete_admin on public.plant_assets;
create policy plant_assets_delete_admin
on public.plant_assets
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

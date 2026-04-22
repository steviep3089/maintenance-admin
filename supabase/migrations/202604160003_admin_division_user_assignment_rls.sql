-- Allow admin and manager users to manage divisions and user_divisions.

-- Divisions management policies for admin/manager.
drop policy if exists divisions_insert_admin on public.divisions;
create policy divisions_insert_admin
on public.divisions
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

drop policy if exists divisions_update_admin on public.divisions;
create policy divisions_update_admin
on public.divisions
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

drop policy if exists divisions_delete_admin on public.divisions;
create policy divisions_delete_admin
on public.divisions
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

-- Keep existing own-user read policy, and add admin read/manage policies.
drop policy if exists user_divisions_select_admin on public.user_divisions;
create policy user_divisions_select_admin
on public.user_divisions
for select
to authenticated
using (
  exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'manager')
  )
);

drop policy if exists user_divisions_insert_admin on public.user_divisions;
create policy user_divisions_insert_admin
on public.user_divisions
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

drop policy if exists user_divisions_delete_admin on public.user_divisions;
create policy user_divisions_delete_admin
on public.user_divisions
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

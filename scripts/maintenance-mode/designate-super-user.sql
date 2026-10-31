-- Designate the ONE Maintenance Mode Super User. Run in the Supabase SQL editor (as postgres) of the
-- target project, after 20261030_maintenance_mode_setting.sql. TESTING first; LIVE needs owner approval.
-- Replace the placeholder email below. The person must already have the 'admin' role in user_roles;
-- this script does not create or change any role. Re-running replaces the previous Super User.
do $$
declare
  v_email constant text := 'REPLACE_WITH_SUPER_USER_EMAIL';
  v_user uuid;
begin
  select u.id into v_user
  from auth.users u
  join public.user_roles ur on ur.user_id = u.id and ur.role = 'admin'
  where lower(u.email) = lower(v_email);

  if v_user is null then
    raise exception 'No admin user found for that email; nothing was changed.';
  end if;

  insert into public.maintenance_super_user (id, user_id)
  values (true, v_user)
  on conflict (id) do update set user_id = excluded.user_id, designated_at = now();
end;
$$;

-- Verify (read-only):
-- select user_id, designated_at from public.maintenance_super_user;

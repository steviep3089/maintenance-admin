-- Maintenance Mode write enforcement: APPLY. TESTING ONLY (etffoumsopxjptnmhvwh). NOT in supabase/migrations
-- on purpose: `supabase db push` must never pick it up, and it must never be run against LIVE.
--
-- Run ONLY after the owner has explicitly approved it. Run in the TESTING SQL editor as `postgres`.
-- Roll back with 20261030_maintenance_mode_enforcement_TESTING_rollback.sql.
--
-- What it does (all-or-nothing, one transaction):
--   * creates public.maintenance_blocks_writes() (read-only, SECURITY DEFINER, empty search_path)
--   * creates 9 RESTRICTIVE policies: INSERT/UPDATE/DELETE on public.defects, public.defect_activity and
--     storage.objects (the defect-photos and repair-photos buckets only), for roles anon and authenticated.
-- RESTRICTIVE policies are AND-ed with every existing permissive policy, so they can only REMOVE access.
-- While maintenance is OFF the helper returns false and every existing permission is unchanged.
-- Only the designated Super User is exempt while it is ON. SELECT is not restricted. Not touched: existing
-- policies, grants, user_roles, auth, notification functions/triggers/cron, the secret-key Edge Functions.
--
-- Safeguards: it aborts (changing nothing) unless maintenance is OFF, a valid Super User exists and none of the
-- objects already exist. It never GRANTs anything and never changes ownership.
--
-- storage.objects is owned by supabase_storage_admin (the SQL editor's `postgres` is not the owner and, in TESTING,
-- is not a member). The storage policies are attempted as the current role, then via SET LOCAL ROLE
-- supabase_storage_admin (only if membership legitimately exists). If neither works the whole transaction aborts
-- and NOTHING is installed (no partial enforcement). Then STOP and report the message; do not grant roles.
begin;

set local lock_timeout = '5s';

do $preflight$
declare
  v_enabled boolean;
  v_super int;
  v_super_ok int;
  v_existing int;
  v_policies int;
begin
  select m.enabled into v_enabled from public.maintenance_mode m where m.id = true;
  if v_enabled is distinct from false then
    raise exception 'Abort: Maintenance Mode must be OFF (found %). Nothing was changed.', coalesce(v_enabled::text, 'no row');
  end if;

  select count(*) into v_super from public.maintenance_super_user;
  select count(*) into v_super_ok
    from public.maintenance_super_user su
    join public.user_roles ur on ur.user_id = su.user_id and ur.role = 'admin'
    join auth.users u on u.id = su.user_id;
  if v_super <> 1 or v_super_ok <> 1 then
    raise exception 'Abort: exactly one valid admin Super User must be designated first. Nothing was changed.';
  end if;

  select count(*) into v_existing from pg_policies where policyname like 'maintenance\_block\_%';
  if v_existing <> 0 or to_regprocedure('public.maintenance_blocks_writes()') is not null then
    raise exception 'Abort: enforcement objects already exist. Run the rollback script first. Nothing was changed.';
  end if;

  if to_regclass('public.defects') is null or to_regclass('public.defect_activity') is null or to_regclass('storage.objects') is null then
    raise exception 'Abort: expected tables are missing. Wrong project? Nothing was changed.';
  end if;
  if not exists (select 1 from storage.buckets where id = 'defect-photos')
     or not exists (select 1 from storage.buckets where id = 'repair-photos') then
    raise exception 'Abort: photo bucket(s) missing. Wrong project? Nothing was changed.';
  end if;

  select count(*) into v_policies from pg_policies;
  perform set_config('maintenance_enforcement.policies_before', v_policies::text, true);
end
$preflight$;

-- Read-only: false when maintenance is OFF or the caller is the Super User; true otherwise.
create or replace function public.maintenance_blocks_writes()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select m.enabled from public.maintenance_mode m where m.id = true), false)
         and not exists (
           select 1 from public.maintenance_super_user su
           where su.user_id = auth.uid()
         );
$$;
revoke all on function public.maintenance_blocks_writes() from public;
grant execute on function public.maintenance_blocks_writes() to anon, authenticated;

create policy maintenance_block_defects_insert on public.defects
  as restrictive for insert to anon, authenticated with check (not public.maintenance_blocks_writes());
create policy maintenance_block_defects_update on public.defects
  as restrictive for update to anon, authenticated using (not public.maintenance_blocks_writes())
  with check (not public.maintenance_blocks_writes());
create policy maintenance_block_defects_delete on public.defects
  as restrictive for delete to anon, authenticated using (not public.maintenance_blocks_writes());

create policy maintenance_block_defect_activity_insert on public.defect_activity
  as restrictive for insert to anon, authenticated with check (not public.maintenance_blocks_writes());
create policy maintenance_block_defect_activity_update on public.defect_activity
  as restrictive for update to anon, authenticated using (not public.maintenance_blocks_writes())
  with check (not public.maintenance_blocks_writes());
create policy maintenance_block_defect_activity_delete on public.defect_activity
  as restrictive for delete to anon, authenticated using (not public.maintenance_blocks_writes());

-- storage.objects is owned by supabase_storage_admin on Supabase, so the three storage policies are created in a
-- DO block that tries, in order: (1) the current role (works if it may manage the table); (2) SET LOCAL ROLE
-- supabase_storage_admin, which only succeeds if this role legitimately holds that membership (nothing is granted
-- here, and the role switch is undone at the end of the block or on any failure). If both fail, the exception
-- aborts the WHOLE transaction, so the defects/defect_activity policies and the helper are rolled back too:
-- all nine policies are installed together or none are.
do $storage$
declare
  v_sql text[] := array[
$s$create policy maintenance_block_photo_objects_insert on storage.objects
  as restrictive for insert to anon, authenticated
  with check (bucket_id not in ('defect-photos','repair-photos') or not public.maintenance_blocks_writes());$s$,
$s$create policy maintenance_block_photo_objects_update on storage.objects
  as restrictive for update to anon, authenticated
  using (bucket_id not in ('defect-photos','repair-photos') or not public.maintenance_blocks_writes())
  with check (bucket_id not in ('defect-photos','repair-photos') or not public.maintenance_blocks_writes());$s$,
$s$create policy maintenance_block_photo_objects_delete on storage.objects
  as restrictive for delete to anon, authenticated
  using (bucket_id not in ('defect-photos','repair-photos') or not public.maintenance_blocks_writes());$s$];
  v_s text;
  v_done boolean := false;
begin
  begin
    foreach v_s in array v_sql loop execute v_s; end loop;
    v_done := true;
  exception when insufficient_privilege then
    null;  -- the sub-transaction rollback undoes anything partially created
  end;

  if not v_done then
    begin
      set local role supabase_storage_admin;
      foreach v_s in array v_sql loop execute v_s; end loop;
      reset role;
      v_done := true;
    exception when others then
      null;  -- role switch refused or creation failed: sub-transaction rolled back, role restored
    end;
  end if;

  if not v_done then
    raise exception 'Abort: could not create the storage.objects policies as % (owner supabase_storage_admin, role switch not permitted). Nothing was changed. Do not grant roles or change ownership; report this message.', current_user;
  end if;
end
$storage$;

do $postcheck$
declare
  v_before int := current_setting('maintenance_enforcement.policies_before')::int;
  v_after int;
  v_restrictive int;
begin
  select count(*) into v_after from pg_policies;
  select count(*) into v_restrictive from pg_policies
    where policyname like 'maintenance\_block\_%' and permissive = 'RESTRICTIVE';
  if v_restrictive <> 9 or v_after <> v_before + 9 then
    raise exception 'Abort: expected exactly 9 new restrictive policies (found %, total % vs % before). Rolled back.', v_restrictive, v_after, v_before;
  end if;
  -- Run as the editor role (no JWT): maintenance is OFF, so nothing may be blocked.
  if public.maintenance_blocks_writes() is distinct from false then
    raise exception 'Abort: helper reports writes blocked while maintenance is OFF. Rolled back.';
  end if;
end
$postcheck$;

commit;

-- Next (read-only): run scripts/maintenance-mode/verify-existing-unchanged.sql (all six rows must still match the
-- earlier fingerprint) and scripts/maintenance-mode/check-enforcement-testing.sql.

-- Maintenance Mode write enforcement: EMERGENCY ROLLBACK. TESTING ONLY (etffoumsopxjptnmhvwh).
-- Removes ONLY the 9 maintenance_block_* policies and public.maintenance_blocks_writes(). It touches no
-- existing policy, grant, table, maintenance_* table, role, notification object or cron job. Idempotent.
--
-- Fastest alternative if you only need writes back RIGHT NOW: scripts/maintenance-mode/emergency-off.sql
-- (turns Maintenance Mode OFF, which makes every restrictive policy pass). Use this file to remove the
-- enforcement entirely.
--
-- The function is dropped WITHOUT CASCADE on purpose: if anything unexpected depends on it, the drop fails and
-- the whole transaction rolls back instead of silently removing other objects.
begin;

set local lock_timeout = '5s';

drop policy if exists maintenance_block_defects_insert on public.defects;
drop policy if exists maintenance_block_defects_update on public.defects;
drop policy if exists maintenance_block_defects_delete on public.defects;

drop policy if exists maintenance_block_defect_activity_insert on public.defect_activity;
drop policy if exists maintenance_block_defect_activity_update on public.defect_activity;
drop policy if exists maintenance_block_defect_activity_delete on public.defect_activity;

-- storage.objects is owned by supabase_storage_admin: try the current role, then SET LOCAL ROLE (only if the
-- membership legitimately exists). If neither works the whole rollback aborts and changes nothing: use
-- emergency-off.sql (turns every restrictive policy into a pass) and report the message.
do $storage$
declare
  v_s text;
  v_done boolean := false;
  v_names text[] := array['maintenance_block_photo_objects_insert', 'maintenance_block_photo_objects_update', 'maintenance_block_photo_objects_delete'];
begin
  begin
    foreach v_s in array v_names loop execute format('drop policy if exists %I on storage.objects', v_s); end loop;
    v_done := true;
  exception when insufficient_privilege then
    null;
  end;
  if not v_done then
    begin
      set local role supabase_storage_admin;
      foreach v_s in array v_names loop execute format('drop policy if exists %I on storage.objects', v_s); end loop;
      reset role;
      v_done := true;
    exception when others then
      null;
    end;
  end if;
  if not v_done then
    raise exception 'Rollback aborted, nothing changed: cannot drop the storage.objects policies as %. Use scripts/maintenance-mode/emergency-off.sql to restore writes immediately, then report this message.', current_user;
  end if;
end
$storage$;

drop function if exists public.maintenance_blocks_writes();

do $postcheck$
begin
  if exists (select 1 from pg_policies where policyname like 'maintenance\_block\_%')
     or to_regprocedure('public.maintenance_blocks_writes()') is not null then
    raise exception 'Rollback incomplete; nothing was committed.';
  end if;
end
$postcheck$;

commit;

-- Verify (read-only): scripts/maintenance-mode/verify-existing-unchanged.sql must match the original fingerprint.

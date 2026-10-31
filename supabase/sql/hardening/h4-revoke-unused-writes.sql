-- DRAFT (not applied anywhere). Revoke write privileges no client uses (evidence: README, "Client write map").
--   anon          : INSERT/UPDATE/DELETE on the ten Maintenance tables listed below (every client writes as `authenticated`).
--   authenticated : INSERT/UPDATE/DELETE on user_roles, invite_digest_runs, invite_expiry_notifications
--                   (written only by Edge Functions / SECURITY DEFINER code, which do not use these grants).
-- RLS already denies these writes today (no matching policy); this removes the grant as a second layer.
-- Tables missing from the database are skipped. Roll back with h4-revoke-unused-writes-rollback.sql.
-- Run only after h3, and only after `h2-grants-inventory.sql` shows no BLOCK rows you have not reviewed.
-- TESTING first: delete the whole `do $live_guard$ ... $live_guard$;` block (it only stops a wrong-project run); keep it for LIVE.
begin;
set local lock_timeout = '5s';

do $live_guard$
declare
  v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'notify_defect_created'
  limit 1;
  if v_def is null or position('zebksrihswwwlejdiboq' in v_def) = 0 or position('etffoumsopxjptnmhvwh' in v_def) > 0 then
    raise exception 'Abort: this database does not look like the LIVE project (zebksrihswwwlejdiboq). Nothing was changed.';
  end if;
end
$live_guard$;

do $h4$
declare
  t text;
begin
  foreach t in array array['defects', 'defect_activity', 'user_roles', 'divisions', 'invite_digest_runs', 'invite_expiry_notifications',
                           'plant_asset_divisions', 'plant_assets', 'repairs', 'user_divisions'] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke insert, update, delete on table public.%I from anon', t);
    end if;
  end loop;
  foreach t in array array['user_roles', 'invite_digest_runs', 'invite_expiry_notifications'] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke insert, update, delete on table public.%I from authenticated', t);
    end if;
  end loop;

  -- the writes the apps depend on must still be granted
  if not (has_table_privilege('authenticated', 'public.defects', 'INSERT') and has_table_privilege('authenticated', 'public.defects', 'UPDATE')
          and has_table_privilege('authenticated', 'public.defect_activity', 'INSERT')) then
    raise exception 'Abort: a required authenticated write privilege on defects/defect_activity is missing. Rolled back.';
  end if;
end
$h4$;

commit;

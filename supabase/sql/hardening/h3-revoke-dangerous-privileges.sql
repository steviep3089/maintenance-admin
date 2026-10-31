-- DRAFT (not applied anywhere). Revoke privileges the Supabase Data API never uses and that bypass RLS:
-- TRUNCATE, REFERENCES, TRIGGER, MAINTAIN, from anon and authenticated, on public tables the API roles can read.
-- SELECT / INSERT / UPDATE / DELETE are NOT touched, so the Portal, mobile app, RLS policies and Maintenance Mode
-- behave exactly as before. service_role, postgres and SECURITY DEFINER functions are unaffected.
-- Run order: TESTING first (delete the whole `do $live_guard$ ... $live_guard$;` block, which only exists to stop
-- this file running on the wrong project), then LIVE with the block kept. Roll back with h3-revoke-dangerous-privileges-rollback.sql.
-- Changes table_grants_and_rls in live-02-baseline-fingerprint.sql ON PURPOSE: take a new baseline afterwards.
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

do $h3$
declare
  r record;
  v_select_before int;
  v_select_after int;
begin
  select count(*) into v_select_before
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated')) ro(rolname)
  where n.nspname = 'public' and c.relkind in ('r', 'p') and has_table_privilege(ro.rolname, c.oid, 'SELECT');

  for r in
    select c.oid::regclass as tbl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT'))
  loop
    execute format('revoke truncate, references, trigger, maintain on table %s from anon, authenticated', r.tbl);
  end loop;

  if exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    cross join (values ('anon'), ('authenticated')) ro(rolname)
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and (has_table_privilege(ro.rolname, c.oid, 'TRUNCATE') or has_table_privilege(ro.rolname, c.oid, 'REFERENCES')
           or has_table_privilege(ro.rolname, c.oid, 'TRIGGER') or has_table_privilege(ro.rolname, c.oid, 'MAINTAIN'))
  ) then
    raise exception 'Abort: dangerous privileges remain after the revoke. Rolled back.';
  end if;

  select count(*) into v_select_after
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  cross join (values ('anon'), ('authenticated')) ro(rolname)
  where n.nspname = 'public' and c.relkind in ('r', 'p') and has_table_privilege(ro.rolname, c.oid, 'SELECT');
  if v_select_before <> v_select_after then
    raise exception 'Abort: SELECT grants changed unexpectedly (% -> %). Rolled back.', v_select_before, v_select_after;
  end if;
end
$h3$;

commit;

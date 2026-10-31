-- ROLLBACK for h3-revoke-dangerous-privileges.sql. Re-grants TRUNCATE, REFERENCES, TRIGGER, MAINTAIN to anon and
-- authenticated on the same set of tables (public tables the API roles can read). No identity guard on purpose.
-- Note: this restores Supabase's default "all privileges" shape; a table that originally held only some of these four
-- would end up with all four (not observed on LIVE: every inventoried table held all of them).
begin;
set local lock_timeout = '5s';

do $h3rb$
declare
  r record;
begin
  for r in
    select c.oid::regclass as tbl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and (has_table_privilege('anon', c.oid, 'SELECT') or has_table_privilege('authenticated', c.oid, 'SELECT'))
  loop
    execute format('grant truncate, references, trigger, maintain on table %s to anon, authenticated', r.tbl);
  end loop;
end
$h3rb$;

commit;

-- READ-ONLY fingerprint of existing objects. TESTING project etffoumsopxjptnmhvwh only.
-- Run it BEFORE and AFTER 20261030_maintenance_mode_setting.sql; every row must be identical both times.
-- Returns hashes and counts only (no policy bodies, secrets or password hashes).

with
existing_policies as (
  select md5(string_agg(concat_ws('|', schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check),
                         E'\n' order by schemaname, tablename, policyname)) as h, count(*) as n
  from pg_policies
  where (schemaname, tablename) in (('public','defects'),('public','defect_activity'),('public','user_roles'),('storage','objects'),('storage','buckets'))
    and policyname not like 'maintenance\_block\_%'
),
existing_grants as (
  select md5(string_agg(concat_ws('|', n.nspname, c.relname, coalesce(c.relacl::text, ''), c.relrowsecurity::text, c.relforcerowsecurity::text),
                         E'\n' order by n.nspname, c.relname)) as h
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where (n.nspname, c.relname) in (('public','defects'),('public','defect_activity'),('public','user_roles'),('storage','objects'),('storage','buckets'))
),
existing_triggers as (
  select md5(coalesce(string_agg(concat_ws('|', c.relname, tg.tgname, tg.tgenabled::text), E'\n' order by c.relname, tg.tgname), '')) as h, count(*) as n
  from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_namespace n on n.oid = c.relnamespace
  where not tg.tgisinternal and n.nspname in ('public','storage') and c.relname not like 'maintenance\_%'
),
existing_functions as (
  select md5(coalesce(string_agg(concat_ws('|', p.oid::regprocedure::text, md5(p.prosrc), p.proacl::text, p.proconfig::text), E'\n' order by p.oid::regprocedure::text), '')) as h, count(*) as n
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname not like '%maintenance%'
),
cron_jobs as (
  select count(*) as n, md5(coalesce(string_agg(concat_ws('|', jobid, jobname, schedule, active::text), ',' order by jobid), '')) as h from cron.job
),
roles_state as (
  select md5(coalesce(string_agg(user_id::text || ':' || role, ',' order by user_id::text, role), '')) as h, count(*) as n from public.user_roles
)
select 'policies' as object, jsonb_build_object('hash', h, 'count', n) as detail from existing_policies
union all select 'table_grants_and_rls', jsonb_build_object('hash', h) from existing_grants
union all select 'triggers', jsonb_build_object('hash', h, 'count', n) from existing_triggers
union all select 'other_public_functions', jsonb_build_object('hash', h, 'count', n) from existing_functions
union all select 'cron_jobs', jsonb_build_object('hash', h, 'count', n) from cron_jobs
union all select 'user_roles', jsonb_build_object('hash', h, 'count', n) from roles_state
order by 1;

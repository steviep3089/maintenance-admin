-- READ-ONLY post-migration check for 20261030_maintenance_mode_setting.sql. TESTING (etffoumsopxjptnmhvwh) only.
-- Run AFTER the migration. Returns names, booleans and counts only.
-- Expected:
--   new_table: 4 rows; rls_enabled true; anon_privs false; authenticated_privs false; policy_count 0.
--   new_function: 6 rows. get_maintenance_status: anon+authenticated can call. set_maintenance_mode and
--     set_maintenance_password: authenticated only. The 3 *_audit_trg functions: nobody can call.
--   new_trigger: 3 rows, enabled 'O'.
--   default_state: maintenance_mode rows 1, enabled false; super_user_rows 0, credential_rows 0, audit_rows 0.

select 'new_table' as section, c.relname::text as object,
       jsonb_build_object('rls_enabled', c.relrowsecurity, 'rls_forced', c.relforcerowsecurity,
         'anon_privs', has_table_privilege('anon', c.oid, 'select,insert,update,delete'),
         'authenticated_privs', has_table_privilege('authenticated', c.oid, 'select,insert,update,delete'),
         'policy_count', (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname)) as detail
from pg_class c
where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
  and c.relname in ('maintenance_mode','maintenance_super_user','maintenance_credentials','maintenance_mode_audit')
union all
select 'new_function', p.oid::regprocedure::text,
       jsonb_build_object('security_definer', p.prosecdef,
         'search_path_pinned', coalesce(p.proconfig::text, '') like '%search_path%',
         'anon_can_call', has_function_privilege('anon', p.oid, 'execute'),
         'authenticated_can_call', has_function_privilege('authenticated', p.oid, 'execute'))
from pg_proc p
where p.pronamespace = 'public'::regnamespace and p.proname like '%maintenance%'
union all
select 'new_trigger', tg.tgname::text, jsonb_build_object('table', c.relname, 'enabled', tg.tgenabled)
from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
where not tg.tgisinternal and c.relname like 'maintenance\_%'
union all
select 'default_state', 'maintenance_mode',
       jsonb_build_object('rows', (select count(*) from public.maintenance_mode),
                          'enabled', (select enabled from public.maintenance_mode limit 1),
                          'has_message', (select message is not null from public.maintenance_mode limit 1))
union all
select 'default_state', 'unconfigured_security_tables',
       jsonb_build_object('super_user_rows', (select count(*) from public.maintenance_super_user),
                          'credential_rows', (select count(*) from public.maintenance_credentials),
                          'audit_rows', (select count(*) from public.maintenance_mode_audit))
order by 1, 2;

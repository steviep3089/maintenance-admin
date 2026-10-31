-- READ-ONLY diagnostic for the Maintenance guard 503. TESTING (etffoumsopxjptnmhvwh) only.
-- Returns booleans only. Run BEFORE and AFTER 20261030_maintenance_mode_service_role_grants.sql.
-- Expected BEFORE the fix (root-cause hypothesis): service_role_can_select_* = false.
-- Expected AFTER: mode/super_user true; credentials and audit false; anon/authenticated false; one mode row, OFF.
select 'service_role_can_select_maintenance_mode' as check_name,
       has_table_privilege('service_role', 'public.maintenance_mode', 'select') as value
union all select 'service_role_can_select_maintenance_super_user',
       has_table_privilege('service_role', 'public.maintenance_super_user', 'select')
union all select 'service_role_can_select_maintenance_credentials (must stay false)',
       has_table_privilege('service_role', 'public.maintenance_credentials', 'select')
union all select 'service_role_can_select_maintenance_mode_audit (must stay false)',
       has_table_privilege('service_role', 'public.maintenance_mode_audit', 'select')
union all select 'anon_or_authenticated_can_select_any_maintenance_table (must be false)',
       exists (
         select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join (values ('anon'), ('authenticated')) r(role_name)
         where n.nspname = 'public' and c.relname like 'maintenance\_%' and c.relkind = 'r'
           and has_table_privilege(r.role_name, c.oid, 'select')
       )
union all select 'service_role_bypasses_rls',
       (select rolbypassrls from pg_roles where rolname = 'service_role')
union all select 'maintenance_mode_row_is_single_and_off',
       (select count(*) = 1 and bool_and(not enabled) from public.maintenance_mode);

-- READ-ONLY policy/grant inventory for Maintenance Mode enforcement design.
-- Run in the TESTING project (etffoumsopxjptnmhvwh) SQL editor only. SELECT only; changes nothing.
-- Covers: public.defects, public.defect_activity, storage buckets 'defect-photos' and
-- 'repair-photos' (storage.objects), plus public.user_roles because the admin check depends on it.
-- Also lists SECURITY DEFINER functions in public (names/booleans only, no bodies) and role attributes.
-- Returns policy expressions and grants (no secrets are stored in these catalogs).

with
tbl(schema_name, table_name) as (
  values ('public','defects'), ('public','defect_activity'),
         ('storage','objects'), ('storage','buckets'), ('public','user_roles')
),
rel as (
  select 'rls_status' as section, t.schema_name || '.' || t.table_name as object,
         jsonb_build_object(
           'exists', c.oid is not null,
           'rls_enabled', c.relrowsecurity,
           'rls_forced', c.relforcerowsecurity,
           'owner', pg_get_userbyid(c.relowner)
         ) as detail
  from tbl t
  left join pg_namespace n on n.nspname = t.schema_name
  left join pg_class c on c.relnamespace = n.oid and c.relname = t.table_name and c.relkind in ('r','p')
),
pol as (
  select 'policy' as section, p.schemaname || '.' || p.tablename as object,
         jsonb_build_object(
           'name', p.policyname,
           'permissive', p.permissive,
           'roles', p.roles,
           'command', p.cmd,
           'using', p.qual,
           'with_check', p.with_check,
           'mentions_target_bucket',
             coalesce(p.qual, '') ~ '(defect-photos|repair-photos)'
             or coalesce(p.with_check, '') ~ '(defect-photos|repair-photos)'
         ) as detail
  from pg_policies p
  join tbl t on t.schema_name = p.schemaname and t.table_name = p.tablename
),
grants as (
  select 'table_grant' as section, n.nspname || '.' || c.relname as object,
         jsonb_build_object(
           'grantee', case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
           'privileges', array_agg(a.privilege_type order by a.privilege_type)
         ) as detail
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join tbl t on t.schema_name = n.nspname and t.table_name = c.relname
  cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
  where c.relkind in ('r','p')
    and (a.grantee = 0 or pg_get_userbyid(a.grantee) in ('anon','authenticated','service_role'))
  group by n.nspname, c.relname, a.grantee
),
trg as (
  select 'trigger' as section, n.nspname || '.' || c.relname as object,
         jsonb_build_object(
           'name', tg.tgname,
           'enabled', tg.tgenabled,
           'function', tp.pronamespace::regnamespace::text || '.' || tp.proname,
           'function_security_definer', tp.prosecdef
         ) as detail
  from pg_trigger tg
  join pg_class c on c.oid = tg.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_proc tp on tp.oid = tg.tgfoid
  join tbl t on t.schema_name = n.nspname and t.table_name = c.relname
  where not tg.tgisinternal
),
bkt as (
  select 'bucket' as section, b.id as object,
         jsonb_build_object(
           'name', b.name,
           'public', b.public,
           'file_size_limit', b.file_size_limit,
           'allowed_mime_types', b.allowed_mime_types
         ) as detail
  from storage.buckets b
  where b.id in ('defect-photos', 'repair-photos')
),
bkt_missing as (
  select 'bucket_missing' as section, x.bucket as object, '{}'::jsonb as detail
  from (values ('defect-photos'), ('repair-photos')) x(bucket)
  where not exists (select 1 from storage.buckets b where b.id = x.bucket)
),
roles_summary as (
  select 'user_roles_values' as section, 'public.user_roles' as object,
         jsonb_build_object('role', ur.role, 'count', count(*)) as detail
  from public.user_roles ur
  group by ur.role
),
definer_fns as (
  -- Names and booleans only; function bodies are never returned.
  select 'definer_function' as section,
         p.pronamespace::regnamespace::text || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as object,
         jsonb_build_object(
           'owner', pg_get_userbyid(p.proowner),
           'search_path_pinned', coalesce(p.proconfig::text, '') like '%search_path%',
           'touches_target_tables', p.prosrc ~* '(defects|defect_activity|user_roles|storage\.objects|maintenance_)',
           'anon_can_call', has_function_privilege('anon', p.oid, 'EXECUTE'),
           'authenticated_can_call', has_function_privilege('authenticated', p.oid, 'EXECUTE')
         ) as detail
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prosecdef
),
role_attrs as (
  select 'role_attribute' as section, r.rolname::text as object,
         jsonb_build_object('superuser', r.rolsuper, 'bypass_rls', r.rolbypassrls) as detail
  from pg_roles r
  where r.rolname in ('postgres', 'anon', 'authenticated', 'service_role', 'supabase_admin', 'authenticator')
)
select section, object, detail
from (
  select * from rel
  union all select * from pol
  union all select * from grants
  union all select * from trg
  union all select * from bkt
  union all select * from bkt_missing
  union all select * from roles_summary
  union all select * from definer_fns
  union all select * from role_attrs
) all_rows
order by section, object, detail::text;

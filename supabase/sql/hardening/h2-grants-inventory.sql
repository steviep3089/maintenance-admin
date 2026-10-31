-- READ-ONLY grant / RLS inventory for every ordinary table in schema public. SELECT only; changes nothing.
-- Run in LIVE and TESTING and compare. For each table: RLS state, number of write policies, the privileges held by
-- anon and authenticated, and flags for the privileges the Data API never needs.
-- Status: BLOCK = a write privilege with RLS off (anyone can write); REVIEW = dangerous privileges present
-- (TRUNCATE/TRIGGER/REFERENCES/MAINTAIN bypass RLS or are never used by the app) or writes without a matching policy.
with t as (
  select c.oid, c.relname, c.relrowsecurity as rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
),
p as (
  select t.oid, t.relname, t.rls, r.rolname,
         (select string_agg(x, ',' order by x) from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) x
           where has_table_privilege(r.oid, t.oid, x)) as privs
  from t cross join (select oid, rolname from pg_roles where rolname in ('anon', 'authenticated')) r
),
pol as (
  select tablename, count(*) filter (where cmd in ('INSERT', 'ALL')) as ins, count(*) filter (where cmd in ('UPDATE', 'ALL')) as upd,
         count(*) filter (where cmd in ('DELETE', 'ALL')) as del
  from pg_policies where schemaname = 'public' group by tablename
)
select p.relname as table_name, p.rolname as role, p.rls as rls_enabled, coalesce(p.privs, '(none)') as privileges,
       coalesce(pol.ins, 0) || '/' || coalesce(pol.upd, 0) || '/' || coalesce(pol.del, 0) as write_policies_ins_upd_del,
       case
         when not p.rls and p.privs ~ 'INSERT|UPDATE|DELETE' then 'BLOCK'
         when p.privs ~ 'TRUNCATE|REFERENCES|TRIGGER|MAINTAIN' then 'REVIEW'
         when p.privs ~ 'INSERT' and coalesce(pol.ins, 0) = 0 then 'REVIEW'
         when p.privs ~ 'UPDATE' and coalesce(pol.upd, 0) = 0 then 'REVIEW'
         when p.privs ~ 'DELETE' and coalesce(pol.del, 0) = 0 then 'REVIEW'
         else 'OK'
       end as status
from p left join pol on pol.tablename = p.relname
where p.privs is not null
order by case when not p.rls and p.privs ~ 'INSERT|UPDATE|DELETE' then 1 when p.privs ~ 'TRUNCATE|REFERENCES|TRIGGER|MAINTAIN' then 2 else 3 end, p.relname, p.rolname;

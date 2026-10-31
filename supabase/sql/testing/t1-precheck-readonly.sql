-- TESTING ONLY (etffoumsopxjptnmhvwh). READ-ONLY. Run each block separately in the TESTING SQL editor.

-- A. Every non-internal trigger on public.defects (expect at most ONE that calls notify_defect_via_edge_function;
--    anything else that posts notifications would cause duplicate calls and must be reviewed first).
--    tgenabled: O = enabled, D = disabled, R = replica only, A = always.
select t.tgname, t.tgenabled, t.tgfoid::regproc as function_name,
       (t.tgtype & 1) = 1 as row_level, (t.tgtype & 2) = 0 as after_trigger, (t.tgtype & 4) = 4 as on_insert
from pg_trigger t
where t.tgrelid = 'public.defects'::regclass and not t.tgisinternal
order by t.tgname;

-- B. The helper exists, points at TESTING and is signed (booleans only; no source is printed).
select p.oid is not null as function_exists,
       position('etffoumsopxjptnmhvwh.supabase.co' in p.prosrc) > 0 as targets_testing,
       position('zebksrihswwwlejdiboq' in p.prosrc) = 0 as no_live_reference,
       position('x-signature' in p.prosrc) > 0 as hmac_signed,
       position('/functions/v1/prodcheck-notify-defect' in p.prosrc) > 0 as already_prodcheck,
       position('division_id' in p.prosrc) > 0 as already_has_division
from (select 1) s left join pg_proc p on p.oid = to_regprocedure('public.notify_defect_via_edge_function()');

-- C. Required schema and Vault name (names only).
select (select count(*) from information_schema.columns where table_schema='public' and table_name='defects' and column_name='division_id' and data_type='uuid') as defects_division_id,
       to_regclass('public.user_divisions') is not null as user_divisions,
       exists (select 1 from vault.decrypted_secrets where name = 'defect_webhook_secret') as vault_signing_key_present,
       to_regclass('public.testing_prodcheck_trigger_state') is not null as migration_already_applied;

-- D. Eligible recipients per division: ACTIVE admins (not banned) assigned through user_divisions.
--    This is the number the function must report as "total". Pick a division where
--    eligible_admins < all_admins_in_system, so an all-admin fallback would show a different number.
select d.id as division_id, d.name,
       count(distinct ud.user_id) as assigned_users,
       count(distinct ud.user_id) filter (where r.role = 'admin') as assigned_admins,
       count(distinct ud.user_id) filter (
         where r.role = 'admin' and (u.banned_until is null or u.banned_until <= now())
       ) as eligible_admins,
       (select count(distinct user_id) from public.user_roles where role = 'admin') as all_admins_in_system
from public.divisions d
left join public.user_divisions ud on ud.division_id = d.id
left join public.user_roles r on r.user_id = ud.user_id
left join auth.users u on u.id = ud.user_id
group by d.id, d.name
order by eligible_admins desc, d.name;

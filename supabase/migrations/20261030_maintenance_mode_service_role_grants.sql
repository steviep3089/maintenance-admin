-- TESTING first. Fixes: the maintenance guard (Edge Functions, secret key = service_role) cannot read the
-- maintenance tables, so every guarded function returns 503 even while Maintenance Mode is OFF.
-- Cause: 20261030_maintenance_mode_setting.sql revoked anon/authenticated but never granted service_role, and
-- this project does not auto-grant new public tables to service_role (the notification migrations grant it
-- explicitly for the same reason). RLS is not the problem: service_role bypasses RLS.
--
-- Scope: SELECT on exactly the two tables the guard reads. NOT maintenance_credentials (password hash) and NOT
-- maintenance_mode_audit. No policies, no anon/authenticated grants, no write access. Idempotent.
-- Rollback: revoke select on public.maintenance_mode, public.maintenance_super_user from service_role;
-- (the guard then fails closed with 503 again - it never fails open).
begin;

grant select on table public.maintenance_mode to service_role;
grant select on table public.maintenance_super_user to service_role;

commit;

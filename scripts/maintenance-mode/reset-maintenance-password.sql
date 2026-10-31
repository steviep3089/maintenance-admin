-- DASHBOARD RECOVERY: forgotten maintenance password. Run in the Supabase SQL editor (as postgres) of
-- the affected project. Removes the stored hash (audited as 'password_removed', source 'direct_sql').
-- Maintenance cannot be turned ON again until the Super User sets a new password in the Portal.
-- Does not change whether maintenance is currently on; use emergency-off.sql for that.
delete from public.maintenance_credentials where id = true;

-- Verify (read-only; does not reveal the hash):
-- select count(*) as password_rows from public.maintenance_credentials;

-- EMERGENCY OFF for Maintenance Mode. Run in the Supabase SQL editor (as postgres) of the affected
-- project only when the Admin Portal cannot be opened. Intended for TESTING first; running it in LIVE
-- requires owner approval. One statement; the audit trigger records it as source 'direct_sql'.
update public.maintenance_mode
   set enabled = false,
       message = null,
       expected_return_at = null,
       updated_at = now()
 where id = true;

-- Verify (read-only):
-- select enabled, message, expected_return_at, updated_at from public.maintenance_mode;

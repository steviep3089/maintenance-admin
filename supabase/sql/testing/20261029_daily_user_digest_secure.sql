-- Secure scheduled job caller for notify-expiring-invites (TESTING PROJECT ONLY)
--
-- Project scope:
-- - Testing: etffoumsopxjptnmhvwh
-- - Production: (DO NOT apply this file to production)
--
-- Goal:
-- - Authenticate the scheduled call using an HMAC-SHA256 signed request.
-- - Avoid passing ANY service-role credential through SQL.
-- - Keep privileged operations inside the Edge Function (service_role key stored as env).
--
-- Auth model:
-- - This call does NOT send an Authorization: Bearer <JWT> header.
-- - Therefore the Edge Function must be deployed with verify_jwt=false.
--   This repo configures that ONLY for notify-defect and notify-expiring-invites.
--
-- Secrets:
-- - Vault secret name (per project): invite_digest_secret
-- - Edge Function env var (per project): INVITE_DIGEST_SIGNING_KEY (recommended)
--   - Backwards-compatible fallback: INVITE_DIGEST_SECRET
--
-- Security notes:
-- - pg_net queues outbound requests in net.http_request_queue.
--   Any headers/bodies (including secrets) may be visible there while queued.
--   Verify who can read net.* tables before rollout.

-- ========================================
-- STAGE 1: Create the scheduled caller function (no cron job yet)
-- ========================================

create or replace function public.run_daily_user_digest(
  p_dry_run boolean default true,
  p_allow_deactivation boolean default false
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  signing_key text;
  request_id text;
  timestamp_seconds bigint;
  path_and_query text;
  body_text text;
  body_sha256_hex text;
  canonical text;
  signature_hex text;
  headers jsonb;
  payload jsonb;
begin
  select ds.decrypted_secret
    into signing_key
  from vault.decrypted_secrets as ds
  where ds.name = 'invite_digest_secret'
  limit 1;

  if signing_key is null or length(signing_key) = 0 then
    raise exception 'invite_digest_secret not configured in Vault';
  end if;

  request_id := 'daily-user-digest:' || to_char(clock_timestamp() at time zone 'utc', 'YYYYMMDD');
  timestamp_seconds := floor(extract(epoch from clock_timestamp()))::bigint;
  path_and_query := '/functions/v1/notify-expiring-invites';

  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-request-id', request_id,
    'x-timestamp', timestamp_seconds::text
  );

  payload := jsonb_build_object(
    'dryRun', p_dry_run,
    'allowDeactivation', p_allow_deactivation
  );

  -- Sign the canonical representation (HMAC-SHA256).
  -- pgcrypto is installed in extensions in the testing project.
  body_text := payload::text;
  body_sha256_hex := encode(extensions.digest(convert_to(body_text, 'UTF8'), 'sha256'), 'hex');
  canonical := concat_ws(E'\n', 'v1', timestamp_seconds::text, request_id, 'POST', path_and_query, body_sha256_hex);
  signature_hex := encode(extensions.hmac(convert_to(canonical, 'UTF8'), convert_to(signing_key, 'UTF8'), 'sha256'), 'hex');
  headers := headers || jsonb_build_object('x-signature', 'v1=' || signature_hex);

  perform net.http_post(
    url := 'https://etffoumsopxjptnmhvwh.supabase.co/functions/v1/notify-expiring-invites',
    body := payload,
    params := '{}'::jsonb,
    headers := headers,
    timeout_milliseconds := 10000
  );
end;
$$;

-- Restrict direct execution: only cron (postgres) should invoke this.
revoke all on function public.run_daily_user_digest(boolean, boolean) from public;
revoke all on function public.run_daily_user_digest(boolean, boolean) from anon;
revoke all on function public.run_daily_user_digest(boolean, boolean) from authenticated;

-- Required ownership / privilege notes (verify in the Dashboard/SQL editor):
-- - Because this is SECURITY DEFINER, the function runs with the privileges of its OWNER.
-- - The function owner must have:
--   - USAGE on schema vault
--   - SELECT on vault.decrypted_secrets
--   - EXECUTE on net.http_post
-- - The cron job will run as the role that creates the cron.schedule entry (job owner).
--   That role must be able to EXECUTE public.run_daily_user_digest(boolean, boolean).

-- Required grants for notify-expiring-invites audit logging (service_role via PostgREST):
grant insert on table public.invite_digest_runs to service_role;
grant usage on sequence public.invite_digest_runs_id_seq to service_role;

-- ========================================
-- STAGE 2: Manual dry-run verification (run manually; optional)
-- ========================================
-- NOTE:
-- - Even in dry-run, notify-expiring-invites may still write audit rows to invite_digest_runs.

-- select public.run_daily_user_digest(true, false);

-- ========================================
-- STAGE 3: Schedule daily-user-digest (TESTING-SAFE ONLY) (run manually AFTER Stage 2)
-- ========================================
-- This schedules ONLY the safe testing call:
--   select public.run_daily_user_digest(true, false);
--
-- It also attempts to unschedule any existing job named daily-user-digest first
-- to avoid duplicate digests.

-- do $job$
-- declare
--   v_jobid int;
-- begin
--   select jobid
--     into v_jobid
--   from cron.job
--   where jobname = 'daily-user-digest'
--     and command = 'select public.run_daily_user_digest(true, false);'
--   limit 1;
--
--   if v_jobid is not null then
--     perform cron.unschedule(v_jobid);
--   end if;
--
--   perform cron.schedule(
--     'daily-user-digest',
--     '0 8 * * *',
--     $cmd$select public.run_daily_user_digest(true, false);$cmd$
--   );
-- end
-- $job$;

-- ========================================
-- ROLLBACK (TESTING) (run manually)
-- ========================================
-- do $$
-- declare
--   v_jobid int;
-- begin
--   select jobid
--     into v_jobid
--   from cron.job
--   where jobname = 'daily-user-digest'
--     and command = 'select public.run_daily_user_digest(true, false);'
--   limit 1;
--
--   if v_jobid is not null then
--     perform cron.unschedule(v_jobid);
--   end if;
-- end $$;
--
-- drop function if exists public.run_daily_user_digest(boolean, boolean);

-- Secure notify-defect trigger caller (TESTING PROJECT ONLY)
--
-- Project scope:
-- - Testing: etffoumsopxjptnmhvwh
-- - Production: (DO NOT apply this file to production)
--
-- Purpose:
-- - Replace any legacy trigger workflow that embedded a service-role JWT.
-- - Call the hardened Edge Function using an HMAC-SHA256 signed request.
-- - Retrieve the shared secret from Supabase Vault at runtime (no secret literals in SQL files).
--
-- Auth model:
-- - This call does NOT send an Authorization: Bearer <JWT> header.
-- - Therefore the Edge Function must be deployed with verify_jwt=false.
--   This repo configures that ONLY for notify-defect and notify-expiring-invites.
--
-- Secrets:
-- - Vault secret name (per project): defect_webhook_secret
-- - Edge Function env var (per project): DEFECT_WEBHOOK_SIGNING_KEY (recommended)
--   - Backwards-compatible fallback: DEFECT_WEBHOOK_SECRET
--
-- Security notes:
-- - pg_net queues outbound requests in net.http_request_queue.
--   Any headers/bodies (including secrets) may be visible there while queued.
--   Verify who can read net.* tables before rollout.

-- ========================================
-- STAGE 1: Create the trigger caller function (no trigger yet)
-- ========================================

create or replace function public.notify_defect_via_edge_function()
returns trigger
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
  -- Fetch signing key from Supabase Vault (never embed secrets in SQL).
  select ds.decrypted_secret
    into signing_key
  from vault.decrypted_secrets as ds
  where ds.name = 'defect_webhook_secret'
  limit 1;

  if signing_key is null or length(signing_key) = 0 then
    raise exception 'defect_webhook_secret not configured in Vault';
  end if;

  request_id := 'notify-defect:' || new.id::text;
  timestamp_seconds := floor(extract(epoch from clock_timestamp()))::bigint;
  path_and_query := '/functions/v1/notify-defect';

  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-request-id', request_id,
    'x-timestamp', timestamp_seconds::text
  );

  -- Payload MUST match what supabase/functions/notify-defect expects.
  -- notify-defect reads these keys directly (it does not query defects by id).
  payload := jsonb_build_object(
    'dryRun', true,
    'id', new.id,
    'asset', new.asset,
    'title', new.title,
    'description', new.description,
    'category', new.category,
    'submitted_by', new.submitted_by,
    'status', new.status,
    'priority', new.priority
  );

  -- Sign the canonical representation (HMAC-SHA256).
  -- pgcrypto is installed in extensions in the testing project.
  body_text := payload::text;
  body_sha256_hex := encode(extensions.digest(convert_to(body_text, 'UTF8'), 'sha256'), 'hex');
  canonical := concat_ws(E'\n', 'v1', timestamp_seconds::text, request_id, 'POST', path_and_query, body_sha256_hex);
  signature_hex := encode(extensions.hmac(convert_to(canonical, 'UTF8'), convert_to(signing_key, 'UTF8'), 'sha256'), 'hex');
  headers := headers || jsonb_build_object('x-signature', 'v1=' || signature_hex);

  perform net.http_post(
    url := 'https://etffoumsopxjptnmhvwh.supabase.co/functions/v1/notify-defect',
    body := payload,
    params := '{}'::jsonb,
    headers := headers,
    timeout_milliseconds := 10000
  );

  return new;
end;
$$;

-- Restrict direct execution: only the trigger should be able to invoke this.
revoke all on function public.notify_defect_via_edge_function() from public;
revoke all on function public.notify_defect_via_edge_function() from anon;
revoke all on function public.notify_defect_via_edge_function() from authenticated;

-- Required ownership / privilege notes (verify in the Dashboard/SQL editor):
-- - Because this is SECURITY DEFINER, the function runs with the privileges of its OWNER.
-- - The function owner must have:
--   - USAGE on schema vault
--   - SELECT on vault.decrypted_secrets
--   - EXECUTE on net.http_post
-- - Trigger runtime execution behavior depends on Postgres role privileges.
--   If inserts into public.defects fail with a function EXECUTE permission error,
--   check which role is performing the INSERT and verify its ability to invoke the trigger.
--   (Do not grant broad EXECUTE without reviewing the implications.)

-- ========================================
-- STAGE 2: Manual dry-run verification (run manually; optional)
-- ========================================
-- Notes:
-- - The Edge Function should return HTTP 200 and report a dry-run response.
-- - This may still create audit/console logs.
-- - This stage intentionally does NOT include an INSERT example because the required
--   columns on public.defects can vary between environments.

-- ========================================
-- STAGE 3: Enable defect notification trigger (run manually AFTER Stage 2)
-- ========================================
-- Intended behavior:
-- - Notify once per newly created defect.
-- - Avoid duplicates by NOT creating update triggers.
--
-- IMPORTANT:
-- - Run the DROP+CREATE together to avoid duplicate notifications.
-- - If you later discover an existing trigger name in another environment, replace
--   the trigger name below accordingly.

-- begin;
--
-- drop trigger if exists defect_notifications_notify_defect on public.defects;
-- create trigger defect_notifications_notify_defect
-- after insert on public.defects
-- for each row
-- execute function public.notify_defect_via_edge_function();
--
-- commit;

-- ========================================
-- ROLLBACK (TESTING) (run manually)
-- ========================================
-- begin;
-- drop trigger if exists defect_notifications_notify_defect on public.defects;
-- drop function if exists public.notify_defect_via_edge_function();
-- commit;

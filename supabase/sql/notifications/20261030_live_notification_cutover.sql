begin;

-- Update notification authentication to HMAC-signed requests (LIVE PROJECT ONLY)
--
-- IMPORTANT:
-- - Replaces the existing defect trigger caller in place.
-- - Creates/replaces the signed digest helper and updates the existing pg_cron
--   job ID 2 in place, preserving its name, active state, and schedule.
-- - Aborts unless the existing digest job exactly matches the verified LIVE
--   identity and still has the expected direct legacy net.http_post command.
--
-- Project scope:
-- - LIVE: zebksrihswwwlejdiboq
-- - This production bundle is not for non-production projects.
--
-- Why:
-- - pg_net queues requests in net.http_request_queue, including headers.
-- - Raw shared-secret headers can therefore be exposed to any role that can read
--   the queue.
-- - This migration moves to HMAC-SHA256 signed requests that never place the raw
--   signing key in headers, URL, or body.
--
-- Prerequisites (verify via read-only queries before execution):
-- - Extension pgcrypto is installed (provides digest() and hmac()).
-- - Vault secrets exist:
--   - defect_webhook_secret (treated as signing key)
--   - invite_digest_secret (treated as signing key)
--
-- Notes:
-- - Requests are signed over a canonical string including:
--   signature_version, timestamp, request_id, method, path, body_sha256
-- - A leased, source-scoped request claim prevents concurrent processing and allows
--   failed work to be retried after an explicit release or lease expiry.
--
-- ========================================
-- STAGE A0: Dedupe table for replay protection
-- ========================================

create table if not exists public.notification_request_dedup (
  source text not null,
  request_id text not null,
  state text not null default 'completed',
  claim_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  received_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint notification_request_dedup_pkey primary key (source, request_id),
  constraint notification_request_dedup_source_check
    check (source in ('notify-defect', 'notify-expiring-invites')),
  constraint notification_request_dedup_state_check
    check (state in ('processing', 'completed', 'failed'))
);

-- Upgrade a table created by the earlier single-column dedupe implementation.
alter table public.notification_request_dedup
  add column if not exists state text not null default 'completed',
  add column if not exists claim_token uuid,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists completed_at timestamptz;

do $$
begin
  if exists (
    select 1
    from public.notification_request_dedup
    group by source, request_id
    having count(*) > 1
  ) then
    raise exception 'notification_request_dedup contains duplicate source/request_id pairs';
  end if;
end
$$;

do $$
declare
  primary_key_name text;
  primary_key_definition text;
begin
  select conname, pg_get_constraintdef(oid)
    into primary_key_name, primary_key_definition
  from pg_constraint
  where conrelid = 'public.notification_request_dedup'::regclass
    and contype = 'p';

  if primary_key_name is not null
    and primary_key_definition <> 'PRIMARY KEY (source, request_id)' then
    execute format(
      'alter table public.notification_request_dedup drop constraint %I',
      primary_key_name
    );
    primary_key_name := null;
  end if;

  if primary_key_name is null then
    alter table public.notification_request_dedup
      add constraint notification_request_dedup_pkey primary key (source, request_id);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.notification_request_dedup'::regclass
      and conname = 'notification_request_dedup_source_check'
  ) then
    alter table public.notification_request_dedup
      add constraint notification_request_dedup_source_check
      check (source in ('notify-defect', 'notify-expiring-invites'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.notification_request_dedup'::regclass
      and conname = 'notification_request_dedup_state_check'
  ) then
    alter table public.notification_request_dedup
      add constraint notification_request_dedup_state_check
      check (state in ('processing', 'completed', 'failed'));
  end if;
end
$$;

alter table public.notification_request_dedup enable row level security;
revoke all on table public.notification_request_dedup from public;
revoke all on table public.notification_request_dedup from anon;
revoke all on table public.notification_request_dedup from authenticated;
revoke all on table public.notification_request_dedup from service_role;

create or replace function public.claim_notification_request(
  p_source text,
  p_request_id text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_new_claim_token uuid := pg_catalog.gen_random_uuid();
  v_claimed_token uuid;
begin
  insert into public.notification_request_dedup as dedup (
    source,
    request_id,
    state,
    claim_token,
    lease_expires_at,
    attempt_count,
    updated_at,
    completed_at
  )
  values (
    p_source,
    p_request_id,
    'processing',
    v_new_claim_token,
    clock_timestamp() + interval '15 minutes',
    1,
    clock_timestamp(),
    null
  )
  on conflict on constraint notification_request_dedup_pkey do update
    set state = 'processing',
        claim_token = excluded.claim_token,
        lease_expires_at = excluded.lease_expires_at,
        attempt_count = dedup.attempt_count + 1,
        updated_at = clock_timestamp(),
        completed_at = null
    where dedup.state = 'failed'
       or (
         dedup.state = 'processing'
         and dedup.lease_expires_at <= clock_timestamp()
       )
  returning dedup.claim_token into v_claimed_token;

  return v_claimed_token;
end;
$$;

create or replace function public.complete_notification_request(
  p_source text,
  p_request_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.notification_request_dedup
     set state = 'completed',
         lease_expires_at = null,
         completed_at = clock_timestamp(),
         updated_at = clock_timestamp()
   where source = p_source
     and request_id = p_request_id
     and claim_token = p_claim_token
     and state = 'processing';

  return found;
end;
$$;

create or replace function public.fail_notification_request(
  p_source text,
  p_request_id text,
  p_claim_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.notification_request_dedup
     set state = 'failed',
         lease_expires_at = null,
         updated_at = clock_timestamp()
   where source = p_source
     and request_id = p_request_id
     and claim_token = p_claim_token
     and state = 'processing';

  return found;
end;
$$;

alter function public.claim_notification_request(text, text) owner to postgres;
alter function public.complete_notification_request(text, text, uuid) owner to postgres;
alter function public.fail_notification_request(text, text, uuid) owner to postgres;

revoke all on function public.claim_notification_request(text, text) from public;
revoke all on function public.claim_notification_request(text, text) from anon;
revoke all on function public.claim_notification_request(text, text) from authenticated;
revoke all on function public.complete_notification_request(text, text, uuid) from public;
revoke all on function public.complete_notification_request(text, text, uuid) from anon;
revoke all on function public.complete_notification_request(text, text, uuid) from authenticated;
revoke all on function public.fail_notification_request(text, text, uuid) from public;
revoke all on function public.fail_notification_request(text, text, uuid) from anon;
revoke all on function public.fail_notification_request(text, text, uuid) from authenticated;
grant execute on function public.claim_notification_request(text, text) to service_role;
grant execute on function public.complete_notification_request(text, text, uuid) to service_role;
grant execute on function public.fail_notification_request(text, text, uuid) to service_role;

-- ========================================
-- STAGE A1: Replace existing notify-defect trigger caller in place
-- ========================================

do $$
declare
  defect_function_oid oid := to_regprocedure('public.notify_defect_created()');
  defect_function_result oid;
  defect_function_arg_count smallint;
  matching_trigger_count bigint;
begin
  if defect_function_oid is null then
    raise exception 'Expected public.notify_defect_created() to exist; migration aborted';
  end if;

  select proc.prorettype, proc.pronargs
    into defect_function_result, defect_function_arg_count
  from pg_proc as proc
  where proc.oid = defect_function_oid;

  if defect_function_result <> 'trigger'::regtype
     or defect_function_arg_count <> 0 then
    raise exception 'Expected notify_defect_created() to remain a zero-argument trigger function; migration aborted';
  end if;

  select count(*)
    into matching_trigger_count
  from pg_trigger as trigger_row
  where trigger_row.tgrelid = 'public.defects'::regclass
    and trigger_row.tgname = 'on_defect_created'
    and not trigger_row.tgisinternal
    and trigger_row.tgfoid = defect_function_oid
    and trigger_row.tgenabled <> 'D';

  if matching_trigger_count <> 1 then
    raise exception 'Expected enabled on_defect_created trigger to call notify_defect_created(); migration aborted';
  end if;
end
$$;

-- CREATE OR REPLACE preserves the existing zero-argument trigger signature;
-- PostgreSQL rejects attempts to change this function's return type.
create or replace function public.notify_defect_created()
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

  payload := jsonb_build_object(
    -- Initial rollout is dry-run only. The Edge Function must also have
    -- ALLOW_DRY_RUN=true; do not treat this signed body flag as the sole control.
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

  body_text := payload::text;
  body_sha256_hex := encode(extensions.digest(convert_to(body_text, 'UTF8'), 'sha256'), 'hex');
  canonical := concat_ws(E'\n', 'v1', timestamp_seconds::text, request_id, 'POST', path_and_query, body_sha256_hex);
  signature_hex := encode(extensions.hmac(convert_to(canonical, 'UTF8'), convert_to(signing_key, 'UTF8'), 'sha256'), 'hex');
  headers := headers || jsonb_build_object('x-signature', 'v1=' || signature_hex);

  perform net.http_post(
    url := 'https://zebksrihswwwlejdiboq.supabase.co/functions/v1/notify-defect',
    body := payload,
    params := '{}'::jsonb,
    headers := headers,
    timeout_milliseconds := 10000
  );

  return new;
end;
$$;

alter function public.notify_defect_created() owner to postgres;

revoke all on function public.notify_defect_created() from public;
revoke all on function public.notify_defect_created() from anon;
revoke all on function public.notify_defect_created() from authenticated;

-- ========================================
-- STAGE A2: Create signed daily digest caller
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
    -- Deactivation is hard-disabled in this initial rollout.
    'allowDeactivation', false
  );

  body_text := payload::text;
  body_sha256_hex := encode(extensions.digest(convert_to(body_text, 'UTF8'), 'sha256'), 'hex');
  canonical := concat_ws(E'\n', 'v1', timestamp_seconds::text, request_id, 'POST', path_and_query, body_sha256_hex);
  signature_hex := encode(extensions.hmac(convert_to(canonical, 'UTF8'), convert_to(signing_key, 'UTF8'), 'sha256'), 'hex');
  headers := headers || jsonb_build_object('x-signature', 'v1=' || signature_hex);

  perform net.http_post(
    url := 'https://zebksrihswwwlejdiboq.supabase.co/functions/v1/notify-expiring-invites',
    body := payload,
    params := '{}'::jsonb,
    headers := headers,
    timeout_milliseconds := 10000
  );
end;
$$;

alter function public.run_daily_user_digest(boolean, boolean) owner to postgres;

revoke all on function public.run_daily_user_digest(boolean, boolean) from public;
revoke all on function public.run_daily_user_digest(boolean, boolean) from anon;
revoke all on function public.run_daily_user_digest(boolean, boolean) from authenticated;

-- Required grants for notify-expiring-invites audit logging (service_role via PostgREST):
-- (Already confirmed needed in testing.)
-- Keeping them here ensures a single execution block is sufficient.

grant insert on table public.invite_digest_runs to service_role;
grant usage on sequence public.invite_digest_runs_id_seq to service_role;

-- ========================================
-- STAGE A3: Replace the verified existing daily digest job in place
-- ========================================

do $$
declare
  existing_job record;
  named_job_count bigint;
begin
  if to_regprocedure('cron.alter_job(bigint,text,text,text,text,boolean)') is null then
    raise exception 'Required cron.alter_job signature is unavailable; no cron job was changed';
  end if;

  select count(*)
    into named_job_count
  from cron.job
  where jobname = 'daily-user-digest';

  if named_job_count <> 1 then
    raise exception 'Expected exactly one daily-user-digest job; no cron job was changed';
  end if;

  select jobid, jobname, schedule, command, active
    into existing_job
  from cron.job
  where jobid = 2;

  if not found
     or existing_job.jobname <> 'daily-user-digest'
     or existing_job.schedule <> '0 8 * * *'
     or existing_job.active is distinct from true then
    raise exception 'Verified daily digest job identity or schedule changed; no cron job was changed';
  end if;

  if existing_job.command !~* 'net[.]http_post'
     or existing_job.command !~* 'authorization'
     or existing_job.command !~* 'vault[.]decrypted_secrets'
     or existing_job.command ~* 'run_daily_user_digest' then
    raise exception 'Daily digest command is not the expected direct Vault-backed HTTP caller; no cron job was changed';
  end if;

  perform cron.alter_job(
    2,
    '0 8 * * *',
    'select public.run_daily_user_digest(true, false);',
    null,
    null,
    null
  );

  select jobid, jobname, schedule, command, active
    into existing_job
  from cron.job
  where jobid = 2;

  if not found
     or existing_job.jobname <> 'daily-user-digest'
     or existing_job.schedule <> '0 8 * * *'
     or existing_job.active is distinct from true
     or existing_job.command <> 'select public.run_daily_user_digest(true, false);' then
    raise exception 'Daily digest job update verification failed; transaction will roll back';
  end if;
end
$$;

commit;

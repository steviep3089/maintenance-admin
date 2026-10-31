begin;

-- TESTING ONLY (etffoumsopxjptnmhvwh). Aborts on any other project. Do NOT run in LIVE.
--
-- Routes TESTING defect notifications to the TESTING-only function prodcheck-notify-defect and adds division_id to the
-- signed payload. The signing logic (canonical v1 string, extensions.digest/hmac, Vault 'defect_webhook_secret') is
-- identical to the existing helper; only the path and the payload's division_id change.
-- Email safety: payload keeps dryRun=true AND the TESTING function has ALLOW_DRY_RUN=true. Either one prevents email.
-- Do not set DEFECT_EMAILS_ENABLED in TESTING.
--
-- Trigger handling: if exactly one AFTER INSERT row trigger already calls notify_defect_via_edge_function() it is kept
-- by name (re-enabled if it was disabled; the previous state is saved). Otherwise a new trigger
-- testing_prodcheck_defect_notify is created. No duplicate trigger is ever created.
-- Rollback: t3-testing-defect-trigger-division-rollback.sql (uses the saved state).

do $$
declare
  fn_oid oid := to_regprocedure('public.notify_defect_via_edge_function()');
  src text;
  n_total int;
  n_ours int;
  trg record;
begin
  if fn_oid is null then
    raise exception 'public.notify_defect_via_edge_function() is missing; aborting';
  end if;
  select prosrc into src from pg_proc where oid = fn_oid;
  if position('etffoumsopxjptnmhvwh.supabase.co' in src) = 0 or position('zebksrihswwwlejdiboq' in src) > 0 then
    raise exception 'Helper does not target the TESTING project only; aborting';
  end if;
  if position('x-signature' in src) = 0 then
    raise exception 'Helper is not the HMAC-signed version; aborting';
  end if;
  if to_regclass('public.testing_prodcheck_trigger_state') is not null then
    raise exception 'Already applied (state table exists); run the rollback first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='defects' and column_name='division_id' and data_type='uuid') then
    raise exception 'public.defects.division_id (uuid) is missing; aborting';
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'defect_webhook_secret') then
    raise exception 'Vault secret defect_webhook_secret is missing; aborting';
  end if;

  select count(*) into n_total from pg_trigger where tgrelid = 'public.defects'::regclass and not tgisinternal;
  select count(*) into n_ours from pg_trigger where tgrelid = 'public.defects'::regclass and not tgisinternal and tgfoid = fn_oid;
  if n_ours > 1 then
    raise exception 'More than one trigger calls the helper; resolve manually first';
  end if;
  if n_total > n_ours then
    raise notice 'Other triggers exist on public.defects; confirm (t1 block A) none sends notifications';
  end if;
  if n_ours = 1 then
    select tgname, tgenabled, tgtype into trg from pg_trigger
    where tgrelid = 'public.defects'::regclass and not tgisinternal and tgfoid = fn_oid;
    if (trg.tgtype & 1) <> 1 or (trg.tgtype & 2) <> 0 or (trg.tgtype & 4) <> 4 then
      raise exception 'Existing trigger is not AFTER INSERT FOR EACH ROW; aborting';
    end if;
  end if;
end
$$;

-- Saved state for an exact rollback. Not exposed to API roles.
create table public.testing_prodcheck_trigger_state (
  id int primary key check (id = 1),
  trigger_name text not null,
  created_by_migration boolean not null,
  previous_enabled "char",
  saved_at timestamptz not null default now()
);
alter table public.testing_prodcheck_trigger_state enable row level security;
revoke all on public.testing_prodcheck_trigger_state from public, anon, authenticated;

do $$
declare
  fn_oid oid := to_regprocedure('public.notify_defect_via_edge_function()');
  trg record;
begin
  select tgname, tgenabled into trg from pg_trigger
  where tgrelid = 'public.defects'::regclass and not tgisinternal and tgfoid = fn_oid;

  if found then
    insert into public.testing_prodcheck_trigger_state (id, trigger_name, created_by_migration, previous_enabled)
    values (1, trg.tgname, false, trg.tgenabled);
    if trg.tgenabled <> 'O' then
      execute format('alter table public.defects enable trigger %I', trg.tgname);
    end if;
  else
    insert into public.testing_prodcheck_trigger_state (id, trigger_name, created_by_migration, previous_enabled)
    values (1, 'testing_prodcheck_defect_notify', true, null);
    create trigger testing_prodcheck_defect_notify
      after insert on public.defects
      for each row execute function public.notify_defect_via_edge_function();
  end if;
end
$$;

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
  path_and_query := '/functions/v1/prodcheck-notify-defect';

  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-request-id', request_id,
    'x-timestamp', timestamp_seconds::text
  );

  payload := jsonb_build_object(
    'dryRun', true,
    'id', new.id,
    'asset', new.asset,
    'title', new.title,
    'description', new.description,
    'category', new.category,
    'submitted_by', new.submitted_by,
    'status', new.status,
    'priority', new.priority,
    'division_id', new.division_id
  );

  body_text := payload::text;
  body_sha256_hex := encode(extensions.digest(convert_to(body_text, 'UTF8'), 'sha256'), 'hex');
  canonical := concat_ws(E'\n', 'v1', timestamp_seconds::text, request_id, 'POST', path_and_query, body_sha256_hex);
  signature_hex := encode(extensions.hmac(convert_to(canonical, 'UTF8'), convert_to(signing_key, 'UTF8'), 'sha256'), 'hex');
  headers := headers || jsonb_build_object('x-signature', 'v1=' || signature_hex);

  perform net.http_post(
    url := 'https://etffoumsopxjptnmhvwh.supabase.co/functions/v1/prodcheck-notify-defect',
    body := payload,
    params := '{}'::jsonb,
    headers := headers,
    timeout_milliseconds := 10000
  );

  return new;
end;
$$;

revoke all on function public.notify_defect_via_edge_function() from public;
revoke all on function public.notify_defect_via_edge_function() from anon;
revoke all on function public.notify_defect_via_edge_function() from authenticated;

do $$
declare
  fn_oid oid := to_regprocedure('public.notify_defect_via_edge_function()');
  src text;
  n int;
begin
  select prosrc into src from pg_proc where oid = fn_oid;
  if position('/functions/v1/prodcheck-notify-defect' in src) = 0
     or position('new.division_id' in src) = 0
     or position('''dryRun'', true' in src) = 0
     or position('zebksrihswwwlejdiboq' in src) > 0 then
    raise exception 'Function verification failed; transaction will roll back';
  end if;
  select count(*) into n from pg_trigger
  where tgrelid = 'public.defects'::regclass and not tgisinternal and tgfoid = fn_oid and tgenabled = 'O';
  if n <> 1 then
    raise exception 'Expected exactly one enabled trigger calling the helper; transaction will roll back';
  end if;
end
$$;

commit;

begin;

-- ROLLBACK for 20261031_defect_division_notifications.sql (LIVE).
-- Restores notify_defect_created() to the cutover version: signed payload has dryRun=true and no division_id, so
-- every defect notification is a dry run again regardless of the Edge Function environment. Trigger unchanged.
-- Also unset DEFECT_EMAILS_ENABLED in the Edge Function secrets (belt and braces).

do $$
begin
  if to_regprocedure('public.notify_defect_created()') is null then
    raise exception 'Expected public.notify_defect_created() to exist; rollback aborted';
  end if;
end
$$;

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

do $$
declare
  src text;
begin
  select proc.prosrc into src from pg_proc as proc where proc.oid = to_regprocedure('public.notify_defect_created()');
  if position('''dryRun'', true' in src) = 0 or position('division_id' in src) <> 0 then
    raise exception 'rollback verification failed; transaction will roll back';
  end if;
end
$$;

commit;

begin;

-- LIVE ONLY (zebksrihswwwlejdiboq): defect notifications to the admins of the defect's division.
--
-- Changes ONLY the body of public.notify_defect_created():
--   * the signed payload now carries division_id (new.division_id; null when the defect has none);
--   * the signed body no longer hard-codes dryRun=true. Real sending is now decided by the Edge Function, which sends
--     real mail only when DEFECT_EMAILS_ENABLED=true and ALLOW_DRY_RUN is not on.
-- Unchanged: the on_defect_created trigger (AFTER INSERT only, so historical defects are never re-notified), HMAC
-- signing, the request id 'notify-defect:<defect id>' (completed claims are never replayed), owner and privileges.
-- Rollback: 20261031_defect_division_notifications_rollback.sql.
--
-- Deploy the notify-defect function BEFORE running this. Order is safe either way while DEFECT_EMAILS_ENABLED is unset.

do $$
declare
  defect_function_oid oid := to_regprocedure('public.notify_defect_created()');
  current_source text;
  matching_trigger_count bigint;
begin
  if defect_function_oid is null then
    raise exception 'Expected public.notify_defect_created() to exist; migration aborted';
  end if;

  select proc.prosrc into current_source from pg_proc as proc where proc.oid = defect_function_oid;
  if current_source is null
     or position('zebksrihswwwlejdiboq.supabase.co/functions/v1/notify-defect' in current_source) = 0
     or position('x-signature' in current_source) = 0 then
    raise exception 'notify_defect_created() is not the LIVE HMAC version (wrong project or cutover not applied); migration aborted';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'defects' and column_name = 'division_id' and data_type = 'uuid'
  ) then
    raise exception 'public.defects.division_id (uuid) is missing; migration aborted';
  end if;

  if to_regclass('public.user_divisions') is null then
    raise exception 'public.user_divisions is missing; migration aborted';
  end if;

  select count(*) into matching_trigger_count
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
    -- Real delivery is controlled by the Edge Function (DEFECT_EMAILS_ENABLED / ALLOW_DRY_RUN), not by this flag.
    'dryRun', false,
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

-- Post-checks: signature unchanged, trigger still attached and enabled, function not callable by API roles.
do $$
declare
  defect_function_oid oid := to_regprocedure('public.notify_defect_created()');
  src text;
begin
  select proc.prosrc into src from pg_proc as proc where proc.oid = defect_function_oid;
  if position('''division_id'', new.division_id' in src) = 0 then
    raise exception 'division_id was not added to the payload; transaction will roll back';
  end if;
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = 'public.defects'::regclass and t.tgname = 'on_defect_created' and not t.tgisinternal
      and t.tgfoid = defect_function_oid and t.tgenabled <> 'D'
  ) then
    raise exception 'on_defect_created trigger is not attached and enabled; transaction will roll back';
  end if;
  if has_function_privilege('anon', defect_function_oid, 'EXECUTE') or has_function_privilege('authenticated', defect_function_oid, 'EXECUTE') then
    raise exception 'API roles must not execute notify_defect_created(); transaction will roll back';
  end if;
end
$$;

commit;

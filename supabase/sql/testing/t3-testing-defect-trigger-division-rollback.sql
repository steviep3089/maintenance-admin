begin;

-- TESTING ONLY. Rolls back t2: restores the original helper (path /functions/v1/notify-defect, no division_id,
-- dryRun=true) and the saved trigger state. A trigger that existed before is KEPT and returned to its previous
-- enabled/disabled state; only a trigger that t2 itself created is dropped.

do $$
begin
  if to_regclass('public.testing_prodcheck_trigger_state') is null then
    raise exception 'No saved state found (t2 not applied, or already rolled back); aborting';
  end if;
  if to_regprocedure('public.notify_defect_via_edge_function()') is null then
    raise exception 'Helper function is missing; aborting';
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
    url := 'https://etffoumsopxjptnmhvwh.supabase.co/functions/v1/notify-defect',
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
  st record;
begin
  select * into st from public.testing_prodcheck_trigger_state where id = 1;

  if st.created_by_migration then
    execute format('drop trigger if exists %I on public.defects', st.trigger_name);
  elsif exists (select 1 from pg_trigger where tgrelid = 'public.defects'::regclass and tgname = st.trigger_name and not tgisinternal) then
    case st.previous_enabled
      when 'D' then execute format('alter table public.defects disable trigger %I', st.trigger_name);
      when 'R' then execute format('alter table public.defects enable replica trigger %I', st.trigger_name);
      when 'A' then execute format('alter table public.defects enable always trigger %I', st.trigger_name);
      else execute format('alter table public.defects enable trigger %I', st.trigger_name);
    end case;
  end if;
end
$$;

drop table public.testing_prodcheck_trigger_state;

do $$
declare
  src text;
begin
  select prosrc into src from pg_proc where oid = to_regprocedure('public.notify_defect_via_edge_function()');
  if position('/functions/v1/prodcheck-notify-defect' in src) > 0 or position('division_id' in src) > 0 then
    raise exception 'Rollback verification failed; transaction will roll back';
  end if;
end
$$;

commit;

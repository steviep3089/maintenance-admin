-- READ-ONLY inventory of database-side places that could still hold or use a legacy JWT key (anon / service_role).
-- Run in the LIVE SQL editor (zebksrihswwwlejdiboq), and in TESTING for comparison. SELECT only; changes nothing.
-- NEVER outputs a secret or token value: only names, ids, booleans and the decoded `role` claim of JWT-shaped values.
-- Status: BLOCK = a legacy JWT is still stored/used (must be removed before retiring the key); REVIEW = inspect; OK/INFO.
with
-- 1. Vault secrets that look like a JWT (value never shown; only the role claim of a well-formed JWT is decoded)
vault_rows as (
  select s.name, s.created_at,
         (s.decrypted_secret ~ 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+') as jwt_shaped,
         case when s.decrypted_secret ~ 'eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+' then
           (convert_from(decode(rpad(translate((regexp_match(s.decrypted_secret, 'eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]{4,})\.[A-Za-z0-9_-]+'))[1], '-_', '+/'),
              ((length((regexp_match(s.decrypted_secret, 'eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]{4,})\.[A-Za-z0-9_-]+'))[1]) + 3) / 4) * 4, '='), 'base64'), 'UTF8'))::jsonb ->> 'role'
         end as jwt_role,
         case when s.decrypted_secret ~ '^sb_secret_' then 'sb_secret_ (new secret key format)'
              when s.decrypted_secret ~ '^sb_publishable_' then 'sb_publishable_'
              when s.decrypted_secret ~* '^\s*bearer' then 'bearer-prefixed'
              when s.decrypted_secret ~ 'eyJ' then 'embedded-jwt'
              else 'other' end as value_kind,
         length(s.decrypted_secret) as value_len
  from vault.decrypted_secrets s
),
-- 2. Database functions (non-system schemas) whose source contains JWT-shaped text or header-style auth markers
func_rows as (
  select n.nspname || '.' || p.proname as object,
         (p.prosrc ~ 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}') as embeds_jwt,
         (p.prosrc ~* 'authorization|bearer|x-notify-secret|apikey|service_role') as mentions_auth
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname not in ('pg_catalog', 'information_schema', 'auth', 'storage', 'extensions', 'vault', 'realtime', 'graphql', 'graphql_public', 'pgsodium', 'net', 'cron')
    and not n.nspname like 'pg_toast%'
),
-- 3. Triggers whose arguments contain JWT-shaped text (e.g. database webhooks with static headers)
trg_rows as (
  select c.relname || '.' || t.tgname as object,
         (encode(t.tgargs, 'escape') ~ 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}') as args_embed_jwt
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  where not t.tgisinternal
),
-- 4. cron.job and the pg_net queue, read dynamically so the query still runs where they are missing
cron_rows as (
  select (xpath('/row/n/text()', x))[1]::text as n_jobs,
         (xpath('/row/j/text()', x))[1]::text as n_jwt,
         (xpath('/row/a/text()', x))[1]::text as n_auth
  from (select query_to_xml(
    case when to_regclass('cron.job') is null then 'select 0 n, 0 j, 0 a'
    else $q$select count(*) n,
                   count(*) filter (where command ~ 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}') j,
                   count(*) filter (where command ~* 'authorization|bearer|vault[.]decrypted_secrets|service_role') a
            from cron.job$q$ end, false, true, '') as x) q
),
net_rows as (
  select (xpath('/row/n/text()', x))[1]::text as n_queued,
         (xpath('/row/j/text()', x))[1]::text as n_jwt
  from (select query_to_xml(
    case when to_regclass('net.http_request_queue') is null then 'select 0 n, 0 j'
    else $q$select count(*) n, count(*) filter (where headers::text ~ 'eyJ[A-Za-z0-9_-]{10,}') j from net.http_request_queue$q$ end, false, true, '') as x) q
),
hook_rows as (
  select case when to_regclass('supabase_functions.hooks') is null then 'schema absent' else 'present' end as state
)
select 'vault_secret' as section, name as object,
       case when jwt_shaped then 'BLOCK' else 'OK' end as status,
       'created=' || created_at::date || ' jwt_shaped=' || jwt_shaped || coalesce(' role=' || jwt_role, '') || ' kind=' || value_kind || ' len=' || value_len as detail
from vault_rows
union all
select 'db_function', object, case when embeds_jwt then 'BLOCK' when mentions_auth then 'REVIEW' else 'OK' end,
       'embeds_jwt=' || embeds_jwt || ' mentions_auth_markers=' || mentions_auth
from func_rows where embeds_jwt or mentions_auth
union all
select 'trigger_args', object, case when args_embed_jwt then 'BLOCK' else 'OK' end, 'args_embed_jwt=' || args_embed_jwt
from trg_rows where args_embed_jwt
union all
select 'cron_jobs', 'cron.job', case when n_jwt::int > 0 then 'BLOCK' when n_auth::int > 0 then 'REVIEW' else 'OK' end,
       'jobs=' || n_jobs || ' with_jwt=' || n_jwt || ' with_auth_markers=' || n_auth from cron_rows
union all
select 'pg_net_queue', 'net.http_request_queue', case when n_jwt::int > 0 then 'BLOCK' else 'OK' end,
       'queued=' || n_queued || ' with_jwt_in_headers=' || n_jwt from net_rows
union all
select 'database_webhooks', 'supabase_functions.hooks', 'INFO', state from hook_rows
order by 1, 2;

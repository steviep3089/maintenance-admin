-- Maintenance Mode v2: setting, Super User, password-gated toggle, rate limiting and audit trail.
-- TESTING first (etffoumsopxjptnmhvwh). Review before running; NOT applied anywhere.
--
-- Security model
--  * Any signed-in Admin Portal admin (user_roles.role = 'admin') may CALL set_maintenance_mode, but must
--    supply the separate maintenance password to turn maintenance ON or OFF.
--  * Exactly one Super User (public.maintenance_super_user) may use the Portal while maintenance is on.
--    Everyone else, including normal admins, is blocked. The Super User is the only bypass.
--  * Knowing or entering the maintenance password never grants a bypass.
--  * The Super User may turn maintenance OFF without the password (emergency recovery); turning ON
--    always needs the password.
--  * The password is stored only as a bcrypt hash (extensions.crypt) in a table no client role can read.
--    It is set by the Super User through set_maintenance_password(); it never appears in SQL files.
--  * Failed attempts are rate limited (per user and globally) and every change/attempt is audited with
--    the signed-in user id and email.
--  * Roles in user_roles are not modified. The Dashboard emergency OFF procedure is retained.
--
-- This migration does NOT block any writes. Write enforcement lives in
-- supabase/held/20261030_maintenance_mode_enforcement.sql and stays on hold until the policy inventory
-- (scripts/maintenance-mode/policy-inventory.sql) has been reviewed.
--
-- RLS note: tables use ENABLE ROW LEVEL SECURITY with no policies and no client grants. FORCE is not
-- used so the owner-run SECURITY DEFINER functions and triggers can write their own audit rows.

begin;

create table if not exists public.maintenance_mode (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  message text,
  expected_return_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint maintenance_mode_message_len check (message is null or char_length(message) <= 500)
);

insert into public.maintenance_mode (id, enabled)
values (true, false)
on conflict (id) do nothing;

-- At most one Super User row.
create table if not exists public.maintenance_super_user (
  id boolean primary key default true check (id),
  user_id uuid not null,
  designated_at timestamptz not null default now()
);

-- At most one password hash row. Never selected by any client-callable function.
create table if not exists public.maintenance_credentials (
  id boolean primary key default true check (id),
  password_hash text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table if not exists public.maintenance_mode_audit (
  id bigint generated always as identity primary key,
  changed_at timestamptz not null default now(),
  actor uuid,
  actor_email text,
  event text not null check (event in (
    'setting_changed', 'failed_password', 'rate_limited',
    'password_set', 'password_changed', 'password_removed', 'super_user_changed'
  )),
  previous_enabled boolean,
  enabled boolean,
  message text,
  expected_return_at timestamptz,
  source text not null,
  detail text
);

create index if not exists maintenance_mode_audit_event_time_idx
  on public.maintenance_mode_audit (event, changed_at desc);

alter table public.maintenance_mode enable row level security;
alter table public.maintenance_super_user enable row level security;
alter table public.maintenance_credentials enable row level security;
alter table public.maintenance_mode_audit enable row level security;

-- No client policies and no client grants: all access is through the functions below.
revoke all on table public.maintenance_mode from public, anon, authenticated;
revoke all on table public.maintenance_super_user from public, anon, authenticated;
revoke all on table public.maintenance_credentials from public, anon, authenticated;
revoke all on table public.maintenance_mode_audit from public, anon, authenticated;

/* ---------------- audit triggers (also catch direct SQL-editor changes) ---------------- */

create or replace function public.maintenance_mode_audit_trg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.maintenance_mode_audit
    (actor, actor_email, event, previous_enabled, enabled, message, expected_return_at, source)
  values
    (auth.uid(),
     (select u.email from auth.users u where u.id = auth.uid()),
     'setting_changed', old.enabled, new.enabled, new.message, new.expected_return_at,
     case when auth.uid() is null then 'direct_sql' else 'rpc' end);
  return new;
end;
$$;

create or replace function public.maintenance_credentials_audit_trg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- The hash itself is never copied into the audit trail.
  insert into public.maintenance_mode_audit (actor, actor_email, event, source)
  values
    (auth.uid(),
     (select u.email from auth.users u where u.id = auth.uid()),
     case tg_op when 'INSERT' then 'password_set'
                when 'UPDATE' then 'password_changed'
                else 'password_removed' end,
     case when auth.uid() is null then 'direct_sql' else 'rpc' end);
  return coalesce(new, old);
end;
$$;

create or replace function public.maintenance_super_user_audit_trg()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.maintenance_mode_audit (actor, actor_email, event, source, detail)
  values
    (auth.uid(),
     (select u.email from auth.users u where u.id = auth.uid()),
     'super_user_changed',
     case when auth.uid() is null then 'direct_sql' else 'rpc' end,
     tg_op || ' ' || coalesce(new.user_id, old.user_id)::text);
  return coalesce(new, old);
end;
$$;

revoke all on function public.maintenance_mode_audit_trg() from public, anon, authenticated;
revoke all on function public.maintenance_credentials_audit_trg() from public, anon, authenticated;
revoke all on function public.maintenance_super_user_audit_trg() from public, anon, authenticated;

drop trigger if exists maintenance_mode_audit on public.maintenance_mode;
create trigger maintenance_mode_audit
after update on public.maintenance_mode
for each row execute function public.maintenance_mode_audit_trg();

drop trigger if exists maintenance_credentials_audit on public.maintenance_credentials;
create trigger maintenance_credentials_audit
after insert or update or delete on public.maintenance_credentials
for each row execute function public.maintenance_credentials_audit_trg();

drop trigger if exists maintenance_super_user_audit on public.maintenance_super_user;
create trigger maintenance_super_user_audit
after insert or update or delete on public.maintenance_super_user
for each row execute function public.maintenance_super_user_audit_trg();

/* ---------------- status (safe for anon) ---------------- */

-- Exposes only: flag, message, return time, and whether THE CALLER is the Super User / an admin.
create or replace function public.get_maintenance_status()
returns table (
  enabled boolean,
  message text,
  expected_return_at timestamptz,
  updated_at timestamptz,
  is_super_user boolean,
  can_manage boolean,
  password_configured boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(m.enabled, false),
    m.message,
    m.expected_return_at,
    m.updated_at,
    coalesce(
      auth.uid() is not null
      and exists (select 1 from public.maintenance_super_user su where su.user_id = auth.uid()),
      false),
    r.is_admin,
    r.is_admin and exists (select 1 from public.maintenance_credentials c where c.id = true)
  from (select 1) s0
  left join public.maintenance_mode m on m.id = true
  cross join lateral (
    select exists (
      select 1 from public.user_roles ur
      where ur.user_id = auth.uid() and ur.role = 'admin'
    ) as is_admin
  ) r;
$$;

revoke all on function public.get_maintenance_status() from public;
grant execute on function public.get_maintenance_status() to anon, authenticated;

/* ---------------- toggle (admin role + maintenance password) ---------------- */

-- Failures are RETURNED as codes rather than raised, so the audit rows written for failed attempts are
-- committed (a raised exception would roll them back and defeat rate limiting).
-- Codes: ok | bad_password | rate_limited | password_not_configured | no_super_user
-- Raised (no state change): 42501 not an admin / not signed in, 22023 invalid input.
create or replace function public.set_maintenance_mode(
  p_enabled boolean,
  p_message text default null,
  p_expected_return_at timestamptz default null,
  p_password text default null
)
returns table (ok boolean, code text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_message text := nullif(btrim(p_message), '');
  v_is_super boolean;
  v_hash text;
  v_window constant interval := interval '15 minutes';
  v_user_limit constant int := 5;
  v_global_limit constant int := 15;
begin
  if v_uid is null
     or not exists (
       select 1 from public.user_roles ur
       where ur.user_id = v_uid and ur.role = 'admin'
     ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_enabled is null then
    raise exception 'enabled is required' using errcode = '22023';
  end if;
  if v_message is not null and char_length(v_message) > 500 then
    raise exception 'message too long' using errcode = '22023';
  end if;
  if p_enabled and p_expected_return_at is not null
     and (p_expected_return_at <= now() or p_expected_return_at > now() + interval '90 days') then
    raise exception 'expected return time must be in the next 90 days' using errcode = '22023';
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;
  v_is_super := exists (select 1 from public.maintenance_super_user su where su.user_id = v_uid);

  -- Serialise all password attempts so parallel requests cannot guess past the limits.
  perform pg_advisory_xact_lock(hashtextextended('maintenance_mode_password', 0));

  -- Only the Super User turning maintenance OFF skips the password (emergency recovery).
  if not (v_is_super and not p_enabled) then
    if (select count(*) from public.maintenance_mode_audit a
         where a.event = 'failed_password' and a.actor = v_uid
           and a.changed_at > now() - v_window) >= v_user_limit
       or (select count(*) from public.maintenance_mode_audit a
            where a.event = 'failed_password'
              and a.changed_at > now() - v_window) >= v_global_limit then
      if not exists (select 1 from public.maintenance_mode_audit a
                      where a.event = 'rate_limited' and a.actor = v_uid
                        and a.changed_at > now() - v_window) then
        insert into public.maintenance_mode_audit (actor, actor_email, event, source)
        values (v_uid, v_email, 'rate_limited', 'rpc');
      end if;
      return query select false, 'rate_limited'::text;
      return;
    end if;

    select c.password_hash into v_hash from public.maintenance_credentials c where c.id = true;
    if v_hash is null then
      return query select false, 'password_not_configured'::text;
      return;
    end if;

    if p_password is null or p_password = ''
       or v_hash <> extensions.crypt(p_password, v_hash) then
      insert into public.maintenance_mode_audit (actor, actor_email, event, source)
      values (v_uid, v_email, 'failed_password', 'rpc');
      return query select false, 'bad_password'::text;
      return;
    end if;
  end if;

  -- Never start maintenance unless a valid Super User exists, otherwise everyone (admins included)
  -- would be locked out and only the Dashboard could recover.
  if p_enabled and not exists (
       select 1
       from public.maintenance_super_user su
       join auth.users u on u.id = su.user_id
     ) then
    return query select false, 'no_super_user'::text;
    return;
  end if;

  -- Turning maintenance off clears the message and return time so stale text cannot reappear.
  update public.maintenance_mode m
     set enabled = p_enabled,
         message = case when p_enabled then v_message else null end,
         expected_return_at = case when p_enabled then p_expected_return_at else null end,
         updated_at = now(),
         updated_by = v_uid
   where m.id = true;

  return query select true, 'ok'::text;
end;
$$;

revoke all on function public.set_maintenance_mode(boolean, text, timestamptz, text) from public, anon;
grant execute on function public.set_maintenance_mode(boolean, text, timestamptz, text) to authenticated;

/* ---------------- password management (Super User only) ---------------- */

-- Codes: ok | weak_password | bad_password | rate_limited. Raised 42501 unless caller is the Super User.
-- If no password is configured yet, the Super User sets the first one without a current password.
create or replace function public.set_maintenance_password(
  p_new_password text,
  p_current_password text default null
)
returns table (ok boolean, code text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_hash text;
  v_window constant interval := interval '15 minutes';
  v_user_limit constant int := 5;
  v_global_limit constant int := 15;
begin
  if v_uid is null
     or not exists (select 1 from public.maintenance_super_user su where su.user_id = v_uid) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- bcrypt only uses the first 72 bytes.
  if p_new_password is null
     or char_length(p_new_password) < 12
     or octet_length(p_new_password) > 72 then
    return query select false, 'weak_password'::text;
    return;
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;
  perform pg_advisory_xact_lock(hashtextextended('maintenance_mode_password', 0));

  select c.password_hash into v_hash from public.maintenance_credentials c where c.id = true;

  if v_hash is not null then
    if (select count(*) from public.maintenance_mode_audit a
         where a.event = 'failed_password' and a.actor = v_uid
           and a.changed_at > now() - v_window) >= v_user_limit
       or (select count(*) from public.maintenance_mode_audit a
            where a.event = 'failed_password'
              and a.changed_at > now() - v_window) >= v_global_limit then
      return query select false, 'rate_limited'::text;
      return;
    end if;

    if p_current_password is null or p_current_password = ''
       or v_hash <> extensions.crypt(p_current_password, v_hash) then
      insert into public.maintenance_mode_audit (actor, actor_email, event, source)
      values (v_uid, v_email, 'failed_password', 'rpc');
      return query select false, 'bad_password'::text;
      return;
    end if;
  end if;

  insert into public.maintenance_credentials as c (id, password_hash, updated_at, updated_by)
  values (true, extensions.crypt(p_new_password, extensions.gen_salt('bf', 12)), now(), v_uid)
  on conflict (id) do update
     set password_hash = excluded.password_hash,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by;

  return query select true, 'ok'::text;
end;
$$;

revoke all on function public.set_maintenance_password(text, text) from public, anon;
grant execute on function public.set_maintenance_password(text, text) to authenticated;

commit;

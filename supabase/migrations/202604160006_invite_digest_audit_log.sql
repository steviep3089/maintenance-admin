create table if not exists public.invite_digest_runs (
  id bigserial primary key,
  triggered_at timestamptz not null default now(),
  success boolean not null,
  reason text,
  recipients text[] not null default '{}'::text[],
  recipients_count integer not null default 0,
  invites_expiring_today integer not null default 0,
  invites_expired_pending integer not null default 0,
  inactive_soon integer not null default 0,
  deactivated integer not null default 0,
  error text,
  details jsonb not null default '{}'::jsonb
);

alter table public.invite_digest_runs enable row level security;

drop policy if exists invite_digest_runs_select_admin on public.invite_digest_runs;
create policy invite_digest_runs_select_admin
on public.invite_digest_runs
for select
to authenticated
using (
  exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role in ('admin', 'manager')
  )
);

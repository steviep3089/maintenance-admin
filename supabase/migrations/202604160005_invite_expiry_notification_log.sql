-- Track admin reminder emails to avoid duplicate notifications per invite cycle.

create table if not exists public.invite_expiry_notifications (
  user_id uuid not null references auth.users (id) on delete cascade,
  invite_sent_at timestamptz not null,
  notified_at timestamptz not null default now(),
  primary key (user_id, invite_sent_at)
);

alter table public.invite_expiry_notifications enable row level security;

-- Admin and manager can read notification history.
drop policy if exists invite_expiry_notifications_select_admin on public.invite_expiry_notifications;
create policy invite_expiry_notifications_select_admin
on public.invite_expiry_notifications
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

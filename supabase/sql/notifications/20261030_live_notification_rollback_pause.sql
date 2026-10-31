-- Emergency rollback to a safe paused state.
-- Keeps the existing on_defect_created trigger and daily-user-digest cron job
-- installed, but makes their caller functions no-ops. It never restores the
-- exposed Authorization JWT or legacy shared-secret headers.
--
-- Expects the verified LIVE daily-user-digest job (ID 2) to have been changed
-- to call public.run_daily_user_digest(true, false). The job name, active
-- state, and 0 8 * * * schedule are left unchanged.
--
-- Apply only after explicit approval if the cutover must be paused.

begin;

do $$
declare
  digest_job record;
begin
  select jobid, jobname, schedule, command, active
    into digest_job
  from cron.job
  where jobid = 2;

  if not found
     or digest_job.jobname <> 'daily-user-digest'
     or digest_job.schedule <> '0 8 * * *'
     or digest_job.active is distinct from true
     or digest_job.command <> 'select public.run_daily_user_digest(true, false);' then
    raise exception 'Expected the cutover daily digest job state; rollback pause aborted';
  end if;
end
$$;

create or replace function public.notify_defect_created()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return new;
end;
$$;

create or replace function public.run_daily_user_digest(
  p_dry_run boolean default true,
  p_allow_deactivation boolean default false
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  return;
end;
$$;

alter function public.run_daily_user_digest(boolean, boolean) owner to postgres;

commit;

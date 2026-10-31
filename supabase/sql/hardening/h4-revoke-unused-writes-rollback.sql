-- ROLLBACK for h4-revoke-unused-writes.sql: re-grants exactly the privileges h4 revoked. No identity guard on purpose.
begin;
set local lock_timeout = '5s';

do $h4rb$
declare
  t text;
begin
  foreach t in array array['defects', 'defect_activity', 'user_roles', 'divisions', 'invite_digest_runs', 'invite_expiry_notifications',
                           'plant_asset_divisions', 'plant_assets', 'repairs', 'user_divisions'] loop
    if to_regclass('public.' || t) is not null then
      execute format('grant insert, update, delete on table public.%I to anon', t);
    end if;
  end loop;
  foreach t in array array['user_roles', 'invite_digest_runs', 'invite_expiry_notifications'] loop
    if to_regclass('public.' || t) is not null then
      execute format('grant insert, update, delete on table public.%I to authenticated', t);
    end if;
  end loop;
end
$h4rb$;

commit;

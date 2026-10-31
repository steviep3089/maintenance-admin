-- Maintenance Mode enforcement CHECK (writes + both photo buckets, ON and OFF). TESTING ONLY (etffoumsopxjptnmhvwh).
-- Run in the TESTING SQL editor as `postgres`, AFTER 20261030_maintenance_mode_enforcement_TESTING_apply.sql.
-- (Running it BEFORE the apply gives a baseline: it will report enforcement_present=false and verdict NOT_ENFORCED.)
--
-- NON-DESTRUCTIVE BY CONSTRUCTION: it is ONE `do` block with no COMMIT, and it always ends by raising an
-- exception, which rolls back every change it made (the temporary Maintenance ON, test rows, test storage
-- rows and the audit rows). The final "error" is therefore expected: its message is the report.
-- It writes only copies/markers named 'maintenance-check', and sends nothing: it aborts if any user trigger
-- exists on defects/defect_activity (so no notification can be queued even inside the rolled-back transaction).
--
-- Method (differential, so it needs no assumptions about existing policies): for each actor and operation it
-- records the outcome with Maintenance OFF, then ON:
--   allowed      the statement affected >= 1 row (INSERT succeeded)
--   zero_rows    the statement succeeded but affected 0 rows  <- what a blocked UPDATE/DELETE looks like
--   denied:<code> an error, e.g. 42501 = row-level security / privilege violation (a blocked INSERT)
-- PASS requires: Super User outcomes identical OFF vs ON; every operation that the ordinary user (a manager,
-- else any non-Super-User) could do OFF is NOT 'allowed' ON; same for anon. Operations the ordinary user could
-- not do even OFF are listed as `inconclusive_ops` (existing permissions already deny them - not a failure).
-- Report format per operation and actor: "<OFF outcome>><ON outcome>".
--
-- INCONCLUSIVE OPERATIONS AND THE PROBE PASS: if the existing policies already deny an operation for the ordinary
-- user even with Maintenance OFF (e.g. there is no UPDATE/DELETE policy on defect_activity, no UPDATE policy on
-- storage.objects, no DELETE policy on defects), the first pass cannot tell whether Maintenance Mode would also
-- block it. A second "probe" pass therefore re-tests ONLY those operations after creating a TEMPORARY permissive
-- policy (maintenance_check_tmp_*) for each, inside this same transaction. It exists only until the final
-- rollback, never persists and changes no real permission. The probe proves "if some policy ever allowed this,
-- Maintenance Mode would still block it". Results appear as probe:<op> in probe_matrix.
-- Verdicts: PASS (everything, including probes, conclusive and correct); PASS_PARTIAL (nothing wrong, but some op
-- could not be probed: see probe_error / probe_ineffective / unprobeable, e.g. probe_error=42501 means the editor
-- role cannot create policies on storage.objects); FAIL; NOT_ENFORCED (the nine policies are not present).
-- Creating a policy briefly takes a lock on the table until the rollback; run it when TESTING is idle.
do $check$
declare
  v_super uuid;
  v_other uuid;
  v_cols text;
  v_base text;
  v_def text;
  v_act text;
  v_pd text;
  v_pr text;
  v_results jsonb := '[]'::jsonb;
  v_state text;
  v_actor text;
  v_uid text;
  v_names text[];
  v_sqls text[];
  v_i int;
  v_n bigint;
  v_outcome text;
  v_present int;
  v_bad_other int;
  v_bad_anon int;
  v_bad_super int;
  v_inconclusive jsonb;
  v_matrix jsonb;
  v_verdict text;
  v_pass text;
  v_op text;
  v_known text[] := array['defect_activity_update', 'defect_activity_delete', 'defect_photo_update', 'repair_photo_update', 'defects_delete'];
  v_probe_ops text[] := '{}';
  v_unprobeable jsonb := '[]'::jsonb;
  v_probe_err text := 'none';
  v_ddl text;
  v_pbad_other int := 0;
  v_pbad_anon int := 0;
  v_pbad_super int := 0;
  v_pineffective jsonb := '[]'::jsonb;
  v_pmatrix jsonb;
begin
  perform set_config('statement_timeout', '60s', true);
  perform set_config('lock_timeout', '5s', true);

  select su.user_id into v_super from public.maintenance_super_user su where su.id = true;
  if v_super is null then raise exception 'Abort: designate the Super User first.'; end if;
  if (select enabled from public.maintenance_mode where id = true) is distinct from false then
    raise exception 'Abort: Maintenance Mode must be OFF before running this check.';
  end if;
  if exists (
    select 1 from pg_trigger t
    where not t.tgisinternal and t.tgenabled <> 'D'
      and t.tgrelid in ('public.defects'::regclass, 'public.defect_activity'::regclass)
  ) then
    raise exception 'Abort: a user trigger exists on defects/defect_activity; this check would fire it (even though rolled back).';
  end if;

  select ur.user_id into v_other from public.user_roles ur where ur.role = 'manager' and ur.user_id <> v_super limit 1;
  if v_other is null then
    select u.id into v_other from auth.users u where u.id <> v_super order by u.created_at limit 1;
  end if;
  if v_other is null then raise exception 'Abort: need one user other than the Super User.'; end if;

  select string_agg(format('%I', c.column_name), ',' order by c.ordinal_position) into v_cols
  from information_schema.columns c
  where c.table_schema = 'public' and c.table_name = 'defects'
    and c.column_name <> 'id' and c.is_generated = 'NEVER' and c.is_identity = 'NO';
  select d.id::text into v_base from public.defects d order by d.id limit 1;
  if v_base is null then raise exception 'Abort: TESTING needs at least one existing defect row to copy.'; end if;

  select count(*) into v_present from pg_policies where policyname like 'maintenance\_block\_%' and permissive = 'RESTRICTIVE';

  foreach v_pass in array array['base', 'probe'] loop
  if v_pass = 'probe' then
    -- Operations the existing policies already deny (so Maintenance Mode cannot be isolated) are re-tested with a
    -- TEMPORARY permissive policy that exists only inside this rolled-back transaction. No real policy is changed.
    execute 'reset role';
    select coalesce(array_agg(distinct x.op), '{}') into v_probe_ops
      from jsonb_to_recordset(v_results) as x(state text, actor text, op text, outcome text)
      where x.actor = 'other_user' and x.state = 'OFF' and x.outcome <> 'allowed' and x.op = any(v_known);
    select coalesce(jsonb_agg(distinct x.op), '[]'::jsonb) into v_unprobeable
      from jsonb_to_recordset(v_results) as x(state text, actor text, op text, outcome text)
      where x.actor = 'other_user' and x.state = 'OFF' and x.outcome <> 'allowed' and not (x.op = any(v_known));
    begin
      foreach v_op in array v_probe_ops loop
        v_ddl := case v_op
          when 'defect_activity_update' then 'on public.defect_activity as permissive for update to anon, authenticated using (true) with check (true)'
          when 'defect_activity_delete' then 'on public.defect_activity as permissive for delete to anon, authenticated using (true)'
          when 'defect_photo_update' then 'on storage.objects as permissive for update to anon, authenticated using (bucket_id = ''defect-photos'') with check (bucket_id = ''defect-photos'')'
          when 'repair_photo_update' then 'on storage.objects as permissive for update to anon, authenticated using (bucket_id = ''repair-photos'') with check (bucket_id = ''repair-photos'')'
          when 'defects_delete' then 'on public.defects as permissive for delete to anon, authenticated using (true)'
        end;
        execute 'create policy ' || quote_ident('maintenance_check_tmp_' || v_op) || ' ' || v_ddl;
      end loop;
    exception when others then
      v_probe_err := sqlstate;  -- e.g. 42501 not owner of storage.objects: probe skipped, reported as unavailable
      v_probe_ops := '{}';
    end;
    if cardinality(v_probe_ops) = 0 then continue; end if;
  end if;

  foreach v_state in array array['OFF', 'ON'] loop
    if v_state = 'ON' then
      update public.maintenance_mode set enabled = true where id = true;  -- rolled back with everything else
    else
      update public.maintenance_mode set enabled = false where id = true;
    end if;

    foreach v_actor in array array['super_user', 'other_user', 'anon'] loop
      -- fixtures, created as the editor role (bypasses RLS) and discarded by the final rollback
      execute 'reset role';
      execute format('insert into public.defects (%s) select %s from public.defects where id::text = %L returning id::text',
                     v_cols, v_cols, v_base) into v_def;
      insert into public.defect_activity (defect_id, message, performed_by)
        select d.id, 'maintenance-check', 'maintenance-check' from public.defects d where d.id::text = v_base
        returning id::text into v_act;
      insert into storage.objects (bucket_id, name)
        values ('defect-photos', 'maintenance-check/' || gen_random_uuid()::text || '.txt') returning id::text into v_pd;
      insert into storage.objects (bucket_id, name)
        values ('repair-photos', 'maintenance-check/' || gen_random_uuid()::text || '.txt') returning id::text into v_pr;

      v_names := array[
        'defects_insert', 'defects_update', 'defect_activity_insert', 'defect_activity_update', 'defect_activity_delete',
        'defect_photo_insert', 'defect_photo_update', 'defect_photo_delete',
        'repair_photo_insert', 'repair_photo_update', 'repair_photo_delete', 'defects_delete'];
      v_sqls := array[
        format('insert into public.defects (%s) select %s from public.defects where id::text = %L', v_cols, v_cols, v_base),
        format('update public.defects set id = id where id::text = %L', v_def),
        format('insert into public.defect_activity (defect_id, message, performed_by) select id, %L, %L from public.defects where id::text = %L', 'maintenance-check', 'maintenance-check', v_base),
        format('update public.defect_activity set message = message where id::text = %L', v_act),
        format('delete from public.defect_activity where id::text = %L', v_act),
        $$insert into storage.objects (bucket_id, name) values ('defect-photos', 'maintenance-check/' || gen_random_uuid()::text || '.txt')$$,
        format('update storage.objects set name = name where id::text = %L', v_pd),
        format('delete from storage.objects where id::text = %L', v_pd),
        $$insert into storage.objects (bucket_id, name) values ('repair-photos', 'maintenance-check/' || gen_random_uuid()::text || '.txt')$$,
        format('update storage.objects set name = name where id::text = %L', v_pr),
        format('delete from storage.objects where id::text = %L', v_pr),
        format('delete from public.defects where id::text = %L', v_def)];

      v_uid := case v_actor when 'super_user' then v_super::text when 'other_user' then v_other::text else '' end;
      perform set_config('request.jwt.claim.sub', v_uid, true);
      perform set_config('request.jwt.claims',
        case when v_uid = '' then '{"role":"anon"}' else json_build_object('sub', v_uid, 'role', 'authenticated')::text end, true);
      -- Storage's own delete guard honours this transaction-local setting; it only affects this rolled-back check.
      perform set_config('storage.allow_delete_query', 'true', true);
      execute case when v_actor = 'anon' then 'set local role anon' else 'set local role authenticated' end;

      for v_i in 1 .. array_length(v_names, 1) loop
        if v_pass = 'probe' and not (v_names[v_i] = any(v_probe_ops)) then continue; end if;
        begin
          execute v_sqls[v_i];
          get diagnostics v_n = row_count;
          v_outcome := case when v_n > 0 then 'allowed' else 'zero_rows' end;
        exception when others then
          v_outcome := 'denied:' || sqlstate;
        end;
        v_results := v_results || jsonb_build_array(jsonb_build_object('state', v_state, 'actor', v_actor,
          'op', case when v_pass = 'probe' then 'probe:' else '' end || v_names[v_i], 'outcome', v_outcome));
      end loop;

      execute 'reset role';
    end loop;
  end loop;
  end loop;

  with r as (select * from jsonb_to_recordset(v_results) as x(state text, actor text, op text, outcome text)),
       p as (
         select a.op, a.actor, a.outcome as off_o, b.outcome as on_o
         from r a join r b on a.op = b.op and a.actor = b.actor and a.state = 'OFF' and b.state = 'ON'
         where a.op not like 'probe:%')
  select
    count(*) filter (where actor = 'other_user' and off_o = 'allowed' and on_o = 'allowed'),
    count(*) filter (where actor = 'anon' and off_o = 'allowed' and on_o = 'allowed'),
    count(*) filter (where actor = 'super_user' and off_o <> on_o),
    coalesce(jsonb_agg(op) filter (where actor = 'other_user' and off_o <> 'allowed'), '[]'::jsonb)
  into v_bad_other, v_bad_anon, v_bad_super, v_inconclusive
  from p;

  -- probe results: the temporary permissive policy must make the op work OFF for the ordinary user (else the probe
  -- proved nothing); then ON must block it, and the Super User must be unaffected.
  with r as (select * from jsonb_to_recordset(v_results) as x(state text, actor text, op text, outcome text)),
       p as (
         select a.op, a.actor, a.outcome as off_o, b.outcome as on_o
         from r a join r b on a.op = b.op and a.actor = b.actor and a.state = 'OFF' and b.state = 'ON'
         where a.op like 'probe:%')
  select
    count(*) filter (where actor = 'other_user' and on_o = 'allowed'),
    count(*) filter (where actor = 'anon' and off_o = 'allowed' and on_o = 'allowed'),
    count(*) filter (where actor = 'super_user' and off_o <> on_o),
    coalesce(jsonb_agg(op) filter (where actor = 'other_user' and off_o <> 'allowed'), '[]'::jsonb)
  into v_pbad_other, v_pbad_anon, v_pbad_super, v_pineffective
  from p;

  with r as (select * from jsonb_to_recordset(v_results) as x(state text, actor text, op text, outcome text)),
       p as (
         select a.op, a.actor, a.outcome || '>' || b.outcome as pair
         from r a join r b on a.op = b.op and a.actor = b.actor and a.state = 'OFF' and b.state = 'ON')
  select jsonb_object_agg(op, m) filter (where op not like 'probe:%'),
         jsonb_object_agg(op, m) filter (where op like 'probe:%')
  into v_matrix, v_pmatrix
  from (select op, jsonb_object_agg(actor, pair) as m from p group by op) q;

  v_verdict := case
    when v_present <> 9 then 'NOT_ENFORCED'
    when v_bad_other + v_bad_anon + v_bad_super + v_pbad_other + v_pbad_anon + v_pbad_super > 0 then 'FAIL'
    when jsonb_array_length(v_inconclusive) = 0 then 'PASS'
    when v_probe_err = 'none' and jsonb_array_length(v_pineffective) = 0 and jsonb_array_length(v_unprobeable) = 0 then 'PASS'
    else 'PASS_PARTIAL' end;

  raise exception 'CHECK COMPLETE - EVERYTHING WAS ROLLED BACK (this error is intentional). verdict=% restrictive_policies=% ordinary_user_still_allowed_ON=% anon_still_allowed_ON=% super_user_changed=% denied_by_existing_policies_OFF=% probe_error=% probe_ineffective=% unprobeable=% probe_ordinary_user_still_allowed_ON=% probe_anon_still_allowed_ON=% probe_super_user_changed=% matrix=% probe_matrix=%',
    v_verdict, v_present, v_bad_other, v_bad_anon, v_bad_super, v_inconclusive, v_probe_err, v_pineffective, v_unprobeable,
    v_pbad_other, v_pbad_anon, v_pbad_super, v_matrix, v_pmatrix;
end
$check$;

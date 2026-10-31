# Maintenance Mode v2 (TESTING first)

Status: prepared locally. **Nothing has been applied, deployed or run against Supabase.** No SQL was
executed and no project was accessed. Offline tests ran (see bottom).

## Security model
| Who | See Portal/app during maintenance | Can open Maintenance settings | Can turn ON | Can turn OFF |
|---|---|---|---|---|
| Anonymous, user, manager | No (maintenance screen) | No | No | No |
| Normal Admin Portal user (`admin` role) | **No** (blocked) | Yes, while maintenance is OFF | Needs maintenance password | Needs maintenance password |
| Super User (one designated admin) | **Yes** (only bypass) | Yes | Needs maintenance password | **No password needed** (emergency recovery) |

- The maintenance password is **not** a bypass. Knowing it lets an admin change the setting; it never
  lets anyone use the Portal/app while maintenance is on. A normal admin who turns maintenance ON is
  blocked straight away (the confirm dialog warns about this).
- The password is verified inside the database against a bcrypt hash (`extensions.crypt`, cost 12). The
  hash lives in `maintenance_credentials`, which clients cannot read. Neither the password nor the hash
  appears in frontend code, the status response, or the audit trail. The Super User sets/changes the
  password in the Portal, so it never appears in a SQL file.
- Rate limit: 5 failed attempts per user and 15 per project in 15 minutes -> `rate_limited`, even for the
  right password. Failures and lock-outs are audited with the signed-in user.
- Audit: `maintenance_mode_audit` records actor id/email, previous and new state, event, and source
  (`rpc` or `direct_sql` for Dashboard edits). Triggers also capture SQL-editor changes.
- Maintenance cannot be turned ON if no valid Super User exists (prevents total lock-out).
- `user_roles` and existing roles/permissions are not modified. Managers get no access.

## Files
Files (TESTING-era notes; paths are the permanent repo's): `supabase/migrations/20261030_maintenance_mode_setting.sql`,
`supabase/held/20261030_maintenance_mode_enforcement.sql` (inactive, outside `migrations/`, **on hold
until the policy inventory is reviewed**), `scripts/maintenance-mode/{policy-inventory.sql,
emergency-off.sql, designate-super-user.sql, reset-maintenance-password.sql, maintenance-mode.test.mjs,
test-testing-maintenance-mode.ps1}`, `src/{maintenanceStatus.js, useMaintenanceStatus.js,
MaintenanceMode.jsx, App.jsx}`.
Portal (`maintenance-admin`): the same four `src/` files. Mobile (`maintenance-app`):
`maintenanceStatus.js`, `MaintenanceGate.js`, `App.js`. Shared copies must stay byte-identical (tested).

## Behaviour decisions (unchanged)
- Status is checked on launch, on foreground, and every 30 seconds.
- A connection failure is not maintenance: last known state is kept; nothing known = behave normally.
  Status is not cached to disk. The Portal waits for the first check, which always settles (8 s timeout).
- UI gating is a courtesy; real protection is the held RLS enforcement. Until it is applied, a determined
  client could still write to the database.
- No durable local draft storage; the mobile overlay says unsent changes are not saved if the app closes.
- Notifications, the digest cron and HMAC dedup are untouched. Email stays dry-run, deactivation disabled.
  A request in flight at switch-over cannot be made exactly-once; an upload followed by a row update may
  be split by the switch (re-submit after recovery).

## TESTING order (each SQL step needs owner approval)
1. Run `policy-inventory.sql` in TESTING (`etffoumsopxjptnmhvwh`) only: Dashboard -> SQL editor -> paste the whole file -> Run. It is one SELECT (no data, permission, schema or setting changes) and returns policies, grants, triggers, buckets, role counts, SECURITY DEFINER function names/booleans and role attributes. Review it (especially `user_roles` writes, SECURITY DEFINER functions with `touches_target_tables` and `authenticated_can_call` both true, and any `rls_enabled=false`).
2. Apply `20261030_maintenance_mode_setting.sql` in TESTING.
3. Edit the email in `designate-super-user.sql` (local copy, do not commit) and run it. Requires an
   existing admin role; creates no role.
4. Sign in to the TESTING Portal as the Super User and set the maintenance password (Portal fieldset).
5. Run `scripts\maintenance-mode\test-testing-maintenance-mode.ps1` (`-IncludeNonAdmin`, `-IncludeAdmin`,
   `-IncludeSuperUser` with TESTING tokens, read as hidden input).
6. Manual: normal admin turns ON (wrong password rejected, 6th failure rate-limited, right password OK);
   confirm normal admin, manager and user are blocked, Super User still works; Super User turns OFF.
7. Only after inventory review: finalise/apply the enforcement policies, then repeat.

## Emergency recovery (Supabase Dashboard -> SQL editor, affected project)
- Maintenance stuck ON, Portal unusable: run `emergency-off.sql` (one UPDATE). Fallback: Table Editor ->
  `maintenance_mode` -> `enabled` = false. Clients recover within 30 s / on foreground.
- Super User can turn OFF in the Portal without the password.
- Password forgotten: run `reset-maintenance-password.sql`, then the Super User sets a new one.
- Dashboard roles are unaffected by maintenance mode. Dashboard edits are audited as `direct_sql`.

## Test scenarios
| Scenario | Expected |
|---|---|
| Anonymous, ON | Login notice / overlay; status readable; `set` rejected |
| Normal user / manager, ON | Maintenance screen; `set` rejected (42501) |
| Normal admin, OFF | Full Portal + Manage strip; toggling needs password |
| Normal admin, ON | **Blocked** with maintenance screen |
| Super User, ON | Full Portal; can OFF without password |
| Wrong password x5 | `bad_password`, then `rate_limited` (audited) |
| Supabase unreachable | No maintenance claim unless already known |
| Recovery (OFF) | Screen disappears within 30 s / on foreground |
| Digest/trigger during maintenance | Still fire; one dedup row; no real email |

## Privilege-escalation review
- All six SECURITY DEFINER functions set `search_path = ''` and qualify every object, including pgcrypto.
- Toggle/password functions re-check roles inside the body; revoked from `public`/`anon`; trigger
  functions revoked from all client roles. Failures are returned as codes (not raised) so audit rows commit.
- RLS is enabled with no policies and no grants (FORCE deliberately not used: it could block owner-run
  definer functions). Tests prove clients cannot read or write any maintenance table.
- The model depends on `public.user_roles` not being writable by non-admins. Unverifiable offline; the
  inventory covers it. If users can write their own role row they could become admin (not Super User).
- The password travels in the RPC body over HTTPS; PostgREST normally does not log bodies. Verify in TESTING logs.

## Held enforcement draft (supabase/held, inert)
Nine RESTRICTIVE policies (INSERT/UPDATE/DELETE on `defects`, `defect_activity`, and `storage.objects` for
`defect-photos`/`repair-photos` only) plus `maintenance_blocks_writes()`, which is false when maintenance is OFF
or the caller is the Super User. SELECT is not restricted. Proven offline against PostgreSQL (PGlite) on stub
tables: OFF changes nothing; ON blocks INSERT (42501) and silently filters UPDATE/DELETE to 0 rows for users,
managers and normal admins; the Super User and other buckets are unaffected. It stays commented out until the
real inventory has been reviewed. It cannot restrict SECURITY DEFINER functions or the secret key (by design).

## TESTING inventory review (actual results, reviewed)
- `user_roles`: RLS on, only two SELECT-own policies, no write policy, no triggers, and no SECURITY DEFINER
  function that writes it is callable by anon/authenticated. Table grants are broad but RLS blocks every
  client write, so no self-promotion path exists via the Data API. TESTING has one admin and one manager.
- The nine restrictive policies sit alongside the existing permissive ones (tested with the real policy set).
  Update/delete policies on tables with no matching permissive policy are harmless extras.
- No existing triggers on defects/defect_activity/user_roles in TESTING (notification trigger not active).
  The five SECURITY DEFINER functions are not callable by anon/authenticated and do not touch these tables.
- Pre-existing gaps, outside Maintenance Mode scope: anon/authenticated hold TRUNCATE/TRIGGER/REFERENCES on
  defects, defect_activity and user_roles (not reachable through the Data API, but it is excess privilege);
  `defect-photos-insert` has no auth check (anonymous upload) and both buckets are public.
- Not covered by RLS: the secret-key Edge Functions. They now call `maintenance_guard.ts` (see below; code
  prepared, not yet deployed), so a normal admin can no longer bypass maintenance by calling them directly.
- Silent zero-row updates: a blocked UPDATE/DELETE raises no error. The mobile defect-details save now checks
  rows affected. Portal update/delete calls are only reachable by admins and are covered by the screen gate.

## Edge Function protection (code ready, NOT deployed)
`supabase/functions/_shared/maintenance_guard.ts` is called by the eight secret-key functions (create-user,
delete-user, get-admin-users, list-users, resend-invite, send-report-email, upload-drive,
invite-contracts-portal) after `auth.getUser()` and the existing role check, before any sensitive step.
- OFF: no change. ON: only the Super User passes; admins and managers get HTTP 503 `Maintenance in progress`.
- If the maintenance state cannot be read it fails closed (503, generic message, nothing logged).
- `verify_jwt` stays `true` for all eight. `notify-defect` and `notify-expiring-invites` are untouched, so
  the digest, notifications and their HMAC auth keep working during maintenance. The Contracts calls made
  inside list-users / invite-contracts-portal are only reachable through these guarded functions.
- The guard reads `maintenance_mode` and `maintenance_super_user` with the secret key (service_role keeps its
  default table privileges; only anon/authenticated were revoked). If service_role lacked them, the guard would
  fail closed and block even when OFF; the smoke test below catches this before maintenance is ever ON.
- Smoke test (TESTING, you run it, it is the only thing that sends requests):
  `.\scripts\maintenance-mode\test-testing-function-maintenance.ps1 -State OFF` then `-State ON`. It signs in to
  TESTING with secure prompts, uses empty bodies for the six non-Contracts functions, and never sends an allowed
  request to `list-users` / `invite-contracts-portal` (they would contact Contracts). In the six admin-only
  functions a manager gets 403 (role check runs first); only `invite-contracts-portal` returns 503 to a manager.
  "Normal admin gets 503" needs a second TESTING admin; without one it is covered only by the offline guard tests.

## Checking TESTING logs for password exposure (without exposing a real password)
Use a throwaway canary, never the real password. 1) `$m = 'CANARY' + [guid]::NewGuid().ToString('N').Substring(0,12)`
and print only `$m`. 2) As Super User, change the TESTING maintenance password to `<m>-Aa1!zzzz` (typed into the Portal
field), then turn maintenance ON and OFF once with it. 3) Dashboard -> Logs -> Logs Explorer, run:
`select timestamp, event_message from postgres_logs where event_message like '%<m>%' limit 20` and the same
against `edge_logs`, `function_edge_logs` and `auth_logs`. Expect zero rows everywhere; copy only the marker.
4) Read-only settings check in the SQL editor: `show log_statement; show log_min_duration_statement;` (expect
`none` / `-1`) and `select rolname, rolconfig from pg_roles where rolconfig::text ~* 'log_';` (expect no rows
that enable statement logging). 5) Set the real password again through the Portal. A non-empty result in
step 3 means the password reaches logs: stop and report the table name only.

## Emergency OFF audit behaviour
`emergency-off.sql` is one UPDATE; the AFTER UPDATE trigger writes a `setting_changed` row with
`previous_enabled`/`enabled` and `source = 'direct_sql'` (it fires even if already OFF). The SQL editor has no
`auth.uid()`, so the actor is NOT recorded: who ran it is only visible in Dashboard/project audit logs. Not
audited: INSERT/DELETE/TRUNCATE on `maintenance_mode` by the table owner (it should never be deleted).

## Guard returned 503 while OFF (TESTING smoke test, diagnosed)
- Cause (reproduced in `maintenance-functions.test.mjs`): the guard reads `maintenance_mode` and
  `maintenance_super_user` with the secret key (role `service_role`). `20261030_maintenance_mode_setting.sql` never
  granted `service_role` anything and this project does not auto-grant new public tables to it, so PostgREST
  returns `42501` and the guard correctly fails closed with 503. RLS is irrelevant (`service_role` bypasses it).
- Fix: `supabase/migrations/20261030_maintenance_mode_service_role_grants.sql` grants SELECT on exactly those two
  tables (not credentials, not audit, no writes). Fail-closed behaviour is unchanged. The guard now logs only the
  error code (`Maintenance state unavailable: <stage> <code>`) in the function logs.
- Evidence still worth capturing: run `diagnose-guard-access.sql` first (expect `service_role_can_select_* = false`),
  and/or the function log line for the 503 (expect `42501`; `PGRST205` would mean a stale schema cache instead,
  fixed with `notify pgrst, 'reload schema'`).
- `invite-contracts-portal` returned 200 to anonymous and normal users because it checked for the Contracts
  environment variables, and validated the body, BEFORE authenticating. That 200 was `{success:false, "Missing
  contracts env vars"}` - no Contracts call happened - but it was an unauthenticated 200 and is now fixed: it
  authenticates, checks the role, applies the guard, and only then checks configuration and the body.

## Enforcement policies: TESTING apply / check / rollback (prepared, NOT executed)

Files (all outside `supabase/migrations/`, so `supabase db push` never runs them; TESTING `etffoumsopxjptnmhvwh` only, never LIVE):

| File | Purpose |
|---|---|
| `supabase/held/20261030_maintenance_mode_enforcement_TESTING_apply.sql` | One transaction: preflight, helper `maintenance_blocks_writes()`, 9 RESTRICTIVE policies, postcheck |
| `supabase/held/20261030_maintenance_mode_enforcement_TESTING_rollback.sql` | Drops only the 9 `maintenance_block_*` policies and the helper (no CASCADE) |
| `scripts/maintenance-mode/check-enforcement-testing.sql` | Always-rolled-back ON/OFF check for defects, defect_activity and both photo buckets |
| `scripts/maintenance-mode/verify-existing-unchanged.sql` | Fingerprint of existing objects; now ignores `maintenance_block_%` policies so it still matches the original baseline |

Order (each step needs explicit approval; run as `postgres` in the TESTING SQL editor, Maintenance OFF):
1. `verify-existing-unchanged.sql` (confirm the six rows still equal the earlier baseline).
2. `check-enforcement-testing.sql` -> expect `verdict=NOT_ENFORCED` (baseline; the "error" is intentional).
3. Apply script. It aborts, changing nothing, unless maintenance is OFF, exactly one valid admin Super User exists, no enforcement objects exist, the buckets exist and the current role can manage `storage.objects`.
4. `verify-existing-unchanged.sql` again: all six rows must still match.
5. `check-enforcement-testing.sql` -> expect `verdict=PASS`, `super_user_changed=0`, `ordinary_user_still_allowed_ON=0`, `anon_still_allowed_ON=0`.
6. Test the Portal and mobile app with maintenance ON/OFF.

Reading the check: each cell is `<OFF outcome>><ON outcome>`. Outcomes: `allowed`, `zero_rows`, `denied:<sqlstate>`. Operations the ordinary user cannot do even when OFF (`denied_by_existing_policies_OFF`, e.g. UPDATE/DELETE on `defect_activity`, UPDATE on `storage.objects`, DELETE on `defects`: no existing policy allows them) are re-tested in a **probe pass** using a TEMPORARY permissive policy that lives only inside the rolled-back transaction (no real policy is changed or weakened). Probe results show as `probe:<op>` in `probe_matrix`. Verdicts: `PASS`, `PASS_PARTIAL` (nothing wrong but some op could not be probed: see `probe_error` / `probe_ineffective` / `unprobeable`; `probe_error=42501` means the editor role cannot create policies on `storage.objects`), `FAIL`, `NOT_ENFORCED`. The probe proves "if some policy ever allowed this, Maintenance Mode would still block it"; it does not change what users can do today. The check creates only `maintenance-check` rows and everything, including the temporary ON and the temporary policies, is rolled back by its final intentional exception. It aborts if a user trigger exists on defects/defect_activity, and the temporary policies take a brief table lock until the rollback, so run it while TESTING is idle.

Identifying a blocked UPDATE/DELETE: RLS does not raise an error; the row is filtered. In SQL, `GET DIAGNOSTICS n = ROW_COUNT` or `RETURNING` gives 0 rows. In supabase-js use `.update(...).eq(...).select('id')` and treat an empty array with no error as "blocked / not saved" (done in the Portal and mobile code). A blocked INSERT raises SQLSTATE 42501.

`storage.objects` ownership (seen in TESTING: `postgres` is NOT the owner; the owner is `supabase_storage_admin`, so the first apply aborted with "cannot manage storage.objects" and changed nothing): the apply script no longer pre-checks ownership. It creates the three storage policies in a `DO` block that tries (1) the current role, then (2) `SET LOCAL ROLE supabase_storage_admin`, which succeeds only if `postgres` legitimately holds that role (nothing is granted, ownership is never changed, and the role switch is undone). If both fail, the exception aborts the entire transaction, so the six defect policies and the helper are rolled back as well: all nine are installed together or none are. The rollback script uses the same two-step path and, if neither works, aborts without dropping anything; use `emergency-off.sql` to restore writes immediately in that case. If the apply aborts with "could not create the storage.objects policies", STOP and report it. Do not grant roles or change ownership. Remaining options (ask first): create the three storage policies through a Supabase-supported route that runs as the storage owner (Dashboard Storage > Policies; whether its editor supports RESTRICTIVE policies is unverified), or deploy the six defect policies only with storage explicitly left uncovered. Storage deletes in the check set `storage.allow_delete_query` locally so Supabase's delete guard does not mask the RLS result; the check's probe policies on `storage.objects` may also be refused (reported as `probe_error`, verdict `PASS_PARTIAL`).

Rollback: run the rollback script (removes enforcement entirely), or just `emergency-off.sql` to make every policy pass immediately. Verify with `verify-existing-unchanged.sql`.

Limits: this cannot be proven against real Supabase offline (PGlite stubs only); the real check script run is the integration test. Anonymous upload to `defect-photos` is an existing gap, only blocked while ON.

## Automated offline tests
`node --test scripts/maintenance-mode/maintenance-functions.test.mjs` covers the Edge Function guard (OFF/ON,
Super User/admin/manager, missing Super User, database errors, thrown exceptions, 503 body, wiring order in all
eight functions, unchanged notification functions and `verify_jwt`) and the mobile zero-row checks.
`node --test scripts/maintenance-mode/maintenance-mode.test.mjs` runs client/static tests always. Set
`PGLITE_DIR` to a folder containing `node_modules/@electric-sql/pglite` to also run the real migration in an
in-memory PostgreSQL with stubbed Supabase auth (otherwise those tests are skipped, not passed).

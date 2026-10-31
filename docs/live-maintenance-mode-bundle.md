# LIVE Maintenance Mode rollout (project `zebksrihswwwlejdiboq`)

Prepared locally. **Nothing here has been run.** The scripts are generated from the TESTING-verified sources by
`scripts/maintenance-mode/build-live-scripts.mjs` (`node scripts\maintenance-mode\build-live-scripts.mjs`, writes the gitignored `supabase/sql/live-generated/`); a test fails if they drift.
Run SQL in the LIVE **SQL Editor** (never `supabase db push`: see `DEPLOYMENT.md`).
Every script except rollback and emergency OFF aborts unless the database is LIVE (identity guard on `notify_defect_created()`).

| File | Purpose | Writes? |
|---|---|---|
| `live-00-readiness.sql` | readiness rows (OK/REVIEW/BLOCK/INFO) | no |
| `live-01-policy-inventory.sql` | policy/grant inventory, to diff against the TESTING inventory | no |
| `live-02-baseline-fingerprint.sql` | six fingerprint rows; run before and after each step | no |
| `live-03-migration-setting.sql` | tables, functions, audit triggers; OFF by default | yes (tx) |
| `live-04-migration-service-role-grants.sql` | SELECT-only grants for the Edge guard | yes (tx) |
| `live-05-verify-first-migration.sql` | verifies 03 and 04 | no |
| `live-06-designate-super-user.sql` | designate ONE existing LIVE admin (edit the email placeholder) | yes |
| `live-07-enforcement-apply.sql` | helper + nine restrictive policies, all-or-nothing | yes (tx) |
| `live-08-enforcement-check.sql` | ON/OFF verdict; always rolled back (intentional error); disables user triggers inside its transaction | no (rolls back) |
| `live-09-enforcement-rollback.sql` | removes only the nine policies and helper | yes |
| `live-10-emergency-off.sql` | sets Maintenance OFF, restoring all writes at once | yes |

## Ordered checklist (stop conditions in bold)

1. **Prerequisites.** Take a LIVE backup/PITR marker. Choose a quiet window. Commit the Portal and mobile changes (not done yet).
2. `live-00-readiness.sql`. **STOP on any BLOCK.** Read every REVIEW. Run `live-01` and diff with the TESTING inventory; **STOP on unexplained differences** (notification trigger on `defects` is expected; `user_roles` must have no write policy). Save `live-02` output.
3. `live-03`, then `live-04`, then `live-05`. **STOP if 05 shows anything but four tables, six functions, three triggers, OFF, no anon table/RPC privileges.** Re-run `live-02`: all six rows must equal the saved baseline.
4. `live-06` with the real admin email. Verify one Super User, one audit row, Maintenance still OFF.
5. Deploy ONLY the eight functions with `.\scripts\deploy\deploy-live.ps1 -Function <name>`, one at a time (explicit LIVE ref, handler-based auth, `--no-verify-jwt`; this is how they were deployed):
   Never deploy `notify-defect` or `notify-expiring-invites` except through the same script. The versions ship the secret-key client and the 401/403 `authorizeAdmin` check. Confirm LIVE has the secret key available (`SUPABASE_SECRET_KEYS`) before deploying. Run the OFF smoke test adapted to LIVE (no emails, no Contracts calls). **STOP and redeploy the previous versions on any unexpected 401/403/503 for the Super User or an admin while OFF.**
6. Deploy the Admin Portal (Vercel, LIVE publishable key). Check it shows OFF and the Super User can open the Maintenance panel.
7. Set the maintenance password in the Portal. Run the log canary check from `README.md` (password must not appear in API/Postgres logs).
8. Build and submit the mobile apps (new iOS and Android builds are required; there is no OTA). Until users update, old builds have no gate and may show a false "saved" on a blocked UPDATE.
9. `live-07-enforcement-apply.sql`. **STOP if it raises (nothing is installed on error).** Re-run `live-02`: all six rows unchanged. Run `live-08`: required `verdict=PASS`, `super_user_changed=0`, `ordinary_user_still_allowed_ON=0`, `anon_still_allowed_ON=0`. **Any other verdict: run `live-09` immediately.**
10. Short real ON/OFF cycle from the Portal: normal user write blocked while ON, Super User allowed, OFF restores writes.

## Rollback (fastest first)
1. `live-10-emergency-off.sql` (writes restored in seconds; policies remain).
2. `live-09-enforcement-rollback.sql` (removes the nine policies and helper only). Re-run `live-02` to confirm baseline.
3. Redeploy the previous Edge Function versions; revert the Portal deployment in Vercel; mobile builds cannot be recalled (the gate is harmless when OFF).
The tables/functions from `live-03/04` are inert while OFF and are not dropped in an emergency.

## Known limits
No normal-admin account exists for a live "admin blocked while ON" test; Super User and manager paths were tested in TESTING. `plant_assets`/`divisions` and similar tables are not covered by the nine policies (Portal UI and Edge guard only). `defect-photos` anonymous upload is a pre-existing gap. Legacy credential retirement is a separate task.

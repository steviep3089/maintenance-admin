# Legacy JWT retirement and grant hardening (drafts, not executed)

Nothing here has been run against Supabase. Run order: TESTING first (delete the identity guard block in h3/h4), then LIVE.

## Files
| File | Purpose |
|---|---|
| h1-legacy-key-inventory.sql | Read-only. Finds JWT-shaped Vault secrets, function bodies, cron commands, pg_net queue headers, hooks. Never prints values. |
| h2-grants-inventory.sql | Read-only. Reports RLS state, write policies, anon/authenticated privileges, dangerous privileges. |
| h3-revoke-dangerous-privileges.sql / -rollback.sql | Revokes TRUNCATE, REFERENCES, TRIGGER, MAINTAIN from anon/authenticated on public tables. |
| h4-revoke-unused-writes.sql / -rollback.sql | Revokes writes the clients never use (anon on 10 tables; authenticated on user_roles, invite_digest_runs, invite_expiry_notifications). |

Order: h1 + h2 (read-only) -> review -> h3 -> h4 -> re-run live-02 (new baseline expected, `table_grants_and_rls` changes) -> smoke tests (Portal ON/OFF, mobile sign-in/defect create, LIVE function test, notification probes).
Rollback: run the matching `-rollback.sql` files in reverse order (h4 then h3).

## Issues
| Issue | Evidence | Risk | Fix | TESTING verification | LIVE dependency |
|---|---|---|---|---|---|
| service_role JWT committed in public repo | maintenance-admin migration 20260105 line 15; public repo; in history | Full DB bypass until legacy secret revoked | Retire legacy keys (sequence below); optional history purge | n/a | h1 clean, secrets confirmed |
| Legacy anon JWTs in history and old APKs | maintenance-app history, apks, app.zip | Old builds break on revocation | Force-update old builds first | Test current build | Build inventory |
| Stale function sources use SUPABASE_SERVICE_ROLE_KEY | old testbranch / pre-consolidation copies | Redeploy regresses | Resolved: `maintenance-admin/supabase/functions` is the only deploy source (`docs/DEPLOYMENT.md`) | n/a | none |
| Possible old Vault secret / pg_net / cron residue | unverified | Key stored at rest | Run h1, delete findings | h1 on TESTING | h1 on LIVE |
| TRUNCATE/TRIGGER/REFERENCES/MAINTAIN granted | LIVE inventory | Low via Data API, RLS bypass elsewhere | h3 | h2 before/after | h3 |
| Unused writable tables | 8 tables writable by API roles | Data tampering | h4 | smoke tests | h4 |
| defect-photos anonymous upload policy | pre-existing policy, no auth check | Anonymous uploads | Needs storage owner; not drafted | n/a | separate task |

## Retirement sequence (verify in dashboard)
1. Run h1/h2 on LIVE; clear every BLOCK.
2. Confirm no function secret named SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY is used.
3. Confirm Portal (Vercel) and current iOS/Android builds use publishable keys; cut off old builds.
4. Confirm JWT signing keys are migrated so user tokens and verify_jwt do not rely on the legacy secret.
5. Disable legacy JWT-based keys (reversible); re-run all smoke tests.
6. After a stable period, revoke the legacy JWT secret (irreversible).
7. Separately decide on history purge / making the repo private.

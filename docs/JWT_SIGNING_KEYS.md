# Edge Functions and the new JWT signing keys (local preparation; nothing deployed)

## Why
The Edge Functions gateway's legacy `verify_jwt=true` check only understands the legacy HS256 secret. Once the project
signs user tokens with an asymmetric key (ECC P-256 / ES256), the gateway would reject valid user tokens. Supabase's
documented approach is `verify_jwt=false` plus verification inside the function.

## What changed
- New `supabase/functions/_shared/user_auth.ts` -> `getAuthenticatedUser(req, supabase)`:
  requires `Authorization: Bearer <JWT-shaped token>` (cheap pre-filter, so a publishable key never reaches Auth),
  then calls `supabase.auth.getUser(token)` with the existing secret-key admin client. Supabase Auth verifies the
  signature with whichever key is current (HS256 now, ES256 later), plus expiry and that the user still exists.
  It also requires `aud = authenticated`. Anything else returns null (fail closed). It never decodes or verifies a token
  locally and reads no signing secret.
- Eight functions use it instead of inline `getUser`: create-user, delete-user, get-admin-users, list-users,
  resend-invite, send-report-email, upload-drive, invite-contracts-portal. Order is unchanged:
  authenticate (401) -> role in `user_roles` (403; invite-contracts-portal admin or manager, the rest admin) ->
  Maintenance Mode guard (503) -> work. invite-contracts-portal's 401 no longer echoes the Auth error text.
- `supabase/config.toml`: `verify_jwt = false` for those eight (notify-defect / notify-expiring-invites untouched).
- Why `@supabase/server` was not used: it is not in the repo or verified here, and the in-handler `auth.getUser` call
  is the documented server-side equivalent that needs no new dependency. Per-request Auth call costs one round-trip;
  `auth.getClaims()` could remove it later but needs a newer supabase-js and was not introduced untested.

## Safety properties (tested offline)
Anonymous, missing, malformed, expired, tampered, wrong-key, `alg:none`, alg-confusion, legacy anon/service_role, publishable and
secret keys are all rejected before the role check, the guard, any body parsing, or any Contracts access.
A publishable key alone never authorises anything.

## Limits of the offline tests
Signature verification is performed by the hosted Auth service. Offline tests use a fake Auth that verifies HS256 and ES256
with node:crypto; they prove the wiring, not the hosted service. These need a TESTING run (below).

## TESTING deployment and smoke test (user runs; TESTING project etffoumsopxjptnmhvwh only)
1. Confirm TESTING JWT signing keys are migrated (current key HS256). Do not rotate yet.
2. (Historical; completed.) Deploy the eight functions to TESTING from the `maintenance-admin` repo with the config in `supabase/config.toml`
   (`supabase functions deploy <name> --project-ref etffoumsopxjptnmhvwh --no-verify-jwt`, one per function).
   Do not deploy the two notify functions. Confirm in the dashboard each shows JWT verification OFF.
3. Run `scripts/maintenance-mode/test-testing-function-maintenance.ps1` with Maintenance OFF (expect 39/39) and ON (40/40).
   Anonymous and malformed tokens must still be 401 (now returned by the handler); normal user/manager 403; Super User passes.
4. Rotate TESTING to ES256 in the dashboard (Settings > JWT Keys: promote the standby key, keep the HS256 key as "previously used").
   Sign in again (new tokens are ES256) and repeat step 3 both OFF and ON. Also confirm Portal sign-in and a mobile defect create.
5. Check an old (HS256) session still works before revoking anything, and note how the Contracts function is called (below).

## Remaining blockers before LIVE key rotation / legacy secret revocation
1. TESTING steps 2-4 passed, including the ES256 run (not yet run by anyone).
2. Redeploy to LIVE only after that, using `scripts\deploy\deploy-live.ps1`; then LIVE smoke (`test-live-function-maintenance.ps1`) before and after promoting ES256.
3. Anything else calling these eight functions with a non-user token (e.g. a service key or scheduled caller)
   will now get 401; the Portal and mobile app use user sessions only (confirm no other caller).
4. Other consumers of the legacy secret (Contracts/Inspections, PostgREST clients with legacy anon keys, old app builds) - see RETIREMENT.md.
5. Revoking the legacy secret is irreversible; do it only after the previous HS256 key has no live sessions that matter.

## Rollback (per function)
Redeploy the previous version of the function, or set `verify_jwt = true` again and redeploy; the handlers also work with
the gateway check on. While HS256 is the current key either state works. Never roll back after ES256 is the only active key
without first re-promoting HS256.

# Maintenance legacy-key migration — TESTING validation

This package documents the TESTING-only integration of the new Supabase API
key model. No deployment, request, SQL, key rotation, or project change has
been performed. LIVE Maintenance (`zebksrihswwwlejdiboq`) is out of scope.
Do not access Contracts or Inspections.

## Key boundaries and authentication

- Browser and mobile clients use the TESTING publishable key as `apikey`.
  Signed-in calls send the Supabase Auth access token as `Authorization:
  Bearer <user JWT>`. Never send a publishable/secret API key as a bearer token.
- The eight user-facing functions below retain the default
  `verify_jwt=true`. Supabase's gateway checks the user JWT; each function then
  independently validates the caller with Maintenance Auth and checks the
  Maintenance `user_roles` authorization before privileged operations.
- Server functions create their privileged Maintenance client from the
  platform-injected `SUPABASE_SECRET_KEYS` default entry. Do not configure a
  custom `SUPABASE_SECRET_KEY`, pass secrets in CLI arguments, or put secret
  keys in browser/mobile code.
- `supabase/config.toml` sets `verify_jwt=false` only for the two HMAC
  notification routes. Do not disable gateway JWT validation for these eight
  functions.

## TESTING deployment

Historical (already done). The maintenance-admin repo has no TESTING link, so
deploying the eight admin functions to TESTING again is a manual, explicit-ref action
(no wrapper script; `deploy-testing.ps1` only handles `prodcheck-*`). Run from
`C:\Users\steve\Codes\maintenance-admin`:

```powershell
supabase functions deploy <function-name> --project-ref etffoumsopxjptnmhvwh --no-verify-jwt
```

Never use this form for LIVE. LIVE deployments use `scripts\deploy\deploy-live.ps1` only
(see `DEPLOYMENT.md`).

## TESTING authorization probes

Set the TESTING publishable key in the current PowerShell process, then run
the probe. The key is public but must be the TESTING key:

```powershell
$env:VITE_SUPABASE_PUBLISHABLE_KEY = Read-Host 'TESTING publishable API key'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\maintenance-key-migration\test-testing-function-auth.ps1
```

The script sends requests only to `etffoumsopxjptnmhvwh`. For all eight
endpoints it expects HTTP 401 for anonymous and malformed-token requests, and
HTTP 403 for a valid non-admin TESTING user token. The non-admin token is
prompted as hidden input and is not written to output or disk. Obtain that
test account/token in TESTING before running. The non-admin requests stop
before privileged work; they do not call the separate Contracts project.

Do not run an authenticated positive request to `list-users` or
`invite-contracts-portal` under the current no-Contracts-access restriction:
their authorized paths call the separate Contracts project. Other positive
smoke tests may send invitations/email, delete accounts, or upload files.
Exercise those only with separately approved disposable TESTING data and
controlled recipients/storage. The current automated probe deliberately
does not perform those side effects.

## Current validation limits

- No Deno runtime or Supabase CLI is available in the local environment, so
  the Deno tests and deployments have not run here.
- This repository has no automated runtime tests for anonymous, malformed
  token, non-admin, or cross-project rejection in these eight handlers. The
  PowerShell probe covers anonymous, malformed, and non-admin behavior when
  run in TESTING. A cross-project JWT test is intentionally not prepared
  because it would require access to another Supabase project.
- This folder is the TESTING copy only. The real LIVE sources are sibling
  repos (see below). Do not point this folder's `src/supabaseClient.js` at LIVE.

## LIVE client sources (local, uncommitted edits)

| Component | Path | Remote | Target |
|---|---|---|---|
| Admin Portal (Vite) | `C:\Users\steve\Codes\maintenance-admin` | `steviep3089/maintenance-admin`, branch `master` | Vercel (`vercel.json`; Vercel project not verifiable locally) |
| Mobile app (Expo) | `C:\Users\steve\Codes\maintenance-app` | `steviep3089/maintenance-app`, branch `master` | EAS / App Store Connect (`ascAppId` in `eas.json`, bundle `com.steviep3089.maintenanceapp`) |

Both now read the publishable key from `VITE_SUPABASE_PUBLISHABLE_KEY` /
`EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and refuse to start unless it begins
`sb_publishable_`. Legacy anon JWT literals were removed from both clients.
`.env.example` files were added; the Portal `.gitignore` now ignores `.env*`.

## Ordered LIVE checklist (each step needs owner approval)

1. (Dashboard) Confirm a publishable key and a default secret key exist in LIVE API Keys.
2. (Dashboard, Vercel) Set `VITE_SUPABASE_PUBLISHABLE_KEY` for Production.
3. (Terminal) In `maintenance-app`: `eas env:create` for `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (environment `production`, visibility plaintext/sensitive-not-secret).
4. (Terminal) Commit + push the two repos; verify Vercel build; run an EAS production build and install it.
5. (Terminal) Deploy the eight functions to LIVE one at a time with `.\scripts\deploy\deploy-live.ps1 -Function <name>` (done; handler-based auth, `--no-verify-jwt`).
6. Smoke test (below) with the old legacy keys still active.
7. (Dashboard) Check Edge Function secrets/Vault, CI, Vercel and any automations for the old service-role JWT; replace with the injected secret key.
8. (Dashboard) Disable legacy `anon` and `service_role` keys. Do not re-enable.
9. (Dashboard) Revoke the legacy JWT secret (JWT Signing Keys). All sessions end.
10. Sign in again on Portal and mobile; repeat the smoke test.

## Smoke tests (TESTING first, then LIVE)

- Portal: sign in; Users page loads (`list-users`); defects list loads; open a defect photo (signed URL).
- Admin ops (disposable user/recipients only): create user, resend invite, delete that user, send a report email to yourself, Drive upload.
- Negative: run `scripts\maintenance-key-migration\test-testing-function-auth.ps1` (TESTING only).
- Mobile: sign in; create a defect with a photo; view it in the Portal; confirm no email is sent (real email stays disabled).
- After step 9: old bundles/tokens must fail sign-in; new sign-in must succeed.

## LIVE defect emails to division admins (ordered, each step needs owner approval)

Read-only pre-check (LIVE SQL editor): `defects.division_id` is `uuid`, `user_divisions(user_id, division_id)` exists,
and the intended division admins have a `user_roles.role='admin'` row.

1. Deploy `notify-defect` with `.\scripts\deploy\deploy-live.ps1 -Function notify-defect` (done).
2. Run `supabase/sql/notifications/20261031_defect_division_notifications.sql` in the SQL Editor (function body only; trigger unchanged; done).
3. Edge Function secrets: set `DEFECT_EMAILS_ENABLED=true`. Keep `NOTIFICATIONS_DRY_RUN=true` (digest stays dry run;
   the digest cron signs `dryRun:true` anyway). `ALLOW_DRY_RUN` must be unset in LIVE (it vetoes real sending).
   Never set `ALLOW_USER_DEACTIVATION`.
4. Verify with ONE defect in a division that has a single known admin: that admin gets one email, nobody else does;
   the function log shows one successful invocation. A defect with no division sends nothing.

Rollback: unset `DEFECT_EMAILS_ENABLED` (instant). Full rollback: run
`supabase/sql/notifications/20261031_defect_division_notifications_rollback.sql` and redeploy the previous `notify-defect`.

Limits: a failure partway through a recipient list releases the claim and the retry re-sends to recipients already
served (exactly-once email is impossible); defects without a division are completed without retry.

## Remaining credential consumers to verify (not inspectable locally)

- Deployed LIVE versions of the eight functions (may still read `SUPABASE_SERVICE_ROLE_KEY`).
- LIVE Edge Function secrets, Vault entries, Vercel/EAS env vars, CI, any Google Drive/Resend automations.
- `supabase\migrations\20260105_defect_notifications.sql` is redacted in the working tree but the exposed JWT remains in Git history; it is superseded by the HMAC cutover. See `RETIREMENT.md` for current status.
- Installed older mobile builds still embed the anon JWT and will stop working after step 8.
- Mobile `LoginScreen.js` stores the password in AsyncStorage (recommendation: remove; not changed).
- The mobile repo tracks `app.aab`, `app.zip` and `bundletool.jar` (hygiene only).

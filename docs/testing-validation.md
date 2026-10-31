# Isolated TESTING validation for the production notification package

These separately named endpoints are copies of the production package. Their
only code differences are the function runtime paths and HMAC canonical paths.
They do not overwrite `notify-defect` or `notify-expiring-invites`.

The endpoints use the direct `@supabase/supabase-js` client configured with
the platform-injected `SUPABASE_URL` and `SUPABASE_SECRET_KEYS` environment
variables. The helper selects the `default` key from the injected JSON map and
creates the client only after HMAC verification. No manually configured
`SUPABASE_SECRET_KEY` variable or legacy service-role JWT is used. The existing
TESTING HMAC signing settings are reused; this does not require changing them.
The handlers prefer `DEFECT_WEBHOOK_SIGNING_KEY` /
`INVITE_DIGEST_SIGNING_KEY`, falling back to existing
`DEFECT_WEBHOOK_SECRET` / `INVITE_DIGEST_SECRET` settings when the preferred
variable is absent.

## Before deploying

In the TESTING Dashboard, verify without revealing values:

- `ALLOW_DRY_RUN=true`
- `ALLOW_USER_DEACTIVATION` is unset or false
- Each function has at least one of its preferred or fallback HMAC settings
  configured: `DEFECT_WEBHOOK_SIGNING_KEY` or `DEFECT_WEBHOOK_SECRET`, and
  `INVITE_DIGEST_SIGNING_KEY` or `INVITE_DIGEST_SECRET`

The successful RPC and audit checks below verify that the platform-injected
default secret key is available and authorized. Do not copy or print it.

Do not use LIVE credentials or signing keys. No SQL, trigger, or cron change is
needed. Each request is signed with `dryRun=true`; digest deactivation is also
explicitly false. The digest can read TESTING users and write an audit row.

## Deploy only these temporary TESTING functions

From the repository root in PowerShell:

```powershell
supabase functions deploy prodcheck-notify-defect --project-ref etffoumsopxjptnmhvwh --workdir .\supabase-testing --no-verify-jwt
supabase functions deploy prodcheck-notify-expiring-invites --project-ref etffoumsopxjptnmhvwh --workdir .\supabase-testing --no-verify-jwt
```

Or use `.\scripts\deploy\deploy-testing.ps1 -Function <name>`.

These do not deploy or replace the existing notification functions.

## Run one signed dry-run request per endpoint

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\testing\test-prodcheck-notify-defect.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\testing\test-prodcheck-notify-expiring-invites.ps1
```

Defect recipients are the ACTIVE admins assigned to the defect's division
(`user_divisions` + `user_roles`; "active" = not banned). Run the defect script
twice: without `-DivisionId` (expect "No division assigned; notification
skipped", never an all-admin fallback) and with a real TESTING division id
(expect "Dry run: notification skipped" or "No eligible recipients", plus the
`eligibleRecipients` count, which must equal the active admins you assigned to
that division). TESTING keeps `ALLOW_DRY_RUN=true`, so no email is ever sent.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\testing\test-prodcheck-notify-defect.ps1 -DivisionId <testing-division-uuid>
```

Enter only the corresponding TESTING HMAC signing key when prompted. Scripts
show HTTP status and allowlisted response fields only, never the key, signature,
or full response body.

## Pass/fail

- Both requests return HTTP 200.
- Defect reports `success=true`, dry-run message, and `sent=0`.
- Digest reports `success=true`, `dryRun=true`, `deactivationEnabled=false`,
  and `deactivated=0`.
- Dashboard logs show successful claim and completion RPCs. The digest also
  writes its normal audit row.
- No email is delivered and no user is deactivated.

Any non-200, missing expected dry-run fields, failed RPC/audit write, or side
effect is a failure; stop and do not proceed to LIVE.

After review, remove the temporary TESTING endpoints through a separately
approved cleanup action. Do not remove the existing working notification
functions.

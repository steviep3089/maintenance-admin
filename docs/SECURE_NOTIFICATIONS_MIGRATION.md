# Secure Notifications Migration (Testing Project Only)

This runbook covers only the Maintenance testing project
`etffoumsopxjptnmhvwh`. The live Maintenance project
`zebksrihswwwlejdiboq` and the Contracts and Inspections projects are out of
scope. Do not use production credentials, endpoints, or secrets.

This local cleanup did not deploy functions, execute SQL, activate a trigger or
cron job, or send a notification request. The operator has reported that both
functions and the signed-request migration are already deployed/applied in
TESTING, and both dry-run requests returned HTTP 200. No persistent defect
trigger or digest cron schedule has been activated.

## Security behavior

- Both Edge Functions accept only `POST` requests at their exact runtime path:
  `/notify-defect` and `/notify-expiring-invites`. Their HMAC canonical paths
  remain `/functions/v1/notify-defect` and
  `/functions/v1/notify-expiring-invites`.
- `x-request-id`, `x-timestamp`, `x-signature`, method, path/query, and the SHA-256
  of the exact HTTP body bytes are covered by the HMAC-SHA256 signature.
- The canonical string is UTF-8 encoded and consists of these newline-separated
  values: `v1`, timestamp seconds, request ID, uppercase method, path/query,
  lowercase body SHA-256 hex.
- Signatures older than five minutes or more than 30 seconds in the future are
  rejected. Signature hex must be exactly 32 bytes and is compared in constant
  time.
- `x-dry-run` is ignored and is not allowed by the CORS header list. Dry-run
  behavior is controlled by environment settings, not by an unsigned header.
- `ALLOW_DRY_RUN=true` forces all requests to skip email delivery and user
  deactivation. Set it only in testing. `NOTIFICATIONS_DRY_RUN=true` also forces
  dry-run behavior.
- Digest deactivation requires both `ALLOW_USER_DEACTIVATION=true` and the
  signed body value `allowDeactivation: true`; dry-run overrides both.
- SMTP responses are checked. A rejected or incomplete send returns a failure
  status rather than reporting a successful delivery.
- User-controlled values, including invitee email addresses, are HTML-escaped
  before insertion into email content.

## Replay and retry behavior

The signed-request update migration creates a private
`public.notification_request_dedup` table and three service-role-only RPCs.
Claims use a composite `(source, request_id)` primary key and a 15-minute lease.
Only one caller can own a live claim at a time; a completed request is rejected
as a duplicate. Failed work explicitly releases its claim, and a crashed worker
can be retried after its lease expires. Database errors are never treated as
duplicates.

Request identifiers are scoped to their work:

- Defect notifications use `notify-defect:<defect UUID>`, so each defect event is
  handled once.
- Daily digests use `daily-user-digest:<UTC date>`, so retries for the same day
  share a claim but a later day has a new scope.

SMTP cannot provide exactly-once delivery. If a batch partially sends and then
fails, a retry may send again to recipients who already received the earlier
attempt. The lease token prevents stale workers from completing a newer claim,
but cannot cancel an email already accepted by SMTP. Digest deactivation is
idempotent for users already marked inactive, but if some users are deactivated
before a later failure, the retry may report a different deactivation count.

## HMAC body compatibility limitation

The SQL hashes `payload::text` as UTF-8 and passes the same `jsonb` value to
`net.http_post`; the Edge Function hashes the exact HTTP body bytes it receives.
The canonical fields, encoding, lowercase hex, and HMAC argument order match
the TypeScript implementation. The operator reported successful TESTING
HTTP 200 dry runs for both functions after the migration, confirming that the
actual request bodies for those requests passed HMAC verification. This local
cleanup did not rerun or independently verify those requests; this evidence
does not establish behavior for every possible JSON serialization.

The controlled TESTING-only integration checks used for this verification were:

1. Deploy these functions to the testing project only and verify
   `ALLOW_DRY_RUN=true`, `ALLOW_USER_DEACTIVATION` unset/false, and
   `NOTIFICATIONS_DRY_RUN=true` if configured. Do not print secret values.
2. Execute the signed-request update migration in the testing project's SQL
   editor.
3. Call `select public.run_daily_user_digest(true, false);` once and confirm the
   Edge Function accepts the signature and reports a dry run. This confirms the
   digest's pg_net body bytes and signature end to end; it may write an audit
   row but must not send email or deactivate users.
4. To check the defect helper without touching `public.defects` or installing a
   persistent trigger, create a temporary table with the fields used by the
   helper, attach a temporary `AFTER INSERT` trigger executing
   `public.notify_defect_via_edge_function()`, insert a fake defect row, and
   inspect the testing Edge Function logs/pg_net response. `ALLOW_DRY_RUN=true`
   must be verified before sending this request. The temporary table and trigger
   disappear with the SQL session.
5. Confirm both responses are HTTP 200 dry runs, no email was delivered, and no
   user was deactivated. Do not activate the persistent defect trigger or cron
   job as part of this test.

If either signature is rejected, do not activate workflows. Inspect the exact
request body received by the testing function without logging secrets, then
adjust the serializer/hash logic and repeat only after review.

## Testing-only deployment and SQL order

The following is a testing-only deployment and SQL sequence for a separately
approved re-application or a fresh test setup; the current TESTING deployment
and migration are reported as complete:

1. Verify the selected project is `etffoumsopxjptnmhvwh` and confirm
   `ALLOW_DRY_RUN=true`, `ALLOW_USER_DEACTIVATION` unset/false, and
   `NOTIFICATIONS_DRY_RUN=true` if configured. Do not print secret values.
2. Historical: the original TESTING copies of `notify-defect` and `notify-expiring-invites`
   were deployed from the old testbranch workspace and are obsolete. In the permanent repo,
   `supabase/functions/notify-*` are the LIVE (production) versions and must NOT be deployed to
   TESTING. TESTING uses the `prodcheck-*` copies in `supabase-testing/`
   (`scripts\deploy\deploy-testing.ps1`).
3. Execute only
   `supabase/sql/testing/20261029_notifications_signed_auth_update.sql` in the
   testing project's SQL editor. It replaces the existing Stage A helper
   definitions and adds the retryable claim table/RPCs. It does not create a
   persistent trigger or schedule a cron job.
4. Run the temporary-table defect test and single daily-digest call from the
   compatibility section. These issue testing-project notification requests and
   require separate approval before execution.
5. Stop after the dry-run checks. Persistent triggers and cron schedules are
   not included in this batch and require separate approval.

Do not rerun
`20261029_defect_notifications_secure.sql` or
`20261029_daily_user_digest_secure.sql` before the replacement migration: the
testing database already has the original Stage A helper functions. Do not use
the legacy-auth rollback SQL; it restores raw secrets in queued HTTP headers.

The PowerShell probes in `scripts/notifications/` are optional manual
testing-only requests. They are hardcoded to the testing project, sign the exact
UTF-8 body bytes they send, prompt for the signing key without echoing it, and
require an explicit `DRYRUN` confirmation after the operator verifies
`ALLOW_DRY_RUN=true`. Do not run them before that verification.

## Safe rollback

If the signed-request migration has been applied but triggers and schedules
remain inactive, the safest rollback is to leave them inactive and retain the
deduplication table. There is no need to revert to raw shared-secret headers.

If the helper functions must be removed from testing, first confirm there are no
active trigger/job callers, then drop the two caller functions and three RPCs:

```sql
drop function if exists public.notify_defect_via_edge_function();
drop function if exists public.run_daily_user_digest(boolean, boolean);
drop function if exists public.claim_notification_request(text, text);
drop function if exists public.complete_notification_request(text, text, uuid);
drop function if exists public.fail_notification_request(text, text, uuid);
```

Keep `public.notification_request_dedup` unless a separately reviewed cleanup is
approved. If workflows are activated in a future, approved change, first
unschedule the exact digest job and drop the persistent defect trigger, then
remove the caller functions. Do not run
`20261029_notifications_legacy_auth_rollback.sql` as a rollback.

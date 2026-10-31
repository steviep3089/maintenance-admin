# Legacy JWT key retirement — status and remaining follow-ups

## Status (as confirmed by the project owner; NOT independently verified from the Supabase dashboard by this repo's tooling)

- Legacy `anon` and `service_role` API keys are **disabled** on LIVE.
- ECC P-256 (ES256) is the **Current** JWT signing key.
- The previous HS256 signing key is **revoked**.
- A fresh LIVE Admin Portal sign-in succeeded after the revocation.
- The ten Edge Functions authenticate in the handler (user JWT via Supabase Auth, or HMAC for notifications) and use
  the secret-key client, so they do not depend on the legacy HS256 secret.

## Remaining follow-ups

1. **Git history.** The old service_role JWT is redacted in the working tree
   (`supabase/migrations/20260105_defect_notifications.sql`) but remains in Git history. With HS256 revoked it can no
   longer authenticate, but consider making the repository private or purging history separately (not done here).
2. **Vault / secrets hygiene.** Re-run `supabase/sql/hardening/h1-legacy-key-inventory.sql` on LIVE after any change and
   confirm no `jwt_shaped=true` Vault row. (A `service_role_key` Vault entry existed with `jwt_shaped=false` at the last check.)
3. **Old clients.** Mobile builds before 2.1.0 embedded the legacy anon JWT and will fail; watch Auth/Edge logs for
   "Invalid API key" and decide on a forced update. Android and older iOS builds in use were not inventoried here.
4. **Other consumers** of LIVE legacy keys (Contracts/Inspections integrations, Zapier, scripts, dashboards) were not
   inspected here; owners should confirm.
5. **Grant hardening.** `supabase/sql/hardening/h3`/`h4` (revoke excess privileges / unused writes) are drafts. Verify on
   TESTING first, then LIVE, and record a new `live-02` baseline afterwards.

## Rules

- Do not re-enable legacy keys or the revoked HS256 key as a routine rollback; fix the client instead. A revoked key
  cannot be restored.
- Never use `supabase db push` until migration history is reconciled (see `DEPLOYMENT.md`).

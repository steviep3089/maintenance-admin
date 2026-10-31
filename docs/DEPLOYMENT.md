# Deployment — single source of truth

`maintenance-admin` is the ONLY place Maintenance Edge Functions are deployed from.
The old `maintenance-admin-testbranch` folder is an archive: never deploy from it.

## Layout

| Path | Purpose |
|---|---|
| `supabase/functions/` | The ten LIVE functions + `_shared/`. Only deployable folder. |
| `supabase/config.toml` | `verify_jwt=false` for the ten functions (auth is done in each handler). No `project_id`. |
| `supabase/migrations/` | Migration history (already applied on LIVE). Do not `db push`. |
| `supabase/held/` | Inert Maintenance Mode enforcement drafts. |
| `supabase/sql/notifications`, `sql/hardening` | LIVE SQL drafts with rollbacks. Run manually in the SQL editor after review. |
| `supabase/sql/testing/` | TESTING-only SQL. Never run on LIVE. |
| `supabase-testing/` | TESTING-only `prodcheck-*` functions (own `--workdir`). |
| `supabase/sql/live-generated/` | Gitignored output of `scripts/maintenance-mode/build-live-scripts.mjs` (contains a personal email). |
| `scripts/deploy/` | The only supported deploy commands. |

## Deploy to LIVE (one function at a time)

```powershell
.\scripts\deploy\deploy-live.ps1 -Function notify-defect
```

Safeguards: allow-list of ten names, hard-coded LIVE ref and explicit `--project-ref` (ignores `supabase/.temp`),
must run from the `maintenance-admin` repo on `master` with a clean tree, prints file hash, requires typing the name,
always `--no-verify-jwt`. Never run `supabase functions deploy` bare or without a name.

## Deploy to TESTING

```powershell
.\scripts\deploy\deploy-testing.ps1 -Function prodcheck-notify-defect
```

## Before every deploy

```powershell
node --test scripts\maintenance-mode\repo-guard.test.mjs scripts\maintenance-mode\email-encoding.test.mjs scripts\maintenance-mode\defect-recipients.test.mjs
```

## Rollback

Redeploy the previous good commit: `git checkout <good-commit> -- supabase/functions/<name>`, commit on `master`,
then run `deploy-live.ps1`. SQL rollbacks sit beside each SQL draft (`*_rollback.sql`).

## Migration history and `supabase db push`

**Do not run `supabase db push` (or `db pull`/`migration repair`) from this repo** until the migration history is
reconciled: `supabase/migrations/` holds older files, some already applied manually in the SQL Editor and not recorded in
the remote history, and one historical file is redacted and must never be executed. Apply SQL only by running reviewed
files from `supabase/sql/` in the SQL Editor.

## Notes

- Secrets live only in Supabase (Edge Function secrets / Vault). Never commit them.
- The legacy service_role JWT that was committed in `20260105_defect_notifications.sql` is redacted in the working
  tree but remains in Git history; see `docs/RETIREMENT.md` for current status.
- Docs moved from the old testbranch folder describe historical steps; where a command differs, this file wins.
  Path mapping: `production/supabase/migrations` → `supabase/sql/notifications`,
  `production/hardening` → `supabase/sql/hardening` + `docs/`, `testing-validation` → `supabase-testing` +
  `supabase/sql/testing` + `scripts/testing`.

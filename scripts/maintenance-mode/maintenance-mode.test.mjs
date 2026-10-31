// Offline tests for Maintenance Mode v2. No network, no Supabase access.
//   Always-on tests:  node --test scripts/maintenance-mode/maintenance-mode.test.mjs
//   Database tests:   run the SAME command with PGLITE_DIR set to a folder containing
//                     node_modules/@electric-sql/pglite (an in-memory PostgreSQL in WASM that runs the
//                     real migration against stubbed auth objects; nothing is installed in this repo).
//                     Without PGLITE_DIR those tests are skipped and reported as skipped, not passed.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DEFAULT_MAINTENANCE_MESSAGE,
  INITIAL_MAINTENANCE_STATE,
  classifyError,
  clearPrivileges,
  describeMaintenanceCode,
  fetchMaintenanceStatus,
  formatExpectedReturn,
  localInputToIso,
  normalizeMaintenanceStatus,
  passwordRequired,
  reduceMaintenanceState,
  setMaintenanceMode,
  setMaintenancePassword,
  shouldShowMaintenance,
  validateMaintenanceForm,
  validateNewPassword,
} from "../../src/maintenanceStatus.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const stripSqlComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

const row = (over = {}) => ({
  enabled: true,
  message: "Back soon",
  expected_return_at: "2030-01-01T10:00:00Z",
  updated_at: "2026-10-30T12:00:00Z",
  is_super_user: false,
  can_manage: false,
  password_configured: false,
  ...over,
});
const fakeClient = (impl) => ({ rpc: async (name, args) => impl(name, args) });
const stateOf = (over) => ({
  loaded: true,
  checked: true,
  connectionError: false,
  status: normalizeMaintenanceStatus(row(over)),
});

/* ====================== client logic ====================== */

test("normalize: object, array and missing data", () => {
  assert.equal(normalizeMaintenanceStatus(row()).enabled, true);
  assert.equal(normalizeMaintenanceStatus([row()]).message, "Back soon");
  assert.deepEqual(normalizeMaintenanceStatus(null), INITIAL_MAINTENANCE_STATE.status);
  assert.deepEqual(normalizeMaintenanceStatus([]), INITIAL_MAINTENANCE_STATE.status);
});

test("normalize: only a literal true enables maintenance or any privilege", () => {
  assert.equal(normalizeMaintenanceStatus(row({ enabled: "true" })).enabled, false);
  assert.equal(normalizeMaintenanceStatus(row({ is_super_user: 1 })).isSuperUser, false);
  assert.equal(normalizeMaintenanceStatus(row({ is_super_user: "yes" })).isSuperUser, false);
  assert.equal(normalizeMaintenanceStatus(row({ can_manage: "true" })).canManage, false);
  assert.equal(normalizeMaintenanceStatus({ ...row(), is_admin: true }).isSuperUser, false);
});

test("normalize: trims, blanks and caps the message", () => {
  assert.equal(normalizeMaintenanceStatus(row({ message: "   " })).message, null);
  assert.equal(normalizeMaintenanceStatus(row({ message: "x".repeat(900) })).message.length, 500);
});

test("fetch: success, network failure, thrown error and server error", async () => {
  const ok = await fetchMaintenanceStatus(fakeClient(() => ({ data: [row()], error: null })));
  assert.equal(ok.ok, true);
  const net = await fetchMaintenanceStatus(
    fakeClient(() => ({ data: null, error: { message: "TypeError: Network request failed" } }))
  );
  assert.deepEqual(net, { ok: false, reason: "network" });
  const thrown = await fetchMaintenanceStatus(
    fakeClient(() => {
      throw new TypeError("Failed to fetch");
    })
  );
  assert.deepEqual(thrown, { ok: false, reason: "network" });
  const server = await fetchMaintenanceStatus(
    fakeClient(() => ({ data: null, error: { code: "PGRST202", message: "function not found" } }))
  );
  assert.deepEqual(server, { ok: false, reason: "server" });
  assert.equal(classifyError({ code: "42501", message: "forbidden" }), "server");
});

test("fetch: a hung request times out as a network failure (UI never waits forever)", async () => {
  const hung = fakeClient(() => new Promise(() => {}));
  const started = Date.now();
  const r = await fetchMaintenanceStatus(hung, 50);
  assert.deepEqual(r, { ok: false, reason: "network" });
  assert.ok(Date.now() - started < 1000);
});

test("reduce: failed check keeps last known state; offline with nothing known never claims maintenance", () => {
  const on = reduceMaintenanceState(INITIAL_MAINTENANCE_STATE, { ok: true, status: normalizeMaintenanceStatus(row()) });
  assert.equal(shouldShowMaintenance(on), true);
  const offline = reduceMaintenanceState(on, { ok: false, reason: "network" });
  assert.equal(offline.connectionError, true);
  assert.equal(shouldShowMaintenance(offline), true);
  const recovered = reduceMaintenanceState(offline, { ok: true, status: normalizeMaintenanceStatus(row({ enabled: false })) });
  assert.equal(recovered.connectionError, false);
  assert.equal(shouldShowMaintenance(recovered), false);

  const unknown = reduceMaintenanceState(INITIAL_MAINTENANCE_STATE, { ok: false, reason: "network" });
  assert.equal(unknown.connectionError, true);
  assert.equal(unknown.checked, true);
  assert.equal(shouldShowMaintenance(unknown), false);
  const serverErr = reduceMaintenanceState(INITIAL_MAINTENANCE_STATE, { ok: false, reason: "server" });
  assert.equal(serverErr.connectionError, false);
  assert.equal(INITIAL_MAINTENANCE_STATE.checked, false);
});

test("gate: ONLY the Super User bypasses (anonymous, user, manager, normal admin are all blocked)", () => {
  assert.equal(shouldShowMaintenance(stateOf({})), true); // anonymous / user / manager
  assert.equal(shouldShowMaintenance(stateOf({ can_manage: true })), true); // normal admin
  assert.equal(shouldShowMaintenance(stateOf({ can_manage: true, password_configured: true })), true); // admin who knows the password
  assert.equal(shouldShowMaintenance(stateOf({ is_super_user: true, can_manage: true })), false);
  assert.equal(shouldShowMaintenance(stateOf({ enabled: false })), false);
});

test("clearPrivileges drops stale Super User/admin flags only", () => {
  const su = stateOf({ is_super_user: true, can_manage: true, password_configured: true });
  const cleared = clearPrivileges(su);
  assert.deepEqual(
    [cleared.status.isSuperUser, cleared.status.canManage, cleared.status.passwordConfigured],
    [false, false, false]
  );
  assert.equal(shouldShowMaintenance(cleared), true);
  const plain = stateOf({});
  assert.equal(clearPrivileges(plain), plain);
});

test("password rules: Super User turning OFF is the only password-free action", () => {
  assert.equal(passwordRequired({ enabled: true, isSuperUser: true }), true);
  assert.equal(passwordRequired({ enabled: true, isSuperUser: false }), true);
  assert.equal(passwordRequired({ enabled: false, isSuperUser: false }), true);
  assert.equal(passwordRequired({ enabled: false, isSuperUser: true }), false);
});

test("form validation: lengths, return-time window and password", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const iso = (ms) => new Date(now + ms).toISOString();
  const base = { enabled: true, message: "ok", password: "pw", now };
  assert.equal(validateMaintenanceForm({ ...base, expectedReturnAt: iso(3600e3) }), null);
  assert.match(validateMaintenanceForm({ ...base, message: "x".repeat(501) }), /500/);
  assert.match(validateMaintenanceForm({ ...base, expectedReturnAt: iso(-1000) }), /future/);
  assert.match(validateMaintenanceForm({ ...base, expectedReturnAt: iso(91 * 86400e3) }), /90 days/);
  assert.match(validateMaintenanceForm({ ...base, expectedReturnAt: "garbage" }), /future/);
  assert.match(validateMaintenanceForm({ ...base, password: "" }), /password/i);
  assert.match(validateMaintenanceForm({ ...base, enabled: false, isSuperUser: false, password: "" }), /password/i);
  assert.equal(validateMaintenanceForm({ ...base, enabled: false, isSuperUser: true, password: "" }), null);
});

test("new-password validation: length, byte cap and confirmation", () => {
  assert.match(validateNewPassword("short", "short"), /12/);
  assert.match(validateNewPassword("a".repeat(12), "b".repeat(12)), /match/);
  assert.match(validateNewPassword("é".repeat(40), "é".repeat(40)), /72/);
  assert.equal(validateNewPassword("correct horse battery", "correct horse battery"), null);
});

test("date helpers handle blank and invalid input", () => {
  assert.equal(localInputToIso(""), null);
  assert.equal(localInputToIso("nope"), null);
  assert.match(localInputToIso("2030-01-01T10:00"), /^2030-01-01T/);
  assert.equal(formatExpectedReturn(null), null);
  assert.equal(formatExpectedReturn("bad"), null);
  assert.ok(formatExpectedReturn("2030-01-01T10:00:00Z", "en-GB"));
  assert.ok(DEFAULT_MAINTENANCE_MESSAGE.length > 10);
});

test("setMaintenanceMode: sends the password in the body, OFF sends no message/time, results expose only a code", async () => {
  let sent;
  const ok = await setMaintenanceMode(
    fakeClient((name, args) => {
      sent = { name, args };
      return { data: [{ ok: true, code: "ok" }], error: null };
    }),
    { enabled: false, message: "leftover", expectedReturnAt: "2030-01-01T00:00:00Z", password: "pw-123456789" }
  );
  assert.deepEqual(ok, { ok: true, code: "ok" });
  assert.equal(sent.name, "set_maintenance_mode");
  assert.deepEqual(sent.args, {
    p_enabled: false,
    p_message: null,
    p_expected_return_at: null,
    p_password: "pw-123456789",
  });

  const bad = await setMaintenanceMode(
    fakeClient(() => ({ data: [{ ok: false, code: "bad_password" }], error: null })),
    { enabled: true, password: "x" }
  );
  assert.deepEqual(bad, { ok: false, code: "bad_password" });

  const denied = await setMaintenanceMode(
    fakeClient(() => ({ error: { code: "42501", message: "forbidden detail should not leak" } })),
    { enabled: true, password: "x" }
  );
  assert.deepEqual(denied, { ok: false, code: "42501" });

  const down = await setMaintenanceMode(
    fakeClient(() => {
      throw new TypeError("Failed to fetch");
    }),
    { enabled: true, password: "x" }
  );
  assert.deepEqual(down, { ok: false, code: "network" });
});

test("setMaintenancePassword: first-time omits current; never echoes passwords back", async () => {
  let sent;
  const r = await setMaintenancePassword(
    fakeClient((name, args) => {
      sent = { name, args };
      return { data: [{ ok: true, code: "ok" }], error: null };
    }),
    { newPassword: "a-long-new-password" }
  );
  assert.deepEqual(r, { ok: true, code: "ok" });
  assert.deepEqual(sent.args, { p_new_password: "a-long-new-password", p_current_password: null });
  assert.deepEqual(JSON.stringify(r).includes("password"), false);
});

test("error text never includes server details", () => {
  for (const code of ["bad_password", "rate_limited", "password_not_configured", "no_super_user", "weak_password", "42501", "weird"]) {
    assert.doesNotMatch(describeMaintenanceCode(code), /hash|crypt|SQL|exception|stack/i);
  }
  assert.match(describeMaintenanceCode("rate_limited"), /15 minutes/);
});

/* ====================== static SQL safety ====================== */

const migration = stripSqlComments(read("supabase/migrations/20261030_maintenance_mode_setting.sql"));

test("sql: every table has RLS enabled, no policies and no client grants", () => {
  for (const t of ["maintenance_mode", "maintenance_super_user", "maintenance_credentials", "maintenance_mode_audit"]) {
    assert.match(migration, new RegExp(`alter table public\\.${t} enable row level security`));
    assert.match(migration, new RegExp(`revoke all on table public\\.${t} from public, anon, authenticated`));
  }
  assert.doesNotMatch(migration, /create policy/i);
  assert.doesNotMatch(migration, /grant\s+(select|insert|update|delete|all)[^;]*on table/i);
  assert.doesNotMatch(migration, /force row level security/i); // would block owner-run audit writes
});

test("sql: every SECURITY DEFINER function pins an empty search_path and qualifies pgcrypto", () => {
  const fns = migration.match(/create or replace function[\s\S]*?\$\$;/gi) || [];
  assert.equal(fns.length, 6);
  for (const fn of fns) {
    assert.match(fn, /security definer/i);
    assert.match(fn, /set search_path = ''/i);
  }
  assert.match(migration, /extensions\.crypt\(/);
  assert.match(migration, /extensions\.gen_salt\('bf', 12\)/);
  assert.doesNotMatch(migration, /(?<!extensions\.)\b(crypt|gen_salt|digest|hmac)\(/);
});

test("sql: toggle needs the admin role AND the password; only Super User OFF skips the password", () => {
  const fn = migration.match(/function public\.set_maintenance_mode[\s\S]*?\$\$;/i)[0];
  assert.match(fn, /v_uid is null/);
  assert.match(fn, /ur\.role = 'admin'/);
  assert.doesNotMatch(fn, /manager/);
  assert.match(fn, /not \(v_is_super and not p_enabled\)/);
  assert.match(fn, /v_hash <> extensions\.crypt\(p_password, v_hash\)/);
  assert.match(fn, /pg_advisory_xact_lock/);
  assert.match(fn, /#variable_conflict use_column/);
  // failures are returned (not raised) so audit rows commit
  assert.doesNotMatch(fn.replace(/raise exception '(forbidden|enabled is required|message too long|expected return[^']*)'[^;]*;/g, ""), /raise exception/);
  // never grants the Super User role or touches user_roles contents
  assert.doesNotMatch(migration, /(insert into|update|delete from) public\.user_roles/i);
});

test("sql: password management is Super User only, bcrypt, and audits never contain the hash", () => {
  const fn = migration.match(/function public\.set_maintenance_password[\s\S]*?\$\$;/i)[0];
  assert.match(fn, /maintenance_super_user su where su\.user_id = v_uid/);
  assert.match(fn, /octet_length\(p_new_password\) > 72/);
  const trg = migration.match(/function public\.maintenance_credentials_audit_trg[\s\S]*?\$\$;/i)[0];
  assert.doesNotMatch(trg, /password_hash/);
});

test("sql: grants - anon may only read status; toggle/password functions are authenticated only", () => {
  const anonGrants = migration.match(/grant execute on function[^;]*anon[^;]*;/gi) || [];
  assert.equal(anonGrants.length, 1);
  assert.match(anonGrants[0], /get_maintenance_status/);
  assert.match(migration, /revoke all on function public\.set_maintenance_mode\(boolean, text, timestamptz, text\) from public, anon/);
  assert.match(migration, /grant execute on function public\.set_maintenance_mode\(boolean, text, timestamptz, text\) to authenticated/);
  assert.match(migration, /revoke all on function public\.set_maintenance_password\(text, text\) from public, anon/);
  assert.match(migration, /grant execute on function public\.set_maintenance_password\(text, text\) to authenticated/);
  for (const trg of ["maintenance_mode_audit_trg", "maintenance_credentials_audit_trg", "maintenance_super_user_audit_trg"]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${trg}\\(\\) from public, anon, authenticated`));
  }
});

test("sql: status never exposes the hash, and migration is transactional and non-destructive", () => {
  const status = migration.match(/function public\.get_maintenance_status[\s\S]*?\$\$;/i)[0];
  assert.doesNotMatch(status, /password_hash/);
  assert.match(migration, /^\s*begin;/i);
  assert.match(migration, /commit;\s*$/i);
  assert.doesNotMatch(migration, /\b(drop table|truncate|delete from|alter publication)\b/i);
  assert.doesNotMatch(migration, /cron\.|net\.http|notification_request_dedup|on_defect_created|vault\./i);
  assert.doesNotMatch(migration, /on public\.(defects|defect_activity)|storage\.objects/i);
  assert.doesNotMatch(migration, /\$2[aby]\$/); // no hard-coded bcrypt hash
});

test("sql: held enforcement file is inert, outside migrations, and the Super User is the only bypass", () => {
  const heldPath = "supabase/held/20261030_maintenance_mode_enforcement.sql";
  assert.ok(existsSync(join(root, heldPath)));
  assert.equal(stripSqlComments(read(heldPath)).trim(), "");
  assert.ok(!existsSync(join(root, "supabase/migrations/20261030_maintenance_mode_enforcement.sql")));
  assert.match(read(heldPath), /maintenance_super_user/);
  assert.doesNotMatch(read(heldPath), /ur\.role = 'admin'/);
});

test("sql: operator scripts - inventory is read-only; recovery scripts are single-purpose and secret-free", () => {
  const inv = stripSqlComments(read("scripts/maintenance-mode/policy-inventory.sql")).trim();
  assert.match(inv, /^with\b/i);
  assert.equal((inv.match(/;/g) || []).length, 1);
  assert.doesNotMatch(inv, /\b(insert|update|delete|alter|drop|create|grant|revoke|truncate|vacuum|execute|do)\b\s/i);
  for (const needle of ["defects", "defect_activity", "defect-photos", "repair-photos", "storage", "pg_policies", "aclexplode"]) {
    assert.ok(inv.includes(needle), `inventory should cover ${needle}`);
  }

  const off = stripSqlComments(read("scripts/maintenance-mode/emergency-off.sql")).trim();
  assert.match(off, /^update public\.maintenance_mode\s+set enabled = false/i);
  assert.equal((off.match(/;/g) || []).length, 1);

  const reset = stripSqlComments(read("scripts/maintenance-mode/reset-maintenance-password.sql")).trim();
  assert.match(reset, /^delete from public\.maintenance_credentials where id = true;$/i);

  const des = read("scripts/maintenance-mode/designate-super-user.sql");
  assert.match(des, /REPLACE_WITH_SUPER_USER_EMAIL/);
  assert.match(des, /ur\.role = 'admin'/);
  assert.doesNotMatch(stripSqlComments(des), /@[a-z0-9-]+\.[a-z]{2,}/i); // no real email committed
  assert.doesNotMatch(stripSqlComments(des), /(insert into|update|delete from) public\.user_roles/i);
});

/* ====================== client static checks ====================== */

const clientFiles = [
  "src/maintenanceStatus.js",
  "src/useMaintenanceStatus.js",
  "src/MaintenanceMode.jsx",
  "../maintenance-app/maintenanceStatus.js",
  "../maintenance-app/MaintenanceGate.js",
];

test("clients: no secrets, hashes, service-role or direct table access; password never stored or logged", () => {
  for (const f of clientFiles) {
    const src = read(f);
    assert.doesNotMatch(src, /service_role|sb_secret|SECRET_KEY|eyJ[A-Za-z0-9_-]{20,}|\$2[aby]\$/, f);
    assert.doesNotMatch(src, /\.from\(\s*["']maintenance_/, f);
    assert.doesNotMatch(src, /localStorage|sessionStorage|AsyncStorage/, f);
    assert.doesNotMatch(src, /console\.[a-z]+\([^)]*(password|Pw\b)/i, f);
    assert.doesNotMatch(src, /VITE_.*(PASSWORD|HASH)|EXPO_PUBLIC_.*(PASSWORD|HASH)/i, f);
  }
  const ui = read("src/MaintenanceMode.jsx");
  assert.ok((ui.match(/type="password"/g) || []).length === 1); // single reusable PasswordField
  assert.match(ui, /clearSecrets\(\)/);
});

test("clients: polling is 30 seconds and every shared copy is byte-identical", () => {
  assert.match(read("src/maintenanceStatus.js"), /MAINTENANCE_POLL_MS = 30000/);
  const hash = (p) => createHash("sha256").update(readFileSync(join(root, p))).digest("hex");
  const group = (paths) => {
    assert.ok(paths.every((p) => existsSync(join(root, p))), `missing copy in ${paths}`);
    assert.equal(new Set(paths.map(hash)).size, 1, `copies differ: ${paths}`);
  };
  group(["src/maintenanceStatus.js", "../maintenance-admin/src/maintenanceStatus.js", "../maintenance-app/maintenanceStatus.js"]);
  group(["src/MaintenanceMode.jsx", "../maintenance-admin/src/MaintenanceMode.jsx"]);
  group(["src/useMaintenanceStatus.js", "../maintenance-admin/src/useMaintenanceStatus.js"]);
  group(["src/App.jsx", "../maintenance-admin/src/App.jsx"]);
});

test("clients: mobile gate - Super User only, overlay keeps navigator mounted, no durable-save claim", () => {
  const gate = read("../maintenance-app/MaintenanceGate.js");
  assert.match(gate, /AppState\.addEventListener\("change"/);
  assert.match(gate, /\{children\}[\s\S]*showOverlay/);
  assert.match(gate, /not saved if you close the app/);
  assert.doesNotMatch(gate, /saved locally|will be retried/i);
  assert.match(gate, /loginRequestedFor === windowId/);
  assert.match(gate, /Super User sign in/);
  assert.doesNotMatch(gate, /isAdmin|canManage/);
});

test("clients: Portal - gate precedes the role check, applies to normal admins, panel only for admins", () => {
  const app = read("src/App.jsx");
  const gateAt = app.indexOf("shouldShowMaintenance(maintenance)");
  const roleAt = app.indexOf('if (role !== "admin")');
  assert.ok(gateAt > 0 && gateAt < roleAt, "maintenance gate must run before the admin role check");
  assert.match(app, /if \(!maintenance\.checked\)/);
  assert.match(app, /<MaintenanceLoginNotice[\s\S]{0,80}<LoginPage \/>/);
  assert.equal((app.match(/<MaintenanceAdminPanel/g) || []).length, 1);
  assert.ok(app.indexOf("<MaintenanceAdminPanel") > roleAt);
  assert.match(read("src/MaintenanceMode.jsx"), /if \(!status\.canManage\) return null;/);
});

/* ====================== database behaviour (real PostgreSQL via PGlite) ====================== */

let db = null;
let dbSkipReason = "PGLITE_DIR not set";
if (process.env.PGLITE_DIR) {
  try {
    const base = join(process.env.PGLITE_DIR, "node_modules", "@electric-sql", "pglite", "dist");
    const { PGlite } = await import(pathToFileURL(join(base, "index.js")).href);
    const { pgcrypto } = await import(pathToFileURL(join(base, "contrib", "pgcrypto.js")).href);
    db = new PGlite({ extensions: { pgcrypto } });
    await db.waitReady;
    dbSkipReason = null;
  } catch (e) {
    dbSkipReason = `PGlite unavailable: ${String(e.message).slice(0, 80)}`;
  }
}
const dbTest = (name, fn) => test(`db: ${name}`, { skip: dbSkipReason || false }, fn);

const U = {
  normal: "00000000-0000-0000-0000-000000000001",
  admin: "00000000-0000-0000-0000-000000000002",
  admin2: "00000000-0000-0000-0000-000000000003",
  manager: "00000000-0000-0000-0000-000000000004",
  sup: "00000000-0000-0000-0000-000000000005",
};
const PW = "Correct-Horse-Battery-9";

async function as(who, sql, params = []) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [who === "anon" ? "" : who]);
  await db.exec(`set role ${who === "anon" ? "anon" : "authenticated"}`);
  try {
    const r = await db.query(sql, params);
    return { rows: r.rows, code: null };
  } catch (e) {
    return { rows: [], code: e.code || "ERR", message: String(e.message) };
  } finally {
    await db.exec("reset role");
  }
}
const toggle = (who, enabled, pw, msg = null, ret = null) =>
  as(who, "select * from public.set_maintenance_mode($1,$2,$3,$4)", [enabled, msg, ret, pw]);
const setPw = (who, next, cur = null) => as(who, "select * from public.set_maintenance_password($1,$2)", [next, cur]);
const status = (who) => as(who, "select * from public.get_maintenance_status()");
const backdateAudit = () => db.exec("update public.maintenance_mode_audit set changed_at = changed_at - interval '1 hour'");
const auditCount = async (event, actor) =>
  Number((await db.query("select count(*)::int n from public.maintenance_mode_audit where event=$1 and ($2::uuid is null or actor=$2)", [event, actor ?? null])).rows[0].n);

dbTest("install migration against stubbed Supabase objects", async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema extensions; create extension pgcrypto schema extensions;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    create table public.user_roles (user_id uuid, role text);
    grant usage on schema public to anon, authenticated;
  `);
  await db.exec(`
    insert into auth.users values
      ('${U.normal}','normal@example.test'), ('${U.admin}','admin@example.test'),
      ('${U.admin2}','admin2@example.test'), ('${U.manager}','manager@example.test'),
      ('${U.sup}','super@example.test');
    insert into public.user_roles values
      ('${U.admin}','admin'), ('${U.admin2}','admin'), ('${U.manager}','manager'), ('${U.sup}','admin');
  `);
  await db.exec(stripSqlComments(read("supabase/migrations/20261030_maintenance_mode_setting.sql")));
  const { rows } = await db.query("select enabled from public.maintenance_mode");
  assert.deepEqual(rows, [{ enabled: false }]);
});

dbTest("anonymous: can read status, cannot call write functions or read any table", async () => {
  const s = await status("anon");
  assert.equal(s.rows.length, 1);
  assert.equal(s.rows[0].is_super_user, false);
  assert.equal(s.rows[0].can_manage, false);
  assert.equal((await toggle("anon", false, "x")).code, "42501"); // permission denied for function
  assert.equal((await setPw("anon", "a-long-new-password")).code, "42501");
  for (const t of ["maintenance_mode", "maintenance_credentials", "maintenance_super_user", "maintenance_mode_audit"]) {
    assert.equal((await as("anon", `select * from public.${t}`)).code, "42501", t);
  }
});

dbTest("authenticated users cannot read or write any maintenance table directly", async () => {
  for (const who of [U.normal, U.admin, U.sup]) {
    for (const t of ["maintenance_mode", "maintenance_credentials", "maintenance_super_user", "maintenance_mode_audit"]) {
      assert.equal((await as(who, `select * from public.${t}`)).code, "42501", `${who} select ${t}`);
    }
    assert.equal((await as(who, "update public.maintenance_mode set enabled = true")).code, "42501");
    assert.equal((await as(who, "delete from public.maintenance_credentials")).code, "42501");
    assert.equal((await as(who, "insert into public.maintenance_super_user (user_id) values ('" + U.admin + "')")).code, "42501");
  }
});

dbTest("non-admins and managers cannot toggle (42501) even with a password", async () => {
  assert.equal((await toggle(U.normal, true, PW)).code, "42501");
  assert.equal((await toggle(U.manager, true, PW)).code, "42501");
  assert.equal((await setPw(U.admin, "a-long-new-password")).code, "42501"); // admin is not the Super User
  const s = await status(U.manager);
  assert.equal(s.rows[0].can_manage, false);
});

dbTest("admin cannot start maintenance before a password exists", async () => {
  const r = await toggle(U.admin, true, PW);
  assert.deepEqual(r.rows, [{ ok: false, code: "password_not_configured" }]);
  assert.equal(await auditCount("failed_password"), 0);
});

dbTest("designate Super User (script logic), then Super User sets the first password", async () => {
  const script = read("scripts/maintenance-mode/designate-super-user.sql").replace("REPLACE_WITH_SUPER_USER_EMAIL", "super@example.test");
  await db.exec(script);
  const unknown = read("scripts/maintenance-mode/designate-super-user.sql").replace("REPLACE_WITH_SUPER_USER_EMAIL", "nobody@example.test");
  await assert.rejects(() => db.exec(unknown), /No admin user found/);
  const nonAdmin = read("scripts/maintenance-mode/designate-super-user.sql").replace("REPLACE_WITH_SUPER_USER_EMAIL", "normal@example.test");
  await assert.rejects(() => db.exec(nonAdmin), /No admin user found/);

  assert.deepEqual((await setPw(U.sup, "short")).rows, [{ ok: false, code: "weak_password" }]);
  assert.deepEqual((await setPw(U.sup, "é".repeat(40))).rows, [{ ok: false, code: "weak_password" }]);
  assert.deepEqual((await setPw(U.sup, PW)).rows, [{ ok: true, code: "ok" }]);

  const { rows } = await db.query("select password_hash from public.maintenance_credentials");
  assert.equal(rows.length, 1);
  assert.match(rows[0].password_hash, /^\$2[aby]\$12\$/); // bcrypt, cost 12
  assert.ok(!rows[0].password_hash.includes(PW));
  assert.equal(await auditCount("password_set"), 1);
  const audit = JSON.stringify((await db.query("select * from public.maintenance_mode_audit")).rows);
  assert.ok(!audit.includes(PW) && !audit.includes(rows[0].password_hash), "audit must not contain password or hash");
});

dbTest("status flags: Super User bypass is distinct from admin management", async () => {
  const a = (await status(U.admin)).rows[0];
  assert.deepEqual([a.is_super_user, a.can_manage, a.password_configured], [false, true, true]);
  const s = (await status(U.sup)).rows[0];
  assert.deepEqual([s.is_super_user, s.can_manage, s.password_configured], [true, true, true]);
  const n = (await status(U.normal)).rows[0];
  assert.deepEqual([n.is_super_user, n.can_manage, n.password_configured], [false, false, false]);
});

dbTest("wrong password is rejected, audited with the signed-in user, and does not change state", async () => {
  const r = await toggle(U.admin, true, "wrong-password-1");
  assert.deepEqual(r.rows, [{ ok: false, code: "bad_password" }]);
  assert.deepEqual((await toggle(U.admin, true, null)).rows, [{ ok: false, code: "bad_password" }]);
  assert.deepEqual((await toggle(U.admin, true, "")).rows, [{ ok: false, code: "bad_password" }]);
  assert.equal(await auditCount("failed_password", U.admin), 3);
  const { rows } = await db.query("select actor_email, source from public.maintenance_mode_audit where event='failed_password' limit 1");
  assert.deepEqual(rows[0], { actor_email: "admin@example.test", source: "rpc" });
  assert.equal((await db.query("select enabled from public.maintenance_mode")).rows[0].enabled, false);
  await backdateAudit();
});

dbTest("rate limiting: 5 failures per user lock further attempts, even with the right password", async () => {
  for (let i = 0; i < 5; i++) await toggle(U.admin, true, `nope-${i}-xxxxxx`);
  const locked = await toggle(U.admin, true, PW);
  assert.deepEqual(locked.rows, [{ ok: false, code: "rate_limited" }]);
  assert.equal((await db.query("select enabled from public.maintenance_mode")).rows[0].enabled, false);
  await toggle(U.admin, true, PW); // second locked attempt: only one rate_limited row per window
  assert.equal(await auditCount("rate_limited", U.admin), 1);
  // another admin is not locked by the first admin's failures
  const other = await toggle(U.admin2, true, "wrong-pw-other");
  assert.deepEqual(other.rows, [{ ok: false, code: "bad_password" }]);
  await backdateAudit();
  assert.deepEqual((await toggle(U.admin, true, "wrong-after-window")).rows, [{ ok: false, code: "bad_password" }]);
  await backdateAudit();
});

dbTest("global rate limit: 15 failures across users lock everyone", async () => {
  for (let i = 0; i < 5; i++) {
    await toggle(U.admin, true, `g1-${i}-xxxxxxxxx`);
    await toggle(U.admin2, true, `g2-${i}-xxxxxxxxx`);
  }
  // admin2 reaches its own limit; spread the last failures via the Super User changing password wrongly
  for (let i = 0; i < 5; i++) await setPw(U.sup, "a-new-long-password-x", `g3-${i}-xxxxxxxxx`);
  assert.ok((await auditCount("failed_password")) >= 15);
  assert.deepEqual((await toggle(U.admin2, true, PW)).rows, [{ ok: false, code: "rate_limited" }]);
  assert.deepEqual((await setPw(U.sup, "a-new-long-password-x", PW)).rows, [{ ok: false, code: "rate_limited" }]);
  await backdateAudit();
});

dbTest("correct password starts maintenance; admin who knows the password is NOT exempt; Super User is", async () => {
  const r = await toggle(U.admin, true, PW, "  Upgrading  ", new Date(Date.now() + 3600e3).toISOString());
  assert.deepEqual(r.rows, [{ ok: true, code: "ok" }]);
  const a = (await status(U.admin)).rows[0];
  assert.equal(a.enabled, true);
  assert.equal(a.message, "Upgrading");
  assert.equal(a.is_super_user, false); // no bypass from the password or the admin role
  assert.equal(a.can_manage, true);
  const gate = (r) => shouldShowMaintenance({ status: normalizeMaintenanceStatus(r) });
  assert.equal(gate(a), true);
  const s = (await status(U.sup)).rows[0];
  assert.equal(s.is_super_user, true);
  assert.equal(gate(s), false);
  for (const who of [U.normal, U.manager, U.admin2, "anon"]) {
    assert.equal(gate((await status(who)).rows[0]), true, `${who} must be blocked`);
  }
  const ch = (await db.query("select actor, actor_email, previous_enabled, enabled, source from public.maintenance_mode_audit where event='setting_changed' order by id desc limit 1")).rows[0];
  assert.deepEqual(ch, { actor: U.admin, actor_email: "admin@example.test", previous_enabled: false, enabled: true, source: "rpc" });
});

dbTest("while ON: normal admin needs the password to turn OFF; Super User does not", async () => {
  assert.deepEqual((await toggle(U.admin2, false, null)).rows, [{ ok: false, code: "bad_password" }]);
  assert.deepEqual((await toggle(U.admin2, false, "wrong-password-z")).rows, [{ ok: false, code: "bad_password" }]);
  assert.equal((await db.query("select enabled from public.maintenance_mode")).rows[0].enabled, true);
  assert.deepEqual((await toggle(U.sup, false, null)).rows, [{ ok: true, code: "ok" }]);
  const m = (await db.query("select enabled, message, expected_return_at from public.maintenance_mode")).rows[0];
  assert.deepEqual(m, { enabled: false, message: null, expected_return_at: null });
  const last = (await db.query("select actor, actor_email from public.maintenance_mode_audit where event='setting_changed' order by id desc limit 1")).rows[0];
  assert.deepEqual(last, { actor: U.sup, actor_email: "super@example.test" });
  await backdateAudit();
});

dbTest("Super User turning ON still needs the password", async () => {
  assert.deepEqual((await toggle(U.sup, true, null)).rows, [{ ok: false, code: "bad_password" }]);
  assert.deepEqual((await toggle(U.sup, true, PW)).rows, [{ ok: true, code: "ok" }]);
  assert.deepEqual((await toggle(U.sup, false, null)).rows, [{ ok: true, code: "ok" }]);
  await backdateAudit();
});

dbTest("input validation raises without changing state or auditing", async () => {
  assert.equal((await toggle(U.admin, true, PW, "x".repeat(501))).code, "22023");
  assert.equal((await toggle(U.admin, true, PW, null, new Date(Date.now() - 1000).toISOString())).code, "22023");
  assert.equal((await toggle(U.admin, true, PW, null, new Date(Date.now() + 91 * 86400e3).toISOString())).code, "22023");
  assert.equal((await as(U.admin, "select * from public.set_maintenance_mode(null, null, null, $1)", [PW])).code, "22023");
  assert.equal((await db.query("select enabled from public.maintenance_mode")).rows[0].enabled, false);
});

dbTest("password change: needs the current password, retires the old one, never reaches the audit trail", async () => {
  assert.deepEqual((await setPw(U.sup, "Another-Long-Password-1", "not-the-current-pw")).rows, [{ ok: false, code: "bad_password" }]);
  assert.deepEqual((await setPw(U.sup, "Another-Long-Password-1", null)).rows, [{ ok: false, code: "bad_password" }]);
  assert.deepEqual((await setPw(U.sup, "Another-Long-Password-1", PW)).rows, [{ ok: true, code: "ok" }]);
  assert.equal(await auditCount("password_changed"), 1);
  assert.deepEqual((await toggle(U.admin, true, PW)).rows, [{ ok: false, code: "bad_password" }]); // old password retired
  assert.deepEqual((await toggle(U.admin, true, "Another-Long-Password-1")).rows, [{ ok: true, code: "ok" }]);
  assert.deepEqual((await toggle(U.sup, false, null)).rows, [{ ok: true, code: "ok" }]);
  const audit = JSON.stringify((await db.query("select * from public.maintenance_mode_audit")).rows);
  assert.ok(!audit.includes("Another-Long-Password-1") && !audit.includes(PW));
  await backdateAudit();
});

dbTest("maintenance cannot start without a valid Super User (no accidental total lockout)", async () => {
  await db.exec("delete from public.maintenance_super_user");
  assert.deepEqual((await toggle(U.admin, true, "Another-Long-Password-1")).rows, [{ ok: false, code: "no_super_user" }]);
  await db.exec(`insert into public.maintenance_super_user (id, user_id) values (true, '00000000-0000-0000-0000-0000000000ff')`);
  assert.deepEqual((await toggle(U.admin, true, "Another-Long-Password-1")).rows, [{ ok: false, code: "no_super_user" }]); // user not in auth.users
  await db.exec(`update public.maintenance_super_user set user_id = '${U.sup}'`);
  assert.ok((await auditCount("super_user_changed")) >= 3);
});

dbTest("Dashboard recovery: emergency OFF and password reset work and are audited as direct_sql", async () => {
  assert.deepEqual((await toggle(U.admin, true, "Another-Long-Password-1")).rows, [{ ok: true, code: "ok" }]);
  // The Dashboard SQL editor has no JWT subject.
  await db.query("select set_config('request.jwt.claim.sub', '', false)");
  await db.exec(stripSqlComments(read("scripts/maintenance-mode/emergency-off.sql")));
  assert.equal((await db.query("select enabled from public.maintenance_mode")).rows[0].enabled, false);
  const off = (await db.query("select actor, source, enabled from public.maintenance_mode_audit where event='setting_changed' order by id desc limit 1")).rows[0];
  assert.deepEqual(off, { actor: null, source: "direct_sql", enabled: false });

  await db.exec(stripSqlComments(read("scripts/maintenance-mode/reset-maintenance-password.sql")));
  assert.equal(await auditCount("password_removed"), 1);
  assert.deepEqual((await toggle(U.admin, true, "Another-Long-Password-1")).rows, [{ ok: false, code: "password_not_configured" }]);
  assert.deepEqual((await setPw(U.sup, "Brand-New-Password-22")).rows, [{ ok: true, code: "ok" }]); // first password needs no current
  assert.deepEqual((await toggle(U.admin, true, "Brand-New-Password-22")).rows, [{ ok: true, code: "ok" }]);
  assert.deepEqual((await toggle(U.sup, false, null)).rows, [{ ok: true, code: "ok" }]);
});

dbTest("roles are untouched by any of the above", async () => {
  const { rows } = await db.query("select user_id::text, role from public.user_roles order by user_id");
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.role).sort(), ["admin", "admin", "admin", "manager"]);
});

/* ====================== held enforcement draft + inventory (real PostgreSQL via PGlite) ====================== */

// Extract the commented-out executable statements from the held draft (in memory only; the file stays inert).
function heldStatements() {
  const out = [];
  let cur = null;
  let isFn = false;
  for (const line of read("supabase/held/20261030_maintenance_mode_enforcement.sql").split(/\r?\n/)) {    if (cur === null && /^-- (create (or replace function|policy)|revoke all on function|grant execute on function)/.test(line)) {
      cur = [];
      isFn = /create or replace function/.test(line);
    }
    if (cur !== null) {
      cur.push(line.replace(/^-- ?/, ""));
      if (isFn ? /\$\$;\s*$/.test(line) : /;\s*$/.test(line)) {
        out.push(cur.join("\n"));
        cur = null;
      }
    }
  }
  return out;
}

test("held draft: 9 restrictive policies on exactly the intended objects, nothing else", () => {
  const stmts = heldStatements();
  const policies = stmts.filter((s) => /^create policy/.test(s));
  assert.equal(policies.length, 9);
  for (const p of policies) {
    assert.match(p, /as restrictive/);
    assert.match(p, /to anon, authenticated/);
    assert.match(p, /maintenance_blocks_writes\(\)/);
    assert.match(p, /on (public\.defects|public\.defect_activity|storage\.objects)\b/);
    assert.doesNotMatch(p, /for select/);
  }
  assert.equal(policies.filter((p) => /storage\.objects/.test(p) && !/defect-photos/.test(p)).length, 0);
  const all = stmts.join("\n");
  assert.doesNotMatch(all, /user_roles|auth\.users|notification|cron\.|net\./i);
  assert.match(all, /maintenance_super_user su\s+where su\.user_id = auth\.uid\(\)/);
});

dbTest("held draft enforcement: OFF changes nothing; ON blocks everyone except the Super User; reads and other buckets unaffected", async () => {
  await db.exec(`
    create table public.defects (id serial primary key, title text);
    create table public.defect_activity (id serial primary key, note text);
    create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id serial primary key, bucket_id text, name text);
    insert into storage.buckets values ('defect-photos','defect-photos',false,null,null), ('repair-photos','repair-photos',false,null,null), ('other','other',false,null,null);
    grant usage on schema storage to anon, authenticated;
    grant select, insert, update, delete on public.defects, public.defect_activity, storage.objects to authenticated;
    grant usage on all sequences in schema public to authenticated;
    grant usage on all sequences in schema storage to authenticated;
    alter table public.defects enable row level security;
    alter table public.defect_activity enable row level security;
    alter table storage.objects enable row level security;
    create policy existing_all on public.defects for all to authenticated using (true) with check (true);
    create policy existing_all on public.defect_activity for all to authenticated using (true) with check (true);
    create policy existing_all on storage.objects for all to authenticated using (true) with check (true);
    insert into public.defects (title) values ('seed');
    insert into storage.objects (bucket_id, name) values ('defect-photos', 'seed.jpg');
  `);
  const writes = (who) => [
    () => as(who, "insert into public.defects (title) values ('x')"),
    () => as(who, "update public.defects set title = 'seed' returning id"),
    () => as(who, "insert into public.defect_activity (note) values ('x')"),
    () => as(who, "insert into storage.objects (bucket_id, name) values ('repair-photos', 'a.jpg')"),
    () => as(who, "update storage.objects set name = name returning id"),
  ];
  const rowCount = async (sql) => Number((await db.query(sql)).rows[0].n);

  for (const stmt of heldStatements()) await db.exec(stmt);
  assert.equal(await rowCount("select count(*)::int n from pg_policies where policyname like 'maintenance_block_%' and permissive = 'RESTRICTIVE'"), 9);

  // OFF: existing permissions are preserved for every role
  assert.equal((await status(U.normal)).rows[0].enabled, false);
  for (const who of [U.normal, U.manager, U.admin, U.sup]) {
    for (const w of writes(who)) assert.equal((await w()).code, null, `OFF should allow ${who}`);
  }
  // OFF: updates really do change rows
  assert.ok((await as(U.normal, "update public.defects set title = 'seed' returning id")).rows.length > 0);

  // ON (normal admin turns it on with the password; Super User exists)
  assert.deepEqual((await toggle(U.admin, true, "Brand-New-Password-22")).rows, [{ ok: true, code: "ok" }]);
  const before = await rowCount("select count(*)::int n from public.defects");
  for (const who of [U.normal, U.manager, U.admin, U.admin2]) {
    for (const w of writes(who)) {
      const r = await w();
      // INSERT violates WITH CHECK (42501); UPDATE/DELETE are filtered by USING to zero rows, silently.
      assert.ok(r.code === "42501" || (r.code === null && r.rows.length === 0), `ON should block ${who}, got ${r.code}`);
    }
    assert.equal((await as(who, "delete from public.defects")).rows.length, 0);
  }
  assert.equal(await rowCount("select count(*)::int n from public.defects"), before, "blocked users must not delete or change rows");
  // other buckets and reads stay available
  assert.equal((await as(U.normal, "insert into storage.objects (bucket_id, name) values ('other', 'o.txt')")).code, null);
  assert.ok((await as(U.normal, "select * from public.defects")).rows.length > 0);
  assert.ok((await as(U.normal, "select * from storage.objects where bucket_id = 'defect-photos'")).rows.length > 0);
  // anonymous: no permissive policy exists, so still denied
  assert.ok((await as("anon", "insert into public.defects (title) values ('x')")).code);
  // Super User is the only bypass
  for (const w of writes(U.sup)) assert.equal((await w()).code, null, "Super User must keep write access");
  // Status/maintenance functions keep working during maintenance (recovery path)
  assert.deepEqual((await toggle(U.sup, false, null)).rows, [{ ok: true, code: "ok" }]);
  for (const w of writes(U.normal)) assert.equal((await w()).code, null, "OFF must restore access");
});

dbTest("held draft is fail-closed without a Super User, and Dashboard emergency OFF restores access", async () => {
  await db.exec("update public.maintenance_mode set enabled = true");
  await db.exec("delete from public.maintenance_super_user");
  assert.equal((await as(U.sup, "insert into public.defects (title) values ('x')")).code, "42501");
  await db.exec(stripSqlComments(read("scripts/maintenance-mode/emergency-off.sql")));
  assert.equal((await as(U.normal, "insert into public.defects (title) values ('x')")).code, null);
  await db.exec(`insert into public.maintenance_super_user (id, user_id) values (true, '${U.sup}')`);
});

dbTest("inventory SQL executes read-only and reports the expected sections", async () => {
  const before = JSON.stringify((await db.query("select count(*) from pg_policies")).rows);
  const { rows } = await db.query(stripSqlComments(read("scripts/maintenance-mode/policy-inventory.sql")).replace(/;\s*$/, ""));
  const sections = new Set(rows.map((r) => r.section));
  for (const s of ["rls_status", "policy", "table_grant", "bucket", "user_roles_values", "definer_function", "role_attribute"]) {
    assert.ok(sections.has(s), `missing section ${s}`);
  }
  const fn = rows.filter((r) => r.section === "definer_function" && /set_maintenance_mode/.test(r.object))[0];
  assert.equal(fn.detail.search_path_pinned, true);
  assert.equal(fn.detail.anon_can_call, false);
  assert.ok(!JSON.stringify(rows).includes("password_hash"));
  assert.equal(JSON.stringify((await db.query("select count(*) from pg_policies")).rows), before);
});

/* ====================== real TESTING policy set (from the reviewed inventory) + held draft ====================== */

dbTest("real TESTING policies coexist with the held draft; user_roles cannot be self-promoted", async () => {
  await db.exec(`
    do $$ declare r record; begin
      for r in select schemaname, tablename, policyname from pg_policies
               where (schemaname, tablename) in (('public','defects'),('public','defect_activity'),('public','user_roles'),('storage','objects'))
      loop execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename); end loop;
    end $$;
    create or replace function auth.role() returns text language sql stable as
      $$ select case when auth.uid() is null then 'anon' else 'authenticated' end $$;
    grant execute on function auth.role() to anon, authenticated;
    alter table public.defects add column if not exists created_by uuid;
    alter table public.defects add column if not exists assigned_to uuid;
    alter table public.user_roles enable row level security;
    grant select, insert, update, delete, truncate on public.user_roles, public.defects, public.defect_activity to anon, authenticated;
    grant select, insert, update, delete on storage.objects to anon, authenticated;
    grant usage on all sequences in schema storage to anon;
    create policy "User can read own role" on public.user_roles for select to public using (auth.uid() = user_id);
    create policy "Users can see their own role" on public.user_roles for select to public using (auth.uid() = user_id);

    create policy "Authenticated users can update defects" on public.defects for update to authenticated using (true) with check (true);
    create policy "Insert defects (any logged in)" on public.defects for insert to public with check (auth.role() = 'authenticated');
    create policy "Read defects (logged in)" on public.defects for select to public using (auth.role() = 'authenticated');
    create policy "Update defects (any user, admin can override lock)" on public.defects for update to public using (auth.uid() is not null) with check (auth.uid() is not null);
    create policy "Users can insert defects" on public.defects for insert to public with check (auth.role() = 'authenticated');
    create policy "Users can view their own and others defects" on public.defects for select to public using (auth.role() = 'authenticated');
    create policy "Users or admins can update defects" on public.defects for update to authenticated
      using (created_by = auth.uid() or assigned_to = auth.uid() or exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'))
      with check (created_by = auth.uid() or assigned_to = auth.uid() or exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'));

    create policy "Admins can view activity" on public.defect_activity for select to public
      using (auth.role() = 'authenticated' and exists (select 1 from user_roles ur where ur.user_id = auth.uid() and ur.role = 'admin'));
    create policy "All authenticated users can insert activity" on public.defect_activity for insert to public with check (auth.role() = 'authenticated');
    create policy "Managers can view activity logs" on public.defect_activity for select to public
      using (exists (select 1 from user_roles where user_roles.user_id = auth.uid() and user_roles.role = 'manager'));

    create policy "defect-photos-delete" on storage.objects for delete to public using (bucket_id = 'defect-photos' and auth.role() = 'authenticated');
    create policy "defect-photos-insert" on storage.objects for insert to public with check (bucket_id = 'defect-photos');
    create policy "defect-photos-select" on storage.objects for select to public using (bucket_id = 'defect-photos');
    create policy "repair-photos-delete" on storage.objects for delete to public using (bucket_id = 'repair-photos' and auth.role() = 'authenticated');
    create policy "repair-photos-insert" on storage.objects for insert to public with check (bucket_id = 'repair-photos' and auth.role() = 'authenticated');
    create policy "repair-photos-select" on storage.objects for select to public using (bucket_id = 'repair-photos');

    update public.maintenance_mode set enabled = false;
    delete from public.defects; delete from public.defect_activity; delete from storage.objects;
    insert into public.defects (title, created_by) values ('seed', '${U.normal}');
    insert into storage.objects (bucket_id, name) values ('defect-photos', 'seed.jpg'), ('repair-photos', 'seed2.jpg');
  `);
  // no name collision between the existing policies and the draft
  const existing = (await db.query("select policyname from pg_policies where policyname like 'maintenance_%'")).rows;
  assert.equal(existing.length, 0);

  // user_roles: no write policy exists, so RLS blocks every client write (grants alone are not enough)
  const rolesBefore = JSON.stringify((await db.query("select user_id::text, role from public.user_roles order by user_id, role")).rows);
  for (const who of [U.normal, U.manager, U.admin]) {
    assert.equal((await as(who, "insert into public.user_roles (user_id, role) values ($1, 'admin')", [who])).code, "42501", `${who} insert`);
    assert.equal((await as(who, "update public.user_roles set role = 'admin' returning user_id")).rows.length, 0, `${who} update`);
    assert.equal((await as(who, "delete from public.user_roles returning user_id")).rows.length, 0, `${who} delete`);
  }
  assert.equal((await as("anon", "insert into public.user_roles (user_id, role) values ($1, 'admin')", [U.normal])).code, "42501");
  assert.equal(JSON.stringify((await db.query("select user_id::text, role from public.user_roles order by user_id, role")).rows), rolesBefore);

  // baseline with maintenance OFF (existing behaviour preserved)
  assert.equal((await as(U.normal, "insert into public.defects (title) values ('n')")).code, null);
  assert.equal((await as(U.normal, "update public.defects set title = 'seed' where title = 'seed' returning id")).rows.length, 1);
  assert.equal((await as(U.normal, "insert into public.defect_activity (note) values ('n')")).code, null);
  assert.equal((await as(U.normal, "insert into storage.objects (bucket_id, name) values ('repair-photos', 'ok.jpg')")).code, null);
  assert.equal((await as("anon", "insert into storage.objects (bucket_id, name) values ('defect-photos', 'anon.jpg')")).code, null); // pre-existing gap

  for (const stmt of heldStatements()) await db.exec(stmt);
  assert.equal((await db.query("select count(*)::int n from pg_policies where policyname like 'maintenance_block_%' and permissive = 'RESTRICTIVE'")).rows[0].n, 9);

  // still OFF: nothing changes for anyone after applying the draft
  assert.equal((await as(U.manager, "insert into public.defects (title) values ('m')")).code, null);
  assert.equal((await as(U.normal, "update public.defects set title = 'seed' where title = 'seed' returning id")).rows.length, 1);
  assert.equal((await as("anon", "insert into storage.objects (bucket_id, name) values ('defect-photos', 'anon2.jpg')")).code, null);

  // ON
  await db.exec("update public.maintenance_mode set enabled = true");
  const blocked = async (who, sql) => {
    const r = await as(who, sql);
    return r.code === "42501" || (r.code === null && r.rows.length === 0);
  };
  for (const who of [U.normal, U.manager, U.admin, U.admin2, "anon"]) {
    assert.ok(await blocked(who, "insert into public.defects (title) values ('x')"), `defects insert ${who}`);
    assert.ok(await blocked(who, "update public.defects set title = 'x' returning id"), `defects update ${who}`);
    assert.ok(await blocked(who, "delete from public.defects returning id"), `defects delete ${who}`);
    assert.ok(await blocked(who, "insert into public.defect_activity (note) values ('x')"), `activity insert ${who}`);
    assert.ok(await blocked(who, "insert into storage.objects (bucket_id, name) values ('defect-photos', 'x.jpg')"), `defect photo insert ${who}`);
    assert.ok(await blocked(who, "insert into storage.objects (bucket_id, name) values ('repair-photos', 'x.jpg')"), `repair photo insert ${who}`);
    assert.ok(await blocked(who, "delete from storage.objects where bucket_id in ('defect-photos','repair-photos') returning id"), `photo delete ${who}`);
  }
  // Super User keeps the existing permissions, reads and status stay open for everyone
  assert.equal((await as(U.sup, "insert into public.defects (title) values ('s')")).code, null);
  assert.equal((await as(U.sup, "update public.defects set title = 'seed' where title = 'seed' returning id")).rows.length, 1);
  assert.equal((await as(U.sup, "insert into storage.objects (bucket_id, name) values ('defect-photos', 's.jpg')")).code, null);
  assert.ok((await as(U.normal, "select * from public.defects")).rows.length > 0);
  assert.ok((await as("anon", "select * from storage.objects where bucket_id = 'defect-photos'")).rows.length > 0);
  assert.equal((await as(U.manager, "select role from public.user_roles")).rows.length, 1);
  assert.equal((await status("anon")).rows[0].enabled, true);
  // normal admin (blocked by maintenance) cannot undo it without the password, so recovery stays with Super User / Dashboard
  assert.deepEqual((await toggle(U.admin2, false, "wrong-password-q")).rows, [{ ok: false, code: "bad_password" }]);
  assert.deepEqual((await toggle(U.sup, false, null)).rows, [{ ok: true, code: "ok" }]);
  assert.equal((await as(U.normal, "insert into public.defects (title) values ('back')")).code, null);
});

/* ====================== TESTING apply / rollback / check scripts ====================== */

const applySql = () => read("supabase/held/20261030_maintenance_mode_enforcement_TESTING_apply.sql");
const rollbackSql = () => read("supabase/held/20261030_maintenance_mode_enforcement_TESTING_rollback.sql");
const checkSql = () => read("scripts/maintenance-mode/check-enforcement-testing.sql");
const policySnapshot = async () =>
  JSON.stringify(
    (await db.query(
      "select schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check from pg_policies where policyname not like 'maintenance\\_block\\_%' order by 1,2,3",
    )).rows,
  );
const countBlock = async () => (await db.query("select count(*)::int n from pg_policies where policyname like 'maintenance\\_block\\_%'")).rows[0].n;
const runScript = async (sql) => {
  try {
    await db.exec(sql);
    return null;
  } catch (e) {
    await db.exec("rollback").catch(() => {});
    return String(e.message);
  }
};
const checkReport = async () => {
  const msg = await runScript(checkSql());
  assert.match(msg ?? "", /CHECK COMPLETE - EVERYTHING WAS ROLLED BACK/, msg);
  return msg;
};

test("TESTING enforcement scripts: static safety properties", () => {
  const apply = stripSqlComments(applySql());
  const rollback = stripSqlComments(rollbackSql());
  const check = stripSqlComments(checkSql());
  for (const p of ["defects_insert", "defects_update", "defects_delete", "defect_activity_insert", "defect_activity_update", "defect_activity_delete", "photo_objects_insert", "photo_objects_update", "photo_objects_delete"]) {
    assert.ok(apply.includes(`maintenance_block_${p}`), `apply creates ${p}`);
    assert.ok(rollback.includes(`maintenance_block_${p}`), `rollback drops ${p}`);
  }
  assert.equal((apply.match(/create policy/g) || []).length, 9);
  assert.equal((rollback.match(/^drop policy if exists/gm) || []).length, 6);
  assert.equal((rollback.match(/drop policy if exists %I on storage\.objects/g) || []).length, 2);
  assert.doesNotMatch(apply + rollback, /grant\s+supabase_storage_admin|alter\s+\w+\s+\S+\s+owner/i);
  assert.equal((apply.match(/set local role supabase_storage_admin/g) || []).length, 1);
  assert.equal((rollback.match(/set local role supabase_storage_admin/g) || []).length, 1);
  assert.equal((apply.match(/as restrictive/g) || []).length, 9);
  // apply grants only the helper's execute; never roles, ownership or table privileges
  assert.equal((apply.match(/^\s*grant\b/gim) || []).length, 1);
  assert.match(apply, /grant execute on function public\.maintenance_blocks_writes\(\) to anon, authenticated;/);
  assert.doesNotMatch(apply + rollback, /alter\s+(table|function|schema).*owner|grant\s+\w+\s+to\s+postgres|disable row level|force row level|\bcascade\b/i);
  assert.doesNotMatch(apply + rollback + check, /user_roles\s+(set|values)|cron\.|net\.http|notify|auth\.users\s+(set|values)|insert into auth\.|delete from auth\./i);
  // rollback only drops policies and the helper, nothing else
  assert.deepEqual([...new Set((rollback.match(/^\s*(drop|alter|create|delete|update|insert|truncate|revoke|grant)\s+\w+/gim) || []).map((s) => s.trim().split(/\s+/)[0].toLowerCase() + " " + s.trim().split(/\s+/)[1].toLowerCase()))].sort(), ["drop function", "drop policy"]);
  // the apply/rollback live outside the active migrations directory
  assert.ok(!existsSync(join(root, "supabase/migrations/20261030_maintenance_mode_enforcement_TESTING_apply.sql")));
  assert.ok(!existsSync(join(root, "supabase/migrations/20261030_maintenance_mode_enforcement_TESTING_rollback.sql")));
  // the check can never commit and always ends by raising
  assert.doesNotMatch(check, /\b(commit|savepoint|release)\b/i);
  assert.match(check, /raise exception 'CHECK COMPLETE/);
  assert.match(check, /Maintenance Mode must be OFF/);
  assert.match(check, /public\.maintenance_mode set enabled = true/);
  // the held draft keeps the same helper and policy bodies as the apply script
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  for (const stmt of heldStatements().filter((s) => /^create policy|^create or replace function/.test(s))) {
    assert.ok(norm(apply).includes(norm(stmt)), `apply must match held draft: ${norm(stmt).slice(0, 60)}`);
  }
});

dbTest("TESTING scripts: check baseline, apply preflight aborts, apply, check, rollback", async () => {
  // Start from the state left by the previous test (draft applied, maintenance OFF) -> remove it with the rollback script.
  const rbErr = await runScript(rollbackSql());
  assert.equal(rbErr, null);
  assert.equal(await countBlock(), 0);
  assert.equal((await db.query("select to_regprocedure('public.maintenance_blocks_writes()') f")).rows[0].f, null);
  assert.equal(await runScript(rollbackSql()), null, "rollback is idempotent");
  const original = await policySnapshot();

  // fixtures needed by the check script (column names of the real tables)
  await db.exec(`
    alter table public.defect_activity add column if not exists defect_id int;
    alter table public.defect_activity add column if not exists message text;
    alter table public.defect_activity add column if not exists performed_by text;
    grant select, insert, update, delete on storage.objects to anon, authenticated;
    grant select, insert, update, delete on public.defects, public.defect_activity to anon, authenticated;
    grant usage on all sequences in schema public to anon, authenticated;
    grant usage on all sequences in schema storage to anon, authenticated;
    delete from storage.objects where name like 'maintenance-check/%';
  `);
  const counts = async () =>
    JSON.stringify((await db.query("select (select count(*) from public.defects) d, (select count(*) from public.defect_activity) a, (select count(*) from storage.objects) o, (select enabled from public.maintenance_mode) m, (select count(*) from public.maintenance_mode_audit) au")).rows);
  const stateBefore = await counts();

  // baseline check (no enforcement yet): reports NOT_ENFORCED and changes nothing
  let msg = await checkReport();
  assert.match(msg, /verdict=NOT_ENFORCED/);
  assert.equal(await counts(), stateBefore, "check must roll back everything");

  // preflight aborts: maintenance ON, no Super User, invalid Super User, objects already present
  await db.exec("update public.maintenance_mode set enabled = true");
  assert.match((await runScript(applySql())) ?? "", /must be OFF/);
  await db.exec("update public.maintenance_mode set enabled = false");
  assert.equal(await countBlock(), 0);
  const su = (await db.query("select user_id::text u from public.maintenance_super_user")).rows[0].u;
  await db.exec("delete from public.maintenance_super_user");
  assert.match((await runScript(applySql())) ?? "", /exactly one valid admin Super User/);
  await db.exec(`insert into public.maintenance_super_user (id, user_id) values (true, '${U.normal}')`); // exists but is not an admin
  assert.match((await runScript(applySql())) ?? "", /exactly one valid admin Super User/);
  await db.exec("delete from public.maintenance_super_user");
  await db.exec(`insert into public.maintenance_super_user (id, user_id) values (true, '${su}')`);
  assert.equal(await countBlock(), 0, "aborted applies must change nothing");
  assert.equal(await policySnapshot(), original);

  // apply: exactly nine new policies; nothing else changes; OFF behaviour is unchanged
  assert.equal(await runScript(applySql()), null);
  assert.equal(await countBlock(), 9);
  assert.equal(await policySnapshot(), original, "existing policies are untouched");
  assert.match((await runScript(applySql())) ?? "", /already exist/, "second apply is refused");
  assert.equal(await countBlock(), 9);
  assert.equal((await as(U.normal, "insert into public.defects (title) values ('n')")).code, null);

  // check with enforcement: PASS, everything rolled back, report is a matrix
  const stateMid = await counts();
  msg = await checkReport();
  assert.match(msg, /verdict=PASS/, msg);
  assert.match(msg, /super_user_changed=0/);
  assert.match(msg, /ordinary_user_still_allowed_ON=0/);
  assert.match(msg, /anon_still_allowed_ON=0/);
  assert.match(msg, /defects_update/);
  assert.match(msg, /repair_photo_delete/);
  assert.match(msg, /probe_error=none/);
  assert.match(msg, /unprobeable=\[\]/);
  assert.match(msg, /probe_ordinary_user_still_allowed_ON=0/);
  assert.match(msg, /probe:defects_delete/);
  assert.match(msg, /probe:defect_activity_update/);
  assert.match(msg, /probe:defect_photo_update/);
  assert.match(msg, /probe:repair_photo_update/);
  assert.equal((await db.query("select count(*)::int n from pg_policies where policyname like 'maintenance_check_tmp_%'")).rows[0].n, 0, "temporary probe policies must not persist");
  assert.equal(await policySnapshot(), original, "check must not change any policy");
  assert.equal(await counts(), stateMid);

  // check refuses to run while maintenance is ON, and when a user trigger exists
  await db.exec("update public.maintenance_mode set enabled = true");
  assert.match((await runScript(checkSql())) ?? "", /must be OFF/);
  await db.exec("update public.maintenance_mode set enabled = false");
  await db.exec("create function public.t_fn() returns trigger language plpgsql as $$ begin return new; end $$; create trigger t_trg before insert on public.defects for each row execute function public.t_fn();");
  assert.match((await runScript(checkSql())) ?? "", /user trigger exists/);
  // LIVE variant (identity guard stripped; it is tested separately) disables the trigger for the transaction instead of aborting
  const { buildLiveScripts, GUARD } = await import("./build-live-scripts.mjs");
  await db.exec("create or replace function public.t_fn() returns trigger language plpgsql as $$ begin raise exception 'TRIGGER FIRED'; end $$;");
  const liveMsg = await runScript(buildLiveScripts()["live-08-enforcement-check.sql"].replace(GUARD, ""));
  assert.match(liveMsg ?? "", /CHECK COMPLETE - EVERYTHING WAS ROLLED BACK/, liveMsg);
  assert.match(liveMsg, /verdict=PASS/, liveMsg);
  assert.match(liveMsg, /disabled_user_triggers=(public\.)?defects\.t_trg/, liveMsg);
  assert.equal((await db.query("select tgenabled from pg_trigger where tgname = 't_trg'")).rows[0].tgenabled, "O", "trigger re-enabled after rollback");
  await db.exec("drop trigger t_trg on public.defects; drop function public.t_fn();");

  // a deliberately broken enforcement (one policy missing) is not reported as PASS
  await db.exec("drop policy maintenance_block_defects_update on public.defects");
  assert.match(await checkReport(), /verdict=NOT_ENFORCED/);
  await db.exec("create policy maintenance_block_defects_update on public.defects as restrictive for update to anon, authenticated using (not public.maintenance_blocks_writes()) with check (not public.maintenance_blocks_writes())");

  // a probe-only gap (e.g. delete on defect_activity not covered) is caught as FAIL, not hidden as inconclusive
  await db.exec("drop policy maintenance_block_defect_activity_delete on public.defect_activity");
  msg = await checkReport();
  assert.match(msg, /verdict=NOT_ENFORCED/);
  await db.exec("create policy maintenance_block_defect_activity_delete on public.defect_activity as restrictive for delete to anon, authenticated using (true)");
  msg = await checkReport();
  assert.match(msg, /verdict=FAIL/, msg);
  assert.match(msg, /probe_ordinary_user_still_allowed_ON=1/, msg);
  await db.exec("drop policy maintenance_block_defect_activity_delete on public.defect_activity");
  await db.exec("create policy maintenance_block_defect_activity_delete on public.defect_activity as restrictive for delete to anon, authenticated using (not public.maintenance_blocks_writes())");
  assert.match(await checkReport(), /verdict=PASS/);

  // emergency OFF alone restores everything without removing policies
  await db.exec("update public.maintenance_mode set enabled = true");
  assert.ok((await as(U.normal, "insert into public.defects (title) values ('x')")).code);
  await db.exec(stripSqlComments(read("scripts/maintenance-mode/emergency-off.sql")));
  assert.equal((await as(U.normal, "insert into public.defects (title) values ('x')")).code, null);

  // rollback restores the exact prior state
  assert.equal(await runScript(rollbackSql()), null);
  assert.equal(await countBlock(), 0);
  assert.equal(await policySnapshot(), original);
  assert.equal((await as(U.normal, "insert into public.defects (title) values ('y')")).code, null);
});

dbTest("TESTING scripts: storage.objects owned by another role: abort cleanly, or succeed via legitimate SET ROLE", async () => {
  // Real Supabase: storage.objects is owned by supabase_storage_admin. The storage DO blocks are extracted verbatim from
  // the apply and rollback scripts and run in a throwaway database (SET SESSION AUTHORIZATION cannot be undone in
  // PGlite, so it must not touch the shared one). SET ROLE is checked against the SESSION user, hence the simulation.
  const block = (sql) => sql.match(/do \$storage\$[\s\S]*?\$storage\$;/)[0];
  const applyBlock = block(applySql());
  const rollbackBlock = block(rollbackSql());
  assert.ok(applyBlock && rollbackBlock);
  const { PGlite } = await import(pathToFileURL(join(process.env.PGLITE_DIR, "node_modules", "@electric-sql", "pglite", "dist", "index.js")).href);
  const setup = `
    create schema storage; create table storage.objects (id serial primary key, bucket_id text);
    alter table storage.objects enable row level security;
    create function public.maintenance_blocks_writes() returns boolean language sql as $$ select false $$;
    create role supabase_storage_admin nologin; create role editor nologin; create role anon nologin; create role authenticated nologin;
    grant usage on schema public, storage to editor, supabase_storage_admin;
    grant execute on function public.maintenance_blocks_writes() to public;
    alter table storage.objects owner to supabase_storage_admin;`;
  const run = async (d, sql) => {
    try {
      await d.exec(`begin; ${sql} commit;`);
      return null;
    } catch (e) {
      await d.exec("rollback").catch(() => {});
      return String(e.message);
    }
  };
  const count = async (d) => (await d.query("select count(*)::int n from pg_policies where policyname like 'maintenance\\_block\\_%'")).rows[0].n;
  const mk = async (member) => {
    const d = new PGlite();
    await d.exec(setup);
    if (member) await d.exec("grant supabase_storage_admin to editor");
    await d.exec("set session authorization editor");
    return d;
  };

  // not the owner and not a member: aborts with a clear message and nothing is left behind
  let d = await mk(false);
  assert.match((await run(d, applyBlock)) ?? "", /could not create the storage\.objects policies/);
  assert.equal(await count(d), 0);

  // legitimate membership: all three are created, and the role switch is undone afterwards
  d = await mk(true);
  assert.equal(await run(d, applyBlock), null);
  assert.equal(await count(d), 3);
  assert.equal((await d.query("select current_user u")).rows[0].u, "editor");
  assert.equal((await d.query("select count(*)::int n from pg_policies where policyname like 'maintenance\\_block\\_%' and permissive = 'RESTRICTIVE'")).rows[0].n, 3);
  // rollback block removes exactly those, and is idempotent
  assert.equal(await run(d, rollbackBlock), null);
  assert.equal(await count(d), 0);
  assert.equal(await run(d, rollbackBlock), null);

  // rollback without membership while a policy exists: aborts, changes nothing
  const noMember = new PGlite();
  await noMember.exec(setup);
  await noMember.exec("create policy maintenance_block_photo_objects_insert on storage.objects as restrictive for insert to public with check (true)");
  await noMember.exec("set session authorization editor");
  assert.match((await run(noMember, rollbackBlock)) ?? "", /Rollback aborted, nothing changed/);
  assert.equal(await count(noMember), 1, "failed rollback must not drop anything");
});

test("clients: defect update checks rows affected so a blocked write is never reported as saved", () => {
  const f = read("../maintenance-app/screens/DefectDetailsScreen.js");
  assert.match(f, /\.update\(updates\)\s*\.eq\("id", currentDefect\.id\)\s*\.select\("id"\)/);
  assert.match(f, /savedRows\.length === 0/);
});

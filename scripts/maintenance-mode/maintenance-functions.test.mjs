// Offline tests for the Maintenance Mode guard on the secret-key Edge Functions.
// Run: node --test scripts/maintenance-mode/maintenance-functions.test.mjs   (Node 22.18+ strips TS types)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const stripSql = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");
const { checkMaintenance, enforceMaintenance } = await import(
  pathToFileURL(join(root, "supabase/functions/_shared/maintenance_guard.ts")).href
);

const SUPER = "00000000-0000-4000-8000-000000000001";
const ADMIN = "00000000-0000-4000-8000-000000000002";
const MANAGER = "00000000-0000-4000-8000-000000000003";

// Fake supabase-js client: from(table).select().eq().maybeSingle() resolves to tables[table].
function fakeDb(tables, { throwOn } = {}) {
  return {
    from(table) {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (throwOn === table) throw new Error("boom");
          return tables[table];
        },
      };
      return chain;
    },
  };
}
const on = { data: { enabled: true }, error: null };
const off = { data: { enabled: false }, error: null };
const superRow = { data: { user_id: SUPER }, error: null };

test("guard: maintenance OFF allows everyone without reading the Super User", async () => {
  for (const who of [SUPER, ADMIN, MANAGER]) {
    assert.equal(await checkMaintenance(fakeDb({ maintenance_mode: off }), who), "allowed");
  }
});

test("guard: maintenance ON blocks normal admin and manager, allows only the Super User", async () => {
  const db = fakeDb({ maintenance_mode: on, maintenance_super_user: superRow });
  assert.equal(await checkMaintenance(db, SUPER), "allowed");
  assert.equal(await checkMaintenance(db, ADMIN), "blocked");
  assert.equal(await checkMaintenance(db, MANAGER), "blocked");
});

test("guard: maintenance ON with no Super User row blocks everyone (fail closed)", async () => {
  const db = fakeDb({ maintenance_mode: on, maintenance_super_user: { data: null, error: null } });
  for (const who of [SUPER, ADMIN]) assert.equal(await checkMaintenance(db, who), "blocked");
});

test("guard: database errors, missing state and exceptions fail closed as unavailable", async () => {
  const err = { data: null, error: { message: "permission denied" } };
  assert.equal(await checkMaintenance(fakeDb({ maintenance_mode: err }), SUPER), "unavailable");
  assert.equal(await checkMaintenance(fakeDb({ maintenance_mode: { data: null, error: null } }), SUPER), "unavailable");
  assert.equal(await checkMaintenance(fakeDb({ maintenance_mode: { data: { enabled: "true" }, error: null } }), SUPER), "unavailable");
  assert.equal(await checkMaintenance(fakeDb({ maintenance_mode: on, maintenance_super_user: err }), SUPER), "unavailable");
  assert.equal(await checkMaintenance(fakeDb({ maintenance_mode: on }, { throwOn: "maintenance_mode" }), SUPER), "unavailable");
  assert.equal(await checkMaintenance(fakeDb({ maintenance_mode: on }, { throwOn: "maintenance_super_user" }), SUPER), "unavailable");
});

test("guard: a Super User id compared strictly (no loose matching)", async () => {
  const db = fakeDb({ maintenance_mode: on, maintenance_super_user: superRow });
  assert.equal(await checkMaintenance(db, SUPER + " "), "blocked");
  assert.equal(await checkMaintenance(db, ""), "blocked");
  assert.equal(await checkMaintenance(db, undefined), "blocked");
});

test("enforce: returns null when allowed, otherwise a 503 with no internal details", async () => {
  const cors = { "Access-Control-Allow-Origin": "*" };
  assert.equal(await enforceMaintenance(fakeDb({ maintenance_mode: off }), ADMIN, cors), null);
  assert.equal(
    await enforceMaintenance(fakeDb({ maintenance_mode: on, maintenance_super_user: superRow }), SUPER, cors),
    null,
  );

  const blocked = await enforceMaintenance(fakeDb({ maintenance_mode: on, maintenance_super_user: superRow }), ADMIN, cors);
  assert.equal(blocked.status, 503);
  assert.equal(blocked.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(blocked.headers.get("Retry-After"), "60");
  assert.deepEqual(await blocked.json(), { success: false, error: "Maintenance in progress", maintenance: true });

  const failed = await enforceMaintenance(
    fakeDb({ maintenance_mode: { data: null, error: { message: "relation secret_detail" } } }),
    SUPER,
    cors,
  );
  assert.equal(failed.status, 503);
  const text = JSON.stringify(await failed.json());
  assert.ok(!text.includes("secret_detail") && !text.includes("maintenance"), text);
});

const SECURED = [
  "create-user", "delete-user", "get-admin-users", "list-users",
  "resend-invite", "send-report-email", "upload-drive", "invite-contracts-portal",
];

test("functions: all eight import the guard, and it runs after authentication and the role check", () => {
  for (const name of SECURED) {
    const src = read(`supabase/functions/${name}/index.ts`);
    assert.match(src, /import \{ enforceMaintenance \} from '\.\.\/_shared\/maintenance_guard\.ts'/, name);
    const calls = [...src.matchAll(/enforceMaintenance\(/g)].map((m) => m.index);
    assert.equal(calls.length, 1, `${name}: exactly one guard call`);
    const at = calls[0];
    assert.ok(src.lastIndexOf("getAuthenticatedUser(", at) !== -1, `${name}: guard follows authentication`);
    const roleCheck = Math.max(
      src.lastIndexOf("!== 'admin'", at),
      src.lastIndexOf('!== "admin"', at),
      src.lastIndexOf('["admin", "manager"]', at),
      src.lastIndexOf('("admin"), ("manager")', at),
    );
    assert.ok(roleCheck !== -1, `${name}: guard follows the role check`);
  }
});

test("functions: guard precedes every sensitive operation", () => {
  const sensitive = [
    "auth.admin.", ".storage", "createClient(CONTRACTS", "fetch(", "sendMail", "smtp", "SmtpClient",
    ".insert(", ".update(", ".delete(", ".upsert(",
  ];
  for (const name of SECURED) {
    const src = read(`supabase/functions/${name}/index.ts`);
    // Evaluate only the request handler, not helper definitions declared before serve().
    const handler = src.slice(src.indexOf("serve(async"));
    const guardAt = handler.indexOf("enforceMaintenance(") !== -1
      ? handler.indexOf("enforceMaintenance(")
      : handler.indexOf("authorizeAdmin(");
    assert.ok(guardAt !== -1, `${name}: guard (or authorizeAdmin, which embeds it) is in the handler`);
    for (const token of sensitive) {
      const idx = handler.indexOf(token);
      if (idx !== -1) assert.ok(idx > guardAt, `${name}: "${token}" must come after the guard`);
    }
  }
});

test("functions: authorizeAdmin helpers embed the guard before returning success", () => {
  for (const name of ["create-user", "delete-user", "get-admin-users", "resend-invite", "send-report-email", "upload-drive"]) {
    const src = read(`supabase/functions/${name}/index.ts`);
    const fn = src.slice(src.indexOf("async function authorizeAdmin"), src.indexOf("serve("));
    assert.match(fn, /await enforceMaintenance\(supabase, user\.id as string, corsHeaders\)/, name);
    assert.ok(fn.indexOf("enforceMaintenance(") < fn.indexOf("denied: null"), name);
  }
});

test("functions: system functions and gateway JWT settings are unchanged", () => {
  for (const name of ["notify-defect", "notify-expiring-invites"]) {
    const src = read(`supabase/functions/${name}/index.ts`);
    assert.ok(!src.includes("maintenance_guard"), `${name} must keep working during maintenance`);
  }
  const config = read("supabase/config.toml");
  assert.match(config, /\[functions\.notify-defect\]\s*verify_jwt = false/);
  assert.match(config, /\[functions\.notify-expiring-invites\]\s*verify_jwt = false/);
  // The admin functions run with verify_jwt=false and authenticate in-handler; see user-auth.test.mjs.
  for (const name of SECURED) assert.match(config, new RegExp(`\\[functions\\.${name}\\]\\s*verify_jwt = false`), name);
});

test("guard: contains no credentials and logs only a short error code", () => {
  const src = read("supabase/functions/_shared/maintenance_guard.ts");
  const logs = src.match(/console\.\w+\(/g) || [];
  assert.equal(logs.length, 1, "exactly one logging call");
  assert.ok(/console\.error\('Maintenance state unavailable:', stage, typeof code === 'string'/.test(src));
  assert.ok(!/\.message|\.details|\.hint/.test(src), "never log error messages or details");
  assert.ok(!/password|password_hash|eyJ|sb_secret/i.test(src));
  assert.ok(!src.includes("maintenance_credentials"), "guard must never read the credentials table");
});

test("guard: unreadable state logs only the error code and still fails closed", async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const denied = { data: null, error: { code: "42501", message: "permission denied for table maintenance_mode SECRET-DETAIL" } };
    assert.equal(await checkMaintenance(fakeDb({ maintenance_mode: denied }), SUPER), "unavailable");
    const missing = { data: null, error: { code: "PGRST205", message: "Could not find the table SECRET-DETAIL" } };
    assert.equal(await checkMaintenance(fakeDb({ maintenance_mode: missing }), SUPER), "unavailable");
  } finally {
    console.error = original;
  }
  assert.equal(logged.length, 2);
  assert.ok(logged[0].includes("42501") && logged[1].includes("PGRST205"));
  assert.ok(logged.every((l) => !l.includes("SECRET-DETAIL") && !l.includes("maintenance_mode ")), logged.join("|"));
});

test("service_role grant fix: exactly SELECT on the two tables the guard reads, nothing else", () => {
  const sql = stripSql(read("supabase/migrations/20261030_maintenance_mode_service_role_grants.sql"));
  const grants = sql.match(/grant [^;]+;/gi) || [];
  assert.deepEqual(grants.map((g) => g.replace(/\s+/g, " ").toLowerCase()), [
    "grant select on table public.maintenance_mode to service_role;",
    "grant select on table public.maintenance_super_user to service_role;",
  ]);
  assert.ok(!/maintenance_credentials|maintenance_mode_audit|anon|authenticated|policy|alter |drop /i.test(sql));
  assert.match(sql, /^\s*begin;[\s\S]*commit;\s*$/i);
  const diag = stripSql(read("scripts/maintenance-mode/diagnose-guard-access.sql"));
  assert.ok(!/\b(insert|update|delete|alter|drop|create|grant|revoke|truncate)\b/i.test(diag), "diagnostic is read-only");
});

test("invite-contracts-portal: nothing is validated or revealed before authentication, role check and guard", () => {
  const src = read("supabase/functions/invite-contracts-portal/index.ts");
  const handler = src.slice(src.indexOf("serve(async"));
  const order = [
    "getAuthenticatedUser(req, maintenanceAdmin)",
    '"Unauthorized"',
    "Forbidden: admin or manager required",
    "enforceMaintenance(",
    "Missing contracts env vars",
    "req.json()",
    '"Email is required."',
    "createClient(CONTRACTS_SUPABASE_URL",
    "listAllAuthUsersByEmailMap(",
  ].map((needle) => [needle, handler.indexOf(needle)]);
  for (const [needle, at] of order) assert.ok(at !== -1, `missing: ${needle}`);
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i][1] > order[i - 1][1], `${order[i][0]} must come after ${order[i - 1][0]}`);
  }
  // Every 200 response in the handler must be after the guard.
  const guardAt = handler.indexOf("enforceMaintenance(");
  for (const m of handler.matchAll(/status: 200/g)) assert.ok(m.index > guardAt, "no 200 before authentication");
});

test("smoke script: admin2 needs explicit ADMIN confirmation and notes never include response bodies", () => {
  const ps = read("scripts/maintenance-mode/test-testing-function-maintenance.ps1");
  assert.match(ps, /-ceq 'ADMIN'/);
  assert.match(ps, /Keep ONLY the generic error string/);
  assert.ok(!/Write-Host|Write-Output.*Content/.test(ps));
});

test("mobile: both defect update paths detect RLS-filtered (zero-row) updates", () => {
  for (const [file, needle] of [
    ["../maintenance-app/screens/DefectDetailsScreen.js", ".update(updates)"],
    ["../maintenance-app/screens/NewDefectScreen.js", ".update({ photo_urls: uploadedUrls })"],
  ]) {
    const src = read(file);
    const at = src.indexOf(needle);
    assert.ok(at !== -1, file);
    const stmt = src.slice(at, at + 200);
    assert.match(stmt, /\.select\("id"\)/, `${file}: update must return affected rows`);
    assert.match(src.slice(at, at + 900), /length === 0/, `${file}: zero rows must not be treated as success`);
  }
});
test("portal: every defects update checks affected rows, and photo deletes never remove files on a zero-row update", () => {
  const src = read("src/App.jsx");
  const updates = [...src.matchAll(/\.from\("defects"\)\s*\.update\(/g)];
  assert.equal(updates.length, 5, "expected the five Portal defect update paths");
  for (const m of updates) {
    const stmt = src.slice(m.index, m.index + 700);
    assert.match(stmt, /\.select\("id"\)/, `update at ${m.index} must return affected rows`);
    assert.match(src.slice(m.index, m.index + 1100), /length === 0/, `update at ${m.index} must reject zero rows`);
  }
  for (const [col, bucket] of [["photo_urls: updatedPhotos", "defect-photos"], ["repair_photos: updatedPhotos", "repair-photos"]]) {
    const at = src.indexOf(`.update({ ${col} })`);
    const removeAt = src.indexOf(`storage.from("${bucket}").remove(`, at);
    const guardAt = src.indexOf("length === 0", at);
    assert.ok(at !== -1 && removeAt !== -1 && guardAt !== -1 && guardAt < removeAt, `${bucket}: guard must precede remove`);
  }
});
test("smoke script: TESTING only, publishable key only, never sends an allowed request to Contracts functions", () => {
  const ps = read("scripts/maintenance-mode/test-testing-function-maintenance.ps1");
  assert.ok(ps.includes("etffoumsopxjptnmhvwh") && !ps.includes("zebksrihswwwlejdiboq"));
  assert.match(ps, /sb_publishable_\*/);
  assert.ok(!/service_role|sb_secret|eyJ/i.test(ps));
  assert.ok(!/Write-Host.*(token|password)/i.test(ps));
  // Contracts functions: the allowed-through branches (OFF, and Super User when ON) must be skipped.
  assert.match(ps, /if \(-not \$isContracts\) \{ Add-Result \$fn \$who 'PASS'/);
  assert.match(ps, /OFF: a manager would be allowed through to Contracts/);
});
// Reproduces the TESTING 503: a project that does not auto-grant new tables to service_role.
let grantDb = null;
let grantSkip = "PGLITE_DIR not set";
if (process.env.PGLITE_DIR) {
  try {
    const base = join(process.env.PGLITE_DIR, "node_modules", "@electric-sql", "pglite", "dist");
    const { PGlite } = await import(pathToFileURL(join(base, "index.js")).href);
    grantDb = new PGlite();
    await grantDb.waitReady;
    grantSkip = false;
  } catch (e) {
    grantSkip = `PGlite unavailable: ${String(e.message).slice(0, 80)}`;
  }
}

test("db: without an explicit grant service_role is denied (42501); the fix grants only the two guard tables", { skip: grantSkip }, async () => {
  await grantDb.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema if not exists public; grant usage on schema public to anon, authenticated, service_role;
    create table public.maintenance_mode (id boolean primary key default true, enabled boolean not null default false);
    insert into public.maintenance_mode values (true, false);
    create table public.maintenance_super_user (id boolean primary key default true, user_id uuid not null);
    create table public.maintenance_credentials (id boolean primary key default true, password_hash text not null);
    create table public.maintenance_mode_audit (id int primary key);
    alter table public.maintenance_mode enable row level security;
    alter table public.maintenance_super_user enable row level security;
    alter table public.maintenance_credentials enable row level security;
    alter table public.maintenance_mode_audit enable row level security;
    revoke all on table public.maintenance_mode, public.maintenance_super_user,
      public.maintenance_credentials, public.maintenance_mode_audit from public, anon, authenticated;
  `);
  const as = async (role, sql) => {
    await grantDb.exec(`set role ${role}`);
    try { return { rows: (await grantDb.query(sql)).rows }; }
    catch (e) { return { code: e.code }; }
    finally { await grantDb.exec("reset role"); }
  };

  // Before the fix: exactly the production symptom (RLS is bypassed, but there is no table privilege).
  assert.equal((await as("service_role", "select enabled from public.maintenance_mode")).code, "42501");

  const fix = stripSql(read("supabase/migrations/20261030_maintenance_mode_service_role_grants.sql"));
  await grantDb.exec(fix);

  const ok = await as("service_role", "select enabled from public.maintenance_mode where id = true");
  assert.deepEqual(ok.rows, [{ enabled: false }]);
  assert.deepEqual((await as("service_role", "select user_id from public.maintenance_super_user")).rows, []);
  assert.equal((await as("service_role", "select * from public.maintenance_credentials")).code, "42501");
  assert.equal((await as("service_role", "select * from public.maintenance_mode_audit")).code, "42501");
  assert.equal((await as("service_role", "update public.maintenance_mode set enabled = true")).code, "42501");
  for (const role of ["anon", "authenticated"]) {
    assert.equal((await as(role, "select * from public.maintenance_mode")).code, "42501", role);
  }
});
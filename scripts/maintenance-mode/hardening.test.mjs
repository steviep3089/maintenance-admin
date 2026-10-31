// Offline tests for the legacy-key / grant hardening drafts in supabase/sql/hardening.
// Static tests always run; database tests need PGLITE_DIR (same convention as maintenance-mode.test.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GUARD } from "./build-live-scripts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (f) => readFileSync(join(root, "supabase/sql/hardening", f), "utf8").replace(/\r\n/g, "\n");
const strip = (s) => s.replace(/--.*$/gm, "");
const noGuard = (s) => s.replace(GUARD, "");
const FAKE_JWT_PAYLOAD = Buffer.from(JSON.stringify({ role: "service_role", ref: "fakeproject" })).toString("base64url");
const FAKE_JWT = `eyJhbGciOiJIUzI1NiJ9.${FAKE_JWT_PAYLOAD}.c2lnbmF0dXJl`;

test("hardening drafts: guard text matches the LIVE identity guard; rollbacks are unguarded", () => {
  for (const f of ["h3-revoke-dangerous-privileges.sql", "h4-revoke-unused-writes.sql"]) assert.ok(read(f).includes(GUARD.trim()), f);
  for (const f of ["h3-revoke-dangerous-privileges-rollback.sql", "h4-revoke-unused-writes-rollback.sql"]) assert.ok(!read(f).includes("live_guard"), f);
});

test("hardening drafts: static safety (no select/key/ownership changes, no secrets, inventories read-only)", () => {
  for (const f of ["h1-legacy-key-inventory.sql", "h2-grants-inventory.sql"]) {
    assert.doesNotMatch(strip(read(f)), /^\s*(insert|update|delete|alter|drop|grant|revoke|create|truncate)\b/im, f);
  }
  const all = ["h3-revoke-dangerous-privileges.sql", "h3-revoke-dangerous-privileges-rollback.sql", "h4-revoke-unused-writes.sql", "h4-revoke-unused-writes-rollback.sql"].map(read).join("\n");
  assert.doesNotMatch(strip(all), /\b(revoke|grant)\b[^;]*\b(select|usage|execute)\b/i, "never touches SELECT/USAGE/EXECUTE");
  assert.doesNotMatch(strip(all), /service_role|supabase_storage_admin|storage\.|auth\.|cascade|owner/i);
  assert.doesNotMatch(noGuard(all).replace(/etffoumsopxjptnmhvwh/g, ""), /eyJ[A-Za-z0-9_-]{10,}\./);
});

const dir = process.env.PGLITE_DIR;
const dbTest = (name, fn) => test(`db: ${name}`, { skip: dir ? false : "PGLITE_DIR not set" }, fn);
let PGlite;
const mk = async () => {
  PGlite ??= (await import(pathToFileURL(join(dir, "node_modules", "@electric-sql", "pglite", "dist", "index.js")).href)).PGlite;
  const d = new PGlite();
  await d.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create table public.defects(id serial primary key, title text, created_by uuid);
    create table public.defect_activity(id serial primary key, note text);
    create table public.user_roles(user_id uuid, role text);
    create table public.invite_digest_runs(id serial primary key);
    create table public.plant_assets(id serial primary key);
    create table public.locked_internal(id int);
    alter table public.defects enable row level security;
    create policy ins on public.defects for insert to authenticated with check (true);
    create policy upd on public.defects for update to authenticated using (true);
    create policy sel on public.defects for select to anon, authenticated using (true);
    grant usage on schema public to anon, authenticated, service_role;
    grant all on public.defects, public.defect_activity, public.user_roles, public.invite_digest_runs, public.plant_assets to anon, authenticated;
    grant usage on all sequences in schema public to anon, authenticated;
    grant select on public.locked_internal to service_role;
    create function public.notify_defect_created() returns int language sql as $$ select 1 /* zebksrihswwwlejdiboq */ $$;`);
  return d;
};
const privs = async (d) =>
  JSON.stringify((await d.query(`select c.relname, r.rolname, p.x from pg_class c join pg_namespace n on n.oid=c.relnamespace
    cross join (values ('anon'),('authenticated')) r(rolname)
    cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p(x)
    where n.nspname='public' and c.relkind='r' and has_table_privilege(r.rolname, c.oid, p.x) order by 1,2,3`)).rows);

dbTest("h3: removes only TRUNCATE/REFERENCES/TRIGGER/MAINTAIN, keeps CRUD, rolls back exactly, guard blocks TESTING", async () => {
  const d = await mk();
  const before = await privs(d);
  assert.match(before, /TRUNCATE/);
  await d.exec(read("h3-revoke-dangerous-privileges.sql"));
  const after = JSON.parse(await privs(d));
  assert.ok(!after.some((r) => ["TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"].includes(r.x)));
  assert.equal(after.filter((r) => r.x === "SELECT").length, JSON.parse(before).filter((r) => r.x === "SELECT").length);
  assert.equal(after.filter((r) => r.x === "INSERT").length, JSON.parse(before).filter((r) => r.x === "INSERT").length);
  assert.equal((await d.query("select has_table_privilege('service_role','public.locked_internal','SELECT') ok")).rows[0].ok, true);
  await d.exec(read("h3-revoke-dangerous-privileges-rollback.sql"));
  assert.equal(await privs(d), before, "rollback restores the exact privilege set");
  // wrong project: aborts, nothing changes
  const t = await mk();
  await t.exec("create or replace function public.notify_defect_created() returns int language sql as $$ select 1 /* etffoumsopxjptnmhvwh */ $$");
  const b = await privs(t);
  await assert.rejects(t.exec(read("h3-revoke-dangerous-privileges.sql")), /does not look like the LIVE project/);
  await t.exec("rollback").catch(() => {});
  assert.equal(await privs(t), b);
});

dbTest("h4: app writes still work through RLS; unused writes are gone; rollback restores", async () => {
  const d = await mk();
  const before = await privs(d);
  await d.exec(read("h3-revoke-dangerous-privileges.sql"));
  await d.exec(read("h4-revoke-unused-writes.sql"));
  const has = async (role, tbl, p) => (await d.query(`select has_table_privilege('${role}','public.${tbl}','${p}') ok`)).rows[0].ok;
  for (const p of ["INSERT", "UPDATE", "DELETE"]) {
    assert.equal(await has("anon", "defects", p), false);
    assert.equal(await has("authenticated", "user_roles", p), false);
    assert.equal(await has("authenticated", "invite_digest_runs", p), false);
  }
  assert.equal(await has("authenticated", "defects", "INSERT"), true);
  assert.equal(await has("authenticated", "defects", "UPDATE"), true);
  assert.equal(await has("authenticated", "defect_activity", "INSERT"), true);
  assert.equal(await has("authenticated", "plant_assets", "DELETE"), true, "authenticated Portal writes kept");
  assert.equal(await has("anon", "user_roles", "SELECT"), true);
  // a real authenticated write through RLS still succeeds
  await d.exec("set role authenticated");
  await d.exec("insert into public.defects(title) values ('x')");
  await d.exec("update public.defects set title = 'y'");
  await d.exec("reset role");
  await d.exec("set role anon");
  await assert.rejects(d.exec("insert into public.defects(title) values ('z')"), /permission denied/);
  await d.exec("reset role");
  await d.exec(read("h4-revoke-unused-writes-rollback.sql"));
  await d.exec(read("h3-revoke-dangerous-privileges-rollback.sql"));
  assert.equal(await privs(d), before);
});

dbTest("h4: aborts (and changes nothing) if a required app write is not granted", async () => {
  const d = await mk();
  await d.exec("revoke insert on public.defect_activity from authenticated");
  const b = await privs(d);
  await assert.rejects(d.exec(read("h4-revoke-unused-writes.sql")), /required authenticated write privilege/);
  await d.exec("rollback").catch(() => {});
  assert.equal(await privs(d), b);
});

dbTest("h2 inventory: flags dangerous privileges and RLS-off writes; changes nothing", async () => {
  const d = await mk();
  const b = await privs(d);
  const rows = (await d.query(read("h2-grants-inventory.sql"))).rows;
  assert.ok(rows.some((r) => r.table_name === "defect_activity" && r.status === "BLOCK"), "RLS-off writable table is BLOCK");
  assert.ok(rows.some((r) => r.table_name === "defects" && r.status === "REVIEW"));
  assert.equal(await privs(d), b);
  await d.exec(read("h3-revoke-dangerous-privileges.sql"));
  const after = (await d.query(read("h2-grants-inventory.sql"))).rows;
  assert.ok(!after.some((r) => r.status === "REVIEW" && /TRUNCATE|TRIGGER|REFERENCES|MAINTAIN/.test(r.privileges)));
});

dbTest("h1 inventory: finds a JWT in vault/function/cron/queue, never outputs the value or its signature", async () => {
  const d = await mk();
  await d.exec(`create schema vault; create view vault.decrypted_secrets as select 'old_service_key'::text as name, now() as created_at, '${FAKE_JWT}'::text as decrypted_secret
                union all select 'hmac_signing_key', now(), 'not-a-jwt-value'
                union all select 'bearer_wrapped', now(), 'Bearer "${FAKE_JWT}"'
                union all select 'new_key', now(), 'sb_secret_abcdefghijklmnop';
    create function public.old_hook() returns void language plpgsql as $$ begin perform 'Bearer ${FAKE_JWT}'; end $$;
    create schema cron; create table cron.job(jobid int, command text); insert into cron.job values (1, 'select net.http_post(headers := ''{"Authorization":"Bearer ${FAKE_JWT}"}'')');
    create schema net; create table net.http_request_queue(id int, headers jsonb); insert into net.http_request_queue values (1, '{"Authorization":"Bearer ${FAKE_JWT}"}');
    create table public.hooked(id int); create function public.noop() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger hook_a after insert on public.hooked for each row execute function public.noop('Authorization', 'Bearer ${FAKE_JWT}');
    create trigger hook_b after update on public.hooked for each row execute function public.noop('plain');`);
  const rows = (await d.query(read("h1-legacy-key-inventory.sql"))).rows;
  const text = JSON.stringify(rows);
  assert.ok(!text.includes("eyJ") && !text.includes(FAKE_JWT_PAYLOAD) && !text.includes("c2lnbmF0dXJl"), "no token material in output");
  const get = (s, o) => rows.find((r) => r.section === s && (!o || r.object === o));
  assert.equal(get("vault_secret", "old_service_key").status, "BLOCK");
  assert.match(get("vault_secret", "old_service_key").detail, /role=service_role/);
  assert.equal(get("vault_secret", "hmac_signing_key").status, "OK");
  assert.equal(get("vault_secret", "bearer_wrapped").status, "BLOCK", "a Bearer-prefixed/quoted JWT is still detected");
  assert.match(get("vault_secret", "bearer_wrapped").detail, /role=service_role.*kind=bearer-prefixed/);
  assert.match(get("vault_secret", "new_key").detail, /kind=sb_secret_/);
  assert.equal(get("vault_secret", "new_key").status, "OK");
  assert.equal(get("db_function", "public.old_hook").status, "BLOCK");
  assert.equal(get("cron_jobs").status, "BLOCK");
  assert.equal(get("pg_net_queue").status, "BLOCK");
  assert.equal(get("trigger_args", "hooked.hook_a").status, "BLOCK");
  assert.ok(!rows.some((r) => r.object === "hooked.hook_b"), "NUL-separated trigger args are read without an encoding error");
  // clean database: no BLOCK anywhere and the query still runs without vault/cron/net contents
  const c = await mk();
  await c.exec(`create schema vault; create view vault.decrypted_secrets as select 'k'::text name, now() created_at, 'plain'::text decrypted_secret;`);
  assert.ok(!(await c.query(read("h1-legacy-key-inventory.sql"))).rows.some((r) => r.status === "BLOCK"));
});

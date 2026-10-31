// Tests for the generated LIVE SQL bundle. Static tests always run; the identity-guard test needs PGLITE_DIR.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildLiveScripts, GUARD, LIVE_REF, TESTING_REF, OUT_DIR } from "./build-live-scripts.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const norm = (s) => s.replace(/\r\n/g, "\n");
const built = buildLiveScripts();
const strip = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--.*$/gm, "");

// Generated output is gitignored (live-06 holds a real email); skip when it has not been generated locally.
test("LIVE bundle on disk matches the generator (no drift from verified sources)", { skip: !existsSync(join(root, OUT_DIR)) && "run build-live-scripts.mjs first" }, () => {
  for (const [name, text] of Object.entries(built)) {
    const p = join(root, OUT_DIR, name);
    assert.ok(existsSync(p), `${name} exists`);
    // live-06 legitimately holds the real Super User email in place of the placeholder; any other difference is drift
    const fixEmail = (s) => (name === "live-06-designate-super-user.sql" ? s.replace(/(v_email constant text := )'[^']*'/, "$1'<email>'") : s);
    assert.equal(fixEmail(norm(readFileSync(p, "utf8"))), fixEmail(text), `${name} is up to date; run build-live-scripts.mjs`);
  }
});

test("LIVE scripts never reference the TESTING project, except inside the guard", () => {
  for (const [name, text] of Object.entries(built)) {
    assert.ok(!text.replace(GUARD, "").includes(TESTING_REF), `${name} has no TESTING ref outside the guard`);
  }
});

test("identity guard is on every script except rollback and emergency OFF", () => {
  for (const [name, text] of Object.entries(built)) {
    const unguarded = name === "live-09-enforcement-rollback.sql" || name === "live-10-emergency-off.sql";
    assert.equal(text.includes("$live_guard$"), !unguarded, name);
  }
  for (const name of ["live-03-migration-setting.sql", "live-04-migration-service-role-grants.sql", "live-07-enforcement-apply.sql"]) {
    const s = strip(built[name]);
    assert.ok(s.indexOf("begin;") < s.indexOf("$live_guard$"), `${name}: guard runs inside the transaction before any change`);
  }
});

test("LIVE enforcement scripts keep the verified bodies; designate script keeps its placeholder", () => {
  assert.match(built["live-06-designate-super-user.sql"], /REPLACE_WITH_SUPER_USER_EMAIL/);
  assert.equal((strip(built["live-07-enforcement-apply.sql"]).match(/create policy/g) || []).length, 9);
  assert.equal((strip(built["live-09-enforcement-rollback.sql"]).match(/^drop policy if exists/gm) || []).length, 6);
  assert.doesNotMatch(strip(built["live-08-enforcement-check.sql"]), /\b(commit|savepoint)\b/i);
  assert.match(built["live-08-enforcement-check.sql"], /disable trigger/);
  assert.match(built["live-07-enforcement-apply.sql"], /live-09-enforcement-rollback\.sql/);
  assert.doesNotMatch(strip(built["live-07-enforcement-apply.sql"] + built["live-09-enforcement-rollback.sql"]), /TESTING_(apply|rollback)\.sql/);
});

const dir = process.env.PGLITE_DIR;
test("identity guard: aborts on TESTING-like and empty databases, passes on LIVE-like", { skip: dir ? false : "PGLITE_DIR not set" }, async () => {
  const { PGlite } = await import(pathToFileURL(join(dir, "node_modules", "@electric-sql", "pglite", "dist", "index.js")).href);
  const mk = async (url) => {
    const d = new PGlite();
    if (url) await d.exec(`create function public.notify_defect_created() returns trigger language plpgsql as $$ begin perform '${url}'; return new; end $$;`);
    return d;
  };
  for (const [label, url, ok] of [
    ["empty", null, false],
    ["testing", `https://${TESTING_REF}.supabase.co/functions/v1/notify-defect`, false],
    ["both refs", `https://${LIVE_REF}.supabase.co https://${TESTING_REF}.supabase.co`, false],
    ["live", `https://${LIVE_REF}.supabase.co/functions/v1/notify-defect`, true],
  ]) {
    const d = await mk(url);
    let err = null;
    try { await d.exec(GUARD); } catch (e) { err = String(e.message); }
    if (ok) assert.equal(err, null, label);
    else assert.match(err ?? "", /does not look like the LIVE project/, label);
  }
  // a guarded migration makes no change on a TESTING-like database
  const d = await mk(`https://${TESTING_REF}.supabase.co/x`);
  await assert.rejects(d.exec(built["live-04-migration-service-role-grants.sql"]));
  await d.exec("rollback").catch(() => {});
  assert.equal((await d.query("select to_regclass('public.maintenance_mode') t")).rows[0].t, null);
});

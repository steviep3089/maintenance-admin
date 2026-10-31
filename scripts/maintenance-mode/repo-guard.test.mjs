// Guards that keep maintenance-admin the single, safe source of truth for deployments.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIVE = "zebksrihswwwlejdiboq";
const TESTING = "etffoumsopxjptnmhvwh";
const TEN = ["create-user", "delete-user", "get-admin-users", "list-users", "resend-invite", "send-report-email", "upload-drive", "invite-contracts-portal", "notify-defect", "notify-expiring-invites"];

const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const read = (p) => readFileSync(p, "utf8");

test("supabase/functions holds exactly the ten production functions (+ _shared, deno.json)", () => {
  const entries = readdirSync(join(root, "supabase", "functions")).filter((n) => statSync(join(root, "supabase", "functions", n)).isDirectory());
  assert.deepEqual(entries.sort(), [...TEN, "_shared"].sort());
  for (const f of TEN) assert.ok(existsSync(join(root, "supabase", "functions", f, "index.ts")), f);
});

test("config.toml sets verify_jwt=false for exactly the ten functions", () => {
  const t = read(join(root, "supabase", "config.toml"));
  const found = [...t.matchAll(/^\[functions\.([\w-]+)\]\s*\r?\nverify_jwt\s*=\s*(\w+)/gm)];
  assert.deepEqual(found.map((m) => m[1]).sort(), [...TEN].sort());
  for (const m of found) assert.equal(m[2], "false", m[1]);
  assert.doesNotMatch(t, /project_id/);
});

test("production function source has no project refs, legacy key env or secrets", () => {
  for (const p of walk(join(root, "supabase", "functions"))) {
    const s = read(p);
    assert.ok(!s.includes(LIVE) && !s.includes(TESTING), `${p} contains a project ref`);
    assert.doesNotMatch(s, /SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY/, p);
    assert.doesNotMatch(s, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, p);
    assert.doesNotMatch(s, /\bprodcheck-/, p);
  }
});

test("TESTING functions live only under supabase-testing and use only prodcheck names", () => {
  const dirs = readdirSync(join(root, "supabase-testing", "supabase", "functions")).filter((n) => n !== "_shared");
  assert.deepEqual(dirs.sort(), ["prodcheck-notify-defect", "prodcheck-notify-expiring-invites"]);
});

test("no Supabase link files, env files or generated LIVE SQL are tracked", () => {
  let tracked = "";
  try { tracked = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" }); } catch { return; }
  const files = tracked.split(/\r?\n/).filter(Boolean);
  assert.deepEqual(files.filter((f) => /(^|\/)\.temp\//.test(f)), []);
  assert.deepEqual(files.filter((f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith(".env.example")), []);
  assert.deepEqual(files.filter((f) => f.startsWith("supabase/sql/live-generated/")), []);
});

test("no JWT-shaped credential in tracked SQL, docs or scripts", () => {
  for (const dir of ["supabase/migrations", "supabase/sql", "supabase/held", "docs", "scripts"]) {
    for (const p of walk(join(root, dir))) {
      if (/live-generated/.test(p)) continue;
      assert.doesNotMatch(read(p), /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, p);
    }
  }
});

test("deploy scripts pin the correct project, pass --project-ref and restrict function names", () => {
  const live = read(join(root, "scripts", "deploy", "deploy-live.ps1"));
  const test_ = read(join(root, "scripts", "deploy", "deploy-testing.ps1"));
  assert.ok(live.includes(`'${LIVE}'`) && !live.includes(TESTING));
  assert.ok(test_.includes(`'${TESTING}'`) && !test_.includes(LIVE));
  assert.match(live, /--project-ref \$LiveRef --no-verify-jwt/);
  assert.match(test_, /--project-ref \$TestingRef --workdir/);
  for (const f of TEN) assert.ok(live.includes(`'${f}'`), f);
  assert.doesNotMatch(live, /prodcheck/);
});

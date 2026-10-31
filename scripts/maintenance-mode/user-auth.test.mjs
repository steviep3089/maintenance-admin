// Offline tests for in-handler user authentication (verify_jwt=false) on the eight admin Edge Functions.
// Run: node --test scripts/maintenance-mode/user-auth.test.mjs   (Node 22.18+ strips TS types)
//
// SCOPE: the real signature verification is done by Supabase Auth (auth.getUser). Here Auth is simulated by a fake
// that genuinely verifies HS256 and ES256 signatures, expiry and audience with node:crypto, so these tests prove
// getAuthenticatedUser() accepts exactly what a correct verifier accepts, never trusts the token itself, and that every
// handler is wired to it before any other work. They do NOT prove the hosted Auth service or gateway behaviour; that
// is the TESTING smoke test (see docs/JWT_SIGNING_KEYS.md).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const { getAuthenticatedUser } = await import(pathToFileURL(join(root, "supabase/functions/_shared/user_auth.ts")).href);

const SECURED = [
  "create-user", "delete-user", "get-admin-users", "list-users",
  "resend-invite", "send-report-email", "upload-drive", "invite-contracts-portal",
];
const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const USER_ID = "00000000-0000-4000-8000-0000000000aa";
const now = () => Math.floor(Date.now() / 1000);

// --- key material (test-only, generated per run) ---
const HS_SECRET = crypto.randomBytes(32);
const ES = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const OTHER_ES = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });

function sign(alg, claims, { header = {}, key } = {}) {
  const h = b64({ alg, typ: "JWT", ...(alg === "ES256" ? { kid: "es-1" } : {}), ...header });
  const p = b64(claims);
  const input = `${h}.${p}`;
  let sig;
  if (alg === "HS256") sig = crypto.createHmac("sha256", key ?? HS_SECRET).update(input).digest();
  else if (alg === "ES256") sig = crypto.sign("sha256", Buffer.from(input), { key: key ?? ES.privateKey, dsaEncoding: "ieee-p1363" });
  else sig = Buffer.alloc(0);
  return `${input}.${sig.toString("base64url")}`;
}
const userClaims = (over = {}) => ({ sub: USER_ID, aud: "authenticated", role: "authenticated", exp: now() + 3600, iat: now(), ...over });

// Fake Auth service: the only place a token is verified, like the hosted Auth server. Accepts the HS256 legacy secret
// (current key) and the ES256 public key (standby/active key); rejects everything else.
function verifyLikeAuth(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header, claims;
  try { header = JSON.parse(Buffer.from(parts[0], "base64url")); claims = JSON.parse(Buffer.from(parts[1], "base64url")); } catch { return null; }
  const input = `${parts[0]}.${parts[1]}`;
  const sig = Buffer.from(parts[2], "base64url");
  let ok = false;
  if (header.alg === "HS256") {
    const mac = crypto.createHmac("sha256", HS_SECRET).update(input).digest();
    ok = sig.length === mac.length && crypto.timingSafeEqual(sig, mac);
  } else if (header.alg === "ES256") {
    ok = crypto.verify("sha256", Buffer.from(input), { key: ES.publicKey, dsaEncoding: "ieee-p1363" }, sig);
  }
  if (!ok || typeof claims.exp !== "number" || claims.exp <= now() || !claims.sub) return null; // no sub = anon/service key
  return { id: claims.sub, aud: claims.aud };
}
function fakeClient({ calls = [], throws = false, override } = {}) {
  return {
    auth: {
      async getUser(token) {
        calls.push(token);
        if (throws) throw new Error("network down SECRET-DETAIL");
        const user = override ? override(token) : verifyLikeAuth(token);
        return user ? { data: { user }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } };
      },
    },
  };
}
const reqWith = (authorization) => new Request("https://f.example/fn", { headers: authorization === undefined ? {} : { Authorization: authorization } });

test("valid HS256 (current key) and ES256 (new signing key) user tokens authenticate", async () => {
  for (const token of [sign("HS256", userClaims()), sign("ES256", userClaims())]) {
    const user = await getAuthenticatedUser(reqWith(`Bearer ${token}`), fakeClient());
    assert.equal(user?.id, USER_ID);
  }
});

test("bearer scheme is case-insensitive and tolerates surrounding whitespace only", async () => {
  const token = sign("ES256", userClaims());
  assert.equal((await getAuthenticatedUser(reqWith(`bearer ${token}`), fakeClient()))?.id, USER_ID);
  assert.equal((await getAuthenticatedUser(reqWith(`BEARER   ${token} `), fakeClient()))?.id, USER_ID);
});

test("rejected: missing/other schemes, expired, tampered, wrong key, alg none, algorithm confusion, anon/service keys", async () => {
  const good = sign("ES256", userClaims());
  const [h, p, s] = good.split(".");
  const tamperedClaims = `${h}.${b64(userClaims({ sub: "00000000-0000-4000-8000-0000000000bb" }))}.${s}`;
  const cases = {
    "no header": undefined,
    "empty header": "",
    "bearer with no token": "Bearer",
    "basic scheme": `Basic ${good}`,
    "raw token without scheme": good,
    "two tokens": `Bearer ${good} ${good}`,
    "expired HS256": `Bearer ${sign("HS256", userClaims({ exp: now() - 10 }))}`,
    "expired ES256": `Bearer ${sign("ES256", userClaims({ exp: now() - 10 }))}`,
    "ES256 signed by another key": `Bearer ${sign("ES256", userClaims(), { key: OTHER_ES.privateKey })}`,
    "HS256 signed with another secret": `Bearer ${sign("HS256", userClaims(), { key: crypto.randomBytes(32) })}`,
    "tampered claims": `Bearer ${tamperedClaims}`,
    "truncated signature": `Bearer ${h}.${p}.${s.slice(0, 10)}`,
    "alg none": `Bearer ${sign("none", userClaims())}`,
    "HS256 using the public key as the secret (alg confusion)": `Bearer ${sign("HS256", userClaims(), { key: ES.publicKey.export({ type: "spki", format: "pem" }) })}`,
    "legacy anon key (no sub)": `Bearer ${sign("HS256", { role: "anon", iss: "supabase", exp: now() + 3600 })}`,
    "legacy service_role key (no sub)": `Bearer ${sign("HS256", { role: "service_role", iss: "supabase", exp: now() + 3600 })}`,
    "publishable key": "Bearer sb_publishable_abcdefghijklmnopqrstuvwx",
    "secret key": "Bearer sb_secret_abcdefghijklmnopqrstuvwx",
    "garbage": "Bearer not.a.jwt!",
    "malformed jwt": "Bearer abc.def",
  };
  for (const [name, header] of Object.entries(cases)) {
    assert.equal(await getAuthenticatedUser(reqWith(header), fakeClient()), null, name);
  }
});

test("a user whose audience is not 'authenticated', or without an id, is rejected even if Auth returns it", async () => {
  const token = sign("ES256", userClaims());
  for (const user of [{ id: USER_ID, aud: "anon" }, { id: USER_ID }, { id: "", aud: "authenticated" }, { aud: "authenticated" }, null]) {
    assert.equal(await getAuthenticatedUser(reqWith(`Bearer ${token}`), fakeClient({ override: () => user })), null);
  }
});

test("Auth errors, network failure and exceptions fail closed without leaking details", async () => {
  const token = sign("HS256", userClaims());
  const logged = [];
  const original = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  try {
    assert.equal(await getAuthenticatedUser(reqWith(`Bearer ${token}`), fakeClient({ throws: true })), null);
  } finally {
    console.error = original;
  }
  assert.deepEqual(logged, [], "helper never logs");
});

test("garbage never reaches Auth; oversized tokens are rejected before any call", async () => {
  const calls = [];
  const client = fakeClient({ calls });
  for (const h of [undefined, "Bearer sb_publishable_x", "Bearer a.b", `Bearer ${"a".repeat(5000)}.bbbbbbbb.cccccccc`, "Bearer ../../etc.passwd.x"]) {
    assert.equal(await getAuthenticatedUser(reqWith(h), client), null);
  }
  assert.equal(calls.length, 0);
  await getAuthenticatedUser(reqWith(`Bearer ${sign("HS256", userClaims())}`), client);
  assert.equal(calls.length, 1);
});

test("helper never verifies, decodes or trusts the token itself and reads no signing secret", () => {
  const src = read("supabase/functions/_shared/user_auth.ts");
  const code = src.replace(/\/\/.*$/gm, "");
  assert.ok(!/atob|Buffer|JSON\.parse|crypto|jwtVerify|jose|djwt|createHmac|SUPABASE_JWT_SECRET|JWT_SECRET|Deno\.env|console\./.test(code), "no local verification, env or logging");
  assert.ok(/supabase\.auth\.getUser\(token\)/.test(code), "delegates to Supabase Auth");
  assert.ok(!/eyJ|sb_secret|sb_publishable/.test(src));
});

test("all eight handlers authenticate through the shared helper, before any other work, with no local JWT handling", () => {
  for (const name of SECURED) {
    const src = read(`supabase/functions/${name}/index.ts`);
    assert.match(src, /import \{ getAuthenticatedUser \} from '\.\.\/_shared\/user_auth\.ts'/, name);
    assert.equal((src.match(/getAuthenticatedUser\(req, /g) || []).length, 1, `${name}: exactly one authentication call`);
    assert.ok(!/auth\.getUser\(/.test(src), `${name}: no inline getUser (all verification goes through the helper)`);
    assert.ok(!/SUPABASE_JWT_SECRET|JWT_SECRET|SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|jwtVerify|jose|djwt/.test(src.replace(/\/\/.*$/gm, "")), `${name}: no legacy key or local JWT verification`);

    const handler = src.slice(src.indexOf("serve(async"));
    const authAt = Math.min(...["getAuthenticatedUser(", "authorizeAdmin("].map((n) => handler.indexOf(n)).filter((i) => i !== -1));
    // The helper (authorizeAdmin) call or the direct call must precede the body parse and every side-effecting call.
    for (const token of ["req.json()", "auth.admin.", ".storage", "createClient(", "fetch(", ".insert(", ".update(", ".delete(", ".upsert(", "Deno.connectTls"]) {
      const idx = handler.indexOf(token);
      if (idx !== -1) assert.ok(idx > authAt, `${name}: "${token}" must come after authentication`);
    }
    // Only the OPTIONS preflight may answer before authentication.
    const beforeAuth = handler.slice(0, authAt);
    assert.ok(!/status: 200/.test(beforeAuth), `${name}: no 200 before authentication`);
  }
});

test("authenticated-user check precedes the role check and the Maintenance Mode guard in every handler", () => {
  for (const name of SECURED) {
    const src = read(`supabase/functions/${name}/index.ts`);
    const authAt = src.indexOf("getAuthenticatedUser(req, ");
    const roleAt = Math.min(...["from('user_roles')", 'from("user_roles")', "getUserRole(", "authorizeAdmin"].map((n) => src.indexOf(n, authAt)).filter((i) => i !== -1));
    const guardAt = src.indexOf("enforceMaintenance(supabase", authAt) !== -1 ? src.indexOf("enforceMaintenance(supabase", authAt) : src.indexOf("enforceMaintenance(maintenanceAdmin", authAt);
    assert.ok(authAt !== -1 && roleAt !== -1 && guardAt !== -1, name);
    assert.ok(authAt < roleAt && roleAt < guardAt, `${name}: authenticate -> role -> maintenance guard`);
  }
  // Admin-only behaviour unchanged; invite-contracts-portal still allows admin or manager.
  for (const name of SECURED.filter((n) => n !== "invite-contracts-portal")) {
    assert.match(read(`supabase/functions/${name}/index.ts`), /roleRow\?\.role !== ['"]admin['"]|role !== 'admin'|callerRoleRow\?\.role !== 'admin'/, name);
  }
  assert.match(read("supabase/functions/invite-contracts-portal/index.ts"), /\["admin"\), \("manager"\)|\[\("admin"\), \("manager"\)\]/);
});

test("invite-contracts-portal: unauthenticated callers can never reach the Contracts client or its env check", () => {
  const src = read("supabase/functions/invite-contracts-portal/index.ts");
  const handler = src.slice(src.indexOf("serve(async"));
  const authAt = handler.indexOf("getAuthenticatedUser(");
  for (const token of ["CONTRACTS_SUPABASE_URL", "createClient(CONTRACTS", "contractsAdmin", "Missing contracts env vars", "req.json()"]) {
    const idx = handler.indexOf(token);
    if (idx !== -1) assert.ok(idx > authAt, `"${token}" must come after authentication`);
  }
  assert.ok(!/Unauthorized: \$\{/.test(src), "401 body no longer echoes the Auth error message");
});

test("config: the eight admin functions use verify_jwt=false only because the handler authenticates; system functions unchanged", () => {
  const config = read("supabase/config.toml");
  for (const name of [...SECURED, "notify-defect", "notify-expiring-invites"]) {
    assert.match(config, new RegExp(`\\[functions\\.${name}\\]\\s*verify_jwt = false`), name);
  }
  for (const name of ["notify-defect", "notify-expiring-invites"]) {
    const src = read(`supabase/functions/${name}/index.ts`);
    assert.ok(!src.includes("user_auth") && !src.includes("maintenance_guard"), `${name} untouched`);
  }
  // Every function with verify_jwt=false must authenticate itself: user token or HMAC signature.
  for (const name of SECURED) assert.ok(read(`supabase/functions/${name}/index.ts`).includes("getAuthenticatedUser("), name);
  for (const name of ["notify-defect", "notify-expiring-invites"]) assert.ok(/signed_request/.test(read(`supabase/functions/${name}/index.ts`)), name);
});

test("admin client still uses the secret key; no function depends on legacy env vars", () => {
  const client = read("supabase/functions/_shared/maintenance_admin_client.ts");
  assert.ok(client.includes("SUPABASE_SECRET_KEYS") && !/SERVICE_ROLE|SUPABASE_ANON_KEY/.test(client));
  for (const name of SECURED) assert.ok(read(`supabase/functions/${name}/index.ts`).includes("createMaintenanceAdminClient()"), name);
});

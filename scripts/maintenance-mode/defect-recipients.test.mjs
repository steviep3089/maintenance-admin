import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..', '..')
const fn = (...p) => resolve(repo, 'supabase', ...p)
const tfn = (...p) => resolve(repo, 'supabase-testing', 'supabase', ...p)
const { findDivisionAdminEmails, parseDivisionId } = await import(`file:///${fn('functions', '_shared', 'defect_recipients.ts').replace(/\\/g, '/')}`)
const { getDefectNotificationSafety } = await import(`file:///${fn('functions', '_shared', 'notification_safety.ts').replace(/\\/g, '/')}`)

const DIV = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const U = (n) => `0000000${n}-0000-4000-8000-000000000000`

function fakeClient({ links = [], roles = [], users = {}, linksError = null, rolesError = null }) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, filters: {} }
      const b = {
        select: () => b,
        eq: (c, v) => { q.filters[c] = v; return b },
        in: (c, v) => { q.filters[c] = v; return b },
        then: (res) => {
          calls.push(q)
          if (table === 'user_divisions') {
            return res(linksError ? { data: null, error: linksError } : { data: links.filter((l) => l.division_id === q.filters.division_id), error: null })
          }
          return res(rolesError ? { data: null, error: rolesError } : { data: roles.filter((r) => r.role === q.filters.role && q.filters.user_id.includes(r.user_id)), error: null })
        },
      }
      return b
    },
    auth: { admin: { getUserById: async (id) => (users[id] instanceof Error ? Promise.reject(users[id]) : users[id] ?? { data: null, error: { status: 404 } }) } },
  }
}
const ok = (email, extra = {}) => ({ data: { user: { email, ...extra } }, error: null })

test('parseDivisionId accepts uuids only', () => {
  assert.equal(parseDivisionId(DIV.toUpperCase()), DIV)
  for (const v of [null, undefined, '', 'abc', 5, `${DIV}x`, {}]) assert.equal(parseDivisionId(v), null)
})

test('safety: real only when enabled, no ALLOW_DRY_RUN, body not dryRun; NOTIFICATIONS_DRY_RUN ignored', () => {
  const s = (env, body = {}) => getDefectNotificationSafety(env, body).dryRun
  assert.equal(s({ defectEmailsEnabled: 'true' }), false)
  assert.equal(s({}), true)
  assert.equal(s({ defectEmailsEnabled: 'false' }), true)
  assert.equal(s({ defectEmailsEnabled: 'true', allowDryRun: 'true' }), true)
  assert.equal(s({ defectEmailsEnabled: 'true' }, { dryRun: true }), true)
  assert.equal(s({ defectEmailsEnabled: 'true', notificationsDryRun: 'true' }), false)
})

test('recipients: only active admins of that division', async () => {
  const c = fakeClient({
    links: [{ user_id: U(1), division_id: DIV }, { user_id: U(2), division_id: DIV }, { user_id: U(3), division_id: DIV }, { user_id: U(4), division_id: OTHER }, { user_id: U(5), division_id: DIV }],
    roles: [{ user_id: U(1), role: 'admin' }, { user_id: U(3), role: 'admin' }, { user_id: U(4), role: 'admin' }, { user_id: U(5), role: 'admin' }, { user_id: U(2), role: 'user' }],
    users: {
      [U(1)]: ok('a@x.test'),
      [U(3)]: ok('banned@x.test', { banned_until: new Date(Date.now() + 1e9).toISOString() }),
      [U(4)]: ok('other@x.test'),
      [U(5)]: ok('old-ban@x.test', { banned_until: new Date(Date.now() - 1e6).toISOString() }),
    },
  })
  assert.deepEqual((await findDivisionAdminEmails(c, DIV)).sort(), ['a@x.test', 'old-ban@x.test'])
})

test('recipients: none assigned, 404 skipped, dedupe, missing email', async () => {
  assert.deepEqual(await findDivisionAdminEmails(fakeClient({}), DIV), [])
  const c = fakeClient({
    links: [1, 2, 3, 4].map((n) => ({ user_id: U(n), division_id: DIV })),
    roles: [1, 2, 3, 4].map((n) => ({ user_id: U(n), role: 'admin' })),
    users: { [U(1)]: ok('same@x.test'), [U(2)]: ok('same@x.test'), [U(3)]: { data: null, error: { status: 404 } }, [U(4)]: ok('') },
  })
  assert.deepEqual(await findDivisionAdminEmails(c, DIV), ['same@x.test'])
})

test('recipients: lookup failures throw (so the claim is released)', async () => {
  await assert.rejects(findDivisionAdminEmails(fakeClient({ linksError: { message: 'x' } }), DIV))
  await assert.rejects(findDivisionAdminEmails(fakeClient({ links: [{ user_id: U(1), division_id: DIV }], rolesError: { message: 'x' } }), DIV))
  const base = { links: [{ user_id: U(1), division_id: DIV }], roles: [{ user_id: U(1), role: 'admin' }] }
  await assert.rejects(findDivisionAdminEmails(fakeClient({ ...base, users: { [U(1)]: { data: null, error: { status: 500 } } } }), DIV))
  await assert.rejects(findDivisionAdminEmails(fakeClient({ ...base, users: { [U(1)]: new Error('boom') } }), DIV))
})

for (const [name, file] of [
  ['production', fn('functions', 'notify-defect', 'index.ts')],
  ['prodcheck', tfn('functions', 'prodcheck-notify-defect', 'index.ts')],
]) {
  test(`${name} handler uses division recipients, never all admins, no deactivation`, () => {
    const src = readFileSync(file, 'utf8')
    assert.match(src, /getDefectNotificationSafety/)
    assert.match(src, /findDivisionAdminEmails\(supabase, divisionId\)/)
    assert.match(src, /DEFECT_EMAILS_ENABLED/)
    assert.doesNotMatch(src, /\.eq\('role', 'admin'\)/)
    assert.doesNotMatch(src, /NOTIFICATIONS_DRY_RUN/)
    assert.doesNotMatch(src, /ban_duration|ALLOW_USER_DEACTIVATION|updateUserById/)
    assert.ok(src.indexOf('parseDivisionId(defect.division_id)') < src.indexOf('runNotificationOnce') + 100000)
  })
}

test('helper copies are identical in production and testing-validation', () => {
  for (const f of ['defect_recipients.ts', 'notification_safety.ts']) {
    assert.equal(
      readFileSync(fn('functions', '_shared', f), 'utf8'),
      readFileSync(tfn('functions', '_shared', f), 'utf8'),
    )
  }
})

test('LIVE migration: only the function body changes; trigger untouched; rollback restores dryRun', () => {
  const m = readFileSync(fn('sql', 'notifications', '20261031_defect_division_notifications.sql'), 'utf8')
  const r = readFileSync(fn('sql', 'notifications', '20261031_defect_division_notifications_rollback.sql'), 'utf8')
  assert.match(m, /'dryRun', false/)
  assert.match(m, /'division_id', new\.division_id/)
  assert.match(m, /extensions\.hmac/)
  assert.match(m, /zebksrihswwwlejdiboq/)
  assert.doesNotMatch(m, /create trigger|drop trigger|cron\.|insert into|update public|delete from/i)
  assert.match(r, /'dryRun', true/)
  assert.doesNotMatch(r, /division_id', new/)
  assert.doesNotMatch(r, /create trigger|drop trigger|cron\./i)
  for (const s of [m, r]) {
    assert.match(s, /^begin;/m)
    assert.match(s, /^commit;/m)
    assert.match(s, /revoke all on function public\.notify_defect_created\(\) from anon/)
  }
})

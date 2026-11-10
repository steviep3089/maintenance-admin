import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..', '..')
const { MAINTENANCE_APP_URL, OPEN_APP_LABEL, ADMIN_PORTAL_LOGIN_LABEL, PASSWORD_SAVED_MESSAGE, DESKTOP_FALLBACK_MESSAGE, isMobileDevice } = await import(`file:///${resolve(repo, 'src', 'openApp.js').replace(/\\/g, '/')}`)

test('Open Maintenance App button uses the registered scheme, no credentials, mobile only', () => {
  const appJson = JSON.parse(readFileSync(resolve(repo, '..', 'maintenance-app', 'app.json'), 'utf8'))
  assert.equal(OPEN_APP_LABEL, 'Open Maintenance App')
  assert.ok(MAINTENANCE_APP_URL.startsWith(`${appJson.expo.scheme}://`))
  assert.doesNotMatch(MAINTENANCE_APP_URL, /[?#=]|token|code/i)
  assert.equal(isMobileDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }), true)
  assert.equal(isMobileDevice({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), true)
  assert.equal(isMobileDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), false)
  const src = readFileSync(resolve(repo, 'src', 'App.jsx'), 'utf8')
  assert.match(src, /\{OPEN_APP_LABEL\}/)
  assert.match(src, /onMobile \?/)
  assert.match(src, /\{PASSWORD_SAVED_MESSAGE\}/)
  assert.match(src, /\{ADMIN_PORTAL_LOGIN_LABEL\}/)
  assert.doesNotMatch(src, /Continue to Login|Back to Portal Login/)
  assert.equal(ADMIN_PORTAL_LOGIN_LABEL, 'Admin Portal Login')
  assert.match(PASSWORD_SAVED_MESSAGE, /saved/)
  assert.match(DESKTOP_FALLBACK_MESSAGE, /phone/)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..', '..')
const url = (p) => `file:///${resolve(repo, p).replace(/\\/g, '/')}`
const flag = await import(url('src/passwordSetupSignOut.js'))
const { MAINTENANCE_APP_URL, ADMIN_PORTAL_LOGIN_LABEL } = await import(url('src/openApp.js'))
const src = readFileSync(resolve(repo, 'src', 'App.jsx'), 'utf8')

// Mirrors the SIGNED_OUT branch of the App auth listener.
const onSignedOut = () => (flag.consumePasswordSetupSignOut() ? 'stay' : 'login')

test('intentional sign-out after password setup keeps the success screen; only once', () => {
  flag.markPasswordSetupSignOut()
  assert.equal(onSignedOut(), 'stay')
  assert.equal(onSignedOut(), 'login')
})

test('normal sign-out still navigates to Login', () => {
  assert.equal(onSignedOut(), 'login')
})

test('flag is cleared if sign-out never fires an event', () => {
  flag.markPasswordSetupSignOut()
  flag.clearPasswordSetupSignOut()
  assert.equal(onSignedOut(), 'login')
})

test('App wiring: listener consumes flag, handleReset sets it only on success, success screen shown to non-admins', () => {
  assert.match(src, /event === "SIGNED_OUT"\) \{\s*if \(consumePasswordSetupSignOut\(\)\)/)
  assert.match(src, /markPasswordSetupSignOut\(\);\s*try \{\s*await supabase\.auth\.signOut\(\);\s*\} finally \{\s*clearPasswordSetupSignOut\(\)/)
  const failIdx = src.search(/if \(error\) \{\s*setError\(error\.message\);\s*\} else \{/)
  assert.ok(failIdx > 0, 'failed update branch precedes success branch')
  const successBlock = src.slice(failIdx, src.indexOf('if (loading)', failIdx))
  assert.equal((successBlock.match(/setShowPostReset\(true\)/g) || []).length, 1)
  assert.ok(successBlock.indexOf('setError(error.message)') < successBlock.indexOf('setShowPostReset(true)'))
  assert.match(src, /!showPostReset && !allowNonAdmin && userRole !== "admin"/)
})

test('success screen keeps Admin Portal Login (onDone + redirect) and maintenanceapp://login', () => {
  assert.equal(MAINTENANCE_APP_URL, 'maintenanceapp://login')
  assert.equal(ADMIN_PORTAL_LOGIN_LABEL, 'Admin Portal Login')
  assert.match(src, /if \(onDone\) onDone\(\);\s*if \(typeof window !== "undefined"\) \{\s*window\.location\.href = portalLoginUrl;/)
  assert.match(src, /\{ADMIN_PORTAL_LOGIN_LABEL\}/)
})

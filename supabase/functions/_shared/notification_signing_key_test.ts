import { getNotificationSigningKey } from './notification_signing_key.ts'

Deno.test('notification signing key: preferred setting takes precedence', () => {
  const key = getNotificationSigningKey('preferred-test-key', 'fallback-test-key')
  if (key !== 'preferred-test-key') {
    throw new Error('preferred signing key must take precedence')
  }
})

Deno.test('notification signing key: legacy setting is used when preferred is absent', () => {
  const key = getNotificationSigningKey(undefined, 'fallback-test-key')
  if (key !== 'fallback-test-key') {
    throw new Error('legacy signing key must be used as fallback')
  }
})

Deno.test('notification signing key: empty settings remain unconfigured', () => {
  if (getNotificationSigningKey(undefined, undefined) !== '') {
    throw new Error('missing signing keys must remain empty')
  }
  if (getNotificationSigningKey('', '') !== '') {
    throw new Error('empty signing keys must remain empty')
  }
})

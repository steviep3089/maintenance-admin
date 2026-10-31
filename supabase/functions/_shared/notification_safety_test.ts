import { getNotificationSafety } from './notification_safety.ts'

Deno.test('production dry-run: signed body and environment both suppress side effects', () => {
  const bodyDryRun = getNotificationSafety(
    { allowUserDeactivation: 'false' },
    { dryRun: true, allowDeactivation: true },
  )
  const environmentDryRun = getNotificationSafety(
    { allowDryRun: 'true', allowUserDeactivation: 'false' },
    { dryRun: false, allowDeactivation: true },
  )

  if (!bodyDryRun.dryRun || bodyDryRun.allowDeactivation) {
    throw new Error('signed dryRun=true must suppress delivery and deactivation')
  }
  if (!environmentDryRun.dryRun || environmentDryRun.allowDeactivation) {
    throw new Error('environment dry-run must suppress delivery and deactivation')
  }
})

Deno.test('production dry-run: deactivation remains opt-in at both levels', () => {
  const requestOnly = getNotificationSafety(
    { allowUserDeactivation: 'false' },
    { dryRun: false, allowDeactivation: true },
  )
  const environmentOnly = getNotificationSafety(
    { allowUserDeactivation: 'true' },
    { dryRun: false, allowDeactivation: false },
  )

  if (requestOnly.allowDeactivation || environmentOnly.allowDeactivation) {
    throw new Error('deactivation requires environment and signed-body opt-ins')
  }
})

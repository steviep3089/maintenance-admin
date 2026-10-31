function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((value || '').toLowerCase())
}

export function getNotificationSafety(
  environment: {
    allowDryRun?: string
    notificationsDryRun?: string
    allowUserDeactivation?: string
  },
  body: Record<string, unknown>,
): { dryRun: boolean; allowDeactivation: boolean } {
  const dryRun =
    isEnabled(environment.allowDryRun) ||
    isEnabled(environment.notificationsDryRun) ||
    body.dryRun === true
  const allowDeactivation =
    !dryRun &&
    isEnabled(environment.allowUserDeactivation) &&
    body.allowDeactivation === true

  return { dryRun, allowDeactivation }
}

// notify-defect has its own switch so real defect emails can be enabled without touching the digest's
// NOTIFICATIONS_DRY_RUN. Real sending requires ALL of: DEFECT_EMAILS_ENABLED on, ALLOW_DRY_RUN (testing-only veto) not
// on, and a signed body that does not request a dry run. Anything else is a dry run. No deactivation exists here.
export function getDefectNotificationSafety(
  environment: { allowDryRun?: string; defectEmailsEnabled?: string },
  body: Record<string, unknown>,
): { dryRun: boolean } {
  const dryRun =
    isEnabled(environment.allowDryRun) ||
    body.dryRun === true ||
    !isEnabled(environment.defectEmailsEnabled)
  return { dryRun }
}

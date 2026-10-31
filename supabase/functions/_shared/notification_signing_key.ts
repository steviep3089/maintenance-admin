export function getNotificationSigningKey(
  preferredKey: string | undefined,
  legacyKey: string | undefined,
): string {
  return preferredKey || legacyKey || ''
}

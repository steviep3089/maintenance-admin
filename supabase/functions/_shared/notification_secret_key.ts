export function getDefaultSecretKey(secretKeysJson: string | undefined): string {
  if (!secretKeysJson) {
    throw new Error('Supabase secret API keys are not configured')
  }

  let secretKeys: unknown
  try {
    secretKeys = JSON.parse(secretKeysJson)
  } catch {
    throw new Error('Supabase secret API keys configuration is invalid')
  }

  if (
    !secretKeys ||
    typeof secretKeys !== 'object' ||
    Array.isArray(secretKeys) ||
    !('default' in secretKeys) ||
    typeof secretKeys.default !== 'string' ||
    secretKeys.default.trim().length === 0
  ) {
    throw new Error('Default Supabase secret API key is unavailable')
  }

  return secretKeys.default
}

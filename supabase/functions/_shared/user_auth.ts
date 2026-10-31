// Caller authentication for the admin-facing Edge Functions that run with verify_jwt = false.
//
// The Edge Functions gateway's legacy verify_jwt check only understands the legacy HS256 secret. With Supabase JWT
// Signing Keys (ES256/RS256) the documented approach is to disable it and validate the user's access token inside
// the function. The token is sent to Supabase Auth (GET /auth/v1/user via auth.getUser(token)), which verifies the
// signature against whichever key is current, plus expiry and that the session/user still exists. No JWT is decoded
// or verified locally and no signing secret is read here, so the result is identical for HS256 and ES256 tokens.
//
// The caller MUST still check the role in user_roles and run enforceMaintenance() afterwards. A publishable or
// legacy anon/service_role key is never a user and is rejected.

const BEARER = /^bearer\s+(\S+)$/i
// Three base64url segments. Only a cheap pre-filter so obvious garbage (e.g. a publishable key) never reaches Auth.
const JWT_SHAPE = /^[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}$/
const MAX_TOKEN_LENGTH = 4096

export type AuthenticatedUser = { id: string; [key: string]: unknown }

// Returns the verified user, or null for anything not provably an authenticated user (fail closed).
export async function getAuthenticatedUser(req: Request, supabase: any): Promise<AuthenticatedUser | null> {
  const match = BEARER.exec((req.headers.get('Authorization') || '').trim())
  const token = match?.[1] ?? ''
  if (!token || token.length > MAX_TOKEN_LENGTH || !JWT_SHAPE.test(token)) return null

  try {
    const { data, error } = await supabase.auth.getUser(token)
    const user = data?.user
    if (error || typeof user?.id !== 'string' || !user.id) return null
    // Anon/service keys and non-user tokens do not resolve to a user; this also rejects a non-authenticated audience.
    if (user.aud !== 'authenticated') return null
    return user as AuthenticatedUser
  } catch {
    return null
  }
}

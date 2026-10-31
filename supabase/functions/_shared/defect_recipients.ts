// Recipient selection for defect notifications: ACTIVE ADMINS assigned to the defect's division (user_divisions).
// Fails safe: no valid division means no recipients (never "all admins"); any lookup failure throws so the
// notification claim is released and the request can be retried.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseDivisionId(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null
}

// Accounts are deactivated by an Auth ban (banned_until). An unreadable ban value is treated as inactive.
function isActiveAccount(user: { banned_until?: unknown } | null | undefined): boolean {
  const banned = user?.banned_until
  if (banned === null || banned === undefined || banned === '') return true
  if (typeof banned !== 'string') return false
  const until = Date.parse(banned)
  return Number.isFinite(until) && until <= Date.now()
}

function isUserNotFound(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown } | null
  return e?.status === 404 || e?.code === 'user_not_found'
}

export async function findDivisionAdminEmails(supabase: any, divisionId: string): Promise<string[]> {
  const { data: links, error: linksError } = await supabase
    .from('user_divisions')
    .select('user_id')
    .eq('division_id', divisionId)
  if (linksError) throw new Error('Division recipient lookup failed')

  const assignedIds = [...new Set(
    (links || []).map((row: { user_id?: unknown }) => row.user_id).filter((id: unknown): id is string => typeof id === 'string' && id.length > 0),
  )] as string[]
  if (assignedIds.length === 0) return []

  const { data: roles, error: rolesError } = await supabase
    .from('user_roles')
    .select('user_id')
    .eq('role', 'admin')
    .in('user_id', assignedIds)
  if (rolesError) throw new Error('Admin role lookup failed')

  const adminIds = [...new Set(
    (roles || []).map((row: { user_id?: unknown }) => row.user_id).filter((id: unknown): id is string => typeof id === 'string' && id.length > 0),
  )] as string[]
  const assignedSet = new Set(assignedIds)
  const candidates = adminIds.filter((id) => assignedSet.has(id))

  const lookups = await Promise.allSettled(candidates.map((id) => supabase.auth.admin.getUserById(id)))
  const emails: string[] = []
  for (const lookup of lookups) {
    if (lookup.status === 'rejected') throw new Error('Admin email lookup failed')
    const { data, error } = lookup.value ?? {}
    if (error) {
      if (isUserNotFound(error)) continue
      throw new Error('Admin email lookup failed')
    }
    const user = data?.user
    const email = typeof user?.email === 'string' ? user.email.trim() : ''
    if (email && isActiveAccount(user)) emails.push(email)
  }
  return [...new Set(emails)]
}

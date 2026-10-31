// Maintenance Mode guard for the admin-facing Edge Functions that use the secret key.
// These functions bypass RLS, so the database policies cannot stop them. Call
// enforceMaintenance() AFTER the caller is authenticated and role-checked, and BEFORE any
// sensitive operation. Only the designated Super User passes while maintenance is ON.
// Not used by notify-defect / notify-expiring-invites (HMAC-signed system callers).

export type MaintenanceVerdict = 'allowed' | 'blocked' | 'unavailable'

// Fails closed: if the state cannot be read, the caller is NOT allowed through.
// Only the PostgREST/Postgres error CODE is logged (e.g. 42501 permission denied, PGRST205 table not in the
// schema cache) so an operator can tell why; messages, details and values are never logged.
function logUnavailable(stage: string, error: unknown) {
  const code = (error as { code?: unknown } | null)?.code
  console.error('Maintenance state unavailable:', stage, typeof code === 'string' ? code.slice(0, 16) : 'no-code')
}

export async function checkMaintenance(supabase: any, userId: string): Promise<MaintenanceVerdict> {
  try {
    const { data: mode, error: modeError } = await supabase
      .from('maintenance_mode')
      .select('enabled')
      .eq('id', true)
      .maybeSingle()
    if (modeError || !mode || typeof mode.enabled !== 'boolean') {
      logUnavailable(modeError ? 'mode-error' : 'mode-missing', modeError)
      return 'unavailable'
    }
    if (mode.enabled === false) return 'allowed'

    const { data: superUser, error: superError } = await supabase
      .from('maintenance_super_user')
      .select('user_id')
      .eq('id', true)
      .maybeSingle()
    if (superError) {
      logUnavailable('super-user-error', superError)
      return 'unavailable'
    }
    if (superUser?.user_id && superUser.user_id === userId) return 'allowed'
    return 'blocked'
  } catch {
    logUnavailable('exception', null)
    return 'unavailable'
  }
}

// Returns a 503 Response when the caller must not proceed, otherwise null.
export async function enforceMaintenance(
  supabase: any,
  userId: string,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const verdict = await checkMaintenance(supabase, userId)
  if (verdict === 'allowed') return null
  const body = verdict === 'blocked'
    ? { success: false, error: 'Maintenance in progress', maintenance: true }
    : { success: false, error: 'Service temporarily unavailable' }
  return new Response(JSON.stringify(body), {
    status: 503,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': '60' },
  })
}

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createMaintenanceAdminClient } from '../_shared/maintenance_admin_client.ts'
import { enforceMaintenance } from '../_shared/maintenance_guard.ts'
import { getAuthenticatedUser } from '../_shared/user_auth.ts'


// Validates the caller's access token and requires the admin role (fail closed).
async function authorizeAdmin(req: Request, supabase: any, corsHeaders: Record<string, string>) {
  const deny = (status: number) =>
    new Response(
      JSON.stringify({ success: false, error: status === 401 ? 'Unauthorized' : 'Forbidden' }),
      { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  const user = await getAuthenticatedUser(req, supabase)
  if (!user) return { userId: null, denied: deny(401) }

  const { data: roleRow, error: roleError } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (roleError) {
    console.error('Caller role lookup failed:', roleError.message)
    return { userId: null, denied: deny(403) }
  }
  if (roleRow?.role !== 'admin') return { userId: null, denied: deny(403) }

  const blocked = await enforceMaintenance(supabase, user.id as string, corsHeaders)
  if (blocked) return { userId: null, denied: blocked }

  return { userId: user.id as string, denied: null }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Errors whose message is safe to return to the caller
class ClientError extends Error {}

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createMaintenanceAdminClient()

    const auth = await authorizeAdmin(req, supabase, corsHeaders)
    if (auth.denied) return auth.denied

    const { userId } = await req.json()
    if (!userId) {
      throw new ClientError('userId is required')
    }
    if (typeof userId !== 'string' || !UUID_PATTERN.test(userId)) {
      throw new ClientError('Invalid userId')
    }
    if (userId === auth.userId) {
      throw new ClientError('You cannot delete your own account')
    }

    // Fail closed: administrators and managers can never be deleted through this function
    const { data: targetRole, error: targetRoleError } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', userId)
      .maybeSingle()
    if (targetRoleError) {
      console.error('Target role lookup failed:', targetRoleError.message)
      throw new Error('Role lookup failed')
    }
    if (targetRole?.role === 'admin' || targetRole?.role === 'manager') {
      throw new ClientError('Administrators and managers cannot be deleted')
    }

    const { error: roleError } = await supabase
      .from('user_roles')
      .delete()
      .eq('user_id', userId)

    if (roleError) throw roleError

    const { error: divisionError } = await supabase
      .from('user_divisions')
      .delete()
      .eq('user_id', userId)

    if (divisionError) throw divisionError

    const { error: deleteError } = await supabase.auth.admin.deleteUser(userId)
    if (deleteError) throw deleteError

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error('Delete user error:', error)
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof ClientError ? error.message : 'Failed to delete user',
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

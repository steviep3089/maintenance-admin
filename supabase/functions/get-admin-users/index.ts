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

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Use the privileged server client only after verifying the caller is an admin.
    const supabase = createMaintenanceAdminClient()

    const auth = await authorizeAdmin(req, supabase, corsHeaders)
    if (auth.denied) return auth.denied

    // Get all admin user IDs
    const { data: adminRoles, error: roleError } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('role', 'admin')

    if (roleError) throw roleError

    console.log('Admin roles found:', adminRoles?.length)

    const adminUserIds = adminRoles.map(r => r.user_id).filter(Boolean)
    if (!adminUserIds.length) {
      return new Response(
        JSON.stringify({ success: true, adminEmails: [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Fetch only admin users instead of listing all users
    const adminEmailResults = await Promise.allSettled(
      adminUserIds.map(async (userId) => {
        const { data, error } = await supabase.auth.admin.getUserById(userId)
        if (error) {
          throw error
        }
        return data?.user?.email || null
      })
    )

    const adminEmails = adminEmailResults
      .filter(result => result.status === "fulfilled")
      .map(result => result.value)
      .filter(Boolean)

    const failedLookups = adminEmailResults.filter(result => result.status === "rejected")
    if (failedLookups.length) {
      console.warn("Admin user lookup failures:", failedLookups.length)
    }

    console.log('Admin emails found:', adminEmails.length)

    return new Response(
      JSON.stringify({ success: true, adminEmails }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (error) {
    console.error('Error:', error)
    return new Response(
      JSON.stringify({ success: false, error: error.message }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})

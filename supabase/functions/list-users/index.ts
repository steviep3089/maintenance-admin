import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createMaintenanceAdminClient } from '../_shared/maintenance_admin_client.ts'
import { enforceMaintenance } from '../_shared/maintenance_guard.ts'
import { getAuthenticatedUser } from '../_shared/user_auth.ts'

const CONTRACTS_SUPABASE_URL = Deno.env.get('CONTRACTS_SUPABASE_URL') || ''
const CONTRACTS_SERVICE_ROLE_KEY = Deno.env.get('CONTRACTS_SERVICE_ROLE_KEY') || ''
const CONTRACTS_LOOKUP_CONFIGURED = !!(CONTRACTS_SUPABASE_URL && CONTRACTS_SERVICE_ROLE_KEY)
const INVITE_EXPIRY_MS = 24 * 60 * 60 * 1000
const INACTIVITY_TIMEOUT_MS = 60 * 24 * 60 * 60 * 1000

async function listContractsUsersByEmailMap() {
  const map: Record<string, { id: string; pendingSetup: boolean }> = {}

  if (!CONTRACTS_SUPABASE_URL || !CONTRACTS_SERVICE_ROLE_KEY) {
    return map
  }

  let page = 1
  while (true) {
    const res = await fetch(`${CONTRACTS_SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=1000`, {
      method: 'GET',
      headers: {
        apikey: CONTRACTS_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${CONTRACTS_SERVICE_ROLE_KEY}`,
      },
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed reading contracts auth users (${res.status}): ${text}`)
    }

    const json = await res.json()
    const users = Array.isArray(json?.users) ? json.users : []

    users.forEach((user: any) => {
      const email = String(user?.email || '').trim().toLowerCase()
      const id = String(user?.id || '').trim()
      if (email && id) {
        const passwordSet = user?.user_metadata?.password_set === true
        const hasSignedIn = !!user?.last_sign_in_at
        map[email] = {
          id,
          pendingSetup: !(passwordSet || hasSignedIn),
        }
      }
    })

    if (users.length < 1000) {
      break
    }
    page += 1
  }

  return map
}

function getAccountStatus(user: any) {
  const inactiveDueToNonUsage = user?.user_metadata?.inactive_due_to_non_usage === true
  const inactiveMarkedAt = user?.user_metadata?.inactive_marked_at || null

  if (inactiveDueToNonUsage) {
    return {
      label: "inactive",
      inviteSentAt: user?.user_metadata?.invite_sent_at || user?.invited_at || user?.created_at || null,
      inviteExpiresAt: null,
      inactiveMarkedAt,
      inactiveAt: inactiveMarkedAt,
      inactiveRemainingDays: 0,
    }
  }

  const passwordSet = user?.user_metadata?.password_set === true
  const hasSignedIn = !!user?.last_sign_in_at
  const inviteSentAt =
    user?.user_metadata?.invite_sent_at || user?.invited_at || user?.created_at || null
  const inviteSentMs = inviteSentAt ? Date.parse(inviteSentAt) : Number.NaN
  const inviteExpiresAt = Number.isNaN(inviteSentMs)
    ? null
    : new Date(inviteSentMs + INVITE_EXPIRY_MS).toISOString()

  const activityAnchorRaw = user?.last_sign_in_at || user?.created_at || null
  const activityAnchorMs = activityAnchorRaw ? Date.parse(activityAnchorRaw) : Number.NaN
  const inactiveAt = Number.isNaN(activityAnchorMs)
    ? null
    : new Date(activityAnchorMs + INACTIVITY_TIMEOUT_MS).toISOString()
  const inactiveRemainingDays = Number.isNaN(activityAnchorMs)
    ? null
    : Math.max(0, Math.ceil((activityAnchorMs + INACTIVITY_TIMEOUT_MS - Date.now()) / (24 * 60 * 60 * 1000)))

  if (passwordSet || hasSignedIn) {
    return {
      label: "live",
      inviteSentAt,
      inviteExpiresAt,
      inactiveMarkedAt: null,
      inactiveAt,
      inactiveRemainingDays,
    }
  }

  if (!Number.isNaN(inviteSentMs) && Date.now() > inviteSentMs + INVITE_EXPIRY_MS) {
    return {
      label: "invite_expired",
      inviteSentAt,
      inviteExpiresAt,
      inactiveMarkedAt: null,
      inactiveAt,
      inactiveRemainingDays,
    }
  }

  return {
    label: "pending_setup",
    inviteSentAt,
    inviteExpiresAt,
    inactiveMarkedAt: null,
    inactiveAt,
    inactiveRemainingDays,
  }
}

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const jsonResponse = (status: number, body: Record<string, unknown>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })

  try {
    // Admin client; no data is read with it until the caller is authorised
    const supabase = createMaintenanceAdminClient()

    // Validate the access token with Supabase Auth (works for HS256 and asymmetric signing keys)
    const caller = await getAuthenticatedUser(req, supabase)

    if (!caller) {
      return jsonResponse(401, { success: false, error: 'Unauthorized' })
    }

    // Fail closed: any lookup error or missing/non-admin role is denied
    const { data: callerRoleRow, error: callerRoleError } = await supabase
      .from('user_roles')
      .select('role')
      .eq('user_id', caller.id)
      .maybeSingle()

    if (callerRoleError) {
      console.error('Caller role lookup failed:', callerRoleError.message)
      return jsonResponse(403, { success: false, error: 'Forbidden' })
    }

    if (callerRoleRow?.role !== 'admin') {
      return jsonResponse(403, { success: false, error: 'Forbidden' })
    }

    const maintenanceBlock = await enforceMaintenance(supabase, caller.id, corsHeaders)
    if (maintenanceBlock) return maintenanceBlock

    // Get all users
    const { data: authData, error: authError } = await supabase.auth.admin.listUsers()

    if (authError) {
      console.error('Auth error:', authError)
      throw authError
    }

    const { data: rolesData, error: rolesError } = await supabase
      .from("user_roles")
      .select("user_id, role")

    if (rolesError) {
      console.error("Role load error:", rolesError)
      throw rolesError
    }

    const rolesMap: Record<string, string> = {}
    rolesData.forEach((row) => {
      rolesMap[row.user_id] = row.role
    })

    const { data: userDivisionRows, error: userDivisionError } = await supabase
      .from("user_divisions")
      .select("user_id, divisions(name)")

    if (userDivisionError) {
      console.error("Division load error:", userDivisionError)
      throw userDivisionError
    }

    const divisionMap: Record<string, string[]> = {}
    ;(userDivisionRows || []).forEach((row: any) => {
      const userId = row.user_id
      const divisionName = row.divisions?.name
      if (!userId || !divisionName) {
        return
      }
      if (!divisionMap[userId]) {
        divisionMap[userId] = []
      }
      divisionMap[userId].push(divisionName)
    })

    let contractsByEmail: Record<string, { id: string; pendingSetup: boolean }> = {}
    try {
      contractsByEmail = await listContractsUsersByEmailMap()
    } catch (contractsLookupError) {
      console.warn('Contracts lookup skipped:', contractsLookupError)
    }

    // Map to simple format
    const users = authData.users.map((user) => {
      const accountStatus = getAccountStatus(user)
      const email = String(user.email || '').trim().toLowerCase()
      const contractsLookup = contractsByEmail[email]
      const contractsUserId = contractsLookup?.id || null
      const contractsPendingSetup = !!contractsLookup?.pendingSetup
      return {
        id: user.id,
        email: user.email,
        role: rolesMap[user.id] || "user",
        divisions: (divisionMap[user.id] || []).sort((a, b) => a.localeCompare(b)),
        contracts_linked: !!contractsUserId,
        contracts_user_id: contractsUserId,
        contracts_pending_setup: contractsPendingSetup,
        contracts_lookup_configured: CONTRACTS_LOOKUP_CONFIGURED,
        status: accountStatus.label,
        invite_sent_at: accountStatus.inviteSentAt,
        invite_expires_at: accountStatus.inviteExpiresAt,
        inactive_at: accountStatus.inactiveAt,
        inactive_remaining_days: accountStatus.inactiveRemainingDays,
        inactive_marked_at: accountStatus.inactiveMarkedAt,
        last_sign_in_at: user.last_sign_in_at || null,
      }
    })

    return new Response(
      JSON.stringify({ 
        success: true, 
        users: users
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )

  } catch (error) {
    console.error('Exception:', error)
    return jsonResponse(500, { success: false, error: 'Internal server error' })
  }
})

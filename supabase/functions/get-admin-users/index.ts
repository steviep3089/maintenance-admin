import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Use service_role to bypass RLS
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // Get all admin user IDs
    const { data: adminRoles, error: roleError } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('role', 'admin')

    if (roleError) throw roleError

    console.log('Admin roles found:', adminRoles?.length)

    // Get all users
    const { data: { users }, error: usersError } = await supabase.auth.admin.listUsers()

    if (usersError) throw usersError

    console.log('Total users found:', users?.length)

    // Filter to admin users only
    const adminUserIds = adminRoles.map(r => r.user_id)
    const adminEmails = users
      .filter(u => adminUserIds.includes(u.id))
      .map(u => u.email)
      .filter(Boolean)

    console.log('Admin emails:', adminEmails)

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

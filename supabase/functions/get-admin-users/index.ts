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

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
    const { email, password, role } = await req.json()
    
    console.log('Creating user:', email, 'with role:', role)

    // Create Supabase admin client with service_role key
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    // Create user in auth
    const { data: userData, error: authError } = await supabase.auth.admin.createUser({
      email: email,
      password: password,
      email_confirm: true
    })

    if (authError) {
      console.error('Auth error:', authError)
      throw authError
    }

    if (!userData.user) {
      throw new Error('User creation failed - no user returned')
    }

    console.log('User created in auth:', userData.user.id)

    // Only insert into user_roles if role is admin or manager
    // Regular users only exist in auth.users, not user_roles
    if (role === 'admin' || role === 'manager') {
      const { data: roleData, error: roleError } = await supabase
        .from('user_roles')
        .insert({
          user_id: userData.user.id,
          role: role
        })
        .select()

      if (roleError) {
        console.error('Role insert error:', roleError)
        console.error('Role error details:', JSON.stringify(roleError))
        // Try to delete the auth user if role insert fails
        await supabase.auth.admin.deleteUser(userData.user.id)
        throw new Error(`Failed to assign role: ${roleError.message}`)
      }

      console.log('Role assigned successfully:', roleData)
    } else {
      console.log('Regular user - no role entry needed')
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        user: {
          id: userData.user.id,
          email: userData.user.email,
          role: role
        }
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )

  } catch (error) {
    console.error('Exception:', error)
    
    // Return proper error messages for common cases
    let errorMessage = error.message || 'Unknown error'
    
    if (error.message?.includes('already been registered')) {
      errorMessage = 'A user with this email already exists'
    }
    
    return new Response(
      JSON.stringify({ 
        success: false,
        error: errorMessage
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

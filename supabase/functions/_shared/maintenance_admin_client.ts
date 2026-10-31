import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getDefaultSecretKey } from './supabase_secret_key.ts'

export function createMaintenanceAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  if (!supabaseUrl) {
    throw new Error('Supabase URL is not configured')
  }

  const secretKey = getDefaultSecretKey(Deno.env.get('SUPABASE_SECRET_KEYS'))
  return createClient(supabaseUrl, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

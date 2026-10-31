import { createClient } from 'npm:@supabase/supabase-js@2'
import { getDefaultSecretKey } from './notification_secret_key.ts'

export function createNotificationAdminClient() {
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

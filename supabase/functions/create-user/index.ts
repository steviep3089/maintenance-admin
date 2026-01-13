import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const GMAIL_USER = Deno.env.get('GMAIL_USER')!
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD')!

async function sendViaGmail(to: string, subject: string, html: string) {
  const conn = await Deno.connectTls({
    hostname: "smtp.gmail.com",
    port: 465
  })

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  async function readLine(conn: Deno.TlsConn): Promise<string> {
    const buf = new Uint8Array(1024)
    const n = await conn.read(buf)
    if (!n) return ""
    return decoder.decode(buf.subarray(0, n)).trim()
  }

  async function writeLine(conn: Deno.TlsConn, line: string) {
    await conn.write(encoder.encode(line + "\r\n"))
  }

  try {
    await readLine(conn)

    await writeLine(conn, `EHLO maintenance-portal`)
    await readLine(conn)

    await writeLine(conn, `AUTH LOGIN`)
    await readLine(conn)

    const usernameB64 = btoa(GMAIL_USER)
    await writeLine(conn, usernameB64)
    await readLine(conn)

    const passwordB64 = btoa(GMAIL_APP_PASSWORD)
    await writeLine(conn, passwordB64)
    await readLine(conn)

    await writeLine(conn, `MAIL FROM:<${GMAIL_USER}>`)
    await readLine(conn)

    await writeLine(conn, `RCPT TO:<${to}>`)
    await readLine(conn)

    await writeLine(conn, `DATA`)
    await readLine(conn)

    const emailContent = [
      `From: Sitebatch Maintenance <${GMAIL_USER}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      html,
      `.`
    ].join('\r\n')

    await conn.write(encoder.encode(emailContent + "\r\n"))
    await readLine(conn)

    await writeLine(conn, `QUIT`)
    await readLine(conn)

    conn.close()
    return { success: true }
  } catch (error) {
    conn.close()
    throw error
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

  try {
    const { email, role, redirectTo } = await req.json()
    
    console.log('Creating user:', email, 'with role:', role)

    // Create Supabase admin client with service_role key
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    const { data: linkData, error: authError } = await supabase.auth.admin.generateLink({
      type: "invite",
      email,
      options: {
        redirectTo,
        data: {
          invited: true,
          password_set: false,
          role,
        },
      },
    })

    if (authError) {
      console.error('Auth error:', authError)
      throw authError
    }

    if (!linkData.user) {
      throw new Error('User creation failed - no user returned')
    }

    if (!linkData.properties?.action_link) {
      throw new Error('Invite link not generated')
    }

    console.log('User created in auth:', linkData.user.id)

    const { error: metadataError } = await supabase.auth.admin.updateUserById(
      linkData.user.id,
      {
        user_metadata: {
          invited: true,
          password_set: false,
          role,
        },
      }
    )

    if (metadataError) {
      console.error('Metadata update error:', metadataError)
      throw new Error(`Failed to set invite metadata: ${metadataError.message}`)
    }

    // Only insert into user_roles if role is admin or manager
    // Regular users only exist in auth.users, not user_roles
    if (role === 'admin' || role === 'manager') {
      const { data: roleData, error: roleError } = await supabase
        .from('user_roles')
        .insert({
          user_id: linkData.user.id,
          role: role
        })
        .select()

      if (roleError) {
        console.error('Role insert error:', roleError)
        console.error('Role error details:', JSON.stringify(roleError))
        // Try to delete the auth user if role insert fails
        await supabase.auth.admin.deleteUser(linkData.user.id)
        throw new Error(`Failed to assign role: ${roleError.message}`)
      }

      console.log('Role assigned successfully:', roleData)
    } else {
      console.log('Regular user - no role entry needed')
    }

    const isAdmin = role === 'admin' || role === 'manager'
    const subject = isAdmin
      ? "You have been invited as an admin for the Sitebatch Maintenance Portal"
      : "You have been invited as a user for the Sitebatch Maintenance App"
    const heading = isAdmin
      ? "You have been invited as an admin for the Sitebatch Maintenance Portal"
      : "You have been invited as a user for the Sitebatch Maintenance App"
    const actionText = isAdmin ? "Set your password" : "Open the Maintenance App"
    const actionLinkUrl = new URL(linkData.properties.action_link)
    if (redirectTo) {
      actionLinkUrl.searchParams.set("redirect_to", redirectTo)
    }
    const actionLink = actionLinkUrl.toString()

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h2>${heading}</h2>
        <p>Please click the button below to continue:</p>
        <p>
          <a href="${actionLink}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">
            ${actionText}
          </a>
        </p>
        <p>If the button does not work, copy and paste this link into your browser:</p>
        <p>${actionLink}</p>
      </div>
    `

    await sendViaGmail(email, subject, html)

    return new Response(
      JSON.stringify({ 
        success: true, 
        user: {
          id: linkData.user.id,
          email: linkData.user.email,
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

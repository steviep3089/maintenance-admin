import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GMAIL_USER = Deno.env.get('GMAIL_USER')!
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Simple SMTP helper using native Deno
async function sendEmail(to: string, subject: string, html: string) {
  const conn = await Deno.connectTls({
    hostname: "smtp.gmail.com",
    port: 465,
  })

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  
  async function readResponse() {
    const buffer = new Uint8Array(1024)
    const n = await conn.read(buffer)
    return decoder.decode(buffer.subarray(0, n || 0))
  }
  
  async function sendCommand(cmd: string) {
    await conn.write(encoder.encode(cmd + "\r\n"))
    return await readResponse()
  }
  
  // Wait for server greeting
  await readResponse()
  
  // EHLO
  await sendCommand(`EHLO localhost`)
  
  // AUTH LOGIN
  await sendCommand(`AUTH LOGIN`)
  await sendCommand(btoa(GMAIL_USER))
  await sendCommand(btoa(GMAIL_APP_PASSWORD))
  
  // MAIL FROM
  await sendCommand(`MAIL FROM:<${GMAIL_USER}>`)
  
  // RCPT TO
  await sendCommand(`RCPT TO:<${to}>`)
  
  // DATA
  await sendCommand(`DATA`)
  
  // Email headers and body
  let email = `From: ${GMAIL_USER}\r\n`
  email += `To: ${to}\r\n`
  email += `Subject: ${subject}\r\n`
  email += `MIME-Version: 1.0\r\n`
  email += `Content-Type: text/html; charset=UTF-8\r\n`
  email += `\r\n`
  email += `${html}\r\n`
  email += `.\r\n`
  
  await conn.write(encoder.encode(email))
  await readResponse()
  
  // QUIT
  await sendCommand(`QUIT`)
  conn.close()
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
    const defect = await req.json()
    console.log('Processing defect notification:', defect.id)

    // Create Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    // Get all admin users
    const { data: adminRoles, error: rolesError } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('role', 'admin')

    if (rolesError) {
      console.error('Error fetching admin roles:', rolesError)
      throw rolesError
    }

    if (!adminRoles || adminRoles.length === 0) {
      console.log('No admin users found')
      return new Response(
        JSON.stringify({ success: true, message: 'No admins to notify' }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Get admin user emails
    const adminUserIds = adminRoles.map(r => r.user_id)
    const { data: adminUsers, error: usersError } = await supabase.auth.admin.listUsers()

    if (usersError) {
      console.error('Error fetching users:', usersError)
      throw usersError
    }

    const adminEmails = adminUsers.users
      .filter(u => adminUserIds.includes(u.id))
      .map(u => u.email)
      .filter(Boolean)

    if (adminEmails.length === 0) {
      console.log('No admin emails found')
      return new Response(
        JSON.stringify({ success: true, message: 'No admin emails found' }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    console.log(`Sending notifications to ${adminEmails.length} admins`)

    // Determine urgency based on priority
    const isUrgent = defect.priority === 1 || defect.priority === 2
    const priorityLabels: Record<number, string> = {
      1: 'Dangerous',
      2: 'Major',
      3: 'Routine',
      4: 'Minor',
      5: 'Cosmetic',
      6: 'Improvement / Preventative maintenance'
    }
    const priorityLabel = priorityLabels[defect.priority] || 'Unknown'
    const priorityColors: Record<number, string> = {
      1: '#ff4d4d',
      2: '#ff944d',
      3: '#ffd24d',
      4: '#4da6ff',
      5: '#d9d9d9',
      6: '#3cb371'
    }
    const priorityColor = priorityColors[defect.priority] || '#666'

    // Build email subject
    const subject = isUrgent
      ? `🚨 URGENT: ${priorityLabel} Defect Reported - ${defect.title}`
      : `📋 New ${priorityLabel} Defect Reported - ${defect.title}`

    // Build email body
    const urgencyText = isUrgent
      ? '<p style="color: #ff0000; font-weight: bold; font-size: 18px;">⚠️ This defect requires your URGENT ATTENTION</p>'
      : '<p style="color: #666; font-size: 16px;">This defect requires your attention.</p>'

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: ${priorityColor}; color: ${defect.priority <= 2 ? '#fff' : '#333'}; padding: 20px; border-radius: 8px 8px 0 0; }
          .content { background: #f9f9f9; padding: 20px; border-radius: 0 0 8px 8px; }
          .field { margin: 15px 0; }
          .label { font-weight: bold; color: #555; }
          .value { margin-top: 5px; }
          .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #ddd; font-size: 12px; color: #666; }
          .button { display: inline-block; background: #007aff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">New Defect Reported</h1>
          </div>
          <div class="content">
            ${urgencyText}
            
            <div class="field">
              <div class="label">Priority:</div>
              <div class="value" style="color: ${priorityColor}; font-weight: bold; font-size: 18px;">${priorityLabel} (Priority ${defect.priority})</div>
            </div>

            <div class="field">
              <div class="label">Asset:</div>
              <div class="value">${defect.asset}</div>
            </div>

            <div class="field">
              <div class="label">Title:</div>
              <div class="value"><strong>${defect.title}</strong></div>
            </div>

            <div class="field">
              <div class="label">Description:</div>
              <div class="value">${defect.description}</div>
            </div>

            <div class="field">
              <div class="label">Category:</div>
              <div class="value">${defect.category}</div>
            </div>

            <div class="field">
              <div class="label">Submitted By:</div>
              <div class="value">${defect.submitted_by}</div>
            </div>

            <div class="field">
              <div class="label">Status:</div>
              <div class="value">${defect.status}</div>
            </div>

            <a href="https://maintenance-admin.vercel.app" class="button">View in Admin Portal</a>

            <div class="footer">
              <p>This is an automated notification from the Maintenance Portal.</p>
              <p>Defect ID: ${defect.id}</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `

    // Send email to all admins using native SMTP
    for (const email of adminEmails) {
      try {
        await sendEmail(email, subject, html)
        console.log(`Email sent to ${email}`)
      } catch (error) {
        console.error(`Failed to send to ${email}:`, error)
      }
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        sent: adminEmails.length, 
        total: adminEmails.length
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )

  } catch (error) {
    console.error('Exception:', error)
    return new Response(
      JSON.stringify({ success: false, error: error.message || 'Unknown error' }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

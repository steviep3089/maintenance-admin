import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createMaintenanceAdminClient } from '../_shared/maintenance_admin_client.ts'
import { enforceMaintenance } from '../_shared/maintenance_guard.ts'
import { getAuthenticatedUser } from '../_shared/user_auth.ts'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!
const GMAIL_USER = Deno.env.get('GMAIL_USER')!
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD')!

// Gmail SMTP function for non-PDF emails (task assignments)
async function sendViaGmail(to: string, subject: string, html: string) {
  console.log('Using Gmail SMTP to send email to:', to)
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
    let response = await readLine(conn)
    console.log('SMTP:', response)
    
    await writeLine(conn, `EHLO maintenance-portal`)
    response = await readLine(conn)
    console.log('SMTP:', response)
    
    await writeLine(conn, `AUTH LOGIN`)
    response = await readLine(conn)
    console.log('SMTP:', response)
    
    const usernameB64 = btoa(GMAIL_USER)
    await writeLine(conn, usernameB64)
    response = await readLine(conn)
    console.log('SMTP:', response)
    
    const passwordB64 = btoa(GMAIL_APP_PASSWORD)
    await writeLine(conn, passwordB64)
    response = await readLine(conn)
    console.log('SMTP:', response)
    
    await writeLine(conn, `MAIL FROM:<${GMAIL_USER}>`)
    response = await readLine(conn)
    console.log('SMTP:', response)
    
    await writeLine(conn, `RCPT TO:<${to}>`)
    response = await readLine(conn)
    console.log('SMTP:', response)
    
    await writeLine(conn, `DATA`)
    response = await readLine(conn)
    console.log('SMTP:', response)
    
    const emailContent = [
      `From: Maintenance Portal <${GMAIL_USER}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      html,
      `.`
    ].join('\r\n')
    
    await conn.write(encoder.encode(emailContent + "\r\n"))
    response = await readLine(conn)
    console.log('SMTP:', response)
    
    await writeLine(conn, `QUIT`)
    response = await readLine(conn)
    console.log('SMTP:', response)
    
    conn.close()
    console.log('Gmail email sent successfully')
    return { success: true }
  } catch (error) {
    conn.close()
    throw error
  }
}

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

const EMAIL_PATTERN = /^[^\s@<>"',;:\\]+@[^\s@<>"',;:\\]+\.[^\s@<>"',;:\\]+$/
const MAX_PDF_BASE64_CHARS = 40_000_000

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

    const { to, subject, html, pdfBase64, filename } = await req.json()

    if (typeof to !== 'string' || !EMAIL_PATTERN.test(to)) {
      throw new Error('A valid recipient email is required')
    }
    // Strip CR/LF so values cannot inject SMTP commands or headers
    const safeSubject = typeof subject === 'string' ? subject.replace(/[\r\n]+/g, ' ').trim() : ''
    if (!safeSubject) {
      throw new Error('Invalid subject')
    }
    if (pdfBase64 && (typeof pdfBase64 !== 'string' || pdfBase64.length > MAX_PDF_BASE64_CHARS)) {
      throw new Error('Invalid or oversized attachment')
    }
    const safeFilename = typeof filename === 'string' ? filename.replace(/[\r\n]+/g, ' ').trim() : undefined

    console.log('Sending email with PDF:', !!pdfBase64)

    // Use Resend for PDF reports (admin only, fast & reliable for attachments)
    // Use Gmail SMTP for non-PDF emails (task assignments to any user)
    if (pdfBase64 && safeFilename) {
      console.log('Using Resend API for PDF report, attachment:', safeFilename, 'Size:', pdfBase64.length)
      
      const emailPayload = {
        from: 'Maintenance Portal <onboarding@resend.dev>',
        to: [to],
        subject: safeSubject,
        html: html || '<p>Please see the attached PDF report.</p>',
        attachments: [{
          filename: safeFilename,
          content: pdfBase64
        }]
      }

      console.log('Calling Resend API...')
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(emailPayload)
      })

      const result = await response.json()
      
      if (!response.ok) {
        console.error('Resend API error:', result)
        throw new Error(result.message || 'Failed to send email via Resend')
      }

      console.log('Email sent successfully via Resend:', result.id)

      return new Response(
        JSON.stringify({ success: true, message: 'Email sent successfully via Resend', id: result.id }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    } else {
      // No PDF, use Gmail SMTP for task assignments
      console.log('Using Gmail SMTP for non-PDF email (task assignment)')
      await sendViaGmail(to, safeSubject, html)
      
      return new Response(
        JSON.stringify({ success: true, message: 'Email sent successfully via Gmail SMTP' }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }
  } catch (error) {
    console.error('Exception:', error)
    return new Response(
      JSON.stringify({ success: false, error: error.message || 'Unknown error' }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  }
})

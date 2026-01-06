import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!
const GMAIL_USER = Deno.env.get('GMAIL_USER')!
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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

serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { to, subject, html, pdfBase64, filename } = await req.json()
    
    console.log('Sending email to:', to, 'with PDF:', !!pdfBase64)

    // Use Resend for PDF reports (admin only, fast & reliable for attachments)
    // Use Gmail SMTP for non-PDF emails (task assignments to any user)
    if (pdfBase64 && filename) {
      console.log('Using Resend API for PDF report, attachment:', filename, 'Size:', pdfBase64.length)
      
      const emailPayload = {
        from: 'Maintenance Portal <onboarding@resend.dev>',
        to: [to],
        subject: subject,
        html: html || '<p>Please see the attached PDF report.</p>',
        attachments: [{
          filename: filename,
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
      await sendViaGmail(to, subject, html)
      
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

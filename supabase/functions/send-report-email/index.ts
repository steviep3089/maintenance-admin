import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GMAIL_USER = Deno.env.get('GMAIL_USER')!
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Simple SMTP with better error handling
async function sendEmail(to: string, subject: string, html: string, attachment?: { filename: string, content: string }) {
  let conn;
  try {
    console.log('Connecting to Gmail SMTP...')
    conn = await Deno.connectTls({
      hostname: "smtp.gmail.com",
      port: 465,
    })

    const encoder = new TextEncoder()
    const decoder = new TextDecoder()
    
    async function readResponse() {
      const buffer = new Uint8Array(4096)
      const n = await conn.read(buffer)
      const response = decoder.decode(buffer.subarray(0, n || 0))
      console.log('SMTP Response:', response.substring(0, 100))
      return response
    }
    
    async function sendCommand(cmd: string) {
      console.log('SMTP Command:', cmd.substring(0, 50))
      await conn.write(encoder.encode(cmd + "\r\n"))
      return await readResponse()
    }
    
    // Server greeting
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
    
    // Build email
    const boundary = "----=_Part_" + Date.now()
    let email = `From: ${GMAIL_USER}\r\n`
    email += `To: ${to}\r\n`
    email += `Subject: ${subject}\r\n`
    email += `MIME-Version: 1.0\r\n`
    email += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n`
    email += `\r\n`
    email += `--${boundary}\r\n`
    email += `Content-Type: text/html; charset=UTF-8\r\n`
    email += `\r\n`
    email += `${html}\r\n`
    
    if (attachment) {
      console.log('Adding attachment, size:', attachment.content.length)
      email += `--${boundary}\r\n`
      email += `Content-Type: application/pdf; name="${attachment.filename}"\r\n`
      email += `Content-Transfer-Encoding: base64\r\n`
      email += `Content-Disposition: attachment; filename="${attachment.filename}"\r\n`
      email += `\r\n`
      email += `${attachment.content}\r\n`
    }
    
    email += `--${boundary}--\r\n`
    email += `.\r\n`
    
    console.log('Sending email data...')
    await conn.write(encoder.encode(email))
    await readResponse()
    
    // QUIT
    await sendCommand(`QUIT`)
    console.log('Email sent successfully')
  } catch (error) {
    console.error('SMTP error:', error)
    throw error
  } finally {
    if (conn) {
      try {
        conn.close()
      } catch (e) {
        console.error('Error closing connection:', e)
      }
    }
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

    const attachment = pdfBase64 && filename ? { filename, content: pdfBase64 } : undefined
    await sendEmail(to, subject, html, attachment)

    return new Response(
      JSON.stringify({ success: true, message: 'Email sent successfully' }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  } catch (error) {
    console.error('Exception:', error)
    return new Response(
      JSON.stringify({ success: false, error: error.message || 'Unknown error' }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  }
})

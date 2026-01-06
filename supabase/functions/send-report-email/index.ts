import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const GMAIL_USER = Deno.env.get('GMAIL_USER')!
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Simple SMTP helper using native Deno
async function sendEmail(to: string, subject: string, html: string, attachment?: { filename: string, content: string }) {
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
    email += `--${boundary}\r\n`
    email += `Content-Type: application/pdf; name="${attachment.filename}"\r\n`
    email += `Content-Transfer-Encoding: base64\r\n`
    email += `Content-Disposition: attachment; filename="${attachment.filename}"\r\n`
    email += `\r\n`
    email += `${attachment.content}\r\n`
  }
  
  email += `--${boundary}--\r\n`
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

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { to, subject, html, pdfBase64, filename } = await req.json()
    
    console.log('Sending email to:', to, 'with PDF:', !!pdfBase64)

    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      throw new Error('Gmail credentials not configured in Supabase secrets')
    }

    // Send email using native SMTP
    const attachment = pdfBase64 && filename ? { filename, content: pdfBase64 } : undefined
    await sendEmail(to, subject, html, attachment)

    console.log('Email sent successfully via Gmail SMTP')

    return new Response(
      JSON.stringify({ success: true, message: 'Email sent successfully' }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  } catch (error) {
    console.error('Exception:', error)
    
    // Return proper error message
    let errorMessage = error.message || 'Unknown error'
    
    // Check for common Gmail SMTP errors
    if (errorMessage.includes('authentication')) {
      errorMessage = 'Gmail authentication failed - check GMAIL_USER and GMAIL_APP_PASSWORD secrets'
    } else if (errorMessage.includes('connection')) {
      errorMessage = 'Failed to connect to Gmail SMTP server'
    }
    
    return new Response(
      JSON.stringify({ success: false, error: errorMessage, details: error.stack }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  }
})

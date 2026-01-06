import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SmtpClient } from "https://deno.land/x/smtp@v0.7.0/mod.ts"

const GMAIL_USER = Deno.env.get('GMAIL_USER')!
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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

    // Connect to Gmail SMTP
    const client = new SmtpClient()
    
    await client.connectTLS({
      hostname: "smtp.gmail.com",
      port: 465,
      username: GMAIL_USER,
      password: GMAIL_APP_PASSWORD,
    })

    console.log('Connected to Gmail SMTP')

    // Prepare email
    const emailContent = {
      from: GMAIL_USER,
      to: to,
      subject: subject,
      content: html || '<p>Please find attached the defect report PDF.</p>',
      html: html || '<p>Please find attached the defect report PDF.</p>',
    }

    // Add PDF attachment if provided
    if (pdfBase64 && filename) {
      console.log('Adding PDF attachment:', filename)
      emailContent.attachments = [
        {
          filename: filename,
          content: pdfBase64,
          encoding: "base64",
          contentType: "application/pdf"
        }
      ]
    }

    // Send email
    await client.send(emailContent)
    await client.close()

    console.log('Email sent successfully via Gmail SMTP')

    return new Response(
      JSON.stringify({ success: true, message: 'Email sent successfully' }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  } catch (error) {
    console.error('Exception:', error)
    return new Response(
      JSON.stringify({ error: error.message || 'Unknown error', stack: error.stack }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  }
})

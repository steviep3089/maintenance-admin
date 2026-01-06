import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SmtpClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts"

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
    console.log('GMAIL_USER:', GMAIL_USER ? 'set' : 'MISSING')
    console.log('GMAIL_APP_PASSWORD:', GMAIL_APP_PASSWORD ? 'set' : 'MISSING')

    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      throw new Error('Gmail credentials not configured in Supabase secrets')
    }

    // Connect to Gmail SMTP
    const client = new SmtpClient()
    
    console.log('Attempting to connect to Gmail SMTP...')
    
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

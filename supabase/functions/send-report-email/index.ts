import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
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

    const emailBody: Record<string, any> = {
      from: 'Maintenance Portal <onboarding@resend.dev>',
      to: [to],
      subject: subject,
      html: html || '<p>Please find attached the defect report PDF.</p>',
    }

    // If PDF attachment provided, add it
    if (pdfBase64 && filename) {
      console.log('Adding PDF attachment:', filename)
      emailBody.attachments = [
        {
          filename: filename,
          content: pdfBase64,
        }
      ]
    }

    console.log('Calling Resend API...')

    // Use Resend API
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify(emailBody),
    })

    const data = await res.json()
    console.log('Resend response status:', res.status)
    console.log('Resend response data:', data)

    if (!res.ok) {
      console.error('Resend error:', data)
      return new Response(
        JSON.stringify({ error: 'Resend API error', details: data }),
        { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    return new Response(
      JSON.stringify({ success: true, data }),
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

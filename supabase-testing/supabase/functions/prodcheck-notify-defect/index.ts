import { verifySignedRequest } from "../_shared/signed_request.ts"
import { runNotificationOnce } from "../_shared/notification_dedup.ts"
import { encodeBodyBase64, encodeSubject } from "../_shared/mime.ts"
import { getDefectNotificationSafety } from "../_shared/notification_safety.ts"
import { findDivisionAdminEmails, parseDivisionId } from "../_shared/defect_recipients.ts"
import { escapeHtml } from "../_shared/html.ts"
import { createNotificationAdminClient } from "../_shared/notification_supabase.ts"
import { getNotificationSigningKey } from "../_shared/notification_signing_key.ts"

const GMAIL_USER = Deno.env.get('GMAIL_USER')!
const GMAIL_APP_PASSWORD = Deno.env.get('GMAIL_APP_PASSWORD')!

async function sendEmail(to: string, subject: string, html: string) {
  if (
    !/^[^\s<>@]+@[^\s<>@]+$/.test(to) ||
    !/^[^\s<>@]+@[^\s<>@]+$/.test(GMAIL_USER) ||
    /[\r\n]/.test(subject)
  ) {
    throw new Error('Invalid notification email header')
  }

  const conn = await Deno.connectTls({
    hostname: "smtp.gmail.com",
    port: 465,
  })

  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  let pending = ''

  async function writeBytes(bytes: Uint8Array) {
    let offset = 0
    while (offset < bytes.length) {
      const count = await conn.write(bytes.subarray(offset))
      if (count === 0) throw new Error('SMTP connection closed')
      offset += count
    }
  }

  async function readResponse(expectedCodes: string[]) {
    const lines: string[] = []
    while (true) {
      const lineEnd = pending.indexOf('\r\n')
      if (lineEnd >= 0) {
        const line = pending.slice(0, lineEnd)
        pending = pending.slice(lineEnd + 2)
        lines.push(line)

        const match = /^(\d{3})([ -])/.exec(line)
        if (!match) throw new Error('Invalid SMTP response')
        if (match[2] === ' ') {
          if (!expectedCodes.includes(match[1])) {
            throw new Error('SMTP command rejected')
          }
          return lines.join('\n')
        }
        continue
      }

      const buffer = new Uint8Array(1024)
      const count = await conn.read(buffer)
      if (count === null || count === 0) throw new Error('SMTP connection closed')
      pending += decoder.decode(buffer.subarray(0, count))
    }
  }

  async function sendCommand(command: string, expectedCodes: string[]) {
    await writeBytes(encoder.encode(`${command}\r\n`))
    return await readResponse(expectedCodes)
  }

  try {
    await readResponse(['220'])
    await sendCommand('EHLO localhost', ['250'])
    await sendCommand('AUTH LOGIN', ['334'])
    await sendCommand(btoa(GMAIL_USER), ['334'])
    await sendCommand(btoa(GMAIL_APP_PASSWORD), ['235'])
    await sendCommand(`MAIL FROM:<${GMAIL_USER}>`, ['250'])
    await sendCommand(`RCPT TO:<${to}>`, ['250', '251'])
    await sendCommand('DATA', ['354'])

    const email = [
      `From: ${GMAIL_USER}`,
      `To: ${to}`,
      `Subject: ${encodeSubject(subject)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeBodyBase64(html),
    ].join('\r\n')

    const dotStuffedEmail = email.replace(/(^|\r\n)\./g, '$1..')
    await writeBytes(encoder.encode(`${dotStuffedEmail}\r\n.\r\n`))
    await readResponse(['250'])
    await sendCommand('QUIT', ['221'])
  } finally {
    conn.close()
  }
}

const SIGNING_KEY = getNotificationSigningKey(
  Deno.env.get('DEFECT_WEBHOOK_SIGNING_KEY'),
  Deno.env.get('DEFECT_WEBHOOK_SECRET'),
)

class EmailDeliveryError extends Error {}

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, x-request-id, x-timestamp, x-signature',
  }

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  // Only the database trigger caller may call this function.
  // Authenticate using an HMAC-SHA256 signed request (no raw secrets in headers).
  if (!SIGNING_KEY) {
    console.error('DEFECT_WEBHOOK_SIGNING_KEY is not configured; rejecting request')
    return new Response(
      JSON.stringify({ success: false, error: 'Service unavailable' }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }

  const auth = await verifySignedRequest(req, {
    signingKey: SIGNING_KEY,
    expectedPathAndQuery: '/functions/v1/prodcheck-notify-defect',
    expectedRuntimePathAndQuery: '/prodcheck-notify-defect',
  })
  if (!auth.ok) {
    const body = await auth.denied.text()
    return new Response(body, {
      status: auth.denied.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }

  let supabase
  try {
    supabase = createNotificationAdminClient()
  } catch {
    console.error('Notification database credentials are not configured')
    return new Response(
      JSON.stringify({ success: false, error: 'Service unavailable' }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    )
  }

  try {
    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(auth.verified.bodyText)
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid request body' }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid request body' }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }
    const defect = parsedBody as Record<string, unknown>
    if (typeof defect.id !== 'string' || defect.id.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid request body' }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    const safety = getDefectNotificationSafety({
      allowDryRun: Deno.env.get('ALLOW_DRY_RUN'),
      defectEmailsEnabled: Deno.env.get('DEFECT_EMAILS_ENABLED'),
    }, defect)
    const processing = await runNotificationOnce(
      supabase,
      'notify-defect',
      auth.verified.requestId,
      async () => {
    // Recipients are the active admins assigned to this defect's division. A defect without a valid division is
    // never sent to all admins; it completes with nothing sent (a retry could not fix a missing division).
    const divisionId = parseDivisionId(defect.division_id)
    if (!divisionId) {
      console.warn('Defect has no valid division; notification skipped')
      return new Response(
        JSON.stringify({ success: true, message: 'No division assigned; notification skipped', sent: 0, total: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const adminEmails = await findDivisionAdminEmails(supabase, divisionId)

    if (adminEmails.length === 0) {
      console.log('No active division admins to notify')
      return new Response(
        JSON.stringify({ success: true, message: 'No eligible recipients', sent: 0, total: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    // Determine urgency based on priority
    const priority = typeof defect.priority === 'number' ? defect.priority : 0
    const isUrgent = priority === 1 || priority === 2
    const priorityLabels: Record<number, string> = {
      1: 'Dangerous',
      2: 'Major',
      3: 'Routine',
      4: 'Minor',
      5: 'Cosmetic',
      6: 'Improvement / Preventative maintenance'
    }
    const priorityLabel = priorityLabels[priority] || 'Unknown'
    const priorityColors: Record<number, string> = {
      1: '#ff4d4d',
      2: '#ff944d',
      3: '#ffd24d',
      4: '#4da6ff',
      5: '#d9d9d9',
      6: '#3cb371'
    }
    const priorityColor = priorityColors[priority] || '#666'

    // Build email subject
    const safeTitleForSubject = String(defect.title ?? '').replace(/[\r\n]+/g, ' ')
    const subject = isUrgent
      ? `🚨 URGENT: ${priorityLabel} Defect Reported - ${safeTitleForSubject}`
      : `📋 New ${priorityLabel} Defect Reported - ${safeTitleForSubject}`

    // Build email body
    const urgencyText = isUrgent
      ? '<p style="color: #ff0000; font-weight: bold; font-size: 18px;">⚠️ This defect requires your URGENT ATTENTION</p>'
      : '<p style="color: #666; font-size: 16px;">This defect requires your attention.</p>'

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: ${priorityColor}; color: ${priority <= 2 ? '#fff' : '#333'}; padding: 20px; border-radius: 8px 8px 0 0; }
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
              <div class="value" style="color: ${priorityColor}; font-weight: bold; font-size: 18px;">${priorityLabel} (Priority ${escapeHtml(defect.priority)})</div>
            </div>

            <div class="field">
              <div class="label">Asset:</div>
              <div class="value">${escapeHtml(defect.asset)}</div>
            </div>

            <div class="field">
              <div class="label">Title:</div>
              <div class="value"><strong>${escapeHtml(defect.title)}</strong></div>
            </div>

            <div class="field">
              <div class="label">Description:</div>
              <div class="value">${escapeHtml(defect.description)}</div>
            </div>

            <div class="field">
              <div class="label">Category:</div>
              <div class="value">${escapeHtml(defect.category)}</div>
            </div>

            <div class="field">
              <div class="label">Submitted By:</div>
              <div class="value">${escapeHtml(defect.submitted_by)}</div>
            </div>

            <div class="field">
              <div class="label">Status:</div>
              <div class="value">${escapeHtml(defect.status)}</div>
            </div>

            <a href="https://maintenance-admin.vercel.app" class="button">View in Admin Portal</a>

            <div class="footer">
              <p>This is an automated notification from the Maintenance Portal.</p>
              <p>Defect ID: ${escapeHtml(defect.id)}</p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `

    if (safety.dryRun) {
      console.warn('Dry run enabled; skipping defect notification emails')
      return new Response(
        JSON.stringify({ success: true, message: 'Dry run: notification skipped', sent: 0, total: adminEmails.length }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    let failedDeliveries = 0
    for (const email of adminEmails) {
      try {
        await sendEmail(email, subject, html)
      } catch {
        failedDeliveries++
      }
    }
    if (failedDeliveries > 0) {
      throw new EmailDeliveryError('One or more notification emails failed')
    }

    return new Response(
      JSON.stringify({ 
        success: true, 
        sent: adminEmails.length, 
        total: adminEmails.length
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
      },
    )

    if (processing.kind === 'duplicate') {
      return new Response(
        JSON.stringify({ success: true, duplicate: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }
    if (processing.kind === 'database-error') {
      console.error('Notification request state could not be updated')
      return new Response(
        JSON.stringify({ success: false, error: 'Service unavailable' }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }
    if (processing.kind === 'processing-error') {
      console.error('Defect notification processing failed')
      return new Response(
        JSON.stringify({
          success: false,
          error: processing.error instanceof EmailDeliveryError
            ? 'Notification delivery failed'
            : 'Notification processing failed',
        }),
        {
          status: processing.error instanceof EmailDeliveryError ? 502 : 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      )
    }
    return processing.value
  } catch (error) {
    console.error('notify-defect request failed')
    return new Response(
      JSON.stringify({ success: false, error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

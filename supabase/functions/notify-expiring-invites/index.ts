import type { SupabaseClient } from "npm:@supabase/supabase-js@2"
import { verifySignedRequest } from "../_shared/signed_request.ts"
import { runNotificationOnce } from "../_shared/notification_dedup.ts"
import { getNotificationSafety } from "../_shared/notification_safety.ts"
import { escapeHtml } from "../_shared/html.ts"
import { createNotificationAdminClient } from "../_shared/notification_supabase.ts"
import { getNotificationSigningKey } from "../_shared/notification_signing_key.ts"

const GMAIL_USER = Deno.env.get("GMAIL_USER")!
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!

const INACTIVITY_TIMEOUT_MS = 60 * 24 * 60 * 60 * 1000
const INACTIVITY_WARNING_DAYS = 10

type DigestUser = {
  id: string
  email?: string | null
  user_metadata?: Record<string, unknown> | null
  invited_at?: string | null
  created_at?: string | null
  last_sign_in_at?: string | null
}

async function sendViaGmail(to: string, subject: string, html: string) {
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
      if (count === 0) throw new Error("SMTP connection closed")
      offset += count
    }
  }

  async function readResponse(expectedCodes: string[]) {
    const lines: string[] = []
    while (true) {
      const lineEnd = pending.indexOf("\r\n")
      if (lineEnd >= 0) {
        const line = pending.slice(0, lineEnd)
        pending = pending.slice(lineEnd + 2)
        lines.push(line)

        const match = /^(\d{3})([ -])/.exec(line)
        if (!match) throw new Error("Invalid SMTP response")
        if (match[2] === " ") {
          if (!expectedCodes.includes(match[1])) {
            throw new Error("SMTP command rejected")
          }
          return lines.join("\n")
        }
        continue
      }

      const buffer = new Uint8Array(1024)
      const count = await conn.read(buffer)
      if (count === null || count === 0) throw new Error("SMTP connection closed")
      pending += decoder.decode(buffer.subarray(0, count))
    }
  }

  async function sendCommand(command: string, expectedCodes: string[]) {
    await writeBytes(encoder.encode(`${command}\r\n`))
    return await readResponse(expectedCodes)
  }

  try {
    await readResponse(["220"])
    await sendCommand("EHLO maintenance-portal", ["250"])
    await sendCommand("AUTH LOGIN", ["334"])
    await sendCommand(btoa(GMAIL_USER), ["334"])
    await sendCommand(btoa(GMAIL_APP_PASSWORD), ["235"])
    await sendCommand(`MAIL FROM:<${GMAIL_USER}>`, ["250"])
    await sendCommand(`RCPT TO:<${to}>`, ["250", "251"])
    await sendCommand("DATA", ["354"])

    const emailContent = [
      `From: Sitebatch Maintenance <${GMAIL_USER}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
    ].join("\r\n")

    const dotStuffedContent = emailContent.replace(/(^|\r\n)\./g, '$1..')
    await writeBytes(encoder.encode(`${dotStuffedContent}\r\n.\r\n`))
    await readResponse(["250"])
    await sendCommand("QUIT", ["221"])
  } finally {
    conn.close()
  }
}

function parseInviteSentAt(user: DigestUser) {
  const metadataDate = user.user_metadata?.invite_sent_at
  const raw =
    (typeof metadataDate === 'string' ? metadataDate : null) ||
    user.invited_at ||
    user.created_at
  if (!raw) return null
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) return null
  return new Date(ms)
}

function parseActivityAnchor(user: DigestUser) {
  const raw = user.last_sign_in_at || user.created_at
  if (!raw) return null
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) return null
  return new Date(ms)
}

function startOfUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0))
}

function endOfUtcDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999))
}

async function deactivateUsers(
  supabase: SupabaseClient,
  users: DigestUser[],
  now: Date,
) {
  for (const user of users) {
    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      ban_duration: "876000h",
      user_metadata: {
        ...(user.user_metadata || {}),
        inactive_due_to_non_usage: true,
        inactive_marked_at: now.toISOString(),
      },
    })
    if (error) throw new Error('User deactivation failed')
  }
}

type DigestRunLog = {
  success: boolean
  reason?: string
  recipients?: string[]
  invitesExpiringToday?: number
  invitesExpiredPending?: number
  inactiveSoon?: number
  deactivated?: number
  error?: string
  details?: Record<string, unknown>
}

async function logDigestRun(supabase: SupabaseClient, log: DigestRunLog) {
  const recipients = log.recipients || []

  const { error } = await supabase.from("invite_digest_runs").insert({
    success: log.success,
    reason: log.reason || null,
    recipients,
    recipients_count: recipients.length,
    invites_expiring_today: log.invitesExpiringToday || 0,
    invites_expired_pending: log.invitesExpiredPending || 0,
    inactive_soon: log.inactiveSoon || 0,
    deactivated: log.deactivated || 0,
    error: log.error || null,
    details: log.details || {},
  })

  if (error) {
    console.error("Failed to write invite digest audit log")
    throw new Error("Digest audit logging failed")
  }
}

const SIGNING_KEY = getNotificationSigningKey(
  Deno.env.get('INVITE_DIGEST_SIGNING_KEY'),
  Deno.env.get('INVITE_DIGEST_SECRET'),
)

Deno.serve(async (req: Request) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, x-request-id, x-timestamp, x-signature",
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    if (!SIGNING_KEY) {
      console.error("INVITE_DIGEST_SIGNING_KEY is not configured; rejecting request")
      return new Response(
        JSON.stringify({ success: false, error: "Service unavailable" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    const auth = await verifySignedRequest(req, {
      signingKey: SIGNING_KEY,
      expectedPathAndQuery: '/functions/v1/notify-expiring-invites',
      expectedRuntimePathAndQuery: '/notify-expiring-invites',
    })
    if (!auth.ok) {
      const body = await auth.denied.text()
      return new Response(body, {
        status: auth.denied.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    let supabase: SupabaseClient
    try {
      supabase = createNotificationAdminClient()
    } catch {
      console.error("Notification database credentials are not configured")
      return new Response(
        JSON.stringify({ success: false, error: "Service unavailable" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    let parsedBody: unknown
    try {
      parsedBody = JSON.parse(auth.verified.bodyText)
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }
    const requestBody = parsedBody as Record<string, unknown>
    if (
      (requestBody.dryRun !== undefined && typeof requestBody.dryRun !== 'boolean') ||
      (requestBody.allowDeactivation !== undefined &&
        typeof requestBody.allowDeactivation !== 'boolean')
    ) {
      return new Response(
        JSON.stringify({ success: false, error: "Invalid request body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    const safety = getNotificationSafety({
      allowDryRun: Deno.env.get('ALLOW_DRY_RUN'),
      notificationsDryRun: Deno.env.get('NOTIFICATIONS_DRY_RUN'),
      allowUserDeactivation: Deno.env.get('ALLOW_USER_DEACTIVATION'),
    }, requestBody)
    const processing = await runNotificationOnce(
      supabase,
      'notify-expiring-invites',
      auth.verified.requestId,
      async () => {

    const { data: authData, error: usersError } = await supabase.auth.admin.listUsers()
    if (usersError) {
      throw usersError
    }

    const now = new Date()
    const nowMs = now.getTime()
    const todayStart = startOfUtcDay(now)
    const todayEnd = endOfUtcDay(now)

    const allUsers = authData?.users || []

    const pendingInviteUsers = allUsers.filter((user) => {
      const isLive = user?.user_metadata?.password_set === true || !!user?.last_sign_in_at
      const isInactive = user?.user_metadata?.inactive_due_to_non_usage === true
      if (isLive || isInactive) return false

      return !!parseInviteSentAt(user)
    })

    const inviteExpiringToday = pendingInviteUsers.filter((user) => {
      const inviteSentAt = parseInviteSentAt(user)
      if (!inviteSentAt) return false

      const expiresAt = new Date(inviteSentAt.getTime() + 24 * 60 * 60 * 1000)
      return expiresAt >= todayStart && expiresAt <= todayEnd
    })

    const inviteExpiredPending = pendingInviteUsers.filter((user) => {
      const inviteSentAt = parseInviteSentAt(user)
      if (!inviteSentAt) return false

      const expiresAt = new Date(inviteSentAt.getTime() + 24 * 60 * 60 * 1000)
      return expiresAt < todayStart
    })

    const usersToDeactivate = allUsers.filter((user) => {
      const isAlreadyInactive = user?.user_metadata?.inactive_due_to_non_usage === true
      if (isAlreadyInactive) return false

      const hasActivated = user?.user_metadata?.password_set === true || !!user?.last_sign_in_at
      if (!hasActivated) return false

      const anchor = parseActivityAnchor(user)
      if (!anchor) return false

      return nowMs >= anchor.getTime() + INACTIVITY_TIMEOUT_MS
    })

    if (safety.allowDeactivation) {
      await deactivateUsers(supabase, usersToDeactivate, now)
    }

    if (!safety.allowDeactivation && usersToDeactivate.length > 0) {
      console.warn(
        `Dry run / deactivation disabled; skipping ${usersToDeactivate.length} deactivation(s)`,
      )
    }

    const inactiveSoon = allUsers.filter((user) => {
      const isAlreadyInactive = user?.user_metadata?.inactive_due_to_non_usage === true
      if (isAlreadyInactive) return false

      const hasActivated = user?.user_metadata?.password_set === true || !!user?.last_sign_in_at
      if (!hasActivated) return false

      const anchor = parseActivityAnchor(user)
      if (!anchor) return false

      const inactiveAtMs = anchor.getTime() + INACTIVITY_TIMEOUT_MS
      if (inactiveAtMs <= nowMs) return false

      const daysRemaining = Math.ceil((inactiveAtMs - nowMs) / (24 * 60 * 60 * 1000))
      return daysRemaining <= INACTIVITY_WARNING_DAYS
    })

    if (
      inviteExpiringToday.length === 0 &&
      inviteExpiredPending.length === 0 &&
      inactiveSoon.length === 0 &&
      usersToDeactivate.length === 0
    ) {
      await logDigestRun(supabase, {
        success: true,
        reason: "No relevant users for daily digest",
        recipients: [],
        invitesExpiringToday: 0,
        invitesExpiredPending: 0,
        inactiveSoon: 0,
        deactivated: 0,
      })

      return new Response(
        JSON.stringify({ success: true, notified: 0, reason: "No relevant users for daily digest" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const { data: adminRoleRows, error: adminRoleError } = await supabase
      .from("user_roles")
      .select("user_id")
      .in("role", ["admin", "manager"])

    if (adminRoleError) {
      throw adminRoleError
    }

    const adminUserIdSet = new Set((adminRoleRows || []).map((r) => r.user_id))
    const adminEmails = (authData?.users || [])
      .filter((user) => adminUserIdSet.has(user.id) && user.email)
      .map((user) => user.email)
      .filter((email): email is string => typeof email === 'string')

    if (adminEmails.length === 0) {
      await logDigestRun(supabase, {
        success: true,
        reason: "No admin recipients found",
        recipients: [],
        invitesExpiringToday: inviteExpiringToday.length,
        invitesExpiredPending: inviteExpiredPending.length,
        inactiveSoon: inactiveSoon.length,
        deactivated: usersToDeactivate.length,
      })

      return new Response(
        JSON.stringify({ success: true, notified: 0, reason: "No admin recipients found" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      )
    }

    const inviteListItems = inviteExpiringToday
      .map((user) => {
        const inviteSentAt = parseInviteSentAt(user)
        const expiresAt = inviteSentAt
          ? new Date(inviteSentAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
          : "Unknown"
        return `<li><strong>${escapeHtml(user.email)}</strong> - expires: ${expiresAt}</li>`
      })
      .join("")

    const inviteExpiredItems = inviteExpiredPending
      .map((user) => {
        const inviteSentAt = parseInviteSentAt(user)
        const expiredAt = inviteSentAt
          ? new Date(inviteSentAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
          : "Unknown"
        return `<li><strong>${escapeHtml(user.email)}</strong> - expired: ${expiredAt}</li>`
      })
      .join("")

    const inactiveSoonItems = inactiveSoon
      .map((user) => {
        const anchor = parseActivityAnchor(user)
        const inactiveAt = anchor
          ? new Date(anchor.getTime() + INACTIVITY_TIMEOUT_MS).toISOString()
          : "Unknown"
        const daysRemaining = anchor
          ? Math.ceil((new Date(inactiveAt).getTime() - nowMs) / (24 * 60 * 60 * 1000))
          : "Unknown"
        return `<li><strong>${escapeHtml(user.email)}</strong> - inactive at: ${inactiveAt} (${daysRemaining} day(s) remaining)</li>`
      })
      .join("")

    const deactivatedItems = usersToDeactivate
      .map((user) => {
        const anchor = parseActivityAnchor(user)
        const inactiveAt = anchor
          ? new Date(anchor.getTime() + INACTIVITY_TIMEOUT_MS).toISOString()
          : now.toISOString()
        return `<li><strong>${escapeHtml(user.email)}</strong> - deactivated at: ${inactiveAt}</li>`
      })
      .join("")

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h2>Daily User Status Digest</h2>
        ${inviteExpiringToday.length > 0 ? `<h3>Invites expiring today</h3><ul>${inviteListItems}</ul>` : ""}
        ${inviteExpiredPending.length > 0 ? `<h3>Invites expired and still pending setup</h3><ul>${inviteExpiredItems}</ul>` : ""}
        ${inactiveSoon.length > 0 ? `<h3>Users becoming inactive within 10 days</h3><ul>${inactiveSoonItems}</ul>` : ""}
        ${usersToDeactivate.length > 0 ? `<h3>Users deactivated for 60-day inactivity</h3><ul>${deactivatedItems}</ul>` : ""}
        <p>If a user still needs access, use portal controls to re-invite or re-activate as needed.</p>
      </div>
    `

    if (safety.dryRun) {
      console.warn('Dry run enabled; skipping digest emails')
    } else {
      await Promise.all(
        adminEmails.map((email) =>
          sendViaGmail(email, "Invite expiry reminder", html)
        )
      )
    }

    await logDigestRun(supabase, {
      success: true,
      reason: safety.dryRun ? "Dry run: digest suppressed" : "Digest email sent",
      recipients: safety.dryRun ? [] : adminEmails,
      invitesExpiringToday: inviteExpiringToday.length,
      invitesExpiredPending: inviteExpiredPending.length,
      inactiveSoon: inactiveSoon.length,
      deactivated: safety.allowDeactivation ? usersToDeactivate.length : 0,
      details: {
        dryRun: safety.dryRun,
        deactivationEnabled: safety.allowDeactivation,
        wouldDeactivate: usersToDeactivate.length,
      },
    })

    return new Response(
      JSON.stringify({
        success: true,
        recipients: adminEmails.length,
        invitesExpiringToday: inviteExpiringToday.length,
        invitesExpiredPending: inviteExpiredPending.length,
        inactiveSoon: inactiveSoon.length,
        deactivated: safety.allowDeactivation ? usersToDeactivate.length : 0,
        dryRun: safety.dryRun,
        deactivationEnabled: safety.allowDeactivation,
        wouldDeactivate: usersToDeactivate.length,
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
      console.error("Notification request state could not be updated")
      return new Response(
        JSON.stringify({ success: false, error: "Service unavailable" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }
    if (processing.kind === 'processing-error') {
      console.error("Invite digest processing failed")
      await logDigestRun(supabase, {
        success: false,
        reason: "Function execution failed",
        recipients: [],
        error: "Notification processing failed",
      })
      return new Response(
        JSON.stringify({ success: false, error: "Notification processing failed" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    return processing.value
  } catch {
    console.error("notify-expiring-invites request failed")
    return new Response(
      JSON.stringify({ success: false, error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

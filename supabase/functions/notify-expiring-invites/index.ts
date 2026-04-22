import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const GMAIL_USER = Deno.env.get("GMAIL_USER")!
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!

const INACTIVITY_TIMEOUT_MS = 60 * 24 * 60 * 60 * 1000
const INACTIVITY_WARNING_DAYS = 10

async function sendViaGmail(to: string, subject: string, html: string) {
  const conn = await Deno.connectTls({
    hostname: "smtp.gmail.com",
    port: 465,
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
    await readLine(conn)
    await writeLine(conn, "EHLO maintenance-portal")
    await readLine(conn)
    await writeLine(conn, "AUTH LOGIN")
    await readLine(conn)
    await writeLine(conn, btoa(GMAIL_USER))
    await readLine(conn)
    await writeLine(conn, btoa(GMAIL_APP_PASSWORD))
    await readLine(conn)
    await writeLine(conn, `MAIL FROM:<${GMAIL_USER}>`)
    await readLine(conn)
    await writeLine(conn, `RCPT TO:<${to}>`)
    await readLine(conn)
    await writeLine(conn, "DATA")
    await readLine(conn)

    const emailContent = [
      `From: Sitebatch Maintenance <${GMAIL_USER}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      ".",
    ].join("\r\n")

    await conn.write(encoder.encode(emailContent + "\r\n"))
    await readLine(conn)

    await writeLine(conn, "QUIT")
    await readLine(conn)

    conn.close()
  } catch (error) {
    conn.close()
    throw error
  }
}

function parseInviteSentAt(user: any) {
  const raw = user?.user_metadata?.invite_sent_at || user?.invited_at || user?.created_at
  if (!raw) return null
  const ms = Date.parse(raw)
  if (Number.isNaN(ms)) return null
  return new Date(ms)
}

function parseActivityAnchor(user: any) {
  const raw = user?.last_sign_in_at || user?.created_at
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

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return "Unknown error"
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

async function logDigestRun(supabase: ReturnType<typeof createClient>, log: DigestRunLog) {
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
    console.error("Failed to write invite digest audit log:", error)
  }
}

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  let supabase: ReturnType<typeof createClient> | null = null

  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

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

    for (const user of usersToDeactivate) {
      await supabase.auth.admin.updateUserById(user.id, {
        ban_duration: "876000h",
        user_metadata: {
          ...(user.user_metadata || {}),
          inactive_due_to_non_usage: true,
          inactive_marked_at: now.toISOString(),
        },
      })
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
        return `<li><strong>${user.email}</strong> - expires: ${expiresAt}</li>`
      })
      .join("")

    const inviteExpiredItems = inviteExpiredPending
      .map((user) => {
        const inviteSentAt = parseInviteSentAt(user)
        const expiredAt = inviteSentAt
          ? new Date(inviteSentAt.getTime() + 24 * 60 * 60 * 1000).toISOString()
          : "Unknown"
        return `<li><strong>${user.email}</strong> - expired: ${expiredAt}</li>`
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
        return `<li><strong>${user.email}</strong> - inactive at: ${inactiveAt} (${daysRemaining} day(s) remaining)</li>`
      })
      .join("")

    const deactivatedItems = usersToDeactivate
      .map((user) => {
        const anchor = parseActivityAnchor(user)
        const inactiveAt = anchor
          ? new Date(anchor.getTime() + INACTIVITY_TIMEOUT_MS).toISOString()
          : now.toISOString()
        return `<li><strong>${user.email}</strong> - deactivated at: ${inactiveAt}</li>`
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

    await Promise.all(
      adminEmails.map((email) =>
        sendViaGmail(email, "Invite expiry reminder", html)
      )
    )

    await logDigestRun(supabase, {
      success: true,
      reason: "Digest email sent",
      recipients: adminEmails,
      invitesExpiringToday: inviteExpiringToday.length,
      invitesExpiredPending: inviteExpiredPending.length,
      inactiveSoon: inactiveSoon.length,
      deactivated: usersToDeactivate.length,
    })

    return new Response(
      JSON.stringify({
        success: true,
        recipients: adminEmails.length,
        invitesExpiringToday: inviteExpiringToday.length,
        invitesExpiredPending: inviteExpiredPending.length,
        inactiveSoon: inactiveSoon.length,
        deactivated: usersToDeactivate.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("notify-expiring-invites exception:", error)

    if (supabase) {
      await logDigestRun(supabase, {
        success: false,
        reason: "Function execution failed",
        recipients: [],
        error: getErrorMessage(error),
      })
    }

    return new Response(
      JSON.stringify({ success: false, error: getErrorMessage(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

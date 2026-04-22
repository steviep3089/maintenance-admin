import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
const GMAIL_USER = Deno.env.get("GMAIL_USER")!
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD")!

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

serve(async (req) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  }

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    const { userId, redirectTo } = await req.json()

    if (!userId) {
      throw new Error("userId is required")
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })

    const { data: userData, error: getUserError } = await supabase.auth.admin.getUserById(userId)

    if (getUserError) {
      throw getUserError
    }

    const user = userData?.user
    if (!user?.email) {
      throw new Error("User not found or missing email")
    }

    const alreadyLive = user?.user_metadata?.password_set === true || !!user?.last_sign_in_at
    if (alreadyLive) {
      throw new Error("User is already live; resend invite is not needed")
    }

    const { data: roleData } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", userId)
      .maybeSingle()

    const role = roleData?.role || "user"
    const inviteSentAt = new Date().toISOString()

    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: "invite",
      email: user.email,
      options: {
        redirectTo,
        data: {
          invited: true,
          password_set: false,
          invite_sent_at: inviteSentAt,
          inactive_due_to_non_usage: false,
          inactive_marked_at: null,
          role,
        },
      },
    })

    if (linkError) {
      throw linkError
    }

    if (!linkData?.properties?.action_link) {
      throw new Error("Invite link not generated")
    }

    await supabase.auth.admin.updateUserById(userId, {
      user_metadata: {
        ...(user.user_metadata || {}),
        invited: true,
        password_set: false,
        invite_sent_at: inviteSentAt,
        inactive_due_to_non_usage: false,
        inactive_marked_at: null,
        role,
      },
    })

    const actionLinkUrl = new URL(linkData.properties.action_link)
    if (redirectTo) {
      actionLinkUrl.searchParams.set("redirect_to", redirectTo)
    }
    const actionLink = actionLinkUrl.toString()

    const isAdmin = role === "admin" || role === "manager"
    const subject = isAdmin
      ? "Maintenance Portal invite reminder"
      : "Maintenance App invite reminder"
    const heading = isAdmin
      ? "Your admin portal invite has been re-sent"
      : "Your app invite has been re-sent"

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5;">
        <h2>${heading}</h2>
        <p>Please click the button below to set your password and continue:</p>
        <p>
          <a href="${actionLink}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">
            Set your password
          </a>
        </p>
        <p><strong>This link expires after 24 hours.</strong></p>
        <p>If the button does not work, copy and paste this link into your browser:</p>
        <p>${actionLink}</p>
      </div>
    `

    await sendViaGmail(user.email, subject, html)

    return new Response(
      JSON.stringify({ success: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  } catch (error) {
    console.error("resend-invite exception:", error)
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message || "Unknown error",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    )
  }
})

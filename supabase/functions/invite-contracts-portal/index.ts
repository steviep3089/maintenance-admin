import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GMAIL_USER = Deno.env.get("GMAIL_USER") || "";
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD") || "";

const CONTRACTS_SUPABASE_URL = Deno.env.get("CONTRACTS_SUPABASE_URL") || "";
const CONTRACTS_SERVICE_ROLE_KEY = Deno.env.get("CONTRACTS_SERVICE_ROLE_KEY") || "";
const CONTRACTS_INVITE_REDIRECT_TO = Deno.env.get("CONTRACTS_INVITE_REDIRECT_TO") || undefined;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sendViaGmail(to: string, subject: string, html: string) {
  const conn = await Deno.connectTls({
    hostname: "smtp.gmail.com",
    port: 465,
  });

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function readLine(conn: Deno.TlsConn): Promise<string> {
    const buf = new Uint8Array(1024);
    const n = await conn.read(buf);
    if (!n) return "";
    return decoder.decode(buf.subarray(0, n)).trim();
  }

  async function writeLine(conn: Deno.TlsConn, line: string) {
    await conn.write(encoder.encode(line + "\r\n"));
  }

  try {
    await readLine(conn);
    await writeLine(conn, "EHLO maintenance-admin");
    await readLine(conn);

    await writeLine(conn, "AUTH LOGIN");
    await readLine(conn);

    await writeLine(conn, btoa(GMAIL_USER));
    await readLine(conn);

    await writeLine(conn, btoa(GMAIL_APP_PASSWORD));
    await readLine(conn);

    await writeLine(conn, `MAIL FROM:<${GMAIL_USER}>`);
    await readLine(conn);

    await writeLine(conn, `RCPT TO:<${to}>`);
    await readLine(conn);

    await writeLine(conn, "DATA");
    await readLine(conn);

    const emailContent = [
      `From: Sitebatch Maintenance <${GMAIL_USER}>`,
      `To: ${to}`,
      `Subject: ${subject}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      html,
      ".",
    ].join("\r\n");

    await conn.write(encoder.encode(emailContent + "\r\n"));
    await readLine(conn);

    await writeLine(conn, "QUIT");
    await readLine(conn);
    conn.close();
  } catch (error) {
    conn.close();
    throw error;
  }
}

function mapAuthorityToRole(authority: string | null | undefined) {
  return String(authority || "").toLowerCase() === "admin" ? "admin" : "viewer";
}

function buildPersonKey(email: string | null, fallback: string) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (normalizedEmail) return `email:${normalizedEmail}`;
  return fallback;
}

async function getUserRole(supabase: any, userId: string) {
  const { data, error } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Role lookup failed: ${error.message}`);
  }

  return String(data?.role || "user").toLowerCase();
}

async function listAllAuthUsersByEmailMap(url: string, serviceRoleKey: string) {
  const map = new Map<string, any>();
  let page = 1;

  while (true) {
    const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=1000`, {
      method: "GET",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed reading contracts auth users (${res.status}): ${text}`);
    }

    const json = await res.json();
    const users = Array.isArray(json?.users) ? json.users : [];

    users.forEach((u: any) => {
      const email = String(u?.email || "").trim().toLowerCase();
      if (email) {
        map.set(email, u);
      }
    });

    if (users.length < 1000) {
      break;
    }
    page += 1;
  }

  return map;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!CONTRACTS_SUPABASE_URL || !CONTRACTS_SERVICE_ROLE_KEY) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "Missing contracts env vars. Set CONTRACTS_SUPABASE_URL and CONTRACTS_SERVICE_ROLE_KEY.",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : "";

    if (!token) {
      return new Response(
        JSON.stringify({ success: false, error: "Missing bearer token." }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json().catch(() => ({}));
    const email = String(body?.email || "").trim().toLowerCase();
    const displayName = String(body?.displayName || "").trim();
    const phone = body?.phone ? String(body.phone).trim() : null;
    const authority = String(body?.authority || "user").toLowerCase() === "admin" ? "admin" : "user";
    const regions = Array.isArray(body?.regions)
      ? body.regions.map((r: unknown) => String(r).trim()).filter(Boolean)
      : [];

    if (!email) {
      return new Response(
        JSON.stringify({ success: false, error: "Email is required." }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const maintenanceAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const {
      data: { user: caller },
      error: callerError,
    } = await maintenanceAdmin.auth.getUser(token);

    if (callerError || !caller?.id) {
      return new Response(
        JSON.stringify({ success: false, error: `Unauthorized: ${callerError?.message || "invalid token"}` }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const callerRole = await getUserRole(maintenanceAdmin, caller.id);
    if (![("admin"), ("manager")].includes(callerRole)) {
      return new Response(
        JSON.stringify({ success: false, error: `Forbidden: admin or manager required. Current role: ${callerRole}.` }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const contractsAdmin = createClient(CONTRACTS_SUPABASE_URL, CONTRACTS_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const contractsUsersByEmail = await listAllAuthUsersByEmailMap(
      CONTRACTS_SUPABASE_URL,
      CONTRACTS_SERVICE_ROLE_KEY
    );

    const existing = contractsUsersByEmail.get(email);
    let contractsUserId = String(existing?.id || "");
    let invited = false;

    if (!contractsUserId) {
      const canSendCustomEmail = !!(GMAIL_USER && GMAIL_APP_PASSWORD);

      if (canSendCustomEmail) {
        const inviteSentAt = new Date().toISOString();
        const { data: linkData, error: linkError } = await contractsAdmin.auth.admin.generateLink({
          type: "invite",
          email,
          options: {
            redirectTo: CONTRACTS_INVITE_REDIRECT_TO,
            data: {
              display_name: displayName || email,
              authority,
              regions,
              invited: true,
              password_set: false,
              invite_sent_at: inviteSentAt,
            },
          },
        });

        if (linkError) {
          throw new Error(`Invite link generation failed: ${linkError.message}`);
        }

        contractsUserId = String(linkData?.user?.id || "");

        const actionLinkRaw = linkData?.properties?.action_link;
        if (!actionLinkRaw) {
          throw new Error("Invite link was not returned by auth.");
        }

        const actionLinkUrl = new URL(actionLinkRaw);
        if (CONTRACTS_INVITE_REDIRECT_TO) {
          actionLinkUrl.searchParams.set("redirect_to", CONTRACTS_INVITE_REDIRECT_TO);
        }
        const actionLink = actionLinkUrl.toString();

        const subject = "You have been invited to join the Contracts Portal";
        const html = `
          <div style="font-family: Arial, sans-serif; line-height: 1.5;">
            <h2>You have been invited to join the Contracts Portal</h2>
            <p>Please create a password by accepting the invite below.</p>
            <p>
              <a href="${actionLink}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;text-decoration:none;border-radius:6px;">
                Accept the invite
              </a>
            </p>
            <p><strong>This link expires after 24 hours.</strong></p>
            <p>If the button does not work, copy and paste this link into your browser:</p>
            <p>${actionLink}</p>
          </div>
        `;

        await sendViaGmail(email, subject, html);
      } else {
        const { data: inviteData, error: inviteError } = await contractsAdmin.auth.admin.inviteUserByEmail(
          email,
          {
            data: {
              display_name: displayName || email,
              authority,
              regions,
            },
            redirectTo: CONTRACTS_INVITE_REDIRECT_TO,
          }
        );

        if (inviteError) {
          throw new Error(`Invite failed: ${inviteError.message}`);
        }

        contractsUserId = String(inviteData?.user?.id || "");
      }

      invited = true;
    }

    if (!contractsUserId) {
      throw new Error("Could not resolve contracts user id.");
    }

    const upsertErrors: string[] = [];

    const { error: roleError } = await contractsAdmin.from("app_user_roles").upsert(
      {
        user_id: contractsUserId,
        role: mapAuthorityToRole(authority),
      },
      { onConflict: "user_id" }
    );
    if (roleError) upsertErrors.push(`app_user_roles: ${roleError.message}`);

    const { error: profileError } = await contractsAdmin.from("user_profiles").upsert(
      {
        user_id: contractsUserId,
        full_name: displayName || null,
        email,
        phone,
        authority,
        regions,
        source_project: "maintenance-admin",
      },
      { onConflict: "user_id" }
    );
    if (profileError) upsertErrors.push(`user_profiles: ${profileError.message}`);

    const personKey = buildPersonKey(email, `portal:${contractsUserId}`);
    const { error: directoryError } = await contractsAdmin.from("people_directory").upsert(
      {
        person_key: personKey,
        portal_user_id: contractsUserId,
        full_name: displayName || null,
        email,
        phone,
        authority,
        regions,
        source_projects: ["maintenance-admin"],
      },
      { onConflict: "person_key" }
    );
    if (directoryError) upsertErrors.push(`people_directory: ${directoryError.message}`);

    return new Response(
      JSON.stringify({
        success: true,
        email,
        contracts_user_id: contractsUserId,
        invited,
        alreadyLinked: !invited,
        warnings: upsertErrors,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

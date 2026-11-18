import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pb-session",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: { code: "ERR_METHOD_NOT_ALLOWED", message: "POST required." } }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!supabaseUrl || !serviceRoleKey) {
      return jsonResponse({
        ok: false,
        error: { code: "ERR_CONFIG_MISSING", message: "Supabase function environment variables are missing." },
      }, 500);
    }

    const gasWebappUrl = (Deno.env.get("GAS_EMAIL_WEBAPP_URL") || Deno.env.get("GAS_TOKEN_WEBAPP_URL") || "").trim();
    const gasSecret = (Deno.env.get("GAS_EMAIL_SECRET") || Deno.env.get("GAS_SECRET_KEY") || "").trim();
    const gasFromEmail = (Deno.env.get("GAS_FROM_EMAIL") || "pattanabhumi.biology@gmail.com").trim();
    const useGasMailer = Boolean(gasWebappUrl && gasSecret);

    const resendApiKey = (Deno.env.get("RESEND_API_KEY") || "").trim();
    if (!useGasMailer && !resendApiKey) {
      return jsonResponse({
        ok: false,
        error: {
          code: "ERR_MAILER_NOT_CONFIGURED",
          message: "No email delivery provider is configured. Set GAS_EMAIL_WEBAPP_URL and GAS_EMAIL_SECRET (recommended for Gmail) or RESEND_API_KEY in Supabase Dashboard -> Edge Functions -> Secrets.",
        },
      }, 400);
    }

    const body = await req.json().catch(() => ({}));
    const sessionToken = String(body.sessionToken || req.headers.get("x-pb-session") || "").trim();
    const newEmail = String(body.newEmail || "").trim();

    if (!sessionToken) {
      return jsonResponse({
        ok: false,
        error: { code: "ERR_AUTH_REQUIRED", message: "Administrator session token is required." },
      }, 401);
    }

    if (!newEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
      return jsonResponse({
        ok: false,
        error: { code: "ERR_VALIDATION_FAILED", message: "Please provide a valid target email address." },
      }, 400);
    }

    // Validate caller session via SECURITY DEFINER RPC
    const authResp = await fetch(`${supabaseUrl}/rest/v1/rpc/pb_validate_session`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({
        p_session_token: sessionToken,
        p_allowed_roles: ["ADMIN"],
      }),
    });

    const authJson = await authResp.json().catch(() => ({}));
    if (!authResp.ok || !authJson?.ok || !authJson?.data?.userId) {
      return jsonResponse({
        ok: false,
        error: {
          code: authJson?.error?.code || "ERR_FORBIDDEN_ROLE",
          message: authJson?.error?.message || "Valid administrator session required.",
        },
      }, 403);
    }

    const actorUserId = String(authJson.data.userId);
    const actorUsername = String(authJson.data?.user?.username || actorUserId);

    // Cryptographically random 6-digit OTP
    const randBuf = new Uint32Array(1);
    crypto.getRandomValues(randBuf);
    const otpCode = String(100000 + (randBuf[0] % 900000));
    const otpHashHex = await sha256Hex(otpCode);
    const otpId = `otp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const expiresAtUtc = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    const insertResp = await fetch(`${supabaseUrl}/rest/v1/admin_email_otps`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": serviceRoleKey,
        "Authorization": `Bearer ${serviceRoleKey}`,
        "Prefer": "return=minimal",
      },
      body: JSON.stringify({
        otp_id: otpId,
        actor_user_id: actorUserId,
        target_email: newEmail,
        otp_sha256_hex: otpHashHex,
        attempt_count: 0,
        expires_at_utc: expiresAtUtc,
      }),
    });

    if (!insertResp.ok) {
      const errTxt = await insertResp.text();
      return jsonResponse({
        ok: false,
        error: { code: "ERR_INTERNAL", message: `Failed to store verification code: ${errTxt}` },
      }, 500);
    }

    const emailSubject = `Pattanabhumi Biology — Verify Your Administrator Email (${otpCode})`;
    const emailText = `Pattanabhumi Biology\n\nVerify your administrator email change\n\nWe received a request from ${actorUsername} to verify ${newEmail}. Please enter the code below in the browser window where you started this update:\n\n${otpCode}\n\nIf you did not request this verification code, please disregard it. The code will remain active for 10 minutes.\n\n© 2026 Pattanabhumi Biology. All rights reserved.`;
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <body style="margin: 0; padding: 0; background-color: #F4F5F7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #F4F5F7; padding: 36px 16px;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; background-color: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 16px; overflow: hidden;">
                <tr>
                  <td align="center" style="padding: 42px 36px 36px 36px;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 24px auto;">
                      <tr>
                        <td style="vertical-align: middle; padding-right: 10px;">
                          <img src="https://hexionx.github.io/ppb-web/assets/logo.webp" alt="Pattanabhumi Biology" width="38" height="38" style="display: block; border-radius: 8px; border: 0;" />
                        </td>
                        <td style="vertical-align: middle; font-size: 20px; font-weight: 700; color: #111827; letter-spacing: -0.02em;">
                          Pattanabhumi Biology
                        </td>
                      </tr>
                    </table>

                    <h1 style="margin: 0 0 14px 0; font-size: 22px; line-height: 1.3; font-weight: 700; color: #111827; text-align: center;">
                      Verify your administrator email
                    </h1>

                    <p style="margin: 0 0 26px 0; font-size: 14px; line-height: 1.6; color: #374151; text-align: center;">
                      We have received a request from <strong>${escapeHtml(actorUsername)}</strong> to verify <strong>${escapeHtml(newEmail)}</strong> with the following code. Please enter it in the browser window where you started editing the administrator account.
                    </p>

                    <div style="margin: 0 auto 24px auto; padding: 24px 20px; background-color: #EEF2F3; border-radius: 10px; text-align: center;">
                      <span style="font-size: 32px; font-weight: 700; letter-spacing: 3px; color: #111827; line-height: 1.2;">${otpCode}</span>
                    </div>

                    <p style="margin: 0 0 28px 0; font-size: 13px; line-height: 1.55; color: #6B7280; text-align: center;">
                      If you did not request this email verification but received this message, please disregard it. The code will remain active for 10 minutes.
                    </p>

                    <div style="border-top: 1px solid #E5E7EB; margin: 0 auto 22px auto; max-width: 440px;"></div>

                    <p style="margin: 0 0 12px 0; font-size: 13px; line-height: 1.5; color: #6B7280; text-align: center;">
                      Pattanabhumi Biology — Private Student &amp; Examination Portal
                    </p>

                    <p style="margin: 0 0 12px 0; font-size: 12px; color: #6B7280; text-align: center;">
                      <a href="https://hexionx.github.io/ppb-web/" style="color: #6B7280; text-decoration: none;">Portal</a>
                      &nbsp;&nbsp;&bull;&nbsp;&nbsp;
                      <a href="mailto:${escapeHtml(gasFromEmail)}" style="color: #6B7280; text-decoration: none;">${escapeHtml(gasFromEmail)}</a>
                    </p>

                    <p style="margin: 0; font-size: 12px; color: #9CA3AF; text-align: center;">
                      &copy; 2026 Pattanabhumi Biology. All rights reserved.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
      </html>
    `;

    let sentFrom = "";
    let providerUsed = "";

    if (useGasMailer) {
      const gasResp = await fetch(gasWebappUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        redirect: "follow",
        body: JSON.stringify({
          secret: gasSecret,
          action: "sendOtpEmail",
          toEmail: newEmail,
          subject: emailSubject,
          htmlBody: emailHtml,
          textBody: emailText,
          fromEmail: gasFromEmail,
          senderName: "Pattanabhumi Biology",
        }),
      });

      const gasRaw = await gasResp.text();
      let gasJson: Record<string, unknown> | null = null;
      try {
        gasJson = JSON.parse(gasRaw);
      } catch (_) {
        gasJson = null;
      }

      if (!gasResp.ok || !gasJson || gasJson.ok !== true) {
        const gasErrMsg =
          (gasJson && typeof gasJson.error === "string" && gasJson.error) ||
          (gasRaw && gasRaw.trim().startsWith("<")
            ? "Google Apps Script returned an HTML login or authorization page instead of JSON. Confirm the Apps Script Web App has latest code deployed, Execute as: Me, and Who has access: Anyone."
            : `Apps Script Gmail relay failed (HTTP ${gasResp.status}).`);
        return jsonResponse({
          ok: false,
          error: {
            code: (gasJson && typeof gasJson.code === "string" && gasJson.code) || "ERR_EMAIL_SEND_FAILED",
            message: gasErrMsg,
          },
        }, 502);
      }

      sentFrom = typeof gasJson.sentFrom === "string" ? gasJson.sentFrom : gasFromEmail;
      providerUsed = "gmail_apps_script";
    } else {
      const fromEmail = (Deno.env.get("RESEND_FROM_EMAIL") || "Pattanabhumi Biology <onboarding@resend.dev>").trim();
      const resendResp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: fromEmail,
          to: [newEmail],
          subject: emailSubject,
          html: emailHtml,
        }),
      });

      if (!resendResp.ok) {
        const resendErr = await resendResp.json().catch(() => ({}));
        return jsonResponse({
          ok: false,
          error: {
            code: "ERR_EMAIL_SEND_FAILED",
            message: `Resend failed to send verification email: ${resendErr?.message || resendResp.statusText}`,
          },
        }, 502);
      }

      sentFrom = fromEmail;
      providerUsed = "resend";
    }

    return jsonResponse({
      ok: true,
      data: {
        sentTo: newEmail,
        sentFrom,
        provider: providerUsed,
        expiresAtUtc,
        expiresInMinutes: 10,
      },
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: {
        code: "ERR_INTERNAL",
        message: err instanceof Error ? err.message : "Unexpected Edge Function error.",
      },
    }, 500);
  }
});

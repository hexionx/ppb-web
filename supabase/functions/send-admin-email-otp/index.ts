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
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </head>
      <body style="margin: 0; padding: 0; background-color: #F4FAF7; font-family: 'Sarabun', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #0F2419;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #F4FAF7; padding: 28px 14px;">
          <tr>
            <td align="center">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 560px; background-color: #FFFFFF; border: 1.5px solid #B7E4C7; border-radius: 20px; overflow: hidden; box-shadow: 0 16px 36px -14px rgba(15, 36, 25, 0.10);">
                <!-- Website Signature Cyan-to-Emerald Top Accent Bar -->
                <tr>
                  <td height="5" style="height: 5px; line-height: 5px; font-size: 0; background-color: #0891B2; background-image: linear-gradient(90deg, #06B6D4 0%, #10B981 100%);">&nbsp;</td>
                </tr>

                <!-- Brand Masthead Header -->
                <tr>
                  <td align="center" style="padding: 24px 28px 18px 28px; background-color: #F0FDFA; background-image: linear-gradient(135deg, #F0FDFA 0%, #ECFDF5 100%); border-bottom: 1px solid #D1FAE5;">
                    <div style="display: inline-block; background-color: #FFFFFF; border: 1.5px solid #B7E4C7; border-radius: 14px; padding: 6px 14px; box-shadow: 0 6px 16px -8px rgba(15, 110, 67, 0.16);">
                      <img src="https://hexionx.github.io/ppb-web/assets/email-logo.png" alt="Pattanabhumi Biology" width="220" height="66" style="display: block; width: 220px; max-width: 100%; height: auto; border: 0;" />
                    </div>
                    <div style="margin-top: 12px;">
                      <span style="display: inline-block; padding: 4px 12px; border-radius: 9999px; background-color: #FFFFFF; border: 1px solid #A5F3FC; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: #0E7490; text-transform: uppercase;">
                        <span style="color: #10B981;">&#9679;&nbsp;</span>Private Student &amp; Examination Portal
                      </span>
                    </div>
                  </td>
                </tr>

                <!-- OTP Body -->
                <tr>
                  <td align="center" style="padding: 28px 32px 26px 32px;">
                    <div style="margin-bottom: 12px;">
                      <span style="display: inline-block; padding: 5px 14px; border-radius: 9999px; font-size: 12px; font-weight: 700; background-color: #ECFEFF; color: #0E7490; border: 1px solid #A5F3FC;">
                        Administrator Verification
                      </span>
                    </div>

                    <h1 style="margin: 0 0 12px 0; font-size: 22px; line-height: 1.35; font-weight: 800; color: #1B4332; text-align: center;">
                      Verify your administrator email
                    </h1>

                    <p style="margin: 0 0 22px 0; font-size: 14.5px; line-height: 1.6; color: #355243; text-align: center;">
                      We have received a request from <strong style="color: #0F2419;">${escapeHtml(actorUsername)}</strong> to verify <strong style="color: #0F2419;">${escapeHtml(newEmail)}</strong> with the following code. Please enter it in the browser window where you started editing the administrator account.
                    </p>

                    <div style="margin: 0 auto 22px auto; padding: 22px 20px; background-color: #F7FCFA; border: 1.5px solid #B7E4C7; border-radius: 14px; text-align: center;">
                      <span style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 34px; font-weight: 800; letter-spacing: 6px; color: #0F2419; line-height: 1.2;">${otpCode}</span>
                    </div>

                    <p style="margin: 0; font-size: 13px; line-height: 1.55; color: #526E5F; text-align: center;">
                      If you did not request this email verification but received this message, please disregard it. The code will remain active for 10 minutes.
                    </p>
                  </td>
                </tr>

                <!-- Website-Matched Footer Strip -->
                <tr>
                  <td align="center" style="padding: 18px 28px 20px 28px; background-color: #F6FBF8; border-top: 1px solid #D5E2DA;">
                    <p style="margin: 0 0 6px 0; font-size: 12.5px; font-weight: 600; color: #355243; text-align: center;">
                      Pattanabhumi Biology &mdash; Biology Tutoring &amp; Learning Portal
                    </p>
                    <p style="margin: 0 0 6px 0; font-size: 12px; color: #526E5F; text-align: center;">
                      <a href="https://hexionx.github.io/ppb-web/" style="color: #0F6E43; font-weight: 700; text-decoration: none;">Open Portal</a>
                      &nbsp;&nbsp;&bull;&nbsp;&nbsp;
                      <a href="mailto:${escapeHtml(gasFromEmail)}" style="color: #0E7490; font-weight: 600; text-decoration: none;">${escapeHtml(gasFromEmail)}</a>
                    </p>
                    <p style="margin: 0; font-size: 11.5px; color: #64748B; text-align: center;">
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

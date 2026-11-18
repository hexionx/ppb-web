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

function formatCategoryBadge(cat: string): { label: string; bg: string; fg: string } {
  const key = String(cat || "GENERAL").toUpperCase();
  if (key === "GRADES") return { label: "Scores & Grades Update", bg: "#DCFCE7", fg: "#166534" };
  if (key === "NEW_COURSE") return { label: "New Course & Content", bg: "#E0F2FE", fg: "#0369A1" };
  if (key === "STUDY_LINK") return { label: "Study Resource Link", bg: "#F3E8FF", fg: "#6B21A8" };
  if (key === "BILLING") return { label: "Tuition & Billing Update", bg: "#FEF3C7", fg: "#92400E" };
  return { label: "School Announcement", bg: "#EEF2F3", fg: "#111827" };
}

function buildAnnouncementEmailHtml(params: {
  recipientName: string;
  title: string;
  category: string;
  bodyText: string;
  linkUrl: string;
  linkLabel: string;
  fromEmail: string;
  schoolName: string;
}): string {
  const badge = formatCategoryBadge(params.category);
  const safeBodyHtml = escapeHtml(params.bodyText).replace(/\r?\n/g, "<br />");
  const hasSafeLink = /^https:\/\//i.test(params.linkUrl);
  const portalUrl = "https://hexionx.github.io/ppb-web/";
  const ctaUrl = hasSafeLink ? params.linkUrl : portalUrl;
  const ctaText = hasSafeLink
    ? params.linkLabel || "Open Resource Link"
    : "Open Student Portal";

  return `
    <!DOCTYPE html>
    <html>
    <body style="margin: 0; padding: 0; background-color: #F4F5F7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #F4F5F7; padding: 32px 16px;">
        <tr>
          <td align="center">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 580px; background-color: #FFFFFF; border: 1px solid #E5E7EB; border-radius: 16px; overflow: hidden;">
              <tr>
                <td style="padding: 36px 32px 30px 32px;">
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 auto 20px auto;">
                    <tr>
                      <td style="vertical-align: middle; padding-right: 10px;">
                        <img src="https://hexionx.github.io/ppb-web/assets/logo.webp" alt="${escapeHtml(params.schoolName)}" width="36" height="36" style="display: block; border-radius: 8px; border: 0;" />
                      </td>
                      <td style="vertical-align: middle; font-size: 19px; font-weight: 700; color: #111827; letter-spacing: -0.02em;">
                        ${escapeHtml(params.schoolName)}
                      </td>
                    </tr>
                  </table>

                  <div style="text-align: center; margin-bottom: 12px;">
                    <span style="display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 700; background-color: ${badge.bg}; color: ${badge.fg};">
                      ${escapeHtml(badge.label)}
                    </span>
                  </div>

                  <h1 style="margin: 0 0 12px 0; font-size: 21px; line-height: 1.35; font-weight: 700; color: #111827; text-align: center;">
                    ${escapeHtml(params.title)}
                  </h1>

                  <p style="margin: 0 0 14px 0; font-size: 14px; line-height: 1.6; color: #374151;">
                    Hello ${escapeHtml(params.recipientName || "Student")},
                  </p>

                  <div style="margin: 0 0 22px 0; padding: 18px 20px; background-color: #F8FAFC; border: 1px solid #E2E8F0; border-radius: 12px; font-size: 14px; line-height: 1.65; color: #1F2937;">
                    ${safeBodyHtml}
                  </div>

                  <div style="text-align: center; margin: 0 0 24px 0;">
                    <a href="${escapeHtml(ctaUrl)}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 12px 24px; background-color: #0D5C75; color: #FFFFFF; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 10px;">
                      ${escapeHtml(ctaText)}
                    </a>
                  </div>

                  <div style="border-top: 1px solid #E5E7EB; margin: 0 auto 18px auto; max-width: 460px;"></div>

                  <p style="margin: 0 0 8px 0; font-size: 12px; color: #6B7280; text-align: center;">
                    ${escapeHtml(params.schoolName)} — Private Student &amp; Examination Portal
                  </p>
                  <p style="margin: 0; font-size: 12px; color: #9CA3AF; text-align: center;">
                    <a href="${portalUrl}" style="color: #6B7280; text-decoration: none;">Portal</a>
                    &nbsp;&nbsp;&bull;&nbsp;&nbsp;
                    <a href="mailto:${escapeHtml(params.fromEmail)}" style="color: #6B7280; text-decoration: none;">${escapeHtml(params.fromEmail)}</a>
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
        error: { code: "ERR_CONFIG_MISSING", message: "Supabase environment variables are missing." },
      }, 500);
    }

    const gasWebappUrl = (Deno.env.get("GAS_EMAIL_WEBAPP_URL") || Deno.env.get("GAS_TOKEN_WEBAPP_URL") || "").trim();
    const gasSecret = (Deno.env.get("GAS_EMAIL_SECRET") || Deno.env.get("GAS_SECRET_KEY") || "").trim();
    const gasFromEmail = (Deno.env.get("GAS_FROM_EMAIL") || "pattanabhumi.biology@gmail.com").trim();
    if (!gasWebappUrl || !gasSecret) {
      return jsonResponse({
        ok: false,
        error: {
          code: "ERR_MAILER_NOT_CONFIGURED",
          message: "Apps Script Gmail secrets (GAS_EMAIL_WEBAPP_URL / GAS_EMAIL_SECRET) are not configured.",
        },
      }, 400);
    }

    const body = await req.json().catch(() => ({}));
    const sessionToken = String(body.sessionToken || req.headers.get("x-pb-session") || "").trim();
    if (!sessionToken) {
      return jsonResponse({
        ok: false,
        error: { code: "ERR_AUTH_REQUIRED", message: "Administrator session token is required." },
      }, 401);
    }

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

    const announcementId = String(body.announcementId || "").trim();
    const title = String(body.title || "").trim();
    const category = String(body.category || "GENERAL").trim().toUpperCase();
    const bodyText = String(body.bodyText || "").trim();
    const linkUrl = String(body.linkUrl || "").trim();
    const linkLabel = String(body.linkLabel || "").trim();
    const schoolName = String(body.schoolName || "Pattanabhumi Biology").trim() || "Pattanabhumi Biology";
    const recipientUserIds: string[] = Array.isArray(body.recipientUserIds)
      ? Array.from(new Set(body.recipientUserIds.map((x: unknown) => String(x || "").trim()).filter(Boolean)))
      : [];

    if (!title || !bodyText || recipientUserIds.length === 0) {
      return jsonResponse({
        ok: false,
        error: { code: "ERR_VALIDATION_FAILED", message: "Title, message body, and recipientUserIds are required." },
      }, 400);
    }

    const inList = recipientUserIds.map((id) => `"${id.replace(/"/g, "")}"`).join(",");
    const usersResp = await fetch(
      `${supabaseUrl}/rest/v1/users?select=user_id,full_name,username_display,email,status&user_id=in.(${encodeURIComponent(inList)})`,
      {
        headers: {
          "apikey": serviceRoleKey,
          "Authorization": `Bearer ${serviceRoleKey}`,
        },
      },
    );
    const userRows: Array<Record<string, unknown>> = usersResp.ok ? await usersResp.json().catch(() => []) : [];
    const badge = formatCategoryBadge(category);
    const subject = `[${schoolName}] ${badge.label}: ${title}`.slice(0, 180);

    let sentCount = 0;
    let skippedNoEmailCount = 0;
    let failedCount = 0;
    const failures: Array<{ userId: string; email: string; reason: string }> = [];
    let actualSentFrom = gasFromEmail;

    const sendTargets: Array<{ userId: string; fullName: string; email: string }> = [];
    for (const u of userRows) {
      if (String(u.status || "") !== "ACTIVE") continue;
      const uid = String(u.user_id || "");
      const email = String(u.email || "").trim();
      const fullName = String(u.full_name || u.username_display || "Student").trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /\.(example|invalid)$/i.test(email)) {
        skippedNoEmailCount += 1;
        continue;
      }
      sendTargets.push({ userId: uid, fullName, email });
    }

    const chunkSize = 4;
    for (let i = 0; i < sendTargets.length; i += chunkSize) {
      const chunk = sendTargets.slice(i, i + chunkSize);
      await Promise.all(
        chunk.map(async (target) => {
          const textBody = `${schoolName} (${badge.label})\n\n${title}\n\nHello ${target.fullName},\n\n${bodyText}${linkUrl ? `\n\nLink: ${linkUrl}` : ""}\n\nPortal: https://hexionx.github.io/ppb-web/`;
          const htmlBody = buildAnnouncementEmailHtml({
            recipientName: target.fullName,
            title,
            category,
            bodyText,
            linkUrl,
            linkLabel,
            fromEmail: gasFromEmail,
            schoolName,
          });
          try {
            const gasResp = await fetch(gasWebappUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              redirect: "follow",
              body: JSON.stringify({
                secret: gasSecret,
                action: "sendOtpEmail",
                toEmail: target.email,
                subject,
                htmlBody,
                textBody,
                fromEmail: gasFromEmail,
                senderName: schoolName,
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
              failedCount += 1;
              failures.push({
                userId: target.userId,
                email: target.email,
                reason: (gasJson && typeof gasJson.error === "string" && gasJson.error) || `HTTP ${gasResp.status}`,
              });
            } else {
              sentCount += 1;
              if (typeof gasJson.sentFrom === "string" && gasJson.sentFrom) {
                actualSentFrom = gasJson.sentFrom;
              }
            }
          } catch (sendErr) {
            failedCount += 1;
            failures.push({
              userId: target.userId,
              email: target.email,
              reason: sendErr instanceof Error ? sendErr.message : "Network error",
            });
          }
        }),
      );
    }

    const summary = {
      status: sentCount > 0 && failedCount === 0
        ? "SENT"
        : sentCount > 0 && failedCount > 0
        ? "PARTIAL"
        : sendTargets.length === 0
        ? "SKIPPED_NO_VALID_EMAIL"
        : "FAILED",
      sentFrom: actualSentFrom,
      provider: "gmail_apps_script",
      totalSelected: recipientUserIds.length,
      targetedWithEmail: sendTargets.length,
      sentCount,
      skippedNoEmailCount,
      failedCount,
      failures: failures.slice(0, 10),
    };

    if (announcementId) {
      await fetch(
        `${supabaseUrl}/rest/v1/portal_announcements?announcement_id=eq.${encodeURIComponent(announcementId)}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "apikey": serviceRoleKey,
            "Authorization": `Bearer ${serviceRoleKey}`,
            "Prefer": "return=minimal",
          },
          body: JSON.stringify({ email_delivery_summary_json: summary }),
        },
      ).catch(() => {});
    }

    return jsonResponse({ ok: true, data: summary });
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

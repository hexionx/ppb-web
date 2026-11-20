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

function formatCategoryBadge(cat: string): { label: string; bg: string; fg: string; border: string } {
  const key = String(cat || "GENERAL").toUpperCase();
  if (key === "GRADES") return { label: "Scores & Grades Update", bg: "#E6F6EC", fg: "#0D6832", border: "#86EFAC" };
  if (key === "NEW_COURSE") return { label: "New Course & Content", bg: "#ECFEFF", fg: "#0E7490", border: "#A5F3FC" };
  if (key === "STUDY_LINK") return { label: "Study Resource Link", bg: "#F3E8FF", fg: "#6B21A8", border: "#D8B4FE" };
  if (key === "BILLING") return { label: "Tuition & Billing Update", bg: "#FEF4E6", fg: "#8A4B08", border: "#FCD34D" };
  return { label: "School Announcement", bg: "#ECFDF5", fg: "#0F6E43", border: "#A7F3D0" };
}

function resolveAnnouncementActionLink(linkUrl: string, linkLabel: string): { url: string; label: string } {
  const portalUrl = "https://hexionx.github.io/ppb-web/";
  const raw = String(linkUrl || "").trim();
  const isHttps = /^https:\/\//i.test(raw);
  const isPortalHash = /^#\/[a-z0-9/_-]+$/i.test(raw);
  const url = isHttps ? raw : isPortalHash ? `${portalUrl}${raw}` : portalUrl;
  const label = isHttps || isPortalHash
    ? String(linkLabel || "").trim() || (isPortalHash ? "Open Section in Portal" : "Open Resource Link")
    : "Open Student Portal";
  return { url, label };
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
  const portalUrl = "https://hexionx.github.io/ppb-web/";
  const actionLink = resolveAnnouncementActionLink(params.linkUrl, params.linkLabel);
  const logoUrl = "https://hexionx.github.io/ppb-web/assets/email-logo.png";
  const pillSubtitle = params.schoolName && params.schoolName !== "Pattanabhumi Biology"
    ? `${params.schoolName} — Student Portal`
    : "Private Student & Examination Portal";

  return `
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
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 580px; background-color: #FFFFFF; border: 1.5px solid #B7E4C7; border-radius: 20px; overflow: hidden; box-shadow: 0 16px 36px -14px rgba(15, 36, 25, 0.10);">
              <!-- Website Signature Cyan-to-Emerald Top Accent Bar -->
              <tr>
                <td height="5" style="height: 5px; line-height: 5px; font-size: 0; background-color: #0891B2; background-image: linear-gradient(90deg, #06B6D4 0%, #10B981 100%);">&nbsp;</td>
              </tr>

              <!-- Brand Masthead Header (Crisp Official Wordmark on Opaque White Pill) -->
              <tr>
                <td align="center" style="padding: 24px 28px 18px 28px; background-color: #F0FDFA; background-image: linear-gradient(135deg, #F0FDFA 0%, #ECFDF5 100%); border-bottom: 1px solid #D1FAE5;">
                  <div style="display: inline-block; background-color: #FFFFFF; border: 1.5px solid #B7E4C7; border-radius: 14px; padding: 6px 14px; box-shadow: 0 6px 16px -8px rgba(15, 110, 67, 0.16);">
                    <img src="${logoUrl}" alt="${escapeHtml(params.schoolName)}" width="220" height="66" style="display: block; width: 220px; max-width: 100%; height: auto; border: 0;" />
                  </div>
                  <div style="margin-top: 12px;">
                    <span style="display: inline-block; padding: 4px 12px; border-radius: 9999px; background-color: #FFFFFF; border: 1px solid #A5F3FC; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: #0E7490; text-transform: uppercase;">
                      <span style="color: #10B981;">&#9679;&nbsp;</span>${escapeHtml(pillSubtitle)}
                    </span>
                  </div>
                </td>
              </tr>

              <!-- Main Announcement Card Body -->
              <tr>
                <td style="padding: 28px 30px 26px 30px;">
                  <div style="text-align: center; margin-bottom: 12px;">
                    <span style="display: inline-block; padding: 5px 14px; border-radius: 9999px; font-size: 12px; font-weight: 700; background-color: ${badge.bg}; color: ${badge.fg}; border: 1px solid ${badge.border};">
                      ${escapeHtml(badge.label)}
                    </span>
                  </div>

                  <h1 style="margin: 0 0 18px 0; font-size: 22px; line-height: 1.35; font-weight: 800; color: #1B4332; text-align: center;">
                    ${escapeHtml(params.title)}
                  </h1>

                  <p style="margin: 0 0 12px 0; font-size: 15px; font-weight: 600; line-height: 1.6; color: #0F2419;">
                    Hello ${escapeHtml(params.recipientName || "Student")},
                  </p>

                  <div style="margin: 0 0 24px 0; padding: 18px 20px; background-color: #F7FCFA; border: 1.5px solid #B7E4C7; border-radius: 14px; font-size: 14.5px; line-height: 1.65; color: #1E3A2F; word-break: break-word; overflow-wrap: anywhere;">
                    ${safeBodyHtml}
                  </div>

                  <div style="text-align: center; margin: 0 0 6px 0;">
                    <a href="${escapeHtml(actionLink.url)}" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 13px 28px; background-color: #0891B2; background-image: linear-gradient(90deg, #06B6D4 0%, #10B981 100%); color: #FFFFFF; font-size: 14.5px; font-weight: 700; text-decoration: none; border-radius: 9999px; box-shadow: 0 10px 22px -8px rgba(6, 182, 212, 0.42);">
                      ${escapeHtml(actionLink.label)} &nbsp;&rarr;
                    </a>
                  </div>
                </td>
              </tr>

              <!-- Website-Matched Footer Strip -->
              <tr>
                <td align="center" style="padding: 18px 28px 20px 28px; background-color: #F6FBF8; border-top: 1px solid #D5E2DA;">
                  <p style="margin: 0 0 6px 0; font-size: 12.5px; font-weight: 600; color: #355243; text-align: center;">
                    ${escapeHtml(params.schoolName)} &mdash; Biology Tutoring &amp; Learning Portal
                  </p>
                  <p style="margin: 0; font-size: 12px; color: #526E5F; text-align: center;">
                    <a href="${portalUrl}" style="color: #0F6E43; font-weight: 700; text-decoration: none;">Open Portal</a>
                    &nbsp;&nbsp;&bull;&nbsp;&nbsp;
                    <a href="mailto:${escapeHtml(params.fromEmail)}" style="color: #0E7490; font-weight: 600; text-decoration: none;">${escapeHtml(params.fromEmail)}</a>
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
          const resolvedLink = resolveAnnouncementActionLink(linkUrl, linkLabel);
          const textBody = `${schoolName} (${badge.label})\n\n${title}\n\nHello ${target.fullName},\n\n${bodyText}\n\n${resolvedLink.label}: ${resolvedLink.url}`;
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

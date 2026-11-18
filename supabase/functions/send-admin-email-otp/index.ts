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

    const resendApiKey = (Deno.env.get("RESEND_API_KEY") || "").trim();
    if (!resendApiKey) {
      return jsonResponse({
        ok: false,
        error: {
          code: "ERR_RESEND_NOT_CONFIGURED",
          message: "Resend API key is not configured yet. Add RESEND_API_KEY (and optional RESEND_FROM_EMAIL) in Supabase Dashboard -> Edge Functions -> Secrets.",
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
        subject: `Pattanabhumi Biology — Email Verification Code (${otpCode})`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #d1fae5; border-radius: 16px; background: #ffffff;">
            <p style="margin: 0 0 8px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #059669;">Pattanabhumi Biology Portal</p>
            <h2 style="margin: 0 0 12px; font-size: 20px; color: #064e3b;">Verify New Administrator Email</h2>
            <p style="margin: 0 0 18px; font-size: 14px; line-height: 1.55; color: #374151;">
              Administrator <strong>${escapeHtml(actorUsername)}</strong> requested to verify <strong>${escapeHtml(newEmail)}</strong>. Enter this 6-digit verification code in the portal within 10 minutes:
            </p>
            <div style="margin: 0 0 20px; padding: 16px; border-radius: 12px; background: #ecfdf5; border: 1px solid #a7f3d0; text-align: center;">
              <span style="font-size: 32px; font-weight: 800; letter-spacing: 0.25em; color: #065f46;">${otpCode}</span>
            </div>
            <p style="margin: 0; font-size: 12px; color: #6b7280;">If you did not request this email change, you can safely ignore this message.</p>
          </div>
        `,
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

    return jsonResponse({
      ok: true,
      data: {
        sentTo: newEmail,
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

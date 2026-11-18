/**
 * gas-token-provider/Code.gs
 * Standalone Lightweight Google Apps Script OAuth Token Provider & Gmail OTP Mailer
 *
 * Responsibilities:
 *   1. `doGet(e)`: Validate caller `secret` query param and return a short-lived
 *      OAuth 2.0 access token (`ScriptApp.getOAuthToken()`) for direct Google Drive v3 uploads.
 *   2. `doPost(e)`: Validate caller `secret` JSON field (server-to-server from Supabase Edge
 *      Function `send-admin-email-otp`) and send 6-digit verification OTP emails via Gmail
 *      from `pattanabhumi.biology@gmail.com` (either directly if deployed under that account,
 *      or via its verified Gmail "Send mail as" alias).
 *
 * IMPORTANT DEPLOYMENT NOTE:
 *   Run `_authorizeScopesOnce_()` in the Apps Script Editor after updating this file so Google
 *   prompts you to authorize Drive + Gmail permissions before publishing a New Deployment version.
 */

// DriveApp.getRootFolder();
// GmailApp.getAliases();

/**
 * Fallback placeholder secret used ONLY if you have not configured
 * `GAS_SECRET_KEY` in Project Settings -> Script Properties yet.
 * Recommended: Set Script Property `GAS_SECRET_KEY` in the Apps Script UI
 * (Project Settings -> Script Properties) and match it in `docs/js/config.js`
 * and Supabase Edge Function Secret `GAS_EMAIL_SECRET`.
 */
var DEFAULT_FALLBACK_SECRET_ = 'REPLACE_WITH_YOUR_RANDOM_SECRET_KEY';
var DEFAULT_FROM_GMAIL_ = 'pattanabhumi.biology@gmail.com';
var DEFAULT_SENDER_NAME_ = 'Pattanabhumi Biology';

function pbReadConfiguredSecret_() {
  var configuredSecret = '';
  try {
    var props = PropertiesService.getScriptProperties();
    if (props) {
      configuredSecret = String(
        props.getProperty('GAS_EMAIL_SECRET') || props.getProperty('GAS_SECRET_KEY') || ''
      ).trim();
    }
  } catch (ignorePropErr) {
    configuredSecret = '';
  }
  return configuredSecret || DEFAULT_FALLBACK_SECRET_;
}

/**
 * HTTP GET entry point.
 * Called by the browser via simple GET (no custom headers) so Google Apps Script
 * handles CORS automatically across redirect to script.googleusercontent.com:
 *
 *   GET https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?secret=<GAS_SECRET_KEY>
 *
 * Response JSON:
 *   Success: { "ok": true,  "token": "ya29...." }
 *   Denied:  { "ok": false, "error": "Unauthorized: invalid or missing secret." }
 *
 * @param {Object} e Apps Script HTTP GET event object.
 * @return {TextOutput} JSON response.
 */
function doGet(e) {
  var providedSecret = '';
  if (e && e.parameter && typeof e.parameter.secret === 'string') {
    providedSecret = e.parameter.secret.trim();
  }

  var expectedSecret = pbReadConfiguredSecret_();
  if (!expectedSecret || !pbConstantTimeEquals_(providedSecret, expectedSecret)) {
    return pbJsonResponse_({
      ok: false,
      error: 'Unauthorized: invalid or missing secret.'
    });
  }

  try {
    var oauthToken = ScriptApp.getOAuthToken();
    return pbJsonResponse_({
      ok: true,
      token: oauthToken,
      expiresInSeconds: 3000
    });
  } catch (err) {
    return pbJsonResponse_({
      ok: false,
      error: 'Failed to retrieve OAuth token: ' + String(err && err.message ? err.message : err)
    });
  }
}

/**
 * HTTP POST entry point for server-to-server Gmail OTP dispatch.
 * Expected JSON payload:
 *   { secret, action: 'sendOtpEmail', toEmail, subject, htmlBody, textBody, fromEmail, senderName }
 *
 * @param {Object} e Apps Script HTTP POST event object.
 * @return {TextOutput} JSON response.
 */
function doPost(e) {
  var body = {};
  try {
    var rawText = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
    body = rawText ? JSON.parse(rawText) : {};
  } catch (parseErr) {
    return pbJsonResponse_({
      ok: false,
      code: 'ERR_BAD_REQUEST',
      error: 'Invalid JSON request body.'
    });
  }

  var providedSecret = typeof body.secret === 'string' ? body.secret.trim() : '';
  var expectedSecret = pbReadConfiguredSecret_();
  if (!expectedSecret || expectedSecret === DEFAULT_FALLBACK_SECRET_ || !pbConstantTimeEquals_(providedSecret, expectedSecret)) {
    return pbJsonResponse_({
      ok: false,
      code: 'ERR_UNAUTHORIZED',
      error: 'Unauthorized: invalid or missing GAS secret.'
    });
  }

  var action = String(body.action || 'sendOtpEmail').trim();
  if (action !== 'sendOtpEmail') {
    return pbJsonResponse_({
      ok: false,
      code: 'ERR_UNKNOWN_ACTION',
      error: 'Unsupported Apps Script POST action: ' + action
    });
  }

  return pbJsonResponse_(pbSendOtpEmailViaGmail_(body));
}

function pbResolveExecutingAccountEmail_() {
  var eff = '';
  try {
    eff = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  } catch (ignoreEff) {
    eff = '';
  }
  if (eff) return eff;

  try {
    var tok = ScriptApp.getOAuthToken();
    if (tok) {
      var resp = UrlFetchApp.fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: 'Bearer ' + tok },
        muteHttpExceptions: true
      });
      if (resp && resp.getResponseCode() === 200) {
        var info = JSON.parse(resp.getContentText() || '{}');
        if (info && info.email) return String(info.email).trim().toLowerCase();
      }
    }
  } catch (ignoreUserinfo) {}
  return '';
}

function pbSendOtpEmailViaGmail_(payload) {
  var toEmail = String((payload && payload.toEmail) || '').trim();
  if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
    return {
      ok: false,
      code: 'ERR_VALIDATION_FAILED',
      error: 'Invalid recipient email address.'
    };
  }

  var subject = String((payload && payload.subject) || 'Pattanabhumi Biology — Verification Code').trim();
  var htmlBody = String((payload && payload.htmlBody) || '').trim();
  var textBody = String((payload && payload.textBody) || 'Use the 6-digit verification code in the portal.').trim();
  var senderName = String((payload && payload.senderName) || DEFAULT_SENDER_NAME_).trim() || DEFAULT_SENDER_NAME_;
  var preferredFrom = String((payload && payload.fromEmail) || DEFAULT_FROM_GMAIL_).trim().toLowerCase();

  try {
    var sendOpts = { name: senderName };
    if (htmlBody) sendOpts.htmlBody = htmlBody;

    var accountEmail = pbResolveExecutingAccountEmail_();
    var aliases = [];
    try {
      aliases = GmailApp.getAliases() || [];
    } catch (aliasErr) {
      aliases = [];
    }

    var aliasMatch = '';
    for (var i = 0; i < aliases.length; i++) {
      var candidate = String(aliases[i] || '').trim();
      if (candidate.toLowerCase() === preferredFrom) {
        aliasMatch = candidate;
        break;
      }
    }

    var actualSentFrom = accountEmail || preferredFrom;
    if (preferredFrom) {
      if (accountEmail && accountEmail === preferredFrom) {
        // Executing natively under preferredFrom — omit `from` so GmailApp uses primary account.
        actualSentFrom = accountEmail;
      } else if (aliasMatch) {
        sendOpts.from = aliasMatch;
        actualSentFrom = aliasMatch;
      } else {
        return {
          ok: false,
          code: 'ERR_SENDER_ALIAS_REQUIRED',
          error:
            'Apps Script is running as ' +
            (accountEmail || 'another Google account') +
            ' and "' +
            preferredFrom +
            '" is not configured as a verified Gmail Send-As alias. Either deploy this script signed in as ' +
            preferredFrom +
            ', or add "' +
            preferredFrom +
            '" under Gmail -> Settings -> Accounts and Import -> Send mail as.'
        };
      }
    }

    GmailApp.sendEmail(toEmail, subject, textBody, sendOpts);
    return {
      ok: true,
      sentTo: toEmail,
      sentFrom: actualSentFrom,
      provider: 'gmail_apps_script'
    };
  } catch (sendErr) {
    return {
      ok: false,
      code: 'ERR_EMAIL_SEND_FAILED',
      error: 'Apps Script Gmail send failed: ' + String(sendErr && sendErr.message ? sendErr.message : sendErr)
    };
  }
}

/**
 * Run this function manually once inside the Apps Script editor whenever scopes change
 * so Google prompts to authorize Drive + Gmail permissions before deploying.
 */
function _authorizeScopesOnce_() {
  var folderName = DriveApp.getRootFolder().getName();
  var email = pbResolveExecutingAccountEmail_();
  var aliases = GmailApp.getAliases();
  return {
    folderName: folderName,
    executingEmail: email,
    aliases: aliases
  };
}

/**
 * Legacy helper alias preserved for compatibility.
 * @private
 */
function _authorizeDriveScopeOnce_() {
  return _authorizeScopesOnce_();
}

/**
 * Constant-time string comparison to avoid timing leaks on secret validation.
 * @private
 */
function pbConstantTimeEquals_(a, b) {
  var sa = String(a || '');
  var sb = String(b || '');
  var maxLen = Math.max(sa.length, sb.length);
  var diff = sa.length ^ sb.length;
  for (var i = 0; i < maxLen; i++) {
    var ca = i < sa.length ? sa.charCodeAt(i) : 0;
    var cb = i < sb.length ? sb.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return maxLen > 0 && diff === 0;
}

/**
 * Wraps any JS object in a CORS-safe JSON ContentService response.
 * @private
 */
function pbJsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

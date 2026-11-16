/**
 * gas-token-provider/Code.gs
 * Standalone Lightweight Google Apps Script OAuth Token Provider
 *
 * Sole Responsibility:
 *   Validate the caller's `secret` query parameter and return a short-lived
 *   OAuth 2.0 access token (`ScriptApp.getOAuthToken()`) as JSON so the
 *   GitHub Pages frontend can upload compressed images and PDFs directly to the
 *   Google Drive REST API v3 (eliminating Base64 proxying through Apps Script).
 *
 * IMPORTANT DEPLOYMENT NOTE:
 *   Keep the DriveApp reference below so Google prompts you to grant Drive
 *   permissions when you deploy this standalone Apps Script Web App.
 */

// DriveApp.getRootFolder();

/**
 * Fallback placeholder secret used ONLY if you have not configured
 * `GAS_SECRET_KEY` in Project Settings -> Script Properties yet.
 * Recommended: Set Script Property `GAS_SECRET_KEY` in the Apps Script UI
 * (Project Settings -> Script Properties) and match it in `docs/js/config.js`.
 */
var DEFAULT_FALLBACK_SECRET_ = 'REPLACE_WITH_YOUR_RANDOM_SECRET_KEY';

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

  var configuredSecret = '';
  try {
    var props = PropertiesService.getScriptProperties();
    if (props) {
      configuredSecret = String(props.getProperty('GAS_SECRET_KEY') || '').trim();
    }
  } catch (ignorePropErr) {
    configuredSecret = '';
  }

  var expectedSecret = configuredSecret || DEFAULT_FALLBACK_SECRET_;
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
 * Ensures Google's static OAuth analyzer detects Drive usage cleanly during
 * manual deployment authorization if comments alone are stripped by the V8 parser.
 * Never called during `doGet(e)`.
 * @private
 */
function _authorizeDriveScopeOnce_() {
  return DriveApp.getRootFolder().getName();
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

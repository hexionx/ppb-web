/**
 * Api.gs
 * Pattanabhumi Biology LMS - JSON HTTP API entry point for the GitHub Pages frontend.
 *
 * The static frontend (docs/ in the GitHub repo) cannot use google.script.run, so it
 * POSTs the exact same RPC envelope that google.script.run used to pass to
 * rpcDispatch():
 *
 *   POST <web app /exec URL>
 *   Content-Type: text/plain;charset=utf-8
 *   Body: {"action":"...","requestId":"...","sessionToken":"...","payload":{...}}
 *
 * The response body is the unchanged rpcDispatch() envelope serialized as JSON.
 * HTTP status is always 200 (Apps Script cannot set status codes); clients must
 * inspect `ok`.
 *
 * Security notes:
 * - All authentication, authorization, privacy-gate, payload-size and rate-limit
 *   checks remain inside rpcDispatch(); this wrapper adds no privileges.
 * - Apps Script does not expose request headers (e.g. Origin), so the API cannot be
 *   restricted to a specific website. This matches the existing ANYONE_ANONYMOUS
 *   exposure of rpcDispatch via google.script.run.
 * - doGet() is untouched, so the legacy HtmlService UI keeps working in parallel.
 */

var PB_DEFAULT_RESOURCE_IDS_ = Object.freeze({
  SPREADSHEET_ID: '129VTczSBm91aXfpATwEHBlDmCrbZ8zZ8eYgRa3en2mU',
  PRIVATE_DRIVE_FOLDER_ID: '1vtFBqT_vHTBTscK8KQXNZmCU_tf31PZ6'
});

/**
 * Ensures SPREADSHEET_ID and PRIVATE_DRIVE_FOLDER_ID are present in ScriptProperties,
 * seeding the configured defaults above if either key is missing or blank.
 * @private
 */
function pbEnsureDefaultResourceProperties_() {
  try {
    var props = PropertiesService.getScriptProperties();
    if (!props) return;
    var existing = props.getProperties() || {};
    var toSet = {};
    var hasChanges = false;
    var keys = Object.keys(PB_DEFAULT_RESOURCE_IDS_);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var cur = existing[k];
      if (typeof cur !== 'string' || cur.trim().length === 0) {
        toSet[k] = PB_DEFAULT_RESOURCE_IDS_[k];
        hasChanges = true;
      }
    }
    if (hasChanges) {
      props.setProperties(toSet, false);
    }
  } catch (ignorePropErr) {}
}

/**
 * Web App HTTP POST entry point (JSON RPC over HTTP).
 *
 * @param {Object} e Apps Script HTTP POST event object.
 * @return {TextOutput} JSON response.
 */
function doPost(e) {
  pbEnsureDefaultResourceProperties_();
  var envelope;
  try {
    var raw =
      e && e.postData && typeof e.postData.contents === 'string'
        ? e.postData.contents
        : '';
    if (!raw) {
      return pbApiJsonOutput_(
        pbApiErrorEnvelope_('ERR_VALIDATION_FAILED', 'Request body is empty.')
      );
    }
    envelope = JSON.parse(raw);
  } catch (parseErr) {
    return pbApiJsonOutput_(
      pbApiErrorEnvelope_('ERR_VALIDATION_FAILED', 'Request body must be valid JSON.')
    );
  }

  var response;
  try {
    response = rpcDispatch(envelope);
  } catch (dispatchErr) {
    // rpcDispatch already maps exceptions to envelopes; this is a last-resort guard.
    var reqId =
      envelope && typeof envelope === 'object' && typeof envelope.requestId === 'string'
        ? envelope.requestId.slice(0, 64)
        : null;
    var act =
      envelope && typeof envelope === 'object' && typeof envelope.action === 'string'
        ? envelope.action.slice(0, 128)
        : '';
    try {
      console.error('doPost unhandled error: ' + (dispatchErr && dispatchErr.stack ? dispatchErr.stack : dispatchErr));
    } catch (ignoreLogErr) {}
    response = pbApiErrorEnvelope_(
      'ERR_INTERNAL',
      'An unexpected server error occurred.',
      reqId,
      act
    );
  }

  return pbApiJsonOutput_(response);
}

/**
 * Builds a minimal error envelope compatible with the client's rpcCallEnvelope().
 * @private
 */
function pbApiErrorEnvelope_(code, message, opt_requestId, opt_action) {
  return {
    ok: false,
    action: opt_action || '',
    requestId: opt_requestId || null,
    serverTimeUtc: new Date().toISOString(),
    error: {
      code: code,
      message: message,
      fieldErrors: {}
    }
  };
}

/**
 * Serializes a value as an application/json TextOutput.
 * @private
 */
function pbApiJsonOutput_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(
    ContentService.MimeType.JSON
  );
}

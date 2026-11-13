/**
 * AuditService.gs
 * Pattanabhumi Biology Learning Management System - Step 2 Data Foundation
 *
 * Responsibilities:
 * - Provide structured, append-only security and administrative audit event recording.
 * - Redact sensitive keys (passwords, session tokens, secrets, base64 payloads) before
 *   serializing summary metadata into the AuditEvents worksheet.
 *
 * Security Note:
 * - All functions end with an underscore (_) so they cannot be invoked directly from
 *   browser clients via google.script.run.
 */

var PB_SENSITIVE_AUDIT_KEYS_ = Object.freeze([
  'password',
  'newpassword',
  'password_hash',
  'passwordhash',
  'sessiontoken',
  'token',
  'token_sha256_hex',
  'app_master_secret',
  'secret',
  'base64data'
]);

/**
 * Sanitizes an arbitrary metadata object by removing sensitive fields and truncating
 * oversized strings so audit records never leak secrets or exceed cell limits.
 *
 * @param {Object=} opt_metadata Raw summary metadata object.
 * @return {string} Sanitized JSON string (<= 5,000 characters).
 */
function sanitizeAuditSummaryJson_(opt_metadata) {
  if (!opt_metadata || typeof opt_metadata !== 'object') {
    return '{}';
  }

  var clean = {};
  var keys = Object.keys(opt_metadata);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var lowerKey = k.toLowerCase();
    if (PB_SENSITIVE_AUDIT_KEYS_.indexOf(lowerKey) !== -1) {
      clean[k] = '[REDACTED]';
      continue;
    }
    var val = opt_metadata[k];
    if (typeof val === 'string') {
      clean[k] = val.length > 500 ? val.slice(0, 500) + '...[TRUNCATED]' : val;
    } else if (typeof val === 'number' || typeof val === 'boolean' || val === null) {
      clean[k] = val;
    } else if (Array.isArray(val)) {
      clean[k] = val.slice(0, 25);
    } else if (typeof val === 'object') {
      clean[k] = '[OBJECT]';
    }
  }

  var jsonStr = JSON.stringify(clean);
  if (jsonStr.length > 5000) {
    return JSON.stringify({ truncated: true, preview: jsonStr.slice(0, 4800) });
  }
  return jsonStr;
}

/**
 * Appends a validated audit event row to the AuditEvents sheet.
 *
 * @param {Object} params Audit parameters:
 *   - {string} actorUserId User ID or 'SYSTEM' / 'ANONYMOUS'
 *   - {string} actorRole 'STUDENT' | 'ADMIN' | 'ANONYMOUS' | 'SYSTEM'
 *   - {string} eventType Uppercase event identifier (e.g., 'SYSTEM_SETUP_COMPLETED')
 *   - {string} targetEntityType Entity category (e.g., 'System', 'User', 'Course', 'Payment')
 *   - {string=} targetEntityId Primary key of affected entity
 *   - {Object=} summary Plain object with non-sensitive context
 * @param {Spreadsheet=} opt_spreadsheet Optional open Spreadsheet instance.
 * @return {Object} The inserted AuditEvents record.
 */
function recordAuditEvent_(params, opt_spreadsheet) {
  if (!params || typeof params !== 'object') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Audit event parameters must be an object.'
    );
  }

  var resolvedTargetType = String(
    params.targetEntityType || params.targetType || 'System'
  ).trim();
  var resolvedTargetId = String(
    params.targetEntityId || params.targetId || 'SYSTEM'
  ).trim();
  var resolvedSummary =
    params.summary !== undefined
      ? params.summary
      : params.metadata !== undefined
      ? params.metadata
      : {};

  var record = {
    audit_id: generateEntityId_('aud_'),
    actor_user_id: String(params.actorUserId || 'SYSTEM').trim(),
    actor_role: String(params.actorRole || 'SYSTEM').trim(),
    event_type: String(params.eventType || 'UNSPECIFIED_EVENT').trim(),
    target_entity_type: resolvedTargetType || 'System',
    target_entity_id: resolvedTargetId || 'SYSTEM',
    summary_json: sanitizeAuditSummaryJson_(resolvedSummary),
    created_at_utc: nowUtcIso_()
  };

  return insertSheetRecord_('AuditEvents', record, {
    spreadsheet: opt_spreadsheet
  });
}
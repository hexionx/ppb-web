/**
 * RateLimitService.gs
 * Pattanabhumi Biology Learning Management System - Step 4 Authentication
 *
 * Responsibilities:
 * - Enforce persistent server-side login throttling backed by the `LoginAttempts` sheet.
 * - Prevent unbounded `LoginAttempts` table growth from random unknown-username floods:
 *     1. Known users (`userExists === true`) track failures in `login:user:<username_lower>`
 *        (locks that account for 15 minutes after 5 failed attempts).
 *     2. Unknown/nonexistent usernames (`userExists === false`) NEVER create per-username rows;
 *        instead they increment a single bounded row `login:unknown_account_bucket`
 *        (locks unknown-username probes for 15 minutes after 20 failed attempts).
 *     3. All failed login attempts also increment a single bounded row `login:global_bucket`
 *        (locks login attempts globally for 15 minutes after 50 failed attempts in 15 minutes).
 * - Clear per-user failure counters (`login:user:<username_lower>`) upon successful login.
 *
 * Security Note:
 * - Every function in this file ends with an underscore (_) so it cannot be called directly
 *   from browser clients via `google.script.run`.
 */

var PB_RATE_LIMIT_BUCKETS_ = Object.freeze({
  UNKNOWN_ACCOUNT_KEY: 'login:unknown_account_bucket',
  GLOBAL_KEY: 'login:global_bucket',
  USER_KEY_PREFIX: 'login:user:'
});

/**
 * Checks whether a single `LoginAttempts` record is currently locked out at `nowMs`.
 *
 * @param {Object|null} record Stored `LoginAttempts` row or null.
 * @param {number} nowMs Current epoch milliseconds.
 * @return {{ isLocked: boolean, retryAfterSeconds: number }}
 */
function evaluateRateLimitRecordLock_(record, nowMs) {
  if (!record || !record.locked_until_utc) {
    return { isLocked: false, retryAfterSeconds: 0 };
  }
  var lockedUntilMs = Date.parse(record.locked_until_utc);
  if (!isFinite(lockedUntilMs) || lockedUntilMs <= nowMs) {
    return { isLocked: false, retryAfterSeconds: 0 };
  }
  var retrySec = Math.max(1, Math.ceil((lockedUntilMs - nowMs) / 1000));
  return { isLocked: true, retryAfterSeconds: retrySec };
}
/**
 * Asserts that login attempts are not currently rate-limited for the target account
 * (or the unknown-account bucket if the username does not exist) or globally.
 * Must be called BEFORE executing PBKDF2 password verification so locked buckets cannot
 * be used to burn CPU time.
 *
 * @param {string} normalizedUsernameLower Lowercase username.
 * @param {boolean} userExists True if `normalizedUsernameLower` matches a row in `Users`.
 */
function assertLoginNotRateLimited_(normalizedUsernameLower, userExists) {
  var nowMs = Date.now();
  var table = readSheetTable_('LoginAttempts');

  var globalHit = table.byId[PB_RATE_LIMIT_BUCKETS_.GLOBAL_KEY] || null;
  var globalCheck = evaluateRateLimitRecordLock_(
    globalHit ? globalHit.record : null,
    nowMs
  );
  if (globalCheck.isLocked) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_RATE_LIMITED,
      'Too many failed login attempts across the portal. Please wait ' +
        globalCheck.retryAfterSeconds +
        ' seconds before trying again.',
      { retryAfterSeconds: String(globalCheck.retryAfterSeconds) }
    );
  }

  var subjectKey = userExists
    ? PB_RATE_LIMIT_BUCKETS_.USER_KEY_PREFIX + normalizedUsernameLower
    : PB_RATE_LIMIT_BUCKETS_.UNKNOWN_ACCOUNT_KEY;

  var subjectHit = table.byId[subjectKey] || null;
  var subjectCheck = evaluateRateLimitRecordLock_(
    subjectHit ? subjectHit.record : null,
    nowMs
  );
  if (subjectCheck.isLocked) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_RATE_LIMITED,
      'Account locked after more than 5 incorrect password attempts. Please contact Pattanabhumi Biology support to unlock your account (Phone: Tel.0966821528 | LINE ID: poowadatch | Email: pattanabhumi.biology@gmail.com) or wait ' +
        subjectCheck.retryAfterSeconds +
        ' seconds.',
      {
        retryAfterSeconds: String(subjectCheck.retryAfterSeconds),
        accountLocked: 'true',
        supportPhone: '0966821528',
        supportLineId: 'poowadatch',
        supportLineUrl: 'https://line.me/ti/p/JpDoXL9lYv',
        supportEmail: 'pattanabhumi.biology@gmail.com'
      }
    );
  }
}
/**
 * Increments a single bounded bucket in `LoginAttempts` inside a script lock.
 *
 * @param {string} subjectKey Primary key in `LoginAttempts`.
 * @param {number} maxFailuresBeforeLock Maximum allowed failures in the window before locking.
 * @param {string} nowIso Current UTC ISO-8601 timestamp.
 * @param {number} nowMs Current epoch milliseconds.
 * @return {Object} Updated or inserted `LoginAttempts` record.
 */
function incrementSingleRateLimitBucket_(
  subjectKey,
  maxFailuresBeforeLock,
  nowIso,
  nowMs
) {
  var existing = getSheetRecordById_('LoginAttempts', subjectKey);
  var windowMs = PB_APP_CONSTANTS_.RATE_LIMIT_WINDOW_MS;
  var lockoutMs = PB_APP_CONSTANTS_.RATE_LIMIT_LOCKOUT_MS;

  if (!existing) {
    var initialLockedUntil =
      1 >= maxFailuresBeforeLock
        ? new Date(nowMs + lockoutMs).toISOString()
        : '';
    return insertSheetRecord_('LoginAttempts', {
      subject_key: subjectKey,
      window_start_utc: nowIso,
      failure_count: 1,
      locked_until_utc: initialLockedUntil,
      last_attempt_at_utc: nowIso,
      updated_at_utc: nowIso
    });
  }

  var windowStartMs = Date.parse(existing.window_start_utc);
  var expiredWindow =
    !isFinite(windowStartMs) || nowMs - windowStartMs > windowMs;

  var newCount = expiredWindow ? 1 : Number(existing.failure_count || 0) + 1;
  var newWindowStart = expiredWindow ? nowIso : existing.window_start_utc;
  var newLockedUntil = existing.locked_until_utc || '';

  if (newCount >= maxFailuresBeforeLock) {
    newLockedUntil = new Date(nowMs + lockoutMs).toISOString();
  } else if (expiredWindow) {
    newLockedUntil = '';
  }

  return updateSheetRecordById_('LoginAttempts', subjectKey, {
    window_start_utc: newWindowStart,
    failure_count: newCount,
    locked_until_utc: newLockedUntil,
    last_attempt_at_utc: nowIso,
    updated_at_utc: nowIso
  });
}
/**
 * Records a failed login attempt in `LoginAttempts`.
 * - Known usernames update `login:user:<username_lower>` (max 5 failures / 15 min).
 * - Unknown usernames update ONLY `login:unknown_account_bucket` (max 20 failures / 15 min),
 *   preventing an attacker from bloating the Google Sheet with random nonexistent usernames.
 * - All failures also update `login:global_bucket` (max 50 failures / 15 min).
 *
 * @param {string} normalizedUsernameLower Lowercase username.
 * @param {boolean} userExists True if the username exists in `Users`.
 * @return {{ subjectRecord: Object, globalRecord: Object }}
 */
function recordFailedLoginAttempt_(normalizedUsernameLower, userExists) {
  return withScriptLock_(function () {
    var nowMs = Date.now();
    var nowIso = new Date(nowMs).toISOString();

    var subjectKey = userExists
      ? PB_RATE_LIMIT_BUCKETS_.USER_KEY_PREFIX + normalizedUsernameLower
      : PB_RATE_LIMIT_BUCKETS_.UNKNOWN_ACCOUNT_KEY;
    var subjectMax = userExists
      ? PB_APP_CONSTANTS_.RATE_LIMIT_MAX_USER_FAILURES
      : PB_APP_CONSTANTS_.RATE_LIMIT_MAX_UNKNOWN_USER_FAILURES;

    var subjectRec = incrementSingleRateLimitBucket_(
      subjectKey,
      subjectMax,
      nowIso,
      nowMs
    );
    var globalRec = incrementSingleRateLimitBucket_(
      PB_RATE_LIMIT_BUCKETS_.GLOBAL_KEY,
      PB_APP_CONSTANTS_.RATE_LIMIT_MAX_GLOBAL_FAILURES,
      nowIso,
      nowMs
    );

    return {
      subjectRecord: subjectRec,
      globalRecord: globalRec
    };
  });
}
/**
 * Resets a known user's failure counter (`login:user:<username_lower>`) to `0` after
 * a valid password verification.
 *
 * @param {string} normalizedUsernameLower Lowercase username.
 */
function clearUserLoginFailuresOnSuccess_(normalizedUsernameLower) {
  var subjectKey =
    PB_RATE_LIMIT_BUCKETS_.USER_KEY_PREFIX + normalizedUsernameLower;
  var existing = getSheetRecordById_('LoginAttempts', subjectKey);
  if (!existing) {
    return;
  }
  if (
    Number(existing.failure_count || 0) === 0 &&
    !existing.locked_until_utc
  ) {
    return;
  }
  var nowIso = nowUtcIso_();
  updateSheetRecordById_('LoginAttempts', subjectKey, {
    window_start_utc: nowIso,
    failure_count: 0,
    locked_until_utc: '',
    last_attempt_at_utc: nowIso,
    updated_at_utc: nowIso
  });
}
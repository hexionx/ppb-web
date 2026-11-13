/**
 * AuthService.gs
 * Pattanabhumi Biology Learning Management System - Step 5 Shell & Privacy Flow
 *
 * Responsibilities:
 * - Provide owner-only initial administrator bootstrap (`bootstrapInitialAdminFromEditor_`).
 * - Implement username/password login (`authenticateUserLogin_`) with bounded login throttling,
 *   account status checks (`ACTIVE` vs. `SUSPENDED` / `ARCHIVED`), opaque 256-bit bearer token
 *   issuance, `SHA-256` token digest storage in `Sessions`, and `Users.last_login_at_utc` updates.
 * - Implement the central session & role guard (`requireAuthenticatedSessionGuard_`) invoked
 *   on every protected RPC action.
 * - Implement Step 5 Privacy Notice acknowledgment & Marketing Consent management:
 *     1. `getCurrentPrivacyNoticeVersion_()` reads the active notice version from `Settings`.
 *     2. `doesUserRequirePrivacyAck_()` checks whether the user has acknowledged the current
 *        `CURRENT_PRIVACY_NOTICE_VERSION` in `Users` AND `PrivacyChoices` (supporting both
 *        first-login gates and version-update re-acknowledgment gates).
 *     3. `acknowledgePrivacyNotice_()` records the required Privacy Notice acknowledgment and
 *        separate optional marketing consent in `PrivacyChoices` and `Users`.
 *     4. `updateMarketingPreference_()` allows users to toggle marketing email consent from
 *        My Profile at any time.
 * - Provide Step 5 Administrator tools (`adminUpdateSchoolSettingsStep5_`,
 *   `adminCreateStudentAccountStep5_`) and editor verification (`runStep5VerificationSuiteFromEditor_`).
 *
 * Security Note:
 * - Every function in this file ends with an underscore (_) so it cannot be called directly
 *   from browser clients via `google.script.run`.
 */

/**
 * Validates and normalizes a username into `{ usernameLower, usernameDisplay }`.
 *
 * @param {string} rawUsername Raw username input.
 * @return {{ usernameLower: string, usernameDisplay: string }}
 */
function normalizeAndValidateUsername_(rawUsername) {
  if (typeof rawUsername !== 'string') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Username must be a string.',
      { username: 'Username is required.' }
    );
  }
  var trimmed = rawUsername.trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(trimmed)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Username must be 3 to 40 characters using letters, numbers, dots, underscores, or hyphens.',
      {
        username:
          'Username must be 3 to 40 characters (letters, numbers, ., _, -).'
      }
    );
  }
  return {
    usernameLower: trimmed.toLowerCase(),
    usernameDisplay: trimmed
  };
}

/**
 * Looks up a user record in `Users` by lowercase username (`username_lower`).
 *
 * @param {string} usernameLower Normalized lowercase username.
 * @param {Object=} opt_usersTable Optional pre-read `Users` table from `readSheetTable_('Users')`.
 * @return {Object|null} Matching user record or null.
 */
function findUserByUsernameLower_(usernameLower, opt_usersTable) {
  var table = opt_usersTable || readSheetTable_('Users');
  for (var i = 0; i < table.records.length; i++) {
    var rec = table.records[i];
    if (
      typeof rec.username_lower === 'string' &&
      rec.username_lower.toLowerCase() === usernameLower
    ) {
      return rec;
    }
  }
  return null;
}

/**
 * Returns the authoritative `CURRENT_PRIVACY_NOTICE_VERSION` from the `Settings` sheet
 * (falling back to `PB_APP_CONSTANTS_.CURRENT_PRIVACY_NOTICE_VERSION_DEFAULT`).
 *
 * @return {string} Active privacy notice version string (e.g., `'2026-10-v1'`).
 */
function getCurrentPrivacyNoticeVersion_() {
  var fallbackVersion =
    PB_APP_CONSTANTS_.CURRENT_PRIVACY_NOTICE_VERSION_DEFAULT || '2026-10-v1';
  try {
    var settingsTable = readSheetTable_('Settings');
    if (
      settingsTable &&
      settingsTable.byId &&
      settingsTable.byId.CURRENT_PRIVACY_NOTICE_VERSION &&
      settingsTable.byId.CURRENT_PRIVACY_NOTICE_VERSION.record.setting_value
    ) {
      var configured = String(
        settingsTable.byId.CURRENT_PRIVACY_NOTICE_VERSION.record.setting_value
      ).trim();
      if (configured.length > 0) {
        return configured;
      }
    }
  } catch (ignoreErr) {}
  return fallbackVersion;
}

/**
 * Inspects the `PrivacyChoices` table for `userId` to determine whether the user has
 * an acknowledgment record for `currentNoticeVersion` and what their latest choice record is.
 *
 * @param {string} userId `Users.user_id`
 * @param {string} currentNoticeVersion Active notice version string.
 * @return {{ hasAnyPriorAck: boolean, hasCurrentVersionAck: boolean, latestAckRecord: Object|null, latestChoiceRecord: Object|null }}
 */
function getUserPrivacyChoiceStatus_(userId, currentNoticeVersion) {
  var hasAnyPriorAck = false;
  var hasCurrentVersionAck = false;
  var latestAckRecord = null;
  var latestChoiceRecord = null;

  try {
    var table = readSheetTable_('PrivacyChoices');
    for (var i = 0; i < table.records.length; i++) {
      var row = table.records[i];
      if (row.user_id !== userId) {
        continue;
      }
      if (
        !latestChoiceRecord ||
        String(row.recorded_at_utc) >=
          String(latestChoiceRecord.recorded_at_utc)
      ) {
        latestChoiceRecord = row;
      }
      if (Boolean(row.acknowledged_notice) === true) {
        hasAnyPriorAck = true;
        if (
          !latestAckRecord ||
          String(row.recorded_at_utc) >=
            String(latestAckRecord.recorded_at_utc)
        ) {
          latestAckRecord = row;
        }
        if (String(row.notice_version) === String(currentNoticeVersion)) {
          hasCurrentVersionAck = true;
        }
      }
    }
  } catch (ignoreErr) {}

  return {
    hasAnyPriorAck: hasAnyPriorAck,
    hasCurrentVersionAck: hasCurrentVersionAck,
    latestAckRecord: latestAckRecord,
    latestChoiceRecord: latestChoiceRecord
  };
}

/**
 * Determines whether `userRecord` must complete the Privacy Notice gate before
 * accessing portal views or protected actions that require privacy acknowledgment.
 *
 * A user requires acknowledgment if:
 * 1. `userRecord.privacy_ack_version !== currentNoticeVersion`, OR
 * 2. No acknowledgment record exists in `PrivacyChoices` for `(user_id, currentNoticeVersion)`.
 *
 * @param {Object} userRecord Stored `Users` row.
 * @param {string=} opt_currentNoticeVersion Optional pre-read current notice version.
 * @return {boolean} True if the user must acknowledge the current Privacy Notice.
 */
function doesUserRequirePrivacyAck_(userRecord, opt_currentNoticeVersion) {
  if (!userRecord || !userRecord.user_id) {
    return true;
  }
  var currentVersion =
    opt_currentNoticeVersion || getCurrentPrivacyNoticeVersion_();
  var userAckVersion = String(userRecord.privacy_ack_version || '').trim();
  if (userAckVersion !== currentVersion) {
    return true;
  }
  var choiceStatus = getUserPrivacyChoiceStatus_(
    userRecord.user_id,
    currentVersion
  );
  return !choiceStatus.hasCurrentVersionAck;
}

/**
 * Shapes a non-sensitive user profile summary safe to return to the client.
 * Never includes `password_hash`.
 *
 * @param {Object} userRecord Stored `Users` row.
 * @param {string=} opt_currentPrivacyVersion Optional current privacy notice version.
 * @return {Object} Sanitized user summary.
 */
function buildPublicUserSummary_(userRecord, opt_currentPrivacyVersion) {
  var requiredNoticeVersion =
    opt_currentPrivacyVersion || getCurrentPrivacyNoticeVersion_();
  var choiceStatus = getUserPrivacyChoiceStatus_(
    userRecord.user_id,
    requiredNoticeVersion
  );
  var userAckVersion = String(userRecord.privacy_ack_version || '').trim();
  var requiresAck =
    userAckVersion !== requiredNoticeVersion ||
    !choiceStatus.hasCurrentVersionAck;

  var effectiveAckVersion = choiceStatus.hasCurrentVersionAck
    ? requiredNoticeVersion
    : choiceStatus.latestAckRecord
    ? String(choiceStatus.latestAckRecord.notice_version || '')
    : '';

  var ackRecordedAtUtc = choiceStatus.latestAckRecord
    ? String(choiceStatus.latestAckRecord.recorded_at_utc || '')
    : '';
  var latestChoiceAtUtc = choiceStatus.latestChoiceRecord
    ? String(choiceStatus.latestChoiceRecord.recorded_at_utc || '')
    : '';

  var gateReason = 'NONE';
  if (requiresAck) {
    gateReason = choiceStatus.hasAnyPriorAck
      ? 'NOTICE_UPDATE_GATE'
      : 'FIRST_LOGIN_GATE';
  }

  return {
    userId: userRecord.user_id,
    username: userRecord.username_display || userRecord.username_lower,
    usernameLower: userRecord.username_lower,
    email: userRecord.email,
    fullName: userRecord.full_name,
    role: userRecord.role,
    status: userRecord.status,
    lastLoginAtUtc: userRecord.last_login_at_utc || '',
    lastLoginAtBangkok: userRecord.last_login_at_utc
      ? formatBangkokTimestamp_(userRecord.last_login_at_utc)
      : '',
    privacyAckVersion: effectiveAckVersion,
    requiredPrivacyNoticeVersion: requiredNoticeVersion,
    privacyAckRecordedAtUtc: ackRecordedAtUtc,
    privacyAckRecordedAtBangkok: ackRecordedAtUtc
      ? formatBangkokTimestamp_(ackRecordedAtUtc)
      : '',
    requiresPrivacyAck: Boolean(requiresAck),
    privacyGateReason: gateReason,
    marketingOptIn: Boolean(userRecord.marketing_opt_in),
    marketingUpdatedAtBangkok: latestChoiceAtUtc
      ? formatBangkokTimestamp_(latestChoiceAtUtc)
      : '',
    isMinorFlag: Boolean(userRecord.is_minor_flag),
    version: Number(userRecord.version || 1)
  };
}

/**
 * Records a user's acknowledgment of the current Privacy Notice (`privacy.acknowledge`)
 * along with their separate, optional marketing email preference.
 *
 * @param {Object} authContext `{ user, session }` from `requireAuthenticatedSessionGuard_`.
 * @param {Object} payload `{ noticeVersion: string, acknowledged: boolean, marketingOptIn?: boolean }`
 * @return {Object} Updated user summary and recorded `PrivacyChoices` metadata.
 */
function acknowledgePrivacyNotice_(authContext, payload) {
  if (!payload || typeof payload !== 'object') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Privacy acknowledgment payload is required.'
    );
  }

  if (payload.acknowledged !== true) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'You must check the Privacy Notice acknowledgment checkbox to continue.',
      {
        acknowledged:
          'Required: Please confirm that you have read and acknowledge the Privacy Notice.'
      }
    );
  }

  var currentNoticeVersion = getCurrentPrivacyNoticeVersion_();
  var submittedVersion =
    typeof payload.noticeVersion === 'string'
      ? payload.noticeVersion.trim()
      : '';

  if (!submittedVersion || submittedVersion !== currentNoticeVersion) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
      'The Privacy Notice version has changed to "' +
        currentNoticeVersion +
        '". Please review and acknowledge the latest version.',
      {
        noticeVersion:
          'Expected current version "' + currentNoticeVersion + '".'
      }
    );
  }

  var marketingOptIn = Boolean(payload.marketingOptIn === true);

  return withScriptLock_(function () {
    var freshUser = getSheetRecordById_('Users', authContext.user.user_id);
    if (!freshUser || freshUser.status !== 'ACTIVE') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_ACCOUNT_SUSPENDED,
        'User account is not active.'
      );
    }

    var priorStatus = getUserPrivacyChoiceStatus_(
      freshUser.user_id,
      currentNoticeVersion
    );
    var actionSource = priorStatus.hasAnyPriorAck
      ? 'NOTICE_UPDATE_GATE'
      : 'FIRST_LOGIN_GATE';
    var nowIso = nowUtcIso_();
    var choiceId = generateEntityId_('prv_');

    insertSheetRecord_('PrivacyChoices', {
      choice_id: choiceId,
      user_id: freshUser.user_id,
      notice_version: currentNoticeVersion,
      acknowledged_notice: true,
      marketing_opt_in: marketingOptIn,
      action_source: actionSource,
      recorded_at_utc: nowIso
    });

    var updatedUser = updateSheetRecordById_(
      'Users',
      freshUser.user_id,
      {
        privacy_ack_version: currentNoticeVersion,
        marketing_opt_in: marketingOptIn,
        updated_at_utc: nowIso
      },
      Number(freshUser.version)
    );

    recordAuditEvent_({
      actorUserId: updatedUser.user_id,
      actorRole: updatedUser.role,
      eventType: 'PRIVACY_NOTICE_ACKNOWLEDGED',
      targetEntityType: 'PrivacyChoice',
      targetEntityId: choiceId,
      summary: {
        noticeVersion: currentNoticeVersion,
        actionSource: actionSource,
        marketingOptIn: marketingOptIn
      }
    });

    return {
      choiceId: choiceId,
      noticeVersion: currentNoticeVersion,
      acknowledgedNotice: true,
      marketingOptIn: marketingOptIn,
      actionSource: actionSource,
      recordedAtUtc: nowIso,
      recordedAtBangkok: formatBangkokTimestamp_(nowIso),
      user: buildPublicUserSummary_(updatedUser, currentNoticeVersion)
    };
  });
}

/**
 * Updates an authenticated user's optional marketing email preference (`privacy.updateMarketing`)
 * from their Profile view without altering their required Privacy Notice acknowledgment.
 *
 * @param {Object} authContext `{ user, session }` from `requireAuthenticatedSessionGuard_`.
 * @param {Object} payload `{ marketingOptIn: boolean }`
 * @return {Object} Updated user summary and recorded `PrivacyChoices` metadata.
 */
function updateMarketingPreference_(authContext, payload) {
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.marketingOptIn !== 'boolean'
  ) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Field "marketingOptIn" must be a boolean (true or false).',
      { marketingOptIn: 'Must be true or false.' }
    );
  }

  var marketingOptIn = Boolean(payload.marketingOptIn);
  var currentNoticeVersion = getCurrentPrivacyNoticeVersion_();

  return withScriptLock_(function () {
    var freshUser = getSheetRecordById_('Users', authContext.user.user_id);
    if (!freshUser || freshUser.status !== 'ACTIVE') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_ACCOUNT_SUSPENDED,
        'User account is not active.'
      );
    }

    var nowIso = nowUtcIso_();
    var choiceId = generateEntityId_('prv_');

    insertSheetRecord_('PrivacyChoices', {
      choice_id: choiceId,
      user_id: freshUser.user_id,
      notice_version: currentNoticeVersion,
      acknowledged_notice: true,
      marketing_opt_in: marketingOptIn,
      action_source: 'PROFILE_PREFERENCE_UPDATE',
      recorded_at_utc: nowIso
    });

    var updatedUser = updateSheetRecordById_(
      'Users',
      freshUser.user_id,
      {
        marketing_opt_in: marketingOptIn,
        updated_at_utc: nowIso
      },
      Number(freshUser.version)
    );

    recordAuditEvent_({
      actorUserId: updatedUser.user_id,
      actorRole: updatedUser.role,
      eventType: 'MARKETING_PREFERENCE_UPDATED',
      targetEntityType: 'PrivacyChoice',
      targetEntityId: choiceId,
      summary: {
        noticeVersion: currentNoticeVersion,
        marketingOptIn: marketingOptIn,
        actionSource: 'PROFILE_PREFERENCE_UPDATE'
      }
    });

    return {
      choiceId: choiceId,
      noticeVersion: currentNoticeVersion,
      marketingOptIn: marketingOptIn,
      actionSource: 'PROFILE_PREFERENCE_UPDATE',
      recordedAtUtc: nowIso,
      recordedAtBangkok: formatBangkokTimestamp_(nowIso),
      user: buildPublicUserSummary_(updatedUser, currentNoticeVersion)
    };
  });
}

/**
 * Revokes all currently `ACTIVE` sessions belonging to `userId`.
 * Called automatically when a user's password, role, or account status changes.
 *
 * @param {string} userId Target `Users.user_id`.
 * @param {string} revokeReason Reason code (e.g., `'PASSWORD_CHANGE'`, `'ROLE_CHANGE'`, `'ACCOUNT_SUSPENDED'`).
 * @param {string=} opt_exceptSessionId Optional session ID to keep active.
 * @return {number} Count of sessions transitioned from `ACTIVE` to `REVOKED`.
 */
function revokeAllUserSessions_(userId, revokeReason, opt_exceptSessionId) {
  return withScriptLock_(function () {
    var table = readSheetTable_('Sessions');
    var nowIso = nowUtcIso_();
    var revokedCount = 0;

    for (var i = 0; i < table.records.length; i++) {
      var ses = table.records[i];
      if (
        ses.user_id === userId &&
        ses.status === 'ACTIVE' &&
        (!opt_exceptSessionId || ses.session_id !== opt_exceptSessionId)
      ) {
        updateSheetRecordById_('Sessions', ses.session_id, {
          status: 'REVOKED',
          revoked_at_utc: nowIso,
          revoke_reason: String(revokeReason || 'SECURITY_STATE_CHANGE')
        });
        revokedCount++;
      }
    }

    return revokedCount;
  });
}

/**
 * Updates a user's security-critical attributes (`newPlainPassword`, `newRole`, `newStatus`)
 * with optimistic concurrency (`expectedVersion`) and automatically revokes all existing
 * active sessions for that user so stale credentials cannot remain usable.
 *
 * @param {Object} params `{ targetUserId, expectedVersion, newPlainPassword?, newRole?, newStatus?, actorUserId?, actorRole? }`
 * @return {{ updatedUser: Object, revokedSessionsCount: number }}
 */
function updateUserSecurityState_(params) {
  if (!params || typeof params !== 'object') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Security state update parameters are required.'
    );
  }

  return withScriptLock_(function () {
    var user = getSheetRecordById_('Users', params.targetUserId);
    if (!user) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Target user "' + params.targetUserId + '" was not found.'
      );
    }

    var nowIso = nowUtcIso_();
    var patch = {
      updated_at_utc: nowIso
    };
    var revokeReasons = [];

    if (
      params.newPlainPassword !== undefined &&
      params.newPlainPassword !== null &&
      params.newPlainPassword !== ''
    ) {
      patch.password_hash = hashPassword_(
        String(params.newPlainPassword),
        user.username_lower
      );
      patch.password_updated_at_utc = nowIso;
      revokeReasons.push('PASSWORD_CHANGE');
    }

    if (params.newRole !== undefined && params.newRole !== user.role) {
      patch.role = params.newRole;
      revokeReasons.push('ROLE_CHANGE');
    }

    if (params.newStatus !== undefined && params.newStatus !== user.status) {
      patch.status = params.newStatus;
      revokeReasons.push('ACCOUNT_' + params.newStatus);
    }

    var updatedUser = updateSheetRecordById_(
      'Users',
      user.user_id,
      patch,
      params.expectedVersion !== undefined
        ? Number(params.expectedVersion)
        : Number(user.version)
    );

    var revokedCount = 0;
    if (revokeReasons.length > 0) {
      revokedCount = revokeAllUserSessions_(
        user.user_id,
        revokeReasons.join('+')
      );
    }

    recordAuditEvent_({
      actorUserId: params.actorUserId || 'SYSTEM',
      actorRole: params.actorRole || 'SYSTEM',
      eventType: 'USER_SECURITY_STATE_UPDATED',
      targetEntityType: 'User',
      targetEntityId: user.user_id,
      summary: {
        reasons: revokeReasons,
        newRole: updatedUser.role,
        newStatus: updatedUser.status,
        revokedSessionsCount: revokedCount
      }
    });

    return {
      updatedUser: updatedUser,
      revokedSessionsCount: revokedCount
    };
  });
}

/**
 * Authenticates a username and password (`auth.login`), enforcing rate limits,
 * verifying the password via PBKDF2-HMAC-SHA256, checking account status, creating a
 * server session record storing only `SHA-256(sessionToken)`, and updating `last_login_at_utc`.
 *
 * @param {Object} payload `{ username, password, rememberMe }`
 * @return {Object} Login response data with `sessionToken`, `expiresAtUtc`, `expiresAtBangkok`, `rememberMe`, and `user`.
 */
function authenticateUserLogin_(payload) {
  var normalized = normalizeAndValidateUsername_(payload.username);
  var rawPassword = typeof payload.password === 'string' ? payload.password : '';
  var rememberMe = Boolean(payload.rememberMe);

  var usersTable = readSheetTable_('Users');
  if (usersTable.records.length === 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_CONFIG_MISSING,
      'No user accounts exist in the Users sheet yet. In your Apps Script editor, add BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD in Project Settings -> Script Properties, then run editorRunOwnerTask in Code.gs.'
    );
  }

  var existingUser = findUserByUsernameLower_(
    normalized.usernameLower,
    usersTable
  );
  var userExists = Boolean(existingUser);

  /* 1. Check persistent rate limits BEFORE running expensive PBKDF2 iterations */
  assertLoginNotRateLimited_(normalized.usernameLower, userExists);

  /* 2. If username does not exist, perform dummy PBKDF2 work, record failure in bounded bucket, and reject */
  if (!existingUser) {
    performDummyPasswordWork_(rawPassword);
    recordFailedLoginAttempt_(normalized.usernameLower, false);
    recordAuditEvent_({
      actorUserId: 'ANONYMOUS',
      actorRole: 'ANONYMOUS',
      eventType: 'AUTH_LOGIN_FAILED_UNKNOWN_USER',
      targetEntityType: 'User',
      targetEntityId: 'unknown_user',
      summary: {
        bucket: PB_RATE_LIMIT_BUCKETS_.UNKNOWN_ACCOUNT_KEY
      }
    });
    throw createAppError_(
      PB_ERROR_CODES_.ERR_INVALID_CREDENTIALS,
      'Invalid username or password.'
    );
  }

  /* 3. Verify password against stored PBKDF2-HMAC-SHA256 record */
  var passwordValid = verifyPassword_(rawPassword, existingUser.password_hash);
  if (!passwordValid) {
    recordFailedLoginAttempt_(normalized.usernameLower, true);
    recordAuditEvent_({
      actorUserId: existingUser.user_id,
      actorRole: existingUser.role,
      eventType: 'AUTH_LOGIN_FAILED_BAD_PASSWORD',
      targetEntityType: 'User',
      targetEntityId: existingUser.user_id,
      summary: {
        usernameLower: existingUser.username_lower
      }
    });
    throw createAppError_(
      PB_ERROR_CODES_.ERR_INVALID_CREDENTIALS,
      'Invalid username or password.'
    );
  }

  /* 4. Check account status (SUSPENDED or ARCHIVED accounts cannot log in) */
  if (existingUser.status !== 'ACTIVE') {
    recordAuditEvent_({
      actorUserId: existingUser.user_id,
      actorRole: existingUser.role,
      eventType: 'AUTH_LOGIN_BLOCKED_INACTIVE_ACCOUNT',
      targetEntityType: 'User',
      targetEntityId: existingUser.user_id,
      summary: {
        accountStatus: existingUser.status
      }
    });
    throw createAppError_(
      PB_ERROR_CODES_.ERR_ACCOUNT_SUSPENDED,
      'This account is currently ' +
        existingUser.status.toLowerCase() +
        '. Please contact the school administrator.'
    );
  }

  /* 5. Clear prior failed login attempts for this user */
  clearUserLoginFailuresOnSuccess_(normalized.usernameLower);

  /* 6. Issue opaque 256-bit bearer token, store only its SHA-256 digest, and update last_login_at_utc */
  return withScriptLock_(function () {
    var freshUser = getSheetRecordById_('Users', existingUser.user_id);
    if (!freshUser || freshUser.status !== 'ACTIVE') {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_ACCOUNT_SUSPENDED,
        'Account is not active.'
      );
    }

    var nowMs = Date.now();
    var nowIso = new Date(nowMs).toISOString();
    var ttlMs = rememberMe
      ? PB_APP_CONSTANTS_.SESSION_TTL_REMEMBER_ME_MS
      : PB_APP_CONSTANTS_.SESSION_TTL_DEFAULT_MS;
    var expiresAtIso = new Date(nowMs + ttlMs).toISOString();

    var rawSessionToken = generateSessionTokenHex_(freshUser.user_id);
    var tokenSha256 = sha256Hex_(rawSessionToken);
    var sessionId = generateEntityId_('ses_');

    insertSheetRecord_('Sessions', {
      session_id: sessionId,
      token_sha256_hex: tokenSha256,
      user_id: freshUser.user_id,
      remember_me: rememberMe,
      status: 'ACTIVE',
      created_at_utc: nowIso,
      expires_at_utc: expiresAtIso,
      last_seen_at_utc: nowIso,
      revoked_at_utc: '',
      revoke_reason: ''
    });

    var updatedUser = updateSheetRecordById_(
      'Users',
      freshUser.user_id,
      {
        last_login_at_utc: nowIso,
        updated_at_utc: nowIso
      },
      Number(freshUser.version)
    );

    var currentNoticeVersion = getCurrentPrivacyNoticeVersion_();

    recordAuditEvent_({
      actorUserId: updatedUser.user_id,
      actorRole: updatedUser.role,
      eventType: 'AUTH_LOGIN_SUCCESS',
      targetEntityType: 'Session',
      targetEntityId: sessionId,
      summary: {
        rememberMe: rememberMe,
        expiresAtUtc: expiresAtIso
      }
    });

    return {
      sessionToken: rawSessionToken,
      sessionId: sessionId,
      expiresAtUtc: expiresAtIso,
      expiresAtBangkok: formatBangkokTimestamp_(expiresAtIso),
      rememberMe: rememberMe,
      privacyNoticeVersion: currentNoticeVersion,
      user: buildPublicUserSummary_(updatedUser, currentNoticeVersion)
    };
  });
}

/**
 * Validates the client's bearer `sessionToken` on every protected RPC call:
 * 1. Verifies the token format (`64` hex characters).
 * 2. Computes `SHA-256(sessionToken)` and looks up the matching row in `Sessions`.
 * 3. Verifies `session.status === 'ACTIVE'` and `expires_at_utc > now` (if expired, marks `EXPIRED`).
 * 4. Looks up the owning user in `Users` and verifies `user.status === 'ACTIVE'`.
 * 5. Enforces role authorization (`actionSpec.requiredRoles`).
 *
 * @param {string|null} rawSessionToken Client bearer token from request envelope.
 * @param {Object} actionSpec Action specification from `getRpcActionRegistry_()`.
 * @return {{ user: Object, session: Object }}
 */
function requireAuthenticatedSessionGuard_(rawSessionToken, actionSpec) {
  if (
    typeof rawSessionToken !== 'string' ||
    rawSessionToken.trim().length === 0
  ) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required for this action. Please sign in.'
    );
  }

  var cleanToken = rawSessionToken.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleanToken)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Invalid or malformed session credential. Please sign in again.'
    );
  }

  var incomingDigest = sha256Hex_(cleanToken);
  var sessionsTable = readSheetTable_('Sessions');
  var matchedSession = null;

  for (var i = 0; i < sessionsTable.records.length; i++) {
    var candidate = sessionsTable.records[i];
    if (
      typeof candidate.token_sha256_hex === 'string' &&
      constantTimeEqual_(candidate.token_sha256_hex, incomingDigest)
    ) {
      matchedSession = candidate;
      break;
    }
  }

  if (!matchedSession) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Session is invalid or was not found. Please sign in again.'
    );
  }

  if (matchedSession.status !== 'ACTIVE') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Your session is no longer active (' +
        matchedSession.status +
        '). Please sign in again.'
    );
  }

  var nowMs = Date.now();
  var expiresMs = Date.parse(matchedSession.expires_at_utc);
  if (!isFinite(expiresMs) || expiresMs <= nowMs) {
    try {
      withScriptLock_(function () {
        var currentSes = getSheetRecordById_(
          'Sessions',
          matchedSession.session_id
        );
        if (currentSes && currentSes.status === 'ACTIVE') {
          updateSheetRecordById_('Sessions', matchedSession.session_id, {
            status: 'EXPIRED',
            revoked_at_utc: new Date(nowMs).toISOString(),
            revoke_reason: 'EXPIRED'
          });
        }
      });
    } catch (ignoreLockErr) {}

    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Your session has expired. Please sign in again.'
    );
  }

  var user = getSheetRecordById_('Users', matchedSession.user_id);
  if (!user) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'The user account associated with this session no longer exists.'
    );
  }

  if (user.status !== 'ACTIVE') {
    try {
      revokeAllUserSessions_(user.user_id, 'ACCOUNT_' + user.status);
    } catch (ignoreRevokeErr) {}

    throw createAppError_(
      PB_ERROR_CODES_.ERR_ACCOUNT_SUSPENDED,
      'Your account is currently ' +
        user.status.toLowerCase() +
        '. Access has been revoked.'
    );
  }

  var requiredRoles =
    actionSpec && Array.isArray(actionSpec.requiredRoles)
      ? actionSpec.requiredRoles
      : [];
  if (requiredRoles.length > 0 && requiredRoles.indexOf(user.role) === -1) {
    recordAuditEvent_({
      actorUserId: user.user_id,
      actorRole: user.role,
      eventType: 'AUTH_FORBIDDEN_ROLE_ACCESS',
      targetEntityType: 'RpcAction',
      targetEntityId:
        actionSpec && actionSpec.actionName
          ? actionSpec.actionName
          : 'protected_action',
      summary: {
        userRole: user.role,
        requiredRoles: requiredRoles
      }
    });
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Access denied: your account role (' +
        user.role +
        ') is not authorized to perform this action.'
    );
  }

  return {
    user: user,
    session: matchedSession
  };
}

/**
 * Revokes the caller's current session (`auth.logout`).
 *
 * @param {Object} authContext `{ user, session }` returned by `requireAuthenticatedSessionGuard_`.
 * @return {Object} `{ revoked: true, sessionId, revokedAtUtc }`
 */
function revokeCurrentSession_(authContext) {
  return withScriptLock_(function () {
    var sessionId = authContext.session.session_id;
    var user = authContext.user;
    var nowIso = nowUtcIso_();

    var current = getSheetRecordById_('Sessions', sessionId);
    if (current && current.status === 'ACTIVE') {
      updateSheetRecordById_('Sessions', sessionId, {
        status: 'REVOKED',
        revoked_at_utc: nowIso,
        revoke_reason: 'USER_LOGOUT'
      });
    }

    recordAuditEvent_({
      actorUserId: user.user_id,
      actorRole: user.role,
      eventType: 'AUTH_LOGOUT',
      targetEntityType: 'Session',
      targetEntityId: sessionId,
      summary: {
        revokeReason: 'USER_LOGOUT'
      }
    });

    return {
      revoked: true,
      sessionId: sessionId,
      revokedAtUtc: nowIso
    };
  });
}

/**
 * Step 5 Administrator helper (`admin.updateSchoolSettings`) allowing an ADMIN user to update:
 * - `CURRENT_PRIVACY_NOTICE_VERSION` (to test version-change privacy re-acknowledgment)
 * - `CONTACT_LINE_URL` (to test configured LINE URL vs. unconfigured fallback)
 * - `CONTACT_FACEBOOK_URL`
 * - `CONTACT_EMAIL`
 * - `SCHOOL_NAME`
 *
 * @param {Object} authContext `{ user, session }`
 * @param {Object} payload `{ privacyNoticeVersion?, contactLineUrl?, contactFacebookUrl?, contactEmail?, schoolName? }`
 * @return {Object} Updated settings summary.
 */
function adminUpdateSchoolSettingsStep5_(authContext, payload) {
  if (!payload || typeof payload !== 'object') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Settings payload must be an object.'
    );
  }

  var fieldErrors = {};
  var updatesToApply = [];

  if (payload.privacyNoticeVersion !== undefined) {
    var ver = String(payload.privacyNoticeVersion || '').trim();
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(ver)) {
      fieldErrors.privacyNoticeVersion =
        'Privacy Notice version must be 3 to 40 characters (letters, numbers, ., _, -).';
    } else {
      updatesToApply.push({
        key: 'CURRENT_PRIVACY_NOTICE_VERSION',
        value: ver
      });
    }
  }

  if (payload.contactLineUrl !== undefined) {
    var lineVal = String(payload.contactLineUrl || '').trim();
    if (lineVal !== '' && !/^https:\/\/[^\s]+$/i.test(lineVal)) {
      fieldErrors.contactLineUrl =
        'LINE URL must start with https:// (or leave blank to test the unconfigured fallback).';
    } else {
      updatesToApply.push({ key: 'CONTACT_LINE_URL', value: lineVal });
    }
  }

  if (payload.contactFacebookUrl !== undefined) {
    var fbVal = String(payload.contactFacebookUrl || '').trim();
    if (fbVal !== '' && !/^https:\/\/[^\s]+$/i.test(fbVal)) {
      fieldErrors.contactFacebookUrl =
        'Facebook URL must start with https:// (or leave blank).';
    } else {
      updatesToApply.push({ key: 'CONTACT_FACEBOOK_URL', value: fbVal });
    }
  }

  if (payload.contactEmail !== undefined) {
    var emailVal = String(payload.contactEmail || '').trim();
    if (emailVal !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
      fieldErrors.contactEmail =
        'Contact email must be a valid email address (or leave blank).';
    } else {
      updatesToApply.push({ key: 'CONTACT_EMAIL', value: emailVal });
    }
  }

  if (payload.schoolName !== undefined) {
    var nameVal = String(payload.schoolName || '').trim();
    if (nameVal.length < 2 || nameVal.length > 100) {
      fieldErrors.schoolName = 'School name must be 2 to 100 characters.';
    } else {
      updatesToApply.push({ key: 'SCHOOL_NAME', value: nameVal });
    }
  }

  /* Preserve existing LOGO_FILE_ID unless logoFileIdOverride is explicitly supplied */
  if (payload.logoFileIdOverride !== undefined) {
    var logoVal = String(payload.logoFileIdOverride || '').trim();
    if (logoVal !== '' && !/^[A-Za-z0-9_-]{8,120}$/.test(logoVal)) {
      fieldErrors.logoFileIdOverride =
        'Replacement Logo Drive File ID must be 8 to 120 alphanumeric/underscore/hyphen characters (or leave blank to use DEFAULT_LOGO_DRIVE_FILE_ID).';
    } else {
      updatesToApply.push({ key: 'LOGO_FILE_ID', value: logoVal });
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Invalid school settings parameters.',
      fieldErrors
    );
  }

  return withScriptLock_(function () {
    var nowIso = nowUtcIso_();
    var actorId = authContext.user.user_id;

    for (var i = 0; i < updatesToApply.length; i++) {
      var item = updatesToApply[i];
      var existing = getSheetRecordById_('Settings', item.key);
      if (existing) {
        updateSheetRecordById_(
          'Settings',
          item.key,
          {
            setting_value: item.value,
            updated_by_user_id: actorId,
            updated_at_utc: nowIso
          },
          Number(existing.version)
        );
      } else {
        insertSheetRecord_('Settings', {
          setting_key: item.key,
          setting_value: item.value,
          updated_by_user_id: actorId,
          updated_at_utc: nowIso
        });
      }
    }

    recordAuditEvent_({
      actorUserId: actorId,
      actorRole: authContext.user.role,
      eventType: 'ADMIN_SETTINGS_UPDATED_STEP5',
      targetEntityType: 'Setting',
      targetEntityId: 'SCHOOL_SETTINGS',
      summary: {
        updatedKeys: updatesToApply.map(function (u) {
          return u.key;
        })
      }
    });

    if (typeof invalidateSchoolLogoCache_ === 'function') {
      invalidateSchoolLogoCache_();
    }

    return {
      updatedCount: updatesToApply.length,
      currentPrivacyNoticeVersion: getCurrentPrivacyNoticeVersion_(),
      updatedAtBangkok: formatBangkokTimestamp_(nowIso)
    };
  });
}

/**
 * Step 5 Administrator helper (`admin.createStudentAccount`) allowing an ADMIN user to create
 * a real `STUDENT` account (or update its password) in `Users` so the owner can test the
 * student login flow, student first-login privacy gate, and student role restrictions.
 *
 * @param {Object} authContext `{ user, session }`
 * @param {Object} payload `{ username, password, fullName, email, isMinorFlag? }`
 * @return {Object} Created student account summary.
 */
function adminCreateStudentAccountStep5_(authContext, payload) {
  if (!payload || typeof payload !== 'object') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Student account payload is required.'
    );
  }

  var normalizedUser = normalizeAndValidateUsername_(payload.username);
  var rawPassword =
    typeof payload.password === 'string' ? payload.password : '';
  var passwordHash = hashPassword_(rawPassword, normalizedUser.usernameLower);

  var fullName =
    typeof payload.fullName === 'string' && payload.fullName.trim().length > 0
      ? payload.fullName.trim()
      : 'Biology Student (' + normalizedUser.usernameDisplay + ')';
  var email =
    typeof payload.email === 'string' && payload.email.trim().length > 0
      ? payload.email.trim()
      : normalizedUser.usernameLower + '@student.pattanabhumi.local';
  var isMinorFlag = Boolean(payload.isMinorFlag === true);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please enter a valid student email address.',
      { email: 'Invalid email address format.' }
    );
  }

  return withScriptLock_(function () {
    var usersTable = readSheetTable_('Users');
    var existing = findUserByUsernameLower_(
      normalizedUser.usernameLower,
      usersTable
    );
    var nowIso = nowUtcIso_();

    if (existing) {
      if (existing.role === 'ADMIN') {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Username "' +
            normalizedUser.usernameDisplay +
            '" belongs to an administrator account. Choose a different student username.',
          { username: 'Username already belongs to an ADMIN account.' }
        );
      }
      var updatedStudent = updateSheetRecordById_(
        'Users',
        existing.user_id,
        {
          full_name: fullName,
          email: email,
          password_hash: passwordHash,
          password_updated_at_utc: nowIso,
          privacy_ack_version: '',
          marketing_opt_in: false,
          is_minor_flag: isMinorFlag,
          status: 'ACTIVE',
          updated_at_utc: nowIso
        },
        Number(existing.version)
      );
      revokeAllUserSessions_(existing.user_id, 'ADMIN_STUDENT_PASSWORD_RESET');

      recordAuditEvent_({
        actorUserId: authContext.user.user_id,
        actorRole: authContext.user.role,
        eventType: 'ADMIN_STUDENT_RESET_FOR_TESTING',
        targetEntityType: 'User',
        targetEntityId: existing.user_id,
        summary: {
          username: updatedStudent.username_display,
          isMinorFlag: isMinorFlag
        }
      });

      return {
        createdNew: false,
        studentUser: buildPublicUserSummary_(updatedStudent)
      };
    }

    var studentId = generateEntityId_('usr_');
    var createdStudent = insertSheetRecord_('Users', {
      user_id: studentId,
      username_lower: normalizedUser.usernameLower,
      username_display: normalizedUser.usernameDisplay,
      email: email,
      full_name: fullName,
      role: 'STUDENT',
      status: 'ACTIVE',
      password_hash: passwordHash,
      password_updated_at_utc: nowIso,
      last_login_at_utc: '',
      privacy_ack_version: '',
      marketing_opt_in: false,
      is_minor_flag: isMinorFlag,
      created_at_utc: nowIso,
      updated_at_utc: nowIso
    });

    recordAuditEvent_({
      actorUserId: authContext.user.user_id,
      actorRole: authContext.user.role,
      eventType: 'ADMIN_STUDENT_CREATED',
      targetEntityType: 'User',
      targetEntityId: studentId,
      summary: {
        username: createdStudent.username_display,
        isMinorFlag: isMinorFlag
      }
    });

    return {
      createdNew: true,
      studentUser: buildPublicUserSummary_(createdStudent)
    };
  });
}

/**
 * Owner-only function intended to be executed from the Apps Script editor (never via RPC)
 * to create the initial `ADMIN` account safely without hardcoding a password in source code.
 *
 * @return {Object} Summary of the created administrator account (never includes password or hash).
 */
function bootstrapInitialAdminFromEditor_() {
  return withScriptLock_(function () {
    var scriptProps = PropertiesService.getScriptProperties();
    var rawUsername = scriptProps.getProperty('BOOTSTRAP_ADMIN_USERNAME') || '';
    var rawPassword = scriptProps.getProperty('BOOTSTRAP_ADMIN_PASSWORD') || '';
    var rawEmail =
      scriptProps.getProperty('BOOTSTRAP_ADMIN_EMAIL') ||
      PB_APP_CONSTANTS_.CONTACT_DEFAULTS.email;
    var rawFullName =
      scriptProps.getProperty('BOOTSTRAP_ADMIN_FULL_NAME') ||
      'Pattanabhumi Portal Administrator';

    var usersTable = readSheetTable_('Users');
    for (var i = 0; i < usersTable.records.length; i++) {
      if (usersTable.records[i].role === 'ADMIN') {
        scriptProps.deleteProperty('BOOTSTRAP_ADMIN_PASSWORD');
        throw createAppError_(
          PB_ERROR_CODES_.ERR_BOOTSTRAP_ALREADY_COMPLETED,
          'An ADMIN account ("' +
            usersTable.records[i].username_display +
            '") already exists in the Users sheet. Initial bootstrap can only be run once.'
        );
      }
    }

    if (!rawUsername.trim() || !rawPassword) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_CONFIG_MISSING,
        'To bootstrap the initial administrator, temporarily add BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD (at least 8 characters) in Project Settings -> Script Properties, then run bootstrapInitialAdminFromEditor_.'
      );
    }

    var normalizedUser = normalizeAndValidateUsername_(rawUsername);
    var passwordHash = hashPassword_(
      rawPassword,
      normalizedUser.usernameLower
    );
    var nowIso = nowUtcIso_();
    var adminUserId = generateEntityId_('usr_');

    var createdAdmin = insertSheetRecord_('Users', {
      user_id: adminUserId,
      username_lower: normalizedUser.usernameLower,
      username_display: normalizedUser.usernameDisplay,
      email: rawEmail.trim(),
      full_name: rawFullName.trim(),
      role: 'ADMIN',
      status: 'ACTIVE',
      password_hash: passwordHash,
      password_updated_at_utc: nowIso,
      last_login_at_utc: '',
      privacy_ack_version: '',
      marketing_opt_in: false,
      is_minor_flag: false,
      created_at_utc: nowIso,
      updated_at_utc: nowIso
    });

    scriptProps.deleteProperty('BOOTSTRAP_ADMIN_PASSWORD');

    recordAuditEvent_({
      actorUserId: adminUserId,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_BOOTSTRAP_CREATED',
      targetEntityType: 'User',
      targetEntityId: adminUserId,
      summary: {
        username: createdAdmin.username_display,
        email: createdAdmin.email,
        tempPasswordPropertyDeleted: true
      }
    });

    var report = {
      ok: true,
      userId: createdAdmin.user_id,
      username: createdAdmin.username_display,
      email: createdAdmin.email,
      role: createdAdmin.role,
      status: createdAdmin.status,
      bootstrapPasswordPropertyDeleted:
        scriptProps.getProperty('BOOTSTRAP_ADMIN_PASSWORD') === null,
      createdAtBangkok: formatBangkokTimestamp_(nowIso)
    };

    Logger.log(
      'Initial Administrator Bootstrap Succeeded: ' + JSON.stringify(report)
    );
    return report;
  });
}

/**
 * Editor-only self-test suite for Step 4 & Step 5 that verifies PBKDF2-HMAC-SHA256,
 * CSPRNG token generation, and Privacy Notice version evaluation.
 *
 * @return {Object} Verification report logged to the Apps Script Execution Log.
 */
function runStep4VerificationSuiteFromEditor_() {
  var results = [];
  var cryptoReport = runCryptoSelfTestAndBenchmark_();

  results.push({
    test: '1. RFC 6070 PBKDF2-HMAC-SHA256 Vectors (c=1, c=2, c=4096)',
    passed: cryptoReport.vectorsPassed === true,
    detail: JSON.stringify(cryptoReport)
  });

  var sampleHash = hashPassword_('CorrectHorseBatteryStaple!26', 'test_user');
  var matchOk = verifyPassword_('CorrectHorseBatteryStaple!26', sampleHash);
  var wrongRejected = !verifyPassword_('WrongPassword!26', sampleHash);
  results.push({
    test: '2. PBKDF2 Hash & Constant-Time Verification (10,000 iterations)',
    passed: matchOk && wrongRejected,
    detail: 'Hash prefix: ' + sampleHash.substring(0, 28) + '...'
  });

  var shortRejected = false;
  try {
    validatePasswordInputBytes_('short', true);
  } catch (err) {
    shortRejected = err.code === PB_ERROR_CODES_.ERR_VALIDATION_FAILED;
  }
  results.push({
    test: '3. Password Minimum/Maximum Length & Byte Validation',
    passed: shortRejected,
    detail: 'Short password rejected with ERR_VALIDATION_FAILED'
  });

  var tok1 = generateSessionTokenHex_('usr_test_1');
  var tok2 = generateSessionTokenHex_('usr_test_1');
  var tokensDistinct =
    tok1.length === 64 &&
    tok2.length === 64 &&
    !constantTimeEqual_(tok1, tok2) &&
    !constantTimeEqual_(sha256Hex_(tok1), sha256Hex_(tok2));
  results.push({
    test: '4. CSPRNG 256-Bit Token Generation & SHA-256 Digest Uniqueness',
    passed: tokensDistinct,
    detail: 'Generated two distinct 64-hex tokens and 64-hex SHA-256 digests'
  });

  var allPassed = true;
  for (var i = 0; i < results.length; i++) {
    if (!results[i].passed) {
      allPassed = false;
    }
  }

  var summary = {
    allPassed: allPassed,
    benchmarkMsFor10000Iterations: cryptoReport.benchmarkElapsedMs,
    results: results
  };
  Logger.log('Step 4 Verification Suite Summary: ' + JSON.stringify(summary));
  return summary;
}
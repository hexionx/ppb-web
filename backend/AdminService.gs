/**
 * AdminService.gs
 * Pattanabhumi Biology Learning Management System - Step 6 Settings & Users Administration
 *
 * Responsibilities:
 * - Separate Public Settings (exposed to unauthenticated visitors in `public.getBootstrap`)
 *   from Private Settings (notification recipient email, PromptPay target, bank account name,
 *   bank name, bank account number, and internal configuration metadata).
 * - Implement `adminGetSettingsStep6_` and `adminUpdateSettingsStep6_` with strict URL/email/
 *   PromptPay/bank/Privacy Notice document & version validation, optimistic concurrency checks
 *   (`expectedVersions`), and an honest unsimulated Logo Upload status (`UNIMPLEMENTED_UNTIL_DRIVE_STORAGE_STEP`).
 * - Implement User Administration & Real Course Enrollment Preparation:
 *     1. `adminListUsersStep6_`: Search, filter (role/status), and cursor pagination with
 *        last login (`Asia/Bangkok`), privacy acknowledgment & marketing status, financial
 *        reference counts (`Invoices` + `Payments`), and active course enrollments (`Enrollments`).
 *        Strictly omits `password_hash` from every response.
 *     2. `adminCreateUserStep6_`: Creates a `STUDENT` or `ADMIN` account with unique normalized
 *        username, validated email, PBKDF2-HMAC-SHA256 initial password hash, role, active/inactive
 *        (`ACTIVE` / `SUSPENDED`) status, and optional initial course enrollments.
 *     3. `adminUpdateUserStep6_`: Edits profile fields (`username`, `email`, `fullName`, `role`,
 *        `status`, `isMinorFlag`, and optional `assignedCourseIds`) with `expectedVersion`
 *        optimistic concurrency checking, last-usable-administrator protection, automatic session
 *        revocation when security-relevant fields (`username`, `role`, `status`) change, and
 *        strict preservation of the user's `marketing_opt_in` choice and `PrivacyChoices` history.
 *     4. `adminResetUserPasswordStep6_`: Resets a user's password (`expectedVersion` checked),
 *        hashes with PBKDF2-HMAC-SHA256, immediately revokes all active sessions for that user
 *        (`ADMIN_PASSWORD_RESET`), and logs a credential-free audit event.
 *     5. `adminSetUserEnrollmentsStep6_`: Prepares course assignment for a user using real
 *        `Enrollments` records (`ACTIVE` vs. `REVOKED`) with optimistic concurrency.
 *     6. `adminDeleteOrArchiveUserStep6_`: Prevents removing/disabling the last usable `ADMIN`,
 *        blocks hard-deletion of any user referenced by `Invoices` or `Payments`
 *        (`ERR_USER_HAS_FINANCIAL_REFERENCES`), and revokes active sessions.
 *     7. `adminSeedStep6SampleUsers_`: Seeds or verifies the 5 required non-real sample users
 *        (2 administrators, 2 active students, 1 disabled student) and sample courses for testing.
 *
 * Security Note:
 * - Every function in this file ends with an underscore (_) so it cannot be called directly
 *   from browser clients via `google.script.run`. All access goes through `rpcDispatch`.
 */

var PB_DEFAULT_PRIVACY_NOTICE_DOCUMENT_TEXT_ =
  '1. Educational & Administrative Data Processed\n' +
  'Pattanabhumi Biology processes your account profile (username, full name, email address, role, and last login timestamp), course enrollments, tuition installment records, uploaded payment receipt images, and class unavailability reports so the school can deliver biology tutoring courses, verify tuition payments, and coordinate class schedules in the Asia/Bangkok timezone.\n\n' +
  '2. Where Portal Records Are Stored\n' +
  'Application records are stored in a private Google Sheet, uploaded course materials and payment receipts are stored in restricted Google Drive folders owned by the school, class schedules are read from Google Calendar, and unavailability notifications are sent via Gmail / Google Apps Script MailApp.\n\n' +
  '3. Essential Browser Storage & Cookie Policy\n' +
  '- Default In-Memory Session Credential: When you sign in without checking "Remember me", your opaque session token is held only in browser memory and is cleared as soon as you close or refresh the tab.\n' +
  '- Optional "Remember Me" Storage (localStorage): If you check "Remember me", an opaque 256-bit bearer token is stored in browser localStorage (pb_lms_session_token_v1) for up to 7 days.\n' +
  '- No Custom HttpOnly Cookies & No Tracking Cookies: Because Google Apps Script HTML Service runs inside a sandboxed *.googleusercontent.com iframe, this web app does not issue custom HttpOnly cookies, never stores passwords, banking details, profile data, or login bearer tokens in cookies, and uses zero advertising or cross-site tracking cookies.\n\n' +
  '4. Important Notice Regarding School Legal Review & Minor Students\n' +
  'Acknowledging this notice records the version and server timestamp of your review in the PrivacyChoices sheet. However, a single checkbox does not by itself constitute complete legal compliance under the Thai Personal Data Protection Act (PDPA B.E. 2562) or other applicable laws, and this software does not invent statutory retention periods. Pattanabhumi Biology administration must review this notice with qualified legal counsel, establish official data-retention schedules, and verify parental or legal guardian consent requirements for minor students.';

var PB_STEP6_PUBLIC_SETTING_KEYS_ = Object.freeze([
  'SCHOOL_NAME',
  'CONTACT_EMAIL',
  'CONTACT_LINE_URL',
  'CONTACT_FACEBOOK_URL',
  'CURRENT_PRIVACY_NOTICE_VERSION',
  'PRIVACY_NOTICE_DOCUMENT_TEXT'
]);

var PB_STEP6_PRIVATE_SETTING_KEYS_ = Object.freeze([
  'ADMIN_NOTIFICATION_EMAIL',
  'PROMPTPAY_ID_DISPLAY',
  'BANK_ACCOUNT_NAME',
  'BANK_NAME',
  'BANK_ACCOUNT_NUMBER',
  'LOGO_FILE_ID'
]);

/**
 * Verifies that `authContext` represents an authenticated, active `ADMIN` user.
 * Throws `ERR_AUTH_REQUIRED` or `ERR_FORBIDDEN_ROLE` if not satisfied.
 *
 * @param {Object} authContext Verified auth context from `rpcDispatch`.
 * @return {Object} The verified admin user record.
 */
function assertAdminRoleStep6_(authContext) {
  if (!authContext || !authContext.user || !authContext.user.user_id) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_AUTH_REQUIRED,
      'Authentication is required for this administrator action.'
    );
  }
  if (authContext.user.status !== 'ACTIVE') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_ACCOUNT_SUSPENDED,
      'Your administrator account is not active.'
    );
  }
  if (authContext.user.role !== 'ADMIN') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
      'Access denied: Administrator privileges (ADMIN) are required for this action.'
    );
  }
  return authContext.user;
}

/**
 * Reads a setting row from a pre-loaded `Settings` table or returns a default structure.
 */
function getSettingEntryWithVersion_(settingsTable, key, defaultValue) {
  if (
    settingsTable &&
    settingsTable.byId &&
    Object.prototype.hasOwnProperty.call(settingsTable.byId, key)
  ) {
    var rec = settingsTable.byId[key].record;
    return {
      key: key,
      value:
        rec.setting_value !== undefined && rec.setting_value !== null
          ? String(rec.setting_value)
          : String(defaultValue || ''),
      version: Number(rec.version || 1),
      updatedByUserId: String(rec.updated_by_user_id || 'SYSTEM'),
      updatedAtUtc: String(rec.updated_at_utc || ''),
      updatedAtBangkok: rec.updated_at_utc
        ? formatBangkokTimestamp_(rec.updated_at_utc)
        : ''
    };
  }
  return {
    key: key,
    value: String(defaultValue || ''),
    version: 0,
    updatedByUserId: 'DEFAULT',
    updatedAtUtc: '',
    updatedAtBangkok: ''
  };
}
/**
 * Returns only the public settings safe for `public.getBootstrap` (Landing Page, Contact Page,
 * and Privacy Notice Modal). Never includes private settings (`ADMIN_NOTIFICATION_EMAIL`,
 * `PROMPTPAY_ID_DISPLAY`, `BANK_ACCOUNT_NAME`, `BANK_NAME`, `BANK_ACCOUNT_NUMBER`).
 *
 * @param {Object=} opt_settingsTable Optional pre-read `Settings` table.
 * @return {Object} Public settings snapshot.
 */
function getPublicSchoolSettingsSnapshot_(opt_settingsTable) {
  var tbl = opt_settingsTable || null;
  if (!tbl) {
    try {
      tbl = readSheetTable_('Settings');
    } catch (ignoreErr) {
      tbl = null;
    }
  }

  var schoolNameEntry = getSettingEntryWithVersion_(
    tbl,
    'SCHOOL_NAME',
    PB_APP_CONSTANTS_.SCHOOL_NAME_DEFAULT
  );
  var schoolName =
    schoolNameEntry.value.trim() || PB_APP_CONSTANTS_.SCHOOL_NAME_DEFAULT;

  var lineEntry = getSettingEntryWithVersion_(tbl, 'CONTACT_LINE_URL', '');
  var fbEntry = getSettingEntryWithVersion_(tbl, 'CONTACT_FACEBOOK_URL', '');
  var emailEntry = getSettingEntryWithVersion_(tbl, 'CONTACT_EMAIL', '');
  var verEntry = getSettingEntryWithVersion_(
    tbl,
    'CURRENT_PRIVACY_NOTICE_VERSION',
    PB_APP_CONSTANTS_.CURRENT_PRIVACY_NOTICE_VERSION_DEFAULT
  );
  var docEntry = getSettingEntryWithVersion_(
    tbl,
    'PRIVACY_NOTICE_DOCUMENT_TEXT',
    PB_DEFAULT_PRIVACY_NOTICE_DOCUMENT_TEXT_
  );

  var contactStatus = resolveContactStatusSafe_({
    lineUrl: lineEntry.value,
    facebookUrl: fbEntry.value,
    email: emailEntry.value
  });

  return {
    schoolName: schoolName,
    contact: contactStatus,
    privacyNoticeVersion:
      verEntry.value.trim() ||
      PB_APP_CONSTANTS_.CURRENT_PRIVACY_NOTICE_VERSION_DEFAULT,
    privacyNoticeDocumentText:
      docEntry.value.trim() || PB_DEFAULT_PRIVACY_NOTICE_DOCUMENT_TEXT_
  };
}
/**
 * Deletes a single row by primary key from a worksheet (used ONLY for hard-deleting a
 * test user that has zero financial references and zero historical dependencies).
 *
 * @param {string} sheetName Target worksheet name.
 * @param {string} primaryKeyValue Primary key value.
 * @param {number=} opt_expectedVersion Expected optimistic concurrency version.
 * @param {Object=} opt_options Optional `{ spreadsheet, skipLock }`.
 * @return {Object} `{ deleted: true, primaryKey, deletedRecord }`
 */
function deleteSheetRecordById_(
  sheetName,
  primaryKeyValue,
  opt_expectedVersion,
  opt_options
) {
  var opts = opt_options && typeof opt_options === 'object' ? opt_options : {};
  var schema = PB_SHEET_SCHEMAS_[sheetName];
  if (!schema) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Unknown worksheet: ' + String(sheetName)
    );
  }

  var executeDelete = function () {
    var table = readSheetTable_(sheetName, opts.spreadsheet);
    var pk = String(primaryKeyValue || '').trim();
    var hit = table.byId[pk];
    if (!hit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'Record "' + pk + '" not found in worksheet "' + sheetName + '".'
      );
    }

    var current = hit.record;
    if (schema.hasVersion && opt_expectedVersion !== undefined && opt_expectedVersion !== null) {
      var expectedVer = Number(opt_expectedVersion);
      if (!isFinite(expectedVer) || expectedVer !== Number(current.version)) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
          'Optimistic concurrency conflict on "' +
            sheetName +
            '" (' +
            pk +
            '): expected version ' +
            String(opt_expectedVersion) +
            ' but stored version is ' +
            String(current.version) +
            '. Another administrator modified this record; please reload before retrying.'
        );
      }
    }

    if (typeof table.sheet.deleteRow === 'function') {
      table.sheet.deleteRow(hit.rowNumber);
    } else {
      var emptyRow = [];
      for (var c = 0; c < schema.headers.length; c++) {
        emptyRow.push('');
      }
      table.sheet
        .getRange(hit.rowNumber, 1, 1, schema.headers.length)
        .setValues([emptyRow]);
    }

    return {
      deleted: true,
      primaryKey: pk,
      deletedRecord: current
    };
  };

  if (opts.skipLock === true) {
    return executeDelete();
  }
  return withScriptLock_(executeDelete);
}
/**
 * Step 6 Handler: `admin.getSettings`
 * Returns both Public Settings and Private Settings with their individual optimistic
 * concurrency `version` numbers, plus the honest unsimulated Logo Upload state.
 *
 * @param {Object} authContext Verified ADMIN auth context.
 * @return {Object} Structured public and private settings with versions.
 */
function adminGetSettingsStep6_(authContext) {
  assertAdminRoleStep6_(authContext);

  var tbl = readSheetTable_('Settings');

  var schoolName = getSettingEntryWithVersion_(
    tbl,
    'SCHOOL_NAME',
    PB_APP_CONSTANTS_.SCHOOL_NAME_DEFAULT
  );
  var contactEmailRaw = getSettingEntryWithVersion_(tbl, 'CONTACT_EMAIL', '');
  var contactLineRaw = getSettingEntryWithVersion_(tbl, 'CONTACT_LINE_URL', '');
  var contactFbRaw = getSettingEntryWithVersion_(
    tbl,
    'CONTACT_FACEBOOK_URL',
    ''
  );
  var privacyVer = getSettingEntryWithVersion_(
    tbl,
    'CURRENT_PRIVACY_NOTICE_VERSION',
    PB_APP_CONSTANTS_.CURRENT_PRIVACY_NOTICE_VERSION_DEFAULT
  );
  var privacyDoc = getSettingEntryWithVersion_(
    tbl,
    'PRIVACY_NOTICE_DOCUMENT_TEXT',
    PB_DEFAULT_PRIVACY_NOTICE_DOCUMENT_TEXT_
  );

  var notifEmail = getSettingEntryWithVersion_(
    tbl,
    'ADMIN_NOTIFICATION_EMAIL',
    ''
  );
  var promptPayRaw = getSettingEntryWithVersion_(
    tbl,
    'PROMPTPAY_ID_DISPLAY',
    ''
  );
  var bankAccNameRaw = getSettingEntryWithVersion_(
    tbl,
    'BANK_ACCOUNT_NAME',
    ''
  );
  var bankNameRaw = getSettingEntryWithVersion_(tbl, 'BANK_NAME', '');
  var bankAccNumRaw = getSettingEntryWithVersion_(
    tbl,
    'BANK_ACCOUNT_NUMBER',
    ''
  );
  var logoOverride = getSettingEntryWithVersion_(tbl, 'LOGO_FILE_ID', '');
  var dekModeEntry = getSettingEntryWithVersion_(tbl, 'DEK_DISPLAY_MODE', 'AUTO_YEAR');
  var dekManualBaseEntry = getSettingEntryWithVersion_(tbl, 'DEK_MANUAL_BASE_NUMBER', '70');
  var portraitFileEntry = getSettingEntryWithVersion_(tbl, 'INSTRUCTOR_PORTRAIT_FILE_ID', '');
  var portraitVerifiedEntry = getSettingEntryWithVersion_(tbl, 'INSTRUCTOR_PROFILE_LAST_VERIFIED_AT', '');
  var pubDraftEntry = getSettingEntryWithVersion_(tbl, 'PUBLIC_CONTENT_DRAFT_JSON', '');
  var pubPublishedEntry = getSettingEntryWithVersion_(tbl, 'PUBLIC_CONTENT_PUBLISHED_JSON', '');

  /* Filter out initial seed placeholder strings so the Admin Settings form shows clean inputs */
  var cleanEmailVal =
    contactEmailRaw.value.indexOf('example.com') !== -1 ||
    contactEmailRaw.value.indexOf('placeholder') !== -1
      ? ''
      : contactEmailRaw.value;
  var cleanLineVal =
    contactLineRaw.value.indexOf('placeholder') !== -1
      ? ''
      : contactLineRaw.value;
  var cleanFbVal =
    contactFbRaw.value.indexOf('placeholder') !== -1 ? '' : contactFbRaw.value;
  var cleanPromptPayVal =
    promptPayRaw.value === '000-000-0000' ? '' : promptPayRaw.value;
  var cleanBankNameVal =
    bankNameRaw.value.indexOf('Placeholder') !== -1 ? '' : bankNameRaw.value;
  var cleanBankAccNameVal =
    bankAccNameRaw.value.indexOf('Placeholder') !== -1
      ? ''
      : bankAccNameRaw.value;
  var cleanBankAccNumVal =
    bankAccNumRaw.value === '000-0-00000-0' ? '' : bankAccNumRaw.value;

  var versionsMap = {
    SCHOOL_NAME: schoolName.version,
    CONTACT_EMAIL: contactEmailRaw.version,
    CONTACT_LINE_URL: contactLineRaw.version,
    CONTACT_FACEBOOK_URL: contactFbRaw.version,
    CURRENT_PRIVACY_NOTICE_VERSION: privacyVer.version,
    PRIVACY_NOTICE_DOCUMENT_TEXT: privacyDoc.version,
    ADMIN_NOTIFICATION_EMAIL: notifEmail.version,
    PROMPTPAY_ID_DISPLAY: promptPayRaw.version,
    BANK_ACCOUNT_NAME: bankAccNameRaw.version,
    BANK_NAME: bankNameRaw.version,
    BANK_ACCOUNT_NUMBER: bankAccNumRaw.version,
    LOGO_FILE_ID: logoOverride.version,
    DEK_DISPLAY_MODE: dekModeEntry.version,
    DEK_MANUAL_BASE_NUMBER: dekManualBaseEntry.version,
    INSTRUCTOR_PORTRAIT_FILE_ID: portraitFileEntry.version,
    INSTRUCTOR_PROFILE_LAST_VERIFIED_AT: portraitVerifiedEntry.version,
    PUBLIC_CONTENT_DRAFT_JSON: pubDraftEntry.version,
    PUBLIC_CONTENT_PUBLISHED_JSON: pubPublishedEntry.version
  };

  var logoDiag = loadValidatedSchoolLogo_(tbl, '').adminDiagnostics;
  var bkkYearNow = 2026;
  try {
    bkkYearNow =
      parseInt(
        Utilities.formatDate(new Date(), PB_APP_CONSTANTS_.TIMEZONE, 'yyyy'),
        10
      ) || 2026;
  } catch (ignoreYrErr) {
    bkkYearNow = 2026;
  }
  var dekConfigPreview =
    typeof calculatePublicDekCohortsPhase3_ === 'function'
      ? calculatePublicDekCohortsPhase3_(
          bkkYearNow,
          dekModeEntry.value || 'AUTO_YEAR',
          parseInt(dekManualBaseEntry.value || '70', 10) || 70
        )
      : null;
  var defaultPublicCopy =
    typeof getDefaultPublicWebsiteContentPhase3_ === 'function'
      ? getDefaultPublicWebsiteContentPhase3_(bkkYearNow)
      : {};
  var mergedPublishedCopy =
    typeof mergePublicWebsiteContentWithOverridesPhase6_ === 'function'
      ? mergePublicWebsiteContentWithOverridesPhase6_(
          defaultPublicCopy,
          pubPublishedEntry.value || '',
          dekConfigPreview
        )
      : defaultPublicCopy;
  var mergedDraftCopy =
    typeof mergePublicWebsiteContentWithOverridesPhase6_ === 'function'
      ? mergePublicWebsiteContentWithOverridesPhase6_(
          mergedPublishedCopy,
          pubDraftEntry.value || '',
          dekConfigPreview
        )
      : mergedPublishedCopy;
  var academicYearReviewStatus =
    typeof evaluateInstructorAcademicYearVerificationPhase6_ === 'function'
      ? evaluateInstructorAcademicYearVerificationPhase6_(
          portraitVerifiedEntry.value || ''
        )
      : {
          lastVerifiedAtUtc: portraitVerifiedEntry.value || '',
          daysSinceVerified: null,
          needsAnnualReview: !portraitVerifiedEntry.value,
          reminderMessage: ''
        };
  var portraitPreview =
    typeof loadValidatedInstructorPortraitPhase3_ === 'function'
      ? loadValidatedInstructorPortraitPhase3_(portraitFileEntry.value || '')
      : { configured: false, available: false, dataUri: '' };
  var heroCardsPreview = [];
  for (var hcIdx = 1; hcIdx <= 3; hcIdx++) {
    var hcEntry = getSettingEntryWithVersion_(tbl, 'HERO_CARD_' + String(hcIdx) + '_FILE_ID', '');
    var hcLoaded =
      typeof loadValidatedInstructorPortraitPhase3_ === 'function'
        ? loadValidatedInstructorPortraitPhase3_(hcEntry.value || '')
        : { configured: false, available: false, dataUri: '' };
    heroCardsPreview.push({
      slotIndex: hcIdx,
      fileId: hcEntry.value || '',
      version: hcEntry.version,
      configured: Boolean(hcLoaded && hcLoaded.configured),
      available: Boolean(hcLoaded && hcLoaded.available),
      dataUri: (hcLoaded && hcLoaded.dataUri) || '',
      mimeType: (hcLoaded && hcLoaded.mimeType) || ''
    });
  }

  return {
    publicSettings: {
      schoolName: schoolName.value || PB_APP_CONSTANTS_.SCHOOL_NAME_DEFAULT,
      contactEmail: cleanEmailVal,
      contactLineUrl: cleanLineVal,
      contactFacebookUrl: cleanFbVal,
      privacyNoticeVersion:
        privacyVer.value ||
        PB_APP_CONSTANTS_.CURRENT_PRIVACY_NOTICE_VERSION_DEFAULT,
      privacyNoticeDocumentText:
        privacyDoc.value || PB_DEFAULT_PRIVACY_NOTICE_DOCUMENT_TEXT_,
      dekDisplayMode:
        dekModeEntry.value === 'MANUAL_OVERRIDE' ? 'MANUAL_OVERRIDE' : 'AUTO_YEAR',
      dekManualBaseNumber: parseInt(dekManualBaseEntry.value || '70', 10) || 70,
      instructorPortraitFileId: portraitFileEntry.value || '',
      instructorProfileLastVerifiedAt: portraitVerifiedEntry.value || ''
    },
    publicWebsiteCms: {
      dekConfig: dekConfigPreview,
      defaultContent: defaultPublicCopy,
      publishedContent: mergedPublishedCopy,
      draftContent: mergedDraftCopy,
      hasUnpublishedDraft: Boolean(
        pubDraftEntry.value &&
          pubDraftEntry.value !== pubPublishedEntry.value
      ),
      rawDraftJson: pubDraftEntry.value || '',
      rawPublishedJson: pubPublishedEntry.value || '',
      instructorPortraitFileId: portraitFileEntry.value || '',
      instructorPortrait: portraitPreview,
      heroShuffleCards: heroCardsPreview,
      academicYearVerification: academicYearReviewStatus
    },
    privateSettings: {
      notificationRecipientEmail: notifEmail.value,
      promptPayTarget: cleanPromptPayVal,
      bankAccountName: cleanBankAccNameVal,
      bankName: cleanBankNameVal,
      bankAccountNumber: cleanBankAccNumVal,
      logoFileIdOverride: logoOverride.value
    },
    versions: versionsMap,
    logoUploadFeature: {
      uploadConnected: true,
      statusCode: 'CONNECTED_STEP_8_PRIVATE_DRIVE',
      maxFileBytes: 209715200,
      allowedFormats: ['image/png', 'image/jpeg', 'image/webp'],
      honestExplanation:
        'Connected in Step 8 (DriveService.gs): Administrators can upload a replacement PNG, JPEG, or WebP school logo (up to 2 MB, verified by binary magic bytes) into the private Google Drive folder and link its application file_id (fil_...) in Settings.LOGO_FILE_ID, or remove the override to restore DEFAULT_LOGO_DRIVE_FILE_ID.',
      logoDiagnostics: logoDiag
    },
    securitySeparationNote:
      'Public settings (schoolName, contactEmail, contactLineUrl, contactFacebookUrl, privacyNoticeVersion, privacyNoticeDocumentText) are included in public.getBootstrap. Private settings (notificationRecipientEmail, promptPayTarget, bankAccountName, bankName, bankAccountNumber) are strictly withheld from public.getBootstrap and require ADMIN authentication.'
  };
}
/**
 * Validates and saves Public and Private School Settings (`admin.updateSettings` / `admin.updateSchoolSettings`).
 * Enforces:
 * - `ADMIN` role verification.
 * - URL (`https://`), email, PromptPay target, bank details, and Privacy Notice version/document validation.
 * - Optimistic concurrency (`expectedVersions` per setting key) with a clear human-readable conflict
 *   explanation if another administrator modified any setting since this administrator loaded the form.
 * - Audit logging without credentials.
 *
 * @param {Object} authContext Verified ADMIN auth context.
 * @param {Object} payload Settings update payload.
 * @return {Object} Updated settings snapshot and version map.
 */
function adminUpdateSettingsStep6_(authContext, payload) {
  var adminUser = assertAdminRoleStep6_(authContext);
  if (!payload || typeof payload !== 'object') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Settings payload must be a valid object.'
    );
  }

  var fieldErrors = {};
  var updatesToApply = [];

  /* 1. School Name */
  if (payload.schoolName !== undefined) {
    var schoolNameVal = String(payload.schoolName || '').trim();
    if (schoolNameVal.length < 2 || schoolNameVal.length > 100) {
      fieldErrors.schoolName = 'School name must be between 2 and 100 characters.';
    } else {
      updatesToApply.push({ key: 'SCHOOL_NAME', value: schoolNameVal });
    }
  }

  /* 2. Public Contact Email */
  if (payload.contactEmail !== undefined) {
    var pubEmailVal = String(payload.contactEmail || '').trim();
    if (
      pubEmailVal !== '' &&
      (pubEmailVal.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pubEmailVal))
    ) {
      fieldErrors.contactEmail =
        'Public contact email must be a valid email address (e.g., contact@pattanabhumi.org) or left blank.';
    } else {
      updatesToApply.push({ key: 'CONTACT_EMAIL', value: pubEmailVal });
    }
  }

  /* 3. LINE Contact URL */
  if (payload.contactLineUrl !== undefined) {
    var lineVal = String(payload.contactLineUrl || '').trim();
    if (
      lineVal !== '' &&
      (lineVal.length > 500 || !/^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\/\S*)?$/i.test(lineVal))
    ) {
      fieldErrors.contactLineUrl =
        'LINE contact URL must be a valid https:// URL (e.g., https://line.me/R/ti/p/@school) or left blank.';
    } else {
      updatesToApply.push({ key: 'CONTACT_LINE_URL', value: lineVal });
    }
  }

  /* 4. Facebook Page URL */
  if (payload.contactFacebookUrl !== undefined) {
    var fbVal = String(payload.contactFacebookUrl || '').trim();
    if (
      fbVal !== '' &&
      (fbVal.length > 500 || !/^https:\/\/[A-Za-z0-9.-]+\.[A-Za-z]{2,}(\/\S*)?$/i.test(fbVal))
    ) {
      fieldErrors.contactFacebookUrl =
        'Facebook page URL must be a valid https:// URL (e.g., https://www.facebook.com/pattanabhumi) or left blank.';
    } else {
      updatesToApply.push({ key: 'CONTACT_FACEBOOK_URL', value: fbVal });
    }
  }

  /* 5. Notification Recipient Email (Private Setting) */
  if (payload.notificationRecipientEmail !== undefined) {
    var notifVal = String(payload.notificationRecipientEmail || '').trim();
    if (
      notifVal !== '' &&
      (notifVal.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notifVal))
    ) {
      fieldErrors.notificationRecipientEmail =
        'Notification recipient email must be a valid email address or left blank.';
    } else {
      updatesToApply.push({
        key: 'ADMIN_NOTIFICATION_EMAIL',
        value: notifVal
      });
    }
  }

  /* 6. PromptPay Target (Private Setting) */
  if (payload.promptPayTarget !== undefined) {
    var ppVal = String(payload.promptPayTarget || '').trim();
    var ppDigitsOnly = ppVal.replace(/[\s-]/g, '');
    if (
      ppVal !== '' &&
      !/^[0-9]{10,15}$/.test(ppDigitsOnly) &&
      !/^[A-Za-z0-9._@-]{5,64}$/.test(ppVal)
    ) {
      fieldErrors.promptPayTarget =
        'PromptPay target must be a valid Thai mobile number (10 digits), National/Tax ID (13 digits), e-Wallet ID (15 digits), or left blank.';
    } else {
      updatesToApply.push({ key: 'PROMPTPAY_ID_DISPLAY', value: ppVal });
    }
  }

  /* 7. Bank Account Name (Private Setting) */
  if (payload.bankAccountName !== undefined) {
    var bAccName = String(payload.bankAccountName || '').trim();
    if (bAccName.length > 140) {
      fieldErrors.bankAccountName =
        'Bank account name must not exceed 140 characters.';
    } else {
      updatesToApply.push({ key: 'BANK_ACCOUNT_NAME', value: bAccName });
    }
  }

  /* 8. Bank Name (Private Setting) */
  if (payload.bankName !== undefined) {
    var bName = String(payload.bankName || '').trim();
    if (bName.length > 120) {
      fieldErrors.bankName = 'Bank name must not exceed 120 characters.';
    } else {
      updatesToApply.push({ key: 'BANK_NAME', value: bName });
    }
  }

  /* 9. Bank Account Number (Private Setting) */
  if (payload.bankAccountNumber !== undefined) {
    var bAccNum = String(payload.bankAccountNumber || '').trim();
    if (bAccNum !== '' && !/^[0-9][0-9\s-]{5,24}[0-9]$/.test(bAccNum)) {
      fieldErrors.bankAccountNumber =
        'Bank account number must contain 7 to 26 digits/hyphens (e.g., 123-4-56789-0) or be left blank.';
    } else {
      updatesToApply.push({ key: 'BANK_ACCOUNT_NUMBER', value: bAccNum });
    }
  }

  /* 10. Privacy Notice Version */
  if (payload.privacyNoticeVersion !== undefined) {
    var verVal = String(payload.privacyNoticeVersion || '').trim();
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(verVal)) {
      fieldErrors.privacyNoticeVersion =
        'Privacy Notice version must be 3 to 40 characters using letters, numbers, dots, underscores, or hyphens (e.g., 2026-10-v1).';
    } else {
      updatesToApply.push({
        key: 'CURRENT_PRIVACY_NOTICE_VERSION',
        value: verVal
      });
    }
  }

  /* 11. Privacy Notice Document Text */
  if (payload.privacyNoticeDocumentText !== undefined) {
    var docVal = String(payload.privacyNoticeDocumentText || '').trim();
    if (docVal.length < 40) {
      fieldErrors.privacyNoticeDocumentText =
        'Privacy Notice document text must be at least 40 characters so students receive a meaningful disclosure.';
    } else if (docVal.length > 25000) {
      fieldErrors.privacyNoticeDocumentText =
        'Privacy Notice document text must not exceed 25,000 characters (Google Sheets cell safety ceiling).';
    } else {
      updatesToApply.push({
        key: 'PRIVACY_NOTICE_DOCUMENT_TEXT',
        value: docVal
      });
    }
  }

  /* 12. Optional Logo File ID Override (Preserve existing unless explicitly passed) */
  if (payload.logoFileIdOverride !== undefined) {
    var rawLogoInput = String(payload.logoFileIdOverride || '').trim();
    var extractedLogoId = extractDriveFileIdFromInput_(rawLogoInput);
    if (
      extractedLogoId !== '' &&
      !/^[A-Za-z0-9_-]{8,120}$/.test(extractedLogoId)
    ) {
      fieldErrors.logoFileIdOverride =
        'Replacement Logo Drive File ID must be a valid Google Drive File ID or Drive link (or left blank to use DEFAULT_LOGO_DRIVE_FILE_ID).';
    } else {
      updatesToApply.push({ key: 'LOGO_FILE_ID', value: extractedLogoId });
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'One or more school settings failed validation. Please review the highlighted fields.',
      fieldErrors
    );
  }

  var expectedVersions =
    payload.expectedVersions && typeof payload.expectedVersions === 'object'
      ? payload.expectedVersions
      : null;

  return withScriptLock_(function () {
    var tbl = readSheetTable_('Settings');
    var nowIso = nowUtcIso_();
    var actorId = adminUser.user_id;

    /* First pass: verify optimistic concurrency (`expectedVersions`) across all keys being updated
       BEFORE mutating any row so a conflict never leaves a half-updated Settings sheet. */
    if (expectedVersions) {
      var conflictDetails = {};
      for (var c = 0; c < updatesToApply.length; c++) {
        var checkItem = updatesToApply[c];
        if (
          Object.prototype.hasOwnProperty.call(expectedVersions, checkItem.key)
        ) {
          var clientExpectedVer = Number(expectedVersions[checkItem.key]);
          var existingHit = tbl.byId[checkItem.key];
          var storedVer = existingHit ? Number(existingHit.record.version) : 0;
          if (
            isFinite(clientExpectedVer) &&
            clientExpectedVer !== storedVer
          ) {
            conflictDetails[checkItem.key] =
              'Expected version ' +
              String(clientExpectedVer) +
              ', but server has version ' +
              String(storedVer) +
              (existingHit && existingHit.record.updated_by_user_id
                ? ' (last updated by ' +
                  existingHit.record.updated_by_user_id +
                  ' at ' +
                  existingHit.record.updated_at_utc +
                  ')'
                : '');
          }
        }
      }

      if (Object.keys(conflictDetails).length > 0) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
          'Settings Save Blocked (Stale Record Version Detected): Another administrator updated School Settings after you loaded this page. Your changes were not saved to prevent silently overwriting their updates. Please click "Reload Settings" to view the latest values and re-apply your edits.',
          conflictDetails
        );
      }
    }

    var changedKeys = [];
    for (var i = 0; i < updatesToApply.length; i++) {
      var item = updatesToApply[i];
      var existingEntry = tbl.byId[item.key] ? tbl.byId[item.key].record : null;
      if (existingEntry) {
        updateSheetRecordById_(
          'Settings',
          item.key,
          {
            setting_value: item.value,
            updated_by_user_id: actorId,
            updated_at_utc: nowIso
          },
          Number(existingEntry.version),
          { skipLock: true }
        );
      } else {
        insertSheetRecord_(
          'Settings',
          {
            setting_key: item.key,
            setting_value: item.value,
            updated_by_user_id: actorId,
            updated_at_utc: nowIso
          },
          { skipLock: true }
        );
      }
      changedKeys.push(item.key);
    }

    recordAuditEvent_({
      actorUserId: actorId,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_SETTINGS_UPDATED',
      targetEntityType: 'Setting',
      targetEntityId: 'SCHOOL_SETTINGS',
      summary: {
        updatedKeys: changedKeys,
        privacyNoticeVersion: getCurrentPrivacyNoticeVersion_()
      }
    });

    if (typeof invalidateSchoolLogoCache_ === 'function') {
      invalidateSchoolLogoCache_();
    }

    var refreshed = adminGetSettingsStep6_(authContext);
    refreshed.updatedCount = changedKeys.length;
    refreshed.updatedKeys = changedKeys;
    refreshed.currentPrivacyNoticeVersion =
      refreshed.publicSettings.privacyNoticeVersion;
    refreshed.updatedAtUtc = nowIso;
    refreshed.updatedAtBangkok = formatBangkokTimestamp_(nowIso);
    return refreshed;
  });
}

/**
 * Counts how many usable (`role === 'ADMIN'` and `status === 'ACTIVE'`) administrator
 * accounts currently exist in the `Users` table, optionally excluding one `user_id`
 * to test whether demoting, suspending, archiving, or deleting that user would leave
 * zero usable administrators.
 *
 * @param {Object} usersTable Pre-read `Users` table.
 * @param {string=} opt_excludeUserId User ID to exclude from the usable admin count.
 * @return {number} Count of usable active administrators.
 */

/**
 * Phase 6: Dedicated Administrator RPC handler (`admin.savePublicWebsiteContent`) for managing
 * the Public Website CMS, Dynamic DEK Cohort Mode (`AUTO_YEAR` vs `MANUAL_OVERRIDE`),
 * Instructor Profile copy, Instructor Portrait file reference, and the annual "4th Year"
 * academic credential verification timestamp.
 *
 * Supported `mode` values:
 * - `'SAVE_DRAFT'`: Saves customizable public content overrides into `PUBLIC_CONTENT_DRAFT_JSON`
 *   (and updates DEK settings if provided) without altering `PUBLIC_CONTENT_PUBLISHED_JSON`.
 * - `'PUBLISH'`: Publishes the validated overrides into both `PUBLIC_CONTENT_PUBLISHED_JSON`
 *   and `PUBLIC_CONTENT_DRAFT_JSON`, updates DEK settings, and records an audit event.
 * - `'RESET_DEFAULT'`: Clears both `PUBLIC_CONTENT_DRAFT_JSON` and `PUBLIC_CONTENT_PUBLISHED_JSON`
 *   and restores `DEK_DISPLAY_MODE = 'AUTO_YEAR'` so the live website uses the exact default owner copy.
 * - `'VERIFY_INSTRUCTOR_YEAR'`: Updates `INSTRUCTOR_PROFILE_LAST_VERIFIED_AT` to the current UTC
 *   timestamp and clears the 180-day academic year review reminder.
 *
 * @param {Object} authContext Verified ADMIN auth context.
 * @param {Object} payload CMS action payload.
 * @return {Object} Refreshed settings and CMS state.
 */
function adminSavePublicWebsiteContentPhase6_(authContext, payload) {
  var adminUser = assertAdminRoleStep6_(authContext);
  var req = payload && typeof payload === 'object' ? payload : {};
  var mode = String(req.mode || 'PUBLISH')
    .trim()
    .toUpperCase();
  if (
    mode !== 'SAVE_DRAFT' &&
    mode !== 'PUBLISH' &&
    mode !== 'RESET_DEFAULT' &&
    mode !== 'VERIFY_INSTRUCTOR_YEAR'
  ) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Unsupported CMS save mode "' +
        mode +
        '". Expected SAVE_DRAFT, PUBLISH, RESET_DEFAULT, or VERIFY_INSTRUCTOR_YEAR.',
      { mode: 'Invalid CMS mode.' }
    );
  }

  var fieldErrors = {};
  var dekDisplayMode =
    req.dekDisplayMode !== undefined
      ? String(req.dekDisplayMode || '')
          .trim()
          .toUpperCase()
      : null;
  if (
    dekDisplayMode !== null &&
    dekDisplayMode !== 'AUTO_YEAR' &&
    dekDisplayMode !== 'MANUAL_OVERRIDE'
  ) {
    fieldErrors.dekDisplayMode =
      'DEK cohort mode must be AUTO_YEAR or MANUAL_OVERRIDE.';
  }

  var dekManualBase = null;
  if (req.dekManualBaseNumber !== undefined && req.dekManualBaseNumber !== null && String(req.dekManualBaseNumber).trim() !== '') {
    var parsedDek = Number(req.dekManualBaseNumber);
    if (!isFinite(parsedDek) || parsedDek < 60 || parsedDek > 150 || Math.floor(parsedDek) !== parsedDek) {
      fieldErrors.dekManualBaseNumber =
        'Manual starting DEK cohort number must be an integer between 60 and 150 (e.g. 70 for DEK70, DEK71, DEK72).';
    } else {
      dekManualBase = parsedDek;
    }
  }

  var contentInput =
    req.contentOverrides && typeof req.contentOverrides === 'object'
      ? req.contentOverrides
      : req;

  function validateOptText(val, fieldKey, label, minLen, maxLen) {
    if (val === undefined || val === null) {
      return '';
    }
    var s = String(val)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
    if (s.length > 0 && s.length < minLen) {
      fieldErrors[fieldKey] =
        label + ' must be at least ' + String(minLen) + ' characters (or left blank to use default).';
    } else if (s.length > maxLen) {
      fieldErrors[fieldKey] =
        label + ' must not exceed ' + String(maxLen) + ' characters.';
    }
    return s;
  }

  var cleanOverridesObj = null;
  if (mode === 'SAVE_DRAFT' || mode === 'PUBLISH') {
    var heroEyebrow = validateOptText(
      contentInput.heroEyebrow,
      'heroEyebrow',
      'Hero eyebrow badge',
      3,
      140
    );
    var heroLead = validateOptText(
      contentInput.heroLead,
      'heroLead',
      'Hero welcome lead paragraph',
      15,
      600
    );
    var aboutSubtitle = validateOptText(
      contentInput.aboutSubtitle,
      'aboutSubtitle',
      'About Us subtitle',
      5,
      180
    );
    var aboutP1 = validateOptText(
      contentInput.aboutParagraph1,
      'aboutParagraph1',
      'About Us paragraph 1',
      20,
      1000
    );
    var aboutP2 = validateOptText(
      contentInput.aboutParagraph2,
      'aboutParagraph2',
      'About Us paragraph 2',
      20,
      1000
    );
    var aboutP3 = validateOptText(
      contentInput.aboutParagraph3,
      'aboutParagraph3',
      'About Us paragraph 3',
      20,
      1000
    );
    var instHeadline = validateOptText(
      contentInput.instructorHeadlineBadge,
      'instructorHeadlineBadge',
      'Instructor headline achievement badge',
      5,
      160
    );
    var instEducation = validateOptText(
      contentInput.instructorEducation,
      'instructorEducation',
      'Instructor education credential',
      10,
      240
    );
    var instExperience = validateOptText(
      contentInput.instructorTeachingExperience,
      'instructorTeachingExperience',
      'Instructor teaching experience',
      15,
      600
    );

    var rawAwardsInput = contentInput.instructorAwards;
    var cleanAwardsList = [];
    if (Array.isArray(rawAwardsInput)) {
      for (var a = 0; a < Math.min(rawAwardsInput.length, 8); a++) {
        var line = String(rawAwardsInput[a] || '').trim();
        if (line) {
          if (line.length > 240) {
            fieldErrors.instructorAwards =
              'Each instructor award line must not exceed 240 characters.';
          } else {
            cleanAwardsList.push(line);
          }
        }
      }
    } else if (typeof rawAwardsInput === 'string' && rawAwardsInput.trim()) {
      var lines = rawAwardsInput.split(/\r?\n/);
      for (var l = 0; l < Math.min(lines.length, 8); l++) {
        var ln = String(lines[l] || '').trim();
        if (ln) {
          if (ln.length > 240) {
            fieldErrors.instructorAwards =
              'Each instructor award line must not exceed 240 characters.';
          } else {
            cleanAwardsList.push(ln);
          }
        }
      }
    }

    cleanOverridesObj = {
      heroEyebrow: heroEyebrow,
      heroLead: heroLead,
      aboutSubtitle: aboutSubtitle,
      aboutParagraph1: aboutP1,
      aboutParagraph2: aboutP2,
      aboutParagraph3: aboutP3,
      instructorHeadlineBadge: instHeadline,
      instructorEducation: instEducation,
      instructorTeachingExperience: instExperience,
      instructorAwards: cleanAwardsList
    };
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please review the highlighted Public Website CMS fields.',
      fieldErrors
    );
  }

  return withScriptLock_(function () {
    var tbl = readSheetTable_('Settings');
    var nowIso = nowUtcIso_();
    var actorId = adminUser.user_id || adminUser.userId;

    function upsertSettingKeyInLock(key, valStr) {
      var hit = tbl.byId[key] ? tbl.byId[key].record : null;
      if (hit) {
        updateSheetRecordById_(
          'Settings',
          key,
          {
            setting_value: valStr,
            updated_by_user_id: actorId,
            updated_at_utc: nowIso
          },
          Number(hit.version),
          { skipLock: true }
        );
      } else {
        insertSheetRecord_(
          'Settings',
          {
            setting_key: key,
            setting_value: valStr,
            updated_by_user_id: actorId,
            updated_at_utc: nowIso,
            version: 1
          },
          { skipLock: true }
        );
      }
      tbl = readSheetTable_('Settings');
    }

    var changedKeys = [];

    if (mode === 'RESET_DEFAULT') {
      upsertSettingKeyInLock('PUBLIC_CONTENT_DRAFT_JSON', '');
      upsertSettingKeyInLock('PUBLIC_CONTENT_PUBLISHED_JSON', '');
      upsertSettingKeyInLock('DEK_DISPLAY_MODE', 'AUTO_YEAR');
      upsertSettingKeyInLock('DEK_MANUAL_BASE_NUMBER', '70');
      changedKeys.push(
        'PUBLIC_CONTENT_DRAFT_JSON',
        'PUBLIC_CONTENT_PUBLISHED_JSON',
        'DEK_DISPLAY_MODE',
        'DEK_MANUAL_BASE_NUMBER'
      );
    } else if (mode === 'VERIFY_INSTRUCTOR_YEAR') {
      upsertSettingKeyInLock('INSTRUCTOR_PROFILE_LAST_VERIFIED_AT', nowIso);
      changedKeys.push('INSTRUCTOR_PROFILE_LAST_VERIFIED_AT');
    } else {
      if (dekDisplayMode !== null) {
        upsertSettingKeyInLock('DEK_DISPLAY_MODE', dekDisplayMode);
        changedKeys.push('DEK_DISPLAY_MODE');
      }
      if (dekManualBase !== null) {
        upsertSettingKeyInLock('DEK_MANUAL_BASE_NUMBER', String(dekManualBase));
        changedKeys.push('DEK_MANUAL_BASE_NUMBER');
      }
      var serializedJson = JSON.stringify(cleanOverridesObj);
      upsertSettingKeyInLock('PUBLIC_CONTENT_DRAFT_JSON', serializedJson);
      changedKeys.push('PUBLIC_CONTENT_DRAFT_JSON');

      if (mode === 'PUBLISH') {
        upsertSettingKeyInLock('PUBLIC_CONTENT_PUBLISHED_JSON', serializedJson);
        changedKeys.push('PUBLIC_CONTENT_PUBLISHED_JSON');
        if (req.markAcademicYearVerified === true) {
          upsertSettingKeyInLock('INSTRUCTOR_PROFILE_LAST_VERIFIED_AT', nowIso);
          changedKeys.push('INSTRUCTOR_PROFILE_LAST_VERIFIED_AT');
        }
      }
    }

    recordAuditEvent_({
      actorUserId: actorId,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_PUBLIC_WEBSITE_CMS_' + mode,
      targetEntityType: 'Setting',
      targetEntityId: 'PUBLIC_WEBSITE_CMS',
      summary: {
        mode: mode,
        updatedKeys: changedKeys
      }
    });

    var refreshed = adminGetSettingsStep6_(authContext);
    refreshed.cmsModeExecuted = mode;
    refreshed.updatedKeys = changedKeys;
    refreshed.updatedAtUtc = nowIso;
    refreshed.updatedAtBangkok = formatBangkokTimestamp_(nowIso);
    refreshed.savedMessage =
      mode === 'SAVE_DRAFT'
        ? 'Public website draft saved. Click "Preview Draft on Home Page" to inspect before publishing.'
        : mode === 'PUBLISH'
        ? 'Published updated Public Website content and DEK cohort settings to the live Home Page.'
        : mode === 'RESET_DEFAULT'
        ? 'Reset Public Website content and DEK cohort mode to the default owner-supplied copy.'
        : 'Marked instructor academic year credential ("4th Year...") as verified today.';
    return refreshed;
  });
}

function countUsableAdministrators_(usersTable, opt_excludeUserId) {
  if (!usersTable || !Array.isArray(usersTable.records)) {
    return 0;
  }
  var count = 0;
  for (var i = 0; i < usersTable.records.length; i++) {
    var u = usersTable.records[i];
    if (opt_excludeUserId && u.user_id === opt_excludeUserId) {
      continue;
    }
    if (u.role === 'ADMIN' && u.status === 'ACTIVE') {
      count += 1;
    }
  }
  return count;
}
/**
 * Inspects `Invoices` and `Payments` tables to determine whether a user has any
 * financial references. Users with financial references must never be hard-deleted.
 *
 * @param {string} userId Target `Users.user_id`.
 * @param {Object=} opt_invoicesTable Optional pre-read `Invoices` table.
 * @param {Object=} opt_paymentsTable Optional pre-read `Payments` table.
 * @return {{ hasFinancialReferences: boolean, invoiceCount: number, paymentCount: number, reviewedPaymentCount: number }}
 */
function getUserFinancialReferenceSummary_(
  userId,
  opt_invoicesTable,
  opt_paymentsTable
) {
  var invTbl = opt_invoicesTable || null;
  var payTbl = opt_paymentsTable || null;
  if (!invTbl) {
    try {
      invTbl = readSheetTable_('Invoices');
    } catch (ignoreInvErr) {}
  }
  if (!payTbl) {
    try {
      payTbl = readSheetTable_('Payments');
    } catch (ignorePayErr) {}
  }

  var invoiceCount = 0;
  var paymentCount = 0;
  var reviewedPaymentCount = 0;

  if (invTbl && Array.isArray(invTbl.records)) {
    for (var i = 0; i < invTbl.records.length; i++) {
      if (invTbl.records[i].user_id === userId) {
        invoiceCount += 1;
      }
    }
  }

  if (payTbl && Array.isArray(payTbl.records)) {
    for (var j = 0; j < payTbl.records.length; j++) {
      var p = payTbl.records[j];
      if (p.user_id === userId) {
        paymentCount += 1;
      }
      if (p.reviewed_by_user_id === userId) {
        reviewedPaymentCount += 1;
      }
    }
  }

  var totalRefs = invoiceCount + paymentCount + reviewedPaymentCount;
  return {
    hasFinancialReferences: totalRefs > 0,
    invoiceCount: invoiceCount,
    paymentCount: paymentCount,
    reviewedPaymentCount: reviewedPaymentCount
  };
}
/**
 * Ensures at least 3 biology courses exist in the `Courses` sheet so administrators can
 * prepare real course assignments (`Enrollments`) for students in Step 6.
 *
 * @param {string} actorUserId Admin user ID for `created_at_utc` metadata.
 * @return {Array<Object>} Array of course summaries `{ courseId, courseCode, title, subtitle, status, sortOrder, version }`.
 */
function ensureDefaultCatalogCoursesForEnrollments_(actorUserId) {
  var coursesTbl = readSheetTable_('Courses');
  if (coursesTbl.records.length === 0) {
    var nowIso = nowUtcIso_();
    var defaultCourses = [
      {
        course_code: 'BIO-M4-CELL',
        title: 'M.4 Cellular Biology & Biomolecules',
        subtitle: 'Cell structure, membrane transport, enzymes, and cellular respiration',
        status: 'PUBLISHED',
        sort_order: 10,
        calendar_tag: '[BIO-M4-CELL]'
      },
      {
        course_code: 'BIO-M5-PHYS',
        title: 'M.5 Human & Plant Physiology',
        subtitle: 'Circulatory, nervous, endocrine, and plant transport systems',
        status: 'PUBLISHED',
        sort_order: 20,
        calendar_tag: '[BIO-M5-PHYS]'
      },
      {
        course_code: 'BIO-M6-GENE',
        title: 'M.6 Genetics, Evolution & A-Level Intensive',
        subtitle: 'Molecular genetics, population genetics, ecology, and exam problem solving',
        status: 'PUBLISHED',
        sort_order: 30,
        calendar_tag: '[BIO-M6-GENE]'
      }
    ];

    for (var i = 0; i < defaultCourses.length; i++) {
      var c = defaultCourses[i];
      insertSheetRecord_(
        'Courses',
        {
          course_id: generateEntityId_('crs_'),
          course_code: c.course_code,
          title: c.title,
          subtitle: c.subtitle,
          cover_file_id: '',
          status: c.status,
          sort_order: c.sort_order,
          objectives_richtext_json: '',
          outcomes_richtext_json: '',
          assessment_updated_at_utc: nowIso,
          reading_updated_at_utc: nowIso,
          calendar_tag: c.calendar_tag,
          created_at_utc: nowIso,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );
    }
    coursesTbl = readSheetTable_('Courses');
  }

  var catalog = [];
  for (var j = 0; j < coursesTbl.records.length; j++) {
    var row = coursesTbl.records[j];
    if (row.status !== 'ARCHIVED') {
      catalog.push({
        courseId: row.course_id,
        courseCode: row.course_code,
        title: row.title,
        subtitle: row.subtitle || '',
        status: row.status,
        sortOrder: Number(row.sort_order || 0),
        version: Number(row.version || 1)
      });
    }
  }
  catalog.sort(function (a, b) {
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    return String(a.courseCode).localeCompare(String(b.courseCode));
  });
  return catalog;
}
/**
 * Synchronizes a user's active course assignments in the `Enrollments` worksheet using
 * real enrollment records (`enr_...` rows with `status: 'ACTIVE'` or `'REVOKED'`).
 *
 * @param {string} targetUserId Student (or user) `user_id`.
 * @param {Array<string>} desiredCourseIds Array of `course_id` strings that should be `ACTIVE`.
 * @param {string} actorAdminUserId Administrator `user_id` performing the assignment.
 * @return {{ activeCourseIds: Array<string>, activeEnrollments: Array<Object>, newlyAssignedCount: number, reactivatedCount: number, revokedCount: number }}
 */
function syncUserCourseEnrollmentsInternal_(
  targetUserId,
  desiredCourseIds,
  actorAdminUserId
) {
  var coursesTbl = readSheetTable_('Courses');
  var enrollmentsTbl = readSheetTable_('Enrollments');
  var nowIso = nowUtcIso_();

  var cleanDesiredMap = {};
  var cleanDesiredList = [];
  if (Array.isArray(desiredCourseIds)) {
    for (var i = 0; i < desiredCourseIds.length; i++) {
      var cid = String(desiredCourseIds[i] || '').trim();
      if (!cid || cleanDesiredMap[cid]) {
        continue;
      }
      var courseHit = coursesTbl.byId[cid];
      if (!courseHit || courseHit.record.status === 'ARCHIVED') {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Course ID "' + cid + '" does not exist or is archived.',
          { assignedCourseIds: 'Unknown or archived course ID: ' + cid }
        );
      }
      cleanDesiredMap[cid] = true;
      cleanDesiredList.push(cid);
    }
  }

  /* Map existing Enrollments for this user by course_id */
  var existingByCourseId = {};
  for (var j = 0; j < enrollmentsTbl.records.length; j++) {
    var enr = enrollmentsTbl.records[j];
    if (enr.user_id === targetUserId) {
      existingByCourseId[enr.course_id] = enr;
    }
  }

  var newlyAssignedCount = 0;
  var reactivatedCount = 0;
  var revokedCount = 0;

  /* 1. Activate or insert desired courses */
  for (var k = 0; k < cleanDesiredList.length; k++) {
    var targetCourseId = cleanDesiredList[k];
    var existingEnr = existingByCourseId[targetCourseId];
    if (!existingEnr) {
      insertSheetRecord_(
        'Enrollments',
        {
          enrollment_id: generateEntityId_('enr_'),
          user_id: targetUserId,
          course_id: targetCourseId,
          status: 'ACTIVE',
          assigned_by_user_id: actorAdminUserId,
          assigned_at_utc: nowIso,
          updated_at_utc: nowIso
        },
        { skipLock: true }
      );
      newlyAssignedCount += 1;
    } else if (existingEnr.status !== 'ACTIVE') {
      updateSheetRecordById_(
        'Enrollments',
        existingEnr.enrollment_id,
        {
          status: 'ACTIVE',
          assigned_by_user_id: actorAdminUserId,
          assigned_at_utc: nowIso,
          updated_at_utc: nowIso
        },
        Number(existingEnr.version),
        { skipLock: true }
      );
      reactivatedCount += 1;
    }
  }

  /* 2. Revoke any previously ACTIVE enrollment that is no longer in desiredCourseIds */
  var existingCourseKeys = Object.keys(existingByCourseId);
  for (var m = 0; m < existingCourseKeys.length; m++) {
    var cKey = existingCourseKeys[m];
    var enrRow = existingByCourseId[cKey];
    if (enrRow.status === 'ACTIVE' && !cleanDesiredMap[cKey]) {
      updateSheetRecordById_(
        'Enrollments',
        enrRow.enrollment_id,
        {
          status: 'REVOKED',
          updated_at_utc: nowIso
        },
        Number(enrRow.version),
        { skipLock: true }
      );
      revokedCount += 1;
    }
  }

  /* 3. Re-read Enrollments for this user to return authoritative active enrollment records */
  var updatedEnrollmentsTbl = readSheetTable_('Enrollments');
  var activeEnrollments = [];
  var activeCourseIds = [];
  for (var n = 0; n < updatedEnrollmentsTbl.records.length; n++) {
    var rec = updatedEnrollmentsTbl.records[n];
    if (rec.user_id === targetUserId && rec.status === 'ACTIVE') {
      var cObj = coursesTbl.byId[rec.course_id]
        ? coursesTbl.byId[rec.course_id].record
        : null;
      activeCourseIds.push(rec.course_id);
      activeEnrollments.push({
        enrollmentId: rec.enrollment_id,
        courseId: rec.course_id,
        courseCode: cObj ? cObj.course_code : rec.course_id,
        courseTitle: cObj ? cObj.title : rec.course_id,
        status: rec.status,
        assignedByUserId: rec.assigned_by_user_id || '',
        assignedAtUtc: rec.assigned_at_utc,
        assignedAtBangkok: rec.assigned_at_utc
          ? formatBangkokTimestamp_(rec.assigned_at_utc)
          : '',
        version: Number(rec.version || 1)
      });
    }
  }

  return {
    activeCourseIds: activeCourseIds,
    activeEnrollments: activeEnrollments,
    newlyAssignedCount: newlyAssignedCount,
    reactivatedCount: reactivatedCount,
    revokedCount: revokedCount
  };
}
/**
 * Builds a sanitized, credential-free user record for the Admin Users table & editor.
 * NEVER includes `password_hash` or any secret material.
 */
function buildAdminUserListItem_(
  userRecord,
  currentPrivacyNoticeVersion,
  enrollmentsByUserMap,
  coursesByIdMap,
  privacyStatsByUserMap,
  financialRefsByUserMap,
  usableAdminCount
) {
  var uid = userRecord.user_id;
  var userEnrs = enrollmentsByUserMap[uid] || [];
  var activeEnrollments = [];
  var assignedCourseIds = [];

  for (var i = 0; i < userEnrs.length; i++) {
    var e = userEnrs[i];
    if (e.status === 'ACTIVE') {
      var courseRec = coursesByIdMap[e.course_id]
        ? coursesByIdMap[e.course_id].record
        : null;
      assignedCourseIds.push(e.course_id);
      activeEnrollments.push({
        enrollmentId: e.enrollment_id,
        courseId: e.course_id,
        courseCode: courseRec ? courseRec.course_code : e.course_id,
        courseTitle: courseRec ? courseRec.title : e.course_id,
        status: e.status,
        assignedAtUtc: e.assigned_at_utc,
        assignedAtBangkok: e.assigned_at_utc
          ? formatBangkokTimestamp_(e.assigned_at_utc)
          : '',
        version: Number(e.version || 1)
      });
    }
  }

  var prvStat = privacyStatsByUserMap[uid] || {
    historyCount: 0,
    lastAckAtUtc: '',
    lastMarketingUpdatedAtUtc: ''
  };

  var finRef = financialRefsByUserMap[uid] || {
    hasFinancialReferences: false,
    invoiceCount: 0,
    paymentCount: 0,
    reviewedPaymentCount: 0
  };

  var isLastUsableAdmin =
    userRecord.role === 'ADMIN' &&
    userRecord.status === 'ACTIVE' &&
    usableAdminCount <= 1;

  return {
    userId: uid,
    username: userRecord.username_display || userRecord.username_lower,
    usernameLower: userRecord.username_lower,
    email: userRecord.email,
    fullName: userRecord.full_name,
    role: userRecord.role,
    status: userRecord.status,
    lastLoginAtUtc: userRecord.last_login_at_utc || null,
    lastLoginAtBangkok: userRecord.last_login_at_utc
      ? formatBangkokTimestamp_(userRecord.last_login_at_utc)
      : 'Never logged in',
    passwordUpdatedAtUtc: userRecord.password_updated_at_utc || null,
    passwordUpdatedAtBangkok: userRecord.password_updated_at_utc
      ? formatBangkokTimestamp_(userRecord.password_updated_at_utc)
      : '',
    privacyAckVersion: userRecord.privacy_ack_version || '',
    requiredPrivacyNoticeVersion: currentPrivacyNoticeVersion,
    requiresPrivacyAck:
      String(userRecord.privacy_ack_version || '').trim() !==
      currentPrivacyNoticeVersion,
    privacyHistoryCount: prvStat.historyCount,
    privacyLastAckAtBangkok: prvStat.lastAckAtUtc
      ? formatBangkokTimestamp_(prvStat.lastAckAtUtc)
      : '',
    marketingOptIn: Boolean(userRecord.marketing_opt_in),
    marketingUpdatedAtBangkok: prvStat.lastMarketingUpdatedAtUtc
      ? formatBangkokTimestamp_(prvStat.lastMarketingUpdatedAtUtc)
      : '',
    isMinorFlag: Boolean(userRecord.is_minor_flag),
    assignedCourseIds: assignedCourseIds,
    activeEnrollments: activeEnrollments,
    financialReferences: finRef,
    isLastUsableAdmin: isLastUsableAdmin,
    createdAtUtc: userRecord.created_at_utc,
    createdAtBangkok: userRecord.created_at_utc
      ? formatBangkokTimestamp_(userRecord.created_at_utc)
      : '',
    updatedAtUtc: userRecord.updated_at_utc,
    updatedAtBangkok: userRecord.updated_at_utc
      ? formatBangkokTimestamp_(userRecord.updated_at_utc)
      : '',
    version: Number(userRecord.version || 1)
  };
}
/**
 * Step 6 Handler: `admin.listUsers`
 * Supports search (`searchQuery` across username, full name, and email), `roleFilter`
 * (`ALL` | `STUDENT` | `ADMIN`), `statusFilter` (`ALL` | `ACTIVE` | `SUSPENDED` | `ARCHIVED`),
 * and cursor pagination (`limit`, `cursor`).
 *
 * Also returns the available courses catalog so the Admin Users UI can assign courses
 * via real `Enrollments` records.
 *
 * @param {Object} authContext Verified ADMIN auth context.
 * @param {Object} payload `{ searchQuery?, roleFilter?, statusFilter?, limit?, cursor? }`
 * @return {Object} Paginated user list, role/status counts, and course catalog.
 */
function adminListUsersStep6_(authContext, payload) {
  var adminUser = assertAdminRoleStep6_(authContext);
  var req = payload && typeof payload === 'object' ? payload : {};

  var searchQuery = String(req.searchQuery || '')
    .trim()
    .toLowerCase();
  var roleFilter = String(req.roleFilter || 'ALL')
    .trim()
    .toUpperCase();
  var statusFilter = String(req.statusFilter || 'ALL')
    .trim()
    .toUpperCase();

  var reqLimit = Number(req.limit || 10);
  if (!isFinite(reqLimit) || reqLimit < 1) {
    reqLimit = 10;
  } else if (reqLimit > PB_APP_CONSTANTS_.PAGINATION_MAX_LIMIT) {
    reqLimit = PB_APP_CONSTANTS_.PAGINATION_MAX_LIMIT;
  }
  var cursorStr = req.cursor ? String(req.cursor).trim() : null;

  return withScriptLock_(function () {
    var availableCourses = ensureDefaultCatalogCoursesForEnrollments_(
      adminUser.user_id
    );
    var coursesTbl = readSheetTable_('Courses');
    var usersTbl = readSheetTable_('Users');
    var enrollmentsTbl = readSheetTable_('Enrollments');
    var privacyTbl = readSheetTable_('PrivacyChoices');
    var invoicesTbl = readSheetTable_('Invoices');
    var paymentsTbl = readSheetTable_('Payments');
    var currentVer = getCurrentPrivacyNoticeVersion_();

    var usableAdminCount = countUsableAdministrators_(usersTbl);

    /* Group Enrollments by user_id */
    var enrollmentsByUserMap = {};
    for (var e = 0; e < enrollmentsTbl.records.length; e++) {
      var enr = enrollmentsTbl.records[e];
      if (!enrollmentsByUserMap[enr.user_id]) {
        enrollmentsByUserMap[enr.user_id] = [];
      }
      enrollmentsByUserMap[enr.user_id].push(enr);
    }

    /* Group PrivacyChoices stats by user_id */
    var privacyStatsByUserMap = {};
    for (var p = 0; p < privacyTbl.records.length; p++) {
      var prv = privacyTbl.records[p];
      if (!privacyStatsByUserMap[prv.user_id]) {
        privacyStatsByUserMap[prv.user_id] = {
          historyCount: 0,
          lastAckAtUtc: '',
          lastMarketingUpdatedAtUtc: ''
        };
      }
      var st = privacyStatsByUserMap[prv.user_id];
      st.historyCount += 1;
      if (
        prv.acknowledged_notice === true &&
        prv.recorded_at_utc >= st.lastAckAtUtc
      ) {
        st.lastAckAtUtc = prv.recorded_at_utc;
      }
      if (prv.recorded_at_utc >= st.lastMarketingUpdatedAtUtc) {
        st.lastMarketingUpdatedAtUtc = prv.recorded_at_utc;
      }
    }

    /* Compute financial reference counts per user_id */
    var financialRefsByUserMap = {};
    for (var uIdx = 0; uIdx < usersTbl.records.length; uIdx++) {
      var uRow = usersTbl.records[uIdx];
      financialRefsByUserMap[uRow.user_id] = getUserFinancialReferenceSummary_(
        uRow.user_id,
        invoicesTbl,
        paymentsTbl
      );
    }

    /* Overall role/status summary counts across all users */
    var summaryCounts = {
      totalUsers: usersTbl.records.length,
      usableAdmins: usableAdminCount,
      totalAdmins: 0,
      activeStudents: 0,
      inactiveStudents: 0,
      totalActiveEnrollments: 0
    };
    for (var s = 0; s < usersTbl.records.length; s++) {
      var ur = usersTbl.records[s];
      if (ur.role === 'ADMIN') {
        summaryCounts.totalAdmins += 1;
      } else if (ur.role === 'STUDENT') {
        if (ur.status === 'ACTIVE') {
          summaryCounts.activeStudents += 1;
        } else {
          summaryCounts.inactiveStudents += 1;
        }
      }
    }
    for (var ae = 0; ae < enrollmentsTbl.records.length; ae++) {
      if (enrollmentsTbl.records[ae].status === 'ACTIVE') {
        summaryCounts.totalActiveEnrollments += 1;
      }
    }

    var pageResult = querySheetRecords_('Users', {
      filterFn: function (rec) {
        if (
          roleFilter !== 'ALL' &&
          roleFilter !== '' &&
          rec.role !== roleFilter
        ) {
          return false;
        }
        if (
          statusFilter !== 'ALL' &&
          statusFilter !== '' &&
          rec.status !== statusFilter
        ) {
          return false;
        }
        if (searchQuery.length > 0) {
          var hayUsername = String(rec.username_lower || '').toLowerCase();
          var hayName = String(rec.full_name || '').toLowerCase();
          var hayEmail = String(rec.email || '').toLowerCase();
          var hayRole = String(rec.role || '').toLowerCase();
          if (
            hayUsername.indexOf(searchQuery) === -1 &&
            hayName.indexOf(searchQuery) === -1 &&
            hayEmail.indexOf(searchQuery) === -1 &&
            hayRole.indexOf(searchQuery) === -1
          ) {
            return false;
          }
        }
        return true;
      },
      sortFn: function (a, b) {
        if (a.role !== b.role) {
          return a.role === 'ADMIN' ? -1 : 1;
        }
        return String(a.username_lower || '').localeCompare(
          String(b.username_lower || '')
        );
      },
      limit: reqLimit,
      cursor: cursorStr
    });

    var sanitizedItems = [];
    for (var i = 0; i < pageResult.items.length; i++) {
      sanitizedItems.push(
        buildAdminUserListItem_(
          pageResult.items[i],
          currentVer,
          enrollmentsByUserMap,
          coursesTbl.byId,
          privacyStatsByUserMap,
          financialRefsByUserMap,
          usableAdminCount
        )
      );
    }

    return {
      items: sanitizedItems,
      nextCursor: pageResult.nextCursor,
      totalMatched: pageResult.totalMatched,
      limit: reqLimit,
      summaryCounts: summaryCounts,
      availableCourses: availableCourses
    };
  });
}
/**
 * Step 6 Handler: `admin.createUser`
 * Creates a new `STUDENT` or `ADMIN` account with:
 * - Unique normalized username (`username_lower` uniqueness enforced inside `withScriptLock_`).
 * - Validated email address (`<= 254` chars).
 * - Initial password hashed with PBKDF2-HMAC-SHA256 (10,000 iterations).
 * - Role (`STUDENT` | `ADMIN`).
 * - Active/inactive status (`ACTIVE` | `SUSPENDED`).
 * - Optional initial course assignments (`assignedCourseIds` stored as real `Enrollments` records).
 * - Marketing preference initialized to `false` (unchecked by default).
 *
 * @param {Object} authContext Verified ADMIN auth context.
 * @param {Object} payload `{ username, email, fullName, initialPassword, role, status?, isMinorFlag?, assignedCourseIds? }`
 * @return {Object} Created sanitized user record and enrollment summary.
 */
function adminCreateUserStep6_(authContext, payload) {
  var adminUser = assertAdminRoleStep6_(authContext);
  if (!payload || typeof payload !== 'object') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'User creation payload must be a valid object.'
    );
  }

  var fieldErrors = {};
  var normalizedUsername = null;
  try {
    normalizedUsername = normalizeAndValidateUsername_(payload.username);
  } catch (uErr) {
    fieldErrors.username = uErr.message;
  }

  var rawPassword =
    payload.initialPassword !== undefined
      ? payload.initialPassword
      : payload.password;
  try {
    validatePasswordInputBytes_(rawPassword, true);
  } catch (pErr) {
    fieldErrors.initialPassword = pErr.message;
  }

  var email = String(payload.email || '').trim();
  if (
    !email ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    fieldErrors.email =
      'A valid email address (up to 254 characters) is required.';
  }

  var fullName = String(payload.fullName || '').trim();
  if (fullName.length < 2 || fullName.length > 120) {
    fieldErrors.fullName = 'Full name must be between 2 and 120 characters.';
  }

  var role = String(payload.role || 'STUDENT')
    .trim()
    .toUpperCase();
  if (role !== 'STUDENT' && role !== 'ADMIN') {
    fieldErrors.role = 'Role must be either STUDENT or ADMIN.';
  }

  var status = String(payload.status || 'ACTIVE')
    .trim()
    .toUpperCase();
  if (status !== 'ACTIVE' && status !== 'SUSPENDED') {
    fieldErrors.status =
      'Initial status must be ACTIVE or SUSPENDED (inactive).';
  }

  var isMinorFlag = Boolean(payload.isMinorFlag === true);
  var desiredCourseIds = Array.isArray(payload.assignedCourseIds)
    ? payload.assignedCourseIds
    : [];

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Please correct the highlighted user fields before creating the account.',
      fieldErrors
    );
  }

  return withScriptLock_(function () {
    ensureDefaultCatalogCoursesForEnrollments_(adminUser.user_id);

    var existingHit = findUserByUsernameLower_(
      normalizedUsername.usernameLower
    );
    if (existingHit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Username "' +
          normalizedUsername.usernameLower +
          '" is already taken (normalized usernames are case-insensitive and must be unique).',
        {
          username:
            'Normalized username "' +
            normalizedUsername.usernameLower +
            '" already exists.'
        }
      );
    }

    var nowIso = nowUtcIso_();
    var newUserId = generateEntityId_('usr_');
    var passwordHash = hashPassword_(
      rawPassword,
      normalizedUsername.usernameLower
    );

    var insertedUser = insertSheetRecord_(
      'Users',
      {
        user_id: newUserId,
        username_lower: normalizedUsername.usernameLower,
        username_display: normalizedUsername.usernameDisplay,
        email: email,
        full_name: fullName,
        role: role,
        status: status,
        password_hash: passwordHash,
        password_updated_at_utc: nowIso,
        last_login_at_utc: '',
        privacy_ack_version: '',
        marketing_opt_in: false,
        is_minor_flag: isMinorFlag,
        created_at_utc: nowIso,
        updated_at_utc: nowIso
      },
      { skipLock: true }
    );

    var enrollmentSync = syncUserCourseEnrollmentsInternal_(
      newUserId,
      desiredCourseIds,
      adminUser.user_id
    );

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType:
        role === 'ADMIN'
          ? 'ADMIN_USER_CREATED_ADMIN'
          : 'ADMIN_USER_CREATED_STUDENT',
      targetEntityType: 'User',
      targetEntityId: newUserId,
      summary: {
        usernameLower: insertedUser.username_lower,
        usernameDisplay: insertedUser.username_display,
        email: insertedUser.email,
        fullName: insertedUser.full_name,
        role: insertedUser.role,
        status: insertedUser.status,
        isMinorFlag: Boolean(insertedUser.is_minor_flag),
        assignedCourseCount: enrollmentSync.activeCourseIds.length
      }
    });

    var coursesTbl = readSheetTable_('Courses');
    var usersTbl = readSheetTable_('Users');
    var currentVer = getCurrentPrivacyNoticeVersion_();
    var enrollmentsByUserMap = {};
    enrollmentsByUserMap[newUserId] = readSheetTable_(
      'Enrollments'
    ).records.filter(function (r) {
      return r.user_id === newUserId;
    });

    var userItem = buildAdminUserListItem_(
      insertedUser,
      currentVer,
      enrollmentsByUserMap,
      coursesTbl.byId,
      {},
      {},
      countUsableAdministrators_(usersTbl)
    );

    return {
      created: true,
      user: userItem,
      enrollmentSummary: enrollmentSync
    };
  });
}
/**
 * Step 6 Handler: `admin.updateUser`
 * Edits an existing user's profile fields (`username`, `email`, `fullName`, `role`, `status`,
 * `isMinorFlag`, and optional `assignedCourseIds`) with strict security & privacy invariants:
 * 1. Verifies `ADMIN` role.
 * 2. Requires `expectedVersion` and throws `ERR_CONFLICT_VERSION` with a clear explanation if stale.
 * 3. Enforces unique normalized `username_lower` if the username is changed.
 * 4. Prevents demoting (`ADMIN` -> `STUDENT`) or disabling (`ACTIVE` -> `SUSPENDED` / `ARCHIVED`)
 *    the last usable administrator (`ERR_LAST_ADMIN_PROTECTED` / `ERR_VALIDATION_FAILED`).
 * 5. Preserves the user's `marketing_opt_in` and `privacy_ack_version` (and `PrivacyChoices`
 *    history) - administrators cannot silently overwrite a student's marketing preference during
 *    profile editing.
 * 6. Automatically revokes all active sessions for the user (`revokeAllUserSessions_`) if
 *    security-sensitive attributes (`username_lower`, `role`, or non-`ACTIVE` `status`) changed.
 * 7. Never returns `password_hash`.
 *
 * @param {Object} authContext Verified ADMIN auth context.
 * @param {Object} payload `{ userId, expectedVersion, username?, email?, fullName?, role?, status?, isMinorFlag?, assignedCourseIds? }`
 * @return {Object} Updated sanitized user record, session revocation count, and enrollment summary.
 */
function adminUpdateUserStep6_(authContext, payload) {
  var adminUser = assertAdminRoleStep6_(authContext);
  if (!payload || typeof payload !== 'object') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'User update payload must be a valid object.'
    );
  }

  var targetUserId = String(payload.userId || '').trim();
  if (!targetUserId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Target userId is required.',
      { userId: 'userId is required.' }
    );
  }

  var expectedVersion = Number(payload.expectedVersion);
  if (
    payload.expectedVersion === undefined ||
    payload.expectedVersion === null ||
    !isFinite(expectedVersion) ||
    expectedVersion < 1
  ) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'expectedVersion (positive integer) is required to prevent overwriting concurrent edits.',
      { expectedVersion: 'Valid expectedVersion is required.' }
    );
  }

  return withScriptLock_(function () {
    var usersTbl = readSheetTable_('Users');
    var hit = usersTbl.byId[targetUserId];
    if (!hit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'User "' + targetUserId + '" was not found in the Users sheet.'
      );
    }

    var current = hit.record;
    if (Number(current.version) !== expectedVersion) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
        'User Edit Conflict (Stale Record Version): User "' +
          (current.username_display || current.username_lower) +
          '" was modified by another administrator (your form had version ' +
          String(expectedVersion) +
          ', but the server now has version ' +
          String(current.version) +
          '). Your changes were not saved so the other administrator\'s edits are not overwritten. Please reload the user list and try again.',
        {
          expectedVersion:
            'Expected version ' +
            String(expectedVersion) +
            ' does not match current version ' +
            String(current.version) +
            '.'
        }
      );
    }

    var fieldErrors = {};
    var patchFields = {};

    /* 1. Username (optional change, normalized uniqueness enforced) */
    var nextUsernameLower = current.username_lower;
    var nextUsernameDisplay = current.username_display;
    if (payload.username !== undefined) {
      try {
        var norm = normalizeAndValidateUsername_(payload.username);
        nextUsernameLower = norm.usernameLower;
        nextUsernameDisplay = norm.usernameDisplay;
      } catch (uErr) {
        fieldErrors.username = uErr.message;
      }
    }

    if (
      !fieldErrors.username &&
      nextUsernameLower !== current.username_lower
    ) {
      var collision = findUserByUsernameLower_(nextUsernameLower, usersTbl);
      if (collision && (collision.record ? collision.record.user_id : collision.user_id) !== targetUserId) {
        fieldErrors.username =
          'Normalized username "' +
          nextUsernameLower +
          '" is already assigned to another user.';
      } else {
        patchFields.username_lower = nextUsernameLower;
        patchFields.username_display = nextUsernameDisplay;
      }
    } else if (
      !fieldErrors.username &&
      nextUsernameDisplay !== current.username_display
    ) {
      patchFields.username_display = nextUsernameDisplay;
    }

    /* 2. Email */
    if (payload.email !== undefined) {
      var emailVal = String(payload.email || '').trim();
      if (
        !emailVal ||
        emailVal.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)
      ) {
        fieldErrors.email =
          'A valid email address (up to 254 characters) is required.';
      } else if (emailVal !== current.email) {
        patchFields.email = emailVal;
      }
    }

    /* 3. Full Name */
    if (payload.fullName !== undefined) {
      var nameVal = String(payload.fullName || '').trim();
      if (nameVal.length < 2 || nameVal.length > 120) {
        fieldErrors.fullName = 'Full name must be between 2 and 120 characters.';
      } else if (nameVal !== current.full_name) {
        patchFields.full_name = nameVal;
      }
    }

    /* 4. Role */
    var nextRole = current.role;
    if (payload.role !== undefined) {
      var rVal = String(payload.role || '')
        .trim()
        .toUpperCase();
      if (rVal !== 'STUDENT' && rVal !== 'ADMIN') {
        fieldErrors.role = 'Role must be STUDENT or ADMIN.';
      } else {
        nextRole = rVal;
        if (nextRole !== current.role) {
          patchFields.role = nextRole;
        }
      }
    }

    /* 5. Status (`ACTIVE` | `SUSPENDED` | `ARCHIVED`) */
    var nextStatus = current.status;
    if (payload.status !== undefined) {
      var sVal = String(payload.status || '')
        .trim()
        .toUpperCase();
      if (
        sVal !== 'ACTIVE' &&
        sVal !== 'SUSPENDED' &&
        sVal !== 'ARCHIVED'
      ) {
        fieldErrors.status =
          'Status must be ACTIVE, SUSPENDED (inactive), or ARCHIVED.';
      } else {
        nextStatus = sVal;
        if (nextStatus !== current.status) {
          patchFields.status = nextStatus;
        }
      }
    }

    /* 6. Minor Flag (`is_minor_flag`) */
    if (payload.isMinorFlag !== undefined) {
      var nextMinor = Boolean(payload.isMinorFlag === true);
      if (nextMinor !== Boolean(current.is_minor_flag)) {
        patchFields.is_minor_flag = nextMinor;
      }
    }

    /* 7. Last Usable Administrator Guard:
       If this user is currently a usable ADMIN (`role === 'ADMIN'` and `status === 'ACTIVE'`),
       and the update would either demote them (`nextRole !== 'ADMIN'`) or deactivate them
       (`nextStatus !== 'ACTIVE'`), verify that at least 1 OTHER usable ADMIN remains! */
    var wasUsableAdmin =
      current.role === 'ADMIN' && current.status === 'ACTIVE';
    var willBeUsableAdmin = nextRole === 'ADMIN' && nextStatus === 'ACTIVE';
    if (wasUsableAdmin && !willBeUsableAdmin) {
      var remainingAdmins = countUsableAdministrators_(usersTbl, targetUserId);
      if (remainingAdmins < 1) {
        var guardMsg =
          'Action blocked: Cannot demote or deactivate "' +
          (current.username_display || current.username_lower) +
          '" because they are the last active administrator account. Create and activate another ADMIN account first.';
        fieldErrors.role = guardMsg;
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
          guardMsg,
          fieldErrors
        );
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Please correct the highlighted user fields.',
        fieldErrors
      );
    }

    /* Explicitly preserve privacy & marketing fields (`marketing_opt_in` and `privacy_ack_version`
       are NEVER included in `patchFields` from `admin.updateUser`). */
    var updatedUser = updateSheetRecordById_(
      'Users',
      targetUserId,
      patchFields,
      expectedVersion,
      { skipLock: true }
    );

    /* Revoke sessions if username, role, or active status changed */
    var revokeReasons = [];
    if (patchFields.username_lower) {
      revokeReasons.push('USERNAME_CHANGED');
    }
    if (patchFields.role) {
      revokeReasons.push('ROLE_CHANGE');
    }
    if (patchFields.status && patchFields.status !== 'ACTIVE') {
      revokeReasons.push('ACCOUNT_' + patchFields.status);
    }

    var revokedSessionCount = 0;
    if (revokeReasons.length > 0) {
      var revRes = revokeAllUserSessions_(
        targetUserId,
        revokeReasons.join(','),
        { skipLock: true }
      );
      revokedSessionCount = Number(revRes && revRes.revokedCount !== undefined ? revRes.revokedCount : revRes || 0);
    }

    /* Optional real course enrollment sync if `assignedCourseIds` array was supplied */
    var enrollmentSummary = null;
    if (Array.isArray(payload.assignedCourseIds)) {
      enrollmentSummary = syncUserCourseEnrollmentsInternal_(
        targetUserId,
        payload.assignedCourseIds,
        adminUser.user_id
      );
    }

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_USER_UPDATED',
      targetEntityType: 'User',
      targetEntityId: targetUserId,
      summary: {
        changedFields: Object.keys(patchFields),
        newRole: updatedUser.role,
        newStatus: updatedUser.status,
        marketingOptInPreserved: Boolean(updatedUser.marketing_opt_in),
        privacyAckVersionPreserved: updatedUser.privacy_ack_version || '',
        revokedSessionCount: revokedSessionCount,
        enrollmentsUpdated: Boolean(enrollmentSummary),
        newVersion: updatedUser.version
      }
    });

    var coursesTbl = readSheetTable_('Courses');
    var refreshedUsersTbl = readSheetTable_('Users');
    var enrollmentsTbl = readSheetTable_('Enrollments');
    var privacyTbl = readSheetTable_('PrivacyChoices');
    var invoicesTbl = readSheetTable_('Invoices');
    var paymentsTbl = readSheetTable_('Payments');
    var currentVer = getCurrentPrivacyNoticeVersion_();

    var userEnrsMap = {};
    userEnrsMap[targetUserId] = enrollmentsTbl.records.filter(function (r) {
      return r.user_id === targetUserId;
    });

    var prvMap = {};
    for (var p = 0; p < privacyTbl.records.length; p++) {
      var pr = privacyTbl.records[p];
      if (pr.user_id === targetUserId) {
        if (!prvMap[targetUserId]) {
          prvMap[targetUserId] = {
            historyCount: 0,
            lastAckAtUtc: '',
            lastMarketingUpdatedAtUtc: ''
          };
        }
        prvMap[targetUserId].historyCount += 1;
        if (
          pr.acknowledged_notice === true &&
          pr.recorded_at_utc >= prvMap[targetUserId].lastAckAtUtc
        ) {
          prvMap[targetUserId].lastAckAtUtc = pr.recorded_at_utc;
        }
        if (
          pr.recorded_at_utc >= prvMap[targetUserId].lastMarketingUpdatedAtUtc
        ) {
          prvMap[targetUserId].lastMarketingUpdatedAtUtc = pr.recorded_at_utc;
        }
      }
    }

    var finMap = {};
    finMap[targetUserId] = getUserFinancialReferenceSummary_(
      targetUserId,
      invoicesTbl,
      paymentsTbl
    );

    var item = buildAdminUserListItem_(
      updatedUser,
      currentVer,
      userEnrsMap,
      coursesTbl.byId,
      prvMap,
      finMap,
      countUsableAdministrators_(refreshedUsersTbl)
    );

    return {
      updated: true,
      user: item,
      revokedSessionCount: revokedSessionCount,
      marketingPreferencePreserved: true,
      enrollmentSummary: enrollmentSummary
    };
  });
}
/**
 * Step 6 Handler: `admin.resetUserPassword`
 * Resets a user's password (`expectedVersion` checked), hashes the new password with
 * PBKDF2-HMAC-SHA256 (`10,000` iterations), revokes all active sessions for that user
 * (`PASSWORD_CHANGE`), and records a credential-free audit event.
 *
 * @param {Object} authContext Verified ADMIN auth context.
 * @param {Object} payload `{ userId, newPassword, expectedVersion }`
 * @return {Object} `{ reset: true, user, revokedSessionCount }`
 */
function adminResetUserPasswordStep6_(authContext, payload) {
  var adminUser = assertAdminRoleStep6_(authContext);
  if (!payload || typeof payload !== 'object') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Password reset payload must be an object.'
    );
  }

  var targetUserId = String(payload.userId || '').trim();
  if (!targetUserId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Target userId is required.',
      { userId: 'userId is required.' }
    );
  }

  var expectedVersion = Number(payload.expectedVersion);
  if (
    payload.expectedVersion === undefined ||
    payload.expectedVersion === null ||
    !isFinite(expectedVersion) ||
    expectedVersion < 1
  ) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'expectedVersion is required to reset a user password safely.',
      { expectedVersion: 'Valid expectedVersion is required.' }
    );
  }

  validatePasswordInputBytes_(payload.newPassword, true);

  return withScriptLock_(function () {
    var usersTbl = readSheetTable_('Users');
    var hit = usersTbl.byId[targetUserId];
    if (!hit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'User "' + targetUserId + '" was not found.'
      );
    }

    var current = hit.record;
    if (Number(current.version) !== expectedVersion) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
        'Password Reset Blocked (Stale Record Version): User "' +
          (current.username_display || current.username_lower) +
          '" was updated by another administrator (expected version ' +
          String(expectedVersion) +
          ', current version ' +
          String(current.version) +
          '). Please reload the user record before resetting the password.'
      );
    }

    var nowIso = nowUtcIso_();
    var newPasswordHash = hashPassword_(
      payload.newPassword,
      current.username_lower
    );

    var updatedUser = updateSheetRecordById_(
      'Users',
      targetUserId,
      {
        password_hash: newPasswordHash,
        password_updated_at_utc: nowIso
      },
      expectedVersion,
      { skipLock: true }
    );

    var revRes = revokeAllUserSessions_(targetUserId, 'PASSWORD_CHANGE', {
      skipLock: true
    });
    clearUserLoginFailuresOnSuccess_(current.username_lower);

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_USER_PASSWORD_RESET',
      targetEntityType: 'User',
      targetEntityId: targetUserId,
      summary: {
        usernameLower: updatedUser.username_lower,
        revokedSessionCount: Number(revRes && revRes.revokedCount !== undefined ? revRes.revokedCount : revRes || 0),
        newVersion: updatedUser.version
      }
    });

    var coursesTbl = readSheetTable_('Courses');
    var enrollmentsTbl = readSheetTable_('Enrollments');
    var currentVer = getCurrentPrivacyNoticeVersion_();
    var userEnrsMap = {};
    userEnrsMap[targetUserId] = enrollmentsTbl.records.filter(function (r) {
      return r.user_id === targetUserId;
    });

    var item = buildAdminUserListItem_(
      updatedUser,
      currentVer,
      userEnrsMap,
      coursesTbl.byId,
      {},
      {},
      countUsableAdministrators_(usersTbl)
    );

    return {
      reset: true,
      user: item,
      revokedSessionCount: Number(revRes && revRes.revokedCount !== undefined ? revRes.revokedCount : revRes || 0),
      passwordUpdatedAtBangkok: formatBangkokTimestamp_(nowIso)
    };
  });
}
/**
 * Step 6 Handler: `admin.setUserEnrollments`
 * Assigns or revokes courses for a user using real `Enrollments` worksheet records.
 *
 * @param {Object} authContext Verified ADMIN auth context.
 * @param {Object} payload `{ userId, expectedUserVersion, assignedCourseIds }`
 * @return {Object} Updated user item and enrollment sync summary.
 */
function adminSetUserEnrollmentsStep6_(authContext, payload) {
  var adminUser = assertAdminRoleStep6_(authContext);
  if (!payload || typeof payload !== 'object') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Course assignment payload must be an object.'
    );
  }

  var targetUserId = String(payload.userId || '').trim();
  if (!targetUserId) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Target userId is required.'
    );
  }

  if (!Array.isArray(payload.assignedCourseIds)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'assignedCourseIds must be an array of course IDs.'
    );
  }

  return withScriptLock_(function () {
    var usersTbl = readSheetTable_('Users');
    var hit = usersTbl.byId[targetUserId];
    if (!hit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'User "' + targetUserId + '" was not found.'
      );
    }

    var current = hit.record;
    if (
      payload.expectedUserVersion !== undefined &&
      payload.expectedUserVersion !== null &&
      Number(payload.expectedUserVersion) !== Number(current.version)
    ) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
        'Course Assignment Blocked (Stale User Version): User "' +
          (current.username_display || current.username_lower) +
          '" was modified by another administrator (expected version ' +
          String(payload.expectedUserVersion) +
          ', current version ' +
          String(current.version) +
          '). Reload before saving course assignments.'
      );
    }

    var syncResult = syncUserCourseEnrollmentsInternal_(
      targetUserId,
      payload.assignedCourseIds,
      adminUser.user_id
    );

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_USER_ENROLLMENTS_UPDATED',
      targetEntityType: 'User',
      targetEntityId: targetUserId,
      summary: {
        usernameLower: current.username_lower,
        activeCourseIds: syncResult.activeCourseIds,
        newlyAssignedCount: syncResult.newlyAssignedCount,
        reactivatedCount: syncResult.reactivatedCount,
        revokedCount: syncResult.revokedCount
      }
    });

    var coursesTbl = readSheetTable_('Courses');
    var enrollmentsTbl = readSheetTable_('Enrollments');
    var currentVer = getCurrentPrivacyNoticeVersion_();
    var userEnrsMap = {};
    userEnrsMap[targetUserId] = enrollmentsTbl.records.filter(function (r) {
      return r.user_id === targetUserId;
    });

    var item = buildAdminUserListItem_(
      current,
      currentVer,
      userEnrsMap,
      coursesTbl.byId,
      {},
      {},
      countUsableAdministrators_(usersTbl)
    );

    return {
      updated: true,
      user: item,
      enrollmentSummary: syncResult
    };
  });
}
/**
 * Step 6 Handler: `admin.deleteOrArchiveUser`
 * Enforces:
 * 1. Cannot delete, archive, or disable the last usable `ADMIN`.
 * 2. Never hard-deletes a user who has financial references in `Invoices` or `Payments`
 *    (throws `ERR_VALIDATION_FAILED` with a clear explanation recommending status deactivation/archival).
 * 3. Revokes all active sessions for the user.
 *
 * @param {Object} authContext Verified ADMIN auth context.
 * @param {Object} payload `{ userId, expectedVersion, mode: 'ARCHIVE' | 'HARD_DELETE' }`
 * @return {Object} Outcome summary.
 */
function adminDeleteOrArchiveUserStep6_(authContext, payload) {
  var adminUser = assertAdminRoleStep6_(authContext);
  if (!payload || typeof payload !== 'object') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Delete/Archive payload must be an object.'
    );
  }

  var targetUserId = String(payload.userId || '').trim();
  var expectedVersion = Number(payload.expectedVersion);
  var mode = String(payload.mode || 'HARD_DELETE')
    .trim()
    .toUpperCase();

  if (!targetUserId || !isFinite(expectedVersion)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Both userId and expectedVersion are required.'
    );
  }

  return withScriptLock_(function () {
    var usersTbl = readSheetTable_('Users');
    var hit = usersTbl.byId[targetUserId];
    if (!hit) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_NOT_FOUND,
        'User "' + targetUserId + '" was not found.'
      );
    }

    var current = hit.record;
    if (Number(current.version) !== expectedVersion) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_CONFLICT_VERSION,
        'Concurrency conflict: User "' +
          (current.username_display || current.username_lower) +
          '" has version ' +
          String(current.version) +
          ' (expected ' +
          String(expectedVersion) +
          '). Reload before retrying.'
      );
    }

    if (current.role === 'ADMIN' && current.status === 'ACTIVE') {
      var remainingAdmins = countUsableAdministrators_(usersTbl, targetUserId);
      if (remainingAdmins < 1) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_FORBIDDEN_ROLE,
          'Action blocked: Cannot remove or archive "' +
            (current.username_display || current.username_lower) +
            '" because they are the last active administrator.'
        );
      }
    }

    var finSummary = getUserFinancialReferenceSummary_(targetUserId);

    if (mode === 'HARD_DELETE') {
      if (finSummary.hasFinancialReferences) {
        throw createAppError_(
          PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
          'Hard Deletion Blocked (Financial References Exist): User "' +
            (current.username_display || current.username_lower) +
            '" is referenced by ' +
            String(finSummary.invoiceCount) +
            ' invoice(s) and ' +
            String(
              finSummary.paymentCount + finSummary.reviewedPaymentCount
            ) +
            ' payment record(s). Users with financial history cannot be hard-deleted. Set their status to SUSPENDED (Inactive) or ARCHIVED instead.',
          {
            financialReferences:
              'Invoices: ' +
              finSummary.invoiceCount +
              ', Payments: ' +
              (finSummary.paymentCount + finSummary.reviewedPaymentCount)
          }
        );
      }

      var revBeforeDel = revokeAllUserSessions_(
        targetUserId,
        'USER_HARD_DELETED',
        { skipLock: true }
      );
      deleteSheetRecordById_('Users', targetUserId, expectedVersion, {
        skipLock: true
      });

      recordAuditEvent_({
        actorUserId: adminUser.user_id,
        actorRole: 'ADMIN',
        eventType: 'ADMIN_USER_HARD_DELETED',
        targetEntityType: 'User',
        targetEntityId: targetUserId,
        summary: {
          usernameLower: current.username_lower,
          role: current.role,
          revokedSessionCount: Number(revBeforeDel && revBeforeDel.revokedCount !== undefined ? revBeforeDel.revokedCount : revBeforeDel || 0)
        }
      });

      return {
        mode: 'HARD_DELETE',
        deleted: true,
        userId: targetUserId,
        username: current.username_display || current.username_lower,
        revokedSessionCount: Number(revBeforeDel && revBeforeDel.revokedCount !== undefined ? revBeforeDel.revokedCount : revBeforeDel || 0)
      };
    }

    /* Archive mode (`status = 'ARCHIVED'`) preserves the row for financial integrity while disabling login */
    var archivedUser = updateSheetRecordById_(
      'Users',
      targetUserId,
      { status: 'ARCHIVED' },
      expectedVersion,
      { skipLock: true }
    );
    var revRes = revokeAllUserSessions_(targetUserId, 'USER_ARCHIVED', {
      skipLock: true
    });

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_USER_ARCHIVED',
      targetEntityType: 'User',
      targetEntityId: targetUserId,
      summary: {
        usernameLower: current.username_lower,
        financialReferencesPreserved: finSummary.hasFinancialReferences,
        revokedSessionCount: Number(revRes && revRes.revokedCount !== undefined ? revRes.revokedCount : revRes || 0)
      }
    });

    return {
      mode: 'ARCHIVE',
      deleted: false,
      archived: true,
      userId: targetUserId,
      username: archivedUser.username_display || archivedUser.username_lower,
      version: archivedUser.version,
      revokedSessionCount: Number(revRes && revRes.revokedCount !== undefined ? revRes.revokedCount : revRes || 0)
    };
  });
}
/**
 * Step 6 Handler: `admin.seedStep6SampleUsers`
 * Seeds or verifies the required non-real sample accounts for Step 6 testing:
 * - Two administrators (existing admin + `sample_admin_02`, or `sample_admin_01` + `sample_admin_02`)
 * - Two active students (`sample_student_01`, `sample_student_02`) with real `Enrollments`
 *   records (`BIO-M4-CELL`, `BIO-M5-PHYS`) and sample invoice reference on `sample_student_01`
 *   (so you can also test financial-reference deletion protection!)
 * - One disabled student (`sample_student_disabled` with `status: 'SUSPENDED'`)
 *
 * @param {Object} authContext Verified ADMIN auth context.
 * @param {Object=} opt_payload Optional `{ samplePassword? }`
 * @return {Object} Summary of seeded/verified sample users and their test credentials.
 */
function adminSeedStep6SampleUsers_(authContext, opt_payload) {
  var adminUser = assertAdminRoleStep6_(authContext);
  var req = opt_payload && typeof opt_payload === 'object' ? opt_payload : {};
  var samplePassword = String(
    req.samplePassword || 'SampleBioPass2026!'
  ).trim();
  validatePasswordInputBytes_(samplePassword, true);

  return withScriptLock_(function () {
    var catalog = ensureDefaultCatalogCoursesForEnrollments_(adminUser.user_id);
    var courseId1 = catalog.length > 0 ? catalog[0].courseId : '';
    var courseId2 = catalog.length > 1 ? catalog[1].courseId : courseId1;

    var specs = [
      {
        username: 'sample_admin_02',
        fullName: 'Dr. Arthit Wongsuwan (Sample Co-Admin)',
        email: 'arthit.sample.admin@pattanabhumi.example.org',
        role: 'ADMIN',
        status: 'ACTIVE',
        isMinorFlag: false,
        courseIds: []
      },
      {
        username: 'sample_student_01',
        fullName: 'Napat Srisai (Sample Active Student 1)',
        email: 'napat.sample01@student.pattanabhumi.example.org',
        role: 'STUDENT',
        status: 'ACTIVE',
        isMinorFlag: true,
        courseIds: courseId1 && courseId2 ? [courseId1, courseId2] : [],
        seedSampleInvoiceForDeleteGuardTest: true
      },
      {
        username: 'sample_student_02',
        fullName: 'Pimchanok Khem (Sample Active Student 2)',
        email: 'pimchanok.sample02@student.pattanabhumi.example.org',
        role: 'STUDENT',
        status: 'ACTIVE',
        isMinorFlag: false,
        courseIds: courseId1 ? [courseId1] : []
      },
      {
        username: 'sample_student_disabled',
        fullName: 'Kittipongwattana (Sample Disabled Student)',
        email: 'kittipong.disabled@student.pattanabhumi.example.org',
        role: 'STUDENT',
        status: 'SUSPENDED',
        isMinorFlag: false,
        courseIds: []
      }
    ];

    /* Ensure at least 2 administrators exist even if the caller is testing in an isolated harness */
    var usersTbl = readSheetTable_('Users');
    var existingAdmins = 0;
    for (var a = 0; a < usersTbl.records.length; a++) {
      if (usersTbl.records[a].role === 'ADMIN') {
        existingAdmins += 1;
      }
    }
    if (existingAdmins < 1) {
      specs.unshift({
        username: 'sample_admin_01',
        fullName: 'Ajarn Pattanabhumi (Sample Primary Admin)',
        email: 'primary.sample.admin@pattanabhumi.example.org',
        role: 'ADMIN',
        status: 'ACTIVE',
        isMinorFlag: false,
        courseIds: []
      });
    }

    var nowIso = nowUtcIso_();
    var seededAccounts = [];

    for (var i = 0; i < specs.length; i++) {
      var sp = specs[i];
      var norm = normalizeAndValidateUsername_(sp.username);
      usersTbl = readSheetTable_('Users');
      var hit = findUserByUsernameLower_(norm.usernameLower, usersTbl);
      var userId = '';
      var actionTaken = '';

      if (!hit) {
        userId = generateEntityId_('usr_');
        var pwHash = hashPassword_(samplePassword, norm.usernameLower);
        insertSheetRecord_(
          'Users',
          {
            user_id: userId,
            username_lower: norm.usernameLower,
            username_display: norm.usernameDisplay,
            email: sp.email,
            full_name: sp.fullName,
            role: sp.role,
            status: sp.status,
            password_hash: pwHash,
            password_updated_at_utc: nowIso,
            last_login_at_utc: '',
            privacy_ack_version: '',
            marketing_opt_in: false,
            is_minor_flag: sp.isMinorFlag,
            created_at_utc: nowIso,
            updated_at_utc: nowIso
          },
          { skipLock: true }
        );
        actionTaken = 'CREATED';
      } else {
        var hitRec = hit.record ? hit.record : hit;
        userId = hitRec.user_id;
        var reHash = hashPassword_(samplePassword, norm.usernameLower);
        updateSheetRecordById_(
          'Users',
          userId,
          {
            email: sp.email,
            full_name: sp.fullName,
            role: sp.role,
            status: sp.status,
            password_hash: reHash,
            password_updated_at_utc: nowIso
          },
          Number(hitRec.version),
          { skipLock: true }
        );
        if (sp.status !== 'ACTIVE') {
          revokeAllUserSessions_(userId, 'SAMPLE_SEED_SUSPENDED', {
            skipLock: true
          });
        }
        actionTaken = 'VERIFIED_AND_RESET';
      }

      var enrSync = syncUserCourseEnrollmentsInternal_(
        userId,
        sp.courseIds,
        adminUser.user_id
      );

      /* Seed 1 sample unpaid invoice on sample_student_01 so financial-reference deletion protection is testable */
      if (sp.seedSampleInvoiceForDeleteGuardTest && courseId1) {
        var invTbl = readSheetTable_('Invoices');
        var hasInv = false;
        for (var v = 0; v < invTbl.records.length; v++) {
          if (invTbl.records[v].user_id === userId) {
            hasInv = true;
            break;
          }
        }
        if (!hasInv) {
          insertSheetRecord_(
            'Invoices',
            {
              invoice_id: generateEntityId_('inv_'),
              user_id: userId,
              course_id: courseId1,
              installment_label:
                'Sample Term 1 Tuition Installment (Financial Reference Guard Test)',
              amount_satang: 350000,
              due_date_bkk: '2026-11-15',
              status: 'UNPAID',
              active_payment_id: '',
              reservation_expires_at_utc: '',
              last_rejection_reason: '',
              created_at_utc: nowIso,
              updated_at_utc: nowIso
            },
            { skipLock: true }
          );
        }
      }

      seededAccounts.push({
        userId: userId,
        username: norm.usernameDisplay,
        role: sp.role,
        status: sp.status,
        actionTaken: actionTaken,
        assignedCourseCount: enrSync.activeCourseIds.length
      });
    }

    recordAuditEvent_({
      actorUserId: adminUser.user_id,
      actorRole: 'ADMIN',
      eventType: 'ADMIN_STEP6_SAMPLE_USERS_SEEDED',
      targetEntityType: 'User',
      targetEntityId: 'SAMPLE_COHORT_STEP6',
      summary: {
        seededUsernames: seededAccounts.map(function (a) {
          return a.username + ' (' + a.role + '/' + a.status + ')';
        })
      }
    });

    return {
      ok: true,
      samplePasswordForTesting: samplePassword,
      seededAccounts: seededAccounts,
      note:
        'Non-real Step 6 sample cohort ready: 2 Administrators (your admin + sample_admin_02), 2 Active Students (sample_student_01 with 2 enrolled courses + 1 financial invoice reference, sample_student_02 with 1 enrolled course), and 1 Disabled Student (sample_student_disabled with status SUSPENDED).'
    };
  });
}
/**
 * Step 6 Student Profile Handler (`student.getProfile`)
 * Returns the student's profile summary along with their real active course enrollments
 * prepared in Step 6 (`Enrollments` joined with `Courses`).
 */
function handleStudentGetProfileStep6_(payload, context) {
  var usr = context.authContext.user;
  var currentVer = getCurrentPrivacyNoticeVersion_();
  var enrollmentsTbl = readSheetTable_('Enrollments');
  var coursesTbl = readSheetTable_('Courses');
  var sectionsTbl = readSheetTable_('Sections');
  var cardsTbl = readSheetTable_('Cards');

  var pubSectionsByCourse = {};
  for (var s = 0; s < sectionsTbl.records.length; s++) {
    var sec = sectionsTbl.records[s];
    if (sec.status === 'PUBLISHED') {
      if (!pubSectionsByCourse[sec.course_id]) {
        pubSectionsByCourse[sec.course_id] = [];
      }
      pubSectionsByCourse[sec.course_id].push(sec);
    }
  }

  var pubCardCountByCourse = {};
  for (var k = 0; k < cardsTbl.records.length; k++) {
    var crd = cardsTbl.records[k];
    if (crd.status === 'PUBLISHED') {
      pubCardCountByCourse[crd.course_id] =
        (pubCardCountByCourse[crd.course_id] || 0) + 1;
    }
  }

  var pubExamCountByCourse = {};
  try {
    var activeCourseIdMap = {};
    for (var aci = 0; aci < enrollmentsTbl.records.length; aci++) {
      var aEnr = enrollmentsTbl.records[aci];
      if (aEnr.user_id === usr.user_id && aEnr.status === 'ACTIVE' && aEnr.course_id) {
        activeCourseIdMap[aEnr.course_id] = true;
      }
    }
    if (Object.keys(activeCourseIdMap).length > 0) {
      var examSetsTbl = readSheetTable_('ExamSets');
      var publishedExams = [];
      for (var exi = 0; exi < examSetsTbl.records.length; exi++) {
        var exRow = examSetsTbl.records[exi];
        if (exRow.status === 'PUBLISHED' && activeCourseIdMap[exRow.course_id]) {
          publishedExams.push(exRow);
        }
      }
      if (publishedExams.length > 0) {
        var examAssignsByExam = {};
        try {
          var examAssignTbl = readSheetTable_('ExamAssignments');
          for (var eai = 0; eai < examAssignTbl.records.length; eai++) {
            var asgRow = examAssignTbl.records[eai];
            if (!asgRow.exam_set_id) continue;
            if (!examAssignsByExam[asgRow.exam_set_id]) {
              examAssignsByExam[asgRow.exam_set_id] = [];
            }
            examAssignsByExam[asgRow.exam_set_id].push(asgRow);
          }
        } catch (_asgErr) {}
        for (var pei = 0; pei < publishedExams.length; pei++) {
          var pEx = publishedExams[pei];
          var asgList = examAssignsByExam[pEx.exam_set_id] || [];
          var hasCourseAsg = pEx.assignment_scope === 'COURSE_ENROLLED';
          var hasStudentAsg = false;
          var isRevokedForStudent = false;
          for (var alIdx = 0; alIdx < asgList.length; alIdx++) {
            var asgItem = asgList[alIdx];
            if (asgItem.target_type === 'COURSE' && asgItem.course_id === pEx.course_id) {
              if (asgItem.assignment_status === 'ASSIGNED') hasCourseAsg = true;
              else if (asgItem.assignment_status === 'REVOKED') hasCourseAsg = false;
            } else if (asgItem.target_type === 'STUDENT' && asgItem.student_user_id === usr.user_id) {
              if (asgItem.assignment_status === 'ASSIGNED') hasStudentAsg = true;
              else if (asgItem.assignment_status === 'REVOKED') isRevokedForStudent = true;
            }
          }
          if (!isRevokedForStudent && (hasStudentAsg || hasCourseAsg)) {
            pubExamCountByCourse[pEx.course_id] =
              (pubExamCountByCourse[pEx.course_id] || 0) + 1;
          }
        }
      }
    }
  } catch (_examCountErr) {}

  var assignedCourses = [];
  var withheldNonPublishedCount = 0;

  for (var i = 0; i < enrollmentsTbl.records.length; i++) {
    var enr = enrollmentsTbl.records[i];
    if (enr.user_id === usr.user_id && enr.status === 'ACTIVE') {
      var cHit = coursesTbl.byId[enr.course_id];
      if (!cHit || !cHit.record) {
        continue;
      }
      var c = cHit.record;
      /* Step 9 Security Rule: Check BOTH active enrollment AND PUBLISHED status on the backend.
         Never send DRAFT, ARCHIVED, or unauthorized courses to the student browser. */
      if (c.status !== 'PUBLISHED') {
        withheldNonPublishedCount += 1;
        continue;
      }

      var courseSecs = (pubSectionsByCourse[c.course_id] || []).slice().sort(function (a, b) {
        return (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0);
      });
      var secTitles = [];
      for (var stIdx = 0; stIdx < courseSecs.length; stIdx++) {
        secTitles.push(courseSecs[stIdx].title);
      }

      assignedCourses.push({
        enrollmentId: enr.enrollment_id,
        courseId: c.course_id,
        courseCode: c.course_code,
        title: c.title,
        subtitle: c.subtitle || '',
        coverFileId: c.cover_file_id || '',
        coverFileMeta:
          typeof lookupFileMetaSummaryStep8_ === 'function'
            ? lookupFileMetaSummaryStep8_(c.cover_file_id)
            : null,
        status: 'PUBLISHED',
        sortOrder: Number(c.sort_order || 10),
        canOpenCourseContent: true,
        publishedSectionCount: courseSecs.length,
        publishedCardCount: pubCardCountByCourse[c.course_id] || 0,
        publishedExamCount: pubExamCountByCourse[c.course_id] || 0,
        sectionTitles: secTitles,
        assessmentUpdatedAtBangkok: c.assessment_updated_at_utc
          ? formatBangkokTimestamp_(c.assessment_updated_at_utc)
          : '',
        readingUpdatedAtBangkok: c.reading_updated_at_utc
          ? formatBangkokTimestamp_(c.reading_updated_at_utc)
          : '',
        updatedAtUtc: c.updated_at_utc || '',
        updatedAtBangkok: c.updated_at_utc
          ? formatBangkokTimestamp_(c.updated_at_utc)
          : '',
        assignedAtUtc: enr.assigned_at_utc,
        assignedAtBangkok: enr.assigned_at_utc
          ? formatBangkokTimestamp_(enr.assigned_at_utc)
          : ''
      });
    }
  }

  assignedCourses.sort(function (a, b) {
    var diff = (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0);
    if (diff !== 0) {
      return diff;
    }
    return String(a.courseCode || '').localeCompare(String(b.courseCode || ''));
  });

  var scoreBundle =
    typeof listStudentPublishedScoresPhase4_ === 'function'
      ? listStudentPublishedScoresPhase4_(usr.user_id, '', false)
      : { publishedScores: [], totalPublishedCount: 0, publishedCountByCourse: {} };

  for (var acIdx = 0; acIdx < assignedCourses.length; acIdx++) {
    var acItem = assignedCourses[acIdx];
    acItem.publishedScoreCount =
      (scoreBundle.publishedCountByCourse &&
        scoreBundle.publishedCountByCourse[acItem.courseId]) ||
      0;
  }

  var userSummary = buildPublicUserSummary_(usr, currentVer);

  return {
    user: userSummary,
    timezone: 'Asia/Bangkok (UTC+07:00)',
    privacyNoticeVersion: currentVer,
    assignedCourses: assignedCourses,
    hasAssignedCourses: assignedCourses.length > 0,
    publishedScores: scoreBundle.publishedScores,
    publishedScoreCount: scoreBundle.totalPublishedCount,
    withheldNonPublishedCount: withheldNonPublishedCount,
    emptyStateMessage:
      'No published biology courses are currently assigned to your account. When your instructor assigns you to a published course, it will appear here automatically.',
    coursesFeatureStatus:
      assignedCourses.length > 0
        ? 'COURSE_CONTENT_ACTIVE_STEP_9'
        : 'NO_COURSES_ASSIGNED_YET',
    stepNote:
      'Step 9 Student Learning Experience is active. Only actively assigned PUBLISHED courses are returned by the server.'
  };
}
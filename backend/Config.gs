/**
 * Config.gs
 * Pattanabhumi Biology Learning Management System - Step 4 Authentication
 *
 * Responsibilities:
 * - Define immutable application constants, authentication/session/rate-limit parameters,
 *   RPC size limits, canonical error codes, and pagination limits.
 * - Define the 16 normalized Google Sheets entity schemas, primary keys, and field constraints.
 * - Provide safe server timestamp generators (UTC ISO-8601 and Asia/Bangkok).
 * - Provide input, correlation ID, payload size, and record validation helpers.
 * - Provide ScriptProperties configuration helpers and non-sensitive shell status checks.
 *
 * Security Note:
 * - Every function in this file ends with an underscore (_) so it cannot be called
 *   directly from browser clients via google.script.run.
 */

var PB_APP_CONSTANTS_ = Object.freeze({
  SCHOOL_NAME_DEFAULT: 'Pattanabhumi Biology',
  LOGO_TEXT_DEFAULT: 'PB',
  LOGO_ALT_TEXT: 'Pattanabhumi Biology logo',
  DEFAULT_LOGO_PROPERTY_KEY: 'DEFAULT_LOGO_DRIVE_FILE_ID',
  DEFAULT_LOGO_DRIVE_FILE_ID: '12EKzWLkKL9XEdZVrJBzGNERdAd7BFi--',
  MAX_LOGO_FILE_BYTES: 209715200,
  MAX_CACHE_SERVICE_LOGO_CHARS: 90000,
  CACHE_TTL_LOGO_SECONDS: 21600,
  APP_STAGE_LABEL: 'STEP_15_SECURITY_REVIEW_AND_VERIFICATION_COMPLETE',
  TIMEZONE: 'Asia/Bangkok',
  RUNTIME_ENGINE: 'V8',
  CURRENT_STEP: 15,
  UNAVAILABILITY_REASON_MIN_CHARS: 5,
  UNAVAILABILITY_REASON_MAX_CHARS: 1000,
  UNAVAILABILITY_MAX_SPAN_DAYS: 30,
  UNAVAILABILITY_RATE_LIMIT_MAX_PER_WINDOW: 5,
  UNAVAILABILITY_RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000,
  UNAVAILABILITY_MAX_EMAIL_RETRIES: 2,
  MAX_CALENDAR_QUERY_DAYS: 62,
  MAX_CALENDAR_RAW_EVENTS_INSPECTED: 500,
  MAX_CALENDAR_AUTHORIZED_EVENTS_RETURNED: 200,
  MIN_CALENDAR_YEAR: 2020,
  MAX_CALENDAR_YEAR: 2035,
  MIN_INVOICE_SATANG: 100,
  MAX_INVOICE_SATANG: 100000000,
  MAX_PAYMENT_TOTAL_SATANG: 500000000,
  PAYMENT_RESERVATION_TTL_MS: 15 * 60 * 1000,
  PAYMENT_RESERVATION_TTL_SECONDS: 900,
  CURRENT_PRIVACY_NOTICE_VERSION_DEFAULT: '2026-10-v1',
  MAX_SHEET_CELL_CHARS: 30000,
  GOOGLE_SHEETS_HARD_CELL_LIMIT: 50000,
  MAX_FILE_UPLOAD_BYTES: 209715200,
  MAX_RPC_REQUEST_BYTES: 98304,
  MAX_RPC_FILE_UPLOAD_REQUEST_BYTES: 293601280,
  MAX_RPC_RESPONSE_BYTES: 293601280,
  ORPHAN_FILE_GRACE_PERIOD_MINUTES_DEFAULT: 1440,
  MAX_REQUEST_ID_LENGTH: 64,
  PAGINATION_DEFAULT_LIMIT: 25,
  PAGINATION_MAX_LIMIT: 100,
  LOCK_TIMEOUT_MS: 10000,
  PBKDF2_ITERATIONS_DEFAULT: 10000,
  PBKDF2_MIN_ITERATIONS: 5000,
  PBKDF2_MAX_ITERATIONS: 50000,
  PASSWORD_MIN_CHARS: 8,
  PASSWORD_MAX_CHARS: 128,
  PASSWORD_MAX_UTF8_BYTES: 256,
  SESSION_TTL_DEFAULT_MS: 8 * 60 * 60 * 1000,
  SESSION_TTL_REMEMBER_ME_MS: 7 * 24 * 60 * 60 * 1000,
  RATE_LIMIT_WINDOW_MS: 15 * 60 * 1000,
  RATE_LIMIT_LOCKOUT_MS: 15 * 60 * 1000,
  RATE_LIMIT_MAX_USER_FAILURES: 5,
  RATE_LIMIT_MAX_UNKNOWN_USER_FAILURES: 20,
  RATE_LIMIT_MAX_GLOBAL_FAILURES: 50,
  OUTBOUND_SENDER_EMAIL: 'pattanabhumi.biology@gmail.com',
  OUTBOUND_SENDER_NAME: 'Pattanabhumi Biology',
  CONTACT_DEFAULTS: Object.freeze({
    lineUrl: 'https://line.me/R/ti/p/@pattanabhumi_placeholder',
    facebookUrl: 'https://www.facebook.com/pattanabhumi.placeholder',
    email: 'contact@pattanabhumi-biology.example.com'
  })
});

/**
 * Dispatches any outbound portal email so that it appears as coming from
 * `pattanabhumi.biology@gmail.com` ("Pattanabhumi Biology").
 *
 * - Uses `GmailApp.sendEmail(to, subject, body, { from: 'pattanabhumi.biology@gmail.com', name, replyTo })`
 *   when `GmailApp` is available in Google Apps Script (which supports verified "Send mail as" aliases
 *   and primary accounts).
 * - Automatically falls back to `MailApp.sendEmail({ to, from, name, replyTo, subject, body, noReply: false })`
 *   if `GmailApp` is unavailable or when running inside the `MailApp` test harness.
 *
 * @param {Object} mailOpts `{ to, subject, body, from?, name?, replyTo?, noReply? }`
 * @return {{ transport: string, from: string, name: string, replyTo: string }}
 */
function dispatchPortalEmailFromOfficialSender_(mailOpts) {
  var opts = mailOpts && typeof mailOpts === 'object' ? mailOpts : {};
  var senderEmail =
    (opts.from && String(opts.from).trim()) ||
    (typeof PB_APP_CONSTANTS_ === 'object' &&
      PB_APP_CONSTANTS_ &&
      PB_APP_CONSTANTS_.OUTBOUND_SENDER_EMAIL) ||
    'pattanabhumi.biology@gmail.com';
  var senderName =
    (opts.name && String(opts.name).trim()) ||
    (typeof PB_APP_CONSTANTS_ === 'object' &&
      PB_APP_CONSTANTS_ &&
      PB_APP_CONSTANTS_.OUTBOUND_SENDER_NAME) ||
    'Pattanabhumi Biology';
  var toAddress = String(opts.to || '').trim();
  var subjectText = String(opts.subject || '');
  var bodyText = String(opts.body || '');
  var replyToAddress =
    opts.replyTo && String(opts.replyTo).trim()
      ? String(opts.replyTo).trim()
      : senderEmail;

  var isSandboxIntercepted =
    typeof PB_ISOLATED_SANDBOX_ACTIVE_DEPTH_STEP15_ !== 'undefined' &&
    Number(PB_ISOLATED_SANDBOX_ACTIVE_DEPTH_STEP15_) > 0;

  if (
    !isSandboxIntercepted &&
    typeof GmailApp !== 'undefined' &&
    GmailApp &&
    typeof GmailApp.sendEmail === 'function'
  ) {
    try {
      var gmailOptions = {
        from: senderEmail,
        name: senderName,
        replyTo: replyToAddress,
        noReply: false
      };
      if (typeof GmailApp.getAliases === 'function') {
        var aliases = GmailApp.getAliases() || [];
        var aliasMatched = false;
        for (var i = 0; i < aliases.length; i++) {
          if (String(aliases[i] || '').trim().toLowerCase() === senderEmail.toLowerCase()) {
            aliasMatched = true;
            break;
          }
        }
        if (!aliasMatched) {
          var activeUserEmail = '';
          try {
            if (
              typeof Session !== 'undefined' &&
              Session &&
              typeof Session.getEffectiveUser === 'function'
            ) {
              activeUserEmail = String(Session.getEffectiveUser().getEmail() || '')
                .trim()
                .toLowerCase();
            }
          } catch (ignoreSessionErr) {}
          if (activeUserEmail === senderEmail.toLowerCase()) {
            delete gmailOptions.from;
          }
        }
      }
      GmailApp.sendEmail(toAddress, subjectText, bodyText, gmailOptions);
      return {
        transport: 'GmailApp',
        from: senderEmail,
        name: senderName,
        replyTo: replyToAddress
      };
    } catch (gmailSendErr) {
      /* Fallback to MailApp.sendEmail if alias is not yet authorized in GmailApp */
    }
  }

  if (typeof MailApp !== 'undefined' && MailApp && typeof MailApp.sendEmail === 'function') {
    MailApp.sendEmail({
      to: toAddress,
      from: senderEmail,
      name: senderName,
      replyTo: replyToAddress,
      subject: subjectText,
      body: bodyText,
      noReply: false
    });
    return {
      transport: 'MailApp',
      from: senderEmail,
      name: senderName,
      replyTo: replyToAddress
    };
  }

  throw new Error('Neither GmailApp.sendEmail nor MailApp.sendEmail is available in this runtime.');
}

var PB_PREV_ERROR_CODES_ = typeof PB_ERROR_CODES_ === "object" && PB_ERROR_CODES_ ? PB_ERROR_CODES_ : {};
var PB_ERROR_CODES_ = Object.freeze(Object.assign({}, PB_PREV_ERROR_CODES_, {
  ERR_INVALID_ACTION: 'ERR_INVALID_ACTION',
  ERR_VALIDATION_FAILED: 'ERR_VALIDATION_FAILED',
  ERR_PAYLOAD_TOO_LARGE: 'ERR_PAYLOAD_TOO_LARGE',
  ERR_RESPONSE_TOO_LARGE: 'ERR_RESPONSE_TOO_LARGE',
  ERR_DUPLICATE_IN_FLIGHT: 'ERR_DUPLICATE_IN_FLIGHT',
  ERR_RATE_LIMITED: 'ERR_RATE_LIMITED',
  ERR_INVALID_CREDENTIALS: 'ERR_INVALID_CREDENTIALS',
  ERR_ACCOUNT_SUSPENDED: 'ERR_ACCOUNT_SUSPENDED',
  ERR_ACCOUNT_INTEGRITY_LOCKED: 'ERR_ACCOUNT_INTEGRITY_LOCKED',
  ERR_EXAM_POLICY_ACK_REQUIRED: 'ERR_EXAM_POLICY_ACK_REQUIRED',
  ERR_EXAM_COPY_SUSPENDED: 'ERR_EXAM_COPY_SUSPENDED',
  ERR_EXAM_ATTEMPT_INVALIDATED: 'ERR_EXAM_ATTEMPT_INVALIDATED',
  ERR_AUTH_REQUIRED: 'ERR_AUTH_REQUIRED',
  ERR_PRIVACY_ACK_REQUIRED: 'ERR_PRIVACY_ACK_REQUIRED',
  ERR_FORBIDDEN_ROLE: 'ERR_FORBIDDEN_ROLE',
  ERR_FORBIDDEN_RESOURCE: 'ERR_FORBIDDEN_RESOURCE',
  ERR_NOT_FOUND: 'ERR_NOT_FOUND',
  ERR_CONFLICT_VERSION: 'ERR_CONFLICT_VERSION',
  ERR_IDEMPOTENCY_CONFLICT: 'ERR_IDEMPOTENCY_CONFLICT',
  ERR_PAYMENT_EXPIRED: 'ERR_PAYMENT_EXPIRED',
  ERR_PAYMENT_STATE_INVALID: 'ERR_PAYMENT_STATE_INVALID',
  ERR_INVALID_STATE_TRANSITION: 'ERR_INVALID_STATE_TRANSITION',
  ERR_CONFLICT_RESERVATION: 'ERR_CONFLICT_RESERVATION',
  ERR_FORBIDDEN_OPERATION: 'ERR_FORBIDDEN_OPERATION',
  ERR_SIMULATED_PARTIAL_WRITE: 'ERR_SIMULATED_PARTIAL_WRITE',
  ERR_FINANCIAL_INCONSISTENCY: 'ERR_FINANCIAL_INCONSISTENCY',
  ERR_FILE_INVALID: 'ERR_FILE_INVALID',
  ERR_FILE_TOO_LARGE: 'ERR_FILE_TOO_LARGE',
  ERR_FILE_SIGNATURE_MISMATCH: 'ERR_FILE_SIGNATURE_MISMATCH',
  ERR_FILE_PURPOSE_MISMATCH: 'ERR_FILE_PURPOSE_MISMATCH',
  ERR_LOCK_TIMEOUT: 'ERR_LOCK_TIMEOUT',
  ERR_CONFIG_MISSING: 'ERR_CONFIG_MISSING',
  ERR_RESOURCE_INACCESSIBLE: 'ERR_RESOURCE_INACCESSIBLE',
  ERR_BOOTSTRAP_ALREADY_COMPLETED: 'ERR_BOOTSTRAP_ALREADY_COMPLETED',
  ERR_NOT_IMPLEMENTED: 'ERR_NOT_IMPLEMENTED',
  ERR_INTERNAL: 'ERR_INTERNAL',
  ERR_ATTEMPT_SUSPENDED: 'ERR_ATTEMPT_SUSPENDED',
  ERR_ATTEMPT_INVALIDATED_COPY_POLICY: 'ERR_ATTEMPT_INVALIDATED_COPY_POLICY',
  ERR_ACCOUNT_INTEGRITY_LOCKED: 'ERR_ACCOUNT_INTEGRITY_LOCKED'
}));

/**
 * Compile-time allowlist of HTML partial filenames that exist in Step 4.
 */
var PB_ALLOWED_HTML_PARTIALS_ = Object.freeze({
  Styles: true,
  StatusView: true,
  LoginView: true,
  ClientCore: true
});

/**
 * Required ScriptProperties keys that the owner configures in Project Settings -> Script Properties,
 * plus APP_MASTER_SECRET which setupEnvironmentFromEditor_() provisions using CSPRNG entropy.
 */
var PB_OWNER_SCRIPT_PROPERTIES_ = Object.freeze([
  'SPREADSHEET_ID',
  'PRIVATE_DRIVE_FOLDER_ID',
  'CALENDAR_ID'
]);

var PB_OPTIONAL_SCRIPT_PROPERTIES_ = Object.freeze([
  'DEFAULT_LOGO_DRIVE_FILE_ID'
]);

var PB_REQUIRED_SCRIPT_PROPERTIES_ = Object.freeze([
  'SPREADSHEET_ID',
  'PRIVATE_DRIVE_FOLDER_ID',
  'CALENDAR_ID',
  'APP_MASTER_SECRET'
]);

/**
 * Temporary ScriptProperties keys used only during initial editor-run admin bootstrap
 * and deleted immediately after bootstrapInitialAdminFromEditor_() succeeds.
 */
var PB_BOOTSTRAP_TEMP_PROPERTIES_ = Object.freeze([
  'BOOTSTRAP_ADMIN_USERNAME',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'BOOTSTRAP_ADMIN_EMAIL',
  'BOOTSTRAP_ADMIN_FULL_NAME'
]);

/**
 * Canonical 16 worksheet names in deterministic creation order.
 */
var PB_SHEET_NAMES_ = Object.freeze([
  'Users',
  'Sessions',
  'LoginAttempts',
  'PrivacyChoices',
  'Courses',
  'Sections',
  'Cards',
  'Assessments',
  'Enrollments',
  'Files',
  'Invoices',
  'Payments',
  'PaymentJournal',
  'UnavailabilityRequests',
  'Settings',
  'AuditEvents',
  'AssessmentScores'
]);

/**
 * Authoritative schema specification for all 16 Google Sheets tabs.
 */
var PB_PREV_SHEET_SCHEMAS_ = typeof PB_SHEET_SCHEMAS_ === "object" && PB_SHEET_SCHEMAS_ ? PB_SHEET_SCHEMAS_ : {};
var PB_SHEET_SCHEMAS_ = Object.freeze(Object.assign({}, PB_PREV_SHEET_SCHEMAS_, {
  Users: Object.freeze({
    sheetName: 'Users',
    primaryKey: 'user_id',
    idPrefix: 'usr_',
    hasVersion: true,
    headers: Object.freeze([
      'user_id',
      'username_lower',
      'username_display',
      'email',
      'full_name',
      'role',
      'status',
      'password_hash',
      'password_updated_at_utc',
      'last_login_at_utc',
      'privacy_ack_version',
      'marketing_opt_in',
      'is_minor_flag',
      'created_at_utc',
      'updated_at_utc',
      'version'
    ]),
    requiredFields: Object.freeze([
      'user_id',
      'username_lower',
      'username_display',
      'email',
      'full_name',
      'role',
      'status',
      'password_hash',
      'created_at_utc',
      'updated_at_utc'
    ]),
    enums: Object.freeze({
      role: Object.freeze(['STUDENT', 'ADMIN']),
      status: Object.freeze(['ACTIVE', 'SUSPENDED', 'ARCHIVED', 'INTEGRITY_LOCKED'])
    }),
    booleanFields: Object.freeze(['marketing_opt_in', 'is_minor_flag']),
    integerFields: Object.freeze(['version']),
    positiveSatangFields: Object.freeze([])
  }),

  Sessions: Object.freeze({
    sheetName: 'Sessions',
    primaryKey: 'session_id',
    idPrefix: 'ses_',
    hasVersion: false,
    headers: Object.freeze([
      'session_id',
      'token_sha256_hex',
      'user_id',
      'remember_me',
      'status',
      'created_at_utc',
      'expires_at_utc',
      'last_seen_at_utc',
      'revoked_at_utc',
      'revoke_reason'
    ]),
    requiredFields: Object.freeze([
      'session_id',
      'token_sha256_hex',
      'user_id',
      'status',
      'created_at_utc',
      'expires_at_utc'
    ]),
    enums: Object.freeze({
      status: Object.freeze(['ACTIVE', 'REVOKED', 'EXPIRED'])
    }),
    booleanFields: Object.freeze(['remember_me']),
    integerFields: Object.freeze([]),
    positiveSatangFields: Object.freeze([])
  }),

  LoginAttempts: Object.freeze({
    sheetName: 'LoginAttempts',
    primaryKey: 'subject_key',
    idPrefix: 'rat_',
    hasVersion: false,
    headers: Object.freeze([
      'subject_key',
      'window_start_utc',
      'failure_count',
      'locked_until_utc',
      'last_attempt_at_utc',
      'updated_at_utc'
    ]),
    requiredFields: Object.freeze([
      'subject_key',
      'window_start_utc',
      'last_attempt_at_utc',
      'updated_at_utc'
    ]),
    enums: Object.freeze({}),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze(['failure_count']),
    positiveSatangFields: Object.freeze([])
  }),

  PrivacyChoices: Object.freeze({
    sheetName: 'PrivacyChoices',
    primaryKey: 'choice_id',
    idPrefix: 'prv_',
    hasVersion: false,
    headers: Object.freeze([
      'choice_id',
      'user_id',
      'notice_version',
      'acknowledged_notice',
      'marketing_opt_in',
      'action_source',
      'recorded_at_utc'
    ]),
    requiredFields: Object.freeze([
      'choice_id',
      'user_id',
      'notice_version',
      'action_source',
      'recorded_at_utc'
    ]),
    enums: Object.freeze({
      action_source: Object.freeze([
        'FIRST_LOGIN_GATE',
        'NOTICE_UPDATE_GATE',
        'PROFILE_PREFERENCE_UPDATE'
      ])
    }),
    booleanFields: Object.freeze(['acknowledged_notice', 'marketing_opt_in']),
    integerFields: Object.freeze([]),
    positiveSatangFields: Object.freeze([])
  }),

  Courses: Object.freeze({
    sheetName: 'Courses',
    primaryKey: 'course_id',
    idPrefix: 'crs_',
    hasVersion: true,
    headers: Object.freeze([
      'course_id',
      'course_code',
      'title',
      'subtitle',
      'cover_file_id',
      'status',
      'sort_order',
      'objectives_richtext_json',
      'outcomes_richtext_json',
      'assessment_updated_at_utc',
      'reading_updated_at_utc',
      'calendar_tag',
      'created_at_utc',
      'updated_at_utc',
      'version'
    ]),
    requiredFields: Object.freeze([
      'course_id',
      'course_code',
      'title',
      'status',
      'created_at_utc',
      'updated_at_utc'
    ]),
    enums: Object.freeze({
      status: Object.freeze(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
    }),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze(['sort_order', 'version']),
    positiveSatangFields: Object.freeze([])
  }),

  Sections: Object.freeze({
    sheetName: 'Sections',
    primaryKey: 'section_id',
    idPrefix: 'sec_',
    hasVersion: true,
    headers: Object.freeze([
      'section_id',
      'course_id',
      'section_type',
      'title',
      'status',
      'sort_order',
      'updated_at_utc',
      'version'
    ]),
    requiredFields: Object.freeze([
      'section_id',
      'course_id',
      'section_type',
      'title',
      'status',
      'updated_at_utc'
    ]),
    enums: Object.freeze({
      section_type: Object.freeze(['ASSESSMENT', 'READING', 'RECORDING', 'CUSTOM']),
      status: Object.freeze(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
    }),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze(['sort_order', 'version']),
    positiveSatangFields: Object.freeze([])
  }),

  Cards: Object.freeze({
    sheetName: 'Cards',
    primaryKey: 'card_id',
    idPrefix: 'crd_',
    hasVersion: true,
    headers: Object.freeze([
      'card_id',
      'course_id',
      'section_id',
      'card_type',
      'title',
      'subtitle',
      'image_file_id',
      'image_caption',
      'content_richtext_json',
      'recording_url',
      'recording_uploaded_at_utc',
      'assessment_id',
      'status',
      'sort_order',
      'created_at_utc',
      'updated_at_utc',
      'version'
    ]),
    requiredFields: Object.freeze([
      'card_id',
      'course_id',
      'section_id',
      'card_type',
      'title',
      'status',
      'created_at_utc',
      'updated_at_utc'
    ]),
    enums: Object.freeze({
      card_type: Object.freeze([
        'READING_CARD',
        'RECORDING_CARD',
        'ASSESSMENT_LINK_CARD'
      ]),
      status: Object.freeze(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
    }),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze(['sort_order', 'version']),
    positiveSatangFields: Object.freeze([])
  }),

  Assessments: Object.freeze({
    sheetName: 'Assessments',
    primaryKey: 'assessment_id',
    idPrefix: 'asm_',
    hasVersion: true,
    headers: Object.freeze([
      'assessment_id',
      'title',
      'description_richtext_json',
      'external_url',
      'pdf_file_id',
      'status',
      'created_at_utc',
      'updated_at_utc',
      'version'
    ]),
    requiredFields: Object.freeze([
      'assessment_id',
      'title',
      'status',
      'created_at_utc',
      'updated_at_utc'
    ]),
    enums: Object.freeze({
      status: Object.freeze(['ACTIVE', 'ARCHIVED'])
    }),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze(['version']),
    positiveSatangFields: Object.freeze([])
  }),

  Enrollments: Object.freeze({
    sheetName: 'Enrollments',
    primaryKey: 'enrollment_id',
    idPrefix: 'enr_',
    hasVersion: true,
    headers: Object.freeze([
      'enrollment_id',
      'user_id',
      'course_id',
      'status',
      'assigned_by_user_id',
      'assigned_at_utc',
      'updated_at_utc',
      'version'
    ]),
    requiredFields: Object.freeze([
      'enrollment_id',
      'user_id',
      'course_id',
      'status',
      'assigned_at_utc',
      'updated_at_utc'
    ]),
    enums: Object.freeze({
      status: Object.freeze(['ACTIVE', 'REVOKED', 'COMPLETED'])
    }),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze(['version']),
    positiveSatangFields: Object.freeze([])
  }),

  Files: Object.freeze({
    sheetName: 'Files',
    primaryKey: 'file_id',
    idPrefix: 'fil_',
    hasVersion: false,
    headers: Object.freeze([
      'file_id',
      'drive_file_id',
      'purpose',
      'course_id',
      'owner_user_id',
      'original_filename',
      'mime_type',
      'size_bytes',
      'sha256_hex',
      'status',
      'created_at_utc'
    ]),
    requiredFields: Object.freeze([
      'file_id',
      'drive_file_id',
      'purpose',
      'original_filename',
      'mime_type',
      'sha256_hex',
      'status',
      'created_at_utc'
    ]),
    enums: Object.freeze({
      purpose: Object.freeze([
        'SCHOOL_LOGO',
        'COURSE_COVER',
        'RICHTEXT_IMAGE',
        'CARD_IMAGE',
        'PDF_ATTACHMENT',
        'COURSE_IMAGE',
        'COURSE_PDF',
        'PAYMENT_RECEIPT',
        'PROMPTPAY_QR_IMAGE',
        'INSTRUCTOR_PORTRAIT',
        'HERO_SHUFFLE_CARD',
        'QUESTION_IMAGE',
        'OPTION_IMAGE',
        'STIMULUS_IMAGE',
        'EXAM_COVER_IMAGE',
        'EXPLANATION_ATTACHMENT'
      ]),
      mime_type: Object.freeze([
        'image/png',
        'image/jpeg',
        'image/webp',
        'image/gif',
        'application/pdf'
      ]),
      status: Object.freeze(['ACTIVE', 'DELETED'])
    }),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze(['size_bytes']),
    positiveSatangFields: Object.freeze([])
  }),

  Invoices: Object.freeze({
    sheetName: 'Invoices',
    primaryKey: 'invoice_id',
    idPrefix: 'inv_',
    hasVersion: true,
    headers: Object.freeze([
      'invoice_id',
      'user_id',
      'course_id',
      'installment_label',
      'amount_satang',
      'due_date_bkk',
      'status',
      'active_payment_id',
      'reservation_expires_at_utc',
      'last_rejection_reason',
      'created_at_utc',
      'updated_at_utc',
      'version'
    ]),
    requiredFields: Object.freeze([
      'invoice_id',
      'user_id',
      'installment_label',
      'amount_satang',
      'due_date_bkk',
      'status',
      'created_at_utc',
      'updated_at_utc'
    ]),
    enums: Object.freeze({
      status: Object.freeze([
        'UNPAID',
        'RESERVED',
        'AWAITING_VERIFICATION',
        'APPROVING',
        'PAID',
        'REJECTED',
        'CANCELLED'
      ])
    }),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze(['amount_satang', 'version']),
    positiveSatangFields: Object.freeze(['amount_satang'])
  }),

  Payments: Object.freeze({
    sheetName: 'Payments',
    primaryKey: 'payment_id',
    idPrefix: 'pay_',
    hasVersion: true,
    headers: Object.freeze([
      'payment_id',
      'user_id',
      'invoice_ids_json',
      'total_amount_satang',
      'method',
      'status',
      'idempotency_key',
      'expires_at_utc',
      'receipt_file_id',
      'submitted_at_utc',
      'reviewed_by_user_id',
      'reviewed_at_utc',
      'rejection_reason',
      'created_at_utc',
      'updated_at_utc',
      'version'
    ]),
    requiredFields: Object.freeze([
      'payment_id',
      'user_id',
      'invoice_ids_json',
      'total_amount_satang',
      'method',
      'status',
      'idempotency_key',
      'created_at_utc',
      'updated_at_utc'
    ]),
    enums: Object.freeze({
      method: Object.freeze(['PROMPTPAY_QR', 'BANK_TRANSFER']),
      status: Object.freeze([
        'PENDING_TRANSFER',
        'RECEIPT_UPLOADED',
        'AWAITING_VERIFICATION',
        'APPROVING',
        'PAID',
        'APPROVED',
        'REJECTED',
        'EXPIRED',
        'CANCELLED'
      ])
    }),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze(['total_amount_satang', 'version']),
    positiveSatangFields: Object.freeze(['total_amount_satang'])
  }),

  PaymentJournal: Object.freeze({
    sheetName: 'PaymentJournal',
    primaryKey: 'journal_id',
    idPrefix: 'jrn_',
    hasVersion: false,
    headers: Object.freeze([
      'journal_id',
      'operation_type',
      'idempotency_key',
      'payment_id',
      'invoice_ids_json',
      'target_payment_status',
      'target_invoice_status',
      'payload_json',
      'journal_status',
      'created_at_utc',
      'committed_at_utc'
    ]),
    requiredFields: Object.freeze([
      'journal_id',
      'operation_type',
      'idempotency_key',
      'payment_id',
      'invoice_ids_json',
      'target_payment_status',
      'target_invoice_status',
      'journal_status',
      'created_at_utc'
    ]),
    enums: Object.freeze({
      operation_type: Object.freeze([
        'RESERVE',
        'SUBMIT_FOR_VERIFICATION',
        'CANCEL_RESERVATION',
        'ADMIN_APPROVE',
        'ADMIN_REJECT',
        'EXPIRE_RESERVATION'
      ]),
      journal_status: Object.freeze(['PENDING', 'COMMITTED', 'HALTED_INCONSISTENT'])
    }),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze([]),
    positiveSatangFields: Object.freeze([])
  }),

  UnavailabilityRequests: Object.freeze({
    sheetName: 'UnavailabilityRequests',
    primaryKey: 'request_id',
    idPrefix: 'unv_',
    hasVersion: true,
    headers: Object.freeze([
      'request_id',
      'user_id',
      'course_id',
      'unavailable_start_date_bkk',
      'unavailable_end_date_bkk',
      'reason',
      'email_recipient',
      'email_delivery_status',
      'email_error_detail',
      'email_attempted_at_utc',
      'admin_note',
      'created_at_utc',
      'version'
    ]),
    requiredFields: Object.freeze([
      'request_id',
      'user_id',
      'unavailable_start_date_bkk',
      'unavailable_end_date_bkk',
      'reason',
      'email_delivery_status',
      'created_at_utc'
    ]),
    enums: Object.freeze({
      email_delivery_status: Object.freeze([
        'PENDING_ATTEMPT',
        'SENT',
        'FAILED',
        'QUOTA_EXCEEDED',
        'RECIPIENT_NOT_CONFIGURED',
        'UNCERTAIN_POST_SEND_UPDATE_FAILED'
      ])
    }),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze(['version']),
    positiveSatangFields: Object.freeze([])
  }),

  Settings: Object.freeze({
    sheetName: 'Settings',
    primaryKey: 'setting_key',
    idPrefix: 'set_',
    hasVersion: true,
    headers: Object.freeze([
      'setting_key',
      'setting_value',
      'updated_by_user_id',
      'updated_at_utc',
      'version'
    ]),
    requiredFields: Object.freeze(['setting_key', 'updated_at_utc']),
    enums: Object.freeze({}),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze(['version']),
    positiveSatangFields: Object.freeze([])
  }),

  AuditEvents: Object.freeze({
    sheetName: 'AuditEvents',
    primaryKey: 'audit_id',
    idPrefix: 'aud_',
    hasVersion: false,
    headers: Object.freeze([
      'audit_id',
      'actor_user_id',
      'actor_role',
      'event_type',
      'target_entity_type',
      'target_entity_id',
      'summary_json',
      'created_at_utc'
    ]),
    requiredFields: Object.freeze([
      'audit_id',
      'actor_user_id',
      'actor_role',
      'event_type',
      'target_entity_type',
      'created_at_utc'
    ]),
    enums: Object.freeze({
      actor_role: Object.freeze(['STUDENT', 'ADMIN', 'ANONYMOUS', 'SYSTEM'])
    }),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze([]),
    positiveSatangFields: Object.freeze([])
  }),

  AssessmentScores: Object.freeze({
    sheetName: 'AssessmentScores',
    primaryKey: 'score_id',
    idPrefix: 'scr_',
    hasVersion: true,
    headers: Object.freeze([
      'score_id',
      'course_id',
      'assessment_id',
      'student_user_id',
      'score_points',
      'max_points',
      'feedback_text',
      'status',
      'published_at_utc',
      'updated_by_user_id',
      'created_at_utc',
      'updated_at_utc',
      'version'
    ]),
    requiredFields: Object.freeze([
      'score_id',
      'course_id',
      'assessment_id',
      'student_user_id',
      'score_points',
      'max_points',
      'status',
      'created_at_utc',
      'updated_at_utc'
    ]),
    enums: Object.freeze({
      status: Object.freeze(['DRAFT', 'PUBLISHED', 'ARCHIVED'])
    }),
    booleanFields: Object.freeze([]),
    integerFields: Object.freeze(['version']),
    positiveSatangFields: Object.freeze([])
  })
}));
if (typeof ensureExamIntegrityPhaseASchemasRegistered_ === "function") {
  try { ensureExamIntegrityPhaseASchemasRegistered_(); } catch (e) {}
}

/**
 * Default non-sensitive school settings seeded into the Settings tab during setup
 * only if the setting_key does not already exist.
 */
var PB_DEFAULT_SETTINGS_SEED_ = Object.freeze([
  Object.freeze({
    setting_key: 'SCHOOL_NAME',
    setting_value: PB_APP_CONSTANTS_.SCHOOL_NAME_DEFAULT
  }),
  Object.freeze({
    setting_key: 'LOGO_FILE_ID',
    setting_value: ''
  }),
  Object.freeze({
    setting_key: 'CONTACT_LINE_URL',
    setting_value: PB_APP_CONSTANTS_.CONTACT_DEFAULTS.lineUrl
  }),
  Object.freeze({
    setting_key: 'CONTACT_FACEBOOK_URL',
    setting_value: PB_APP_CONSTANTS_.CONTACT_DEFAULTS.facebookUrl
  }),
  Object.freeze({
    setting_key: 'CONTACT_EMAIL',
    setting_value: PB_APP_CONSTANTS_.CONTACT_DEFAULTS.email
  }),
  Object.freeze({
    setting_key: 'ADMIN_NOTIFICATION_EMAIL',
    setting_value: ''
  }),
  Object.freeze({
    setting_key: 'BANK_NAME',
    setting_value: 'Placeholder Bank (Configure in Admin Settings)'
  }),
  Object.freeze({
    setting_key: 'BANK_ACCOUNT_NAME',
    setting_value: 'Pattanabhumi Biology Tutoring (Placeholder)'
  }),
  Object.freeze({
    setting_key: 'BANK_ACCOUNT_NUMBER',
    setting_value: '000-0-00000-0'
  }),
  Object.freeze({
    setting_key: 'PROMPTPAY_QR_FILE_ID',
    setting_value: ''
  }),
  Object.freeze({
    setting_key: 'PROMPTPAY_ID_DISPLAY',
    setting_value: '000-000-0000'
  }),
  Object.freeze({
    setting_key: 'CURRENT_PRIVACY_NOTICE_VERSION',
    setting_value: PB_APP_CONSTANTS_.CURRENT_PRIVACY_NOTICE_VERSION_DEFAULT
  }),
  Object.freeze({
    setting_key: 'PRIVACY_NOTICE_DOCUMENT_TEXT',
    setting_value:
      '1. Educational & Administrative Data Processed\nPattanabhumi Biology processes your account profile, course enrollments, tuition installment records, uploaded payment receipts, and class unavailability reports in the Asia/Bangkok timezone.\n\n2. Where Portal Records Are Stored\nApplication records are stored in a private Google Sheet, uploaded files are stored in restricted Google Drive folders, class schedules are read from Google Calendar, and unavailability notifications are sent via Gmail / MailApp.\n\n3. Essential Browser Storage & Cookie Policy\nBy default, session tokens reside in memory only; optional Remember me uses localStorage. No custom HttpOnly cookies or tracking cookies are used.\n\n4. School Legal Review & Minor Students\nPattanabhumi Biology administration must review this notice with legal counsel, establish official data-retention schedules, and verify parental or legal guardian consent requirements for minor students.'
  })
]);

/**
 * Creates a structured application Error with a canonical pbCode and optional fieldErrors.
 *
 * @param {string} code Error code from PB_ERROR_CODES_.
 * @param {string} message Human-readable error message.
 * @param {Object=} opt_fieldErrors Optional map of field-specific validation errors.
 * @return {Error} Augmented Error object.
 */
function createAppError_(code, message, opt_fieldErrors) {
  var err = new Error(message);
  var resolvedCode = code || PB_ERROR_CODES_.ERR_INTERNAL;
  err.pbCode = resolvedCode;
  err.code = resolvedCode;
  err.isAppError = true;
  err.fieldErrors = opt_fieldErrors || {};
  return err;
}

/**
 * Returns the current server UTC timestamp in ISO-8601 format (YYYY-MM-DDTHH:mm:ss.sssZ).
 *
 * @return {string}
 */
function nowUtcIso_() {
  return new Date().toISOString();
}

/**
 * Compatibility alias for `nowUtcIso_()` used across Step 8/9 modules.
 *
 * @return {string} Current UTC ISO-8601 timestamp.
 */
function getNowUtcIso_() {
  return nowUtcIso_();
}

/**
 * Formats a Date object or UTC ISO string in Asia/Bangkok time.
 *
 * @param {(Date|string)=} opt_dateOrIso Date or ISO string; defaults to now.
 * @param {string=} opt_pattern Format pattern; defaults to "yyyy-MM-dd HH:mm:ss 'ICT (UTC+07:00)'".
 * @return {string}
 */
function formatBangkokTimestamp_(opt_dateOrIso, opt_pattern) {
  var d = opt_dateOrIso ? new Date(opt_dateOrIso) : new Date();
  if (isNaN(d.getTime())) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Invalid date supplied to formatBangkokTimestamp_.'
    );
  }
  var pattern = opt_pattern || "yyyy-MM-dd HH:mm:ss 'ICT (UTC+07:00)'";
  return Utilities.formatDate(d, PB_APP_CONSTANTS_.TIMEZONE, pattern);
}

/**
 * Returns today's date string in Asia/Bangkok as YYYY-MM-DD.
 *
 * @return {string}
 */
function todayBangkokDateString_() {
  return formatBangkokTimestamp_(new Date(), 'yyyy-MM-dd');
}

/**
 * Sanitizes and validates a client-supplied correlation requestId.
 * Ensures the correlation ID never contains credentials, tokens, or control characters.
 *
 * @param {*} rawRequestId Candidate requestId from requestEnvelope.
 * @return {string} Safe correlation ID matching ^req_[a-zA-Z0-9_-]{4,56}$.
 */
function normalizeCorrelationRequestId_(rawRequestId) {
  if (typeof rawRequestId === 'string') {
    var trimmed = rawRequestId.trim();
    if (
      trimmed.length >= 8 &&
      trimmed.length <= PB_APP_CONSTANTS_.MAX_REQUEST_ID_LENGTH &&
      /^req_[a-zA-Z0-9_-]+$/.test(trimmed) &&
      !/token|pass|secret|auth|ses_/i.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return (
    'req_srv_' +
    new Date().getTime() +
    '_' +
    Math.floor(Math.random() * 1000000)
  );
}

/**
 * Recursively converts any Date instances into ISO-8601 UTC strings and strips
 * functions or undefined properties so return values are 100% compatible with
 * google.script.run serialization.
 *
 * @param {*} value Arbitrary value to serialize.
 * @return {*} JSON-safe serializable value.
 */
function sanitizeSerializableValue_(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    var arrOut = [];
    for (var i = 0; i < value.length; i++) {
      arrOut.push(sanitizeSerializableValue_(value[i]));
    }
    return arrOut;
  }
  if (typeof value === 'object') {
    var objOut = {};
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var propVal = value[key];
      if (typeof propVal !== 'function' && propVal !== undefined) {
        objOut[key] = sanitizeSerializableValue_(propVal);
      }
    }
    return objOut;
  }
  return String(value);
}

/**
 * Estimates UTF-8 byte length of a JSON-serializable object.
 *
 * @param {*} obj Serializable value.
 * @return {number} Estimated UTF-8 byte length.
 */
function estimateSerializedBytes_(obj) {
  var jsonStr = '';
  try {
    jsonStr = JSON.stringify(obj);
  } catch (err) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Payload is not valid serializable JSON.'
    );
  }
  if (!jsonStr) {
    return 0;
  }
  return Utilities.newBlob(jsonStr).getBytes().length;
}

/**
 * Reads all ScriptProperties as a plain object map.
 *
 * @return {Object<string, string>}
 */
function getAllScriptPropertiesMap_() {
  var props = PropertiesService.getScriptProperties();
  return props ? props.getProperties() : {};
}

/**
 * Reads a required ScriptProperty and throws ERR_CONFIG_MISSING if absent or blank.
 *
 * @param {string} propertyKey Key name in ScriptProperties.
 * @param {Object<string, string>=} opt_propsMap Optional pre-fetched properties map.
 * @return {string} Trimmed property value.
 */
function getRequiredScriptProperty_(propertyKey, opt_propsMap) {
  var map = opt_propsMap || getAllScriptPropertiesMap_();
  var val = map[propertyKey];
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_CONFIG_MISSING,
      'Missing required Script Property "' +
        propertyKey +
        '". Please add it in Project Settings (gear icon) -> Script Properties.'
    );
  }
  return val.trim();
}

/**
 * Validates that a resource ID string (Spreadsheet ID, Drive Folder ID, Calendar ID)
 * is non-empty and free of whitespace or URL prefixes.
 *
 * @param {string} keyName Property name for error messages.
 * @param {string} rawId Raw ID string from ScriptProperties.
 * @return {string} Validated ID string.
 */
function validateResourceIdFormat_(keyName, rawId) {
  if (typeof rawId !== 'string' || rawId.trim().length === 0) {
    var emptyErr = {};
    emptyErr[keyName] = 'Value cannot be empty.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_CONFIG_MISSING,
      'Required configuration "' + keyName + '" is missing or empty.',
      emptyErr
    );
  }
  var trimmed = rawId.trim();
  if (/^https?:\/\//i.test(trimmed) || /\.ics$/i.test(trimmed)) {
    var urlErr = {};
    urlErr[keyName] =
      'Provide the resource ID only, not a full https:// URL or .ics address.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Configuration "' +
        keyName +
        '" looks like a URL or iCal address instead of an ID.',
      urlErr
    );
  }
  if (/\s/.test(trimmed) || trimmed.length < 5 || trimmed.length > 256) {
    var fmtErr = {};
    fmtErr[keyName] = 'Resource ID must be 5..256 characters with no spaces.';
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Configuration "' + keyName + '" has an invalid format.',
      fmtErr
    );
  }
  return trimmed;
}

/**
 * Generates a unique entity primary key with the given prefix (e.g., "aud_", "usr_")
 * using keyed HMAC-SHA256 derivation in CryptoService.gs when available.
 *
 * @param {string} prefix Short entity prefix ending with "_".
 * @return {string} Prefixed 24-hex-character identifier.
 */
function generateEntityId_(prefix) {
  var safePrefix = typeof prefix === 'string' && prefix.length > 0 ? prefix : 'id_';
  if (typeof deriveRandomBytesHex_ === 'function') {
    try {
      return safePrefix + deriveRandomBytesHex_(12, 'PB_ENTITY_ID_' + safePrefix);
    } catch (fallbackErr) {
      /* Fall back if APP_MASTER_SECRET is not yet provisioned during initial setup */
    }
  }
  var map = {};
  try {
    map = getAllScriptPropertiesMap_();
  } catch (ignoreErr) {
    map = {};
  }
  var secretKey =
    map.APP_MASTER_SECRET && map.APP_MASTER_SECRET.length >= 32
      ? map.APP_MASTER_SECRET
      : 'PB_FALLBACK_ID_KEY_BEFORE_SETUP';
  var message =
    safePrefix +
    '|' +
    Utilities.getUuid() +
    '|' +
    new Date().getTime() +
    '|' +
    Math.random();
  var digestBytes = Utilities.computeHmacSha256Signature(message, secretKey);
  var hex = bytesToHex_(digestBytes).slice(0, 24);
  return safePrefix + hex;
}

/**
 * Converts a signed byte array from Apps Script Utilities into a lowercase hex string.
 *
 * @param {Array<number>} byteArray Signed byte array (-128..127).
 * @return {string} Lowercase hex string.
 */
function bytesToHex_(byteArray) {
  var out = [];
  for (var i = 0; i < byteArray.length; i++) {
    var b = byteArray[i] & 0xff;
    out.push((b < 16 ? '0' : '') + b.toString(16));
  }
  return out.join('');
}

/**
 * Converts an even-length hex string into a signed byte array (-128..127)
 * compatible with Google Apps Script Utilities byte[] methods.
 *
 * @param {string} hexStr Hexadecimal string.
 * @return {Array<number>} Signed byte array.
 */
function hexToSignedBytes_(hexStr) {
  if (typeof hexStr !== 'string' || hexStr.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hexStr)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Invalid hexadecimal string supplied to hexToSignedBytes_.'
    );
  }
  var out = [];
  for (var i = 0; i < hexStr.length; i += 2) {
    var uByte = parseInt(hexStr.substr(i, 2), 16);
    out.push(uByte > 127 ? uByte - 256 : uByte);
  }
  return out;
}

/**
 * Validates and normalizes pagination parameters ({ limit, cursor }).
 *
 * @param {Object=} opt_query Optional pagination query object.
 * @return {{ limit: number, cursor: string }}
 */
function normalizePaginationOptions_(opt_query) {
  var q = opt_query && typeof opt_query === 'object' ? opt_query : {};
  var limit = PB_APP_CONSTANTS_.PAGINATION_DEFAULT_LIMIT;

  if (q.limit !== undefined && q.limit !== null && q.limit !== '') {
    var parsed = Number(q.limit);
    if (!isFinite(parsed) || Math.floor(parsed) !== parsed || parsed < 1) {
      throw createAppError_(
        PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
        'Pagination limit must be a positive integer.',
        { limit: 'Must be an integer >= 1.' }
      );
    }
    limit = Math.min(parsed, PB_APP_CONSTANTS_.PAGINATION_MAX_LIMIT);
  }

  var cursor = '';
  if (typeof q.cursor === 'string' && q.cursor.trim().length > 0) {
    cursor = q.cursor.trim().slice(0, 120);
  }

  return {
    limit: limit,
    cursor: cursor
  };
}

/**
 * Validates a record object against the authoritative schema for a worksheet.
 *
 * @param {string} sheetName Target worksheet name.
 * @param {Object} record Candidate record object keyed by column header.
 * @return {Object} Normalized copy of the record ready for serialization.
 */
/**
 * Step 15 Defect Remediation (F-02): Spreadsheet Formula Injection Defense (CWE-1236).
 * Detects whether a candidate string value begins with a spreadsheet formula trigger
 * (`=`, `+`, `-`, `@`, Tab `\t`, or Carriage Return `\r`), including after leading spaces/newlines.
 *
 * @param {*} rawValue Candidate cell string.
 * @return {boolean} True if the value starts with a dangerous spreadsheet formula prefix.
 */
function isDangerousSpreadsheetFormulaInputStep15_(rawValue) {
  if (typeof rawValue !== 'string' || rawValue.length === 0) {
    return false;
  }
  if (/^[\t\r]/.test(rawValue)) {
    return true;
  }
  if (/^[ \t\r\n]*[=+\-@]/.test(rawValue)) {
    return true;
  }
  return false;
}

/**
 * Step 15 Defense-in-Depth Cell Serializer Guard:
 * Neutralizes any string cell starting with `=`, `+`, `-`, `@`, `\t`, or `\r` by prefixing
 * a literal single apostrophe (`'`) before writing to Google Sheets via `appendRow` or `setValues`.
 *
 * @param {*} strValue String value being serialized into a spreadsheet cell.
 * @return {string} Safe string cell value that Google Sheets will never evaluate as a formula.
 */
function neutralizeSpreadsheetFormulaCellStep15_(strValue) {
  var s = strValue === undefined || strValue === null ? '' : String(strValue);
  if (s.length === 0) {
    return '';
  }
  if (isDangerousSpreadsheetFormulaInputStep15_(s)) {
    return "'" + s;
  }
  return s;
}

function validateRecordAgainstSchema_(sheetName, record) {
  if (!Object.prototype.hasOwnProperty.call(PB_SHEET_SCHEMAS_, sheetName)) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Unknown worksheet schema: ' + String(sheetName)
    );
  }
  if (!record || typeof record !== 'object') {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Record for sheet "' + sheetName + '" must be a non-null object.'
    );
  }

  var schema = PB_SHEET_SCHEMAS_[sheetName];
  var normalized = {};
  var fieldErrors = {};

  for (var i = 0; i < schema.headers.length; i++) {
    var col = schema.headers[i];
    var rawVal = Object.prototype.hasOwnProperty.call(record, col) ? record[col] : '';
    if (rawVal === undefined || rawVal === null) {
      rawVal = '';
    }
    normalized[col] = rawVal;
  }

  for (var r = 0; r < schema.requiredFields.length; r++) {
    var reqCol = schema.requiredFields[r];
    var val = normalized[reqCol];
    if (
      val === '' ||
      val === null ||
      val === undefined ||
      (typeof val === 'string' && val.trim().length === 0)
    ) {
      fieldErrors[reqCol] = 'Field "' + reqCol + '" is required.';
    }
  }

  for (var b = 0; b < schema.booleanFields.length; b++) {
    var boolCol = schema.booleanFields[b];
    var bVal = normalized[boolCol];
    if (bVal === '' || bVal === false || bVal === 'FALSE' || bVal === 'false') {
      normalized[boolCol] = false;
    } else if (bVal === true || bVal === 'TRUE' || bVal === 'true') {
      normalized[boolCol] = true;
    } else {
      fieldErrors[boolCol] = 'Field "' + boolCol + '" must be a boolean (true or false).';
    }
  }

  for (var n = 0; n < schema.integerFields.length; n++) {
    var intCol = schema.integerFields[n];
    var iVal = normalized[intCol];
    if (iVal === '' && schema.requiredFields.indexOf(intCol) === -1 && intCol !== 'version') {
      normalized[intCol] = 0;
    } else {
      var num = Number(iVal);
      if (
        typeof iVal === 'boolean' ||
        iVal === '' ||
        !isFinite(num) ||
        Math.floor(num) !== num ||
        num < 0
      ) {
        fieldErrors[intCol] =
          'Field "' + intCol + '" must be a non-negative integer.';
      } else {
        normalized[intCol] = num;
      }
    }
  }

  for (var s = 0; s < schema.positiveSatangFields.length; s++) {
    var satCol = schema.positiveSatangFields[s];
    var sVal = normalized[satCol];
    if (typeof sVal !== 'number' || Math.floor(sVal) !== sVal || sVal <= 0) {
      fieldErrors[satCol] =
        'Monetary field "' +
        satCol +
        '" must be a positive integer in satang (e.g. 250000 for 2,500.00 THB).';
    }
  }

  var enumCols = Object.keys(schema.enums);
  for (var e = 0; e < enumCols.length; e++) {
    var enumCol = enumCols[e];
    var allowedList = schema.enums[enumCol];
    var eVal = String(normalized[enumCol] || '');
    if (allowedList.indexOf(eVal) === -1) {
      fieldErrors[enumCol] =
        'Invalid value "' +
        eVal +
        '" for "' +
        enumCol +
        '". Allowed: ' +
        allowedList.join(', ') +
        '.';
    }
  }

  if (sheetName === 'Users') {
    var pwdHash = String(normalized.password_hash || '');
    if (
      !/^pbkdf2_sha256\$\d+\$[0-9a-f]{32}\$[0-9a-f]{64}$/i.test(pwdHash)
    ) {
      fieldErrors.password_hash =
        'Plaintext or fast-digest passwords are forbidden. password_hash must follow pbkdf2_sha256$<iterations>$<salt_32_hex>$<hash_64_hex>.';
    }
  }

  for (var c = 0; c < schema.headers.length; c++) {
    var hCol = schema.headers[c];
    var cellVal = normalized[hCol];
    if (typeof cellVal === 'string') {
      if (cellVal.length > PB_APP_CONSTANTS_.MAX_SHEET_CELL_CHARS) {
        fieldErrors[hCol] =
          'Field "' +
          hCol +
          '" exceeds the maximum allowed cell length of ' +
          PB_APP_CONSTANTS_.MAX_SHEET_CELL_CHARS +
          ' characters.';
      } else if (isDangerousSpreadsheetFormulaInputStep15_(cellVal)) {
        fieldErrors[hCol] =
          'Field "' +
          hCol +
          '" starts with a prohibited spreadsheet formula trigger (=, +, -, @, Tab, or CR).';
      }
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw createAppError_(
      PB_ERROR_CODES_.ERR_VALIDATION_FAILED,
      'Validation failed for "' +
        sheetName +
        '": ' +
        JSON.stringify(fieldErrors),
      fieldErrors
    );
  }

  return normalized;
}

/**
 * Returns a non-sensitive configuration and readiness summary for the Step 4 status page.
 *
 * @return {Object} Non-sensitive configuration status payload.
 */
function getPublicShellStatus_() {
  var missingKeys = [];
  var configuredKeysCount = 0;
  var scriptPropsAvailable = false;

  try {
    var allProps = getAllScriptPropertiesMap_();
    scriptPropsAvailable = true;

    for (var i = 0; i < PB_REQUIRED_SCRIPT_PROPERTIES_.length; i++) {
      var keyName = PB_REQUIRED_SCRIPT_PROPERTIES_[i];
      var rawValue = allProps[keyName];
      if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
        configuredKeysCount++;
      } else {
        missingKeys.push(keyName);
      }
    }
  } catch (err) {
    scriptPropsAvailable = false;
    missingKeys = PB_REQUIRED_SCRIPT_PROPERTIES_.slice();
  }

  var now = new Date();
  var bangkokFormattedTime = formatBangkokTimestamp_(now);

  return {
    schoolName: PB_APP_CONSTANTS_.SCHOOL_NAME_DEFAULT,
    logoText: PB_APP_CONSTANTS_.LOGO_TEXT_DEFAULT,
    stageLabel: PB_APP_CONSTANTS_.APP_STAGE_LABEL,
    currentStep: PB_APP_CONSTANTS_.CURRENT_STEP,
    isApplicationComplete: false,
    authenticationImplemented: true,
    databaseConnected: configuredKeysCount === PB_REQUIRED_SCRIPT_PROPERTIES_.length,
    timezone: PB_APP_CONSTANTS_.TIMEZONE,
    runtimeEngine: PB_APP_CONSTANTS_.RUNTIME_ENGINE,
    serverTimeUtc: now.toISOString(),
    serverTimeBangkok: bangkokFormattedTime,
    rpcLimits: {
      maxRequestBytes: PB_APP_CONSTANTS_.MAX_RPC_REQUEST_BYTES,
      maxFileUploadRequestBytes: PB_APP_CONSTANTS_.MAX_RPC_FILE_UPLOAD_REQUEST_BYTES,
      maxResponseBytes: PB_APP_CONSTANTS_.MAX_RPC_RESPONSE_BYTES
    },
    contact: {
      lineUrl: PB_APP_CONSTANTS_.CONTACT_DEFAULTS.lineUrl,
      facebookUrl: PB_APP_CONSTANTS_.CONTACT_DEFAULTS.facebookUrl,
      email: PB_APP_CONSTANTS_.CONTACT_DEFAULTS.email
    },
    configCheck: {
      scriptPropertiesAccessible: scriptPropsAvailable,
      requiredKeysTotal: PB_REQUIRED_SCRIPT_PROPERTIES_.length,
      configuredKeysCount: configuredKeysCount,
      missingKeyNames: missingKeys,
      summaryMessage:
        missingKeys.length === 0
          ? 'Step 4 authentication, PBKDF2-HMAC-SHA256 password hashing, session validation, and login throttling are active.'
          : 'Step 4 authentication code is loaded, but ScriptProperties (' +
            missingKeys.join(', ') +
            ') are missing. Configure them in Project Settings and run setupEnvironmentFromEditor_.'
    }
  };
}

/**
 * Evaluates whether each school contact channel (LINE, Facebook, Email) has been
 * configured with a real value by the administrator versus remaining empty or on
 * the initial installation placeholder.
 *
 * @param {Object=} opt_rawContact `{ lineUrl, facebookUrl, email }`
 * @return {Object} `{ lineUrl, lineConfigured, facebookUrl, facebookConfigured, email, emailConfigured }`
 */
function evaluateContactChannelsStatus_(opt_rawContact) {
  var raw = opt_rawContact && typeof opt_rawContact === 'object' ? opt_rawContact : {};
  var lineUrl = typeof raw.lineUrl === 'string' ? raw.lineUrl.trim() : '';
  var facebookUrl = typeof raw.facebookUrl === 'string' ? raw.facebookUrl.trim() : '';
  var email = typeof raw.email === 'string' ? raw.email.trim() : '';

  var lineConfigured =
    /^https:\/\/[^\s]+$/i.test(lineUrl) &&
    lineUrl !== PB_APP_CONSTANTS_.CONTACT_DEFAULTS.lineUrl &&
    lineUrl.toLowerCase() !== 'https://line.me' &&
    lineUrl.toLowerCase() !== 'https://line.me/' &&
    lineUrl.toLowerCase().indexOf('placeholder') === -1;

  var facebookConfigured =
    /^https:\/\/[^\s]+$/i.test(facebookUrl) &&
    facebookUrl !== PB_APP_CONSTANTS_.CONTACT_DEFAULTS.facebookUrl &&
    facebookUrl.toLowerCase() !== 'https://www.facebook.com' &&
    facebookUrl.toLowerCase() !== 'https://www.facebook.com/' &&
    facebookUrl.toLowerCase().indexOf('placeholder') === -1;

  var emailConfigured =
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    email.toLowerCase() !== PB_APP_CONSTANTS_.CONTACT_DEFAULTS.email.toLowerCase() &&
    email.toLowerCase().indexOf('example.com') === -1 &&
    email.toLowerCase().indexOf('placeholder') === -1;

  return {
    lineUrl: lineConfigured ? lineUrl : '',
    lineConfigured: lineConfigured,
    facebookUrl: facebookConfigured ? facebookUrl : '',
    facebookConfigured: facebookConfigured,
    email: emailConfigured ? email : '',
    emailConfigured: emailConfigured
  };
}


/**
 * Inspects the raw binary bytes of a file blob to detect its true raster image format
 * from magic-byte file signatures rather than trusting file extensions or hardcoding image/png.
 *
 * Approved project raster formats:
 * - PNG (`image/png`): 89 50 4E 47 0D 0A 1A 0A
 * - JPEG (`image/jpeg`): FF D8 FF
 * - WebP (`image/webp`): 52 49 46 46 (`RIFF`) at 0..3 and 57 45 42 50 (`WEBP`) at 8..11
 *
 * @param {Array<number>} rawBytes Signed byte array returned by `Blob.getBytes()`.
 * @return {{ validRaster: boolean, mimeType: string, formatLabel: string, detectedHeaderDesc: string }}
 */
function detectLogoRasterSignature_(rawBytes) {
  if (!Array.isArray(rawBytes) || rawBytes.length < 4) {
    return {
      validRaster: false,
      mimeType: '',
      formatLabel: 'EMPTY_OR_TOO_SHORT',
      detectedHeaderDesc: 'File has fewer than 4 bytes.'
    };
  }

  function u8(idx) {
    return (rawBytes[idx] + 256) % 256;
  }

  var b0 = u8(0);
  var b1 = u8(1);
  var b2 = u8(2);
  var b3 = u8(3);

  /* 1. PNG: 89 50 4E 47 0D 0A 1A 0A */
  if (
    rawBytes.length >= 8 &&
    b0 === 0x89 &&
    b1 === 0x50 &&
    b2 === 0x4e &&
    b3 === 0x47 &&
    u8(4) === 0x0d &&
    u8(5) === 0x0a &&
    u8(6) === 0x1a &&
    u8(7) === 0x0a
  ) {
    return {
      validRaster: true,
      mimeType: 'image/png',
      formatLabel: 'PNG',
      detectedHeaderDesc: 'PNG magic signature (89 50 4E 47 0D 0A 1A 0A)'
    };
  }

  /* 2. JPEG: FF D8 FF */
  if (b0 === 0xff && b1 === 0xd8 && b2 === 0xff) {
    return {
      validRaster: true,
      mimeType: 'image/jpeg',
      formatLabel: 'JPEG',
      detectedHeaderDesc: 'JPEG magic signature (FF D8 FF)'
    };
  }

  /* 3. WebP: RIFF....WEBP */
  if (
    rawBytes.length >= 12 &&
    b0 === 0x52 &&
    b1 === 0x49 &&
    b2 === 0x46 &&
    b3 === 0x46 &&
    u8(8) === 0x57 &&
    u8(9) === 0x45 &&
    u8(10) === 0x42 &&
    u8(11) === 0x50
  ) {
    return {
      validRaster: true,
      mimeType: 'image/webp',
      formatLabel: 'WEBP',
      detectedHeaderDesc: 'WebP magic signature (RIFF....WEBP)'
    };
  }

  /* Check common unsupported formats to give administrators an exact conversion hint */
  if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) {
    return {
      validRaster: false,
      mimeType: 'application/pdf',
      formatLabel: 'PDF',
      detectedHeaderDesc: 'PDF document (%PDF). Convert the logo to PNG, JPEG, or WebP.'
    };
  }

  if (b0 === 0x47 && b1 === 0x49 && b2 === 0x46 && b3 === 0x38) {
    return {
      validRaster: true,
      mimeType: 'image/gif',
      formatLabel: 'GIF',
      detectedHeaderDesc: 'GIF magic signature (GIF87a/GIF89a)'
    };
  }

  if (b0 === 0x42 && b1 === 0x4d) {
    return {
      validRaster: false,
      mimeType: 'image/bmp',
      formatLabel: 'BMP',
      detectedHeaderDesc: 'BMP bitmap (BM). Convert the logo to PNG, JPEG, or WebP.'
    };
  }

  var asciiHead = '';
  var headLen = Math.min(rawBytes.length, 64);
  for (var i = 0; i < headLen; i++) {
    var code = u8(i);
    if (code >= 32 && code <= 126) {
      asciiHead += String.fromCharCode(code);
    }
  }
  if (
    asciiHead.toLowerCase().indexOf('<svg') !== -1 ||
    asciiHead.toLowerCase().indexOf('<?xml') !== -1
  ) {
    return {
      validRaster: false,
      mimeType: 'image/svg+xml',
      formatLabel: 'SVG',
      detectedHeaderDesc: 'SVG vector XML. Export the logo as a raster PNG, JPEG, or WebP file under 2 MB.'
    };
  }

  var hexPreview = [b0, b1, b2, b3]
    .map(function (n) {
      var h = n.toString(16).toUpperCase();
      return h.length < 2 ? '0' + h : h;
    })
    .join(' ');

  return {
    validRaster: false,
    mimeType: '',
    formatLabel: 'UNKNOWN',
    detectedHeaderDesc: 'Unrecognized binary header (' + hexPreview + '). Convert the file to PNG, JPEG, or WebP.'
  };
}

/**
 * Phase 3: Calculates the 3 active Thai university entrance cohort labels (DEKxx)
 * based on the current calendar year in `Asia/Bangkok` (or an optional administrator override).
 *
 * Formula:
 * - In 2026: firstDek = 70 -> ["DEK70", "DEK71", "DEK72"]
 * - In 2027: firstDek = 71 -> ["DEK71", "DEK72", "DEK73"]
 * - In 2028: firstDek = 72 -> ["DEK72", "DEK73", "DEK74"]
 * - General: firstDek = 70 + (bangkokYear - 2026)
 *
 * @param {number=} opt_bangkokYear 4-digit year in Asia/Bangkok.
 * @param {string=} opt_dekMode Optional mode ('AUTO_YEAR' or 'MANUAL_OVERRIDE').
 * @param {number=} opt_manualBaseDek Optional manual starting DEK number (e.g. 70).
 * @return {Object} `{ bangkokYear, mode, baseDekNumber, cohorts, staticGreetingText, ariaLabelText }`
 */
function calculatePublicDekCohortsPhase3_(opt_bangkokYear, opt_dekMode, opt_manualBaseDek) {
  var year = Number(opt_bangkokYear);
  if (!year || isNaN(year) || year < 2020 || year > 2100) {
    try {
      var bkkYearStr = Utilities.formatDate(
        new Date(),
        PB_APP_CONSTANTS_.TIMEZONE,
        'yyyy'
      );
      year = parseInt(bkkYearStr, 10) || 2026;
    } catch (e) {
      year = 2026;
    }
  } else {
    year = Math.floor(year);
  }

  var mode =
    opt_dekMode === 'MANUAL_OVERRIDE' ? 'MANUAL_OVERRIDE' : 'AUTO_YEAR';
  var manualBase = Number(opt_manualBaseDek);
  var firstDek =
    mode === 'MANUAL_OVERRIDE' && !isNaN(manualBase) && manualBase >= 60 && manualBase <= 150
      ? Math.floor(manualBase)
      : 70 + (year - 2026);

  var cohorts = [
    'DEK' + String(firstDek),
    'DEK' + String(firstDek + 1),
    'DEK' + String(firstDek + 2)
  ];

  return {
    bangkokYear: year,
    mode: mode,
    baseDekNumber: firstDek,
    cohorts: cohorts,
    staticGreetingText:
      'Welcome, ' + cohorts[0] + ', ' + cohorts[1] + ' & ' + cohorts[2],
    ariaLabelText:
      'Welcome, ' + cohorts[0] + ', ' + cohorts[1] + ', and ' + cohorts[2]
  };
}

/**
 * Phase 3: Returns the authoritative default English public website copy for
 * Pattanabhumi Biology (Hero, Platform Introduction & Benefits, How to Log In,
 * About Us, Instructor Profile, and Contact/Help CTA).
 *
 * @param {number=} opt_bangkokYear Optional 4-digit Asia/Bangkok year.
 * @return {Object} Structured default public website content.
 */
function getDefaultPublicWebsiteContentPhase3_(opt_bangkokYear) {
  var dekInfo = calculatePublicDekCohortsPhase3_(opt_bangkokYear, 'AUTO_YEAR', 0);
  var emDash = '\u2014';
  return {
    dek: dekInfo,
    hero: {
      eyebrow: 'Online Learning Platform ' + emDash + ' Asia/Bangkok (UTC+7)',
      title: PB_APP_CONSTANTS_.SCHOOL_NAME_DEFAULT,
      lead:
        'Welcome to the Pattanabhumi Biology online learning platform. We built this portal to give enrolled students a clear, organized, and distraction-free environment for mastering biology.'
    },
    benefits: {
      heading: 'A Better Way to Learn Biology',
      lead:
        'Welcome to the Pattanabhumi Biology online learning platform. We built this portal to give enrolled students a clear, organized, and distraction-free environment for mastering biology.',
      subheading: 'Why Learn on This Platform',
      items: [
        {
          id: 'benefit-materials',
          icon: 'book-open',
          title: 'Centralized Course Materials',
          body:
            'Access your reading materials, downloadable PDFs, and class resources in one organized place ' +
            emDash +
            ' no more searching through scattered chat messages or links.'
        },
        {
          id: 'benefit-progress',
          icon: 'clipboard-check',
          title: 'Clear Progress and Score Tracking',
          body:
            'View course objectives, learning outcomes, assessment links, and your published scores so you always know how you are progressing.'
        },
        {
          id: 'benefit-recordings',
          icon: 'video-play',
          title: 'Recorded Classes and Lesson Documents',
          body:
            'Review class recordings at your own pace, complete with supporting documents listed right below each video lesson.'
        },
        {
          id: 'benefit-payments',
          icon: 'credit-card',
          title: 'Simple, Transparent Tuition Payments',
          body:
            'Check your tuition installments, pay securely via PromptPay QR or bank transfer, upload payment slips, and track verification status step by step.'
        },
        {
          id: 'benefit-calendar',
          icon: 'calendar',
          title: 'Class Calendar and Schedule Support',
          body:
            'Stay up to date with upcoming classes in Bangkok time and easily report unavailability when you need to notify the school in advance.'
        }
      ],
      securityCallout: {
        title: 'Built with Security and Privacy in Mind',
        body:
          'Access to courses, learning documents, recordings, scores, and payment records is strictly reserved for enrolled students. Each student signs in with a personal account issued by the school.'
      }
    },
    howToLogIn: {
      heading: 'How to Log In',
      intro:
        'This platform is for enrolled Pattanabhumi Biology students. Follow the steps below to access your account:',
      steps: [
        {
          stepNumber: 1,
          title: 'Receive Your Account Credentials',
          body:
            'After your enrollment is confirmed, the school administrator will provide your personal Username and Password.'
        },
        {
          stepNumber: 2,
          title: 'Open the Sign-In Section',
          body:
            'Click the Log In button in the top navigation bar (or scroll to the sign-in panel on this page).'
        },
        {
          stepNumber: 3,
          title: 'Enter Your Username and Password',
          body:
            'Type your assigned username and password carefully. Choose "Keep me signed in on this device" only if you are using your own private device. Do not select this option on a shared or public computer.'
        },
        {
          stepNumber: 4,
          title: 'Review the Privacy Notice (First Sign-In)',
          body:
            'On your first sign-in ' +
            emDash +
            ' or whenever our privacy terms are updated ' +
            emDash +
            ' you will be asked to review and accept the Privacy Notice before entering the platform. You can also choose whether to receive optional course news and marketing emails.'
        },
        {
          stepNumber: 5,
          title: 'Access Your Courses and Learning Tools',
          body:
            'Once signed in, you will be taken to My Profile, where you can open your assigned courses, view published scores, check the class calendar, and manage tuition payments.'
        },
        {
          stepNumber: 6,
          title: 'Need Help Signing In?',
          body:
            'If you forget your password, cannot access your account, or notice an issue with your assigned courses, please contact the school directly using the Contact button at the top of the page.'
        }
      ]
    },
    aboutUs: {
      eyebrowBadge: 'Established 2025',
      heading: 'About Us',
      subtitle: 'Education Site for Biology Courses Since 2025',
      paragraphs: [
        'Founded in 2025, Pattanabhumi Biology is a dedicated online education platform created to make high school and pre-university biology clear, structured, and deeply understandable.',
        'We believe strong performance in biology comes from genuine conceptual understanding rather than rote memorization. Our curriculum connects core biological principles, visual explanations, carefully structured reading materials, and targeted assessments so students can build lasting scientific confidence.',
        'Through this learning portal, enrolled students can study course materials, review recorded lessons alongside companion documents, track their assessment scores, follow class schedules, and manage tuition payments in one reliable academic workspace.'
      ]
    },
    instructorProfile: {
      heading: 'Instructor Profile',
      headlineBadge: "100/100 Full Score " + emDash + " A-Level Biology '23",
      education:
        'Medical Student ' +
        emDash +
        ' 4th Year, Faculty of Medicine Siriraj Hospital, Mahidol University',
      awards: [
        '1st Runner-Up ' +
          emDash +
          ' National Round, 21st Thailand Biology Olympiad (21st TBO)',
        'Gold Medal ' +
          emDash +
          ' National Round, 19th Thailand Biology Olympiad (19th TBO)',
        'Highest Score (Theoretical Exam) ' +
          emDash +
          ' 19th Thailand Biology Olympiad (19th TBO)',
        'Highest Aggregate Score (Central Region) ' +
          emDash +
          ' 19th Thailand Biology Olympiad (19th TBO)'
      ],
      teachingExperience:
        'Over 3 years of experience teaching high school biology, combining Olympiad-level depth with clear, exam-ready problem-solving strategies.'
    }
  };
}


/**
 * Phase 6: Merges customizable administrator overrides (from `PUBLIC_CONTENT_PUBLISHED_JSON`
 * or `PUBLIC_CONTENT_DRAFT_JSON`) onto the authoritative owner-supplied default copy,
 * ensuring any blank or omitted field gracefully falls back to the default owner copy.
 *
 * @param {Object} defaultContent Output of `getDefaultPublicWebsiteContentPhase3_`.
 * @param {string|Object} rawOverrideJsonOrObj JSON string or object containing overrides.
 * @param {Object=} opt_dekConfig Calculated DEK cohort descriptor.
 * @return {Object} Merged public website content object.
 */
function mergePublicWebsiteContentWithOverridesPhase6_(
  defaultContent,
  rawOverrideJsonOrObj,
  opt_dekConfig
) {
  var base =
    defaultContent && typeof defaultContent === 'object'
      ? JSON.parse(JSON.stringify(defaultContent))
      : getDefaultPublicWebsiteContentPhase3_(2026);
  if (opt_dekConfig && typeof opt_dekConfig === 'object') {
    base.dek = opt_dekConfig;
  }
  var ov = null;
  if (typeof rawOverrideJsonOrObj === 'string' && rawOverrideJsonOrObj.trim()) {
    try {
      ov = JSON.parse(rawOverrideJsonOrObj);
    } catch (ignoreParseErr) {
      ov = null;
    }
  } else if (rawOverrideJsonOrObj && typeof rawOverrideJsonOrObj === 'object') {
    ov = rawOverrideJsonOrObj;
  }
  if (!ov || typeof ov !== 'object') {
    return base;
  }

  function pickCleanStr(val, fallbackVal, maxLen) {
    if (typeof val !== 'string') {
      return fallbackVal;
    }
    var trimmed = val.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
    if (!trimmed) {
      return fallbackVal;
    }
    return maxLen && trimmed.length > maxLen ? trimmed.substring(0, maxLen) : trimmed;
  }

  if (ov.hero && typeof ov.hero === 'object') {
    base.hero.eyebrow = pickCleanStr(ov.hero.eyebrow, base.hero.eyebrow, 140);
    base.hero.title = pickCleanStr(ov.hero.title, base.hero.title, 120);
    base.hero.lead = pickCleanStr(ov.hero.lead, base.hero.lead, 600);
  } else {
    if (ov.heroEyebrow !== undefined) {
      base.hero.eyebrow = pickCleanStr(ov.heroEyebrow, base.hero.eyebrow, 140);
    }
    if (ov.heroTitle !== undefined) {
      base.hero.title = pickCleanStr(ov.heroTitle, base.hero.title, 120);
    }
    if (ov.heroLead !== undefined) {
      base.hero.lead = pickCleanStr(ov.heroLead, base.hero.lead, 600);
    }
  }

  if (ov.aboutUs && typeof ov.aboutUs === 'object') {
    base.aboutUs.subtitle = pickCleanStr(
      ov.aboutUs.subtitle,
      base.aboutUs.subtitle,
      180
    );
    if (Array.isArray(ov.aboutUs.paragraphs) && ov.aboutUs.paragraphs.length > 0) {
      var nextParas = [];
      for (var p = 0; p < Math.min(ov.aboutUs.paragraphs.length, 6); p++) {
        var pStr = pickCleanStr(ov.aboutUs.paragraphs[p], '', 1000);
        if (pStr) {
          nextParas.push(pStr);
        }
      }
      if (nextParas.length > 0) {
        base.aboutUs.paragraphs = nextParas;
      }
    }
  } else {
    if (ov.aboutSubtitle !== undefined) {
      base.aboutUs.subtitle = pickCleanStr(
        ov.aboutSubtitle,
        base.aboutUs.subtitle,
        180
      );
    }
    if (
      ov.aboutParagraph1 !== undefined ||
      ov.aboutParagraph2 !== undefined ||
      ov.aboutParagraph3 !== undefined
    ) {
      base.aboutUs.paragraphs = [
        pickCleanStr(ov.aboutParagraph1, base.aboutUs.paragraphs[0], 1000),
        pickCleanStr(ov.aboutParagraph2, base.aboutUs.paragraphs[1], 1000),
        pickCleanStr(ov.aboutParagraph3, base.aboutUs.paragraphs[2], 1000)
      ];
    }
  }

  if (ov.instructorProfile && typeof ov.instructorProfile === 'object') {
    base.instructorProfile.headlineBadge = pickCleanStr(
      ov.instructorProfile.headlineBadge,
      base.instructorProfile.headlineBadge,
      160
    );
    base.instructorProfile.education = pickCleanStr(
      ov.instructorProfile.education,
      base.instructorProfile.education,
      240
    );
    base.instructorProfile.teachingExperience = pickCleanStr(
      ov.instructorProfile.teachingExperience,
      base.instructorProfile.teachingExperience,
      600
    );
    if (
      Array.isArray(ov.instructorProfile.awards) &&
      ov.instructorProfile.awards.length > 0
    ) {
      var nextAwards = [];
      for (var a = 0; a < Math.min(ov.instructorProfile.awards.length, 8); a++) {
        var aStr = pickCleanStr(ov.instructorProfile.awards[a], '', 240);
        if (aStr) {
          nextAwards.push(aStr);
        }
      }
      if (nextAwards.length > 0) {
        base.instructorProfile.awards = nextAwards;
      }
    }
  } else {
    if (ov.instructorHeadlineBadge !== undefined) {
      base.instructorProfile.headlineBadge = pickCleanStr(
        ov.instructorHeadlineBadge,
        base.instructorProfile.headlineBadge,
        160
      );
    }
    if (ov.instructorEducation !== undefined) {
      base.instructorProfile.education = pickCleanStr(
        ov.instructorEducation,
        base.instructorProfile.education,
        240
      );
    }
    if (ov.instructorTeachingExperience !== undefined) {
      base.instructorProfile.teachingExperience = pickCleanStr(
        ov.instructorTeachingExperience,
        base.instructorProfile.teachingExperience,
        600
      );
    }
    if (Array.isArray(ov.instructorAwards) && ov.instructorAwards.length > 0) {
      var flatAwards = [];
      for (var fa = 0; fa < Math.min(ov.instructorAwards.length, 8); fa++) {
        var faStr = pickCleanStr(ov.instructorAwards[fa], '', 240);
        if (faStr) {
          flatAwards.push(faStr);
        }
      }
      if (flatAwards.length > 0) {
        base.instructorProfile.awards = flatAwards;
      }
    }
  }

  return base;
}

/**
 * Phase 6: Evaluates whether the instructor's time-sensitive academic year credential
 * ("Medical Student - 4th Year, Faculty of Medicine Siriraj Hospital, Mahidol University")
 * requires periodic administrator verification (> 180 days since last verified, or never verified).
 *
 * @param {string} lastVerifiedIso ISO-8601 UTC timestamp from `Settings.INSTRUCTOR_PROFILE_LAST_VERIFIED_AT`.
 * @param {number=} opt_nowMs Optional epoch milliseconds for deterministic testing.
 * @return {Object} `{ lastVerifiedAtUtc, daysSinceVerified, needsAnnualReview, reminderMessage }`
 */
function evaluateInstructorAcademicYearVerificationPhase6_(lastVerifiedIso, opt_nowMs) {
  var rawIso = typeof lastVerifiedIso === 'string' ? lastVerifiedIso.trim() : '';
  var nowMs =
    opt_nowMs !== undefined && opt_nowMs !== null ? Number(opt_nowMs) : Date.now();
  if (!rawIso) {
    return {
      lastVerifiedAtUtc: '',
      daysSinceVerified: null,
      needsAnnualReview: true,
      reminderMessage:
        'Academic Year Reminder: The credential "4th Year, Faculty of Medicine Siriraj Hospital, Mahidol University" has not been marked verified yet. Please confirm or update it for the current academic year.'
    };
  }
  var parsedMs = Date.parse(rawIso);
  if (isNaN(parsedMs)) {
    return {
      lastVerifiedAtUtc: rawIso,
      daysSinceVerified: null,
      needsAnnualReview: true,
      reminderMessage:
        'Academic Year Reminder: Please verify that the instructor academic year ("4th Year...") is still current.'
    };
  }
  var elapsedDays = Math.max(0, Math.floor((nowMs - parsedMs) / 86400000));
  var needsReview = elapsedDays >= 180;
  return {
    lastVerifiedAtUtc: rawIso,
    daysSinceVerified: elapsedDays,
    needsAnnualReview: needsReview,
    reminderMessage: needsReview
      ? 'Academic Year Reminder: Last verified ' +
        String(elapsedDays) +
        ' days ago (' +
        rawIso.substring(0, 10) +
        '). Please confirm whether "4th Year" should be updated for the new academic year.'
      : 'Verified ' +
        String(elapsedDays) +
        ' day(s) ago (' +
        rawIso.substring(0, 10) +
        '). Next academic year check recommended in ' +
        String(Math.max(1, 180 - elapsedDays)) +
        ' days.'
  };
}

// === END OF Config.gs (Complete) ===
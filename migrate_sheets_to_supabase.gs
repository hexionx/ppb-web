/**
 * migrate_sheets_to_supabase.gs
 *
 * Standalone Google Apps Script to migrate all legacy data from your existing
 * Google Spreadsheet into Supabase PostgreSQL via the Supabase REST API (`PostgREST`).
 *
 * HOW TO USE:
 *   1. Open https://script.google.com and create a standalone Apps Script project
 *      (or add this file temporarily in an admin script).
 *   2. Fill in `MIGRATION_CONFIG` below:
 *      - `SUPABASE_URL`: Your project API URL (accepts `https://<ref>.supabase.co` or `.../rest/v1/`).
 *      - `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase `service_role` / `sb_secret_...` secret key
 *        (from Supabase Dashboard -> Project Settings -> API Keys).
 *        WARNING: NEVER put `sb_publishable_...` here, and NEVER commit your secret key to Git!
 *      - `SPREADSHEET_ID`: Your legacy Google Spreadsheet ID.
 *   3. Optionally run `migrateSheetsDryRun()` first to validate row parsing without writing.
 *   4. Run `migrateSheetsToSupabase()` and open View -> Logs / Executions to inspect progress.
 *   5. It uses `POST /rest/v1/<table>?on_conflict=<pk>` with `"Prefer": "resolution=merge-duplicates"`
 *      so it is idempotent and can be safely re-run at any time.
 */

// ============================================================================
// 1. CONFIGURATION SECTION
// ============================================================================

var MIGRATION_CONFIG = {
  // Supabase Project URL or REST v1 base URL
  SUPABASE_URL: 'https://uqkbbevzwpbronolqizv.supabase.co',

  // REQUIRED FOR MIGRATION: Supabase Secret Key (`service_role` JWT or `sb_secret_...`)
  // Bypasses Row Level Security so restricted tables (`users`, `sessions`, `login_attempts`) succeed.
  SUPABASE_SERVICE_ROLE_KEY: 'PASTE_YOUR_SUPABASE_SERVICE_ROLE_SECRET_KEY_HERE',

  // Legacy Google Spreadsheet ID
  // Example legacy ID from backend/Api.gs: '129VTczSBm91aXfpATwEHBlDmCrbZ8zZ8eYgRa3en2mU'
  SPREADSHEET_ID: 'PASTE_YOUR_GOOGLE_SPREADSHEET_ID_HERE',

  // Number of rows sent per PostgREST upsert request (100-300 recommended)
  BATCH_SIZE: 200,

  // Set true to clean/validate all rows in Logs without sending HTTP writes to Supabase
  DRY_RUN: false
};

// ============================================================================
// 2. COLUMN & FOREIGN-KEY DEPENDENCY SPECIFICATION (Matches schema.sql 1:1)
// ============================================================================
// Types:
//   'text'         -> String (trimmed only where appropriate; '' preserved on NOT NULL defaults)
//   'bool'         -> Boolean (true / false)
//   'int'          -> Integer / BigInt (rounded finite number)
//   'num'          -> Numeric(10, 2) / Decimal
//   'jsonb'        -> Parsed JSON object or array (null if nullable and empty)
//   'ts'           -> ISO-8601 timestamptz string (null if nullable and empty)
//   'date'         -> 'YYYY-MM-DD' date string in Asia/Bangkok timezone
//   'ts_text'      -> String stored as text in PostgreSQL (e.g. cards.recording_uploaded_at_utc)

function cSpec_(type, notNull, defaultVal, extra) {
  var obj = { type: type, notNull: Boolean(notNull), defaultVal: defaultVal };
  if (extra) {
    var keys = Object.keys(extra);
    for (var i = 0; i < keys.length; i++) obj[keys[i]] = extra[keys[i]];
  }
  return obj;
}

/**
 * Exact ordered migration manifest respecting PostgreSQL foreign keys:
 *   Tier 1: Root tables (`users`, `settings`, `login_attempts`, `audit_events`, `files`, `courses`, ...)
 *   Tier 2: Direct children (`sessions`, `privacy_choices`, `sections`, `enrollments`, `assessment_scores`, ...)
 *   Tier 3: Grandchildren (`cards`, `question_options`, `exam_sections`, `exam_attempts`)
 *   Tier 4: Great-grandchildren (`exam_items`, `attempt_items`, `result_revisions`, `exam_integrity_events`)
 *   Tier 5: Leaf dependents (`attempt_responses`)
 */
var MIGRATION_TABLES_ = [
  // ---- TIER 1: ROOT TABLES ----
  {
    sheetName: 'Users',
    tableName: 'users',
    primaryKey: 'user_id',
    columns: {
      user_id: cSpec_('text', true, ''),
      username_lower: cSpec_('text', true, ''),
      username_display: cSpec_('text', true, ''),
      email: cSpec_('text', true, ''),
      full_name: cSpec_('text', true, ''),
      role: cSpec_('text', true, 'STUDENT'),
      status: cSpec_('text', true, 'ACTIVE'),
      password_hash: cSpec_('text', true, ''),
      password_updated_at_utc: cSpec_('ts', false, null),
      last_login_at_utc: cSpec_('ts', false, null),
      privacy_ack_version: cSpec_('text', false, ''),
      marketing_opt_in: cSpec_('bool', true, false),
      is_minor_flag: cSpec_('bool', true, false),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    },
    postTransform: function (row) {
      row.username_lower = String(row.username_lower || '').trim().toLowerCase();
      if (!row.username_display) row.username_display = row.username_lower;
      return row;
    }
  },
  {
    sheetName: 'Settings',
    tableName: 'settings',
    primaryKey: 'setting_key',
    columns: {
      setting_key: cSpec_('text', true, ''),
      setting_value: cSpec_('text', false, ''),
      updated_by_user_id: cSpec_('text', false, ''),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'LoginAttempts',
    tableName: 'login_attempts',
    primaryKey: 'subject_key',
    columns: {
      subject_key: cSpec_('text', true, ''),
      window_start_utc: cSpec_('ts', true, '__NOW__'),
      failure_count: cSpec_('int', true, 0),
      locked_until_utc: cSpec_('ts', false, null),
      last_attempt_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__')
    }
  },
  {
    sheetName: 'AuditEvents',
    tableName: 'audit_events',
    primaryKey: 'audit_id',
    columns: {
      audit_id: cSpec_('text', true, ''),
      actor_user_id: cSpec_('text', true, 'SYSTEM'),
      actor_role: cSpec_('text', true, 'SYSTEM'),
      event_type: cSpec_('text', true, 'LEGACY_EVENT'),
      target_entity_type: cSpec_('text', true, 'SYSTEM'),
      target_entity_id: cSpec_('text', false, ''),
      summary_json: cSpec_('jsonb', true, {}),
      created_at_utc: cSpec_('ts', true, '__NOW__')
    }
  },
  {
    sheetName: 'Files',
    tableName: 'files',
    primaryKey: 'file_id',
    columns: {
      file_id: cSpec_('text', true, ''),
      drive_file_id: cSpec_('text', true, ''),
      purpose: cSpec_('text', true, 'PDF_ATTACHMENT'),
      course_id: cSpec_('text', false, ''),
      owner_user_id: cSpec_('text', false, ''),
      original_filename: cSpec_('text', true, 'file'),
      mime_type: cSpec_('text', true, 'application/pdf'),
      size_bytes: cSpec_('int', true, 0),
      sha256_hex: cSpec_('text', true, ''),
      status: cSpec_('text', true, 'ACTIVE'),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      web_view_link: cSpec_('text', false, ''),
      web_content_link: cSpec_('text', false, ''),
      storage_provider: cSpec_('text', true, 'GOOGLE_DRIVE')
    },
    postTransform: function (row) {
      if (!row.web_view_link && row.drive_file_id) {
        row.web_view_link = 'https://drive.google.com/file/d/' + encodeURIComponent(row.drive_file_id) + '/view';
      }
      if (!row.storage_provider) {
        row.storage_provider = 'GOOGLE_DRIVE';
      }
      return row;
    }
  },
  {
    sheetName: 'Courses',
    tableName: 'courses',
    primaryKey: 'course_id',
    columns: {
      course_id: cSpec_('text', true, ''),
      course_code: cSpec_('text', true, ''),
      title: cSpec_('text', true, ''),
      subtitle: cSpec_('text', false, ''),
      cover_file_id: cSpec_('text', false, ''),
      status: cSpec_('text', true, 'DRAFT'),
      sort_order: cSpec_('int', true, 0),
      objectives_richtext_json: cSpec_('jsonb', false, null, { richText: true }),
      outcomes_richtext_json: cSpec_('jsonb', false, null, { richText: true }),
      assessment_updated_at_utc: cSpec_('ts', false, null),
      reading_updated_at_utc: cSpec_('ts', false, null),
      calendar_tag: cSpec_('text', false, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'Assessments',
    tableName: 'assessments',
    primaryKey: 'assessment_id',
    columns: {
      assessment_id: cSpec_('text', true, ''),
      title: cSpec_('text', true, ''),
      description_richtext_json: cSpec_('jsonb', false, null, { richText: true }),
      external_url: cSpec_('text', false, ''),
      pdf_file_id: cSpec_('text', false, ''),
      status: cSpec_('text', true, 'ACTIVE'),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'SharedStimuli',
    tableName: 'shared_stimuli',
    primaryKey: 'stimulus_id',
    columns: {
      stimulus_id: cSpec_('text', true, ''),
      stimulus_code: cSpec_('text', true, ''),
      title: cSpec_('text', true, ''),
      content_richtext_json: cSpec_('jsonb', false, null, { richText: true }),
      image_file_id: cSpec_('text', false, ''),
      image_alt_text: cSpec_('text', false, ''),
      image_caption: cSpec_('text', false, ''),
      accessible_design_flag: cSpec_('text', true, 'STANDARD_ALT'),
      topic_tags_json: cSpec_('jsonb', false, [], { expectArray: true }),
      status: cSpec_('text', true, 'PUBLISHED'),
      created_by_user_id: cSpec_('text', false, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'QuestionBank',
    tableName: 'question_bank',
    primaryKey: 'question_id',
    columns: {
      question_id: cSpec_('text', true, ''),
      question_code: cSpec_('text', true, ''),
      title: cSpec_('text', true, ''),
      question_type: cSpec_('text', true, 'SINGLE_CHOICE'),
      topic_tags_json: cSpec_('jsonb', false, [], { expectArray: true }),
      difficulty: cSpec_('text', true, 'MEDIUM'),
      active_version_id: cSpec_('text', true, ''),
      latest_version_no: cSpec_('int', true, 1),
      status: cSpec_('text', true, 'PUBLISHED'),
      used_in_attempts_count: cSpec_('int', true, 0),
      created_by_user_id: cSpec_('text', false, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'ExamSets',
    tableName: 'exam_sets',
    primaryKey: 'exam_set_id',
    columns: {
      exam_set_id: cSpec_('text', true, ''),
      assessment_id: cSpec_('text', false, ''),
      course_id: cSpec_('text', false, ''),
      exam_code: cSpec_('text', true, ''),
      title: cSpec_('text', true, ''),
      description_richtext_json: cSpec_('jsonb', false, null, { richText: true }),
      instructions_richtext_json: cSpec_('jsonb', false, null, { richText: true }),
      cover_image_file_id: cSpec_('text', false, ''),
      exam_mode: cSpec_('text', true, 'PRACTICE'),
      active_exam_version_id: cSpec_('text', false, ''),
      draft_exam_version_id: cSpec_('text', false, ''),
      latest_version_no: cSpec_('int', true, 1),
      assignment_scope: cSpec_('text', true, 'COURSE_ENROLLED'),
      open_at_utc: cSpec_('ts', false, null),
      close_at_utc: cSpec_('ts', false, null),
      duration_minutes: cSpec_('int', true, 90),
      grace_seconds: cSpec_('int', true, 30),
      max_attempts: cSpec_('int', true, 1),
      retake_cooldown_minutes: cSpec_('int', true, 0),
      navigation_mode: cSpec_('text', true, 'FREE'),
      aggregation_rule: cSpec_('text', true, 'BEST_PUBLISHED'),
      score_release_policy: cSpec_('text', true, 'MANUAL_ADMIN'),
      score_release_at_utc: cSpec_('ts', false, null),
      explanation_release_policy: cSpec_('text', true, 'WITH_SCORE'),
      explanation_release_at_utc: cSpec_('ts', false, null),
      pass_threshold_pct: cSpec_('int', true, 60),
      randomize_questions: cSpec_('bool', true, false),
      randomize_options: cSpec_('bool', true, false),
      allow_per_question_practice_feedback: cSpec_('bool', true, false),
      status: cSpec_('text', true, 'DRAFT'),
      created_by_user_id: cSpec_('text', false, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1),
      copy_policy_enabled: cSpec_('bool', true, false),
      copy_policy_version: cSpec_('text', false, ''),
      max_copy_warnings: cSpec_('int', true, 3),
      copy_suspension_seconds: cSpec_('int', true, 5),
      max_integrity_invalidations_before_lock: cSpec_('int', true, 2)
    }
  },
  {
    sheetName: 'ExamOperationJournal',
    tableName: 'exam_operation_journal',
    primaryKey: 'journal_id',
    columns: {
      journal_id: cSpec_('text', true, ''),
      operation_type: cSpec_('text', true, 'START_ATTEMPT'),
      idempotency_key: cSpec_('text', true, ''),
      attempt_id: cSpec_('text', true, ''),
      exam_set_id: cSpec_('text', true, ''),
      student_user_id: cSpec_('text', true, ''),
      target_status: cSpec_('text', true, ''),
      payload_json: cSpec_('jsonb', false, {}, {}),
      journal_status: cSpec_('text', true, 'COMMITTED'),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      committed_at_utc: cSpec_('ts', false, null)
    }
  },
  {
    sheetName: 'PaymentJournal',
    tableName: 'payment_journal',
    primaryKey: 'journal_id',
    columns: {
      journal_id: cSpec_('text', true, ''),
      operation_type: cSpec_('text', true, 'RESERVE'),
      idempotency_key: cSpec_('text', true, ''),
      payment_id: cSpec_('text', true, ''),
      invoice_ids_json: cSpec_('jsonb', true, [], { expectArray: true }),
      target_payment_status: cSpec_('text', true, ''),
      target_invoice_status: cSpec_('text', true, ''),
      payload_json: cSpec_('jsonb', false, {}, {}),
      journal_status: cSpec_('text', true, 'COMMITTED'),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      committed_at_utc: cSpec_('ts', false, null)
    }
  },
  {
    sheetName: 'CalendarEvents',
    tableName: 'calendar_events',
    primaryKey: 'event_id',
    optionalSheet: true,
    columns: {
      event_id: cSpec_('text', true, ''),
      title: cSpec_('text', true, ''),
      course_id: cSpec_('text', false, ''),
      course_code: cSpec_('text', false, ''),
      calendar_tag: cSpec_('text', false, ''),
      scope: cSpec_('text', true, 'COURSE'),
      start_date_bkk: cSpec_('date', true, '2026-01-01'),
      end_date_bkk: cSpec_('date', true, '2026-01-01'),
      all_day: cSpec_('bool', true, false),
      start_time_bkk: cSpec_('text', false, ''),
      end_time_bkk: cSpec_('text', false, ''),
      location: cSpec_('text', false, ''),
      status: cSpec_('text', true, 'ACTIVE'),
      created_by_user_id: cSpec_('text', false, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__')
    }
  },

  // ---- TIER 2: DIRECT CHILDREN (Reference users / courses / question_bank / exam_sets) ----
  {
    sheetName: 'Sessions',
    tableName: 'sessions',
    primaryKey: 'session_id',
    columns: {
      session_id: cSpec_('text', true, ''),
      token_sha256_hex: cSpec_('text', true, ''),
      user_id: cSpec_('text', true, ''),
      remember_me: cSpec_('bool', true, false),
      status: cSpec_('text', true, 'REVOKED'),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      expires_at_utc: cSpec_('ts', true, '__NOW__'),
      last_seen_at_utc: cSpec_('ts', false, null),
      revoked_at_utc: cSpec_('ts', false, null),
      revoke_reason: cSpec_('text', false, '')
    }
  },
  {
    sheetName: 'PrivacyChoices',
    tableName: 'privacy_choices',
    primaryKey: 'choice_id',
    columns: {
      choice_id: cSpec_('text', true, ''),
      user_id: cSpec_('text', true, ''),
      notice_version: cSpec_('text', true, '2026-10-v1'),
      acknowledged_notice: cSpec_('bool', true, false),
      marketing_opt_in: cSpec_('bool', true, false),
      action_source: cSpec_('text', true, 'FIRST_LOGIN_GATE'),
      recorded_at_utc: cSpec_('ts', true, '__NOW__')
    }
  },
  {
    sheetName: 'Sections',
    tableName: 'sections',
    primaryKey: 'section_id',
    columns: {
      section_id: cSpec_('text', true, ''),
      course_id: cSpec_('text', true, ''),
      section_type: cSpec_('text', true, 'READING'),
      title: cSpec_('text', true, ''),
      status: cSpec_('text', true, 'PUBLISHED'),
      sort_order: cSpec_('int', true, 0),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'Enrollments',
    tableName: 'enrollments',
    primaryKey: 'enrollment_id',
    columns: {
      enrollment_id: cSpec_('text', true, ''),
      user_id: cSpec_('text', true, ''),
      course_id: cSpec_('text', true, ''),
      status: cSpec_('text', true, 'ACTIVE'),
      assigned_by_user_id: cSpec_('text', false, ''),
      assigned_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'AssessmentScores',
    tableName: 'assessment_scores',
    primaryKey: 'score_id',
    columns: {
      score_id: cSpec_('text', true, ''),
      course_id: cSpec_('text', true, ''),
      assessment_id: cSpec_('text', true, ''),
      student_user_id: cSpec_('text', true, ''),
      score_points: cSpec_('num', true, 0),
      max_points: cSpec_('num', true, 0),
      feedback_text: cSpec_('text', false, ''),
      status: cSpec_('text', true, 'PUBLISHED'),
      published_at_utc: cSpec_('ts', false, null),
      updated_by_user_id: cSpec_('text', false, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'QuestionVersions',
    tableName: 'question_versions',
    primaryKey: 'question_version_id',
    columns: {
      question_version_id: cSpec_('text', true, ''),
      question_id: cSpec_('text', true, ''),
      version_no: cSpec_('int', true, 1),
      question_type: cSpec_('text', true, 'SINGLE_CHOICE'),
      title: cSpec_('text', true, ''),
      stem_richtext_json: cSpec_('jsonb', true, { schemaVersion: 'pb-richtext-v1', blocks: [] }, { richText: true }),
      stimulus_id: cSpec_('text', false, ''),
      image_file_id: cSpec_('text', false, ''),
      image_alt_text: cSpec_('text', false, ''),
      image_caption: cSpec_('text', false, ''),
      accessible_design_flag: cSpec_('text', true, 'STANDARD_ALT'),
      default_points_bp: cSpec_('int', true, 100),
      negative_points_bp: cSpec_('int', true, 0),
      lock_option_order: cSpec_('bool', true, false),
      selection_instruction: cSpec_('text', false, ''),
      unit_label: cSpec_('text', false, ''),
      max_length_chars: cSpec_('int', true, 0),
      grading_mode: cSpec_('text', true, 'AUTO'),
      grading_spec_private_json: cSpec_('jsonb', true, {}),
      explanation_richtext_json: cSpec_('jsonb', false, null, { richText: true }),
      reference_text: cSpec_('text', false, ''),
      admin_notes_private: cSpec_('text', false, ''),
      is_immutable: cSpec_('bool', true, false),
      created_by_user_id: cSpec_('text', false, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__')
    }
  },
  {
    sheetName: 'ExamVersions',
    tableName: 'exam_versions',
    primaryKey: 'exam_version_id',
    columns: {
      exam_version_id: cSpec_('text', true, ''),
      exam_set_id: cSpec_('text', true, ''),
      version_no: cSpec_('int', true, 1),
      version_state: cSpec_('text', true, 'DRAFT'),
      exam_mode: cSpec_('text', true, 'PRACTICE'),
      title: cSpec_('text', true, ''),
      instructions_richtext_json: cSpec_('jsonb', false, null, { richText: true }),
      duration_minutes: cSpec_('int', true, 0),
      grace_seconds: cSpec_('int', true, 0),
      total_questions_count: cSpec_('int', true, 0),
      max_points_bp: cSpec_('int', true, 0),
      negative_marking_enabled: cSpec_('bool', true, false),
      unanswered_points_bp: cSpec_('int', true, 0),
      navigation_mode: cSpec_('text', true, 'FREE'),
      randomize_questions: cSpec_('bool', true, false),
      randomize_options: cSpec_('bool', true, false),
      allow_per_question_practice_feedback: cSpec_('bool', true, false),
      policy_snapshot_json: cSpec_('jsonb', false, {}, {}),
      published_by_user_id: cSpec_('text', false, ''),
      published_at_utc: cSpec_('ts', false, null),
      created_at_utc: cSpec_('ts', true, '__NOW__')
    }
  },
  {
    sheetName: 'ExamAssignments',
    tableName: 'exam_assignments',
    primaryKey: 'assignment_id',
    columns: {
      assignment_id: cSpec_('text', true, ''),
      exam_set_id: cSpec_('text', true, ''),
      course_id: cSpec_('text', false, ''),
      target_type: cSpec_('text', true, 'COURSE'),
      student_user_id: cSpec_('text', false, ''),
      assignment_status: cSpec_('text', true, 'ASSIGNED'),
      open_at_override_utc: cSpec_('ts', false, null),
      override_deadline_utc: cSpec_('ts', false, null),
      extra_time_minutes: cSpec_('int', true, 0),
      extra_attempts_granted: cSpec_('int', true, 0),
      accommodation_reason: cSpec_('text', false, ''),
      assigned_by_user_id: cSpec_('text', false, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1),
      copy_policy_accommodation_mode: cSpec_('text', false, ''),
      custom_max_copy_warnings: cSpec_('int', true, 0)
    }
  },
  {
    sheetName: 'ExamPolicyAcknowledgments',
    tableName: 'exam_policy_acknowledgments',
    primaryKey: 'ack_id',
    columns: {
      ack_id: cSpec_('text', true, ''),
      exam_set_id: cSpec_('text', true, ''),
      exam_version_id: cSpec_('text', false, ''),
      attempt_id: cSpec_('text', false, ''),
      student_user_id: cSpec_('text', true, ''),
      policy_version: cSpec_('text', true, 'pb-copy-policy-v1'),
      max_copy_warnings_snapshot: cSpec_('int', true, 0),
      suspension_seconds_snapshot: cSpec_('int', true, 0),
      max_invalidations_before_lock_snapshot: cSpec_('int', true, 0),
      acknowledged_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'StudentIntegrityProfiles',
    tableName: 'student_integrity_profiles',
    primaryKey: 'profile_id',
    columns: {
      profile_id: cSpec_('text', true, ''),
      student_user_id: cSpec_('text', true, ''),
      integrity_status: cSpec_('text', true, 'CLEAR'),
      distinct_copy_invalidations_total: cSpec_('int', true, 0),
      overturned_invalidations_total: cSpec_('int', true, 0),
      effective_strike_baseline: cSpec_('int', true, 0),
      effective_active_strikes: cSpec_('int', true, 0),
      locked_at_utc: cSpec_('ts', false, null),
      lock_trigger_attempt_id: cSpec_('text', false, ''),
      lock_reason_code: cSpec_('text', false, ''),
      unlocked_at_utc: cSpec_('ts', false, null),
      unlocked_by_user_id: cSpec_('text', false, ''),
      unlock_reason: cSpec_('text', false, ''),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'ExamIntegrityReviews',
    tableName: 'exam_integrity_reviews',
    primaryKey: 'review_id',
    columns: {
      review_id: cSpec_('text', true, ''),
      target_type: cSpec_('text', true, 'INTEGRITY_EVENT'),
      target_id: cSpec_('text', true, ''),
      student_user_id: cSpec_('text', true, ''),
      attempt_id: cSpec_('text', false, ''),
      exam_set_id: cSpec_('text', false, ''),
      action_taken: cSpec_('text', true, 'CONFIRM_INCIDENT'),
      previous_state_json: cSpec_('jsonb', false, {}, {}),
      new_state_json: cSpec_('jsonb', false, {}, {}),
      new_strike_baseline_count: cSpec_('int', true, 0),
      reason: cSpec_('text', true, ''),
      admin_user_id: cSpec_('text', true, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'Invoices',
    tableName: 'invoices',
    primaryKey: 'invoice_id',
    columns: {
      invoice_id: cSpec_('text', true, ''),
      user_id: cSpec_('text', true, ''),
      course_id: cSpec_('text', false, ''),
      installment_label: cSpec_('text', true, ''),
      amount_satang: cSpec_('int', true, 100),
      due_date_bkk: cSpec_('date', true, '2026-01-01'),
      status: cSpec_('text', true, 'UNPAID'),
      active_payment_id: cSpec_('text', false, ''),
      reservation_expires_at_utc: cSpec_('ts', false, null),
      last_rejection_reason: cSpec_('text', false, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'Payments',
    tableName: 'payments',
    primaryKey: 'payment_id',
    columns: {
      payment_id: cSpec_('text', true, ''),
      user_id: cSpec_('text', true, ''),
      invoice_ids_json: cSpec_('jsonb', true, [], { expectArray: true }),
      total_amount_satang: cSpec_('int', true, 100),
      method: cSpec_('text', true, 'PROMPTPAY_QR'),
      status: cSpec_('text', true, 'PENDING_TRANSFER'),
      idempotency_key: cSpec_('text', true, ''),
      expires_at_utc: cSpec_('ts', false, null),
      receipt_file_id: cSpec_('text', false, ''),
      submitted_at_utc: cSpec_('ts', false, null),
      reviewed_by_user_id: cSpec_('text', false, ''),
      reviewed_at_utc: cSpec_('ts', false, null),
      rejection_reason: cSpec_('text', false, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'UnavailabilityRequests',
    tableName: 'unavailability_requests',
    primaryKey: 'request_id',
    columns: {
      request_id: cSpec_('text', true, ''),
      user_id: cSpec_('text', true, ''),
      course_id: cSpec_('text', false, ''),
      unavailable_start_date_bkk: cSpec_('date', true, '2026-01-01'),
      unavailable_end_date_bkk: cSpec_('date', true, '2026-01-01'),
      reason: cSpec_('text', true, ''),
      email_recipient: cSpec_('text', false, ''),
      email_delivery_status: cSpec_('text', true, 'PENDING_ATTEMPT'),
      email_error_detail: cSpec_('text', false, ''),
      email_attempted_at_utc: cSpec_('ts', false, null),
      admin_note: cSpec_('text', false, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },

  // ---- TIER 3: GRANDCHILDREN ----
  {
    sheetName: 'Cards',
    tableName: 'cards',
    primaryKey: 'card_id',
    columns: {
      card_id: cSpec_('text', true, ''),
      course_id: cSpec_('text', true, ''),
      section_id: cSpec_('text', true, ''),
      card_type: cSpec_('text', true, 'READING_CARD'),
      title: cSpec_('text', true, ''),
      subtitle: cSpec_('text', false, ''),
      image_file_id: cSpec_('text', false, ''),
      image_caption: cSpec_('text', false, ''),
      content_richtext_json: cSpec_('jsonb', false, null, { richText: true }),
      recording_url: cSpec_('text', false, ''),
      recording_uploaded_at_utc: cSpec_('ts_text', false, ''),
      assessment_id: cSpec_('text', false, ''),
      status: cSpec_('text', true, 'PUBLISHED'),
      sort_order: cSpec_('int', true, 0),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },
  {
    sheetName: 'QuestionOptions',
    tableName: 'question_options',
    primaryKey: 'option_id',
    columns: {
      option_id: cSpec_('text', true, ''),
      question_version_id: cSpec_('text', true, ''),
      question_id: cSpec_('text', true, ''),
      option_key: cSpec_('text', true, 'A'),
      content_richtext_json: cSpec_('jsonb', true, { schemaVersion: 'pb-richtext-v1', blocks: [] }, { richText: true }),
      image_file_id: cSpec_('text', false, ''),
      image_alt_text: cSpec_('text', false, ''),
      sort_order: cSpec_('int', true, 0),
      pin_position: cSpec_('text', true, 'NONE'),
      is_correct_private: cSpec_('bool', true, false),
      created_at_utc: cSpec_('ts', true, '__NOW__')
    }
  },
  {
    sheetName: 'ExamSections',
    tableName: 'exam_sections',
    primaryKey: 'exam_section_id',
    columns: {
      exam_section_id: cSpec_('text', true, ''),
      exam_version_id: cSpec_('text', true, ''),
      exam_set_id: cSpec_('text', true, ''),
      title: cSpec_('text', true, 'Section 1'),
      instructions_richtext_json: cSpec_('jsonb', false, null, { richText: true }),
      sort_order: cSpec_('int', true, 0),
      selection_mode: cSpec_('text', true, 'FIXED_ITEMS'),
      pool_draw_count: cSpec_('int', true, 0),
      pool_filter_json: cSpec_('jsonb', false, {}, {}),
      lock_section_order: cSpec_('bool', true, false),
      randomize_items_within_section: cSpec_('bool', true, false),
      section_questions_count: cSpec_('int', true, 0),
      section_max_points_bp: cSpec_('int', true, 0),
      created_at_utc: cSpec_('ts', true, '__NOW__')
    }
  },
  {
    sheetName: 'ExamAttempts',
    tableName: 'exam_attempts',
    primaryKey: 'attempt_id',
    columns: {
      attempt_id: cSpec_('text', true, ''),
      exam_set_id: cSpec_('text', true, ''),
      exam_version_id: cSpec_('text', true, ''),
      course_id: cSpec_('text', false, ''),
      student_user_id: cSpec_('text', true, ''),
      attempt_number: cSpec_('int', true, 1),
      idempotency_key: cSpec_('text', false, ''),
      attempt_status: cSpec_('text', true, 'IN_PROGRESS'),
      grading_status: cSpec_('text', true, 'NOT_GRADED'),
      publication_status: cSpec_('text', true, 'UNPUBLISHED'),
      explanation_status: cSpec_('text', true, 'WITHHELD'),
      started_at_utc: cSpec_('ts', true, '__NOW__'),
      effective_deadline_utc: cSpec_('ts', false, null),
      grace_deadline_utc: cSpec_('ts', false, null),
      submitted_at_utc: cSpec_('ts', false, null),
      last_saved_at_utc: cSpec_('ts', false, null),
      time_used_seconds: cSpec_('int', true, 0),
      active_lease_token: cSpec_('text', false, ''),
      latest_revision_no: cSpec_('int', true, 0),
      answered_count: cSpec_('int', true, 0),
      flagged_count: cSpec_('int', true, 0),
      auto_score_bp: cSpec_('int', true, 0),
      manual_score_bp: cSpec_('int', true, 0),
      total_score_bp: cSpec_('int', true, 0),
      max_score_bp: cSpec_('int', true, 0),
      percentage_bp: cSpec_('int', true, 0),
      passed_flag: cSpec_('bool', true, false),
      current_result_revision_id: cSpec_('text', false, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1),
      copy_policy_enabled_snapshot: cSpec_('bool', true, false),
      copy_policy_version_snapshot: cSpec_('text', false, ''),
      max_copy_warnings_snapshot: cSpec_('int', true, 0),
      copy_suspension_seconds_snapshot: cSpec_('int', true, 0),
      max_invalidations_lock_snapshot: cSpec_('int', true, 0),
      policy_acknowledged_at_utc: cSpec_('ts', false, null),
      copy_warning_count: cSpec_('int', true, 0),
      suspension_until_utc: cSpec_('ts', false, null),
      invalidation_reason_code: cSpec_('text', false, ''),
      invalidated_at_utc: cSpec_('ts', false, null),
      invalidation_overturned: cSpec_('bool', true, false),
      invalidation_overturned_at_utc: cSpec_('ts', false, null),
      invalidation_overturned_by_user_id: cSpec_('text', false, ''),
      invalidation_review_reason: cSpec_('text', false, '')
    }
  },

  // ---- TIER 4: GREAT-GRANDCHILDREN ----
  {
    sheetName: 'ExamItems',
    tableName: 'exam_items',
    primaryKey: 'exam_item_id',
    columns: {
      exam_item_id: cSpec_('text', true, ''),
      exam_version_id: cSpec_('text', true, ''),
      exam_section_id: cSpec_('text', true, ''),
      exam_set_id: cSpec_('text', true, ''),
      question_id: cSpec_('text', true, ''),
      question_version_id: cSpec_('text', true, ''),
      sort_order: cSpec_('int', true, 0),
      lock_item_position: cSpec_('bool', true, false),
      lock_option_order: cSpec_('bool', true, false),
      points_bp: cSpec_('int', true, 100),
      negative_points_bp: cSpec_('int', true, 0),
      is_pool_candidate: cSpec_('bool', true, false),
      pool_group_tag: cSpec_('text', false, ''),
      created_at_utc: cSpec_('ts', true, '__NOW__')
    }
  },
  {
    sheetName: 'AttemptItems',
    tableName: 'attempt_items',
    primaryKey: 'attempt_item_id',
    columns: {
      attempt_item_id: cSpec_('text', true, ''),
      attempt_id: cSpec_('text', true, ''),
      exam_set_id: cSpec_('text', true, ''),
      exam_version_id: cSpec_('text', true, ''),
      exam_section_id: cSpec_('text', true, ''),
      display_number: cSpec_('int', true, 1),
      question_id: cSpec_('text', true, ''),
      question_version_id: cSpec_('text', true, ''),
      stimulus_id: cSpec_('text', false, ''),
      option_order_json: cSpec_('jsonb', false, [], { expectArray: true }),
      points_bp: cSpec_('int', true, 100),
      negative_points_bp: cSpec_('int', true, 0),
      is_flagged: cSpec_('bool', true, false),
      flag_updated_at_utc: cSpec_('ts', false, null),
      created_at_utc: cSpec_('ts', true, '__NOW__')
    }
  },
  {
    sheetName: 'ResultRevisions',
    tableName: 'result_revisions',
    primaryKey: 'result_revision_id',
    columns: {
      result_revision_id: cSpec_('text', true, ''),
      attempt_id: cSpec_('text', true, ''),
      exam_set_id: cSpec_('text', true, ''),
      exam_version_id: cSpec_('text', true, ''),
      student_user_id: cSpec_('text', true, ''),
      revision_no: cSpec_('int', true, 1),
      revision_type: cSpec_('text', true, 'INITIAL_AUTO_GRADE'),
      auto_score_bp: cSpec_('int', true, 0),
      manual_score_bp: cSpec_('int', true, 0),
      total_score_bp: cSpec_('int', true, 0),
      max_score_bp: cSpec_('int', true, 0),
      percentage_bp: cSpec_('int', true, 0),
      passed_flag: cSpec_('bool', true, false),
      grading_status: cSpec_('text', true, 'GRADED'),
      publication_status: cSpec_('text', true, 'UNPUBLISHED'),
      explanation_status: cSpec_('text', true, 'WITHHELD'),
      reason: cSpec_('text', false, ''),
      actor_user_id: cSpec_('text', true, 'SYSTEM'),
      created_at_utc: cSpec_('ts', true, '__NOW__')
    }
  },
  {
    sheetName: 'ExamIntegrityEvents',
    tableName: 'exam_integrity_events',
    primaryKey: 'integrity_event_id',
    columns: {
      integrity_event_id: cSpec_('text', true, ''),
      event_client_id: cSpec_('text', true, ''),
      attempt_id: cSpec_('text', true, ''),
      exam_set_id: cSpec_('text', true, ''),
      exam_version_id: cSpec_('text', false, ''),
      course_id: cSpec_('text', false, ''),
      student_user_id: cSpec_('text', true, ''),
      policy_version: cSpec_('text', true, 'pb-copy-policy-v1'),
      event_type: cSpec_('text', true, 'QUALIFYING_COPY_ATTEMPT'),
      target_region: cSpec_('text', true, 'QUESTION_STEM'),
      attempt_item_id: cSpec_('text', false, ''),
      question_id: cSpec_('text', false, ''),
      warning_count_after: cSpec_('int', true, 0),
      outcome_action: cSpec_('text', true, 'SUSPENDED_5S'),
      suspension_until_utc: cSpec_('ts', false, null),
      triggered_invalidation: cSpec_('bool', true, false),
      triggered_account_lock: cSpec_('bool', true, false),
      review_status: cSpec_('text', true, 'UNREVIEWED'),
      reviewed_by_user_id: cSpec_('text', false, ''),
      reviewed_at_utc: cSpec_('ts', false, null),
      review_reason: cSpec_('text', false, ''),
      detected_at_client_utc: cSpec_('ts', false, null),
      recorded_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  },

  // ---- TIER 5: LEAF DEPENDENTS ----
  {
    sheetName: 'AttemptResponses',
    tableName: 'attempt_responses',
    primaryKey: 'response_id',
    columns: {
      response_id: cSpec_('text', true, ''),
      attempt_id: cSpec_('text', true, ''),
      attempt_item_id: cSpec_('text', true, ''),
      question_version_id: cSpec_('text', true, ''),
      student_user_id: cSpec_('text', true, ''),
      response_payload_json: cSpec_('jsonb', false, {}, {}),
      is_answered: cSpec_('bool', true, false),
      client_revision_no: cSpec_('int', true, 0),
      server_revision_no: cSpec_('int', true, 0),
      saved_at_utc: cSpec_('ts', true, '__NOW__'),
      grading_source: cSpec_('text', true, 'UNGRADED'),
      awarded_points_bp: cSpec_('int', true, 0),
      max_points_bp: cSpec_('int', true, 0),
      correctness_state: cSpec_('text', true, 'UNGRADED'),
      instructor_feedback: cSpec_('text', false, ''),
      graded_by_user_id: cSpec_('text', false, ''),
      graded_at_utc: cSpec_('ts', false, null),
      created_at_utc: cSpec_('ts', true, '__NOW__'),
      updated_at_utc: cSpec_('ts', true, '__NOW__'),
      version: cSpec_('int', true, 1)
    }
  }
];

// ============================================================================
// 3. PUBLIC ENTRYPOINTS
// ============================================================================

/**
 * Main entrypoint: Migrates all Google Sheets tabs to Supabase PostgreSQL in strict
 * foreign-key dependency order with PostgREST merge-duplicates upsert.
 */
function migrateSheetsToSupabase() {
  return runMigrationInternal_(null, Boolean(MIGRATION_CONFIG.DRY_RUN));
}

/**
 * Dry-run validation: Parses and cleans all rows from all tabs without calling Supabase.
 */
function migrateSheetsDryRun() {
  return runMigrationInternal_(null, true);
}

/**
 * Optional single-table re-run helper (e.g., migrateSingleSheetToSupabase('Users')).
 */
function migrateSingleSheetToSupabase(sheetOrTableName) {
  return runMigrationInternal_(sheetOrTableName, Boolean(MIGRATION_CONFIG.DRY_RUN));
}

// ============================================================================
// 4. MIGRATION ENGINE & TYPE NORMALIZATION HELPERS
// ============================================================================

function validateMigrationConfig_(dryRun) {
  var baseUrl = normalizeSupabaseBaseUrl_(MIGRATION_CONFIG.SUPABASE_URL);
  if (!dryRun && (!baseUrl || baseUrl.indexOf('PASTE_') === 0 || baseUrl.indexOf('https://') !== 0)) {
    throw new Error('MIGRATION_CONFIG.SUPABASE_URL must be a valid https://<project>.supabase.co URL.');
  }

  var serviceKey = String(MIGRATION_CONFIG.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!dryRun) {
    if (!serviceKey || serviceKey.indexOf('PASTE_') === 0) {
      throw new Error(
        'MIGRATION_CONFIG.SUPABASE_SERVICE_ROLE_KEY is missing. Set your Supabase service_role / sb_secret_... key to bypass RLS.'
      );
    }
    if (serviceKey.indexOf('sb_publishable_') === 0) {
      throw new Error(
        'Do NOT use a publishable (`sb_publishable_...`) key for migration! Copy your Secret / service_role key from Supabase Project Settings -> API Keys so RLS is bypassed on `users`, `sessions`, and `login_attempts`.'
      );
    }
  }

  var ssId = String(MIGRATION_CONFIG.SPREADSHEET_ID || '').trim();
  if (!ssId || ssId.indexOf('PASTE_') === 0) {
    throw new Error(
      'MIGRATION_CONFIG.SPREADSHEET_ID is not configured. Set it to your Google Spreadsheet ID (e.g. from the Sheet URL).'
    );
  }

  var batchSize = Math.max(1, Math.min(1000, Number(MIGRATION_CONFIG.BATCH_SIZE) || 200));
  return { baseUrl: baseUrl, serviceKey: serviceKey, spreadsheetId: ssId, batchSize: batchSize };
}

function normalizeSupabaseBaseUrl_(rawUrl) {
  return String(rawUrl || '')
    .trim()
    .replace(/\/rest\/v1\/?$/i, '')
    .replace(/\/+$/, '');
}

function runMigrationInternal_(onlyTargetName, dryRun) {
  var cfg = validateMigrationConfig_(dryRun);
  var ss = SpreadsheetApp.openById(cfg.spreadsheetId);
  var startedMs = new Date().getTime();
  var nowIso = new Date().toISOString();

  Logger.log('====================================================================');
  Logger.log('[START] Pattanabhumi Biology Sheets -> Supabase Migration');
  Logger.log('Spreadsheet : ' + ss.getName() + ' (' + cfg.spreadsheetId + ')');
  Logger.log('Target URL  : ' + cfg.baseUrl + '/rest/v1/');
  Logger.log('Mode        : ' + (dryRun ? 'DRY RUN (No HTTP writes)' : 'LIVE UPSERT (Batch ' + cfg.batchSize + ')'));
  Logger.log('====================================================================');

  var filterLower = onlyTargetName ? String(onlyTargetName).trim().toLowerCase() : '';
  var totals = { sheetsProcessed: 0, sheetsSkipped: 0, rowsUpserted: 0, rowsFailed: 0 };

  for (var i = 0; i < MIGRATION_TABLES_.length; i++) {
    var spec = MIGRATION_TABLES_[i];
    if (
      filterLower &&
      spec.sheetName.toLowerCase() !== filterLower &&
      spec.tableName.toLowerCase() !== filterLower
    ) {
      continue;
    }

    var sheet = ss.getSheetByName(spec.sheetName);
    if (!sheet) {
      Logger.log('[SKIP] Sheet "' + spec.sheetName + '" -> table `' + spec.tableName + '`: Tab not found in spreadsheet.');
      totals.sheetsSkipped++;
      continue;
    }

    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (lastRow <= 1 || lastCol < 1) {
      Logger.log('[EMPTY] Sheet "' + spec.sheetName + '" -> table `' + spec.tableName + '`: 0 data rows.');
      totals.sheetsProcessed++;
      continue;
    }

    var values = sheet.getRange(1, 1, lastRow, lastCol).getValues();
    var headerMap = buildHeaderIndexMap_(values[0]);
    var cleanedRows = [];

    for (var r = 1; r < values.length; r++) {
      var transformed = transformSheetRow_(values[r], headerMap, spec, nowIso);
      if (transformed) cleanedRows.push(transformed);
    }

    if (cleanedRows.length === 0) {
      Logger.log('[EMPTY] Sheet "' + spec.sheetName + '" -> table `' + spec.tableName + '`: No rows with non-empty `' + spec.primaryKey + '`.');
      totals.sheetsProcessed++;
      continue;
    }

    var deduped = dedupeBatchByPk_(cleanedRows, spec.primaryKey);
    if (deduped.length !== cleanedRows.length) {
      Logger.log('[INFO] "' + spec.sheetName + '": Deduplicated ' + (cleanedRows.length - deduped.length) + ' duplicate PK row(s).');
    }

    if (dryRun) {
      Logger.log('[DRY_RUN] "' + spec.sheetName + '" -> `' + spec.tableName + '`: Parsed ' + deduped.length + ' row(s).');
      totals.rowsUpserted += deduped.length;
      totals.sheetsProcessed++;
      continue;
    }

    var res = upsertTableInChunks_(cfg.baseUrl, cfg.serviceKey, spec, deduped, cfg.batchSize);
    totals.rowsUpserted += res.succeeded;
    totals.rowsFailed += res.failed;
    totals.sheetsProcessed++;

    Logger.log(
      '[DONE] "' + spec.sheetName + '" -> `' + spec.tableName + '`: ' +
      res.succeeded + ' upserted, ' + res.failed + ' failed.'
    );
  }

  var elapsedSec = ((new Date().getTime() - startedMs) / 1000).toFixed(1);
  Logger.log('====================================================================');
  Logger.log(
    '[SUMMARY] Finished in ' + elapsedSec + 's | Sheets Processed: ' + totals.sheetsProcessed +
    ', Skipped: ' + totals.sheetsSkipped +
    ', Rows Upserted: ' + totals.rowsUpserted +
    ', Rows Failed: ' + totals.rowsFailed
  );
  Logger.log('====================================================================');
  return totals;
}

function buildHeaderIndexMap_(headerRow) {
  var map = {};
  for (var c = 0; c < headerRow.length; c++) {
    var name = String(headerRow[c] || '').trim();
    if (name && map[name] === undefined) {
      map[name] = c;
    }
  }
  return map;
}

function transformSheetRow_(rawRow, headerMap, spec, nowIso) {
  var pkCol = spec.primaryKey;
  var pkIdx = headerMap[pkCol];
  if (pkIdx === undefined) return null;
  var pkVal = cleanTextCell_(rawRow[pkIdx]);
  if (!pkVal) return null;

  var out = {};
  var colNames = Object.keys(spec.columns);
  for (var i = 0; i < colNames.length; i++) {
    var colName = colNames[i];
    var colSpec = spec.columns[colName];
    var idx = headerMap[colName];
    var rawVal = idx !== undefined ? rawRow[idx] : undefined;
    out[colName] = formatCellValue_(rawVal, colSpec, nowIso);
  }

  if (typeof spec.postTransform === 'function') {
    out = spec.postTransform(out) || out;
  }
  return out;
}

function formatCellValue_(rawVal, colSpec, nowIso) {
  var fallback = colSpec.defaultVal === '__NOW__' ? nowIso : colSpec.defaultVal;
  var t = colSpec.type;

  if (t === 'text') {
    return cleanTextCell_(rawVal, fallback);
  }
  if (t === 'ts_text') {
    if (rawVal instanceof Date && !isNaN(rawVal.getTime())) {
      return rawVal.toISOString();
    }
    return cleanTextCell_(rawVal, fallback);
  }
  if (t === 'bool') {
    return parseBooleanCell_(rawVal, fallback);
  }
  if (t === 'int') {
    return parseIntegerCell_(rawVal, fallback);
  }
  if (t === 'num') {
    return parseNumericCell_(rawVal, fallback);
  }
  if (t === 'ts') {
    return parseIsoTimestampCell_(rawVal, colSpec.notNull, fallback);
  }
  if (t === 'date') {
    return parseBangkokDateCell_(rawVal, fallback);
  }
  if (t === 'jsonb') {
    return parseJsonbCell_(rawVal, colSpec);
  }
  return cleanTextCell_(rawVal, fallback);
}

function cleanTextCell_(val, opt_default) {
  if (val === null || val === undefined) {
    return opt_default !== undefined && opt_default !== null ? String(opt_default) : '';
  }
  var s = String(val);
  if (s.trim() === '' && opt_default !== undefined && opt_default !== null) {
    return String(opt_default);
  }
  return s;
}

function parseBooleanCell_(val, defaultBool) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  var s = String(val === null || val === undefined ? '' : val).trim().toUpperCase();
  if (s === '') return Boolean(defaultBool);
  if (s === 'TRUE' || s === '1' || s === 'YES' || s === 'Y') return true;
  if (s === 'FALSE' || s === '0' || s === 'NO' || s === 'N') return false;
  return Boolean(defaultBool);
}

function parseIntegerCell_(val, defaultInt) {
  if (val === null || val === undefined || val === '') return Number(defaultInt) || 0;
  if (typeof val === 'number') return isFinite(val) ? Math.round(val) : Number(defaultInt) || 0;
  var s = String(val).replace(/,/g, '').trim();
  if (!s) return Number(defaultInt) || 0;
  var n = Number(s);
  return isFinite(n) ? Math.round(n) : Number(defaultInt) || 0;
}

function parseNumericCell_(val, defaultNum) {
  if (val === null || val === undefined || val === '') return Number(defaultNum) || 0;
  if (typeof val === 'number') return isFinite(val) ? Math.round(val * 100) / 100 : Number(defaultNum) || 0;
  var s = String(val).replace(/,/g, '').trim();
  if (!s) return Number(defaultNum) || 0;
  var n = Number(s);
  return isFinite(n) ? Math.round(n * 100) / 100 : Number(defaultNum) || 0;
}

function parseIsoTimestampCell_(val, isNotNull, fallbackVal) {
  if (val instanceof Date) {
    return !isNaN(val.getTime()) ? val.toISOString() : (isNotNull ? fallbackVal : null);
  }
  var s = String(val === null || val === undefined ? '' : val).trim();
  if (!s || s.toLowerCase() === 'null') {
    return isNotNull ? fallbackVal : null;
  }

  // Handle legacy Bangkok display timestamps such as "2026-10-15 14:30:00 ICT (UTC+07:00)"
  var bkkMatch = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*ICT(?:\s*\(UTC\+07:00\))?$/i);
  if (bkkMatch) {
    s = bkkMatch[1] + 'T' + bkkMatch[2] + (bkkMatch[2].length === 5 ? ':00' : '') + '+07:00';
  }

  var parsed = new Date(s);
  if (isNaN(parsed.getTime())) {
    return isNotNull ? fallbackVal : null;
  }
  return parsed.toISOString();
}

function parseBangkokDateCell_(val, fallbackYmd) {
  if (val instanceof Date && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, 'Asia/Bangkok', 'yyyy-MM-dd');
  }
  var s = String(val === null || val === undefined ? '' : val).trim();
  if (!s || s.toLowerCase() === 'null') return fallbackYmd || '2026-01-01';
  var ymdMatch = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (ymdMatch) return ymdMatch[1];
  var parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, 'Asia/Bangkok', 'yyyy-MM-dd');
  }
  return fallbackYmd || '2026-01-01';
}

function parseJsonbCell_(val, colSpec) {
  var nullableEmpty = colSpec.notNull ? colSpec.defaultVal : (colSpec.defaultVal !== undefined ? colSpec.defaultVal : null);
  if (val === null || val === undefined) return nullableEmpty;
  if (typeof val === 'object' && !(val instanceof Date)) return val;

  var s = String(val).trim();
  if (!s || s.toLowerCase() === 'null') return nullableEmpty;

  try {
    var parsed = JSON.parse(s);
    if (colSpec.expectArray && !Array.isArray(parsed)) {
      return colSpec.defaultVal || [];
    }
    return parsed;
  } catch (ignoreParseErr) {
    if (colSpec.richText) {
      return {
        schemaVersion: 'pb-richtext-v1',
        blocks: [{ type: 'paragraph', spans: [{ text: s }] }]
      };
    }
    if (colSpec.expectArray) {
      return s.split(/[,;|]/).map(function (x) { return x.trim(); }).filter(Boolean);
    }
    return { legacyRawText: s };
  }
}

function dedupeBatchByPk_(rows, pkCol) {
  var indexByPk = {};
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var pk = String(row[pkCol] || '');
    if (Object.prototype.hasOwnProperty.call(indexByPk, pk)) {
      out[indexByPk[pk]] = row;
    } else {
      indexByPk[pk] = out.length;
      out.push(row);
    }
  }
  return out;
}

function upsertTableInChunks_(baseUrl, serviceKey, spec, rows, batchSize) {
  var endpoint =
    baseUrl +
    '/rest/v1/' +
    encodeURIComponent(spec.tableName) +
    '?on_conflict=' +
    encodeURIComponent(spec.primaryKey);

  var succeeded = 0;
  var failed = 0;

  for (var start = 0; start < rows.length; start += batchSize) {
    var chunk = rows.slice(start, start + batchSize);
    var batchRes = postPostgrestUpsert_(endpoint, serviceKey, chunk);
    if (batchRes.ok) {
      succeeded += chunk.length;
      continue;
    }

    Logger.log(
      '[WARN] "' + spec.sheetName + '" batch [' + start + '..' + (start + chunk.length - 1) +
      '] returned HTTP ' + batchRes.status + ': ' + batchRes.body + '. Retrying row-by-row...'
    );

    // Isolate individual bad rows without losing valid neighbors in the batch
    for (var j = 0; j < chunk.length; j++) {
      var singleRes = postPostgrestUpsert_(endpoint, serviceKey, [chunk[j]]);
      if (singleRes.ok) {
        succeeded++;
      } else {
        failed++;
        Logger.log(
          '[ERROR] `' + spec.tableName + '` ' + spec.primaryKey + '=' + chunk[j][spec.primaryKey] +
          ' -> HTTP ' + singleRes.status + ': ' + singleRes.body
        );
      }
    }
  }

  return { succeeded: succeeded, failed: failed };
}

function postPostgrestUpsert_(endpointUrl, serviceKey, payloadArray) {
  var res = UrlFetchApp.fetch(endpointUrl, {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      apikey: serviceKey,
      Authorization: 'Bearer ' + serviceKey,
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    payload: JSON.stringify(payloadArray)
  });

  var code = res.getResponseCode();
  return {
    ok: code >= 200 && code < 300,
    status: code,
    body: code >= 200 && code < 300 ? '' : res.getContentText()
  };
}

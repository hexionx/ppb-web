-- ============================================================================
-- Pattanabhumi Biology LMS — Complete Supabase (PostgreSQL) Migration Schema
-- ============================================================================
-- Migrates all 35 normalized Google Sheets worksheets + 1 Portal Calendar table
-- into PostgreSQL with:
--   1. Exact legacy snake_case table/column alignment for seamless CSV import.
--   2. Google Drive API v3 columns (drive_file_id, web_view_link, web_content_link).
--   3. Row Level Security (RLS) enabled on all 36 tables.
--   4. Zero direct anon table access to `users`, `sessions`, or `login_attempts`
--      so `password_hash` and `token_sha256_hex` are NEVER exposed to browsers.
--   5. `SECURITY DEFINER` PostgreSQL RPC functions (`pb_*`) implementing:
--      - RFC 6070 PBKDF2-HMAC-SHA256 verification (100% compatible with
--        legacy Google Sheet `pbkdf2_sha256$...` password hashes!)
--      - Single-device session enforcement (`NEW_DEVICE_LOGIN` auto-kickout)
--      - Account/unknown/global rate limiting
--      - Privacy consent gate & marketing preferences
--      - Safe admin user CRUD, enrollments, dashboard summary & factory reset
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. AUTHENTICATION, SESSIONS, PRIVACY, SETTINGS & AUDIT
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.users (
  user_id text PRIMARY KEY,
  username_lower text NOT NULL UNIQUE,
  username_display text NOT NULL,
  email text NOT NULL DEFAULT '',
  full_name text NOT NULL,
  role text NOT NULL CHECK (role IN ('STUDENT', 'ADMIN')),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED', 'INTEGRITY_LOCKED')),
  password_hash text NOT NULL,
  password_updated_at_utc timestamptz,
  last_login_at_utc timestamptz,
  privacy_ack_version text DEFAULT '',
  marketing_opt_in boolean NOT NULL DEFAULT false,
  is_minor_flag boolean NOT NULL DEFAULT false,
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.sessions (
  session_id text PRIMARY KEY,
  token_sha256_hex text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  remember_me boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  expires_at_utc timestamptz NOT NULL,
  last_seen_at_utc timestamptz,
  revoked_at_utc timestamptz,
  revoke_reason text DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_status ON public.sessions(user_id, status);

CREATE TABLE IF NOT EXISTS public.login_attempts (
  subject_key text PRIMARY KEY,
  window_start_utc timestamptz NOT NULL DEFAULT now(),
  failure_count integer NOT NULL DEFAULT 0,
  locked_until_utc timestamptz,
  last_attempt_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_email_otps (
  otp_id text PRIMARY KEY,
  actor_user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  target_email text NOT NULL,
  otp_sha256_hex text NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  expires_at_utc timestamptz NOT NULL,
  consumed_at_utc timestamptz,
  created_at_utc timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_email_otps_actor ON public.admin_email_otps(actor_user_id, created_at_utc DESC);

CREATE TABLE IF NOT EXISTS public.privacy_choices (
  choice_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  notice_version text NOT NULL,
  acknowledged_notice boolean NOT NULL DEFAULT false,
  marketing_opt_in boolean NOT NULL DEFAULT false,
  action_source text NOT NULL CHECK (action_source IN ('FIRST_LOGIN_GATE', 'NOTICE_UPDATE_GATE', 'PROFILE_PREFERENCE_UPDATE')),
  recorded_at_utc timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_privacy_choices_user ON public.privacy_choices(user_id, recorded_at_utc DESC);

CREATE TABLE IF NOT EXISTS public.settings (
  setting_key text PRIMARY KEY,
  setting_value text DEFAULT '',
  updated_by_user_id text DEFAULT '',
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.audit_events (
  audit_id text PRIMARY KEY,
  actor_user_id text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('STUDENT', 'ADMIN', 'ANONYMOUS', 'SYSTEM')),
  event_type text NOT NULL,
  target_entity_type text NOT NULL,
  target_entity_id text DEFAULT '',
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at_utc timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_events_created ON public.audit_events(created_at_utc DESC);

-- ============================================================================
-- 2. GOOGLE DRIVE FILE INDEX (Supports both legacy drive_file_id & web_view_link)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.files (
  file_id text PRIMARY KEY,
  drive_file_id text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN (
    'SCHOOL_LOGO', 'COURSE_COVER', 'RICHTEXT_IMAGE', 'CARD_IMAGE', 'PDF_ATTACHMENT',
    'COURSE_IMAGE', 'COURSE_PDF', 'PAYMENT_RECEIPT', 'PROMPTPAY_QR_IMAGE',
    'INSTRUCTOR_PORTRAIT', 'HERO_SHUFFLE_CARD', 'HERO_CARD_1', 'HERO_CARD_2', 'HERO_CARD_3',
    'QUESTION_IMAGE', 'OPTION_IMAGE', 'STIMULUS_IMAGE', 'EXAM_COVER_IMAGE',
    'QUESTION_PDF', 'EXPLANATION_ATTACHMENT'
  )),
  course_id text DEFAULT '',
  owner_user_id text DEFAULT '',
  original_filename text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf')),
  size_bytes bigint NOT NULL DEFAULT 0,
  sha256_hex text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELETED')),
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  web_view_link text DEFAULT '',
  web_content_link text DEFAULT '',
  storage_provider text NOT NULL DEFAULT 'GOOGLE_DRIVE'
);
CREATE INDEX IF NOT EXISTS idx_files_purpose_status ON public.files(purpose, status);
CREATE INDEX IF NOT EXISTS idx_files_drive_id ON public.files(drive_file_id);

-- ============================================================================
-- 3. COURSES, SECTIONS, CARDS, LEGACY ASSESSMENTS & ENROLLMENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.courses (
  course_id text PRIMARY KEY,
  course_code text NOT NULL UNIQUE,
  title text NOT NULL,
  subtitle text DEFAULT '',
  cover_file_id text DEFAULT '',
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  sort_order integer NOT NULL DEFAULT 0,
  objectives_richtext_json jsonb,
  outcomes_richtext_json jsonb,
  assessment_updated_at_utc timestamptz,
  reading_updated_at_utc timestamptz,
  calendar_tag text DEFAULT '',
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_courses_status_sort ON public.courses(status, sort_order);

CREATE TABLE IF NOT EXISTS public.sections (
  section_id text PRIMARY KEY,
  course_id text NOT NULL REFERENCES public.courses(course_id) ON DELETE CASCADE,
  section_type text NOT NULL CHECK (section_type IN ('ASSESSMENT', 'READING', 'RECORDING', 'CUSTOM')),
  title text NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  sort_order integer NOT NULL DEFAULT 0,
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_sections_course_sort ON public.sections(course_id, sort_order);

CREATE TABLE IF NOT EXISTS public.cards (
  card_id text PRIMARY KEY,
  course_id text NOT NULL REFERENCES public.courses(course_id) ON DELETE CASCADE,
  section_id text NOT NULL REFERENCES public.sections(section_id) ON DELETE CASCADE,
  card_type text NOT NULL CHECK (card_type IN ('READING_CARD', 'RECORDING_CARD', 'ASSESSMENT_LINK_CARD')),
  title text NOT NULL,
  subtitle text DEFAULT '',
  image_file_id text DEFAULT '',
  image_caption text DEFAULT '',
  content_richtext_json jsonb,
  recording_url text DEFAULT '',
  recording_uploaded_at_utc text DEFAULT '',
  assessment_id text DEFAULT '',
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_cards_course_section ON public.cards(course_id, section_id, sort_order);

CREATE TABLE IF NOT EXISTS public.assessments (
  assessment_id text PRIMARY KEY,
  title text NOT NULL,
  description_richtext_json jsonb,
  external_url text DEFAULT '',
  pdf_file_id text DEFAULT '',
  status text NOT NULL CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.assessment_scores (
  score_id text PRIMARY KEY,
  course_id text NOT NULL,
  assessment_id text NOT NULL,
  student_user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  score_points numeric(10, 2) NOT NULL DEFAULT 0,
  max_points numeric(10, 2) NOT NULL DEFAULT 0,
  feedback_text text DEFAULT '',
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  published_at_utc timestamptz,
  updated_by_user_id text DEFAULT '',
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_assessment_scores_student ON public.assessment_scores(student_user_id, course_id);

CREATE TABLE IF NOT EXISTS public.enrollments (
  enrollment_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  course_id text NOT NULL REFERENCES public.courses(course_id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'COMPLETED')),
  assigned_by_user_id text DEFAULT '',
  assigned_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_enrollments_user_course ON public.enrollments(user_id, course_id, status);

-- ============================================================================
-- 4. QUESTION BANK & SHARED PASSAGES
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.shared_stimuli (
  stimulus_id text PRIMARY KEY,
  stimulus_code text NOT NULL UNIQUE,
  title text NOT NULL,
  content_richtext_json jsonb,
  image_file_id text DEFAULT '',
  image_alt_text text DEFAULT '',
  image_caption text DEFAULT '',
  accessible_design_flag text NOT NULL CHECK (accessible_design_flag IN ('STANDARD_ALT', 'VISUAL_INTERPRETATION_REQUIRED')),
  topic_tags_json jsonb DEFAULT '[]'::jsonb,
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  created_by_user_id text DEFAULT '',
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.question_bank (
  question_id text PRIMARY KEY,
  question_code text NOT NULL UNIQUE,
  title text NOT NULL,
  question_type text NOT NULL CHECK (question_type IN (
    'SINGLE_CHOICE', 'COMPLEX_MULTIPLE_CHOICE', 'MULTIPLE_SELECT',
    'TRUE_FALSE', 'NUMERIC_RESPONSE', 'SHORT_ANSWER', 'WRITTEN_RESPONSE'
  )),
  topic_tags_json jsonb DEFAULT '[]'::jsonb,
  difficulty text NOT NULL CHECK (difficulty IN ('EASY', 'MEDIUM', 'HARD', 'OLYMPIAD')),
  active_version_id text NOT NULL,
  latest_version_no integer NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  used_in_attempts_count integer NOT NULL DEFAULT 0,
  created_by_user_id text DEFAULT '',
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_qbank_status ON public.question_bank(status, question_type);

CREATE TABLE IF NOT EXISTS public.question_versions (
  question_version_id text PRIMARY KEY,
  question_id text NOT NULL REFERENCES public.question_bank(question_id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  question_type text NOT NULL CHECK (question_type IN (
    'SINGLE_CHOICE', 'COMPLEX_MULTIPLE_CHOICE', 'MULTIPLE_SELECT',
    'TRUE_FALSE', 'NUMERIC_RESPONSE', 'SHORT_ANSWER', 'WRITTEN_RESPONSE'
  )),
  title text NOT NULL,
  stem_richtext_json jsonb NOT NULL,
  stimulus_id text DEFAULT '',
  image_file_id text DEFAULT '',
  image_alt_text text DEFAULT '',
  image_caption text DEFAULT '',
  accessible_design_flag text NOT NULL CHECK (accessible_design_flag IN ('STANDARD_ALT', 'VISUAL_INTERPRETATION_REQUIRED')),
  default_points_bp integer NOT NULL,
  negative_points_bp integer NOT NULL DEFAULT 0,
  lock_option_order boolean NOT NULL DEFAULT false,
  selection_instruction text DEFAULT '',
  unit_label text DEFAULT '',
  max_length_chars integer NOT NULL DEFAULT 0,
  grading_mode text NOT NULL CHECK (grading_mode IN ('AUTO', 'MANUAL', 'AUTO_WITH_MANUAL_REVIEW')),
  grading_spec_private_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  explanation_richtext_json jsonb,
  reference_text text DEFAULT '',
  admin_notes_private text DEFAULT '',
  is_immutable boolean NOT NULL DEFAULT false,
  created_by_user_id text DEFAULT '',
  created_at_utc timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qversions_qid ON public.question_versions(question_id, version_no);

CREATE TABLE IF NOT EXISTS public.question_options (
  option_id text PRIMARY KEY,
  question_version_id text NOT NULL REFERENCES public.question_versions(question_version_id) ON DELETE CASCADE,
  question_id text NOT NULL REFERENCES public.question_bank(question_id) ON DELETE CASCADE,
  option_key text NOT NULL,
  content_richtext_json jsonb NOT NULL,
  image_file_id text DEFAULT '',
  image_alt_text text DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  pin_position text NOT NULL CHECK (pin_position IN ('NONE', 'LAST', 'FIXED')),
  is_correct_private boolean NOT NULL DEFAULT false,
  created_at_utc timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qoptions_qvid ON public.question_options(question_version_id, sort_order);

-- ============================================================================
-- 5. EXAM SETS, VERSIONS, SECTIONS, ITEMS & ASSIGNMENTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.exam_sets (
  exam_set_id text PRIMARY KEY,
  assessment_id text DEFAULT '',
  course_id text DEFAULT '',
  exam_code text NOT NULL UNIQUE,
  title text NOT NULL,
  description_richtext_json jsonb,
  instructions_richtext_json jsonb,
  cover_image_file_id text DEFAULT '',
  exam_mode text NOT NULL CHECK (exam_mode IN ('PRACTICE', 'MOCK_EXAM', 'ASSIGNED_ASSESSMENT')),
  active_exam_version_id text DEFAULT '',
  draft_exam_version_id text DEFAULT '',
  latest_version_no integer NOT NULL DEFAULT 1,
  assignment_scope text NOT NULL CHECK (assignment_scope IN ('COURSE_ENROLLED', 'SELECTED_STUDENTS')),
  open_at_utc timestamptz,
  close_at_utc timestamptz,
  duration_minutes integer NOT NULL DEFAULT 90,
  grace_seconds integer NOT NULL DEFAULT 30,
  max_attempts integer NOT NULL DEFAULT 1,
  retake_cooldown_minutes integer NOT NULL DEFAULT 0,
  navigation_mode text NOT NULL CHECK (navigation_mode IN ('FREE', 'LINEAR')),
  aggregation_rule text NOT NULL CHECK (aggregation_rule IN ('BEST_PUBLISHED', 'LATEST_PUBLISHED', 'FIRST_PUBLISHED')),
  score_release_policy text NOT NULL CHECK (score_release_policy IN ('IMMEDIATE_AUTO', 'MANUAL_ADMIN', 'SCHEDULED', 'AFTER_CLOSE')),
  score_release_at_utc timestamptz,
  explanation_release_policy text NOT NULL CHECK (explanation_release_policy IN ('WITH_SCORE', 'MANUAL_ADMIN', 'SCHEDULED', 'AFTER_CLOSE', 'NEVER')),
  explanation_release_at_utc timestamptz,
  pass_threshold_pct integer NOT NULL DEFAULT 60,
  randomize_questions boolean NOT NULL DEFAULT false,
  randomize_options boolean NOT NULL DEFAULT false,
  allow_per_question_practice_feedback boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED')),
  created_by_user_id text DEFAULT '',
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  copy_policy_enabled boolean NOT NULL DEFAULT false,
  copy_policy_version text DEFAULT '',
  max_copy_warnings integer NOT NULL DEFAULT 3,
  copy_suspension_seconds integer NOT NULL DEFAULT 5,
  max_integrity_invalidations_before_lock integer NOT NULL DEFAULT 2
);

CREATE TABLE IF NOT EXISTS public.exam_versions (
  exam_version_id text PRIMARY KEY,
  exam_set_id text NOT NULL REFERENCES public.exam_sets(exam_set_id) ON DELETE CASCADE,
  version_no integer NOT NULL,
  version_state text NOT NULL CHECK (version_state IN ('DRAFT', 'PUBLISHED')),
  exam_mode text NOT NULL CHECK (exam_mode IN ('PRACTICE', 'MOCK_EXAM', 'ASSIGNED_ASSESSMENT')),
  title text NOT NULL,
  instructions_richtext_json jsonb,
  duration_minutes integer NOT NULL DEFAULT 0,
  grace_seconds integer NOT NULL DEFAULT 0,
  total_questions_count integer NOT NULL DEFAULT 0,
  max_points_bp integer NOT NULL DEFAULT 0,
  negative_marking_enabled boolean NOT NULL DEFAULT false,
  unanswered_points_bp integer NOT NULL DEFAULT 0,
  navigation_mode text NOT NULL CHECK (navigation_mode IN ('FREE', 'LINEAR')),
  randomize_questions boolean NOT NULL DEFAULT false,
  randomize_options boolean NOT NULL DEFAULT false,
  allow_per_question_practice_feedback boolean NOT NULL DEFAULT false,
  policy_snapshot_json jsonb DEFAULT '{}'::jsonb,
  published_by_user_id text DEFAULT '',
  published_at_utc timestamptz,
  created_at_utc timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exversions_set ON public.exam_versions(exam_set_id, version_no);

CREATE TABLE IF NOT EXISTS public.exam_sections (
  exam_section_id text PRIMARY KEY,
  exam_version_id text NOT NULL REFERENCES public.exam_versions(exam_version_id) ON DELETE CASCADE,
  exam_set_id text NOT NULL REFERENCES public.exam_sets(exam_set_id) ON DELETE CASCADE,
  title text NOT NULL,
  instructions_richtext_json jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  selection_mode text NOT NULL CHECK (selection_mode IN ('FIXED_ITEMS', 'QUESTION_POOL')),
  pool_draw_count integer NOT NULL DEFAULT 0,
  pool_filter_json jsonb DEFAULT '{}'::jsonb,
  lock_section_order boolean NOT NULL DEFAULT false,
  randomize_items_within_section boolean NOT NULL DEFAULT false,
  section_questions_count integer NOT NULL DEFAULT 0,
  section_max_points_bp integer NOT NULL DEFAULT 0,
  created_at_utc timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exsections_ver ON public.exam_sections(exam_version_id, sort_order);

CREATE TABLE IF NOT EXISTS public.exam_items (
  exam_item_id text PRIMARY KEY,
  exam_version_id text NOT NULL REFERENCES public.exam_versions(exam_version_id) ON DELETE CASCADE,
  exam_section_id text NOT NULL REFERENCES public.exam_sections(exam_section_id) ON DELETE CASCADE,
  exam_set_id text NOT NULL REFERENCES public.exam_sets(exam_set_id) ON DELETE CASCADE,
  question_id text NOT NULL,
  question_version_id text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  lock_item_position boolean NOT NULL DEFAULT false,
  lock_option_order boolean NOT NULL DEFAULT false,
  points_bp integer NOT NULL,
  negative_points_bp integer NOT NULL DEFAULT 0,
  is_pool_candidate boolean NOT NULL DEFAULT false,
  pool_group_tag text DEFAULT '',
  created_at_utc timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exitems_ver ON public.exam_items(exam_version_id, sort_order);

CREATE TABLE IF NOT EXISTS public.exam_assignments (
  assignment_id text PRIMARY KEY,
  exam_set_id text NOT NULL REFERENCES public.exam_sets(exam_set_id) ON DELETE CASCADE,
  course_id text DEFAULT '',
  target_type text NOT NULL CHECK (target_type IN ('COURSE', 'STUDENT')),
  student_user_id text DEFAULT '',
  assignment_status text NOT NULL CHECK (assignment_status IN ('ASSIGNED', 'REVOKED')),
  open_at_override_utc timestamptz,
  override_deadline_utc timestamptz,
  extra_time_minutes integer NOT NULL DEFAULT 0,
  extra_attempts_granted integer NOT NULL DEFAULT 0,
  accommodation_reason text DEFAULT '',
  assigned_by_user_id text DEFAULT '',
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  copy_policy_accommodation_mode text DEFAULT '',
  custom_max_copy_warnings integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_exassign_set ON public.exam_assignments(exam_set_id, assignment_status);

-- ============================================================================
-- 6. EXAM ATTEMPTS, RESPONSES, GRADING JOURNAL & RESULT REVISIONS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.exam_attempts (
  attempt_id text PRIMARY KEY,
  exam_set_id text NOT NULL REFERENCES public.exam_sets(exam_set_id) ON DELETE CASCADE,
  exam_version_id text NOT NULL REFERENCES public.exam_versions(exam_version_id) ON DELETE CASCADE,
  course_id text DEFAULT '',
  student_user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  attempt_number integer NOT NULL,
  idempotency_key text DEFAULT '',
  attempt_status text NOT NULL CHECK (attempt_status IN ('IN_PROGRESS', 'SUBMITTING', 'SUBMITTED', 'EXPIRED_SUBMITTED', 'INVALIDATED', 'INVALIDATED_COPY_POLICY')),
  grading_status text NOT NULL CHECK (grading_status IN ('NOT_GRADED', 'GRADING_IN_PROGRESS', 'AUTO_GRADED_PENDING_MANUAL', 'GRADED', 'REGRADED')),
  publication_status text NOT NULL CHECK (publication_status IN ('UNPUBLISHED', 'SCHEDULED', 'PUBLISHED', 'WITHHELD')),
  explanation_status text NOT NULL CHECK (explanation_status IN ('WITHHELD', 'RELEASED')),
  started_at_utc timestamptz NOT NULL DEFAULT now(),
  effective_deadline_utc timestamptz,
  grace_deadline_utc timestamptz,
  submitted_at_utc timestamptz,
  last_saved_at_utc timestamptz,
  time_used_seconds integer NOT NULL DEFAULT 0,
  active_lease_token text DEFAULT '',
  latest_revision_no integer NOT NULL DEFAULT 0,
  answered_count integer NOT NULL DEFAULT 0,
  flagged_count integer NOT NULL DEFAULT 0,
  auto_score_bp integer NOT NULL DEFAULT 0,
  manual_score_bp integer NOT NULL DEFAULT 0,
  total_score_bp integer NOT NULL DEFAULT 0,
  max_score_bp integer NOT NULL DEFAULT 0,
  percentage_bp integer NOT NULL DEFAULT 0,
  passed_flag boolean NOT NULL DEFAULT false,
  current_result_revision_id text DEFAULT '',
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  copy_policy_enabled_snapshot boolean NOT NULL DEFAULT false,
  copy_policy_version_snapshot text DEFAULT '',
  max_copy_warnings_snapshot integer NOT NULL DEFAULT 0,
  copy_suspension_seconds_snapshot integer NOT NULL DEFAULT 0,
  max_invalidations_lock_snapshot integer NOT NULL DEFAULT 0,
  policy_acknowledged_at_utc timestamptz,
  copy_warning_count integer NOT NULL DEFAULT 0,
  suspension_until_utc timestamptz,
  invalidation_reason_code text DEFAULT '',
  invalidated_at_utc timestamptz,
  invalidation_overturned boolean NOT NULL DEFAULT false,
  invalidation_overturned_at_utc timestamptz,
  invalidation_overturned_by_user_id text DEFAULT '',
  invalidation_review_reason text DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_attempts_student_exam ON public.exam_attempts(student_user_id, exam_set_id);

CREATE TABLE IF NOT EXISTS public.attempt_items (
  attempt_item_id text PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES public.exam_attempts(attempt_id) ON DELETE CASCADE,
  exam_set_id text NOT NULL,
  exam_version_id text NOT NULL,
  exam_section_id text NOT NULL,
  display_number integer NOT NULL,
  question_id text NOT NULL,
  question_version_id text NOT NULL,
  stimulus_id text DEFAULT '',
  option_order_json jsonb DEFAULT '[]'::jsonb,
  points_bp integer NOT NULL,
  negative_points_bp integer NOT NULL DEFAULT 0,
  is_flagged boolean NOT NULL DEFAULT false,
  flag_updated_at_utc timestamptz,
  created_at_utc timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attempt_items_attempt ON public.attempt_items(attempt_id, display_number);

CREATE TABLE IF NOT EXISTS public.attempt_responses (
  response_id text PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES public.exam_attempts(attempt_id) ON DELETE CASCADE,
  attempt_item_id text NOT NULL REFERENCES public.attempt_items(attempt_item_id) ON DELETE CASCADE,
  question_version_id text NOT NULL,
  student_user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  response_payload_json jsonb DEFAULT '{}'::jsonb,
  is_answered boolean NOT NULL DEFAULT false,
  client_revision_no integer NOT NULL DEFAULT 0,
  server_revision_no integer NOT NULL DEFAULT 0,
  saved_at_utc timestamptz NOT NULL DEFAULT now(),
  grading_source text NOT NULL CHECK (grading_source IN ('UNGRADED', 'AUTO_ENGINE', 'MANUAL_INSTRUCTOR', 'REGRADE_ENGINE')),
  awarded_points_bp integer NOT NULL DEFAULT 0,
  max_points_bp integer NOT NULL DEFAULT 0,
  correctness_state text NOT NULL CHECK (correctness_state IN ('UNGRADED', 'CORRECT', 'PARTIAL', 'INCORRECT', 'UNANSWERED', 'MANUAL_REVIEW_PENDING')),
  instructor_feedback text DEFAULT '',
  graded_by_user_id text DEFAULT '',
  graded_at_utc timestamptz,
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_attempt_responses_attempt ON public.attempt_responses(attempt_id, attempt_item_id);

CREATE TABLE IF NOT EXISTS public.exam_operation_journal (
  journal_id text PRIMARY KEY,
  operation_type text NOT NULL CHECK (operation_type IN (
    'START_ATTEMPT', 'SUBMIT_ATTEMPT', 'EXPIRE_FINALIZE', 'GRADE_ATTEMPT',
    'PUBLISH_RESULT', 'REGRADE_ATTEMPT', 'INTEGRITY_COPY_EVENT', 'INTEGRITY_ADMIN_REVIEW'
  )),
  idempotency_key text NOT NULL,
  attempt_id text NOT NULL,
  exam_set_id text NOT NULL,
  student_user_id text NOT NULL,
  target_status text NOT NULL,
  payload_json jsonb DEFAULT '{}'::jsonb,
  journal_status text NOT NULL CHECK (journal_status IN ('PENDING', 'COMMITTED', 'ROLLED_BACK', 'HALTED_INCONSISTENT')),
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  committed_at_utc timestamptz
);

CREATE TABLE IF NOT EXISTS public.result_revisions (
  result_revision_id text PRIMARY KEY,
  attempt_id text NOT NULL REFERENCES public.exam_attempts(attempt_id) ON DELETE CASCADE,
  exam_set_id text NOT NULL,
  exam_version_id text NOT NULL,
  student_user_id text NOT NULL,
  revision_no integer NOT NULL,
  revision_type text NOT NULL CHECK (revision_type IN ('INITIAL_AUTO_GRADE', 'MANUAL_GRADING_COMPLETED', 'PUBLICATION_CHANGE', 'ADMIN_REGRADE')),
  auto_score_bp integer NOT NULL DEFAULT 0,
  manual_score_bp integer NOT NULL DEFAULT 0,
  total_score_bp integer NOT NULL DEFAULT 0,
  max_score_bp integer NOT NULL DEFAULT 0,
  percentage_bp integer NOT NULL DEFAULT 0,
  passed_flag boolean NOT NULL DEFAULT false,
  grading_status text NOT NULL CHECK (grading_status IN ('NOT_GRADED', 'GRADING_IN_PROGRESS', 'AUTO_GRADED_PENDING_MANUAL', 'GRADED', 'REGRADED')),
  publication_status text NOT NULL CHECK (publication_status IN ('UNPUBLISHED', 'SCHEDULED', 'PUBLISHED', 'WITHHELD')),
  explanation_status text NOT NULL CHECK (explanation_status IN ('WITHHELD', 'RELEASED')),
  reason text DEFAULT '',
  actor_user_id text NOT NULL,
  created_at_utc timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_result_revisions_attempt ON public.result_revisions(attempt_id, revision_no DESC);

-- ============================================================================
-- 7. EXAM INTEGRITY & ANTI-COPY LOGS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.exam_integrity_events (
  integrity_event_id text PRIMARY KEY,
  event_client_id text NOT NULL,
  attempt_id text NOT NULL REFERENCES public.exam_attempts(attempt_id) ON DELETE CASCADE,
  exam_set_id text NOT NULL,
  exam_version_id text DEFAULT '',
  course_id text DEFAULT '',
  student_user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  policy_version text NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('QUALIFYING_COPY_ATTEMPT')),
  target_region text NOT NULL CHECK (target_region IN ('QUESTION_STEM', 'OPTION_TEXT', 'SHARED_STIMULUS', 'QUESTION_CAPTION')),
  attempt_item_id text DEFAULT '',
  question_id text DEFAULT '',
  warning_count_after integer NOT NULL DEFAULT 0,
  outcome_action text NOT NULL CHECK (outcome_action IN ('SUSPENDED_5S', 'ATTEMPT_INVALIDATED', 'IGNORED_DURING_SUSPENSION', 'IDEMPOTENT_REPLAY')),
  suspension_until_utc timestamptz,
  triggered_invalidation boolean NOT NULL DEFAULT false,
  triggered_account_lock boolean NOT NULL DEFAULT false,
  review_status text NOT NULL CHECK (review_status IN ('UNREVIEWED', 'CONFIRMED', 'ERRONEOUS_OVERTURNED')),
  reviewed_by_user_id text DEFAULT '',
  reviewed_at_utc timestamptz,
  review_reason text DEFAULT '',
  detected_at_client_utc timestamptz,
  recorded_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_integrity_events_student ON public.exam_integrity_events(student_user_id, recorded_at_utc DESC);

CREATE TABLE IF NOT EXISTS public.exam_policy_acknowledgments (
  ack_id text PRIMARY KEY,
  exam_set_id text NOT NULL,
  exam_version_id text DEFAULT '',
  attempt_id text DEFAULT '',
  student_user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  policy_version text NOT NULL,
  max_copy_warnings_snapshot integer NOT NULL DEFAULT 0,
  suspension_seconds_snapshot integer NOT NULL DEFAULT 0,
  max_invalidations_before_lock_snapshot integer NOT NULL DEFAULT 0,
  acknowledged_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.student_integrity_profiles (
  profile_id text PRIMARY KEY,
  student_user_id text NOT NULL UNIQUE REFERENCES public.users(user_id) ON DELETE CASCADE,
  integrity_status text NOT NULL CHECK (integrity_status IN ('CLEAR', 'WARNED', 'INTEGRITY_LOCKED', 'UNLOCKED_ON_PROBATION')),
  distinct_copy_invalidations_total integer NOT NULL DEFAULT 0,
  overturned_invalidations_total integer NOT NULL DEFAULT 0,
  effective_strike_baseline integer NOT NULL DEFAULT 0,
  effective_active_strikes integer NOT NULL DEFAULT 0,
  locked_at_utc timestamptz,
  lock_trigger_attempt_id text DEFAULT '',
  lock_reason_code text DEFAULT '',
  unlocked_at_utc timestamptz,
  unlocked_by_user_id text DEFAULT '',
  unlock_reason text DEFAULT '',
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS public.exam_integrity_reviews (
  review_id text PRIMARY KEY,
  target_type text NOT NULL CHECK (target_type IN ('INTEGRITY_EVENT', 'ATTEMPT_INVALIDATION', 'ACCOUNT_INTEGRITY_LOCK')),
  target_id text NOT NULL,
  student_user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  attempt_id text DEFAULT '',
  exam_set_id text DEFAULT '',
  action_taken text NOT NULL CHECK (action_taken IN ('MARK_EVENT_ERRONEOUS', 'CONFIRM_INCIDENT', 'OVERTURN_INVALIDATION', 'GRANT_REPLACEMENT_ATTEMPT', 'UNLOCK_ACCOUNT_SET_BASELINE')),
  previous_state_json jsonb DEFAULT '{}'::jsonb,
  new_state_json jsonb DEFAULT '{}'::jsonb,
  new_strike_baseline_count integer NOT NULL DEFAULT 0,
  reason text NOT NULL,
  admin_user_id text NOT NULL,
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);

-- ============================================================================
-- 8. BILLING, PAYMENTS, CLASS CALENDAR & UNAVAILABILITY REQUESTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.invoices (
  invoice_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  course_id text DEFAULT '',
  installment_label text NOT NULL,
  amount_satang bigint NOT NULL CHECK (amount_satang > 0),
  due_date_bkk date NOT NULL,
  status text NOT NULL CHECK (status IN ('UNPAID', 'RESERVED', 'AWAITING_VERIFICATION', 'APPROVING', 'PAID', 'REJECTED', 'CANCELLED')),
  active_payment_id text DEFAULT '',
  reservation_expires_at_utc timestamptz,
  last_rejection_reason text DEFAULT '',
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_invoices_user_status ON public.invoices(user_id, status);

CREATE TABLE IF NOT EXISTS public.payments (
  payment_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  invoice_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_amount_satang bigint NOT NULL CHECK (total_amount_satang > 0),
  method text NOT NULL CHECK (method IN ('PROMPTPAY_QR', 'BANK_TRANSFER')),
  status text NOT NULL CHECK (status IN ('PENDING_TRANSFER', 'RECEIPT_UPLOADED', 'AWAITING_VERIFICATION', 'APPROVING', 'PAID', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED')),
  idempotency_key text NOT NULL,
  expires_at_utc timestamptz,
  receipt_file_id text DEFAULT '',
  submitted_at_utc timestamptz,
  reviewed_by_user_id text DEFAULT '',
  reviewed_at_utc timestamptz,
  rejection_reason text DEFAULT '',
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_payments_user_status ON public.payments(user_id, status);

CREATE TABLE IF NOT EXISTS public.payment_journal (
  journal_id text PRIMARY KEY,
  operation_type text NOT NULL CHECK (operation_type IN ('RESERVE', 'SUBMIT_FOR_VERIFICATION', 'CANCEL_RESERVATION', 'ADMIN_APPROVE', 'ADMIN_REJECT', 'EXPIRE_RESERVATION')),
  idempotency_key text NOT NULL,
  payment_id text NOT NULL,
  invoice_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  target_payment_status text NOT NULL,
  target_invoice_status text NOT NULL,
  payload_json jsonb DEFAULT '{}'::jsonb,
  journal_status text NOT NULL CHECK (journal_status IN ('PENDING', 'COMMITTED', 'HALTED_INCONSISTENT')),
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  committed_at_utc timestamptz
);

CREATE TABLE IF NOT EXISTS public.unavailability_requests (
  request_id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  course_id text DEFAULT '',
  unavailable_start_date_bkk date NOT NULL,
  unavailable_end_date_bkk date NOT NULL,
  reason text NOT NULL,
  email_recipient text DEFAULT '',
  email_delivery_status text NOT NULL CHECK (email_delivery_status IN ('PENDING_ATTEMPT', 'SENT', 'FAILED', 'QUOTA_EXCEEDED', 'RECIPIENT_NOT_CONFIGURED', 'UNCERTAIN_POST_SEND_UPDATE_FAILED')),
  email_error_detail text DEFAULT '',
  email_attempted_at_utc timestamptz,
  admin_note text DEFAULT '',
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_unavail_user ON public.unavailability_requests(user_id, created_at_utc DESC);

CREATE TABLE IF NOT EXISTS public.calendar_events (
  event_id text PRIMARY KEY,
  title text NOT NULL,
  course_id text DEFAULT '',
  course_code text DEFAULT '',
  calendar_tag text DEFAULT '',
  scope text NOT NULL DEFAULT 'COURSE' CHECK (scope IN ('SCHOOL_WIDE', 'COURSE')),
  start_date_bkk date NOT NULL,
  end_date_bkk date NOT NULL,
  all_day boolean NOT NULL DEFAULT false,
  start_time_bkk text DEFAULT '',
  end_time_bkk text DEFAULT '',
  location text DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELETED')),
  created_by_user_id text DEFAULT '',
  created_at_utc timestamptz NOT NULL DEFAULT now(),
  updated_at_utc timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calendar_events_dates ON public.calendar_events(status, start_date_bkk, end_date_bkk);

-- ============================================================================
-- DEFAULT SETTINGS SEED (Idempotent)
-- ============================================================================

INSERT INTO public.settings (setting_key, setting_value, updated_by_user_id, version)
VALUES
  ('SCHOOL_NAME', 'Pattanabhumi Biology', 'SYSTEM_SEED', 1),
  ('LOGO_FILE_ID', '', 'SYSTEM_SEED', 1),
  ('CONTACT_LINE_URL', 'https://line.me/R/ti/p/@pattanabhumi_placeholder', 'SYSTEM_SEED', 1),
  ('CONTACT_FACEBOOK_URL', 'https://www.facebook.com/pattanabhumi.placeholder', 'SYSTEM_SEED', 1),
  ('CONTACT_EMAIL', 'contact@pattanabhumi-biology.example.com', 'SYSTEM_SEED', 1),
  ('ADMIN_NOTIFICATION_EMAIL', '', 'SYSTEM_SEED', 1),
  ('BANK_NAME', 'Placeholder Bank (Configure in Admin Settings)', 'SYSTEM_SEED', 1),
  ('BANK_ACCOUNT_NAME', 'Pattanabhumi Biology Tutoring (Placeholder)', 'SYSTEM_SEED', 1),
  ('BANK_ACCOUNT_NUMBER', '000-0-00000-0', 'SYSTEM_SEED', 1),
  ('PROMPTPAY_QR_FILE_ID', '', 'SYSTEM_SEED', 1),
  ('PROMPTPAY_ID_DISPLAY', '000-000-0000', 'SYSTEM_SEED', 1),
  ('CURRENT_PRIVACY_NOTICE_VERSION', '2026-10-v1', 'SYSTEM_SEED', 1),
  ('PRIVACY_NOTICE_DOCUMENT_TEXT',
   E'1. Educational & Administrative Data Processed\nPattanabhumi Biology processes your account profile, course enrollments, tuition installment records, uploaded payment receipts, and class unavailability reports in the Asia/Bangkok timezone.\n\n2. Where Portal Records Are Stored\nApplication records are stored in Supabase PostgreSQL and uploaded files are stored in Google Drive.\n\n3. Essential Browser Storage & Cookie Policy\nBy default, session tokens reside in memory only; optional Remember me uses localStorage.\n\n4. School Legal Review & Minor Students\nPattanabhumi Biology administration reviews retention schedules and guardian consent requirements.',
   'SYSTEM_SEED', 1)
ON CONFLICT (setting_key) DO NOTHING;

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================================

-- 1) STRICTLY LOCKED AUTHENTICATION TABLES
-- No browser client (`anon` / `authenticated`) can query or mutate users, sessions,
-- or login_attempts directly. `password_hash` and `token_sha256_hex` never leave DB.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_email_otps ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.users FROM anon, authenticated;
REVOKE ALL ON public.sessions FROM anon, authenticated;
REVOKE ALL ON public.login_attempts FROM anon, authenticated;
REVOKE ALL ON public.admin_email_otps FROM anon, authenticated;

DROP POLICY IF EXISTS "Deny direct users table access" ON public.users;
CREATE POLICY "Deny direct users table access" ON public.users AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "Deny direct sessions table access" ON public.sessions;
CREATE POLICY "Deny direct sessions table access" ON public.sessions AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "Deny direct login_attempts table access" ON public.login_attempts;
CREATE POLICY "Deny direct login_attempts table access" ON public.login_attempts AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "Deny direct admin_email_otps table access" ON public.admin_email_otps;
CREATE POLICY "Deny direct admin_email_otps table access" ON public.admin_email_otps AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- 2) ENABLE RLS & CREATE FRONTEND POLICIES ON ALL 33 APPLICATION TABLES
DO $$
DECLARE
  tbl text;
  app_tables text[] := ARRAY[
    'privacy_choices', 'settings', 'audit_events', 'files',
    'courses', 'sections', 'cards', 'assessments', 'assessment_scores', 'enrollments',
    'shared_stimuli', 'question_bank', 'question_versions', 'question_options',
    'exam_sets', 'exam_versions', 'exam_sections', 'exam_items', 'exam_assignments',
    'exam_attempts', 'attempt_items', 'attempt_responses', 'exam_operation_journal', 'result_revisions',
    'exam_integrity_events', 'exam_policy_acknowledgments', 'student_integrity_profiles', 'exam_integrity_reviews',
    'invoices', 'payments', 'payment_journal', 'unavailability_requests', 'calendar_events'
  ];
BEGIN
  FOREACH tbl IN ARRAY app_tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon, authenticated;', tbl);

    EXECUTE format('DROP POLICY IF EXISTS "Allow frontend SELECT" ON public.%I;', tbl);
    EXECUTE format('CREATE POLICY "Allow frontend SELECT" ON public.%I FOR SELECT TO anon, authenticated USING (true);', tbl);

    EXECUTE format('DROP POLICY IF EXISTS "Allow frontend INSERT" ON public.%I;', tbl);
    EXECUTE format('CREATE POLICY "Allow frontend INSERT" ON public.%I FOR INSERT TO anon, authenticated WITH CHECK (true);', tbl);

    EXECUTE format('DROP POLICY IF EXISTS "Allow frontend UPDATE" ON public.%I;', tbl);
    EXECUTE format('CREATE POLICY "Allow frontend UPDATE" ON public.%I FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);', tbl);

    EXECUTE format('DROP POLICY IF EXISTS "Allow frontend DELETE" ON public.%I;', tbl);
    EXECUTE format('CREATE POLICY "Allow frontend DELETE" ON public.%I FOR DELETE TO anon, authenticated USING (true);', tbl);
  END LOOP;
END
$$;

-- ============================================================================
-- SECURITY DEFINER CRYPTO & AUTHENTICATION POSTGRESQL FUNCTIONS (RPCs)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.pb_format_bkk_ts(p_ts timestamptz)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT CASE
    WHEN p_ts IS NULL THEN ''
    ELSE to_char(p_ts AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI:SS') || ' ICT (UTC+07:00)'
  END;
$$;

CREATE OR REPLACE FUNCTION public.pb_gen_id(p_prefix text)
RETURNS text
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  SELECT p_prefix || encode(gen_random_bytes(12), 'hex');
$$;

-- Exact RFC 6070 PBKDF2-HMAC-SHA256 implementation matching legacy Apps Script CryptoService.gs
-- Note: Legacy hashes store raw 16-byte salt as 32 hex chars in `salt_hex` (decoded via `decode(p_salt_hex, 'hex')`).
CREATE OR REPLACE FUNCTION public.pb_pbkdf2_sha256_hex(
  p_password text,
  p_salt_hex text,
  p_iterations integer DEFAULT 10000
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_pwd_bytes bytea;
  v_salt_bytes bytea;
  v_block_one bytea;
  v_u bytea;
  v_t bytea;
  v_i integer;
  v_j integer;
BEGIN
  IF p_iterations < 1 OR p_iterations > 100000 THEN
    RAISE EXCEPTION 'Invalid PBKDF2 iteration count';
  END IF;
  v_pwd_bytes := convert_to(p_password, 'UTF8');
  v_salt_bytes := decode(p_salt_hex, 'hex');
  v_block_one := v_salt_bytes || decode('00000001', 'hex');

  v_u := hmac(v_block_one, v_pwd_bytes, 'sha256');
  v_t := v_u;

  FOR v_i IN 2..p_iterations LOOP
    v_u := hmac(v_u, v_pwd_bytes, 'sha256');
    FOR v_j IN 0..31 LOOP
      v_t := set_byte(v_t, v_j, get_byte(v_t, v_j) # get_byte(v_u, v_j));
    END LOOP;
  END LOOP;

  RETURN encode(v_t, 'hex');
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_hash_password(p_password text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_salt_hex text;
  v_iter integer := 10000;
  v_hash_hex text;
BEGIN
  IF p_password IS NULL OR char_length(p_password) < 8 OR char_length(p_password) > 128 THEN
    RAISE EXCEPTION 'Password must be between 8 and 128 characters.';
  END IF;
  v_salt_hex := encode(gen_random_bytes(16), 'hex');
  v_hash_hex := public.pb_pbkdf2_sha256_hex(p_password, v_salt_hex, v_iter);
  RETURN 'pbkdf2_sha256$' || v_iter::text || '$' || v_salt_hex || '$' || v_hash_hex;
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_verify_password(p_candidate text, p_stored_hash text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_parts text[];
  v_iter integer;
  v_salt_hex text;
  v_expected text;
  v_actual text;
BEGIN
  IF p_candidate IS NULL OR p_stored_hash IS NULL THEN
    RETURN false;
  END IF;
  v_parts := string_to_array(p_stored_hash, '$');
  IF array_length(v_parts, 1) <> 4 OR v_parts[1] <> 'pbkdf2_sha256' THEN
    RETURN false;
  END IF;
  IF v_parts[2] !~ '^\d+$' OR v_parts[3] !~ '^[0-9a-fA-F]{32}$' OR v_parts[4] !~ '^[0-9a-fA-F]{64}$' THEN
    RETURN false;
  END IF;
  v_iter := v_parts[2]::integer;
  IF v_iter < 1 OR v_iter > 100000 THEN
    RETURN false;
  END IF;
  v_salt_hex := lower(v_parts[3]);
  v_expected := lower(v_parts[4]);
  v_actual := lower(public.pb_pbkdf2_sha256_hex(p_candidate, v_salt_hex, v_iter));
  RETURN v_actual = v_expected;
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_err(
  p_code text,
  p_message text,
  p_field_errors jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT jsonb_build_object(
    'ok', false,
    'error', jsonb_build_object(
      'code', coalesce(p_code, 'ERR_INTERNAL'),
      'message', coalesce(p_message, 'Unexpected error.'),
      'fieldErrors', coalesce(p_field_errors, '{}'::jsonb)
    )
  );
$$;

CREATE OR REPLACE FUNCTION public.pb_ok(p_data jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT jsonb_build_object(
    'ok', true,
    'data', coalesce(p_data, '{}'::jsonb)
  );
$$;

CREATE OR REPLACE FUNCTION public.pb_build_user_summary(
  p_user public.users,
  p_req_privacy_ver text DEFAULT '2026-10-v1'
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_latest_ack record;
  v_latest_choice record;
  v_has_current boolean := false;
  v_has_prior boolean := false;
  v_requires_ack boolean := false;
  v_eff_ver text := '';
  v_ack_ts text := '';
  v_choice_bkk text := '';
  v_gate_reason text := 'NONE';
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.privacy_choices
    WHERE user_id = p_user.user_id AND acknowledged_notice = true AND notice_version = p_req_privacy_ver
  ) INTO v_has_current;

  SELECT EXISTS (
    SELECT 1 FROM public.privacy_choices
    WHERE user_id = p_user.user_id AND acknowledged_notice = true
  ) INTO v_has_prior;

  SELECT * INTO v_latest_ack
  FROM public.privacy_choices
  WHERE user_id = p_user.user_id AND acknowledged_notice = true
  ORDER BY recorded_at_utc DESC LIMIT 1;

  SELECT * INTO v_latest_choice
  FROM public.privacy_choices
  WHERE user_id = p_user.user_id
  ORDER BY recorded_at_utc DESC LIMIT 1;

  v_requires_ack := (coalesce(trim(p_user.privacy_ack_version), '') <> p_req_privacy_ver) OR (NOT v_has_current);
  IF v_has_current THEN
    v_eff_ver := p_req_privacy_ver;
  ELSIF v_latest_ack.choice_id IS NOT NULL THEN
    v_eff_ver := coalesce(v_latest_ack.notice_version, '');
  END IF;

  IF v_latest_ack.recorded_at_utc IS NOT NULL THEN
    v_ack_ts := to_char(v_latest_ack.recorded_at_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  END IF;

  IF v_latest_choice.recorded_at_utc IS NOT NULL THEN
    v_choice_bkk := public.pb_format_bkk_ts(v_latest_choice.recorded_at_utc);
  END IF;

  IF v_requires_ack THEN
    v_gate_reason := CASE WHEN v_has_prior THEN 'NOTICE_UPDATE_GATE' ELSE 'FIRST_LOGIN_GATE' END;
  END IF;

  RETURN jsonb_build_object(
    'userId', p_user.user_id,
    'username', coalesce(NULLIF(p_user.username_display, ''), p_user.username_lower),
    'usernameLower', p_user.username_lower,
    'email', coalesce(p_user.email, ''),
    'fullName', coalesce(p_user.full_name, ''),
    'role', p_user.role,
    'status', p_user.status,
    'lastLoginAtUtc', CASE WHEN p_user.last_login_at_utc IS NOT NULL THEN to_char(p_user.last_login_at_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE '' END,
    'lastLoginAtBangkok', public.pb_format_bkk_ts(p_user.last_login_at_utc),
    'privacyAckVersion', v_eff_ver,
    'requiredPrivacyNoticeVersion', p_req_privacy_ver,
    'privacyAckRecordedAtUtc', v_ack_ts,
    'privacyAckRecordedAtBangkok', CASE WHEN v_latest_ack.recorded_at_utc IS NOT NULL THEN public.pb_format_bkk_ts(v_latest_ack.recorded_at_utc) ELSE '' END,
    'requiresPrivacyAck', v_requires_ack,
    'privacyGateReason', v_gate_reason,
    'marketingOptIn', coalesce(p_user.marketing_opt_in, false),
    'marketingUpdatedAtBangkok', v_choice_bkk,
    'isMinorFlag', coalesce(p_user.is_minor_flag, false),
    'assignedCourseIds', coalesce((
      SELECT jsonb_agg(e.course_id ORDER BY e.assigned_at_utc ASC)
      FROM public.enrollments e
      WHERE e.user_id = p_user.user_id AND e.status = 'ACTIVE'
    ), '[]'::jsonb),
    'enrolledCourseIds', coalesce((
      SELECT jsonb_agg(e.course_id ORDER BY e.assigned_at_utc ASC)
      FROM public.enrollments e
      WHERE e.user_id = p_user.user_id AND e.status = 'ACTIVE'
    ), '[]'::jsonb),
    'version', coalesce(p_user.version, 1)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_validate_session(
  p_session_token text,
  p_allowed_roles text[] DEFAULT ARRAY['STUDENT', 'ADMIN']
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_clean text;
  v_digest text;
  v_ses public.sessions%ROWTYPE;
  v_usr public.users%ROWTYPE;
  v_notice_ver text;
BEGIN
  v_clean := lower(trim(coalesce(p_session_token, '')));
  IF v_clean = '' THEN
    RETURN public.pb_err('ERR_AUTH_REQUIRED', 'Authentication is required for this action. Please sign in.');
  END IF;
  IF v_clean !~ '^[0-9a-f]{64}$' THEN
    RETURN public.pb_err('ERR_AUTH_REQUIRED', 'Invalid or malformed session credential. Please sign in again.');
  END IF;

  v_digest := encode(digest(convert_to(v_clean, 'UTF8'), 'sha256'), 'hex');
  SELECT * INTO v_ses FROM public.sessions WHERE token_sha256_hex = v_digest LIMIT 1;

  IF v_ses.session_id IS NULL THEN
    RETURN public.pb_err('ERR_AUTH_REQUIRED', 'Session is invalid or was not found. Please sign in again.');
  END IF;

  IF v_ses.status <> 'ACTIVE' THEN
    IF upper(coalesce(v_ses.revoke_reason, '')) = 'NEW_DEVICE_LOGIN' THEN
      RETURN public.pb_err(
        'ERR_AUTH_REQUIRED',
        'You have been logged out because your account was signed in on another device.',
        jsonb_build_object(
          'sessionSuperseded', true,
          'revokeReason', 'NEW_DEVICE_LOGIN',
          'revokedAtUtc', CASE WHEN v_ses.revoked_at_utc IS NOT NULL THEN to_char(v_ses.revoked_at_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE '' END
        )
      );
    END IF;
    RETURN public.pb_err('ERR_AUTH_REQUIRED', 'Your session is no longer active (' || v_ses.status || '). Please sign in again.');
  END IF;

  IF v_ses.expires_at_utc <= now() THEN
    UPDATE public.sessions SET status = 'EXPIRED', revoked_at_utc = now(), revoke_reason = 'EXPIRED' WHERE session_id = v_ses.session_id;
    RETURN public.pb_err('ERR_AUTH_REQUIRED', 'Your session has expired. Please sign in again.');
  END IF;

  SELECT * INTO v_usr FROM public.users WHERE user_id = v_ses.user_id LIMIT 1;
  IF v_usr.user_id IS NULL THEN
    RETURN public.pb_err('ERR_AUTH_REQUIRED', 'The user account associated with this session no longer exists.');
  END IF;

  IF v_usr.status <> 'ACTIVE' THEN
    UPDATE public.sessions SET status = 'REVOKED', revoked_at_utc = now(), revoke_reason = 'ACCOUNT_' || v_usr.status
    WHERE user_id = v_usr.user_id AND status = 'ACTIVE';
    RETURN public.pb_err('ERR_ACCOUNT_SUSPENDED', 'Account is currently ' || lower(v_usr.status) || '. Please contact the school administrator.');
  END IF;

  IF p_allowed_roles IS NOT NULL AND NOT (v_usr.role = ANY(p_allowed_roles)) THEN
    RETURN public.pb_err('ERR_FORBIDDEN_ROLE', 'Access denied: insufficient privileges.');
  END IF;

  UPDATE public.sessions SET last_seen_at_utc = now() WHERE session_id = v_ses.session_id;

  SELECT coalesce(NULLIF(trim(setting_value), ''), '2026-10-v1') INTO v_notice_ver
  FROM public.settings WHERE setting_key = 'CURRENT_PRIVACY_NOTICE_VERSION';
  IF v_notice_ver IS NULL THEN v_notice_ver := '2026-10-v1'; END IF;

  RETURN public.pb_ok(jsonb_build_object(
    'sessionId', v_ses.session_id,
    'userId', v_usr.user_id,
    'role', v_usr.role,
    'expiresAtUtc', to_char(v_ses.expires_at_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAtBangkok', public.pb_format_bkk_ts(v_ses.expires_at_utc),
    'rememberMe', v_ses.remember_me,
    'privacyNoticeVersion', v_notice_ver,
    'user', public.pb_build_user_summary(v_usr, v_notice_ver)
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_bootstrap_first_admin(
  p_username text,
  p_password text,
  p_email text DEFAULT '',
  p_full_name text DEFAULT 'Pattanabhumi Administrator'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_count bigint;
  v_uname_lower text;
  v_uid text;
  v_hash text;
  v_user public.users%ROWTYPE;
BEGIN
  SELECT count(*) INTO v_count FROM public.users;
  IF v_count > 0 THEN
    RETURN public.pb_err('ERR_BOOTSTRAP_ALREADY_COMPLETED', 'Users already exist. Initial admin bootstrap is disabled.');
  END IF;
  v_uname_lower := lower(trim(coalesce(p_username, '')));
  IF v_uname_lower !~ '^[a-z0-9._-]{3,40}$' THEN
    RETURN public.pb_err('ERR_VALIDATION_FAILED', 'Username must be 3-40 lowercase letters, digits, ., _, or -.');
  END IF;
  v_hash := public.pb_hash_password(p_password);
  v_uid := public.pb_gen_id('usr_');

  INSERT INTO public.users (
    user_id, username_lower, username_display, email, full_name,
    role, status, password_hash, password_updated_at_utc,
    privacy_ack_version, marketing_opt_in, is_minor_flag, created_at_utc, updated_at_utc, version
  ) VALUES (
    v_uid, v_uname_lower, trim(p_username), trim(coalesce(p_email, '')), trim(coalesce(NULLIF(p_full_name, ''), 'Administrator')),
    'ADMIN', 'ACTIVE', v_hash, now(),
    '', false, false, now(), now(), 1
  ) RETURNING * INTO v_user;

  RETURN public.pb_ok(jsonb_build_object('user', public.pb_build_user_summary(v_user, '2026-10-v1')));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_auth_login(
  p_username text,
  p_password text,
  p_remember_me boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uname text;
  v_user public.users%ROWTYPE;
  v_exists boolean := false;
  v_subject_key text;
  v_global_key text := 'login:global_bucket';
  v_unknown_key text := 'login:unknown_account_bucket';
  v_rl record;
  v_retry integer;
  v_max_fail integer;
  v_pwd_ok boolean;
  v_raw_token text;
  v_token_sha text;
  v_ses_id text;
  v_exp timestamptz;
  v_notice_ver text;
BEGIN
  v_uname := lower(trim(coalesce(p_username, '')));
  IF v_uname = '' OR coalesce(p_password, '') = '' THEN
    RETURN public.pb_err('ERR_VALIDATION_FAILED', 'Username and password are required.');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users) THEN
    RETURN public.pb_err('ERR_CONFIG_MISSING', 'No user accounts exist in Supabase yet. Import Users CSV or run pb_bootstrap_first_admin in SQL Editor.');
  END IF;

  SELECT * INTO v_user FROM public.users WHERE username_lower = v_uname LIMIT 1;
  v_exists := (v_user.user_id IS NOT NULL);
  v_subject_key := CASE WHEN v_exists THEN 'login:user:' || v_uname ELSE v_unknown_key END;

  -- Check global rate limit
  SELECT * INTO v_rl FROM public.login_attempts WHERE subject_key = v_global_key;
  IF v_rl.locked_until_utc IS NOT NULL AND v_rl.locked_until_utc > now() THEN
    v_retry := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_rl.locked_until_utc - now())))::integer);
    RETURN public.pb_err('ERR_RATE_LIMITED', 'Too many failed login attempts across the portal. Please wait ' || v_retry || ' seconds.', jsonb_build_object('retryAfterSeconds', v_retry::text));
  END IF;

  -- Check account / unknown bucket rate limit
  SELECT * INTO v_rl FROM public.login_attempts WHERE subject_key = v_subject_key;
  IF v_rl.locked_until_utc IS NOT NULL AND v_rl.locked_until_utc > now() THEN
    v_retry := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_rl.locked_until_utc - now())))::integer);
    RETURN public.pb_err(
      'ERR_RATE_LIMITED',
      'Account locked after too many incorrect password attempts. Contact support or wait ' || v_retry || ' seconds.',
      jsonb_build_object('retryAfterSeconds', v_retry::text, 'accountLocked', 'true')
    );
  END IF;

  -- Verify credentials
  v_pwd_ok := CASE WHEN v_exists THEN public.pb_verify_password(p_password, v_user.password_hash) ELSE false END;

  IF (NOT v_exists) OR (NOT v_pwd_ok) THEN
    v_max_fail := CASE WHEN v_exists THEN 5 ELSE 20 END;
    INSERT INTO public.login_attempts (subject_key, window_start_utc, failure_count, locked_until_utc, last_attempt_at_utc, updated_at_utc)
    VALUES (v_subject_key, now(), 1, CASE WHEN 1 >= v_max_fail THEN now() + interval '15 minutes' ELSE NULL END, now(), now())
    ON CONFLICT (subject_key) DO UPDATE SET
      failure_count = CASE WHEN public.login_attempts.window_start_utc < now() - interval '15 minutes' THEN 1 ELSE public.login_attempts.failure_count + 1 END,
      window_start_utc = CASE WHEN public.login_attempts.window_start_utc < now() - interval '15 minutes' THEN now() ELSE public.login_attempts.window_start_utc END,
      locked_until_utc = CASE
        WHEN (CASE WHEN public.login_attempts.window_start_utc < now() - interval '15 minutes' THEN 1 ELSE public.login_attempts.failure_count + 1 END) >= v_max_fail
        THEN now() + interval '15 minutes'
        WHEN public.login_attempts.window_start_utc < now() - interval '15 minutes' THEN NULL
        ELSE public.login_attempts.locked_until_utc
      END,
      last_attempt_at_utc = now(),
      updated_at_utc = now();

    INSERT INTO public.login_attempts (subject_key, window_start_utc, failure_count, locked_until_utc, last_attempt_at_utc, updated_at_utc)
    VALUES (v_global_key, now(), 1, NULL, now(), now())
    ON CONFLICT (subject_key) DO UPDATE SET
      failure_count = CASE WHEN public.login_attempts.window_start_utc < now() - interval '15 minutes' THEN 1 ELSE public.login_attempts.failure_count + 1 END,
      window_start_utc = CASE WHEN public.login_attempts.window_start_utc < now() - interval '15 minutes' THEN now() ELSE public.login_attempts.window_start_utc END,
      locked_until_utc = CASE
        WHEN (CASE WHEN public.login_attempts.window_start_utc < now() - interval '15 minutes' THEN 1 ELSE public.login_attempts.failure_count + 1 END) >= 50
        THEN now() + interval '15 minutes' ELSE NULL END,
      last_attempt_at_utc = now(),
      updated_at_utc = now();

    INSERT INTO public.audit_events (audit_id, actor_user_id, actor_role, event_type, target_entity_type, target_entity_id, summary_json)
    VALUES (public.pb_gen_id('aud_'), coalesce(v_user.user_id, 'ANONYMOUS'), coalesce(v_user.role, 'ANONYMOUS'),
            CASE WHEN v_exists THEN 'AUTH_LOGIN_FAILED_BAD_PASSWORD' ELSE 'AUTH_LOGIN_FAILED_UNKNOWN_USER' END,
            'User', coalesce(v_user.user_id, 'unknown_user'), jsonb_build_object('usernameLower', v_uname));

    RETURN public.pb_err('ERR_INVALID_CREDENTIALS', 'Invalid username or password.');
  END IF;

  IF v_user.status <> 'ACTIVE' THEN
    RETURN public.pb_err('ERR_ACCOUNT_SUSPENDED', 'This account is currently ' || lower(v_user.status) || '. Please contact the school administrator.');
  END IF;

  -- Reset user login failures on valid password
  UPDATE public.login_attempts SET failure_count = 0, locked_until_utc = NULL, updated_at_utc = now() WHERE subject_key = v_subject_key;

  -- Create single-device session (revoke all prior ACTIVE sessions for user)
  v_raw_token := encode(gen_random_bytes(32), 'hex');
  v_token_sha := encode(digest(convert_to(v_raw_token, 'UTF8'), 'sha256'), 'hex');
  v_ses_id := public.pb_gen_id('ses_');
  v_exp := now() + CASE WHEN coalesce(p_remember_me, false) THEN interval '7 days' ELSE interval '8 hours' END;

  UPDATE public.sessions
  SET status = 'REVOKED', revoked_at_utc = now(), revoke_reason = 'NEW_DEVICE_LOGIN'
  WHERE user_id = v_user.user_id AND status = 'ACTIVE';

  INSERT INTO public.sessions (session_id, token_sha256_hex, user_id, remember_me, status, created_at_utc, expires_at_utc, last_seen_at_utc)
  VALUES (v_ses_id, v_token_sha, v_user.user_id, coalesce(p_remember_me, false), 'ACTIVE', now(), v_exp, now());

  UPDATE public.users SET last_login_at_utc = now(), updated_at_utc = now(), version = version + 1 WHERE user_id = v_user.user_id RETURNING * INTO v_user;

  SELECT coalesce(NULLIF(trim(setting_value), ''), '2026-10-v1') INTO v_notice_ver
  FROM public.settings WHERE setting_key = 'CURRENT_PRIVACY_NOTICE_VERSION';
  IF v_notice_ver IS NULL THEN v_notice_ver := '2026-10-v1'; END IF;

  INSERT INTO public.audit_events (audit_id, actor_user_id, actor_role, event_type, target_entity_type, target_entity_id, summary_json)
  VALUES (public.pb_gen_id('aud_'), v_user.user_id, v_user.role, 'AUTH_LOGIN_SUCCESS', 'Session', v_ses_id, jsonb_build_object('rememberMe', coalesce(p_remember_me, false)));

  RETURN public.pb_ok(jsonb_build_object(
    'sessionToken', v_raw_token,
    'sessionId', v_ses_id,
    'expiresAtUtc', to_char(v_exp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAtBangkok', public.pb_format_bkk_ts(v_exp),
    'rememberMe', coalesce(p_remember_me, false),
    'privacyNoticeVersion', v_notice_ver,
    'user', public.pb_build_user_summary(v_user, v_notice_ver)
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_auth_logout(p_session_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_clean text := lower(trim(coalesce(p_session_token, '')));
  v_digest text;
  v_ses public.sessions%ROWTYPE;
BEGIN
  IF v_clean ~ '^[0-9a-f]{64}$' THEN
    v_digest := encode(digest(convert_to(v_clean, 'UTF8'), 'sha256'), 'hex');
    UPDATE public.sessions
    SET status = 'REVOKED', revoked_at_utc = now(), revoke_reason = 'USER_LOGOUT'
    WHERE token_sha256_hex = v_digest AND status = 'ACTIVE'
    RETURNING * INTO v_ses;
  END IF;
  RETURN public.pb_ok(jsonb_build_object('loggedOut', true));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_auth_get_session_status(p_session_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN public.pb_validate_session(p_session_token, ARRAY['STUDENT', 'ADMIN']);
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_get_integrity_lock_status(p_username text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_uname text := lower(trim(coalesce(p_username, '')));
  v_user public.users%ROWTYPE;
  v_sip public.student_integrity_profiles%ROWTYPE;
BEGIN
  IF v_uname = '' THEN
    RETURN public.pb_ok(jsonb_build_object('isLocked', false));
  END IF;
  SELECT * INTO v_user FROM public.users WHERE username_lower = v_uname LIMIT 1;
  IF v_user.user_id IS NULL THEN
    RETURN public.pb_ok(jsonb_build_object('isLocked', false));
  END IF;
  SELECT * INTO v_sip FROM public.student_integrity_profiles WHERE student_user_id = v_user.user_id LIMIT 1;
  IF v_user.status = 'INTEGRITY_LOCKED' OR (v_sip.profile_id IS NOT NULL AND v_sip.integrity_status = 'INTEGRITY_LOCKED') THEN
    RETURN public.pb_ok(jsonb_build_object(
      'isLocked', true,
      'status', 'INTEGRITY_LOCKED',
      'reasonCode', coalesce(v_sip.lock_reason_code, 'REPEATED_COPY_POLICY_VIOLATION'),
      'message', 'Account is temporarily locked due to repeated exam copy-policy violations. Contact an administrator.'
    ));
  END IF;
  RETURN public.pb_ok(jsonb_build_object('isLocked', false));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_privacy_acknowledge(
  p_session_token text,
  p_notice_version text,
  p_acknowledged boolean,
  p_marketing_opt_in boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_uid text;
  v_cur_ver text;
  v_user public.users%ROWTYPE;
  v_has_prior boolean;
  v_source text;
  v_choice_id text;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['STUDENT', 'ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_uid := v_auth->'data'->>'userId';

  IF p_acknowledged IS DISTINCT FROM true THEN
    RETURN public.pb_err('ERR_VALIDATION_FAILED', 'You must acknowledge the Privacy Notice to continue.');
  END IF;

  SELECT coalesce(NULLIF(trim(setting_value), ''), '2026-10-v1') INTO v_cur_ver FROM public.settings WHERE setting_key = 'CURRENT_PRIVACY_NOTICE_VERSION';
  IF trim(coalesce(p_notice_version, '')) <> v_cur_ver THEN
    RETURN public.pb_err('ERR_CONFLICT_VERSION', 'Privacy Notice version changed to "' || v_cur_ver || '".');
  END IF;

  SELECT EXISTS(SELECT 1 FROM public.privacy_choices WHERE user_id = v_uid AND acknowledged_notice = true) INTO v_has_prior;
  v_source := CASE WHEN v_has_prior THEN 'NOTICE_UPDATE_GATE' ELSE 'FIRST_LOGIN_GATE' END;
  v_choice_id := public.pb_gen_id('prv_');

  INSERT INTO public.privacy_choices (choice_id, user_id, notice_version, acknowledged_notice, marketing_opt_in, action_source, recorded_at_utc)
  VALUES (v_choice_id, v_uid, v_cur_ver, true, coalesce(p_marketing_opt_in, false), v_source, now());

  UPDATE public.users
  SET privacy_ack_version = v_cur_ver, marketing_opt_in = coalesce(p_marketing_opt_in, false), updated_at_utc = now(), version = version + 1
  WHERE user_id = v_uid
  RETURNING * INTO v_user;

  RETURN public.pb_ok(jsonb_build_object(
    'choiceId', v_choice_id,
    'noticeVersion', v_cur_ver,
    'acknowledgedNotice', true,
    'marketingOptIn', v_user.marketing_opt_in,
    'actionSource', v_source,
    'user', public.pb_build_user_summary(v_user, v_cur_ver)
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_privacy_update_marketing(
  p_session_token text,
  p_marketing_opt_in boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_uid text;
  v_cur_ver text;
  v_user public.users%ROWTYPE;
  v_choice_id text;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['STUDENT', 'ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_uid := v_auth->'data'->>'userId';

  SELECT coalesce(NULLIF(trim(setting_value), ''), '2026-10-v1') INTO v_cur_ver FROM public.settings WHERE setting_key = 'CURRENT_PRIVACY_NOTICE_VERSION';
  v_choice_id := public.pb_gen_id('prv_');

  INSERT INTO public.privacy_choices (choice_id, user_id, notice_version, acknowledged_notice, marketing_opt_in, action_source, recorded_at_utc)
  VALUES (v_choice_id, v_uid, v_cur_ver, true, coalesce(p_marketing_opt_in, false), 'PROFILE_PREFERENCE_UPDATE', now());

  UPDATE public.users
  SET marketing_opt_in = coalesce(p_marketing_opt_in, false), updated_at_utc = now(), version = version + 1
  WHERE user_id = v_uid
  RETURNING * INTO v_user;

  RETURN public.pb_ok(jsonb_build_object(
    'choiceId', v_choice_id,
    'marketingOptIn', v_user.marketing_opt_in,
    'user', public.pb_build_user_summary(v_user, v_cur_ver)
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_public_get_bootstrap(p_session_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_settings jsonb := '{}'::jsonb;
  v_has_users boolean := false;
  v_ses_res jsonb := NULL;
  v_active_session jsonb := NULL;
  v_restore_status text := 'NO_TOKEN';
BEGIN
  SELECT coalesce(jsonb_object_agg(setting_key, coalesce(setting_value, '')), '{}'::jsonb)
  INTO v_settings
  FROM public.settings
  WHERE setting_key IN (
    'SCHOOL_NAME', 'LOGO_FILE_ID', 'CONTACT_LINE_URL', 'CONTACT_FACEBOOK_URL',
    'CONTACT_EMAIL', 'CURRENT_PRIVACY_NOTICE_VERSION', 'PRIVACY_NOTICE_DOCUMENT_TEXT',
    'DEK_DISPLAY_MODE', 'DEK_MANUAL_BASE_NUMBER',
    'PUBLIC_CONTENT_PUBLISHED_JSON', 'PUBLIC_CONTENT_DRAFT_JSON',
    'INSTRUCTOR_PORTRAIT_FILE_ID', 'INSTRUCTOR_PROFILE_LAST_VERIFIED_AT',
    'HERO_CARD_1_FILE_ID', 'HERO_CARD_2_FILE_ID', 'HERO_CARD_3_FILE_ID'
  );

  SELECT EXISTS(SELECT 1 FROM public.users) INTO v_has_users;

  IF p_session_token IS NOT NULL AND trim(p_session_token) <> '' THEN
    v_ses_res := public.pb_validate_session(p_session_token, ARRAY['STUDENT', 'ADMIN']);
    IF coalesce((v_ses_res->>'ok')::boolean, false) = true THEN
      v_restore_status := 'ACTIVE';
      v_active_session := v_ses_res->'data';
    ELSE
      v_restore_status := coalesce(v_ses_res->'error'->'fieldErrors'->>'revokeReason', v_ses_res->'error'->>'code', 'INVALID');
    END IF;
  END IF;

  RETURN public.pb_ok(jsonb_build_object(
    'settings', v_settings,
    'hasAnyUserAccount', v_has_users,
    'sessionRestoreStatus', v_restore_status,
    'activeSession', v_active_session
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_admin_get_dashboard_summary(p_session_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_users_total bigint;
  v_students_total bigint;
  v_active_sessions bigint;
  v_privacy_choices bigint;
  v_courses bigint;
  v_pending_payments bigint;
  v_open_unavail bigint;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;

  SELECT count(*) INTO v_users_total FROM public.users WHERE status <> 'ARCHIVED';
  SELECT count(*) INTO v_students_total FROM public.users WHERE role = 'STUDENT' AND status <> 'ARCHIVED';
  SELECT count(*) INTO v_active_sessions FROM public.sessions WHERE status = 'ACTIVE' AND expires_at_utc > now();
  SELECT count(*) INTO v_privacy_choices FROM public.privacy_choices;
  SELECT count(*) INTO v_courses FROM public.courses WHERE status <> 'ARCHIVED';
  SELECT count(*) INTO v_pending_payments FROM public.payments WHERE status IN ('AWAITING_VERIFICATION', 'APPROVING');
  SELECT count(*) INTO v_open_unavail FROM public.unavailability_requests;

  RETURN public.pb_ok(jsonb_build_object(
    'counts', jsonb_build_object(
      'usersTotal', v_users_total,
      'studentsTotal', v_students_total,
      'activeSessions', v_active_sessions,
      'privacyChoicesTotal', v_privacy_choices,
      'coursesTotal', v_courses,
      'pendingPaymentsTotal', v_pending_payments,
      'unavailabilityTotal', v_open_unavail
    ),
    'currentUser', v_auth->'data'->'user'
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_admin_list_users(
  p_session_token text,
  p_search text DEFAULT '',
  p_role text DEFAULT 'ALL',
  p_status text DEFAULT 'ALL',
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_kw text := lower(trim(coalesce(p_search, '')));
  v_items jsonb := '[]'::jsonb;
  v_notice_ver text;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;

  SELECT coalesce(NULLIF(trim(setting_value), ''), '2026-10-v1') INTO v_notice_ver
  FROM public.settings WHERE setting_key = 'CURRENT_PRIVACY_NOTICE_VERSION';
  IF v_notice_ver IS NULL THEN v_notice_ver := '2026-10-v1'; END IF;

  SELECT coalesce(jsonb_agg(item_obj), '[]'::jsonb) INTO v_items
  FROM (
    SELECT (
      public.pb_build_user_summary(u, v_notice_ver) ||
      jsonb_build_object(
        'enrolledCourseIds', coalesce((
          SELECT jsonb_agg(e.course_id) FROM public.enrollments e
          WHERE e.user_id = u.user_id AND e.status = 'ACTIVE'
        ), '[]'::jsonb),
        'invoiceCount', (SELECT count(*) FROM public.invoices i WHERE i.user_id = u.user_id),
        'paymentCount', (SELECT count(*) FROM public.payments p WHERE p.user_id = u.user_id)
      )
    ) AS item_obj
    FROM public.users u
    WHERE (coalesce(p_role, 'ALL') IN ('ALL', '') OR u.role = upper(p_role))
      AND (coalesce(p_status, 'ALL') IN ('ALL', '') OR u.status = upper(p_status))
      AND (
        v_kw = '' OR
        u.username_lower LIKE '%' || v_kw || '%' OR
        lower(u.full_name) LIKE '%' || v_kw || '%' OR
        lower(u.email) LIKE '%' || v_kw || '%'
      )
    ORDER BY CASE WHEN u.role = 'ADMIN' THEN 0 ELSE 1 END, u.created_at_utc DESC
    LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 500)
  ) t;

  RETURN public.pb_ok(jsonb_build_object('users', v_items));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_admin_save_user(
  p_session_token text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_actor_id text;
  v_user_id text;
  v_uname text;
  v_uname_lower text;
  v_email text;
  v_full_name text;
  v_role text;
  v_status text;
  v_minor boolean;
  v_pwd text;
  v_exp_ver integer;
  v_existing public.users%ROWTYPE;
  v_updated public.users%ROWTYPE;
  v_admin_cnt integer;
  v_notice_ver text;
  v_otp_code text;
  v_otp_hash text;
  v_otp_row public.admin_email_otps%ROWTYPE;
  v_desired_courses text[];
  v_cid text;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_actor_id := v_auth->'data'->>'userId';

  v_user_id := trim(coalesce(p_payload->>'userId', ''));
  v_uname := trim(coalesce(p_payload->>'username', p_payload->>'usernameDisplay', ''));
  v_uname_lower := lower(v_uname);
  v_email := trim(coalesce(p_payload->>'email', ''));
  v_full_name := trim(coalesce(p_payload->>'fullName', ''));
  v_role := upper(trim(coalesce(p_payload->>'role', 'STUDENT')));
  v_status := upper(trim(coalesce(p_payload->>'status', 'ACTIVE')));
  v_minor := coalesce((p_payload->>'isMinorFlag')::boolean, false);
  v_pwd := coalesce(p_payload->>'password', p_payload->>'initialPassword', '');

  IF v_role NOT IN ('STUDENT', 'ADMIN') THEN v_role := 'STUDENT'; END IF;
  IF v_status NOT IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED', 'INTEGRITY_LOCKED') THEN v_status := 'ACTIVE'; END IF;

  SELECT coalesce(NULLIF(trim(setting_value), ''), '2026-10-v1') INTO v_notice_ver
  FROM public.settings WHERE setting_key = 'CURRENT_PRIVACY_NOTICE_VERSION';
  IF v_notice_ver IS NULL THEN v_notice_ver := '2026-10-v1'; END IF;

  IF v_user_id = '' THEN
    IF v_uname_lower !~ '^[a-z0-9._-]{3,40}$' THEN
      RETURN public.pb_err('ERR_VALIDATION_FAILED', 'Username must be 3-40 letters, digits, ., _, or -.', jsonb_build_object('username', 'Invalid username format.'));
    END IF;
    IF v_full_name = '' THEN
      RETURN public.pb_err('ERR_VALIDATION_FAILED', 'Full name is required.', jsonb_build_object('fullName', 'Full name is required.'));
    END IF;
    IF char_length(v_pwd) < 8 THEN
      RETURN public.pb_err('ERR_VALIDATION_FAILED', 'Initial password must be at least 8 characters.', jsonb_build_object('password', 'Minimum 8 characters.'));
    END IF;
    IF EXISTS (SELECT 1 FROM public.users WHERE username_lower = v_uname_lower) THEN
      RETURN public.pb_err('ERR_VALIDATION_FAILED', 'Username "' || v_uname || '" already exists.', jsonb_build_object('username', 'Username already exists.'));
    END IF;

    v_user_id := public.pb_gen_id('usr_');
    INSERT INTO public.users (
      user_id, username_lower, username_display, email, full_name, role, status,
      password_hash, password_updated_at_utc, marketing_opt_in, is_minor_flag, created_at_utc, updated_at_utc, version
    ) VALUES (
      v_user_id, v_uname_lower, v_uname, v_email, v_full_name, v_role, v_status,
      public.pb_hash_password(v_pwd), now(), false, v_minor, now(), now(), 1
    ) RETURNING * INTO v_updated;

    INSERT INTO public.audit_events (audit_id, actor_user_id, actor_role, event_type, target_entity_type, target_entity_id, summary_json)
    VALUES (public.pb_gen_id('aud_'), v_actor_id, 'ADMIN', 'ADMIN_USER_CREATED', 'User', v_user_id, jsonb_build_object('usernameLower', v_uname_lower, 'role', v_role));
  ELSE
    SELECT * INTO v_existing FROM public.users WHERE user_id = v_user_id;
    IF v_existing.user_id IS NULL THEN
      RETURN public.pb_err('ERR_NOT_FOUND', 'User not found.');
    END IF;
    IF p_payload ? 'expectedVersion' AND (p_payload->>'expectedVersion') ~ '^\d+$' THEN
      v_exp_ver := (p_payload->>'expectedVersion')::integer;
      IF v_exp_ver <> v_existing.version THEN
        RETURN public.pb_err('ERR_CONFLICT_VERSION', 'User record was modified by another administrator. Reload and retry.');
      END IF;
    END IF;

    IF v_existing.role = 'ADMIN' AND v_existing.status = 'ACTIVE' AND (v_role <> 'ADMIN' OR v_status <> 'ACTIVE') THEN
      SELECT count(*) INTO v_admin_cnt FROM public.users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND user_id <> v_user_id;
      IF v_admin_cnt < 1 THEN
        RETURN public.pb_err('ERR_FORBIDDEN_OPERATION', 'Cannot remove or deactivate the last active administrator account.');
      END IF;
    END IF;

    IF (v_existing.role = 'ADMIN' OR v_role = 'ADMIN')
       AND p_payload ? 'email'
       AND lower(v_email) <> lower(coalesce(v_existing.email, '')) THEN
      IF v_email = '' OR v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' THEN
        RETURN public.pb_err('ERR_VALIDATION_FAILED', 'A valid email address is required for an administrator account.', jsonb_build_object('email', 'Valid email address required.'));
      END IF;

      v_otp_code := trim(coalesce(p_payload->>'emailChangeOtpCode', ''));
      IF v_otp_code = '' THEN
        RETURN public.pb_err(
          'ERR_OTP_REQUIRED',
          'Email change for administrator accounts requires a 6-digit OTP verification code sent to ' || v_email || '.',
          jsonb_build_object('emailChangeOtpCode', 'Enter the 6-digit OTP sent to the new email address.')
        );
      END IF;

      SELECT * INTO v_otp_row
      FROM public.admin_email_otps
      WHERE actor_user_id = v_actor_id
        AND lower(target_email) = lower(v_email)
        AND consumed_at_utc IS NULL
        AND expires_at_utc > now()
      ORDER BY created_at_utc DESC
      LIMIT 1;

      IF v_otp_row.otp_id IS NULL THEN
        RETURN public.pb_err(
          'ERR_INVALID_OTP',
          'Verification code has expired or was not requested for ' || v_email || '. Click "Send Verification OTP" first.',
          jsonb_build_object('emailChangeOtpCode', 'Request a new verification OTP.')
        );
      END IF;

      IF coalesce(v_otp_row.attempt_count, 0) >= 5 THEN
        RETURN public.pb_err(
          'ERR_OTP_LOCKED',
          'Too many failed OTP attempts. Please request a new verification OTP.',
          jsonb_build_object('emailChangeOtpCode', 'Request a new OTP code.')
        );
      END IF;

      v_otp_hash := encode(extensions.digest(convert_to(v_otp_code, 'UTF8'), 'sha256'), 'hex');
      IF lower(v_otp_hash) <> lower(v_otp_row.otp_sha256_hex) THEN
        UPDATE public.admin_email_otps
        SET attempt_count = attempt_count + 1
        WHERE otp_id = v_otp_row.otp_id;
        RETURN public.pb_err(
          'ERR_INVALID_OTP',
          'The 6-digit verification code does not match. Check your inbox and try again.',
          jsonb_build_object('emailChangeOtpCode', 'Invalid 6-digit OTP code.')
        );
      END IF;

      UPDATE public.admin_email_otps
      SET consumed_at_utc = now()
      WHERE otp_id = v_otp_row.otp_id;
    END IF;

    UPDATE public.users SET
      email = CASE WHEN p_payload ? 'email' THEN v_email ELSE email END,
      full_name = CASE WHEN v_full_name <> '' THEN v_full_name ELSE full_name END,
      role = CASE WHEN p_payload ? 'role' THEN v_role ELSE role END,
      status = CASE WHEN p_payload ? 'status' THEN v_status ELSE status END,
      is_minor_flag = CASE WHEN p_payload ? 'isMinorFlag' THEN v_minor ELSE is_minor_flag END,
      updated_at_utc = now(),
      version = version + 1
    WHERE user_id = v_user_id
    RETURNING * INTO v_updated;

    IF v_updated.role <> v_existing.role OR v_updated.status <> v_existing.status THEN
      UPDATE public.sessions SET status = 'REVOKED', revoked_at_utc = now(), revoke_reason = 'USER_SECURITY_UPDATE'
      WHERE user_id = v_user_id AND status = 'ACTIVE';
    END IF;
  END IF;

  IF p_payload ? 'assignedCourseIds' THEN
    SELECT coalesce(array_agg(DISTINCT val), ARRAY[]::text[])
    INTO v_desired_courses
    FROM jsonb_array_elements_text(coalesce(p_payload->'assignedCourseIds', '[]'::jsonb)) AS t(val)
    WHERE trim(coalesce(val, '')) <> '';

    UPDATE public.enrollments
    SET status = 'REVOKED', updated_at_utc = now(), version = version + 1
    WHERE user_id = v_updated.user_id AND status = 'ACTIVE' AND NOT (course_id = ANY(v_desired_courses));

    FOREACH v_cid IN ARRAY v_desired_courses LOOP
      IF EXISTS (SELECT 1 FROM public.courses WHERE course_id = v_cid) THEN
        IF EXISTS (SELECT 1 FROM public.enrollments WHERE user_id = v_updated.user_id AND course_id = v_cid) THEN
          UPDATE public.enrollments
          SET status = 'ACTIVE', assigned_by_user_id = v_actor_id, assigned_at_utc = now(), updated_at_utc = now(), version = version + 1
          WHERE user_id = v_updated.user_id AND course_id = v_cid;
        ELSE
          INSERT INTO public.enrollments (enrollment_id, user_id, course_id, status, assigned_by_user_id, assigned_at_utc, updated_at_utc, version)
          VALUES (public.pb_gen_id('enr_'), v_updated.user_id, v_cid, 'ACTIVE', v_actor_id, now(), now(), 1);
        END IF;
      END IF;
    END LOOP;
  END IF;

  RETURN public.pb_ok(jsonb_build_object('user', public.pb_build_user_summary(v_updated, v_notice_ver)));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_admin_reset_password(
  p_session_token text,
  p_user_id text,
  p_new_password text,
  p_expected_version integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_existing public.users%ROWTYPE;
  v_updated public.users%ROWTYPE;
  v_notice_ver text;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;

  IF char_length(coalesce(p_new_password, '')) < 8 THEN
    RETURN public.pb_err('ERR_VALIDATION_FAILED', 'New password must be at least 8 characters.');
  END IF;

  SELECT * INTO v_existing FROM public.users WHERE user_id = trim(coalesce(p_user_id, ''));
  IF v_existing.user_id IS NULL THEN
    RETURN public.pb_err('ERR_NOT_FOUND', 'User not found.');
  END IF;
  IF p_expected_version IS NOT NULL AND p_expected_version <> v_existing.version THEN
    RETURN public.pb_err('ERR_CONFLICT_VERSION', 'User record was modified by another administrator.');
  END IF;

  UPDATE public.users SET
    password_hash = public.pb_hash_password(p_new_password),
    password_updated_at_utc = now(),
    updated_at_utc = now(),
    version = version + 1
  WHERE user_id = v_existing.user_id
  RETURNING * INTO v_updated;

  UPDATE public.sessions SET status = 'REVOKED', revoked_at_utc = now(), revoke_reason = 'PASSWORD_CHANGE'
  WHERE user_id = v_existing.user_id AND status = 'ACTIVE';

  SELECT coalesce(NULLIF(trim(setting_value), ''), '2026-10-v1') INTO v_notice_ver
  FROM public.settings WHERE setting_key = 'CURRENT_PRIVACY_NOTICE_VERSION';

  RETURN public.pb_ok(jsonb_build_object('user', public.pb_build_user_summary(v_updated, coalesce(v_notice_ver, '2026-10-v1'))));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_admin_set_user_enrollments(
  p_session_token text,
  p_user_id text,
  p_course_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_actor_id text;
  v_cid text;
  v_desired text[];
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_actor_id := v_auth->'data'->>'userId';

  IF NOT EXISTS (SELECT 1 FROM public.users WHERE user_id = p_user_id) THEN
    RETURN public.pb_err('ERR_NOT_FOUND', 'User not found.');
  END IF;

  v_desired := coalesce(p_course_ids, ARRAY[]::text[]);

  -- Revoke active enrollments not in desired list
  UPDATE public.enrollments
  SET status = 'REVOKED', updated_at_utc = now(), version = version + 1
  WHERE user_id = p_user_id AND status = 'ACTIVE' AND NOT (course_id = ANY(v_desired));

  -- Upsert / reactivate desired enrollments
  FOREACH v_cid IN ARRAY v_desired LOOP
    IF EXISTS (SELECT 1 FROM public.courses WHERE course_id = v_cid) THEN
      IF EXISTS (SELECT 1 FROM public.enrollments WHERE user_id = p_user_id AND course_id = v_cid) THEN
        UPDATE public.enrollments
        SET status = 'ACTIVE', assigned_by_user_id = v_actor_id, assigned_at_utc = now(), updated_at_utc = now(), version = version + 1
        WHERE user_id = p_user_id AND course_id = v_cid;
      ELSE
        INSERT INTO public.enrollments (enrollment_id, user_id, course_id, status, assigned_by_user_id, assigned_at_utc, updated_at_utc, version)
        VALUES (public.pb_gen_id('enr_'), p_user_id, v_cid, 'ACTIVE', v_actor_id, now(), now(), 1);
      END IF;
    END IF;
  END LOOP;

  RETURN public.pb_ok(jsonb_build_object('userId', p_user_id, 'courseIds', to_jsonb(v_desired)));
END;
$$;

DROP FUNCTION IF EXISTS public.pb_admin_delete_user(text, text, boolean, integer);

CREATE OR REPLACE FUNCTION public.pb_admin_verify_actor_password(
  p_session_token text,
  p_admin_password text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_actor_id text;
  v_actor_row public.users%ROWTYPE;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_actor_id := v_auth->'data'->>'userId';

  SELECT * INTO v_actor_row FROM public.users WHERE user_id = v_actor_id;
  IF v_actor_row.user_id IS NULL OR NOT public.pb_verify_password(coalesce(p_admin_password, ''), v_actor_row.password_hash) THEN
    RETURN public.pb_err('ERR_INVALID_CREDENTIALS', 'Administrator password verification failed.', jsonb_build_object('adminPassword', 'Incorrect administrator password.'));
  END IF;

  RETURN public.pb_ok(jsonb_build_object(
    'userId', v_actor_row.user_id,
    'username', coalesce(NULLIF(v_actor_row.username_display, ''), v_actor_row.username_lower),
    'email', coalesce(v_actor_row.email, ''),
    'fullName', coalesce(v_actor_row.full_name, '')
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_admin_set_course_enrollments(
  p_session_token text,
  p_course_id text,
  p_user_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_actor_id text;
  v_uid text;
  v_desired text[];
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_actor_id := v_auth->'data'->>'userId';

  IF NOT EXISTS (SELECT 1 FROM public.courses WHERE course_id = p_course_id) THEN
    RETURN public.pb_err('ERR_NOT_FOUND', 'Course not found.');
  END IF;

  v_desired := coalesce(p_user_ids, ARRAY[]::text[]);

  UPDATE public.enrollments
  SET status = 'REVOKED', updated_at_utc = now(), version = version + 1
  WHERE course_id = p_course_id AND status = 'ACTIVE' AND NOT (user_id = ANY(v_desired));

  FOREACH v_uid IN ARRAY v_desired LOOP
    IF EXISTS (SELECT 1 FROM public.users WHERE user_id = v_uid) THEN
      IF EXISTS (SELECT 1 FROM public.enrollments WHERE course_id = p_course_id AND user_id = v_uid) THEN
        UPDATE public.enrollments
        SET status = 'ACTIVE', assigned_by_user_id = v_actor_id, assigned_at_utc = now(), updated_at_utc = now(), version = version + 1
        WHERE course_id = p_course_id AND user_id = v_uid;
      ELSE
        INSERT INTO public.enrollments (enrollment_id, user_id, course_id, status, assigned_by_user_id, assigned_at_utc, updated_at_utc, version)
        VALUES (public.pb_gen_id('enr_'), v_uid, p_course_id, 'ACTIVE', v_actor_id, now(), now(), 1);
      END IF;
    END IF;
  END LOOP;

  RETURN public.pb_ok(jsonb_build_object('courseId', p_course_id, 'userIds', to_jsonb(v_desired)));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_admin_delete_user(
  p_session_token text,
  p_user_id text,
  p_hard_delete boolean DEFAULT false,
  p_expected_version integer DEFAULT NULL,
  p_admin_password text DEFAULT ''
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_actor_id text;
  v_actor_row public.users%ROWTYPE;
  v_existing public.users%ROWTYPE;
  v_admin_cnt integer;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_actor_id := v_auth->'data'->>'userId';

  SELECT * INTO v_actor_row FROM public.users WHERE user_id = v_actor_id;
  IF v_actor_row.user_id IS NULL OR trim(coalesce(p_admin_password, '')) = '' OR NOT public.pb_verify_password(p_admin_password, v_actor_row.password_hash) THEN
    RETURN public.pb_err('ERR_INVALID_CREDENTIALS', 'Your signed-in administrator password is required to confirm deleting or archiving a user account.', jsonb_build_object('adminPassword', 'Incorrect administrator password.'));
  END IF;

  SELECT * INTO v_existing FROM public.users WHERE user_id = trim(coalesce(p_user_id, ''));
  IF v_existing.user_id IS NULL THEN
    RETURN public.pb_err('ERR_NOT_FOUND', 'User not found.');
  END IF;
  IF v_existing.user_id = v_actor_id THEN
    RETURN public.pb_err('ERR_FORBIDDEN_OPERATION', 'Cannot delete or archive your own signed-in administrator account.');
  END IF;
  IF v_existing.role = 'ADMIN' AND v_existing.status = 'ACTIVE' THEN
    SELECT count(*) INTO v_admin_cnt FROM public.users WHERE role = 'ADMIN' AND status = 'ACTIVE' AND user_id <> v_existing.user_id;
    IF v_admin_cnt < 1 THEN
      RETURN public.pb_err('ERR_FORBIDDEN_OPERATION', 'Cannot delete or archive the last active administrator account.');
    END IF;
  END IF;

  UPDATE public.sessions SET status = 'REVOKED', revoked_at_utc = now(), revoke_reason = 'ACCOUNT_DELETED' WHERE user_id = v_existing.user_id AND status = 'ACTIVE';

  IF p_hard_delete THEN
    DELETE FROM public.payment_journal WHERE payment_id IN (SELECT payment_id FROM public.payments WHERE user_id = v_existing.user_id);
    DELETE FROM public.users WHERE user_id = v_existing.user_id;
    INSERT INTO public.audit_events (audit_id, actor_user_id, actor_role, event_type, target_entity_type, target_entity_id, summary_json)
    VALUES (public.pb_gen_id('aud_'), v_actor_id, 'ADMIN', 'ADMIN_USER_DELETED', 'User', v_existing.user_id, jsonb_build_object('usernameLower', v_existing.username_lower));
    RETURN public.pb_ok(jsonb_build_object('userId', v_existing.user_id, 'mode', 'HARD_DELETED'));
  ELSE
    UPDATE public.users SET status = 'ARCHIVED', updated_at_utc = now(), version = version + 1 WHERE user_id = v_existing.user_id;
    RETURN public.pb_ok(jsonb_build_object('userId', v_existing.user_id, 'mode', 'ARCHIVED'));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_student_get_profile(
  p_session_token text,
  p_target_user_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_uid text;
  v_role text;
  v_target_uid text;
  v_user public.users%ROWTYPE;
  v_courses jsonb := '[]'::jsonb;
  v_notice_ver text;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['STUDENT', 'ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_uid := v_auth->'data'->>'userId';
  v_role := v_auth->'data'->>'role';
  v_target_uid := CASE WHEN v_role = 'ADMIN' AND NULLIF(trim(coalesce(p_target_user_id, '')), '') IS NOT NULL THEN trim(p_target_user_id) ELSE v_uid END;

  SELECT * INTO v_user FROM public.users WHERE user_id = v_target_uid;
  IF v_user.user_id IS NULL THEN
    RETURN public.pb_err('ERR_NOT_FOUND', 'Student profile not found.');
  END IF;

  SELECT coalesce(NULLIF(trim(setting_value), ''), '2026-10-v1') INTO v_notice_ver
  FROM public.settings WHERE setting_key = 'CURRENT_PRIVACY_NOTICE_VERSION';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'courseId', c.course_id,
    'courseCode', c.course_code,
    'title', c.title,
    'subtitle', coalesce(c.subtitle, ''),
    'coverFileId', coalesce(c.cover_file_id, ''),
    'coverDriveFileId', coalesce((SELECT f.drive_file_id FROM public.files f WHERE f.file_id = c.cover_file_id AND f.status = 'ACTIVE' LIMIT 1), ''),
    'coverWebViewLink', coalesce((SELECT f.web_view_link FROM public.files f WHERE f.file_id = c.cover_file_id AND f.status = 'ACTIVE' LIMIT 1), ''),
    'status', c.status,
    'calendarTag', coalesce(c.calendar_tag, ''),
    'sortOrder', c.sort_order,
    'enrollmentStatus', coalesce(e.status, CASE WHEN v_role = 'ADMIN' THEN 'ADMIN_PREVIEW' ELSE '' END)
  ) ORDER BY c.sort_order ASC, c.created_at_utc DESC), '[]'::jsonb)
  INTO v_courses
  FROM public.courses c
  LEFT JOIN public.enrollments e ON e.course_id = c.course_id AND e.user_id = v_target_uid AND e.status = 'ACTIVE'
  WHERE c.status = 'PUBLISHED' AND (e.enrollment_id IS NOT NULL OR v_role = 'ADMIN');

  RETURN public.pb_ok(jsonb_build_object(
    'user', public.pb_build_user_summary(v_user, coalesce(v_notice_ver, '2026-10-v1')),
    'enrolledCourses', v_courses,
    'courses', v_courses
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_admin_factory_reset_preview(p_session_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_cats jsonb;
  v_admin_email text;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;

  SELECT coalesce(email, '') INTO v_admin_email
  FROM public.users
  WHERE user_id = (v_auth->'data'->>'userId');

  v_cats := jsonb_build_array(
    jsonb_build_object('id', 'COURSES_CONTENT', 'label', 'Courses, Sections, Cards & Quizzes', 'description', 'Course catalog, sections, lesson cards, and legacy assessment scores.', 'rowCount', (SELECT count(*) FROM public.courses) + (SELECT count(*) FROM public.sections) + (SELECT count(*) FROM public.cards) + (SELECT count(*) FROM public.assessments) + (SELECT count(*) FROM public.assessment_scores)),
    jsonb_build_object('id', 'EXAMS_QBANK', 'label', 'Question Bank & Exam Studio Tests', 'description', 'Shared passages, questions, exam sets, sections, and student assignments.', 'rowCount', (SELECT count(*) FROM public.shared_stimuli) + (SELECT count(*) FROM public.question_bank) + (SELECT count(*) FROM public.exam_sets) + (SELECT count(*) FROM public.exam_assignments)),
    jsonb_build_object('id', 'SUBMISSIONS_INTEGRITY', 'label', 'Exam Submissions, Grades & Integrity Logs', 'description', 'Student exam attempts, responses, result revisions, and integrity logs.', 'rowCount', (SELECT count(*) FROM public.exam_attempts) + (SELECT count(*) FROM public.attempt_responses) + (SELECT count(*) FROM public.exam_integrity_events)),
    jsonb_build_object('id', 'STUDENTS_ENROLLMENTS', 'label', 'Student Accounts & Enrollments', 'description', 'Student accounts, privacy choices, and course enrollments (Admin stays intact in selective reset).', 'rowCount', (SELECT count(*) FROM public.users WHERE role <> 'ADMIN') + (SELECT count(*) FROM public.enrollments)),
    jsonb_build_object('id', 'BILLING_PAYMENTS', 'label', 'Invoices, Payment Slips & Billing Journal', 'description', 'Tuition invoices, uploaded transfer slips, and income journal logs.', 'rowCount', (SELECT count(*) FROM public.invoices) + (SELECT count(*) FROM public.payments) + (SELECT count(*) FROM public.payment_journal)),
    jsonb_build_object('id', 'CALENDAR_AVAILABILITY', 'label', 'Class Calendar & Unavailability Requests', 'description', 'Portal calendar events and student unavailability requests.', 'rowCount', (SELECT count(*) FROM public.calendar_events) + (SELECT count(*) FROM public.unavailability_requests)),
    jsonb_build_object('id', 'FILES_MEDIA', 'label', 'Uploaded Files & Media Index', 'description', 'Database file references in public.files.', 'rowCount', (SELECT count(*) FROM public.files)),
    jsonb_build_object('id', 'SECURITY_AUDIT', 'label', 'Audit Logs, Login Attempts & Other Sessions', 'description', 'Audit history, login rate-limit counters, and non-current sessions.', 'rowCount', (SELECT count(*) FROM public.audit_events) + (SELECT count(*) FROM public.login_attempts)),
    jsonb_build_object('id', 'SETTINGS_RESET', 'label', 'Portal Settings (Restore Defaults)', 'description', 'Resets portal branding, bank transfer instructions, and display settings to defaults.', 'rowCount', (SELECT count(*) FROM public.settings))
  );

  RETURN public.pb_ok(jsonb_build_object(
    'categories', v_cats,
    'requiresEmailOtp', false,
    'designatedEmail', coalesce(v_admin_email, '')
  ));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_admin_execute_factory_reset(
  p_session_token text,
  p_mode text,
  p_categories text[],
  p_admin_password text,
  p_phrase text,
  p_keep_current_admin boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_actor_id text;
  v_cur_ses_id text;
  v_admin public.users%ROWTYPE;
  v_cats text[];
  v_all_cats text[] := ARRAY[
    'COURSES_CONTENT','EXAMS_QBANK','SUBMISSIONS_INTEGRITY',
    'STUDENTS_ENROLLMENTS','BILLING_PAYMENTS','CALENDAR_AVAILABILITY',
    'FILES_MEDIA','SECURITY_AUDIT','SETTINGS_RESET'
  ];
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_actor_id := v_auth->'data'->>'userId';
  v_cur_ses_id := v_auth->'data'->>'sessionId';

  SELECT * INTO v_admin FROM public.users WHERE user_id = v_actor_id;
  IF NOT public.pb_verify_password(coalesce(p_admin_password, ''), v_admin.password_hash) THEN
    RETURN public.pb_err('ERR_INVALID_CREDENTIALS', 'Administrator password verification failed.');
  END IF;
  IF upper(trim(coalesce(p_phrase, ''))) <> 'FACTORY RESET' THEN
    RETURN public.pb_err('ERR_VALIDATION_FAILED', 'Confirmation phrase must match FACTORY RESET.');
  END IF;

  v_cats := CASE WHEN upper(trim(coalesce(p_mode, ''))) = 'FULL' THEN v_all_cats ELSE coalesce(p_categories, ARRAY[]::text[]) END;

  IF 'SUBMISSIONS_INTEGRITY' = ANY(v_cats) THEN
    DELETE FROM public.exam_integrity_reviews;
    DELETE FROM public.student_integrity_profiles;
    DELETE FROM public.exam_policy_acknowledgments;
    DELETE FROM public.exam_integrity_events;
    DELETE FROM public.result_revisions;
    DELETE FROM public.exam_operation_journal;
    DELETE FROM public.attempt_responses;
    DELETE FROM public.attempt_items;
    DELETE FROM public.exam_attempts;
  END IF;

  IF 'EXAMS_QBANK' = ANY(v_cats) THEN
    DELETE FROM public.exam_assignments;
    DELETE FROM public.exam_items;
    DELETE FROM public.exam_sections;
    DELETE FROM public.exam_versions;
    DELETE FROM public.exam_sets;
    DELETE FROM public.question_options;
    DELETE FROM public.question_versions;
    DELETE FROM public.question_bank;
    DELETE FROM public.shared_stimuli;
  END IF;

  IF 'COURSES_CONTENT' = ANY(v_cats) THEN
    DELETE FROM public.assessment_scores;
    DELETE FROM public.cards;
    DELETE FROM public.sections;
    DELETE FROM public.assessments;
    DELETE FROM public.courses;
  END IF;

  IF 'BILLING_PAYMENTS' = ANY(v_cats) THEN
    DELETE FROM public.payment_journal;
    DELETE FROM public.payments;
    DELETE FROM public.invoices;
  END IF;

  IF 'CALENDAR_AVAILABILITY' = ANY(v_cats) THEN
    DELETE FROM public.unavailability_requests;
    DELETE FROM public.calendar_events;
  END IF;

  IF 'FILES_MEDIA' = ANY(v_cats) THEN
    DELETE FROM public.files;
  END IF;

  IF 'STUDENTS_ENROLLMENTS' = ANY(v_cats) THEN
    DELETE FROM public.enrollments;
    DELETE FROM public.privacy_choices WHERE user_id <> v_actor_id;
    IF upper(trim(coalesce(p_mode, ''))) = 'FULL' AND NOT coalesce(p_keep_current_admin, true) THEN
      DELETE FROM public.users WHERE user_id <> v_actor_id;
    ELSE
      DELETE FROM public.users WHERE role <> 'ADMIN';
    END IF;
  END IF;

  IF 'SECURITY_AUDIT' = ANY(v_cats) THEN
    DELETE FROM public.audit_events;
    DELETE FROM public.login_attempts;
    DELETE FROM public.sessions WHERE session_id <> v_cur_ses_id;
  END IF;

  IF 'SETTINGS_RESET' = ANY(v_cats) THEN
    DELETE FROM public.settings;
    INSERT INTO public.settings (setting_key, setting_value, updated_by_user_id, version) VALUES
      ('SCHOOL_NAME', 'Pattanabhumi Biology', v_actor_id, 1),
      ('CURRENT_PRIVACY_NOTICE_VERSION', '2026-10-v1', v_actor_id, 1),
      ('DEK_DISPLAY_MODE', 'AUTO_YEAR', v_actor_id, 1)
    ON CONFLICT (setting_key) DO NOTHING;
  END IF;

  RETURN public.pb_ok(jsonb_build_object('resetMode', upper(coalesce(p_mode, 'SELECTIVE')), 'categories', to_jsonb(v_cats)));
END;
$$;

CREATE OR REPLACE FUNCTION public.pb_set_user_integrity_status(
  p_session_token text,
  p_target_user_id text,
  p_next_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_ctx jsonb;
  v_actor_id text;
  v_actor_role text;
  v_target_id text;
  v_status text;
  v_now timestamptz := now();
BEGIN
  v_ctx := public.pb_validate_session(p_session_token, ARRAY['STUDENT', 'ADMIN']);
  IF NOT coalesce((v_ctx->>'ok')::boolean, false) THEN
    RETURN v_ctx;
  END IF;

  v_actor_id := v_ctx->'data'->>'userId';
  v_actor_role := v_ctx->'data'->>'role';
  v_target_id := trim(coalesce(p_target_user_id, ''));
  v_status := upper(trim(coalesce(p_next_status, '')));

  IF v_target_id = '' THEN
    RETURN public.pb_err('ERR_VALIDATION_FAILED', 'Target student userId is required.');
  END IF;

  IF v_actor_role <> 'ADMIN' THEN
    IF v_actor_id <> v_target_id OR v_status <> 'INTEGRITY_LOCKED' THEN
      RETURN public.pb_err('ERR_FORBIDDEN_ROLE', 'Only administrators can change another user account integrity status.');
    END IF;
  END IF;

  IF v_status NOT IN ('ACTIVE', 'INTEGRITY_LOCKED') THEN
    RETURN public.pb_err('ERR_VALIDATION_FAILED', 'Integrity account status must be ACTIVE or INTEGRITY_LOCKED.');
  END IF;

  UPDATE public.users
  SET status = v_status,
      updated_at_utc = v_now,
      version = version + 1
  WHERE user_id = v_target_id;

  IF NOT FOUND THEN
    RETURN public.pb_err('ERR_NOT_FOUND', 'Target user was not found.');
  END IF;

  IF v_status = 'INTEGRITY_LOCKED' THEN
    UPDATE public.sessions
    SET status = 'REVOKED',
        revoked_at_utc = v_now,
        revoke_reason = 'INTEGRITY_LOCKED'
    WHERE user_id = v_target_id AND status = 'ACTIVE';
  END IF;

  RETURN public.pb_ok(jsonb_build_object(
    'userId', v_target_id,
    'status', v_status,
    'updatedAtUtc', v_now
  ));
END;
$$;

-- Grant RPC execution privileges cleanly
GRANT USAGE ON SCHEMA public TO anon, authenticated;
REVOKE ALL ON FUNCTION
  public.pb_gen_id(text),
  public.pb_pbkdf2_sha256_hex(text, text, integer),
  public.pb_hash_password(text),
  public.pb_verify_password(text, text),
  public.pb_build_user_summary(public.users, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
  public.pb_format_bkk_ts(timestamptz),
  public.pb_err(text, text, jsonb),
  public.pb_ok(jsonb),
  public.pb_validate_session(text, text[]),
  public.pb_bootstrap_first_admin(text, text, text, text),
  public.pb_auth_login(text, text, boolean),
  public.pb_auth_logout(text),
  public.pb_auth_get_session_status(text),
  public.pb_get_integrity_lock_status(text),
  public.pb_privacy_acknowledge(text, text, boolean, boolean),
  public.pb_privacy_update_marketing(text, boolean),
  public.pb_public_get_bootstrap(text),
  public.pb_admin_get_dashboard_summary(text),
  public.pb_admin_list_users(text, text, text, text, integer),
  public.pb_admin_save_user(text, jsonb),
  public.pb_admin_reset_password(text, text, text, integer),
  public.pb_admin_set_user_enrollments(text, text, text[]),
  public.pb_admin_set_course_enrollments(text, text, text[]),
  public.pb_admin_verify_actor_password(text, text),
  public.pb_admin_delete_user(text, text, boolean, integer, text),
  public.pb_student_get_profile(text, text),
  public.pb_admin_factory_reset_preview(text),
  public.pb_admin_execute_factory_reset(text, text, text[], text, text, boolean),
  public.pb_set_user_integrity_status(text, text, text)
TO anon, authenticated;

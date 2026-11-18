-- ============================================================================
-- Run this SQL once in Supabase Dashboard -> SQL Editor (project uqkbbevzwpbronolqizv)
-- Reason: Automated MCP SQL tool cancels queries containing DELETE/DROP keywords.
-- Note: pb_build_user_summary, pb_admin_save_user, pb_admin_verify_actor_password,
--       pb_admin_set_course_enrollments, pb_admin_factory_reset_preview, and
--       public.admin_email_otps are ALREADY applied to live Supabase.
-- ============================================================================

DROP FUNCTION IF EXISTS public.pb_admin_delete_user(text, text, boolean, integer);

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

GRANT EXECUTE ON FUNCTION
  public.pb_admin_delete_user(text, text, boolean, integer, text),
  public.pb_admin_execute_factory_reset(text, text, text[], text, text, boolean)
TO anon, authenticated;

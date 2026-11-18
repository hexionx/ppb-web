-- Announcements, Recipient Read Receipts, and Per-User Release Notes Acknowledgements
-- Security: RLS enabled with zero direct anon/authenticated table access;
-- all access is mediated through SECURITY DEFINER RPCs validating `pb_validate_session`.

CREATE TABLE IF NOT EXISTS public.user_release_acks (
  user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  release_version text NOT NULL,
  role_at_ack text NOT NULL DEFAULT 'STUDENT',
  acknowledged_at_utc timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, release_version)
);

ALTER TABLE public.user_release_acks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny direct user_release_acks access" ON public.user_release_acks;
CREATE POLICY "Deny direct user_release_acks access"
  ON public.user_release_acks
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE TABLE IF NOT EXISTS public.portal_announcements (
  announcement_id text PRIMARY KEY,
  title text NOT NULL,
  category text NOT NULL DEFAULT 'GENERAL',
  body_text text NOT NULL,
  link_url text NOT NULL DEFAULT '',
  link_label text NOT NULL DEFAULT '',
  course_id text NOT NULL DEFAULT '',
  recipient_user_ids_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  recipient_count integer NOT NULL DEFAULT 0,
  send_email_requested boolean NOT NULL DEFAULT false,
  email_delivery_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'PUBLISHED',
  created_at_utc timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portal_announcements_created_at
  ON public.portal_announcements (created_at_utc DESC);

CREATE INDEX IF NOT EXISTS idx_portal_announcements_recipients_gin
  ON public.portal_announcements USING gin (recipient_user_ids_json);

ALTER TABLE public.portal_announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny direct portal_announcements access" ON public.portal_announcements;
CREATE POLICY "Deny direct portal_announcements access"
  ON public.portal_announcements
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

CREATE TABLE IF NOT EXISTS public.portal_announcement_reads (
  announcement_id text NOT NULL REFERENCES public.portal_announcements(announcement_id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES public.users(user_id) ON DELETE CASCADE,
  read_at_utc timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_portal_announcement_reads_user
  ON public.portal_announcement_reads (user_id, read_at_utc DESC);

ALTER TABLE public.portal_announcement_reads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Deny direct portal_announcement_reads access" ON public.portal_announcement_reads;
CREATE POLICY "Deny direct portal_announcement_reads access"
  ON public.portal_announcement_reads
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

-- 1. Check whether the signed-in user has already acknowledged a build/release version
CREATE OR REPLACE FUNCTION public.pb_portal_get_release_ack_status(
  p_session_token text,
  p_release_version text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_uid text;
  v_ver text;
  v_ack_at timestamptz;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['STUDENT', 'ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_uid := v_auth->'data'->>'userId';
  v_ver := left(trim(coalesce(p_release_version, '')), 64);

  IF v_ver = '' THEN
    RETURN public.pb_ok(jsonb_build_object('releaseVersion', '', 'acknowledged', true));
  END IF;

  SELECT acknowledged_at_utc INTO v_ack_at
  FROM public.user_release_acks
  WHERE user_id = v_uid AND release_version = v_ver
  LIMIT 1;

  RETURN public.pb_ok(jsonb_build_object(
    'releaseVersion', v_ver,
    'acknowledged', (v_ack_at IS NOT NULL),
    'acknowledgedAtUtc', CASE WHEN v_ack_at IS NOT NULL THEN to_char(v_ack_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE '' END
  ));
END;
$$;

-- 2. Record once-per-update release notification display/acknowledgement per user
CREATE OR REPLACE FUNCTION public.pb_portal_ack_release_notes(
  p_session_token text,
  p_release_version text
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
  v_ver text;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['STUDENT', 'ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_uid := v_auth->'data'->>'userId';
  v_role := coalesce(v_auth->'data'->'user'->>'role', 'STUDENT');
  v_ver := left(trim(coalesce(p_release_version, '')), 64);

  IF v_ver = '' THEN
    RETURN public.pb_err('ERR_VALIDATION_FAILED', 'releaseVersion is required.');
  END IF;

  INSERT INTO public.user_release_acks (user_id, release_version, role_at_ack, acknowledged_at_utc)
  VALUES (v_uid, v_ver, v_role, now())
  ON CONFLICT (user_id, release_version)
  DO UPDATE SET
    role_at_ack = EXCLUDED.role_at_ack,
    acknowledged_at_utc = COALESCE(public.user_release_acks.acknowledged_at_utc, EXCLUDED.acknowledged_at_utc);

  RETURN public.pb_ok(jsonb_build_object(
    'releaseVersion', v_ver,
    'acknowledged', true
  ));
END;
$$;

-- 3. Admin creates an announcement for multiple selected students/recipients
CREATE OR REPLACE FUNCTION public.pb_admin_create_announcement(
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
  v_title text;
  v_cat text;
  v_body text;
  v_link_url text;
  v_link_label text;
  v_course_id text;
  v_send_email boolean;
  v_raw_ids text[];
  v_valid_ids jsonb := '[]'::jsonb;
  v_recipients jsonb := '[]'::jsonb;
  v_rec_count integer := 0;
  v_ann_id text;
  v_row public.portal_announcements%ROWTYPE;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_actor_id := v_auth->'data'->>'userId';

  v_title := left(trim(coalesce(p_payload->>'title', '')), 160);
  v_cat := upper(trim(coalesce(p_payload->>'category', 'GENERAL')));
  v_body := left(trim(coalesce(p_payload->>'bodyText', '')), 4000);
  v_link_url := left(trim(coalesce(p_payload->>'linkUrl', '')), 500);
  v_link_label := left(trim(coalesce(p_payload->>'linkLabel', '')), 80);
  v_course_id := left(trim(coalesce(p_payload->>'courseId', '')), 64);
  v_send_email := coalesce((p_payload->>'sendEmail')::boolean, false);

  IF v_cat NOT IN ('GRADES', 'NEW_COURSE', 'STUDY_LINK', 'BILLING', 'GENERAL') THEN
    v_cat := 'GENERAL';
  END IF;
  IF char_length(v_title) < 2 THEN
    RETURN public.pb_err('ERR_VALIDATION_FAILED', 'Announcement title must be at least 2 characters.', jsonb_build_object('title', 'Enter a clear title.'));
  END IF;
  IF char_length(v_body) < 2 THEN
    RETURN public.pb_err('ERR_VALIDATION_FAILED', 'Announcement message body cannot be empty.', jsonb_build_object('bodyText', 'Enter a message for students.'));
  END IF;
  IF v_link_url <> '' AND v_link_url !~* '^(https?://|#/[a-z0-9/_-]+)' THEN
    RETURN public.pb_err('ERR_VALIDATION_FAILED', 'Optional study/action link must start with https:// or a valid portal route.', jsonb_build_object('linkUrl', 'Invalid URL format.'));
  END IF;

  SELECT coalesce(array_agg(DISTINCT trim(val)), ARRAY[]::text[])
  INTO v_raw_ids
  FROM jsonb_array_elements_text(coalesce(p_payload->'recipientUserIds', '[]'::jsonb)) AS t(val)
  WHERE trim(coalesce(val, '')) <> '';

  IF coalesce(array_length(v_raw_ids, 1), 0) = 0 THEN
    RETURN public.pb_err('ERR_VALIDATION_FAILED', 'Select at least one recipient student or user.', jsonb_build_object('recipientUserIds', 'Select at least 1 recipient.'));
  END IF;

  SELECT
    coalesce(jsonb_agg(u.user_id ORDER BY u.full_name, u.user_id), '[]'::jsonb),
    coalesce(jsonb_agg(jsonb_build_object(
      'userId', u.user_id,
      'username', u.username_display,
      'fullName', u.full_name,
      'email', coalesce(u.email, ''),
      'role', u.role
    ) ORDER BY u.full_name, u.user_id), '[]'::jsonb),
    count(*)::integer
  INTO v_valid_ids, v_recipients, v_rec_count
  FROM public.users u
  WHERE u.user_id = ANY(v_raw_ids)
    AND u.status = 'ACTIVE';

  IF v_rec_count < 1 THEN
    RETURN public.pb_err('ERR_VALIDATION_FAILED', 'None of the selected recipients are active accounts.', jsonb_build_object('recipientUserIds', 'No active recipients found.'));
  END IF;

  v_ann_id := public.pb_gen_id('ann_');
  INSERT INTO public.portal_announcements (
    announcement_id, title, category, body_text, link_url, link_label, course_id,
    recipient_user_ids_json, recipient_count, send_email_requested,
    email_delivery_summary_json, created_by_user_id, status, created_at_utc
  ) VALUES (
    v_ann_id, v_title, v_cat, v_body, v_link_url, v_link_label, v_course_id,
    v_valid_ids, v_rec_count, v_send_email,
    CASE WHEN v_send_email THEN jsonb_build_object('status', 'DISPATCHING') ELSE jsonb_build_object('status', 'PORTAL_ONLY') END,
    v_actor_id, 'PUBLISHED', now()
  )
  RETURNING * INTO v_row;

  INSERT INTO public.audit_events (audit_id, actor_user_id, actor_role, event_type, target_entity_type, target_entity_id, summary_json)
  VALUES (
    public.pb_gen_id('aud_'), v_actor_id, 'ADMIN', 'ADMIN_ANNOUNCEMENT_PUBLISHED',
    'Announcement', v_ann_id,
    jsonb_build_object('category', v_cat, 'recipientCount', v_rec_count, 'sendEmail', v_send_email, 'title', v_title)
  );

  RETURN public.pb_ok(jsonb_build_object(
    'announcement', jsonb_build_object(
      'announcementId', v_row.announcement_id,
      'title', v_row.title,
      'category', v_row.category,
      'bodyText', v_row.body_text,
      'linkUrl', v_row.link_url,
      'linkLabel', v_row.link_label,
      'courseId', v_row.course_id,
      'recipientUserIds', v_row.recipient_user_ids_json,
      'recipientCount', v_row.recipient_count,
      'sendEmailRequested', v_row.send_email_requested,
      'emailDeliverySummary', v_row.email_delivery_summary_json,
      'createdByUserId', v_row.created_by_user_id,
      'createdAtUtc', to_char(v_row.created_at_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'createdAtBangkok', to_char(v_row.created_at_utc AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') || ' ICT'
    ),
    'recipients', v_recipients
  ));
END;
$$;

-- 4. List portal announcements scoped strictly to caller (ADMIN sees all, STUDENT sees only addressed to them)
CREATE OR REPLACE FUNCTION public.pb_list_portal_announcements(
  p_session_token text,
  p_limit integer DEFAULT 40
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
  v_lim integer;
  v_items jsonb := '[]'::jsonb;
  v_unread integer := 0;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['STUDENT', 'ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_uid := v_auth->'data'->>'userId';
  v_role := coalesce(v_auth->'data'->'user'->>'role', 'STUDENT');
  v_lim := LEAST(GREATEST(coalesce(p_limit, 40), 1), 100);

  IF v_role = 'ADMIN' THEN
    SELECT coalesce(jsonb_agg(item), '[]'::jsonb) INTO v_items
    FROM (
      SELECT jsonb_build_object(
        'announcementId', a.announcement_id,
        'title', a.title,
        'category', a.category,
        'bodyText', a.body_text,
        'linkUrl', a.link_url,
        'linkLabel', a.link_label,
        'courseId', a.course_id,
        'recipientUserIds', a.recipient_user_ids_json,
        'recipientCount', a.recipient_count,
        'readCount', (SELECT count(*)::integer FROM public.portal_announcement_reads r WHERE r.announcement_id = a.announcement_id),
        'sendEmailRequested', a.send_email_requested,
        'emailDeliverySummary', a.email_delivery_summary_json,
        'createdByUserId', a.created_by_user_id,
        'createdAtUtc', to_char(a.created_at_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'createdAtBangkok', to_char(a.created_at_utc AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') || ' ICT',
        'isRead', true
      ) AS item
      FROM public.portal_announcements a
      WHERE a.status = 'PUBLISHED'
      ORDER BY a.created_at_utc DESC
      LIMIT v_lim
    ) sub;
  ELSE
    SELECT coalesce(jsonb_agg(item), '[]'::jsonb) INTO v_items
    FROM (
      SELECT jsonb_build_object(
        'announcementId', a.announcement_id,
        'title', a.title,
        'category', a.category,
        'bodyText', a.body_text,
        'linkUrl', a.link_url,
        'linkLabel', a.link_label,
        'courseId', a.course_id,
        'recipientCount', a.recipient_count,
        'createdAtUtc', to_char(a.created_at_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'createdAtBangkok', to_char(a.created_at_utc AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM-DD HH24:MI') || ' ICT',
        'isRead', (r.user_id IS NOT NULL),
        'readAtUtc', CASE WHEN r.read_at_utc IS NOT NULL THEN to_char(r.read_at_utc AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE '' END
      ) AS item
      FROM public.portal_announcements a
      LEFT JOIN public.portal_announcement_reads r
        ON r.announcement_id = a.announcement_id AND r.user_id = v_uid
      WHERE a.status = 'PUBLISHED'
        AND (a.recipient_user_ids_json ? v_uid)
      ORDER BY a.created_at_utc DESC
      LIMIT v_lim
    ) sub;

    SELECT count(*)::integer INTO v_unread
    FROM public.portal_announcements a
    WHERE a.status = 'PUBLISHED'
      AND (a.recipient_user_ids_json ? v_uid)
      AND NOT EXISTS (
        SELECT 1 FROM public.portal_announcement_reads r
        WHERE r.announcement_id = a.announcement_id AND r.user_id = v_uid
      );
  END IF;

  RETURN public.pb_ok(jsonb_build_object(
    'announcements', v_items,
    'unreadCount', v_unread
  ));
END;
$$;

-- 5. Mark an announcement as read for the signed-in user
CREATE OR REPLACE FUNCTION public.pb_mark_announcement_read(
  p_session_token text,
  p_announcement_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_uid text;
  v_ann_id text;
  v_unread integer := 0;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['STUDENT', 'ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_uid := v_auth->'data'->>'userId';
  v_ann_id := trim(coalesce(p_announcement_id, ''));

  IF v_ann_id = '' THEN
    INSERT INTO public.portal_announcement_reads (announcement_id, user_id, read_at_utc)
    SELECT a.announcement_id, v_uid, now()
    FROM public.portal_announcements a
    WHERE a.status = 'PUBLISHED' AND (a.recipient_user_ids_json ? v_uid)
    ON CONFLICT (announcement_id, user_id) DO NOTHING;
  ELSE
    IF EXISTS (
      SELECT 1 FROM public.portal_announcements a
      WHERE a.announcement_id = v_ann_id AND a.status = 'PUBLISHED' AND (a.recipient_user_ids_json ? v_uid)
    ) THEN
      INSERT INTO public.portal_announcement_reads (announcement_id, user_id, read_at_utc)
      VALUES (v_ann_id, v_uid, now())
      ON CONFLICT (announcement_id, user_id) DO NOTHING;
    END IF;
  END IF;

  SELECT count(*)::integer INTO v_unread
  FROM public.portal_announcements a
  WHERE a.status = 'PUBLISHED'
    AND (a.recipient_user_ids_json ? v_uid)
    AND NOT EXISTS (
      SELECT 1 FROM public.portal_announcement_reads r
      WHERE r.announcement_id = a.announcement_id AND r.user_id = v_uid
    );

  RETURN public.pb_ok(jsonb_build_object('unreadCount', v_unread));
END;
$$;

-- 6. Admin delete announcement
CREATE OR REPLACE FUNCTION public.pb_admin_delete_announcement(
  p_session_token text,
  p_announcement_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_auth jsonb;
  v_ann_id text;
BEGIN
  v_auth := public.pb_validate_session(p_session_token, ARRAY['ADMIN']);
  IF coalesce((v_auth->>'ok')::boolean, false) = false THEN RETURN v_auth; END IF;
  v_ann_id := trim(coalesce(p_announcement_id, ''));
  DELETE FROM public.portal_announcements WHERE announcement_id = v_ann_id;
  RETURN public.pb_ok(jsonb_build_object('deleted', true, 'announcementId', v_ann_id));
END;
$$;

GRANT EXECUTE ON FUNCTION
  public.pb_portal_get_release_ack_status(text, text),
  public.pb_portal_ack_release_notes(text, text),
  public.pb_admin_create_announcement(text, jsonb),
  public.pb_list_portal_announcements(text, integer),
  public.pb_mark_announcement_read(text, text),
  public.pb_admin_delete_announcement(text, text)
TO anon, authenticated;

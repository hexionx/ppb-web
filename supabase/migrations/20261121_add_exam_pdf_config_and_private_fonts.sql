-- Migration: Add per-exam PDF export configuration & private Thai font storage bucket
-- Applied to Supabase project uqkbbevzwpbronolqizv

ALTER TABLE public.exam_sets
  ADD COLUMN IF NOT EXISTS pdf_config JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.exam_sets.pdf_config IS
  'Persisted template-based PDF export configuration (template key alevel|posn, Slots 1-5 metadata, logo/watermark URLs, QR URL, custom rules).';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  (
    'private-fonts',
    'private-fonts',
    false,
    10485760,
    ARRAY['font/woff2', 'application/font-woff2', 'application/octet-stream']
  ),
  (
    'exam-pdf-assets',
    'exam-pdf-assets',
    false,
    5242880,
    ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']
  )
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'pb_private_fonts_select'
  ) THEN
    CREATE POLICY pb_private_fonts_select
      ON storage.objects FOR SELECT
      TO anon, authenticated
      USING (bucket_id = 'private-fonts');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'pb_exam_pdf_assets_select'
  ) THEN
    CREATE POLICY pb_exam_pdf_assets_select
      ON storage.objects FOR SELECT
      TO anon, authenticated
      USING (bucket_id = 'exam-pdf-assets');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'pb_exam_pdf_assets_insert'
  ) THEN
    CREATE POLICY pb_exam_pdf_assets_insert
      ON storage.objects FOR INSERT
      TO anon, authenticated
      WITH CHECK (bucket_id = 'exam-pdf-assets');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'pb_exam_pdf_assets_update'
  ) THEN
    CREATE POLICY pb_exam_pdf_assets_update
      ON storage.objects FOR UPDATE
      TO anon, authenticated
      USING (bucket_id = 'exam-pdf-assets')
      WITH CHECK (bucket_id = 'exam-pdf-assets');
  END IF;
END $$;

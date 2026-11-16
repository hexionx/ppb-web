# Migration Guide: Google Sheets + Apps Script -> Supabase + Direct Google Drive

This guide walks through every manual step required to run the refactored **Pattanabhumi Biology LMS** on **GitHub Pages (`docs/`)** with **Supabase (PostgreSQL)** and **Direct Google Drive API v3 uploads**.

---

## Architecture Overview

```text
Browser (GitHub Pages: docs/)
  ├── @supabase/supabase-js (PostgreSQL + SECURITY DEFINER Auth/Session RPCs)
  │     └── All 36 tables protected by Row Level Security (RLS)
  │         (`users`, `sessions`, `login_attempts` are never queryable directly by anon!)
  ├── gas-token-provider (Standalone Apps Script GET ?secret=...)
  │     └── Returns short-lived OAuth 2.0 token via ScriptApp.getOAuthToken()
  └── Google Drive REST API v3 (Client-side direct multipart upload & media fetch)
        ├── JPG/PNG compressed client-side via HTML5 Canvas (maxWidth 1280px, quality 0.8)
        └── Direct uploads saved with parents: [GOOGLE_DRIVE_FOLDER_ID]
```

---

## Step 1: Create Supabase Project & Run `schema.sql`

1. Create a new project in [Supabase](https://supabase.com/dashboard).
2. Open **SQL Editor -> New query**.
3. Copy the entire contents of [`schema.sql`](schema.sql) and run it (`Run`).
4. Verify execution succeeded with zero errors:
   - All **36 tables** are created in `public`.
   - `pgcrypto` extension is enabled.
   - All tables have **Row Level Security (`ENABLE ROW LEVEL SECURITY`)** active.
   - Direct browser `SELECT`/`INSERT`/`UPDATE`/`DELETE` policies on `public.users`, `public.sessions`, and `public.login_attempts` deny access (`USING (false)`), while login, session validation (`NEW_DEVICE_LOGIN` kickout), privacy consent, integrity account lock transitions, and admin user management execute inside `SECURITY DEFINER` RPC functions (`pb_*`).
5. Gather your Supabase keys from **Project Settings -> Data API / API Keys**:
   - **Project URL** (`SUPABASE_URL`, e.g. `https://xxxx.supabase.co`)
   - **`anon` / `publishable` Key** (`SUPABASE_ANON_KEY`)
   - *(Never put the `service_role` secret key in `docs/js/config.js`!)*

### Bootstrapping an Initial Admin (Only If NOT Importing Legacy `Users` CSV)
If you are starting with an empty `public.users` table instead of importing your legacy Google Sheet `Users` tab:

```sql
SELECT public.pb_bootstrap_first_admin(
  'admin_username',
  'YourStrongAdminPassword!123',
  'Instructor Name',
  'admin@example.com'
);
```
> `pb_bootstrap_first_admin` uses RFC 6070 PBKDF2-HMAC-SHA256 (`100000` iterations), producing the exact same `pbkdf2_sha256$...` format as legacy Apps Script `Code.gs`. It automatically refuses to run once any `ADMIN` exists.

---

## Step 2: Deploy Standalone Apps Script Token Provider (`gas-token-provider`)

This standalone project does **not** touch Google Sheets or Base64 file payloads. Its sole job is issuing short-lived Google OAuth access tokens (`ScriptApp.getOAuthToken()`).

1. Go to [https://script.google.com](https://script.google.com) -> click **New project**.
2. Name the project `Pattanabhumi Drive Token Provider`.
3. Replace `Code.gs` with the contents of [`gas-token-provider/Code.gs`](gas-token-provider/Code.gs).
   - Ensure `// DriveApp.getRootFolder();` and `_authorizeDriveScopeOnce_()` remain in the script so Google prompts for Google Drive OAuth consent on deploy.
4. Click **Project Settings** (gear icon):
   - Check **"Show 'appsscript.json' manifest file in editor"**.
   - Return to the Editor, open `appsscript.json`, and paste [`gas-token-provider/appsscript.json`](gas-token-provider/appsscript.json) (which locks OAuth scope to `https://www.googleapis.com/auth/drive`).
5. Return to **Project Settings -> Script Properties -> Add script property**:
   - Property: `GAS_SECRET_KEY`
   - Value: generate a strong random secret string (e.g., 32+ random characters) and **save it** — you will paste this identical value into `docs/js/config.js`.
6. Click **Deploy -> New deployment**:
   - Select type: **Web app**
   - **Execute as:** `Me` (the Google account that owns your Drive upload folder!)
   - **Who has access:** `Anyone` (required so GitHub Pages can fetch via anonymous HTTPS GET with your `GAS_SECRET_KEY`)
7. Authorize the OAuth consent prompt (granting Google Drive access).
8. Copy the deployed **Web app URL** ending in `/exec` (`GAS_TOKEN_WEBAPP_URL`).

---

## Step 3: Import Legacy Google Sheets Data (Optional — Skip If Starting Fresh)

Because `schema.sql` preserves all legacy `snake_case` table and column names, existing student passwords (`pbkdf2_sha256$...`), exam questions, attempts, and Drive file IDs work immediately with **zero password resets**.

### Option A (Recommended — Automated): Run `migrate_sheets_to_supabase.gs`
1. Open [`migrate_sheets_to_supabase.gs`](migrate_sheets_to_supabase.gs) and copy its contents into a standalone Apps Script project (`https://script.google.com`).
2. Fill in `MIGRATION_CONFIG`:
   - `SUPABASE_URL`: `'https://uqkbbevzwpbronolqizv.supabase.co'` (or `.../rest/v1/`)
   - `SUPABASE_SERVICE_ROLE_KEY`: Your Supabase **`service_role` / `sb_secret_...`** key from **Project Settings -> API Keys** (do **not** use the `sb_publishable_...` key — migration must bypass locked RLS on `users`, `sessions`, and `login_attempts`).
   - `SPREADSHEET_ID`: Your legacy Google Spreadsheet ID.
3. Run `migrateSheetsDryRun()` first to verify parsing in **Executions / Logs**, then run `migrateSheetsToSupabase()`.

### Option B (Manual): Export CSVs from Your Legacy Google Sheet
In Google Sheets, export each populated worksheet (`File -> Download -> Comma-separated values (.csv)`).

### 3B. Prepare CSV Files Before Importing
In **Supabase Dashboard -> Table Editor -> Import data from CSV**:
- **Empty numeric/timestamp/jsonb cells:** Ensure blank optional cells are empty (`,,` rather than `"null"` text) so Postgres treats them as SQL `NULL` or column default.
- **`files.csv` mapping for legacy records:**
  - Ensure `drive_file_id` is preserved intact.
  - Leave `storage_provider` as `GOOGLE_DRIVE`.
  - Leave `web_view_link` empty or populate `https://drive.google.com/file/d/<drive_file_id>/view`.
  - Both new uploads and legacy imported images render cleanly via `getGoogleDriveImageUrl(drive_file_id)` (and automatically fall back to authenticated `alt=media` fetch if a legacy Drive file is private!).

### 3C. Strict Foreign-Key Import Order
Import populated tables in this exact sequence:

1. **Core Auth & Config:** `users` -> `settings` -> `privacy_choices` -> `audit_events`
2. **Courses & Media:** `files` -> `courses` -> `sections` -> `assessments` -> `cards` -> `enrollments` -> `assessment_scores`
3. **Question Bank & Exams:** `shared_stimuli` -> `question_bank` -> `question_versions` -> `question_options` -> `exam_sets` -> `exam_versions` -> `exam_sections` -> `exam_items` -> `exam_assignments`
4. **Attempts & Results:** `exam_attempts` -> `attempt_items` -> `attempt_responses` -> `exam_operation_journal` -> `result_revisions`
5. **Exam Integrity:** `exam_integrity_events` -> `exam_policy_acknowledgments` -> `student_integrity_profiles` -> `exam_integrity_reviews`
6. **Billing & Calendar:** `invoices` -> `payments` -> `payment_journal` -> `calendar_events` -> `unavailability_requests`

> Note: Existing legacy passwords stored in `users.password_hash` (`pbkdf2_sha256$<iterations>$<salt_32_hex>$<hash_64_hex>`) are verified natively by PostgreSQL `pb_verify_password()` via `pgcrypto`!

---

## Step 4: Configure `docs/js/config.js`

Open [`docs/js/config.js`](docs/js/config.js) and replace all five placeholders:

```js
window.PB_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'eyJ...YOUR_SUPABASE_ANON_KEY...',
  GAS_TOKEN_WEBAPP_URL: 'https://script.google.com/macros/s/AKfycb.../exec',
  GAS_SECRET_KEY: 'YOUR_MATCHING_GAS_SECRET_KEY',
  GOOGLE_DRIVE_FOLDER_ID: '1vtFBqT_vHTBTscK8KQXNZmCU_tf31PZ6',
  IMAGE_MAX_WIDTH: 1280,
  IMAGE_QUALITY: 0.8,
  DRIVE_SET_ANYONE_READER: true,
  REQUEST_TIMEOUT_MS: 120000
};
```

> Verify `GOOGLE_DRIVE_FOLDER_ID` points to a folder owned by or writable by the Google account that deployed `gas-token-provider`.

---

## Step 5: Deploy & Verify on GitHub Pages

1. Commit and push all updates (including filled `docs/js/config.js`) to your GitHub repository.
2. Under **Settings -> Pages**: ensure source is Branch `main`, folder `/docs`.
3. Open your live site and verify:
   - Public home page loads courses, portrait, logo, and hero cards from Supabase (`public.getBootstrap`).
   - Log in with a legacy imported user or bootstrapped admin (`pb_auth_login`) — verify single-device login enforcement and session persistence.
   - Upload an image (JPG/PNG) in Course/Card/Question Bank Editor -> confirm HTML5 Canvas resizes to max width `1280px` (`0.8` quality), fetches token from `gas-token-provider`, uploads directly to Drive API v3 (`webViewLink` + `drive_file_id` stored in Supabase `files`), and renders immediately via `getGoogleDriveImageUrl`.
   - Upload a PDF in Question Bank / Assessment / Mock Exam -> confirm embedded viewer works with Download / View-Only permissions preserved.

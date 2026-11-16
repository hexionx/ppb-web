# Pattanabhumi Biology LMS — GitHub Pages + Supabase + Direct Google Drive

Frontend static portal served from **`docs/`** on **GitHub Pages**, backed by **Supabase (PostgreSQL + RLS + SECURITY DEFINER Auth RPCs)** and **client-side Direct Google Drive REST v3 uploads** authorized via a lightweight standalone Apps Script token endpoint (`gas-token-provider/`).

See **[MIGRATION_GUIDE.md](MIGRATION_GUIDE.md)** for full step-by-step setup, CSV migration, and deployment instructions.

---

## Architecture

```text
Browser (GitHub Pages: docs/)
  ├── @supabase/supabase-js (CDN) -> PostgreSQL tables + pb_* RPC functions
  ├── docs/js/drive-storage.js    -> HTML5 Canvas compression (1280px, 0.8) + Direct Drive API v3 + lh3.googleusercontent.com URLs
  ├── docs/js/supabase-backend.js -> Auth/Sessions, CMS, Courses, Files, Invoices/PromptPay, Calendar
  ├── docs/js/supabase-exams.js   -> Question Bank, Stimuli, Exam Builder, Auto/Manual Grading, Analytics & Anti-Copy Integrity
  ├── docs/js/api.js              -> google.script.run drop-in shim delegating to PBSupabaseBackend
  └── gas-token-provider/Code.gs  -> Lightweight OAuth token getter (ScriptApp.getOAuthToken())
```

---

## Repository Layout

| Path | Description | Manual Setup Needed? |
|---|---|---|
| [`schema.sql`](schema.sql) | 36-table PostgreSQL schema, RLS policies & `SECURITY DEFINER` auth/session RPCs (`pb_*`) | Run in Supabase SQL Editor |
| [`gas-token-provider/Code.gs`](gas-token-provider/Code.gs) | Standalone Apps Script Web App issuing Drive OAuth tokens (`doGet`) | Deploy to Apps Script (`Anyone`) |
| [`gas-token-provider/appsscript.json`](gas-token-provider/appsscript.json) | Manifest scoping the token provider to `drive` | Copy into standalone script |
| [`docs/js/config.js`](docs/js/config.js) | Supabase URL/Key, GAS Token URL/Secret & Drive Folder ID | Fill values before publish |
| [`docs/js/drive-storage.js`](docs/js/drive-storage.js) | `getGoogleDriveImageUrl()`, Canvas compressor & Drive multipart uploader | Built & ready |
| [`docs/js/supabase-backend.js`](docs/js/supabase-backend.js) | Primary Supabase query/RPC data router | Built & ready |
| [`docs/js/supabase-exams.js`](docs/js/supabase-exams.js) | Native online examination, scoring, results & integrity handlers | Built & ready |
| [`docs/js/api.js`](docs/js/api.js) | Drop-in `google.script.run` bridge to `PBSupabaseBackend` | Built & ready |
| `docs/index.html`, `docs/css/styles.css`, `docs/js/app.js` | Generated frontend UI (preserved layout/forms/UX) | Generated via build script |
| [`tools/build-from-apps-script.ps1`](tools/build-from-apps-script.ps1) | Rebuilds `docs/` from `ClientCore.html` / `Index.html` / `Styles.html` | Run after editing source HTML |
| [`MIGRATION_GUIDE.md`](MIGRATION_GUIDE.md) | Complete step-by-step migration & deployment manual | Follow step by step |
| `backend/` | Reference legacy Apps Script source kept in sync with UI edits | Archival / reference |

---

## Quick Start

1. Run [`schema.sql`](schema.sql) in your Supabase project's **SQL Editor**.
2. Deploy [`gas-token-provider/Code.gs`](gas-token-provider/Code.gs) as a standalone Apps Script Web App (`Execute as: Me`, `Access: Anyone`) with Script Property `GAS_SECRET_KEY`.
3. Fill [`docs/js/config.js`](docs/js/config.js) with `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `GAS_TOKEN_WEBAPP_URL`, `GAS_SECRET_KEY`, and `GOOGLE_DRIVE_FOLDER_ID`.
4. Commit & push, then enable **GitHub Pages** on branch `main` folder `/docs`.
5. Follow [`MIGRATION_GUIDE.md`](MIGRATION_GUIDE.md) to import any legacy Google Sheets CSVs cleanly in FK order.

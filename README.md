# Pattanabhumi Biology LMS: GitHub Pages + Apps Script API

This repo hosts the **frontend on GitHub Pages** (`docs/`). The **backend stays on Google Apps Script** (`backend/`) and serves a JSON API. Data remains in Google Sheets, Drive, Calendar and Mail, exactly as before.

```
Browser ──(GitHub Pages: docs/)──► index.html + css + js
   │
   └── fetch POST (text/plain JSON envelope) ──► Apps Script Web App /exec
                                                   doPost()  (backend/Api.gs)
                                                     └─► rpcDispatch()  (unchanged)
                                                           └─► Sheets / Drive / Calendar / Mail
```

## Repository layout

| Path | What it is | Edit by hand? |
|---|---|---|
| `docs/index.html` | Built from `Index.html` + `StatusView.html` (includes resolved) | No, generated |
| `docs/css/styles.css` | Built from `Styles.html` | No, generated |
| `docs/js/app.js` | Built from `ClientCore.html` (logic unchanged; logo now loads from a file) | No, generated |
| `docs/assets/logo.webp` | Default logo extracted from the old embedded base64 string | Generated |
| `docs/js/api.js` | **New.** `google.script.run`-compatible shim that calls the API with `fetch()` | Yes |
| `docs/js/config.js` | **New.** Backend `/exec` URL | **Yes, set `API_URL`** |
| `docs/.nojekyll` | Tells Pages to serve files as-is | Yes |
| `backend/*.gs`, `backend/*.html` | Original Apps Script files, byte-for-byte unchanged | Yes (source of truth) |
| `backend/Api.gs` | **New.** `doPost(e)` JSON entry point that wraps `rpcDispatch` | Yes |
| `backend/appsscript.json` | Manifest (renamed from the misspelled `appscript.json`) | Yes |
| `backend/.clasp.json`, `.claspignore` | Optional config for the `clasp` CLI | Yes |
| `backend/DUPLICATES.md` | Report of conflicting duplicate function definitions | Info |
| `tools/build-from-apps-script.ps1` | Regenerates `docs/` and `backend/` from the Apps Script source folder | Yes |

---

## 1. Deploy the backend (Apps Script)

### Option A (recommended for the first deploy): add one file in the editor

This leaves every existing file and the file order untouched (see [backend/DUPLICATES.md](backend/DUPLICATES.md) for why order matters).

1. Open the existing project at https://script.google.com.
2. Click **+ → Script**, name it `Api`, and paste the contents of [`backend/Api.gs`](backend/Api.gs). Save.
3. Click **Deploy → New deployment**, choose type **Web app**, and set:
   - **Execute as:** *Me* (same as today: `USER_DEPLOYING`)
   - **Who has access:** *Anyone* (same as today: `ANYONE_ANONYMOUS`). This is required, because the browser calls the API anonymously.
4. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

> Updating an existing deployment instead (**Manage deployments → Edit → Version: New version**) keeps the same URL. Both the old HtmlService UI (`doGet`) and the new API (`doPost`) are served from that URL.

### Option B: push with `clasp` (later, after reviewing file order)

```powershell
npm install -g @google/clasp
clasp login
cd backend
# put your Script ID (Project Settings → IDs) into .clasp.json
clasp push
```

> ⚠️ `clasp push` uploads the files in its own order unless `filePushOrder` is set in `.clasp.json`. Because 17 functions are defined differently in more than one file, a different order can change which version runs. Read `backend/DUPLICATES.md` first.

## 2. Point the frontend at the backend

Edit [`docs/js/config.js`](docs/js/config.js):

```js
window.PB_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycb.../exec',
  REQUEST_TIMEOUT_MS: 390000
};
```

## 3. Publish on GitHub Pages

Git isn't installed on this PC, so use one of these:

**GitHub Desktop** (https://desktop.github.com)
1. **File → Add local repository →** choose this `ppb-web` folder (accept "create a repository").
2. **Publish repository.** Pages on a free account requires a **public** repo (see the security notes below).

**Or the github.com web uploader**
1. Create a new repository on github.com.
2. **Add file → Upload files**, then drag in the *contents* of `ppb-web` (`docs/`, `backend/`, `tools/`, `README.md`). Note that `.nojekyll`, `.clasp.json` and `.claspignore` are hidden files; enable showing hidden files in Explorer first.

**Then enable Pages:** repo **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder: `/docs` → Save.**
The site will be at `https://<username>.github.io/<repo>/` within a minute or two.

Custom domain later: add it under Settings → Pages. All paths are relative, so no code changes are needed.

---

## Updating the site after editing the Apps Script code

The original Apps Script files (e.g. in `OneDrive\PPB\Web`, or `backend/`) remain the source of truth. After changing them, regenerate:

```powershell
powershell -ExecutionPolicy Bypass -File tools\build-from-apps-script.ps1
# or from a different source folder:
powershell -ExecutionPolicy Bypass -File tools\build-from-apps-script.ps1 -SourceDir .\backend
```

Then commit and push. Remember to also update the Apps Script deployment (new version) when you change `.gs` files.

---

## How the transport works

- `app.js` still calls `google.script.run.withSuccessHandler(..).withFailureHandler(..).rpcDispatch(envelope)`.
- `api.js` defines that object. It POSTs `JSON.stringify(envelope)` with `Content-Type: text/plain`, a CORS "simple request", so there's no preflight, which Apps Script can't answer.
- `doPost` parses the body, calls the unchanged `rpcDispatch`, and returns its envelope as JSON.
- Sessions already use a bearer token in the envelope (stored in `localStorage`), so no Google cookies are involved.

## Known limits and security notes

- **Upload size:** files are sent as base64 in a single request. Apps Script accepts roughly **50 MB per request**, so the practical file limit is about **35 MB**, even though `Config.gs` allows 200 MB. That's the same practical ceiling `google.script.run` had.
- **Origin restriction is impossible:** Apps Script doesn't expose request headers, so the API can't be limited to your Pages domain. All auth, role, rate-limit and size checks still run in `rpcDispatch`, which is the same exposure as the existing `ANYONE_ANONYMOUS` deployment.
- **Public repo:** with free GitHub Pages, the backend source is publicly readable. No hard-coded secrets were found (secrets live in Script Properties). Sample/seed passwords such as `StudentPass123!` appear in admin seed/verification helpers, so make sure no real account uses them. You can keep `backend/` out of the public repo if you prefer.
- **`*.github.io` storage:** all project sites under the same username share one origin, so they can read each other's `localStorage` (where the session token lives). Use a custom domain, or don't host untrusted pages under the same account.
- **Latency:** each call takes about 1–3 s of Apps Script cold start, the same as `google.script.run`.
- **Legacy UI:** `doGet` is unchanged. To retire it later, make `doGet` return a redirect page to the Pages URL.

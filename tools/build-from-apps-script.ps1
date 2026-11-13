<#
.SYNOPSIS
  Regenerates the GitHub Pages frontend (docs/) and the clasp backend (backend/)
  from the original Google Apps Script project files.

.DESCRIPTION
  Re-run this whenever the Apps Script source (e.g. OneDrive\PPB\Web) changes.
  Generated (overwritten) files:
    docs/index.html, docs/css/styles.css, docs/js/app.js, docs/assets/logo.webp
    backend/*.gs, backend/*.html, backend/appsscript.json
  Hand-maintained (never overwritten):
    docs/js/api.js, docs/js/config.js, docs/.nojekyll,
    backend/Api.gs, backend/.clasp.json, backend/.claspignore

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\build-from-apps-script.ps1
  powershell -ExecutionPolicy Bypass -File tools\build-from-apps-script.ps1 -SourceDir "D:\other\Web"
#>
param(
  [string]$SourceDir = (Join-Path $env:USERPROFILE 'OneDrive\PPB\Web'),
  [string]$RepoRoot  = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-Text([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { throw "Missing source file: $path" }
  $t = [System.IO.File]::ReadAllText($path, $Utf8NoBom)
  if ($t.Length -gt 0 -and $t[0] -eq [char]0xFEFF) { $t = $t.Substring(1) }
  if ($t.Length -eq 0) { throw "Source file is empty (OneDrive not synced?): $path" }
  return $t
}
function Write-Text([string]$path, [string]$text) {
  $dir = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom)
}
function Strip-Wrapper([string]$text, [string]$tag, [string]$name) {
  $open  = [regex]::new('^\s*<' + $tag + '>\s*\r?\n')
  $close = [regex]::new('\r?\n\s*</' + $tag + '>\s*$')
  if (-not $open.IsMatch($text) -or -not $close.IsMatch($text)) {
    throw "$name is not wrapped in a single <$tag>...</$tag> block; update the build script."
  }
  $text = $open.Replace($text, '', 1)
  return $close.Replace($text, "`r`n", 1)
}

$SourceDir = (Resolve-Path -LiteralPath $SourceDir).Path
$docs    = Join-Path $RepoRoot 'docs'
$backend = Join-Path $RepoRoot 'backend'
Write-Host "Source : $SourceDir"
Write-Host "Repo   : $RepoRoot"

# ---------------------------------------------------------------- frontend
$index      = Read-Text (Join-Path $SourceDir 'Index.html')
$styles     = Read-Text (Join-Path $SourceDir 'Styles.html')
$statusView = Read-Text (Join-Path $SourceDir 'StatusView.html')
$loginView  = Read-Text (Join-Path $SourceDir 'LoginView.html')
$clientCore = Read-Text (Join-Path $SourceDir 'ClientCore.html')

# Styles.html -> css/styles.css
Write-Text (Join-Path $docs 'css\styles.css') (Strip-Wrapper $styles 'style' 'Styles.html')

# ClientCore.html -> js/app.js (+ extract embedded default logo)
$appJs = Strip-Wrapper $clientCore 'script' 'ClientCore.html'
$logoRx = [regex]::new("(var DEFAULT_EMBEDDED_LOGO_DATA_URL =\s*)'data:image/webp;base64,([A-Za-z0-9+/=]+)';")
$m = $logoRx.Match($appJs)
if (-not $m.Success) { throw 'Could not find DEFAULT_EMBEDDED_LOGO_DATA_URL in ClientCore.html.' }
$logoBytes = [Convert]::FromBase64String($m.Groups[2].Value)
$assetsDir = Join-Path $docs 'assets'
if (-not (Test-Path $assetsDir)) { New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null }
[System.IO.File]::WriteAllBytes((Join-Path $assetsDir 'logo.webp'), $logoBytes)
$appJs = $logoRx.Replace($appJs, ($m.Groups[1].Value -replace '\$', '$$$$') + "'assets/logo.webp';", 1)
$appJs = "/* GENERATED from Apps Script ClientCore.html by tools/build-from-apps-script.ps1 - do not edit by hand. */`r`n" + $appJs
Write-Text (Join-Path $docs 'js\app.js') $appJs

# StatusView (+ LoginView splice, mirroring includePartial_ in Code.gs)
$loginIncludeRx = [regex]::new("<\?!=?\s*includePartial_\(\s*['""]LoginView['""]\s*\);?\s*\?>")
$statusHasModal = $statusView.Contains('id="modal-login"')
$loginHasModal  = $loginView.Contains('id="modal-login"')
if ($statusView.Contains('includePartial_')) {
  $replacement = if ($statusHasModal) { '' } elseif ($loginHasModal) { $loginView } else { '' }
  $statusView = $loginIncludeRx.Replace($statusView, { param($x) $replacement })
} elseif (-not $statusHasModal -and $loginHasModal) {
  $statusView = $loginView + "`r`n" + $statusView
}

# Index.html -> index.html (resolve scriptlets statically)
$tagStyles = "<?!= includePartial_('Styles'); ?>"
$tagStatus = "<?!= includePartial_('StatusView'); ?>"
$tagCore   = "<?!= includePartial_('ClientCore'); ?>"
foreach ($t in @($tagStyles, $tagStatus, $tagCore)) {
  if (-not $index.Contains($t)) { throw "Index.html no longer contains expected tag: $t" }
}
$index = $index.Replace($tagStyles, '<link rel="stylesheet" href="css/styles.css" />')
$index = $index.Replace($tagStatus, $statusView)
$index = $index.Replace($tagCore, (@(
  '<!-- Backend endpoint config, fetch transport shim, then the original client app -->',
  '    <script src="js/config.js"></script>',
  '    <script src="js/api.js"></script>',
  '    <script src="js/app.js"></script>'
) -join "`r`n"))
# doGet() added these via HtmlOutput; add them as real tags.
$index = $index.Replace('<meta charset="UTF-8" />', (@(
  '<meta charset="UTF-8" />',
  '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
  '    <link rel="icon" type="image/webp" href="assets/logo.webp" />'
) -join "`r`n"))
if ($index -match '<\?') { throw 'index.html still contains unresolved Apps Script scriptlets.' }
$index = "<!-- GENERATED from Apps Script Index.html by tools/build-from-apps-script.ps1 - do not edit by hand. -->`r`n" + $index
Write-Text (Join-Path $docs 'index.html') $index

# ---------------------------------------------------------------- backend
if (-not (Test-Path $backend)) { New-Item -ItemType Directory -Force -Path $backend | Out-Null }
Get-ChildItem -LiteralPath $SourceDir -File | Where-Object { $_.Extension -in '.gs', '.html' } | ForEach-Object {
  Write-Text (Join-Path $backend $_.Name) (Read-Text $_.FullName)
}
$manifestSrc = @('appsscript.json', 'appscript.json') | ForEach-Object { Join-Path $SourceDir $_ } |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $manifestSrc) { throw 'No appsscript.json / appscript.json manifest found.' }
Write-Text (Join-Path $backend 'appsscript.json') (Read-Text $manifestSrc)

$leftover = Select-String -Path (Join-Path $docs 'js\app.js'), (Join-Path $docs 'index.html') -Pattern 'includePartial_|<\?!?='
if ($leftover) { throw "Unresolved template markers remain: $($leftover | Out-String)" }

Write-Host ('Logo  : {0:N0} bytes -> docs/assets/logo.webp' -f $logoBytes.Length)
Write-Host 'Done.'

# Checks the shops added on the admin Add shop page (pnpm shop-requests). Run every 15 minutes by Windows Task
# Scheduler (task "MTP Shop Requests", hidden window). Logs go to out/shop-requests-YYYY-MM-DD.log.
# The nightly task (run-local.ps1) pulls code and runs migrations; this one only checks requests.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
New-Item -ItemType Directory -Force -Path (Join-Path $repo 'out') | Out-Null
$log = Join-Path $repo ("out\shop-requests-" + (Get-Date -Format 'yyyy-MM-dd') + '.log')
"=== $(Get-Date -Format s)" *>> $log
pnpm shop-requests *>> $log

# Hourly adaptive re-checks for the shops that run locally (from 1 Nov). Run by Windows Task Scheduler.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
New-Item -ItemType Directory -Force -Path (Join-Path $repo 'out') | Out-Null
$log = Join-Path $repo ("out\local-due-" + (Get-Date -Format 'yyyy-MM-dd') + '.log')
"=== $(Get-Date -Format s)" *>> $log
pnpm scrape-due --runner local --minutes 50 *>> $log

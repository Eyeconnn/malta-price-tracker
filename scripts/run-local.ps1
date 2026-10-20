# Nightly scrape of the shops that refuse GitHub Actions IPs (config.runner = "local").
# Run by Windows Task Scheduler; logs go to out/local-YYYY-MM-DD.log.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
New-Item -ItemType Directory -Force -Path (Join-Path $repo 'out') | Out-Null
$log = Join-Path $repo ("out\local-" + (Get-Date -Format 'yyyy-MM-dd') + '.log')

# pick up any code or shop changes pushed from elsewhere, then make sure dependencies match
git pull --ff-only *>> $log
pnpm install --frozen-lockfile *>> $log
pnpm migrate *>> $log
pnpm seed *>> $log
pnpm scrape --runner local *>> $log

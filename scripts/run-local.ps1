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

# Start the cloud scrapes now. GitHub's own cron is unreliable (it ran up to 5 hours late) and stays
# only as a backup that skips shops already scraped.
foreach ($w in 'scrape-shopify', 'scrape-woo', 'scrape-magento', 'scrape-html') {
  gh workflow run $w --repo Eyeconnn/malta-price-tracker *>> $log
}

# product photos: small WebP copies to R2 (src/pipeline/images.ts)
$env:IMAGES_ENABLED = 'on'
pnpm scrape --runner local *>> $log

# Build the public site's tables. The cloud scrapes started above may still be running; the workflow's own
# cron at 04:55 UTC builds again when any scrape finished after this build began (else it skips).
gh workflow run site-build --repo Eyeconnn/malta-price-tracker *>> $log

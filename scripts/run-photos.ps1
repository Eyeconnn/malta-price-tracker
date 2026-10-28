# Daytime photo catch-up for the local shops (config.runner = "local"): from 08:00 until midnight Malta time, at
# each shop's own pace, stopping per shop once nothing is left (src/cli/photos.ts).
# Run by Windows Task Scheduler ("MTP Daytime Photos"); logs go to out/photos-YYYY-MM-DD.log.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
New-Item -ItemType Directory -Force -Path (Join-Path $repo 'out') | Out-Null
$log = Join-Path $repo ("out\photos-" + (Get-Date -Format 'yyyy-MM-dd') + '.log')

# Start the cloud shops' morning run too: GitHub's own cron skipped or delayed it (27 Oct), and stays only as a
# backup. A run already going makes this one wait (concurrency group photos), and a shop with nothing left returns at once.
gh workflow run photos --repo Eyeconnn/malta-price-tracker *>> $log

$env:IMAGES_ENABLED = 'on'
pnpm photos --runner local --until 24:00 *>> $log

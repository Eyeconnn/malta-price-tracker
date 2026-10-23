# Nightly clean names (pnpm normalise-names) for new or changed product groups, after the 02:30 local scrape.
# Run by Windows Task Scheduler ("MTP Name Normaliser", scripts/install-tasks.ps1) from the main checkout; the scrape
# task has already pulled, installed and migrated. Claude runs on the owner's own login (never an API key).
# Caps per night: at most 400 batches and about 5 dollars of reported cost; change them in the command below.
# Logs go to out/names/nightly-YYYY-MM-DD.log; the task result is the script's exit code.
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
New-Item -ItemType Directory -Force -Path (Join-Path $repo 'out\names') | Out-Null
$log = Join-Path $repo ("out\names\nightly-" + (Get-Date -Format 'yyyy-MM-dd') + '.log')

"=== start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" *>> $log
pnpm normalise-names --model haiku --effort low --max-batches 400 --max-cost 5 --parallel 3 *>> $log
$code = $LASTEXITCODE
"=== end $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') exit $code" *>> $log
exit $code

# Nightly clean names (pnpm normalise-names) and product match judging (pnpm judge-matches) for new or changed
# product groups, after the 02:30 local scrape.
# Run by Windows Task Scheduler ("MTP Name Normaliser", scripts/install-tasks.ps1) from the main checkout; the scrape
# task has already pulled, installed and migrated. Claude runs on the owner's own login (never an API key).
# Caps per night: names at most 400 batches and about 5 dollars of reported cost; judging at most 200 batches and
# about 3 dollars. Change them in the commands below. Judging uses Sonnet at medium effort (owner decision 29 Oct:
# Haiku kept too many listings of one product apart), the same as the full re-judge of that day.
# Judging ends with the merge pass (clusters judged apart that look like one product, src/match/merge.ts) within the
# same caps; to switch it off add --no-merge-pass to the judge-matches line.
# Logs go to out/names/nightly-YYYY-MM-DD.log; the task result is the first failing exit code (0 when both pass).
$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
New-Item -ItemType Directory -Force -Path (Join-Path $repo 'out\names') | Out-Null
$log = Join-Path $repo ("out\names\nightly-" + (Get-Date -Format 'yyyy-MM-dd') + '.log')

"=== start $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" *>> $log
pnpm normalise-names --model haiku --effort high --max-batches 400 --max-cost 5 --parallel 3 *>> $log
$code = $LASTEXITCODE
"=== names exit $code; judging $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" *>> $log
pnpm judge-matches --model sonnet --effort medium --max-batches 200 --max-cost 3 --parallel 3 *>> $log
$judge = $LASTEXITCODE
if ($code -eq 0) { $code = $judge }
"=== end $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') exit $code" *>> $log
exit $code

# Creates (or replaces) the Windows scheduled tasks that run the local part of the price tracker.
#   MTP Nightly Local Scrape  every night 02:30, wakes the PC, catches up if the PC was off (at most 5 hours:
#                             Gamebreaker at its 10 s gap needs about 1h45 to scrape plus up to 2h10 for photos)
#   MTP Hourly Local Rechecks hourly at :41 from 1 Nov 2026 (adaptive re-checks for local shops)
#   MTP Shop Requests         every 15 minutes, hidden window: checks shops added on the admin Add shop page
#                             (does not wake the PC; a run that is still going makes the next one skip)
#   MTP Name Normaliser       every day 05:00 (after the scrape), hidden window, clean names for new or changed
#                             groups, capped by batches and cost (does not wake the PC; at most 4 hours)
#   MTP Daytime Photos        every day 08:00 until midnight, hidden window: the product photos of local shops the
#                             nightly scrape had no time for, at each shop's own pace (does not wake the PC)
# Run from the main checkout (the tasks run the scripts of the checkout this file is in):
#   powershell -ExecutionPolicy Bypass -File scripts\install-tasks.ps1
# Remove: Unregister-ScheduledTask -TaskName 'MTP Nightly Local Scrape','MTP Hourly Local Rechecks','MTP Shop Requests','MTP Name Normaliser','MTP Daytime Photos'
$repo = Split-Path -Parent $PSScriptRoot
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

function Install($name, $script, $trigger, $limit, [switch]$Hidden, [switch]$NoWake,
  $description = 'Malta price tracker (MTPIndex): local scrape of shops that refuse GitHub Actions IPs') {
  $window = if ($Hidden) { '-WindowStyle Hidden ' } else { '' }
  $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile $window-ExecutionPolicy Bypass -File `"$repo\scripts\$script`"" -WorkingDirectory $repo
  $options = @{
    StartWhenAvailable = $true
    AllowStartIfOnBatteries = $true
    DontStopIfGoingOnBatteries = $true
    ExecutionTimeLimit = $limit
    MultipleInstances = 'IgnoreNew'
  }
  if (-not $NoWake) { $options.WakeToRun = $true }
  if ($Hidden) { $options.Hidden = $true }
  $settings = New-ScheduledTaskSettingsSet @options
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
    -Description $description -Force | Out-Null
  Get-ScheduledTask -TaskName $name | Select-Object TaskName, State
}

Install 'MTP Nightly Local Scrape' 'run-local.ps1' (New-ScheduledTaskTrigger -Daily -At '02:30') (New-TimeSpan -Hours 5)

$hourly = New-ScheduledTaskTrigger -Once -At ([datetime]'2026-11-01T00:41:00') -RepetitionInterval (New-TimeSpan -Hours 1)
Install 'MTP Hourly Local Rechecks' 'run-local-due.ps1' $hourly (New-TimeSpan -Minutes 55)

# a check of up to 20 shops at the polite pace can take a while; overlapping runs are skipped (IgnoreNew,
# and pnpm shop-requests also takes a database lock)
$quarterly = New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddMinutes(7)) -RepetitionInterval (New-TimeSpan -Minutes 15)
Install 'MTP Shop Requests' 'run-shop-requests.ps1' $quarterly (New-TimeSpan -Hours 2) -Hidden -NoWake -description 'Malta price tracker (MTPIndex): checks shops added on the admin Add shop page'

Install 'MTP Name Normaliser' 'run-names-nightly.ps1' (New-ScheduledTaskTrigger -Daily -At '05:00') (New-TimeSpan -Hours 4) -Hidden -NoWake `
  -description 'Malta price tracker (MTPIndex): nightly clean product names with Claude Code (capped by batches and cost)'

# the photo catch-up stops itself at midnight Malta time (pnpm photos --until 24:00); 16 hours is a backstop
Install 'MTP Daytime Photos' 'run-photos.ps1' (New-ScheduledTaskTrigger -Daily -At '08:00') (New-TimeSpan -Hours 16) -Hidden -NoWake `
  -description 'Malta price tracker (MTPIndex): daytime catch-up of product photos for local shops, at each shop''s own pace'

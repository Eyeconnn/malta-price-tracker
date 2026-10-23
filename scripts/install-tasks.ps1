# Creates (or replaces) the Windows scheduled tasks that run the local part of the price tracker.
#   MTP Nightly Local Scrape  every night 02:30, wakes the PC, catches up if the PC was off
#   MTP Hourly Local Rechecks hourly at :41 from 1 Nov 2026 (adaptive re-checks for local shops)
#   MTP Name Normaliser       every day 05:00 (after the scrape), clean names for new or changed groups, capped
# Run:  powershell -ExecutionPolicy Bypass -File scripts\install-tasks.ps1
# Remove: Unregister-ScheduledTask -TaskName 'MTP Nightly Local Scrape','MTP Hourly Local Rechecks','MTP Name Normaliser'
$repo = Split-Path -Parent $PSScriptRoot
$ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

function Install($name, $script, $trigger, $limit, [switch]$Hidden,
  $description = 'Malta price tracker (MTPIndex): local scrape of shops that refuse GitHub Actions IPs') {
  $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$repo\scripts\$script`"" -WorkingDirectory $repo
  $settings = New-ScheduledTaskSettingsSet -WakeToRun -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit $limit -MultipleInstances IgnoreNew -Hidden:$Hidden
  Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings `
    -Description $description -Force | Out-Null
  Get-ScheduledTask -TaskName $name | Select-Object TaskName, State
}

Install 'MTP Nightly Local Scrape' 'run-local.ps1' (New-ScheduledTaskTrigger -Daily -At '02:30') (New-TimeSpan -Hours 4)

$hourly = New-ScheduledTaskTrigger -Once -At ([datetime]'2026-11-01T00:41:00') -RepetitionInterval (New-TimeSpan -Hours 1)
Install 'MTP Hourly Local Rechecks' 'run-local-due.ps1' $hourly (New-TimeSpan -Minutes 55)

Install 'MTP Name Normaliser' 'run-names-nightly.ps1' (New-ScheduledTaskTrigger -Daily -At '05:00') (New-TimeSpan -Hours 4) -Hidden `
  -description 'Malta price tracker (MTPIndex): nightly clean product names with Claude Code (capped by batches and cost)'

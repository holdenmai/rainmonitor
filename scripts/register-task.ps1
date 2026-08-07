<#
  Registers a daily Windows Scheduled Task that pulls yesterday's rainfall.

  Run once, from an elevated PowerShell prompt:
      powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1

  Remove with:
      Unregister-ScheduledTask -TaskName "RainMonitor Ingest" -Confirm:$false
#>
param(
  [string]$Time     = "07:15",
  [string]$TaskName = "RainMonitor Ingest"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source

if (-not (Test-Path (Join-Path $repo "src\cli.js"))) {
  throw "Could not find src\cli.js under $repo"
}

# 7:15 local is deliberate: COOP observers report at 7am, the RFC QPE daily
# product closes at 12Z, and the upstream analyses need a few minutes to publish.
#
# Most sources re-fetch the last `revisitDays`, so a missed run self-heals. Two
# do NOT, because they publish no archive: RFC QPE (a missed day is gone) and the
# on-farm Davis NOAAMO report (a missed month is gone). Keep this task enabled.
$action  = New-ScheduledTaskAction -Execute $node -Argument "src\cli.js ingest" -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
              -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
              -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Description "Pull daily rainfall for farm fields" -Force | Out-Null

Write-Host "Registered '$TaskName' to run daily at $Time"
Write-Host "  node:    $node"
Write-Host "  workdir: $repo"
Write-Host "Run it now with:  Start-ScheduledTask -TaskName '$TaskName'"

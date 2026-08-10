<#
  One-time setup for Rain Monitor. Run it by double-clicking Setup.cmd.

  It does the four things that otherwise have to be typed at a command prompt:

    1. checks Node is installed and new enough
    2. creates config.json
    3. registers the dashboard to start at login, so it is always there
    4. puts a "Rain Monitor" shortcut on the desktop

  There is deliberately no scheduled task for the daily pull. The dashboard
  does its own collection while it runs, and since step 3 starts it at login,
  a second scheduler would be a second thing to break. `-IngestTask` adds one
  anyway for a machine that is left logged out.

  Undo everything with:  Setup.cmd -Remove
#>
param(
  [switch]$Remove,        # unregister the task and delete the shortcut
  [switch]$NoAutoStart,   # skip the start-at-login task
  [switch]$IngestTask,    # also register a daily ingest task (for logged-out machines)
  [switch]$NoBrowser,     # do not open the dashboard at the end
  [string]$TaskName = "Rain Monitor Dashboard",
  [string]$IngestTaskName = "RainMonitor Ingest"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$shortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Rain Monitor.url"

function Say  ($m) { Write-Host $m }
function Good ($m) { Write-Host "  [ok] $m" -ForegroundColor Green }
function Warn ($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }

Say ""
Say "Rain Monitor setup"
Say "=================="
Say ""

# ---------------------------------------------------------------- remove
if ($Remove) {
  foreach ($t in @($TaskName, $IngestTaskName)) {
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $t -Confirm:$false
      Good "removed scheduled task '$t'"
    }
  }
  if (Test-Path $shortcut) { Remove-Item $shortcut -Force; Good "removed the desktop shortcut" }
  Say ""
  Say "Rain Monitor will no longer start on its own."
  Say "Your data in data\rain.db and your setup in config.json were NOT touched."
  Say ""
  return
}

# ---------------------------------------------------------------- node
# The version gate is real: node:sqlite ships in 22.5, and without it every
# command fails with a module-not-found error that says nothing about Node.
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  Warn "Node.js is not installed."
  Say ""
  Say "  Rain Monitor needs Node.js 22.5 or newer. It is a free download:"
  Say "    https://nodejs.org  ->  the LTS button"
  Say ""
  Say "  Install it, then double-click Setup.cmd again."
  Say ""
  exit 1
}
$vRaw = (& node --version).Trim()
$v = [Version]($vRaw.TrimStart('v'))
if ($v -lt [Version]"22.5.0") {
  Warn "Node.js $vRaw is too old -- 22.5 or newer is required."
  Say  "  Update from https://nodejs.org, then run Setup.cmd again."
  Say ""
  exit 1
}
Good "Node.js $vRaw at $($node.Source)"

# ---------------------------------------------------------------- config
Push-Location $repo
try {
  $existed = Test-Path (Join-Path $repo "config.json")
  & node "src\cli.js" init | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not create config.json" }
  Good $(if ($existed) { "config.json already existed -- left alone" } else { "created config.json" })
} finally {
  Pop-Location
}

# ---------------------------------------------------------------- port
$port = 8787
try {
  $cfg = Get-Content (Join-Path $repo "config.json") -Raw | ConvertFrom-Json
  if ($cfg.server.port) { $port = [int]$cfg.server.port }
} catch { }
$url = "http://127.0.0.1:$port"

# ---------------------------------------------------------------- autostart
if (-not $NoAutoStart) {
  # At logon rather than at boot, and as this user: the dashboard writes
  # config.json in this folder, and running it as SYSTEM would leave files the
  # signed-in user cannot edit.
  $action = New-ScheduledTaskAction -Execute $node.Source -Argument "src\server.js" -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5) `
                -MultipleInstances IgnoreNew
  # ExecutionTimeLimit zero means "no limit" -- this one is meant to stay running.
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description "Runs the Rain Monitor dashboard and its daily rainfall collection" -Force | Out-Null
  Good "the dashboard will start automatically when you log in"
} else {
  Warn "skipped start-at-login (-NoAutoStart)"
}

if ($IngestTask) {
  $ia = New-ScheduledTaskAction -Execute $node.Source -Argument "src\cli.js ingest" -WorkingDirectory $repo
  $it = New-ScheduledTaskTrigger -Daily -At "07:15"
  $is = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
          -ExecutionTimeLimit (New-TimeSpan -Hours 1)
  Register-ScheduledTask -TaskName $IngestTaskName -Action $ia -Trigger $it -Settings $is `
    -Description "Pull daily rainfall even when nobody is logged in" -Force | Out-Null
  Good "daily rainfall pull registered for 07:15, logged in or not"
}

# ---------------------------------------------------------------- shortcut
# A .url file, not a .lnk: no COM, no WScript.Shell, and it opens in whatever
# browser the machine already prefers.
@"
[InternetShortcut]
URL=$url
IconIndex=0
"@ | Set-Content -Path $shortcut -Encoding ASCII
Good "put a 'Rain Monitor' shortcut on your desktop"

# ---------------------------------------------------------------- start it
$running = $false
try {
  $probe = Invoke-WebRequest -Uri "$url/api/fields" -TimeoutSec 3 -UseBasicParsing
  $running = ($probe.StatusCode -eq 200)
} catch { }

if ($running) {
  Good "the dashboard is already running at $url"
} else {
  Start-Process -FilePath $node.Source -ArgumentList "src\server.js" -WorkingDirectory $repo -WindowStyle Hidden
  Start-Sleep -Seconds 3
  try {
    $probe = Invoke-WebRequest -Uri "$url/api/fields" -TimeoutSec 5 -UseBasicParsing
    if ($probe.StatusCode -eq 200) { Good "started the dashboard at $url" }
  } catch {
    Warn "the dashboard did not answer at $url yet -- give it a moment and open the desktop shortcut"
  }
}

Say ""
Say "Done. What happens from here:"
Say ""
Say "  * The dashboard runs at $url and starts itself when you log in."
Say "  * It pulls new rainfall on its own -- every 15 minutes it checks whether"
Say "    the record has gone stale, so a computer that was off catches up."
Say "  * Open it from the 'Rain Monitor' shortcut on your desktop."
Say ""
Say "  Next: open it and replace the example fields under 'Fields' with your own."
Say "  Each field you add maps its own gauges and pulls its own history."
Say ""
Say "  To undo all of this:  Setup.cmd -Remove"
Say ""

if (-not $NoBrowser) { Start-Process $url }

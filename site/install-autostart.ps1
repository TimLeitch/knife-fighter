# Makes the Kaotic Gaming site start by itself (hidden, in the background) every time you sign in
# to Windows, and restart within a minute if it ever stops. No administrator rights needed.
# Run it: right-click this file -> "Run with PowerShell".  Undo it: run remove-autostart.ps1.
$ErrorActionPreference = 'Stop'
$site = $PSScriptRoot
$node = 'C:\Program Files\nodejs\node.exe'
$dataDir = Join-Path $env:LOCALAPPDATA 'KaoticGaming'
$log = Join-Path $dataDir 'site.log'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$cmd = "Set-Location -LiteralPath '$site'; & '$node' server.js *>> '$log'"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"$cmd`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName 'Kaotic Gaming site' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force `
  -Description 'Runs a local copy of the Kaotic Gaming site (node server.js) on port 8088. Remove with remove-autostart.ps1.' | Out-Null

# start it now too (if the site is already running in another window, this copy just exits: the port is taken)
Start-ScheduledTask -TaskName 'Kaotic Gaming site'
Write-Host "Done. The site now starts by itself when you sign in to Windows." -ForegroundColor Green
Write-Host "Log file: $log"
Read-Host 'Press Enter to close'

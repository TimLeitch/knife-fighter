# Stops the Kaotic Gaming site from starting by itself at sign-in (undoes install-autostart.ps1).
# Run it: right-click this file -> "Run with PowerShell".
Stop-ScheduledTask -TaskName 'Kaotic Gaming site' -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName 'Kaotic Gaming site' -Confirm:$false -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host 'Removed. The site no longer starts by itself (and has been stopped).' -ForegroundColor Yellow
Read-Host 'Press Enter to close'

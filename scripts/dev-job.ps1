# huabu dev launcher (called by start.bat):
# - spawns "cmd /c pnpm dev" in the same console so logs are visible
# - spawns a hidden detached watchdog (dev-watch.ps1) that kills the whole dev tree
#   when the console window is closed (electron is a GUI process and would otherwise
#   survive the console closing as an orphan)
$ErrorActionPreference = 'Stop'

# repo root (this script lives in scripts/)
Set-Location (Join-Path $PSScriptRoot '..')

$dev = Start-Process cmd.exe -ArgumentList '/c pnpm dev' -WorkingDirectory (Get-Location).Path -PassThru

$watchArgs = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -WatchPid {1} -DevPid {2}' -f `
  (Join-Path $PSScriptRoot 'dev-watch.ps1'), $PID, $dev.Id
Start-Process powershell.exe -ArgumentList $watchArgs -WindowStyle Hidden

# foreground: keep this console attached to the dev run until it exits
$dev.WaitForExit()
exit $dev.ExitCode

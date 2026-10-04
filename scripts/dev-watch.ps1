# huabu dev watchdog (detached): kills the whole dev process tree when the console
# host dies. Launched hidden by dev-job.ps1; survives the console window closing.
param(
  [int]$WatchPid,   # pid of the dev-job.ps1 powershell host (dies when console closes)
  [int]$DevPid      # pid of the "cmd /c pnpm dev" root process
)
while ($true) {
  $host1 = Get-Process -Id $WatchPid -ErrorAction SilentlyContinue
  $dev = Get-Process -Id $DevPid -ErrorAction SilentlyContinue
  if (-not $host1) {
    # console window closed / host killed: dev tree may have orphans (electron is a
    # GUI process and does not die with the console) -> kill the whole tree
    if ($dev) { taskkill /F /T /PID $DevPid | Out-Null }
    break
  }
  if (-not $dev) { break } # dev exited normally (app window closed); nothing to kill
  Start-Sleep -Milliseconds 800
}

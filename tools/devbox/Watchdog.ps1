#Requires -Version 5.1
<#
  Watchdog.ps1 - is the dev loop still moving, or is something stuck?

  Every `-IntervalMinutes` (default 5) it appends one line to `temp/watchdog.log` with a
  fingerprint of the work in flight, and after three ticks that changed nothing it writes
  `temp/watchdog.alert` (deleted again as soon as a tick moves). Two signals, because a
  stall looks different depending on where it happened:

    local     HEAD, the porcelain status hash and `git diff HEAD --stat` - is code being edited?
    output    the total size of the opencode shell `.out` files - is the running command
              still printing? (this script never writes a tick to stdout, so an idle box
              holds this number still)
    remote    the long-lived processes on the devbox (vitest / tsc / deploy / helm / kubectl),
              with their ages - is a gate or a deploy still running, and has it been running
              for an implausible length of time?

  Run it in the background while a gate or a deploy runs:

      .\tools\devbox\Watchdog.ps1                     # 5 min, 4 h, then it prints a summary
      .\tools\devbox\Watchdog.ps1 -Hours 1
      .\tools\devbox\Watchdog.ps1 -Stop               # stop the one that is running

  It is read-only: no writes outside `temp/`, no ssh beyond one `ps` per tick.
#>
param(
  # How often a check happens.
  [int]$IntervalMinutes = 5,
  # How long the watchdog watches before printing its summary and exiting.
  [double]$Hours = 4,
  # Stop the watchdog started earlier (reads temp/watchdog.pid).
  [switch]$Stop
)

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tempDir = Join-Path $root 'temp'
$logPath = Join-Path $tempDir 'watchdog.log'
$alertPath = Join-Path $tempDir 'watchdog.alert'
$pidPath = Join-Path $tempDir 'watchdog.pid'
$shellDir = Join-Path $env:USERPROFILE '.local\share\opencode\shell'

if ($Stop) {
  if (-not (Test-Path $pidPath)) { Write-Host 'watchdog: nothing to stop (no temp/watchdog.pid)'; exit 0 }
  $old = (Get-Content $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($old) {
    try { Stop-Process -Id ([int]$old) -ErrorAction Stop; Write-Host "watchdog: stopped pid $old" }
    catch { Write-Host "watchdog: pid $old is gone already" }
  }
  Remove-Item $pidPath, $alertPath -ErrorAction SilentlyContinue
  exit 0
}

New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$PID | Set-Content -Path $pidPath -Encoding ascii
# A stale alert from an earlier run must not look like this run's verdict.
Remove-Item $alertPath -ErrorAction SilentlyContinue

$ErrorActionPreference = 'Continue'

function Get-TickData {
  $head = ((& git -C $root rev-parse --short HEAD) | Select-Object -First 1)
  $porcelain = (& git -C $root status --porcelain) -join "`n"
  $stat = ((& git -C $root diff HEAD --stat) | Select-Object -Last 1)
  $changed = @($porcelain -split "`n" | Where-Object { $_ -ne '' }).Count

  # Total bytes of everything the opencode shell has captured: it grows while a command prints.
  $outBytes = 0
  $outFiles = 0
  if (Test-Path $shellDir) {
    foreach ($f in Get-ChildItem -Path $shellDir -Recurse -File -Filter '*.out' -ErrorAction SilentlyContinue) {
      $outBytes += $f.Length
      $outFiles++
    }
  }

  # One `ps` on the devbox: the long-lived WORK, oldest first, as "<seconds> <command>".
  # Written without quotes or metacharacters: Windows ssh rebuilds the remote command line
  # from argv and drops quoting, so `grep -E "a|b"` arrives unquoted at the remote shell.
  # Long-lived servers (the demo stack's `pnpm --filter @manythreads/server start`) are
  # deliberately not matched: they are always there and say nothing about progress.
  $remoteCmd = 'ps -eo etimes=,args= | grep -e vitest -e tsc -e helm -e kubectl -e rsync -e deploy.sh -e buildx | grep -v grep | sort -rn | head -2'
  $remote = @()
  $remoteError = ''
  try {
    $remote = @(& ssh -o BatchMode=yes -o ConnectTimeout=8 devbox $remoteCmd)
  } catch {
    $remoteError = "ssh failed: $($_.Exception.Message)"
  }
  if ($remote.Count -eq 0 -and $LASTEXITCODE -ne 0) { $remoteError = "$remoteError (ssh exit $LASTEXITCODE)" }
  $remoteText = (@($remote | Where-Object { $_ -and $_.Trim() -ne '' }) -join ' ; ').Trim()
  $remoteOldest = 0
  foreach ($line in $remote) {
    $secs = ($line.Trim() -split '\s+')[0]
    if ($secs -match '^\d+$' -and [int]$secs -gt $remoteOldest) { $remoteOldest = [int]$secs }
  }

  $sig = "$head|$changed|$outBytes|$remoteText"
  [pscustomobject]@{
    Head = $head
    Changed = $changed
    Stat = $stat
    OutBytes = $outBytes
    OutFiles = $outFiles
    Remote = $remoteText
    RemoteOldest = $remoteOldest
    RemoteError = $remoteError
    Sig = $sig
  }
}

function Write-Line([string]$text) {
  "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) $text" | Add-Content -Path $logPath -Encoding utf8
}

function Write-Alert([string]$text) {
  "ALERT $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) $text" | Set-Content -Path $alertPath -Encoding utf8
  Write-Line "*** ALERT *** $text"
}

# Two thresholds, because the two stalls need different words: nothing running anywhere
# (the loop stopped), and a remote command that stopped printing (a hang).
$idleLimit = 3            # 3 ticks x 5 min = 15 min of no local change and no output growth
$runningLimit = 6         # 30 min with a remote command alive and nothing new to show for it
$slowSeconds = 1800       # a remote process older than this is named even while it prints

$deadline = (Get-Date).AddHours($Hours)
$interval = [Math]::Max(1, $IntervalMinutes) * 60
$ticks = 0
$alerts = 0
$previous = $null
$lastAlertSig = ''
$stagnant = 0
$started = Get-Date

Write-Host "watchdog: every $IntervalMinutes min for $Hours h; log $logPath; alert $alertPath"
Write-Line "watchdog started (pid $PID, every $IntervalMinutes min, $Hours h)"

while ((Get-Date) -lt $deadline) {
  $t = Get-TickData
  $ticks++

  if ($null -ne $previous -and $t.Sig -eq $previous.Sig) { $stagnant++ } else { $stagnant = 0 }
  $moving = ($stagnant -eq 0)
  if ($moving) {
    if (Test-Path $alertPath) { Remove-Item $alertPath -ErrorAction SilentlyContinue; Write-Line 'alert cleared: progress again' }
    $lastAlertSig = ''
  }

  $state = 'idle'
  if ($t.Remote -ne '') { $state = 'running' }
  $statText = ''
  if ($t.Stat) { $statText = " stat=[$($t.Stat)]" }
  Write-Line ("tick {0}: {1} head={2} changed={3} out={4}B/{5}f stagnant={6}min{7}" -f `
      $ticks, $state, $t.Head, $t.Changed, $t.OutBytes, $t.OutFiles, ($stagnant * $IntervalMinutes), $statText)
  if ($t.Remote -ne '') { Write-Line "        remote: $($t.Remote)" }
  if ($t.RemoteError -ne '') { Write-Line "        $($t.RemoteError)" }

  if ($t.RemoteOldest -gt $slowSeconds -and $t.Remote -ne '') {
    $mins = [int]($t.RemoteOldest / 60)
    Write-Line "*** WARN *** a remote process has run ${mins} min: $($t.Remote)"
  }

  if ($t.Sig -ne $lastAlertSig) {
    if ($state -eq 'idle' -and $stagnant -ge $idleLimit) {
      $alerts++
      $lastAlertSig = $t.Sig
      Write-Alert "no progress for $($stagnant * $IntervalMinutes) min: head=$($t.Head), changed=$($t.Changed), out=$($t.OutBytes)B, nothing running on the devbox. Check temp/watchdog.log and the last command's output."
    } elseif ($state -eq 'running' -and $stagnant -ge $runningLimit) {
      $alerts++
      $lastAlertSig = $t.Sig
      Write-Alert "no new output for $($stagnant * $IntervalMinutes) min while a remote command runs: $($t.Remote). It may be hung - check 'ssh devbox ps -eo etimes=,args= | grep vitest'."
    }
  }

  $previous = $t
  Start-Sleep -Seconds $interval
}

$last = Get-TickData
Write-Line "watchdog stopped after $ticks ticks ($([int]((Get-Date) - $started).TotalMinutes) min), $alerts alert(s)"
Write-Host "watchdog: $ticks ticks, $alerts alert(s); head=$($last.Head) changed=$($last.Changed) remote='$($last.Remote)'"
if (Test-Path $alertPath) { Write-Host "watchdog: STILL STALLED - see $alertPath" }
Remove-Item $pidPath -ErrorAction SilentlyContinue

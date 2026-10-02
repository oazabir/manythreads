# Shared by Sync-Up.ps1 / Sync-Down.ps1: rsync discovery, repo paths, exclude list.
# Dot-source from a script in this folder:  . "$PSScriptRoot\_common.ps1"
# Native Windows rsync only - no WSL. See WINDOWS_DEV.md for the one-time install.
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$RemoteRoot = 'devbox:/root/manythreads/'

# Files that never cross the wire: each side keeps its own (.git, node_modules),
# plus build output, caches, logs, local secrets and e2e scratch data.
# AGENTS.md is excluded because it is a symlink on Linux that a Windows checkout
# materializes as a regular file (its target, CLAUDE.md, syncs normally).
$SyncExcludes = @(
  '.git/', 'node_modules/', 'dist/', 'build/', '.turbo/', 'coverage/',
  '.vite/', 'playwright-report/', 'test-results/', '.screenshots-current/',
  '*.tsbuildinfo', '*.log', '.env', 'e2e/.auth/', 'e2e/data/', 'data/repos/',
  'AGENTS.md'
)

function Get-PosixPath([string]$WinPath) {
  # C:\a\b -> /c/a/b - msys2 tools read paths in POSIX form.
  $drive = $WinPath[0].ToString().ToLowerInvariant()
  $rest = $WinPath.Substring(2).TrimStart('\')   # drop "C:" and the leading backslash
  return "/$drive/" + ($rest -replace '\\', '/')
}

function Find-Rsync {
  $cmd = Get-Command rsync.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @('C:\msys64\usr\bin\rsync.exe', "$env:LOCALAPPDATA\msys64\usr\bin\rsync.exe")) {
    if (Test-Path $p) { return $p }
  }
  throw @"
rsync.exe not found. Install native rsync (no WSL needed):
  winget install MSYS2.MSYS2
  & C:\msys64\usr\bin\pacman.exe -S --noconfirm rsync openssh
See WINDOWS_DEV.md, section 'One-time setup'.
"@
}

function Get-SshCommand([string]$RsyncPath) {
  # The remote shell must be the MSYS2 ssh that ships next to rsync, NOT the Win32
  # C:\Windows\System32\OpenSSH\ssh.exe: an msys process spawns Win32 children with
  # msys pipe handles, Windows ssh fails reading its stdin ("channel 0: read failed"),
  # and the rsync protocol dies with "connection unexpectedly closed ... 0 bytes".
  $dir = Split-Path $RsyncPath
  $candidates = @((Join-Path $dir 'ssh.exe'), 'C:\msys64\usr\bin\ssh.exe', "$env:LOCALAPPDATA\msys64\usr\bin\ssh.exe")
  $ssh = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $ssh) {
    throw "MSYS2 ssh.exe not found. Install it next to rsync: & C:\msys64\usr\bin\pacman.exe -S --noconfirm openssh"
  }

  # msys2 ssh resolves ~ from its own passwd table (/home/<user>), so the Windows
  # ~/.ssh is not read automatically: point at config / known_hosts / keys directly.
  $winSshDir = Join-Path $env:USERPROFILE '.ssh'
  $sshDir = Get-PosixPath $winSshDir
  $e = (Get-PosixPath $ssh) +
       " -F $sshDir/config" +
       " -o UserKnownHostsFile=$sshDir/known_hosts" +
       ' -o BatchMode=yes -o StrictHostKeyChecking=accept-new'
  foreach ($k in @('id_ed25519', 'id_rsa', 'id_ecdsa')) {
    if (Test-Path (Join-Path $winSshDir $k)) { $e += " -i $sshDir/$k" }
  }
  return $e
}

function Invoke-Rsync([string]$Source, [string]$Destination, [switch]$Delete) {
  $rsync = Find-Rsync
  $ssh = Get-SshCommand $rsync
  $RsyncArgs = @('-az', '--no-perms', '--no-owner', '--no-group', '--stats', '-e', $ssh)
  if ($Delete) { $RsyncArgs += '--delete' }
  foreach ($x in $SyncExcludes) { $RsyncArgs += @('--exclude', $x) }
  $RsyncArgs += @($Source, $Destination)

  Write-Host "rsync: $rsync"
  & $rsync @RsyncArgs
  $code = $LASTEXITCODE
  if ($code -eq 24) {
    Write-Warning 'rsync: some files vanished during transfer (exit 24) - run the sync again.'
    return
  }
  if ($code -ne 0) { throw "rsync failed with exit code $code" }
}

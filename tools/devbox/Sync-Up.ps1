#Requires -Version 5.1
# Sync-Up: local working tree -> devbox /root/manythreads (native rsync over SSH).
# Copies file contents only; use git push/pull for commit history. Requires LF
# checkouts on both sides:  git config core.autocrlf false  (once per clone).
. "$PSScriptRoot\_common.ps1"

$src = (Get-PosixPath $RepoRoot) + '/'
Write-Host "sync-up $RepoRoot -> $RemoteRoot"
Invoke-Rsync -Source $src -Destination $RemoteRoot -Delete
Write-Host "sync-up done. Run remote steps with: .\tools\devbox\Remote.ps1 'pnpm lint'"

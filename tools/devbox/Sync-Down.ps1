#Requires -Version 5.1
# Sync-Down: devbox /root/manythreads -> local working tree (native rsync over SSH).
# Same excludes as Sync-Up; no --delete (local-only files are left alone). Use after
# remote-side edits or generated files you want back; rarely needed in the daily loop.
. "$PSScriptRoot\_common.ps1"

$dst = (Get-PosixPath $RepoRoot) + '/'
Write-Host "sync-down $RemoteRoot -> $RepoRoot"
Invoke-Rsync -Source $RemoteRoot -Destination $dst
Write-Host 'sync-down done.'

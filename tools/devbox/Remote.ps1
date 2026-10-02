#Requires -Version 5.1
<#
  Remote.ps1 - run one command on the devbox inside /root/manythreads.
  Sync first so the devbox sees your latest edits:

      .\tools\devbox\Sync-Up.ps1
      .\tools\devbox\Remote.ps1 "pnpm test --maxWorkers=3 -- --run test/markdown.test.ts"
      .\tools\devbox\Remote.ps1 "kubectl -n manythreads get pods"
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Command
)
$ErrorActionPreference = 'Stop'
ssh devbox "cd /root/manythreads && $Command"
if ($LASTEXITCODE -ne 0) { throw "remote command failed (exit $LASTEXITCODE)" }

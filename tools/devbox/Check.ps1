#Requires -Version 5.1
# Check.ps1 - the local Windows gates: ESLint + Stylelint and a full tsc pass.
# Runs entirely on this machine: no Docker, no SSH, no devbox needed. Takes ~1 min.
# Ship.ps1 calls this first; run it alone while iterating on a change.
$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

Push-Location $RepoRoot
try {
  Write-Host '== pnpm lint (eslint + stylelint)'
  pnpm lint
  if ($LASTEXITCODE -ne 0) { throw "lint failed (exit $LASTEXITCODE)" }

  Write-Host '== pnpm typecheck (tsc across all workspaces)'
  pnpm typecheck
  if ($LASTEXITCODE -ne 0) { throw "typecheck failed (exit $LASTEXITCODE)" }

  Write-Host 'local gates OK (lint + typecheck). Next: .\tools\devbox\Ship.ps1'
}
finally {
  Pop-Location
}

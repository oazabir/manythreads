#Requires -Version 5.1
<#
  Ship.ps1 - the full loop: local gates -> rsync -> devbox (install, lint, typecheck,
  tests, docker build, helm deploy to k3s) -> verify https://manythreads.kahf.to/

    .\tools\devbox\Ship.ps1                          # everything (tests included)
    .\tools\devbox\Ship.ps1 -SkipTests               # fast iteration: gates + deploy
    .\tools\devbox\Ship.ps1 -SkipDeploy              # stop after the remote gates
    .\tools\devbox\Ship.ps1 -ExpectString 'win-dev'  # also assert the site serves text

  Each stage fails fast with its own message. Switches: -SkipLocal, -SkipTests,
  -SkipDeploy, -ExpectString <text>. Full process: WINDOWS_DEV.md.
#>
param(
  [switch]$SkipLocal,
  [switch]$SkipTests,
  [switch]$SkipDeploy,
  [string]$ExpectString
)
$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$Site = 'https://manythreads.kahf.to'

function Stage([string]$Name) {
  Write-Host ''
  Write-Host "### $Name" -ForegroundColor Cyan
}
function Fail([string]$Msg, [int]$Code) {
  throw "FAILED: $Msg (exit $Code)"
}

# 1 - local gates: lint + typecheck on this machine ---------------------------
Stage 'local gates (pnpm lint + pnpm typecheck)'
if ($SkipLocal) { Write-Host 'skipped (-SkipLocal)' }
else {
  & (Join-Path $PSScriptRoot 'Check.ps1')
  if ($LASTEXITCODE -ne 0) { Fail 'local gates' $LASTEXITCODE }
}

# 2 - push the working tree to the devbox ------------------------------------
Stage 'sync working tree -> devbox:/root/manythreads'
& (Join-Path $PSScriptRoot 'Sync-Up.ps1')
if ($LASTEXITCODE -ne 0) { Fail 'sync-up' $LASTEXITCODE }

# 3 - remote gates: install, lint, typecheck, tests --------------------------
Stage 'remote gates on devbox (install + lint + typecheck + tests)'
$gates = 'cd /root/manythreads && bash tools/devbox/remote-gates.sh'
if ($SkipTests) { $gates += ' --no-tests' }
ssh devbox $gates
if ($LASTEXITCODE -ne 0) { Fail 'remote gates (see the failing stage above)' $LASTEXITCODE }

if ($SkipDeploy) {
  Stage 'deploy'
  Write-Host 'skipped (-SkipDeploy). Remote gates passed.'
  return
}

# 4 - build images and deploy to the local k3s --------------------------------
Stage 'deploy on devbox (docker build -> k3s import -> helm upgrade -> smoke test)'
ssh devbox 'cd /root/manythreads && bash tools/devbox/deploy.sh'
if ($LASTEXITCODE -ne 0) { Fail 'deploy.sh' $LASTEXITCODE }

# 5 - verify the live site -----------------------------------------------------
Stage "verify $Site"
$failed = $false

$code = ((& curl.exe -fsSk -o NUL -w '%{http_code}' "$Site/") -join '')
if ($LASTEXITCODE -ne 0 -or $code -ne '200') {
  Write-Host "  /            -> HTTP $(if ($code) { $code } else { "curl exit $LASTEXITCODE" }) (expected 200)" -ForegroundColor Red
  $failed = $true
}
else { Write-Host '  /            -> 200' }

foreach ($ep in @('/healthz', '/readyz')) {
  $body = ((& curl.exe -fsSk "$Site$ep") -join ' ')
  if ($LASTEXITCODE -ne 0) { Write-Host "  $ep -> FAILED" -ForegroundColor Red; $failed = $true }
  else { Write-Host "  $ep -> $body" }
}

if ($ExpectString) {
  $html = ((& curl.exe -fsSk "$Site/") -join "`n")
  if ($LASTEXITCODE -eq 0 -and $html.Contains($ExpectString)) {
    Write-Host "  content      -> found `"$ExpectString`""
  } else {
    Write-Host "  content      -> `"$ExpectString`" NOT in the served page" -ForegroundColor Red
    $failed = $true
  }
}

$serverImage = (ssh devbox "kubectl -n manythreads get deploy manythreads-server -o jsonpath='{.spec.template.spec.containers[0].image}'")
Write-Host "  deployed     -> $serverImage"
Write-Host ''
ssh devbox 'kubectl -n manythreads get pods --no-headers'

if ($failed) { throw 'FAILED: verification' }
Write-Host ''
Write-Host "SHIPPED - $Site is serving your working tree." -ForegroundColor Green

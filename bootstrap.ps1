param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Assert-Command($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "[coreConsole] error: '$name' is not installed or not on PATH"
  }
}

Write-Host "[coreConsole] bootstrap start"

Assert-Command "node"
Assert-Command "npm"

$nodeVersion = (node -v).Trim()
$nodeMajor = [int]((node -p "process.versions.node.split('.')[0]").Trim())
if ($nodeMajor -lt 20) {
  throw "[coreConsole] error: Node 20+ required (found $nodeVersion)"
}

Write-Host "[coreConsole] using node $nodeVersion, npm $((npm -v).Trim())"

Write-Host "[coreConsole] install root deps"
npm install

Write-Host "[coreConsole] install GUI deps"
npm --prefix GUI install

Write-Host "[coreConsole] install visa-addon deps"
npm --prefix packages/visa-addon install

Write-Host "[coreConsole] install visa-service deps"
npm --prefix packages/visa-service install

Write-Host "[coreConsole] build visa-addon"
npm --prefix packages/visa-addon run build

Write-Host "[coreConsole] check visa-service"
npm run visa:service:check

if (-not $SkipBuild) {
  Write-Host "[coreConsole] build GUI renderer"
  npm run build
}

Write-Host "[coreConsole] bootstrap complete"
Write-Host "Next: npm run dev"

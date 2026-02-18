param(
  [string]$Resource = "",
  [string]$Command = "*IDN?",
  [int]$TimeoutMs = 3000,
  [switch]$ListOnly,
  [switch]$Mock
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..\..")
Set-Location $repoRoot

if (-not (Test-Path "packages\visa-service\node_modules")) {
  npm --prefix packages/visa-service install
}

$script = "packages/visa-service/examples/visa_smoke.js"
$args = @($script, "--command", "$Command", "--timeout-ms", "$TimeoutMs")
if ($Resource -ne "") { $args += @("--resource", $Resource) }
if ($ListOnly) { $args += "--list-only" }
if ($Mock) { $args += "--mock" }

Write-Host "Running VISA smoke test..."
node @args

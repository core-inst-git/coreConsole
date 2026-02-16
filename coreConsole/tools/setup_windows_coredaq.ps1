param(
    [string]$EnvName = "coreDAQ",
    [string]$PythonVersion = "3.11",
    [switch]$InstallNodeIfMissing,
    [switch]$RunBuild,
    [switch]$RunDev
)

$ErrorActionPreference = "Stop"

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Invoke-External([string]$Exe, [string[]]$Args) {
    & $Exe @Args
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed ($LASTEXITCODE): $Exe $($Args -join ' ')"
    }
}

function Find-CondaExe {
    if ($env:CONDA_EXE -and (Test-Path $env:CONDA_EXE)) {
        return $env:CONDA_EXE
    }

    $condaCmd = Get-Command conda -ErrorAction SilentlyContinue
    if ($condaCmd) {
        return $condaCmd.Source
    }

    return $null
}

function Ensure-Node {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue

    if (-not $nodeCmd -or -not $npmCmd) {
        if ($InstallNodeIfMissing) {
            $winget = Get-Command winget -ErrorAction SilentlyContinue
            if (-not $winget) {
                throw "Node.js/npm are missing and winget is unavailable. Install Node.js LTS manually."
            }

            Write-Step "Installing Node.js LTS via winget"
            Invoke-External $winget.Source @("install", "--id", "OpenJS.NodeJS.LTS", "--source", "winget", "--silent")

            $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                        [System.Environment]::GetEnvironmentVariable("Path", "User")
        } else {
            throw "Node.js/npm not found. Install Node.js LTS first or rerun with -InstallNodeIfMissing."
        }
    }

    $nodeVersion = (& node -v).Trim()
    if (-not $nodeVersion) {
        throw "Unable to read Node.js version."
    }
    $major = [int]($nodeVersion.TrimStart("v").Split(".")[0])
    if ($major -lt 18) {
        throw "Node.js $nodeVersion detected. Use Node.js 18+ (20 LTS recommended)."
    }

    Write-Host "Node.js: $nodeVersion"
    Write-Host "npm:     $((& npm -v).Trim())"
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$GuiDir = Join-Path $RepoRoot "GUI"
$ReqPath = Join-Path $GuiDir "backend\requirements.txt"

if (-not (Test-Path (Join-Path $GuiDir "package.json"))) {
    throw "Cannot find GUI/package.json. Run this script from the coreConsole repo."
}
if (-not (Test-Path $ReqPath)) {
    throw "Cannot find backend requirements at: $ReqPath"
}

$CondaExe = Find-CondaExe
if (-not $CondaExe) {
    throw "Conda not found. Open Anaconda Prompt, then run: powershell -ExecutionPolicy Bypass -File .\tools\setup_windows_coredaq.ps1"
}

Write-Step "Using conda executable: $CondaExe"

Write-Step "Checking conda environment '$EnvName'"
$envListJson = & $CondaExe env list --json
if ($LASTEXITCODE -ne 0) {
    throw "Unable to list conda environments."
}
$envList = $envListJson | ConvertFrom-Json
$envExists = $false
foreach ($path in $envList.envs) {
    if ([System.IO.Path]::GetFileName($path).ToLowerInvariant() -eq $EnvName.ToLowerInvariant()) {
        $envExists = $true
        break
    }
}

if (-not $envExists) {
    Write-Step "Creating conda environment '$EnvName' (python=$PythonVersion)"
    Invoke-External $CondaExe @("create", "-n", $EnvName, "-y", "python=$PythonVersion")
} else {
    Write-Host "Environment '$EnvName' already exists."
}

Write-Step "Installing Python dependencies in conda env '$EnvName'"
Invoke-External $CondaExe @("run", "-n", $EnvName, "python", "-m", "pip", "install", "--upgrade", "pip")
Invoke-External $CondaExe @("run", "-n", $EnvName, "python", "-m", "pip", "install", "-r", $ReqPath, "h5py", "numpy", "matplotlib")

Write-Step "Checking Node.js/npm"
Ensure-Node

Write-Step "Installing GUI npm dependencies"
$env:ELECTRON_CACHE = Join-Path $GuiDir ".electron-cache"
$env:ELECTRON_BUILDER_CACHE = Join-Path $GuiDir ".electron-builder-cache"
New-Item -ItemType Directory -Force -Path $env:ELECTRON_CACHE | Out-Null
New-Item -ItemType Directory -Force -Path $env:ELECTRON_BUILDER_CACHE | Out-Null

Push-Location $GuiDir
try {
    Invoke-External "npm" @("install")

    $pyExe = (& $CondaExe run -n $EnvName python -c "import sys; print(sys.executable)").Trim()
    if (-not $pyExe) {
        throw "Unable to resolve Python executable for env '$EnvName'."
    }
    $env:COREDAQ_PYTHON = $pyExe
    Write-Host "COREDAQ_PYTHON=$pyExe"
    try {
        & setx COREDAQ_PYTHON "$pyExe" | Out-Null
        Write-Host "Persisted COREDAQ_PYTHON for future terminals."
    } catch {
        Write-Host "Warning: could not persist COREDAQ_PYTHON with setx." -ForegroundColor Yellow
    }

    if ($RunBuild) {
        Write-Step "Running npm build"
        Invoke-External "npm" @("run", "build")
    }

    if ($RunDev) {
        Write-Step "Running npm dev"
        & npm run dev
    } else {
        Write-Step "Setup complete"
        Write-Host "Next commands:"
        Write-Host "  cd GUI"
        Write-Host "  `$env:COREDAQ_PYTHON = '$pyExe'"
        Write-Host "  npm run build"
        Write-Host "  npm run dev"
        Write-Host ""
        Write-Host "If you open a new terminal/VS Code window, COREDAQ_PYTHON is already set via setx."
    }
}
finally {
    Pop-Location
}

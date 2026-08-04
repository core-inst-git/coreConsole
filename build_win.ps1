# ============================================================================
# coreConsole Windows build — renderer + Python backend (PyInstaller) + NSIS/zip
#
# Usage:   powershell -ExecutionPolicy Bypass -File .\build_win.ps1
# Output:  GUI\release\coreConsole Setup <version>.exe  (+ .zip)
#
# Prereqs: node 20+, npm 10+, Python 3.10+ ("python" or the "py" launcher).
# The Python backend is bundled as a self-contained PyInstaller binary, so the
# target machine needs NO Python install. Build on Windows for Windows.
# ============================================================================
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# ----- resolve python ------------------------------------------------------
$py = $null
foreach ($cand in @('python', 'py')) {
  if (Get-Command $cand -ErrorAction SilentlyContinue) { $py = $cand; break }
}
if (-not $py) { throw 'Python not found on PATH (install Python 3.10+)' }
if ($py -eq 'py') { $pyArgs = @('-3') } else { $pyArgs = @() }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'node not found on PATH' }
Write-Host "node $(node --version) | npm $(npm --version) | $(& $py @pyArgs --version)"

# ----- 1. Python deps + PyInstaller ---------------------------------------
Write-Host '==> Installing Python backend dependencies'
& $py @pyArgs -m pip install --quiet -r GUI\backend\requirements.txt
& $py @pyArgs -m pip install --quiet pyinstaller

# ----- 2. Node deps ---------------------------------------------------------
if (-not (Test-Path GUI\node_modules)) {
  Write-Host '==> Installing GUI node modules'
  npm --prefix GUI ci
  if ($LASTEXITCODE -ne 0) { npm --prefix GUI install }
}

# ----- 3. Backend binary (PyInstaller onedir) -------------------------------
# --paths: resolve the py_coreDAQ package location explicitly (needed for pip
# editable installs, harmless otherwise).
Write-Host '==> Building backend binary (PyInstaller)'
$pyd = & $py @pyArgs -c 'import py_coreDAQ, os; print(os.path.dirname(os.path.dirname(py_coreDAQ.__file__)))'
Push-Location GUI\backend
# --exclude-module: keep GUI/plotting stacks out of the frozen backend (h5py/
# numpy dependency scans can chase into installed Qt/matplotlib and abort or
# bloat the build).
& $py @pyArgs -m PyInstaller --noconfirm --clean --onedir `
  --name coredaq-backend `
  --paths "$pyd" `
  --collect-submodules py_coreDAQ `
  --exclude-module PyQt5 --exclude-module PyQt6 `
  --exclude-module PySide2 --exclude-module PySide6 `
  --exclude-module matplotlib --exclude-module IPython `
  --exclude-module pandas --exclude-module scipy --exclude-module tkinter `
  --distpath dist `
  --workpath "$env:TEMP\coredaq-pyi-build" `
  --specpath "$env:TEMP\coredaq-pyi-build" `
  coredaq_service.py
Pop-Location
if (-not (Test-Path GUI\backend\dist\coredaq-backend\coredaq-backend.exe)) {
  throw 'PyInstaller build failed: coredaq-backend.exe not found'
}

# ----- 4. Smoke-test the binary ---------------------------------------------
Write-Host '==> Smoke-testing backend binary (simulator on :8899)'
$proc = Start-Process -FilePath GUI\backend\dist\coredaq-backend\coredaq-backend.exe `
  -ArgumentList '--simulator', '--ws-port', '8899' -PassThru -WindowStyle Hidden
$ok = $false
foreach ($i in 1..30) {
  Start-Sleep -Seconds 1
  if ((Test-NetConnection -ComputerName 127.0.0.1 -Port 8899 -WarningAction SilentlyContinue).TcpTestSucceeded) {
    $ok = $true; break
  }
}
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
if (-not $ok) { throw 'backend binary failed to start listening on :8899' }
Write-Host '    backend binary OK'

# ----- 5. Renderer + electron-builder ---------------------------------------
Write-Host '==> Building renderer'
npm --prefix GUI run build:renderer
if ($LASTEXITCODE -ne 0) { throw 'renderer build failed' }

Write-Host '==> Packaging (electron-builder)'
Push-Location GUI
npx electron-builder --win --x64
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'electron-builder failed' }
Pop-Location

Write-Host ''
Write-Host 'Done. Artifacts:'
Get-ChildItem GUI\release\*.exe, GUI\release\*.zip -ErrorAction SilentlyContinue | Format-Table Name, Length

# coreConsole Windows 10 Build Guide

This guide builds `coreConsole` (Electron GUI + Python backend) into a Windows executable package.
It also includes the optional NI-VISA GPIB stack (`visa-addon` + `visa-service`).

## 1) Prerequisites

- Windows 10 x64
- Git
- Miniconda or Anaconda (recommended)
- nvm-windows (recommended)

Required runtime versions:
- Node.js `20.x` (LTS)
- npm `10.x`
- Python `3.11`

## 2) Open terminal and go to repo

Use **Anaconda Prompt** or **PowerShell**:

```bat
cd C:\path\to\coreDev\coreConsole
```

## 3) Select Node 20

```bat
nvm install 20.20.0
nvm use 20.20.0
node -v
npm -v
```

Expected: Node `v20.x`, npm `10.x`.

## 4) Create Python env and install backend deps

```bat
conda create -n coreDAQ python=3.11 -y
conda activate coreDAQ
python -m pip install --upgrade pip
python -m pip install -r GUI\backend\requirements.txt pyinstaller
```

## 5) Install Node dependencies

From repo root:

```bat
npm install
npm --prefix GUI install
npm --prefix packages\visa-addon install
npm --prefix packages\visa-service install
```

## 6) Build Python backend EXE

```bat
cd GUI\backend
python -m PyInstaller --clean --noconfirm --onefile --name coredaq_service coredaq_service.py
copy /Y dist\coredaq_service.exe bin\coredaq_service.exe
cd ..\..
```

Verify:

```bat
dir GUI\backend\bin\coredaq_service.exe
```

## 7) Build Windows app package

### Installer build (NSIS + zip)

```bat
npm run dist:win
```

### Portable single EXE build

```bat
npm run dist:win:portable
```

## 8) Build NI-VISA native addon (for GPIB support)

> Required only if you need GPIB from Electron.

Install prerequisites:
- NI-VISA x64 (runtime)
- Visual Studio Build Tools (C++ workload)

Build:

```bat
cd packages\visa-addon
npm run build
cd ..\..
```

Verify addon binary:

```bat
dir packages\visa-addon\build\Release\visa_addon.node
```

Quick service smoke test (mock, no hardware):

```bat
set VISA_SERVICE_MOCK=1
npm --prefix packages\visa-service start
```

## 9) Output locations

- Installer/zip/portable outputs:
  - `GUI\release\`
- Common outputs include:
  - `GUI\release\*.exe`
  - `GUI\release\*.zip`
  - `GUI\release\win-unpacked\coreConsole.exe`

## 10) Quick validation

1. Run the packaged app EXE.
2. Confirm window renders UI (not blank).
3. Connect coreDAQ and verify status updates.

## 11) If packaged app opens a dark/blank window

Use latest repo state and rebuild. Renderer assets must be relative for packaged `file://` loading.

Clean and rebuild:

```bat
rmdir /S /Q GUI\renderer\dist
rmdir /S /Q GUI\release
npm run dist:win:portable
```

## 12) Optional: run app in dev mode (no packaging)

```bat
set COREDAQ_PYTHON=C:\Users\<you>\miniconda3\envs\coreDAQ\python.exe
npm run dev
```

## 13) NI-VISA / GPIB runtime checks

At app startup, Electron main spawns `visa-service` and requests health.

- If NI-VISA is missing, you should see a modal with:
  - error code (for example `NI_VISA_NOT_FOUND`)
  - checked VISA DLL paths
  - install guidance
- If NI-VISA is present but no GPIB resources are detected, health returns:
  - `visaLoaded: true`
  - `resourceManager: true`
  - `gpibDetected: false`

You can force service behavior:

```bat
set COREDAQ_ENABLE_GPIB_SERVICE=1
set COREDAQ_DISABLE_GPIB_SERVICE=0
set VISA_ADDON_PATH=C:\path\to\visa_addon.node
set VISA_SERVICE_LOG=C:\temp\coreconsole_visa_service.log
```

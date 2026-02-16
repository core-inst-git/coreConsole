# coreConsole Windows 10 Build Guide

This guide builds `coreConsole` (Electron GUI + Python backend) into a Windows executable package.

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

## 8) Output locations

- Installer/zip/portable outputs:
  - `GUI\release\`
- Common outputs include:
  - `GUI\release\*.exe`
  - `GUI\release\*.zip`
  - `GUI\release\win-unpacked\coreConsole.exe`

## 9) Quick validation

1. Run the packaged app EXE.
2. Confirm window renders UI (not blank).
3. Connect coreDAQ and verify status updates.

## 10) If packaged app opens a dark/blank window

Use latest repo state and rebuild. Renderer assets must be relative for packaged `file://` loading.

Clean and rebuild:

```bat
rmdir /S /Q GUI\renderer\dist
rmdir /S /Q GUI\release
npm run dist:win:portable
```

## 11) Optional: run app in dev mode (no packaging)

```bat
set COREDAQ_PYTHON=C:\Users\<you>\miniconda3\envs\coreDAQ\python.exe
npm run dev
```


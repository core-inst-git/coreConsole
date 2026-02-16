# coreConsole Release Guide (macOS + Windows)

This guide creates installer artifacts that run on target machines without Node.js or Python installed.

## What "no install required" means

- Target user does **not** need Node.js, npm, Python, or pip.
- Electron runtime and backend service executable are bundled into the app.
- Drivers may still be needed for external hardware:
  - USB CDC serial usually works out of the box.
  - Some GPIB setups still require vendor VISA/driver stack.

## Build model

Build each platform on native OS:

- Build mac package on macOS.
- Build Windows package on Windows.

Do not rely on Wine-based Windows packaging from macOS for production.

## 1) macOS Release (Apple Silicon)

From `coreConsole/GUI`:

```bash
# Optional but recommended: clean python venv for deterministic backend build
python3 -m venv .venv-release
source .venv-release/bin/activate
python -m pip install -U pip
python -m pip install -r backend/requirements.txt pyinstaller

# Build backend executable (bundled into app resources)
cd backend
python -m PyInstaller --noconfirm --clean --onefile \
  --name coredaq_service coredaq_service.py \
  --paths ../../API \
  --add-data ../../API/responsivity_curves.json:. \
  --exclude-module PyQt5 --exclude-module PyQt6 \
  --exclude-module PySide2 --exclude-module PySide6 \
  --exclude-module tkinter --exclude-module matplotlib --exclude-module IPython
cd ..
cp -f backend/dist/coredaq_service backend/bin/coredaq_service

# Build mac installer + zip
npm run dist:mac

# Optional: organize artifacts in release/distributions/
npm run release:organize
```

Outputs:

- `release/coreConsole-0.1.0-arm64.dmg`
- `release/coreConsole-0.1.0-arm64-mac.zip`

## 2) Windows 11 x64 Release

From `coreConsole/GUI` in PowerShell:

```powershell
# Optional but recommended: clean venv
py -3 -m venv .venv-release
.venv-release\Scripts\Activate.ps1
python -m pip install -U pip
python -m pip install -r backend\requirements.txt pyinstaller

# Build backend executable
cd backend
python -m PyInstaller --noconfirm --clean --onefile `
  --name coredaq_service coredaq_service.py `
  --paths ..\..\API `
  --add-data ..\..\API\responsivity_curves.json;. `
  --exclude-module PyQt5 --exclude-module PyQt6 `
  --exclude-module PySide2 --exclude-module PySide6 `
  --exclude-module tkinter --exclude-module matplotlib --exclude-module IPython
cd ..
copy /Y backend\dist\coredaq_service.exe backend\bin\coredaq_service.exe

# Build Windows x64 installer + zip
npm run dist:win -- --x64

# Optional: organize artifacts in release/distributions/
npm run release:organize
```

Outputs:

- `release/coreConsole Setup 0.1.0.exe`
- `release/coreConsole-0.1.0-win.zip`

## 3) Deployment on clean machines

macOS:

- Preferred: distribute `.dmg`.
- Unsigned apps show Gatekeeper warning. User can open via right-click -> Open.
- Best production flow: sign + notarize + staple.

Windows:

- Preferred: distribute `.exe` installer.
- Unsigned apps may show SmartScreen warning.
- Best production flow: sign with Authenticode certificate.

## 4) Recommended production hardening

- Add app icons for mac/win in `build` config.
- Add `author` in `GUI/package.json`.
- Add code signing:
  - macOS: Developer ID + notarization.
  - Windows: EV/OV certificate for SmartScreen reputation.
- Keep backend build in isolated venv to avoid PyInstaller dependency pollution.

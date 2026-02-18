# coreConsole

Standalone desktop GUI for coreDAQ instruments. Firmware and GUI are intentionally split into separate repositories.

## Repository layout
- `GUI/`: Electron + React desktop app
- `GUI/backend/`: Python backend service (device control, GPIB laser/sweep orchestration, streaming, HDF5 save)
- `API/`: Python coreDAQ API used by backend
- `API/coredaq_js_api.js`: Async Node.js coreDAQ API (serial + acquisition + transfer)
- `packages/visa-addon/`: Native N-API addon for NI-VISA
- `packages/visa-service/`: Stdio JSON-RPC VISA service used by Electron main
- `packages/GPIB_ARCHITECTURE.md`: GPIB service architecture and RPC boundary

## Prerequisites
- Node.js 20 LTS + npm 10
- Python 3.10+ with pip

## Development run
```bash
cd GUI
npm install
python3 -m pip install -r backend/requirements.txt
npm run dev
```

## Windows setup (conda + npm)
The same instructions are in `windows_setup.txt`.

Part A - Python/Conda backend (Anaconda Prompt)
```bat
cd <path>\coreConsole
conda create -n coreDAQ python=3.11 -y
conda activate coreDAQ
python -m pip install --upgrade pip
python -m pip install -r GUI\backend\requirements.txt h5py numpy matplotlib
python -c "import sys; print(sys.executable)"
```

Copy the printed python path and set `COREDAQ_PYTHON`:
```bat
set COREDAQ_PYTHON=C:\path\to\conda\envs\coreDAQ\python.exe
setx COREDAQ_PYTHON "C:\path\to\conda\envs\coreDAQ\python.exe"
```

Part B - Node/Electron frontend
```bat
nvm install 20
nvm use 20
node -v
npm -v
cd <path>\coreConsole\GUI
npm install
cd ..
npm run dev
```

Notes:
- If `npm run dev` cannot find Python, re-open the terminal so `setx` takes effect
  or re-run `set COREDAQ_PYTHON` in the current terminal.
- You can set `COREDAQ_PYTHON` permanently via Windows System Settings.

## NI-VISA / GPIB service (Windows)

The Electron app uses a separate Node service + native addon for NI-VISA.

Build steps:

```bat
cd <path>\coreConsole
npm --prefix packages\visa-addon install
npm --prefix packages\visa-addon run build
npm --prefix packages\visa-service install
```

Optional mock run (no hardware):

```bat
set VISA_SERVICE_MOCK=1
npm --prefix packages\visa-service start
```

Smoke tests (service + addon API boundary):

```bat
cd <path>\\coreConsole
npm run visa:smoke:mock
npm run visa:smoke
```

Platform wrapper scripts:
- Windows PowerShell: `packages/visa-service/examples/run_windows.ps1`
- macOS bash: `packages/visa-service/examples/run_macos.sh`

## Packaging
```bash
cd GUI
npm run dist:mac
npm run dist:win
npm run dist:win:portable
npm run release:organize
```

Final artifacts are placed under `GUI/release/distributions/`.

## Windows backend executable
For fully standalone Windows packaging, build and place:
- `GUI/backend/bin/coredaq_service.exe`

Example build command on Windows:
```bat
py -m PyInstaller --clean --noconfirm --onefile --name coredaq_service backend\coredaq_service.py
copy /Y dist\coredaq_service.exe backend\bin\coredaq_service.exe
```

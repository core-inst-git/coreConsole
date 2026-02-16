# coreConsole

Standalone desktop GUI for coreDAQ instruments. Firmware and GUI are intentionally split into separate repositories.

## Repository layout
- `GUI/`: Electron + React desktop app
- `GUI/backend/`: Python backend service (device control, GPIB laser/sweep orchestration, streaming, HDF5 save)
- `API/`: Python coreDAQ API used by backend

## Prerequisites
- Node.js LTS + npm
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

## Packaging
```bash
cd GUI
npm run dist:mac
npm run dist:win
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

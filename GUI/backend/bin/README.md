# Backend Binary Placement

For packaged desktop builds, place the platform-specific backend executable here:

- macOS/Linux: `coredaq_service`
- Windows: `coredaq_service.exe`

The Electron app launches this file from `resources/backend/` in production.

## Build backend executable (recommended)

Use PyInstaller on each target OS:

```bash
cd GUI/backend
python3 -m pip install pyinstaller -r requirements.txt
pyinstaller --onefile --name coredaq_service coredaq_service.py
```

Then copy:

- macOS/Linux: `dist/coredaq_service` -> `GUI/backend/bin/coredaq_service`
- Windows: `dist/coredaq_service.exe` -> `GUI/backend/bin/coredaq_service.exe`

Cross-platform packaging still needs platform-native backend binaries.

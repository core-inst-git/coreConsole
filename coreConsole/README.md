# coreConsole

Standalone desktop GUI for coreDAQ instruments. Firmware and GUI are intentionally split into separate repositories.

## Repository layout
- `GUI/`: Electron + React desktop app
- `GUI/backend/coredaq_service.js`: Node backend service (device control, streaming, sweep orchestration)
- `API/`: coreDAQ APIs (`coredaq_js_api.js`, legacy `coredaq_python_api.py`)
- `packages/laser-js/`: JS laser command library (TSL550/570/770)
- `packages/visa-addon/`: Native N-API addon for NI-VISA
- `packages/visa-service/`: Stdio JSON-RPC VISA service (standalone smoke/debug path)
- `packages/GPIB_ARCHITECTURE.md`: current GPIB/service architecture notes

## Prerequisites
- Node.js 20 LTS + npm 10
- NI-VISA (+ NI-488.2 for GPIB controllers) if using laser sweep/GPIB

## Development run
```bash
cd coreConsole
npm install
npm --prefix GUI install
npm --prefix packages/visa-addon install
npm --prefix packages/visa-addon run build
npm run dev
```

One-shot bootstrap after fresh clone:
```bash
cd coreConsole
./bootstrap.sh
```

## NI-VISA smoke tests
```bash
cd coreConsole
npm run visa:smoke:mock
npm run visa:smoke
```

Wrapper scripts:
- Windows: `packages/visa-service/examples/run_windows.ps1`
- macOS: `packages/visa-service/examples/run_macos.sh`

## Packaging
```bash
cd coreConsole
npm run dist:mac
npm run dist:win
npm run dist:win:portable
npm run release:organize
```

Final artifacts are under `GUI/release/distributions/`.

## Notes
- The backend path is JS-native (`GUI/backend/coredaq_service.js`).
- Sweep control uses NI-VISA from JS path.
- `sweep_save_h5` currently exports JSON payload (`.h5.json`) with full metadata/data while native HDF5 writer migration is pending.

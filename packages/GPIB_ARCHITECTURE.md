# GPIB / VISA Architecture (Current)

## Default runtime path

Renderer -> WebSocket (`ws://127.0.0.1:8765`) -> `GUI/backend/coredaq_service.js` ->
`laser-js` + `visa-addon` -> NI-VISA -> GPIB instruments

Key points:
- CoreDAQ control/streaming/sweep orchestration is now in JS backend.
- Laser sweep commands for TSL550/TSL570/TSL770 are in `packages/laser-js`.
- Sweep control uses JS VISA path (no `pyvisa` in default mode).

## Electron-main VISA service path

Renderer -> Electron IPC -> Main -> `visa-service` (stdio JSON-RPC) -> `visa-addon` -> NI-VISA

This runs by default inside the Electron app.  
Use `COREDAQ_DISABLE_GPIB_SERVICE=1` only if you explicitly want to bypass it for debugging.

## Package layout

- `packages/visa-addon/` - native N-API VISA bridge
- `packages/visa-service/` - standalone JSON-RPC VISA process + smoke tests
- `packages/laser-js/` - model-aware Santec TSL command library

## Laser command handling

`laser-js` selects command mode by model:
- `TSL550`, `TSL570`: nm-based sweep commands
- `TSL770`: meter-based sweep commands (`WAV:UNIT 1` + SI units)

Shared sweep flow:
1) `*RST` + trigger/power/sweep setup
2) `WAV:SWE 1` start
3) wait capture duration + overhead
4) `WAV:SWE 0` stop

## Packaging notes

Windows/macOS packaging includes:
- JS backend (`GUI/backend/coredaq_service.js`)
- API files (`resources/API`)
- laser-js (`resources/laser-js`)
- visa-addon binary (`resources/visa-addon/build/Release/*.node`)

JS backend receives runtime paths from Electron main via env:
- `COREDAQ_API_PATH`
- `COREDAQ_LASER_JS_PATH`
- `COREDAQ_VISA_ADDON_PATH`

## Current limitation

`action: sweep_save_h5` in JS backend currently writes a JSON export (`.h5.json`) containing full sweep metadata and channel arrays. Native HDF5 writer migration is pending.

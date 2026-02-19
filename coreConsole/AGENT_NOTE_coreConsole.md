# coreConsole Agent Handoff (PC-Side Focus)

## 1) Scope
Develop **coreConsole** on the PC side:
- Electron app shell and lifecycle
- React renderer UX/plots
- Node backend services
- JS device API + VISA/GPIB + laser control
- Packaging/distribution

Keep MCU/firmware details minimal unless explicitly requested.

## 2) Repo Layout
- `coreConsole/GUI/`
  - `electron/main.js` (window, backend spawn, IPC)
  - `electron/preload.js` (secure bridge)
  - `electron/visaServiceClient.js` (VISA service client)
  - `backend/coredaq_service.js` (main WS backend at `127.0.0.1:8765`)
  - `renderer/src/` (tabs/components/styles)
- `coreConsole/API/`
  - `coredaq_js_api.js` (primary JS host API)
  - `coredaq_python_api.py` (legacy/reference)
- `coreConsole/packages/`
  - `visa-addon/` (N-API NI-VISA bridge)
  - `visa-service/` (stdio JSON-RPC VISA service)
  - `laser-js/` (TSL550/570/770 commands)

## 3) Runtime Architecture
Primary path:
Renderer -> WebSocket -> `coredaq_service.js` -> `coredaq_js_api.js` + `visa-addon` + `laser-js`

Electron-main VISA path:
Renderer -> Electron IPC -> `visaServiceClient.js` -> `visa-service` -> `visa-addon`

## 4) Current Feature Set
- Device discovery/status
- Live power streaming
- Spectrum Analyzer sweep capture
- Console tab
- Calibration UI hooks (PC-side workflow)
- GPIB scan/query and laser model detection
- Virtual/math channels
- Sweep save path (`sweep_save_h5` behavior should be verified before changes)

## 5) Device Essentials Only
- LINEAR and LOG modes have different capabilities.
- Respect busy/acquisition state.
- Avoid command chatter during acquisition/transfer.

## 6) Key Files
- Shell: `coreConsole/GUI/electron/main.js`
- Backend: `coreConsole/GUI/backend/coredaq_service.js`
- Capture UI: `coreConsole/GUI/renderer/src/tabs/Capture/CaptureTab.tsx`
- Live UI: `coreConsole/GUI/renderer/src/tabs/LivePlot/LivePlot.tsx`
- Client bridge: `coreConsole/GUI/renderer/src/coredaqClient.ts`
- Styles: `coreConsole/GUI/renderer/src/styles/theme.css`

## 7) Build/Run
From repo root:
- mac/linux bootstrap: `./bootstrap.sh`
- windows bootstrap: `powershell -ExecutionPolicy Bypass -File .\\bootstrap.ps1`
- dev run: `npm run dev`
- renderer build: `npm --prefix GUI run build:renderer`

VISA prerequisites:
- NI-VISA installed
- NI-488.2 for GPIB controllers

## 8) Packaging
- Windows portable: `npm --prefix GUI run dist:win:portable`
- Windows installer: `npm --prefix GUI run dist:win`
- mac: `npm --prefix GUI run dist:mac`

Build on target OS for reliability.

## 9) Engineering Rules
- Keep state transitions explicit and deterministic.
- Use bounded timeouts; avoid indefinite waits.
- Show user-facing actionable errors.
- Preserve LINEAR vs LOG feature gating.
- Keep precision physically meaningful in display/conversion.

## 10) Immediate Priorities
1. Harden GPIB scan/query reliability on Windows.
2. Keep sweep pipeline robust under timing variance.
3. Improve packaging diagnostics and first-run checks.
4. Add regression checks for control + capture flows.

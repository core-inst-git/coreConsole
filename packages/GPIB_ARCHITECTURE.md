# GPIB Integration Architecture (Electron + NI-VISA)

## Topology

Renderer -> Electron IPC -> Main -> stdio JSON-RPC -> visa-service -> N-API addon -> NI-VISA -> GPIB instruments

Key boundary rules:
- Renderer does not load NI or native modules.
- Electron main does not load the native addon.
- Only `visa-service` loads `visa_addon.node`.

## Package layout

- `packages/visa-addon/` - N-API C++ addon exposing VISA calls
- `packages/visa-service/` - Node JSON-RPC service over stdio
- `packages/electron-app/` - wrapper package for `GUI` app commands

## RPC contract

Request (JSON per line):

```json
{"id":"123","method":"query","params":{"sessionId":"...","command":"*IDN?\n"}}
```

Success:

```json
{"id":"123","ok":true,"result":{"data":"..."}}
```

Error:

```json
{"id":"123","ok":false,"error":{"code":"VISA_ERROR","message":"VI_ERROR_TMO"}}
```

Boot status lines:
- `BOOT_OK` with health payload
- `BOOT_ERROR` then process exits non-zero

## Main IPC API exposed to renderer

- `gpib:health`
- `gpib:list`
- `gpib:open`
- `gpib:write`
- `gpib:read`
- `gpib:query`
- `gpib:set-timeout`
- `gpib:close`
- `gpib:restart-service`

Preload exposes these as `window.gpib.*`.

## Packaging notes

- `visa-service` copied to app resources as `resources/visa-service`
- `visa-addon` binary copied to `resources/visa-addon/build/Release/*.node`
- Native module excluded from `asar` via `asarUnpack` (`**/*.node`)

## Driver checks

`visa-service` boot performs:
1) NI-VISA loader check (`visa64.dll` dynamic load)
2) `viOpenDefaultRM` functional check
3) resource enumeration and `gpibDetected` status

If NI-VISA is missing, boot returns `BOOT_ERROR` with `checkedPaths` and install guidance.

## Standalone smoke tests

Use these before wiring full UI workflows:

- `packages/visa-service/examples/visa_smoke.js` (cross-platform Node RPC client)
- `packages/visa-service/examples/run_windows.ps1`
- `packages/visa-service/examples/run_macos.sh`

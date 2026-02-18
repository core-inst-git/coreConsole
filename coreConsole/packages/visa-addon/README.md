# visa-addon

Native N-API addon for NI-VISA.

## Scope

- Windows x64 first (`visa64.dll`)
- Runtime dynamic loading via `LoadLibrary`
- Exposes minimal VISA calls used by `visa-service`

## Build (Windows)

```powershell
cd coreConsole\packages\visa-addon
npm install
npm run build
```

Expected output:

- `build/Release/visa_addon.node`

## Environment overrides

- `VISA_DLL_PATH` - optional explicit path to `visa64.dll`
- `VISA_ADDON_PATH` - optional explicit path to `visa_addon.node` (used by service)

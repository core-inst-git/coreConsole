# coreConsole Windows 10/11 Build Guide

This guide builds coreConsole with the JS backend.

## 1) Prerequisites

- Windows 10/11 x64
- Git
- nvm-windows
- Node.js `20.x` + npm `10.x`
- NI-VISA x64 (and NI-488.2 for GPIB controllers)
- Visual Studio Build Tools (for native addon compile)

## 2) Clone and select Node 20

```bat
cd %USERPROFILE%
git clone https://github.com/core-inst-git/coreConsole.git
cd coreConsole
nvm install 20.20.0
nvm use 20.20.0
node -v
npm -v
```

## 3) Install dependencies

```bat
npm install
npm --prefix GUI install
npm --prefix packages\visa-addon install
npm --prefix packages\visa-addon run build
npm --prefix packages\visa-service install
```

## 4) Validate VISA stack

```bat
npm run visa:smoke:mock
npm run visa:smoke
```

If `visa:smoke` lists resources, NI-VISA path is good.

## 5) Run app in dev mode

```bat
npm run dev
```

## 6) Build distributables

```bat
npm run dist:win
npm run dist:win:portable
```

Outputs:
- `GUI\release\*.exe`
- `GUI\release\*.zip`
- `GUI\release\win-unpacked\coreConsole.exe`

## 7) Packaging notes

Packaging includes:
- Electron app (`GUI/electron`, `GUI/renderer/dist`)
- JS backend (`GUI/backend/coredaq_service.js`)
- `API` resources
- `laser-js` library
- `visa-addon` native module
- `visa-service` utilities

## 8) Useful env vars

```bat
set COREDAQ_VISA_ADDON_PATH=C:\path\to\visa_addon.node
set COREDAQ_ENABLE_GPIB_SERVICE=0
set COREDAQ_DISABLE_GPIB_SERVICE=1
```

`COREDAQ_ENABLE_GPIB_SERVICE=1` enables the standalone Electron-main VISA service path; default flow uses JS backend actions.

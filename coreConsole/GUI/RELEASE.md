# coreConsole Release Guide (macOS + Windows)

This guide builds installer artifacts with the JS backend included.

## Build model

- Build mac package on macOS.
- Build Windows package on Windows.

## 1) Common prep

From `coreConsole`:

```bash
npm install
npm --prefix GUI install
npm --prefix packages/visa-addon install
npm --prefix packages/visa-addon run build
```

## 2) macOS release

From `coreConsole/GUI`:

```bash
npm run dist:mac
npm run release:organize
```

Outputs:
- `release/coreConsole-*.dmg`
- `release/coreConsole-*-mac.zip`

## 3) Windows release

From `coreConsole/GUI` (PowerShell/CMD):

```bat
npm run dist:win -- --x64
npm run dist:win:portable
npm run release:organize
```

Outputs:
- `release/coreConsole Setup *.exe`
- `release/coreConsole-*-win.zip`
- `release/coreConsole *.exe` (portable)

## 4) Deployment notes

- Target machine does not need Node.js installed.
- NI-VISA/NI-488.2 are still required for GPIB workflows.
- Unsigned binaries may trigger OS security warnings.

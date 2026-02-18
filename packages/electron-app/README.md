# electron-app (wrapper)

The production Electron app source remains in `coreConsole/GUI`.

This package exists to keep a `packages/electron-app` monorepo layout while forwarding commands to the current app.

## Commands

```bash
cd coreConsole/packages/electron-app
npm run dev
npm run build
npm run dist:win
```

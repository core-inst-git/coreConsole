# coreDAQ GUI (Electron + React)

This is a modular UI scaffold for coreDAQ. The first tab is **Live Plot**.

## Dev workflow

From `GUI/`:

```bash
npm install
npm run dev
```

- Vite runs the renderer on `http://localhost:5173`
- Electron opens the desktop window

## Build

```bash
npm run build
```

This builds the renderer to `GUI/renderer/dist`.

## Structure

```
GUI/
  electron/      Electron main + preload
  renderer/      Vite + React UI
  backend/       Python service (stub for now)
  shared/        IPC / protocol contract (draft)
```

## Notes
- The Python backend will own the serial port and stream data to the UI.
- UI is designed for scientific clarity: high contrast, legible axes, and minimal clutter.

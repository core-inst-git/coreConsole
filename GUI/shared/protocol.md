# coreDAQ GUI Protocol (Draft)

This folder will hold the IPC contract between the Electron UI and the Python backend.

Planned channels:
- `status` (device connection, mode, errors)
- `stream` (continuous sample frames, channel mask, timestamps)
- `control` (gain, autogain, frequency, oversampling, start/stop)

Not implemented yet.

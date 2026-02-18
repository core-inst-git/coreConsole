# visa-service

Node JSON-RPC service over stdio. It loads the native `visa-addon` and is designed to be spawned by Electron main.

## RPC methods

- `health()`
- `listResources()`
- `open({resource, timeoutMs?})`
- `setTimeout({sessionId, ms})`
- `write({sessionId, command})`
- `read({sessionId, maxBytes?})`
- `query({sessionId, command, maxBytes?})`
- `close({sessionId})`

Optional:

- `writeBinary({sessionId, dataBase64})`
- `readBinary({sessionId, maxBytes?})`

## Boot behavior

- On successful boot, emits one line:
  - `{ "type":"BOOT_OK", "ok":true, "result":{...health} }`
- On failure (missing NI-VISA/addon), emits one line:
  - `{ "type":"BOOT_ERROR", "ok":false, "error":{...} }`
  - then exits with non-zero code.

## Environment

- `VISA_ADDON_PATH` - path to `visa_addon.node`
- `VISA_SERVICE_MOCK=1` - use mock addon (no hardware)
- `VISA_SERVICE_LOG` - optional log file path

## Run

```bash
cd coreConsole/packages/visa-service
npm start
```

Mock mode:

```bash
VISA_SERVICE_MOCK=1 npm start
```

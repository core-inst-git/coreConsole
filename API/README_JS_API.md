# coreDAQ JavaScript API (Node.js)

`coredaq_js_api.js` is an async Node.js port of `coredaq_python_api.py`.

## Install

```bash
cd coreConsole/API
npm install
```

## Quick start

```js
const { CoreDAQ } = require('./coredaq_js_api');

(async () => {
  const ports = await CoreDAQ.find();
  const dev = await CoreDAQ.open(ports[0], 0.2);
  try {
    console.log(await dev.idn());
    const power = await dev.snapshot_W(8);
    console.log(power);
  } finally {
    await dev.close();
  }
})();
```

## Notes

- All serial/command methods are **async** and should be awaited.
- Method names intentionally mirror the Python API (`snapshot_W`, `transfer_frames_W`, `arm_acquisition`, etc.) for easier parity updates.
- Includes:
  - frontend detection (`HEAD_TYPE?`)
  - detector/wavelength/responsivity model
  - linear calibration + factory/soft zeroing
  - log LUT calibration + deadband
  - gain control, acquisition control, channel masks
  - bulk transfer (`XFER`) with timeout guards
  - frequency/oversampling compatibility logic
  - sensor reads and port discovery

## Example

```bash
cd coreConsole/API
node examples_js/example_discover_snapshot.js
```

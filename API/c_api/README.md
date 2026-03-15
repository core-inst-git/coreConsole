# coreDAQ C API

This folder provides a native C API for coreDAQ with bounded timeouts and explicit error handling.

## Features

- Cross-platform serial backend (Windows + POSIX)
- Device discovery (`coredaq_find_ports`)
- Discovery/open/close/query helpers
- Frequency, oversampling, gains, channel mask control
- Snapshot APIs (`ADC`, `mV`, `V`, `W`)
- Acquisition control (`ACQ ARM`, `TRIGARM`, start/stop, wait)
- Bulk transfer (`XFER`) and conversion helpers
- LOG LUT load (`LOGCAL`) and LINEAR calibration load (`CAL`)

## Build

```bash
cmake -S API/c_api -B API/c_api/build
cmake --build API/c_api/build --config Release
```

## Examples

- `examples/example_snapshot_w.c`
- `examples/example_triggered_capture.c`

Run (Windows examples):

```bash
API\\c_api\\build\\Release\\coredaq_c_example_snapshot.exe COM5
API\\c_api\\build\\Release\\coredaq_c_example_triggered.exe COM5 2000
```

## Error Model

Every function returns `coredaq_result_t`. On failure, call:

- `coredaq_result_string(rc)`
- `coredaq_last_error(dev)`

No API call waits indefinitely.

# coreDAQ API Programmer's Manual

This document describes the host APIs for controlling `coreDAQ` instruments from Python and JavaScript, including:

- Device discovery and connection
- Snapshots in ADC, volts, mV, and watts
- Timed and triggered acquisition workflows
- Frequency and oversampling behavior
- Channel masking and memory implications
- Calibration, zeroing, detector, and responsivity controls

The API files in this folder are:

- `coredaq_python_api.py` (synchronous Python API)
- `coredaq_js_api.js` (async JavaScript API)

---

## 1. Architecture and Model

coreDAQ is a 4-channel measurement device with two front-end families:

- `LINEAR`: gain-selectable transimpedance path
- `LOG`: logarithmic detector path with LUT-based conversion

Most measurements and transfers are grouped per channel as arrays:

- `CH1..CH4` order is always `[0, 1, 2, 3]`
- Typical return shape: `[ch1_array, ch2_array, ch3_array, ch4_array]`

Important runtime model:

- Python API is blocking/synchronous.
- JS API is promise-based and asynchronous.
- JS constructor initializes asynchronously; call `await dev.ready()` (or use `CoreDAQ.open(...)`).

---

## 2. Prerequisites

### Runtime

- Device appears as serial `COMx` (Windows) / tty device (Linux/macOS)
- Correct USB serial driver installed

### Python

- Python 3.x
- `pyserial` installed

### JavaScript

- Node.js (project targets Node 20.x)
- `serialport` package installed

---

## 3. Quick Start

### Python: connect, identify, snapshot power

```python
from coredaq_python_api import CoreDAQ

with CoreDAQ("COM5", timeout=0.15) as dev:
    print("IDN:", dev.idn())
    print("Frontend:", dev.frontend_type())
    p_w = dev.snapshot_W(n_frames=1)  # [ch1, ch2, ch3, ch4] in W
    print("Power W:", p_w)
```

### JavaScript: connect, identify, snapshot power

```js
const { CoreDAQ } = require("./coredaq_js_api");

async function main() {
  const dev = await CoreDAQ.open("COM5", 0.15, 0.0);
  try {
    console.log("IDN:", await dev.idn());
    console.log("Frontend:", dev.frontend_type());
    const pW = await dev.snapshot_W(1);
    console.log("Power W:", pW);
  } finally {
    await dev.close();
  }
}

main().catch(console.error);
```

---

## 4. Discovery and Connection

Both APIs support discovery:

- Python: `CoreDAQ.find(baudrate=115200, timeout=0.15) -> List[str]`
- JS: `await CoreDAQ.find(baudrate=115200, timeout=0.15) -> string[]`

The APIs probe ports using `IDN?` and return matching port paths.

---

## 5. Front-End, Detector, and Responsivity

### Front-end detection

- `frontend_type()` returns `LINEAR` or `LOG`.

### Detector model

- `detector_type()` / `set_detector_type("INGAAS" | "SILICON")`
- `set_wavelength_nm(...)` and `get_wavelength_nm()`
- `get_wavelength_limits_nm(...)`

### Responsivity curves

- `load_responsivity_curves_json(path)`
- `get_responsivity_A_per_W(detector, wavelength_nm)`
- `set_responsivity_reference_nm(...)`

Responsivity affects power conversion behavior, especially with wavelength-dependent correction.

---

## 6. Snapshot APIs

Snapshots are immediate command/response acquisitions (not long SDRAM captures).

Main methods:

- `snapshot_adc(n_frames=1, timeout_s=1.0, poll_hz=200.0)`
- `snapshot_adc_zeroed(...)`
- `snapshot_volts(...)`
- `snapshot_mV(...)`
- `snapshot_W(...)`

### Notes

- `snapshot_W(...)` returns 4 values (one per channel) when `n_frames=1`.
- For `LINEAR`, `autogain=True` can adjust gain before final conversion.
- For `LOG`, deadband can suppress near-zero output:
  - `set_log_deadband_mV(...)`
  - `get_log_deadband_mV()`

---

## 7. Zeroing and Calibration (LINEAR-focused)

Available methods include:

- Factory/soft zero:
  - `refresh_factory_zeros()`
  - `get_factory_zero_adc()`
  - `get_linear_zero_adc()`
  - `set_soft_zero_adc(z1, z2, z3, z4)`
  - `restore_factory_zero()`
- Snapshot-based zeroing:
  - `soft_zero_from_snapshot(...)`
  - `recompute_zero_from_snapshot(...)`

Calibration and model methods:

- `voltage_to_power_W(...)` (LOG conversion utility)
- Silicon model tuning:
  - `set_silicon_linear_tia_ohm(...)`
  - `set_silicon_log_model(...)`

---

## 8. Frequency and Oversampling

Control methods:

- `get_freq_hz()`, `set_freq(hz)`
- `get_oversampling()`, `set_oversampling(os_idx)`

Device rule implemented by APIs:

- Maximum sample frequency is `100000 Hz`.
- Oversampling index range is `0..7`.
- Effective max frequency for oversampling:
  - `os <= 1`: `100000`
  - `os > 1`: `floor(100000 / 2^(os - 1))`

If you request an invalid `freq/os` pair, API logic may auto-adjust to a valid pair and warn.

---

## 9. Channel Masking Concept

Channel masking determines which channels are stored/transferred during acquisition.

- Use `set_channel_mask(mask)` with `mask` in `1..15`.
- Bit mapping:
  - bit0 -> CH1
  - bit1 -> CH2
  - bit2 -> CH3
  - bit3 -> CH4

Examples:

- `0x1` -> CH1 only
- `0x3` -> CH1 + CH2
- `0xF` -> CH1..CH4

Mask-dependent frame bytes:

- `frame_bytes = active_channels * 2` (int16 ADC per channel sample)

Memory capacity:

- `max_frames = floor(SDRAM_BYTES / frame_bytes)`
- Query with `max_acquisition_frames(mask=None)`

---

## 10. Acquisition Pipeline (Timed and Triggered)

Long captures are done via arm/start/transfer flow.

Core methods:

- `arm_acquisition(frames, use_trigger=False, trigger_rising=True)`
- `start_acquisition()`
- `stop_acquisition()`
- `wait_for_completion(poll_s=0.25, timeout_s=None)`
- `state_enum()`
- `transfer_frames_adc(frames, idle_timeout_s=2.0, overall_timeout_s=None)`
- `transfer_frames_mV(...)`, `transfer_frames_volts(...)`, `transfer_frames_W(...)`

### 10.1 Timed acquisition (non-triggered)

1. Configure frequency, oversampling, channel mask.
2. Compute desired `frames`.
3. `arm_acquisition(frames, use_trigger=False)`
4. `start_acquisition()`
5. `wait_for_completion(...)`
6. Transfer data.

### 10.2 Triggered acquisition

1. Configure frequency, oversampling, channel mask.
2. `arm_acquisition(frames, use_trigger=True, trigger_rising=True/False)`
3. Wait for external trigger.
4. `wait_for_completion(...)`
5. Transfer data.

---

## 11. Python Example: Timed Capture

```python
from coredaq_python_api import CoreDAQ

with CoreDAQ("COM5") as dev:
    dev.set_freq(50_000)
    dev.set_oversampling(0)
    dev.set_channel_mask(0x0F)  # CH1..CH4

    duration_s = 2.0
    frames = int(duration_s * dev.get_freq_hz())
    max_frames = dev.max_acquisition_frames()
    if frames > max_frames:
        raise RuntimeError(f"frames={frames} exceeds max={max_frames}")

    dev.arm_acquisition(frames, use_trigger=False)
    dev.start_acquisition()
    dev.wait_for_completion(timeout_s=10.0)

    ch_w = dev.transfer_frames_W(frames)  # [ch1[], ch2[], ch3[], ch4[]]
    print("Captured frames:", len(ch_w[0]))
```

---

## 12. Python Example: Triggered Capture

```python
from coredaq_python_api import CoreDAQ

with CoreDAQ("COM5") as dev:
    dev.set_freq(20_000)
    dev.set_oversampling(1)
    dev.set_channel_mask(0x03)  # CH1+CH2

    frames = 40_000
    dev.arm_acquisition(frames, use_trigger=True, trigger_rising=True)
    # External trigger arrives here...
    dev.wait_for_completion(timeout_s=15.0)
    ch_adc = dev.transfer_frames_adc(frames)
    print(len(ch_adc[0]), len(ch_adc[1]))
```

---

## 13. JavaScript Example: Timed Capture

```js
const { CoreDAQ } = require("./coredaq_js_api");

async function captureTimed(port) {
  const dev = await CoreDAQ.open(port, 0.15, 0.0);
  try {
    await dev.set_freq(50000);
    await dev.set_oversampling(0);
    await dev.set_channel_mask(0x0f);

    const durationS = 2.0;
    const frames = Math.round(durationS * (await dev.get_freq_hz()));
    const maxFrames = await dev.max_acquisition_frames();
    if (frames > maxFrames) throw new Error(`frames=${frames} > max=${maxFrames}`);

    await dev.arm_acquisition(frames, false, true);
    await dev.start_acquisition();
    await dev.wait_for_completion(0.25, 10.0);

    const chW = await dev.transfer_frames_W(frames);
    console.log("Captured frames:", chW[0].length);
  } finally {
    await dev.close();
  }
}
```

---

## 14. JavaScript Example: Snapshot Loop

```js
const { CoreDAQ } = require("./coredaq_js_api");

async function snapshotLoop(port) {
  const dev = await CoreDAQ.open(port);
  try {
    for (let i = 0; i < 10; i += 1) {
      const pW = await dev.snapshot_W(1, 1.0, 200.0, null, false);
      console.log(i, pW);
      await new Promise((r) => setTimeout(r, 100));
    }
  } finally {
    await dev.close();
  }
}
```

---

## 15. Method Families (Reference Map)

### Identity and lifecycle

- `idn`, `close`, `soft_reset`, `enter_dfu`, `i2c_refresh`

### Operating point

- `get_freq_hz`, `set_freq`, `get_oversampling`, `set_oversampling`
- `set_gain`, `get_gains` (LINEAR)

### Measurement

- `snapshot_*` family
- `transfer_frames_*` family

### Acquisition control

- `arm_acquisition`, `start_acquisition`, `stop_acquisition`
- `wait_for_completion`, `state_enum`, `frames_remaining`

### Channel/memory

- `get_channel_mask_info`, `get_channel_mask`, `set_channel_mask`, `max_acquisition_frames`

### Environment telemetry

- `get_head_temperature_C`, `get_head_humidity`, `get_die_temperature_C`

### Discovery

- `find(...)`

---

## 16. Error Handling Guidance

- Wrap all I/O calls in try/except (Python) or try/catch (JS).
- Validate `frames <= max_acquisition_frames()` before arming.
- Handle timeouts explicitly for trigger waits and long transfers.
- Do not issue frequent configuration commands during active acquisition/transfer.

---

## 17. Recommended Control Patterns

For robust scientific workflows:

1. Connect and read `idn`, `frontend_type`, `detector_type`.
2. Set detector/wavelength model before power conversion runs.
3. Set `freq`, then `os` (or verify returned values after auto-adjust).
4. Set channel mask to minimum required channels for maximum depth.
5. For long captures, use arm/start/wait/transfer sequence.
6. Keep configuration command traffic low while acquisition is running.

---

## 18. Notes

- Python and JS APIs are intentionally aligned in naming and behavior.
- JS API includes `CoreDAQ.open(...)` convenience and async lifecycle.
- Some text values in legacy outputs may contain encoding artifacts; this does not affect numeric behavior.


---

## 19. Saved Sweep H5: Fast Plot Workflow

When you save from the Spectrum Analyzer tab, the backend writes a compressed HDF5 sweep file (`*.h5`).

Metadata includes:

- save/capture UTC timestamps
- `coredaq_idn`, device id, and COM port
- room temperature and humidity
- sweep settings (`start_nm`, `stop_nm`, `sample_rate_hz`, etc.)

Minimal Python flow:

1. Set `file_path`.
2. Load H5 channel data + metadata.
3. Build wavelength axis from `start_nm` and `stop_nm`.
4. Plot one channel.

```python
from pathlib import Path
import h5py
import matplotlib.pyplot as plt

file_path = Path(r"C:\path\to\coredaq_sweep_2026-03-14_120000.h5")

with h5py.File(file_path, "r") as h5:
    ch1 = h5["/sweep/channels/ch1_w"][:]
    meta = h5["/metadata"].attrs
    start_nm = float(meta.get("start_nm", 0.0))
    stop_nm = float(meta.get("stop_nm", float(len(ch1) - 1)))

n = len(ch1)
wavelength_nm = [start_nm + i * (stop_nm - start_nm) / (n - 1) for i in range(n)]

plt.plot(wavelength_nm, ch1)
plt.xlabel("Wavelength (nm)")
plt.ylabel("Power (W)")
plt.title("Saved Sweep - CH1")
plt.grid(alpha=0.3)
plt.tight_layout()
plt.show()
```

See also: `API/examples/example_plot_saved_sweep_minimal.py`.

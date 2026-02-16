# coreDAQ Programmer's Manual

Version: v4 software stack  
Audience: application developers using the Python API for power measurement and acquisition.

## 1. What You Control

`coreDAQ` is a 4-channel optical measurement device with two major front-end families:

- `LINEAR` front-end: selectable gain stages (0..7), gain-aware power conversion.
- `LOG` front-end: logarithmic conversion path, no gain switching in host workflow.

Each unit can be detector-configured as:

- `INGAAS` (typical IR workflows, default 1550 nm)
- `SILICON` (typical visible/NIR workflows, default 775 nm)

The API abstracts this into high-level functions like:

- `snapshot_W(...)` for live power
- `arm_acquisition(...) + transfer_frames_W(...)` for dense captures
- `set_freq(...)`, `set_oversampling(...)` for sampling behavior
- `set_channel_mask(...)` for channel selection and SDRAM depth optimization

## 2. Install + Import

```bash
pip install pyserial matplotlib numpy
```

```python
from coredaq_python_api import CoreDAQ, CoreDAQError
```

## 3. Connect (Manual Port or Auto-Find)

```python
# Manual port
dev = CoreDAQ(port="COM7", timeout=0.15)

# Auto-find first device
ports = CoreDAQ.find(timeout=0.15)
if not ports:
    raise RuntimeError("No coreDAQ found")
dev = CoreDAQ(port=ports[0], timeout=0.15)
```

Common identity / capability checks:

```python
print(dev.idn())
print(dev.frontend_type())   # "LINEAR" or "LOG"
print(dev.detector_type())   # "INGAAS" or "SILICON"
```

## 4. Sampling and Oversampling

Sampling frequency range is `1 .. 100000 Hz`.

```python
dev.set_freq(50000)
dev.set_oversampling(0)  # 0..7
```

Important behavior:

- `set_freq(hz)` may auto-adjust oversampling if current OS is invalid at requested frequency.
- `set_oversampling(os_idx)` may clamp to the best valid OS for the current frequency.
- The API emits runtime warnings when auto-adjustment occurs.

Frequency/OS rule:

- Base max sampling is `100000 Hz`.
- For OS `0` and `1`, max is `100000 Hz`.
- For OS `>=2`, max is `100000 / 2^(OS-1)`.

## 5. Wavelength and Detector Behavior

Set wavelength once for power conversion:

```python
dev.set_wavelength_nm(1550.0)   # InGaAs default
wl = dev.get_wavelength_nm()
```

Wavelength limits are detector-dependent:

- InGaAs: `910 .. 1700 nm`
- Silicon: `400 .. 1100 nm`

If outside range, API clamps to nearest valid value and raises a warning.

## 6. Live Measurement APIs

### 6.1 Voltage Snapshot

```python
mv, gains = dev.snapshot_mV(n_frames=8)
# mv: [ch1_mV, ch2_mV, ch3_mV, ch4_mV]
# gains: per-channel gain indices
```

### 6.2 Power Snapshot

```python
pw = dev.snapshot_W(n_frames=8, autogain=False)
# pw: [ch1_W, ch2_W, ch3_W, ch4_W]
```

Power conversion depends on variant:

- LINEAR + InGaAs: calibrated slope/intercept model (+ detector correction by wavelength)
- LINEAR + Silicon: TIA gain model + silicon responsivity curve
- LOG + InGaAs: LUT-based voltage-to-power (+ detector correction by wavelength)
- LOG + Silicon: ADL5303-style log model + silicon responsivity curve

## 7. Gain Control (LINEAR only)

```python
dev.set_gain(1, 3)   # CH1 -> gain index 3
dev.set_gain(2, 5)
gains = dev.get_gains()
```

For convenience:

```python
dev.set_gain1(2)
dev.set_gain2(2)
dev.set_gain3(2)
dev.set_gain4(2)
```

Autogain during snapshot:

```python
pw = dev.snapshot_W(n_frames=8, autogain=True)
```

## 8. Acquisition Modes

Core acquisition flow:

1. Configure frequency/OS/mask.
2. Arm acquisition.
3. Start acquisition.
4. Wait complete.
5. Transfer data from SDRAM.

### 8.1 Trigger-Based

```python
frames = 100000
dev.arm_acquisition(frames, use_trigger=True, trigger_rising=True)
dev.start_acquisition()
dev.wait_for_completion(timeout_s=30.0)
power_ch = dev.transfer_frames_W(frames)
```

### 8.2 Internal Timer-Based

```python
frames = 500000
dev.arm_acquisition(frames, use_trigger=False)
dev.start_acquisition()
dev.wait_for_completion(timeout_s=30.0)
power_ch = dev.transfer_frames_W(frames)
```

## 9. Channel Masking and SDRAM Capacity

Channel mask lets you capture only needed channels:

- Bit0 -> CH1
- Bit1 -> CH2
- Bit2 -> CH3
- Bit3 -> CH4

Examples:

- `0xF`: CH1+CH2+CH3+CH4
- `0x3`: CH1+CH2
- `0x1`: CH1 only

API:

```python
dev.set_channel_mask(0x3)
mask, active, frame_bytes = dev.get_channel_mask_info()
max_frames = dev.max_acquisition_frames(mask)
```

Buffer model:

- Total SDRAM bytes: `32 * 1024 * 1024`.
- Each active channel contributes `2 bytes/sample` (16-bit ADC).
- `frame_bytes = active_channels * 2`.
- `max_frames = SDRAM_BYTES // frame_bytes`.

Practical impact:

- Fewer active channels -> deeper capture duration.
- Use mask strategically for long sweeps or high-rate captures.

## 10. Transfer APIs

Raw ADC:

```python
adc_ch = dev.transfer_frames_adc(frames)
```

Converted:

```python
mv_ch = dev.transfer_frames_mV(frames)
v_ch  = dev.transfer_frames_volts(frames)
pw_ch = dev.transfer_frames_W(frames)
```

All transfer methods return 4 lists `[ch1, ch2, ch3, ch4]` with length `frames`.
Masked-out channels are returned as zeros.

## 11. Zeroing and Offsets

LINEAR path:

- Uses per-channel ADC zero offsets.
- Factory and software zero workflows are supported.
- Zeroing affects linear voltage/power conversions.

LOG path:

- Zeroing is not used for LOG conversion.
- LOG near-zero suppression is handled via deadband:

```python
dev.set_log_deadband_mV(300.0)
db = dev.get_log_deadband_mV()
```

## 12. Robust Workflow Recommendations

- Set detector type and wavelength immediately after connect.
- Set `freq` and `OS` before capture; let API resolve invalid combinations.
- Keep command traffic minimal during active acquisition / transfer.
- Use channel masking to maximize effective memory depth.
- For large transfers, keep generous host timeouts.

## 13. Key Function Definitions (Python API)

```python
# Discovery / connect
CoreDAQ.find(baudrate: int = 115200, timeout: float = 0.15) -> List[str]
CoreDAQ(port: str, timeout: float = 0.05)

# Identity / mode
idn(refresh: bool = False) -> str
frontend_type() -> str
detector_type() -> str
set_detector_type(detector: str) -> None

# Wavelength
set_wavelength_nm(wavelength_nm: float) -> float
get_wavelength_nm() -> float
get_wavelength_limits_nm(detector_type: Optional[str] = None) -> Tuple[float, float]

# Sampling
set_freq(hz: int) -> None
get_freq_hz() -> int
set_oversampling(os_idx: int) -> None
get_oversampling() -> int

# Live readout
snapshot_mV(n_frames: int = 8, timeout_s: float = 2.0, poll_hz: float = 100.0, use_zero: Optional[bool] = None)
snapshot_W(n_frames: int = 8, timeout_s: float = 2.0, poll_hz: float = 100.0, autogain: bool = False, ...)

# Gain / calibration helpers
set_gain(head: int, value: int) -> None
get_gains() -> List[int]
recompute_zero_from_snapshot(temp_snap_frames: int = 32, temp_freq_hz: int = 1000, temp_os: int = 6, settle_s: float = 0.2)
set_log_deadband_mV(deadband_mV: float) -> None

# Acquisition control
arm_acquisition(frames: int, use_trigger: bool = False, trigger_rising: bool = True) -> None
start_acquisition() -> None
stop_acquisition() -> None
wait_for_completion(poll_s: float = 0.25, timeout_s: Optional[float] = None) -> None

# Mask + transfer
set_channel_mask(mask: int) -> None
get_channel_mask_info() -> Tuple[int, int, int]
max_acquisition_frames(mask: Optional[int] = None) -> int
transfer_frames_adc(frames: int, idle_timeout_s: float = 2.0, overall_timeout_s: Optional[float] = None)
transfer_frames_mV(frames: int, ...)
transfer_frames_volts(frames: int, ...)
transfer_frames_W(frames: int, ...)
```

## 14. Example Programs Included

In `API/examples/`:

- `example_set_gain_measure.py`
- `example_trigger_acquisition_plot.py`
- `example_timer_acquisition_plot.py`
- `example_live_stream_plot.py`

All examples support:

- Manual port: `--port COM7` or `--port /dev/ttyACM0`
- Auto-find: omit `--port`, optionally use `--device-index N`


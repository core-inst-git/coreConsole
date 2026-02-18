# CoreDAQ Calibration Agent Specification

Use this document as the primary prompt/context for an AI agent tasked with building a full, automated, scientific calibration system for CoreDAQ devices.

---

## 0) Agent Role

You are a senior calibration and instrumentation software engineer building a production-grade calibration pipeline for CoreDAQ.

Primary goal:

- Build a repeatable, traceable, automated calibration system for both CoreDAQ frontend types (`LINEAR`, `LOG`) using a NIST-traceable reference power meter (Thorlabs PM100 path), controlled optical flux hardware, and robust model fitting.

Non-negotiables:

- Measurement integrity over convenience
- Full traceability (who, when, setup, coefficients, uncertainty)
- Deterministic automation and reproducibility
- Respect CoreDAQ acquisition-state constraints (do not command-spam during acquisition/transfer)

---

## 1) CoreDAQ Platform Context (What You Must Know)

Repositories:

- GUI/API repo: `/Users/ravipradip/coreConsole`
- LINEAR firmware repo: `/Users/ravipradip/LinearFirmware`
- LOG firmware repo: `/Users/ravipradip/LogFirmware`

Important CoreDAQ software components:

- API: `API/coredaq_python_api.py`
- GUI backend service: `GUI/backend/coredaq_service.js`
- Electron app shell: `GUI/electron/main.js`
- React frontend tabs in `GUI/renderer/src/`

Current API capabilities already available:

- Frontend detection: `HEAD_TYPE?` -> `LINEAR` / `LOG`
- Identity: `IDN?`
- Snapshot/transfer acquisition (`SNAP`, `XFER`, triggered arm/state model)
- LINEAR gain control (`GAIN`, `GAINS?`)
- Frequency + oversampling control (`FREQ`, `OS`)
- Channel mask control (`CHMASK`)
- Zeroing support for LINEAR (`FACTORY_ZEROS?`, host-side soft zero recompute)
- Calibration pull:
  - LINEAR: `CAL <head> <gain>` slope/intercept
  - LOG: `LOGCAL 1` LUT stream

Current precision policy:

- ADC is 16-bit bipolar, conversion precision should be meaningful and bounded.
- API conversion now quantizes/rounds to avoid fake floating-point resolution.

---

## 2) Calibration Hardware Model (Target Bench Setup)

Optical source chain (1550 nm baseline):

1. Laser with optical output/brightness controlled by **DAC channel 1**
2. Variable attenuator #1 controlled by **DAC channel 2** (about 40 dB range)
3. Variable attenuator #2 controlled by **DAC channel 3** (about 40 dB range)
4. Output into fixed 1x2 splitter (split ratio characterized once)
5. Arm A -> Thorlabs PM100 (NIST-traceable reference)
6. Arm B -> CoreDAQ channel under test

Total controllable dynamic span target: approximately 80+ dB (attenuators), plus source modulation.

Control requirement:

- Build USB CDC FS software control path for DAC channels 1/2/3 (controller firmware + host driver + calibration orchestration).

### 2.1 Optical connector and bench discipline (must follow)

Treat fiber handling as part of calibration, not an afterthought.

- Use connector type intentionally at 1550 nm:
  - Prefer FC/APC in reflection-sensitive paths.
  - Do not mix APC/UPC mating.
- Clean and inspect before every critical run:
  - Inspect with fiber scope.
  - Dry clean first (one-click cleaner), wet clean only if needed, then dry clean again.
  - Re-inspect; no visible contamination/scratches in core/cladding zone.
- Keep optical path mechanically stable:
  - Fixed patch routing, strain relief, no cable motion during sweep.
  - Respect minimum bend radius and avoid micro-bending.
- Track every reconnection:
  - Any reconnect or connector disturbance invalidates previous baseline and requires re-baselining.
- Control bench environment:
  - Warm-up and thermal stabilization before data collection.
  - Log room temperature/humidity.
  - Minimize airflow/vibration around fibers and photodiodes.

### 2.2 Experimental conditions checklist

- PM100 wavelength set correctly (e.g., 1550 nm for InGaAs calibration runs).
- PM100 averaging/time constant fixed and recorded.
- Laser mode fixed (no hidden auto-power control drift unless intentionally used).
- Polarization state management defined and repeatable (especially if DUT is polarization-sensitive).

---

## 3) Frontend-Specific Calibration Objectives

### 3.1 LINEAR frontend (op-amp TIA + SP8T resistor/gain switching)

Per physical channel (CH1..CH4), per gain (0..7):

- Estimate robust `slope_mV_per_W` and `intercept_mV`
- Define valid operating power range for each gain (lower noise-limited bound and upper linear/saturation bound)
- Validate overlap stitching between adjacent gains
- Optionally derive gain-switch recommendation map

Important analog reality:

- This circuit is on single supply (0 to 5 V), not split supply.
- Therefore electrical "zero light" is not equal to 0 V output.
- A non-zero offset is expected and must be modeled, not "forced away."

Target model:

- `mV = slope * P_ref + intercept`
- Inverse for runtime power:
  - `P = max(0, (mV - intercept) / slope)`

Offset/intercept strategy:

- Treat intercept as a physical/electronic model parameter.
- Keep intercept free during fitting; do not constrain intercept to zero.
- Use dark/zero routines to stabilize baseline and drift, but do not overwrite the calibration intercept conceptually.
- Recommended decomposition for analysis:
  - `mV_meas = mV_dark_runtime + mV_transfer`
  - `mV_transfer = slope * P_ref + intercept_cal`
  - `mV_dark_runtime` handles day-to-day dark drift; `intercept_cal` remains the calibration coefficient.

### 3.2 LOG frontend (ADL5303)

No gain switching.

Calibrate transfer from measured electrical output to optical power:

- Primary method: fit parametric log model (e.g., `V = a * log10(P) + b`) and invert for `P`.
- ADL5303 is highly linear in log domain (order 0.1% typical), so model-first is preferred.
- LUT should be fallback only if residual/hysteresis/non-ideal behavior exceeds acceptance limits.

Preferred for production:

- Parametric model with strict residual validation and temperature annotation.
- Store calibration metadata including temperature and measurement span.
- Keep optional LUT path available for edge cases only.

---

## 4) Photodiode Strategy (InGaAs vs Silicon)

### 4.1 InGaAs path (priority)

- Perform absolute calibration at 1550 nm with PM100 traceability.
- For multi-wavelength/sweep use:
  - Apply relative responsivity correction from manufacturer dataset:
    - `P_corrected(lambda) = P_1550_cal * [R_pd(1550) / R_pd(lambda)]` (or equivalent consistent formulation)
- Keep dataset provenance (manufacturer, version, date, wavelength grid).

### 4.2 Silicon path (interim mode)

For now:

- Skip full absolute bench calibration.
- Use theoretical/raw silicon responsivity curve + known TIA gain resistor values for estimated power conversion.
- Mark outputs clearly as "model-derived / not fully bench-calibrated".

---

## 5) Required New Control Layer: DAC Flux Controller

Build a dedicated software interface for the new DAC-controlled optical flux hardware.

### 5.1 Proposed CDC command contract (implement and version)

Define and implement a minimal robust protocol such as:

- `IDN?`
- `DAC SET <ch> <code>`
- `DAC GET <ch>`
- `DAC APPLY <c1> <c2> <c3>`
- `DAC LIMITS?`
- `OUT?`
- `SAFE` (optional emergency safe attenuation/power)

Rules:

- Deterministic ACK/ERR response
- Range checks and command validation in firmware
- Include protocol version in `IDN?`

### 5.2 Host driver

Create Python driver (new module) with:

- Port discovery and connect/reconnect
- Atomic apply of channels 1..3
- Rate-limited stepping with settle wait
- Optional readback verification

---

## 6) Calibration Workflow (Automation Sequence)

### 6.1 Preflight

- Verify instruments:
  - CoreDAQ connected, frontend type detected, firmware supported
  - PM100 reachable and configured for power readout in watts
  - DAC flux controller reachable
- Verify dark-state and safe attenuation defaults
- Warm-up stabilization period (laser + detector + electronics)
- Capture baseline ambient and device metadata
- Perform and log connector cleaning/inspection state (pass/fail + operator)
- Lock optical routing and strain relief before sweep sequence

### 6.2 Splitter characterization (once per setup or periodic re-check)

- Measure splitter ratio across calibration operating range
- Store correction factor and uncertainty
- Apply ratio correction consistently in reference power computation

### 6.3 Dark/zero stage

For LINEAR channels:

- Run zero routine with detectors dark:
  - Use API recompute path (temp `freq=1000`, `os=6`, `snap=32`, restore previous settings)
- Log resulting zero codes and timestamp
- Collect repeated dark captures per gain to estimate dark mean and dark noise (`sigma_dark`)
- Do not force final calibration intercept to 0 mV; intercept remains part of the fitted transfer model

### 6.4 Sweep measurement stage

For each channel and model mode:

- Program channel/gain configuration (LINEAR gain-specific)
- Sweep optical flux using DAC1/2/3 plan:
  - Coarse-fine stepping strategy across dynamic range
  - Include up and down sweeps to detect hysteresis
  - At each setpoint:
    - wait settle time
    - average N PM100 samples
    - average N CoreDAQ samples (or capture burst with known settings)
- Reject obviously saturated/invalid points

Important CoreDAQ invariant:

- Do not issue state/console chatter while device is actively acquiring/transferring large frames.

---

## 7) Fitting and Model Selection

### 7.1 LINEAR fitting

Per (channel, gain):

- Fit `mV = slope * P_ref + intercept` using robust regression (Huber/RANSAC + weighted LS fallback)
- Enforce physically consistent constraints:
  - slope positive
  - monotonic response
- Validate intercept stability across repeated runs (detect drift vs true model change)
- Derive:
  - slope/intercept
  - confidence intervals
  - residual statistics (RMSE, max error, R^2)
  - valid range `[P_min_valid, P_max_valid]`

Range rules (example defaults):

- Lower bound: SNR above threshold, > few ADC LSB equivalent
- Upper bound: linearity residual threshold + saturation margin

### 7.2 LOG fitting/LUT

- Fit primary log-domain parametric model and compute residual metrics.
- If parametric model meets acceptance gates, use it directly (no LUT required).
- If model fails acceptance gates, generate monotonic LUT fallback and document why fallback was required.
- Always report selected model type (`parametric` or `lut_fallback`) in run outputs.

---

## 8) Data Model and Traceability

Persist full raw + processed datasets.

Recommended outputs per run:

- `run_manifest.yaml`:
  - operator, timestamp, instrument IDs/serials, firmware versions, photodiode type, wavelength, splitter factor, environment, software commit hashes
- `raw_measurements.h5`:
  - all setpoints, PM100 readings, CoreDAQ raw/snapshot data, gain/os/freq state
- `fit_results.json`:
  - coefficients, ranges, residual metrics, uncertainty summary
- `qa_report.md` + plots:
  - residual plots, monotonic checks, gain overlap, outlier log

Calibration IDs:

- `cal_id = <device_serial>_<frontend>_<date>_<rev>`

Never overwrite previous calibrations; keep immutable history.

---

## 9) Coefficient Deployment Strategy

Current system can read calibration but write/update paths may need expansion.

Implement explicit strategy:

1. **Host-side override mode first** (fast to validate)
2. **Firmware persistent mode next** (production)

Suggested firmware command additions (design, then implement in both firmware repos as applicable):

- LINEAR:
  - `CALSET <head> <gain> S=<hexfloat> I=<hexfloat>`
  - `CALSAVE`
  - `CALLOAD`
- LOG:
  - `LOGCALSET S=<hexfloat> I=<hexfloat>` (parametric first choice)
  - `LOGCALGET` (readback)
  - Optional fallback:
    - `LOGLUTSET ...` streamed LUT write command
    - `LOGLUTSAVE`
    - `LOGLUTLOAD`

Add API wrappers in `coredaq_python_api.py` and validation reads after write.

---

## 10) Scientific Quality Criteria (Acceptance Gates)

Calibration passes only if all checks pass:

- Monotonicity violations: none
- Per-segment/overall residuals below configured thresholds
- No hidden saturation regions in declared valid ranges
- Gain-to-gain overlap continuity within tolerance
- Repeatability across repeated runs within tolerance
- Traceability artifacts complete (raw, metadata, fit report)

Define explicit numeric thresholds in config (not hard-coded in logic).

---

## 11) Software Architecture to Build

Create a new calibration package (suggested):

- `coreConsole/calibration/`
  - `drivers/`
    - `coredaq_driver.py` (wrapper around existing API)
    - `pm100_driver.py`
    - `flux_dac_driver.py`
  - `workflows/`
    - `linear_calibration.py`
    - `log_calibration.py`
    - `splitter_characterization.py`
  - `models/`
    - linear regression models
    - log parametric model
    - optional LUT fallback model
  - `io/`
    - metadata schema, H5/JSON writers
  - `cli.py`

Design principles:

- Config-driven workflow (`yaml/json` recipe)
- Dry-run mode for hardware-safe testing
- Resume support for interrupted calibrations
- Deterministic seed/control for fitting choices

---

## 12) Integration with Existing GUI

Near-term:

- Keep calibration automation as CLI + backend callable routines.

Later:

- Add Calibration Wizard tab in GUI:
  - Instrument check
  - Run sequence
  - Live status + plots
  - Result approval
  - Coefficient deploy + verification

Ensure GUI gates functionality by frontend type:

- LINEAR routines only for LINEAR devices
- LOG routines only for LOG devices

---

## 13) Initial Execution Plan for the Agent

### Phase 1: Foundation

- Define DAC CDC protocol and implement firmware + Python driver
- Implement PM100 driver and verify readings
- Create calibration run metadata schema

### Phase 2: Measurement Harness

- Build synchronized acquisition loop:
  - set DACs
  - settle
  - read PM100
  - read CoreDAQ snapshots
- Store raw data robustly

### Phase 3: LINEAR Calibration

- Implement per-channel/per-gain fitting and QA
- Generate coefficient package + report
- Add host-side coefficient override usage path

### Phase 4: LOG Calibration

- Implement and validate primary log parametric model
- Add LUT fallback path only for non-conforming datasets
- Validate monotonicity and residuals

### Phase 5: Deployment and Tooling

- Implement firmware persistent write path (commands + API wrappers)
- Add CLI and optional GUI integration
- Add regression tests with recorded datasets

---

## 14) Core Constraints and Pitfalls to Avoid

- Do not query CoreDAQ aggressively while acquisition/transfer is active.
- Do not mix LINEAR and LOG calibration logic.
- Do not trust unvalidated splitter ratio assumptions.
- Do not hide uncertainty: always report confidence/quality.
- Do not silently overwrite calibration history.
- Do not force intercept to zero on single-supply analog paths.
- Do not treat dirty/unstable fiber connections as software noise; fix optics first.

---

## 15) Deliverables Expected from the Agent

1. Working DAC control stack over USB CDC FS
2. Automated calibration CLI workflow for LINEAR and LOG
3. Raw + processed data persistence with traceability metadata
4. Fit models with QA reports and acceptance checks
5. Coefficient deployment path (host override first, firmware persistent next)
6. Documentation for operators and developers

---

If tradeoffs are required, prioritize:

1. scientific correctness,
2. repeatability,
3. traceability,
4. automation convenience.

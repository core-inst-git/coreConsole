# coreDAQ MCU Agent Note (Firmware-Side)

## 1) Scope
This note is for MCU firmware development only.
Focus on STM32F7 firmware behavior for acquisition, USB protocol, timing, and memory flow.
PC-side GUI/API details are out of scope except where protocol compatibility matters.

## 2) Firmware Repos and Variants
Current firmware repos in this workspace:
- `LinearFirmware/` -> linear TIA path firmware
- `LogFirmware/` -> log TIA path firmware

Frontend/detector combinations conceptually supported:
- LINEAR + InGaAs
- LINEAR + Silicon
- LOG + InGaAs
- LOG + Silicon

Important current status:
- Only LINEAR and LOG are distinct firmware codebases.
- Silicon vs InGaAs is currently mostly an identifier/config label (`IDN`/head info), not a different embedded signal-processing path yet.
- Detector-specific power-conversion differences are currently handled host-side.

## 3) MCU Responsibilities
- Deterministic ADC acquisition timing
- Trigger/timer state machine control
- BUSY/DRDY synchronized SPI readout from ADC chain
- SDRAM/FMC buffering and burst-safe writes
- USB CDC command/response + bulk transfer behavior
- Report stable device identity and mode (head/frontend/version)

## 4) Acquisition Pipeline (Core)
Nominal sequence:
1. Timer or external trigger arms conversion cadence
2. CONVST asserted per sample event
3. Wait for ADC BUSY falling edge
4. SPI read sample words
5. Pack samples according to channel mask/order
6. Write to SDRAM ring/linear capture region
7. On host request, transfer buffered data over USB

Key rule:
- During active acquisition/transfer, avoid extra command traffic that can perturb timing.

## 5) State Machine Requirements
Firmware should expose clear mutually-exclusive runtime states, e.g.:
- `IDLE`
- `ARMED`
- `ACQUIRING`
- `CAPTURE_DONE`
- `TRANSFERRING`
- `ERROR`

Host-visible behavior must be consistent:
- Reject configuration changes in unsafe states with explicit busy/state errors.
- Permit transfer only after acquisition completion criteria are met.

## 6) Protocol/Command Essentials
Must remain backward-compatible where practical.
Critical command categories:
- identity/version/head type (`IDN?`, head type query)
- acquisition configuration (sample rate, oversampling index, channel mask, gain for linear)
- control (start/arm/stop/status)
- snapshots (quick reads)
- capture transfer (`XFER` path) for SDRAM data

Protocol quality bar:
- deterministic response format
- bounded response latency
- no ambiguous units in payload comments vs actual payload

## 7) LINEAR vs LOG Firmware Differences (Embedded)
LINEAR firmware:
- gain switching path enabled (GPIO expander/controls)
- autogain hooks available (if managed by host + command path)
- zeroing-related command support expected

LOG firmware:
- no gain switching path
- no linear zero-cal flow dependency in firmware behavior
- acquisition/transfer transport behavior should still mirror linear where possible

Shared requirement:
- keep transport/state-machine reliability equivalent across both repos.

## 8) Detector Type (Si vs InGaAs) Current Handling
As of now:
- Si/InGaAs mainly affects identity metadata
- detector spectral responsivity and final power conversion are host/API responsibilities
- firmware should still expose unambiguous model identity so host can apply correct conversion

Future note:
- detector-specific firmware branches can be added later; keep current code structured to allow this.

## 9) Build and Output Expectations
For both `LinearFirmware` and `LogFirmware`:
- Release build is primary target
- produce both `.elf` and `.bin`
- ensure VS Code/CLI tasks are deterministic and do not require manual post-steps

## 10) Reliability Priorities
1. USB transfer robustness for large SDRAM payloads
2. No deadlocks between acquisition and transfer states
3. Accurate BUSY-edge-driven sample timing
4. Safe config validation (freq/OS/channel mask ranges)
5. Clear and fast error reporting (`BUSY`, invalid state, invalid args)

## 11) Minimum Validation After Firmware Changes
- Build Release for both repos
- Verify command parser still responds to identity/config/status commands
- Run snapshot sanity check
- Run triggered capture + full transfer (including large captures)
- Confirm no protocol regression for host API

## 12) Engineering Rules for Agent
- Do not silently change command semantics.
- Keep timing-critical ISR paths minimal and bounded.
- Keep buffer ownership/hand-off explicit between ISR and main loop contexts.
- Mirror transport/state-machine fixes to both firmware repos unless intentionally variant-specific.
- If changing payload format, update protocol docs and host API in lockstep.

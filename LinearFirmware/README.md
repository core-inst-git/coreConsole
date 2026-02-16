# LinearFirmware

Firmware for CoreDAQ Linear head on STM32F7 (STM32CubeIDE/CubeMX project), including:

- AD7606-based synchronous 4-channel acquisition
- Timer-driven conversion and BUSY-edge data capture
- SDRAM (FMC) buffering for long captures
- USB CDC command/control and bulk transfer
- Python host API (`API/coredaq_python_api.py`)

## Hardware/Firmware Summary

- MCU: STM32F730 (CubeMX-generated project structure)
- ADC: AD7606 (4 active channels, 16-bit signed samples)
- Acquisition timing:
  - CONVST from timer PWM
  - data-ready from BUSY falling edge
  - SPI read on BUSY event
- Memory: 32 MB external SDRAM via FMC (`0xC0000000`)
- USB:
  - HS CDC used for normal command + data transfer
  - FS path available for DFU scenarios

## Repository Layout

- `Core/` application code, ISR hooks, Cube-generated startup/init
- `USB_DEVICE/` USB CDC class glue and command parser
- `Drivers/` STM32 HAL + CMSIS
- `Middlewares/` STM32 USB middleware
- `API/` Python host API and tooling
- `coreDAQ_firmware_LINEAR_v1.0.ioc` CubeMX project configuration

## Build (STM32CubeIDE)

1. Open STM32CubeIDE.
2. Import existing project from this folder.
3. Select `Debug` or `Release` configuration.
4. Build project.

Output binaries are generated under `Debug/` or `Release/` (ignored by Git).

## Flash and Run

- Use ST-LINK from CubeIDE ("Run" or "Debug").
- Confirm USB HS enumeration on host.
- Use CDC command protocol or Python API for operation.

## USB Command Protocol (Typical)

Examples of supported commands:

- `IDN?`
- `HEAD_TYPE?`
- `GAIN <head> <0..7>`, `GAINS?`
- `OS <0..7>`, `OS?`
- `FREQ <hz>`, `FREQ?`
- `ACQ ARM <frames>`, `ACQ START`, `ACQ STOP`
- `TRIGARM <frames> R|F`
- `SNAP <N>`, `SNAP?`, `SNAP CANCEL`
- `XFER <bytes>`
- `SOFTRESET`
- `DFU`

Recent extension:

- `CHMASK?`
- `CHMASK <mask>` where mask is 4-bit (`0x1..0xF`, bit0..bit3 => CH1..CH4)

`CHMASK` controls which channels are stored to SDRAM during streaming, enabling longer captures when fewer channels are saved.

## Python API

Host-side interface is provided in:

- `API/coredaq_python_api.py`

Install dependency:

```bash
pip install pyserial
```

Then use `CoreDAQ` class to:

- detect/connect device
- configure gain, frequency, oversampling
- run snapshot or streaming acquisition
- transfer and parse acquired frames

## Git Workflow

Recommended workflow:

1. Create a feature branch:
   - `git checkout -b feature/<short-topic>`
2. Commit focused changes with clear messages.
3. Open PR and review before merge to `main`.

Suggested commit style:

- `feat: ...` new functionality
- `fix: ...` bug fix
- `chore: ...` maintenance/build/docs
- `docs: ...` documentation updates

## Notes for CubeMX Regeneration Safety

- Keep custom logic in `USER CODE BEGIN/END` blocks where possible.
- Avoid editing generated init code unless necessary.
- Preserve IRQ timing assumptions (BUSY/CONVST/SPI ordering).

## License

Project licensing follows the existing STM32Cube and project source headers. Add a top-level license file if you want explicit repository-level licensing.

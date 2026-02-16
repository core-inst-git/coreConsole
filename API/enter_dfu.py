#!/usr/bin/env python3
"""
Find coreDAQ on a serial port, issue DFU command, and confirm DFU enumeration.
"""

import argparse
import re
import shutil
import subprocess
import sys
import time

import serial
import serial.tools.list_ports

from coredaq_python_api import CoreDAQ, CoreDAQError


def _find_tool() -> tuple[str, list[str]] | tuple[None, None]:
    dfu_util = shutil.which("dfu-util")
    if dfu_util:
        return dfu_util, ["-l"]

    stm32_prog = shutil.which("STM32_Programmer_CLI") or shutil.which("stm32programmercli")
    if stm32_prog:
        return stm32_prog, ["-l"]

    return None, None


def _list_ports():
    return list(serial.tools.list_ports.comports())


def _find_coredaq_port(port_hint: str | None, timeout: float) -> str | None:
    if port_hint:
        return port_hint

    for p in _list_ports():
        try:
            dev = CoreDAQ(p.device, timeout=timeout)
            idn = dev.idn()
            dev.close()
            if "COREDAQ" in idn.upper():
                return p.device
        except (CoreDAQError, serial.SerialException, OSError):
            try:
                dev.close()  # type: ignore[misc]
            except Exception:
                pass
            continue
    return None


def _send_dfu(port: str, timeout: float) -> None:
    # Device often disconnects immediately on DFU; do not wait for response.
    ser = serial.Serial(port=port, baudrate=115200, timeout=timeout, write_timeout=0.5)
    try:
        ser.reset_input_buffer()
        ser.write(b"DFU\n")
        ser.flush()
    finally:
        try:
            ser.close()
        except Exception:
            pass


def _wait_for_dfu(tool: str, args: list[str], vidpid: str, timeout_s: float) -> str | None:
    deadline = time.time() + timeout_s
    vidpid_l = vidpid.lower()

    while time.time() < deadline:
        try:
            r = subprocess.run([tool, *args], capture_output=True, text=True)
            out = (r.stdout or "") + (r.stderr or "")
        except Exception:
            out = ""

        if vidpid_l in out.lower() or re.search(r"dfu", out, re.IGNORECASE):
            return out.strip()

        time.sleep(0.5)
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Enter DFU mode via coreDAQ CDC and confirm DFU enumeration.")
    ap.add_argument("--port", help="Serial port (COMx, /dev/tty.*). If omitted, auto-detect.")
    ap.add_argument("--timeout", type=float, default=0.1, help="Serial timeout seconds (default 0.1).")
    ap.add_argument("--dfu-timeout", type=float, default=20.0, help="Seconds to wait for DFU (default 20).")
    ap.add_argument("--vidpid", default="0483:df11", help="Expected DFU VID:PID (default 0483:df11).")
    args = ap.parse_args()

    port = _find_coredaq_port(args.port, args.timeout)
    if not port:
        print("coreDAQ not found on any serial port.")
        return 1

    print(f"coreDAQ found on port {port}. Entering DFU.")
    _send_dfu(port, args.timeout)

    tool, tool_args = _find_tool()
    if not tool:
        print("DFU tool not found. Install dfu-util or STM32_Programmer_CLI.")
        return 2

    info = _wait_for_dfu(tool, tool_args, args.vidpid, args.dfu_timeout)
    if not info:
        print("DFU device not detected (timeout).")
        return 3

    print("DFU device enumerated:")
    print(info)
    return 0


if __name__ == "__main__":
    sys.exit(main())

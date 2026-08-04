#!/usr/bin/env python3
"""
Line-mode serial console for coreDAQ.
Type a full line, press Enter to send.
"""

import argparse
import sys
import time

import serial
import serial.tools.list_ports

from coredaq_python_api import CoreDAQ, CoreDAQError


def _find_coredaq_port(timeout: float) -> str | None:
    for p in serial.tools.list_ports.comports():
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


def main() -> int:
    ap = argparse.ArgumentParser(description="Line-mode serial console for coreDAQ.")
    ap.add_argument("--port", help="Serial port (COMx, /dev/tty.*). If omitted, auto-detect.")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--timeout", type=float, default=0.1)
    args = ap.parse_args()

    port = args.port or _find_coredaq_port(args.timeout)
    if not port:
        print("coreDAQ not found on any serial port.")
        return 1

    print(f"coreDAQ found on port {port}. Line console ready. Ctrl+C to quit.")

    try:
        ser = serial.Serial(port=port, baudrate=args.baud, timeout=args.timeout)
    except Exception as e:
        print(f"Failed to open {port}: {e}")
        return 2

    try:
        ser.reset_input_buffer()
        while True:
            try:
                line = input("> ")
            except EOFError:
                break

            if not line:
                continue
            ser.write((line.strip() + "\n").encode("ascii", errors="ignore"))
            ser.flush()

            # Read until a line comes back or a short timeout elapses
            t0 = time.time()
            while True:
                resp = ser.readline()
                if resp:
                    print(resp.decode("ascii", "ignore").strip())
                    break
                if time.time() - t0 > 0.5:
                    break
    except KeyboardInterrupt:
        pass
    finally:
        ser.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())

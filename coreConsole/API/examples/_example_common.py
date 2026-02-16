#!/usr/bin/env python3
"""Shared helpers for coreDAQ API examples."""

from __future__ import annotations

import argparse
import os
import sys
import time
from typing import List

SCRIPT_DIR = os.path.abspath(os.path.dirname(__file__))
API_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
if API_DIR not in sys.path:
    sys.path.insert(0, API_DIR)

from coredaq_python_api import CoreDAQ  # noqa: E402


def add_port_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--port",
        type=str,
        default="",
        help="Manual serial port (e.g. COM7, /dev/ttyACM0). If omitted, auto-find is used.",
    )
    parser.add_argument(
        "--device-index",
        type=int,
        default=0,
        help="When auto-finding multiple devices, pick this index (default: 0).",
    )
    parser.add_argument("--timeout", type=float, default=0.15, help="Serial command timeout in seconds.")
    parser.add_argument(
        "--cmd-gap-ms",
        type=float,
        default=2.0,
        help="Inter-command gap in milliseconds (helps avoid BUSY on some hosts).",
    )


def resolve_port(port_arg: str, device_index: int, timeout: float) -> str:
    if port_arg:
        return port_arg
    ports: List[str] = CoreDAQ.find(timeout=timeout)
    if not ports:
        raise RuntimeError("No coreDAQ detected. Pass --port manually.")
    ports = sorted(ports)
    if device_index < 0 or device_index >= len(ports):
        raise RuntimeError(
            f"--device-index {device_index} out of range for {len(ports)} detected devices: {ports}"
        )
    return ports[device_index]


def connect_from_args(args: argparse.Namespace) -> CoreDAQ:
    port = resolve_port(args.port, args.device_index, args.timeout)
    print(f"Connecting to coreDAQ on {port} ...")
    dev = CoreDAQ(port=port, timeout=args.timeout)
    try:
        dev.set_inter_command_gap_s(max(0.0, float(args.cmd_gap_ms)) / 1000.0)
    except Exception:
        pass
    return dev


def _is_busy_error(exc: BaseException) -> bool:
    return "BUSY" in str(exc).upper()


def ensure_idle(dev: CoreDAQ, timeout_s: float = 2.0, poll_s: float = 0.05) -> None:
    """
    Best-effort transition to READY state before reconfiguration.
    Useful when previous sessions left acquisition armed/running.
    """
    deadline = time.time() + max(0.2, float(timeout_s))
    while time.time() < deadline:
        try:
            if int(dev.state_enum()) == 4:
                return
        except Exception:
            pass
        try:
            dev.stop_acquisition()
        except Exception:
            pass
        time.sleep(max(0.01, float(poll_s)))


def call_with_busy_retry(
    dev: CoreDAQ,
    op,
    *args,
    retries: int = 30,
    delay_s: float = 0.05,
):
    """
    Retry API operations that can transiently fail with BUSY.
    """
    last_exc = None
    for _ in range(max(1, int(retries))):
        try:
            return op(*args)
        except Exception as exc:
            if not _is_busy_error(exc):
                raise
            last_exc = exc
            try:
                dev.stop_acquisition()
            except Exception:
                pass
            time.sleep(max(0.01, float(delay_s)))
    if last_exc is not None:
        raise last_exc

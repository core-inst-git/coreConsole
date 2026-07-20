#!/usr/bin/env python3
"""coreDAQ backend service (Python / py_coreDAQ).

Replaces the legacy Node backend (coredaq_service.js + coredaq_js_api.js).
Speaks the *same* JSON-over-WebSocket protocol on ws://127.0.0.1:8765 so the
existing React renderer is unchanged:

  inbound   {type:'console', cmd, device_id?}
            {type:'control', action, ...}
  outbound  {type:'status' | 'stream' | 'console' | 'control', ...}

Device I/O + all calibration/unit math live in py_coreDAQ (the single source of
truth).  py_coreDAQ is synchronous/blocking, so every device call is dispatched
to a worker thread via ``asyncio.to_thread``; the driver's transport lock keeps
concurrent status/stream access safe.

GPIB / laser sweeps (pyvisa + FTDI-direct) and HDF5 save are added in Phase 2;
the corresponding actions are stubbed here with actionable errors.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import signal
import sys
import time
import warnings
from datetime import datetime, timezone
from typing import Any, Optional

import numpy as np
from websockets.asyncio.server import serve, broadcast as ws_broadcast

from py_coreDAQ import coreDAQ
from py_coreDAQ import (
    coreDAQError,
    coreDAQConnectionError,
    coreDAQUnsupportedError,
)

from lasers import (
    FtdiTransport,
    LaserError,
    open_laser,
    open_transport,
    probe_resource,
)
from sweep_engines import SweepParams, run_sweep

# --------------------------------------------------------------------------
# Constants (mirrors coredaq_service.js)
# --------------------------------------------------------------------------
FRONTEND_LINEAR = "LINEAR"
FRONTEND_LOG = "LOG"
DETECTOR_INGAAS = "INGAAS"
DETECTOR_SILICON = "SILICON"

INGAAS_WAVELENGTH_RANGE_NM = (910.0, 1700.0)
SILICON_WAVELENGTH_RANGE_NM = (400.0, 1100.0)

LIVE_STREAM_TARGET_HZ = 500
LIVE_STREAM_PERIOD_S = max(0.001, 1.0 / LIVE_STREAM_TARGET_HZ)
STREAM_MAX_CONSEC_ERRORS = 5
DISCOVERY_INTERVAL_S = 2.0

# Stream samples are read at 500 Hz but broadcast in batches: one JSON message
# per device per flush window instead of one per sample (~20x fewer messages,
# frames and JSON encodes).
STREAM_FLUSH_PERIOD_S = 0.025

# Sweep previews/zoom windows: shared-x min/max envelope decimation. The cap
# bounds what a client can request; the default keeps charts snappy while the
# full-resolution data stays here for zooming and H5 export.
SWEEP_PREVIEW_POINTS_DEFAULT = 4000
SWEEP_PREVIEW_POINTS_MAX = 20000
SWEEP_MAX_SAMPLES = 4_000_000  # backend memory cap (~128 MB for 4 float64 ch)

WS_HOST = "127.0.0.1"

LASER_REGISTRY_PATH = os.path.join(
    os.path.expanduser("~"), ".coreconsole", "laser_registry.json")

# py_coreDAQ emits a RuntimeWarning when a wavelength is clamped to the detector
# range; the backend clamps deliberately, so keep those out of the log stream.
# (Filtered by message because the driver raises it with stacklevel=2, which
# attributes it to this module rather than to py_coreDAQ.)
warnings.filterwarnings(
    "ignore", message=r"wavelength_nm=.*is outside", category=RuntimeWarning)


def now_sec() -> float:
    return time.monotonic()


def iso_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def fw_major_from_idn(idn: str) -> Optional[int]:
    m = re.search(r"FW[_-]?V?(\d+)", str(idn or "").upper())
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def device_key_from_idn(idn: str, port: str) -> str:
    txt = str(idn or "").upper()
    m = re.search(r"\bSN[A-Z0-9]+\b", txt)
    if m:
        return m.group(0)
    tail = re.sub(r"[^A-Z0-9]+", "_", str(port or "").split("/")[-1].upper())
    return f"DEV_{tail or 'UNKNOWN'}"


def normalize_detector_type(detector: Any) -> str:
    txt = str(detector or "").strip().upper()
    if txt in ("SILICON", "SI", "SI_PD", "SIPD"):
        return DETECTOR_SILICON
    return DETECTOR_INGAAS


def detect_detector_type_from_idn(idn: str) -> str:
    txt = str(idn or "").upper()
    if "SILICON" in txt:
        return DETECTOR_SILICON
    if "INGAAS" in txt:
        return DETECTOR_INGAAS
    toks = [t for t in re.split(r"[^A-Z0-9]+", txt) if t]
    if "SI" in toks:
        return DETECTOR_SILICON
    return DETECTOR_INGAAS


def default_wavelength_nm(detector_type: str) -> float:
    return 775.0 if detector_type == DETECTOR_SILICON else 1550.0


def fallback_wavelength_limits(detector_type: str) -> tuple[float, float]:
    if detector_type == DETECTOR_SILICON:
        return SILICON_WAVELENGTH_RANGE_NM
    return INGAAS_WAVELENGTH_RANGE_NM


def log(*args: Any) -> None:
    print("[coredaq-service-py]", *args, file=sys.stderr, flush=True)


class Session:
    """Per-device runtime state (mirrors the JS `s` object)."""

    def __init__(self, device_id: str, port: str, dev: coreDAQ) -> None:
        self.device_id = device_id
        self.port = port
        self.dev = dev
        self.idn = ""
        self.frontend_type = "UNKNOWN"
        self.detector_type = DETECTOR_INGAAS
        self.wavelength_nm: Optional[float] = None
        self.wavelength_min_nm: Optional[float] = None
        self.wavelength_max_nm: Optional[float] = None
        self.stream_enabled = True
        self.autogain_enabled = False
        self.fixed_freq_hz = 500
        self.default_os_idx = 6
        self.last_autogain = 0.0
        self.freq_hz: Optional[int] = None
        self.os_idx: Optional[int] = None
        self.gains: Optional[list[int]] = None
        self.die_temp_c: Optional[float] = None
        self.room_temp_c: Optional[float] = None
        self.room_humidity_pct: Optional[float] = None
        self.busy = False
        self.stream_error_streak = 0
        self.status_poll_error_streak = 0
        self.last_status_poll_ts = 0.0
        # Batched live-stream samples awaiting the next flush.
        self.pending_t: list[float] = []
        self.pending_ch: list[list[float]] = [[], [], [], []]


class CoreDAQBackend:
    def __init__(self, port_override: Optional[str] = None, timeout_s: float = 0.2,
                 simulator: bool = False, sim_frontend: str = "LINEAR",
                 sim_detector: str = "INGAAS", sim_count: int = 1) -> None:
        self.port_override = port_override or None
        self.timeout_s = timeout_s if timeout_s > 0 else 0.2
        self.simulator = simulator
        self.sim_count = max(1, min(4, int(sim_count or 1)))
        self.sim_frontend = sim_frontend
        self.sim_detector = sim_detector

        self.clients: set[Any] = set()
        self.devices: dict[str, Session] = {}
        self.port_to_device: dict[str, str] = {}
        self.unsupported_ports: dict[str, dict] = {}
        self.active_device_id: Optional[str] = None
        self.last_discovery_ts = 0.0
        self.discovery_in_flight = False

        self.stream_enabled_global = True

        self.gpib_resource: Optional[str] = None
        self.gpib_idn: Optional[str] = None
        self.gpib_model: Optional[str] = None
        self.laser_registry: list[dict] = self._load_laser_registry()
        self.sweep_task: Optional[asyncio.Task] = None
        self.sweep_abort = False

        self.capture_state = "idle"
        self.capture_message = ""
        self.last_sweep: Optional[dict] = None

        # Live recording (Record button on the Live tab): taps the 500 Hz
        # stream loop and writes an HDF5 file when the window elapses.
        # {path, duration_s, started, t_end, cards, buffers, stop, prev_stream}
        self.record: Optional[dict] = None

        self.running = True
        self._stream_next_tick = 0.0
        self._stream_last_flush = 0.0

    # ---- lifecycle -------------------------------------------------------
    async def close(self) -> None:
        self.running = False
        for s in list(self.devices.values()):
            await self._close_session(s)
        self.devices.clear()
        self.port_to_device.clear()

    async def _close_session(self, s: Session) -> None:
        try:
            await asyncio.to_thread(s.dev.close)
        except Exception:
            pass

    async def _drop_session(self, device_id: str) -> None:
        s = self.devices.pop(device_id, None)
        if not s:
            return
        self.port_to_device.pop(s.port, None)
        await self._close_session(s)
        if self.active_device_id == device_id:
            self.active_device_id = None

    def _make_unique_device_id(self, base: str) -> str:
        if base not in self.devices:
            return base
        idx = 2
        while True:
            candidate = f"{base}_{idx}"
            if candidate not in self.devices:
                return candidate
            idx += 1

    def _pick_default_active(self) -> Optional[str]:
        if not self.devices:
            return None
        entries = sorted(self.devices.items(), key=lambda kv: kv[0])
        for did, s in entries:
            if str(s.frontend_type or "").upper() == FRONTEND_LINEAR:
                return did
        return entries[0][0]

    # ---- discovery -------------------------------------------------------
    def _open_and_setup_sync(self, port: str) -> Any:
        """Open a port, verify it's a coreDAQ, configure defaults. Blocking.

        Returns a Session on success, an ('unsupported', dict) tuple for a
        recognised-but-unsupported device, or None to skip.
        """
        try:
            if self.simulator:
                dev = coreDAQ.connect(simulator=True, frontend=self.sim_frontend,
                                      detector=self.sim_detector)
            else:
                dev = coreDAQ.connect(port=port, baudrate=115200, timeout=self.timeout_s)
        except Exception:
            return None

        try:
            idn = dev.identify()
        except Exception:
            idn = ""

        if "COREDAQ" not in str(idn).upper():
            try:
                dev.close()
            except Exception:
                pass
            return None

        major = fw_major_from_idn(idn)
        base_id = port if self.simulator else device_key_from_idn(idn, port)

        if major == 3:
            try:
                dev.close()
            except Exception:
                pass
            return ("unsupported", {
                "device_id": base_id,
                "connected": True,
                "port": port,
                "idn": idn,
                "frontend_type": "UNKNOWN",
                "unsupported_firmware": True,
                "unsupported_reason":
                    "Firmware v3 is not supported. Please upgrade to firmware v4.",
            })

        try:
            frontend_type = str(dev.frontend() or "UNKNOWN").upper()
        except Exception:
            frontend_type = "UNKNOWN"

        s = Session(base_id, port, dev)
        s.idn = idn
        s.frontend_type = frontend_type

        # Detector is derived from the calibration image (py_coreDAQ); fall back
        # to IDN heuristics only if that read fails.
        try:
            s.detector_type = normalize_detector_type(dev.detector())
        except Exception:
            s.detector_type = detect_detector_type_from_idn(idn)

        try:
            lo, hi = dev.wavelength_limits_nm(s.detector_type)
            s.wavelength_min_nm = float(lo)
            s.wavelength_max_nm = float(hi)
        except Exception:
            lo, hi = fallback_wavelength_limits(s.detector_type)
            s.wavelength_min_nm = lo
            s.wavelength_max_nm = hi

        try:
            s.wavelength_nm = float(dev.wavelength_nm())
        except Exception:
            s.wavelength_nm = default_wavelength_nm(s.detector_type)

        if s.frontend_type == FRONTEND_LOG:
            s.autogain_enabled = False

        # Manual gain control by default; py_coreDAQ autoRange is opt-in per read.
        try:
            dev.set_autorange(False)
        except Exception:
            pass

        try:
            dev.set_sample_rate_hz(s.fixed_freq_hz)
            dev.set_oversampling(s.default_os_idx)
        except Exception:
            pass

        return s

    async def discover_devices(self, force: bool = False) -> None:
        if self.discovery_in_flight:
            return
        now = now_sec()
        if not force and (now - self.last_discovery_ts) < DISCOVERY_INTERVAL_S:
            return
        self.last_discovery_ts = now
        self.discovery_in_flight = True
        try:
            if self.simulator:
                candidate_ports = [f"SIM{i + 1}" for i in range(self.sim_count)]
            elif self.port_override:
                candidate_ports = [self.port_override]
            else:
                try:
                    candidate_ports = await asyncio.to_thread(
                        coreDAQ.discover, 115200, self.timeout_s)
                except Exception as err:
                    log("discover failed:", err)
                    candidate_ports = []

            present = set(candidate_ports)

            for port, device_id in list(self.port_to_device.items()):
                if port not in present:
                    await self._drop_session(device_id)

            for port in list(self.unsupported_ports.keys()):
                if port not in present:
                    self.unsupported_ports.pop(port, None)

            for port in candidate_ports:
                if port in self.port_to_device:
                    continue
                result = await asyncio.to_thread(self._open_and_setup_sync, port)
                if result is None:
                    continue
                if isinstance(result, tuple) and result[0] == "unsupported":
                    self.unsupported_ports[port] = result[1]
                    continue

                s: Session = result
                s.device_id = self._make_unique_device_id(s.device_id)
                self.devices[s.device_id] = s
                self.port_to_device[port] = s.device_id
                self.unsupported_ports.pop(port, None)

            if not self.active_device_id or self.active_device_id not in self.devices:
                self.active_device_id = self._pick_default_active()
        finally:
            self.discovery_in_flight = False

    # ---- session lookup --------------------------------------------------
    def _get_session(self, requested_device_id: Optional[str], *,
                     require_linear: bool = False) -> Session:
        s: Optional[Session] = None
        if requested_device_id:
            s = self.devices.get(requested_device_id)
            if s is None:
                # Never silently retarget a command meant for one instrument to
                # a different one (the device may have just dropped off USB).
                raise coreDAQError(
                    f"Unknown or disconnected device_id: {requested_device_id}")
        if s is None and self.active_device_id in self.devices:
            s = self.devices[self.active_device_id]
        if s is None and self.devices:
            first = sorted(self.devices.keys())[0]
            s = self.devices[first]
        if s is None:
            raise coreDAQError("No supported CoreDAQ device connected")
        if require_linear and s.frontend_type != FRONTEND_LINEAR:
            raise coreDAQError("This operation is only available on LINEAR front-end devices")
        return s

    def _set_active_device(self, device_id: str) -> None:
        if device_id not in self.devices:
            raise coreDAQError(f"Unknown device_id: {device_id}")
        self.active_device_id = device_id

    # ---- status polling --------------------------------------------------
    def _poll_session_status_sync(self, s: Session) -> bool:
        """Refresh cached device state (blocking). Returns False to drop."""
        try:
            s.freq_hz = int(s.dev.sample_rate_hz())
            s.os_idx = int(s.dev.oversampling())
            if s.frontend_type == FRONTEND_LINEAR:
                gains = s.dev.get_ranges()
                s.gains = [int(gains[i] or 0) for i in range(4)]
            else:
                s.gains = None
        except Exception:
            return False

        try:
            s.detector_type = normalize_detector_type(s.dev.detector())
        except Exception:
            if not s.detector_type:
                s.detector_type = detect_detector_type_from_idn(s.idn)

        try:
            s.wavelength_nm = float(s.dev.wavelength_nm())
        except Exception:
            pass

        try:
            lo, hi = s.dev.wavelength_limits_nm(s.detector_type)
            s.wavelength_min_nm = float(lo)
            s.wavelength_max_nm = float(hi)
        except Exception:
            if s.wavelength_min_nm is None or s.wavelength_max_nm is None:
                lo, hi = fallback_wavelength_limits(s.detector_type)
                s.wavelength_min_nm = lo
                s.wavelength_max_nm = hi

        try:
            s.die_temp_c = float(s.dev.die_temperature_c())
        except Exception:
            s.die_temp_c = None
        try:
            s.room_temp_c = float(s.dev.head_temperature_c())
        except Exception:
            s.room_temp_c = None
        try:
            s.room_humidity_pct = float(s.dev.head_humidity_percent())
        except Exception:
            s.room_humidity_pct = None

        return True

    async def _poll_session_status(self, s: Session) -> bool:
        if s.busy:
            return True
        now = now_sec()
        is_streaming = self.stream_enabled_global and s.stream_enabled
        min_poll = 2.0 if is_streaming else 0.5
        if (now - s.last_status_poll_ts) < min_poll:
            return True
        ok = await asyncio.to_thread(self._poll_session_status_sync, s)
        if not ok:
            # One transient serial hiccup must not drop a live session; only
            # repeated failures mean the device is really gone.
            s.status_poll_error_streak += 1
            if s.status_poll_error_streak >= 3:
                await self._drop_session(s.device_id)
                return False
            s.last_status_poll_ts = now
            return True
        s.status_poll_error_streak = 0
        s.last_status_poll_ts = now
        return True

    # ---- broadcast + status/stream loops ---------------------------------
    def _device_status_payload(self, s: Session) -> dict:
        return {
            "device_id": s.device_id,
            "connected": True,
            "port": s.port,
            "idn": s.idn,
            "frontend_type": s.frontend_type,
            "detector_type": s.detector_type,
            "unsupported_firmware": False,
            "unsupported_reason": None,
            "freq_hz": s.freq_hz,
            "os_idx": s.os_idx,
            "wavelength_nm": s.wavelength_nm,
            "wavelength_min_nm": s.wavelength_min_nm,
            "wavelength_max_nm": s.wavelength_max_nm,
            "gains": s.gains,
            "autogain": bool(s.autogain_enabled),
            "streaming": bool(self.stream_enabled_global and s.stream_enabled),
            "die_temp_c": s.die_temp_c,
            "room_temp_c": s.room_temp_c,
            "room_humidity_pct": s.room_humidity_pct,
            "busy": bool(s.busy),
        }

    async def broadcast(self, msg: dict) -> None:
        # websockets' broadcast() is fire-and-forget: it never awaits, and a
        # client with a saturated send buffer is skipped instead of stalling
        # the 500 Hz stream loop behind its TCP backpressure.
        data = json.dumps(msg)
        try:
            ws_broadcast(list(self.clients), data)
        except Exception:
            pass

    async def status_loop(self) -> None:
        while self.running:
            try:
                any_streaming = any(
                    self.stream_enabled_global and s.stream_enabled
                    for s in self.devices.values())
                # While streaming, still look for hot-plugged devices — just
                # on a slower cadence so port probing can't perturb sampling.
                due = (now_sec() - self.last_discovery_ts) > (
                    10.0 if any_streaming else 0.0)
                if due:
                    try:
                        await self.discover_devices(False)
                    except Exception as err:
                        log("discover error:", err)

                for _, s in sorted(self.devices.items(), key=lambda kv: kv[0]):
                    await self._poll_session_status(s)

                if not self.active_device_id or self.active_device_id not in self.devices:
                    self.active_device_id = self._pick_default_active()

                device_rows = [
                    self._device_status_payload(s)
                    for _, s in sorted(self.devices.items(), key=lambda kv: kv[1].device_id)
                ]
                for _, row in sorted(self.unsupported_ports.items(), key=lambda kv: kv[0]):
                    device_rows.append(dict(row))

                active = self.devices.get(self.active_device_id) if self.active_device_id else None
                unsupported_rows = [d for d in device_rows if d.get("unsupported_firmware")]

                await self.broadcast({
                    "type": "status",
                    "connected": len(self.devices) > 0,
                    "device_count": len(self.devices),
                    "devices": device_rows,
                    "active_device_id": self.active_device_id,
                    "port": active.port if active else None,
                    "idn": active.idn if active else None,
                    "detector_type": active.detector_type if active else None,
                    "freq_hz": active.freq_hz if active else None,
                    "os_idx": active.os_idx if active else None,
                    "wavelength_nm": active.wavelength_nm if active else None,
                    "wavelength_min_nm": active.wavelength_min_nm if active else None,
                    "wavelength_max_nm": active.wavelength_max_nm if active else None,
                    "gains": active.gains if active else None,
                    "autogain": active.autogain_enabled if active else False,
                    "streaming": (self.stream_enabled_global and active.stream_enabled)
                    if active else False,
                    "die_temp_c": active.die_temp_c if active else None,
                    "room_temp_c": active.room_temp_c if active else None,
                    "room_humidity_pct": active.room_humidity_pct if active else None,
                    "unsupported_firmware": len(unsupported_rows) > 0,
                    "unsupported_reason": unsupported_rows[0]["unsupported_reason"]
                    if unsupported_rows else None,
                    "gpib_resource": self.gpib_resource,
                    "gpib_idn": self.gpib_idn,
                    "gpib_model": self.gpib_model,
                    "capture_state": self.capture_state,
                    "capture_message": self.capture_message,
                })
            except Exception as err:
                log("status loop error:", err)
            await asyncio.sleep(1.0)

    def _read_power_w_sync(self, s: Session) -> list[float]:
        power_w = None
        if s.frontend_type == FRONTEND_LINEAR and s.autogain_enabled:
            if (now_sec() - s.last_autogain) > 1.0:
                try:
                    power_w = s.dev.read_all(unit="w", autoRange=True)
                    s.last_autogain = now_sec()
                except Exception:
                    power_w = None
        if not power_w:
            power_w = s.dev.read_all(unit="w", autoRange=False)
        if not isinstance(power_w, list) or len(power_w) < 4:
            raise coreDAQError("Invalid power snapshot payload")
        return [float(power_w[i] or 0.0) for i in range(4)]

    async def stream_loop(self) -> None:
        # Absolute-deadline pacing: each iteration targets the next 1/500 s
        # boundary so device-read time doesn't erode the sample rate (a fixed
        # trailing sleep capped the loop at ~400 Hz). Samples are buffered and
        # broadcast in ~25 ms batches (one message per device per flush).
        # A blanket guard keeps one unexpected exception from killing the loop.
        self._stream_next_tick = now_sec()
        self._stream_last_flush = now_sec()
        while self.running:
            try:
                await self._stream_loop_iteration()
            except asyncio.CancelledError:
                raise
            except Exception as err:
                log("stream loop error (recovering):", err)
                await asyncio.sleep(0.1)

    async def _stream_loop_iteration(self) -> None:
        if not self.stream_enabled_global or not self.devices:
            # A recording must still finalize (partial file) if every device
            # vanished or streaming was disabled mid-record.
            if self.record is not None and (
                self.record.get("stop")
                or not self.devices
                or now_sec() >= self.record["t_end"]
            ):
                await self._finalize_record()
            await asyncio.sleep(0.2)
            self._stream_next_tick = now_sec()
            return

        for _, s in sorted(self.devices.items(), key=lambda kv: kv[0]):
            if not self.stream_enabled_global or not s.stream_enabled or s.busy:
                continue
            try:
                ch = await asyncio.to_thread(self._read_power_w_sync, s)
                ts = now_sec()
                rec = self.record
                if rec is not None and s.device_id in rec["buffers"]:
                    buf = rec["buffers"][s.device_id]
                    buf["t"].append(ts)
                    for i in range(4):
                        buf["ch"][i].append(ch[i])
                s.pending_t.append(ts)
                for i in range(4):
                    s.pending_ch[i].append(ch[i])
                s.stream_error_streak = 0
            except Exception:
                s.stream_error_streak += 1
                if s.stream_error_streak >= STREAM_MAX_CONSEC_ERRORS:
                    await self._drop_session(s.device_id)

        now = now_sec()
        if now - self._stream_last_flush >= STREAM_FLUSH_PERIOD_S:
            self._stream_last_flush = now
            for s in list(self.devices.values()):
                if not s.pending_t:
                    continue
                batch_t, batch_ch = s.pending_t, s.pending_ch
                s.pending_t = []
                s.pending_ch = [[], [], [], []]
                await self.broadcast({
                    "type": "stream",
                    "device_id": s.device_id,
                    "frontend_type": s.frontend_type,
                    "t": batch_t,
                    "ch": batch_ch,
                })

        if self.record is not None and (
            self.record.get("stop") or now_sec() >= self.record["t_end"]
        ):
            await self._finalize_record()

        self._stream_next_tick += LIVE_STREAM_PERIOD_S
        delay = self._stream_next_tick - now_sec()
        if delay > 0:
            await asyncio.sleep(delay)
        else:
            # Fell behind (slow device round trip) — don't accumulate debt.
            self._stream_next_tick = now_sec()
            await asyncio.sleep(0)

    # ---- message handling ------------------------------------------------
    async def _handle_console(self, ws: Any, data: dict) -> None:
        cmd = str(data.get("cmd") or "").strip()
        if not cmd:
            return
        requested_id = str(data.get("device_id") or "").strip() or None
        try:
            sess = self._get_session(requested_id)
        except Exception as err:
            await ws.send(json.dumps({
                "type": "console", "dir": "rx",
                "device_id": requested_id, "text": f"ERR {err}",
            }))
            return

        try:
            st, payload = await asyncio.to_thread(sess.dev._ask, cmd)
            if st == "OK":
                resp = f"OK {payload}".strip()
            elif st == "BUSY":
                resp = "BUSY"
            else:
                resp = f"ERR {payload}".strip()
        except Exception as err:
            resp = f"ERR {err}"

        await ws.send(json.dumps({
            "type": "console", "dir": "rx",
            "device_id": sess.device_id, "text": resp,
        }))

    async def _handle_control(self, ws: Any, data: dict) -> None:
        action = data.get("action")
        requested_id = str(data.get("device_id") or "").strip() or None
        try:
            if action == "set_active_device":
                did = str(data.get("device_id") or "").strip()
                self._set_active_device(did)
                await ws.send(json.dumps({"type": "control", "action": action, "ok": True,
                                          "error": None, "active_device_id": self.active_device_id}))
                return

            if action == "set_gain":
                sess = self._get_session(requested_id, require_linear=True)
                head = int(data.get("head") or 1)
                gain = int(data.get("gain") or 0)
                await asyncio.to_thread(sess.dev.set_range, head - 1, gain)
                await ws.send(json.dumps({"type": "control", "action": action, "ok": True,
                                          "error": None, "device_id": sess.device_id}))
                return

            if action == "set_os":
                sess = self._get_session(requested_id)
                os_idx = int(data.get("os_idx") or 0)
                sess.default_os_idx = os_idx
                await asyncio.to_thread(sess.dev.set_oversampling, os_idx)
                await ws.send(json.dumps({"type": "control", "action": action, "ok": True,
                                          "error": None, "device_id": sess.device_id}))
                return

            if action == "set_wavelength":
                sess = self._get_session(requested_id)
                try:
                    wl = float(data.get("wavelength_nm"))
                except (TypeError, ValueError):
                    raise coreDAQError("Invalid wavelength_nm")
                if not (wl > 0) or wl != wl:  # reject <=0 and NaN
                    raise coreDAQError("Invalid wavelength_nm")

                sess.dev.set_wavelength_nm(wl)
                sess.wavelength_nm = float(sess.dev.wavelength_nm())
                try:
                    sess.detector_type = normalize_detector_type(sess.dev.detector())
                except Exception:
                    pass
                try:
                    lo, hi = sess.dev.wavelength_limits_nm(sess.detector_type)
                    sess.wavelength_min_nm = float(lo)
                    sess.wavelength_max_nm = float(hi)
                except Exception:
                    lo, hi = fallback_wavelength_limits(sess.detector_type)
                    sess.wavelength_min_nm = lo
                    sess.wavelength_max_nm = hi

                await ws.send(json.dumps({
                    "type": "control", "action": action, "ok": True, "error": None,
                    "device_id": sess.device_id,
                    "detector_type": sess.detector_type,
                    "wavelength_nm": sess.wavelength_nm,
                    "wavelength_min_nm": sess.wavelength_min_nm,
                    "wavelength_max_nm": sess.wavelength_max_nm,
                }))
                return

            if action == "set_autogain":
                enabled = bool(data.get("enabled"))
                target: list[str] = []
                if requested_id:
                    sess = self._get_session(requested_id)
                    if sess.frontend_type != FRONTEND_LINEAR:
                        raise coreDAQError("Autogain is only available on LINEAR front-end devices")
                    sess.autogain_enabled = enabled
                    target = [sess.device_id]
                else:
                    for s in self.devices.values():
                        if s.frontend_type == FRONTEND_LINEAR:
                            s.autogain_enabled = enabled
                            target.append(s.device_id)
                await ws.send(json.dumps({"type": "control", "action": action, "ok": True,
                                          "error": None, "device_ids": target}))
                return

            if action == "stream":
                enabled = bool(data.get("enabled"))
                if requested_id:
                    sess = self._get_session(requested_id)
                    sess.stream_enabled = enabled
                else:
                    self.stream_enabled_global = enabled
                    for s in self.devices.values():
                        s.stream_enabled = enabled
                await ws.send(json.dumps({"type": "control", "action": action, "ok": True,
                                          "error": None, "enabled": enabled,
                                          "device_id": requested_id}))
                return

            if action == "recalibrate_zero":
                sess = self._get_session(requested_id, require_linear=True)
                prev_stream = bool(sess.stream_enabled)
                sess.stream_enabled = False
                sess.busy = True
                try:
                    codes, gains = await asyncio.to_thread(self._recalibrate_zero_sync, sess)
                finally:
                    sess.busy = False
                    sess.stream_enabled = prev_stream
                await ws.send(json.dumps({
                    "type": "control", "action": action, "ok": True, "error": None,
                    "device_id": sess.device_id, "zeros": codes, "gains": gains,
                }))
                return

            # ---- live recording ------------------------------------------
            if action == "record_start":
                info = self._start_record(data)
                await ws.send(json.dumps({"type": "control", "action": action,
                                          "ok": True, "error": None, **info}))
                return

            if action == "record_stop":
                if self.record is None:
                    raise coreDAQError("No recording in progress")
                self.record["stop"] = True
                await ws.send(json.dumps({"type": "control", "action": action,
                                          "ok": True, "error": None}))
                return

            # ---- GPIB / laser sweep (Phase 2) --------------------------------
            if action == "gpib_scan":
                timeout_s = min(15.0, max(1.0, float(data.get("timeout_ms") or 5000) / 1000.0))
                if self.simulator:
                    # Simulator offers a fake laser so the whole sweep flow
                    # (scan -> select -> run -> zoom) is exercisable in the UI.
                    resources = [{
                        "resource": "SIM::LASER0::INSTR",
                        "idn": "SIMULATED,TSL-570,00000,1.0",
                        "model": "TSL570",
                        "backend": "sim",
                    }] + [dict(r) for r in self.laser_registry]
                    debug: list[str] = []
                else:
                    resources, debug = await asyncio.to_thread(
                        self._scan_lasers_sync, timeout_s)
                await ws.send(json.dumps({
                    "type": "control", "action": action, "ok": True, "error": None,
                    "resources": resources, "debug": debug, "backend": "python",
                }))
                return

            if action == "laser_probe":
                resource = str(data.get("resource") or "").strip()
                if not resource:
                    raise coreDAQError("No laser resource provided")
                row = await asyncio.to_thread(probe_resource, resource)
                await ws.send(json.dumps({"type": "control", "action": action,
                                          "ok": True, "error": None, **row}))
                return

            if action == "laser_add":
                resource = str(data.get("resource") or "").strip()
                if not resource:
                    raise coreDAQError("No laser resource provided")
                row = await asyncio.to_thread(probe_resource, resource)
                self.laser_registry = [
                    r for r in self.laser_registry if r.get("resource") != resource
                ] + [row]
                self._save_laser_registry()
                await ws.send(json.dumps({"type": "control", "action": action,
                                          "ok": True, "error": None, **row}))
                return

            if action == "laser_remove":
                resource = str(data.get("resource") or "").strip()
                before = len(self.laser_registry)
                self.laser_registry = [
                    r for r in self.laser_registry if r.get("resource") != resource]
                if len(self.laser_registry) != before:
                    self._save_laser_registry()
                await ws.send(json.dumps({"type": "control", "action": action,
                                          "ok": True, "error": None,
                                          "resource": resource,
                                          "removed": before != len(self.laser_registry)}))
                return

            if action == "gpib_select":
                resource = str(data.get("resource") or "").strip()
                if not resource:
                    raise coreDAQError("No GPIB resource provided")
                self.gpib_resource = resource
                await ws.send(json.dumps({"type": "control", "action": action, "ok": True,
                                          "error": None, "resource": resource, "backend": "pending"}))
                return

            if action == "sweep_run":
                sess = self._get_session(requested_id)
                resource = str(data.get("resource") or "").strip()
                if self.simulator and (not resource or resource.upper().startswith("SIM::")):
                    await self._run_sim_sweep(ws, sess, data)
                    return
                if self.sweep_task is not None and not self.sweep_task.done():
                    raise coreDAQError("A sweep is already running")
                if sess.busy:
                    raise coreDAQError(f"Device {sess.device_id} is busy")
                # Long-running: run as a task so this client's other commands
                # (and every other client) stay responsive; the sweep_run
                # reply is sent by the task itself when the sweep finishes.
                self.sweep_task = asyncio.create_task(
                    self._run_real_sweep(ws, sess, data))
                return

            if action == "sweep_abort":
                if self.sweep_task is None or self.sweep_task.done():
                    raise coreDAQError("No sweep in progress")
                self.sweep_abort = True
                await ws.send(json.dumps({"type": "control", "action": action,
                                          "ok": True, "error": None}))
                return

            if action == "sweep_window":
                await self._handle_sweep_window(ws, data)
                return

            if action == "sweep_save_h5":
                path = str(data.get("path") or "").strip()
                if not path:
                    raise coreDAQError("No output path provided")
                result = await asyncio.to_thread(self._write_sweep_h5_sync, path)
                await ws.send(json.dumps({"type": "control", "action": action,
                                          "ok": True, "error": None, **result}))
                return

            if action == "gpib_query":
                resource = str(data.get("resource") or self.gpib_resource or "").strip()
                cmd = str(data.get("cmd") or data.get("command") or "").strip()
                if not resource:
                    raise coreDAQError("No laser resource selected")
                if not cmd:
                    raise coreDAQError("No command provided")

                def _q() -> tuple[str, Optional[str]]:
                    t = open_transport(resource, timeout_s=3.0)
                    try:
                        if cmd.endswith("?"):
                            return t.query(cmd), None
                        t.write(cmd)
                        return "", None
                    finally:
                        t.close()

                reply, _ = await asyncio.to_thread(_q)
                out = {"resource": resource, "command": cmd, "reply": reply,
                       "backend": resource.split(":", 1)[0]}
                if cmd.upper() == "*IDN?" and reply:
                    from lasers import detect_laser
                    found = detect_laser(reply)
                    if found:
                        out["model"] = found[1]
                        self.gpib_idn = reply
                        self.gpib_model = found[1]
                await ws.send(json.dumps({"type": "control", "action": action,
                                          "ok": True, "error": None, **out}))
                return

            await ws.send(json.dumps({"type": "control", "action": action, "ok": False,
                                      "error": "Unknown action"}))
        except Exception as err:
            self.capture_state = "idle"
            self.capture_message = f"Error: {err}"
            await ws.send(json.dumps({
                "type": "control", "action": action, "ok": False,
                "error": str(err), "device_id": requested_id,
            }))

    # ---- laser registry + real sweeps -------------------------------------

    def _load_laser_registry(self) -> list[dict]:
        try:
            with open(LASER_REGISTRY_PATH, "r") as f:
                data = json.load(f)
            return [r for r in data if isinstance(r, dict) and r.get("resource")]
        except FileNotFoundError:
            return []
        except Exception as err:
            log(f"laser registry unreadable ({err}) — starting empty")
            return []

    def _save_laser_registry(self) -> None:
        try:
            os.makedirs(os.path.dirname(LASER_REGISTRY_PATH), exist_ok=True)
            with open(LASER_REGISTRY_PATH, "w") as f:
                json.dump(self.laser_registry, f, indent=1)
        except Exception as err:
            log(f"laser registry save failed: {err}")

    def _scan_lasers_sync(self, timeout_s: float) -> tuple[list[dict], list[str]]:
        """Registry rows + live VISA scan + FTDI enumeration."""
        rows: list[dict] = [dict(r) for r in self.laser_registry]
        seen = {r["resource"] for r in rows}
        debug: list[str] = []
        deadline = time.monotonic() + max(1.0, timeout_s)

        try:
            import pyvisa
            rm = pyvisa.ResourceManager()
            for res in rm.list_resources():
                if time.monotonic() > deadline:
                    debug.append("VISA scan hit timeout; partial results")
                    break
                if res in seen or "GPIB" not in res.upper():
                    continue
                try:
                    row = probe_resource(res, timeout_s=2.0)
                    rows.append(row)
                    seen.add(res)
                except LaserError as err:
                    debug.append(f"{res}: {err}")
        except LaserError as err:
            debug.append(str(err))
        except Exception as err:
            debug.append(f"VISA unavailable: {err}")

        for sn in FtdiTransport.list_devices():
            res = f"ftdi://SANTEC:{sn}"
            if res in seen or time.monotonic() > deadline:
                continue
            try:
                row = probe_resource(res, timeout_s=2.0)
                rows.append(row)
                seen.add(res)
            except LaserError as err:
                debug.append(f"{res}: {err}")
        return rows, debug

    async def _run_real_sweep(self, ws: Any, sess: Session, data: dict) -> None:
        """Background task: one real laser sweep end-to-end. Owns busy flags,
        sends the sweep_run control reply itself (success or failure)."""
        params = data.get("params") if isinstance(data.get("params"), dict) else {}
        resource = str(data.get("resource") or self.gpib_resource or "").strip()
        laser = None
        try:
            if not resource:
                raise coreDAQError("No laser resource selected")
            try:
                p = SweepParams(
                    start_nm=float(params.get("start_nm") or 1480.0),
                    stop_nm=float(params.get("stop_nm") or 1620.0),
                    speed_nm_s=float(params.get("speed_nm_s") or 50.0),
                    power_mw=float(params.get("power_mw") or 1.0),
                    sample_rate_hz=float(params.get("sample_rate_hz") or 50000.0),
                    os_idx=int(params.get("os_idx") or 0),
                    channel_mask=int(params.get("channel_mask") or 0x0F),
                    gains=[int(g) for g in params.get("gains") or []] or None,
                    default_wavelength_nm=(
                        float(params["default_wavelength_nm"])
                        if params.get("default_wavelength_nm") is not None else None),
                    step_pm=float(params.get("step_pm") or 0.0),
                )
            except (TypeError, ValueError):
                raise coreDAQError("Invalid sweep parameters") from None
            if not (p.speed_nm_s > 0) or abs(p.stop_nm - p.start_nm) < 0.01:
                raise coreDAQError("Invalid sweep range/speed")

            sess.busy = True
            sess.stream_enabled = False
            self.sweep_abort = False
            self.capture_state = "running"
            self.capture_message = "Connecting to laser..."

            laser = await asyncio.to_thread(open_laser, resource)
            self.gpib_resource = resource
            self.gpib_idn = laser.idn
            self.gpib_model = laser.model

            def eng_log(msg: str) -> None:
                self.capture_message = msg
                log("sweep:", msg)

            def progress(done: int, total: int) -> None:
                self.capture_message = f"Sweep {done}/{total} points"

            result = await asyncio.to_thread(
                run_sweep, sess.dev, laser, p,
                is_linear=(sess.frontend_type == FRONTEND_LINEAR),
                detector=sess.detector_type,
                log=eng_log, progress=progress,
                should_abort=lambda: self.sweep_abort or not self.running)

            preview_n = self._clamp_preview_points(params.get("preview_points"))
            self.last_sweep = {
                "x": result.x,
                "y_w": result.y_w,
                "meta": {
                    "device_id": sess.device_id, "idn": sess.idn,
                    "frontend_type": sess.frontend_type,
                    "detector_type": sess.detector_type,
                    "start_nm": p.start_nm, "stop_nm": p.stop_nm,
                    "speed_nm_s": p.speed_nm_s, "power_mw": p.power_mw,
                    "sample_rate_hz": result.sample_rate_hz,
                    "os_idx": p.os_idx,
                    "default_wavelength_nm": p.default_wavelength_nm,
                    "laser_idn": laser.idn, "laser_model": laser.model,
                    "engine": result.engine, **result.meta,
                    "created_utc": iso_utc_now(), "simulated": False,
                },
            }
            x_dec, y_dec, is_raw = self._sweep_envelope(
                result.x, result.y_w, preview_n)
            await ws.send(json.dumps({
                "type": "control", "action": "sweep_run", "ok": True, "error": None,
                "device_id": sess.device_id,
                "samples_total": int(result.x.size),
                "full_points": int(result.x.size),
                "x0_nm": float(result.x[0]), "x1_nm": float(result.x[-1]),
                "preview_raw": bool(is_raw),
                "sample_rate_hz": result.sample_rate_hz,
                "os_idx": p.os_idx, "os_idx_requested": p.os_idx,
                "engine": result.engine,
                "simulated": False,
                "series": self._series_payload(x_dec, y_dec),
            }))
        except Exception as err:
            log("sweep failed:", err)
            try:
                await ws.send(json.dumps({
                    "type": "control", "action": "sweep_run", "ok": False,
                    "error": str(err), "device_id": sess.device_id,
                }))
            except Exception:
                pass
        finally:
            # Park the laser at its resting wavelength (the Default Wavelength
            # UI setting — consumed here for the first time), best effort.
            if laser is not None:
                park_nm = None
                try:
                    park_nm = float(params.get("default_wavelength_nm"))
                except (TypeError, ValueError):
                    pass
                if park_nm:
                    try:
                        await asyncio.to_thread(laser.park, park_nm)
                        log(f"laser parked at {park_nm:.3f} nm")
                    except Exception as err:
                        log(f"laser park failed: {err}")
                try:
                    await asyncio.to_thread(laser.close)
                except Exception:
                    pass
            sess.busy = False
            sess.stream_enabled = True
            self.capture_state = "idle"
            self.capture_message = ""
            self.sweep_task = None

    # ---- sweep data (full resolution lives here; UI gets envelopes) -------

    @staticmethod
    def _sweep_envelope(x: Any, ys: Any, n_points: int) -> tuple[Any, list[Any], bool]:
        """Shared-grid min/max envelope decimation.

        Returns (x_dec, [y_dec x4], is_raw). All channels share x_dec so the
        client's index-aligned math cards stay consistent. Each bucket emits
        its min then max, which preserves narrow absorption dips/peaks that
        stride subsampling would erase.
        """
        n = int(x.size)
        if n <= n_points:
            return x, [ys[i] for i in range(ys.shape[0])], True
        buckets = max(1, n_points // 2)
        edges = np.linspace(0, n, buckets + 1, dtype=np.int64)
        starts = edges[:-1]
        ends = np.maximum(edges[1:] - 1, starts)
        x_dec = np.empty(2 * buckets, dtype=np.float64)
        x_dec[0::2] = x[starts]
        x_dec[1::2] = x[ends]
        y_out = []
        for i in range(ys.shape[0]):
            mins = np.minimum.reduceat(ys[i], starts)
            maxs = np.maximum.reduceat(ys[i], starts)
            yi = np.empty(2 * buckets, dtype=np.float64)
            yi[0::2] = mins
            yi[1::2] = maxs
            y_out.append(yi)
        return x_dec, y_out, False

    @staticmethod
    def _series_payload(x: Any, ys: list[Any]) -> list[dict]:
        return [{"data": np.column_stack((x, ys[i])).tolist()} for i in range(len(ys))]

    def _clamp_preview_points(self, requested: Any) -> int:
        try:
            n = int(requested)
        except (TypeError, ValueError):
            n = SWEEP_PREVIEW_POINTS_DEFAULT
        if n <= 0:
            n = SWEEP_PREVIEW_POINTS_DEFAULT
        return max(256, min(n, SWEEP_PREVIEW_POINTS_MAX))

    def _simulate_sweep_sync(self, start_nm: float, stop_nm: float,
                             speed_nm_s: float, power_mw: float,
                             sample_rate_hz: float) -> tuple[Any, Any]:
        """Synthetic gas-cell-like sweep for --simulator mode: baseline with
        HCN-style absorption dips + etalon ripple + noise, at the full sample
        count a real sweep would produce."""
        n = int(round(abs(stop_nm - start_nm) / max(speed_nm_s, 1e-6) * sample_rate_hz))
        n = max(100, min(n, SWEEP_MAX_SAMPLES))
        lo, hi = min(start_nm, stop_nm), max(start_nm, stop_nm)
        x = np.linspace(lo, hi, n)
        base_w = max(power_mw, 1e-3) * 1e-3
        rng = np.random.default_rng(0xC0DE)

        line_centers = np.arange(1528.0, 1563.0, 0.65)
        depths = 0.25 + 0.6 * (0.5 + 0.5 * np.sin(np.arange(line_centers.size) * 1.7))
        sigma_nm = 0.004  # ~4 pm lines: invisible in a stride-decimated preview
        absorb = np.zeros_like(x)
        span = x[-1] - x[0] if n > 1 else 1.0
        for c, d in zip(line_centers, depths):
            if not (lo - 0.1 <= c <= hi + 0.1):
                continue
            i0 = int(np.searchsorted(x, c - 6 * sigma_nm))
            i1 = int(np.searchsorted(x, c + 6 * sigma_nm))
            if i1 <= i0:
                continue
            seg = x[i0:i1]
            absorb[i0:i1] += d * np.exp(-0.5 * ((seg - c) / sigma_nm) ** 2)
        trans = np.clip(1.0 - absorb, 0.02, 1.0)
        etalon = 1.0 + 0.01 * np.sin(2 * np.pi * x / 0.25) + 0.02 * np.sin(2 * np.pi * x / span)

        couplings = (1.0, 0.82, 0.65, 0.5)
        ys = np.empty((4, n), dtype=np.float64)
        for i, cp in enumerate(couplings):
            noise = 1.0 + rng.normal(0.0, 0.002, n)
            ys[i] = base_w * cp * trans * etalon * noise
        return x, ys

    async def _run_sim_sweep(self, ws: Any, sess: Session, data: dict) -> None:
        params = data.get("params") if isinstance(data.get("params"), dict) else {}
        try:
            start_nm = float(params.get("start_nm") or 1480.0)
            stop_nm = float(params.get("stop_nm") or 1620.0)
            speed_nm_s = float(params.get("speed_nm_s") or 50.0)
            power_mw = float(params.get("power_mw") or 1.0)
            sample_rate_hz = float(params.get("sample_rate_hz") or 50000.0)
            os_idx = int(params.get("os_idx") or 0)
        except (TypeError, ValueError):
            raise coreDAQError("Invalid sweep parameters") from None
        if not (speed_nm_s > 0) or abs(stop_nm - start_nm) < 0.01:
            raise coreDAQError("Invalid sweep range/speed")
        preview_n = self._clamp_preview_points(params.get("preview_points"))

        sess.busy = True
        self.capture_state = "running"
        self.capture_message = "Simulated sweep in progress"
        try:
            x, ys = await asyncio.to_thread(
                self._simulate_sweep_sync, start_nm, stop_nm, speed_nm_s,
                power_mw, sample_rate_hz)
            # Mimic a real sweep taking wall-clock time (capped) so the UI's
            # busy/progress states are exercised.
            await asyncio.sleep(min(2.0, abs(stop_nm - start_nm) / speed_nm_s))
        finally:
            sess.busy = False
            self.capture_state = "idle"
            self.capture_message = ""

        self.last_sweep = {
            "x": x,
            "y_w": ys,
            "meta": {
                "device_id": sess.device_id,
                "idn": sess.idn,
                "frontend_type": sess.frontend_type,
                "detector_type": sess.detector_type,
                "start_nm": start_nm, "stop_nm": stop_nm,
                "speed_nm_s": speed_nm_s, "power_mw": power_mw,
                "sample_rate_hz": sample_rate_hz, "os_idx": os_idx,
                "default_wavelength_nm": params.get("default_wavelength_nm"),
                "created_utc": iso_utc_now(),
                "simulated": True,
            },
        }
        x_dec, y_dec, is_raw = self._sweep_envelope(x, ys, preview_n)
        await ws.send(json.dumps({
            "type": "control", "action": "sweep_run", "ok": True, "error": None,
            "device_id": sess.device_id,
            "samples_total": int(x.size),
            "full_points": int(x.size),
            "x0_nm": float(x[0]), "x1_nm": float(x[-1]),
            "preview_raw": bool(is_raw),
            "sample_rate_hz": sample_rate_hz,
            "os_idx": os_idx, "os_idx_requested": os_idx,
            "simulated": True,
            "series": self._series_payload(x_dec, y_dec),
        }))

    async def _handle_sweep_window(self, ws: Any, data: dict) -> None:
        if self.last_sweep is None:
            raise coreDAQError("No sweep data available — run a sweep first")
        sweep = self.last_sweep
        x = sweep["x"]
        ys = sweep["y_w"]
        try:
            x0 = float(data.get("x0_nm"))
            x1 = float(data.get("x1_nm"))
        except (TypeError, ValueError):
            raise coreDAQError("Invalid window bounds") from None
        if x1 < x0:
            x0, x1 = x1, x0
        n_points = self._clamp_preview_points(data.get("points"))
        i0 = int(np.searchsorted(x, x0, side="left"))
        i1 = int(np.searchsorted(x, x1, side="right"))
        # Pad one sample each side so line segments continue past the frame.
        i0 = max(0, i0 - 1)
        i1 = min(int(x.size), i1 + 1)
        if i1 - i0 < 2:
            raise coreDAQError("Zoom window contains no sweep samples")
        xw = x[i0:i1]
        yw = ys[:, i0:i1]
        x_dec, y_dec, is_raw = self._sweep_envelope(xw, yw, n_points)
        await ws.send(json.dumps({
            "type": "control", "action": "sweep_window", "ok": True, "error": None,
            "req_id": data.get("req_id"),
            "x0_nm": float(xw[0]), "x1_nm": float(xw[-1]),
            "raw": bool(is_raw),
            "points_in_window": int(i1 - i0),
            "series": self._series_payload(x_dec, y_dec),
        }))

    def _write_sweep_h5_sync(self, path: str) -> dict:
        import h5py

        sweep = self.last_sweep
        if sweep is None:
            raise coreDAQError("No sweep data available to save")
        if not path.lower().endswith(".h5"):
            path += ".h5"
        x = sweep["x"]
        ys = sweep["y_w"]
        with h5py.File(path, "w") as f:
            f.attrs["created_utc"] = iso_utc_now()
            f.attrs["app"] = "coreConsole"
            f.attrs["source"] = "sweep"
            for k, v in sweep["meta"].items():
                if v is None:
                    continue
                try:
                    f.attrs[k] = v
                except TypeError:
                    f.attrs[k] = str(v)
            g = f.create_group("sweep")
            g.create_dataset("wavelength_nm", data=x)
            g.create_dataset("power_w", data=ys.T)  # (N, 4) full resolution
        return {"path": path, "samples": int(x.size)}

    # ---- live recording ---------------------------------------------------

    RECORD_MAX_S = 60.0
    RECORD_NOMINAL_HZ = LIVE_STREAM_TARGET_HZ

    def _start_record(self, data: dict) -> dict:
        """Validate a record_start request and install the recorder state."""
        if self.record is not None:
            raise coreDAQError("A recording is already in progress")

        path = str(data.get("path") or "").strip()
        if not path:
            raise coreDAQError("No output path provided")
        if not path.lower().endswith(".h5"):
            path += ".h5"
        out_dir = os.path.dirname(os.path.abspath(path))
        if not os.path.isdir(out_dir):
            raise coreDAQError(f"Output directory does not exist: {out_dir}")
        if not os.access(out_dir, os.W_OK):
            raise coreDAQError(f"Output directory is not writable: {out_dir}")

        try:
            duration_s = float(data.get("duration_s") or 0)
        except (TypeError, ValueError):
            raise coreDAQError("Invalid duration") from None
        if not (0.5 <= duration_s <= self.RECORD_MAX_S):
            raise coreDAQError(
                f"Duration must be between 0.5 and {self.RECORD_MAX_S:.0f} seconds")

        cards_in = data.get("cards")
        if not isinstance(cards_in, list) or not cards_in:
            raise coreDAQError("No open channel cards to record")

        cards: list[dict] = []
        needed_devices: set[str] = set()
        for c in cards_in:
            if not isinstance(c, dict):
                continue
            kind = str(c.get("kind") or "")
            name = str(c.get("name") or "").strip() or f"card{len(cards) + 1}"
            if kind == "physical":
                did = str(c.get("device_id") or "")
                chn = int(c.get("channel") if c.get("channel") is not None else -1)
                if did not in self.devices or not (0 <= chn <= 3):
                    continue
                needed_devices.add(did)
                cards.append({"kind": "physical", "name": name,
                              "device_id": did, "channel": chn})
            elif kind == "math":
                a = self._parse_source(str(c.get("src_a") or ""))
                b = self._parse_source(str(c.get("src_b") or ""))
                math_type = str(c.get("math_type") or "")
                if not a or not b or math_type not in ("db", "diff", "sum"):
                    continue
                if a[0] not in self.devices or b[0] not in self.devices:
                    continue
                needed_devices.update((a[0], b[0]))
                cards.append({"kind": "math", "name": name, "math_type": math_type,
                              "src_a": a, "src_b": b})
        if not cards:
            raise coreDAQError("No recordable cards (devices disconnected?)")

        # Recording taps the stream loop, so make sure it is running for the
        # involved devices; previous flags are restored when the file is done.
        prev_stream = {"global": self.stream_enabled_global,
                       "sessions": {d: self.devices[d].stream_enabled for d in needed_devices}}
        self.stream_enabled_global = True
        for d in needed_devices:
            self.devices[d].stream_enabled = True

        started = now_sec()
        self.record = {
            "path": path,
            "duration_s": duration_s,
            "started": started,
            "t_end": started + duration_s,
            "cards": cards,
            "buffers": {d: {"t": [], "ch": [[], [], [], []]} for d in needed_devices},
            "stop": False,
            "prev_stream": prev_stream,
            "device_meta": {
                d: {
                    "idn": self.devices[d].idn,
                    "frontend_type": self.devices[d].frontend_type,
                    "detector_type": self.devices[d].detector_type,
                    "wavelength_nm": self.devices[d].wavelength_nm,
                    "gains": list(self.devices[d].gains or []),
                } for d in needed_devices
            },
        }
        return {"path": path, "duration_s": duration_s}

    @staticmethod
    def _parse_source(src: str) -> Optional[tuple[str, int]]:
        """'<device_id>:ch<1..4>' -> (device_id, channel_index 0..3)."""
        m = re.match(r"^(.*):ch([1-4])$", src, re.IGNORECASE)
        if not m:
            return None
        return (m.group(1), int(m.group(2)) - 1)

    async def _finalize_record(self) -> None:
        rec = self.record
        if rec is None:
            return
        self.record = None
        # Restore stream flags synchronously, before any await: a recording
        # started during the (threaded) H5 write below must snapshot the true
        # user state, not our forced-on flags.
        prev = rec.get("prev_stream") or {}
        self.stream_enabled_global = bool(prev.get("global", True))
        for did, enabled in (prev.get("sessions") or {}).items():
            if did in self.devices:
                self.devices[did].stream_enabled = bool(enabled)
        try:
            result = await asyncio.to_thread(self._write_record_h5, rec)
            await self.broadcast({"type": "control", "action": "record_done",
                                  "ok": True, "error": None, **result})
            log(f"recording saved: {result['path']} ({result['frames']} frames)")
        except Exception as err:
            await self.broadcast({"type": "control", "action": "record_done",
                                  "ok": False, "error": str(err), "path": rec["path"]})
            log(f"recording FAILED: {err}")

    def _write_record_h5(self, rec: dict) -> dict:
        import numpy as np
        import h5py

        started = rec["started"]
        buffers = rec["buffers"]

        dev_t: dict[str, Any] = {}
        dev_ch: dict[str, Any] = {}
        for did, buf in buffers.items():
            t = np.asarray(buf["t"], dtype=np.float64) - started
            ch = np.asarray(buf["ch"], dtype=np.float64)  # (4, N)
            dev_t[did] = t
            dev_ch[did] = ch
        total_frames = max((len(t) for t in dev_t.values()), default=0)
        if total_frames == 0:
            raise coreDAQError("Recording captured no samples (stream stalled?)")

        def aligned(a_src: tuple[str, int], b_src: tuple[str, int]):
            (da, ca), (db_, cb) = a_src, b_src
            n = min(len(dev_t[da]), len(dev_t[db_]))
            return dev_t[da][:n], dev_ch[da][ca][:n], dev_ch[db_][cb][:n]

        with h5py.File(rec["path"], "w") as f:
            f.attrs["created_utc"] = iso_utc_now()
            f.attrs["app"] = "coreConsole"
            f.attrs["source"] = "live_record"
            f.attrs["nominal_sample_rate_hz"] = float(self.RECORD_NOMINAL_HZ)
            f.attrs["requested_duration_s"] = float(rec["duration_s"])

            gdev = f.create_group("devices")
            for did in sorted(buffers.keys()):
                g = gdev.create_group(did.replace("/", "_"))
                t = dev_t[did]
                g.create_dataset("time_s", data=t)
                g.create_dataset("power_w", data=dev_ch[did].T)  # (N, 4)
                meta = rec["device_meta"].get(did, {})
                g.attrs["idn"] = str(meta.get("idn") or "")
                g.attrs["frontend_type"] = str(meta.get("frontend_type") or "")
                g.attrs["detector_type"] = str(meta.get("detector_type") or "")
                if meta.get("wavelength_nm") is not None:
                    g.attrs["wavelength_nm"] = float(meta["wavelength_nm"])
                if meta.get("gains"):
                    g.attrs["gains"] = [int(x) for x in meta["gains"]]
                if len(t) >= 2 and t[-1] > t[0]:
                    g.attrs["achieved_sample_rate_hz"] = float((len(t) - 1) / (t[-1] - t[0]))

            gcards = f.create_group("cards")
            for idx, card in enumerate(rec["cards"]):
                safe = re.sub(r"[/\\\\]", "_", card["name"]) or f"card{idx + 1}"
                g = gcards.create_group(f"{idx + 1:02d}_{safe}")
                g.attrs["name"] = card["name"]
                g.attrs["kind"] = card["kind"]
                if card["kind"] == "physical":
                    did, chn = card["device_id"], card["channel"]
                    g.attrs["device_id"] = did
                    g.attrs["channel"] = chn + 1
                    g.attrs["unit"] = "W"
                    g.create_dataset("time_s", data=dev_t[did])
                    g.create_dataset("value", data=dev_ch[did][chn])
                else:
                    t, ya, yb = aligned(card["src_a"], card["src_b"])
                    mt = card["math_type"]
                    if mt == "sum":
                        y = ya + yb
                        unit = "W"
                    elif mt == "diff":
                        y = ya - yb
                        unit = "W"
                    else:  # 'db' — mirror the Live plot: 20*log10(|A|/|B|), 0 -> -120
                        num, den = np.abs(ya), np.abs(yb)
                        with np.errstate(divide="ignore", invalid="ignore"):
                            y = 20.0 * np.log10(num / den)
                        y[~np.isfinite(y)] = -120.0
                        unit = "dB"
                    g.attrs["math_type"] = mt
                    g.attrs["src_a"] = f"{card['src_a'][0]}:ch{card['src_a'][1] + 1}"
                    g.attrs["src_b"] = f"{card['src_b'][0]}:ch{card['src_b'][1] + 1}"
                    g.attrs["unit"] = unit
                    g.create_dataset("time_s", data=t)
                    g.create_dataset("value", data=y)

        return {"path": rec["path"], "frames": int(total_frames),
                "cards": len(rec["cards"]),
                "duration_s": float(rec["duration_s"])}

    def _recalibrate_zero_sync(self, sess: Session) -> tuple[list[int], Optional[list[int]]]:
        codes = list(sess.dev.zero_dark(frames=32, settle_s=0.2))
        try:
            gains = [int(g or 0) for g in sess.dev.get_ranges()]
        except Exception:
            gains = None
        return codes, gains

    async def handle_message(self, ws: Any, raw: Any) -> None:
        try:
            data = json.loads(raw)
        except Exception:
            return
        if not isinstance(data, dict):
            return
        if data.get("type") == "console":
            await self._handle_console(ws, data)
        elif data.get("type") == "control":
            await self._handle_control(ws, data)


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="coredaq_service.py")
    p.add_argument("--port", default=None, help="Force a specific serial port")
    p.add_argument("--ws-port", type=int, default=8765)
    p.add_argument("--timeout", type=float, default=0.2)
    p.add_argument("--simulator", action="store_true",
                   help="Run against a py_coreDAQ simulated device (no hardware)")
    p.add_argument("--sim-frontend", default="LINEAR", choices=["LINEAR", "LOG"])
    p.add_argument("--sim-count", type=int, default=1,
                   help="Number of simulated devices (1-4)")
    p.add_argument("--sim-detector", default="INGAAS", choices=["INGAAS", "SILICON"])
    return p.parse_args(argv)


async def main() -> None:
    args = parse_args(sys.argv[1:])
    backend = CoreDAQBackend(
        port_override=args.port, timeout_s=args.timeout,
        simulator=args.simulator, sim_frontend=args.sim_frontend,
        sim_detector=args.sim_detector, sim_count=args.sim_count,
    )

    ALLOWED_ORIGINS = (None, "", "null", "file://")

    def origin_allowed(origin: Optional[str]) -> bool:
        # The renderer connects from file:// (packaged) or the Vite dev server;
        # native local processes send no Origin. A drive-by web page always
        # sends its http(s) origin -> rejected.
        if origin in ALLOWED_ORIGINS:
            return True
        o = str(origin)
        return o.startswith("http://localhost:") or o.startswith("http://127.0.0.1:")

    async def handler(ws: Any) -> None:
        origin = None
        try:
            origin = ws.request.headers.get("Origin")
        except Exception:
            pass
        if not origin_allowed(origin):
            log(f"rejected websocket connection from origin {origin!r}")
            await ws.close(1008, "origin not allowed")
            return
        backend.clients.add(ws)
        try:
            async for msg in ws:
                await backend.handle_message(ws, msg)
        except Exception:
            pass
        finally:
            backend.clients.discard(ws)

    stop = asyncio.get_running_loop().create_future()

    def _request_stop() -> None:
        if not stop.done():
            stop.set_result(None)

    try:
        asyncio.get_running_loop().add_signal_handler(signal.SIGINT, _request_stop)
        asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, _request_stop)
    except NotImplementedError:
        pass  # Windows: signal handlers on the loop are unsupported

    async with serve(handler, WS_HOST, args.ws_port):
        log(f"websocket listening on ws://{WS_HOST}:{args.ws_port}"
            + (" (simulator)" if args.simulator else ""))
        try:
            await backend.discover_devices(True)
        except Exception as err:
            log("initial discover failed:", err)

        status_task = asyncio.create_task(backend.status_loop())
        stream_task = asyncio.create_task(backend.stream_loop())

        await stop
        backend.running = False
        # Don't discard up to 60 s of buffered recording on SIGTERM/SIGINT —
        # write out what was captured.
        try:
            await backend._finalize_record()
        except Exception as err:
            log("finalize-on-shutdown failed:", err)
        for t in (status_task, stream_task):
            t.cancel()
        await asyncio.gather(status_task, stream_task, return_exceptions=True)
        await backend.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

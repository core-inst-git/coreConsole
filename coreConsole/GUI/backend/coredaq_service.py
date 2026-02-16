#!/usr/bin/env python3
"""
coreDAQ backend service.
- Owns one or more serial ports using coredaq_python_api
- Serves a local WebSocket for UI
"""

import argparse
import asyncio
import json
import math
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set, Tuple

import serial
import serial.tools.list_ports
import websockets

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
API_PATH = os.path.join(ROOT, 'API')
if API_PATH not in sys.path:
    sys.path.insert(0, API_PATH)

from coredaq_python_api import CoreDAQ, CoreDAQError  # noqa: E402

try:
    import pyvisa  # type: ignore
except Exception:  # pragma: no cover
    pyvisa = None

try:
    import h5py  # type: ignore
except Exception:  # pragma: no cover
    h5py = None

SWEEP_SAMPLE_RATE_DEFAULT_HZ = 50_000
SWEEP_SAMPLE_RATE_MAX_HZ = 100_000
SWEEP_TRANSFER_OVERHEAD_S = 1.2
LIVE_STREAM_TARGET_HZ = 500
LIVE_STREAM_PERIOD_S = 1.0 / float(LIVE_STREAM_TARGET_HZ)
STREAM_MAX_CONSEC_ERRORS = 5
COREDAQ_READY_STATE = 4
DISCOVERY_INTERVAL_S = 2.0
COREDAQ_HINTS = ('coredaq', 'core instrumentation', 'core_instrumentation')
USB_CDC_HINTS = ('usbmodem', 'usbserial', 'ttyacm', 'ttyusb')
EXCLUDED_PORT_HINTS = ('bluetooth', 'incoming-port', 'debug-console', 'cmfbuds', 'bt50-audio')


def detect_laser_model(idn: str) -> Optional[str]:
    txt = (idn or '').upper()
    if 'TSL550' in txt or ('SANTEC' in txt and '550' in txt):
        return 'TSL550'
    if 'TSL570' in txt or ('SANTEC' in txt and '570' in txt):
        return 'TSL570'
    if 'TSL770' in txt or ('SANTEC' in txt and '770' in txt):
        return 'TSL770'
    return None


class LaserSession:
    """Thin SCPI wrapper for Santec TSL lasers over VISA/GPIB."""

    def __init__(self, resource: str, timeout_ms: int = 4000, visa_backend: Optional[str] = None):
        if pyvisa is None:
            raise RuntimeError('pyvisa is not installed')
        backend = str(visa_backend or '').strip()
        self._visa_backend = backend
        self._rm = pyvisa.ResourceManager(backend) if backend else pyvisa.ResourceManager()
        self._inst = self._rm.open_resource(resource)
        self._inst.timeout = timeout_ms
        self._inst.read_termination = '\n'
        self._inst.write_termination = '\n'

    def query(self, cmd: str) -> str:
        return str(self._inst.query(cmd)).strip()

    def write(self, cmd: str) -> None:
        self._inst.write(cmd)

    def configure_for_sweep(
        self,
        start_nm: float,
        stop_nm: float,
        power_mw: float,
        speed_nm_s: float,
        model: Optional[str] = None,
    ) -> None:
        self.write('*RST')
        self.write(':POW:ATT:AUT 1')
        self.write(':POW:UNIT 1')
        self.write(':TRIG:INP:EXT0')
        self.write(':WAV:SWE:CYCL 1')
        self.write(':TRIG:OUTP2')
        self.write(':POW 20.0')
        self.write(f':POW {power_mw}')

        model_norm = (model or '').upper().strip()
        if model_norm == 'TSL770':
            # TSL770 sweep wrappers use SI length units.
            start_m = float(start_nm) * 1e-9
            stop_m = float(stop_nm) * 1e-9
            speed_m_s = float(speed_nm_s) * 1e-9
            self.write(':WAV:UNIT 1')
            self.write(f':WAV:SWE:SPE {speed_m_s:.12g}')
            self.write(f':WAV {start_m:.12g}')
            self.write(f':WAV:SWE:STAR {start_m:.12g}')
            self.write(f':WAV:SWE:STOP {stop_m:.12g}')
        else:
            # TSL550/TSL570 use nanometer-form sweep commands.
            self.write(':WAV:UNIT 0')
            self.write(f':WAV:SWE:SPE {speed_nm_s}')
            self.write(f':WAV {start_nm}')
            self.write(f':WAV:SWE:STAR {start_nm}')
            self.write(f':WAV:SWE:STOP {stop_nm}')

        self.write(':WAV:SWE:MOD 1')
        self.write(':WAV:SWE:DWEL 0')

    def start_sweep(self) -> None:
        self.write('WAV:SWE 1')

    def stop_sweep(self) -> None:
        self.write('WAV:SWE 0')

    def close(self) -> None:
        try:
            self._inst.close()
        except Exception:
            pass
        try:
            self._rm.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        self.close()


@dataclass
class DeviceSession:
    device_id: str
    port: str
    dev: CoreDAQ
    idn: str
    frontend_type: str
    detector_type: str = CoreDAQ.DETECTOR_INGAAS
    wavelength_nm: Optional[float] = None
    wavelength_min_nm: Optional[float] = None
    wavelength_max_nm: Optional[float] = None
    stream_enabled: bool = True
    autogain_enabled: bool = False
    fixed_freq_hz: int = 500
    default_os_idx: int = 6
    last_autogain: float = 0.0
    freq_hz: Optional[int] = None
    os_idx: Optional[int] = None
    gains: Optional[List[int]] = None
    die_temp_c: Optional[float] = None
    room_temp_c: Optional[float] = None
    room_humidity_pct: Optional[float] = None
    busy: bool = False
    stream_error_streak: int = 0
    last_stream_error: str = ''
    last_stream_error_ts: float = 0.0
    last_status_poll_ts: float = 0.0


class CoreDAQBackend:
    def __init__(self, port: Optional[str], timeout: float):
        self.port_override = port
        self.timeout = timeout

        self.clients: Set[Any] = set()
        self.devices: Dict[str, DeviceSession] = {}
        self.port_to_device_id: Dict[str, str] = {}
        self.unsupported_ports: Dict[str, Dict[str, Any]] = {}
        self.active_device_id: Optional[str] = None
        self.last_discovery_ts = 0.0

        self.stream_enabled_global = True

        self.gpib_resource: Optional[str] = None
        self.gpib_idn: Optional[str] = None
        self.gpib_model: Optional[str] = None
        self.gpib_backend: Optional[str] = None
        self.gpib_resource_backend: Dict[str, Optional[str]] = {}
        self.visa_backend_hint: Optional[str] = str(os.getenv('COREDAQ_VISA_BACKEND', '')).strip() or None

        self.capture_state = 'idle'
        self.capture_message = ''
        self.last_sweep: Optional[Dict[str, Any]] = None

    @staticmethod
    def _fw_major_from_idn(idn: str) -> Optional[int]:
        text = idn.strip().upper()
        m = re.search(r'FW[_-]?V?(\d+)', text)
        if not m:
            return None
        try:
            return int(m.group(1))
        except ValueError:
            return None

    @staticmethod
    def _device_key_from_idn(idn: str, port: str) -> str:
        text = (idn or '').upper()
        m = re.search(r'\bSN[A-Z0-9]+\b', text)
        if m:
            return m.group(0)
        tail = os.path.basename(port).upper().replace('.', '_').replace('-', '_')
        return f'DEV_{tail}'

    @staticmethod
    def _normalize_detector_type(detector: Optional[str]) -> str:
        txt = str(detector or '').strip().upper()
        if txt in ('SILICON', 'SI', 'SI_PD', 'SIPD'):
            return CoreDAQ.DETECTOR_SILICON
        return CoreDAQ.DETECTOR_INGAAS

    @staticmethod
    def _detect_detector_type_from_idn(idn: str) -> str:
        txt = str(idn or '').upper()
        if 'SILICON' in txt:
            return CoreDAQ.DETECTOR_SILICON
        toks = [t for t in re.split(r'[^A-Z0-9]+', txt) if t]
        if 'SI' in toks:
            return CoreDAQ.DETECTOR_SILICON
        return CoreDAQ.DETECTOR_INGAAS

    @staticmethod
    def _default_wavelength_nm(detector_type: str) -> float:
        return 775.0 if detector_type == CoreDAQ.DETECTOR_SILICON else 1550.0

    @staticmethod
    def _fallback_wavelength_limits_nm(detector_type: str) -> Tuple[float, float]:
        if detector_type == CoreDAQ.DETECTOR_SILICON:
            lo, hi = getattr(CoreDAQ, 'SILICON_WAVELENGTH_RANGE_NM', (400.0, 1100.0))
        else:
            lo, hi = getattr(CoreDAQ, 'INGAAS_WAVELENGTH_RANGE_NM', (910.0, 1700.0))
        return float(lo), float(hi)

    def _make_unique_device_id(self, base: str) -> str:
        if base not in self.devices:
            return base
        idx = 2
        while True:
            candidate = f'{base}_{idx}'
            if candidate not in self.devices:
                return candidate
            idx += 1

    def _close_session(self, session: DeviceSession) -> None:
        try:
            session.dev.close()
        except Exception:
            pass

    def _drop_session(self, device_id: str) -> None:
        session = self.devices.pop(device_id, None)
        if session is None:
            return
        self.port_to_device_id.pop(session.port, None)
        self._close_session(session)
        if self.active_device_id == device_id:
            self.active_device_id = None

    def _pick_default_active(self) -> Optional[str]:
        if not self.devices:
            return None
        linear_ids = [
            did for did, s in sorted(self.devices.items())
            if s.frontend_type.upper() == CoreDAQ.FRONTEND_LINEAR
        ]
        if linear_ids:
            return linear_ids[0]
        return sorted(self.devices.keys())[0]

    def _iter_candidate_ports(self) -> List[str]:
        if self.port_override:
            return [self.port_override]
        matched: List[str] = []
        fallback: List[str] = []
        for p in serial.tools.list_ports.comports():
            dev = str(getattr(p, 'device', '') or '').strip()
            if not dev:
                continue

            text = ' '.join([
                dev,
                str(getattr(p, 'description', '') or ''),
                str(getattr(p, 'manufacturer', '') or ''),
                str(getattr(p, 'product', '') or ''),
                str(getattr(p, 'serial_number', '') or ''),
            ]).lower()
            dev_l = dev.lower()

            # Skip known non-instrument virtual ports that can block open().
            if any(h in text for h in EXCLUDED_PORT_HINTS):
                continue

            if any(h in text for h in COREDAQ_HINTS):
                matched.append(dev)
                continue

            # Keep generic USB CDC ports as fallback candidates.
            if any(h in dev_l for h in USB_CDC_HINTS):
                fallback.append(dev)
                continue

            # Windows-style serial ports.
            if re.fullmatch(r'com\d+', dev_l):
                fallback.append(dev)

        out: List[str] = []
        for seq in (sorted(matched), sorted(fallback)):
            for dev in seq:
                if dev not in out:
                    out.append(dev)
        return out

    @staticmethod
    def _probe_coredaq_idn(port: str, timeout: float = 0.2, attempts: int = 3) -> Optional[str]:
        try:
            with serial.Serial(
                port=port,
                baudrate=115200,
                timeout=timeout,
                write_timeout=timeout,
            ) as ser:
                for _ in range(max(1, int(attempts))):
                    try:
                        ser.reset_input_buffer()
                        ser.reset_output_buffer()
                    except Exception:
                        pass
                    ser.write(b'IDN?\n')
                    ser.flush()
                    line = ser.readline().decode('ascii', 'ignore').strip()
                    if not line:
                        continue
                    if line.startswith('BUSY'):
                        continue
                    if not line.startswith('OK'):
                        continue
                    payload = line[2:].strip()
                    if 'COREDAQ' in payload.upper():
                        return payload
        except Exception:
            return None
        return None

    def _discover_devices(self) -> None:
        now = time.time()
        if (now - self.last_discovery_ts) < DISCOVERY_INTERVAL_S:
            return
        self.last_discovery_ts = now

        candidate_ports = self._iter_candidate_ports()
        present = set(candidate_ports)

        for port, device_id in list(self.port_to_device_id.items()):
            if port not in present:
                self._drop_session(device_id)

        for port in list(self.unsupported_ports.keys()):
            if port not in present:
                self.unsupported_ports.pop(port, None)

        for port in candidate_ports:
            if port in self.port_to_device_id:
                continue

            probe_timeout = min(0.45, max(0.12, float(self.timeout)))
            probed_idn = self._probe_coredaq_idn(port, timeout=probe_timeout)
            if not probed_idn and ('usbmodem' not in port.lower()) and (not re.fullmatch(r'com\d+', port.lower())):
                continue

            dev: Optional[CoreDAQ] = None
            idn = ''
            try:
                dev = CoreDAQ(port, timeout=self.timeout)
                idn = dev.idn() or probed_idn
            except (CoreDAQError, serial.SerialException, OSError):
                if dev is not None:
                    try:
                        dev.close()
                    except Exception:
                        pass
                continue
            except Exception:
                if dev is not None:
                    try:
                        dev.close()
                    except Exception:
                        pass
                continue

            if 'COREDAQ' not in idn.upper():
                try:
                    dev.close()
                except Exception:
                    pass
                continue

            major = self._fw_major_from_idn(idn)
            base_id = self._device_key_from_idn(idn, port)

            if major == 3:
                reason = 'Firmware v3 is not supported. Please upgrade to firmware v4.'
                self.unsupported_ports[port] = {
                    'device_id': base_id,
                    'port': port,
                    'idn': idn,
                    'frontend_type': None,
                    'unsupported_firmware': True,
                    'unsupported_reason': reason,
                }
                try:
                    dev.close()
                except Exception:
                    pass
                continue

            device_id = self._make_unique_device_id(base_id)
            frontend_type = 'UNKNOWN'
            try:
                frontend_type = str(dev.frontend_type()).upper()
            except Exception:
                frontend_type = 'UNKNOWN'

            session = DeviceSession(
                device_id=device_id,
                port=port,
                dev=dev,
                idn=idn,
                frontend_type=frontend_type,
            )

            try:
                session.detector_type = self._normalize_detector_type(dev.detector_type())
            except Exception:
                session.detector_type = self._detect_detector_type_from_idn(idn)
            try:
                session.dev.set_detector_type(session.detector_type)
            except Exception:
                pass

            try:
                lo, hi = dev.get_wavelength_limits_nm(session.detector_type)
                session.wavelength_min_nm = float(lo)
                session.wavelength_max_nm = float(hi)
            except Exception:
                lo, hi = self._fallback_wavelength_limits_nm(session.detector_type)
                session.wavelength_min_nm = lo
                session.wavelength_max_nm = hi

            default_wavelength_nm = self._default_wavelength_nm(session.detector_type)
            try:
                session.dev.set_wavelength_nm(default_wavelength_nm)
            except Exception:
                pass
            try:
                session.wavelength_nm = float(session.dev.get_wavelength_nm())
            except Exception:
                session.wavelength_nm = default_wavelength_nm

            if frontend_type == CoreDAQ.FRONTEND_LOG:
                session.autogain_enabled = False

            try:
                session.dev.set_freq(session.fixed_freq_hz)
                session.dev.set_oversampling(session.default_os_idx)
            except Exception:
                pass

            self.devices[device_id] = session
            self.port_to_device_id[port] = device_id
            self.unsupported_ports.pop(port, None)

        if self.active_device_id not in self.devices:
            self.active_device_id = self._pick_default_active()

    def _get_session(
        self,
        requested_device_id: Optional[str],
        require_linear: bool = False,
    ) -> DeviceSession:
        session: Optional[DeviceSession] = None
        if requested_device_id:
            session = self.devices.get(requested_device_id)
        if session is None and self.active_device_id:
            session = self.devices.get(self.active_device_id)
        if session is None and self.devices:
            first = sorted(self.devices.keys())[0]
            session = self.devices[first]
        if session is None:
            raise RuntimeError('No supported CoreDAQ device connected')

        if require_linear and session.frontend_type != CoreDAQ.FRONTEND_LINEAR:
            raise RuntimeError('This operation is only available on LINEAR front-end devices')

        return session

    def _set_active_device(self, device_id: str) -> None:
        if device_id not in self.devices:
            raise RuntimeError(f'Unknown device_id: {device_id}')
        self.active_device_id = device_id

    @staticmethod
    def _decimate_indices(n: int, max_points: int) -> List[int]:
        if n <= 0:
            return []
        if max_points < 64:
            max_points = 64
        if n <= max_points:
            return list(range(n))
        step = int(math.ceil(n / float(max_points)))
        idx = list(range(0, n, step))
        if idx[-1] != (n - 1):
            idx.append(n - 1)
        return idx

    @staticmethod
    def _max_freq_for_os(os_idx: int) -> int:
        os_idx = int(os_idx)
        if os_idx <= 1:
            return 100_000
        return 100_000 // (2 ** (os_idx - 1))

    @classmethod
    def _max_os_for_freq(cls, hz: int) -> int:
        hz = int(hz)
        if hz <= 0:
            return 0
        best = 0
        for os_idx in range(0, 8):
            if hz <= cls._max_freq_for_os(os_idx):
                best = os_idx
            else:
                break
        return best

    @staticmethod
    def _norm_visa_backend(spec: Optional[str]) -> Optional[str]:
        txt = str(spec or '').strip()
        if txt.lower() in ('default', '<default>', 'auto'):
            return None
        return txt or None

    def _candidate_visa_backends(self, preferred: Optional[str] = None) -> List[Optional[str]]:
        # Prefer explicit selection, then env hint, then common defaults.
        ordered: List[Optional[str]] = [
            self._norm_visa_backend(preferred),
            self._norm_visa_backend(self.gpib_backend),
            self._norm_visa_backend(self.visa_backend_hint),
            None,      # pyvisa default backend resolution
            '@ivi',    # NI/Keysight style IVI backend
            '@py',     # pyvisa-py pure python backend
        ]
        out: List[Optional[str]] = []
        seen: Set[str] = set()
        for spec in ordered:
            key = spec or '<default>'
            if key in seen:
                continue
            seen.add(key)
            out.append(spec)
        return out

    @staticmethod
    def _open_visa_manager(backend: Optional[str]):
        if pyvisa is None:
            raise RuntimeError('pyvisa is not installed; run pip install pyvisa')
        spec = str(backend or '').strip()
        return pyvisa.ResourceManager(spec) if spec else pyvisa.ResourceManager()

    def _gpib_scan(self) -> List[Dict[str, Optional[str]]]:
        if pyvisa is None:
            raise RuntimeError('pyvisa is not installed; run pip install pyvisa')

        rows: List[Dict[str, Optional[str]]] = []
        seen_resources: Set[str] = set()
        resource_backend: Dict[str, Optional[str]] = {}

        for backend in self._candidate_visa_backends():
            rm = None
            try:
                rm = self._open_visa_manager(backend)
                resources = list(rm.list_resources())
            except Exception:
                resources = []

            try:
                for name in resources:
                    if name in seen_resources:
                        continue
                    seen_resources.add(name)
                    resource_backend[name] = backend
                    idn = None
                    model = None
                    try:
                        inst = rm.open_resource(name)
                        try:
                            inst.timeout = 700
                            inst.read_termination = '\n'
                            inst.write_termination = '\n'
                            idn = str(inst.query('*IDN?')).strip()
                            model = detect_laser_model(idn)
                        finally:
                            inst.close()
                    except Exception:
                        idn = None
                        model = None
                    rows.append({
                        'resource': name,
                        'idn': idn,
                        'model': model,
                        'backend': backend or 'default',
                    })
            finally:
                if rm is not None:
                    try:
                        rm.close()
                    except Exception:
                        pass

        self.gpib_resource_backend = resource_backend
        if self.gpib_resource and self.gpib_resource in resource_backend:
            self.gpib_backend = self._norm_visa_backend(resource_backend.get(self.gpib_resource))
        return rows

    def _gpib_query(self, resource: str, cmd: str) -> Dict[str, Optional[str]]:
        if pyvisa is None:
            raise RuntimeError('pyvisa is not installed; run pip install pyvisa')
        if not resource:
            raise RuntimeError('No GPIB resource selected')

        c = str(cmd).strip()
        if not c:
            raise RuntimeError('Empty command')

        backend = self._norm_visa_backend(self.gpib_resource_backend.get(resource) or self.gpib_backend)
        with LaserSession(resource, timeout_ms=4000, visa_backend=backend) as laser:
            if c.endswith('?'):
                reply = laser.query(c)
            else:
                laser.write(c)
                reply = 'OK'

        model = detect_laser_model(reply) if c.upper() in ('*IDN?', 'IDN?') else None
        return {
            'resource': resource,
            'backend': backend or 'default',
            'command': c,
            'reply': reply,
            'model': model,
        }

    def _run_sweep_capture(
        self,
        session: DeviceSession,
        resource: str,
        params: Dict[str, Any],
    ) -> Dict[str, Any]:
        if pyvisa is None:
            raise RuntimeError('pyvisa is not installed; run pip install pyvisa')
        if not resource:
            raise RuntimeError('No GPIB resource selected')
        if session.busy:
            raise RuntimeError('Selected device is busy')

        start_nm = float(params.get('start_nm', 1480.0))
        stop_nm = float(params.get('stop_nm', 1620.0))
        power_mw = float(params.get('power_mw', 1.0))
        speed_nm_s = float(params.get('speed_nm_s', 50.0))
        sample_rate = int(params.get('sample_rate_hz', SWEEP_SAMPLE_RATE_DEFAULT_HZ))
        os_idx_requested = int(params.get('os_idx', session.default_os_idx))
        gains_param = params.get('gains', [0, 0, 0, 0])
        channel_mask = int(params.get('channel_mask', 0x0F)) & 0x0F
        preview_points = int(params.get('preview_points', 24_000))

        if speed_nm_s <= 0:
            raise RuntimeError('Sweep speed must be > 0')
        if sample_rate <= 0:
            raise RuntimeError('Sample rate must be > 0')
        if sample_rate > SWEEP_SAMPLE_RATE_MAX_HZ:
            sample_rate = SWEEP_SAMPLE_RATE_MAX_HZ
        os_idx_requested = max(0, min(7, os_idx_requested))
        os_idx_max_for_rate = self._max_os_for_freq(sample_rate)
        os_idx = min(os_idx_requested, os_idx_max_for_rate)
        if channel_mask == 0:
            channel_mask = 0x0F

        gains = [0, 0, 0, 0]
        if isinstance(gains_param, list):
            for i in range(min(4, len(gains_param))):
                try:
                    gains[i] = int(gains_param[i])
                except Exception:
                    gains[i] = 0

        sweep_span = stop_nm - start_nm
        sweep_duration_s = abs(sweep_span) / speed_nm_s
        samples_total = int(max(1, round(sweep_duration_s * sample_rate)))

        previous_mask: Optional[int] = None
        mask_applied = False
        prev_stream = session.stream_enabled

        session.busy = True
        session.stream_enabled = False

        try:
            try:
                previous_mask = int(session.dev.get_channel_mask()) & 0x0F
            except Exception:
                previous_mask = None

            if previous_mask is not None and previous_mask != channel_mask:
                session.dev.set_channel_mask(channel_mask)
                mask_applied = True

            try:
                if previous_mask is None:
                    max_frames = int(session.dev.max_acquisition_frames())
                else:
                    max_frames = int(session.dev.max_acquisition_frames(mask=channel_mask))
            except Exception:
                max_frames = int(session.dev.max_acquisition_frames())

            if samples_total > max_frames:
                raise RuntimeError(
                    f'Sweep needs {samples_total} samples, exceeds CoreDAQ capacity {max_frames}. '
                    'Reduce span, speed, or sample rate.'
                )

            self.capture_state = 'running'
            self.capture_message = f'Configuring sweep for {samples_total} samples'
            session.dev.set_freq(sample_rate)
            session.dev.set_oversampling(os_idx)
            try:
                actual_os_idx = int(session.dev.get_oversampling())
            except Exception:
                actual_os_idx = os_idx

            session.default_os_idx = actual_os_idx
            session.os_idx = actual_os_idx

            # Spectrum sweeps are anchored to 1550 nm for InGaAs so relative correction is unity.
            try:
                detector = (session.detector_type or '').upper()
                if detector == CoreDAQ.DETECTOR_INGAAS:
                    session.dev.set_responsivity_reference_nm(1550.0)
                    session.dev.set_wavelength_nm(1550.0)
                    try:
                        session.wavelength_nm = float(session.dev.get_wavelength_nm())
                    except Exception:
                        session.wavelength_nm = 1550.0
            except Exception:
                pass

            if session.frontend_type == CoreDAQ.FRONTEND_LINEAR:
                for head, gain in enumerate(gains[:4], start=1):
                    session.dev.set_gain(head, int(gain))

            session.dev.arm_acquisition(samples_total, use_trigger=True, trigger_rising=True)
            time.sleep(0.8)

            visa_backend = self._norm_visa_backend(self.gpib_resource_backend.get(resource) or self.gpib_backend)
            try:
                with LaserSession(resource, timeout_ms=5000, visa_backend=visa_backend) as laser:
                    try:
                        self.gpib_idn = laser.query('*IDN?')
                        self.gpib_model = detect_laser_model(self.gpib_idn) or self.gpib_model
                        self.gpib_backend = visa_backend
                        if not self.gpib_model:
                            raise RuntimeError(
                                'Unsupported laser model. Supported models: TSL550, TSL570, TSL770.'
                            )
                    except Exception:
                        raise

                    self.capture_message = 'Configuring laser'
                    laser.configure_for_sweep(
                        start_nm,
                        stop_nm,
                        power_mw,
                        speed_nm_s,
                        model=self.gpib_model,
                    )
                    self.capture_message = 'Waiting for laser trigger and acquisition'
                    laser.start_sweep()
                    time.sleep(samples_total / float(sample_rate) + SWEEP_TRANSFER_OVERHEAD_S)
                    try:
                        laser.stop_sweep()
                    except Exception:
                        pass
            except Exception as e:
                msg = str(e or '')
                if 'Unsupported laser model' in msg:
                    raise RuntimeError(msg) from e
                raise RuntimeError(
                    f'Laser not found or not responding on VISA resource "{resource}". '
                    'Run Scan VISA and *IDN? to verify connection.'
                ) from e

            self.capture_message = 'Transferring capture from CoreDAQ'
            state_now = int(session.dev.state_enum())
            if state_now != COREDAQ_READY_STATE:
                raise RuntimeError(
                    f'Acquisition not complete before transfer (state={state_now}). '
                    'Increase sweep overhead or reduce capture duration.'
                )

            channels_w = session.dev.transfer_frames_W(samples_total)
            if not isinstance(channels_w, list) or len(channels_w) < 4:
                raise RuntimeError('Invalid transfer payload from CoreDAQ')

        finally:
            if mask_applied and previous_mask is not None:
                try:
                    session.dev.set_channel_mask(previous_mask)
                except Exception:
                    pass
            session.stream_enabled = prev_stream
            session.busy = False

        colors = ['#4DD0E1', '#FFB454', '#7BE7A1', '#FF7AA2']
        active_channels = [i for i in range(4) if (channel_mask & (1 << i)) != 0]
        dec_idx = self._decimate_indices(samples_total, preview_points)
        duration_s = samples_total / float(sample_rate)
        if duration_s <= 0:
            duration_s = 1.0
        span = stop_nm - start_nm

        x_preview = []
        for i in dec_idx:
            t = float(i) / float(sample_rate)
            x_preview.append(start_nm + span * (t / duration_s))

        series = []
        for ch_idx in range(4):
            y = channels_w[ch_idx]
            data = [[x_preview[k], float(y[i])] for k, i in enumerate(dec_idx)]
            series.append({
                'name': f'CH{ch_idx + 1}',
                'color': colors[ch_idx],
                'data': data,
            })

        room_temp_c = None
        room_humidity_pct = None
        try:
            room_temp_c = float(session.dev.get_head_temperature_C())
        except Exception:
            room_temp_c = None
        try:
            room_humidity_pct = float(session.dev.get_head_humidity())
        except Exception:
            room_humidity_pct = None

        captured_at_unix = float(time.time())
        captured_at_utc = datetime.fromtimestamp(captured_at_unix, tz=timezone.utc).isoformat()
        self.last_sweep = {
            'captured_at_unix': captured_at_unix,
            'captured_at_utc': captured_at_utc,
            'resource': resource,
            'gpib_idn': self.gpib_idn,
            'gpib_model': self.gpib_model,
            'device_id': session.device_id,
            'frontend_type': session.frontend_type,
            'coredaq_port': session.port,
            'coredaq_idn': session.idn,
            'start_nm': start_nm,
            'stop_nm': stop_nm,
            'power_mw': power_mw,
            'speed_nm_s': speed_nm_s,
            'sample_rate_hz': sample_rate,
            'os_idx': actual_os_idx,
            'os_idx_requested': os_idx_requested,
            'os_idx_max_for_rate': os_idx_max_for_rate,
            'gains': [int(x) for x in gains[:4]],
            'channel_mask': channel_mask,
            'active_channels': active_channels,
            'samples_total': samples_total,
            'sweep_duration_s': sweep_duration_s,
            'room_temp_c': room_temp_c,
            'room_humidity_pct': room_humidity_pct,
            'channels_w': channels_w,
        }

        self.capture_state = 'idle'
        self.capture_message = 'Sweep complete'
        return {
            'device_id': session.device_id,
            'frontend_type': session.frontend_type,
            'samples_total': samples_total,
            'sweep_duration_s': sweep_duration_s,
            'start_nm': start_nm,
            'stop_nm': stop_nm,
            'sample_rate_hz': sample_rate,
            'os_idx': actual_os_idx,
            'os_idx_requested': os_idx_requested,
            'os_idx_max_for_rate': os_idx_max_for_rate,
            'channel_mask': channel_mask,
            'active_channels': active_channels,
            'series': series,
        }

    def _save_last_sweep_h5(self, requested_path: Optional[str]) -> str:
        if h5py is None:
            raise RuntimeError('h5py is not installed; run pip install h5py')
        if not self.last_sweep:
            raise RuntimeError('No sweep data available. Run a sweep first.')

        payload = self.last_sweep
        out_path = (requested_path or '').strip()
        if not out_path:
            out_dir = os.path.join(ROOT, 'GUI', 'captures')
            os.makedirs(out_dir, exist_ok=True)
            ts = datetime.now(tz=timezone.utc).strftime('%Y%m%d_%H%M%S')
            out_path = os.path.join(out_dir, f'coredaq_sweep_{ts}.h5')
        if not out_path.lower().endswith('.h5'):
            out_path = f'{out_path}.h5'

        parent = os.path.dirname(out_path)
        if parent:
            os.makedirs(parent, exist_ok=True)

        channel_mask = int(payload.get('channel_mask', 0x0F)) & 0x0F
        active_channels = payload.get('active_channels', [0, 1, 2, 3])
        channels_w = payload.get('channels_w', [[], [], [], []])

        with h5py.File(out_path, 'w') as hf:
            hf.attrs['format'] = 'coredaq_sweep'
            hf.attrs['format_version'] = '1.1'
            hf.attrs['captured_at_utc'] = str(payload.get('captured_at_utc', ''))

            coredaq = hf.create_group('coredaq')
            coredaq.attrs['device_id'] = str(payload.get('device_id') or '')
            coredaq.attrs['frontend_type'] = str(payload.get('frontend_type') or '')
            coredaq.attrs['port'] = str(payload.get('coredaq_port') or '')
            coredaq.attrs['idn'] = str(payload.get('coredaq_idn') or '')
            coredaq.attrs['channel_mask'] = int(channel_mask)

            laser = hf.create_group('laser')
            laser.attrs['visa_resource'] = str(payload.get('resource') or '')
            laser.attrs['idn'] = str(payload.get('gpib_idn') or '')
            laser.attrs['model'] = str(payload.get('gpib_model') or '')
            laser.attrs['start_nm'] = float(payload.get('start_nm', 0.0))
            laser.attrs['stop_nm'] = float(payload.get('stop_nm', 0.0))
            laser.attrs['speed_nm_s'] = float(payload.get('speed_nm_s', 0.0))
            laser.attrs['power_mw'] = float(payload.get('power_mw', 0.0))

            acquisition = hf.create_group('acquisition')
            acquisition.attrs['sample_rate_hz'] = int(payload.get('sample_rate_hz', 0))
            acquisition.attrs['oversampling_index'] = int(payload.get('os_idx', 0))
            acquisition.attrs['samples_total'] = int(payload.get('samples_total', 0))
            acquisition.attrs['sweep_duration_s'] = float(payload.get('sweep_duration_s', 0.0))
            acquisition.attrs['x_axis_formula'] = (
                'wavelength_nm = start_nm + (stop_nm-start_nm) * (sample_index / samples_total)'
            )
            gains = payload.get('gains', [0, 0, 0, 0])
            acquisition.create_dataset('gains', data=[int(x) for x in gains], dtype='i1')

            ambient = hf.create_group('ambient')
            room_temp_c = payload.get('room_temp_c')
            room_humidity_pct = payload.get('room_humidity_pct')
            if room_temp_c is not None:
                ambient.attrs['room_temp_c'] = float(room_temp_c)
            if room_humidity_pct is not None:
                ambient.attrs['room_humidity_pct'] = float(room_humidity_pct)

            channels = hf.create_group('channels')
            for ch_idx in active_channels:
                if ch_idx < 0 or ch_idx > 3:
                    continue
                arr = channels_w[ch_idx] if ch_idx < len(channels_w) else []
                channels.create_dataset(
                    f'ch{ch_idx + 1}_power_w',
                    data=arr,
                    compression='gzip',
                    compression_opts=4,
                    shuffle=True,
                )

        return out_path

    async def broadcast(self, msg: Dict[str, Any]) -> None:
        if not self.clients:
            return
        data = json.dumps(msg)
        await asyncio.gather(*(c.send(data) for c in self.clients), return_exceptions=True)

    def _device_status_payload(self, s: DeviceSession) -> Dict[str, Any]:
        return {
            'device_id': s.device_id,
            'connected': True,
            'port': s.port,
            'idn': s.idn,
            'frontend_type': s.frontend_type,
            'detector_type': s.detector_type,
            'unsupported_firmware': False,
            'unsupported_reason': None,
            'freq_hz': s.freq_hz,
            'os_idx': s.os_idx,
            'wavelength_nm': s.wavelength_nm,
            'wavelength_min_nm': s.wavelength_min_nm,
            'wavelength_max_nm': s.wavelength_max_nm,
            'gains': s.gains,
            'autogain': s.autogain_enabled,
            'streaming': self.stream_enabled_global and s.stream_enabled,
            'die_temp_c': s.die_temp_c,
            'room_temp_c': s.room_temp_c,
            'room_humidity_pct': s.room_humidity_pct,
            'busy': s.busy,
        }

    async def _poll_session_status(self, s: DeviceSession) -> bool:
        if s.busy:
            return True

        # While streaming, reduce status command pressure on the serial link.
        now = time.time()
        is_streaming = self.stream_enabled_global and s.stream_enabled
        min_poll_interval_s = 2.0 if is_streaming else 0.5
        if (now - s.last_status_poll_ts) < min_poll_interval_s:
            return True

        try:
            s.freq_hz = int(await asyncio.to_thread(s.dev.get_freq_hz))
            s.os_idx = int(await asyncio.to_thread(s.dev.get_oversampling))
            if s.frontend_type == CoreDAQ.FRONTEND_LINEAR:
                gains = await asyncio.to_thread(s.dev.get_gains)
                s.gains = [int(x) for x in gains]
            else:
                s.gains = None
        except Exception:
            self._drop_session(s.device_id)
            return False

        try:
            s.detector_type = self._normalize_detector_type(await asyncio.to_thread(s.dev.detector_type))
        except Exception:
            if not s.detector_type:
                s.detector_type = self._detect_detector_type_from_idn(s.idn)

        try:
            s.wavelength_nm = float(await asyncio.to_thread(s.dev.get_wavelength_nm))
        except Exception:
            pass

        try:
            lo, hi = await asyncio.to_thread(s.dev.get_wavelength_limits_nm, s.detector_type)
            s.wavelength_min_nm = float(lo)
            s.wavelength_max_nm = float(hi)
        except Exception:
            if s.wavelength_min_nm is None or s.wavelength_max_nm is None:
                lo, hi = self._fallback_wavelength_limits_nm(s.detector_type)
                s.wavelength_min_nm = lo
                s.wavelength_max_nm = hi

        try:
            s.die_temp_c = float(await asyncio.to_thread(s.dev.get_die_temperature_C))
        except Exception:
            s.die_temp_c = None
        try:
            s.room_temp_c = float(await asyncio.to_thread(s.dev.get_head_temperature_C))
        except Exception:
            s.room_temp_c = None
        try:
            s.room_humidity_pct = float(await asyncio.to_thread(s.dev.get_head_humidity))
        except Exception:
            s.room_humidity_pct = None

        s.last_status_poll_ts = now
        return True

    async def status_loop(self) -> None:
        while True:
            any_streaming = any(self.stream_enabled_global and s.stream_enabled for s in self.devices.values())
            # Discovery probes can block and cause visible stream stutter on Windows.
            # Skip probing while actively streaming.
            if not any_streaming:
                self._discover_devices()

            for _did, sess in list(sorted(self.devices.items())):
                await self._poll_session_status(sess)

            if self.active_device_id not in self.devices:
                self.active_device_id = self._pick_default_active()

            device_rows = [
                self._device_status_payload(s)
                for _did, s in sorted(self.devices.items())
            ]
            for _port, row in sorted(self.unsupported_ports.items()):
                device_rows.append(dict(row))

            active = self.devices.get(self.active_device_id or '')
            unsupported_rows = [d for d in device_rows if d.get('unsupported_firmware')]

            await self.broadcast({
                'type': 'status',
                'connected': len(self.devices) > 0,
                'device_count': len(self.devices),
                'devices': device_rows,
                'active_device_id': self.active_device_id,

                # Backward-compatible top-level fields (active device)
                'port': active.port if active else None,
                'idn': active.idn if active else None,
                'detector_type': active.detector_type if active else None,
                'freq_hz': active.freq_hz if active else None,
                'os_idx': active.os_idx if active else None,
                'wavelength_nm': active.wavelength_nm if active else None,
                'wavelength_min_nm': active.wavelength_min_nm if active else None,
                'wavelength_max_nm': active.wavelength_max_nm if active else None,
                'gains': active.gains if active else None,
                'autogain': active.autogain_enabled if active else False,
                'streaming': (self.stream_enabled_global and active.stream_enabled) if active else False,
                'die_temp_c': active.die_temp_c if active else None,
                'room_temp_c': active.room_temp_c if active else None,
                'room_humidity_pct': active.room_humidity_pct if active else None,
                'unsupported_firmware': len(unsupported_rows) > 0,
                'unsupported_reason': unsupported_rows[0].get('unsupported_reason') if unsupported_rows else None,

                # Shared sweep / laser state
                'gpib_resource': self.gpib_resource,
                'gpib_idn': self.gpib_idn,
                'gpib_model': self.gpib_model,
                'gpib_backend': self.gpib_backend or (self.visa_backend_hint or 'default'),
                'capture_state': self.capture_state,
                'capture_message': self.capture_message,
            })

            await asyncio.sleep(1.0)

    async def stream_loop(self) -> None:
        # Live stream via SNAP 1 (power units, W).
        while True:
            if not self.stream_enabled_global or not self.devices:
                await asyncio.sleep(0.2)
                continue

            for _did, s in list(sorted(self.devices.items())):
                if not self.stream_enabled_global or not s.stream_enabled or s.busy:
                    continue

                try:
                    power_w: Optional[Any] = None
                    if s.frontend_type == CoreDAQ.FRONTEND_LINEAR and s.autogain_enabled:
                        if (time.time() - s.last_autogain) > 1.0:
                            try:
                                # Reuse this snapshot for streaming so autogain does not
                                # trigger an extra USB transaction in the same cycle.
                                power_w = await asyncio.to_thread(s.dev.snapshot_W, n_frames=1, autogain=True)
                                s.last_autogain = time.time()
                            except Exception:
                                power_w = None

                    if power_w is None:
                        power_w = await asyncio.to_thread(s.dev.snapshot_W, n_frames=1)
                    if isinstance(power_w, tuple):
                        power_w = power_w[0]
                    if not isinstance(power_w, (list, tuple)) or len(power_w) < 4:
                        raise RuntimeError('Invalid power snapshot payload')

                    await self.broadcast({
                        'type': 'stream',
                        'device_id': s.device_id,
                        'frontend_type': s.frontend_type,
                        'ts': time.time(),
                        'ch': [float(power_w[i]) for i in range(4)],
                    })
                    s.stream_error_streak = 0
                    s.last_stream_error = ''
                    s.last_stream_error_ts = 0.0
                except Exception as exc:
                    s.stream_error_streak += 1
                    s.last_stream_error = str(exc)
                    s.last_stream_error_ts = time.time()
                    if s.stream_error_streak >= STREAM_MAX_CONSEC_ERRORS:
                        self._drop_session(s.device_id)

            # Keep UI stream responsive; actual loop rate is bounded by serial round-trip.
            await asyncio.sleep(LIVE_STREAM_PERIOD_S)

    async def handle_client(self, ws):
        self.clients.add(ws)
        try:
            async for msg in ws:
                try:
                    data = json.loads(msg)
                except Exception:
                    continue

                if data.get('type') == 'console':
                    cmd = str(data.get('cmd', '')).strip()
                    if not cmd:
                        continue

                    requested_id = str(data.get('device_id', '') or '').strip() or None
                    try:
                        sess = self._get_session(requested_id)
                    except Exception as e:
                        await ws.send(json.dumps({
                            'type': 'console',
                            'dir': 'rx',
                            'device_id': requested_id,
                            'text': f'ERR {e}'
                        }))
                        continue

                    try:
                        st, payload = await asyncio.to_thread(sess.dev._ask, cmd)
                        if st == 'OK':
                            resp = f'OK {payload}'.strip()
                        elif st == 'BUSY':
                            resp = 'BUSY'
                        else:
                            resp = f'ERR {payload}'.strip()
                    except Exception as e:
                        resp = f'ERR {e}'

                    await ws.send(json.dumps({
                        'type': 'console',
                        'dir': 'rx',
                        'device_id': sess.device_id,
                        'text': resp,
                    }))
                    continue

                if data.get('type') != 'control':
                    continue

                action = data.get('action')
                requested_id = str(data.get('device_id', '') or '').strip() or None

                try:
                    if action == 'set_active_device':
                        did = str(data.get('device_id', '')).strip()
                        self._set_active_device(did)
                        await ws.send(json.dumps({
                            'type': 'control',
                            'action': action,
                            'ok': True,
                            'error': None,
                            'active_device_id': self.active_device_id,
                        }))

                    elif action == 'set_gain':
                        sess = self._get_session(requested_id, require_linear=True)
                        head = int(data.get('head', 1))
                        gain = int(data.get('gain', 0))
                        await asyncio.to_thread(sess.dev.set_gain, head, gain)
                        await ws.send(json.dumps({
                            'type': 'control',
                            'action': action,
                            'ok': True,
                            'error': None,
                            'device_id': sess.device_id,
                        }))

                    elif action == 'set_os':
                        sess = self._get_session(requested_id)
                        idx = int(data.get('os_idx', 0))
                        sess.default_os_idx = idx
                        await asyncio.to_thread(sess.dev.set_oversampling, idx)
                        await ws.send(json.dumps({
                            'type': 'control',
                            'action': action,
                            'ok': True,
                            'error': None,
                            'device_id': sess.device_id,
                        }))

                    elif action == 'set_wavelength':
                        sess = self._get_session(requested_id)
                        try:
                            wavelength_nm = float(data.get('wavelength_nm'))
                        except Exception as exc:
                            raise RuntimeError('Invalid wavelength_nm') from exc

                        await asyncio.to_thread(sess.dev.set_wavelength_nm, wavelength_nm)
                        sess.wavelength_nm = float(await asyncio.to_thread(sess.dev.get_wavelength_nm))
                        try:
                            sess.detector_type = self._normalize_detector_type(
                                await asyncio.to_thread(sess.dev.detector_type)
                            )
                        except Exception:
                            pass
                        try:
                            lo, hi = await asyncio.to_thread(sess.dev.get_wavelength_limits_nm, sess.detector_type)
                            sess.wavelength_min_nm = float(lo)
                            sess.wavelength_max_nm = float(hi)
                        except Exception:
                            lo, hi = self._fallback_wavelength_limits_nm(sess.detector_type)
                            sess.wavelength_min_nm = lo
                            sess.wavelength_max_nm = hi

                        await ws.send(json.dumps({
                            'type': 'control',
                            'action': action,
                            'ok': True,
                            'error': None,
                            'device_id': sess.device_id,
                            'detector_type': sess.detector_type,
                            'wavelength_nm': sess.wavelength_nm,
                            'wavelength_min_nm': sess.wavelength_min_nm,
                            'wavelength_max_nm': sess.wavelength_max_nm,
                        }))

                    elif action == 'set_autogain':
                        enabled = bool(data.get('enabled', False))
                        if requested_id:
                            sess = self._get_session(requested_id)
                            if sess.frontend_type != CoreDAQ.FRONTEND_LINEAR:
                                raise RuntimeError('Autogain is only available on LINEAR front-end devices')
                            sess.autogain_enabled = enabled
                            target = [sess.device_id]
                        else:
                            target = []
                            for _did, s in self.devices.items():
                                if s.frontend_type == CoreDAQ.FRONTEND_LINEAR:
                                    s.autogain_enabled = enabled
                                    target.append(s.device_id)
                        await ws.send(json.dumps({
                            'type': 'control',
                            'action': action,
                            'ok': True,
                            'error': None,
                            'device_ids': target,
                        }))

                    elif action == 'stream':
                        enabled = bool(data.get('enabled', True))
                        if requested_id:
                            sess = self._get_session(requested_id)
                            sess.stream_enabled = enabled
                        else:
                            self.stream_enabled_global = enabled
                            for _did, s in self.devices.items():
                                s.stream_enabled = enabled

                        await ws.send(json.dumps({
                            'type': 'control',
                            'action': action,
                            'ok': True,
                            'error': None,
                            'enabled': enabled,
                            'device_id': requested_id,
                        }))

                    elif action == 'recalibrate_zero':
                        sess = self._get_session(requested_id, require_linear=True)
                        prev_stream = sess.stream_enabled
                        sess.stream_enabled = False
                        sess.busy = True
                        try:
                            codes, gains = await asyncio.to_thread(
                                sess.dev.recompute_zero_from_snapshot,
                                32,
                                sess.fixed_freq_hz,
                                sess.default_os_idx,
                                0.2,
                            )
                        finally:
                            sess.busy = False
                            sess.stream_enabled = prev_stream

                        await ws.send(json.dumps({
                            'type': 'control',
                            'action': action,
                            'ok': True,
                            'error': None,
                            'device_id': sess.device_id,
                            'zeros': codes,
                            'gains': gains,
                        }))

                    elif action == 'gpib_scan':
                        rows = await asyncio.to_thread(self._gpib_scan)
                        await ws.send(json.dumps({
                            'type': 'control',
                            'action': action,
                            'ok': True,
                            'error': None,
                            'resources': rows,
                            'python_exe': sys.executable,
                            'visa_backend_hint': self.visa_backend_hint or 'default',
                        }))

                    elif action == 'gpib_select':
                        resource = str(data.get('resource', '')).strip()
                        if not resource:
                            raise RuntimeError('No GPIB resource provided')
                        self.gpib_resource = resource
                        self.gpib_backend = self._norm_visa_backend(self.gpib_resource_backend.get(resource))
                        await ws.send(json.dumps({
                            'type': 'control',
                            'action': action,
                            'ok': True,
                            'error': None,
                            'resource': resource,
                            'backend': self.gpib_backend or 'default',
                        }))

                    elif action == 'gpib_query':
                        resource = str(data.get('resource', self.gpib_resource or '')).strip()
                        cmd = str(data.get('cmd', '')).strip()
                        out = await asyncio.to_thread(self._gpib_query, resource, cmd)
                        self.gpib_resource = out.get('resource') or self.gpib_resource
                        self.gpib_backend = self._norm_visa_backend(out.get('backend'))
                        if cmd.upper() in ('*IDN?', 'IDN?'):
                            self.gpib_idn = out.get('reply')
                            self.gpib_model = out.get('model')
                        await ws.send(json.dumps({
                            'type': 'control',
                            'action': action,
                            'ok': True,
                            'error': None,
                            **out,
                        }))

                    elif action == 'sweep_run':
                        sess = self._get_session(requested_id)
                        resource = str(data.get('resource', self.gpib_resource or '')).strip()
                        params = data.get('params', {})
                        if not isinstance(params, dict):
                            params = {}

                        self.capture_state = 'running'
                        self.capture_message = 'Starting sweep'

                        out = await asyncio.to_thread(self._run_sweep_capture, sess, resource, params)
                        await ws.send(json.dumps({
                            'type': 'control',
                            'action': action,
                            'ok': True,
                            'error': None,
                            **out,
                        }))

                    elif action == 'sweep_save_h5':
                        path = str(data.get('path', '') or '').strip()
                        saved_path = await asyncio.to_thread(self._save_last_sweep_h5, path)
                        await ws.send(json.dumps({
                            'type': 'control',
                            'action': action,
                            'ok': True,
                            'error': None,
                            'path': saved_path,
                        }))

                    else:
                        await ws.send(json.dumps({
                            'type': 'control',
                            'action': action,
                            'ok': False,
                            'error': 'Unknown action',
                        }))

                except Exception as e:
                    self.capture_state = 'idle'
                    self.capture_message = f'Error: {e}'
                    await ws.send(json.dumps({
                        'type': 'control',
                        'action': action,
                        'ok': False,
                        'error': str(e),
                        'device_id': requested_id,
                    }))

        finally:
            self.clients.discard(ws)


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', help='Serial port override')
    ap.add_argument('--ws-port', type=int, default=8765)
    ap.add_argument('--timeout', type=float, default=0.2)
    args = ap.parse_args()

    backend = CoreDAQBackend(args.port, args.timeout)
    backend._discover_devices()

    async with websockets.serve(backend.handle_client, '127.0.0.1', args.ws_port):
        await asyncio.gather(
            backend.status_loop(),
            backend.stream_loop(),
        )


if __name__ == '__main__':
    asyncio.run(main())

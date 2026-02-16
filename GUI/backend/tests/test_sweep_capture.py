import os
import sys
import unittest
from unittest.mock import patch

BACKEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import coredaq_service as svc  # noqa: E402


class FakeLaserSession:
    def __init__(self, resource: str, timeout_ms: int = 4000):
        self.resource = resource
        self.timeout_ms = timeout_ms

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def query(self, cmd: str) -> str:
        if cmd.strip().upper() == '*IDN?':
            return 'SANTEC,TSL570,FAKE,1.0'
        return 'OK'

    def write(self, cmd: str) -> None:
        _ = cmd

    def configure_for_sweep(self, start_nm, stop_nm, power_mw, speed_nm_s, model=None) -> None:
        _ = (start_nm, stop_nm, power_mw, speed_nm_s, model)

    def start_sweep(self) -> None:
        pass

    def stop_sweep(self) -> None:
        pass


class FakeDev:
    def __init__(self):
        self.mask = 0x0F
        self.freq_hz = 50_000
        self.os_idx = 0
        self.gains = [0, 0, 0, 0]
        self.wavelength_nm = 1310.0
        self.resp_ref_nm = 1550.0

    def get_channel_mask(self) -> int:
        return self.mask

    def set_channel_mask(self, mask: int) -> None:
        self.mask = int(mask) & 0x0F

    def max_acquisition_frames(self, mask=None) -> int:
        _ = mask
        return 8_000_000

    @staticmethod
    def _max_freq_for_os(os_idx: int) -> int:
        if os_idx <= 1:
            return 100_000
        return 100_000 // (2 ** (os_idx - 1))

    def _best_os_for_freq(self, hz: int) -> int:
        best = 0
        for os_idx in range(0, 8):
            if hz <= self._max_freq_for_os(os_idx):
                best = os_idx
            else:
                break
        return best

    def set_freq(self, hz: int) -> None:
        self.freq_hz = int(hz)

    def set_oversampling(self, os_idx: int) -> None:
        req = int(os_idx)
        if self.freq_hz > self._max_freq_for_os(req):
            self.os_idx = self._best_os_for_freq(self.freq_hz)
        else:
            self.os_idx = req

    def get_oversampling(self) -> int:
        return self.os_idx

    def set_gain(self, head: int, gain: int) -> None:
        self.gains[int(head) - 1] = int(gain)

    def arm_acquisition(self, frames: int, use_trigger: bool = False, trigger_rising: bool = True) -> None:
        _ = (frames, use_trigger, trigger_rising)

    def state_enum(self) -> int:
        return svc.COREDAQ_READY_STATE

    def transfer_frames_W(self, frames: int):
        out = []
        for ch in range(4):
            base = (ch + 1) * 1e-9
            out.append([base + ((i % 100) - 50) * 1e-12 for i in range(frames)])
        return out

    def get_head_temperature_C(self) -> float:
        return 24.5

    def get_head_humidity(self) -> float:
        return 38.0

    def set_responsivity_reference_nm(self, wavelength_nm: float) -> None:
        self.resp_ref_nm = float(wavelength_nm)

    def set_wavelength_nm(self, wavelength_nm: float) -> None:
        self.wavelength_nm = float(wavelength_nm)

    def get_wavelength_nm(self) -> float:
        return float(self.wavelength_nm)


class SweepCaptureTests(unittest.TestCase):
    def test_sweep_returns_4_series_and_applies_os_and_1550nm_anchor(self):
        backend = svc.CoreDAQBackend(port=None, timeout=0.05)
        dev = FakeDev()
        session = svc.DeviceSession(
            device_id='DEV_TEST',
            port='COM_FAKE',
            dev=dev,
            idn='COREDAQ_FWV4_TEST',
            frontend_type=svc.CoreDAQ.FRONTEND_LINEAR,
            detector_type=svc.CoreDAQ.DETECTOR_INGAAS,
        )

        params = {
            'start_nm': 1500.0,
            'stop_nm': 1510.0,
            'speed_nm_s': 100.0,
            'power_mw': 1.0,
            'sample_rate_hz': 100_000,
            'os_idx': 6,
            'gains': [1, 2, 3, 4],
            'channel_mask': 0x0F,
            'preview_points': 4096,
        }

        with patch.object(svc, 'pyvisa', object()), patch.object(svc, 'LaserSession', FakeLaserSession), patch.object(svc.time, 'sleep', lambda _t: None):
            out = backend._run_sweep_capture(session, 'GPIB0::1::INSTR', params)

        self.assertEqual(len(out.get('series', [])), 4)
        self.assertTrue(all(len(ch.get('data', [])) > 0 for ch in out['series']))
        self.assertEqual(out.get('channel_mask'), 0x0F)

        # Requested OS is clamped for 100 kHz and backend reports effective values.
        self.assertEqual(out.get('os_idx_requested'), 6)
        self.assertEqual(out.get('os_idx_max_for_rate'), 1)
        self.assertEqual(out.get('os_idx'), 1)

        # InGaAs sweep path anchors conversion wavelength/reference at 1550 nm.
        self.assertEqual(dev.resp_ref_nm, 1550.0)
        self.assertEqual(dev.wavelength_nm, 1550.0)


if __name__ == '__main__':
    unittest.main()

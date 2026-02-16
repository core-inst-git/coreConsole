#!/usr/bin/env python3
# coredaq_py_api.py  v3.2
# High-level driver for coreDAQ
#
# REQUIREMENTS:
#   pip install pyserial

import serial, time, struct, threading, math, sys, bisect, re
import serial.tools.list_ports
from array import array
from typing import Optional, Tuple, List, Union, Dict
import warnings
import json
import os


class CoreDAQError(Exception):
    pass


Number = Union[int, float]
NumOrSeq = Union[Number, List[Number], Tuple[Number, ...]]


class CoreDAQ:
    # --- Device/ADC constants ---
    ADC_BITS = 16
    ADC_VFS_VOLTS = 5.0  # ±5 V range (full-scale magnitude)
    # For signed 16-bit bipolar ADC codes, LSB_V = (2*Vfs) / 2^bits
    ADC_LSB_VOLTS = (2.0 * ADC_VFS_VOLTS) / (2 ** ADC_BITS)
    ADC_LSB_MV = ADC_LSB_VOLTS * 1e3

    # Transport/display precision guardrails.
    # Use enough fractional digits to preserve sub-nW linear LSB behavior
    # (e.g. ~20 pW at high gain) without exposing unbounded float tails.
    MV_OUTPUT_DECIMALS = 3
    POWER_OUTPUT_DECIMALS_MAX = 12

    # Keep legacy names used in your old code
    FS_VOLTS = ADC_VFS_VOLTS
    CODES_PER_FS = 32768.0  # signed full-scale codes

    NUM_HEADS = 4
    NUM_GAINS = 8
    SDRAM_BYTES = 32 * 1024 * 1024

    FRONTEND_LINEAR = "LINEAR"
    FRONTEND_LOG = "LOG"
    DETECTOR_INGAAS = "INGAAS"
    DETECTOR_SILICON = "SILICON"

    DEFAULT_WAVELENGTH_NM = 1550.0
    DEFAULT_RESPONSIVITY_REF_NM = 1550.0
    DEFAULT_SILICON_LOG_VY_V_PER_DECADE = 0.5
    DEFAULT_SILICON_LOG_IZ_A = 100e-12
    INGAAS_WAVELENGTH_RANGE_NM = (910.0, 1700.0)
    SILICON_WAVELENGTH_RANGE_NM = (400.0, 1100.0)

    # Nominal maximum recommended optical power per gain (watts), UI guidance only
    GAIN_MAX_POWER_W = [
        4e-3,      # G0: 4 mW
        2e-3,      # G1: 2 mW
        800e-6,    # G2: 800 µW
        400e-6,    # G3: 400 µW
        80e-6,     # G4: 80 µW
        40e-6,     # G5: 40 µW
        4e-6,      # G6: 4 µW
        400e-9,    # G7: 400 nW
    ]

    GAIN_LABELS = [
        "4 mW",
        "2 mW",
        "800 µW",
        "400 µW",
        "80 µW",
        "40 µW",
        "4 µW",
        "400 nW",
    ]

    @classmethod
    def _build_default_tia_ohm_table(cls) -> List[List[float]]:
        """
        Fallback TIA estimates if no explicit silicon gain table is provided.
        These are based on nominal range labels and 5 V ADC full-scale.
        """
        per_gain = []
        for pmax in cls.GAIN_MAX_POWER_W:
            if pmax <= 0:
                per_gain.append(1.0)
            else:
                per_gain.append(cls.ADC_VFS_VOLTS / pmax)
        return [list(per_gain) for _ in range(cls.NUM_HEADS)]

    def __init__(self, port: str, timeout: float = 0.15, inter_command_gap_s: float = 0.0):
        self._ser = serial.Serial(
            port=port,
            baudrate=115200,
            timeout=timeout,
            write_timeout=0.5
        )
        self._lock = threading.Lock()
        self._inter_command_gap_s = max(0.0, float(inter_command_gap_s))
        self._last_command_ts = 0.0
        self._drain()

        # Detect frontend type ONCE at init
        self._frontend_type: str = self._detect_frontend_type_once()
        self._idn_cache: str = ""
        try:
            self._idn_cache = self.idn()
        except Exception:
            self._idn_cache = ""
        self._detector_type: str = self._detect_detector_type_once(self._idn_cache)

        # LINEAR calibration tables
        self._cal_slope = [[0.0 for _ in range(self.NUM_GAINS)] for _ in range(self.NUM_HEADS)]
        self._cal_intercept = [[0.0 for _ in range(self.NUM_GAINS)] for _ in range(self.NUM_HEADS)]

        # Near-zero clamp (mV) used by LINEAR conversions (optional)
        self._mv_zero_threshold = 0.0

        # ====== v3.1: LINEAR zeroing (gain-independent, per-channel) ======
        # Firmware: FACTORY_ZEROS? -> 4 values (CH1..CH4)
        # Host always subtracts active zeros for LINEAR snapshots/transfers.
        # Soft zero overwrites the active zeros (host-side only).
        self._factory_zero_adc: List[int] = [0, 0, 0, 0]
        self._linear_zero_adc: List[int] = [0, 0, 0, 0]

        # ====== LOG LUT storage ======
        self._loglut_V_V: Optional[List[float]] = None
        self._loglut_log10P: Optional[List[float]] = None
        self._loglut_V_mV: Optional[List[int]] = None
        self._loglut_log10P_Q16: Optional[List[int]] = None

        # ====== v3.1: LOG deadband (mV), independent of zeroing ======
        self._log_deadband_mV: float = 300.0  # default; change via set_log_deadband_mV()

        # Wavelength / responsivity model state.
        self._wavelength_nm: float = self.DEFAULT_WAVELENGTH_NM
        self._responsivity_ref_nm: float = self.DEFAULT_RESPONSIVITY_REF_NM
        self._resp_curve_nm: Dict[str, List[float]] = {}
        self._resp_curve_aw: Dict[str, List[float]] = {}

        # Silicon model parameters.
        self._silicon_log_vy_v_per_decade: float = self.DEFAULT_SILICON_LOG_VY_V_PER_DECADE
        self._silicon_log_iz_a: float = self.DEFAULT_SILICON_LOG_IZ_A
        self._silicon_linear_tia_ohm: List[List[float]] = self._build_default_tia_ohm_table()

        # Load I2C state and calibration tables
        self.i2c_refresh()
        self._load_calibration_for_frontend()

        # Load factory zeros AFTER calibration load (LINEAR only)
        if self._frontend_type == self.FRONTEND_LINEAR:
            self._load_factory_zeros()

        # Build silicon fallback TIA estimates from loaded LINEAR calibration when available.
        self._bootstrap_silicon_tia_from_linear_cal()

        # Load bundled responsivity curves if present.
        resp_path = os.path.join(os.path.dirname(__file__), "responsivity_curves.json")
        if os.path.exists(resp_path):
            try:
                self.load_responsivity_curves_json(resp_path)
                self._bootstrap_silicon_tia_from_linear_cal()
            except Exception:
                # Keep API usable even if responsivity file is malformed/missing.
                pass

    # ---------- Lifecycle ----------
    def close(self):
        try:
            if self._ser.is_open:
                self._ser.flush()
                self._ser.reset_input_buffer()
                self._ser.reset_output_buffer()
                self._ser.close()
        except Exception:
            pass

    def __enter__(self):
        return self

    def __exit__(self, et, ev, tb):
        self.close()

    # ---------- Low-level IO helpers ----------
    def _drain(self):
        try:
            self._ser.reset_input_buffer()
        except Exception:
            pass

    def _writeln(self, s: str):
        if not s.endswith("\n"):
            s += "\n"
        self._ser.write(s.encode("ascii", errors="ignore"))

    def _readline(self) -> str:
        raw = self._ser.readline()
        if not raw:
            raise CoreDAQError("Device timeout")
        return raw.decode("ascii", "ignore").strip()

    def _ask(self, cmd: str) -> Tuple[str, str]:
        with self._lock:
            # Optional pacing to avoid back-to-back command bursts on some hosts.
            if self._inter_command_gap_s > 0.0 and self._last_command_ts > 0.0:
                dt = time.perf_counter() - self._last_command_ts
                if dt < self._inter_command_gap_s:
                    time.sleep(self._inter_command_gap_s - dt)
            self._writeln(cmd)
            self._last_command_ts = time.perf_counter()
            line = self._readline()
        if line.startswith("OK"):
            return "OK", line[2:].strip()
        if line.startswith("ERR"):
            return "ERR", line[3:].strip()
        if line.startswith("BUSY"):
            return "BUSY", ""
        return "ERR", line

    def set_inter_command_gap_s(self, gap_s: float) -> None:
        g = float(gap_s)
        if not math.isfinite(g) or g < 0.0:
            raise ValueError("inter-command gap must be >= 0")
        self._inter_command_gap_s = g

    def get_inter_command_gap_s(self) -> float:
        return float(self._inter_command_gap_s)

    @staticmethod
    def _parse_int(s: str) -> int:
        return int(s, 0)

    @staticmethod
    def _active_channel_indices(mask: int) -> List[int]:
        return [i for i in range(4) if ((mask >> i) & 0x1) != 0]

    @classmethod
    def _frame_bytes_from_mask(cls, mask: int) -> int:
        ch = len(cls._active_channel_indices(mask))
        if ch == 0:
            raise CoreDAQError("Invalid channel mask: no channels enabled")
        return ch * 2

    # ---------- Frontend detection (ONE TIME) ----------
    def _detect_frontend_type_once(self) -> str:
        """
        Detects frontend type exactly once at init.
        Requires firmware command:
          HEAD_TYPE?
        Response:
          OK TYPE=LOG
          OK TYPE=LINEAR
        """
        time.sleep(0.05)
        self._drain()

        st, p = self._ask("HEAD_TYPE?")
        if st != "OK":
            raise CoreDAQError(f"HEAD_TYPE? failed: {p}")

        txt = p.strip().upper().replace(" ", "")
        if "TYPE=LOG" in txt:
            return self.FRONTEND_LOG
        if "TYPE=LINEAR" in txt:
            return self.FRONTEND_LINEAR
        raise CoreDAQError(f"Unexpected HEAD_TYPE? reply: {p!r}")

    def frontend_type(self) -> str:
        return self._frontend_type

    def _require_frontend(self, expected: str, feature: str):
        if self._frontend_type != expected:
            raise CoreDAQError(
                f"{feature} not supported on {self._frontend_type} front end (expected {expected})."
            )

    # ---------- Detector / wavelength / responsivity ----------
    @staticmethod
    def _normalize_detector_type(detector: str) -> str:
        txt = str(detector or "").strip().upper()
        if txt in ("INGAAS", "INGAAS_PD", "INGAASPD"):
            return CoreDAQ.DETECTOR_INGAAS
        if txt in ("SILICON", "SI", "SIPD", "SI_PD"):
            return CoreDAQ.DETECTOR_SILICON
        raise ValueError(f"Unknown detector type: {detector!r}")

    def _detect_detector_type_once(self, idn_payload: str = "") -> str:
        txt = str(idn_payload or "").upper()
        if "INGAAS" in txt:
            return self.DETECTOR_INGAAS
        if "SILICON" in txt:
            return self.DETECTOR_SILICON

        # Support compact tokenized IDs such as "..._SI_..."
        toks = [t for t in re.split(r"[^A-Z0-9]+", txt) if t]
        if "SI" in toks:
            return self.DETECTOR_SILICON
        if "INGAAS" in toks:
            return self.DETECTOR_INGAAS

        # Backward-compatible default for existing deployments.
        return self.DETECTOR_INGAAS

    def detector_type(self) -> str:
        return self._detector_type

    def set_detector_type(self, detector: str) -> None:
        self._detector_type = self._normalize_detector_type(detector)
        # Enforce detector-specific wavelength bounds after type change.
        self.set_wavelength_nm(self._wavelength_nm)

    def _detector_wavelength_limits_nm(self, detector: Optional[str] = None) -> Tuple[float, float]:
        det = self._detector_type if detector is None else self._normalize_detector_type(detector)
        if det == self.DETECTOR_SILICON:
            return self.SILICON_WAVELENGTH_RANGE_NM
        return self.INGAAS_WAVELENGTH_RANGE_NM

    def get_wavelength_limits_nm(self, detector: Optional[str] = None) -> Tuple[float, float]:
        return self._detector_wavelength_limits_nm(detector)

    def set_wavelength_nm(self, wavelength_nm: float) -> None:
        wl = float(wavelength_nm)
        if not math.isfinite(wl) or wl <= 0.0:
            raise ValueError("wavelength_nm must be > 0")
        lo, hi = self._detector_wavelength_limits_nm()
        clamped = max(lo, min(hi, wl))
        if clamped != wl:
            warnings.warn(
                (
                    f"wavelength_nm={wl:g} is outside {self._detector_type} range "
                    f"[{lo:g}, {hi:g}] nm; clamped to {clamped:g} nm."
                ),
                RuntimeWarning,
                stacklevel=2,
            )
        self._wavelength_nm = clamped

    def get_wavelength_nm(self) -> float:
        return float(self._wavelength_nm)

    def set_responsivity_reference_nm(self, wavelength_nm: float) -> None:
        wl = float(wavelength_nm)
        if not math.isfinite(wl) or wl <= 0.0:
            raise ValueError("responsivity reference wavelength must be > 0")
        self._responsivity_ref_nm = wl

    def get_responsivity_reference_nm(self) -> float:
        return float(self._responsivity_ref_nm)

    def load_responsivity_curves_json(self, path: str) -> None:
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)

        det = doc.get("detectors", {})
        parsed_nm = {}
        parsed_aw = {}
        for key in (self.DETECTOR_INGAAS, self.DETECTOR_SILICON):
            points = det.get(key, {}).get("points", [])
            clean = []
            for row in points:
                if not isinstance(row, (list, tuple)) or len(row) < 2:
                    continue
                try:
                    wl = float(row[0])
                    aw = float(row[1])
                except Exception:
                    continue
                if wl <= 0.0 or aw <= 0.0 or not math.isfinite(wl) or not math.isfinite(aw):
                    continue
                clean.append((wl, aw))

            if not clean:
                continue

            clean.sort(key=lambda x: x[0])
            # Deduplicate wavelength entries by keeping the last value.
            by_wl = {}
            for wl, aw in clean:
                by_wl[wl] = aw
            uniq = sorted(by_wl.items(), key=lambda x: x[0])
            parsed_nm[key] = [p[0] for p in uniq]
            parsed_aw[key] = [p[1] for p in uniq]

        if self.DETECTOR_INGAAS not in parsed_nm:
            raise CoreDAQError("Responsivity JSON missing INGAAS curve")
        if self.DETECTOR_SILICON not in parsed_nm:
            raise CoreDAQError("Responsivity JSON missing SILICON curve")

        self._resp_curve_nm = parsed_nm
        self._resp_curve_aw = parsed_aw

    def _interp_responsivity_aw(self, detector: str, wavelength_nm: float) -> float:
        det = self._normalize_detector_type(detector)
        if det not in self._resp_curve_nm or det not in self._resp_curve_aw:
            raise CoreDAQError(
                "Responsivity curves are not loaded. "
                "Run load_responsivity_curves_json(<path>) first."
            )

        xs = self._resp_curve_nm[det]
        ys = self._resp_curve_aw[det]
        x = float(wavelength_nm)
        if x <= xs[0]:
            return float(ys[0])
        if x >= xs[-1]:
            return float(ys[-1])

        j = bisect.bisect_left(xs, x)
        x0, x1 = xs[j - 1], xs[j]
        y0, y1 = ys[j - 1], ys[j]
        if x1 == x0:
            return float(y0)
        t = (x - x0) / (x1 - x0)
        return float(y0 + t * (y1 - y0))

    def get_responsivity_A_per_W(
        self,
        detector: Optional[str] = None,
        wavelength_nm: Optional[float] = None,
    ) -> float:
        det = self._detector_type if detector is None else detector
        wl = self._wavelength_nm if wavelength_nm is None else float(wavelength_nm)
        return float(self._interp_responsivity_aw(det, wl))

    def _ingaas_responsivity_correction_factor(self) -> float:
        """
        Relative correction from calibration reference wavelength to current wavelength:
          P(lambda) = P(ref) * R(ref) / R(lambda)
        """
        try:
            r_ref = self._interp_responsivity_aw(self.DETECTOR_INGAAS, self._responsivity_ref_nm)
            r_now = self._interp_responsivity_aw(self.DETECTOR_INGAAS, self._wavelength_nm)
        except Exception:
            # Keep legacy behavior if responsivity curves are unavailable.
            return 1.0
        if r_now <= 0.0 or not math.isfinite(r_now):
            return 1.0
        return max(0.0, float(r_ref) / float(r_now))

    def _bootstrap_silicon_tia_from_linear_cal(self) -> None:
        """
        Estimate per-channel/per-gain effective transimpedance (ohms) from LINEAR calibration:
          slope[mV/W] ~= 1000 * R_tia[ohm] * responsivity[A/W]
        This gives a robust default for SILICON LINEAR mode until explicit gain tables are provided.
        """
        try:
            r_ref = self._interp_responsivity_aw(self.DETECTOR_INGAAS, self._responsivity_ref_nm)
        except Exception:
            r_ref = 1.0

        if not math.isfinite(r_ref) or r_ref <= 0.0:
            r_ref = 1.0

        for h in range(self.NUM_HEADS):
            for g in range(self.NUM_GAINS):
                slope = float(self._cal_slope[h][g])
                if not math.isfinite(slope) or slope == 0.0:
                    continue
                tia = abs(slope) / (1000.0 * r_ref)
                if math.isfinite(tia) and tia > 0.0:
                    self._silicon_linear_tia_ohm[h][g] = float(tia)

    def set_silicon_linear_tia_ohm(self, head: int, gain: int, tia_ohm: float) -> None:
        if head not in (1, 2, 3, 4):
            raise ValueError("head must be 1..4")
        if not (0 <= int(gain) < self.NUM_GAINS):
            raise ValueError("gain must be 0..7")
        val = float(tia_ohm)
        if not math.isfinite(val) or val <= 0.0:
            raise ValueError("tia_ohm must be > 0")
        self._silicon_linear_tia_ohm[head - 1][int(gain)] = val

    def get_silicon_linear_tia_ohm(self, head: int, gain: int) -> float:
        if head not in (1, 2, 3, 4):
            raise ValueError("head must be 1..4")
        if not (0 <= int(gain) < self.NUM_GAINS):
            raise ValueError("gain must be 0..7")
        return float(self._silicon_linear_tia_ohm[head - 1][int(gain)])

    def set_silicon_log_model(self, vy_v_per_decade: float, iz_a: float) -> None:
        vy = float(vy_v_per_decade)
        iz = float(iz_a)
        if not math.isfinite(vy) or vy <= 0.0:
            raise ValueError("vy_v_per_decade must be > 0")
        if not math.isfinite(iz) or iz <= 0.0:
            raise ValueError("iz_a must be > 0")
        self._silicon_log_vy_v_per_decade = vy
        self._silicon_log_iz_a = iz

    def get_silicon_log_model(self) -> Tuple[float, float]:
        return float(self._silicon_log_vy_v_per_decade), float(self._silicon_log_iz_a)

    def _convert_log_voltage_to_power_w(self, v_volts: float) -> float:
        if self._detector_type == self.DETECTOR_SILICON:
            # ADL5303 model:
            #   Vout = VY * log10(S * Pin / IZ)
            # => Pin = (IZ / S) * 10^(Vout / VY)
            resp = self._interp_responsivity_aw(self.DETECTOR_SILICON, self._wavelength_nm)
            if resp <= 0.0:
                raise CoreDAQError("Invalid silicon responsivity")
            pin_w = (self._silicon_log_iz_a / resp) * (10.0 ** (float(v_volts) / self._silicon_log_vy_v_per_decade))
            return float(pin_w)

        pin_w = float(self.voltage_to_power_W(float(v_volts)))
        if self._detector_type == self.DETECTOR_INGAAS:
            pin_w *= self._ingaas_responsivity_correction_factor()
        return pin_w

    def _convert_linear_mv_to_power_w(self, head_idx: int, gain: int, mv_corr: float) -> float:
        if abs(mv_corr) < float(self._mv_zero_threshold):
            return 0.0

        if self._detector_type == self.DETECTOR_SILICON:
            resp = self._interp_responsivity_aw(self.DETECTOR_SILICON, self._wavelength_nm)
            tia = float(self._silicon_linear_tia_ohm[head_idx][gain])
            if resp <= 0.0 or tia <= 0.0:
                raise CoreDAQError(f"Invalid silicon model at head {head_idx+1}, gain {gain}")

            power_lsb = self.ADC_LSB_VOLTS / abs(tia * resp)
            decimals = self._power_decimals_from_step(power_lsb)
            p_w = (float(mv_corr) / 1000.0) / (tia * resp)
            p_w = self._quantize_to_step(p_w, power_lsb)
            return round(p_w, decimals)

        slope_mV_per_W = float(self._cal_slope[head_idx][gain])
        intercept_mV = float(self._cal_intercept[head_idx][gain])
        if slope_mV_per_W == 0.0:
            raise CoreDAQError(f"Invalid slope for head {head_idx+1}, gain {gain}")

        power_lsb = self.ADC_LSB_MV / abs(slope_mV_per_W)
        p_w = (float(mv_corr) - intercept_mV) / slope_mV_per_W
        if self._detector_type == self.DETECTOR_INGAAS:
            corr = self._ingaas_responsivity_correction_factor()
            p_w *= corr
            power_lsb *= max(0.0, corr)

        decimals = self._power_decimals_from_step(power_lsb)
        p_w = self._quantize_to_step(p_w, power_lsb)
        return round(p_w, decimals)

    # ---------- Identity ----------
    def idn(self, refresh: bool = False) -> str:
        if self._idn_cache and not refresh:
            return self._idn_cache
        st, p = self._ask("IDN?")
        if st != "OK":
            raise CoreDAQError(p)
        self._idn_cache = p
        return p

    # ---------- ADC conversions (raw) ----------
    @classmethod
    def adc_code_to_volts(cls, code: Number) -> float:
        return float(code) * cls.ADC_LSB_VOLTS

    @classmethod
    def adc_code_to_mV(cls, code: Number) -> float:
        return cls.adc_code_to_volts(code) * 1e3

    @classmethod
    def _power_decimals_from_step(cls, step_w: float) -> int:
        if not math.isfinite(step_w) or step_w <= 0.0:
            return 0
        return max(0, min(cls.POWER_OUTPUT_DECIMALS_MAX, round(-math.log10(step_w))))

    @staticmethod
    def _quantize_to_step(value: float, step: float) -> float:
        if not math.isfinite(value):
            return 0.0
        if not math.isfinite(step) or step <= 0.0:
            return value
        return round(value / step) * step

    # ============================================================
    # v3.1 LINEAR ZEROING (factory + soft; gain-independent)
    # ============================================================
    def _load_factory_zeros(self) -> List[int]:
        """
        LINEAR-only. Queries device for factory ADC zero offsets.

        Firmware command:
          FACTORY_ZEROS?
        Accepts responses like:
          OK 836 835 834 839
        or:
          OK h1=836 h2=835 h3=834 h4=839
        """
        self._require_frontend(self.FRONTEND_LINEAR, "_load_factory_zeros")

        st, payload = self._ask("FACTORY_ZEROS?")
        if st != "OK":
            raise CoreDAQError(f"FACTORY_ZEROS? failed: {payload}")

        parts = payload.split()
        if len(parts) < 4:
            raise CoreDAQError(f"FACTORY_ZEROS? payload too short: {payload!r}")

        # Case A: key=value format (preferred if detected)
        if any("=" in t for t in parts):
            kv = {}
            for t in parts:
                if "=" not in t:
                    continue
                k, v = t.split("=", 1)
                kv[k.strip().lower()] = v.strip()

            def _get(k: str) -> int:
                if k not in kv:
                    raise CoreDAQError(f"FACTORY_ZEROS? missing {k}= in {payload!r}")
                try:
                    return int(kv[k], 0)
                except Exception as e:
                    raise CoreDAQError(f"FACTORY_ZEROS? bad {k} value in {payload!r}") from e

            z = [_get("h1"), _get("h2"), _get("h3"), _get("h4")]

        # Case B: plain 4 integers
        else:
            try:
                z = [int(parts[0], 0), int(parts[1], 0), int(parts[2], 0), int(parts[3], 0)]
            except Exception as e:
                raise CoreDAQError(f"FACTORY_ZEROS? parse error: {payload!r}") from e

        self._factory_zero_adc = list(z)
        self._linear_zero_adc = list(z)
        return list(z)

    def refresh_factory_zeros(self) -> Tuple[int, int, int, int]:
        """
        LINEAR-only. Re-queries FACTORY_ZEROS? and sets them as active zeros.
        """
        if self._frontend_type != self.FRONTEND_LINEAR:
            return (0, 0, 0, 0)
        z = self._load_factory_zeros()
        return tuple(z)  # type: ignore[return-value]

    def get_linear_zero_adc(self) -> Tuple[int, int, int, int]:
        """
        Returns the currently active LINEAR zero offsets (CH1..CH4).
        On LOG devices this returns (0,0,0,0).
        """
        if self._frontend_type != self.FRONTEND_LINEAR:
            return (0, 0, 0, 0)
        return tuple(int(x) for x in self._linear_zero_adc)  # type: ignore[return-value]

    def get_factory_zero_adc(self) -> Tuple[int, int, int, int]:
        """
        Returns last loaded factory zeros (CH1..CH4). On LOG returns (0,0,0,0).
        """
        if self._frontend_type != self.FRONTEND_LINEAR:
            return (0, 0, 0, 0)
        return tuple(int(x) for x in self._factory_zero_adc)  # type: ignore[return-value]

    def set_soft_zero_adc(self, z1: int, z2: int, z3: int, z4: int) -> None:
        """
        LINEAR-only. Overwrites the active zero offsets (soft zeroing).
        This does NOT talk to the device; host-side subtraction only.
        """
        if self._frontend_type != self.FRONTEND_LINEAR:
            return
        self._linear_zero_adc = [int(z1), int(z2), int(z3), int(z4)]

    def restore_factory_zero(self) -> None:
        """
        LINEAR-only. Restores active zeros to the last loaded factory zeros.
        If none were loaded, best-effort loads them from device.
        """
        if self._frontend_type != self.FRONTEND_LINEAR:
            return

        if self._factory_zero_adc == [0, 0, 0, 0]:
            try:
                self._load_factory_zeros()
                return
            except Exception:
                pass

        self._linear_zero_adc = list(self._factory_zero_adc)

    def soft_zero_from_snapshot(self, n_frames: int = 32, settle_s: float = 0.2) -> Tuple[List[int], List[int]]:
        """
        LINEAR-only. Takes a snapshot and uses returned ADC codes (CH1..CH4)
        as new soft zero offsets.
        Returns:
          (codes, gains) from snapshot. (codes are raw snapshot codes)
        """
        self._require_frontend(self.FRONTEND_LINEAR, "soft_zero_from_snapshot")
        if n_frames <= 0:
            raise ValueError("n_frames must be > 0")

        time.sleep(max(0.0, float(settle_s)))
        codes, gains = self.snapshot_adc(n_frames=n_frames)
        self._linear_zero_adc = [int(codes[0]), int(codes[1]), int(codes[2]), int(codes[3])]
        return codes, gains

    def recompute_zero_from_snapshot(
        self,
        n_frames: int = 32,
        temp_freq_hz: int = 1000,
        temp_os: int = 6,
        settle_s: float = 0.2,
    ) -> Tuple[List[int], List[int]]:
        """
        LINEAR-only. Assumes the device is at zero input.
        Temporarily sets FREQ/OS, takes a snapshot, updates soft zero (host-side),
        then restores previous FREQ/OS.
        Returns: (codes, gains) from snapshot.
        """
        self._require_frontend(self.FRONTEND_LINEAR, "recompute_zero_from_snapshot")
        if n_frames <= 0:
            raise ValueError("n_frames must be > 0")

        prev_freq = self.get_freq_hz()
        prev_os = self.get_oversampling()

        try:
            # Set temporary acquisition conditions
            self.set_freq(temp_freq_hz)
            self.set_oversampling(temp_os)
            time.sleep(max(0.0, float(settle_s)))

            codes, gains = self.snapshot_adc(n_frames=n_frames)
            self._linear_zero_adc = [int(codes[0]), int(codes[1]), int(codes[2]), int(codes[3])]
            return codes, gains
        finally:
            # Restore previous settings
            try:
                self.set_freq(prev_freq)
                self.set_oversampling(prev_os)
            except Exception:
                # Best-effort restore; caller can handle if needed.
                pass

    def _apply_linear_zero_ch(self, codes: List[int]) -> List[int]:
        """
        LINEAR-only: subtract per-channel active zeros.
        LOG: passthrough.
        """
        if self._frontend_type != self.FRONTEND_LINEAR:
            return codes
        return [int(codes[i]) - int(self._linear_zero_adc[i]) for i in range(4)]

    def snapshot_adc_zeroed(
        self,
        n_frames: int = 1,
        timeout_s: float = 1.0,
        poll_hz: float = 200.0
    ) -> Tuple[List[int], List[int]]:
        """
        Returns ADC codes with active LINEAR zero offsets applied.
        LOG frontends return raw codes unchanged.
        """
        codes, gains = self.snapshot_adc(n_frames=n_frames, timeout_s=timeout_s, poll_hz=poll_hz)
        return self._apply_linear_zero_ch(codes), gains

    # ---------- v3.1: LOG deadband controls ----------
    def set_log_deadband_mV(self, deadband_mV: float) -> None:
        """
        Set LOG deadband threshold in mV.
        Only used for LOG conversions; has no effect on LINEAR.
        Set to 0 to disable.
        """
        if deadband_mV < 0:
            raise ValueError("deadband_mV must be >= 0")
        self._log_deadband_mV = float(deadband_mV)

    def get_log_deadband_mV(self) -> float:
        return float(self._log_deadband_mV)

    # ---------- Calibration loading ----------
    def _load_calibration_for_frontend(self):
        if self._frontend_type == self.FRONTEND_LINEAR:
            self._load_linear_calibration()
        elif self._frontend_type == self.FRONTEND_LOG:
            self._load_log_calibration()
        else:
            raise CoreDAQError(f"Unknown frontend type: {self._frontend_type}")

    def _load_linear_calibration(self):
        """
        Query all heads/gains via CAL <head> <gain> and populate:
          self._cal_slope[head-1][gain]     (mV/W)
          self._cal_intercept[head-1][gain] (mV)

        Expects:
          OK H<h> G<g> S=<SLOPE_HEX> I=<INTERCEPT_HEX>
        """
        for head in range(1, self.NUM_HEADS + 1):
            for gain in range(self.NUM_GAINS):
                status, payload = self._ask(f"CAL {head} {gain}")
                if status != "OK":
                    raise CoreDAQError(f"CAL {head} {gain} failed: {payload}")

                parts = payload.split()
                if len(parts) < 4:
                    raise CoreDAQError(f"Unexpected CAL reply: {payload!r}")

                slope_hex = None
                intercept_hex = None
                for token in parts:
                    if token.startswith("S="):
                        slope_hex = token.split("=", 1)[1]
                    elif token.startswith("I="):
                        intercept_hex = token.split("=", 1)[1]

                if slope_hex is None or intercept_hex is None:
                    raise CoreDAQError(f"Missing S= or I= in CAL reply: {payload!r}")

                try:
                    slope_bits = int(slope_hex, 16)
                    intercept_bits = int(intercept_hex, 16)
                    slope = struct.unpack("<f", slope_bits.to_bytes(4, "little"))[0]
                    intercept = struct.unpack("<f", intercept_bits.to_bytes(4, "little"))[0]
                except Exception as e:
                    raise CoreDAQError(f"Failed parsing CAL payload {payload!r}: {e}")

                self._cal_slope[head - 1][gain] = float(slope)
                self._cal_intercept[head - 1][gain] = float(intercept)

    def _load_log_calibration(self):
        """
        Pull log LUT via:
          LOGCAL 1

        Stream:
          OK H1 N=<n_pts> RB=<rec_bytes>
          <binary payload n_pts*RB>
          OK DONE

        Record = little-endian <Hi:
          uint16 V_mV
          int32  log10P_Q16
        """
        with self._lock:
            self._ser.reset_input_buffer()
            self._writeln("LOGCAL 1")

            header = None
            for _ in range(120):
                raw = self._ser.readline()
                if not raw:
                    continue
                line = raw.decode("ascii", "ignore").strip()
                if line.startswith("OK") and (" N=" in line) and (" RB=" in line) and (" H" in line):
                    header = line
                    break

            if not header:
                raise CoreDAQError("LOGCAL header not received")

            parts = header.split()
            try:
                n_pts = int([t for t in parts if t.startswith("N=")][0].split("=", 1)[1])
                rb = int([t for t in parts if t.startswith("RB=")][0].split("=", 1)[1])
            except Exception:
                raise CoreDAQError(f"Malformed LOGCAL header: {header!r}")

            if rb != 6:
                raise CoreDAQError(f"Unexpected LOGCAL RB={rb} (expected 6)")

            payload_len = n_pts * rb
            payload = self._ser.read(payload_len)
            if len(payload) != payload_len:
                raise CoreDAQError(f"Short LOGCAL payload: got {len(payload)} / {payload_len}")

            done_ok = False
            for _ in range(120):
                raw = self._ser.readline()
                if not raw:
                    continue
                line = raw.decode("ascii", "ignore").strip()
                if line == "OK DONE":
                    done_ok = True
                    break
            if not done_ok:
                raise CoreDAQError("LOGCAL missing OK DONE terminator")

        V_mV: List[int] = []
        Q16: List[int] = []
        for i in range(n_pts):
            v, q = struct.unpack_from("<Hi", payload, i * rb)
            V_mV.append(int(v))
            Q16.append(int(q))

        if not V_mV:
            raise CoreDAQError("LOG LUT empty")

        self._loglut_V_mV = V_mV
        self._loglut_log10P_Q16 = Q16
        self._loglut_V_V = [v / 1000.0 for v in V_mV]
        self._loglut_log10P = [q / 65536.0 for q in Q16]

        if len(self._loglut_V_V) != len(self._loglut_log10P):
            raise CoreDAQError("LOG LUT length mismatch after decode")

    # ---------- LOG conversion (volts -> power) ----------
    def voltage_to_power_W(self, v_volts: NumOrSeq):
        self._require_frontend(self.FRONTEND_LOG, "voltage_to_power_W")
        if self._loglut_V_V is None or self._loglut_log10P is None:
            raise CoreDAQError("LOG LUT not loaded")

        xs = self._loglut_V_V
        ys = self._loglut_log10P

        def interp_one(x: float) -> float:
            if x <= xs[0]:
                return 10.0 ** ys[0]
            if x >= xs[-1]:
                return 10.0 ** ys[-1]

            j = bisect.bisect_left(xs, x)
            x0, x1 = xs[j - 1], xs[j]
            y0, y1 = ys[j - 1], ys[j]
            if x1 == x0:
                y = y0
            else:
                t = (x - x0) / (x1 - x0)
                y = y0 + t * (y1 - y0)
            return 10.0 ** y

        if isinstance(v_volts, (list, tuple)):
            return [interp_one(float(v)) for v in v_volts]
        return float(interp_one(float(v_volts)))

    # ---------- Snapshot (raw ADC + gains) ----------
    def snapshot_adc(self, n_frames: int = 1, timeout_s: float = 1.0, poll_hz: float = 200.0):
        """
        MCU returns ADC codes (signed 16-bit) for 4 channels + gains.
        Returns:
          (codes_list[4], gains_list[4])
        """
        st, payload = self._ask(f"SNAP {n_frames}")
        if st != "OK":
            raise CoreDAQError(f"SNAP arm failed: {payload}")

        t0 = time.time()
        sleep_s = 1.0 / poll_hz

        while True:
            st, payload = self._ask("SNAP?")
            if st == "BUSY":
                if (time.time() - t0) > timeout_s:
                    raise CoreDAQError("Snapshot timeout")
                time.sleep(sleep_s)
                continue

            if st != "OK":
                raise CoreDAQError(f"SNAP? failed: {payload}")

            parts = payload.split()
            if len(parts) < 4:
                raise CoreDAQError(f"SNAP? payload too short: {payload}")

            try:
                codes = [int(parts[i]) for i in range(4)]
            except ValueError as e:
                raise CoreDAQError(f"Failed to parse ADC codes from SNAP?: {payload}") from e

            gains = [0, 0, 0, 0]
            for i, part in enumerate(parts):
                if "G=" in part:
                    try:
                        gains[0] = int(part.split("=")[1])
                        gains[1] = int(parts[i + 1])
                        gains[2] = int(parts[i + 2])
                        gains[3] = int(parts[i + 3])
                    except (ValueError, IndexError) as e:
                        raise CoreDAQError(f"Failed to parse gains from SNAP?: {payload}") from e
                    break

            return codes, gains

    # ---------- v3.1: snapshot_volts/mV with LINEAR zero subtraction ----------
    def snapshot_volts(
        self,
        n_frames: int = 1,
        timeout_s: float = 1.0,
        poll_hz: float = 200.0,
        use_zero: Optional[bool] = None,  # kept for compatibility; ignored
    ):
        codes, gains = self.snapshot_adc_zeroed(n_frames=n_frames, timeout_s=timeout_s, poll_hz=poll_hz)
        v = [float(c) * self.ADC_LSB_VOLTS for c in codes]
        return v, gains

    def snapshot_mV(
        self,
        n_frames: int = 1,
        timeout_s: float = 1.0,
        poll_hz: float = 200.0,
        use_zero: Optional[bool] = None,  # kept for compatibility; ignored
    ):
        codes, gains = self.snapshot_adc_zeroed(n_frames=n_frames, timeout_s=timeout_s, poll_hz=poll_hz)
        mv = [round(float(c) * self.ADC_LSB_MV, self.MV_OUTPUT_DECIMALS) for c in codes]
        return mv, gains

    # ---------- Snapshot_W (unified, includes LINEAR autogain + LOG deadband) ----------
    def snapshot_W(
        self,
        n_frames: int = 1,
        timeout_s: float = 1.0,
        poll_hz: float = 200.0,
        use_zero: Optional[bool] = None,   # kept for compatibility; ignored
        autogain: bool = False,
        # autogain params (LINEAR only)
        min_mv: float = 100,
        max_mv: float = 4700.0,
        max_iters: int = 10,
        settle_s: float = 0.01,
        return_debug: bool = False,
        # LOG only (optional override)
        log_deadband_mV: Optional[float] = None,
    ):
        """
        Returns calibrated optical power (W) for each channel [1..4].

        LINEAR:
          - INGAAS: Uses slope/intercept (mV/W, mV) and current gains.
          - SILICON: Uses TIA gain model + Si responsivity curve.
          - If autogain=True, adjusts gains to keep |mV| within [min_mv, max_mv].
          - Always subtracts per-channel ADC zero (factory or soft).

        LOG:
          - INGAAS: Uses LUT (voltage -> P).
          - SILICON: Uses ADL5303 model + Si responsivity curve.
          - Applies deadband in mV (configurable) to suppress intercept wander.
          - Zeroing never affects LOG.

        Wavelength correction:
          - INGAAS conversions are corrected from reference wavelength (default 1550 nm)
            using R(ref)/R(lambda).
        """

        # ---------- LOG frontend ----------
        if self._frontend_type == self.FRONTEND_LOG:
            mv, _gains = self.snapshot_mV(n_frames=n_frames, timeout_s=timeout_s, poll_hz=poll_hz, use_zero=None)
            out: List[float] = []
            db = self._log_deadband_mV if log_deadband_mV is None else float(log_deadband_mV)

            for ch in range(4):
                mv_corr = float(mv[ch])
                if db > 0.0 and abs(mv_corr) < db:
                    out.append(0.0)
                    continue
                v = mv_corr / 1000.0
                p_w = self._convert_log_voltage_to_power_w(v)
                out.append(round(p_w, self.POWER_OUTPUT_DECIMALS_MAX))
            return out

        # ---------- LINEAR frontend ----------
        if self._frontend_type == self.FRONTEND_LINEAR:
            if autogain:
                for _ in range(max_iters):
                    mv_now, gains = self.snapshot_mV(
                        n_frames=n_frames,
                        timeout_s=timeout_s,
                        poll_hz=poll_hz,
                        use_zero=None
                    )
                    changed = False

                    for ch in range(4):
                        vabs = abs(float(mv_now[ch]))
                        g = int(gains[ch])
                        head = ch + 1

                        if vabs < min_mv and g < 7:
                            self.set_gain(head, g + 1)
                            changed = True
                        elif vabs > max_mv and g > 0:
                            self.set_gain(head, g - 1)
                            changed = True

                    if not changed:
                        break
                    time.sleep(settle_s)

            # final snapshot for conversion
            mv, gains = self.snapshot_mV(n_frames=n_frames, timeout_s=timeout_s, poll_hz=poll_hz, use_zero=None)

            out: List[float] = []

            for ch in range(4):
                head_idx = ch
                gain = int(gains[ch])
                mv_corr = float(mv[ch])
                out.append(self._convert_linear_mv_to_power_w(head_idx, gain, mv_corr))

            if return_debug:
                return out, mv, gains
            return out

        raise CoreDAQError(f"Unknown frontend type: {self._frontend_type}")

    # ---------- Gains (LINEAR only) ----------
    def set_gain(self, head: int, value: int) -> None:
        self._require_frontend(self.FRONTEND_LINEAR, "set_gain")
        if head not in (1, 2, 3, 4):
            raise ValueError("head must be 1..4")
        if not (0 <= value <= 7):
            raise ValueError("gain value must be 0..7")

        st, payload = self._ask(f"GAIN {head} {value}")
        if st != "OK":
            raise CoreDAQError(f"GAIN {head} failed: {payload}")
        
        time.sleep(0.05) # settle

    def get_gains(self) -> Tuple[int, int, int, int]:
        self._require_frontend(self.FRONTEND_LINEAR, "get_gains")

        st, payload = self._ask("GAINS?")
        if st != "OK":
            raise CoreDAQError(f"GAINS? failed: {payload}")

        parts = payload.replace("HEAD", "").replace("=", " ").split()
        try:
            nums = [int(parts[i]) for i in range(1, len(parts), 2)]
            if len(nums) != 4:
                raise ValueError
            return tuple(nums)  # type: ignore[return-value]
        except Exception:
            raise CoreDAQError(f"Unexpected GAINS? payload: '{payload}'")

    def set_gain1(self, value: int): self.set_gain(1, value)
    def set_gain2(self, value: int): self.set_gain(2, value)
    def set_gain3(self, value: int): self.set_gain(3, value)
    def set_gain4(self, value: int): self.set_gain(4, value)

    # ---------- State / acquisition helpers ----------
    def state_enum(self) -> int:
        st, p = self._ask("STATE?")
        if st != "OK":
            raise CoreDAQError(p)
        return self._parse_int(p)

    # ============================================================
    # Acquisition control (unified, explicit API)
    # ============================================================
    def arm_acquisition(self, frames: int, use_trigger: bool = False, trigger_rising: bool = True):
        if frames <= 0:
            raise ValueError("frames must be > 0")

        max_frames = self.max_acquisition_frames()
        if frames > max_frames:
            raise CoreDAQError(f"frames={frames} exceeds max={max_frames} for current channel mask")

        if use_trigger:
            pol = "R" if trigger_rising else "F"
            st, p = self._ask(f"TRIGARM {frames} {pol}")
            if st != "OK":
                raise CoreDAQError(f"TRIGARM failed: {p}")
            return

        st, p = self._ask(f"ACQ ARM {frames}")
        if st != "OK":
            raise CoreDAQError(f"ACQ ARM failed: {p}")

    def start_acquisition(self):
        st, p = self._ask("ACQ START")
        if st != "OK":
            raise CoreDAQError(f"ACQ START failed: {p}")

    def stop_acquisition(self):
        st, p = self._ask("ACQ STOP")
        if st != "OK":
            raise CoreDAQError(f"ACQ STOP failed: {p}")

    def acquisition_status(self) -> str:
        st, p = self._ask("STREAM?")
        if st != "OK":
            raise CoreDAQError(p)
        return p

    def frames_remaining(self) -> int:
        st, p = self._ask("LEFT?")
        if st != "OK":
            raise CoreDAQError(p)
        return self._parse_int(p)

    # ---------- Channel mask / capacity ----------
    def get_channel_mask_info(self) -> Tuple[int, int, int]:
        """
        Returns (mask, active_channels, frame_bytes).
        Firmware reply format example: "0xF CH=4 FB=8"
        """
        st, p = self._ask("CHMASK?")
        if st != "OK":
            raise CoreDAQError(f"CHMASK? failed: {p}")

        m = re.search(r"0x([0-9A-Fa-f]+)", p)
        ch = re.search(r"CH\s*=\s*(\d+)", p, re.IGNORECASE)
        fb = re.search(r"FB\s*=\s*(\d+)", p, re.IGNORECASE)
        if not m:
            raise CoreDAQError(f"Unexpected CHMASK? payload: '{p}'")

        mask = int(m.group(1), 16) & 0x0F
        active = int(ch.group(1)) if ch else len(self._active_channel_indices(mask))
        frame_bytes = int(fb.group(1)) if fb else self._frame_bytes_from_mask(mask)
        return mask, active, frame_bytes

    def get_channel_mask(self) -> int:
        mask, _active, _fb = self.get_channel_mask_info()
        return mask

    def set_channel_mask(self, mask: int) -> None:
        mask = int(mask) & 0x0F
        if mask == 0:
            raise ValueError("mask must enable at least one channel (1..15)")
        st, p = self._ask(f"CHMASK 0x{mask:X}")
        if st != "OK":
            raise CoreDAQError(f"CHMASK set failed: {p}")

    def max_acquisition_frames(self, mask: Optional[int] = None) -> int:
        if mask is None:
            try:
                _m, _ch, frame_bytes = self.get_channel_mask_info()
            except Exception:
                # Backward compatibility with firmware without CHMASK support.
                frame_bytes = 8
        else:
            frame_bytes = self._frame_bytes_from_mask(int(mask) & 0x0F)
        return self.SDRAM_BYTES // frame_bytes

    def wait_for_completion(self, poll_s: float = 0.25, timeout_s: Optional[float] = None):
        READY_STATE = 4
        t0 = time.time()

        while True:
            if self.state_enum() == READY_STATE:
                return
            if timeout_s is not None and (time.time() - t0) > timeout_s:
                raise CoreDAQError("Acquisition timeout")
            time.sleep(poll_s)

    # ---------- Bulk transfer (ADC codes) ----------
    def transfer_frames_adc(
        self,
        frames: int,
        idle_timeout_s: float = 2.0,
        overall_timeout_s: Optional[float] = None,
    ) -> List[List[int]]:
        """
        Transfers <frames> frames of raw ADC codes.
        Host -> Dev:  XFER <bytes>
        Dev  -> Host: OK ...
                      <binary payload>

        Returns: [ch1_codes, ch2_codes, ch3_codes, ch4_codes] each length=frames.
        If channel mask disables a channel, that channel returns zeros.
        """
        if frames <= 0:
            raise ValueError("frames must be > 0")

        ser = self._ser
        try:
            mask, active_ch, frame_bytes = self.get_channel_mask_info()
        except Exception:
            # Backward compatibility with firmware that does not support CHMASK?
            mask, active_ch, frame_bytes = 0x0F, 4, 8

        if active_ch <= 0:
            raise CoreDAQError("No active channels in mask")

        bytes_needed = frames * frame_bytes
        time.sleep(0.05)

        # Estimate a reasonable overall timeout if not provided.
        # HS CDC throughput can vary on Windows; keep this generous.
        if overall_timeout_s is None:
            overall_timeout_s = max(5.0, bytes_needed / 1_000_000.0 * 8.0)

        with self._lock:
            ser.reset_input_buffer()
            self._writeln(f"XFER {bytes_needed}")
            ser.flush()

            line = self._readline()
            if not line.startswith("OK"):
                raise CoreDAQError(f"XFER refused: {line}")

            buf = bytearray(bytes_needed)
            mv = memoryview(buf)
            got = 0
            chunk = 262144
            t_deadline = time.time() + float(overall_timeout_s)
            t_last_rx = time.time()
            while got < bytes_needed:
                r = ser.read(min(chunk, bytes_needed - got))
                if not r:
                    now = time.time()
                    if (now - t_last_rx) > float(idle_timeout_s):
                        raise TimeoutError(f"USB read timeout at {got}/{bytes_needed} bytes")
                    if now > t_deadline:
                        raise TimeoutError(f"USB read overall timeout at {got}/{bytes_needed} bytes")
                    time.sleep(0.01)
                    continue
                mv[got:got + len(r)] = r
                got += len(r)
                t_last_rx = time.time()

        samples = array('h')
        samples.frombytes(buf)
        if sys.byteorder != "little":
            samples.byteswap()

        active_idx = self._active_channel_indices(mask)
        if len(active_idx) != active_ch:
            active_ch = len(active_idx)
        if active_ch == 0:
            raise CoreDAQError("Invalid active channel count")

        out = [[0] * frames for _ in range(4)]
        for pos, ch_idx in enumerate(active_idx):
            vals = list(samples[pos::active_ch])
            if len(vals) != frames:
                raise CoreDAQError(f"Parse mismatch on CH{ch_idx+1}: expected {frames}, got {len(vals)}")
            out[ch_idx] = vals

        return out

    def transfer_frames_raw(self, frames: int) -> List[List[int]]:
        return self.transfer_frames_adc(frames)

    # ---------- v3.1: transfer_frames_mV with LOG deadband + LINEAR zero ----------
    def transfer_frames_mV(
        self,
        frames: int,
        use_zero: Optional[bool] = None,          # kept for compatibility; ignored
        log_deadband_mV: Optional[float] = None
    ) -> List[List[float]]:
        ch = self.transfer_frames_adc(frames)
        lsb_mV = self.ADC_LSB_MV

        # LINEAR: always subtract per-channel zero offsets (gain-independent)
        if self._frontend_type == self.FRONTEND_LINEAR:
            out: List[List[float]] = [[], [], [], []]
            for head_idx in range(4):
                z = int(self._linear_zero_adc[head_idx])
                out[head_idx] = [
                    round(float(code - z) * lsb_mV, self.MV_OUTPUT_DECIMALS)
                    for code in ch[head_idx]
                ]
            return out

        # LOG: apply deadband in mV (does not use zeroing at all)
        if self._frontend_type == self.FRONTEND_LOG:
            db = self._log_deadband_mV if log_deadband_mV is None else float(log_deadband_mV)
            out = []
            for lst in ch:
                mv_list = [round(float(x) * lsb_mV, self.MV_OUTPUT_DECIMALS) for x in lst]
                if db > 0.0:
                    mv_list = [0.0 if abs(v) < db else v for v in mv_list]
                out.append(mv_list)
            return out

        raise CoreDAQError(f"Unknown frontend type: {self._frontend_type}")

    def transfer_frames_volts(self, frames: int, use_zero: Optional[bool] = None) -> List[List[float]]:
        mv = self.transfer_frames_mV(frames, use_zero=use_zero)
        return [[x / 1000.0 for x in lst] for lst in mv]

    def transfer_frames_W(
        self,
        frames: int,
        use_zero: Optional[bool] = None,          # kept for compatibility; ignored
        log_deadband_mV: Optional[float] = None
    ) -> List[List[float]]:
        """
        Transfers frames and converts to optical power in watts per channel.

        LINEAR:
          - reads GAINS? once (assumes fixed during acquisition)
          - INGAAS: applies per-head, per-gain slope/intercept (+ wavelength correction)
          - SILICON: uses TIA gain model + Si responsivity curve

        LOG:
          - INGAAS: ADC -> volts -> LUT -> watts (+ wavelength correction)
          - SILICON: ADL5303 model with Si responsivity curve
          - optional deadband in mV (log_deadband_mV or configured default)
        """
        if frames <= 0:
            raise ValueError("frames must be > 0")

        if self._frontend_type == self.FRONTEND_LINEAR:
            mv_ch = self.transfer_frames_mV(frames, use_zero=None)
            gains = self.get_gains()
            power_ch: List[List[float]] = [[], [], [], []]

            for ch_idx in range(4):
                gain = int(gains[ch_idx])

                out_list = power_ch[ch_idx]
                for mv_val in mv_ch[ch_idx]:
                    out_list.append(self._convert_linear_mv_to_power_w(ch_idx, gain, float(mv_val)))

            return power_ch

        if self._frontend_type == self.FRONTEND_LOG:
            v_ch = self.transfer_frames_volts(frames, use_zero=None)
            db = self._log_deadband_mV if log_deadband_mV is None else float(log_deadband_mV)

            power_ch: List[List[float]] = [[], [], [], []]
            for ch_idx in range(4):
                out_list = power_ch[ch_idx]
                for v in v_ch[ch_idx]:
                    mv_equiv = v * 1e3
                    if db > 0.0 and abs(mv_equiv) < db:
                        out_list.append(0.0)
                    else:
                        p_w = self._convert_log_voltage_to_power_w(float(v))
                        out_list.append(round(p_w, self.POWER_OUTPUT_DECIMALS_MAX))
            return power_ch

        raise CoreDAQError(f"Unknown frontend type: {self._frontend_type}")

    # ---------- Misc / settings ----------
    def stream_write_address(self) -> int:
        st, p = self._ask("ADDR?")
        if st != "OK":
            raise CoreDAQError(f"ADDR? failed: {p}")
        return self._parse_int(p)

    def soft_reset(self) -> None:
        st, p = self._ask("SOFTRESET")
        if st != "OK":
            raise CoreDAQError(f"SOFTRESET failed: {p}")

    def enter_dfu(self) -> None:
        # Device resets shortly after ACK; response handling is best-effort.
        with self._lock:
            self._writeln("DFU")

    def i2c_refresh(self) -> None:
        st, payload = self._ask("I2C REFRESH")
        if st != "OK":
            raise CoreDAQError(f"I2C REFRESH failed: {payload}")

    def get_oversampling(self) -> int:
        st, p = self._ask("OS?")
        if st != "OK":
            raise CoreDAQError(p)
        return self._parse_int(p)

    def get_freq_hz(self) -> int:
        st, p = self._ask("FREQ?")
        if st != "OK":
            raise CoreDAQError(p)
        return self._parse_int(p)

    def _max_freq_for_os(self, os_idx: int) -> int:
        if not (0 <= os_idx <= 7):
            raise ValueError("os_idx must be 0..7")
        base = 100_000
        if os_idx <= 1:
            return base
        return base // (2 ** (os_idx - 1))

    def _best_os_for_freq(self, hz: int) -> int:
        if hz <= 0:
            raise ValueError("hz must be > 0")
        if hz > 100_000:
            raise ValueError("hz must be <= 100000")
        best = 0
        for os_idx in range(0, 8):
            if hz <= self._max_freq_for_os(os_idx):
                best = os_idx
            else:
                break
        return best

    def set_freq(self, hz: int):
        if hz <= 0 or hz > 100_000:
            raise CoreDAQError("FREQ must be 1..100000 Hz")

        st, p = self._ask(f"FREQ {hz}")
        if st != "OK":
            raise CoreDAQError(p)

        cur_os = self.get_oversampling()
        if hz > self._max_freq_for_os(cur_os):
            new_os = self._best_os_for_freq(hz)
            st, p = self._ask(f"OS {new_os}")
            if st != "OK":
                raise CoreDAQError(p)
            warnings.warn(
                f"OS {cur_os} is not valid at {hz} Hz. Auto-adjusted OS to {new_os}.",
                RuntimeWarning,
                stacklevel=2,
            )

    def set_oversampling(self, os_idx: int):
        if not (0 <= os_idx <= 7):
            raise CoreDAQError("OS must be 0..7")

        hz = self.get_freq_hz()
        if hz > self._max_freq_for_os(os_idx):
            new_os = self._best_os_for_freq(hz)
            st, p = self._ask(f"OS {new_os}")
            if st != "OK":
                raise CoreDAQError(p)
            warnings.warn(
                f"Requested OS {os_idx} is not valid at {hz} Hz. Kept FREQ={hz} Hz and set OS={new_os}.",
                RuntimeWarning,
                stacklevel=2,
            )
            return

        st, p = self._ask(f"OS {os_idx}")
        if st != "OK":
            raise CoreDAQError(p)

    # ---------- Sensors ----------
    def get_head_temperature_C(self) -> float:
        st, val = self._ask("TEMP?")
        if st != "OK":
            raise CoreDAQError(f"TEMP? failed: {val}")
        try:
            return float(val)
        except ValueError:
            raise CoreDAQError(f"Bad TEMP format: '{val}'")

    def get_head_humidity(self) -> float:
        st, val = self._ask("HUM?")
        if st != "OK":
            raise CoreDAQError(f"HUM? failed: {val}")
        try:
            return float(val)
        except ValueError:
            raise CoreDAQError(f"Bad HUM format: '{val}'")

    def get_die_temperature_C(self) -> float:
        st, val = self._ask("DIE_TEMP?")
        if st != "OK":
            raise CoreDAQError(f"DIE_TEMP? failed: {val}")
        try:
            return float(val)
        except ValueError:
            raise CoreDAQError(f"Bad DIE_TEMP format: '{val}'")

    # ---------- Port discovery ----------
    @staticmethod
    def find(baudrate: int = 115200, timeout: float = 0.15):
        """
        Find all connected coreDAQ devices.

        Detection order:
          1) USB descriptor match (manufacturer / product / serial)
          2) Fallback: probe CDC ports with IDN?

        Returns:
            List of serial port device strings.
        """
        MANUFACTURER_HINTS = ("coreinstrumentation", "core instrumentation")
        PRODUCT_HINTS = ("coredaq",)
        SERIAL_PREFIXES = ("cdaq", "coredaq")

        def _contains_any(s: str, hints) -> bool:
            s = (s or "").lower()
            return any(h in s for h in hints)

        def _descriptor_match(p) -> bool:
            man = getattr(p, "manufacturer", "") or ""
            prod = getattr(p, "product", "") or ""
            desc = getattr(p, "description", "") or ""
            sn = getattr(p, "serial_number", "") or ""

            if _contains_any(man, MANUFACTURER_HINTS): return True
            if _contains_any(prod, PRODUCT_HINTS): return True
            if _contains_any(desc, PRODUCT_HINTS): return True

            sn_l = sn.lower()
            if any(sn_l.startswith(pref) for pref in SERIAL_PREFIXES):
                return True

            return False

        def _probe_idn(port: str) -> bool:
            try:
                with serial.Serial(
                    port,
                    baudrate=baudrate,
                    timeout=timeout,
                    write_timeout=timeout,
                ) as ser:
                    try:
                        ser.reset_input_buffer()
                    except Exception:
                        pass
                    ser.write(b"IDN?\n")
                    ser.flush()
                    line = ser.readline().decode("ascii", "ignore").strip()
                    if not line.startswith("OK"):
                        return False
                    payload = line[2:].strip().lower()
                    return "coredaq" in payload
            except Exception:
                return False

        ports = list(serial.tools.list_ports.comports())
        found = []

        for p in ports:
            if _descriptor_match(p):
                if _probe_idn(p.device):
                    found.append(p.device)

        if not found:
            for p in ports:
                if _probe_idn(p.device):
                    found.append(p.device)

        return found

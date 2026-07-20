"""Sweep engines: orchestrate a tunable laser against a py_coreDAQ capture.

All functions are BLOCKING (run via ``asyncio.to_thread``); the caller owns
session busy flags and stream gating. Each returns ``SweepData`` in the exact
shape the backend's ``last_sweep`` store expects.

Engine choice (automatic, from laser capabilities):
  B  stepped-trigger + lambda-log  (Keysight N777-C precision path)
  A  continuous, start-trigger     (Santec TSL, Keysight CONT without LLOG)
  C  host-stepped                  (EXFO T100S-HP and any set-and-settle laser)

The orchestration sequence is the port of the proven JS `_runSweepCapture`
(git e73f547): configure DAQ -> arm -> start laser -> wait -> verify -> collect
-> restore, with the laser's trigger output wired to the coreDAQ BNC.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import numpy as np

from lasers import LaserError, TunableLaser

# coreDAQ tracks external edges reliably to ~50 kHz (project docs); keep a
# healthy margin when deriving stepped-trigger rates.
MAX_TRIGGER_HZ = 40_000.0
SWEEP_TRANSFER_OVERHEAD_S = 1.5
ARM_SETTLE_S = 0.8


@dataclass
class SweepParams:
    start_nm: float
    stop_nm: float
    speed_nm_s: float
    power_mw: float
    sample_rate_hz: float
    os_idx: int
    channel_mask: int
    gains: Optional[list[int]] = None
    default_wavelength_nm: Optional[float] = None
    step_pm: float = 0.0          # 0 = derive (engine B) / continuous (A)


@dataclass
class SweepData:
    x: np.ndarray                 # wavelength axis, nm, ascending
    y_w: np.ndarray               # (4, N) watts
    sample_rate_hz: float
    engine: str
    meta: dict = field(default_factory=dict)


def _restore(dev: Any, prev_mask: Optional[int], log: Callable[[str], None]) -> None:
    if prev_mask is not None:
        try:
            dev.set_capture_channel_mask(prev_mask)
        except Exception as err:
            log(f"warning: could not restore channel mask: {err}")


def _prepare_daq(dev: Any, p: SweepParams, is_linear: bool,
                 detector: str, log: Callable[[str], None]) -> Optional[int]:
    """Common DAQ setup. Returns the previous channel mask (to restore)."""
    prev_mask: Optional[int] = None
    mask = p.channel_mask & 0x0F or 0x0F
    current = dev.capture_channel_mask()
    if current != mask:
        prev_mask = current
        dev.set_capture_channel_mask(mask)
    dev.set_sample_rate_hz(int(p.sample_rate_hz))
    dev.set_oversampling(int(p.os_idx))
    if detector == "INGAAS":
        # Sweep conversion fixed at 1550 nm (matches UI copy / legacy engine).
        dev.set_wavelength_nm(1550.0)
    if is_linear and p.gains:
        for head, gain in enumerate(p.gains[:4]):
            dev.set_range(head, int(gain))
    return prev_mask


def _collect_watts(dev: Any, frames: Optional[int]) -> tuple[np.ndarray, float]:
    result = dev.collect_capture(frames, unit="w")
    n = None
    traces: dict[int, np.ndarray] = {}
    for ch in range(4):
        try:
            tr = np.asarray(result.trace(ch), dtype=np.float64)
        except Exception:
            tr = None
        if tr is not None and tr.size:
            traces[ch] = tr
            n = tr.size if n is None else min(n, tr.size)
    if not traces or not n:
        raise LaserError("Capture returned no samples")
    ys = np.zeros((4, n), dtype=np.float64)
    for ch, tr in traces.items():
        ys[ch] = tr[:n]
    return ys, float(result.sample_rate_hz or 0.0)


def run_continuous_sweep(dev: Any, laser: TunableLaser, p: SweepParams, *,
                         is_linear: bool, detector: str,
                         log: Callable[[str], None]) -> SweepData:
    """Engine A: laser sweep-start trigger arms a fixed-clock capture; the
    wavelength axis is linear in time."""
    span = abs(p.stop_nm - p.start_nm)
    n_frames = int(round(span / p.speed_nm_s * p.sample_rate_hz))
    if n_frames < 2:
        raise LaserError("Sweep would produce fewer than 2 samples")
    if n_frames > dev.max_capture_frames():
        raise LaserError(
            f"Sweep needs {n_frames} frames; device stores at most "
            f"{dev.max_capture_frames()} for this channel mask — reduce span, "
            "sample rate, or enabled channels")

    prev_mask = _prepare_daq(dev, p, is_linear, detector, log)
    try:
        laser.configure_sweep(p.start_nm, p.stop_nm, p.speed_nm_s, p.power_mw)
        dev.arm_capture(n_frames, trigger=True, trigger_rising=True)
        time.sleep(ARM_SETTLE_S)
        laser.start_sweep()
        log(f"Sweep started ({n_frames} frames @ {p.sample_rate_hz:.0f} Hz)")
        time.sleep(n_frames / p.sample_rate_hz + SWEEP_TRANSFER_OVERHEAD_S)
        laser.stop_sweep()
        if not dev.capture_is_data_ready():
            dev.stop_capture()
            raise LaserError(
                "Acquisition did not complete — check the trigger BNC wiring "
                "(laser trigger out -> coreDAQ trigger in)")
        ys, rate = _collect_watts(dev, n_frames)
        n = ys.shape[1]
        lo, hi = min(p.start_nm, p.stop_nm), max(p.start_nm, p.stop_nm)
        x = np.linspace(lo, hi, n)
        if p.stop_nm < p.start_nm:
            ys = ys[:, ::-1]
        return SweepData(x=x, y_w=ys, sample_rate_hz=rate or p.sample_rate_hz,
                         engine="A:continuous-start-trigger",
                         meta={"frames": n})
    finally:
        _restore(dev, prev_mask, log)


def run_lambda_logged_sweep(dev: Any, laser: TunableLaser, p: SweepParams, *,
                            is_linear: bool, detector: str,
                            log: Callable[[str], None]) -> SweepData:
    """Engine B (precision): per-step triggers clock the coreDAQ's stepped
    capture; the wavelength axis is the laser's own lambda log."""
    span_nm = abs(p.stop_nm - p.start_nm)
    step_pm = p.step_pm
    if step_pm <= 0:
        # Pitch per sample at the requested rate (speed/fs), floored by the
        # coreDAQ edge-rate limit at this sweep speed.
        step_pm = max(p.speed_nm_s * 1000.0 / p.sample_rate_hz,
                      p.speed_nm_s * 1000.0 / MAX_TRIGGER_HZ,
                      0.1)
    trig_hz = p.speed_nm_s * 1000.0 / step_pm
    if trig_hz > MAX_TRIGGER_HZ:
        raise LaserError(
            f"Step pitch {step_pm:.2f} pm at {p.speed_nm_s} nm/s gives "
            f"{trig_hz:.0f} triggers/s; coreDAQ tracks ~{MAX_TRIGGER_HZ:.0f}/s. "
            "Increase the step size or reduce the sweep speed")
    n_steps = int(round(span_nm * 1000.0 / step_pm)) + 1
    if n_steps > 1_048_576:
        raise LaserError("More than 1,048,576 steps — beyond the laser's lambda log")
    if n_steps > dev.max_capture_frames():
        raise LaserError(f"{n_steps} steps exceed device capture memory")

    prev_mask = _prepare_daq(dev, p, is_linear, detector, log)
    try:
        laser.configure_sweep(p.start_nm, p.stop_nm, p.speed_nm_s, p.power_mw,
                              step_pm=step_pm)
        dev.arm_capture(n_steps, trigger=True, trigger_rising=True,
                        stepped=True, step_delay_us=1, step_burst=1)
        time.sleep(ARM_SETTLE_S)
        laser.start_sweep()
        log(f"Lambda-logged sweep: {n_steps} steps of {step_pm:.2f} pm "
            f"({trig_hz:.0f} trig/s)")
        expected_s = span_nm / p.speed_nm_s
        deadline = time.monotonic() + expected_s + 10.0
        while time.monotonic() < deadline:
            time.sleep(0.25)
            try:
                if hasattr(laser, "sweep_done") and laser.sweep_done():
                    break
            except LaserError:
                break
        laser.stop_sweep()
        time.sleep(0.2)
        dev.stop_capture()
        missed = 0
        try:
            missed = int(dev.step_missed_edges())
        except Exception:
            pass
        ys, rate = _collect_watts(dev, None)   # collect what was stored
        wl = laser.read_lambda_log()
        n = ys.shape[1]
        if wl is not None and wl.size:
            m = min(n, wl.size)
            if abs(wl.size - n) > max(2, 0.01 * n):
                log(f"warning: lambda log has {wl.size} points vs {n} samples"
                    f" (missed edges: {missed}) — axis truncated to {m}")
            x = np.asarray(wl[:m], dtype=np.float64)
            ys = ys[:, :m]
        else:
            log("warning: no lambda log returned — falling back to linear axis")
            x = np.linspace(min(p.start_nm, p.stop_nm),
                            max(p.start_nm, p.stop_nm), n)
        order = np.argsort(x)
        x = x[order]
        ys = ys[:, order]
        return SweepData(x=x, y_w=ys, sample_rate_hz=rate or p.sample_rate_hz,
                         engine="B:stepped-trigger+lambda-log",
                         meta={"step_pm": step_pm, "missed_edges": missed,
                               "lambda_logged": bool(wl is not None and wl.size)})
    finally:
        _restore(dev, prev_mask, log)


def run_host_stepped_sweep(dev: Any, laser: TunableLaser, p: SweepParams, *,
                           is_linear: bool, detector: str,
                           log: Callable[[str], None],
                           settle_s: float = 0.35,
                           progress: Optional[Callable[[int, int], None]] = None,
                           should_abort: Optional[Callable[[], bool]] = None
                           ) -> SweepData:
    """Engine C: the host steps the laser and reads the DAQ at each point.
    Slow but wavelength-exact; for lasers with no usable trigger output."""
    step_pm = p.step_pm if p.step_pm > 0 else 10.0     # sane default: 10 pm
    lo, hi = min(p.start_nm, p.stop_nm), max(p.start_nm, p.stop_nm)
    xs = np.arange(lo, hi + step_pm * 5e-4, step_pm / 1000.0)
    if xs.size < 2:
        raise LaserError("Sweep range smaller than one step")
    if xs.size > 20_000:
        raise LaserError(
            f"{xs.size} host-stepped points would take too long — increase the "
            "step size (each point costs ~0.5 s on this laser)")

    prev_mask = _prepare_daq(dev, p, is_linear, detector, log)
    try:
        laser.set_power_mw(p.power_mw)
        if hasattr(laser, "enable_output"):
            try:
                laser.enable_output()
            except LaserError:
                pass
        ys = np.zeros((4, xs.size), dtype=np.float64)
        log(f"Host-stepped sweep: {xs.size} points, {step_pm:.1f} pm pitch")
        for k, wl in enumerate(xs):
            if should_abort and should_abort():
                raise LaserError("Sweep aborted")
            laser.set_wavelength_nm(float(wl))
            time.sleep(settle_s)
            vals = dev.read_all(unit="w", autoRange=False)
            for ch in range(4):
                ys[ch, k] = float(vals[ch] or 0.0)
            if progress and (k % 10 == 0 or k == xs.size - 1):
                progress(k + 1, xs.size)
        return SweepData(x=xs, y_w=ys, sample_rate_hz=1.0 / max(settle_s, 1e-3),
                         engine="C:host-stepped",
                         meta={"step_pm": step_pm, "settle_s": settle_s})
    finally:
        _restore(dev, prev_mask, log)


def pick_engine(laser: TunableLaser) -> str:
    caps = laser.capabilities
    if not caps.get("sweep"):
        raise LaserError(
            f"{laser.model} has no sweep capability (set-and-hold source)")
    if caps.get("lambda_log") and caps.get("stepped_sweep"):
        return "B"
    if caps.get("continuous_sweep") and caps.get("trigger_out"):
        return "A"
    return "C"


def run_sweep(dev: Any, laser: TunableLaser, p: SweepParams, *,
              is_linear: bool, detector: str,
              log: Callable[[str], None],
              progress: Optional[Callable[[int, int], None]] = None,
              should_abort: Optional[Callable[[], bool]] = None) -> SweepData:
    engine = pick_engine(laser)
    log(f"Engine {engine} selected for {laser.vendor} {laser.model}")
    if engine == "B":
        try:
            return run_lambda_logged_sweep(dev, laser, p, is_linear=is_linear,
                                           detector=detector, log=log)
        except Exception as err:
            # Old coreDAQ firmware (< v4.3) has no stepped capture — fall back.
            if "unsupported" in str(err).lower() and laser.capabilities.get("continuous_sweep"):
                log(f"Stepped capture unavailable ({err}); falling back to Engine A")
                return run_continuous_sweep(dev, laser, p, is_linear=is_linear,
                                            detector=detector, log=log)
            raise
    if engine == "A":
        return run_continuous_sweep(dev, laser, p, is_linear=is_linear,
                                    detector=detector, log=log)
    return run_host_stepped_sweep(dev, laser, p, is_linear=is_linear,
                                  detector=detector, log=log,
                                  progress=progress, should_abort=should_abort)

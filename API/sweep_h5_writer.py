#!/usr/bin/env python3
"""
Write a compressed coreConsole sweep file in true HDF5 format.

Input JSON schema is produced by GUI/backend/coredaq_service.js (_saveLastSweepH5).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

try:
    import h5py  # type: ignore
except Exception as exc:
    sys.stderr.write("MISSING_DEPENDENCY:h5py\n")
    sys.stderr.write(f"{exc}\n")
    raise SystemExit(5)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Write compressed H5 sweep file")
    p.add_argument("--in-json", required=True, help="Path to JSON input payload")
    p.add_argument("--out", required=True, help="Output .h5 file path")
    return p.parse_args()


def _as_float_or_none(v: Any) -> Optional[float]:
    try:
        x = float(v)
    except Exception:
        return None
    if not math.isfinite(x):
        return None
    return x


def _as_int_list(v: Any) -> List[int]:
    if not isinstance(v, list):
        return []
    out: List[int] = []
    for item in v:
        try:
            out.append(int(item))
        except Exception:
            continue
    return out


def _sanitize_name(name: str, fallback: str) -> str:
    txt = re.sub(r"[^A-Za-z0-9_]+", "_", str(name or "").strip())
    txt = txt.strip("_")
    return txt or fallback


def _dataset_kwargs(arr: np.ndarray) -> Dict[str, Any]:
    # Apply compression for non-trivial datasets.
    if arr.size >= 64:
        return {
            "compression": "gzip",
            "compression_opts": 6,
            "shuffle": True,
            "chunks": True,
        }
    return {}


def _write_float_array(group: h5py.Group, name: str, values: Any) -> h5py.Dataset:
    arr = np.asarray(values, dtype=np.float64)
    return group.create_dataset(name, data=arr, **_dataset_kwargs(arr))


def _extract_channels(payload: Dict[str, Any]) -> List[Tuple[int, str, np.ndarray]]:
    raw = payload.get("channels_w")
    out: List[Tuple[int, str, np.ndarray]] = []

    if isinstance(raw, list) and raw and isinstance(raw[0], dict):
        for item in raw:
            try:
                idx = int(item.get("index"))
            except Exception:
                continue
            if idx < 0:
                continue
            name = str(item.get("name") or f"CH{idx + 1}")
            arr = np.asarray(item.get("data_w") or [], dtype=np.float64)
            out.append((idx, name, arr))
        out.sort(key=lambda x: x[0])
        return out

    if isinstance(raw, list):
        for idx, item in enumerate(raw):
            arr = np.asarray(item or [], dtype=np.float64)
            out.append((idx, f"CH{idx + 1}", arr))
        return out

    return []


def _extract_virtual(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    raw = payload.get("virtual_series")
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        out.append(item)
    return out


def _make_wavelength_axis(start_nm: Optional[float], stop_nm: Optional[float], n: int) -> np.ndarray:
    if n <= 0:
        return np.asarray([], dtype=np.float64)
    if start_nm is not None and stop_nm is not None:
        return np.linspace(start_nm, stop_nm, n, dtype=np.float64)
    return np.arange(n, dtype=np.float64)


def write_h5(payload: Dict[str, Any], out_path: Path) -> None:
    channels = _extract_channels(payload)
    virtual_series = _extract_virtual(payload)

    sample_count = int(payload.get("samples_total") or 0)
    if sample_count <= 0:
        sample_count = max((arr.size for _, _, arr in channels), default=0)

    start_nm = _as_float_or_none(payload.get("start_nm"))
    stop_nm = _as_float_or_none(payload.get("stop_nm"))
    wavelength_nm = _make_wavelength_axis(start_nm, stop_nm, sample_count)

    out_path.parent.mkdir(parents=True, exist_ok=True)

    with h5py.File(str(out_path), "w") as h5f:
        h5f.attrs["format"] = "coredaq_sweep_h5_v1"
        h5f.attrs["writer"] = "coreConsole sweep_h5_writer.py"

        meta = h5f.create_group("metadata")
        meta.attrs["saved_at_utc"] = str(payload.get("saved_at_utc") or datetime.now(timezone.utc).isoformat())
        meta.attrs["captured_at_utc"] = str(payload.get("captured_at_utc") or "")
        meta.attrs["captured_at_unix"] = float(payload.get("captured_at_unix") or 0.0)
        meta.attrs["coredaq_idn"] = str(payload.get("coredaq_idn") or "")
        meta.attrs["coredaq_device_id"] = str(payload.get("coredaq_device_id") or "")
        meta.attrs["coredaq_port"] = str(payload.get("coredaq_port") or "")
        meta.attrs["laser_resource"] = str(payload.get("laser_resource") or "")
        meta.attrs["laser_backend"] = str(payload.get("laser_backend") or "")
        meta.attrs["laser_idn"] = str(payload.get("laser_idn") or "")
        meta.attrs["laser_model"] = str(payload.get("laser_model") or "")

        room_temp = _as_float_or_none(payload.get("room_temp_c"))
        room_hum = _as_float_or_none(payload.get("room_humidity_pct"))
        meta.attrs["room_temp_c"] = room_temp if room_temp is not None else np.nan
        meta.attrs["room_humidity_pct"] = room_hum if room_hum is not None else np.nan

        for key in (
            "start_nm",
            "stop_nm",
            "speed_nm_s",
            "power_mw",
            "return_wavelength_nm",
            "sample_rate_hz",
            "os_idx",
            "os_idx_requested",
            "os_idx_max_for_rate",
            "sweep_duration_s",
            "samples_total",
            "channel_mask",
            "save_channel_mask",
        ):
            val = _as_float_or_none(payload.get(key))
            if val is not None:
                meta.attrs[key] = val

        gains = np.asarray(_as_int_list(payload.get("gains")), dtype=np.int32)
        if gains.size > 0:
            meta.create_dataset("gains", data=gains)

        active_channels = np.asarray(_as_int_list(payload.get("active_channels")), dtype=np.int32)
        save_active_channels = np.asarray(_as_int_list(payload.get("save_active_channels")), dtype=np.int32)
        meta.create_dataset("active_channels", data=active_channels)
        meta.create_dataset("save_active_channels", data=save_active_channels)

        sweep = h5f.create_group("sweep")
        _write_float_array(sweep, "wavelength_nm", wavelength_nm)

        ch_group = sweep.create_group("channels")
        for idx, name, arr in channels:
            dset_name = f"ch{idx + 1}_w"
            ds = _write_float_array(ch_group, dset_name, arr)
            ds.attrs["index"] = int(idx)
            ds.attrs["name"] = str(name)
            ds.attrs["unit"] = "W"

        if virtual_series:
            v_group = sweep.create_group("virtual_channels")
            for i, item in enumerate(virtual_series):
                v_name = _sanitize_name(str(item.get("name") or ""), f"virtual_{i+1}")
                data = np.asarray(item.get("data") or [], dtype=np.float64)
                ds = _write_float_array(v_group, v_name, data)
                ds.attrs["name"] = str(item.get("name") or v_name)
                ds.attrs["math"] = str(item.get("math") or "")
                ds.attrs["unit"] = str(item.get("unit") or "")
                src = item.get("src") if isinstance(item.get("src"), dict) else {}
                ds.attrs["src_a"] = int(src.get("a", 0)) if src else 0
                ds.attrs["src_b"] = int(src.get("b", 1)) if src else 1


def main() -> int:
    args = parse_args()
    in_json = Path(args.in_json).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve()

    if not in_json.exists():
        raise FileNotFoundError(f"Input JSON not found: {in_json}")

    with in_json.open("r", encoding="utf-8") as f:
        payload = json.load(f)

    if not isinstance(payload, dict):
        raise ValueError("Input JSON payload must be an object")

    write_h5(payload, out_path)
    print(str(out_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

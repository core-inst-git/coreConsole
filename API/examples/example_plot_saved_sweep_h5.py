# H5 example: load a saved sweep and plot wavelength vs power
# Requirements: pip install h5py numpy matplotlib

from pathlib import Path

import h5py
import matplotlib.pyplot as plt
import numpy as np

# 1) file_path
file_path = Path(r"C:\path\to\coredaq_sweep_2026-03-14_120000.h5")
channel_index = 0  # 0..3 for CH1..CH4

if not file_path.exists():
    raise FileNotFoundError(f"File not found: {file_path}")

channel_name = f"ch{channel_index + 1}_w"

# 2) load data
with h5py.File(file_path, "r") as h5:
    sweep = h5["/sweep"]
    channels = sweep["channels"]
    if channel_name not in channels:
        available = ", ".join(sorted(channels.keys()))
        raise ValueError(f"{channel_name} not found. Available channels: {available}")

    y_w = np.asarray(channels[channel_name], dtype=np.float64)

    if "wavelength_nm" in sweep:
        x_nm = np.asarray(sweep["wavelength_nm"], dtype=np.float64)
    else:
        meta = h5["/metadata"].attrs
        start_nm = float(meta.get("start_nm", 0.0))
        stop_nm = float(meta.get("stop_nm", float(max(0, y_w.size - 1))))
        # 3) create wavelength axis
        x_nm = np.linspace(start_nm, stop_nm, y_w.size, dtype=np.float64)

if y_w.size == 0:
    raise ValueError(f"{channel_name} has no data")

if x_nm.size != y_w.size:
    # 3) create wavelength axis (fallback if axis length mismatches)
    start_nm = float(x_nm[0]) if x_nm.size > 0 else 0.0
    stop_nm = float(x_nm[-1]) if x_nm.size > 0 else float(max(0, y_w.size - 1))
    x_nm = np.linspace(start_nm, stop_nm, y_w.size, dtype=np.float64)

# 4) plot
plt.figure(figsize=(9, 5))
plt.plot(x_nm, y_w, lw=1.2)
plt.title(f"Saved Sweep H5 - CH{channel_index + 1}")
plt.xlabel("Wavelength (nm)")
plt.ylabel("Power (W)")
plt.grid(True, alpha=0.3)
plt.tight_layout()
plt.show()

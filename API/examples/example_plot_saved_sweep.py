# Example: load a saved sweep file and plot wavelength vs transmission
# Requirements: pip install numpy matplotlib

FILE_PATH = r"C:\path\to\coredaq_sweep_2026-02-22T12-00-00.h5"
CHANNEL_INDEX = 0  # 0..3 for CH1..CH4

import json
import os
import numpy as np
import matplotlib.pyplot as plt

path = FILE_PATH
if path.lower().endswith(".h5") and (not os.path.exists(path)) and os.path.exists(path + ".json"):
    path = path + ".json"

if not os.path.exists(path):
    raise FileNotFoundError(f"File not found: {path}")

with open(path, "r", encoding="utf-8") as f:
    doc = json.load(f)

payload = doc.get("payload", doc)
start_nm = float(payload["start_nm"])
stop_nm = float(payload["stop_nm"])
channels_w = payload["channels_w"]

# Supports both saved layouts:
# 1) [[...], [...], ...]
# 2) [{index,name,data_w}, ...]
if isinstance(channels_w[0], dict):
    y_raw = None
    for ch in channels_w:
        if int(ch.get("index", -1)) == CHANNEL_INDEX:
            y_raw = ch.get("data_w", [])
            break
    if y_raw is None:
        raise ValueError(f"Channel CH{CHANNEL_INDEX + 1} not found in file.")
else:
    y_raw = channels_w[CHANNEL_INDEX]

y_w = np.asarray(y_raw, dtype=np.float64)
if y_w.size == 0:
    raise ValueError(f"Channel CH{CHANNEL_INDEX + 1} has no data.")

x_nm = np.linspace(start_nm, stop_nm, y_w.size, dtype=np.float64)

plt.figure(figsize=(9, 5))
plt.plot(x_nm, y_w, lw=1.2)
plt.title(f"Saved Sweep - CH{CHANNEL_INDEX + 1}")
plt.xlabel("Wavelength (nm)")
plt.ylabel("Transmission (W)")
plt.grid(True, alpha=0.3)
plt.tight_layout()
plt.show()
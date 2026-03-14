# Minimal example: load saved sweep JSON and plot CH1 vs wavelength
# Requirements: pip install matplotlib

from pathlib import Path
import json
import matplotlib.pyplot as plt

# 1) file_path
file_path = Path(r"C:\path\to\coredaq_sweep_2026-03-14_120000.h5.json")
if file_path.suffix.lower() == ".h5" and not file_path.exists():
    alt = Path(str(file_path) + ".json")
    if alt.exists():
        file_path = alt

# 2) load data
with file_path.open("r", encoding="utf-8") as f:
    doc = json.load(f)

payload = doc["payload"]
start_nm = float(payload["start_nm"])
stop_nm = float(payload["stop_nm"])
ch1 = payload["channels_w"][0]["data_w"]

# 3) create wavelength axis
n = len(ch1)
if n < 2:
    raise ValueError("CH1 has no sweep data.")
wavelength_nm = [start_nm + i * (stop_nm - start_nm) / (n - 1) for i in range(n)]

# 4) plot
plt.plot(wavelength_nm, ch1, linewidth=1.2)
plt.xlabel("Wavelength (nm)")
plt.ylabel("Power (W)")
plt.title("coreDAQ Sweep - CH1")
plt.grid(alpha=0.3)
plt.tight_layout()
plt.show()

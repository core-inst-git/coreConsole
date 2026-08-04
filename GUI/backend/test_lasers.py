"""Unit tests for the laser vendor layer (no hardware): command sequences per
driver, LLOG binary parsing, detection, engine selection.

Run:  python3 test_lasers.py
"""
from __future__ import annotations

import struct
import sys

import numpy as np

from lasers import (
    ExfoT100S,
    ExfoT200S,
    KeysightN777,
    LaserError,
    MockTransport,
    SantecTSL,
    detect_laser,
    open_transport,
)
from sweep_engines import pick_engine

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  ok  {name}")
    else:
        FAILURES.append(name)
        print(f"FAIL  {name}  {detail}")


# --- Santec: configureForSweep must reproduce laser-js byte-for-byte --------
t = MockTransport()
tsl = SantecTSL(t, "SANTEC,TSL-570", "TSL570")
tsl.configure_sweep(1480.0, 1620.0, 50.0, 1.0)
expected_570 = [
    "*RST", ":POW:ATT:AUT 1", ":POW:UNIT 1", ":TRIG:INP:EXT0",
    ":WAV:SWE:CYCL 1", ":TRIG:OUTP2", ":POW 20.0", ":POW 1",
    ":WAV:UNIT 0", ":WAV:SWE:SPE 50", ":WAV 1480",
    ":WAV:SWE:STAR 1480", ":WAV:SWE:STOP 1620",
    ":WAV:SWE:MOD 1", ":WAV:SWE:DWEL 0",
]
check("TSL570 sweep sequence == laser-js", t.sent == expected_570,
      f"got {t.sent}")

t = MockTransport()
tsl770 = SantecTSL(t, "SANTEC TSL-770", "TSL770")
tsl770.configure_sweep(1480.0, 1620.0, 50.0, 1.0)
check("TSL770 uses metres", ":WAV:SWE:SPE 5e-8" in t.sent and ":WAV 1.48e-6" in t.sent,
      f"got {t.sent}")
t = MockTransport()
tsl770.t = t
tsl770.start_sweep(); tsl770.stop_sweep()
check("TSL start/stop", t.sent == ["WAV:SWE 1", "WAV:SWE 0"], f"got {t.sent}")

# --- Keysight: continuous+LLOG configuration -------------------------------
t = MockTransport()
k = KeysightN777(t, "Keysight Technologies,N7778C,DE123,1.2", "N7778C")
k.configure_sweep(1520.0, 1560.0, 10.0, 1.0, step_pm=1.0)
sent = ";".join(t.sent)
for frag in (":SOUR0:WAV:SWE:STAR 1520NM", ":SOUR0:WAV:SWE:STOP 1560NM",
             ":SOUR0:WAV:SWE:MODE CONT", ":SOUR0:WAV:SWE:SPE 10nm/s",
             ":SOUR0:WAV:SWE:STEP 0.001NM", ":TRIG0:OUTP STF",
             ":SOUR0:WAV:SWE:LLOG 1", ":SOUR0:AM:STAT OFF"):
    check(f"N7778C sends {frag}", frag in t.sent, f"sent={t.sent}")
def raises(fn) -> bool:
    try:
        fn()
        return False
    except (LaserError, Exception):
        return True

check("N7778C rejects start>=stop",
      raises(lambda: KeysightN777(MockTransport(), "", "N7778C")
             .configure_sweep(1560.0, 1520.0, 10.0, 1.0, step_pm=1.0)))
check("N7711A refuses sweep",
      raises(lambda: KeysightN777(MockTransport(), "", "N7711A")
             .configure_sweep(1520.0, 1560.0, 10.0, 1.0)))

# LLOG binary block: #<d><len><doubles LE metres>
wl_m = np.array([1520e-9, 1520.001e-9, 1520.002e-9])
payload = wl_m.astype("<f8").tobytes()
blk = b"#" + str(len(str(len(payload)))).encode() + str(len(payload)).encode() + payload + b"\n"
t = MockTransport(binary=blk)
k2 = KeysightN777(t, "", "N7778C")
k2._llog_armed = True
wl_nm = k2.read_lambda_log()
check("LLOG block parses to nm",
      wl_nm is not None and wl_nm.size == 3 and abs(wl_nm[0] - 1520.0) < 1e-6
      and abs(wl_nm[1] - 1520.001) < 1e-6, f"got {wl_nm}")

# --- EXFO T100S dialect ----------------------------------------------------
t = MockTransport(responses={r"L\?": "L=1552.123"})
e = ExfoT100S(t, "EXFO T100S-HP")
e.set_wavelength_nm(1550.0)
e.set_power_mw(2.5)
check("T100S dialect commands",
      t.sent[0] == "L=1550.000" and "MW" in t.sent and "P=2.50" in t.sent,
      f"sent={t.sent}")
check("T100S wavelength query parse", abs(e.get_wavelength_nm() - 1552.123) < 1e-9)

check("T200S refuses (unverified)",
      raises(lambda: ExfoT200S(MockTransport(), "", "T200S").set_wavelength_nm(1550)))

# --- detection -------------------------------------------------------------
cases = {
    "SANTEC,TSL-570,12345,1.0": ("Santec", "TSL570"),
    "SANTEC INST TSL550": ("Santec", "TSL550"),
    "Keysight Technologies,N7776C,MY123,V2.1": ("Keysight", "N7776C"),
    "KEYSIGHT,N7711A,X,1": ("Keysight", "N7711A"),
    "EXFO,T100S-HP,001,6.07": ("EXFO", "T100S-HP"),
    "EXFO,T200S,001,1.0": ("EXFO", "T200S"),
    "PHOTONETICS,TUNICS-PLUS": ("EXFO", "T100S-HP"),
}
for idn, (vendor, model) in cases.items():
    found = detect_laser(idn)
    check(f"detect {idn!r} -> {model}",
          found is not None and found[0] == vendor and found[1] == model,
          f"got {found}")
check("detect unknown -> None", detect_laser("ACME LASER 9000") is None)

# --- engine selection ------------------------------------------------------
check("engine B for N7778C",
      pick_engine(KeysightN777(MockTransport(), "", "N7778C")) == "B")
check("engine A for TSL570",
      pick_engine(SantecTSL(MockTransport(), "", "TSL570")) == "A")
check("engine C for T100S",
      pick_engine(ExfoT100S(MockTransport(), "")) == "C")
check("no engine for N7711A",
      raises(lambda: pick_engine(KeysightN777(MockTransport(), "", "N7711A"))))

# --- resource URIs ---------------------------------------------------------
check("bad resource rejected", raises(lambda: open_transport("bogus")))
check("sim resource rejected here", raises(lambda: open_transport("SIM::LASER0::INSTR")))

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S): {FAILURES}")
    sys.exit(1)
print("all laser-layer tests passed")

#!/usr/bin/env python3
"""
Quick VISA backend diagnostics for coreConsole.

Run this with the same Python interpreter used by GUI backend:
  python backend/visa_debug.py
"""

from __future__ import annotations

import os
import platform
import sys
from typing import List, Optional, Set


def _candidate_backends() -> List[Optional[str]]:
    env_hint = str(os.getenv("COREDAQ_VISA_BACKEND", "")).strip() or None
    ordered: List[Optional[str]] = [env_hint, None, "@ivi", "@py"]
    out: List[Optional[str]] = []
    seen: Set[str] = set()
    for spec in ordered:
        key = spec or "<default>"
        if key in seen:
            continue
        seen.add(key)
        out.append(spec)
    return out


def main() -> int:
    print("=== coreConsole VISA Debug ===")
    print(f"Python executable : {sys.executable}")
    print(f"Python version    : {sys.version.split()[0]}")
    print(f"Platform          : {platform.platform()}")
    print(f"COREDAQ_VISA_BACKEND: {os.getenv('COREDAQ_VISA_BACKEND', '') or '<unset>'}")
    print(f"PYVISA_LIBRARY      : {os.getenv('PYVISA_LIBRARY', '') or '<unset>'}")

    try:
        import pyvisa  # type: ignore
    except Exception as e:
        print(f"\npyvisa import failed: {e}")
        return 2

    print(f"pyvisa version    : {getattr(pyvisa, '__version__', 'unknown')}")
    try:
        backends = pyvisa.highlevel.list_backends()
        print(f"Known backends    : {backends}")
    except Exception as e:
        print(f"Known backends    : <error: {e}>")

    found_any = False
    for backend in _candidate_backends():
        tag = backend or "default"
        print(f"\n--- Backend {tag} ---")
        rm = None
        try:
            rm = pyvisa.ResourceManager(backend) if backend else pyvisa.ResourceManager()
            print(f"visalib: {rm.visalib}")
            resources = list(rm.list_resources())
            print(f"resources ({len(resources)}): {resources}")
            if resources:
                found_any = True
            for name in resources:
                try:
                    inst = rm.open_resource(name)
                    try:
                        inst.timeout = 1200
                        inst.read_termination = "\n"
                        inst.write_termination = "\n"
                        idn = str(inst.query("*IDN?")).strip()
                        print(f"  {name} -> {idn}")
                    finally:
                        inst.close()
                except Exception as e:
                    print(f"  {name} -> *IDN? failed: {e}")
        except Exception as e:
            print(f"open/list failed: {e}")
        finally:
            if rm is not None:
                try:
                    rm.close()
                except Exception:
                    pass

    if not found_any:
        print("\nNo VISA resources found from this interpreter.")
        print("Next checks:")
        print("1) Run this script with COREDAQ_PYTHON to match GUI backend.")
        print("2) Verify NI-VISA bitness matches Python (64-bit with 64-bit).")
        print("3) Try setting COREDAQ_VISA_BACKEND=@ivi before npm run dev.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

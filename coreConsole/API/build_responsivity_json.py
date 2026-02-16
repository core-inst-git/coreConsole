#!/usr/bin/env python3
"""Build a unified responsivity JSON from vendor Excel tables."""

from __future__ import annotations

import json
from pathlib import Path
from typing import List, Tuple

import pandas as pd

ROOT = Path(__file__).resolve().parent
INGAAS_XLSX = ROOT / "Typical InGaAs PD Responsivity.xlsx"
SILICON_XLS = ROOT / "Typical Si PD Responsivity (1).xls"
OUT_JSON = ROOT / "responsivity_curves.json"


def _extract_numeric_pairs(path: Path) -> List[Tuple[float, float]]:
    # Files contain header rows and sometimes empty leading columns.
    # We only keep rows where both wavelength and responsivity are numeric.
    df = pd.read_excel(path, header=None)

    numeric_cols = []
    for c in df.columns:
        s = pd.to_numeric(df[c], errors="coerce")
        non_nan = int(s.notna().sum())
        if non_nan >= 8:
            numeric_cols.append(c)

    if len(numeric_cols) < 2:
        raise RuntimeError(f"Could not find 2 numeric columns in {path}")

    wl_col = numeric_cols[0]
    r_col = numeric_cols[1]

    wl = pd.to_numeric(df[wl_col], errors="coerce")
    rs = pd.to_numeric(df[r_col], errors="coerce")

    pairs: List[Tuple[float, float]] = []
    for w, r in zip(wl, rs):
        if pd.isna(w) or pd.isna(r):
            continue
        wn = float(w)
        rn = float(r)
        if wn <= 0.0 or rn <= 0.0:
            continue
        # Input units are mA/mW which is numerically equal to A/W.
        pairs.append((wn, rn))

    if not pairs:
        raise RuntimeError(f"No numeric responsivity points found in {path}")

    # Sort and deduplicate by wavelength (keep last seen).
    by_wl = {}
    for w, r in pairs:
        by_wl[round(w, 6)] = round(r, 9)

    out = sorted((float(w), float(r)) for w, r in by_wl.items())
    return out


def main() -> None:
    ingaas = _extract_numeric_pairs(INGAAS_XLSX)
    silicon = _extract_numeric_pairs(SILICON_XLS)

    doc = {
        "schema": "coredaq.responsivity.v1",
        "units": {
            "wavelength": "nm",
            "responsivity": "A/W",
            "source_table_unit_note": "Input files use mA/mW, numerically equal to A/W",
        },
        "detectors": {
            "INGAAS": {
                "source_file": INGAAS_XLSX.name,
                "points": [[w, r] for w, r in ingaas],
            },
            "SILICON": {
                "source_file": SILICON_XLS.name,
                "points": [[w, r] for w, r in silicon],
            },
        },
    }

    OUT_JSON.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_JSON}")
    print(f"INGAAS points: {len(ingaas)} [{ingaas[0][0]}..{ingaas[-1][0]} nm]")
    print(f"SILICON points: {len(silicon)} [{silicon[0][0]}..{silicon[-1][0]} nm]")


if __name__ == "__main__":
    main()

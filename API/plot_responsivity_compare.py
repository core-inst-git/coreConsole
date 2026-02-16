#!/usr/bin/env python3
"""
Plot responsivity comparison for InGaAs and Silicon detectors.

For each detector, this script overlays:
1) Original points from the vendor Excel file
2) JSON curve points loaded from responsivity_curves.json
3) A dense linear interpolation generated from the JSON curve
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import List, Tuple

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parent
DEFAULT_JSON = ROOT / "responsivity_curves.json"
DEFAULT_INGAAS_XLSX = ROOT / "Typical InGaAs PD Responsivity.xlsx"
DEFAULT_SILICON_XLS = ROOT / "Typical Si PD Responsivity (1).xls"


def extract_numeric_pairs(path: Path) -> List[Tuple[float, float]]:
    """
    Read two numeric columns (wavelength, responsivity) from the Excel source.
    """
    df = pd.read_excel(path, header=None)

    numeric_cols = []
    for c in df.columns:
        s = pd.to_numeric(df[c], errors="coerce")
        if int(s.notna().sum()) >= 8:
            numeric_cols.append(c)

    if len(numeric_cols) < 2:
        raise RuntimeError(f"Could not find two numeric columns in {path}")

    wl = pd.to_numeric(df[numeric_cols[0]], errors="coerce")
    rs = pd.to_numeric(df[numeric_cols[1]], errors="coerce")

    pairs: List[Tuple[float, float]] = []
    for w, r in zip(wl, rs):
        if pd.isna(w) or pd.isna(r):
            continue
        wn = float(w)
        rn = float(r)
        if wn <= 0.0 or rn <= 0.0:
            continue
        pairs.append((wn, rn))

    if not pairs:
        raise RuntimeError(f"No valid responsivity points found in {path}")

    pairs.sort(key=lambda x: x[0])
    return pairs


def load_json_curve(path: Path, detector_key: str) -> Tuple[np.ndarray, np.ndarray]:
    doc = json.loads(path.read_text(encoding="utf-8"))
    points = doc["detectors"][detector_key]["points"]
    if not points:
        raise RuntimeError(f"No JSON points for detector {detector_key}")

    wl = np.array([float(p[0]) for p in points], dtype=float)
    rs = np.array([float(p[1]) for p in points], dtype=float)
    order = np.argsort(wl)
    wl = wl[order]
    rs = rs[order]
    return wl, rs


def plot_detector(
    detector_key: str,
    excel_pairs: List[Tuple[float, float]],
    json_wl: np.ndarray,
    json_rs: np.ndarray,
    out_path: Path,
    dpi: int = 180,
) -> None:
    x_excel = np.array([p[0] for p in excel_pairs], dtype=float)
    y_excel = np.array([p[1] for p in excel_pairs], dtype=float)

    x_dense = np.linspace(float(json_wl[0]), float(json_wl[-1]), 1200)
    y_dense = np.interp(x_dense, json_wl, json_rs)
    y_excel_interp = np.interp(x_excel, json_wl, json_rs)

    mae = float(np.mean(np.abs(y_excel - y_excel_interp)))
    max_abs = float(np.max(np.abs(y_excel - y_excel_interp)))

    plt.figure(figsize=(9.2, 5.4))
    plt.plot(x_dense, y_dense, linewidth=2.2, label="Interpolated from JSON")
    plt.plot(json_wl, json_rs, "o-", markersize=3.2, linewidth=1.0, alpha=0.8, label="JSON points")
    plt.scatter(x_excel, y_excel, s=20, alpha=0.9, label="Original Excel points")

    plt.title(
        f"{detector_key} Responsivity: Excel vs JSON Interpolation\n"
        f"MAE={mae:.6g} A/W, Max |err|={max_abs:.6g} A/W"
    )
    plt.xlabel("Wavelength (nm)")
    plt.ylabel("Responsivity (A/W)")
    plt.grid(True, alpha=0.28)
    plt.legend(loc="best")
    plt.tight_layout()
    plt.savefig(out_path, dpi=dpi)
    plt.close()

    print(f"[{detector_key}] saved {out_path}")
    print(f"  range: {json_wl[0]:.1f} .. {json_wl[-1]:.1f} nm")
    print(f"  points: excel={len(x_excel)} json={len(json_wl)}")
    print(f"  MAE={mae:.6g} A/W, Max |err|={max_abs:.6g} A/W")


def main() -> None:
    ap = argparse.ArgumentParser(description="Plot responsivity curves vs interpolation.")
    ap.add_argument("--json", type=Path, default=DEFAULT_JSON, help="Path to responsivity_curves.json")
    ap.add_argument("--ingaas-xlsx", type=Path, default=DEFAULT_INGAAS_XLSX, help="Path to InGaAs Excel file")
    ap.add_argument("--silicon-xls", type=Path, default=DEFAULT_SILICON_XLS, help="Path to Silicon Excel file")
    ap.add_argument("--out-dir", type=Path, default=(ROOT / "plots"), help="Output directory for PNG files")
    ap.add_argument("--show", action="store_true", help="Display plots after saving")
    ap.add_argument("--dpi", type=int, default=180, help="Output PNG DPI")
    args = ap.parse_args()

    args.out_dir.mkdir(parents=True, exist_ok=True)

    ingaas_excel = extract_numeric_pairs(args.ingaas_xlsx)
    silicon_excel = extract_numeric_pairs(args.silicon_xls)

    ingaas_wl, ingaas_rs = load_json_curve(args.json, "INGAAS")
    silicon_wl, silicon_rs = load_json_curve(args.json, "SILICON")

    plot_detector(
        "INGAAS",
        ingaas_excel,
        ingaas_wl,
        ingaas_rs,
        args.out_dir / "responsivity_ingaas_compare.png",
        dpi=args.dpi,
    )
    plot_detector(
        "SILICON",
        silicon_excel,
        silicon_wl,
        silicon_rs,
        args.out_dir / "responsivity_silicon_compare.png",
        dpi=args.dpi,
    )

    if args.show:
        # Optional quick-view mode: reload and display generated PNGs.
        for p in (
            args.out_dir / "responsivity_ingaas_compare.png",
            args.out_dir / "responsivity_silicon_compare.png",
        ):
            img = plt.imread(p)
            plt.figure(figsize=(10, 6))
            plt.imshow(img)
            plt.axis("off")
            plt.title(p.name)
        plt.show()


if __name__ == "__main__":
    main()

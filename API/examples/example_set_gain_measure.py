#!/usr/bin/env python3
"""
Set gain (LINEAR only), then read and print voltage + power snapshot.
Supports manual --port or auto-find.
"""

from __future__ import annotations

import argparse

from _example_common import add_port_args, connect_from_args


def main() -> int:
    parser = argparse.ArgumentParser(description="Set gain and measure snapshot (mV + W).")
    add_port_args(parser)
    parser.add_argument("--head", type=int, default=1, choices=[1, 2, 3, 4], help="Head index (1..4)")
    parser.add_argument("--gain", type=int, default=0, choices=list(range(8)), help="Gain index (0..7)")
    parser.add_argument("--frames", type=int, default=8, help="Averaging frames for snapshot.")
    args = parser.parse_args()

    dev = connect_from_args(args)
    try:
        idn = dev.idn()
        frontend = dev.frontend_type()
        detector = dev.detector_type()
        print(f"IDN: {idn}")
        print(f"Frontend: {frontend} | Detector: {detector}")

        if frontend.upper() == "LINEAR":
            dev.set_gain(args.head, args.gain)
            print(f"Set CH{args.head} gain -> {args.gain}")
        else:
            print("LOG front-end detected; gain setting is not applicable.")

        mv, gains = dev.snapshot_mV(n_frames=args.frames)
        pw = dev.snapshot_W(n_frames=args.frames, autogain=False)

        print("\nSnapshot:")
        for ch in range(4):
            g = gains[ch] if ch < len(gains) else "-"
            print(f"  CH{ch+1}: gain={g}  voltage={mv[ch]:>10.3f} mV  power={pw[ch]:>12.6e} W")
        return 0
    finally:
        dev.close()


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""
Internal-timer acquisition example:
1) Configure mask + sampling
2) Arm timer capture
3) Start acquisition, wait expected duration (+ margin)
4) Transfer and plot power traces
"""

from __future__ import annotations

import argparse
import time

import matplotlib.pyplot as plt
import numpy as np

from _example_common import add_port_args, call_with_busy_retry, connect_from_args, ensure_idle


def parse_mask(mask_text: str) -> int:
    return int(mask_text, 0) & 0x0F


def main() -> int:
    parser = argparse.ArgumentParser(description="Timer-based coreDAQ capture + matplotlib plot.")
    add_port_args(parser)
    parser.add_argument("--frames", type=int, default=4000000, help="Number of frames to capture.")
    parser.add_argument("--mask", type=str, default="0xF", help="Channel mask (hex or int). Example: 0xF, 0x3.")
    parser.add_argument("--freq-hz", type=int, default=100000, help="Sampling frequency in Hz.")
    parser.add_argument("--os-idx", type=int, default=0, help="Oversampling index (0..7).")
    parser.add_argument("--margin-s", type=float, default=0.4, help="Extra wait after expected capture duration.")
    args = parser.parse_args()

    dev = connect_from_args(args)
    try:
        print(f"IDN: {dev.idn()}")
        mask = parse_mask(args.mask)
        if mask == 0:
            raise ValueError("mask must enable at least one channel.")

        ensure_idle(dev, timeout_s=2.0)
        call_with_busy_retry(dev, dev.set_freq, args.freq_hz)
        call_with_busy_retry(dev, dev.set_oversampling, args.os_idx)
        call_with_busy_retry(dev, dev.set_channel_mask, mask)
        max_frames = dev.max_acquisition_frames(mask)
        if args.frames > max_frames:
            raise ValueError(f"frames={args.frames} exceeds max={max_frames} for mask=0x{mask:X}")

        freq = max(1, int(dev.get_freq_hz()))
        os_idx = int(dev.get_oversampling())
        expected_s = float(args.frames) / float(freq)

        print(
            f"Starting timer capture: frames={args.frames}, mask=0x{mask:X}, "
            f"freq={freq} Hz, os={os_idx}, expected={expected_s:.3f}s"
        )
        call_with_busy_retry(dev, dev.arm_acquisition, args.frames, False, True)
        call_with_busy_retry(dev, dev.start_acquisition)
        # Avoid command chatter while acquisition is active.
        time.sleep(expected_s + max(0.0, float(args.margin_s)))
        dev.wait_for_completion(timeout_s=max(3.0, expected_s + float(args.margin_s) + 2.0))

        print("Capture complete. Transferring ...")
        power_ch = dev.transfer_frames_W(args.frames)
        x = np.arange(args.frames, dtype=float) / float(freq)

        fig, axes = plt.subplots(4, 1, sharex=True, figsize=(12, 8))
        fig.suptitle("coreDAQ Timer-Based Acquisition (Power)")
        for ch in range(4):
            ax = axes[ch]
            ax.plot(x, power_ch[ch], linewidth=0.8)
            ax.set_ylabel(f"CH{ch+1} [W]")
            ax.grid(alpha=0.3)
        axes[-1].set_xlabel("Time [s]")
        plt.tight_layout()
        plt.show()
        return 0
    finally:
        dev.close()


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""
Triggered acquisition example:
1) Configure channel mask + acquisition settings
2) Arm trigger capture
3) Wait for external trigger completion
4) Transfer and plot power traces
"""

from __future__ import annotations

import argparse

import matplotlib.pyplot as plt
import numpy as np

from _example_common import add_port_args, call_with_busy_retry, connect_from_args, ensure_idle


def parse_mask(mask_text: str) -> int:
    return int(mask_text, 0) & 0x0F


def main() -> int:
    parser = argparse.ArgumentParser(description="Triggered coreDAQ capture + matplotlib plot.")
    add_port_args(parser)
    parser.add_argument("--frames", type=int, default=20000, help="Number of frames to capture.")
    parser.add_argument("--mask", type=str, default="0xF", help="Channel mask (hex or int). Example: 0xF, 0x3.")
    parser.add_argument("--freq-hz", type=int, default=50000, help="Sampling frequency in Hz.")
    parser.add_argument("--os-idx", type=int, default=0, help="Oversampling index (0..7).")
    parser.add_argument("--trigger", type=str, default="rising", choices=["rising", "falling"], help="Trigger edge.")
    parser.add_argument("--timeout-s", type=float, default=30.0, help="Timeout while waiting for trigger completion.")
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

        trigger_rising = args.trigger == "rising"
        print(
            f"Arming trigger capture: frames={args.frames}, mask=0x{mask:X}, "
            f"freq={dev.get_freq_hz()} Hz, os={dev.get_oversampling()}, edge={args.trigger}"
        )
        call_with_busy_retry(dev, dev.arm_acquisition, args.frames, True, trigger_rising)
        call_with_busy_retry(dev, dev.start_acquisition)

        print("Waiting for trigger + acquisition complete ...")
        dev.wait_for_completion(timeout_s=args.timeout_s)
        print("Capture complete. Transferring ...")

        power_ch = dev.transfer_frames_W(args.frames)
        freq = max(1, int(dev.get_freq_hz()))
        x = np.arange(args.frames, dtype=float) / float(freq)

        fig, axes = plt.subplots(4, 1, sharex=True, figsize=(12, 8))
        fig.suptitle("coreDAQ Triggered Acquisition (Power)")
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

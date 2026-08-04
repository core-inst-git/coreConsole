#!/usr/bin/env python3
"""
Live power stream plot using matplotlib.
- Uses host time on x-axis.
- Attempts sampling loop at --sample-hz (default 500).
- Supports manual --port or auto-find.
"""

from __future__ import annotations

import argparse
import threading
import time
from collections import deque
from typing import Deque, List

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.animation import FuncAnimation

from _example_common import add_port_args, connect_from_args


def main() -> int:
    parser = argparse.ArgumentParser(description="Live stream power plot (matplotlib).")
    add_port_args(parser)
    parser.add_argument("--sample-hz", type=float, default=500.0, help="Host polling target in Hz.")
    parser.add_argument("--window-s", type=float, default=5.0, help="Displayed time window in seconds.")
    parser.add_argument("--freq-hz", type=int, default=500, help="Device frequency setpoint for streaming snapshots.")
    parser.add_argument("--os-idx", type=int, default=0, help="Device oversampling index for streaming snapshots.")
    parser.add_argument("--frames", type=int, default=1, help="SNAP averaging frames per sample.")
    args = parser.parse_args()

    dev = connect_from_args(args)
    try:
        print(f"IDN: {dev.idn()}")
        dev.set_freq(args.freq_hz)
        dev.set_oversampling(args.os_idx)
        print(f"Configured: freq={dev.get_freq_hz()} Hz, os={dev.get_oversampling()}")

        sample_hz = max(1.0, float(args.sample_hz))
        dt_target = 1.0 / sample_hz
        max_points = max(200, int(float(args.window_s) * sample_hz))

        tbuf: Deque[float] = deque(maxlen=max_points)
        ybuf: List[Deque[float]] = [deque(maxlen=max_points) for _ in range(4)]
        lock = threading.Lock()
        stop_evt = threading.Event()

        t0 = time.perf_counter()

        def worker() -> None:
            next_deadline = time.perf_counter()
            while not stop_evt.is_set():
                try:
                    p = dev.snapshot_W(n_frames=max(1, int(args.frames)), autogain=False)
                    if isinstance(p, tuple):
                        p = p[0]
                    now = time.perf_counter() - t0
                    with lock:
                        tbuf.append(now)
                        for ch in range(4):
                            ybuf[ch].append(float(p[ch]))
                except Exception as exc:
                    print(f"[stream] {exc}")
                    time.sleep(0.05)

                next_deadline += dt_target
                sleep_s = next_deadline - time.perf_counter()
                if sleep_s > 0:
                    time.sleep(sleep_s)
                else:
                    next_deadline = time.perf_counter()

        th = threading.Thread(target=worker, daemon=True)
        th.start()

        fig, axes = plt.subplots(4, 1, sharex=True, figsize=(12, 8))
        fig.suptitle("coreDAQ Live Power Stream")
        lines = []
        for ch in range(4):
            ax = axes[ch]
            (line,) = ax.plot([], [], linewidth=1.0)
            ax.set_ylabel(f"CH{ch+1} [W]")
            ax.grid(alpha=0.3)
            lines.append(line)
        axes[-1].set_xlabel("Host time [s]")

        def update(_frame):
            with lock:
                if not tbuf:
                    return lines
                t = np.asarray(tbuf, dtype=float)
                ys = [np.asarray(ybuf[ch], dtype=float) for ch in range(4)]

            tmin = max(0.0, float(t[-1]) - float(args.window_s))
            for ch in range(4):
                lines[ch].set_data(t, ys[ch])
                axes[ch].set_xlim(tmin, max(tmin + 1e-3, float(t[-1])))
                if ys[ch].size > 1:
                    ymin = float(np.min(ys[ch]))
                    ymax = float(np.max(ys[ch]))
                    if ymin == ymax:
                        pad = abs(ymin) * 0.05 + 1e-12
                    else:
                        pad = (ymax - ymin) * 0.12
                    axes[ch].set_ylim(ymin - pad, ymax + pad)
            return lines

        anim = FuncAnimation(fig, update, interval=30, blit=False, cache_frame_data=False)
        _ = anim
        plt.tight_layout()
        plt.show()
        return 0
    finally:
        stop_evt = locals().get("stop_evt")
        if stop_evt is not None:
            stop_evt.set()
        dev.close()


if __name__ == "__main__":
    raise SystemExit(main())

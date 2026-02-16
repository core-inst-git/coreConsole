# coreDAQ API Examples

All scripts support:

- Manual port: `--port COM7` or `--port /dev/ttyACM0`
- Auto-find: omit `--port`, optionally `--device-index N`

## 1) Set Gain + Measure Snapshot

```bash
python API/examples/example_set_gain_measure.py --head 1 --gain 3 --frames 8
```

## 2) Triggered Acquisition + Plot

```bash
python API/examples/example_trigger_acquisition_plot.py --frames 20000 --mask 0xF --freq-hz 50000 --os-idx 0 --trigger rising
```

## 3) Internal Timer Acquisition + Plot

```bash
python API/examples/example_timer_acquisition_plot.py --frames 20000 --mask 0xF --freq-hz 50000 --os-idx 0
```

## 4) Live Power Stream Plot

```bash
python API/examples/example_live_stream_plot.py --sample-hz 500 --window-s 5 --freq-hz 500 --os-idx 0
```

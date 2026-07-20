import React, { useEffect, useMemo, useRef, useState } from 'react';
import LiveChart from '@/components/LiveChart';
import { ControlMsg, DeviceStatus, gainDisplayLabel, sendControl, subscribeControl, subscribeStatus, subscribeStream } from '@/coredaqClient';
import { VirtualChannelDef, VirtualMathType } from '@/virtualChannels';

const CHANNEL_COLORS = [
  '#4DD0E1',
  '#FFB454',
  '#7BE7A1',
  '#FF7AA2',
  '#82AAFF',
  '#C792EA',
  '#FFD166',
  '#6EE7B7',
];

const DISPLAY_POINTS_PER_SECOND = 500;
const RECORD_STORAGE_KEY = 'coredaq.record.v1';
const RECORD_MAX_S = 60;

// Chart refreshes are decoupled from the 500 Hz sample stream: samples land in
// plain ref-held buffers and the UI repaints at most this often.
const CHART_TICK_MS = 33;
// Each chart draws at most this many points; buffers are min/max-decimated per
// repaint so peaks/dips survive (stride subsampling would erase them).
const CHART_MAX_POINTS = 700;

type XY = { x: number[]; y: number[] };

function emptyXY(): XY {
  return { x: [], y: [] };
}

/** Min/max envelope decimation onto [x,y] pairs (order-preserving per bucket). */
function decimateMinMax(x: number[], y: number[], maxPoints: number): [number, number][] {
  const n = Math.min(x.length, y.length);
  if (n <= maxPoints) {
    const out: [number, number][] = new Array(n);
    for (let i = 0; i < n; i += 1) out[i] = [x[i], y[i]];
    return out;
  }
  const buckets = Math.max(1, Math.floor(maxPoints / 2));
  const step = n / buckets;
  const out: [number, number][] = [];
  for (let b = 0; b < buckets; b += 1) {
    const i0 = Math.floor(b * step);
    const i1 = Math.min(n, Math.max(i0 + 1, Math.floor((b + 1) * step)));
    let minI = i0;
    let maxI = i0;
    for (let i = i0 + 1; i < i1; i += 1) {
      if (y[i] < y[minI]) minI = i;
      if (y[i] > y[maxI]) maxI = i;
    }
    const first = Math.min(minI, maxI);
    const second = Math.max(minI, maxI);
    out.push([x[first], y[first]]);
    if (second !== first) out.push([x[second], y[second]]);
  }
  return out;
}

type ChannelDef = {
  id: string;
  type: 'physical' | 'math';
  name: string;
  color: string;
  deviceId?: string;
  channelIndex?: number;
  srcA?: string;
  srcB?: string;
  mathType?: VirtualMathType;
  virtualId?: string;
};

type ChannelSeries = {
  x: number[];
  y: number[];
};

type PowerScale = {
  factor: number;
  unit: string;
};

type Props = {
  windowSeconds: number;
  devices: DeviceStatus[];
  activeDeviceId: string | null;
  onSelectDevice: (deviceId: string) => void;
  globalStreaming: boolean;
  virtualChannels: VirtualChannelDef[];
  onAddVirtualChannel: (input: { mathType: VirtualMathType; srcA: string; srcB: string; name: string }) => void;
  onRemoveVirtualChannel: (virtualId: string) => void;
};

function pickPowerScale(data: number[]): PowerScale {
  let maxAbs = 0;
  for (const v of data) {
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs >= 1) return { factor: 1, unit: 'W' };
  if (maxAbs >= 1e-3) return { factor: 1e3, unit: 'mW' };
  if (maxAbs >= 1e-6) return { factor: 1e6, unit: 'uW' };
  if (maxAbs >= 1e-9) return { factor: 1e9, unit: 'nW' };
  return { factor: 1e12, unit: 'pW' };
}

function formatWavelengthInput(valueNm: number | null | undefined): string {
  if (typeof valueNm !== 'number' || !Number.isFinite(valueNm)) return '';
  const rounded = Math.round(valueNm * 1000) / 1000;
  return Number.isInteger(rounded) ? String(Math.trunc(rounded)) : String(rounded);
}

function physicalChannelId(deviceId: string, channelIdx: number): string {
  return `${deviceId}:ch${channelIdx + 1}`;
}

function emptySeries(): ChannelSeries {
  return { x: [], y: [] };
}

export default function LivePlot({
  windowSeconds,
  devices,
  activeDeviceId,
  onSelectDevice,
  globalStreaming,
  virtualChannels,
  onAddVirtualChannel,
  onRemoveVirtualChannel,
}: Props) {
  const sortedDevices = useMemo(
    () => [...devices].sort((a, b) => a.device_id.localeCompare(b.device_id)),
    [devices]
  );

  const activeDevice = useMemo(() => {
    if (activeDeviceId) {
      const found = sortedDevices.find((d) => d.device_id === activeDeviceId);
      if (found) return found;
    }
    return sortedDevices[0] ?? null;
  }, [activeDeviceId, sortedDevices]);

  const activeIsLinear = activeDevice?.frontend_type === 'LINEAR';

  const physicalChannels = useMemo(() => {
    return sortedDevices.flatMap((d, dIdx) =>
      Array.from({ length: 4 }).map((_, chIdx) => ({
        id: physicalChannelId(d.device_id, chIdx),
        type: 'physical' as const,
        name: `D${dIdx + 1} CH${chIdx + 1}`,
        color: CHANNEL_COLORS[(dIdx * 4 + chIdx) % CHANNEL_COLORS.length],
        deviceId: d.device_id,
        channelIndex: chIdx,
      }))
    );
  }, [sortedDevices]);

  // Sample buffers live OUTSIDE React state: appending 500 samples/s through
  // setState churned new arrays per sample and re-rendered per message. The
  // buffers are plain ref-held arrays; `chartTick` drives repaints at ~30 Hz.
  const buffersRef = useRef<Record<string, XY>>({});
  const streamDirtyRef = useRef(false);
  const [chartTick, setChartTick] = useState(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const [active, setActive] = useState<ChannelDef[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [addType, setAddType] = useState<'physical' | 'math'>('physical');
  const [mathType, setMathType] = useState<VirtualMathType>('db');
  const [srcA, setSrcA] = useState('');
  const [srcB, setSrcB] = useState('');
  const t0Ref = useRef<Record<string, number>>({});

  const maxPoints = Math.max(250, Math.round(windowSeconds * DISPLAY_POINTS_PER_SECOND));

  useEffect(() => {
    const physIds = new Set(physicalChannels.map((c) => c.id));

    setActive((prev) => {
      const kept = prev.filter((c) => c.type === 'math' || physIds.has(c.id));
      const existingPhysical = new Set(kept.filter((c) => c.type === 'physical').map((c) => c.id));
      for (const p of physicalChannels) {
        if (!existingPhysical.has(p.id)) kept.push({ ...p });
      }
      return kept;
    });

    const buffers = buffersRef.current;
    const next: Record<string, XY> = {};
    for (const p of physicalChannels) {
      next[p.id] = buffers[p.id] || emptyXY();
    }
    buffersRef.current = next;

    setSrcA((prev) => (prev && physIds.has(prev) ? prev : physicalChannels[0]?.id || ''));
    setSrcB((prev) => {
      if (prev && physIds.has(prev)) return prev;
      if (physicalChannels.length > 1) return physicalChannels[1].id;
      return physicalChannels[0]?.id || '';
    });
  }, [physicalChannels]);

  // Repaint clock: bump chartTick only when new samples arrived.
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (!streamDirtyRef.current) return;
      streamDirtyRef.current = false;
      setChartTick((t) => (t + 1) | 0);
    }, CHART_TICK_MS);
    return () => window.clearInterval(iv);
  }, []);

  useEffect(() => {
    const virtualDefs: ChannelDef[] = virtualChannels.map((v) => ({
      id: `virtual-${v.id}`,
      virtualId: v.id,
      type: 'math',
      name: v.name,
      color: v.color,
      srcA: v.srcA,
      srcB: v.srcB,
      mathType: v.mathType,
    }));

    setActive((prev) => {
      const phys = prev.filter((c) => c.type === 'physical');
      return [...phys, ...virtualDefs];
    });
  }, [virtualChannels]);

  useEffect(() => {
    // Backend sends batched samples: {device_id, t:[...], ch:[[...]x4]} every
    // ~25 ms. Ingest appends into ref buffers in place — no React state churn.
    const unsub = subscribeStream((msg) => {
      if (!msg.device_id) return;
      const batchT = Array.isArray(msg.t) ? (msg.t as number[]) : null;
      const batchCh = Array.isArray(msg.ch) ? (msg.ch as number[][]) : null;
      if (!batchT || !batchCh || batchCh.length < 4 || batchT.length === 0) return;

      if (t0Ref.current[msg.device_id] === undefined) {
        t0Ref.current[msg.device_id] = batchT[0];
      }
      const t0 = t0Ref.current[msg.device_id];
      const minT = batchT[batchT.length - 1] - t0 - Math.max(0.2, windowSeconds);

      for (let i = 0; i < 4; i += 1) {
        const key = physicalChannelId(msg.device_id as string, i);
        const buf = buffersRef.current[key];
        if (!buf) continue;
        const chArr = batchCh[i];
        if (!Array.isArray(chArr)) continue;
        const m = Math.min(batchT.length, chArr.length);
        for (let k = 0; k < m; k += 1) {
          buf.x.push(batchT[k] - t0);
          buf.y.push(Number(chArr[k] ?? 0));
        }
        let drop = 0;
        while (drop < buf.x.length && buf.x[drop] < minT) drop += 1;
        if (buf.x.length - drop > maxPoints) drop = buf.x.length - maxPoints;
        if (drop > 0) {
          buf.x.splice(0, drop);
          buf.y.splice(0, drop);
        }
      }
      streamDirtyRef.current = true;
    });
    return () => unsub();
  }, [maxPoints, windowSeconds]);

  const gains = useMemo(() => {
    if (!Array.isArray(activeDevice?.gains) || activeDevice.gains.length < 4) {
      return [0, 0, 0, 0];
    }
    return activeDevice.gains.slice(0, 4).map((v) => Number(v) || 0);
  }, [activeDevice]);

  const autoGain = !!activeDevice?.autogain;
  const freqHz = typeof activeDevice?.freq_hz === 'number' ? activeDevice.freq_hz : null;
  const osIdx = typeof activeDevice?.os_idx === 'number' ? activeDevice.os_idx : null;
  const dieTempC = typeof activeDevice?.die_temp_c === 'number' ? activeDevice.die_temp_c : null;
  const roomTempC = typeof activeDevice?.room_temp_c === 'number' ? activeDevice.room_temp_c : null;
  const roomHumidityPct =
    typeof activeDevice?.room_humidity_pct === 'number' ? activeDevice.room_humidity_pct : null;
  const detectorType = (activeDevice?.detector_type || 'INGAAS').toString().toUpperCase();
  const wavelengthNm = typeof activeDevice?.wavelength_nm === 'number' ? activeDevice.wavelength_nm : null;
  const wavelengthMinNm =
    typeof activeDevice?.wavelength_min_nm === 'number'
      ? activeDevice.wavelength_min_nm
      : detectorType === 'SILICON'
        ? 400
        : 910;
  const wavelengthMaxNm =
    typeof activeDevice?.wavelength_max_nm === 'number'
      ? activeDevice.wavelength_max_nm
      : detectorType === 'SILICON'
        ? 1100
        : 1700;
  const [wavelengthInput, setWavelengthInput] = useState('');
  const [wavelengthEditing, setWavelengthEditing] = useState(false);
  const [wavelengthError, setWavelengthError] = useState<string | null>(null);
  // Value submitted to the device and awaiting confirmation, plus the time it
  // was sent. While a submit is pending we do NOT snap the field back to the
  // (stale) device value; the staleness fallback below guarantees the field can
  // never stay frozen even if a control ack is lost.
  const wavelengthPendingRef = useRef<{ value: number; ts: number } | null>(null);
  const WAVELENGTH_PENDING_TIMEOUT_MS = 4000;

  // Refs so the (mount-once) control subscriber always sees current context.
  const activeDeviceIdRef = useRef<string | null>(null);
  const wavelengthNmRef = useRef<number | null>(null);
  activeDeviceIdRef.current = activeDevice?.device_id ?? null;
  wavelengthNmRef.current = wavelengthNm;

  // Resync the field from device status — but never clobber active typing or an
  // in-flight submit (until it confirms, clamps, or goes stale).
  useEffect(() => {
    if (wavelengthEditing) return;
    const pending = wavelengthPendingRef.current;
    if (pending) {
      const confirmed =
        typeof wavelengthNm === 'number' && Math.abs(wavelengthNm - pending.value) < 0.5;
      const stale = Date.now() - pending.ts > WAVELENGTH_PENDING_TIMEOUT_MS;
      if (!confirmed && !stale) return; // keep showing the submitted value
      wavelengthPendingRef.current = null;
    }
    setWavelengthInput(formatWavelengthInput(wavelengthNm));
  }, [activeDevice?.device_id, wavelengthNm, wavelengthEditing]);

  // Reset transient input state when the active device changes.
  useEffect(() => {
    setWavelengthEditing(false);
    setWavelengthError(null);
    wavelengthPendingRef.current = null;
  }, [activeDevice?.device_id]);

  // Handle the backend's set_wavelength acknowledgement (fixes silent failures
  // that previously required an app restart to recover from).
  useEffect(() => {
    return subscribeControl((msg: ControlMsg) => {
      if (msg.action !== 'set_wavelength') return;
      const forDevice = (msg.device_id as string | undefined) ?? null;
      if (forDevice && activeDeviceIdRef.current && forDevice !== activeDeviceIdRef.current) return;
      wavelengthPendingRef.current = null;
      if (msg.ok) {
        setWavelengthError(null);
        const applied = msg.wavelength_nm as number | undefined;
        if (typeof applied === 'number' && Number.isFinite(applied)) {
          setWavelengthInput(formatWavelengthInput(applied));
        }
      } else {
        setWavelengthError(String(msg.error || 'Failed to set wavelength'));
        setWavelengthInput(formatWavelengthInput(wavelengthNmRef.current));
      }
    });
  }, []);

  // ---- live recording (Record button) -----------------------------------
  const [recDurationS, setRecDurationS] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem(RECORD_STORAGE_KEY);
      const v = raw ? Number(JSON.parse(raw).durationS) : NaN;
      return Number.isFinite(v) && v >= 1 && v <= RECORD_MAX_S ? v : 10;
    } catch {
      return 10;
    }
  });
  const [recording, setRecording] = useState(false);
  const [recRemaining, setRecRemaining] = useState(0);
  const [recNote, setRecNote] = useState<string | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(RECORD_STORAGE_KEY, JSON.stringify({ durationS: recDurationS }));
    } catch {
      // ignore
    }
  }, [recDurationS]);

  useEffect(() => {
    if (!recording) return;
    const iv = window.setInterval(() => setRecRemaining((p) => Math.max(0, p - 1)), 1000);
    return () => window.clearInterval(iv);
  }, [recording]);

  const recordingRef = useRef(false);
  recordingRef.current = recording;

  useEffect(() => {
    return subscribeControl((msg: ControlMsg) => {
      if (msg.action === 'record_start' && !msg.ok) {
        setRecording(false);
        setRecNote(`Record failed: ${msg.error || 'unknown error'}`);
      } else if (msg.action === 'record_stop' && !msg.ok) {
        // e.g. "No recording in progress" after a backend restart — always
        // unlock the UI rather than wedging in the recording state.
        setRecording(false);
        setRecNote(`Record stopped: ${msg.error || 'unknown error'}`);
      } else if (msg.action === 'record_done') {
        setRecording(false);
        setRecNote(
          msg.ok
            ? `Saved ${msg.frames ?? '?'} frames → ${msg.path ?? ''}`
            : `Record failed: ${msg.error || 'unknown error'}`
        );
      }
    });
  }, []);

  // Backend loss mid-record: record_done will never arrive — abort the UI
  // state (the backend finalizes a partial file on SIGTERM when it can).
  useEffect(() => {
    return subscribeStatus((msg) => {
      if (msg.connected === false && recordingRef.current) {
        setRecording(false);
        setRecNote('Backend disconnected — recording aborted; a partial file may exist.');
      }
    });
  }, []);

  const startRecording = async () => {
    if (recording) return;
    const cards = active.map((def) =>
      def.type === 'physical'
        ? {
            kind: 'physical',
            name: def.name,
            device_id: def.deviceId,
            channel: def.channelIndex,
          }
        : {
            kind: 'math',
            name: def.name,
            math_type: def.mathType,
            src_a: def.srcA,
            src_b: def.srcB,
          }
    );
    if (cards.length === 0) {
      setRecNote('No open cards to record.');
      return;
    }
    const d = Math.min(RECORD_MAX_S, Math.max(1, Math.round(recDurationS)));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const defaultName = `coredaq_live_${stamp}.h5`;
    let path = defaultName;
    if (window.coredaq?.pickSavePath) {
      const picked = await window.coredaq.pickSavePath(defaultName);
      if (picked.canceled || !picked.filePath) return;
      path = picked.filePath;
    }
    setRecNote(null);
    setRecording(true);
    setRecRemaining(d);
    sendControl({ action: 'record_start', path, duration_s: d, cards });
  };

  const applyWavelength = () => {
    setWavelengthEditing(false);
    if (!activeDevice) return;
    const parsed = Number(wavelengthInput);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setWavelengthInput(formatWavelengthInput(wavelengthNm));
      wavelengthPendingRef.current = null;
      return;
    }
    // No-op if unchanged from the device value — avoids needless commands.
    if (typeof wavelengthNm === 'number' && Math.abs(parsed - wavelengthNm) < 0.01) {
      wavelengthPendingRef.current = null;
      setWavelengthError(null);
      setWavelengthInput(formatWavelengthInput(wavelengthNm));
      return;
    }
    wavelengthPendingRef.current = { value: parsed, ts: Date.now() };
    setWavelengthError(null);
    sendControl({
      action: 'set_wavelength',
      device_id: activeDevice.device_id,
      wavelength_nm: parsed,
    });
  };

  const updateGain = (idx: number, val: number) => {
    if (!activeDevice || !activeIsLinear) return;
    sendControl({ action: 'set_gain', device_id: activeDevice.device_id, head: idx + 1, gain: val });
  };

  const computeMath = (def: ChannelDef): ChannelSeries => {
    const a = def.srcA ? buffersRef.current[def.srcA] : undefined;
    const b = def.srcB ? buffersRef.current[def.srcB] : undefined;
    if (!a || !b) return emptySeries();

    const len = Math.min(a.y.length, b.y.length);
    if (len <= 0) return emptySeries();

    const aOff = a.y.length - len;
    const bOff = b.y.length - len;
    const xSrc = a.x.length <= b.x.length ? a : b;
    const xOff = xSrc.x.length - len;
    const xBase = new Array(len);
    const out = new Array(len);

    for (let i = 0; i < len; i += 1) {
      xBase[i] = xSrc.x[xOff + i];
      const va = a.y[aOff + i];
      const vb = b.y[bOff + i];
      switch (def.mathType) {
        case 'sum':
          out[i] = va + vb;
          break;
        case 'diff':
          out[i] = va - vb;
          break;
        case 'db': {
          const num = Math.abs(va);
          const den = Math.abs(vb);
          out[i] = den === 0 || num === 0 ? -120 : 20 * Math.log10(num / den);
          break;
        }
        default:
          out[i] = 0;
      }
    }

    return { x: xBase, y: out };
  };

  // Recomputed on the ~30 Hz chart tick (not per sample). Output is already
  // decimated to what the chart will actually draw.
  const displaySeries = useMemo(() => {
    void chartTick; // buffers are refs; the tick is the invalidation signal
    return active.map((def) => {
      const base =
        def.type === 'physical'
          ? buffersRef.current[def.id] || emptySeries()
          : computeMath(def);
      const latest = base.y.length > 0 ? base.y[base.y.length - 1] : null;
      if (def.type === 'math' && def.mathType === 'db') {
        return { ...def, unit: 'dB', latest, points: decimateMinMax(base.x, base.y, CHART_MAX_POINTS) };
      }
      const scale = pickPowerScale(base.y);
      const pts = decimateMinMax(base.x, base.y, CHART_MAX_POINTS);
      for (let i = 0; i < pts.length; i += 1) pts[i][1] *= scale.factor;
      return { ...def, unit: scale.unit, latest, points: pts };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, chartTick]);

  const clearSeries = () => {
    t0Ref.current = {};
    for (const key of Object.keys(buffersRef.current)) {
      buffersRef.current[key] = emptyXY();
    }
    streamDirtyRef.current = true;
  };

  const removeChannel = (id: string) => {
    setActive((prev) => {
      const target = prev.find((c) => c.id === id);
      if (target?.type === 'math' && target.virtualId) {
        onRemoveVirtualChannel(target.virtualId);
      }
      return prev.filter((c) => c.id !== id);
    });
  };

  const addPhysical = (id: string) => {
    const def = physicalChannels.find((c) => c.id === id);
    if (!def) return;
    setActive((prev) => [...prev, { ...def }]);
  };

  const addMath = () => {
    if (!srcA || !srcB) return;
    const srcALabel = physicalChannels.find((c) => c.id === srcA)?.name || 'A';
    const srcBLabel = physicalChannels.find((c) => c.id === srcB)?.name || 'B';
    const name =
      mathType === 'db'
        ? `dB ${srcALabel}/${srcBLabel}`
        : mathType === 'diff'
          ? `${srcALabel}-${srcBLabel}`
          : `${srcALabel}+${srcBLabel}`;

    onAddVirtualChannel({
      mathType,
      srcA,
      srcB,
      name,
    });
  };

  const osLabel = (idx: number | null) => {
    if (typeof idx !== 'number') return '--';
    const ratio = 1 << idx;
    return `${ratio}x oversampling`;
  };

  const clampPct = (v: number, lo: number, hi: number) => {
    const p = ((v - lo) / (hi - lo)) * 100;
    return Math.max(0, Math.min(100, p));
  };

  const metricStyle = (pct: number, color: string): React.CSSProperties => ({
    background: `conic-gradient(${color} ${pct}%, rgba(43,55,70,0.35) ${pct}% 100%)`,
  });

  return (
    <section className="live">
      <div className="live-header">
        <div>
          <div className="live-title">Power Monitor</div>
        </div>
        <div className="live-actions">
          <select
            className="pref-input live-device-select"
            value={activeDevice?.device_id || ''}
            onChange={(e) => onSelectDevice(e.target.value)}
            disabled={sortedDevices.length === 0}
          >
            {sortedDevices.length === 0 && <option value="">No device</option>}
            {sortedDevices.map((d) => (
              <option key={d.device_id} value={d.device_id}>
                {d.device_id} • {d.frontend_type || 'UNKNOWN'}
              </option>
            ))}
          </select>
          <button className="btn ghost" onClick={() => setShowAdd(true)}>
            Add Channel
          </button>
          <div className="record-controls" title="Record the open cards to an HDF5 file (500 Hz, max 60 s)">
            <input
              className="pref-input record-duration"
              type="number"
              min={1}
              max={RECORD_MAX_S}
              step={1}
              value={recDurationS}
              disabled={recording}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) setRecDurationS(v);
              }}
              onBlur={() =>
                setRecDurationS((p) => Math.min(RECORD_MAX_S, Math.max(1, Math.round(p) || 10)))
              }
            />
            <span className="record-unit">s</span>
            {!recording ? (
              <button
                className="btn record-btn"
                onClick={startRecording}
                disabled={sortedDevices.length === 0}
              >
                ● Record
              </button>
            ) : (
              <button
                className="btn record-btn recording"
                onClick={() => sendControl({ action: 'record_stop' })}
              >
                ■ Stop ({recRemaining}s)
              </button>
            )}
          </div>
          <button className="btn ghost" onClick={() => sendControl({ action: 'stream', enabled: false })}>
            Freeze
          </button>
          <button
            className="btn primary"
            onClick={() => {
              clearSeries();
              sendControl({ action: 'stream', enabled: true });
            }}
          >
            {globalStreaming ? 'Streaming' : 'Start Stream'}
          </button>
        </div>
      </div>

      {recNote && <div className="record-note">{recNote}</div>}

      <div className="live-grid">
        <div className="panel chart-panel">
          <div className="panel-header">
            <div className="panel-title">Power Stream</div>
          </div>
          <div className="chart-grid">
            {displaySeries.map((ch) => (
              <div
                key={ch.id}
                className={`chart-cell ${dragId === ch.id ? 'dragging' : ''}`}
                draggable
                onDragStart={() => setDragId(ch.id)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (!dragId || dragId === ch.id) return;
                  const next = active.filter((c) => c.id !== dragId);
                  const insertAt = next.findIndex((c) => c.id === ch.id);
                  const moving = active.find((c) => c.id === dragId);
                  if (!moving) return;
                  next.splice(insertAt, 0, moving);
                  setActive(next);
                  setDragId(null);
                }}
                onDragEnd={() => setDragId(null)}
              >
                <div className="chart-title">
                  <span className="legend-dot" style={{ background: ch.color }} />
                  {ch.name}
                  <span className="drag-hint">drag</span>
                  <button
                    className="icon-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeChannel(ch.id);
                    }}
                    title="Close"
                  >
                    ×
                  </button>
                </div>
                <LiveChart
                  series={[{ name: ch.name, color: ch.color, points: ch.points }]}
                  unit={ch.unit}
                  compact
                />
              </div>
            ))}
          </div>
        </div>

        <div className="panel control-panel">
          <div className="panel-header">
            <div className="panel-title">Device Control</div>
            <div className="panel-meta">
              {activeDevice
                ? `${activeDevice.device_id} • ${activeDevice.frontend_type || 'UNKNOWN'} • ${detectorType}`
                : 'No active device'}
            </div>
          </div>

          {activeIsLinear ? (
            <>
              <div className="toggle-row">
                <div>
                  <div className="toggle-title">Autogain</div>
                  <div className="toggle-sub">Gain Control auto-optimizes dynamic range</div>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={autoGain}
                    onChange={(e) => {
                      if (!activeDevice) return;
                      sendControl({
                        action: 'set_autogain',
                        device_id: activeDevice.device_id,
                        enabled: e.target.checked,
                      });
                    }}
                    disabled={!activeDevice}
                  />
                  <span className="slider" />
                </label>
              </div>

              <div className="divider" />

              <div className="gain-list">
                {Array.from({ length: 4 }).map((_, idx) => (
                  <div key={idx} className="gain-row">
                    <div className="gain-label">
                      <span className="gain-dot" style={{ background: CHANNEL_COLORS[idx % CHANNEL_COLORS.length] }} />
                      <span>{`CH${idx + 1}`}</span>
                    </div>
                    <select
                      className="gain-select"
                      value={gains[idx]}
                      onChange={(e) => updateGain(idx, Number(e.target.value))}
                      disabled={autoGain || !activeDevice}
                    >
                      {Array.from({ length: 8 }).map((__, g) => (
                        <option key={`gain-${idx}-${g}`} value={g}>
                          {gainDisplayLabel(g)}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="device-note">
              LOG front-end active. Gain Control and Autogain are unavailable for this device type.
            </div>
          )}

          <div className="divider" />

          <div className="stats">
            <div className="stat">
              <div className="stat-label">Sampling</div>
              <div className="stat-value">
                {typeof freqHz === 'number' ? `${freqHz.toLocaleString()} Hz` : '--'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Oversampling</div>
              <div className="stat-value">{osLabel(osIdx)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">OS Index</div>
              <select
                className="pref-input"
                value={typeof osIdx === 'number' ? osIdx : 0}
                onChange={(e) => {
                  if (!activeDevice) return;
                  sendControl({
                    action: 'set_os',
                    device_id: activeDevice.device_id,
                    os_idx: Number(e.target.value),
                  });
                }}
                disabled={!activeDevice}
              >
                {Array.from({ length: 7 }).map((_, i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            </div>
            <div className="stat">
              <div className="stat-label">Wavelength</div>
              <div className="stat-input-wrap">
                <input
                  className="pref-input wavelength-input"
                  type="number"
                  step="1"
                  min={wavelengthMinNm}
                  max={wavelengthMaxNm}
                  value={wavelengthInput}
                  onChange={(e) => setWavelengthInput(e.target.value)}
                  onFocus={() => setWavelengthEditing(true)}
                  onBlur={applyWavelength}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      applyWavelength();
                    }
                  }}
                  disabled={!activeDevice}
                />
                <span className="stat-unit">nm</span>
              </div>
            </div>
            {wavelengthError ? (
              <div className="stat-hint stat-hint-error">{wavelengthError}</div>
            ) : (
              <div className="stat-hint">
                Range {Math.round(wavelengthMinNm)}-{Math.round(wavelengthMaxNm)} nm
                {' • '}
                default 1550 nm
              </div>
            )}
          </div>

          <div className="divider" />

          <div className="env-title">Environment</div>
          <div className="env-grid">
            <div className="env-card">
              <div className="env-ring" style={metricStyle(clampPct(dieTempC ?? 0, 10, 90), '#ff9f7a')}>
                <div className="env-ring-core" />
              </div>
              <div className="env-name">Device Temp</div>
              <div className="env-value">{typeof dieTempC === 'number' ? `${dieTempC.toFixed(1)} C` : '--'}</div>
            </div>

            <div className="env-card">
              <div className="env-ring" style={metricStyle(clampPct(roomTempC ?? 0, 0, 50), '#7ad3ff')}>
                <div className="env-ring-core" />
              </div>
              <div className="env-name">Room Temp</div>
              <div className="env-value">{typeof roomTempC === 'number' ? `${roomTempC.toFixed(1)} C` : '--'}</div>
            </div>

            <div className="env-card">
              <div className="env-ring" style={metricStyle(clampPct(roomHumidityPct ?? 0, 0, 100), '#7be7a1')}>
                <div className="env-ring-core" />
              </div>
              <div className="env-name">Humidity</div>
              <div className="env-value">
                {typeof roomHumidityPct === 'number' ? `${roomHumidityPct.toFixed(1)} %` : '--'}
              </div>
            </div>
          </div>
        </div>
      </div>

      {showAdd && (
        <div className="modal-backdrop" onClick={() => setShowAdd(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Add Channel</div>
              <button className="btn ghost" onClick={() => setShowAdd(false)}>
                Close
              </button>
            </div>
            <div className="modal-body">
              <div className="pref-row">
                <div>
                  <div className="pref-title">Type</div>
                  <div className="pref-sub">Physical or Math channel</div>
                </div>
                <select
                  className="pref-input"
                  value={addType}
                  onChange={(e) => setAddType(e.target.value as 'physical' | 'math')}
                >
                  <option value="physical">Physical</option>
                  <option value="math">Virtual</option>
                </select>
              </div>

              {addType === 'physical' && (
                <div className="pref-row">
                  <div>
                    <div className="pref-title">Physical Channel</div>
                    <div className="pref-sub">From connected devices</div>
                  </div>
                  <select
                    className="pref-input live-modal-wide"
                    defaultValue=""
                    onChange={(e) => {
                      if (!e.target.value) return;
                      addPhysical(e.target.value);
                      setShowAdd(false);
                    }}
                  >
                    <option value="">Select...</option>
                    {physicalChannels.map((c) => (
                      <option key={c.id} value={c.id} disabled={!!active.find((a) => a.id === c.id)}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {addType === 'math' && (
                <>
                  <div className="pref-row">
                    <div>
                      <div className="pref-title">Math Type</div>
                      <div className="pref-sub">Shared across monitor and sweep</div>
                    </div>
                    <select
                      className="pref-input live-modal-wide"
                      value={mathType}
                      onChange={(e) => setMathType(e.target.value as VirtualMathType)}
                    >
                      <option value="db">dB (A/B)</option>
                      <option value="diff">Difference (A - B)</option>
                      <option value="sum">Sum (A + B)</option>
                    </select>
                  </div>
                  <div className="pref-row">
                    <div>
                      <div className="pref-title">Source A</div>
                      <div className="pref-sub">Numerator / left term</div>
                    </div>
                    <select
                      className="pref-input live-modal-wide"
                      value={srcA}
                      onChange={(e) => setSrcA(e.target.value)}
                    >
                      {physicalChannels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="pref-row">
                    <div>
                      <div className="pref-title">Source B</div>
                      <div className="pref-sub">Denominator / right term</div>
                    </div>
                    <select
                      className="pref-input live-modal-wide"
                      value={srcB}
                      onChange={(e) => setSrcB(e.target.value)}
                    >
                      {physicalChannels.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="pref-row">
                    <div>
                      <div className="pref-title">Guard Rails</div>
                      <div className="pref-sub">0 or undefined maps to -120 dB</div>
                    </div>
                    <button
                      className="btn primary"
                      onClick={() => {
                        addMath();
                        setShowAdd(false);
                      }}
                    >
                      Add Virtual Channel
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import LiveChart from '@/components/LiveChart';
import { DeviceStatus, gainDisplayLabel, sendControl, subscribeStream } from '@/coredaqClient';
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

  const [seriesByChannel, setSeriesByChannel] = useState<Record<string, ChannelSeries>>({});
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

    setSeriesByChannel((prev) => {
      const next: Record<string, ChannelSeries> = {};
      for (const p of physicalChannels) {
        next[p.id] = prev[p.id] || emptySeries();
      }
      return next;
    });

    setSrcA((prev) => (prev && physIds.has(prev) ? prev : physicalChannels[0]?.id || ''));
    setSrcB((prev) => {
      if (prev && physIds.has(prev)) return prev;
      if (physicalChannels.length > 1) return physicalChannels[1].id;
      return physicalChannels[0]?.id || '';
    });
  }, [physicalChannels]);

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
    const unsub = subscribeStream((msg) => {
      if (!msg.device_id || !Array.isArray(msg.ch) || msg.ch.length < 4) return;
      if (typeof msg.ts !== 'number' || !Number.isFinite(msg.ts)) return;

      if (!t0Ref.current[msg.device_id]) {
        t0Ref.current[msg.device_id] = msg.ts;
      }
      const relT = msg.ts - t0Ref.current[msg.device_id];

      setSeriesByChannel((prev) => {
        const next = { ...prev };
        let touched = false;
        for (let i = 0; i < 4; i += 1) {
          const key = physicalChannelId(msg.device_id as string, i);
          const oldSeries = prev[key] || emptySeries();
          const nextX = [...oldSeries.x, relT];
          const nextY = [...oldSeries.y, Number(msg.ch[i] ?? 0)];
          const minT = relT - Math.max(0.2, windowSeconds);
          let drop = 0;
          while (drop < nextX.length && nextX[drop] < minT) drop += 1;
          if (drop > 0) {
            nextX.splice(0, drop);
            nextY.splice(0, drop);
          }
          if (nextX.length > maxPoints) {
            const extra = nextX.length - maxPoints;
            nextX.splice(0, extra);
            nextY.splice(0, extra);
          }
          next[key] = { x: nextX, y: nextY };
          touched = true;
        }
        return touched ? next : prev;
      });
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

  useEffect(() => {
    setWavelengthInput(formatWavelengthInput(wavelengthNm));
  }, [activeDevice?.device_id, wavelengthNm]);

  const applyWavelength = () => {
    if (!activeDevice) return;
    const parsed = Number(wavelengthInput);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setWavelengthInput(formatWavelengthInput(wavelengthNm));
      return;
    }
    sendControl({
      action: 'set_wavelength',
      device_id: activeDevice.device_id,
      wavelength_nm: parsed,
    });
  };

  useEffect(() => {
    if (!activeDevice) return;
    sendControl({ action: 'set_freq', device_id: activeDevice.device_id, freq_hz: 500 });
  }, [activeDevice?.device_id]);

  const updateGain = (idx: number, val: number) => {
    if (!activeDevice || !activeIsLinear) return;
    sendControl({ action: 'set_gain', device_id: activeDevice.device_id, head: idx + 1, gain: val });
  };

  const computeMath = (def: ChannelDef): ChannelSeries => {
    const a = def.srcA ? seriesByChannel[def.srcA] : undefined;
    const b = def.srcB ? seriesByChannel[def.srcB] : undefined;
    if (!a || !b) return emptySeries();

    const len = Math.min(a.y.length, b.y.length);
    if (len <= 0) return emptySeries();

    const aY = a.y.slice(-len);
    const bY = b.y.slice(-len);
    const xBase = (a.x.length <= b.x.length ? a.x : b.x).slice(-len);
    const out = new Array(len);

    for (let i = 0; i < len; i += 1) {
      const va = aY[i];
      const vb = bY[i];
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
          out[i] = den === 0 || num === 0 ? -120 : 10 * Math.log10(num / den);
          break;
        }
        default:
          out[i] = 0;
      }
    }

    return { x: xBase, y: out };
  };

  const activeSeries = useMemo(() => {
    return active.map((def) => {
      if (def.type === 'physical') {
        const base = seriesByChannel[def.id] || emptySeries();
        return { ...def, x: base.x, y: base.y };
      }
      const math = computeMath(def);
      return { ...def, x: math.x, y: math.y };
    });
  }, [active, seriesByChannel]);

  const displaySeries = useMemo(() => {
    return activeSeries.map((def) => {
      if (def.type === 'math' && def.mathType === 'db') {
        return { ...def, unit: 'dB', displayY: def.y };
      }
      const scale = pickPowerScale(def.y);
      return {
        ...def,
        unit: scale.unit,
        displayY: def.y.map((v) => v * scale.factor),
      };
    });
  }, [activeSeries]);

  const clearSeries = () => {
    t0Ref.current = {};
    setSeriesByChannel((prev) => {
      const next: Record<string, ChannelSeries> = {};
      for (const key of Object.keys(prev)) {
        next[key] = emptySeries();
      }
      return next;
    });
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
          <button className="btn ghost" onClick={() => setShowAdd(true)}>
            Add Channel
          </button>
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
                    Ã—
                  </button>
                </div>
                <LiveChart
                  x={ch.x}
                  series={[{ name: ch.name, color: ch.color, data: ch.displayY }]}
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
                ? `${activeDevice.device_id} â€¢ ${activeDevice.frontend_type || 'UNKNOWN'} â€¢ ${detectorType}`
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
            <div className="stat-hint">
              Range {Math.round(wavelengthMinNm)}-{Math.round(wavelengthMaxNm)} nm
              {' â€¢ '}
              default 1550 nm
            </div>
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


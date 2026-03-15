import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CaptureMiniChart from '@/components/CaptureMiniChart';
import { DeviceStatus, gainDisplayLabel, sendControl, subscribeControl, subscribeStatus } from '@/coredaqClient';
import { VirtualChannelDef, VirtualMathType, parsePhysicalSourceId, physicalSourceId } from '@/virtualChannels';

type Props = {
  connected: boolean;
  devices: DeviceStatus[];
  activeDeviceId: string | null;
  virtualChannels: VirtualChannelDef[];
  onAddVirtualChannel: (input: { mathType: VirtualMathType; srcA: string; srcB: string; name: string }) => void;
  onRemoveVirtualChannel: (virtualId: string) => void;
};

type Point = [number, number];

type ChannelDef = {
  id: string;
  type: 'physical' | 'math';
  name: string;
  color: string;
  srcA?: number;
  srcB?: number;
  mathType?: VirtualMathType;
  virtualId?: string;
};

type ActiveSeries = ChannelDef & {
  points: Point[];
  unit: string;
};

type PowerScale = { factor: number; unit: string };

type GpibResource = {
  resource: string;
  idn?: string | null;
  model?: string | null;
  backend?: string | null;
};

type LogLine = {
  ts: string;
  text: string;
};

const PHYS_CHANNELS = [
  { id: 'ch1', name: 'CH1', color: '#4DD0E1' },
  { id: 'ch2', name: 'CH2', color: '#FFB454' },
  { id: 'ch3', name: 'CH3', color: '#7BE7A1' },
  { id: 'ch4', name: 'CH4', color: '#FF7AA2' },
];

const SAMPLE_RATE_DEFAULT = 50_000;
const SAMPLE_RATE_MIN = 1;
const SAMPLE_RATE_MAX = 100_000;
const OS_IDX_MIN = 0;
const OS_IDX_MAX = 6;
const SWEEP_PREVIEW_POINTS_DEFAULT = 120_000;
const DEFAULT_SWEEP_MASK = 0x0f;
const DEFAULT_TSL_START_NM = 1500;
const DEFAULT_TSL_STOP_NM = 1600;
const DEFAULT_VISIBLE_START_NM = 770;
const DEFAULT_VISIBLE_STOP_NM = 780;
const DEFAULT_VISIBLE_MIN_NM = 765;
const DEFAULT_VISIBLE_MAX_NM = 781;
const DEFAULT_VISIBLE_POINT_COUNT = 201;
const DEFAULT_VISIBLE_SETTLE_MS = 500;
const DEFAULT_VISIBLE_AVERAGE_MS = 100;
const CAPTURE_SELECTED_RESOURCE_KEY = 'coreconsole.capture.selected_resource';
const DETECTOR_NOMINAL_LIMITS: Record<string, [number, number]> = {
  INGAAS: [910, 1700],
  SILICON: [400, 1100],
};

type LaserSweepProfile = {
  family: 'tsl' | 'visible' | 'unknown';
  model: string | null;
  minNm: number | null;
  maxNm: number | null;
  defaultStartNm: number;
  defaultStopNm: number;
};

function loadPersistedSelectedResource(): string {
  try {
    return String(window.localStorage.getItem(CAPTURE_SELECTED_RESOURCE_KEY) || '').trim();
  } catch (_) {
    return '';
  }
}

const captureSessionCache: {
  resources: GpibResource[];
  selectedResource: string;
  gpibModel: string | null;
  sample_rate_hz: number | null;
  os_idx: number | null;
} = {
  resources: [],
  selectedResource: '',
  gpibModel: null,
  sample_rate_hz: null,
  os_idx: null,
};

function tsNow(): string {
  return new Date().toLocaleTimeString();
}

function clampSampleRate(value: number): number {
  if (!Number.isFinite(value)) return SAMPLE_RATE_DEFAULT;
  return Math.min(SAMPLE_RATE_MAX, Math.max(SAMPLE_RATE_MIN, Math.round(value)));
}

function maxFreqForOs(osIdx: number): number {
  if (osIdx <= 1) return 100_000;
  return Math.floor(100_000 / 2 ** (osIdx - 1));
}

function maxOsForFreq(freqHz: number): number {
  const hz = clampSampleRate(freqHz);
  let best = OS_IDX_MIN;
  for (let os = OS_IDX_MIN; os <= OS_IDX_MAX; os += 1) {
    if (hz <= maxFreqForOs(os)) best = os;
    else break;
  }
  return best;
}

function userFacingSweepError(raw: string): string {
  const t = (raw || '').toLowerCase();
  if (t.includes('no gpib resource selected') || t.includes('no gpib resource provided')) {
    return 'No laser resource selected. Click Scan Resources, select a resource, then run sweep.';
  }
  if (t.includes('visible step sweep requires a usb raw laser resource')) {
    return 'Visible step sweep needs a USB raw laser resource. Re-scan and select the TLB6700 USB controller entry.';
  }
  if (t.includes('usb raw backend not supported') || t.includes('winusb/libusb') || t.includes('usbdk')) {
    return 'Visible laser USB control is not available with the current Windows driver. Bind the controller to WinUSB/libusb or enable UsbDK, then re-scan.';
  }
  if (t.includes('not found or not responding on visa resource') || t.includes('not found or not responding on ftdi resource')) {
    return raw;
  }
  if (t.includes('unsupported laser model')) {
    return raw;
  }
  if (t.includes('not connected')) {
    return 'CoreDAQ is not connected.';
  }
  return raw || 'Sweep failed.';
}

function detectLaserModelFromIdn(idnRaw: string): string | null {
  const t = String(idnRaw || '').toUpperCase();
  if (t.includes('TSL550') || (t.includes('SANTEC') && t.includes('550'))) return 'TSL550';
  if (t.includes('TSL570') || (t.includes('SANTEC') && t.includes('570'))) return 'TSL570';
  if (t.includes('TSL710') || (t.includes('SANTEC') && t.includes('710'))) return 'TSL710';
  if (t.includes('TSL770') || (t.includes('SANTEC') && t.includes('770'))) return 'TSL770';
  return null;
}

function detectVisibleLaserModel(raw: string): string | null {
  const t = String(raw || '').toUpperCase();
  if (!t) return null;
  if (t.includes('TLB6700')) return 'TLB6700';
  if (t.includes('TLB-6700')) return 'TLB6700';
  if (t.includes('TLB 6700')) return 'TLB6700';
  if (t.includes('NEW_FOCUS') && t.includes('6700')) return 'TLB6700';
  if (t.includes('NEW FOCUS') && t.includes('6700')) return 'TLB6700';
  if (t.includes('TLB')) return 'TLB6700';
  return null;
}

function approxEq(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

function sweepLooksLikeKnownDefault(startNm: number, stopNm: number): boolean {
  return (
    (approxEq(startNm, DEFAULT_TSL_START_NM) && approxEq(stopNm, DEFAULT_TSL_STOP_NM))
    || (approxEq(startNm, DEFAULT_VISIBLE_START_NM) && approxEq(stopNm, DEFAULT_VISIBLE_STOP_NM))
  );
}

function resolveLaserSweepProfile(row: GpibResource | null, fallbackModel: string | null): LaserSweepProfile {
  const combined = [
    row?.model || '',
    row?.idn || '',
    fallbackModel || '',
    row?.resource || '',
  ].join(' ');

  const tslModel = detectLaserModelFromIdn(combined);
  if (tslModel) {
    return {
      family: 'tsl',
      model: tslModel,
      minNm: null,
      maxNm: null,
      defaultStartNm: DEFAULT_TSL_START_NM,
      defaultStopNm: DEFAULT_TSL_STOP_NM,
    };
  }

  const visibleModel = detectVisibleLaserModel(combined);
  if (visibleModel) {
    return {
      family: 'visible',
      model: visibleModel,
      minNm: DEFAULT_VISIBLE_MIN_NM,
      maxNm: DEFAULT_VISIBLE_MAX_NM,
      defaultStartNm: DEFAULT_VISIBLE_START_NM,
      defaultStopNm: DEFAULT_VISIBLE_STOP_NM,
    };
  }

  return {
    family: 'unknown',
    model: null,
    minNm: null,
    maxNm: null,
    defaultStartNm: DEFAULT_TSL_START_NM,
    defaultStopNm: DEFAULT_TSL_STOP_NM,
  };
}

function buildLaserRangeWarning(profile: LaserSweepProfile, startNm: number, stopNm: number): string | null {
  if (!(Number.isFinite(profile.minNm) && Number.isFinite(profile.maxNm))) return null;
  const lo = Math.min(startNm, stopNm);
  const hi = Math.max(startNm, stopNm);
  const minNm = Number(profile.minNm);
  const maxNm = Number(profile.maxNm);
  if (lo >= minNm && hi <= maxNm) return null;
  const modelLabel = profile.model || 'selected laser';
  return `Requested sweep range ${lo.toFixed(3)}-${hi.toFixed(3)} nm is outside the known ${modelLabel} range ${minNm.toFixed(3)}-${maxNm.toFixed(3)} nm.`;
}

function buildDetectorCompatibilityWarning(detectorType: string, startNm: number, stopNm: number): string | null {
  const limits = DETECTOR_NOMINAL_LIMITS[String(detectorType || '').toUpperCase()];
  if (!limits) return null;
  const lo = Math.min(startNm, stopNm);
  const hi = Math.max(startNm, stopNm);
  if (lo >= limits[0] && hi <= limits[1]) return null;
  return `Selected sweep range ${lo.toFixed(3)}-${hi.toFixed(3)} nm is outside the nominal ${String(detectorType).toUpperCase()} detector range ${limits[0]}-${limits[1]} nm. The sweep can still run, but optical signal may be invalid or absent.`;
}

function inferResourceBackend(resource: string): string {
  const txt = String(resource || '').trim().toUpperCase();
  if (txt.startsWith('USBRAW::')) return 'usb-raw';
  if (txt.startsWith('FTDI::')) return 'ftdi-serial';
  return 'visa-service';
}

function formatFrontendLabel(frontend: string | null | undefined): string {
  const t = String(frontend || '').toUpperCase();
  if (t === 'LINEAR') return 'Linear';
  if (t === 'LOG') return 'Log';
  return 'Unknown';
}

function mergeResourceRows(prev: GpibResource[], nextRows: GpibResource[]): GpibResource[] {
  const map = new Map<string, GpibResource>();
  const ingest = (row: GpibResource) => {
    const resource = String(row?.resource || '').trim();
    if (!resource) return;
    const prior = map.get(resource);
    const merged: GpibResource = {
      resource,
      idn: row.idn ?? prior?.idn ?? null,
      model: row.model ?? prior?.model ?? null,
      backend: row.backend ?? prior?.backend ?? null,
    };
    map.set(resource, merged);
  };

  for (const row of prev || []) ingest(row);
  for (const row of nextRows || []) ingest(row);

  return [...map.values()].sort((a, b) => a.resource.localeCompare(b.resource));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  const timeoutMs = Math.max(1, Math.round(Number(ms) || 1));
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (err) => {
        window.clearTimeout(t);
        reject(err);
      }
    );
  });
}

function channelIndexFromId(id: string): number | null {
  if (id === 'ch1') return 0;
  if (id === 'ch2') return 1;
  if (id === 'ch3') return 2;
  if (id === 'ch4') return 3;
  return null;
}

function buildSweepMask(channels: ChannelDef[]): number {
  let mask = 0;
  for (const ch of channels) {
    if (ch.type === 'physical') {
      const idx = channelIndexFromId(ch.id);
      if (idx !== null) mask |= 1 << idx;
      continue;
    }
    if (typeof ch.srcA === 'number' && ch.srcA >= 0 && ch.srcA < 4) mask |= 1 << ch.srcA;
    if (typeof ch.srcB === 'number' && ch.srcB >= 0 && ch.srcB < 4) mask |= 1 << ch.srcB;
  }
  return mask === 0 ? DEFAULT_SWEEP_MASK : mask & 0x0f;
}

function buildSaveMask(channels: ChannelDef[]): number {
  let mask = 0;
  for (const ch of channels) {
    if (ch.type !== 'physical') continue;
    const idx = channelIndexFromId(ch.id);
    if (idx !== null) mask |= 1 << idx;
  }
  return mask & 0x0f;
}


function pickPowerScale(dataW: number[]): PowerScale {
  let maxAbs = 0;
  for (const v of dataW) {
    const a = Math.abs(v);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs >= 1) return { factor: 1, unit: 'W' };
  if (maxAbs >= 1e-3) return { factor: 1e3, unit: 'mW' };
  if (maxAbs >= 1e-6) return { factor: 1e6, unit: 'uW' };
  if (maxAbs >= 1e-9) return { factor: 1e9, unit: 'nW' };
  return { factor: 1e12, unit: 'pW' };
}

export default function CaptureTab({
  connected,
  devices,
  activeDeviceId,
  virtualChannels,
  onAddVirtualChannel,
  onRemoveVirtualChannel,
}: Props) {
  const sortedDevices = useMemo(
    () => [...devices].sort((a, b) => a.device_id.localeCompare(b.device_id)),
    [devices]
  );

  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const selectedDevice = useMemo(
    () => sortedDevices.find((d) => d.device_id === selectedDeviceId) || null,
    [selectedDeviceId, sortedDevices]
  );
  const selectedDeviceDisplay = useMemo(() => {
    if (!selectedDevice) return 'No device selected';
    const port = String(selectedDevice.port || '').trim() || selectedDevice.device_id;
    return `${port} Device ${formatFrontendLabel(selectedDevice.frontend_type)}`;
  }, [selectedDevice]);
  const selectedIsLinear = selectedDevice?.frontend_type === 'LINEAR';
  const selectedDetectorType = (selectedDevice?.detector_type || 'INGAAS').toString().toUpperCase();


  useEffect(() => {
    if (activeDeviceId && sortedDevices.some((d) => d.device_id === activeDeviceId)) {
      setSelectedDeviceId(activeDeviceId);
      return;
    }
    setSelectedDeviceId((prev) => {
      if (prev && sortedDevices.some((d) => d.device_id === prev)) return prev;
      return sortedDevices[0]?.device_id || '';
    });
  }, [activeDeviceId, sortedDevices]);

  const [resources, setResources] = useState<GpibResource[]>(() => captureSessionCache.resources);
  const [selectedResource, setSelectedResource] = useState(() => {
    const cached = String(captureSessionCache.selectedResource || '').trim();
    if (cached) return cached;
    const persisted = loadPersistedSelectedResource();
    if (persisted) {
      captureSessionCache.selectedResource = persisted;
      return persisted;
    }
    return '';
  });
  const [captureState, setCaptureState] = useState('idle');
  const [captureMessage, setCaptureMessage] = useState('');
  const [gpibModel, setGpibModel] = useState<string | null>(() => captureSessionCache.gpibModel);
  const [gpibCmd, setGpibCmd] = useState('*IDN?');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [scanWarnings, setScanWarnings] = useState<string[]>([]);

  const [startNm, setStartNm] = useState(DEFAULT_TSL_START_NM);
  const [stopNm, setStopNm] = useState(DEFAULT_TSL_STOP_NM);
  const [speedNmS, setSpeedNmS] = useState(50);
  const [powerMw, setPowerMw] = useState(1);
  const [visiblePointCount, setVisiblePointCount] = useState(DEFAULT_VISIBLE_POINT_COUNT);
  const [visibleSettleMs, setVisibleSettleMs] = useState(DEFAULT_VISIBLE_SETTLE_MS);
  const [visibleAverageMs, setVisibleAverageMs] = useState(DEFAULT_VISIBLE_AVERAGE_MS);
  const [sampleRateHz, setSampleRateHz] = useState(() => captureSessionCache.sample_rate_hz ?? SAMPLE_RATE_DEFAULT);
  const [osIdx, setOsIdx] = useState(() => captureSessionCache.os_idx ?? 0);

  useEffect(() => {
    captureSessionCache.sample_rate_hz = sampleRateHz;
  }, [sampleRateHz]);

  useEffect(() => {
    captureSessionCache.os_idx = osIdx;
  }, [osIdx]);

  const [gains, setGains] = useState([0, 0, 0, 0]);
  const seededDeviceIdRef = useRef<string>('');

  const [sweepX, setSweepX] = useState<number[]>([]);
  const [physY, setPhysY] = useState<number[][]>([[], [], [], []]); // stored in W
  const [physScale, setPhysScale] = useState<PowerScale[]>([
    pickPowerScale([]),
    pickPowerScale([]),
    pickPowerScale([]),
    pickPowerScale([]),
  ]);
  const [samplesTotal, setSamplesTotal] = useState<number | null>(null);
  const [hasSweepData, setHasSweepData] = useState(false);
  const [running, setRunning] = useState(false);
  const [runningDeviceId, setRunningDeviceId] = useState<string | null>(null);
  const [scanningVisa, setScanningVisa] = useState(false);
  const [scanProgressPct, setScanProgressPct] = useState(0);

  const [active, setActive] = useState<ChannelDef[]>(() =>
    PHYS_CHANNELS.map((c) => ({ ...c, type: 'physical' }))
  );
  const [dragId, setDragId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addType, setAddType] = useState<'physical' | 'math'>('physical');
  const [mathType, setMathType] = useState<VirtualMathType>('db');
  const [srcA, setSrcA] = useState(0);
  const [srcB, setSrcB] = useState(1);
  const setSelectedResourceCached = useCallback((resource: string) => {
    const value = String(resource || '').trim();
    captureSessionCache.selectedResource = value;
    setSelectedResource(value);
  }, []);
  const setGpibModelCached = useCallback((model: string | null) => {
    const value = model && String(model).trim().length > 0 ? String(model).trim() : null;
    captureSessionCache.gpibModel = value;
    setGpibModel(value);
  }, []);
  const setResourcesSnapshot = useCallback((rows: GpibResource[]) => {
    setResources(() => {
      const next = mergeResourceRows([], rows);
      captureSessionCache.resources = next;
      return next;
    });
  }, []);
  const upsertResource = useCallback((row: GpibResource) => {
    setResources((prev) => {
      const merged = mergeResourceRows(prev, [row]);
      captureSessionCache.resources = merged;
      return merged;
    });
  }, []);

  const selectedResourceRow = useMemo(
    () => resources.find((r) => r.resource === selectedResource) || null,
    [resources, selectedResource]
  );
  const selectedLaserProfile = useMemo(
    () => resolveLaserSweepProfile(selectedResourceRow, gpibModel),
    [selectedResourceRow, gpibModel]
  );

  useEffect(() => {
    if (!selectedDeviceId) return;
    sendControl({
      action: 'set_freq',
      device_id: selectedDeviceId,
      freq_hz: clampSampleRate(sampleRateHz),
      os_idx: osIdx,
    });
  }, [selectedDeviceId, sampleRateHz, osIdx]);

  const maxOsIdxForRate = useMemo(() => maxOsForFreq(sampleRateHz), [sampleRateHz]);
  const selectedVirtualDefs = useMemo<ChannelDef[]>(() => {
    if (!selectedDeviceId) return [];
    const out: ChannelDef[] = [];
    for (const v of virtualChannels) {
      const a = parsePhysicalSourceId(v.srcA);
      const b = parsePhysicalSourceId(v.srcB);
      if (!a || !b) continue;
      if (a.deviceId !== selectedDeviceId || b.deviceId !== selectedDeviceId) continue;
      out.push({
        id: `virtual-${v.id}`,
        virtualId: v.id,
        type: 'math',
        name: v.name,
        color: v.color,
        srcA: a.channelIndex,
        srcB: b.channelIndex,
        mathType: v.mathType,
      });
    }
    return out;
  }, [selectedDeviceId, virtualChannels]);

  useEffect(() => {
    if (!selectedDevice) {
      seededDeviceIdRef.current = '';
      return;
    }
    if (seededDeviceIdRef.current === selectedDevice.device_id) {
      return;
    }
    seededDeviceIdRef.current = selectedDevice.device_id;
    if (
      selectedDevice.frontend_type === 'LINEAR'
      && Array.isArray(selectedDevice.gains)
      && selectedDevice.gains.length >= 4
    ) {
      setGains(selectedDevice.gains.slice(0, 4).map((v) => Number(v) || 0));
    }
  }, [selectedDevice]);

  useEffect(() => {
    if (osIdx > maxOsIdxForRate) {
      setOsIdx(maxOsIdxForRate);
    }
  }, [osIdx, maxOsIdxForRate]);

  useEffect(() => {
    if (!selectedResource) return;
    if (resources.some((r) => r.resource === selectedResource)) return;
    upsertResource({
      resource: selectedResource,
      model: gpibModel,
      backend: inferResourceBackend(selectedResource),
    });
  }, [gpibModel, resources, selectedResource, upsertResource]);

  useEffect(() => {
    setActive((prev) => {
      const physical = prev.filter((c) => c.type === 'physical');
      return [...physical, ...selectedVirtualDefs];
    });
  }, [selectedVirtualDefs]);

  const addLog = useCallback((text: string) => {
    setLogs((prev) => [...prev.slice(-199), { ts: tsNow(), text }]);
  }, []);

  useEffect(() => {
    if (!selectedResource) return;
    if (!sweepLooksLikeKnownDefault(startNm, stopNm)) return;
    const nextStart = selectedLaserProfile.defaultStartNm;
    const nextStop = selectedLaserProfile.defaultStopNm;
    if (approxEq(startNm, nextStart) && approxEq(stopNm, nextStop)) return;
    setStartNm(nextStart);
    setStopNm(nextStop);
    if (selectedLaserProfile.family === 'visible') {
      addLog(`Visible laser defaults applied: ${nextStart.toFixed(3)}-${nextStop.toFixed(3)} nm.`);
    }
  }, [
    selectedResource,
    selectedLaserProfile.defaultStartNm,
    selectedLaserProfile.defaultStopNm,
    selectedLaserProfile.family,
    startNm,
    stopNm,
    addLog,
  ]);

  const warnUser = (message: string) => {
    addLog(message);
    window.alert(message);
  };

  const estimate = useMemo(() => {
    const span = Math.abs(stopNm - startNm);
    if (selectedLaserProfile.family === 'visible') {
      const points = Math.max(1, Math.round(Number(visiblePointCount) || DEFAULT_VISIBLE_POINT_COUNT));
      const settleMs = Math.max(0, Math.round(Number(visibleSettleMs) || 0));
      const averageMs = Math.max(1, Math.round(Number(visibleAverageMs) || DEFAULT_VISIBLE_AVERAGE_MS));
      const duration = points * ((settleMs + averageMs) / 1000.0);
      const resolutionPm = points > 1 ? (span / (points - 1)) * 1000.0 : null;
      return { duration, samples: points, span, resolutionPm, sampleLabel: 'points' };
    }
    const duration = speedNmS > 0 ? span / speedNmS : 0;
    const samples = Math.max(1, Math.round(duration * sampleRateHz));
    const resolutionPm = speedNmS > 0 && sampleRateHz > 0
      ? (speedNmS / sampleRateHz) * 1000.0
      : null;
    return { duration, samples, span, resolutionPm, sampleLabel: 'samples' };
  }, [
    startNm,
    stopNm,
    speedNmS,
    sampleRateHz,
    selectedLaserProfile.family,
    visiblePointCount,
    visibleSettleMs,
    visibleAverageMs,
  ]);

  useEffect(() => {
    if (!scanningVisa) return () => undefined;
    const started = performance.now();
    setScanProgressPct(8);
    const id = window.setInterval(() => {
      const elapsed = performance.now() - started;
      const pct = Math.min(95, 8 + (elapsed / 5000) * 87);
      setScanProgressPct(pct);
    }, 80);
    return () => window.clearInterval(id);
  }, [scanningVisa, addLog]);

  useEffect(() => {
    const unsubStatus = subscribeStatus((s) => {
      if (typeof s.gpib_resource === 'string' && s.gpib_resource.length > 0) {
        const model = typeof s.gpib_model === 'string' && s.gpib_model.length > 0 ? s.gpib_model : null;
        const idn = typeof s.gpib_idn === 'string' && s.gpib_idn.length > 0 ? s.gpib_idn : null;
        setSelectedResourceCached(s.gpib_resource);
        upsertResource({
          resource: s.gpib_resource,
          idn,
          model,
          backend: inferResourceBackend(s.gpib_resource),
        });
      }
      if (typeof s.gpib_model === 'string' && s.gpib_model.length > 0) {
        setGpibModelCached(s.gpib_model);
      }
      setCaptureState(typeof s.capture_state === 'string' ? s.capture_state : 'idle');
      setCaptureMessage(typeof s.capture_message === 'string' ? s.capture_message : '');
    });

    const unsubControl = subscribeControl((msg) => {
      if (!msg.action) return;

      if (msg.action === 'gpib_scan') {
        setScanningVisa(false);
        setScanProgressPct(100);
        window.setTimeout(() => setScanProgressPct(0), 250);
        if (msg.ok) {
          const rows = Array.isArray(msg.resources) ? (msg.resources as GpibResource[]) : [];
          setResourcesSnapshot(rows);
          addLog(`Laser scan complete: ${rows.length} resource(s)`);
          if (msg.timed_out) {
            addLog('Laser scan reached timeout; showing partial results.');
          }

          const warnings = Array.isArray(msg.warnings) ? (msg.warnings as unknown[]) : [];
          setScanWarnings(warnings.map((w) => String(w)));
          for (const w of warnings) {
            addLog(`Warning: ${String(w)}`);
          }

          const debugRows = Array.isArray(msg.debug) ? (msg.debug as unknown[]) : [];
          for (const d of debugRows) {
            addLog(`LASER IO: ${String(d)}`);
          }
          if (rows.length === 0) {
            const backendExe = String(msg.node_exe ?? msg.python_exe ?? 'unknown');
            const hint = String(msg.backend ?? 'mixed');
            addLog(`No laser resources found. Backend=${hint}, Runtime=${backendExe}`);
          }
        } else {
          setScanWarnings([]);
          addLog(`Laser scan error: ${String(msg.error ?? 'Unknown')}`);
        }
        return;
      }
      if (msg.action === 'gpib_query') {
        if (msg.ok) {
          const cmd = String(msg.command ?? '');
          const reply = String(msg.reply ?? '');
          const model = (msg.model as string | null | undefined) ?? null;
          const resource = String(msg.resource ?? '').trim();
          addLog(`${cmd} -> ${reply}`);
          if (model) setGpibModelCached(model);
          if (resource) {
            upsertResource({
              resource,
              idn: cmd.toUpperCase() === '*IDN?' || cmd.toUpperCase() === 'IDN?' ? reply : undefined,
              model: cmd.toUpperCase() === '*IDN?' || cmd.toUpperCase() === 'IDN?' ? model : undefined,
              backend: String(msg.backend ?? inferResourceBackend(resource)),
            });
          }
        } else {
          addLog(`GPIB query error: ${String(msg.error ?? 'Unknown')}`);
        }
        return;
      }

      if (msg.action === 'gpib_select') {
        if (msg.ok) {
          const resource = String(msg.resource ?? '').trim();
          if (resource) {
            const idn = typeof msg.idn === 'string' && msg.idn.length > 0 ? msg.idn : null;
            const model = typeof msg.model === 'string' && msg.model.length > 0 ? msg.model : null;
            setSelectedResourceCached(resource);
            if (model) setGpibModelCached(model);
            upsertResource({ resource, idn, model, backend: String(msg.backend ?? inferResourceBackend(resource)) });
          }
        }
        return;
      }

      if (msg.action === 'sweep_run') {
        const msgDeviceId = typeof msg.device_id === 'string' ? msg.device_id : null;
        if (runningDeviceId && msgDeviceId && msgDeviceId !== runningDeviceId) return;

        setRunning(false);
        setRunningDeviceId(null);
        if (!msg.ok) {
          setHasSweepData(false);
          const friendly = userFacingSweepError(String(msg.error ?? 'Unknown'));
          warnUser(friendly);
          return;
        }

        const n = Number(msg.samples_total ?? 0);
        setSamplesTotal(Number.isFinite(n) ? n : null);
        const resultLabel = String(msg.sweep_mode ?? '') === 'step-visible' ? 'points' : 'samples';
        addLog(`Sweep complete: ${n} ${resultLabel}`);
        const effectiveRate = Number(msg.sample_rate_hz);
        if (Number.isFinite(effectiveRate) && effectiveRate > 0) {
        }
        const effectiveOs = Number(msg.os_idx);
        if (Number.isFinite(effectiveOs) && effectiveOs >= OS_IDX_MIN) {
          setOsIdx(Math.min(OS_IDX_MAX, Math.round(effectiveOs)));
        }
        const requestedOs = Number(msg.os_idx_requested);
        if (Number.isFinite(requestedOs) && Number.isFinite(effectiveOs) && requestedOs !== effectiveOs) {
          addLog(`Oversampling request ${requestedOs} adjusted to ${effectiveOs} for selected sample rate.`);
        }

        const series = Array.isArray(msg.series) ? (msg.series as Array<{ data?: unknown }>) : [];
        const channelsW = Array.isArray(msg.channels_w) ? (msg.channels_w as unknown[]) : [];
        const nextX: number[] = [];
        const nextY: number[][] = [[], [], [], []];
        const nextScale: PowerScale[] = [
          pickPowerScale([]),
          pickPowerScale([]),
          pickPowerScale([]),
          pickPowerScale([]),
        ];

        for (let ch = 0; ch < 4; ch += 1) {
          const data = Array.isArray(series[ch]?.data) ? (series[ch]?.data as unknown[]) : [];
          const pts: Point[] = [];
          for (const p of data) {
            if (!Array.isArray(p) || p.length < 2) continue;
            const x = Number(p[0]);
            const y = Number(p[1]);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            pts.push([x, y]);
          }

          if (ch === 0) {
            for (const p of pts) nextX.push(p[0]);
          }
          for (const p of pts) nextY[ch].push(p[1]);
          if (Array.isArray(channelsW[ch])) {
            const raw = (channelsW[ch] as number[]).map((v) => Number(v) || 0);
            nextScale[ch] = pickPowerScale(raw);
          } else {
            nextScale[ch] = pickPowerScale(nextY[ch]);
          }
        }

        setSweepX(nextX);
        setPhysY(nextY);
        setPhysScale(nextScale);
        setHasSweepData(true);
        return;
      }

      if (msg.action === 'sweep_save_h5') {
        if (msg.ok) {
          const p = String(msg.path ?? '');
          addLog(`Saved sweep H5: ${p}`);
        } else {
          warnUser(`Save H5 error: ${String(msg.error ?? 'Unknown')}`);
        }
      }
    });

    return () => {
      unsubStatus();
      unsubControl();
    };
  }, [runningDeviceId, setGpibModelCached, setResourcesSnapshot, setSelectedResourceCached, upsertResource, addLog]);

  const doScan = async () => {
    if (scanningVisa) return;
    setScanningVisa(true);
    setScanProgressPct(4);
    setScanWarnings([]);
    sendControl({ action: 'gpib_scan', timeout_ms: 12000 });
  };
  const doQuery = async () => {
    const cmd = gpibCmd.trim();
    if (!cmd) return;
    if (!selectedResource) {
      addLog('Select a laser resource first.');
      return;
    }
    sendControl({ action: 'gpib_query', resource: selectedResource, cmd });
  };
  const doRunSweep = () => {
    if (!connected || sortedDevices.length === 0) {
      warnUser('CoreDAQ not connected.');
      return;
    }
    if (!selectedDeviceId || !selectedDevice) {
      warnUser('No target device selected.');
      return;
    }
    if (selectedDevice.busy) {
      warnUser(`Device ${selectedDevice.device_id} is busy.`);
      return;
    }
    if (!selectedResource) {
      warnUser('No laser resource selected. Click Scan Resources, select a resource, then run sweep.');
      return;
    }
    if (selectedResourceRow && (!selectedResourceRow.idn || String(selectedResourceRow.idn).trim().length === 0)) {
      addLog('Selected resource has no cached IDN response. Backend will verify at sweep start.');
    }
    const selectedModel = (selectedResourceRow?.model || gpibModel || '').toString().toUpperCase();
    if (!selectedModel) {
      addLog('Laser model not cached. Backend will detect model at sweep start.');
    }

    const preflightWarnings = [
      buildLaserRangeWarning(selectedLaserProfile, startNm, stopNm),
      buildDetectorCompatibilityWarning(selectedDetectorType, startNm, stopNm),
    ].filter((msg): msg is string => Boolean(msg));
    if (preflightWarnings.length > 0) {
      for (const warning of preflightWarnings) addLog(`Warning: ${warning}`);
      const proceed = window.confirm(`${preflightWarnings.join('\n\n')}\n\nContinue anyway?`);
      if (!proceed) return;
    }

    const clampedRate = clampSampleRate(sampleRateHz);
    const clampedOsIdx = Math.min(osIdx, maxOsForFreq(clampedRate));
    if (clampedOsIdx !== osIdx) {
      setOsIdx(clampedOsIdx);
      addLog(`Oversampling index limited to ${clampedOsIdx} for ${clampedRate.toLocaleString()} Hz.`);
    }
    if (selectedDetectorType === 'INGAAS') {
      addLog('Sweep conversion fixed to 1550 nm for InGaAs (relative correction disabled).');
    }

    setRunning(true);
    setRunningDeviceId(selectedDeviceId);
    setSamplesTotal(null);
    setSweepX([]);
    setPhysY([[], [], [], []]);
    setHasSweepData(false);
    addLog(`${selectedLaserProfile.family === 'visible' ? 'Starting visible step sweep' : 'Starting sweep'} on ${selectedDeviceId}...`);

    const channelMask = buildSweepMask(active);
    const saveChannelMask = buildSaveMask(active);
    const isVisibleSweep = selectedLaserProfile.family === 'visible';
    const params: Record<string, unknown> = {
      start_nm: startNm,
      stop_nm: stopNm,
      power_mw: powerMw,
      return_wavelength_nm: isVisibleSweep
        ? startNm
        : ((typeof selectedDevice?.wavelength_nm === 'number' && Number.isFinite(selectedDevice.wavelength_nm)) ? selectedDevice.wavelength_nm : 1550.0),
      sample_rate_hz: clampedRate,
      os_idx: clampedOsIdx,
      channel_mask: channelMask,
      save_channel_mask: saveChannelMask,
      virtual_channels: selectedVirtualDefs.map((v) => ({
        name: v.name,
        math: v.mathType || 'sum',
        src: { a: v.srcA ?? 0, b: v.srcB ?? 0 },
        unit: v.mathType === 'db' ? 'dB' : 'W',
      })),
      preview_points: SWEEP_PREVIEW_POINTS_DEFAULT,
    };
    if (isVisibleSweep) {
      params.sweep_mode = 'step-visible';
      params.point_count = Math.max(1, Math.round(Number(visiblePointCount) || DEFAULT_VISIBLE_POINT_COUNT));
      params.step_settle_ms = Math.max(0, Math.round(Number(visibleSettleMs) || 0));
      params.average_ms = Math.max(1, Math.round(Number(visibleAverageMs) || DEFAULT_VISIBLE_AVERAGE_MS));
    } else {
      params.speed_nm_s = speedNmS;
    }
    if (selectedIsLinear) {
      params.gains = gains;
    }

    sendControl({
      action: 'sweep_run',
      device_id: selectedDeviceId,
      resource: selectedResource,
      params,
    });
  };

  const doSaveH5 = async () => {
    if (!hasSweepData) {
      warnUser('No sweep data to save. Run a sweep first, then save to H5.');
      return;
    }
    let path = '';
    const now = new Date();
    const defaultName = `coredaq_sweep_${now.getFullYear()}${String(now.getMonth() + 1).padStart(
      2,
      '0'
    )}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(
      now.getMinutes()
    ).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.h5`;

    try {
      if (window.coredaq?.pickSavePath) {
        const picked = await window.coredaq.pickSavePath(defaultName);
        if (picked?.canceled) {
          addLog('Save canceled.');
          return;
        }
        path = picked?.filePath || '';
      }
    } catch (err) {
      addLog(`Save dialog error: ${String(err)}`);
    }

    sendControl({ action: 'sweep_save_h5', path });
  };

  const computeMathRaw = (def: ChannelDef): number[] => {
    const a = def.srcA ?? 0;
    const b = def.srcB ?? 1;
    const arrA = physY[a] || [];
    const arrB = physY[b] || [];
    const len = Math.min(arrA.length, arrB.length);
    const out = new Array(len);
    for (let i = 0; i < len; i += 1) {
      const va = arrA[i];
      const vb = arrB[i];
      let v = 0;
      if (def.mathType === 'sum') v = va + vb;
      else if (def.mathType === 'diff') v = va - vb;
      else {
        const num = Math.abs(va);
        const den = Math.abs(vb);
        v = den === 0 || num === 0 ? -120 : 10 * Math.log10(num / den);
      }
      out[i] = v;
    }
    return out;
  };

  const activeSeries = useMemo<ActiveSeries[]>(() => {
    return active.map((def) => {
      if (def.type === 'physical') {
        const idx = PHYS_CHANNELS.findIndex((c) => c.id === def.id);
        const yRaw = idx >= 0 ? physY[idx] || [] : [];
        const len = Math.min(sweepX.length, yRaw.length);
        const yTrim = yRaw.slice(0, len);
        const xTrim = sweepX.slice(0, len);
        const scale = physScale[idx] ?? pickPowerScale(yTrim);
        const points: Point[] = new Array(len);
        for (let i = 0; i < len; i += 1) {
          points[i] = [xTrim[i], yTrim[i] * scale.factor];
        }
        return { ...def, points, unit: scale.unit };
      }

      const yRaw = computeMathRaw(def);
      const len = Math.min(sweepX.length, yRaw.length);
      const yTrim = yRaw.slice(0, len);
      const xTrim = sweepX.slice(0, len);
      if (def.mathType === 'db') {
        const points: Point[] = new Array(len);
        for (let i = 0; i < len; i += 1) points[i] = [xTrim[i], yTrim[i]];
        return { ...def, points, unit: 'dB' };
      }

      const scale = pickPowerScale(yTrim);
      const points: Point[] = new Array(len);
      for (let i = 0; i < len; i += 1) {
        points[i] = [xTrim[i], yTrim[i] * scale.factor];
      }
      return { ...def, points, unit: scale.unit };
    });
  }, [active, sweepX, physY, physScale]);

  const removeChannel = (id: string) =>
    setActive((prev) => {
      const target = prev.find((c) => c.id === id);
      if (target?.type === 'math' && target.virtualId) {
        onRemoveVirtualChannel(target.virtualId);
      }
      return prev.filter((c) => c.id !== id);
    });

  const addPhysical = (id: string) => {
    const def = PHYS_CHANNELS.find((c) => c.id === id);
    if (!def) return;
    setActive((prev) => [...prev, { ...def, type: 'physical' }]);
  };

  const addMath = () => {
    if (!selectedDeviceId) return;
    const name =
      mathType === 'db'
        ? `dB CH${srcA + 1}/CH${srcB + 1}`
        : mathType === 'diff'
          ? `CH${srcA + 1}-CH${srcB + 1}`
          : `CH${srcA + 1}+CH${srcB + 1}`;
    onAddVirtualChannel({
      name,
      mathType,
      srcA: physicalSourceId(selectedDeviceId, srcA),
      srcB: physicalSourceId(selectedDeviceId, srcB),
    });
  };

  return (
    <section className="capture-tab">
      <div className="live-header">
        <div>
          <div className="live-title">Spectrum Analyzer</div>
        </div>
        <div className={`capture-state ${captureState === 'running' ? 'run' : 'idle'}`}>
          {captureState === 'running' ? 'Running' : 'Idle'}
        </div>
      </div>

      <div className="capture-live-grid">
        <div className="panel capture-controls-panel">
          <div className="panel-header">
            <div className="panel-title">Sweep Control</div>
            <div className="panel-meta">{selectedDeviceDisplay}</div>
          </div>

          <div className="capture-fields">
            <div className="capture-toolbar">
              <button className="btn ghost" onClick={doScan} disabled={scanningVisa}>
                {scanningVisa ? 'Scanning...' : 'Scan Resources'}
              </button>
            </div>
            {scanningVisa && (
              <div className="scan-progress">
                <div className="scan-progress-bar" style={{ width: `${scanProgressPct}%` }} />
              </div>
            )}
            {scanWarnings.length > 0 && (
              <div className="device-note" role="alert">
                {scanWarnings.join(' | ')}
              </div>
            )}

            <div className="capture-field">
              <label className="capture-label">Target Device</label>
              <div className="capture-readonly">{selectedDeviceDisplay}</div>
            </div>
            <div className="capture-field">
              <label className="capture-label">Resource</label>
              <select
                className="capture-input"
                value={selectedResource}
                onChange={(e) => {
                  const v = e.target.value;
                  setSelectedResourceCached(v);
                  sendControl({ action: 'gpib_select', resource: v });
                }}
              >
                <option value="">Select...</option>
                {resources.map((r) => (
                  <option key={r.resource} value={r.resource}>
                    {r.resource}
                    {r.model ? ` (${r.model})` : ''}
                    {r.backend ? ` [${r.backend}]` : ''}
                  </option>
                ))}
              </select>
            </div>

            <div className="capture-field">
              <label className="capture-label">GPIB</label>
              <div className="capture-inline">
                <input
                  className="capture-input"
                  value={gpibCmd}
                  onChange={(e) => setGpibCmd(e.target.value)}
                  placeholder="*IDN?"
                />
                <button className="btn ghost" onClick={doQuery}>
                  Send
                </button>
              </div>
            </div>
            {selectedLaserProfile.family === 'visible' && (
              <div className="capture-hint">
                Visible laser profile active. Using fallback defaults {selectedLaserProfile.defaultStartNm.toFixed(0)}-
                {selectedLaserProfile.defaultStopNm.toFixed(0)} nm and nominal range {Number(selectedLaserProfile.minNm).toFixed(0)}-
                {Number(selectedLaserProfile.maxNm).toFixed(0)} nm unless the laser reports tighter limits later.
              </div>
            )}

            <div className="capture-grid-2">
              <div className="capture-field">
                <label className="capture-label">Start (nm)</label>
                <input
                  className="capture-input"
                  type="number"
                  min={selectedLaserProfile.minNm ?? undefined}
                  max={selectedLaserProfile.maxNm ?? undefined}
                  step="0.001"
                  value={startNm}
                  onChange={(e) => setStartNm(Number(e.target.value))}
                />
              </div>
              <div className="capture-field">
                <label className="capture-label">Stop (nm)</label>
                <input
                  className="capture-input"
                  type="number"
                  min={selectedLaserProfile.minNm ?? undefined}
                  max={selectedLaserProfile.maxNm ?? undefined}
                  step="0.001"
                  value={stopNm}
                  onChange={(e) => setStopNm(Number(e.target.value))}
                />
              </div>
            </div>

            {selectedLaserProfile.family === 'visible' ? (
              <>
                <div className="capture-grid-2">
                  <div className="capture-field">
                    <label className="capture-label">Points</label>
                    <input
                      className="capture-input"
                      type="number"
                      min="1"
                      step="1"
                      value={visiblePointCount}
                      onChange={(e) => setVisiblePointCount(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                    />
                  </div>
                  <div className="capture-field">
                    <label className="capture-label">Laser Power (mW)</label>
                    <input
                      className="capture-input"
                      type="number"
                      min="0"
                      step="0.1"
                      value={powerMw}
                      onChange={(e) => setPowerMw(Number(e.target.value))}
                    />
                  </div>
                </div>

                <div className="capture-grid-2">
                  <div className="capture-field">
                    <label className="capture-label">Settle (ms)</label>
                    <input
                      className="capture-input"
                      type="number"
                      min="0"
                      step="10"
                      value={visibleSettleMs}
                      onChange={(e) => setVisibleSettleMs(Math.max(0, Math.round(Number(e.target.value) || 0)))}
                    />
                  </div>
                  <div className="capture-field">
                    <label className="capture-label">Average (ms)</label>
                    <input
                      className="capture-input"
                      type="number"
                      min="1"
                      step="10"
                      value={visibleAverageMs}
                      onChange={(e) => setVisibleAverageMs(Math.max(1, Math.round(Number(e.target.value) || 1)))}
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="capture-grid-2">
                <div className="capture-field">
                  <label className="capture-label">Speed (nm/s)</label>
                  <input
                    className="capture-input"
                    type="number"
                    min="0"
                    step="0.1"
                    value={speedNmS}
                    onChange={(e) => setSpeedNmS(Number(e.target.value))}
                  />
                </div>
                <div className="capture-field">
                  <label className="capture-label">Laser Power (mW)</label>
                  <input
                    className="capture-input"
                    type="number"
                    min="0"
                    step="0.1"
                    value={powerMw}
                    onChange={(e) => setPowerMw(Number(e.target.value))}
                  />
                </div>
              </div>
            )}

            <div className="capture-field">
              <label className="capture-label">Detector</label>
              <div className="capture-readonly">{selectedDetectorType}</div>
            </div>

            <div className="capture-grid-2">
              <div className="capture-field">
                <label className="capture-label">Sample Rate (Hz)</label>
                <input
                  className="capture-input"
                  type="number"
                  min={SAMPLE_RATE_MIN}
                  max={SAMPLE_RATE_MAX}
                  step="1"
                  value={sampleRateHz}
                  onChange={(e) => setSampleRateHz(clampSampleRate(Number(e.target.value)))}
                />
                <div className="capture-hint">Default 50,000 Hz - Max 100,000 Hz</div>
              </div>
              <div className="capture-field">
                <label className="capture-label">Oversampling (idx)</label>
                <select className="capture-input" value={osIdx} onChange={(e) => setOsIdx(Number(e.target.value))}>
                  {Array.from({ length: maxOsIdxForRate + 1 }).map((_, v) => (
                    <option key={v} value={v}>{`Index ${v} (${1 << v}x)`}</option>
                  ))}
                </select>
                <div className="capture-hint">Max index for this rate: {maxOsIdxForRate}</div>
              </div>
            </div>

            {selectedIsLinear ? (
              <div className="capture-gain-grid">
                {[0, 1, 2, 3].map((idx) => (
                  <div className="capture-field" key={idx}>
                    <label className="capture-label">{`Gain CH${idx + 1}`}</label>
                    <select
                      className="capture-input"
                      value={gains[idx]}
                      onChange={(e) =>
                        setGains((prev) => {
                          const next = [...prev];
                          next[idx] = Number(e.target.value);
                          return next;
                        })
                      }
                    >
                      {[0, 1, 2, 3, 4, 5, 6, 7].map((g) => (
                        <option key={g} value={g}>
                          {gainDisplayLabel(g)}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            ) : (
              <div className="device-note">LOG front-end selected. Gain Control is not available.</div>
            )}

            <div className="capture-actions">
              <button className="btn ghost" onClick={() => setShowAdd(true)}>
                Add Channel
              </button>
              <button className="btn ghost" onClick={doSaveH5} disabled={running}>
                Save H5
              </button>
              <button className="btn primary" onClick={doRunSweep} disabled={running}>
                {running ? 'Running...' : 'Run Sweep'}
              </button>
            </div>

            <div className="capture-meta">
              {captureMessage || 'Ready'} - Span {estimate.span.toFixed(3)} nm - Duration{' '}
              {estimate.duration.toFixed(2)} s - Est {estimate.samples.toLocaleString()} {estimate.sampleLabel}
              {estimate.resolutionPm != null ? ` - Resolution ${estimate.resolutionPm.toFixed(3)} pm` : ''}
              {samplesTotal ? ` - Last ${samplesTotal.toLocaleString()} ${estimate.sampleLabel}` : ''}
            </div>

            <div className="capture-log">
              {logs.length === 0 ? (
                <div className="console-empty">Use Scan Resources and *IDN? to detect TSL550/570/710/770 or a TLB6700 visible controller.</div>
              ) : (
                logs.map((l, i) => (
                  <div key={i} className="console-line rx">
                    <span className="console-ts">[{l.ts}]</span>
                    <span className="console-text">{l.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="panel chart-panel">
          <div className="panel-header">
            <div className="panel-title">Sweep Channels</div>
            <div className="panel-meta">Right click for scroll control</div>
          </div>
          <div className="chart-grid">
            {activeSeries.map((ch) => (
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
                    x
                  </button>
                </div>
                <CaptureMiniChart points={ch.points} color={ch.color} unit={ch.unit} />
              </div>
            ))}
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
            <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
              <div className="pref-row">
                <div>
                  <div className="pref-title">Channel Type</div>
                  <div className="pref-sub">Physical or math channel</div>
                </div>
                <select className="pref-input" value={addType} onChange={(e) => setAddType(e.target.value as 'physical' | 'math')}>
                  <option value="physical">Physical</option>
                  <option value="math">Virtual</option>
                </select>
              </div>
              {addType === 'physical' ? (
                <div className="pref-row">
                  <div>
                    <div className="pref-title">Physical Channel</div>
                    <div className="pref-sub">Add CH1..CH4 tile</div>
                  </div>
                  <select className="pref-input" onChange={(e) => addPhysical(e.target.value)}>
                    <option value="">Select</option>
                    {PHYS_CHANNELS.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <>
                  <div className="pref-row">
                    <div>
                      <div className="pref-title">Math Function</div>
                      <div className="pref-sub">Shared across monitor and sweep</div>
                    </div>
                    <select className="pref-input" value={mathType} onChange={(e) => setMathType(e.target.value as VirtualMathType)}>
                      <option value="db">Transmission dB</option>
                      <option value="diff">Difference</option>
                      <option value="sum">Sum</option>
                    </select>
                  </div>
                  <div className="pref-row">
                    <div>
                      <div className="pref-title">Source A/B</div>
                      <div className="pref-sub">Choose CH indices</div>
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <select className="pref-input" value={srcA} onChange={(e) => setSrcA(Number(e.target.value))}>
                        {[0, 1, 2, 3].map((i) => (
                          <option key={i} value={i}>{`CH${i + 1}`}</option>
                        ))}
                      </select>
                      <select className="pref-input" value={srcB} onChange={(e) => setSrcB(Number(e.target.value))}>
                        {[0, 1, 2, 3].map((i) => (
                          <option key={i} value={i}>{`CH${i + 1}`}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="cal-actions">
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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import LivePlot from './tabs/LivePlot/LivePlot';
import ConsoleTab from './tabs/Console/ConsoleTab';
import CalibrationTab from './tabs/Calibration/CalibrationTab';
import CaptureTab from './tabs/Capture/CaptureTab';
import { ControlMsg, DeviceStatus, sendControl, subscribeControl, subscribeStatus } from './coredaqClient';
import { VirtualChannelDef, VirtualMathType } from './virtualChannels';

const tabs = [
  { id: 'live', label: 'Power Monitor' },
  { id: 'capture', label: 'Spectrum Analyzer' },
  { id: 'cal', label: 'Calibration' },
  { id: 'console', label: 'Console' },
];
const VIRTUAL_CHANNELS_STORAGE_KEY = 'coredaq.virtual_channels.v1';
const VIRTUAL_CHANNEL_COLORS = ['#C792EA', '#82AAFF', '#F78C6C', '#A3BE8C', '#FFD166', '#6EE7B7'];

function firmwareVersionFromIdn(idn?: string | null): string {
  if (!idn) return 'Unknown';
  const m = idn.toUpperCase().match(/FW[_-]?V?([0-9]+(?:\.[0-9]+)?)/);
  return m ? `v${m[1]}` : 'Unknown';
}

function formatHeadType(detectorType?: string | null): string {
  const d = (detectorType || '').toString().toUpperCase();
  if (d === 'SILICON') return 'Silicon';
  if (d === 'INGAAS') return 'InGaAs';
  return 'Unknown';
}

function formatAmplifierType(frontendType?: string | null): string {
  const f = (frontendType || '').toString().toUpperCase();
  if (f === 'LINEAR') return 'Linear TIA';
  if (f === 'LOG') return 'Log TIA';
  return 'Unknown';
}

function normalizeDevice(row: DeviceStatus): DeviceStatus | null {
  if (!row || typeof row.device_id !== 'string' || row.device_id.length === 0) {
    return null;
  }
  if (row.unsupported_firmware) {
    return null;
  }
  return {
    ...row,
    connected: row.connected !== false,
    frontend_type: (row.frontend_type || 'UNKNOWN').toString().toUpperCase(),
  };
}

function loadVirtualChannels(): VirtualChannelDef[] {
  try {
    const raw = window.localStorage.getItem(VIRTUAL_CHANNELS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v) =>
        v &&
        typeof v.id === 'string' &&
        typeof v.name === 'string' &&
        typeof v.color === 'string' &&
        typeof v.srcA === 'string' &&
        typeof v.srcB === 'string' &&
        (v.mathType === 'db' || v.mathType === 'diff' || v.mathType === 'sum')
    ) as VirtualChannelDef[];
  } catch {
    return [];
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState('live');

  // Tabs are kept mounted and hidden with CSS; echarts instances size
  // themselves to 0 while hidden, so nudge them after the pane is shown.
  useEffect(() => {
    const t = window.setTimeout(() => window.dispatchEvent(new Event('resize')), 0);
    return () => window.clearTimeout(t);
  }, [activeTab]);
  const [showPrefs, setShowPrefs] = useState(false);

  // Manual serial-port control (autodiscovery override)
  const [serialPorts, setSerialPorts] = useState<
    { device: string; description: string; connected: boolean; is_coredaq_candidate: boolean }[]
  >([]);
  const [portOverride, setPortOverride] = useState<string | null>(null);

  useEffect(() => {
    sendControl({ action: 'serial_ports_list' });
    const unsub = subscribeControl((msg: ControlMsg) => {
      if (msg.action === 'serial_ports_list' && msg.ok && Array.isArray(msg.ports)) {
        setSerialPorts(msg.ports as typeof serialPorts);
        if (typeof msg.port_override === 'string' || msg.port_override === null) {
          setPortOverride((msg.port_override as string | null) ?? null);
        }
      } else if (msg.action === 'set_port_override' && msg.ok) {
        setPortOverride((msg.port_override as string | null) ?? null);
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [windowSeconds, setWindowSeconds] = useState(5);
  const [maximized, setMaximized] = useState<boolean>(false);
  const [devices, setDevices] = useState<DeviceStatus[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [infoDeviceId, setInfoDeviceId] = useState<string | null>(null);
  const [virtualChannels, setVirtualChannels] = useState<VirtualChannelDef[]>(() => loadVirtualChannels());
  const unsupportedPopupShown = useRef(false);
  const sortedDevices = useMemo(
    () => [...devices].sort((a, b) => a.device_id.localeCompare(b.device_id)),
    [devices]
  );

  const activeDevice = useMemo(() => {
    if (activeDeviceId) {
      const found = devices.find((d) => d.device_id === activeDeviceId);
      if (found) return found;
    }
    return devices[0] ?? null;
  }, [devices, activeDeviceId]);
  const infoDevice = useMemo(() => {
    if (!infoDeviceId) return null;
    return sortedDevices.find((d) => d.device_id === infoDeviceId) ?? null;
  }, [infoDeviceId, sortedDevices]);
  const infoDeviceIndex = useMemo(() => {
    if (!infoDevice) return -1;
    return sortedDevices.findIndex((d) => d.device_id === infoDevice.device_id);
  }, [infoDevice, sortedDevices]);

  // Socket-level connectivity is tracked separately from the device list so a
  // brief backend restart shows "Disconnected" without wiping the layout.
  const [backendUp, setBackendUp] = useState(true);
  const connected = backendUp && devices.length > 0;
  const anyStreaming = devices.some((d) => !!d.streaming);

  const selectActiveDevice = (deviceId: string) => {
    if (!deviceId) return;
    setActiveDeviceId(deviceId);
    sendControl({ action: 'set_active_device', device_id: deviceId });
  };

  useEffect(() => {
    let alive = true;
    const unsub = subscribeStatus((s) => {
      // Synthetic disconnect statuses (socket close) carry no `devices` field;
      // keep the last known list so a sub-second backend restart doesn't wipe
      // buffers and card layout. Real backend statuses always include it.
      if (!Array.isArray(s.devices)) {
        if (s.connected === false) setBackendUp(false);
        return;
      }
      setBackendUp(true);
      if (typeof (s as Record<string, unknown>).port_override === 'string') {
        setPortOverride((s as Record<string, unknown>).port_override as string);
      } else if ((s as Record<string, unknown>).port_override === null) {
        setPortOverride(null);
      }
      const rows = s.devices;
      const unsupported = rows.find((r) => r?.unsupported_firmware);
      if (unsupported?.unsupported_firmware) {
        if (!unsupportedPopupShown.current) {
          const idnSuffix = unsupported.idn ? `\n\nDetected device: ${unsupported.idn}` : '';
          const reason =
            unsupported.unsupported_reason ??
            'This device firmware is not supported by this GUI. Please upgrade firmware.';
          window.alert(`Device not supported.\n${reason}${idnSuffix}`);
          unsupportedPopupShown.current = true;
        }
      } else {
        unsupportedPopupShown.current = false;
      }

      const nextDevices = rows
        .map(normalizeDevice)
        .filter((d): d is DeviceStatus => d !== null);

      if (!alive) return;
      setDevices(nextDevices);
      setActiveDeviceId((prev) => {
        const preferred = typeof s.active_device_id === 'string' ? s.active_device_id : null;
        if (preferred && nextDevices.some((d) => d.device_id === preferred)) return preferred;
        if (prev && nextDevices.some((d) => d.device_id === prev)) return prev;
        return nextDevices[0]?.device_id ?? null;
      });
    });

    if (window.coredaq?.onOpenPreferences) {
      window.coredaq.onOpenPreferences(() => setShowPrefs(true));
    }

    return () => {
      alive = false;
      unsub();
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIRTUAL_CHANNELS_STORAGE_KEY, JSON.stringify(virtualChannels));
    } catch {
      // Ignore persistence failures (e.g. private mode/storage quota).
    }
  }, [virtualChannels]);

  const addVirtualChannel = (input: { mathType: VirtualMathType; srcA: string; srcB: string; name: string }) => {
    setVirtualChannels((prev) => {
      const exists = prev.find((v) => v.mathType === input.mathType && v.srcA === input.srcA && v.srcB === input.srcB);
      if (exists) return prev;
      const id = `vch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const color = VIRTUAL_CHANNEL_COLORS[prev.length % VIRTUAL_CHANNEL_COLORS.length];
      return [...prev, { id, color, ...input }];
    });
  };

  const removeVirtualChannel = (virtualId: string) => {
    setVirtualChannels((prev) => prev.filter((v) => v.id !== virtualId));
  };

  useEffect(() => {
    if (!infoDeviceId) return;
    if (!sortedDevices.some((d) => d.device_id === infoDeviceId)) {
      setInfoDeviceId(null);
    }
  }, [infoDeviceId, sortedDevices]);

  useEffect(() => {
    let alive = true;
    let offState: (() => void) | undefined;
    if (window.coredaq?.windowIsMaximized) {
      window.coredaq
        .windowIsMaximized()
        .then((state) => {
          if (alive) setMaximized(!!state.maximized);
        })
        .catch(() => {});
    }
    if (window.coredaq?.onWindowState) {
      offState = window.coredaq.onWindowState((state) => {
        if (alive) setMaximized(!!state.maximized);
      });
    }
    return () => {
      alive = false;
      offState?.();
    };
  }, []);

  return (
    <div className="app">
      <header className="topbar window-drag">
        <div className="brand">
          <div>
            {/* Product wordmark per the coreX brand sheet: `core` medium +
                bold accent suffix. The coupler X glyph is company-only and
                lives in the sidebar footer lockup — never on product names. */}
            <div className="brand-title">
              <span className="product-core">core</span>
              <span className="product-suffix">Console</span>
            </div>
            <div className="brand-sub">
              <a
                className="brand-link window-no-drag"
                href="https://core-instrumentation.com"
                target="_blank"
                rel="noreferrer"
              >
                coreX — Instrumentation
              </a>
            </div>
          </div>
        </div>
        <div className="topbar-right window-no-drag">
          <div className={`status ${connected ? 'ok' : 'idle'}`}>
            <span className="status-dot" />
            {connected
              ? `${devices.length} device${devices.length > 1 ? 's' : ''}${
                  activeDevice?.port ? ` • ${activeDevice.port}` : ''
                }`
              : 'Disconnected'}
          </div>
          <div className="window-controls">
            <button
              className="win-btn"
              title="Minimize"
              onClick={() => window.coredaq?.windowMinimize?.()}
            >
              _
            </button>
            <button
              className="win-btn"
              title={maximized ? 'Restore' : 'Maximize'}
              onClick={() => window.coredaq?.windowToggleMaximize?.()}
            >
              {maximized ? '[]' : '[ ]'}
            </button>
            <button
              className="win-btn close"
              title="Close"
              onClick={() => window.coredaq?.windowClose?.()}
            >
              X
            </button>
          </div>
        </div>
      </header>

      <div className="content">
        <nav className="sidebar">
          <div className="nav-title">Workbench</div>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`nav-item ${activeTab === t.id ? 'active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}

          <div className="device-manager">
            <div className="device-manager-head">Device Manager</div>
            {sortedDevices.length === 0 && <div className="device-empty">Connect a CoreDAQ v4 device.</div>}
            {sortedDevices.map((d, idx) => {
              const isActive = activeDevice?.device_id === d.device_id;
              return (
                <div key={d.device_id} className="device-item-row">
                  <button
                    className={`device-item ${isActive ? 'active' : ''}`}
                    onClick={() => selectActiveDevice(d.device_id)}
                    title={`Device ${idx + 1}`}
                  >
                    <div className="device-item-top">
                      <span className="device-item-name">{`Device ${idx + 1}`}</span>
                      {d.busy && <span className="device-tag busy">busy</span>}
                      {!!d.streaming && <span className="device-tag stream">stream</span>}
                    </div>
                  </button>
                  <button
                    className="device-info-btn"
                    title={`Device ${idx + 1} details`}
                    onClick={() => setInfoDeviceId(d.device_id)}
                  >
                    i
                  </button>
                </div>
              );
            })}

            <div className="port-select-row">
              <span className="device-manager-head">Port</span>
              <select
                className="pref-input port-select"
                value={portOverride ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  sendControl({ action: 'set_port_override', port: v || null });
                }}
                title="Pin the coreDAQ to a specific serial port (Auto = discover)"
              >
                <option value="">Auto (discover)</option>
                {serialPorts.map((p) => (
                  <option key={p.device} value={p.device}>
                    {p.device}
                    {p.is_coredaq_candidate ? ' ●' : ''}
                  </option>
                ))}
              </select>
              <button
                className="icon-btn"
                title="Refresh port list"
                onClick={() => sendControl({ action: 'serial_ports_list' })}
              >
                ↻
              </button>
            </div>
          </div>

          <div className="sidebar-footer">
            {/* coreX company lockup — canonical 2x2 fiber-coupler X glyph. */}
            <span className="corex-logo" aria-label="coreX">
              <span className="corex-core">core</span>
              <svg className="corex-x" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <linearGradient id="corex-beam" x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0" stopColor="#66E3F0" />
                    <stop offset="1" stopColor="#3B82C4" />
                  </linearGradient>
                </defs>
                <path
                  d="M9,58 C36,58 36,14 63,14"
                  fill="none"
                  stroke="url(#corex-beam)"
                  strokeWidth="11"
                  strokeLinecap="round"
                  opacity="0.75"
                />
                <path
                  d="M9,14 C36,14 36,58 63,58"
                  fill="none"
                  stroke="url(#corex-beam)"
                  strokeWidth="11"
                  strokeLinecap="round"
                />
                <circle cx="36" cy="36" r="6.5" fill="#EAF7FA" />
              </svg>
            </span>
            <div className="footer-version">coreConsole v{__APP_VERSION__}</div>
            <a
              className="footer-company window-no-drag"
              href="https://core-instrumentation.com"
              target="_blank"
              rel="noreferrer"
            >
              core-instrumentation.com
            </a>
            <div className="footer-legal">
              coreX — Instrumentation UG (haftungsbeschränkt) · Heidelberg, Germany
            </div>
          </div>
        </nav>

        <main className="main">
          {/* All tabs stay mounted; inactive ones are hidden with CSS so their
              local state (sweep settings, logs, plots, console history)
              survives tab switches. */}
          <div className={`tab-pane${activeTab === 'live' ? '' : ' tab-pane-hidden'}`}>
            <LivePlot
              windowSeconds={windowSeconds}
              devices={devices}
              activeDeviceId={activeDeviceId}
              onSelectDevice={selectActiveDevice}
              globalStreaming={anyStreaming}
              virtualChannels={virtualChannels}
              onAddVirtualChannel={addVirtualChannel}
              onRemoveVirtualChannel={removeVirtualChannel}
            />
          </div>
          <div className={`tab-pane${activeTab === 'capture' ? '' : ' tab-pane-hidden'}`}>
            <CaptureTab
              connected={connected}
              devices={devices}
              activeDeviceId={activeDeviceId}
              onSelectDevice={selectActiveDevice}
              virtualChannels={virtualChannels}
              onAddVirtualChannel={addVirtualChannel}
              onRemoveVirtualChannel={removeVirtualChannel}
            />
          </div>
          <div className={`tab-pane${activeTab === 'console' ? '' : ' tab-pane-hidden'}`}>
            <ConsoleTab
              connected={connected}
              devices={devices}
              activeDeviceId={activeDeviceId}
              onSelectDevice={selectActiveDevice}
            />
          </div>
          <div className={`tab-pane${activeTab === 'cal' ? '' : ' tab-pane-hidden'}`}>
            <CalibrationTab
              connected={connected}
              devices={devices}
              activeDeviceId={activeDeviceId}
              onSelectDevice={selectActiveDevice}
            />
          </div>
        </main>
      </div>

      {showPrefs && (
        <div className="modal-backdrop" onClick={() => setShowPrefs(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">Preferences</div>
              <button className="btn ghost" onClick={() => setShowPrefs(false)}>
                Close
              </button>
            </div>
            <div className="modal-body">
              <div className="pref-row">
                <div>
                  <div className="pref-title">Live Plot Window</div>
                  <div className="pref-sub">Moving window length in seconds</div>
                </div>
                <input
                  className="pref-input"
                  type="number"
                  min={1}
                  max={60}
                  step={1}
                  value={windowSeconds}
                  onChange={(e) => setWindowSeconds(Number(e.target.value))}
                />
              </div>
            </div>
          </div>
        </div>
      )}
      {infoDevice && (
        <div className="modal-backdrop" onClick={() => setInfoDeviceId(null)}>
          <div className="modal device-info-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                {`Device ${infoDeviceIndex >= 0 ? infoDeviceIndex + 1 : ''} Details`}
              </div>
              <button className="btn ghost" onClick={() => setInfoDeviceId(null)}>
                Close
              </button>
            </div>
            <div className="device-info-grid">
              <div className="device-info-row">
                <span className="device-info-key">COM Port</span>
                <span className="device-info-val">{infoDevice.port || 'n/a'}</span>
              </div>
              <div className="device-info-row">
                <span className="device-info-key">Head Type</span>
                <span className="device-info-val">{formatHeadType(infoDevice.detector_type)}</span>
              </div>
              <div className="device-info-row">
                <span className="device-info-key">Amplifier Type</span>
                <span className="device-info-val">{formatAmplifierType(infoDevice.frontend_type)}</span>
              </div>
              <div className="device-info-row">
                <span className="device-info-key">Firmware Version</span>
                <span className="device-info-val">{firmwareVersionFromIdn(infoDevice.idn)}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

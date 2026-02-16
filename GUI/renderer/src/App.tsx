import React, { useEffect, useMemo, useRef, useState } from 'react';
import LivePlot from './tabs/LivePlot/LivePlot';
import ConsoleTab from './tabs/Console/ConsoleTab';
import CalibrationTab from './tabs/Calibration/CalibrationTab';
import CaptureTab from './tabs/Capture/CaptureTab';
import { DeviceStatus, sendControl, subscribeStatus } from './coredaqClient';
import { VirtualChannelDef, VirtualMathType } from './virtualChannels';
import picMark from '../../image.png';

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
  const [showPrefs, setShowPrefs] = useState(false);
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

  const connected = devices.length > 0;
  const anyStreaming = devices.some((d) => !!d.streaming);

  const selectActiveDevice = (deviceId: string) => {
    if (!deviceId) return;
    setActiveDeviceId(deviceId);
    sendControl({ action: 'set_active_device', device_id: deviceId });
  };

  useEffect(() => {
    let alive = true;
    const unsub = subscribeStatus((s) => {
      const rows = Array.isArray(s.devices) ? s.devices : [];
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
          <div className="brand-mark" />
          <div>
            <div className="brand-title">coreDAQ</div>
            <div className="brand-sub">
              <a
                className="brand-link window-no-drag"
                href="https://core-instrumentation.com"
                target="_blank"
                rel="noreferrer"
              >
                Core - Instrumentation
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
          </div>

          <div className="sidebar-footer">
            <div className="pic-badge" aria-hidden="true">
              <img src={picMark} alt="PIC" className="pic-badge-image" />
            </div>
            <div className="pic-caption">PIC Suite</div>
          </div>
        </nav>

        <main className="main">
          {activeTab === 'live' && (
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
          )}
          {activeTab === 'capture' && (
            <CaptureTab
              connected={connected}
              devices={devices}
              activeDeviceId={activeDeviceId}
              onSelectDevice={selectActiveDevice}
              virtualChannels={virtualChannels}
              onAddVirtualChannel={addVirtualChannel}
              onRemoveVirtualChannel={removeVirtualChannel}
            />
          )}
          {activeTab === 'console' && (
            <ConsoleTab
              connected={connected}
              devices={devices}
              activeDeviceId={activeDeviceId}
              onSelectDevice={selectActiveDevice}
            />
          )}
          {activeTab === 'cal' && (
            <CalibrationTab
              connected={connected}
              devices={devices}
              activeDeviceId={activeDeviceId}
              onSelectDevice={selectActiveDevice}
            />
          )}
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

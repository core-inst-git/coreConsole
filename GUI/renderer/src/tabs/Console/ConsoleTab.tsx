import React, { useEffect, useMemo, useState } from 'react';
import { DeviceStatus, sendConsole, subscribeConsole } from '@/coredaqClient';

type Line = { dir: 'tx' | 'rx'; text: string; ts: string; deviceId?: string | null };

type Props = {
  connected: boolean;
  devices: DeviceStatus[];
  activeDeviceId: string | null;
  onSelectDevice: (deviceId: string) => void;
};

export default function ConsoleTab({ connected, devices, activeDeviceId, onSelectDevice }: Props) {
  const sortedDevices = useMemo(
    () => [...devices].sort((a, b) => a.device_id.localeCompare(b.device_id)),
    [devices]
  );

  const [targetDeviceId, setTargetDeviceId] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    if (activeDeviceId && sortedDevices.some((d) => d.device_id === activeDeviceId)) {
      setTargetDeviceId(activeDeviceId);
      return;
    }
    setTargetDeviceId((prev) => {
      if (prev && sortedDevices.some((d) => d.device_id === prev)) return prev;
      return sortedDevices[0]?.device_id || '';
    });
  }, [activeDeviceId, sortedDevices]);

  const onSend = () => {
    const cmd = input.trim();
    if (!cmd) return;
    setInput('');

    if (!connected) {
      setLines((prev) => [
        ...prev,
        { dir: 'rx', text: 'ERR Not connected', ts: new Date().toLocaleTimeString() },
      ]);
      return;
    }
    if (!targetDeviceId) {
      setLines((prev) => [
        ...prev,
        { dir: 'rx', text: 'ERR No target device selected', ts: new Date().toLocaleTimeString() },
      ]);
      return;
    }

    sendConsole(cmd, targetDeviceId);
  };

  useEffect(() => {
    const unsub = subscribeConsole((msg) => {
      setLines((prev) => [
        ...prev,
        {
          dir: msg.dir,
          text: msg.text,
          ts: new Date().toLocaleTimeString(),
          deviceId: msg.device_id || null,
        },
      ]);
    });
    return () => unsub();
  }, []);

  return (
    <section className="console">
      <div className="console-header">
        <div>
          <div className="live-title">Console</div>
          <div className="live-sub">Line-mode command interface (CDC), device-targeted.</div>
        </div>
        <div className="console-target">
          <label className="capture-label">Target</label>
          <select
            className="capture-input console-target-select"
            value={targetDeviceId}
            onChange={(e) => {
              const v = e.target.value;
              setTargetDeviceId(v);
              if (v) onSelectDevice(v);
            }}
          >
            <option value="">Select device...</option>
            {sortedDevices.map((d) => (
              <option key={d.device_id} value={d.device_id}>
                {d.device_id}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="panel console-panel">
        <div className="console-log">
          {lines.length === 0 && <div className="console-empty">Type a command and press Enter.</div>}
          {lines.map((l, i) => (
            <div key={i} className={`console-line ${l.dir}`}>
              <span className="console-ts">[{l.ts}]</span>
              <span className="console-dir">{l.dir === 'tx' ? '>>' : '<<'}</span>
              {l.deviceId && <span className="console-device">[{l.deviceId}]</span>}
              <span className="console-text">{l.text}</span>
            </div>
          ))}
        </div>

        <div className="console-input-row">
          <input
            className="console-input"
            placeholder="IDN?"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSend();
            }}
          />
          <button className="btn primary" onClick={onSend}>
            Send
          </button>
        </div>
      </div>
    </section>
  );
}

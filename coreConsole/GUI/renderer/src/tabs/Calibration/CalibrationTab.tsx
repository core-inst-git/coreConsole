import React, { useEffect, useMemo, useState } from 'react';
import { DeviceStatus, sendControl, subscribeControl } from '@/coredaqClient';

type Props = {
  connected: boolean;
  devices: DeviceStatus[];
  activeDeviceId: string | null;
  onSelectDevice: (deviceId: string) => void;
};

type Step = 'idle' | 'confirm' | 'running' | 'done' | 'error';

export default function CalibrationTab({ connected, devices, activeDeviceId, onSelectDevice }: Props) {
  const linearDevices = useMemo(
    () =>
      [...devices]
        .filter((d) => d.frontend_type === 'LINEAR')
        .sort((a, b) => a.device_id.localeCompare(b.device_id)),
    [devices]
  );

  const [targetDeviceId, setTargetDeviceId] = useState('');
  const [step, setStep] = useState<Step>('idle');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (activeDeviceId && linearDevices.some((d) => d.device_id === activeDeviceId)) {
      setTargetDeviceId(activeDeviceId);
      return;
    }
    setTargetDeviceId((prev) => {
      if (prev && linearDevices.some((d) => d.device_id === prev)) return prev;
      return linearDevices[0]?.device_id || '';
    });
  }, [activeDeviceId, linearDevices]);

  useEffect(() => {
    const unsub = subscribeControl((msg) => {
      if (msg.action !== 'recalibrate_zero') return;
      const msgDeviceId = typeof msg.device_id === 'string' ? msg.device_id : null;
      if (targetDeviceId && msgDeviceId && msgDeviceId !== targetDeviceId) return;
      if (msg.ok) {
        const z = Array.isArray(msg.zeros) ? msg.zeros : [];
        setMessage(`Zero updated: [${z.join(', ')}]`);
        setStep('done');
      } else {
        setMessage(msg.error || 'Calibration failed');
        setStep('error');
      }
    });
    return () => unsub();
  }, [targetDeviceId]);

  const start = () => {
    setStep('confirm');
    setMessage('');
  };

  const proceed = () => {
    if (!targetDeviceId) {
      setMessage('Select a LINEAR device first.');
      setStep('error');
      return;
    }
    setStep('running');
    setMessage('Recalibrating zero...');
    sendControl({ action: 'recalibrate_zero', device_id: targetDeviceId });
  };

  return (
    <section className="cal-tab">
      <div className="live-header">
        <div>
          <div className="live-title">Calibration</div>
          <div className="live-sub">Guided zero recalibration workflow (LINEAR devices only).</div>
        </div>
      </div>

      <div className="panel cal-panel">
        <div className="capture-field">
          <label className="capture-label">Target Device</label>
          <select
            className="capture-input"
            value={targetDeviceId}
            onChange={(e) => {
              const v = e.target.value;
              setTargetDeviceId(v);
              if (v) onSelectDevice(v);
            }}
          >
            <option value="">Select LINEAR device...</option>
            {linearDevices.map((d) => (
              <option key={d.device_id} value={d.device_id}>
                {d.device_id}
              </option>
            ))}
          </select>
        </div>

        {linearDevices.length === 0 && (
          <div className="device-note">No LINEAR device connected. Zero recalibration is unavailable in LOG mode.</div>
        )}

        <button
          className="btn primary cal-big-btn"
          onClick={start}
          disabled={!connected || step === 'running' || linearDevices.length === 0}
        >
          Recalibrate Zero
        </button>

        {step === 'confirm' && (
          <div className="cal-card">
            <div className="cal-title">Before proceeding</div>
            <div className="cal-text">Make sure all the detectors are dark.</div>
            <div className="cal-actions">
              <button className="btn ghost" onClick={() => setStep('idle')}>
                Cancel
              </button>
              <button className="btn primary" onClick={proceed}>
                Proceed
              </button>
            </div>
          </div>
        )}

        {step === 'running' && (
          <div className="cal-card">
            <div className="cal-title">Running</div>
            <div className="cal-text">{message}</div>
          </div>
        )}

        {step === 'done' && (
          <div className="cal-card success">
            <div className="cal-title">Completed</div>
            <div className="cal-text">{message}</div>
          </div>
        )}

        {step === 'error' && (
          <div className="cal-card error">
            <div className="cal-title">Error</div>
            <div className="cal-text">{message}</div>
          </div>
        )}
      </div>
    </section>
  );
}

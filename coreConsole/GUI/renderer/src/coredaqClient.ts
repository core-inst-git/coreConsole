export type FrontendType = 'LINEAR' | 'LOG' | string;

export const GAIN_RANGE_LABELS = [
  '5 mW',
  '1 mW',
  '500 uW',
  '100 uW',
  '50 uW',
  '10 uW',
  '5 uW',
  '500 nW',
];

export function gainDisplayLabel(gainIndex: number): string {
  const idx = Math.max(0, Math.min(GAIN_RANGE_LABELS.length - 1, Number(gainIndex) || 0));
  return `G${idx} (${GAIN_RANGE_LABELS[idx]})`;
}

export type DeviceStatus = {
  device_id: string;
  connected?: boolean;
  port?: string | null;
  idn?: string | null;
  frontend_type?: FrontendType | null;
  detector_type?: string | null;
  unsupported_firmware?: boolean;
  unsupported_reason?: string | null;
  freq_hz?: number | null;
  os_idx?: number | null;
  wavelength_nm?: number | null;
  wavelength_min_nm?: number | null;
  wavelength_max_nm?: number | null;
  gains?: number[] | null;
  autogain?: boolean;
  streaming?: boolean;
  die_temp_c?: number | null;
  room_temp_c?: number | null;
  room_humidity_pct?: number | null;
  busy?: boolean;
};

export type StatusMsg = {
  type: 'status';
  connected: boolean;
  device_count?: number;
  devices?: DeviceStatus[];
  active_device_id?: string | null;
  port?: string | null;
  idn?: string | null;
  detector_type?: string | null;
  unsupported_firmware?: boolean;
  unsupported_reason?: string | null;
  gpib_resource?: string | null;
  gpib_idn?: string | null;
  gpib_model?: string | null;
  capture_state?: string | null;
  capture_message?: string | null;
  freq_hz?: number | null;
  os_idx?: number | null;
  wavelength_nm?: number | null;
  wavelength_min_nm?: number | null;
  wavelength_max_nm?: number | null;
  gains?: number[] | null;
  autogain?: boolean;
  streaming?: boolean;
  die_temp_c?: number | null;
  room_temp_c?: number | null;
  room_humidity_pct?: number | null;
};

export type StreamMsg = {
  type: 'stream';
  device_id?: string;
  frontend_type?: FrontendType | null;
  ts: number;
  ch: number[];
};

export type ConsoleMsg = {
  type: 'console';
  dir: 'rx' | 'tx';
  text: string;
  device_id?: string | null;
};

export type ControlMsg = {
  type: 'control';
  action?: string;
  ok: boolean;
  error?: string | null;
  zeros?: number[];
  gains?: number[];
  [key: string]: unknown;
};

type Handler<T> = (msg: T) => void;

const statusHandlers = new Set<Handler<StatusMsg>>();
const streamHandlers = new Set<Handler<StreamMsg>>();
const consoleHandlers = new Set<Handler<ConsoleMsg>>();
const controlHandlers = new Set<Handler<ControlMsg>>();

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  ws = new WebSocket('ws://127.0.0.1:8765');

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'status') {
        statusHandlers.forEach((h) => h(msg));
      } else if (msg.type === 'stream') {
        streamHandlers.forEach((h) => h(msg));
      } else if (msg.type === 'console') {
        consoleHandlers.forEach((h) => h(msg));
      } else if (msg.type === 'control') {
        controlHandlers.forEach((h) => h(msg));
      }
    } catch {
      // ignore
    }
  };

  ws.onclose = () => {
    if (reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1000);
  };
}

export function subscribeStatus(h: Handler<StatusMsg>) {
  statusHandlers.add(h);
  connect();
  return () => {
    statusHandlers.delete(h);
  };
}

export function subscribeStream(h: Handler<StreamMsg>) {
  streamHandlers.add(h);
  connect();
  return () => {
    streamHandlers.delete(h);
  };
}

export function subscribeConsole(h: Handler<ConsoleMsg>) {
  consoleHandlers.add(h);
  connect();
  return () => {
    consoleHandlers.delete(h);
  };
}

export function sendConsole(cmd: string, deviceId?: string) {
  connect();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'console',
    cmd,
    ...(deviceId ? { device_id: deviceId } : {}),
  }));
  consoleHandlers.forEach((h) =>
    h({ type: 'console', dir: 'tx', text: cmd, device_id: deviceId || null })
  );
}

export function sendControl(payload: Record<string, unknown>) {
  connect();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'control', ...payload }));
}

export function subscribeControl(h: Handler<ControlMsg>) {
  controlHandlers.add(h);
  connect();
  return () => {
    controlHandlers.delete(h);
  };
}

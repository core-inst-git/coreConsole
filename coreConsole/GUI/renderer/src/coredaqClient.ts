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
  return GAIN_RANGE_LABELS[idx];
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
  /** Batched samples: t[i] pairs with ch[channel][i]; one message per ~25 ms. */
  t: number[];
  ch: number[][];
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

// The backend port is normally 8765 but can be moved with COREDAQ_WS_PORT;
// Electron main passes the effective port through the preload bridge.
const WS_PORT = (window as any).coredaq?.wsPort || 8765;

let ws: WebSocket | null = null;
let reconnectTimer: number | null = null;
let wasOpen = false;

// Commands issued while the socket is down are queued (bounded) and flushed on
// reconnect instead of being silently dropped.
const pendingMessages: string[] = [];
const MAX_PENDING_MESSAGES = 128;

function enqueueMessage(raw: string) {
  if (pendingMessages.length >= MAX_PENDING_MESSAGES) pendingMessages.shift();
  pendingMessages.push(raw);
}

function flushPendingMessages() {
  while (ws && ws.readyState === WebSocket.OPEN && pendingMessages.length > 0) {
    const raw = pendingMessages.shift();
    if (raw) ws.send(raw);
  }
}

/** Dispatch to every handler; one throwing subscriber must not starve the rest. */
function dispatch<T>(handlers: Set<Handler<T>>, msg: T) {
  handlers.forEach((h) => {
    try {
      h(msg);
    } catch (err) {
      console.error('[coredaqClient] subscriber error', err);
    }
  });
}

function scheduleReconnect() {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1000);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
  } catch {
    ws = null;
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    wasOpen = true;
    flushPendingMessages();
  };

  ws.onerror = () => {
    // onclose follows; nothing to do, but keep the handler so errors are not
    // reported as unhandled by some environments.
  };

  ws.onmessage = (ev) => {
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'status') {
      dispatch(statusHandlers, msg);
    } else if (msg.type === 'stream') {
      dispatch(streamHandlers, msg);
    } else if (msg.type === 'console') {
      dispatch(consoleHandlers, msg);
    } else if (msg.type === 'control') {
      dispatch(controlHandlers, msg);
    }
  };

  ws.onclose = () => {
    // Tell subscribers the backend is gone so the UI can't show stale
    // "connected" state forever.
    if (wasOpen) {
      wasOpen = false;
      // No `devices` field: consumers keep their last device list (a backend
      // blip must not wipe buffers/layout); they only flip connectivity.
      dispatch(statusHandlers, { type: 'status', connected: false } as StatusMsg);
    }
    scheduleReconnect();
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
  const raw = JSON.stringify({
    type: 'console',
    cmd,
    ...(deviceId ? { device_id: deviceId } : {}),
  });
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    enqueueMessage(raw);
  } else {
    ws.send(raw);
  }
  dispatch(consoleHandlers, { type: 'console', dir: 'tx', text: cmd, device_id: deviceId || null });
}

// Only idempotent state-setters may be queued for replay after a reconnect.
// Side-effecting commands (zeroing, recording, sweeps, GPIB) executed against
// a freshly restarted backend at some arbitrary later moment would be wrong —
// they fail fast instead.
const REPLAY_SAFE_ACTIONS = new Set([
  'set_active_device',
  'stream',
  'set_freq',
  'set_os',
  'set_wavelength',
  'set_autogain',
  'set_gain',
  'serial_ports_list',
]);

export function sendControl(payload: Record<string, unknown>) {
  connect();
  const raw = JSON.stringify({ type: 'control', ...payload });
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    const action = String(payload.action || '');
    if (REPLAY_SAFE_ACTIONS.has(action)) {
      enqueueMessage(raw);
    } else {
      dispatch(controlHandlers, {
        type: 'control',
        action,
        ok: false,
        error: 'Backend not connected',
      } as ControlMsg);
    }
    return;
  }
  ws.send(raw);
}

export function subscribeControl(h: Handler<ControlMsg>) {
  controlHandlers.add(h);
  connect();
  return () => {
    controlHandlers.delete(h);
  };
}

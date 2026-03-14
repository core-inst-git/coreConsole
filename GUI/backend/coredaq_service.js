#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');

const ROOT = path.resolve(__dirname, '..', '..');
const API_PATH = process.env.COREDAQ_API_PATH
  ? path.resolve(process.env.COREDAQ_API_PATH)
  : path.join(ROOT, 'API');
const LASER_JS_PATH = process.env.COREDAQ_LASER_JS_PATH
  ? path.resolve(process.env.COREDAQ_LASER_JS_PATH)
  : path.join(ROOT, 'packages', 'laser-js');
const GUI_NODE_MODULES_PATHS = process.env.COREDAQ_GUI_NODE_MODULES_PATH
  ? String(process.env.COREDAQ_GUI_NODE_MODULES_PATH)
    .split(path.delimiter)
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .map((p) => path.resolve(p))
  : [path.join(ROOT, 'GUI', 'node_modules')];

function pathLikelyResolvable(p) {
  const txt = String(p || '');
  if (!txt) return false;
  // Paths inside app.asar can be resolvable by Node/Electron module loader
  // even when fs.existsSync reports false from a run-as-node child.
  if (txt.includes('.asar')) return true;
  return fs.existsSync(txt);
}

const extraNodePaths = [
  ...GUI_NODE_MODULES_PATHS,
  path.join(API_PATH, 'node_modules'),
  path.join(LASER_JS_PATH, 'node_modules'),
].filter((p) => pathLikelyResolvable(p));
if (extraNodePaths.length > 0) {
  const existing = process.env.NODE_PATH ? process.env.NODE_PATH.split(path.delimiter) : [];
  process.env.NODE_PATH = [...extraNodePaths, ...existing].join(path.delimiter);
  Module._initPaths();
}

const { CoreDAQ } = require(path.join(API_PATH, 'coredaq_js_api.js'));
const {
  detectLaserModel,
  createLaserFromIdn,
} = require(path.join(LASER_JS_PATH, 'index.js'));
const { VisaServiceClient } = require(path.join(__dirname, '..', 'electron', 'visaServiceClient.js'));

const SWEEP_SAMPLE_RATE_DEFAULT_HZ = 50_000;
const SWEEP_SAMPLE_RATE_MAX_HZ = 100_000;
const SWEEP_POST_START_SETTLE_S = 1.0;
const SWEEP_FINISH_POLL_TIMEOUT_S = 8.0;
const SWEEP_FINISH_POLL_INTERVAL_MS = 250;
const LIVE_STREAM_TARGET_HZ = 500;
const LIVE_STREAM_PERIOD_MS = Math.max(1, Math.round(1000 / LIVE_STREAM_TARGET_HZ));
const STREAM_MAX_CONSEC_ERRORS = 5;
const STREAM_SNAPSHOT_RETRIES = 1;
const STREAM_SNAPSHOT_RETRY_DELAY_MS = 30;
const COREDAQ_READY_STATE = 4;
const DISCOVERY_INTERVAL_MS = 2000;
const DISCOVERY_OPEN_RETRY_BACKOFF_MS = 3000;
const DISCOVERY_OPEN_RETRY_SETTLE_MS = 350;
const MAX_CONNECTED_DEVICES = 2;
const MANUAL_CONNECT_PROBE_TIMEOUT_MS = 1000;

const WS_HOST = '127.0.0.1';
const FTDI_RESOURCE_PREFIX = 'FTDI::';
const FTDI_VENDOR_IDS = new Set(['0403']);
const FTDI_BAUD_CANDIDATES = [9600, 19200, 38400, 57600, 115200];
const FTDI_SCAN_TIMEOUT_MAX_MS = 5000;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
}

function withTimeout(promise, timeoutMs, timeoutCode = 'TIMEOUT') {
  const ms = Math.max(1, Math.round(Number(timeoutMs) || 1));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const e = new Error(`Operation timed out after ${ms} ms`);
      e.code = timeoutCode;
      reject(e);
    }, ms);
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function execFileAsync(file, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      if (err) {
        err.stdout = String(stdout || '');
        err.stderr = String(stderr || '');
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function nowSec() {
  return Date.now() / 1000;
}
function parseArgs(argv) {
  const out = {
    port: null,
    wsPort: 8765,
    timeoutS: 0.2,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (a === '--port' && i + 1 < argv.length) {
      out.port = String(argv[++i]);
      continue;
    }
    if (a === '--ws-port' && i + 1 < argv.length) {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) out.wsPort = Math.trunc(v);
      continue;
    }
    if (a === '--timeout' && i + 1 < argv.length) {
      const v = Number(argv[++i]);
      if (Number.isFinite(v) && v > 0) out.timeoutS = v;
      continue;
    }
  }

  return out;
}

function deviceKeyFromIdn(idn, port) {
  const txt = String(idn || '').toUpperCase();
  const m = txt.match(/\bSN[A-Z0-9]+\b/);
  if (m) return m[0];
  const tail = path.basename(String(port || '')).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  return `DEV_${tail || 'UNKNOWN'}`;
}

function fwMajorFromIdn(idn) {
  const txt = String(idn || '').toUpperCase();
  const m = txt.match(/FW[_-]?V?(\d+)/);
  if (!m) return null;
  const v = Number.parseInt(m[1], 10);
  return Number.isFinite(v) ? v : null;
}

function normalizeDetectorType(detector) {
  const txt = String(detector || '').trim().toUpperCase();
  if (['SILICON', 'SI', 'SI_PD', 'SIPD'].includes(txt)) return CoreDAQ.DETECTOR_SILICON;
  return CoreDAQ.DETECTOR_INGAAS;
}

function detectDetectorTypeFromIdn(idn) {
  const txt = String(idn || '').toUpperCase();
  if (txt.includes('SILICON')) return CoreDAQ.DETECTOR_SILICON;
  if (txt.includes('INGAAS')) return CoreDAQ.DETECTOR_INGAAS;
  const toks = txt.split(/[^A-Z0-9]+/g).filter(Boolean);
  if (toks.includes('SI')) return CoreDAQ.DETECTOR_SILICON;
  return CoreDAQ.DETECTOR_INGAAS;
}

function defaultWavelengthNm(detectorType) {
  return detectorType === CoreDAQ.DETECTOR_SILICON ? 775.0 : 1550.0;
}

function fallbackWavelengthLimits(detectorType) {
  if (detectorType === CoreDAQ.DETECTOR_SILICON) {
    return Array.isArray(CoreDAQ.SILICON_WAVELENGTH_RANGE_NM)
      ? [...CoreDAQ.SILICON_WAVELENGTH_RANGE_NM]
      : [400.0, 1100.0];
  }
  return Array.isArray(CoreDAQ.INGAAS_WAVELENGTH_RANGE_NM)
    ? [...CoreDAQ.INGAAS_WAVELENGTH_RANGE_NM]
    : [910.0, 1700.0];
}

function maxFreqForOs(osIdx) {
  const os = Number(osIdx);
  if (os <= 1) return 100_000;
  return Math.floor(100_000 / (2 ** (os - 1)));
}

function maxOsForFreq(hz) {
  const f = Number(hz);
  if (!(f > 0)) return 0;
  let best = 0;
  for (let os = 0; os <= 7; os += 1) {
    if (f <= maxFreqForOs(os)) best = os;
    else break;
  }
  return best;
}

function decimateIndices(n, maxPoints) {
  if (!(n > 0)) return [];
  let m = Math.max(64, Math.trunc(maxPoints || 0));
  if (n <= m) {
    return Array.from({ length: n }, (_, i) => i);
  }
  const step = Math.ceil(n / m);
  const out = [];
  for (let i = 0; i < n; i += step) out.push(i);
  if (out[out.length - 1] !== (n - 1)) out.push(n - 1);
  return out;
}

function activeChannelIndices(mask) {
  const out = [];
  const m = Number(mask) & 0x0f;
  for (let i = 0; i < 4; i += 1) {
    if (((m >> i) & 0x1) !== 0) out.push(i);
  }
  return out;
}

function isoUtcNow() {
  return new Date().toISOString();
}

function sortPortPaths(paths) {
  const uniq = [...new Set((paths || []).map((p) => String(p || '').trim()).filter(Boolean))];
  return uniq.sort((a, b) => {
    const am = /^COM(\d+)$/i.exec(a);
    const bm = /^COM(\d+)$/i.exec(b);
    if (am && bm) return Number(am[1]) - Number(bm[1]);
    if (am) return -1;
    if (bm) return 1;
    return a.localeCompare(b);
  });
}

function listWindowsComPortsFallback() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '[System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { $_ }',
      ],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        const ports = String(stdout || '')
          .split(/\r?\n/g)
          .map((line) => line.trim())
          .filter(Boolean);
        resolve(sortPortPaths(ports));
      },
    );
  });
}

function listWindowsComPortsFromRegistry() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        const ports = [];
        for (const line of String(stdout || '').split(/\r?\n/g)) {
          const m = line.match(/\bCOM\d+\b/gi);
          if (m && m.length > 0) ports.push(...m);
        }
        resolve(sortPortPaths(ports));
      },
    );
  });
}

function listWindowsComPortsFromCim() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_SerialPort | Select-Object -ExpandProperty DeviceID',
      ],
      { windowsHide: true, timeout: 6000 },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        const ports = String(stdout || '')
          .split(/\r?\n/g)
          .map((line) => line.trim())
          .filter((line) => /^COM\d+$/i.test(line));
        resolve(sortPortPaths(ports));
      },
    );
  });
}

function prioritizePortPath(paths, preferredPort) {
  const preferred = String(preferredPort || '').trim();
  if (!preferred) return sortPortPaths(paths);
  const sorted = sortPortPaths(paths);
  const rest = sorted.filter((p) => p.toUpperCase() !== preferred.toUpperCase());
  return [preferred, ...rest];
}

class VisaSessionTransport {
  constructor(manager, resource, timeoutMs = 4000) {
    this.manager = manager;
    this.resource = String(resource || '').trim();
    this.timeoutMs = Math.max(100, Number(timeoutMs) || 4000);
    this.sessionId = null;
  }

  async ensureOpen() {
    if (this.sessionId) return this.sessionId;
    if (!this.resource) throw new Error('No VISA resource provided');
    const out = await this.manager.request('open', {
      resource: this.resource,
      timeoutMs: this.timeoutMs,
    }, Math.max(8000, this.timeoutMs + 4000));
    const id = String(out?.sessionId || '').trim();
    if (!id) throw new Error('Failed to open VISA session');
    this.sessionId = id;
    return this.sessionId;
  }

  async write(cmd) {
    const sessionId = await this.ensureOpen();
    let line = String(cmd || '');
    if (!line.endsWith('\n')) line = `${line}\n`;
    await this.manager.request('write', {
      sessionId,
      command: line,
    }, Math.max(2000, this.timeoutMs + 1000));
  }

  async query(cmd, maxBytes = 8192) {
    const sessionId = await this.ensureOpen();
    let line = String(cmd || '');
    if (!line.endsWith('\n')) line = `${line}\n`;
    const out = await this.manager.request('query', {
      sessionId,
      command: line,
      maxBytes: Math.max(64, Number(maxBytes) || 8192),
      timeoutMs: this.timeoutMs,
    }, Math.max(2500, this.timeoutMs + 1200));
    return String(out?.data || '').replace(/\r+$/g, '').trim();
  }

  async close() {
    if (!this.sessionId) return;
    const sessionId = this.sessionId;
    this.sessionId = null;
    try {
      await this.manager.request('close', { sessionId }, 5000);
    } catch (_) {
      // ignore close errors
    }
  }
}

class SerialLaserTransport {
  constructor(portPath, { baudRate = 9600, timeoutMs = 2000, terminator = '\r' } = {}) {
    this.portPath = String(portPath || '').trim();
    this.baudRate = Math.max(1200, Number(baudRate) || 9600);
    this.timeoutMs = Math.max(100, Number(timeoutMs) || 2000);
    this.terminator = String(terminator || '\r');
    this.port = null;
    this.rxBuffer = '';
    this.onData = (chunk) => {
      this.rxBuffer += Buffer.from(chunk || []).toString('ascii');
      if (this.rxBuffer.length > 65536) {
        this.rxBuffer = this.rxBuffer.slice(-32768);
      }
    };
  }

  _loadSerialPortCtor() {
    const pkg = require('serialport');
    return pkg?.SerialPort || pkg?.default || pkg;
  }

  async open() {
    if (this.port && this.port.isOpen) return;
    if (!this.portPath) throw new Error('No serial port provided');

    const SerialPort = this._loadSerialPortCtor();
    const port = new SerialPort({
      path: this.portPath,
      baudRate: this.baudRate,
      autoOpen: false,
    });

    await new Promise((resolve, reject) => {
      port.open((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    port.on('data', this.onData);
    this.port = port;
    this.rxBuffer = '';
  }

  async _drain() {
    if (!this.port || !this.port.isOpen) return;
    await new Promise((resolve, reject) => {
      this.port.drain((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  _lineWithTerminator(cmd) {
    let line = String(cmd || '').trim();
    if (!line) throw new Error('Empty command');
    if (!line.endsWith(this.terminator)) {
      line = `${line}${this.terminator}`;
    }
    return line;
  }

  async write(cmd) {
    await this.open();
    const line = this._lineWithTerminator(cmd);
    await new Promise((resolve, reject) => {
      this.port.write(Buffer.from(line, 'ascii'), (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
    await this._drain();
    await sleepMs(20);
  }

  _normalizeReply(raw) {
    const txt = String(raw || '').replace(/\0/g, '').replace(/\r/g, '\n');
    const lines = txt
      .split(/\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length > 0) return lines[lines.length - 1];
    return txt.trim();
  }

  async query(cmd, _maxBytes = 8192) {
    await this.open();
    this.rxBuffer = '';
    await this.write(cmd);

    const deadline = Date.now() + this.timeoutMs;
    let aggregated = '';
    while (Date.now() < deadline) {
      if (this.rxBuffer.length > 0) {
        aggregated += this.rxBuffer;
        this.rxBuffer = '';
        if (/[\r\n]/.test(aggregated)) {
          const out = this._normalizeReply(aggregated);
          if (out) return out;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      await sleepMs(20);
    }

    const out = this._normalizeReply(aggregated);
    if (out) return out;
    const e = new Error('Timeout waiting for serial response');
    e.code = 'FTDI_QUERY_TIMEOUT';
    throw e;
  }

  async close() {
    if (!this.port) return;
    const port = this.port;
    this.port = null;
    this.rxBuffer = '';
    try {
      port.off('data', this.onData);
    } catch (_) {
      // ignore
    }
    if (!port.isOpen) return;
    await new Promise((resolve) => {
      port.close(() => resolve());
    });
  }
}

class VisaManager {
  constructor() {
    this.client = null;
    this.bootError = null;
    this.isDev = !String(__dirname).includes('app.asar');
  }

  _asBootError(err) {
    return {
      code: err?.code || 'NI_VISA_NOT_FOUND',
      message: err?.message || String(err),
      checkedPaths: Array.isArray(err?.checkedPaths) ? err.checkedPaths : [],
    };
  }

  async ensureStarted() {
    if (!this.client) {
      this.client = new VisaServiceClient({
        isDev: this.isDev,
        autoRestart: true,
      });
    }
    try {
      await this.client.start();
      this.bootError = null;
      return this.client;
    } catch (err) {
      this.bootError = this._asBootError(err);
      throw err;
    }
  }

  async health() {
    try {
      const client = await this.ensureStarted();
      const h = await client.health();
      return { enabled: true, ...(h || {}) };
    } catch (err) {
      return {
        enabled: false,
        visaLoaded: false,
        resourceManager: false,
        gpibDetected: false,
        resourcesSample: [],
        checkedPaths: this.bootError?.checkedPaths || [],
        error: this._asBootError(err),
      };
    }
  }

  async request(method, params = {}, timeoutMs = 15000) {
    const client = await this.ensureStarted();
    return client.request(method, params, timeoutMs);
  }

  async listResources() {
    const rows = await this.request('listResources', {}, 12000);
    return Array.isArray(rows) ? rows.map((x) => String(x)) : [];
  }

  open(resource, timeoutMs = 4000) {
    const res = String(resource || '').trim();
    if (!res) throw new Error('No VISA resource provided');
    return new VisaSessionTransport(this, res, timeoutMs);
  }

  async stop() {
    if (!this.client) return;
    try {
      await this.client.stop();
    } finally {
      this.client = null;
      this.bootError = null;
    }
  }
}

class CoreDAQBackend {
  constructor({ portOverride = null, timeoutS = 0.2 }) {
    this.portOverride = portOverride || null;
    this.timeoutS = Number(timeoutS) > 0 ? Number(timeoutS) : 0.2;

    this.clients = new Set();
    this.devices = new Map();
    this.portToDevice = new Map();
    this.unsupportedPorts = new Map();
    this.activeDeviceId = null;
    this.lastDiscoveryMs = 0;
    this.discoveryInFlight = false;
    this.portRetryAtMs = new Map();
    this.manualTargetPorts = new Set();
    this.lastSerialPortDebug = [];

    this.streamEnabledGlobal = true;

    this.gpibResource = null;
    this.gpibIdn = null;
    this.gpibModel = null;
    this.ftdiResourceMeta = new Map();

    this.captureState = 'idle';
    this.captureMessage = '';
    this.lastSweep = null;

    this.running = true;

    this.visa = new VisaManager();
  }

  async close() {
    this.running = false;
    for (const [, s] of this.devices.entries()) {
      await this._closeSession(s);
    }
    this.devices.clear();
    this.portToDevice.clear();
    await this.visa.stop().catch(() => {});
  }

  _deviceStatusPayload(s) {
    return {
      device_id: s.device_id,
      connected: true,
      port: s.port,
      idn: s.idn,
      frontend_type: s.frontend_type,
      detector_type: s.detector_type,
      unsupported_firmware: false,
      unsupported_reason: null,
      freq_hz: s.freq_hz,
      os_idx: s.os_idx,
      wavelength_nm: s.wavelength_nm,
      wavelength_min_nm: s.wavelength_min_nm,
      wavelength_max_nm: s.wavelength_max_nm,
      gains: s.gains,
      autogain: !!s.autogain_enabled,
      streaming: !!(this.streamEnabledGlobal && s.stream_enabled),
      die_temp_c: s.die_temp_c,
      room_temp_c: s.room_temp_c,
      room_humidity_pct: s.room_humidity_pct,
      busy: !!s.busy,
    };
  }

  async _closeSession(s) {
    try {
      await s.dev.close();
    } catch (_) {
      // ignore
    }
  }

  async _dropSession(deviceId) {
    const s = this.devices.get(deviceId);
    if (!s) return;
    this.devices.delete(deviceId);
    this.portToDevice.delete(s.port);
    await this._closeSession(s);
    if (this.activeDeviceId === deviceId) {
      this.activeDeviceId = null;
    }
  }

  _makeUniqueDeviceId(base) {
    if (!this.devices.has(base)) return base;
    let idx = 2;
    while (true) {
      const candidate = `${base}_${idx}`;
      if (!this.devices.has(candidate)) return candidate;
      idx += 1;
    }
  }

  _pickDefaultActive() {
    if (this.devices.size === 0) return null;
    const entries = [...this.devices.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const linear = entries.find(([, s]) => String(s.frontend_type || '').toUpperCase() === CoreDAQ.FRONTEND_LINEAR);
    if (linear) return linear[0];
    return entries[0][0];
  }

  async _discoverCandidatePorts() {
    if (this.portOverride) {
      const listed = await this._listSerialPorts();
      return prioritizePortPath([this.portOverride, ...listed], this.portOverride);
    }
    if (this.manualTargetPorts.size > 0) {
      return sortPortPaths([...this.manualTargetPorts.values()]);
    }
    const envPort = String(process.env.COREDAQ_PORT || process.env.COREDAQ_PORT_HINT || '').trim();
    if (envPort) {
      return prioritizePortPath([envPort], envPort);
    }
    return [];
  }

  async _listSerialPorts() {
    const debug = [];
    let ports = [];
    try {
      const sp = require('serialport');
      const SerialPort = sp?.SerialPort || sp?.default || sp;
      const rows = await SerialPort.list();
      ports = Array.isArray(rows)
        ? rows.map((r) => String(r?.path || '').trim()).filter(Boolean)
        : [];
      debug.push(`serialport.list=${ports.length}`);
    } catch (err) {
      console.warn('[coredaq-service] serialport list failed:', err?.message || err);
      debug.push(`serialport.error=${String(err?.message || err)}`);
    }
    if (ports.length === 0) {
      const regPorts = await listWindowsComPortsFromRegistry();
      if (regPorts.length > 0) {
        ports = regPorts;
        debug.push(`fallback.registry=${regPorts.length}`);
      } else {
        debug.push('fallback.registry=0');
      }
    }
    if (ports.length === 0) {
      const cimPorts = await listWindowsComPortsFromCim();
      if (cimPorts.length > 0) {
        ports = cimPorts;
        debug.push(`fallback.cim=${cimPorts.length}`);
      } else {
        debug.push('fallback.cim=0');
      }
    }
    if (ports.length === 0) {
      const fallback = await listWindowsComPortsFallback();
      if (fallback.length > 0) {
        console.warn(`[coredaq-service] using Windows COM fallback list (${fallback.length} ports).`);
        ports = fallback;
        debug.push(`fallback.winapi=${fallback.length}`);
      } else {
        debug.push('fallback.winapi=0');
      }
    }
    debug.push(`node_path=${String(process.env.NODE_PATH || '').split(path.delimiter).length}`);
    const out = sortPortPaths(ports);
    this.lastSerialPortDebug = debug;
    return out;
  }

  async _connectPort(port, { probeTimeoutMs = 0 } = {}) {
    const portPath = String(port || '').trim();
    if (!portPath) {
      return { ok: false, code: 'INVALID_PORT', error: new Error('No COM port selected.') };
    }

    const existingDeviceId = this.portToDevice.get(portPath);
    if (existingDeviceId && this.devices.has(existingDeviceId)) {
      return { ok: true, reused: true, deviceId: existingDeviceId };
    }

    if (this.devices.size >= MAX_CONNECTED_DEVICES) {
      return {
        ok: false,
        code: 'MAX_DEVICES',
        error: new Error(`Maximum ${MAX_CONNECTED_DEVICES} CoreDAQ devices can be connected.`),
      };
    }

    if (probeTimeoutMs > 0 && typeof CoreDAQ._probe_idn === 'function') {
      let probeOk = false;
      try {
        probeOk = await withTimeout(
          CoreDAQ._probe_idn(portPath, 115200, 0.15),
          probeTimeoutMs,
          'COREDAQ_PROBE_TIMEOUT',
        );
      } catch (_) {
        probeOk = false;
      }
      if (!probeOk) {
        return {
          ok: false,
          code: 'NOT_COREDAQ',
          error: new Error(`${portPath} did not identify as CoreDAQ within 1 second.`),
        };
      }
    }

    let dev = null;
    let openErr = null;
    const openTimeouts = [
      Math.max(this.timeoutS, 0.5),
      1.5,
      3.0,
    ].filter((v, i, arr) => arr.indexOf(v) === i);
    for (const t of openTimeouts) {
      try {
        // eslint-disable-next-line no-await-in-loop
        dev = await CoreDAQ.open(portPath, t, 0.0);
        openErr = null;
        break;
      } catch (err) {
        openErr = err;
        dev = null;
        // Device may still be booting after USB open; avoid hammering immediate retries.
        // eslint-disable-next-line no-await-in-loop
        await sleepMs(DISCOVERY_OPEN_RETRY_SETTLE_MS);
      }
    }
    if (!dev) {
      return {
        ok: false,
        code: 'OPEN_FAILED',
        error: openErr || new Error(`Failed to open ${portPath}`),
      };
    }

    let idn = '';
    try {
      idn = await dev.idn();
    } catch (_) {
      idn = '';
    }

    if (!String(idn).toUpperCase().includes('COREDAQ')) {
      await dev.close().catch(() => {});
      return {
        ok: false,
        code: 'NOT_COREDAQ',
        error: new Error(`${portPath} is not a CoreDAQ device.`),
      };
    }

    const major = fwMajorFromIdn(idn);
    const baseId = deviceKeyFromIdn(idn, portPath);

    if (major === 3) {
      this.unsupportedPorts.set(portPath, {
        device_id: baseId,
        connected: true,
        port: portPath,
        idn,
        frontend_type: 'UNKNOWN',
        unsupported_firmware: true,
        unsupported_reason: 'Firmware v3 is not supported. Please upgrade to firmware v4.',
      });
      await dev.close().catch(() => {});
      return {
        ok: false,
        code: 'UNSUPPORTED_FW',
        error: new Error('Firmware v3 is not supported. Please upgrade to firmware v4.'),
      };
    }

    let frontendType = 'UNKNOWN';
    try {
      frontendType = String(dev.frontend_type() || 'UNKNOWN').toUpperCase();
    } catch (_) {
      frontendType = 'UNKNOWN';
    }

    const deviceId = this._makeUniqueDeviceId(baseId);

    const s = {
      device_id: deviceId,
      port: portPath,
      dev,
      idn,
      frontend_type: frontendType,
      detector_type: CoreDAQ.DETECTOR_INGAAS,
      wavelength_nm: null,
      wavelength_min_nm: null,
      wavelength_max_nm: null,
      stream_enabled: true,
      autogain_enabled: false,
      fixed_freq_hz: 500,
      default_os_idx: 6,
      last_autogain: 0,
      freq_hz: null,
      os_idx: null,
      gains: null,
      die_temp_c: null,
      room_temp_c: null,
      room_humidity_pct: null,
      busy: false,
      stream_error_streak: 0,
      last_status_poll_ts: 0,
    };

    try {
      s.detector_type = normalizeDetectorType(dev.detector_type());
    } catch (_) {
      s.detector_type = detectDetectorTypeFromIdn(idn);
    }

    try {
      dev.set_detector_type(s.detector_type);
    } catch (_) {
      // ignore
    }

    try {
      const lim = dev.get_wavelength_limits_nm(s.detector_type);
      s.wavelength_min_nm = Number(lim[0]);
      s.wavelength_max_nm = Number(lim[1]);
    } catch (_) {
      const [lo, hi] = fallbackWavelengthLimits(s.detector_type);
      s.wavelength_min_nm = lo;
      s.wavelength_max_nm = hi;
    }

    const defaultWl = defaultWavelengthNm(s.detector_type);
    try {
      dev.set_wavelength_nm(defaultWl);
    } catch (_) {
      // ignore
    }
    try {
      s.wavelength_nm = Number(dev.get_wavelength_nm());
    } catch (_) {
      s.wavelength_nm = defaultWl;
    }

    if (s.frontend_type === CoreDAQ.FRONTEND_LOG) {
      s.autogain_enabled = false;
    }

    try {
      await dev.set_freq(s.fixed_freq_hz);
      await dev.set_oversampling(s.default_os_idx);
    } catch (_) {
      // ignore
    }

    this.devices.set(deviceId, s);
    this.portToDevice.set(portPath, deviceId);
    this.unsupportedPorts.delete(portPath);

    return { ok: true, reused: false, deviceId };
  }

  async discoverDevices(force = false) {
    if (this.discoveryInFlight) return;
    const now = Date.now();
    if (!force && (now - this.lastDiscoveryMs) < DISCOVERY_INTERVAL_MS) return;
    this.lastDiscoveryMs = now;
    this.discoveryInFlight = true;

    try {
      const candidatePorts = await this._discoverCandidatePorts();

      const present = new Set(candidatePorts);

      for (const [port, deviceId] of [...this.portToDevice.entries()]) {
        if (!present.has(port)) {
          // eslint-disable-next-line no-await-in-loop
          await this._dropSession(deviceId);
          this.portRetryAtMs.delete(port);
        }
      }

      for (const port of [...this.unsupportedPorts.keys()]) {
        if (!present.has(port)) {
          this.unsupportedPorts.delete(port);
          this.portRetryAtMs.delete(port);
        }
      }

      for (const port of candidatePorts) {
        if (this.devices.size >= MAX_CONNECTED_DEVICES) break;
        if (this.portToDevice.has(port)) continue;
        const retryAt = Number(this.portRetryAtMs.get(port) || 0);
        if (!force && retryAt > Date.now()) continue;

        // eslint-disable-next-line no-await-in-loop
        const result = await this._connectPort(port);
        if (!result.ok) {
          if (result.code !== 'MAX_DEVICES' && result.error) {
            console.warn(`[coredaq-service] connect failed for ${port}:`, result.error?.message || result.error);
          }
          this.portRetryAtMs.set(port, Date.now() + DISCOVERY_OPEN_RETRY_BACKOFF_MS);
          if (result.code === 'MAX_DEVICES') break;
          continue;
        }
        this.portRetryAtMs.delete(port);
      }

      if (!this.activeDeviceId || !this.devices.has(this.activeDeviceId)) {
        this.activeDeviceId = this._pickDefaultActive();
      }
    } finally {
      this.discoveryInFlight = false;
    }
  }

  _getSession(requestedDeviceId, { requireLinear = false } = {}) {
    let s = null;
    if (requestedDeviceId && this.devices.has(requestedDeviceId)) {
      s = this.devices.get(requestedDeviceId);
    }
    if (!s && this.activeDeviceId && this.devices.has(this.activeDeviceId)) {
      s = this.devices.get(this.activeDeviceId);
    }
    if (!s && this.devices.size > 0) {
      const first = [...this.devices.keys()].sort()[0];
      s = this.devices.get(first);
    }
    if (!s) throw new Error('No supported CoreDAQ device connected');

    if (requireLinear && s.frontend_type !== CoreDAQ.FRONTEND_LINEAR) {
      throw new Error('This operation is only available on LINEAR front-end devices');
    }

    return s;
  }

  _setActiveDevice(deviceId) {
    if (!this.devices.has(deviceId)) {
      throw new Error(`Unknown device_id: ${deviceId}`);
    }
    this.activeDeviceId = deviceId;
  }

  async _pollSessionStatus(s) {
    if (s.busy) return true;

    const now = nowSec();
    const isStreaming = this.streamEnabledGlobal && s.stream_enabled;
    const minPollInterval = isStreaming ? 2.0 : 0.5;
    if ((now - s.last_status_poll_ts) < minPollInterval) {
      return true;
    }

    try {
      s.freq_hz = Number(await s.dev.get_freq_hz());
      s.os_idx = Number(await s.dev.get_oversampling());
      if (s.frontend_type === CoreDAQ.FRONTEND_LINEAR) {
        const gains = await s.dev.get_gains();
        s.gains = [0, 1, 2, 3].map((i) => Number(gains[i] || 0));
      } else {
        s.gains = null;
      }
    } catch (_) {
      await this._dropSession(s.device_id);
      return false;
    }

    try {
      s.detector_type = normalizeDetectorType(s.dev.detector_type());
    } catch (_) {
      if (!s.detector_type) s.detector_type = detectDetectorTypeFromIdn(s.idn);
    }

    try {
      s.wavelength_nm = Number(s.dev.get_wavelength_nm());
    } catch (_) {
      // ignore
    }

    try {
      const lim = s.dev.get_wavelength_limits_nm(s.detector_type);
      s.wavelength_min_nm = Number(lim[0]);
      s.wavelength_max_nm = Number(lim[1]);
    } catch (_) {
      if (s.wavelength_min_nm == null || s.wavelength_max_nm == null) {
        const [lo, hi] = fallbackWavelengthLimits(s.detector_type);
        s.wavelength_min_nm = lo;
        s.wavelength_max_nm = hi;
      }
    }

    try {
      s.die_temp_c = Number(await s.dev.get_die_temperature_C());
    } catch (_) {
      s.die_temp_c = null;
    }
    try {
      s.room_temp_c = Number(await s.dev.get_head_temperature_C());
    } catch (_) {
      s.room_temp_c = null;
    }
    try {
      s.room_humidity_pct = Number(await s.dev.get_head_humidity());
    } catch (_) {
      s.room_humidity_pct = null;
    }

    s.last_status_poll_ts = now;
    return true;
  }

  async broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of [...this.clients]) {
      if (ws.readyState !== ws.OPEN) continue;
      try {
        ws.send(data);
      } catch (_) {
        // ignore send errors
      }
    }
  }

  async statusLoop() {
    while (this.running) {
      try {
        const anyStreaming = [...this.devices.values()].some((s) => this.streamEnabledGlobal && s.stream_enabled);
        if (!anyStreaming) {
          this.discoverDevices(false).catch((err) => {
            console.warn('[coredaq-service-js] discover error:', err?.message || err);
          });
        }

        for (const [, s] of [...this.devices.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          // eslint-disable-next-line no-await-in-loop
          await this._pollSessionStatus(s);
        }

        if (!this.activeDeviceId || !this.devices.has(this.activeDeviceId)) {
          this.activeDeviceId = this._pickDefaultActive();
        }

        const deviceRows = [...this.devices.values()]
          .sort((a, b) => a.device_id.localeCompare(b.device_id))
          .map((s) => this._deviceStatusPayload(s));

        for (const [, row] of [...this.unsupportedPorts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
          deviceRows.push({ ...row });
        }

        const active = this.activeDeviceId ? this.devices.get(this.activeDeviceId) : null;
        const unsupportedRows = deviceRows.filter((d) => !!d.unsupported_firmware);

        await this.broadcast({
          type: 'status',
          connected: this.devices.size > 0,
          device_count: this.devices.size,
          devices: deviceRows,
          active_device_id: this.activeDeviceId,
          port_override: this.portOverride,

          port: active ? active.port : null,
          idn: active ? active.idn : null,
          detector_type: active ? active.detector_type : null,
          freq_hz: active ? active.freq_hz : null,
          os_idx: active ? active.os_idx : null,
          wavelength_nm: active ? active.wavelength_nm : null,
          wavelength_min_nm: active ? active.wavelength_min_nm : null,
          wavelength_max_nm: active ? active.wavelength_max_nm : null,
          gains: active ? active.gains : null,
          autogain: active ? active.autogain_enabled : false,
          streaming: active ? (this.streamEnabledGlobal && active.stream_enabled) : false,
          die_temp_c: active ? active.die_temp_c : null,
          room_temp_c: active ? active.room_temp_c : null,
          room_humidity_pct: active ? active.room_humidity_pct : null,
          unsupported_firmware: unsupportedRows.length > 0,
          unsupported_reason: unsupportedRows.length > 0 ? unsupportedRows[0].unsupported_reason : null,

          gpib_resource: this.gpibResource,
          gpib_idn: this.gpibIdn,
          gpib_model: this.gpibModel,
          capture_state: this.captureState,
          capture_message: this.captureMessage,
        });
      } catch (err) {
        console.warn('[coredaq-service] status loop error:', err?.message || err);
      }

      // Keep UI status smooth but avoid serial pressure.
      // eslint-disable-next-line no-await-in-loop
      await sleepMs(1000);
    }
  }

  async streamLoop() {
    const normalizeStreamSnapshot = (raw) => {
      let powerW = null;
      let adcMv = null;

      if (Array.isArray(raw) && Array.isArray(raw[0])) {
        powerW = raw[0];
        if (Array.isArray(raw[1])) adcMv = raw[1];
      } else {
        powerW = raw;
      }

      if (!Array.isArray(powerW) || powerW.length < 4) {
        throw new Error('Invalid power snapshot payload');
      }

      const out = {
        powerW: [0, 1, 2, 3].map((i) => Number(powerW[i] || 0)),
        adcMv: null,
      };
      if (Array.isArray(adcMv) && adcMv.length >= 4) {
        out.adcMv = [0, 1, 2, 3].map((i) => Number(adcMv[i] || 0));
      }
      return out;
    };

    const readStreamSnapshot = async (session, autogainEnabled) => {
      const raw = await session.dev.snapshot_W(
        1,
        1.0,
        200.0,
        null,
        !!autogainEnabled,
        100.0,
        3000.0,
        10,
        0.01,
        true,
      );
      return normalizeStreamSnapshot(raw);
    };

    const publishStreamSnapshot = async (session, sample) => {
      const msg = {
        type: 'stream',
        device_id: session.device_id,
        frontend_type: session.frontend_type,
        ts: nowSec(),
        ch: sample.powerW,
      };
      if (Array.isArray(sample.adcMv)) {
        msg.adc_mv = sample.adcMv;
        msg.adc_v = sample.adcMv.map((mv) => mv / 1000.0);
      }
      await this.broadcast(msg);
    };

    while (this.running) {
      if (!this.streamEnabledGlobal || this.devices.size === 0) {
        // eslint-disable-next-line no-await-in-loop
        await sleepMs(200);
        continue;
      }

      for (const [, s] of [...this.devices.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (!this.streamEnabledGlobal || !s.stream_enabled || s.busy) continue;

        try {
          let sample = null;
          if (s.frontend_type === CoreDAQ.FRONTEND_LINEAR && s.autogain_enabled) {
            if ((nowSec() - s.last_autogain) > 1.0) {
              try {
                // Reuse this snapshot for streaming to avoid duplicate USB transactions.
                // eslint-disable-next-line no-await-in-loop
                sample = await readStreamSnapshot(s, true);
                s.last_autogain = nowSec();
              } catch (_) {
                sample = null;
              }
            }
          }

          if (!sample) {
            // eslint-disable-next-line no-await-in-loop
            sample = await readStreamSnapshot(s, false);
          }

          // eslint-disable-next-line no-await-in-loop
          await publishStreamSnapshot(s, sample);
          s.stream_error_streak = 0;
        } catch (err) {
          let recovered = false;
          let lastErr = err;

          for (let attempt = 0; attempt < STREAM_SNAPSHOT_RETRIES; attempt += 1) {
            try {
              // eslint-disable-next-line no-await-in-loop
              await sleepMs(STREAM_SNAPSHOT_RETRY_DELAY_MS);
              // eslint-disable-next-line no-await-in-loop
              const retrySample = await readStreamSnapshot(s, false);
              // eslint-disable-next-line no-await-in-loop
              await publishStreamSnapshot(s, retrySample);
              s.stream_error_streak = 0;
              recovered = true;
              break;
            } catch (retryErr) {
              lastErr = retryErr;
            }
          }

          if (recovered) continue;

          s.stream_error_streak += 1;
          if (s.stream_error_streak === 1 || s.stream_error_streak >= STREAM_MAX_CONSEC_ERRORS) {
            console.warn(
              '[coredaq-service] stream snapshot failed (' + s.device_id + ') streak=' + s.stream_error_streak + ': ' + String(lastErr?.message || lastErr),
            );
          }
          if (s.stream_error_streak >= STREAM_MAX_CONSEC_ERRORS) {
            // eslint-disable-next-line no-await-in-loop
            await this._dropSession(s.device_id);
          }
        }
      }

      // eslint-disable-next-line no-await-in-loop
      await sleepMs(LIVE_STREAM_PERIOD_MS);
    }
  }

  _buildSweepSeries(channelsW, startNm, stopNm, sampleRateHz, samplesTotal, previewPoints) {
    const span = Number(stopNm) - Number(startNm);
    const sr = Number(sampleRateHz);
    const durationS = (samplesTotal > 1 && sr > 0) ? ((samplesTotal - 1) / sr) : 1.0;
    const idx = decimateIndices(samplesTotal, previewPoints);
    const xPreview = idx.map((i) => {
      const t = i / Number(sampleRateHz);
      return Number(startNm) + span * (t / durationS);
    });

    const colors = ['#4DD0E1', '#FFB454', '#7BE7A1', '#FF7AA2'];
    const series = [];

    for (let ch = 0; ch < 4; ch += 1) {
      const y = Array.isArray(channelsW[ch]) ? channelsW[ch] : [];
      const data = idx.map((sampleIdx, k) => [xPreview[k], Number(y[sampleIdx] || 0)]);
      series.push({
        name: `CH${ch + 1}`,
        color: colors[ch],
        data,
      });
    }

    return series;
  }

  _isFtdiResource(resource) {
    return String(resource || '').trim().toUpperCase().startsWith(FTDI_RESOURCE_PREFIX);
  }

  _parseFtdiResource(resource) {
    const txt = String(resource || '').trim();
    if (!this._isFtdiResource(txt)) {
      throw new Error('Not an FTDI resource');
    }
    const body = txt.slice(FTDI_RESOURCE_PREFIX.length);
    const [pathPart, paramPart] = body.split(';', 2);
    const portPath = String(pathPart || '').trim();
    if (!portPath) throw new Error('Invalid FTDI resource');
    let baud = null;
    if (paramPart) {
      const m = /BAUD\s*=\s*(\d+)/i.exec(paramPart);
      if (m) {
        const b = Number.parseInt(m[1], 10);
        if (Number.isFinite(b) && b > 0) baud = b;
      }
    }
    return { portPath, baud };
  }

  _isLikelyFtdiPort(row) {
    const vid = String(row?.vendorId || '').trim().toLowerCase();
    if (FTDI_VENDOR_IDS.has(vid)) return true;

    const mfg = String(row?.manufacturer || '').toUpperCase();
    if (mfg.includes('SANTEC') || mfg.includes('FTDI')) return true;

    const pnp = String(row?.pnpId || '').toUpperCase();
    if (pnp.includes('VID_0403')) return true;

    return false;
  }

  async _getSerialPortDetails() {
    try {
      const sp = require('serialport');
      const SerialPort = sp?.SerialPort || sp?.default || sp;
      const rows = await SerialPort.list();
      if (!Array.isArray(rows)) return [];
      return rows.map((row) => ({
        path: String(row?.path || '').trim(),
        manufacturer: String(row?.manufacturer || '').trim(),
        serialNumber: String(row?.serialNumber || '').trim(),
        pnpId: String(row?.pnpId || '').trim(),
        vendorId: String(row?.vendorId || '').trim(),
        productId: String(row?.productId || '').trim(),
      })).filter((row) => !!row.path);
    } catch (_) {
      return [];
    }
  }

  async _checkFtdiDriver() {
    if (process.platform !== 'win32') {
      return { ok: true, details: ['non-windows'] };
    }
    const resourcesPath = String(process.resourcesPath || '').trim();
    const bundledDllPaths = [
      resourcesPath ? path.join(resourcesPath, 'ftdi-driver', 'win64', 'FTD2XX64.dll') : '',
      resourcesPath ? path.join(resourcesPath, 'ftdi-driver', 'FTD2XX64.dll') : '',
      path.join(ROOT, 'packages', 'ftdi-driver', 'win64', 'FTD2XX64.dll'),
      path.join(ROOT, 'ftdi-driver', 'win64', 'FTD2XX64.dll'),
    ].filter(Boolean);

    const dllPaths = [
      'C:\\Windows\\System32\\ftd2xx.dll',
      'C:\\Windows\\SysWOW64\\ftd2xx.dll',
      'C:\\Windows\\System32\\ftd2xx64.dll',
      'C:\\Windows\\SysWOW64\\ftd2xx64.dll',
      ...bundledDllPaths,
    ];
    const foundDll = dllPaths.find((p) => fs.existsSync(p)) || null;

    let hasService = false;
    try {
      const outBus = await execFileAsync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\FTDIBUS'], {
        windowsHide: true,
        timeout: 3000,
      });
      hasService = /FTDIBUS/i.test(String(outBus?.stdout || ''));
    } catch (_) {
      // ignore
    }

    if (!hasService) {
      try {
        const outSer = await execFileAsync('reg.exe', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Services\\FTSER2'], {
          windowsHide: true,
          timeout: 3000,
        });
        hasService = /FTSER2/i.test(String(outSer?.stdout || ''));
      } catch (_) {
        // ignore
      }
    }

    return {
      ok: !!(foundDll || hasService),
      details: [
        foundDll ? `dll=${foundDll}` : 'dll=not-found',
        `service=${hasService ? 'present' : 'missing'}`,
      ],
    };
  }

  async _openFtdiTransport(resource, opts = {}) {
    const { portPath, baud } = this._parseFtdiResource(resource);
    const timeoutMs = Math.max(400, Math.round(Number(opts.timeoutMs) || 1800));
    const probeIdn = opts.probeIdn !== false;

    const remembered = this.ftdiResourceMeta.get(`FTDI::${portPath}`) || this.ftdiResourceMeta.get(resource) || {};
    const baudCandidates = [];
    if (baud) baudCandidates.push(baud);
    if (Number.isFinite(remembered?.baud) && remembered.baud > 0) baudCandidates.push(remembered.baud);
    for (const b of FTDI_BAUD_CANDIDATES) baudCandidates.push(b);

    const uniqueBauds = [...new Set(baudCandidates.map((b) => Math.trunc(Number(b))).filter((b) => Number.isFinite(b) && b > 0))];
    const rememberedTerminator = String(remembered?.terminator || '').trim();
    const terminatorCandidates = [...new Set([
      rememberedTerminator,
      '\r',
      '\n',
      '\r\n',
    ].filter((t) => typeof t === 'string' && t.length > 0))];
    const failures = [];

    for (const candidateBaud of uniqueBauds) {
      for (const terminator of terminatorCandidates) {
        const transport = new SerialLaserTransport(portPath, {
          baudRate: candidateBaud,
          timeoutMs,
          terminator,
        });
        try {
          // eslint-disable-next-line no-await-in-loop
          await transport.open();

          let idn = '';
          let model = null;
          if (probeIdn) {
            try {
              // eslint-disable-next-line no-await-in-loop
              idn = await transport.query('*IDN?', 4096);
            } catch (_) {
              idn = '';
            }
            if (!idn) {
              try {
                // eslint-disable-next-line no-await-in-loop
                idn = await transport.query('IDN?', 4096);
              } catch (_) {
                idn = '';
              }
            }
            model = detectLaserModel(idn);
            const upper = String(idn || '').toUpperCase();
            if (!idn || (!model && !upper.includes('SANTEC') && !upper.includes('TSL'))) {
              throw new Error('No valid TSL IDN response');
            }
          }

          const normalizedResource = `FTDI::${portPath}`;
          this.ftdiResourceMeta.set(normalizedResource, {
            baud: candidateBaud,
            terminator,
            command_set: remembered?.command_set || 'legacy',
          });

          return {
            transport,
            resource: normalizedResource,
            portPath,
            baud: candidateBaud,
            terminator,
            idn,
            model,
            command_set: remembered?.command_set || 'legacy',
          };
        } catch (err) {
          failures.push(`baud=${candidateBaud}, term=${JSON.stringify(terminator)}: ${String(err?.message || err)}`);
          // eslint-disable-next-line no-await-in-loop
          await transport.close().catch(() => {});
        }
      }
    }
    const e = new Error(`Unable to open FTDI resource ${portPath}: ${failures.join(' | ')}`);
    e.code = 'FTDI_OPEN_FAILED';
    throw e;
  }

  async _scanFtdiResourcesJs(timeoutMs = FTDI_SCAN_TIMEOUT_MAX_MS) {
    const warnings = [];
    const rows = [];
    const debug = [];
    const scanBudgetMs = Math.min(FTDI_SCAN_TIMEOUT_MAX_MS, Math.max(1500, Number(timeoutMs) || FTDI_SCAN_TIMEOUT_MAX_MS));
    const deadlineMs = Date.now() + scanBudgetMs;

    const driver = await this._checkFtdiDriver();
    if (!driver.ok) {
      warnings.push(`FTDI driver not detected (${driver.details.join(', ')}).`);
    }

    const details = await this._getSerialPortDetails();
    const likely = details.filter((row) => this._isLikelyFtdiPort(row));

    let candidatePorts = likely.map((row) => row.path);
    if (candidatePorts.length === 0) {
      candidatePorts = sortPortPaths(details.map((row) => row.path));
      candidatePorts = candidatePorts.sort((a, b) => {
        const ma = /^COM(\d+)$/i.exec(a);
        const mb = /^COM(\d+)$/i.exec(b);
        if (ma && mb) return Number(mb[1]) - Number(ma[1]);
        if (ma) return -1;
        if (mb) return 1;
        return b.localeCompare(a);
      });
    } else {
      candidatePorts = sortPortPaths(candidatePorts);
    }
    candidatePorts = candidatePorts.slice(0, 20);

    for (const portPath of candidatePorts) {
      if (Date.now() >= deadlineMs) break;
      const resource = `FTDI::${portPath}`;
      try {
        // eslint-disable-next-line no-await-in-loop
        const opened = await this._openFtdiTransport(resource, {
          timeoutMs: Math.min(1600, Math.max(700, deadlineMs - Date.now())),
          probeIdn: true,
        });
        const idn = String(opened?.idn || '').trim() || null;
        const model = opened?.model || (idn ? detectLaserModel(idn) : null);
        this.ftdiResourceMeta.set(resource, {
          baud: opened?.baud || null,
          terminator: opened?.terminator || '\r',
          command_set: 'legacy',
        });
        rows.push({
          resource,
          idn,
          model,
          backend: 'ftdi-serial',
          baud: opened?.baud || null,
          terminator: opened?.terminator || '\r',
          command_set: 'legacy',
        });
        // eslint-disable-next-line no-await-in-loop
        await opened.transport.close().catch(() => {});
      } catch (err) {
        debug.push(`${resource} probe failed: ${String(err?.code || err?.message || err)}`);
      }
    }
    if (rows.length === 0) {
      if (!driver.ok) {
        warnings.push('No FTDI laser resources detected. Install FTDI D2XX/VCP driver and bind the laser in Device Manager (Update driver -> Browse my computer -> FTDI folder), then reconnect.');
      } else {
        warnings.push('No FTDI laser resources detected on serial ports. If the laser is in D2XX-only mode, switch/bind it to FTDI VCP in Device Manager or use a JS D2XX backend.');
      }
    }

    return {
      rows,
      warnings,
      debug,
      backend: 'ftdi-serial',
    };
  }

  async _queryFtdiJs(resource, cmd, timeoutMs = 4000) {
    const opened = await this._openFtdiTransport(resource, {
      timeoutMs: Math.min(2400, Math.max(700, timeoutMs)),
      probeIdn: false,
    });
    try {
      const command = String(cmd || '').trim();
      const reply = String(await opened.transport.query(command, 8192) || '').trim();
      let model = opened.model || null;
      if (!model && (command.toUpperCase() === '*IDN?' || command.toUpperCase() === 'IDN?')) {
        model = detectLaserModel(reply) || null;
      }
      return {
        resource: opened.resource,
        command,
        reply,
        model,
        backend: 'ftdi-serial',
        baud: opened.baud,
      };
    } finally {
      await opened.transport.close().catch(() => {});
    }
  }

  async _sweepFtdiJs(payload = {}, timeoutMs = 30000) {
    const resource = String(payload?.resource || '').trim();
    const startNm = Number(payload?.start_nm);
    const stopNm = Number(payload?.stop_nm);
    const powerMw = Number(payload?.power_mw);
    const speedNmS = Number(payload?.speed_nm_s);
    const pollIntervalMs = Math.max(100, Math.round(Number(payload?.poll_interval_ms) || 250));
    const acquisitionWaitS = Math.max(0, Number(payload?.acquisition_wait_s) || 0);

    const opened = await this._openFtdiTransport(resource, {
      timeoutMs: Math.min(3000, Math.max(1000, timeoutMs)),
      probeIdn: false,
    });

    try {
      let idn = String(opened.idn || '').trim();
      if (!idn) {
        try {
          idn = String(await opened.transport.query('*IDN?', 4096) || '').trim();
        } catch (_) {
          idn = '';
        }
      }

      const created = createLaserFromIdn(idn, opened.transport, { commandSet: 'legacy' });
      const laser = created.laser;
      const model = created.model || opened.model || detectLaserModel(idn) || null;
      await laser.configureForSweep({ startNm, stopNm, powerMw, speedNmS });
      await laser.startSweep();
      if (acquisitionWaitS > 0) {
        await sleepMs(Math.round(acquisitionWaitS * 1000));
      }
      const sweepState = await laser.waitForSweepComplete({
        timeoutMs: Math.max(1000, Math.round(Number(timeoutMs) || 30000)),
        pollIntervalMs,
      });

      return {
        resource: opened.resource,
        idn,
        model,
        backend: 'ftdi-serial',
        sweep_state: sweepState,
        baud: opened.baud,
      };
    } finally {
      await opened.transport.close().catch(() => {});
    }
  }

  async _setFtdiWavelengthJs(payload = {}, timeoutMs = 8000) {
    const resource = String(payload?.resource || '').trim();
    const wavelengthNm = Number(payload?.wavelength_nm);

    const opened = await this._openFtdiTransport(resource, {
      timeoutMs: Math.min(2600, Math.max(700, timeoutMs)),
      probeIdn: false,
    });
    try {
      let idn = String(opened.idn || '').trim();
      if (!idn) {
        try {
          idn = String(await opened.transport.query('*IDN?', 4096) || '').trim();
        } catch (_) {
          idn = '';
        }
      }

      const created = createLaserFromIdn(idn, opened.transport, { commandSet: 'legacy' });
      await created.laser.setWavelengthNm(wavelengthNm);

      let readback = '';
      try {
        readback = await opened.transport.query('WA', 128);
      } catch (_) {
        readback = '';
      }

      return {
        resource: opened.resource,
        backend: 'ftdi-serial',
        readback,
        baud: opened.baud,
      };
    } finally {
      await opened.transport.close().catch(() => {});
    }
  }

  async _runFtdiHelper(action, payload = {}, timeoutMs = 15000) {
    const act = String(action || '').trim().toLowerCase();
    if (act === 'scan') {
      const out = await this._scanFtdiResourcesJs(timeoutMs);
      return { ok: true, ...out };
    }
    if (act === 'query') {
      const out = await this._queryFtdiJs(payload?.resource, payload?.cmd || payload?.command, timeoutMs);
      return { ok: true, ...out };
    }
    if (act === 'sweep') {
      const out = await this._sweepFtdiJs(payload, timeoutMs);
      return { ok: true, ...out };
    }
    if (act === 'set_wavelength') {
      const out = await this._setFtdiWavelengthJs(payload, timeoutMs);
      return { ok: true, ...out };
    }
    if (act === 'health') {
      const driver = await this._checkFtdiDriver();
      return {
        ok: true,
        backend: 'ftdi-serial',
        driver_ok: !!driver.ok,
        details: driver.details,
      };
    }
    throw new Error(`Unsupported FTDI action: ${action}`);
  }
  _mergeLaserScanRows(rows) {
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const resource = String(row?.resource || '').trim();
      if (!resource) continue;
      const prev = map.get(resource) || {};
      map.set(resource, {
        resource,
        idn: row?.idn ?? prev.idn ?? null,
        model: row?.model ?? prev.model ?? null,
        backend: row?.backend ?? prev.backend ?? null,
      });
    }
    return [...map.values()].sort((a, b) => a.resource.localeCompare(b.resource));
  }

  async _gpibScan(opts = {}) {
    const timeoutMs = Math.max(500, Math.trunc(Number(opts.timeout_ms ?? 5000)));
    const deadlineMs = Date.now() + timeoutMs;
    const debug = [];
    const rows = [];
    const visaWarnings = [];
    const ftdiWarnings = [];
    let timedOut = false;

    const probeVisaResources = async (resources, tag = '') => {
      const normalized = [];
      const seen = new Set();
      for (const raw of Array.isArray(resources) ? resources : []) {
        const resource = String(raw || '').trim();
        if (!resource || seen.has(resource)) continue;
        seen.add(resource);
        normalized.push(resource);
      }

      const rowByResource = new Map();
      for (const resource of normalized) {
        const row = {
          resource,
          idn: null,
          model: null,
          backend: 'visa-service',
        };
        rows.push(row);
        rowByResource.set(resource, row);
      }

      // Return the full VISA list first. Probe only GPIB rows for IDN/model.
      const gpibProbeQueue = normalized
        .filter((resource) => /^GPIB\d+::/i.test(resource))
        .sort((a, b) => a.localeCompare(b));

      debug.push(`visa resources=${normalized.length}${tag}, gpibProbe=${gpibProbeQueue.length}`);
      for (const resource of gpibProbeQueue) {
        const remainingMs = deadlineMs - Date.now();
        if (remainingMs <= 0) {
          debug.push('scan deadline reached during GPIB probe; returning listed VISA resources');
          timedOut = true;
          break;
        }

        try {
          // eslint-disable-next-line no-await-in-loop
          const ioTimeoutMs = Math.max(300, Math.min(1200, remainingMs - 40));
          const transport = this.visa.open(resource, ioTimeoutMs);
          try {
            // eslint-disable-next-line no-await-in-loop
            const idn = await withTimeout(
              transport.query('*IDN?', 2048),
              Math.max(300, Math.min(ioTimeoutMs + 500, remainingMs - 20)),
              'GPIB_SCAN_QUERY_TIMEOUT',
            );
            const model = detectLaserModel(idn);
            const row = rowByResource.get(resource);
            if (row) {
              row.idn = idn;
              row.model = model;
            }
          } finally {
            // eslint-disable-next-line no-await-in-loop
            await withTimeout(transport.close(), 800, 'GPIB_SCAN_CLOSE_TIMEOUT').catch(() => {});
          }
        } catch (err) {
          debug.push(`${resource} probe failed: ${String(err?.code || err?.message || err)}`);
        }
      }
    };
    const visaHealthBudgetMs = Math.max(1200, Math.min(7000, Math.max(1500, timeoutMs - 200)));
    let visaHealth = null;
    try {
      visaHealth = await withTimeout(this.visa.health(), visaHealthBudgetMs, 'GPIB_SCAN_HEALTH_TIMEOUT');
    } catch (err) {
      visaHealth = {
        enabled: false,
        error: {
          code: String(err?.code || 'VISA_HEALTH_ERROR'),
          message: String(err?.message || err),
        },
      };
    }

    if (visaHealth?.enabled) {
      const listBudgetMs = Math.max(600, deadlineMs - Date.now() - 300);
      try {
        const resources = await withTimeout(this.visa.listResources(), listBudgetMs, 'GPIB_SCAN_LIST_TIMEOUT');
        await probeVisaResources(resources);
      } catch (err) {
        const msg = String(err?.message || err);
        debug.push(`visa scan failed: ${msg}`);
        visaWarnings.push(`NI-VISA scan failed: ${msg}`);
      }
    } else {
      const errCode = String(visaHealth?.error?.code || 'VISA_UNAVAILABLE');
      const errMsg = String(visaHealth?.error?.message || 'VISA backend not ready');

      // Recover from slow service boot by trying listResources directly.
      if (errCode === 'GPIB_SCAN_HEALTH_TIMEOUT') {
        debug.push('visa health timed out; trying direct resource listing');
        try {
          const listBudgetMs = Math.max(1000, deadlineMs - Date.now() - 300);
          const resources = await withTimeout(this.visa.listResources(), listBudgetMs, 'GPIB_SCAN_LIST_TIMEOUT');
          await probeVisaResources(resources, ' (direct)');
        } catch (err) {
          const msg = String(err?.message || err);
          debug.push(`visa direct scan failed: ${msg}`);
          visaWarnings.push(`NI-VISA unavailable (${errCode}): ${errMsg}`);
        }
      } else {
        visaWarnings.push(`NI-VISA unavailable (${errCode}): ${errMsg}`);
      }

      if (Array.isArray(visaHealth?.checkedPaths) && visaHealth.checkedPaths.length > 0) {
        debug.push(`visa checked paths=${visaHealth.checkedPaths.join(',')}`);
      }
    }

    try {
      const remainingMs = Math.max(1200, Math.min(FTDI_SCAN_TIMEOUT_MAX_MS, deadlineMs - Date.now()));
      const ftdi = await this._runFtdiHelper('scan', {}, remainingMs);
      const ftdiRows = Array.isArray(ftdi?.rows) ? ftdi.rows : [];
      const ftdiWarnRows = Array.isArray(ftdi?.warnings) ? ftdi.warnings : [];
      debug.push(`ftdi resources=${ftdiRows.length}`);
      for (const w of ftdiWarnRows) {
        ftdiWarnings.push(String(w));
      }
      for (const row of ftdiRows) {
        rows.push({
          resource: String(row?.resource || ''),
          idn: row?.idn ?? null,
          model: row?.model ?? null,
          backend: 'ftdi-serial',
        });
      }
    } catch (err) {
      ftdiWarnings.push(`FTDI serial backend unavailable: ${String(err?.message || err)}`);
    }

    const warnings = [];
    const hasVisaRows = rows.some((r) => String(r?.backend || '') === 'visa-service');
    const hasFtdiRows = rows.some((r) => String(r?.backend || '') === 'ftdi-serial');

    if (!hasVisaRows) warnings.push(...visaWarnings);
    if (!hasFtdiRows) warnings.push(...ftdiWarnings);

    const mergedRows = this._mergeLaserScanRows(rows);
    debug.push(`scan timeout=${timeoutMs}ms`);
    return {
      rows: mergedRows,
      debug,
      warnings,
      timed_out: timedOut,
      backend: 'mixed',
    };
  }
  async _gpibQuery(resource, cmd) {
    const res = String(resource || '').trim();
    const c = String(cmd || '').trim();
    if (!res) throw new Error('No GPIB resource selected');
    if (!c) throw new Error('Empty command');

    if (this._isFtdiResource(res)) {
      const out = await this._runFtdiHelper('query', {
        resource: res,
        cmd: c,
        timeout_ms: 4000,
      }, 9000);
      return {
        resource: String(out?.resource || res),
        backend: 'ftdi-serial',
        command: c,
        reply: String(out?.reply || ''),
        model: out?.model || null,
      };
    }

    const transport = this.visa.open(res, 4000);
    try {
      let reply = 'OK';
      if (c.endsWith('?')) {
        reply = await transport.query(c, 8192);
      } else {
        await transport.write(c);
      }
      const model = (c.toUpperCase() === '*IDN?' || c.toUpperCase() === 'IDN?') ? detectLaserModel(reply) : null;
      return {
        resource: res,
        backend: 'visa-service',
        command: c,
        reply,
        model,
      };
    } finally {
      await transport.close();
    }
  }
  async _returnLaserToWavelength(transport, wavelengthNm) {
    const wl = Number(wavelengthNm);
    if (!Number.isFinite(wl) || wl <= 0) return { ok: false, reason: 'invalid_wavelength' };

    const wlText = wl.toFixed(4).replace(/\.?0+$/, '');
    const commandPlans = [
      [':SOUR:WAV ' + wlText],
      [':SOUR:WAV ' + wlText + 'NM'],
      [':SOURCE:WAVELENGTH ' + wlText],
      [':SOURCE:WAVELENGTH ' + wlText + 'NM'],
    ];

    const errors = [];
    for (const plan of commandPlans) {
      try {
        for (const cmd of plan) {
          // eslint-disable-next-line no-await-in-loop
          await transport.write(cmd);
          // eslint-disable-next-line no-await-in-loop
          await sleepMs(30);
        }

        let readback = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          readback = await transport.query(':SOUR:WAV?', 128);
        } catch (_) {
          try {
            // eslint-disable-next-line no-await-in-loop
            readback = await transport.query(':SOURCE:WAVELENGTH?', 128);
          } catch (_) {
            readback = null;
          }
        }

        if (readback != null) {
          const parsed = Number(String(readback).trim());
          if (Number.isFinite(parsed) && Math.abs(parsed - wl) > 0.5) {
            throw new Error('Wavelength readback mismatch (' + parsed + ' vs ' + wl + ')');
          }
        }

        return { ok: true, readback };
      } catch (err) {
        errors.push(String(err?.message || err));
      }
    }

    return { ok: false, reason: errors.join(' | ') || 'unknown' };
  }

  async _runSweepCapture(session, resource, params) {
    const res = String(resource || '').trim();
    if (!res) throw new Error('No GPIB resource selected');
    if (session.busy) throw new Error('Selected device is busy');

    const startNm = Number(params.start_nm ?? 1480.0);
    const stopNm = Number(params.stop_nm ?? 1620.0);
    const powerMw = Number(params.power_mw ?? 1.0);
    const returnWavelengthNm = Number(params.return_wavelength_nm ?? 1550.0);
    const speedNmS = Number(params.speed_nm_s ?? 50.0);
    let sampleRate = Math.trunc(Number(params.sample_rate_hz ?? SWEEP_SAMPLE_RATE_DEFAULT_HZ));
    const osIdxRequested = Math.max(0, Math.min(7, Math.trunc(Number(params.os_idx ?? session.default_os_idx))));
    const channelMask = (Math.trunc(Number(params.channel_mask ?? 0x0f)) & 0x0f) || 0x0f;
    const saveChannelMaskRaw = params.save_channel_mask;
    let saveChannelMask = null;
    if (saveChannelMaskRaw !== undefined && saveChannelMaskRaw !== null && saveChannelMaskRaw !== '') {
      const v = Math.trunc(Number(saveChannelMaskRaw));
      if (Number.isFinite(v)) saveChannelMask = v & 0x0f;
    }
    if (saveChannelMask == null) saveChannelMask = channelMask;
    const previewPoints = Math.trunc(Number(params.preview_points ?? 24000));

    const gainsIn = Array.isArray(params.gains) ? params.gains : [0, 0, 0, 0];
    const gains = [0, 1, 2, 3].map((i) => {
      const g = Number.parseInt(String(gainsIn[i] ?? 0), 10);
      if (!Number.isFinite(g)) return 0;
      return Math.max(0, Math.min(7, g));
    });

    if (!(speedNmS > 0)) throw new Error('Sweep speed must be > 0');
    if (!(sampleRate > 0)) throw new Error('Sample rate must be > 0');
    sampleRate = Math.min(sampleRate, SWEEP_SAMPLE_RATE_MAX_HZ);

    const osIdxMaxForRate = maxOsForFreq(sampleRate);
    const osIdx = Math.min(osIdxRequested, osIdxMaxForRate);

    const sweepDurationS = Math.abs(stopNm - startNm) / speedNmS;
    const samplesTotal = Math.max(1, Math.round(sweepDurationS * sampleRate));

    const prevStream = !!session.stream_enabled;
    let transport = null;
    let laser = null;
    let previousMask = null;
    let maskApplied = false;

    session.busy = true;
    session.stream_enabled = false;

    try {
      try {
        previousMask = Number(await session.dev.get_channel_mask()) & 0x0f;
      } catch (_) {
        previousMask = null;
      }

      if (previousMask != null && previousMask !== channelMask) {
        await session.dev.set_channel_mask(channelMask);
        maskApplied = true;
      }

      let maxFrames = 0;
      try {
        maxFrames = previousMask == null
          ? Number(await session.dev.max_acquisition_frames())
          : Number(await session.dev.max_acquisition_frames(channelMask));
      } catch (_) {
        maxFrames = Number(await session.dev.max_acquisition_frames());
      }

      if (samplesTotal > maxFrames) {
        throw new Error(
          `Sweep needs ${samplesTotal} samples, exceeds CoreDAQ capacity ${maxFrames}. Reduce span, speed, or sample rate.`,
        );
      }

      this.captureState = 'running';
      this.captureMessage = `Configuring sweep for ${samplesTotal} samples`;

      await session.dev.set_freq(sampleRate);
      await session.dev.set_oversampling(osIdx);
      let actualOsIdx = osIdx;
      try {
        actualOsIdx = Number(await session.dev.get_oversampling());
      } catch (_) {
        actualOsIdx = osIdx;
      }

      session.default_os_idx = actualOsIdx;
      session.os_idx = actualOsIdx;

      try {
        if (String(session.detector_type || '').toUpperCase() === CoreDAQ.DETECTOR_INGAAS) {
          session.dev.set_responsivity_reference_nm(1550.0);
          session.dev.set_wavelength_nm(1550.0);
          session.wavelength_nm = Number(session.dev.get_wavelength_nm());
        }
      } catch (_) {
        // ignore wavelength correction setup failures
      }

      if (session.frontend_type === CoreDAQ.FRONTEND_LINEAR) {
        for (let head = 1; head <= 4; head += 1) {
          // eslint-disable-next-line no-await-in-loop
          await session.dev.set_gain(head, gains[head - 1]);
        }
      }

      await session.dev.arm_acquisition(samplesTotal, true, true);
      await sleepMs(800);

      let gpibIdn = null;
      let gpibModel = null;
      let laserBackend = 'visa-service';

      if (this._isFtdiResource(res)) {
        laserBackend = 'ftdi-serial';
        try {
          this.captureMessage = 'Configuring laser';
          const sweepWaitMs = Math.round((samplesTotal / sampleRate + SWEEP_POST_START_SETTLE_S + SWEEP_FINISH_POLL_TIMEOUT_S) * 1000);
          const sweepOut = await this._runFtdiHelper('sweep', {
            resource: res,
            start_nm: startNm,
            stop_nm: stopNm,
            power_mw: powerMw,
            speed_nm_s: speedNmS,
            acquisition_wait_s: (samplesTotal / sampleRate) + SWEEP_POST_START_SETTLE_S,
            timeout_ms: sweepWaitMs,
            poll_interval_ms: SWEEP_FINISH_POLL_INTERVAL_MS,
          }, sweepWaitMs + 5000);

          gpibIdn = String(sweepOut?.idn || '').trim() || null;
          gpibModel = sweepOut?.model || detectLaserModel(gpibIdn);
          if (!gpibModel) {
            throw new Error('Unsupported laser model. Supported models: TSL550, TSL570, TSL710, TSL770.');
          }

          const sweepState = sweepOut?.sweep_state || null;
          if (sweepState && sweepState.known && sweepState.running) {
            throw new Error(
              `Laser sweep did not finish in time (status=${String(sweepState.raw || 'running')}).`,
            );
          }

          this.gpibIdn = gpibIdn;
          this.gpibModel = gpibModel;
          this.gpibResource = res;
        } catch (err) {
          const msg = String(err?.message || err);
          if (msg.includes('Unsupported laser model')) throw err;
          throw new Error(
            `Laser not found or not responding on FTDI resource "${res}". Verify FTDI driver/cabling, then re-scan.`,
          );
        }
      } else {
        transport = this.visa.open(res, 5000);
        try {
          gpibIdn = await transport.query('*IDN?', 4096);
          gpibModel = detectLaserModel(gpibIdn);
          if (!gpibModel) {
            throw new Error('Unsupported laser model. Supported models: TSL550, TSL570, TSL710, TSL770.');
          }

          this.gpibIdn = gpibIdn;
          this.gpibModel = gpibModel;
          this.gpibResource = res;

          ({ laser } = createLaserFromIdn(gpibIdn, transport));

          this.captureMessage = 'Configuring laser';
          await laser.configureForSweep({ startNm, stopNm, powerMw, speedNmS });

          this.captureMessage = 'Waiting for laser trigger and acquisition';
          await laser.startSweep();
          await sleepMs(Math.round((samplesTotal / sampleRate + SWEEP_POST_START_SETTLE_S) * 1000));

          this.captureMessage = 'Verifying laser sweep completion';
          const sweepState = await laser.waitForSweepComplete({
            timeoutMs: Math.round(SWEEP_FINISH_POLL_TIMEOUT_S * 1000),
            pollIntervalMs: SWEEP_FINISH_POLL_INTERVAL_MS,
          });
          if (sweepState.known && sweepState.running) {
            throw new Error(
              `Laser sweep did not finish in time (status=${String(sweepState.raw || 'running')}).`,
            );
          }
        } catch (err) {
          const msg = String(err?.message || err);
          if (msg.includes('Unsupported laser model')) throw err;
          throw new Error(
            `Laser not found or not responding on VISA resource "${res}". Run Scan Resources and *IDN? to verify connection.`,
          );
        }
      }
      this.captureMessage = 'Transferring capture from CoreDAQ';
      const stateNow = Number(await session.dev.state_enum());
      if (stateNow !== COREDAQ_READY_STATE) {
        throw new Error(
          `Acquisition not complete before transfer (state=${stateNow}). Increase sweep overhead or reduce capture duration.`,
        );
      }

      const activeChannels = activeChannelIndices(channelMask);
      const saveActiveChannels = activeChannelIndices(saveChannelMask);

      let channelsW = await session.dev.transfer_frames_W(samplesTotal);
      if (!Array.isArray(channelsW) || channelsW.length < 4) {
        throw new Error('Invalid transfer payload from CoreDAQ');
      }
      channelsW = channelsW.map((ch, idx) => (activeChannels.includes(idx) ? ch : []));

      const series = this._buildSweepSeries(channelsW, startNm, stopNm, sampleRate, samplesTotal, previewPoints);

      let roomTempC = null;
      let roomHumidityPct = null;
      try {
        roomTempC = Number(await session.dev.get_head_temperature_C());
      } catch (_) {
        roomTempC = null;
      }
      try {
        roomHumidityPct = Number(await session.dev.get_head_humidity());
      } catch (_) {
        roomHumidityPct = null;
      }

      if (this._isFtdiResource(res)) {
        try {
          await this._runFtdiHelper('set_wavelength', {
            resource: res,
            wavelength_nm: returnWavelengthNm,
          }, 8000);
        } catch (err) {
          this.captureMessage = `Sweep complete, but laser return failed (${String(err?.message || err)})`;
        }
      } else if (transport) {
        const laserReturn = await this._returnLaserToWavelength(transport, returnWavelengthNm);
        if (!laserReturn.ok) {
          this.captureMessage = `Sweep complete, but laser return failed (${String(laserReturn.reason || 'unknown')})`;
        }
      }
      const payload = {
        captured_at_unix: nowSec(),
        captured_at_utc: isoUtcNow(),
        resource: res,
        laser_backend: laserBackend,
        gpib_idn: this.gpibIdn,
        gpib_model: this.gpibModel,
        device_id: session.device_id,
        frontend_type: session.frontend_type,
        coredaq_port: session.port,
        coredaq_idn: session.idn,
        start_nm: startNm,
        stop_nm: stopNm,
        power_mw: powerMw,
        return_wavelength_nm: returnWavelengthNm,
        speed_nm_s: speedNmS,
        sample_rate_hz: sampleRate,
        os_idx: Number(session.os_idx),
        os_idx_requested: osIdxRequested,
        os_idx_max_for_rate: osIdxMaxForRate,
        gains,
        channel_mask: channelMask,
        active_channels: activeChannels,
        save_channel_mask: saveChannelMask,
        save_active_channels: saveActiveChannels,
        samples_total: samplesTotal,
        sweep_duration_s: sweepDurationS,
        room_temp_c: roomTempC,
        room_humidity_pct: roomHumidityPct,
        channels_w: channelsW,
      };

      this.lastSweep = payload;
      this.captureState = 'idle';
      this.captureMessage = `Sweep complete: ${samplesTotal} samples`;

      return {
        ...payload,
        preview_points: previewPoints,
        series,
      };
    } finally {
      if (maskApplied && previousMask != null) {
        try {
          await session.dev.set_channel_mask(previousMask);
        } catch (_) {
          // ignore restore failures
        }
      }
      if (transport) {
        await transport.close().catch(() => {});
      }
      session.stream_enabled = prevStream;
      session.busy = false;
    }
  }

  _pythonRunnerCandidates() {
    if (process.platform === 'win32') {
      return [
        { exe: 'py', prefix: ['-3'] },
        { exe: 'python', prefix: [] },
        { exe: 'python3', prefix: [] },
      ];
    }
    return [
      { exe: 'python3', prefix: [] },
      { exe: 'python', prefix: [] },
    ];
  }

  async _runSweepH5Writer(scriptPath, inputJsonPath, outputPath) {
    const attempts = [];
    const commonArgs = [scriptPath, '--in-json', inputJsonPath, '--out', outputPath];

    for (const runner of this._pythonRunnerCandidates()) {
      const cmd = runner.exe;
      const args = [...runner.prefix, ...commonArgs];
      try {
        const out = await execFileAsync(cmd, args, {
          windowsHide: true,
          timeout: 45000,
          maxBuffer: 16 * 1024 * 1024,
        });
        return {
          runner: cmd,
          stdout: String(out?.stdout || ''),
          stderr: String(out?.stderr || ''),
        };
      } catch (err) {
        attempts.push({
          cmd,
          args,
          code: String(err?.code || ''),
          message: String(err?.message || err),
          stdout: String(err?.stdout || ''),
          stderr: String(err?.stderr || ''),
        });
      }
    }

    const detail = attempts.map((a) => {
      const stderr = a.stderr.trim();
      return `${a.cmd} (${a.code || 'ERR'}): ${stderr || a.message}`;
    }).join(' | ');

    const missingH5py = attempts.some((a) => String(a.stderr || '').includes('MISSING_DEPENDENCY:h5py'));
    if (missingH5py) {
      throw new Error(`H5 save failed: Python h5py dependency is missing. Install with "pip install h5py". ${detail}`);
    }

    throw new Error(`H5 save failed: no usable Python runtime found. Install Python 3 and h5py. ${detail}`);
  }

  async _saveLastSweepH5(outPath) {
    if (!this.lastSweep) {
      throw new Error('No sweep data available. Run sweep first.');
    }

    const input = String(outPath || '').trim();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const basePath = input || path.join(process.cwd(), `coredaq_sweep_${stamp}.h5`);
    const h5Path = basePath.toLowerCase().endsWith('.h5') ? basePath : `${basePath}.h5`;

    const payload = this.lastSweep;
    const active = Array.isArray(payload?.save_active_channels)
      ? payload.save_active_channels
      : (Array.isArray(payload?.active_channels) ? payload.active_channels : []);

    const compactChannelsW = active.map((idx) => ({
      index: idx,
      name: `CH${idx + 1}`,
      data_w: Array.isArray(payload?.channels_w?.[idx]) ? payload.channels_w[idx] : [],
    }));

    const virtualSeries = Array.isArray(payload?.virtual_channels) ? payload.virtual_channels.map((v) => {
      const a = Number(v?.src?.a ?? 0);
      const b = Number(v?.src?.b ?? 0);
      const chA = Array.isArray(payload?.channels_w?.[a]) ? payload.channels_w[a] : [];
      const chB = Array.isArray(payload?.channels_w?.[b]) ? payload.channels_w[b] : [];
      const len = Math.min(chA.length, chB.length);
      const out = new Array(len);
      const math = String(v?.math || 'sum');
      for (let i = 0; i < len; i += 1) {
        const va = Number(chA[i] || 0);
        const vb = Number(chB[i] || 0);
        if (math === 'diff') out[i] = va - vb;
        else if (math === 'db') {
          const num = Math.abs(va);
          const den = Math.abs(vb);
          out[i] = den === 0 || num === 0 ? -120 : 10 * Math.log10(num / den);
        } else out[i] = va + vb;
      }
      return {
        name: v?.name || 'virtual',
        math,
        src: v?.src || { a, b },
        unit: math === 'db' ? 'dB' : 'W',
        data: out,
      };
    }) : [];

    const writerPayload = {
      format: 'coredaq_sweep_h5_v1',
      saved_at_utc: isoUtcNow(),
      captured_at_utc: payload?.captured_at_utc || null,
      captured_at_unix: Number(payload?.captured_at_unix ?? 0),
      coredaq_idn: payload?.coredaq_idn || null,
      coredaq_device_id: payload?.device_id || null,
      coredaq_port: payload?.coredaq_port || null,
      room_temp_c: Number.isFinite(Number(payload?.room_temp_c)) ? Number(payload.room_temp_c) : null,
      room_humidity_pct: Number.isFinite(Number(payload?.room_humidity_pct)) ? Number(payload.room_humidity_pct) : null,
      laser_resource: payload?.resource || null,
      laser_backend: payload?.laser_backend || null,
      laser_idn: payload?.gpib_idn || null,
      laser_model: payload?.gpib_model || null,
      start_nm: Number(payload?.start_nm),
      stop_nm: Number(payload?.stop_nm),
      speed_nm_s: Number(payload?.speed_nm_s),
      power_mw: Number(payload?.power_mw),
      return_wavelength_nm: Number(payload?.return_wavelength_nm),
      sample_rate_hz: Number(payload?.sample_rate_hz),
      os_idx: Number(payload?.os_idx),
      os_idx_requested: Number(payload?.os_idx_requested),
      os_idx_max_for_rate: Number(payload?.os_idx_max_for_rate),
      sweep_duration_s: Number(payload?.sweep_duration_s),
      samples_total: Number(payload?.samples_total),
      channel_mask: Number(payload?.channel_mask),
      save_channel_mask: Number(payload?.save_channel_mask),
      active_channels: Array.isArray(payload?.active_channels) ? payload.active_channels : [],
      save_active_channels: active,
      gains: Array.isArray(payload?.gains) ? payload.gains : [],
      channels_w: compactChannelsW,
      virtual_series: virtualSeries,
    };

    const writerScript = path.join(API_PATH, 'sweep_h5_writer.py');
    if (!fs.existsSync(writerScript)) {
      throw new Error(`H5 writer script not found: ${writerScript}`);
    }

    fs.mkdirSync(path.dirname(h5Path), { recursive: true });

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coreconsole-sweep-'));
    const inputJsonPath = path.join(tmpDir, 'sweep_writer_input.json');

    try {
      fs.writeFileSync(inputJsonPath, JSON.stringify(writerPayload), 'utf8');
      await this._runSweepH5Writer(writerScript, inputJsonPath, h5Path);

      if (!fs.existsSync(h5Path)) {
        throw new Error('H5 writer completed but output file was not created.');
      }
      const st = fs.statSync(h5Path);
      if (!(st.size > 0)) {
        throw new Error('H5 writer produced an empty output file.');
      }
      return h5Path;
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {
        // ignore cleanup failures
      }
    }
  }

  async _handleConsole(ws, data) {
    const cmd = String(data.cmd || '').trim();
    if (!cmd) return;

    const requestedId = String(data.device_id || '').trim() || null;
    let sess;
    try {
      sess = this._getSession(requestedId);
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'console',
        dir: 'rx',
        device_id: requestedId,
        text: `ERR ${String(err?.message || err)}`,
      }));
      return;
    }

    let resp;
    try {
      const [st, payload] = await sess.dev._ask(cmd);
      if (st === 'OK') resp = `OK ${payload}`.trim();
      else if (st === 'BUSY') resp = 'BUSY';
      else resp = `ERR ${payload}`.trim();
    } catch (err) {
      resp = `ERR ${String(err?.message || err)}`;
    }

    ws.send(JSON.stringify({
      type: 'console',
      dir: 'rx',
      device_id: sess.device_id,
      text: resp,
    }));
  }

  async _handleControl(ws, data) {
    const action = data.action;
    const requestedId = String(data.device_id || '').trim() || null;
    const requestedSlot = Number.isFinite(Number(data.slot)) ? Math.trunc(Number(data.slot)) : null;

    try {
      if (action === 'set_active_device') {
        const did = String(data.device_id || '').trim();
        this._setActiveDevice(did);
        ws.send(JSON.stringify({ type: 'control', action, ok: true, error: null, active_device_id: this.activeDeviceId }));
        return;
      }

      if (action === 'serial_ports_list') {
        const ports = await this._listSerialPorts();
        ws.send(JSON.stringify({
          type: 'control',
          action,
          ok: true,
          error: null,
          ports,
          debug: this.lastSerialPortDebug,
          port_override: this.portOverride,
        }));
        return;
      }

      if (action === 'set_port_override') {
        const nextPort = String(data.port || '').trim();
        this.portOverride = nextPort || null;
        await this.discoverDevices(true);
        if (!this.activeDeviceId || !this.devices.has(this.activeDeviceId)) {
          this.activeDeviceId = this._pickDefaultActive();
        }
        ws.send(JSON.stringify({
          type: 'control',
          action,
          ok: true,
          error: null,
          port_override: this.portOverride,
          active_device_id: this.activeDeviceId,
          device_count: this.devices.size,
        }));
        return;
      }

      if (action === 'connect_port') {
        const port = String(data.port || '').trim();
        if (!port) throw new Error('No COM port selected.');
        const slot = Number.isFinite(Number(data.slot)) ? Math.trunc(Number(data.slot)) : null;
        const connectStartMs = Date.now();
        const result = await withTimeout(
          this._connectPort(port, { probeTimeoutMs: MANUAL_CONNECT_PROBE_TIMEOUT_MS }),
          15000,
          'CONNECT_PORT_TIMEOUT',
        );
        if (!result.ok) throw result.error;
        this.manualTargetPorts.add(port);
        if (!this.activeDeviceId || !this.devices.has(this.activeDeviceId)) {
          this.activeDeviceId = this._pickDefaultActive();
        }
        ws.send(JSON.stringify({
          type: 'control',
          action,
          ok: true,
          error: null,
          port,
          slot,
          device_id: result.deviceId,
          reused: !!result.reused,
          elapsed_ms: Date.now() - connectStartMs,
          device_count: this.devices.size,
        }));
        return;
      }

      if (action === 'disconnect_port') {
        const port = String(data.port || '').trim();
        if (!port) throw new Error('No COM port selected.');
        const slot = Number.isFinite(Number(data.slot)) ? Math.trunc(Number(data.slot)) : null;
        this.manualTargetPorts.delete(port);
        const deviceId = this.portToDevice.get(port);
        if (deviceId) {
          await this._dropSession(deviceId);
        }
        this.unsupportedPorts.delete(port);
        this.portRetryAtMs.delete(port);
        if (!this.activeDeviceId || !this.devices.has(this.activeDeviceId)) {
          this.activeDeviceId = this._pickDefaultActive();
        }
        ws.send(JSON.stringify({
          type: 'control',
          action,
          ok: true,
          error: null,
          port,
          slot,
          disconnected: !!deviceId,
          device_count: this.devices.size,
          active_device_id: this.activeDeviceId,
        }));
        return;
      }

      if (action === 'set_gain') {
        const sess = this._getSession(requestedId, { requireLinear: true });
        const head = Math.trunc(Number(data.head || 1));
        const gain = Math.trunc(Number(data.gain || 0));
        await sess.dev.set_gain(head, gain);
        ws.send(JSON.stringify({ type: 'control', action, ok: true, error: null, device_id: sess.device_id }));
        return;
      }

      if (action === 'set_os') {
        const sess = this._getSession(requestedId);
        const osIdx = Math.trunc(Number(data.os_idx || 0));
        sess.default_os_idx = osIdx;
        await sess.dev.set_oversampling(osIdx);
        ws.send(JSON.stringify({ type: 'control', action, ok: true, error: null, device_id: sess.device_id }));
        return;
      }
      if (action === 'set_freq') {
        const sess = this._getSession(requestedId);
        const freqHz = Number(data.freq_hz);
        if (!Number.isFinite(freqHz) || freqHz <= 0) {
          throw new Error('Invalid freq_hz');
        }
        await sess.dev.set_freq(freqHz);
        sess.freq_hz = Number(await sess.dev.get_freq_hz());
        if (data.os_idx != null) {
          const osIdx = Math.trunc(Number(data.os_idx));
          if (Number.isFinite(osIdx)) {
            sess.default_os_idx = osIdx;
            await sess.dev.set_oversampling(osIdx);
            sess.os_idx = Number(await sess.dev.get_oversampling());
          }
        }
        ws.send(JSON.stringify({
          type: 'control',
          action,
          ok: true,
          error: null,
          device_id: sess.device_id,
          freq_hz: sess.freq_hz,
          os_idx: sess.os_idx,
        }));
        return;
      }
      if (action === 'set_wavelength') {
        const sess = this._getSession(requestedId);
        const wavelengthNm = Number(data.wavelength_nm);
        if (!Number.isFinite(wavelengthNm) || wavelengthNm <= 0) {
          throw new Error('Invalid wavelength_nm');
        }

        sess.dev.set_wavelength_nm(wavelengthNm);
        sess.wavelength_nm = Number(sess.dev.get_wavelength_nm());

        try {
          sess.detector_type = normalizeDetectorType(sess.dev.detector_type());
        } catch (_) {
          // ignore
        }
        try {
          const lim = sess.dev.get_wavelength_limits_nm(sess.detector_type);
          sess.wavelength_min_nm = Number(lim[0]);
          sess.wavelength_max_nm = Number(lim[1]);
        } catch (_) {
          const [lo, hi] = fallbackWavelengthLimits(sess.detector_type);
          sess.wavelength_min_nm = lo;
          sess.wavelength_max_nm = hi;
        }

        ws.send(JSON.stringify({
          type: 'control',
          action,
          ok: true,
          error: null,
          device_id: sess.device_id,
          detector_type: sess.detector_type,
          wavelength_nm: sess.wavelength_nm,
          wavelength_min_nm: sess.wavelength_min_nm,
          wavelength_max_nm: sess.wavelength_max_nm,
        }));
        return;
      }

      if (action === 'set_autogain') {
        const enabled = !!data.enabled;
        let target = [];
        if (requestedId) {
          const sess = this._getSession(requestedId);
          if (sess.frontend_type !== CoreDAQ.FRONTEND_LINEAR) {
            throw new Error('Autogain is only available on LINEAR front-end devices');
          }
          sess.autogain_enabled = enabled;
          target = [sess.device_id];
        } else {
          for (const [, s] of this.devices.entries()) {
            if (s.frontend_type === CoreDAQ.FRONTEND_LINEAR) {
              s.autogain_enabled = enabled;
              target.push(s.device_id);
            }
          }
        }
        ws.send(JSON.stringify({ type: 'control', action, ok: true, error: null, device_ids: target }));
        return;
      }

      if (action === 'stream') {
        const enabled = !!data.enabled;
        if (requestedId) {
          const sess = this._getSession(requestedId);
          sess.stream_enabled = enabled;
        } else {
          this.streamEnabledGlobal = enabled;
          for (const [, s] of this.devices.entries()) {
            s.stream_enabled = enabled;
          }
        }
        ws.send(JSON.stringify({ type: 'control', action, ok: true, error: null, enabled, device_id: requestedId }));
        return;
      }

      if (action === 'recalibrate_zero') {
        const sess = this._getSession(requestedId, { requireLinear: true });
        const prevStream = !!sess.stream_enabled;
        sess.stream_enabled = false;
        sess.busy = true;
        let codes;
        let gains;
        try {
          [codes, gains] = await sess.dev.recompute_zero_from_snapshot(32, sess.fixed_freq_hz, sess.default_os_idx, 0.2);
        } finally {
          sess.busy = false;
          sess.stream_enabled = prevStream;
        }

        ws.send(JSON.stringify({
          type: 'control',
          action,
          ok: true,
          error: null,
          device_id: sess.device_id,
          zeros: codes,
          gains,
        }));
        return;
      }

      if (action === 'gpib_scan') {
        const out = await this._gpibScan({ timeout_ms: data.timeout_ms ?? 5000 });
        ws.send(JSON.stringify({
          type: 'control',
          action,
          ok: true,
          error: null,
          resources: out.rows,
          debug: out.debug,
          warnings: out.warnings,
          timed_out: !!out.timed_out,
          backend: out.backend || 'mixed',
          node_exe: process.execPath,
        }));
        return;
      }

      if (action === 'gpib_select') {
        const resource = String(data.resource || '').trim();
        if (!resource) throw new Error('No GPIB resource provided');
        this.gpibResource = resource;
        let idn = null;
        let model = null;
        let detectError = null;
        try {
          const out = await this._gpibQuery(resource, '*IDN?');
          idn = String(out.reply || '').trim() || null;
          model = out.model || null;
          this.gpibIdn = idn;
          this.gpibModel = model;
        } catch (err) {
          detectError = String(err?.message || err);
          this.gpibIdn = null;
          this.gpibModel = null;
        }
        ws.send(JSON.stringify({
          type: 'control',
          action,
          ok: true,
          error: null,
          resource,
          idn,
          model,
          detect_error: detectError,
          backend: 'visa-service',
        }));
        return;
      }

      if (action === 'gpib_query') {
        const resource = String(data.resource || this.gpibResource || '').trim();
        const cmd = String(data.cmd || '').trim();
        const out = await this._gpibQuery(resource, cmd);
        this.gpibResource = out.resource || this.gpibResource;
        if (cmd.toUpperCase() === '*IDN?' || cmd.toUpperCase() === 'IDN?') {
          this.gpibIdn = out.reply;
          this.gpibModel = out.model;
        }
        ws.send(JSON.stringify({ type: 'control', action, ok: true, error: null, ...out }));
        return;
      }

      if (action === 'sweep_run') {
        const sess = this._getSession(requestedId);
        const resource = String(data.resource || this.gpibResource || '').trim();
        const params = (data.params && typeof data.params === 'object') ? data.params : {};

        this.captureState = 'running';
        this.captureMessage = 'Starting sweep';

        const out = await this._runSweepCapture(sess, resource, params);
        ws.send(JSON.stringify({ type: 'control', action, ok: true, error: null, ...out }));
        return;
      }

      if (action === 'sweep_save_h5') {
        const outPath = String(data.path || '').trim();
        const savedPath = await this._saveLastSweepH5(outPath);
        ws.send(JSON.stringify({ type: 'control', action, ok: true, error: null, path: savedPath }));
        return;
      }

      ws.send(JSON.stringify({ type: 'control', action, ok: false, error: 'Unknown action' }));
    } catch (err) {
      this.captureState = 'idle';
      this.captureMessage = `Error: ${String(err?.message || err)}`;
      ws.send(JSON.stringify({
        type: 'control',
        action,
        ok: false,
        error: String(err?.message || err),
        error_code: String(err?.code || ''),
        device_id: requestedId,
        slot: requestedSlot,
      }));
    }
  }

  async handleMessage(ws, raw) {
    let data = null;
    try {
      data = JSON.parse(String(raw || ''));
    } catch (_) {
      return;
    }
    if (!data || typeof data !== 'object') return;

    if (data.type === 'console') {
      await this._handleConsole(ws, data);
      return;
    }
    if (data.type === 'control') {
      await this._handleControl(ws, data);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const backend = new CoreDAQBackend({
    portOverride: args.port,
    timeoutS: args.timeoutS,
  });

  const wss = new WebSocketServer({ host: WS_HOST, port: args.wsPort });
  wss.on('error', (err) => {
    const code = String(err?.code || '');
    if (code === 'EADDRINUSE') {
      console.warn(`[coredaq-service-js] ws://${WS_HOST}:${args.wsPort} already in use; another backend is running.`);
      backend.close().finally(() => process.exit(0));
      return;
    }
    console.error('[coredaq-service-js] websocket server error:', err);
    backend.close().finally(() => process.exit(1));
  });
  console.log(`[coredaq-service-js] websocket listening on ws://${WS_HOST}:${args.wsPort}`);
  backend.discoverDevices(true).catch((err) => {
    console.warn('[coredaq-service-js] initial discover failed:', err?.message || err);
  });

  wss.on('connection', (ws) => {
    backend.clients.add(ws);

    ws.on('message', async (msg) => {
      await backend.handleMessage(ws, msg);
    });

    ws.on('close', () => {
      backend.clients.delete(ws);
    });

    ws.on('error', () => {
      backend.clients.delete(ws);
    });
  });

  const statusTask = backend.statusLoop();
  const streamTask = backend.streamLoop();

  const shutdown = async () => {
    backend.running = false;
    try {
      wss.close();
    } catch (_) {
      // ignore
    }
    await backend.close();
  };

  process.on('SIGINT', () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    shutdown().finally(() => process.exit(0));
  });

  await Promise.all([statusTask, streamTask]);
}

main().catch((err) => {
  console.error('[coredaq-service-js] fatal:', err);
  process.exit(1);
});


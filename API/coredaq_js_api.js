'use strict';

const fs = require('fs');
const path = require('path');

class CoreDAQError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CoreDAQError';
  }
}

let SerialPortCtor = null;

function getSerialPortCtor() {
  if (SerialPortCtor) return SerialPortCtor;
  let mod;
  try {
    mod = require('serialport');
  } catch (err) {
    throw new CoreDAQError('serialport package not installed. Run: npm install serialport');
  }
  SerialPortCtor = mod.SerialPort || mod.default || mod;
  if (!SerialPortCtor) {
    throw new CoreDAQError('Unable to resolve SerialPort class from serialport package');
  }
  return SerialPortCtor;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function ensureArray4(name, arr) {
  if (!Array.isArray(arr) || arr.length < 4) {
    throw new CoreDAQError(`${name} must be an array of length >= 4`);
  }
}

function fill2D(rows, cols, val) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => val));
}

function bisectLeft(xs, x) {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

class CoreDAQ {
  // Device/ADC constants
  static ADC_BITS = 16;
  static ADC_VFS_VOLTS = 5.0;
  static ADC_LSB_VOLTS = (2.0 * CoreDAQ.ADC_VFS_VOLTS) / (2 ** CoreDAQ.ADC_BITS);
  static ADC_LSB_MV = CoreDAQ.ADC_LSB_VOLTS * 1e3;

  static MV_OUTPUT_DECIMALS = 3;
  static POWER_OUTPUT_DECIMALS_MAX = 12;

  static FS_VOLTS = CoreDAQ.ADC_VFS_VOLTS;
  static CODES_PER_FS = 32768.0;

  static NUM_HEADS = 4;
  static NUM_GAINS = 8;
  static SDRAM_BYTES = 32 * 1024 * 1024;

  static FRONTEND_LINEAR = 'LINEAR';
  static FRONTEND_LOG = 'LOG';
  static DETECTOR_INGAAS = 'INGAAS';
  static DETECTOR_SILICON = 'SILICON';

  static DEFAULT_WAVELENGTH_NM = 1550.0;
  static DEFAULT_RESPONSIVITY_REF_NM = 1550.0;
  static DEFAULT_SILICON_LOG_VY_V_PER_DECADE = 0.5;
  static DEFAULT_SILICON_LOG_IZ_A = 100e-12;
  static INGAAS_WAVELENGTH_RANGE_NM = [910.0, 1700.0];
  static SILICON_WAVELENGTH_RANGE_NM = [400.0, 1100.0];

  static GAIN_MAX_POWER_W = [
    5e-3,
    1e-3,
    500e-6,
    100e-6,
    50e-6,
    10e-6,
    5e-6,
    500e-9,
  ];

  static GAIN_LABELS = [
    '5 mW',
    '1 mW',
    '500 µW',
    '100 µW',
    '50 µW',
    '10 µW',
    '5 µW',
    '500 nW',
  ];

  static _build_default_tia_ohm_table() {
    const perGain = [];
    for (const pmax of CoreDAQ.GAIN_MAX_POWER_W) {
      if (pmax <= 0) perGain.push(1.0);
      else perGain.push(CoreDAQ.ADC_VFS_VOLTS / pmax);
    }
    return Array.from({ length: CoreDAQ.NUM_HEADS }, () => [...perGain]);
  }

  /**
   * Constructor mirrors Python API signature.
   * Serial connection and device init are asynchronous; call await dev.ready().
   */
  constructor(port, timeoutOrOptions = 0.15, interCommandGapS = 0.0) {
    if (!port || typeof port !== 'string') {
      throw new CoreDAQError('port must be a non-empty string');
    }

    let opts = {};
    if (typeof timeoutOrOptions === 'object' && timeoutOrOptions !== null) {
      opts = timeoutOrOptions;
    } else {
      opts = {
        timeout: timeoutOrOptions,
        interCommandGapS,
      };
    }

    this._portPath = port;
    this._baudrate = Number.isFinite(Number(opts.baudrate)) ? Number(opts.baudrate) : 115200;
    this._timeoutS = Number.isFinite(Number(opts.timeout)) ? Number(opts.timeout) : 0.15;
    this._timeoutMs = Math.max(1, Math.round(this._timeoutS * 1000));
    this._writeTimeoutMs = Number.isFinite(Number(opts.writeTimeoutMs)) ? Number(opts.writeTimeoutMs) : 500;
    this._interCommandGapS = Math.max(0.0, Number.isFinite(Number(opts.interCommandGapS)) ? Number(opts.interCommandGapS) : 0.0);
    this._warningHandler = typeof opts.onWarning === 'function' ? opts.onWarning : null;

    this._port = null;
    this._rxBuffer = Buffer.alloc(0);
    this._closed = false;
    this._lastError = null;

    this._ioQueue = Promise.resolve();
    this._lastCommandTsMs = 0;

    this._frontend_type = '';
    this._idn_cache = '';
    this._detector_type = CoreDAQ.DETECTOR_INGAAS;

    this._cal_slope = fill2D(CoreDAQ.NUM_HEADS, CoreDAQ.NUM_GAINS, 0.0);
    this._cal_intercept = fill2D(CoreDAQ.NUM_HEADS, CoreDAQ.NUM_GAINS, 0.0);
    this._mv_zero_threshold = 0.0;

    this._factory_zero_adc = [0, 0, 0, 0];
    this._linear_zero_adc = [0, 0, 0, 0];

    this._loglut_V_V = null;
    this._loglut_log10P = null;
    this._loglut_V_mV = null;
    this._loglut_log10P_Q16 = null;

    this._log_deadband_mV = 300.0;

    this._wavelength_nm = CoreDAQ.DEFAULT_WAVELENGTH_NM;
    this._responsivity_ref_nm = CoreDAQ.DEFAULT_RESPONSIVITY_REF_NM;
    this._resp_curve_nm = {};
    this._resp_curve_aw = {};

    this._silicon_log_vy_v_per_decade = CoreDAQ.DEFAULT_SILICON_LOG_VY_V_PER_DECADE;
    this._silicon_log_iz_a = CoreDAQ.DEFAULT_SILICON_LOG_IZ_A;
    this._silicon_linear_tia_ohm = CoreDAQ._build_default_tia_ohm_table();

    // ---- Fast-path caches (transfer_frames_W) ----
    this._fastLinearSlope = fill2D(CoreDAQ.NUM_HEADS, CoreDAQ.NUM_GAINS, 0.0);
    this._fastLinearIntercept = fill2D(CoreDAQ.NUM_HEADS, CoreDAQ.NUM_GAINS, 0.0);
    this._fastLinearPowerLsb = fill2D(CoreDAQ.NUM_HEADS, CoreDAQ.NUM_GAINS, 0.0);
    this._fastLinearDecimals = fill2D(CoreDAQ.NUM_HEADS, CoreDAQ.NUM_GAINS, 0);
    this._fastLinearCorr = 1.0;
    this._fastLogCorr = 1.0;
    this._fastLoglutV = null;
    this._fastLoglutLog10P = null;
    this._fastSiliconResp = 1.0;

    this._onData = (chunk) => {
      if (!chunk || chunk.length === 0) return;
      this._rxBuffer = Buffer.concat([this._rxBuffer, Buffer.from(chunk)]);
    };

    this._readyPromise = this._initialize();
  }

  static async open(port, timeout = 0.15, interCommandGapS = 0.0) {
    const dev = new CoreDAQ(port, timeout, interCommandGapS);
    await dev.ready();
    return dev;
  }

  async ready() {
    await this._readyPromise;
    return this;
  }

  _warn(message) {
    if (this._warningHandler) {
      this._warningHandler(String(message));
      return;
    }
    if (typeof process !== 'undefined' && typeof process.emitWarning === 'function') {
      process.emitWarning(String(message), { type: 'RuntimeWarning' });
      return;
    }
    // eslint-disable-next-line no-console
    console.warn(message);
  }

  async _initialize() {
    const SerialPort = getSerialPortCtor();
    this._port = new SerialPort({
      path: this._portPath,
      baudRate: this._baudrate,
      autoOpen: false,
    });

    await new Promise((resolve, reject) => {
      this._port.open((err) => {
        if (err) reject(new CoreDAQError(`Serial open failed: ${err.message || err}`));
        else resolve();
      });
    });

    this._port.on('data', this._onData);
    this._port.on('error', (err) => {
      this._lastError = err;
    });

    const startupDeadlineMs = Date.now() + Math.max(2500, this._timeoutMs * 10);
    let frontendErr = null;
    for (;;) {
      try {
        await this._drain();
        this._frontend_type = await this._detect_frontend_type_once();
        frontendErr = null;
        break;
      } catch (err) {
        frontendErr = err;
        if (Date.now() >= startupDeadlineMs) break;
        await sleepMs(120);
      }
    }
    if (!this._frontend_type) {
      throw frontendErr || new CoreDAQError('Failed to detect CoreDAQ front-end type during startup');
    }
    try {
      const [stIdn, payloadIdn] = await this._ask('IDN?');
      this._idn_cache = stIdn === 'OK' ? payloadIdn : '';
    } catch (_) {
      this._idn_cache = '';
    }
    this._detector_type = this._detect_detector_type_once(this._idn_cache);

    const [stI2c, payloadI2c] = await this._ask('I2C REFRESH');
    if (stI2c !== 'OK') {
      throw new CoreDAQError(`I2C REFRESH failed: ${payloadI2c}`);
    }
    await this._load_calibration_for_frontend();

    if (this._frontend_type === CoreDAQ.FRONTEND_LINEAR) {
      await this._load_factory_zeros();
    }

    this._bootstrap_silicon_tia_from_linear_cal();
    this._rebuildFastTables();

    const respPath = path.join(__dirname, 'responsivity_curves.json');
    if (fs.existsSync(respPath)) {
      try {
        this.load_responsivity_curves_json(respPath);
        this._bootstrap_silicon_tia_from_linear_cal();
        this._rebuildFastTables();
      } catch (_) {
        // Keep API usable if file is malformed.
      }
    }
  }

  async close() {
    await this.ready().catch(() => {});
    if (this._closed) return;
    this._closed = true;
    if (!this._port) return;

    try {
      this._port.off('data', this._onData);
    } catch (_) {
      // ignore
    }

    try {
      if (this._port.isOpen) {
        await new Promise((resolve) => this._port.flush(() => resolve()));
        await new Promise((resolve) => this._port.close(() => resolve()));
      }
    } catch (_) {
      // ignore close errors
    }
  }

  async _withLock(fn) {
    const prev = this._ioQueue;
    let release;
    this._ioQueue = new Promise((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async _waitForData(timeoutMs) {
    if (timeoutMs <= 0) return;
    if (!this._port || !this._port.isOpen) {
      throw new CoreDAQError('Serial port is not open');
    }
    await new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => {
        clearTimeout(timer);
        this._port.off('data', onData);
        this._port.off('error', onError);
        this._port.off('close', onClose);
      };
      const finish = (err) => {
        if (done) return;
        done = true;
        cleanup();
        if (err) reject(err);
        else resolve();
      };
      const onData = () => finish();
      const onError = (err) => finish(new CoreDAQError(`Serial error: ${err?.message || err}`));
      const onClose = () => finish(new CoreDAQError('Serial port closed'));
      const timer = setTimeout(() => finish(), timeoutMs);
      this._port.on('data', onData);
      this._port.on('error', onError);
      this._port.on('close', onClose);
    });
  }

  async _readlineNoLock(timeoutMs = this._timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const idx = this._rxBuffer.indexOf(0x0a);
      if (idx >= 0) {
        const lineBuf = this._rxBuffer.subarray(0, idx);
        this._rxBuffer = this._rxBuffer.subarray(idx + 1);
        return lineBuf.toString('ascii').replace(/\r+$/g, '').trim();
      }
      const now = Date.now();
      if (now >= deadline) {
        throw new CoreDAQError('Device timeout');
      }
      await this._waitForData(Math.min(50, deadline - now));
    }
  }

  async _tryReadlineNoLock(timeoutMs = this._timeoutMs) {
    try {
      return await this._readlineNoLock(timeoutMs);
    } catch (err) {
      if (String(err?.message || err).toLowerCase().includes('timeout')) {
        return null;
      }
      throw err;
    }
  }

  async _readExactNoLock(length, idleTimeoutMs = 2000, overallTimeoutMs = 5000) {
    const n = Number(length);
    if (!Number.isInteger(n) || n < 0) {
      throw new CoreDAQError(`Invalid read length: ${length}`);
    }
    if (n === 0) return Buffer.alloc(0);

    const out = Buffer.allocUnsafe(n);
    let got = 0;
    let lastRxMs = Date.now();
    const deadlineMs = Date.now() + Math.max(1, overallTimeoutMs);

    while (got < n) {
      if (this._rxBuffer.length > 0) {
        const take = Math.min(this._rxBuffer.length, n - got);
        this._rxBuffer.copy(out, got, 0, take);
        this._rxBuffer = this._rxBuffer.subarray(take);
        got += take;
        lastRxMs = Date.now();
        continue;
      }

      const now = Date.now();
      if ((now - lastRxMs) > idleTimeoutMs) {
        throw new CoreDAQError(`USB read timeout at ${got}/${n} bytes`);
      }
      if (now > deadlineMs) {
        throw new CoreDAQError(`USB read overall timeout at ${got}/${n} bytes`);
      }

      await this._waitForData(Math.min(50, deadlineMs - now));
    }

    return out;
  }

  async _writeNoLock(data) {
    if (!this._port || !this._port.isOpen) {
      throw new CoreDAQError('Serial port is not open');
    }
    await new Promise((resolve, reject) => {
      this._port.write(data, (err) => {
        if (err) {
          reject(new CoreDAQError(`Serial write failed: ${err.message || err}`));
          return;
        }
        this._port.drain((drainErr) => {
          if (drainErr) reject(new CoreDAQError(`Serial drain failed: ${drainErr.message || drainErr}`));
          else resolve();
        });
      });
    });
  }

  async _applyInterCommandGapNoLock() {
    if (!(this._interCommandGapS > 0) || !(this._lastCommandTsMs > 0)) return;
    const dtMs = Date.now() - this._lastCommandTsMs;
    const needMs = Math.round(this._interCommandGapS * 1000);
    if (dtMs < needMs) {
      await sleepMs(needMs - dtMs);
    }
  }

  async _writelnNoLock(s) {
    let line = String(s);
    if (!line.endsWith('\n')) line += '\n';
    await this._writeNoLock(Buffer.from(line, 'ascii'));
    this._lastCommandTsMs = Date.now();
  }

  async _drain() {
    if (!this._port || !this._port.isOpen) return;
    this._rxBuffer = Buffer.alloc(0);
    await new Promise((resolve) => {
      try {
        this._port.flush(() => resolve());
      } catch (_) {
        resolve();
      }
    });
  }

  async _ask(cmd) {
    return this._withLock(async () => {
      await this._applyInterCommandGapNoLock();
      await this._writelnNoLock(cmd);
      const line = await this._readlineNoLock(this._timeoutMs);
      if (line.startsWith('OK')) return ['OK', line.slice(2).trim()];
      if (line.startsWith('ERR')) return ['ERR', line.slice(3).trim()];
      if (line.startsWith('BUSY')) return ['BUSY', ''];
      return ['ERR', line];
    });
  }

  set_inter_command_gap_s(gap_s) {
    const g = Number(gap_s);
    if (!Number.isFinite(g) || g < 0.0) {
      throw new Error('inter-command gap must be >= 0');
    }
    this._interCommandGapS = g;
  }

  get_inter_command_gap_s() {
    return Number(this._interCommandGapS);
  }

  static _parse_int(s) {
    const txt = String(s).trim();
    const vNum = Number(txt);
    if (Number.isFinite(vNum)) {
      return Math.trunc(vNum);
    }
    const v = Number.parseInt(txt, 10);
    if (!Number.isFinite(v)) {
      throw new CoreDAQError(`Failed to parse integer: ${s}`);
    }
    return v;
  }

  static _active_channel_indices(mask) {
    const out = [];
    for (let i = 0; i < 4; i += 1) {
      if (((mask >> i) & 0x1) !== 0) out.push(i);
    }
    return out;
  }

  static _frame_bytes_from_mask(mask) {
    const ch = CoreDAQ._active_channel_indices(mask).length;
    if (ch === 0) {
      throw new CoreDAQError('Invalid channel mask: no channels enabled');
    }
    return ch * 2;
  }

  async _detect_frontend_type_once() {
    await sleepMs(50);
    await this._drain();

    const [st, p] = await this._ask('HEAD_TYPE?');
    if (st !== 'OK') {
      throw new CoreDAQError(`HEAD_TYPE? failed: ${p}`);
    }

    const txt = String(p).trim().toUpperCase().replace(/\s+/g, '');
    if (txt.includes('TYPE=LOG')) return CoreDAQ.FRONTEND_LOG;
    if (txt.includes('TYPE=LINEAR')) return CoreDAQ.FRONTEND_LINEAR;
    throw new CoreDAQError(`Unexpected HEAD_TYPE? reply: ${p}`);
  }

  frontend_type() {
    return this._frontend_type;
  }

  _require_frontend(expected, feature) {
    if (this._frontend_type !== expected) {
      throw new CoreDAQError(`${feature} not supported on ${this._frontend_type} front end (expected ${expected}).`);
    }
  }

  static _normalize_detector_type(detector) {
    const txt = String(detector || '').trim().toUpperCase();
    if (['INGAAS', 'INGAAS_PD', 'INGAASPD'].includes(txt)) return CoreDAQ.DETECTOR_INGAAS;
    if (['SILICON', 'SI', 'SIPD', 'SI_PD'].includes(txt)) return CoreDAQ.DETECTOR_SILICON;
    throw new Error(`Unknown detector type: ${detector}`);
  }

  _detect_detector_type_once(idn_payload = '') {
    const txt = String(idn_payload || '').toUpperCase();
    if (txt.includes('INGAAS')) return CoreDAQ.DETECTOR_INGAAS;
    if (txt.includes('SILICON')) return CoreDAQ.DETECTOR_SILICON;

    const toks = txt.split(/[^A-Z0-9]+/g).filter(Boolean);
    if (toks.includes('SI')) return CoreDAQ.DETECTOR_SILICON;
    if (toks.includes('INGAAS')) return CoreDAQ.DETECTOR_INGAAS;

    return CoreDAQ.DETECTOR_INGAAS;
  }

  detector_type() {
    return this._detector_type;
  }

  set_detector_type(detector) {
    this._detector_type = CoreDAQ._normalize_detector_type(detector);
    this.set_wavelength_nm(this._wavelength_nm);
    this._rebuildFastTables();
  }

  _detector_wavelength_limits_nm(detector = null) {
    const det = detector === null ? this._detector_type : CoreDAQ._normalize_detector_type(detector);
    if (det === CoreDAQ.DETECTOR_SILICON) {
      return [...CoreDAQ.SILICON_WAVELENGTH_RANGE_NM];
    }
    return [...CoreDAQ.INGAAS_WAVELENGTH_RANGE_NM];
  }

  get_wavelength_limits_nm(detector = null) {
    return this._detector_wavelength_limits_nm(detector);
  }

  set_wavelength_nm(wavelength_nm) {
    const wl = Number(wavelength_nm);
    if (!Number.isFinite(wl) || wl <= 0.0) {
      throw new Error('wavelength_nm must be > 0');
    }
    const [lo, hi] = this._detector_wavelength_limits_nm();
    const clamped = clamp(wl, lo, hi);
    if (clamped !== wl) {
      this._warn(
        `wavelength_nm=${wl} is outside ${this._detector_type} range [${lo}, ${hi}] nm; clamped to ${clamped} nm.`,
      );
    }
    this._wavelength_nm = clamped;
    this._rebuildFastTables();
  }

  get_wavelength_nm() {
    return Number(this._wavelength_nm);
  }

  set_responsivity_reference_nm(wavelength_nm) {
    const wl = Number(wavelength_nm);
    if (!Number.isFinite(wl) || wl <= 0.0) {
      throw new Error('responsivity reference wavelength must be > 0');
    }
    this._responsivity_ref_nm = wl;
    this._rebuildFastTables();
  }

  get_responsivity_reference_nm() {
    return Number(this._responsivity_ref_nm);
  }

  load_responsivity_curves_json(filePath) {
    const text = fs.readFileSync(filePath, 'utf8');
    const doc = JSON.parse(text);

    const det = doc.detectors || {};
    const parsed_nm = {};
    const parsed_aw = {};

    for (const key of [CoreDAQ.DETECTOR_INGAAS, CoreDAQ.DETECTOR_SILICON]) {
      const points = (((det[key] || {}).points) || []);
      const clean = [];
      for (const row of points) {
        if (!Array.isArray(row) || row.length < 2) continue;
        const wl = Number(row[0]);
        const aw = Number(row[1]);
        if (!(wl > 0.0) || !(aw > 0.0) || !Number.isFinite(wl) || !Number.isFinite(aw)) continue;
        clean.push([wl, aw]);
      }
      if (clean.length === 0) continue;

      clean.sort((a, b) => a[0] - b[0]);
      const byWl = new Map();
      for (const [wl, aw] of clean) {
        byWl.set(wl, aw);
      }
      const uniq = [...byWl.entries()].sort((a, b) => a[0] - b[0]);
      parsed_nm[key] = uniq.map((v) => v[0]);
      parsed_aw[key] = uniq.map((v) => v[1]);
    }

    if (!parsed_nm[CoreDAQ.DETECTOR_INGAAS]) {
      throw new CoreDAQError('Responsivity JSON missing INGAAS curve');
    }
    if (!parsed_nm[CoreDAQ.DETECTOR_SILICON]) {
      throw new CoreDAQError('Responsivity JSON missing SILICON curve');
    }

    this._resp_curve_nm = parsed_nm;
    this._resp_curve_aw = parsed_aw;
  }

  _interp_responsivity_aw(detector, wavelength_nm) {
    const det = CoreDAQ._normalize_detector_type(detector);
    if (!this._resp_curve_nm[det] || !this._resp_curve_aw[det]) {
      throw new CoreDAQError(
        'Responsivity curves are not loaded. Run load_responsivity_curves_json(<path>) first.',
      );
    }

    const xs = this._resp_curve_nm[det];
    const ys = this._resp_curve_aw[det];
    const x = Number(wavelength_nm);

    if (x <= xs[0]) return Number(ys[0]);
    if (x >= xs[xs.length - 1]) return Number(ys[ys.length - 1]);

    const j = bisectLeft(xs, x);
    const x0 = xs[j - 1];
    const x1 = xs[j];
    const y0 = ys[j - 1];
    const y1 = ys[j];
    if (x1 === x0) return Number(y0);
    const t = (x - x0) / (x1 - x0);
    return Number(y0 + t * (y1 - y0));
  }

  get_responsivity_A_per_W(detector = null, wavelength_nm = null) {
    const det = detector === null ? this._detector_type : detector;
    const wl = wavelength_nm === null ? this._wavelength_nm : Number(wavelength_nm);
    return Number(this._interp_responsivity_aw(det, wl));
  }

  _ingaas_responsivity_correction_factor() {
    let rRef;
    let rNow;
    try {
      rRef = this._interp_responsivity_aw(CoreDAQ.DETECTOR_INGAAS, this._responsivity_ref_nm);
      rNow = this._interp_responsivity_aw(CoreDAQ.DETECTOR_INGAAS, this._wavelength_nm);
    } catch (_) {
      return 1.0;
    }
    if (!(rNow > 0.0) || !Number.isFinite(rNow)) return 1.0;
    return Math.max(0.0, Number(rRef) / Number(rNow));
  }

  _rebuildFastTables() {
    try {
      this._fastLogCorr = Number(this._ingaas_responsivity_correction_factor());
      if (!Number.isFinite(this._fastLogCorr)) this._fastLogCorr = 1.0;
    } catch (_) {
      this._fastLogCorr = 1.0;
    }

    try {
      this._fastSiliconResp = Number(this._interp_responsivity_aw(CoreDAQ.DETECTOR_SILICON, this._wavelength_nm));
      if (!Number.isFinite(this._fastSiliconResp)) this._fastSiliconResp = 1.0;
    } catch (_) {
      this._fastSiliconResp = 1.0;
    }

    if (this._loglut_V_V && this._loglut_log10P) {
      this._fastLoglutV = this._loglut_V_V;
      this._fastLoglutLog10P = this._loglut_log10P;
    } else {
      this._fastLoglutV = null;
      this._fastLoglutLog10P = null;
    }

    if (this._detector_type === CoreDAQ.DETECTOR_INGAAS) {
      let corr = 1.0;
      try { corr = Number(this._ingaas_responsivity_correction_factor()); } catch (_) { corr = 1.0; }
      if (!Number.isFinite(corr)) corr = 1.0;
      this._fastLinearCorr = corr;

      for (let h = 0; h < CoreDAQ.NUM_HEADS; h += 1) {
        for (let g = 0; g < CoreDAQ.NUM_GAINS; g += 1) {
          const slope = Number(this._cal_slope[h][g]);
          const intercept = Number(this._cal_intercept[h][g]);
          this._fastLinearSlope[h][g] = slope;
          this._fastLinearIntercept[h][g] = intercept;
          if (!(slope !== 0.0 && Number.isFinite(slope))) {
            this._fastLinearPowerLsb[h][g] = 0.0;
            this._fastLinearDecimals[h][g] = 0;
            continue;
          }
          let powerLsb = CoreDAQ.ADC_LSB_MV / Math.abs(slope);
          powerLsb *= Math.max(0.0, corr);
          this._fastLinearPowerLsb[h][g] = powerLsb;
          this._fastLinearDecimals[h][g] = CoreDAQ._power_decimals_from_step(powerLsb);
        }
      }
      return;
    }

    if (this._detector_type === CoreDAQ.DETECTOR_SILICON) {
      const resp = Number(this._fastSiliconResp);
      for (let h = 0; h < CoreDAQ.NUM_HEADS; h += 1) {
        for (let g = 0; g < CoreDAQ.NUM_GAINS; g += 1) {
          const tia = Number(this._silicon_linear_tia_ohm[h][g]);
          this._fastLinearSlope[h][g] = 0.0;
          this._fastLinearIntercept[h][g] = 0.0;
          if (!(resp > 0.0) || !(tia > 0.0)) {
            this._fastLinearPowerLsb[h][g] = 0.0;
            this._fastLinearDecimals[h][g] = 0;
            continue;
          }
          const powerLsb = CoreDAQ.ADC_LSB_VOLTS / Math.abs(tia * resp);
          this._fastLinearPowerLsb[h][g] = powerLsb;
          this._fastLinearDecimals[h][g] = CoreDAQ._power_decimals_from_step(powerLsb);
        }
      }
      return;
    }

    this._fastLinearCorr = 1.0;
  }

  _bootstrap_silicon_tia_from_linear_cal() {
    let rRef;
    try {
      rRef = this._interp_responsivity_aw(CoreDAQ.DETECTOR_INGAAS, this._responsivity_ref_nm);
    } catch (_) {
      rRef = 1.0;
    }

    if (!Number.isFinite(rRef) || !(rRef > 0.0)) rRef = 1.0;

    for (let h = 0; h < CoreDAQ.NUM_HEADS; h += 1) {
      for (let g = 0; g < CoreDAQ.NUM_GAINS; g += 1) {
        const slope = Number(this._cal_slope[h][g]);
        if (!Number.isFinite(slope) || slope === 0.0) continue;
        const tia = Math.abs(slope) / (1000.0 * rRef);
        if (Number.isFinite(tia) && tia > 0.0) {
          this._silicon_linear_tia_ohm[h][g] = Number(tia);
        }
      }
    }
    this._rebuildFastTables();
  }

  set_silicon_linear_tia_ohm(head, gain, tia_ohm) {
    if (![1, 2, 3, 4].includes(head)) throw new Error('head must be 1..4');
    const g = Number(gain);
    if (!(g >= 0 && g < CoreDAQ.NUM_GAINS)) throw new Error('gain must be 0..7');
    const val = Number(tia_ohm);
    if (!Number.isFinite(val) || !(val > 0.0)) throw new Error('tia_ohm must be > 0');
    this._silicon_linear_tia_ohm[head - 1][g] = val;
    this._rebuildFastTables();
  }

  get_silicon_linear_tia_ohm(head, gain) {
    if (![1, 2, 3, 4].includes(head)) throw new Error('head must be 1..4');
    const g = Number(gain);
    if (!(g >= 0 && g < CoreDAQ.NUM_GAINS)) throw new Error('gain must be 0..7');
    return Number(this._silicon_linear_tia_ohm[head - 1][g]);
  }

  set_silicon_log_model(vy_v_per_decade, iz_a) {
    const vy = Number(vy_v_per_decade);
    const iz = Number(iz_a);
    if (!Number.isFinite(vy) || !(vy > 0.0)) throw new Error('vy_v_per_decade must be > 0');
    if (!Number.isFinite(iz) || !(iz > 0.0)) throw new Error('iz_a must be > 0');
    this._silicon_log_vy_v_per_decade = vy;
    this._silicon_log_iz_a = iz;
    this._rebuildFastTables();
  }

  get_silicon_log_model() {
    return [Number(this._silicon_log_vy_v_per_decade), Number(this._silicon_log_iz_a)];
  }

  _convert_log_voltage_to_power_w(v_volts) {
    if (this._detector_type === CoreDAQ.DETECTOR_SILICON) {
      const resp = this._interp_responsivity_aw(CoreDAQ.DETECTOR_SILICON, this._wavelength_nm);
      if (!(resp > 0.0)) {
        throw new CoreDAQError('Invalid silicon responsivity');
      }
      const pinW = (this._silicon_log_iz_a / resp) * (10.0 ** (Number(v_volts) / this._silicon_log_vy_v_per_decade));
      return Number(pinW);
    }

    let pinW = Number(this.voltage_to_power_W(Number(v_volts)));
    if (this._detector_type === CoreDAQ.DETECTOR_INGAAS) {
      pinW *= this._ingaas_responsivity_correction_factor();
    }
    return pinW;
  }

  _convert_linear_mv_to_power_w(head_idx, gain, mv_corr) {
    if (Math.abs(Number(mv_corr)) < Number(this._mv_zero_threshold)) {
      return 0.0;
    }

    if (this._detector_type === CoreDAQ.DETECTOR_SILICON) {
      const resp = this._interp_responsivity_aw(CoreDAQ.DETECTOR_SILICON, this._wavelength_nm);
      const tia = Number(this._silicon_linear_tia_ohm[head_idx][gain]);
      if (!(resp > 0.0) || !(tia > 0.0)) {
        throw new CoreDAQError(`Invalid silicon model at head ${head_idx + 1}, gain ${gain}`);
      }

      const powerLsb = CoreDAQ.ADC_LSB_VOLTS / Math.abs(tia * resp);
      const decimals = CoreDAQ._power_decimals_from_step(powerLsb);
      let pW = (Number(mv_corr) / 1000.0) / (tia * resp);
      pW = CoreDAQ._quantize_to_step(pW, powerLsb);
      return Number(pW.toFixed(decimals));
    }

    const slope = Number(this._cal_slope[head_idx][gain]);
    const intercept = Number(this._cal_intercept[head_idx][gain]);
    if (slope === 0.0) {
      throw new CoreDAQError(`Invalid slope for head ${head_idx + 1}, gain ${gain}`);
    }

    let powerLsb = CoreDAQ.ADC_LSB_MV / Math.abs(slope);
    let pW = (Number(mv_corr) - intercept) / slope;

    if (this._detector_type === CoreDAQ.DETECTOR_INGAAS) {
      const corr = this._ingaas_responsivity_correction_factor();
      pW *= corr;
      powerLsb *= Math.max(0.0, corr);
    }

    const decimals = CoreDAQ._power_decimals_from_step(powerLsb);
    pW = CoreDAQ._quantize_to_step(pW, powerLsb);
    return Number(pW.toFixed(decimals));
  }

  async idn(refresh = false) {
    await this.ready();
    if (this._idn_cache && !refresh) return this._idn_cache;
    const [st, p] = await this._ask('IDN?');
    if (st !== 'OK') throw new CoreDAQError(p);
    this._idn_cache = p;
    return p;
  }

  static adc_code_to_volts(code) {
    return Number(code) * CoreDAQ.ADC_LSB_VOLTS;
  }

  static adc_code_to_mV(code) {
    return CoreDAQ.adc_code_to_volts(code) * 1e3;
  }

  static _power_decimals_from_step(step_w) {
    const step = Number(step_w);
    if (!Number.isFinite(step) || !(step > 0.0)) return 0;
    return clamp(Math.round(-Math.log10(step)), 0, CoreDAQ.POWER_OUTPUT_DECIMALS_MAX);
  }

  static _quantize_to_step(value, step) {
    const v = Number(value);
    const s = Number(step);
    if (!Number.isFinite(v)) return 0.0;
    if (!Number.isFinite(s) || !(s > 0.0)) return v;
    return Math.round(v / s) * s;
  }

  async _load_factory_zeros() {
    this._require_frontend(CoreDAQ.FRONTEND_LINEAR, '_load_factory_zeros');

    const [st, payload] = await this._ask('FACTORY_ZEROS?');
    if (st !== 'OK') throw new CoreDAQError(`FACTORY_ZEROS? failed: ${payload}`);

    const parts = String(payload).split(/\s+/g).filter(Boolean);
    if (parts.length < 4) {
      throw new CoreDAQError(`FACTORY_ZEROS? payload too short: ${payload}`);
    }

    let z;
    if (parts.some((t) => t.includes('='))) {
      const kv = new Map();
      for (const t of parts) {
        const eq = t.indexOf('=');
        if (eq < 0) continue;
        const k = t.slice(0, eq).trim().toLowerCase();
        const v = t.slice(eq + 1).trim();
        kv.set(k, v);
      }

      const get = (k) => {
        if (!kv.has(k)) {
          throw new CoreDAQError(`FACTORY_ZEROS? missing ${k}= in ${payload}`);
        }
        const val = Number.parseInt(kv.get(k), 0);
        if (!Number.isFinite(val)) {
          throw new CoreDAQError(`FACTORY_ZEROS? bad ${k} value in ${payload}`);
        }
        return val;
      };

      z = [get('h1'), get('h2'), get('h3'), get('h4')];
    } else {
      z = parts.slice(0, 4).map((v) => {
        const n = Number.parseInt(v, 0);
        if (!Number.isFinite(n)) {
          throw new CoreDAQError(`FACTORY_ZEROS? parse error: ${payload}`);
        }
        return n;
      });
    }

    this._factory_zero_adc = [...z];
    this._linear_zero_adc = [...z];
    return [...z];
  }

  async refresh_factory_zeros() {
    await this.ready();
    if (this._frontend_type !== CoreDAQ.FRONTEND_LINEAR) return [0, 0, 0, 0];
    const z = await this._load_factory_zeros();
    return [...z];
  }

  get_linear_zero_adc() {
    if (this._frontend_type !== CoreDAQ.FRONTEND_LINEAR) return [0, 0, 0, 0];
    return this._linear_zero_adc.map((x) => Number.parseInt(String(x), 10));
  }

  get_factory_zero_adc() {
    if (this._frontend_type !== CoreDAQ.FRONTEND_LINEAR) return [0, 0, 0, 0];
    return this._factory_zero_adc.map((x) => Number.parseInt(String(x), 10));
  }

  set_soft_zero_adc(z1, z2, z3, z4) {
    if (this._frontend_type !== CoreDAQ.FRONTEND_LINEAR) return;
    this._linear_zero_adc = [Number.parseInt(String(z1), 10), Number.parseInt(String(z2), 10), Number.parseInt(String(z3), 10), Number.parseInt(String(z4), 10)];
  }

  async restore_factory_zero() {
    await this.ready();
    if (this._frontend_type !== CoreDAQ.FRONTEND_LINEAR) return;

    if (this._factory_zero_adc.every((v) => v === 0)) {
      try {
        await this._load_factory_zeros();
        return;
      } catch (_) {
        // ignore and keep old behavior
      }
    }

    this._linear_zero_adc = [...this._factory_zero_adc];
  }

  async soft_zero_from_snapshot(n_frames = 32, settle_s = 0.2) {
    await this.ready();
    this._require_frontend(CoreDAQ.FRONTEND_LINEAR, 'soft_zero_from_snapshot');
    if (!(n_frames > 0)) throw new Error('n_frames must be > 0');

    await sleepMs(Number(settle_s) * 1000);
    const [codes, gains] = await this.snapshot_adc(n_frames);
    this._linear_zero_adc = [Number(codes[0]), Number(codes[1]), Number(codes[2]), Number(codes[3])];
    return [codes, gains];
  }

  async recompute_zero_from_snapshot(n_frames = 32, temp_freq_hz = 1000, temp_os = 6, settle_s = 0.2) {
    await this.ready();
    this._require_frontend(CoreDAQ.FRONTEND_LINEAR, 'recompute_zero_from_snapshot');
    if (!(n_frames > 0)) throw new Error('n_frames must be > 0');

    const prevFreq = await this.get_freq_hz();
    const prevOs = await this.get_oversampling();

    try {
      await this.set_freq(temp_freq_hz);
      await this.set_oversampling(temp_os);
      await sleepMs(Number(settle_s) * 1000);

      const [codes, gains] = await this.snapshot_adc(n_frames);
      this._linear_zero_adc = [Number(codes[0]), Number(codes[1]), Number(codes[2]), Number(codes[3])];
      return [codes, gains];
    } finally {
      try {
        await this.set_freq(prevFreq);
        await this.set_oversampling(prevOs);
      } catch (_) {
        // best effort
      }
    }
  }

  _apply_linear_zero_ch(codes) {
    ensureArray4('codes', codes);
    if (this._frontend_type !== CoreDAQ.FRONTEND_LINEAR) return [...codes];
    return [0, 1, 2, 3].map((i) => Number(codes[i]) - Number(this._linear_zero_adc[i]));
  }

  async snapshot_adc_zeroed(n_frames = 1, timeout_s = 1.0, poll_hz = 200.0) {
    const [codes, gains] = await this.snapshot_adc(n_frames, timeout_s, poll_hz);
    return [this._apply_linear_zero_ch(codes), gains];
  }

  set_log_deadband_mV(deadband_mV) {
    const db = Number(deadband_mV);
    if (db < 0) throw new Error('deadband_mV must be >= 0');
    this._log_deadband_mV = db;
  }

  get_log_deadband_mV() {
    return Number(this._log_deadband_mV);
  }

  async _load_calibration_for_frontend() {
    if (this._frontend_type === CoreDAQ.FRONTEND_LINEAR) {
      await this._load_linear_calibration();
      return;
    }
    if (this._frontend_type === CoreDAQ.FRONTEND_LOG) {
      await this._load_log_calibration();
      return;
    }
    throw new CoreDAQError(`Unknown frontend type: ${this._frontend_type}`);
  }

  async _load_linear_calibration() {
    for (let head = 1; head <= CoreDAQ.NUM_HEADS; head += 1) {
      for (let gain = 0; gain < CoreDAQ.NUM_GAINS; gain += 1) {
        const [status, payload] = await this._ask(`CAL ${head} ${gain}`);
        if (status !== 'OK') {
          throw new CoreDAQError(`CAL ${head} ${gain} failed: ${payload}`);
        }

        const parts = String(payload).split(/\s+/g);
        if (parts.length < 4) {
          throw new CoreDAQError(`Unexpected CAL reply: ${payload}`);
        }

        let slopeHex = null;
        let interceptHex = null;
        for (const token of parts) {
          if (token.startsWith('S=')) slopeHex = token.split('=', 2)[1];
          else if (token.startsWith('I=')) interceptHex = token.split('=', 2)[1];
        }

        if (!slopeHex || !interceptHex) {
          throw new CoreDAQError(`Missing S= or I= in CAL reply: ${payload}`);
        }

        try {
          const slopeBits = Number.parseInt(slopeHex, 16);
          const interceptBits = Number.parseInt(interceptHex, 16);
          const sb = Buffer.alloc(4);
          const ib = Buffer.alloc(4);
          sb.writeUInt32LE(slopeBits >>> 0, 0);
          ib.writeUInt32LE(interceptBits >>> 0, 0);
          const slope = sb.readFloatLE(0);
          const intercept = ib.readFloatLE(0);
          this._cal_slope[head - 1][gain] = Number(slope);
          this._cal_intercept[head - 1][gain] = Number(intercept);
        } catch (err) {
          throw new CoreDAQError(`Failed parsing CAL payload ${payload}: ${err.message || err}`);
        }
      }
    }
  }

  async _load_log_calibration() {
    const [V_mV, Q16] = await this._withLock(async () => {
      this._rxBuffer = Buffer.alloc(0);
      await this._applyInterCommandGapNoLock();
      await this._writelnNoLock('LOGCAL 1');

      let header = null;
      for (let i = 0; i < 120; i += 1) {
        const line = await this._tryReadlineNoLock(this._timeoutMs);
        if (!line) continue;
        if (line.startsWith('OK') && line.includes(' N=') && line.includes(' RB=') && line.includes(' H')) {
          header = line;
          break;
        }
      }

      if (!header) {
        throw new CoreDAQError('LOGCAL header not received');
      }

      const parts = header.split(/\s+/g);
      let nPts = null;
      let rb = null;
      for (const token of parts) {
        if (token.startsWith('N=')) nPts = Number.parseInt(token.slice(2), 10);
        if (token.startsWith('RB=')) rb = Number.parseInt(token.slice(3), 10);
      }

      if (!Number.isFinite(nPts) || !Number.isFinite(rb)) {
        throw new CoreDAQError(`Malformed LOGCAL header: ${header}`);
      }
      if (rb !== 6) {
        throw new CoreDAQError(`Unexpected LOGCAL RB=${rb} (expected 6)`);
      }

      const payloadLen = nPts * rb;
      const payload = await this._readExactNoLock(payloadLen, this._timeoutMs * 4, Math.max(5000, payloadLen * 8));
      if (payload.length !== payloadLen) {
        throw new CoreDAQError(`Short LOGCAL payload: got ${payload.length} / ${payloadLen}`);
      }

      let doneOk = false;
      for (let i = 0; i < 120; i += 1) {
        const line = await this._tryReadlineNoLock(this._timeoutMs);
        if (!line) continue;
        if (line === 'OK DONE') {
          doneOk = true;
          break;
        }
      }
      if (!doneOk) {
        throw new CoreDAQError('LOGCAL missing OK DONE terminator');
      }

      const vs = [];
      const qs = [];
      for (let i = 0; i < nPts; i += 1) {
        const base = i * rb;
        vs.push(payload.readUInt16LE(base));
        qs.push(payload.readInt32LE(base + 2));
      }
      return [vs, qs];
    });

    if (!V_mV || V_mV.length === 0) {
      throw new CoreDAQError('LOG LUT empty');
    }

    this._loglut_V_mV = V_mV.map((v) => Number(v));
    this._loglut_log10P_Q16 = Q16.map((v) => Number(v));
    this._loglut_V_V = this._loglut_V_mV.map((v) => v / 1000.0);
    this._loglut_log10P = this._loglut_log10P_Q16.map((v) => v / 65536.0);

    if (this._loglut_V_V.length !== this._loglut_log10P.length) {
      throw new CoreDAQError('LOG LUT length mismatch after decode');
    }
  }

  voltage_to_power_W(v_volts) {
    this._require_frontend(CoreDAQ.FRONTEND_LOG, 'voltage_to_power_W');
    if (!this._loglut_V_V || !this._loglut_log10P) {
      throw new CoreDAQError('LOG LUT not loaded');
    }

    const xs = this._loglut_V_V;
    const ys = this._loglut_log10P;

    const interpOne = (x) => {
      if (x <= xs[0]) return 10.0 ** ys[0];
      if (x >= xs[xs.length - 1]) return 10.0 ** ys[ys.length - 1];

      const j = bisectLeft(xs, x);
      const x0 = xs[j - 1];
      const x1 = xs[j];
      const y0 = ys[j - 1];
      const y1 = ys[j];
      const y = x1 === x0 ? y0 : y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
      return 10.0 ** y;
    };

    if (Array.isArray(v_volts)) {
      return v_volts.map((v) => interpOne(Number(v)));
    }
    return Number(interpOne(Number(v_volts)));
  }

  async snapshot_adc(n_frames = 1, timeout_s = 1.0, poll_hz = 200.0) {
    await this.ready();
    const [stArm, payloadArm] = await this._ask(`SNAP ${n_frames}`);
    if (stArm !== 'OK') {
      throw new CoreDAQError(`SNAP arm failed: ${payloadArm}`);
    }

    const t0 = Date.now();
    const sleepS = 1.0 / Number(poll_hz);

    for (;;) {
      const [st, payload] = await this._ask('SNAP?');
      if (st === 'BUSY') {
        if ((Date.now() - t0) / 1000.0 > Number(timeout_s)) {
          throw new CoreDAQError('Snapshot timeout');
        }
        await sleepMs(sleepS * 1000);
        continue;
      }

      if (st !== 'OK') {
        throw new CoreDAQError(`SNAP? failed: ${payload}`);
      }

      const parts = String(payload).split(/\s+/g).filter(Boolean);
      if (parts.length < 4) {
        throw new CoreDAQError(`SNAP? payload too short: ${payload}`);
      }

      const codes = [];
      for (let i = 0; i < 4; i += 1) {
        const v = Number.parseInt(parts[i], 10);
        if (!Number.isFinite(v)) {
          throw new CoreDAQError(`Failed to parse ADC codes from SNAP?: ${payload}`);
        }
        codes.push(v);
      }

      const gains = [0, 0, 0, 0];
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        if (!part.includes('G=')) continue;
        try {
          gains[0] = Number.parseInt(part.split('=')[1], 10);
          gains[1] = Number.parseInt(parts[i + 1], 10);
          gains[2] = Number.parseInt(parts[i + 2], 10);
          gains[3] = Number.parseInt(parts[i + 3], 10);
        } catch (err) {
          throw new CoreDAQError(`Failed to parse gains from SNAP?: ${payload}`);
        }
        break;
      }

      return [codes, gains];
    }
  }

  async snapshot_volts(n_frames = 1, timeout_s = 1.0, poll_hz = 200.0, _use_zero = null) {
    const [codes, gains] = await this.snapshot_adc_zeroed(n_frames, timeout_s, poll_hz);
    return [codes.map((c) => Number(c) * CoreDAQ.ADC_LSB_VOLTS), gains];
  }

  async snapshot_mV(n_frames = 1, timeout_s = 1.0, poll_hz = 200.0, _use_zero = null) {
    const [codes, gains] = await this.snapshot_adc_zeroed(n_frames, timeout_s, poll_hz);
    return [
      codes.map((c) => Number((Number(c) * CoreDAQ.ADC_LSB_MV).toFixed(CoreDAQ.MV_OUTPUT_DECIMALS))),
      gains,
    ];
  }

  async snapshot_W(
    n_frames = 1,
    timeout_s = 1.0,
    poll_hz = 200.0,
    _use_zero = null,
    autogain = false,
    min_mv = 100,
    max_mv = 3500.0,
    max_iters = 10,
    settle_s = 0.01,
    return_debug = false,
    log_deadband_mV = null,
  ) {
    await this.ready();

    if (this._frontend_type === CoreDAQ.FRONTEND_LOG) {
      const [mv] = await this.snapshot_mV(n_frames, timeout_s, poll_hz, null);
      const out = [];
      const db = log_deadband_mV === null ? this._log_deadband_mV : Number(log_deadband_mV);

      for (let ch = 0; ch < 4; ch += 1) {
        const mvCorr = Number(mv[ch]);
        if (db > 0.0 && Math.abs(mvCorr) < db) {
          out.push(0.0);
          continue;
        }
        const v = mvCorr / 1000.0;
        const pW = this._convert_log_voltage_to_power_w(v);
        out.push(Number(pW.toFixed(CoreDAQ.POWER_OUTPUT_DECIMALS_MAX)));
      }
      return out;
    }

    if (this._frontend_type === CoreDAQ.FRONTEND_LINEAR) {
      if (autogain) {
        let minCode = Math.ceil(Number(min_mv) / CoreDAQ.ADC_LSB_MV);
        let maxCode = Math.floor(Number(max_mv) / CoreDAQ.ADC_LSB_MV);
        if (minCode < 0) minCode = 0;
        if (maxCode < minCode) maxCode = minCode;

        for (let iter = 0; iter < Number(max_iters); iter += 1) {
          const [codesNow, gains] = await this.snapshot_adc_zeroed(n_frames, timeout_s, poll_hz);
          let changed = false;

          for (let ch = 0; ch < 4; ch += 1) {
            const codeAbs = Math.abs(Number(codesNow[ch]));
            const g = Number(gains[ch]);
            const head = ch + 1;

            if (codeAbs < minCode && g < 7) {
              await this.set_gain(head, g + 1);
              changed = true;
            } else if (codeAbs > maxCode && g > 0) {
              await this.set_gain(head, g - 1);
              changed = true;
            }
          }

          if (!changed) break;
          await sleepMs(Number(settle_s) * 1000);
        }
      }

      const [mv, gains] = await this.snapshot_mV(n_frames, timeout_s, poll_hz, null);
      const out = [];

      for (let ch = 0; ch < 4; ch += 1) {
        const gain = Number(gains[ch]);
        out.push(this._convert_linear_mv_to_power_w(ch, gain, Number(mv[ch])));
      }

      if (return_debug) {
        return [out, mv, gains];
      }
      return out;
    }

    throw new CoreDAQError(`Unknown frontend type: ${this._frontend_type}`);
  }

  async set_gain(head, value) {
    await this.ready();
    this._require_frontend(CoreDAQ.FRONTEND_LINEAR, 'set_gain');
    if (![1, 2, 3, 4].includes(Number(head))) {
      throw new Error('head must be 1..4');
    }
    const gain = Number(value);
    if (!(gain >= 0 && gain <= 7)) {
      throw new Error('gain value must be 0..7');
    }

    const [st, payload] = await this._ask(`GAIN ${head} ${gain}`);
    if (st !== 'OK') {
      throw new CoreDAQError(`GAIN ${head} failed: ${payload}`);
    }

    await sleepMs(50);
  }

  async get_gains() {
    await this.ready();
    this._require_frontend(CoreDAQ.FRONTEND_LINEAR, 'get_gains');

    const [st, payload] = await this._ask('GAINS?');
    if (st !== 'OK') {
      throw new CoreDAQError(`GAINS? failed: ${payload}`);
    }

    const parts = String(payload).replace(/HEAD/g, '').replace(/=/g, ' ').split(/\s+/g).filter(Boolean);
    try {
      const nums = [];
      for (let i = 1; i < parts.length; i += 2) {
        nums.push(Number.parseInt(parts[i], 10));
      }
      if (nums.length !== 4 || nums.some((x) => !Number.isFinite(x))) {
        throw new Error('bad payload');
      }
      return nums;
    } catch (_) {
      throw new CoreDAQError(`Unexpected GAINS? payload: '${payload}'`);
    }
  }

  async set_gain1(value) { await this.set_gain(1, value); }
  async set_gain2(value) { await this.set_gain(2, value); }
  async set_gain3(value) { await this.set_gain(3, value); }
  async set_gain4(value) { await this.set_gain(4, value); }

  async state_enum() {
    await this.ready();
    const [st, p] = await this._ask('STATE?');
    if (st !== 'OK') throw new CoreDAQError(p);
    return CoreDAQ._parse_int(p);
  }

  async arm_acquisition(frames, use_trigger = false, trigger_rising = true) {
    await this.ready();
    const nFrames = Number(frames);
    if (!(nFrames > 0)) {
      throw new Error('frames must be > 0');
    }

    const maxFrames = await this.max_acquisition_frames();
    if (nFrames > maxFrames) {
      throw new CoreDAQError(`frames=${nFrames} exceeds max=${maxFrames} for current channel mask`);
    }

    if (use_trigger) {
      const pol = trigger_rising ? 'R' : 'F';
      const [st, p] = await this._ask(`TRIGARM ${nFrames} ${pol}`);
      if (st !== 'OK') {
        throw new CoreDAQError(`TRIGARM failed: ${p}`);
      }
      return;
    }

    const [st, p] = await this._ask(`ACQ ARM ${nFrames}`);
    if (st !== 'OK') {
      throw new CoreDAQError(`ACQ ARM failed: ${p}`);
    }
  }

  async start_acquisition() {
    await this.ready();
    const [st, p] = await this._ask('ACQ START');
    if (st !== 'OK') {
      throw new CoreDAQError(`ACQ START failed: ${p}`);
    }
  }

  async stop_acquisition() {
    await this.ready();
    const [st, p] = await this._ask('ACQ STOP');
    if (st !== 'OK') {
      throw new CoreDAQError(`ACQ STOP failed: ${p}`);
    }
  }

  async acquisition_status() {
    await this.ready();
    const [st, p] = await this._ask('STREAM?');
    if (st !== 'OK') throw new CoreDAQError(p);
    return p;
  }

  async frames_remaining() {
    await this.ready();
    const [st, p] = await this._ask('LEFT?');
    if (st !== 'OK') throw new CoreDAQError(p);
    return CoreDAQ._parse_int(p);
  }

  async get_channel_mask_info() {
    await this.ready();
    const [st, p] = await this._ask('CHMASK?');
    if (st !== 'OK') {
      throw new CoreDAQError(`CHMASK? failed: ${p}`);
    }

    const m = /0x([0-9A-Fa-f]+)/.exec(p);
    const ch = /CH\s*=\s*(\d+)/i.exec(p);
    const fb = /FB\s*=\s*(\d+)/i.exec(p);
    if (!m) {
      throw new CoreDAQError(`Unexpected CHMASK? payload: '${p}'`);
    }

    const mask = (Number.parseInt(m[1], 16) & 0x0f);
    const active = ch ? Number.parseInt(ch[1], 10) : CoreDAQ._active_channel_indices(mask).length;
    const frameBytes = fb ? Number.parseInt(fb[1], 10) : CoreDAQ._frame_bytes_from_mask(mask);
    return [mask, active, frameBytes];
  }

  async get_channel_mask() {
    const [mask] = await this.get_channel_mask_info();
    return mask;
  }

  async set_channel_mask(mask) {
    await this.ready();
    const m = Number(mask) & 0x0f;
    if (m === 0) {
      throw new Error('mask must enable at least one channel (1..15)');
    }
    const [st, p] = await this._ask(`CHMASK 0x${m.toString(16).toUpperCase()}`);
    if (st !== 'OK') {
      throw new CoreDAQError(`CHMASK set failed: ${p}`);
    }
  }

  async max_acquisition_frames(mask = null) {
    await this.ready();
    let frameBytes;
    if (mask === null || typeof mask === 'undefined') {
      try {
        const info = await this.get_channel_mask_info();
        frameBytes = info[2];
      } catch (_) {
        frameBytes = 8;
      }
    } else {
      frameBytes = CoreDAQ._frame_bytes_from_mask(Number(mask) & 0x0f);
    }
    return Math.floor(CoreDAQ.SDRAM_BYTES / frameBytes);
  }

  async wait_for_completion(poll_s = 0.25, timeout_s = null) {
    const readyState = 4;
    const t0 = Date.now();

    for (;;) {
      if ((await this.state_enum()) === readyState) return;
      if (timeout_s !== null && ((Date.now() - t0) / 1000.0) > Number(timeout_s)) {
        throw new CoreDAQError('Acquisition timeout');
      }
      await sleepMs(Number(poll_s) * 1000);
    }
  }

  async transfer_frames_adc(frames, idle_timeout_s = 2.0, overall_timeout_s = null) {
    await this.ready();
    const nFrames = Number(frames);
    if (!(nFrames > 0)) {
      throw new Error('frames must be > 0');
    }

    let mask;
    let activeCh;
    let frameBytes;
    try {
      [mask, activeCh, frameBytes] = await this.get_channel_mask_info();
    } catch (_) {
      mask = 0x0f;
      activeCh = 4;
      frameBytes = 8;
    }

    if (!(activeCh > 0)) {
      throw new CoreDAQError('No active channels in mask');
    }

    const bytesNeeded = nFrames * frameBytes;
    await sleepMs(50);

    let overallTimeoutS = overall_timeout_s;
    if (overallTimeoutS === null || typeof overallTimeoutS === 'undefined') {
      overallTimeoutS = Math.max(5.0, (bytesNeeded / 1_000_000.0) * 8.0);
    }

    const payload = await this._withLock(async () => {
      this._rxBuffer = Buffer.alloc(0);
      await this._applyInterCommandGapNoLock();
      await this._writelnNoLock(`XFER ${bytesNeeded}`);

      const line = await this._readlineNoLock(this._timeoutMs);
      if (!line.startsWith('OK')) {
        throw new CoreDAQError(`XFER refused: ${line}`);
      }

      return this._readExactNoLock(
        bytesNeeded,
        Number(idle_timeout_s) * 1000,
        Number(overallTimeoutS) * 1000,
      );
    });

    const activeIdx = CoreDAQ._active_channel_indices(mask);
    if (activeIdx.length !== activeCh) {
      activeCh = activeIdx.length;
    }
    if (activeCh === 0) {
      throw new CoreDAQError('Invalid active channel count');
    }

    const out = [
      new Array(nFrames).fill(0),
      new Array(nFrames).fill(0),
      new Array(nFrames).fill(0),
      new Array(nFrames).fill(0),
    ];

    const sampleCount = Math.floor(payload.length / 2);
    if (sampleCount !== nFrames * activeCh) {
      throw new CoreDAQError(`Payload/sample mismatch: expected ${nFrames * activeCh} samples, got ${sampleCount}`);
    }

    for (let pos = 0; pos < activeIdx.length; pos += 1) {
      const chIdx = activeIdx[pos];
      const vals = out[chIdx];
      for (let f = 0; f < nFrames; f += 1) {
        const sampleIndex = f * activeCh + pos;
        vals[f] = payload.readInt16LE(sampleIndex * 2);
      }
    }

    return out;
  }

  async transfer_frames_raw(frames) {
    return this.transfer_frames_adc(frames);
  }

  async transfer_frames_mV(frames, _use_zero = null, log_deadband_mV = null) {
    const ch = await this.transfer_frames_adc(frames);
    const lsbMv = CoreDAQ.ADC_LSB_MV;

    if (this._frontend_type === CoreDAQ.FRONTEND_LINEAR) {
      const out = [[], [], [], []];
      for (let headIdx = 0; headIdx < 4; headIdx += 1) {
        const z = Number(this._linear_zero_adc[headIdx]);
        out[headIdx] = ch[headIdx].map((code) => Number(((Number(code) - z) * lsbMv).toFixed(CoreDAQ.MV_OUTPUT_DECIMALS)));
      }
      return out;
    }

    if (this._frontend_type === CoreDAQ.FRONTEND_LOG) {
      const db = log_deadband_mV === null ? this._log_deadband_mV : Number(log_deadband_mV);
      const out = [];
      for (const lst of ch) {
        let mvList = lst.map((x) => Number((Number(x) * lsbMv).toFixed(CoreDAQ.MV_OUTPUT_DECIMALS)));
        if (db > 0.0) {
          mvList = mvList.map((v) => (Math.abs(v) < db ? 0.0 : v));
        }
        out.push(mvList);
      }
      return out;
    }

    throw new CoreDAQError(`Unknown frontend type: ${this._frontend_type}`);
  }

  async transfer_frames_volts(frames, use_zero = null) {
    const mv = await this.transfer_frames_mV(frames, use_zero);
    return mv.map((lst) => lst.map((x) => x / 1000.0));
  }

  async transfer_frames_W(frames, _use_zero = null, log_deadband_mV = null) {
    const nFrames = Number(frames);
    if (!(nFrames > 0)) {
      throw new Error('frames must be > 0');
    }

    if (this._frontend_type === CoreDAQ.FRONTEND_LINEAR) {
      const ch = await this.transfer_frames_adc(nFrames);
      const gains = await this.get_gains();
      const powerCh = [[], [], [], []];

      if (this._detector_type === CoreDAQ.DETECTOR_INGAAS) {
        const corr = Number(this._fastLinearCorr);
        for (let chIdx = 0; chIdx < 4; chIdx += 1) {
          const gain = Number(gains[chIdx]);
          const slope = Number(this._fastLinearSlope[chIdx][gain]);
          const intercept = Number(this._fastLinearIntercept[chIdx][gain]);
          const powerLsb = Number(this._fastLinearPowerLsb[chIdx][gain]);
          const decimals = Number(this._fastLinearDecimals[chIdx][gain]);

          if (!(slope !== 0.0)) {
            throw new CoreDAQError(`Invalid slope for head ${chIdx + 1}, gain ${gain}`);
          }

          const codes = ch[chIdx];
          const out = new Array(nFrames);
          const z = Number(this._linear_zero_adc[chIdx]);
          const mvScale = CoreDAQ.ADC_LSB_MV;
          for (let i = 0; i < nFrames; i += 1) {
            let mv = (Number(codes[i]) - z) * mvScale;
            if (this._mv_zero_threshold > 0.0 && Math.abs(mv) < this._mv_zero_threshold) mv = 0.0;
            let p = (mv - intercept) / slope;
            if (corr !== 1.0) p *= corr;
            if (powerLsb > 0.0) p = Math.round(p / powerLsb) * powerLsb;
            out[i] = Number(p.toFixed(decimals));
          }
          powerCh[chIdx] = out;
        }
        return powerCh;
      }

      if (this._detector_type === CoreDAQ.DETECTOR_SILICON) {
        const resp = Number(this._fastSiliconResp);
        for (let chIdx = 0; chIdx < 4; chIdx += 1) {
          const gain = Number(gains[chIdx]);
          const tia = Number(this._silicon_linear_tia_ohm[chIdx][gain]);
          const powerLsb = Number(this._fastLinearPowerLsb[chIdx][gain]);
          const decimals = Number(this._fastLinearDecimals[chIdx][gain]);

          if (!(resp > 0.0) || !(tia > 0.0)) {
            throw new CoreDAQError(`Invalid silicon model at head ${chIdx + 1}, gain ${gain}`);
          }

          const codes = ch[chIdx];
          const out = new Array(nFrames);
          const z = Number(this._linear_zero_adc[chIdx]);
          const mvScale = CoreDAQ.ADC_LSB_MV;
          for (let i = 0; i < nFrames; i += 1) {
            let mv = (Number(codes[i]) - z) * mvScale;
            if (this._mv_zero_threshold > 0.0 && Math.abs(mv) < this._mv_zero_threshold) mv = 0.0;
            let p = (mv / 1000.0) / (tia * resp);
            if (powerLsb > 0.0) p = Math.round(p / powerLsb) * powerLsb;
            out[i] = Number(p.toFixed(decimals));
          }
          powerCh[chIdx] = out;
        }
        return powerCh;
      }

      throw new CoreDAQError(`Unknown detector type: ${this._detector_type}`);
    }

    if (this._frontend_type === CoreDAQ.FRONTEND_LOG) {
      const ch = await this.transfer_frames_adc(nFrames);
      const db = log_deadband_mV === null ? this._log_deadband_mV : Number(log_deadband_mV);
      const powerCh = [[], [], [], []];

      if (this._detector_type === CoreDAQ.DETECTOR_SILICON) {
        const resp = Number(this._fastSiliconResp);
        if (!(resp > 0.0)) throw new CoreDAQError('Invalid silicon responsivity');
        for (let chIdx = 0; chIdx < 4; chIdx += 1) {
          const codes = ch[chIdx];
          const out = new Array(nFrames);
          const mvScale = CoreDAQ.ADC_LSB_MV;
          for (let i = 0; i < nFrames; i += 1) {
            let mv = Number(codes[i]) * mvScale;
            if (db > 0.0 && Math.abs(mv) < db) { out[i] = 0.0; continue; }
            const v = mv / 1000.0;
            const p = (this._silicon_log_iz_a / resp) * (10.0 ** (v / this._silicon_log_vy_v_per_decade));
            out[i] = Number(p.toFixed(CoreDAQ.POWER_OUTPUT_DECIMALS_MAX));
          }
          powerCh[chIdx] = out;
        }
        return powerCh;
      }

      if (this._detector_type === CoreDAQ.DETECTOR_INGAAS) {
        const xs = this._fastLoglutV;
        const ys = this._fastLoglutLog10P;
        if (!xs || !ys) throw new CoreDAQError('LOG LUT not loaded');
        const corr = Number(this._fastLogCorr);
        for (let chIdx = 0; chIdx < 4; chIdx += 1) {
          const codes = ch[chIdx];
          const out = new Array(nFrames);
          const mvScale = CoreDAQ.ADC_LSB_MV;
          for (let i = 0; i < nFrames; i += 1) {
            let mv = Number(codes[i]) * mvScale;
            if (db > 0.0 && Math.abs(mv) < db) { out[i] = 0.0; continue; }
            const v = mv / 1000.0;
            // linear interpolation of LUT
            let j = 0;
            if (v <= xs[0]) j = 0;
            else if (v >= xs[xs.length - 1]) j = xs.length - 2;
            else {
              // binary search
              let lo = 0; let hi = xs.length - 1;
              while (lo < hi - 1) {
                const mid = (lo + hi) >>> 1;
                if (xs[mid] <= v) lo = mid; else hi = mid;
              }
              j = lo;
            }
            const x0 = xs[j]; const x1 = xs[j + 1];
            const y0 = ys[j]; const y1 = ys[j + 1];
            const t = x1 === x0 ? 0.0 : (v - x0) / (x1 - x0);
            let y = y0 + t * (y1 - y0);
            let p = 10.0 ** y;
            if (corr !== 1.0) p *= corr;
            out[i] = Number(p.toFixed(CoreDAQ.POWER_OUTPUT_DECIMALS_MAX));
          }
          powerCh[chIdx] = out;
        }
        return powerCh;
      }

      throw new CoreDAQError(`Unknown detector type: ${this._detector_type}`);
    }

    throw new CoreDAQError(`Unknown frontend type: ${this._frontend_type}`);
  }

  async stream_write_address() {
    await this.ready();
    const [st, p] = await this._ask('ADDR?');
    if (st !== 'OK') {
      throw new CoreDAQError(`ADDR? failed: ${p}`);
    }
    return CoreDAQ._parse_int(p);
  }

  async soft_reset() {
    await this.ready();
    const [st, p] = await this._ask('SOFTRESET');
    if (st !== 'OK') {
      throw new CoreDAQError(`SOFTRESET failed: ${p}`);
    }
  }

  async enter_dfu() {
    await this.ready();
    await this._withLock(async () => {
      await this._applyInterCommandGapNoLock();
      await this._writelnNoLock('DFU');
    });
  }

  async i2c_refresh() {
    await this.ready();
    const [st, payload] = await this._ask('I2C REFRESH');
    if (st !== 'OK') {
      throw new CoreDAQError(`I2C REFRESH failed: ${payload}`);
    }
  }

  async get_oversampling() {
    await this.ready();
    const [st, p] = await this._ask('OS?');
    if (st !== 'OK') throw new CoreDAQError(p);
    return CoreDAQ._parse_int(p);
  }

  async get_freq_hz() {
    await this.ready();
    const [st, p] = await this._ask('FREQ?');
    if (st !== 'OK') throw new CoreDAQError(p);
    return CoreDAQ._parse_int(p);
  }

  _max_freq_for_os(os_idx) {
    const os = Number(os_idx);
    if (!(os >= 0 && os <= 7)) throw new Error('os_idx must be 0..7');
    const base = 100000;
    if (os <= 1) return base;
    return Math.floor(base / (2 ** (os - 1)));
  }

  _best_os_for_freq(hz) {
    const f = Number(hz);
    if (!(f > 0)) throw new Error('hz must be > 0');
    if (f > 100000) throw new Error('hz must be <= 100000');
    let best = 0;
    for (let os = 0; os <= 7; os += 1) {
      if (f <= this._max_freq_for_os(os)) best = os;
      else break;
    }
    return best;
  }

  async set_freq(hz) {
    await this.ready();
    const f = Number(hz);
    if (!(f > 0) || f > 100000) {
      throw new CoreDAQError('FREQ must be 1..100000 Hz');
    }

    const [st, p] = await this._ask(`FREQ ${f}`);
    if (st !== 'OK') {
      throw new CoreDAQError(p);
    }

    const curOs = await this.get_oversampling();
    if (f > this._max_freq_for_os(curOs)) {
      const newOs = this._best_os_for_freq(f);
      const [stOs, pOs] = await this._ask(`OS ${newOs}`);
      if (stOs !== 'OK') throw new CoreDAQError(pOs);
      this._warn(`OS ${curOs} is not valid at ${f} Hz. Auto-adjusted OS to ${newOs}.`);
    }
  }

  async set_oversampling(os_idx) {
    await this.ready();
    const os = Number(os_idx);
    if (!(os >= 0 && os <= 7)) {
      throw new CoreDAQError('OS must be 0..7');
    }

    const hz = await this.get_freq_hz();
    if (hz > this._max_freq_for_os(os)) {
      const newOs = this._best_os_for_freq(hz);
      const [stAuto, pAuto] = await this._ask(`OS ${newOs}`);
      if (stAuto !== 'OK') throw new CoreDAQError(pAuto);
      this._warn(`Requested OS ${os} is not valid at ${hz} Hz. Kept FREQ=${hz} Hz and set OS=${newOs}.`);
      return;
    }

    const [st, p] = await this._ask(`OS ${os}`);
    if (st !== 'OK') throw new CoreDAQError(p);
  }

  async get_head_temperature_C() {
    await this.ready();
    const [st, val] = await this._ask('TEMP?');
    if (st !== 'OK') throw new CoreDAQError(`TEMP? failed: ${val}`);
    const n = Number(val);
    if (!Number.isFinite(n)) throw new CoreDAQError(`Bad TEMP format: '${val}'`);
    return n;
  }

  async get_head_humidity() {
    await this.ready();
    const [st, val] = await this._ask('HUM?');
    if (st !== 'OK') throw new CoreDAQError(`HUM? failed: ${val}`);
    const n = Number(val);
    if (!Number.isFinite(n)) throw new CoreDAQError(`Bad HUM format: '${val}'`);
    return n;
  }

  async get_die_temperature_C() {
    await this.ready();
    const [st, val] = await this._ask('DIE_TEMP?');
    if (st !== 'OK') throw new CoreDAQError(`DIE_TEMP? failed: ${val}`);
    const n = Number(val);
    if (!Number.isFinite(n)) throw new CoreDAQError(`Bad DIE_TEMP format: '${val}'`);
    return n;
  }

  static _contains_any(s, hints) {
    const txt = String(s || '').toLowerCase();
    return hints.some((h) => txt.includes(h));
  }

  static _descriptor_match(p) {
    const man = p.manufacturer || '';
    const prod = p.product || '';
    const desc = p.friendlyName || p.path || p.pnpId || '';
    const sn = p.serialNumber || p.serial_number || '';

    const manufacturerHints = ['coreinstrumentation', 'core instrumentation'];
    const productHints = ['coredaq'];
    const serialPrefixes = ['cdaq', 'coredaq'];

    if (CoreDAQ._contains_any(man, manufacturerHints)) return true;
    if (CoreDAQ._contains_any(prod, productHints)) return true;
    if (CoreDAQ._contains_any(desc, productHints)) return true;

    const snLower = String(sn).toLowerCase();
    if (serialPrefixes.some((pref) => snLower.startsWith(pref))) return true;
    return false;
  }

  static async _probe_idn(portPath, baudrate = 115200, timeout = 0.15) {
    const SerialPort = getSerialPortCtor();
    const timeoutMs = Math.max(1, Math.round(Number(timeout) * 1000));

    const port = new SerialPort({
      path: portPath,
      baudRate: Number(baudrate),
      autoOpen: false,
    });

    const open = () => new Promise((resolve, reject) => {
      port.open((err) => (err ? reject(err) : resolve()));
    });
    const close = () => new Promise((resolve) => {
      if (!port.isOpen) return resolve();
      port.close(() => resolve());
    });
    const flush = () => new Promise((resolve) => {
      try {
        port.flush(() => resolve());
      } catch (_) {
        resolve();
      }
    });
    const write = (line) => new Promise((resolve, reject) => {
      port.write(Buffer.from(line, 'ascii'), (err) => {
        if (err) return reject(err);
        port.drain((drainErr) => (drainErr ? reject(drainErr) : resolve()));
      });
    });

    let rx = Buffer.alloc(0);
    const onData = (chunk) => {
      rx = Buffer.concat([rx, Buffer.from(chunk)]);
    };

    const readLine = async () => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const idx = rx.indexOf(0x0a);
        if (idx >= 0) {
          const out = rx.subarray(0, idx).toString('ascii').replace(/\r+$/g, '').trim();
          rx = rx.subarray(idx + 1);
          return out;
        }
        if (Date.now() >= deadline) return null;
        await new Promise((resolve, reject) => {
          let done = false;
          const cleanup = () => {
            clearTimeout(timer);
            port.off('data', onChunk);
            port.off('error', onErr);
          };
          const finish = (err) => {
            if (done) return;
            done = true;
            cleanup();
            if (err) reject(err);
            else resolve();
          };
          const onChunk = () => finish();
          const onErr = (err) => finish(err);
          const timer = setTimeout(() => finish(), 25);
          port.on('data', onChunk);
          port.on('error', onErr);
        });
      }
    };

    try {
      await open();
      port.on('data', onData);
      await flush();
      await write('IDN?\n');
      const line = await readLine();
      if (!line || !line.startsWith('OK')) return false;
      const payload = line.slice(2).trim().toLowerCase();
      return payload.includes('coredaq');
    } catch (_) {
      return false;
    } finally {
      try { port.off('data', onData); } catch (_) { /* ignore */ }
      await close();
    }
  }

  static async find(baudrate = 115200, timeout = 0.15) {
    const SerialPort = getSerialPortCtor();
    const ports = await SerialPort.list();
    const found = [];

    for (const p of ports) {
      if (CoreDAQ._descriptor_match(p)) {
        // eslint-disable-next-line no-await-in-loop
        if (await CoreDAQ._probe_idn(p.path, baudrate, timeout)) {
          found.push(p.path);
        }
      }
    }

    if (found.length === 0) {
      for (const p of ports) {
        // eslint-disable-next-line no-await-in-loop
        if (await CoreDAQ._probe_idn(p.path, baudrate, timeout)) {
          found.push(p.path);
        }
      }
    }

    return found;
  }
}

module.exports = {
  CoreDAQ,
  CoreDAQError,
};

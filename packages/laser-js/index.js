'use strict';

function detectLaserModel(idn) {
  const txt = String(idn || '').toUpperCase();
  if (txt.includes('TSL550') || (txt.includes('SANTEC') && txt.includes('550'))) return 'TSL550';
  if (txt.includes('TSL570') || (txt.includes('SANTEC') && txt.includes('570'))) return 'TSL570';
  if (txt.includes('TSL710') || (txt.includes('SANTEC') && txt.includes('710'))) return 'TSL710';
  if (txt.includes('TSL770') || (txt.includes('SANTEC') && txt.includes('770'))) return 'TSL770';
  if (txt.includes('TLB6700') || txt.includes('TLB-6700') || txt.includes('TLB 6700')) return 'TLB6700';
  if ((txt.includes('NEW_FOCUS') || txt.includes('NEW FOCUS')) && txt.includes('6700')) return 'TLB6700';
  return null;
}

function formatNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid numeric value: ${v}`);
  if (n === 0) return '0';
  if (Math.abs(n) >= 1e6 || Math.abs(n) < 1e-3) {
    return n.toExponential(12).replace(/\.?0+e/, 'e');
  }
  return String(n);
}

class BaseTSL {
  constructor(transport, model, options = {}) {
    if (!transport || typeof transport.write !== 'function' || typeof transport.query !== 'function') {
      throw new Error('transport must provide write(cmd) and query(cmd)');
    }
    this.transport = transport;
    this.model = String(model || 'TSL').toUpperCase();
    const commandSet = String(options?.commandSet || options?.dialect || 'scpi').toLowerCase();
    this.commandSet = commandSet === 'legacy' ? 'legacy' : 'scpi';
  }

  async idn() {
    return String(await this.transport.query('*IDN?')).trim();
  }

  async write(cmd) {
    await this.transport.write(cmd);
  }

  async query(cmd) {
    return String(await this.transport.query(cmd)).trim();
  }

  _isLegacy() {
    return this.commandSet === 'legacy';
  }

  async _writeAny(commands) {
    let lastErr = null;
    for (const cmd of commands) {
      if (!cmd) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.write(cmd);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    throw new Error('No command candidates provided');
  }

  async _queryAny(commands) {
    let lastErr = null;
    for (const cmd of commands) {
      if (!cmd) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await this.query(cmd);
        if (String(out || '').trim()) return String(out).trim();
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    return '';
  }

  _legacySetCandidates(token, value) {
    const t = String(token || '').trim().toUpperCase();
    const v = formatNumber(value);
    return [`${t}${v}`, `${t} ${v}`];
  }

  async configureForSweep({ startNm, stopNm, powerMw, speedNmS }) {
    const start = Number(startNm);
    const stop = Number(stopNm);
    const power = Number(powerMw);
    const speed = Number(speedNmS);

    if (!Number.isFinite(start) || !Number.isFinite(stop)) throw new Error('start/stop wavelength is invalid');
    if (!(speed > 0)) throw new Error('speed_nm_s must be > 0');
    if (!(power >= 0)) throw new Error('power_mw must be >= 0');

    if (this._isLegacy()) {
      // TSL short command set used on FTDI links.
      await this._writeAny(['LO']);
      await this._writeAny(['SO']);
      await this._writeAny(['AF', 'AO']);
      await this._writeAny(this._legacySetCandidates('LP', power));
      await this._configureSweepAxisLegacy(start, stop, speed);
      return;
    }

    await this.write('*RST');
    await this.write(':POW:ATT:AUT 1');
    await this.write(':POW:UNIT 1');
    await this.write(':TRIG:INP:EXT0');
    await this.write(':WAV:SWE:CYCL 1');
    await this.write(':TRIG:OUTP2');
    await this.write(':POW 20.0');
    await this.write(`:POW ${formatNumber(power)}`);

    await this._configureSweepAxis(start, stop, speed);

    await this.write(':WAV:SWE:MOD 1');
    await this.write(':WAV:SWE:DWEL 0');
  }

  async startSweep() {
    if (this._isLegacy()) {
      await this._writeAny(['SG']);
      return;
    }
    await this.write('WAV:SWE 1');
  }

  async stopSweep() {
    if (this._isLegacy()) {
      await this._writeAny(['SQ']);
      return;
    }
    await this.write('WAV:SWE 0');
  }

  async setWavelengthNm(wavelengthNm) {
    const wl = Number(wavelengthNm);
    if (!Number.isFinite(wl) || wl <= 0) {
      throw new Error(`Invalid wavelength: ${wavelengthNm}`);
    }

    if (this._isLegacy()) {
      await this._writeAny(this._legacySetCandidates('WA', wl));
      return;
    }

    await this.write(':WAV:UNIT 0');
    await this.write(`:WAV ${formatNumber(wl)}`);
  }

  _parseSweepState(raw) {
    const txt = String(raw || '').trim();
    if (!txt) return null;

    const upper = txt.toUpperCase();
    const num = Number(txt);
    if (Number.isFinite(num)) {
      if (num <= 0) return { known: true, running: false, raw: txt };
      return { known: true, running: true, raw: txt };
    }

    if (upper.includes('STOP') || upper.includes('OFF') || upper.includes('IDLE') || upper.includes('READY')) {
      return { known: true, running: false, raw: txt };
    }
    if (upper.includes('RUN') || upper.includes('SWEEP') || upper.includes('BUSY') || upper.includes('PAUS')) {
      return { known: true, running: true, raw: txt };
    }

    return null;
  }

  async getSweepState() {
    if (this._isLegacy()) {
      try {
        const sxRaw = await this._queryAny(['SX', 'SX?']);
        const sxNum = Number(String(sxRaw || '').trim());
        if (Number.isFinite(sxNum)) {
          if (sxNum >= 1) {
            return { known: true, running: false, raw: String(sxRaw), command: 'SX' };
          }
          return { known: true, running: true, raw: String(sxRaw), command: 'SX' };
        }
      } catch (_) {
        // continue with SK fallback
      }

      try {
        const skRaw = await this._queryAny(['SK', 'SK?', 'SU', 'SU?']);
        const parsed = this._parseSweepState(skRaw);
        if (parsed) return { ...parsed, command: 'SK' };
      } catch (_) {
        // ignore
      }

      return { known: false, running: null, raw: null, command: null };
    }

    const queries = [
      ':WAV:SWE?',
      'WAV:SWE?',
      ':WAV:SWE:STAT?',
      'WAV:SWE:STAT?',
    ];

    for (const cmd of queries) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const raw = await this.query(cmd);
        const parsed = this._parseSweepState(raw);
        if (parsed) return { ...parsed, command: cmd };
      } catch (_) {
        // try next command variant
      }
    }

    return { known: false, running: null, raw: null, command: null };
  }

  async waitForSweepComplete({ timeoutMs = 10000, pollIntervalMs = 300 } = {}) {
    const deadline = Date.now() + Math.max(200, Math.round(Number(timeoutMs) || 10000));
    const pollMs = Math.max(50, Math.round(Number(pollIntervalMs) || 300));
    let last = { known: false, running: null, raw: null, command: null };

    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      last = await this.getSweepState();
      if (last.known && last.running === false) {
        return { complete: true, ...last };
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return { complete: false, ...last };
  }

  async close() {
    if (typeof this.transport.close === 'function') {
      await this.transport.close();
    }
  }

  async _configureSweepAxisLegacy(startNm, stopNm, speedNmS) {
    await this._writeAny(this._legacySetCandidates('SS', startNm));
    await this._writeAny(this._legacySetCandidates('SE', stopNm));
    await this._writeAny(this._legacySetCandidates('SN', speedNmS));
    await this._writeAny(this._legacySetCandidates('SZ', 1));
  }

  async _configureSweepAxis(_startNm, _stopNm, _speedNmS) {
    throw new Error('Not implemented');
  }
}

class TLB6700 {
  constructor(transport, options = {}) {
    if (!transport || typeof transport.write !== 'function' || typeof transport.query !== 'function') {
      throw new Error('transport must provide write(cmd) and query(cmd)');
    }
    this.transport = transport;
    this.model = 'TLB6700';
    this.options = options || {};
  }

  async write(cmd) {
    await this.transport.write(cmd);
  }

  async query(cmd) {
    return String(await this.transport.query(cmd)).trim();
  }

  async _writeAny(commands) {
    let lastErr = null;
    for (const cmd of commands) {
      if (!cmd) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.write(cmd);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    throw new Error('No command candidates provided');
  }

  async _queryAny(commands) {
    let lastErr = null;
    for (const cmd of commands) {
      if (!cmd) continue;
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await this.query(cmd);
        if (String(out || '').trim()) return String(out).trim();
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
    return '';
  }

  async idn() {
    return String(await this._queryAny(['*IDN?'])).trim();
  }

  async ensureRemote() {
    await this._writeAny(['SYST:MCON REM', 'SYSTEM:MCONTROL REM']);
  }

  async setOutputEnabled(enabled) {
    await this._writeAny([
      `OUTP:STAT ${enabled ? 1 : 0}`,
      `OUTPUT:STATE ${enabled ? 'ON' : 'OFF'}`,
    ]);
  }

  async setTrackEnabled(enabled) {
    await this._writeAny([
      `OUTP:TRAC ${enabled ? 1 : 0}`,
      `OUTPUT:TRACK ${enabled ? 1 : 0}`,
    ]);
  }

  async setPowerMw(powerMw) {
    const power = Number(powerMw);
    if (!(power >= 0)) throw new Error('power_mw must be >= 0');
    await this._writeAny([
      `SOUR:POW:DIOD ${formatNumber(power)}`,
      `SOURCE:POWER:DIODE ${formatNumber(power)}`,
    ]);
  }

  async setConstantPowerMode(enabled = true) {
    await this._writeAny([
      `SOUR:CPOW ${enabled ? 1 : 0}`,
      `SOURCE:CPOWER ${enabled ? 1 : 0}`,
    ]);
  }

  async setWavelengthNm(wavelengthNm) {
    const wl = Number(wavelengthNm);
    if (!Number.isFinite(wl) || wl <= 0) throw new Error(`Invalid wavelength: ${wavelengthNm}`);
    await this.ensureRemote();
    await this.setTrackEnabled(true);
    await this._writeAny([
      `SOUR:WAVE ${formatNumber(wl)}`,
      `SOURCE:WAVELENGTH ${formatNumber(wl)}`,
    ]);
  }

  async getWavelengthNm() {
    const raw = await this._queryAny(['SENS:WAVE?', 'SENSE:WAVELENGTH?']);
    const value = Number(String(raw || '').trim());
    if (!Number.isFinite(value)) throw new Error(`Invalid wavelength readback: ${raw}`);
    return value;
  }

  async configureForStepSweep({ powerMw = 1.0, outputEnabled = true } = {}) {
    await this.ensureRemote();
    await this.setConstantPowerMode(true);
    await this.setPowerMw(powerMw);
    if (outputEnabled) {
      await this.setOutputEnabled(true);
    }
  }

  async configureForSweep({ startNm, stopNm, powerMw, speedNmS }) {
    const start = Number(startNm);
    const stop = Number(stopNm);
    const power = Number(powerMw);
    const speed = Number(speedNmS);
    if (!Number.isFinite(start) || !Number.isFinite(stop)) throw new Error('start/stop wavelength is invalid');
    if (!(speed > 0)) throw new Error('speed_nm_s must be > 0');
    if (!(power >= 0)) throw new Error('power_mw must be >= 0');

    await this.ensureRemote();
    await this.setConstantPowerMode(true);
    await this.setPowerMw(power);
    await this.setOutputEnabled(true);
    await this.setTrackEnabled(true);
    await this._writeAny([
      `SOUR:WAVE:START ${formatNumber(start)}`,
      `SOURCE:WAVELENGTH:START ${formatNumber(start)}`,
    ]);
    await this._writeAny([
      `SOUR:WAVE:STOP ${formatNumber(stop)}`,
      `SOURCE:WAVELENGTH:STOP ${formatNumber(stop)}`,
    ]);
    await this._writeAny([
      `SOUR:WAVE:SLEW:FORW ${formatNumber(speed)}`,
      `SOURCE:WAVELENGTH:SLEW:FORWARD ${formatNumber(speed)}`,
    ]);
    await this._writeAny([
      `SOUR:WAVE:SLEW:RET ${formatNumber(speed)}`,
      `SOURCE:WAVELENGTH:SLEW:RETURN ${formatNumber(speed)}`,
    ]);
  }

  async startSweep() {
    await this._writeAny(['OUTP:SCAN:START', 'OUTPUT:SCAN:START']);
  }

  async stopSweep() {
    await this._writeAny(['OUTP:SCAN:STOP', 'OUTPUT:SCAN:STOP']);
  }

  async resetSweep() {
    await this._writeAny(['OUTP:SCAN:RESET', 'OUTPUT:SCAN:RESET']);
  }

  async getSweepState() {
    try {
      const raw = await this._queryAny(['*OPC?']);
      const num = Number(String(raw || '').trim());
      if (Number.isFinite(num)) {
        return {
          known: true,
          running: num === 0,
          raw: String(raw),
          command: '*OPC?',
        };
      }
    } catch (_) {
      // ignore and fall through
    }
    return { known: false, running: null, raw: null, command: null };
  }

  async waitForSweepComplete({ timeoutMs = 10000, pollIntervalMs = 300 } = {}) {
    const deadline = Date.now() + Math.max(200, Math.round(Number(timeoutMs) || 10000));
    const pollMs = Math.max(50, Math.round(Number(pollIntervalMs) || 300));
    let last = { known: false, running: null, raw: null, command: null };

    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      last = await this.getSweepState();
      if (last.known && last.running === false) {
        return { complete: true, ...last };
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return { complete: false, ...last };
  }

  async waitForOperationComplete({ timeoutMs = 10000, pollIntervalMs = 200 } = {}) {
    return this.waitForSweepComplete({ timeoutMs, pollIntervalMs });
  }

  async close() {
    if (typeof this.transport.close === 'function') {
      await this.transport.close();
    }
  }
}

class TSL550 extends BaseTSL {
  constructor(transport, options = {}) {
    super(transport, 'TSL550', options);
  }

  async _configureSweepAxis(startNm, stopNm, speedNmS) {
    await this.write(':WAV:UNIT 0');
    await this.write(`:WAV:SWE:SPE ${formatNumber(speedNmS)}`);
    await this.write(`:WAV ${formatNumber(startNm)}`);
    await this.write(`:WAV:SWE:STAR ${formatNumber(startNm)}`);
    await this.write(`:WAV:SWE:STOP ${formatNumber(stopNm)}`);
  }
}

class TSL570 extends BaseTSL {
  constructor(transport, options = {}) {
    super(transport, 'TSL570', options);
  }

  async _configureSweepAxis(startNm, stopNm, speedNmS) {
    await this.write(':WAV:UNIT 0');
    await this.write(`:WAV:SWE:SPE ${formatNumber(speedNmS)}`);
    await this.write(`:WAV ${formatNumber(startNm)}`);
    await this.write(`:WAV:SWE:STAR ${formatNumber(startNm)}`);
    await this.write(`:WAV:SWE:STOP ${formatNumber(stopNm)}`);
  }
}

class TSL770 extends BaseTSL {
  constructor(transport, options = {}) {
    super(transport, 'TSL770', options);
  }

  async _configureSweepAxis(startNm, stopNm, speedNmS) {
    // Use wavelength units in nm across TSL550/570/770 for a consistent host-side sweep pipeline.
    await this.write(':WAV:UNIT 0');
    await this.write(`:WAV:SWE:SPE ${formatNumber(speedNmS)}`);
    await this.write(`:WAV ${formatNumber(startNm)}`);
    await this.write(`:WAV:SWE:STAR ${formatNumber(startNm)}`);
    await this.write(`:WAV:SWE:STOP ${formatNumber(stopNm)}`);
  }
}

class TSL710 extends BaseTSL {
  constructor(transport, options = {}) {
    super(transport, 'TSL710', options);
  }

  async _configureSweepAxis(startNm, stopNm, speedNmS) {
    await this.write(':WAV:UNIT 0');
    await this.write(`:WAV:SWE:SPE ${formatNumber(speedNmS)}`);
    await this.write(`:WAV ${formatNumber(startNm)}`);
    await this.write(`:WAV:SWE:STAR ${formatNumber(startNm)}`);
    await this.write(`:WAV:SWE:STOP ${formatNumber(stopNm)}`);
  }
}

function createLaserDriver(model, transport, options = {}) {
  const m = String(model || '').toUpperCase().trim();
  if (m === 'TSL550') return new TSL550(transport, options);
  if (m === 'TSL570') return new TSL570(transport, options);
  if (m === 'TSL710') return new TSL710(transport, options);
  if (m === 'TSL770') return new TSL770(transport, options);
  if (m === 'TLB6700') return new TLB6700(transport, options);
  throw new Error(`Unsupported laser model: ${model}`);
}

function createLaserFromIdn(idn, transport, options = {}) {
  const model = detectLaserModel(idn);
  if (!model) {
    const commandSet = String(options?.commandSet || options?.dialect || 'scpi').toLowerCase();
    if (commandSet === 'legacy') {
      return {
        model: 'TSL_LEGACY',
        laser: new TSL550(transport, options),
      };
    }
    throw new Error('Unsupported laser model. Supported models: TSL550, TSL570, TSL710, TSL770, TLB6700.');
  }
  return {
    model,
    laser: createLaserDriver(model, transport, options),
  };
}

module.exports = {
  detectLaserModel,
  BaseTSL,
  TLB6700,
  TSL550,
  TSL570,
  TSL710,
  TSL770,
  createLaserDriver,
  createLaserFromIdn,
};

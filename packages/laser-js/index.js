'use strict';

function detectLaserModel(idn) {
  const txt = String(idn || '').toUpperCase();
  if (txt.includes('TSL550') || (txt.includes('SANTEC') && txt.includes('550'))) return 'TSL550';
  if (txt.includes('TSL570') || (txt.includes('SANTEC') && txt.includes('570'))) return 'TSL570';
  if (txt.includes('TSL770') || (txt.includes('SANTEC') && txt.includes('770'))) return 'TSL770';
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
  constructor(transport, model) {
    if (!transport || typeof transport.write !== 'function' || typeof transport.query !== 'function') {
      throw new Error('transport must provide write(cmd) and query(cmd)');
    }
    this.transport = transport;
    this.model = String(model || 'TSL').toUpperCase();
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

  async configureForSweep({ startNm, stopNm, powerMw, speedNmS }) {
    const start = Number(startNm);
    const stop = Number(stopNm);
    const power = Number(powerMw);
    const speed = Number(speedNmS);

    if (!Number.isFinite(start) || !Number.isFinite(stop)) throw new Error('start/stop wavelength is invalid');
    if (!(speed > 0)) throw new Error('speed_nm_s must be > 0');
    if (!(power >= 0)) throw new Error('power_mw must be >= 0');

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
    await this.write('WAV:SWE 1');
  }

  async stopSweep() {
    await this.write('WAV:SWE 0');
  }

  async close() {
    if (typeof this.transport.close === 'function') {
      await this.transport.close();
    }
  }

  async _configureSweepAxis(_startNm, _stopNm, _speedNmS) {
    throw new Error('Not implemented');
  }
}

class TSL550 extends BaseTSL {
  constructor(transport) {
    super(transport, 'TSL550');
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
  constructor(transport) {
    super(transport, 'TSL570');
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
  constructor(transport) {
    super(transport, 'TSL770');
  }

  async _configureSweepAxis(startNm, stopNm, speedNmS) {
    const startM = Number(startNm) * 1e-9;
    const stopM = Number(stopNm) * 1e-9;
    const speedMS = Number(speedNmS) * 1e-9;

    await this.write(':WAV:UNIT 1');
    await this.write(`:WAV:SWE:SPE ${formatNumber(speedMS)}`);
    await this.write(`:WAV ${formatNumber(startM)}`);
    await this.write(`:WAV:SWE:STAR ${formatNumber(startM)}`);
    await this.write(`:WAV:SWE:STOP ${formatNumber(stopM)}`);
  }
}

function createLaserDriver(model, transport) {
  const m = String(model || '').toUpperCase().trim();
  if (m === 'TSL550') return new TSL550(transport);
  if (m === 'TSL570') return new TSL570(transport);
  if (m === 'TSL770') return new TSL770(transport);
  throw new Error(`Unsupported laser model: ${model}`);
}

function createLaserFromIdn(idn, transport) {
  const model = detectLaserModel(idn);
  if (!model) throw new Error('Unsupported laser model. Supported models: TSL550, TSL570, TSL770.');
  return {
    model,
    laser: createLaserDriver(model, transport),
  };
}

module.exports = {
  detectLaserModel,
  BaseTSL,
  TSL550,
  TSL570,
  TSL770,
  createLaserDriver,
  createLaserFromIdn,
};

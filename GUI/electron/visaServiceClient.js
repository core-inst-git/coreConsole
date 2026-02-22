'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function isWin() {
  return process.platform === 'win32';
}

function createError(code, message, extra = {}) {
  const err = new Error(message || code);
  err.code = code;
  Object.assign(err, extra);
  return err;
}

class VisaServiceClient {
  constructor(opts = {}) {
    this.isDev = !!opts.isDev;
    this.onBootError = typeof opts.onBootError === 'function' ? opts.onBootError : null;
    this.onBootOk = typeof opts.onBootOk === 'function' ? opts.onBootOk : null;
    this.restartDelayMs = Number.isFinite(Number(opts.restartDelayMs)) ? Number(opts.restartDelayMs) : 1000;
    this.bootTimeoutMs = Number.isFinite(Number(opts.bootTimeoutMs)) ? Number(opts.bootTimeoutMs) : 10000;
    this.autoRestart = opts.autoRestart !== false;

    this.child = null;
    this.stdoutBuf = '';
    this.reqSeq = 1;
    this.pending = new Map();
    this.starting = null;
    this.stopping = false;
    this.suppressRestart = false;
    this.lastBootError = null;
    this.bootReady = false;
  }

  _serviceScriptPath() {
    if (this.isDev) {
      return path.resolve(__dirname, '..', '..', 'packages', 'visa-service', 'src', 'service.js');
    }
    return path.join(process.resourcesPath, 'visa-service', 'src', 'service.js');
  }

  _addonBinaryPath() {
    if (this.isDev) {
      return path.resolve(__dirname, '..', '..', 'packages', 'visa-addon', 'build', 'Release', 'visa_addon.node');
    }
    return path.join(process.resourcesPath, 'visa-addon', 'build', 'Release', 'visa_addon.node');
  }

  _serviceLogPath() {
    if (process.env.VISA_SERVICE_LOG) return process.env.VISA_SERVICE_LOG;
    return path.join(process.cwd(), 'coreconsole_visa_service.log');
  }

  _rejectAllPending(err) {
    for (const [, req] of this.pending) {
      req.reject(err);
    }
    this.pending.clear();
  }

  _handleStdout(chunk) {
    this.stdoutBuf += String(chunk || '');
    for (;;) {
      const idx = this.stdoutBuf.indexOf('\n');
      if (idx < 0) break;
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[visa-service] non-JSON output:', line);
        continue;
      }

      if (msg.type === 'BOOT_ERROR') {
        this.lastBootError = msg.error || createError('BOOT_ERROR', 'visa-service boot failed');
        this.bootReady = false;
        if (this.onBootError) this.onBootError(this.lastBootError);
        continue;
      }

      if (msg.type === 'BOOT_OK') {
        this.lastBootError = null;
        this.bootReady = true;
        if (this.onBootOk) this.onBootOk(msg.result || {});
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(msg, 'id')) {
        continue;
      }

      const key = String(msg.id);
      const pending = this.pending.get(key);
      if (!pending) continue;
      this.pending.delete(key);

      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        const e = createError(
          msg.error?.code || 'VISA_ERROR',
          msg.error?.message || 'visa-service request failed',
          msg.error || {},
        );
        pending.reject(e);
      }
    }
  }

  _scheduleRestart() {
    if (this.stopping || this.suppressRestart || !this.autoRestart) return;
    setTimeout(() => {
      this.start().catch(() => {
        // ignore, caller sees onBootError/health failures
      });
    }, this.restartDelayMs);
  }

  async start() {
    if (this.child && !this.child.killed) return;
    if (this.starting) return this.starting;

    this.starting = new Promise((resolve, reject) => {
      const script = this._serviceScriptPath();
      if (!fs.existsSync(script)) {
        reject(createError('SERVICE_NOT_FOUND', `visa-service script not found: ${script}`));
        this.starting = null;
        return;
      }

      const addonPath = this._addonBinaryPath();
      const env = {
        ...process.env,
        VISA_SERVICE_LOG: this._serviceLogPath(),
        ELECTRON_RUN_AS_NODE: '1',
      };
      if (fs.existsSync(addonPath)) {
        env.VISA_ADDON_PATH = addonPath;
      }

      const child = spawn(process.execPath, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env,
      });

      this.child = child;
      this.stdoutBuf = '';
      this.bootReady = false;
      this.lastBootError = null;

      child.stdout.on('data', (chunk) => this._handleStdout(chunk));
      child.stderr.on('data', (chunk) => {
        // eslint-disable-next-line no-console
        console.warn('[visa-service]', String(chunk || '').trim());
      });

      child.on('error', (err) => {
        const e = createError('SERVICE_SPAWN_FAILED', err.message || String(err));
        this._rejectAllPending(e);
        this.child = null;
        this.starting = null;
        reject(e);
      });

      child.on('exit', (code, signal) => {
        const e = createError('SERVICE_DIED', `visa-service exited (code=${code}, signal=${signal || ''})`);
        this._rejectAllPending(e);
        this.child = null;
        this.starting = null;
        this.bootReady = false;
        this._scheduleRestart();
      });

      // Boot handshake timeout (Windows can take a few seconds to load VISA stack).
      setTimeout(() => {
        this.starting = null;
        if (this.lastBootError) {
          reject(createError(this.lastBootError.code || 'BOOT_ERROR', this.lastBootError.message || 'visa-service boot error', this.lastBootError));
          return;
        }
        if (!this.bootReady) {
          reject(createError('SERVICE_BOOT_TIMEOUT', 'visa-service did not report BOOT_OK in time'));
          return;
        }
        resolve();
      }, this.bootTimeoutMs);
    });

    return this.starting;
  }

  async stop() {
    this.stopping = true;
    this.suppressRestart = true;
    try {
      if (this.child && !this.child.killed) {
        this.child.kill();
      }
    } finally {
      this.child = null;
      this.bootReady = false;
      this.stopping = false;
      this.starting = null;
      setTimeout(() => {
        this.suppressRestart = false;
      }, Math.max(500, this.restartDelayMs));
    }
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  async request(method, params = {}, timeoutMs = 15000) {
    if (!this.child || this.child.killed || !this.bootReady) {
      await this.start();
    }

    const id = String(this.reqSeq++);
    const req = { id, method, params };

    const line = `${JSON.stringify(req)}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(createError('RPC_TIMEOUT', `visa-service RPC timeout for ${method}`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      try {
        this.child.stdin.write(line);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(createError('SERVICE_WRITE_FAILED', err.message || String(err)));
      }
    });
  }

  async health() {
    return this.request('health', {}, 8000);
  }
}

module.exports = {
  VisaServiceClient,
  isWin,
};

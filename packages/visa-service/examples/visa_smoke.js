'use strict';

const path = require('path');
const { spawn } = require('child_process');

function parseArgs(argv) {
  const out = {
    resource: '',
    command: '*IDN?\n',
    timeoutMs: 3000,
    readMax: 65536,
    listOnly: false,
    mock: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--resource' && i + 1 < argv.length) {
      out.resource = argv[++i];
      continue;
    }
    if (a === '--command' && i + 1 < argv.length) {
      out.command = argv[++i];
      continue;
    }
    if (a === '--timeout-ms' && i + 1 < argv.length) {
      out.timeoutMs = Number(argv[++i]);
      continue;
    }
    if (a === '--read-max' && i + 1 < argv.length) {
      out.readMax = Number(argv[++i]);
      continue;
    }
    if (a === '--list-only') {
      out.listOnly = true;
      continue;
    }
    if (a === '--mock') {
      out.mock = true;
      continue;
    }
  }

  out.command = String(out.command).replace(/\\r/g, '\r').replace(/\\n/g, '\n');

  if (!out.command.endsWith('\n')) {
    out.command = `${out.command}\n`;
  }

  return out;
}

class RpcClient {
  constructor(serviceScript, env = {}) {
    this.serviceScript = serviceScript;
    this.env = env;
    this.child = null;
    this.reqSeq = 1;
    this.pending = new Map();
    this.buf = '';
    this.boot = null;
  }

  async start() {
    this.child = spawn(process.execPath, [this.serviceScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
    });

    this.child.stderr.on('data', (chunk) => {
      const s = String(chunk || '').trim();
      if (s) console.error('[visa-service stderr]', s);
    });

    this.child.on('exit', (code, signal) => {
      const err = new Error(`visa-service exited (code=${code}, signal=${signal || ''})`);
      err.code = 'SERVICE_EXITED';
      for (const [, p] of this.pending) {
        p.reject(err);
      }
      this.pending.clear();
    });

    this.boot = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Boot timeout waiting for BOOT_OK/BOOT_ERROR')), 5000);

      const onData = (chunk) => {
        this.buf += String(chunk || '');
        for (;;) {
          const idx = this.buf.indexOf('\n');
          if (idx < 0) break;
          const line = this.buf.slice(0, idx).trim();
          this.buf = this.buf.slice(idx + 1);
          if (!line) continue;

          let msg;
          try {
            msg = JSON.parse(line);
          } catch (_) {
            console.log('[service]', line);
            continue;
          }

          if (msg.type === 'BOOT_ERROR') {
            clearTimeout(t);
            this.child.stdout.off('data', onData);
            const err = new Error(msg.error?.message || 'BOOT_ERROR');
            err.code = msg.error?.code || 'BOOT_ERROR';
            err.details = msg.error;
            reject(err);
            return;
          }

          if (msg.type === 'BOOT_OK') {
            clearTimeout(t);
            this.child.stdout.off('data', onData);
            this.child.stdout.on('data', (next) => this._onStdout(next));
            resolve(msg.result || {});
            return;
          }
        }
      };

      this.child.stdout.on('data', onData);
    });

    return this.boot;
  }

  _onStdout(chunk) {
    this.buf += String(chunk || '');
    for (;;) {
      const idx = this.buf.indexOf('\n');
      if (idx < 0) break;
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        console.log('[service]', line);
        continue;
      }

      if (msg.type) {
        console.log(`[service:${msg.type}]`, msg);
        continue;
      }

      if (!Object.prototype.hasOwnProperty.call(msg, 'id')) continue;

      const key = String(msg.id);
      const p = this.pending.get(key);
      if (!p) continue;
      this.pending.delete(key);

      if (msg.ok) p.resolve(msg.result);
      else {
        const err = new Error(msg.error?.message || 'RPC failed');
        err.code = msg.error?.code || 'RPC_ERROR';
        err.details = msg.error;
        p.reject(err);
      }
    }
  }

  request(method, params = {}, timeoutMs = 10000) {
    if (!this.child || this.child.killed) {
      return Promise.reject(new Error('Service is not running'));
    }

    const id = String(this.reqSeq++);
    const payload = { id, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        const err = new Error(`RPC timeout: ${method}`);
        err.code = 'RPC_TIMEOUT';
        reject(err);
      }, timeoutMs);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  async stop() {
    if (!this.child || this.child.killed) return;
    this.child.kill();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const serviceScript = path.join(__dirname, '..', 'src', 'service.js');

  const env = {};
  if (args.mock) {
    env.VISA_SERVICE_MOCK = '1';
  }

  const client = new RpcClient(serviceScript, env);

  try {
    const boot = await client.start();
    console.log('BOOT_OK:', boot);

    const health = await client.request('health', {});
    console.log('HEALTH:', health);

    const resources = await client.request('listResources', {});
    console.log('RESOURCES:', resources);

    if (args.listOnly) {
      return 0;
    }

    const resource = args.resource || (Array.isArray(resources) && resources.length ? resources[0] : '');
    if (!resource) {
      console.error('No VISA resource available. Use --resource or connect an instrument.');
      return 2;
    }

    const opened = await client.request('open', {
      resource,
      timeoutMs: args.timeoutMs,
    });
    const sessionId = opened.sessionId;
    console.log('OPEN:', { sessionId, resource });

    await client.request('setTimeout', { sessionId, ms: args.timeoutMs });
    console.log('SET_TIMEOUT OK');

    const q = await client.request('query', {
      sessionId,
      command: args.command,
      maxBytes: args.readMax,
    });
    console.log('QUERY:', q);

    await client.request('write', { sessionId, command: args.command });
    const r = await client.request('read', { sessionId, maxBytes: args.readMax });
    console.log('WRITE+READ:', r);

    await client.request('close', { sessionId });
    console.log('CLOSE OK');

    return 0;
  } catch (err) {
    console.error('SMOKE FAILED:', err.code || 'ERROR', err.message || err);
    if (err.details) {
      console.error('DETAILS:', err.details);
    }
    return 1;
  } finally {
    await client.stop();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

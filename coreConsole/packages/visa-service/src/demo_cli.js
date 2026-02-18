'use strict';

const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const serviceScript = path.join(__dirname, 'service.js');
const child = spawn(process.execPath, [serviceScript], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

let reqId = 1;
const pending = new Map();

function rpc(method, params = {}) {
  const id = String(reqId++);
  const payload = { id, method, params };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, t0: Date.now() });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 10000);
  });
}

let buf = '';
child.stdout.on('data', (chunk) => {
  buf += String(chunk || '');
  for (;;) {
    const idx = buf.indexOf('\n');
    if (idx < 0) break;
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      console.log('SERVICE:', line);
      continue;
    }

    if (msg.type === 'BOOT_ERROR') {
      console.error('BOOT_ERROR:', msg.error);
      process.exit(1);
      return;
    }

    if (msg.type === 'BOOT_OK') {
      console.log('Service ready:', msg.result);
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(msg, 'id')) {
      console.log('SERVICE:', msg);
      return;
    }

    const p = pending.get(String(msg.id));
    if (!p) return;
    pending.delete(String(msg.id));

    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error?.message || 'RPC failed'));
  }
});

child.on('exit', (code) => {
  for (const [, p] of pending) {
    p.reject(new Error(`Service exited (${code})`));
  }
  pending.clear();
});

(async () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  try {
    const resources = await rpc('listResources');
    console.log('Resources:', resources);
    if (!resources.length) {
      console.log('No VISA resources.');
      rl.close();
      child.kill();
      return;
    }

    const sel = await ask(`Select index [0..${resources.length - 1}] (default 0): `);
    const idx = Number.isFinite(Number(sel)) ? Number(sel) : 0;
    const resource = resources[Math.max(0, Math.min(resources.length - 1, idx))];

    const { sessionId } = await rpc('open', { resource });
    console.log('Opened session:', sessionId, resource);

    const idn = await rpc('query', { sessionId, command: '*IDN?\n' });
    console.log('*IDN? =>', idn.data);

    for (;;) {
      const cmd = await ask('SCPI> ');
      if (!cmd || cmd.trim().toLowerCase() === 'exit') break;
      if (cmd.trim().endsWith('?')) {
        const out = await rpc('query', { sessionId, command: `${cmd}\n` });
        console.log(out.data);
      } else {
        await rpc('write', { sessionId, command: `${cmd}\n` });
        console.log('OK');
      }
    }

    await rpc('close', { sessionId });
  } catch (err) {
    console.error(err.message || err);
  } finally {
    rl.close();
    child.kill();
  }
})();

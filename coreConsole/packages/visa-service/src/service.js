'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_READ_MAX_BYTES = 64 * 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_COMMAND_BYTES = 8 * 1024;
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

const sessions = new Map();
let addon = null;
let rmHandle = null;
let bootInfo = {
  visaLoaded: false,
  resourceManager: false,
  gpibDetected: false,
  resourcesSample: [],
  checkedPaths: [],
  loadedPath: '',
  platform: process.platform,
  reason: '',
};

const logPath = process.env.VISA_SERVICE_LOG || '';

function rotateLogIfNeeded() {
  if (!logPath) return;
  try {
    if (!fs.existsSync(logPath)) return;
    const stat = fs.statSync(logPath);
    if (stat.size < LOG_ROTATE_BYTES) return;
    const backup = `${logPath}.1`;
    if (fs.existsSync(backup)) fs.unlinkSync(backup);
    fs.renameSync(logPath, backup);
  } catch (_) {
    // best effort
  }
}

function logLine(msg) {
  if (!logPath) return;
  try {
    rotateLogIfNeeded();
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] ${msg}\n`, 'utf8');
  } catch (_) {
    // best effort
  }
}

function emit(obj) {
  const line = JSON.stringify(obj);
  process.stdout.write(`${line}\n`);
}

function emitBootError(err) {
  emit({
    type: 'BOOT_ERROR',
    ok: false,
    error: err,
  });
}

function makeError(code, message, extra = {}) {
  return {
    code,
    message: String(message || code),
    ...extra,
  };
}

function toRpcError(err, fallbackCode = 'VISA_ERROR') {
  const code = (err && err.code) ? String(err.code) : fallbackCode;
  const message = err && err.message ? String(err.message) : String(err || fallbackCode);
  const out = { code, message };
  if (err && typeof err.status !== 'undefined') out.status = err.status;
  if (err && Array.isArray(err.checkedPaths)) out.checkedPaths = err.checkedPaths;
  if (err && err.fix) out.fix = err.fix;
  return out;
}

function validateCommand(command) {
  const cmd = String(command || '');
  const len = Buffer.byteLength(cmd, 'utf8');
  if (len <= 0) {
    throw Object.assign(new Error('Empty command'), { code: 'INVALID_ARGUMENT' });
  }
  if (len > MAX_COMMAND_BYTES) {
    throw Object.assign(new Error(`Command too long (${len} bytes)`), { code: 'INVALID_ARGUMENT' });
  }
  return cmd;
}

function normalizeReadSize(maxBytes) {
  const n = Number.isFinite(Number(maxBytes)) ? Number(maxBytes) : DEFAULT_READ_MAX_BYTES;
  return Math.max(1, Math.min(MAX_READ_BYTES, Math.round(n)));
}

function resolveAddonModule() {
  if (process.env.VISA_SERVICE_MOCK === '1') {
    logLine('Using mock VISA addon');
    return require('./mock_visa_addon');
  }

  const explicit = process.env.VISA_ADDON_PATH || '';
  if (explicit) {
    logLine(`Loading VISA addon from VISA_ADDON_PATH=${explicit}`);
    return require(path.resolve(explicit));
  }

  const pkgPath = path.resolve(__dirname, '..', '..', 'visa-addon');
  logLine(`Loading VISA addon package from ${pkgPath}`);
  return require(pkgPath);
}

function listResourcesSafe() {
  const resources = addon.listResources(rmHandle) || [];
  return Array.isArray(resources) ? resources.map((r) => String(r)) : [];
}

function detectGpib(resources) {
  return resources.some((r) => /^GPIB\d+::/i.test(String(r)));
}

function healthPayload() {
  const resources = rmHandle ? listResourcesSafe() : [];
  const gpibDetected = detectGpib(resources);
  return {
    visaLoaded: !!bootInfo.visaLoaded,
    resourceManager: !!bootInfo.resourceManager,
    gpibDetected,
    resourcesSample: resources.slice(0, 64),
    checkedPaths: bootInfo.checkedPaths || [],
    loadedPath: bootInfo.loadedPath || '',
    platform: bootInfo.platform || process.platform,
    reason: bootInfo.reason || '',
  };
}

function queueSession(session, fn) {
  const run = session.queue.then(fn, fn);
  session.queue = run.catch(() => {});
  return run;
}

function getSessionOrThrow(sessionId) {
  const id = String(sessionId || '');
  const session = sessions.get(id);
  if (!session) {
    throw Object.assign(new Error(`Unknown sessionId: ${id}`), { code: 'INVALID_SESSION' });
  }
  return session;
}

function openSession(resource, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const resourceStr = String(resource || '').trim();
  if (!resourceStr) {
    throw Object.assign(new Error('resource is required'), { code: 'INVALID_ARGUMENT' });
  }

  const handle = addon.open(rmHandle, resourceStr);
  const sessionId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  addon.setTimeout(handle, Math.max(1, Math.round(Number(timeoutMs) || DEFAULT_TIMEOUT_MS)));
  if (typeof addon.setTermChar === 'function') {
    try {
      addon.setTermChar(handle, 10, true);
    } catch (_) {
      // optional capability
    }
  }

  sessions.set(sessionId, {
    id: sessionId,
    resource: resourceStr,
    handle,
    queue: Promise.resolve(),
    timeoutMs: Math.max(1, Math.round(Number(timeoutMs) || DEFAULT_TIMEOUT_MS)),
  });

  return { sessionId };
}

async function closeSession(sessionId) {
  const session = getSessionOrThrow(sessionId);
  await queueSession(session, async () => {
    addon.close(session.handle);
  });
  sessions.delete(session.id);
  return { ok: true };
}

async function handleMethod(method, params) {
  const p = params && typeof params === 'object' ? params : {};

  switch (method) {
    case 'health': {
      return healthPayload();
    }
    case 'listResources': {
      return listResourcesSafe();
    }
    case 'open': {
      return openSession(p.resource, p.timeoutMs);
    }
    case 'setTimeout': {
      const session = getSessionOrThrow(p.sessionId);
      const ms = Math.max(1, Math.round(Number(p.ms)));
      await queueSession(session, async () => {
        addon.setTimeout(session.handle, ms);
        session.timeoutMs = ms;
      });
      return { ok: true };
    }
    case 'write': {
      const session = getSessionOrThrow(p.sessionId);
      const command = validateCommand(p.command);
      const out = await queueSession(session, async () => {
        const bytesWritten = addon.write(session.handle, command);
        return { ok: true, bytesWritten: Number(bytesWritten) };
      });
      return out;
    }
    case 'read': {
      const session = getSessionOrThrow(p.sessionId);
      const maxBytes = normalizeReadSize(p.maxBytes);
      const out = await queueSession(session, async () => {
        const data = addon.read(session.handle, maxBytes);
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        return { data: buf.toString('utf8').replace(/\r?\n$/, '') };
      });
      return out;
    }
    case 'query': {
      if (p.sessionId) {
        const session = getSessionOrThrow(p.sessionId);
        const command = validateCommand(p.command);
        const out = await queueSession(session, async () => {
          addon.write(session.handle, command);
          const data = addon.read(session.handle, normalizeReadSize(p.maxBytes));
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          return { data: buf.toString('utf8').replace(/\r?\n$/, '') };
        });
        return out;
      }

      // Optional convenience path: query by resource without explicit open.
      if (p.resource) {
        const { sessionId } = openSession(p.resource, p.timeoutMs);
        try {
          const out = await handleMethod('query', {
            sessionId,
            command: p.command,
            maxBytes: p.maxBytes,
          });
          return out;
        } finally {
          await closeSession(sessionId).catch(() => {});
        }
      }

      throw Object.assign(new Error('query requires sessionId or resource'), { code: 'INVALID_ARGUMENT' });
    }
    case 'close': {
      return closeSession(p.sessionId);
    }
    case 'writeBinary': {
      const session = getSessionOrThrow(p.sessionId);
      const dataB64 = String(p.dataBase64 || '');
      const buf = Buffer.from(dataB64, 'base64');
      if (buf.length === 0) {
        throw Object.assign(new Error('writeBinary dataBase64 is empty'), { code: 'INVALID_ARGUMENT' });
      }
      const out = await queueSession(session, async () => {
        const bytesWritten = addon.write(session.handle, buf);
        return { ok: true, bytesWritten: Number(bytesWritten) };
      });
      return out;
    }
    case 'readBinary': {
      const session = getSessionOrThrow(p.sessionId);
      const maxBytes = normalizeReadSize(p.maxBytes);
      const out = await queueSession(session, async () => {
        const data = addon.read(session.handle, maxBytes);
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        return { dataBase64: buf.toString('base64'), byteLength: buf.length };
      });
      return out;
    }
    default:
      throw Object.assign(new Error(`Unknown method: ${method}`), { code: 'METHOD_NOT_FOUND' });
  }
}

async function shutdown() {
  const ids = [...sessions.keys()];
  for (const id of ids) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await closeSession(id);
    } catch (_) {
      // best effort
    }
  }

  if (addon && rmHandle) {
    try {
      addon.close(rmHandle);
    } catch (_) {
      // ignore
    }
  }
}

async function boot() {
  try {
    addon = resolveAddonModule();
  } catch (err) {
    const e = toRpcError(err, 'ADDON_LOAD_FAILED');
    e.fix = 'Build and ship visa-addon.node, and ensure VISA_ADDON_PATH points to it.';
    emitBootError(e);
    process.exitCode = 1;
    return;
  }

  try {
    const addonHealth = (typeof addon.health === 'function') ? addon.health() : {};
    bootInfo = {
      ...bootInfo,
      ...addonHealth,
    };

    rmHandle = addon.init();
    bootInfo.resourceManager = true;
    bootInfo.visaLoaded = true;

    const resources = listResourcesSafe();
    bootInfo.resourcesSample = resources.slice(0, 64);
    bootInfo.gpibDetected = detectGpib(resources);

    emit({
      type: 'BOOT_OK',
      ok: true,
      result: healthPayload(),
    });
  } catch (err) {
    const e = toRpcError(err, 'NI_VISA_NOT_FOUND');
    if (!e.fix) {
      e.fix = 'Install NI-VISA (and NI-488.2 for GPIB), then restart the app.';
    }
    emitBootError(e);
    process.exitCode = 1;
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on('line', async (line) => {
    const raw = String(line || '').trim();
    if (!raw) return;

    let req;
    try {
      req = JSON.parse(raw);
    } catch (err) {
      emit({
        id: null,
        ok: false,
        error: makeError('BAD_JSON', `Invalid JSON: ${err.message || err}`),
      });
      return;
    }

    const id = Object.prototype.hasOwnProperty.call(req, 'id') ? req.id : null;
    const method = String(req.method || '').trim();

    if (!method) {
      emit({
        id,
        ok: false,
        error: makeError('INVALID_ARGUMENT', 'method is required'),
      });
      return;
    }

    try {
      const result = await handleMethod(method, req.params || {});
      emit({ id, ok: true, result });
    } catch (err) {
      emit({
        id,
        ok: false,
        error: toRpcError(err),
      });
    }
  });

  rl.on('close', async () => {
    await shutdown();
    process.exit(0);
  });
}

process.on('SIGTERM', async () => {
  logLine('SIGTERM received');
  await shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logLine('SIGINT received');
  await shutdown();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  emit({
    type: 'SERVICE_FATAL',
    ok: false,
    error: toRpcError(err, 'SERVICE_FATAL'),
  });
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  emit({
    type: 'SERVICE_FATAL',
    ok: false,
    error: toRpcError(err, 'SERVICE_FATAL'),
  });
  process.exit(1);
});

boot();

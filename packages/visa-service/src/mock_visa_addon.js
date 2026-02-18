'use strict';

let nextHandle = 100;
const sessions = new Map();

function health() {
  return {
    visaLoaded: true,
    platform: process.platform,
    reason: 'mock',
    resourceManager: true,
    checkedPaths: [],
    loadedPath: '<mock>'
  };
}

function init() {
  return 1;
}

function listResources() {
  return ['GPIB0::10::INSTR'];
}

function open(_rm, resource) {
  const h = nextHandle++;
  sessions.set(h, {
    resource: String(resource),
    timeoutMs: 2000,
    lastCommand: ''
  });
  return h;
}

function setTimeout(handle, ms) {
  const s = sessions.get(handle);
  if (!s) {
    const err = new Error('Invalid session');
    err.code = 'VI_ERROR_INV_OBJECT';
    throw err;
  }
  s.timeoutMs = Number(ms);
}

function setTermChar() {
  // no-op in mock
}

function write(handle, data) {
  const s = sessions.get(handle);
  if (!s) {
    const err = new Error('Invalid session');
    err.code = 'VI_ERROR_INV_OBJECT';
    throw err;
  }
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  s.lastCommand = text;
  return Buffer.byteLength(text);
}

function read(handle) {
  const s = sessions.get(handle);
  if (!s) {
    const err = new Error('Invalid session');
    err.code = 'VI_ERROR_INV_OBJECT';
    throw err;
  }
  if (s.lastCommand.trim().toUpperCase() === '*IDN?') {
    return Buffer.from('MOCK,COREDAQ,0,1.0\n', 'utf8');
  }
  return Buffer.from('OK\n', 'utf8');
}

function close(handle) {
  sessions.delete(handle);
}

function statusDesc(_handle, status) {
  return `MOCK_STATUS_${status}`;
}

module.exports = {
  health,
  init,
  listResources,
  open,
  setTimeout,
  setTermChar,
  write,
  read,
  close,
  statusDesc,
};

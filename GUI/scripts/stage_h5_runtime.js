#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GUI_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(GUI_ROOT, '..');
const STAGE_ROOT = path.join(GUI_ROOT, 'build-resources', 'python-runtime', 'win64');

function rmIfExists(target) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
}

function mkdirp(target) {
  fs.mkdirSync(target, { recursive: true });
}

function copyIfExists(src, dst) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.cpSync(src, dst, { recursive: true, force: true });
  } else {
    mkdirp(path.dirname(dst));
    fs.copyFileSync(src, dst);
  }
}

function resolvePythonInfo() {
  const candidates = [];
  if (process.env.COREDAQ_H5_PYTHON) {
    candidates.push({ exe: process.env.COREDAQ_H5_PYTHON, args: [] });
  }
  if (process.platform === 'win32') {
    candidates.push({ exe: 'python', args: [] });
    candidates.push({ exe: 'py', args: ['-3'] });
  } else {
    candidates.push({ exe: 'python3', args: [] });
    candidates.push({ exe: 'python', args: [] });
  }

  const probe = [
    'import json, os, site, sys',
    'import h5py, numpy',
    'print(json.dumps({"executable": sys.executable, "base_prefix": getattr(sys, "base_prefix", sys.prefix), "prefix": sys.prefix, "user_site": site.getusersitepackages(), "h5py_file": h5py.__file__, "numpy_file": numpy.__file__}))',
  ].join('; ');

  const errors = [];
  for (const candidate of candidates) {
    try {
      const out = execFileSync(candidate.exe, [...candidate.args, '-c', probe], {
        encoding: 'utf8',
        windowsHide: true,
      });
      const info = JSON.parse(String(out || '').trim());
      return {
        command: candidate.exe,
        commandArgs: candidate.args,
        ...info,
      };
    } catch (err) {
      errors.push(`${candidate.exe} ${candidate.args.join(' ')} :: ${String(err.message || err)}`);
    }
  }
  throw new Error(
    `Unable to locate a Python runtime with h5py and numpy for H5 export staging.\n${errors.join('\n')}`,
  );
}

function stageRuntime(info) {
  rmIfExists(STAGE_ROOT);
  mkdirp(STAGE_ROOT);

  const base = path.resolve(info.base_prefix);
  const files = [
    'python.exe',
    'python3.dll',
    'python314.dll',
    'vcruntime140.dll',
    'vcruntime140_1.dll',
  ];
  for (const file of files) {
    copyIfExists(path.join(base, file), path.join(STAGE_ROOT, file));
  }
  copyIfExists(path.join(base, 'DLLs'), path.join(STAGE_ROOT, 'DLLs'));
  copyIfExists(path.join(base, 'Lib'), path.join(STAGE_ROOT, 'Lib'));

  const sitePackages = path.join(STAGE_ROOT, 'Lib', 'site-packages');
  mkdirp(sitePackages);

  const userSite = path.resolve(info.user_site);
  const pkgNames = ['h5py', 'h5py.libs', 'numpy', 'numpy.libs'];
  for (const name of pkgNames) {
    copyIfExists(path.join(userSite, name), path.join(sitePackages, name));
  }

  const meta = {
    built_at_utc: new Date().toISOString(),
    source_python: info.executable,
    source_base_prefix: base,
    source_user_site: userSite,
    source_h5py: info.h5py_file,
    source_numpy: info.numpy_file,
  };
  fs.writeFileSync(
    path.join(STAGE_ROOT, 'coreconsole_h5_runtime.json'),
    JSON.stringify(meta, null, 2),
    'utf8',
  );
}

function validateRuntime() {
  const stagedPython = path.join(STAGE_ROOT, 'python.exe');
  const env = {
    ...process.env,
    PYTHONHOME: STAGE_ROOT,
    PYTHONNOUSERSITE: '1',
  };
  const code = [
    'import h5py, numpy',
    'print("coreconsole_h5_runtime_ok")',
  ].join('; ');
  const out = execFileSync(stagedPython, ['-c', code], {
    encoding: 'utf8',
    windowsHide: true,
    env,
  });
  if (!String(out || '').includes('coreconsole_h5_runtime_ok')) {
    throw new Error('Bundled Python runtime validation failed.');
  }
}

function main() {
  const info = resolvePythonInfo();
  stageRuntime(info);
  validateRuntime();
  const size = fs.existsSync(STAGE_ROOT)
    ? fs.readdirSync(STAGE_ROOT).length
    : 0;
  console.log(`[coreConsole] staged bundled H5 runtime at ${STAGE_ROOT} (${size} top-level items)`);
}

main();

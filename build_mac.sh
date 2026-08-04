#!/usr/bin/env bash
# ============================================================================
# coreConsole mac build — renderer + Python backend (PyInstaller) + dmg/zip
#
# Usage:   ./build_mac.sh
# Output:  GUI/release/coreConsole-<version>-arm64.dmg  (+ .zip)
#
# Prereqs: node 20+, npm 10+, python3 3.10+ on PATH.
# The Python backend is bundled as a self-contained PyInstaller binary, so the
# target machine needs NO Python install.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

PY=python3
command -v node >/dev/null || { echo "ERROR: node not found"; exit 1; }
command -v $PY  >/dev/null || { echo "ERROR: python3 not found"; exit 1; }
echo "node $(node --version) | npm $(npm --version) | $($PY --version)"

# ----- 1. Python deps + PyInstaller --------------------------------------
echo "==> Installing Python backend dependencies"
$PY -m pip install --quiet -r GUI/backend/requirements.txt
$PY -m pip install --quiet pyinstaller

# ----- 2. Node deps -------------------------------------------------------
if [ ! -d GUI/node_modules ]; then
  echo "==> Installing GUI node modules"
  npm --prefix GUI ci || npm --prefix GUI install
fi

# ----- 3. Backend binary (PyInstaller onedir) -----------------------------
# --paths: resolve the py_coreDAQ package location explicitly. Required when
# py_coreDAQ is a pip *editable* install (PEP 660 finder hooks are invisible
# to PyInstaller's analyzer); harmless for a normal install.
echo "==> Building backend binary (PyInstaller)"
PYD="$($PY -c 'import py_coreDAQ, os; print(os.path.dirname(os.path.dirname(py_coreDAQ.__file__)))')"
# --exclude-module: keep GUI/plotting stacks out of the frozen backend. They
# are never imported by the service, but h5py/numpy dependency scans can chase
# into globally-installed Qt/matplotlib and abort the build (multiple Qt
# bindings) or bloat it.
( cd GUI/backend && $PY -m PyInstaller --noconfirm --clean --onedir \
    --name coredaq-backend \
    --paths "$PYD" \
    --collect-submodules py_coreDAQ \
    --exclude-module PyQt5 --exclude-module PyQt6 \
    --exclude-module PySide2 --exclude-module PySide6 \
    --exclude-module matplotlib --exclude-module IPython \
    --exclude-module pandas --exclude-module scipy --exclude-module tkinter \
    --distpath dist \
    --workpath "${TMPDIR:-/tmp}/coredaq-pyi-build" \
    --specpath "${TMPDIR:-/tmp}/coredaq-pyi-build" \
    coredaq_service.py )

# ----- 4. Smoke-test the binary -------------------------------------------
echo "==> Smoke-testing backend binary (simulator on :8899)"
GUI/backend/dist/coredaq-backend/coredaq-backend --simulator --ws-port 8899 &
BPID=$!
OK=0
for _ in $(seq 1 30); do
  sleep 1
  if lsof -nP -i :8899 -sTCP:LISTEN >/dev/null 2>&1; then OK=1; break; fi
done
kill $BPID 2>/dev/null || true
wait $BPID 2>/dev/null || true
[ "$OK" = "1" ] || { echo "ERROR: backend binary failed to start"; exit 1; }
echo "    backend binary OK"

# ----- 5. Renderer + electron-builder -------------------------------------
echo "==> Building renderer"
npm --prefix GUI run build:renderer

echo "==> Packaging (electron-builder, unsigned)"
( cd GUI && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac )

echo ""
echo "Done. Artifacts:"
ls -lh GUI/release/*.dmg GUI/release/*-mac.zip 2>/dev/null

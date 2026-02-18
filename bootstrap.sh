#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

echo "[coreConsole] bootstrap start"

if ! command -v node >/dev/null 2>&1; then
  echo "[coreConsole] error: node is not installed"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[coreConsole] error: npm is not installed"
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "[coreConsole] error: Node 20+ required (found $(node -v))"
  exit 1
fi

echo "[coreConsole] using node $(node -v), npm $(npm -v)"

echo "[coreConsole] install root deps"
npm install

echo "[coreConsole] install GUI deps"
npm --prefix GUI install

echo "[coreConsole] install visa-addon deps"
npm --prefix packages/visa-addon install

echo "[coreConsole] install visa-service deps"
npm --prefix packages/visa-service install

echo "[coreConsole] build visa-addon"
npm --prefix packages/visa-addon run build

echo "[coreConsole] check visa-service"
npm run visa:service:check

echo "[coreConsole] build GUI renderer"
npm run build

cat <<'EOF'
[coreConsole] bootstrap complete
Next:
  npm run dev
EOF

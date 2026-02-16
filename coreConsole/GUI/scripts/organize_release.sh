#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="${ROOT_DIR}/release"
DIST_DIR="${RELEASE_DIR}/distributions"
WIN_DIR="${DIST_DIR}/windows-x64"
MAC_DIR="${DIST_DIR}/macos-arm64"

mkdir -p "${RELEASE_DIR}"
rm -rf "${DIST_DIR}"
mkdir -p "${WIN_DIR}" "${MAC_DIR}"

copy_if_exists() {
  local src="$1"
  local dst="$2"
  if [[ -e "${src}" ]]; then
    cp -a "${src}" "${dst}"
  fi
}

# Windows artifacts (support both legacy coreDAQ and current coreConsole names)
copy_if_exists "${RELEASE_DIR}/coreConsole Setup 0.1.0.exe" "${WIN_DIR}/"
copy_if_exists "${RELEASE_DIR}/coreConsole Setup 0.1.0.exe.blockmap" "${WIN_DIR}/"
copy_if_exists "${RELEASE_DIR}/coreConsole-0.1.0-win.zip" "${WIN_DIR}/"
copy_if_exists "${RELEASE_DIR}/coreDAQ Setup 0.1.0.exe" "${WIN_DIR}/"
copy_if_exists "${RELEASE_DIR}/coreDAQ Setup 0.1.0.exe.blockmap" "${WIN_DIR}/"
copy_if_exists "${RELEASE_DIR}/coreDAQ-0.1.0-win.zip" "${WIN_DIR}/"
copy_if_exists "${RELEASE_DIR}/win-unpacked" "${WIN_DIR}/"

# macOS artifacts (support both legacy coreDAQ and current coreConsole names)
copy_if_exists "${RELEASE_DIR}/coreConsole-0.1.0-arm64.dmg" "${MAC_DIR}/"
copy_if_exists "${RELEASE_DIR}/coreConsole-0.1.0-arm64.dmg.blockmap" "${MAC_DIR}/"
copy_if_exists "${RELEASE_DIR}/coreConsole-0.1.0-arm64-mac.zip" "${MAC_DIR}/"
copy_if_exists "${RELEASE_DIR}/coreConsole-0.1.0-arm64-mac.zip.blockmap" "${MAC_DIR}/"
copy_if_exists "${RELEASE_DIR}/coreDAQ-0.1.0-arm64.dmg" "${MAC_DIR}/"
copy_if_exists "${RELEASE_DIR}/coreDAQ-0.1.0-arm64.dmg.blockmap" "${MAC_DIR}/"
copy_if_exists "${RELEASE_DIR}/coreDAQ-0.1.0-arm64-mac.zip" "${MAC_DIR}/"
copy_if_exists "${RELEASE_DIR}/coreDAQ-0.1.0-arm64-mac.zip.blockmap" "${MAC_DIR}/"
copy_if_exists "${RELEASE_DIR}/mac-arm64" "${MAC_DIR}/"

(cd "${WIN_DIR}" && { shasum -a 256 coreConsole* coreDAQ* 2>/dev/null || true; } > SHA256SUMS.txt)
(cd "${MAC_DIR}" && { shasum -a 256 coreConsole* coreDAQ* 2>/dev/null || true; } > SHA256SUMS.txt)

cat > "${DIST_DIR}/README.txt" << 'EOF'
coreConsole Release Layout

windows-x64/
- coreConsole Setup 0.1.0.exe     (Windows installer)
- coreConsole-0.1.0-win.zip       (portable zip)
- win-unpacked/                   (portable unpacked app)
- SHA256SUMS.txt                  (checksums)

macos-arm64/
- coreConsole-0.1.0-arm64.dmg     (macOS installer image)
- coreConsole-0.1.0-arm64-mac.zip (portable zip)
- mac-arm64/                      (unpacked app bundle)
- SHA256SUMS.txt                  (checksums)

Notes:
- macOS package includes backend binary: resources/backend/coredaq_service
- Windows package expects resources/backend/coredaq_service.exe
- If Windows backend executable is missing, package GUI launches but hardware backend cannot start.
EOF

echo "Organized release artifacts in: ${DIST_DIR}"

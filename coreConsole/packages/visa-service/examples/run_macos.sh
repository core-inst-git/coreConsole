#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

RESOURCE=""
COMMAND="*IDN?"
TIMEOUT_MS="3000"
LIST_ONLY="0"
MOCK="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource)
      RESOURCE="$2"
      shift 2
      ;;
    --command)
      COMMAND="$2"
      shift 2
      ;;
    --timeout-ms)
      TIMEOUT_MS="$2"
      shift 2
      ;;
    --list-only)
      LIST_ONLY="1"
      shift
      ;;
    --mock)
      MOCK="1"
      shift
      ;;
    *)
      echo "Unknown arg: $1"
      exit 2
      ;;
  esac
done

if [[ ! -d "packages/visa-service/node_modules" ]]; then
  npm --prefix packages/visa-service install
fi

ARGS=("packages/visa-service/examples/visa_smoke.js" "--command" "$COMMAND" "--timeout-ms" "$TIMEOUT_MS")
if [[ -n "$RESOURCE" ]]; then
  ARGS+=("--resource" "$RESOURCE")
fi
if [[ "$LIST_ONLY" == "1" ]]; then
  ARGS+=("--list-only")
fi
if [[ "$MOCK" == "1" ]]; then
  ARGS+=("--mock")
fi

echo "Running VISA smoke test..."
node "${ARGS[@]}"

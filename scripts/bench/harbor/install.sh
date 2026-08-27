#!/usr/bin/env bash
# Harbor installed-agent adapter — install script (B0, plan §9.5).
# Installs the August harness into $INSTALL_DIR (default /opt/august).
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/august}"
REPO_DIR="${AUGUST_REPO_DIR:-$(cd "$(dirname "$0")/../../.." && pwd)}"

echo "[august-bench/harbor] installing into $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
cp -r "$REPO_DIR/backend-py" "$INSTALL_DIR/backend-py"

cd "$INSTALL_DIR/backend-py"
if command -v uv >/dev/null 2>&1; then
  uv sync --frozen
else
  python3 -m venv .venv
  ./.venv/bin/pip install -e .
fi

echo "[august-bench/harbor] installed. Run tasks via run.sh."

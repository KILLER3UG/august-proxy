#!/usr/bin/env bash
# install.sh — August Proxy desktop backend setup (macOS / Linux)
#
# One-shot setup: create backend-py/.venv with Python >= 3.12 and install
# the backend as an editable package. Run once after cloning, before
# `npm run dev:desktop`.
#
#   ./install.sh
#
# Idempotent: skips venv creation if a valid .venv already exists.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$REPO_ROOT/backend-py"
VENV_DIR="$BACKEND_DIR/.venv"
VENV_PY="$VENV_DIR/bin/python"
PIP_EXE="$VENV_DIR/bin/pip"

# --- Find Python >= 3.12 -----------------------------------------------
# Prefer uv (honours backend-py/.python-version), then PATH python3/python.
is_py_312_plus() {
  local cmd="$1"
  "$cmd" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)' 2>/dev/null
}

find_python() {
  if command -v uv >/dev/null 2>&1; then
    local uv_py
    uv_py="$(uv python find 3.12 2>/dev/null || true)"
    if [ -n "${uv_py:-}" ] && [ -x "$uv_py" ] && is_py_312_plus "$uv_py"; then
      echo "$uv_py"
      return 0
    fi
  fi
  local candidates=("python3.14" "python3.13" "python3.12" "python3" "python")
  for cmd in "${candidates[@]}"; do
    if command -v "$cmd" >/dev/null 2>&1 && is_py_312_plus "$cmd"; then
      echo "$cmd"
      return 0
    fi
  done
  return 1
}

if [ ! -d "$BACKEND_DIR" ]; then
  echo "ERROR: backend-py directory not found at $BACKEND_DIR. Clone the repo first." >&2
  exit 1
fi

PYCMD="$(find_python)" || {
  echo "ERROR: Python >= 3.12 is required but not found." >&2
  echo "       Install it (https://www.python.org/downloads/) or: uv python install 3.12" >&2
  exit 1
}
echo "Using $PYCMD ($($PYCMD --version 2>&1))"

# --- Create venv if missing, invalid, or older than 3.12 --------------
NEED_VENV=1
if [ -x "$VENV_PY" ]; then
  if is_py_312_plus "$VENV_PY" && "$VENV_PY" -c "import fastapi" >/dev/null 2>&1; then
    NEED_VENV=0
  elif ! is_py_312_plus "$VENV_PY"; then
    echo "WARNING: existing venv is not Python >= 3.12; recreating." >&2
    rm -rf "$VENV_DIR"
  fi
fi

if [ "$NEED_VENV" -eq 1 ]; then
  echo "Creating virtual environment at $VENV_DIR ..."
  "$PYCMD" -m venv "$VENV_DIR" || { echo "ERROR: failed to create venv." >&2; exit 1; }
  if ! is_py_312_plus "$VENV_PY"; then
    echo "ERROR: venv Python is still < 3.12. Install 3.12+ and re-run." >&2
    exit 1
  fi
else
  echo "Reusing existing venv at $VENV_DIR"
fi

# --- Install deps (uv if present, else pip) -------------------------
if command -v uv >/dev/null 2>&1; then
  if [ -f "$BACKEND_DIR/uv.lock" ]; then
    uv sync --project "$BACKEND_DIR"
  else
    uv pip install -e "$BACKEND_DIR"
  fi
else
  "$PIP_EXE" install -e "$BACKEND_DIR" || { echo "ERROR: pip install failed." >&2; exit 1; }
fi

# --- Version stamp (dev parity) --------------------------------------
if [ -f "$REPO_ROOT/package.json" ]; then
  VER="$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' "$REPO_ROOT/package.json" | head -1 | sed -E 's/.*"([^"]+)".*/\1/')"
  mkdir -p "$REPO_ROOT/data"
  printf '%s' "$VER" > "$REPO_ROOT/data/backend-version.txt"
fi

echo ""
echo "✅ Backend ready."
echo "Next steps:"
echo "  npm install"
echo "  npm run dev:desktop"

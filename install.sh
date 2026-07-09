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
find_python() {
  local candidates=("python3" "python")
  for cmd in "${candidates[@]}"; do
    if command -v "$cmd" >/dev/null 2>&1; then
      if "$cmd" --version 2>&1 | grep -qE 'Python 3\.(1[2-9]|[2-9][0-9])|Python [4-9]'; then
        echo "$cmd"
        return 0
      fi
    fi
  done
  return 1
}

if [ ! -d "$BACKEND_DIR" ]; then
  echo "ERROR: backend-py directory not found at $BACKEND_DIR. Clone the repo first." >&2
  exit 1
fi

PYCMD="$(find_python)" || {
  echo "ERROR: Python >= 3.12 is required but not found on PATH." >&2
  echo "       Install it (https://www.python.org/downloads/) and retry." >&2
  exit 1
}
echo "Using $PYCMD ($($PYCMD --version 2>&1))"

# --- Create venv if missing or invalid --------------------------------
NEED_VENV=1
if [ -x "$VENV_PY" ]; then
  if "$VENV_PY" -c "import fastapi" >/dev/null 2>&1; then
    NEED_VENV=0
  fi
fi

if [ "$NEED_VENV" -eq 1 ]; then
  echo "Creating virtual environment at $VENV_DIR ..."
  "$PYCMD" -m venv "$VENV_DIR" || { echo "ERROR: failed to create venv." >&2; exit 1; }
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

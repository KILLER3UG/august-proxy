#!/usr/bin/env bash
# Pier air-gapped adapter — install script (B0, plan §9.5).
#
# Air-gapped contract: the environment provides NO network unless a host is
# on the allowlist. The allowlist is honored AT SANDBOX SETUP:
#   * empty allowlist  → sandbox network axis stays DENIED (default);
#   * non-empty        → the allowlist is written to the environment marker
#                        file and passed to august-bench, which enables the
#                        sandbox network axis and records the list in the
#                        trajectory for audit.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/august}"
REPO_DIR="${AUGUST_REPO_DIR:-$(cd "$(dirname "$0")/../../.." && pwd)}"
ALLOWLIST_FILE="${PIER_ALLOWLIST_FILE:-$INSTALL_DIR/network-allowlist.txt}"

echo "[august-bench/pier] installing into $INSTALL_DIR (air-gapped)"
mkdir -p "$INSTALL_DIR"
cp -r "$REPO_DIR/backend-py" "$INSTALL_DIR/backend-py"

cd "$INSTALL_DIR/backend-py"
if command -v uv >/dev/null 2>&1; then
  # Offline-safe: dependencies must already be in the local wheel cache.
  uv sync --frozen ${PIER_WHEEL_CACHE:+--find-links "$PIER_WHEEL_CACHE"}
else
  python3 -m venv .venv
  ./.venv/bin/pip install --no-index ${PIER_WHEEL_CACHE:+--find-links "$PIER_WHEEL_CACHE"} -e .
fi

# Materialize the allowlist (one host per line; '#' comments allowed).
if [[ ! -f "$ALLOWLIST_FILE" ]]; then
  cat > "$ALLOWLIST_FILE" <<'EOF'
# Pier network allowlist — one host per line.
# Empty file = network fully denied at the sandbox layer.
EOF
  echo "[august-bench/pier] created empty allowlist at $ALLOWLIST_FILE (network denied)"
else
  echo "[august-bench/pier] using existing allowlist at $ALLOWLIST_FILE"
fi

echo "[august-bench/pier] installed."

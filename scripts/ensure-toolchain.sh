#!/usr/bin/env bash
set -euo pipefail
echo "[toolchain] checking uv, pnpm, ripgrep, fd, jq"
for bin in uv pnpm rg fd jq; do
  if command -v "$bin" >/dev/null 2>&1; then
    echo "  $bin: $($bin --version 2>&1 | head -n1)"
  else
    echo "  $bin: MISSING"
  fi
done
echo "[toolchain] node: $(node --version 2>&1 || echo missing) / npm: $(npm --version 2>&1 || echo missing)"
echo "[toolchain] python: $(python --version 2>&1 || python3 --version 2>&1 || echo missing)"
# Pre-install check only; Dockerfile installs rg/fd-find/jq/pnpm. This script is for host visibility.

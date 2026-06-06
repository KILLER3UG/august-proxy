#!/usr/bin/env bash
# scripts/sync-ui.sh — populate apps/desktop/ui/ from the proxy's built SPA.
#
# Usage:  bash scripts/sync-ui.sh          # copy
#         bash scripts/sync-ui.sh link     # symlink (faster, dev only)
#
# The Tauri webview serves from `../ui` relative to the main crate (per
# tauri.conf.json → build.frontendDist). This script keeps that directory
# in sync with the latest build artifact.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
UI_DIR="$DESKTOP_DIR/ui"
PROXY_WEB_DIST="$DESKTOP_DIR/../web-dist"

if [ ! -d "$PROXY_WEB_DIST" ]; then
  echo "[sync-ui] ERROR: $PROXY_WEB_DIST does not exist."
  echo "[sync-ui] Build the SPA first:  npm run build:web"
  exit 1
fi

MODE="${1:-copy}"

if [ "$MODE" = "link" ]; then
  rm -rf "$UI_DIR"
  ln -s "$PROXY_WEB_DIST" "$UI_DIR"
  echo "[sync-ui] symlinked $UI_DIR -> $PROXY_WEB_DIST"
else
  rm -rf "$UI_DIR"
  mkdir -p "$UI_DIR"
  cp -R "$PROXY_WEB_DIST/." "$UI_DIR/"
  echo "[sync-ui] copied $PROXY_WEB_DIST -> $UI_DIR"
fi

echo "[sync-ui] done. contents:"
ls -la "$UI_DIR"

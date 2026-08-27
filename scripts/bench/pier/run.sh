#!/usr/bin/env bash
# Pier air-gapped adapter — run command (B0, plan §9.5).
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/august}"
ALLOWLIST_FILE="${PIER_ALLOWLIST_FILE:-$INSTALL_DIR/network-allowlist.txt}"
RESULTS_DIR="${PIER_RESULTS_DIR:-./results}"
RUN_ID="pier_$(date +%Y%m%d)_$RANDOM"
export RUN_ID
mkdir -p "$RESULTS_DIR"

if [[ -z "${PIER_TASK_PROMPT:-}" ]]; then
  echo "PIER_TASK_PROMPT is required" >&2
  exit 42
fi

# Honor the allowlist at setup: strip comments/blanks → comma-separated list.
ALLOWLIST=""
if [[ -f "$ALLOWLIST_FILE" ]]; then
  ALLOWLIST="$(grep -Ev '^\s*(#|$)' "$ALLOWLIST_FILE" | paste -sd, -)"
fi

cd "$INSTALL_DIR/backend-py"
PYTHON_BIN="${PYTHON_BIN:-uv run python}"

set +e
$PYTHON_BIN -m app.bench \
  --task "$PIER_TASK_PROMPT" \
  --workspace "${PIER_WORKSPACE:-$PWD}" \
  ${PIER_MODEL:+--model "$PIER_MODEL"} \
  ${PIER_PROVIDER:+--provider "$PIER_PROVIDER"} \
  --max-turns "${PIER_MAX_TURNS:-50}" \
  --max-duration-s "${PIER_TIMEOUT_S:-1800}" \
  ${ALLOWLIST:+--network-allowlist "$ALLOWLIST"} \
  ${PIER_OUTPUT_SCHEMA:+--output-schema "$PIER_OUTPUT_SCHEMA"} \
  --events "$RESULTS_DIR/$RUN_ID.events.jsonl" \
  --trajectory "$RESULTS_DIR/$RUN_ID.trajectory.json" \
  --run-id "$RUN_ID"
EXIT_CODE=$?
set -e
exit $EXIT_CODE

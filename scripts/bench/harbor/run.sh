#!/usr/bin/env bash
# Harbor installed-agent adapter — run command (B0, plan §9.5).
#
# Harbor contract (env → august-bench flags):
#   HARBOR_TASK_PROMPT   → --task            (required)
#   HARBOR_WORKSPACE     → --workspace       (the task checkout)
#   HARBOR_MODEL         → --model           (optional)
#   HARBOR_PROVIDER      → --provider        (optional)
#   HARBOR_MAX_TURNS     → --max-turns       (default 50)
#   HARBOR_TIMEOUT_S     → --max-duration-s  (default 1800)
#   HARBOR_OUTPUT_SCHEMA → --output-schema   (optional)
#
# Session export: the JSONL event stream + trajectory.json are written into
# $HARBOR_RESULTS_DIR (default ./results) for the board to collect.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/august}"
RESULTS_DIR="${HARBOR_RESULTS_DIR:-./results}"
RUN_ID="harbor_$(date +%Y%m%d)_$RANDOM"
export RUN_ID
mkdir -p "$RESULTS_DIR"

if [[ -z "${HARBOR_TASK_PROMPT:-}" ]]; then
  echo "HARBOR_TASK_PROMPT is required" >&2
  exit 42
fi

cd "$INSTALL_DIR/backend-py"
PYTHON_BIN="${PYTHON_BIN:-uv run python}"

# The bench exit code is the contract — capture it instead of dying on it.
set +e
$PYTHON_BIN -m app.bench \
  --task "$HARBOR_TASK_PROMPT" \
  --workspace "${HARBOR_WORKSPACE:-$PWD}" \
  ${HARBOR_MODEL:+--model "$HARBOR_MODEL"} \
  ${HARBOR_PROVIDER:+--provider "$HARBOR_PROVIDER"} \
  --max-turns "${HARBOR_MAX_TURNS:-50}" \
  --max-duration-s "${HARBOR_TIMEOUT_S:-1800}" \
  ${HARBOR_OUTPUT_SCHEMA:+--output-schema "$HARBOR_OUTPUT_SCHEMA"} \
  --events "$RESULTS_DIR/$RUN_ID.events.jsonl" \
  --trajectory "$RESULTS_DIR/$RUN_ID.trajectory.json" \
  --run-id "$RUN_ID"
EXIT_CODE=$?
set -e

# Session export: copy the workbench session blob next to the trajectory.
$PYTHON_BIN - <<'EOF' || true
import json, os, sys
from pathlib import Path
results = Path(os.environ.get("HARBOR_RESULTS_DIR", "./results"))
run_id = os.environ.get("RUN_ID", "")
try:
    from app.services.workbench.sessions import get_workbench_session, list_workbench_sessions
    sessions = sorted(list_workbench_sessions(), key=lambda s: s.get("updatedAt", ""), reverse=True)
    if sessions:
        (results / f"{run_id}.session.json").write_text(
            json.dumps(sessions[0], indent=2, ensure_ascii=False, default=str), encoding="utf-8"
        )
except Exception as exc:
    print(f"session export skipped: {exc}", file=sys.stderr)
EOF

exit $EXIT_CODE

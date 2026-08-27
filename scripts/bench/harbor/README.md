# Harbor installed-agent adapter (B0)

Adapter shape for entering August into a Harbor-style installed-agent board
(plan §9.5 B0). The contestant is the **full harness** — the real workbench
loop in `agent` mode, sandbox on, no neutered profile.

## Files

| File | Role |
|------|------|
| `install.sh` | Installs `backend-py` into `$INSTALL_DIR` (default `/opt/august`) and provisions the venv (uv preferred, plain venv fallback). |
| `config.template.json` | The generated config shape a board fills in: agent name/version, run/install commands, budgets, model, artifact paths, exit-code table. |
| `run.sh` | The run command: maps `HARBOR_*` env vars onto `python -m app.bench` flags, writes the JSONL event stream + `trajectory.json` into `$HARBOR_RESULTS_DIR`, then exports the workbench session blob. |

## Contract

- **Task in:** `HARBOR_TASK_PROMPT` (required; exit 42 when missing).
- **Budgets:** `HARBOR_MAX_TURNS` (→ exit 53), `HARBOR_TIMEOUT_S`.
- **Answer out:** the final assistant text; with `HARBOR_OUTPUT_SCHEMA`, it is
  validated against the JSON Schema (subset: type/required/properties/items/enum)
  and a mismatch exits 1.
- **Session export:** newest workbench session → `<runId>.session.json` next to
  the trajectory (best-effort; a failed export never fails the run).
- **Stream:** lossless typed JSONL (`run/start`, `step/tool_call`,
  `step/tool_result`, `step/assistant`, `context/pressure`, `run/end`, …) so
  board adapters never need to parse stdout prose.

## Integrity

The bench registers a PRE_TOOL_USE integrity hook: no `solution/` reads, no
test/grader modifications, no answer fetching. Attempts are denied with
feedback and recorded as reward-hack candidates in `trajectory.json`
(`integrity_violations`).

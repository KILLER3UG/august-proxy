# Pier air-gapped adapter (B0)

Adapter shape for entering August into a Pier-style air-gapped board
(plan §9.5 B0). Air-gapped means the environment provides **no network unless
a host is explicitly allowed** — the allowlist is honored at sandbox setup.

## Network contract

| Allowlist state | Effect |
|-----------------|--------|
| empty / missing file | sandbox network axis stays **denied**; network commands are blocked by the sandbox policy |
| one or more hosts | the list is passed to `august-bench --network-allowlist`, which enables the sandbox network axis and records the list in `trajectory.json → budgets.networkAllowlist` for audit; host-level filtering is enforced by the environment firewall |

The allowlist lives in `$PIER_ALLOWLIST_FILE` (default
`$INSTALL_DIR/network-allowlist.txt`), one host per line, `#` comments
allowed. `install.sh` creates it empty (deny-by-default) and installs
dependencies **offline** from a local wheel cache (`PIER_WHEEL_CACHE`).

## Files

| File | Role |
|------|------|
| `install.sh` | Offline install into `$INSTALL_DIR`; materializes the empty allowlist (deny-by-default). |
| `run.sh` | Maps `PIER_*` env vars onto `python -m app.bench`; folds the allowlist file into `--network-allowlist`; writes events + trajectory to `$PIER_RESULTS_DIR`. |

## Contract

- **Task in:** `PIER_TASK_PROMPT` (required; exit 42 when missing).
- **Budgets:** `PIER_MAX_TURNS` (→ exit 53), `PIER_TIMEOUT_S`.
- **Out:** typed JSONL event stream + ATIF-compatible `trajectory.json`;
  exit codes 0 ok / 1 error / 42 input / 53 turn-limit.
- **Integrity:** same PRE_TOOL_USE integrity hook as the Harbor adapter —
  no `solution/` reads, no test/grader modifications, no answer fetching;
  violations recorded in the trajectory.

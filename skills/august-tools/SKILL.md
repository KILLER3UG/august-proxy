---
name: august-tools
description: "Correct usage of every August tool: hash-anchored file edits, run_command rules, search, web/browser/desktop, bulk batching. Load before calling tools."
category: harness
version: 1.0.0
platforms: [linux, macos, windows]
---

# August Tools — Correct Usage

Every tool runs in the session sandbox (workspace-write by default, network
off). Use the right tool; never shell out for what a native tool does.

## Files

- `read_file` — the only way to cat/head/tail. Page big files with
  `offset`/`limit`. Results start with a `[sha256 …]` header.
- `write_file` — full overwrite; pass the sha256 from your last `read_file` as
  `fileHash` so the harness rejects the write if the file changed since.
- `edit_lines` — surgical line edits, each verified by line number + exact
  current text + `fileHash` (required). Prefer over `write_file` for small
  changes; applied bottom-up so earlier line numbers stay valid.
- `apply_patch` — unified diff for multi-hunk changes; more robust than many
  `edit_lines` entries.
- `list_directory` — dir listing with sizes; `search_files` — case-insensitive
  content search (ripgrep), path defaults to the workspace.

Rule: read before you write, echo the hash back. A rejected hash means the
file moved under you — re-read, don't retry blind.

## Shell

- `run_command` — non-interactive only: stdin is closed, no pagers/REPLs/
  password prompts. Use `--yes`/`-y`/`--non-interactive` flags.
- The exit code is ALWAYS surfaced (zero included) — treat it as your receipt.
- Network is off by default; pass `network:true` for curl/gh/pip instead of
  toggling the session. Optional `timeout_s` (default 120s, max 600s).
- On Windows prefer PowerShell/cmd semantics; common Unix head/tail/cat/ls are
  auto-translated when possible.

## Batch & parallel

- `bulk` family (`run_commands`, `read_files`, `write_files`,
  `web_fetch_many`) for repeated work in one call.
- Independent single calls: emit them in parallel in one turn.

## Web & GUI

- `web_fetch` / `web_search` for content; `browser_*` (open, click, type,
  select, scroll, wait, screenshot, get_content, evaluate) when a page needs
  real interaction.
- `desktop_*` (screenshot, click, type, press_key, list_windows, open_url,
  mouse_position, screen_size) for OS-level automation outside the browser.

## Sessions, sub-agents, skills

- `spawn_subagents` / `send_subagent_message` / `interrupt_subagent` for
  delegated parallel work; `spawn_daemon` + `list_daemons` + `kill_daemon` for
  background processes; `write_blackboard` / `read_blackboard` /
  `clear_blackboard` to share state; `list_workstreams` to see dispatched work.
- `list_skills` / `load_skills` / `load_skill` — load a skill's full guidance
  before doing the thing it covers.

## Introspection & state

- `describe_environment` / `diagnose_proxy` to learn what this runtime can do.
- `harness_introspect` — inspect your own harness (tool surface, flow map,
  budgets) before reasoning about it; `harness_propose` files structured
  improvement proposals for human review (never assume applied).
- `update_state`, `write_scratchpad`, `summarize_session`, `enter_plan_mode`,
  `submit_plan`, `set_agent_mode` — see the `august-harness` skill for the loop
  these drive.

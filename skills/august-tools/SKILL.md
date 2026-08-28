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

## What this skill is

A reference for the right way to call every August tool — file edits, shell
commands, search, web/browser/desktop, and the bulk + sub-agent families. Load
this before calling any tool so you pick the native call instead of shelling
out, and so you handle the hash-anchored write path correctly.

## When to Use

- Before any `read_file` / `write_file` / `edit_lines` / `apply_patch` —
  the hash-anchored write path is the one thing this skill prevents you
  from getting wrong.
- When you need `run_command` rules (non-interactive, exit code is the
  receipt, network off by default) or any web/browser/desktop call.
- Before reaching for the `bulk` family, sub-agents, daemons, or the
  blackboard — there is one canonical way to batch each kind of work.

## Prerequisites

- An open August session with sandbox access (workspace-write by default;
  `sandboxMode: danger-full-access` is rare and explicit).
- `harness_introspect()` available so you can confirm the current tool
  surface before relying on a specific name.

## How to Run

1. Load this skill (`load_skill "august-tools"`) at the start of a session
   or before any new tool family.
2. Pick the right tool: prefer `edit_lines` / `apply_patch` over
   `write_file`; prefer `bulk` over many single calls; prefer the
   `browser_*` family for real pages over `web_fetch`.
3. Always `read_file` first; pass the returned `sha256` back in the write.
4. Treat the `run_command` exit code as the receipt — surface it, zero too.

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

## Pitfalls

- Skipping the `read_file` → write hash check. A wrong hash means the file
  moved under you; re-read instead of retrying blind.
- Using `write_file` for a one-line change when `edit_lines` exists. Hash
  safety is the same; you just pay the full-file read cost.
- Forgetting that `run_command` stdin is closed — pass `--yes` /
  `--non-interactive` and never pipe into a REPL or pager.
- Reaching for `bash` to do something a native tool already does (the
  harness sandbox may not even allow the shell path).

## Verification

- After an edit block, the next tool result includes the new sha256 — diff
  it against the previous one to prove the change landed.
- After `run_command`, the exit code is the receipt: report it (zero
  included), not a narrative of what the command was supposed to do.
- For multi-step work, advance `update_state(phase, step)` every turn and
  finish with `phase='complete'`.

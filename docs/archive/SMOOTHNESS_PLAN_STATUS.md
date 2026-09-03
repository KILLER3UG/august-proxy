# Smoothness Plan — Implementation Status (2026-08-13)

Status ledger for the streaming-smoothness plan (A.1 cheap live markdown,
B cancel/progress reliability, C terminal/run_command liveness, D verification).
Reviewed against the tree and closed out in 0.16.2.

## A — Live markdown rendering

### A.1 Cheap live markdown — DONE (0.16.2)

`src/sections/chat/ChatMarkdown.tsx` previously ran the **full**
`convertLatexToUnicode` + `marked.parse` + whole-tree `dangerouslySetInnerHTML`
replace on every ~32ms flush. Now the live path:

- `splitLiveBlocks()` splits content at blank-line boundaries (fence-aware —
  a blank line inside ``` ``` ``` is code, not a separator).
- Every **complete** block renders exactly once into a module-level cache;
  only the still-growing **tail** block re-parses per flush.
- Each block is its own keyed `<div>`. The cache stores the ready-to-pass
  `dangerouslySetInnerHTML` **prop object** — a fresh `{__html}` object per
  render makes React re-parse a block's HTML on every flush (measured ~14×
  slower in jsdom), so caching the object is what actually lets React skip
  untouched blocks.
- The settle path (`live=false`) is untouched: one full parse, byte-identical
  to pre-A.1 output (and highlight.js colors apply only there).
- `stabilizeLiveTables` (hold back a half-received table row) still applies
  before the split.

**Measured before/after** (vitest bench `ChatMarkdown.perf.test.tsx`, growing
17,009-char stream, 120 flushes, jsdom):

| Path | Total | Per flush |
| --- | --- | --- |
| Legacy: full parse + whole-tree innerHTML replace | 1373 ms | ~11.4 ms |
| New: block-cached live render (React diff + tail-only parse) | 249 ms | ~2.1 ms |

**5.5× faster**, and the per-flush DOM work shrinks to one tail block. In a
real browser the ratio is at least as good (the parse side is
browser-independent; jsdom DOM costs are pessimistic).

## B — Cancel & progress (verified in tree, tests added 0.16.2)

| Item | Status | Regression test |
| --- | --- | --- |
| Generic tool heartbeat (Running {tool}… + 8s "Still working on {tool}…") | in tree (`workbench.py`) | `test_generic_tool_heartbeat` (eval, interval monkeypatched to 50ms) |
| run_command idle warning (stdin closed) + "Still working…" beats | in tree | `test_run_command_idle_warning` |
| Cancel orphan kill — `communicate_or_kill` / `_communicate_streaming` close the child on `CancelledError` | in tree (`async_subprocess.py`) | `test_outer_task_cancel_kills_child` |
| LLM cancel poll (both Anthropic + OpenAI streams break on `current_subprocess_cancel`) | in tree | (covered by existing stream tests) |
| DDGS isolation (subprocess + `proc.kill()` on timeout) | in tree | `test_ddgs_subprocess_killed_on_timeout` |
| `_pySearchFiles` off-loop (`asyncio.to_thread` + timeout + cancel Event) | in tree | (existing) |
| Persist debounce (1s) + flush on turn end | in tree | `session-stream-store.test.ts` (3 tests) |

Heartbeat intervals were extracted to module constants
(`_TOOL_HEARTBEAT_INTERVAL_S`, `_COMMAND_IDLE_BEAT_INTERVAL_S`,
`_COMMAND_IDLE_BEAT_MIN_GAP_S`) so tests can shrink the windows instead of
waiting real seconds.

## C — Terminal & run_command liveness

| Item | Status |
| --- | --- |
| Interactive idle warning on first 8s silence | in tree (B row above) |
| Drawer WS reconnect with exponential backoff + 4001/4004 stop | in tree (frontend) |
| QueueFull → drop oldest + visible gap marker | in tree (`terminal_service._broadcastTerminal`) |
| 32ms + rAF throttle | in tree (left as planned) |
| **Unix `stdbuf -oL -eL`** for run_command | **ADDED 0.16.2** |

### C.2 stdbuf — DONE (0.16.2)

`prefix_line_buffering()` (`app/lib/async_subprocess.py`) wraps a simple
external command with `stdbuf -oL -eL` when on Unix and stdbuf is on PATH.
Python children are already unbuffered (`PYTHONUNBUFFERED=1`); this fixes
pip/npm/C programs that block-buffer their stdout when piped ("hang-then-dump"
→ live progress lines). Conservatively skipped for:

- Windows (`os.name == 'nt'`)
- hosts without stdbuf (macOS by default)
- shell builtins / control keywords (`cd`, `export`, `for`, …)
- assignment prefixes (`VAR=x cmd`) and quoted program names
- the bwrap/seatbelt sandbox paths (stdbuf binary not guaranteed inside)

Applied in `sandbox/backends/fallback._spawn` (the common run_command path).
Unit tests: `test_prefix_line_buffering_*` (3 tests, platform shimmed).

### Drawer reconnect duplication — FIXED (0.16.2)

**Bug (real):** every WS connect replayed the whole session buffer
(`terminal_service.handleTerminalConnection`), so a reconnect duplicated the
entire history under the grey "connection lost" line.

**Fix:** the backend now tracks `streamLen` (total code points ever appended;
never shrinks when the buffer truncates at 256KB) and the client sends its
last-seen code-point offset as `?offset=N` on every connect. The backend
replays only the unseen suffix:

```python
truncated = streamLen - len(buffer)
unseen = buffer[max(0, offset - truncated):]
```

- First connect (offset 0) → full buffer (unchanged behavior).
- Reconnect → only output received since the last connect.
- Offset behind the truncation point → whole tail (missed chars are gone).
- Offset ahead of the stream → nothing.

Both sides count code points (`[...s].length` ≈ Python `len()`) so non-BMP
characters don't drift. Frontend (`RightDrawerTerminalSection`) counts
received chunks and passes the offset. Tests:
`test_resume_replays_only_unseen_output`, `test_resume_first_connect_*`,
`test_resume_after_buffer_truncation_*`, `test_resume_offset_behind_*`,
`test_resume_offset_ahead_*`, `test_append_output_tracks_stream_len_*`.

## D — Live-feel verification

- **Long stream:** automated before/after above (5.5× per-flush cost cut) +
  the `Markdown` 14-test suite asserts live/final structural parity.
- **Tool cancel:** `test_outer_task_cancel_kills_child` proves Stop's cancel
  path kills the child; the eval heartbeat tests prove progress events flow.
- **Sleep / idle:** `test_run_command_idle_warning` covers the idle warning
  path end-to-end against the real loop.
- **Drawer ping:** reconnect resume tests cover no-duplicate replay; the
  remaining GUI-only feel check (visual smoothness of a live stream in the
  packaged app) is a manual smoke: `npm run dev:desktop`, start a chat with a
  long answer, watch text paint; kill the backend port mid-stream and watch
  the drawer terminal reconnect without duplicating history.

## Known remaining (accepted)

- Chat Stop → MCP/browser: timeout/task-cancel only, no child kill.
- Chat Stop → DDGS fallback thread (non-subprocess path): not killable.
- Subagents do not auto-cancel on chat Stop.
- Agent shell is pipe-based, not a true PTY (drawer terminal has PTY).
- Deep MCP/browser phase progress is not exposed.

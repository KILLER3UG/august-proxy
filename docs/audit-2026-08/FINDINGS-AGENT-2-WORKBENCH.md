# FINDINGS — Agent 2 (workbench / tool loop)

Scope: `backend-py/app/services/workbench/`, `tool_registrations/system_tools.py`,
`tool_registrations/file_tools.py`, `tool_guardrails.py`, `tool_policy.py`,
`chat_stages.py`, `parallel_tools.py`, `validator.py`, `harness_eval.py`.

Static checks: `ruff check` ✓ clean, `mypy app/services/workbench/` ✓ no issues,
`pytest tests/test_harness_evals.py` ✓ 13/13 (with `tests/test_workbench_tool_loop.py`,
`test_verifier_gate_enforcement.py`, `test_verifier_enforced_flag.py` → 36/36 ✓).

Repro probes were run against the real harness via `app.services.harness_eval.run_turn`
(no mocks beyond the model client; real tool registry + tool loop + verifier).

---

## 1. Hash-anchored edits

### 🔴 Hash computed on re-encoded text ≠ hash of raw bytes → CRLF / invalid-UTF-8 files are uneditable

`backend-py/app/services/tool_registrations/file_tools.py:139-146`:

```python
async with aiofiles.open(str(filePath), 'r', encoding='utf-8', errors='replace') as f:
    content = await f.read()
digest = hashlib.sha256(content.encode('utf-8')).hexdigest()
```

`backend-py/app/services/workbench/workbench.py:4062-4068`:

```python
if p.is_file():
    actual = hashlib.sha256(p.read_bytes()).hexdigest()
    if actual != expected.lower():
        return 'Error: File changed since you read it ...'
```

The `read_file` tool emits a sha256 of the **decoded-and-re-encoded** content.
The hash-check in `_executeTool` hashes the **raw bytes**. These differ
any time the read path normalises something the bytes had:

- **CRLF → LF translation** (text-mode `open` does universal-newline translation).
  Verified with `aiofiles.open(..., 'r', errors='replace').read()` on a
  `b'line1\r\nline2'` file: raw-sha ≠ re-enc-sha, write_file with the
  echoed hash is rejected "File changed since you read it".
- **Invalid UTF-8 bytes** replaced by U+FFFD on read; re-encoding produces
  different bytes than raw.
- Only BOM survives the round-trip (`'\ufeffhello'` decodes and re-encodes
  to the same bytes).

Repro script (run on this worktree):

```python
p.write_bytes(b'line1\r\nline2')
async with aiofiles.open(str(p), 'r', encoding='utf-8', errors='replace') as f:
    content = await f.read()
assert hashlib.sha256(p.read_bytes()).hexdigest() != hashlib.sha256(content.encode('utf-8')).hexdigest()
```

Impact on Windows: nearly every text file written by Notepad/VSCode with
CRLF will spuriously fail every hash-anchored edit. The "hardening" feature
is effectively disabled on the dominant platform August ships for.

Fix options:
- Hash the raw bytes in `read_file` too (one extra `filePath.read_bytes()`
  read, no normalisation), so the header is a faithful "hash of bytes on
  disk at read time" both sides compare.
- Or drop the bytes-read in `_executeTool` and re-normalise the same way
  (read with `errors='replace'`, then hash the re-encoded text) — must
  match `read_file`'s exact decode path.

### 🟡 Hash check skipped silently when path is missing or unreadable

`workbench.py:4053-4070`: the entire hash verification is wrapped in
`if p.is_file():` + `try: ... except OSError: pass`. Passes silently if:
- `target` is empty (model sent no `path`/`filePath`/`file_path`/`file`).
- `p.is_file()` is False (deleted between read and write — precisely the
  corruption case the hash is supposed to catch).
- Any OSError (locked file, network share hiccup).

If the goal is "reject stale patches", silently skipping when the file
is *gone* defeats the purpose — the patch will then land on an empty file
or fail with a confusing "no such file" from the underlying tool handler.

---

## 2. Verifier gate

### 🟠 Verifier auto-run enqueues a steer that is only consumed on the NEXT user turn

`workbench.py:3577-3625` — in the turn `finally`, after the loop has already
exited and `session.status = 'idle'` was set in the preceding try block, the
auto-run fires:

```python
vresult = await _executeTool('run_command', {'command': vcmd}, session)
...
enqueueUserMessage(sessionId, steer, kind='steer')
```

The steer goes into `session.queuedUserMessages`. Nothing within this turn
drains the queue. Consumption happens at `drainQueuedMessages(sessionId, ...)`,
which only fires at the start of round ≥ 2 of a turn — so the user must
send another message before the model ever sees "verification passed, call
update_state(phase='complete')".

Observed (via `run_turn(..., verifier_enforced=True)` with the model only
setting `phase='implement'` + `verificationCommand='echo ok'` then finishing
with text):

```
events: ['started', 'contextPressure', 'toolCall', 'tool_progress', 'toolResult',
         'verifierBlocked', 'evidenceState', 'done']
final phase: {'phase': 'implement', 'verification_command': 'echo ok', ...}
finalOutput chars: 0
```

So: with verifierEnforced on, a session ending without phase='complete' will
NEVER release its answer unless the user manually revives the turn. The
auto-run's diagnostic is useful but only as feedback for the next turn.

Severity 🟠: this is "opt-in" (`verifierEnforced`) so casual chat is safe,
but the feature's intended purpose — "stop the agent skipping tests" — fails
closed and silently. A better implementation would either:

- resume the model loop in-place on auto-run (continue the `while True` with
  the steer as user input), or
- emit a distinct "completed-but-withheld" status so the UI can prompt the
  user to nudge the model.

### 🟠 Session-sticky `_verifier_auto_ran` / `_reviewer_checked` — one gate per session, ever

`workbench.py:3588` sets `session._verifier_auto_ran = True` and never resets it.
`system_tools.py:250` does the same with `_reviewer_checked`.

Repro: two consecutive user tasks in one session, both with verifierEnforced
on, both ending without complete. Only the FIRST task triggers the auto-run
and only the FIRST task pays the reviewer critique. Subsequent tasks bypass
the rail silently.

Fix: clear these flags at the start of each turn (next to
`session._verification_receipts = None` at `workbench.py:601`).

### 🟡 `_normalizeCommand` is too naive — trivially bypassable

`system_tools.py:158-160` — only `lower().split()` whitespace normalisation.

The declared `verificationCommand='pytest tests'`-match succeeds against:

- `pytest  tests` (extra space) — yes, normalized.
- `PYTEST TESTS` — yes, lowercased.
- `python -m pytest tests` — **no** (different tokens).
- `cd app && pytest tests` — **no**.
- `pwsh -c pytest tests` — **no**.

So a model that wants to satisfy the gate with a different-but-equivalent
command is denied (`expected_command` filter rejects it), while a model
that wants to *evade* the gate just runs the declared `echo`-equivalent
shell builtin: `pytest tests; echo done` produces a clean exit-0 receipt
whose normalized command does not match `'pytest tests'` — and the gate
stays open.

Realistically the gap that matters is the *failure to match equivalent-but-
not-character-identical* commands — agents often refactor the verification
line (e.g. add `cd`), and the gate refuses them even though the verification
actually ran.

### 🟡 Reviewer critique: failure-closed-OPEN (allow on any exception)

`system_tools.py:295-296`:

```python
except Exception:
    return (True, '')
```

Any error in building the reviewer client (provider offline, no key, model
typo) silently allows the completion. Combined with `_reviewer_checked` being
sticky, a single provider hiccup permanently disables the reviewer for the
session.

### 🟢 Verifier gate honor-system limit: marker scan falls for tool output that *contains* '0 failed'

`_STRONG_PASS_MARKERS = ('0 failed', ...)` — a `run_command` whose stdout
merely contains the substring `'0 failed'` (e.g. a tool that prints raw
test logs from a different runner, or `echo "0 failed"` itself) is treated
as a passing verification. Cheap fix: require the marker to appear in
*stderr-empty + exit-0* context and reject on `'error:' / 'Traceback'`
substrings first (the current code does have `_FAIL_MARKERS` checked after
`_STRONG_PASS_MARKERS` but only because of explicit ordering at
`system_tools.py:152-155`).

---

## 3. Stream rules

### 🟠 `narrated_tool_call` regex false-positives on legitimate explanatory prose

`providers.py:518`:

```python
re.compile(r"\bI['\u2019]?ll (?:now )?(?:use|call|invoke) (?:the )?[\w:]+ (?:tool|function)\b", re.IGNORECASE)
```

Repro via `run_turn` with a pure-text scripted round:

| Probe text | Stream-rule fires? |
|---|---|
| `I'll use the read_file tool to check this.` | ✓ (intended) |
| `As the docs say, "I'll use the read_file tool" is the convention.` | ✓ (false positive) |
| `Let me explain: when you read a file you would say "I'll use the read_file tool".` | ✓ (false positive) |
| `First, let me explain how to read. Then I'll use the read tool.` | ✓ |
| `I'll call the json.loads function` | ✗ (only because `json.loads` has a dot which isn't in `[\w:]+`) |

When the rule fires mid-stream, the generation is ABORTED, a `warning` is
emitted, and a `[Proxy Self-Heal]` reminder is injected. On a model that's
just *teaching the user* about tool calling, this restarts a perfectly good
response — and after 1 such abort the model may start hedging
("Use the read_file tool") only to hit the rule again on the next rephrase.

Suggested mitigation:
- Only fire when tools are actually offered for this round AND the model
  has been narrating without a tool call for N consecutive tok batches.
- Require sentence-initial position (`^` or after `\n\n`) for the
  `narrated_tool_call` arm.
- Track whether the previous round already produced a tool call — if yes,
  narration is far more likely to be post-hoc explanation than hallucinated
  intent.

(Test evidence: `_probe_agent2_b.py` produced 1 narration warning per
innocent probe.)

---

## 4. Tool loop robustness

### 🟠 No timeout on individual `_executeTool` calls — a hung tool blocks the turn forever

`workbench.py:3236` (run_command path) and `workbench.py:3281` (generic path):

```python
result = await _executeTool(toolName, toolInput, session, toolUseId)
```

There is a `tool_progress` heartbeat (`Still working on {toolName}…`) every
8 s, but **no `asyncio.wait_for`** anywhere around the dispatch. If a tool
handler hangs (MCP server that never responds, deadlocked sandbox, network
socket with no read timeout, infinite loop in `_pySearchFilesSync`), the
loop is alive (heartbeats fire) but the turn never advances. The cancel
button is the only release — and `_isCancelled()` is only consulted at the
top of the next tool-round iteration, so a genuinely-hung tool can't be
interrupted cleanly either; it just blocks the next round's pre-check
indefinitely.

Suggested mitigation: wrap the `_executeTool` call in
`asyncio.wait_for(..., timeout=_TOOL_CALL_HARD_TIMEOUT_S)` (a generous value
like 600 s, configurable per tool). On timeout, cancel the task, mark the
result as an error, and let the model re-plan.

### 🟡 `invalidThisRound` reset is on `toolResults`-based recovery, not the round counter

`workbench.py:3443-3444`:

```python
if invalidThisRound == 0:
    parseFailures = 0
```

`invalidThisRound` is per-round (cleared at the top of each round);
`parseFailures` is turn-scoped and only reset when *this round* had zero
invalid calls. If the model alternates malformed/clean/malformed/clean/…
indefinitely the counter never crosses the threshold of 3, so the
bare-surface downgrade never fires.

Verified (round-1 probe): script `malformed → ok → malformed → malformed → text`
produced no downgrade warning. That IS the intended "consecutive-only"
behaviour per the comment, so this is informational, but a model that hits
malformed at a steady rate (e.g. 50% of rounds) escapes the downgrade
forever. Consider a sliding-window heuristic (e.g. ≥3 malformed in the
last 5 rounds) instead of strictly-consecutive.

### 🟡 `_text_tool_protocol` is sticky-turn — set on surface='text' or after 2 refusals, never cleared

`workbench.py:1175` (capability profile `surface == 'text'`) and
`workbench.py:2780` (after the second refusal). Once `True`, the run-loop
continues parsing `[TOOLCALL]` lines from plain text — even if the model
later acquires native tool calling again. No `setattr(..., False)` path
exists.

Edge case: a session that was auto-downgraded for refusals, then user
switches the model to a strong one — the strong model continues to use the
text protocol because the session flag persists.

Fix: reset `session._text_tool_protocol = False` whenever a model with
native tool calling successfully emits a tool_use block this turn.

### 🟢 Stall detector threshold effectively `rounds ≥ 20` then hard-stop at `22` — long hang before any signal

`MAX_STALLED_ROUNDS=8`, `MIN_ROUNDS_BEFORE_STALL_CHECK=12`. Stall fires on
round ≥ 12 + 8 = 20. Confirmed via probe: a model calling the same tool
30 times produced 21 toolResult events before the hard-stop. With Claude or
GPT-4 at streaming rates that's many seconds of wall-clock and thousands of
tokens before the first nudge.

May be intentional (model needs headroom to explore) but consider scaling
`MIN_ROUNDS_BEFORE_STALL_CHECK` with the loop cap: when
`maxWorkbenchToolLoops` is reduced to e.g. 8 the stall detector should fire
earlier than round 12 + 8 = 20 — currently it would never fire at all
(because the cap hits first).

---

## 5. Capability profiles / truncation

### 🟠 `maxToolResultChars` truncation mid-JSON produces corrupt history

`workbench.py:3397-3405`:

```python
if len(historyContent) > resultCap:
    historyContent = (
        historyContent[:resultCap]
        + f'\n\n[... Tool result truncated at {resultCap // 1024} KB ...]'
    )
```

If the tool returned a JSON document (likely for `web_fetch`, `browser_*`,
`memory_search`, MCP tool results), slicing at a hard character cap:
- splits mid-JSON-string, mid-escape, mid-UTF-16 surrogate pair (if the
  result has astral characters crossing the boundary).
- leaves no closing brace `}` for the model to detect truncation.
- the `[...]` marker that *does* flag truncation lands AFTER the cut — the
  model sees something like `{"key": "val` followed by ASCII whitespace and
  `[...]`.

The model then takes this corrupt string at face value, may try to parse it
as JSON, fail, and conclude the tool is broken — a side effect harder to
debug than a clean error.

Fixes (any one):
- Truncate at the last `\n` before the cap.
- If the result starts with `{` or `[`, attempt `json.loads` on decreasing
  prefixes (find last complete `,` at depth 0) and emit `[..., <truncated>]`
  as a closing marker.
- At minimum, prepend a `⚠ TRUNCATED:` header on the surviving prefix so
  the model can detect it without scanning to the tail.

### 🟡 `toolSurface: bare` exposes `update_state`/`write_scratchpad`/`diagnose_proxy`/`get_session_info`

`_BARE_TOOL_ALLOW` (`workbench.py:1116-1131`) includes state-management
tools. If "bare" is intended as a hard floor for weak models with malformed
JSON, this is defensible. But it's worth documenting that "bare" still
exposes 13 tools — not literally zero. A user reading `toolSurface: bare`
in Model settings is likely to expect "only file ops" or "only run_command",
not "everything in the harness's critical path".

No code bug; documentation / UX wording.

### 🟢 `_modelCapabilityProfile` does dict-scan per turn

For every turn, both `toolDefinitions` and `openaiToolDefinitions` call
`_modelCapabilityProfile(session)`, which iterates
`config_service.getProvidersAsModels()` → each provider → each model entry.
The list can be cached against the config generation counter (the way
`tool_defs_cache` already does for raw definitions). Micro-perf only.

---

## 6. Session ownership / cancellation

### 🟠 `_isCancelled` is only checked at the top of each tool round, not between tool uses within a round

`workbench.py:2823` checks `_isCancelled()` between tools in a round, but
the *model-call* retry/sleep block at `workbench.py:2576` uses
`_interruptibleSleep` (good) and the `_executeTool` invocation has no
cancel-aware wrapper. Combined with the missing per-tool timeout, a
non-cooperative tool (`await subproc.wait()` on a child that never exits)
can pin the loop forever — Stop button emits `_isCancelled` but nothing
between `await _executeTool(...)` and the next round boundary checks it.

Most tools do check the cancellation event via `current_subprocess_cancel`,
but not all: any tool that doesn't honour it (e.g. an MCP server client that
doesn't receive the cancel) blocks indefinitely. The "Stop" UX is then
perceived as broken.

### 🟡 `updateSessionState` swallows lock timeout silently

`workbench.py:5065-5078`:

```python
try:
    await asyncio.wait_for(session._state_lock.acquire(), timeout=5.0)
    ...
    session._execution_state = executionState
except asyncio.TimeoutError:
    pass  # never reported
except RuntimeError:
    pass
```

If the lock can't be acquired in 5 s (re-entry? leaked acquire? contention
with another concurrent `updateState`), the update is silently dropped and
the caller returns "State updated: ..." happily. The session is left in the
prior state with no signal to the user or the model that the write did not
land.

Suggested: log + return an error string when the timeout fires.

### 🟡 `_persist_sessions_snapshot` can drop an in-flight session from the in-memory map

`sessions.py:470-476`: on save, only the 200 most-recent `updatedAt` sessions
stay in `_sessions`. The eviction is by sort order, not activity. A
long-running turn already holds a strong reference (the local `session`
variable), so the running turn is safe; but any *state* the running turn
sets on the evicted instance diverges from the fresh `WorkbenchSession`
that `get_workbench_session(...)` will hydrate from SQLite on the next
lookup. If `save_sessions` fires between turn boundaries AND a status
subscriber polls in between, brief inconsistency windows are possible.

Low severity in practice — the active-turn reference and the SQLite SoT
prevent data loss — but this is an unusual pattern and worth a comment if
intentional.

---

## 7. Misc

### 🟢 `_run_tracked` records `tool_friction` even on success-path emission errors

`chat_stages.py:81-94`: the `except Exception` handler in `_run_tracked`
records failure twice (`trackToolFailure` + `record_tool_friction`) — fine.
The subtlety: if the *emit* call inside `_run_tracked` raises (a stream
subscriber that throws), the whole tool result is replaced with
`{'role': 'tool', 'is_error': True, 'content': f'Error: {exc}'}`, even
though the underlying tool ran successfully and already produced output.
The user sees a phantom failure for a real action.

### 🟢 `model_fleet.py` is a stub

`workbench.py:5-15` says "Subagent dispatch (stubbed)" — see
`backend-py/app/services/workbench/model_fleet.py` (34 lines, no real logic).
Not a bug, but cleanup.

---

## Suggested improvements (ordered by impact)

1. **🔴 Unify hash computation between `read_file` and `_executeTool`** —
   hash raw bytes in both places (one extra `read_bytes` in read_file), so
   CRLF/UTF-8-replacement files don't spuriously fail the anchor check
   (workbench.py:4062 vs file_tools.py:139-146). This bug fires on every
   CRLF text file on Windows, the primary desktop target.

2. **🟠 Resume the model loop in-place after verifier auto-run** — currently
   `enqueueUserMessage` from `workbench.py:3623` is consumed on the next
   turn boundary. Replace the enqueue with an inline `continue` of the
   `while True` loop (or a follow-up `sendWorkbenchMessageStreamImpl` call
   with the steer as user message) so a verifier-enforced turn actually
   completes instead of waiting for the user (workbench.py:3577-3625).

3. **🟠 Reset `_verifier_auto_ran` and `_reviewer_checked` at turn start** —
   both flags are one-shot-per-session, silently disabling the verifier
   rail for the second task onwards. Clear them alongside
   `session._verification_receipts = None` (workbench.py:601).

4. **🟠 Add a hard timeout to `_executeTool`** — `asyncio.wait_for(..., 600)`
   or configurable per tool. Without it, any tool that hangs pins the turn
   (workbench.py:3236/3281) and the only release is the cancel button, which
   tools that don't honour the cancellation event ignore.

5. **🟠 Trim stream-rule false positives** — require either (a) the previous
   round emitted no tool call, (b) sentence-initial match, or (c) the rule
   has fired N consecutive rounds before acting on the narration heuristic
   (providers.py:518). Today any prose containing "I'll use the X tool"
   restarts the generation, including explanatory answers.

6. **🟠 Make truncation JSON-aware** — when `maxToolResultChars` clamps a
   tool result that starts with `{`/`[`, close at the last valid character
   or emit a leading `TRUNCATED` marker (workbench.py:3397-3405).

7. **🟡 Log + return error when `updateSessionState` lock times out** —
   workbench.py:5068-5078 silently drops the state write.

8. **🟡 Reset `session._text_tool_protocol = False`** when a native tool
   call succeeds after the protocol was set (workbench.py:1175/2780).

9. **🟡 Consider a sliding-window malformed-JSON counter** instead of
   strictly-consecutive (workbench.py:3443-3444).

10. **🟢 Cache `_modelCapabilityProfile`** against the config generation
    counter (workbench.py:1141).

---

## Quality gate

- ruff: clean.
- mypy `app/services/workbench/`: clean.
- All 36 workbench-adjacent tests pass on this tree.
- Verification-backed findings: hash mismatch (probe), stream-rule false
  positive (probe), stall-detection-round counts (probe), verifier auto-run
  steer destination (probe), per-turn reset absence (static read), per-tool
  timeout absence (static read), updateSessionState silent-drop (static
  read), sticky `_text_tool_protocol` (static read), sticky `_verifier_auto_ran`
  and `_reviewer_checked` (static read).
- Speculation flagged inline where applicable.

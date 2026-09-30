# Deep-scan findings — August Proxy (2026-09-27)

A read-only audit of the whole repository: 16 parallel auditor tracks over the
backend, the Tauri shell, the React frontend, the build/release pipeline and the
documentation, each critical/high claim put through an adversarial refutation
pass, then de-duplicated into one ranked register. 34 agents, 2 synthesis
passes.

## Baseline established before the audit

Everything the project already gates on is green. That matters, because it means
the findings below are semantic gaps that a passing suite does not see — not a
broken build.

| Gate | Result |
|---|---|
| `ruff check .` (backend-py) | clean |
| `mypy app/` | clean — no issues in 334 source files |
| `pytest -q -n auto` | **3924 passed**, 3 skipped, 8m05s |
| `npm run test:frontend` | **1486 passed** / 189 files, 67.8s |
| coverage | 70.34% (gate is 55%) |
| `npm run check:docs` | 4 doc claims match the code |
| `npm run check:version` | all 8 sources in sync at 0.18.16 |
| `npm run check:naming` | 182 known camelCase params, no new ones |

## Fixes applied in this session

**20 findings are fixed** in the working tree. Every one was re-read at its
source before the change — several were better or worse than the original
report, and those corrections are noted inline. The fixes are ordered by blast
radius, not by rank number.

### Round 1 — the top findings, with regression tests

| # | File | Fix |
|---|---|---|
| 1 | `file_tools.py:596` | `_editLines` clears the tool-result cache after a successful write, mirroring `writeFile` at `:315-321`. The second edit of a file in one session is accepted again. |
| 2 | `workbench.py:5709` | The running-session deletion guard resolves the `bulk` meta-tool's `operation` before the name test, closing self-deletion through the aggregate path in every guard mode. |
| 13 | `workbench.py:1308` | New module-level `_canRetrieveSpill(tools, openaiTools, session)` decides spill retrievability and falls back to `openaiTools` on the OpenAI/Responses wires. Extracted from the 6.5k-line loop so a test can reach it — the inline version was untestable, which is how it survived 3924 green tests. |
| 10 | `workbench.py:1670` | `'daemon'` added to the storable kinds, so the auto-turn's `kinds={'subagent','daemon'}` drain (`routers/workbench.py:274`) is satisfiable. Three call sites all looked correct; the filter was dead. |
| 17 | `workbench.py:2982` | The skills credit moved out of `if _memoryBlock:`, so `skills_injected` is recorded whenever the skills lane renders — including with `memoryAutoInject` off, the default. |

14 regression tests live in `backend-py/tests/test_deep_scan_fixes_2026_09_27.py`,
red/green validated: stashing only the source fixes makes exactly 5 fail, one per
behavioural fix, while the negative controls ("still allows deleting another
session", "still rejects a genuinely stale hash") pass in both states.

### Round 2 — the remaining confirmed, high-confidence defects

| # | File | Fix |
|---|---|---|
| 9 | `mcp_client.py:221` | New `rehydrate_from_config()` restores the persisted registry; `_loadConfig` had **no callers at all**, so every MCP server was lost on restart. Called from the `main.py` lifespan before the tool refresh. Rows go through `registerServer(persist=False)` so a config written before a validation tightening is skipped, not restored into a refused launch. |
| 11 | `subagent_orchestrator.py:1010` | The session permit is released on the GLOBAL-slot timeout. Only one of the two refusals leaked — the session-acquire path returns with nothing acquired. The file's own comment at `:995-999` already described this bug class. |
| 14 | `hdl_tools.py:645` | VCD vector changes (`b1010 data`) are now parsed. They were silently dropped, so **every** multi-bit signal reported zero activity. `_parse_vcd_value_change` existed, was correct, and was never called. |
| 6 | `firmware_tools.py:205` | `name` is sanitised before becoming a path component, matching the sibling HDL tools. An absolute name won outright in `Path(tmpdir) / base`. |
| 7 | `browser/handlers.py:162` | New `_parkPage` blanks the page on refusal. A refused address stayed live, so the next get_content / screenshot / evaluate read the blocked target through a different door. |
| 8 | `tool_policy.py:190` | The five `desktop_*` input tools added to `_PLAN_BLOCKED_EXACT`, mirroring the `browser_*` precedent. Enumerated, not a prefix rule, so `desktop_screenshot` stays readable. |
| 30 | `desktop_automation.py:119` | `openUrl` now enforces the same URL policy as the headless browser, and refuses any non-http(s) scheme before handing the string to the OS. |
| 3 | `consolidation.py:408` | The merge loop guards **both** sides and checks the UPDATE rowcount. The old check covered only `older`, so a three-fact chain could pick a deleted survivor — deleting a fact with its text written nowhere, logged as merged. |
| 4 | `rollback_store.py:236` | Fact values are decoded one JSON layer before being written back. `get_fact` does not decode, so each Undo added a layer until the recalled text was unreadable. |
| 33 | `rollback_store.py:225` | The project-memory restore failure now propagates. The inner `except` swallowed the very raise meant to make undo report `ok=False` — it reported success, restored nothing, and burned the entry. |
| 23 | `daemon_manager.py:268` | `expires_at` restored on rehydrate and the reaper re-armed, so a resurrected daemon finally has a deadline. |
| 26 | `daemon_manager.py:141` | Daemon ids carry a uuid suffix. Two same-named spawns in one second collided, orphaning a running loop invisible to kill/list/rehydrate. |
| 25 | `harness_jobs.py:127` | `dirty` is tri-state and a terminal status is terminal. The default-argument close wiped the `mark_dirty` receipt; a cancelled job could be overwritten as `completed`. |
| 24 / 48 | `spawn_subagents_tool.py:761` | The wave driver checks for cancellation between waves, and items are named by their real position instead of a hardcoded `0`. |
| 20 | `routers/august.py:947` | `tools/manage {action:'list'}` redacts, exactly as `routers/mcp.py` does. It returned raw rows — a GitHub token in plaintext. |
| 21 | `routers/mcp.py:157` | PATCH carries `headers` and `catalogId` forward (and can now set them). The rebuild dropped them, so every detail-pane save lost a remote server's Authorization header. |
| 31 | `terminal_service.py:206` | The exit sentinel evicts the oldest item and retries. On a full queue it was dropped, so the WebSocket never closed. |
| 36 | `hdl_tools.py:1078` | `failed`, `ok` and the JUnit `failures`/`skipped` counts all use one predicate. `ok` excluded SKIP while `failed` counted it, so a fully-skipped run reported `ok:true, failed:3`. |
| 34 | `firmware_tools.py:307` | A missing `avr-objcopy` is a distinct failure with the install hint, and a missing `.hex` is checked before `copyfile`. Both previously surfaced as an opaque errno. |
| 19 | `live_speech.py:61` | The base URL is used verbatim. Live STT/TTS was appending `/v1`, the one place August invents it. |
| 39 / 44 | `file_tools.py:263` | Paged reads join with `''` (elements already carry `\n`), so the block can be copied into an `edit_lines` anchor; the unreachable `path:start-end` cache entry is gone. |
| 38 | `types/workbench.ts`, `api/schemas/workbench.ts`, `streamEvents.ts` | `'budget'` added in lockstep. `lib/turn-end.ts` already shipped the phrase, so the documented amber "budget reached" badge could never render. |
| 49 | `release-desktop.mjs:80` | The semver prerelease suffix is stripped before parsing. `0.18.16-rc.1` patch-bumped to the string `0.18.NaN`, hard-blocking the next build. |
| 41 | `release-desktop.yml:115` | Every command's exit code is checked. A multi-line `run:` under pwsh reports only the last, so `uv lock --check` could fail silently — after the payload was already staged. |
| 50 / 51 | `.pre-commit-config.yaml` | ruff hook `v0.9.10` → `v0.15.21` (what `uv.lock` pins and CI runs), and `backend-py/scripts/` un-excluded (`pyproject.toml:160` already ignores the rules it trips). |

### Round 3 — the remaining 18, each with the judgement call recorded

Resource ceilings needed a value, so the reasoning is stated rather than implied.

| # | File | Fix and the call behind it |
|---|---|---|
| 12 | `file_tools.py:19` | Paging keeps a ceiling — `_MAXPageFileSize` (200 MB), deliberately **higher** than the 20 MB normal cap because paging is the documented escape hatch for a big log, but finite because the paged branch reads the file twice. |
| 32 | `bulk_tools.py:38` | The `files` object form now truncates at `BULK_MAX_ITEMS` and reports the dropped count. `format_bulk_report` already advertised a 40-cap; only the enforcement was missing. |
| 45 | `terminal_service.py:315` | Listing and retention now share `_MAX_SESSIONS_HARD`. A retained terminal must be addressable by id; the old 50/100 split made 50 shells unreachable. `MAX_SESSIONS` is kept for its other callers. |
| 46 | `browser/handlers.py:55` | New `_pruneScreenshots` keeps the newest 50, wired into both the browser and the desktop capture path. Filenames are millisecond stamps, so lexical order is chronological. |
| 15 | `workbench.py:3248` | A ladder rung now always consumes exactly one step, even when the surface is already narrowed. A no-op `surface` rung emits its own recovery event instead of falling through to the terminal rung. |
| 16 | `workbench.py:5137` | `budgetSurfaceNarrowed` tracks *which* authority narrowed the surface. The A6 clean-round restore still reverses the self-heal downgrade, but re-asserts a budget narrowing. |
| 18 | `workbench.py:5306` | The per-step shadow-git snapshot moved to `run_in_executor`, matching the turn-start baseline. Awaited rather than fire-and-forget, so successive snapshots keep round order for the ChangesCard diff. |
| 27 | `subagent.py:66` | `_STREAM_RULE_MAX_RETRIES = 3`. On exhaustion the round is **accepted with its text**, not abandoned — retrying forever burned calls, and ending on nothing would discard real work. |
| 35 | `hdl_tools.py:455` | The ModelSim `-l transcript` file is read back before the tmpdir is removed, so assertion failures are actually parsed. |
| 5 | `project_memory.py:289` | Per-fact filenames disambiguate against what is on disk (`-2`, `-3`, …). The existing check compared *titles*, not filenames, which is why the collision was invisible. Existing files need no migration — the new name is only used when the target exists. |
| 42 | `consolidation.py:417` | The survivor's value is re-read from the row inside the loop, so a merge chain no longer rebuilds from the pre-loop snapshot and lose the earlier pair's provenance note. |
| 43 | `rollback_store.py:210` | Undo restores `description`/`kind`, and `per_fact` is **derived** — from the snapshot when present, else from the entry not living in the legacy `memory.md`. The first attempt defaulted it to `True` and an existing test caught it converting a legacy entry into a per-fact file. |
| 28 | `browser/handlers.py`, `web_tools.py` | Schema and handlers reconciled: `browserScroll` accepts `ref`; `browserClick` implements `button`/`clickCount`; `browserType` honours `clear`; the scroll `direction` enum narrowed to what the handler actually does (`up`/`down`) and its documented default corrected to 400. |
| 29 | `browser/handlers.py:412` | `markdown` now runs `html_to_markdown` instead of duplicating `text`, so the stamped format is honest. |
| 47 | `web_tools.py:610` | `'load'` added to the `browser_wait` strategy enum — the handler implemented it, the schema hid it. |
| 40 | `durability.py:47` | The recorded `_tailFrom` is the authoritative cut; the marker scan is only the fallback for older patched messages. |
| 22 | `routers/git.py:565` | The docstring now states the property the code actually has: the argv is fixed, `repo_path` is a honoured fallback, and the web drive-by vector is closed by `TrustedOriginGuard`. The doc was wrong, not the resolver. |
| 30, 9, 7, 8, 10, 13, 17, 1, 2, 3, 4, 5, 6, 11, 14, 19, 20, 21, 23, 24, 25, 26, 31, 33, 34, 36, 38, 39, 41, 44, 48, 49, 50, 51 | — | (unchanged from rounds 1-2) |

### Post-fix gates

`ruff` clean · `mypy` clean on 334 files · **4067 backend passed / 3 skipped**
(7m43s) · **1486 frontend passed / 189 files** · `check:docs` (6 claims),
`check:version` and `check:naming` all pass · zero regressions against the
3924 + 1486 baseline.

**All 52 findings are now closed**, plus #53 found afterwards by the
conformance test.

## Two tests that were not testing what they claimed

Found while re-verifying the later work, not by the sweep: consecutive full
runs failed **different** tests, which is the signature of load sensitivity
rather than a regression. `AGENTS.md` is explicit that this is a bug in the
test, not a reason to drop `-n auto`, and both were load-sensitive for the same
underlying reason — a wall-clock or fixed-sleep assertion standing in for a
structural fact.

**`test_parallel_tools_gather_runs`** asserted "concurrent, not serial" with
`elapsed < 0.05` over two 0.02 s tasks. Serial execution takes 0.04 s, which
*also* satisfies that bound — so the test passed whether or not the calls were
gathered, and it was simultaneously the suite's flakiest, failing a concurrent
pair that measured 0.053 s. It now asserts **overlap**: each task records when
it started and finished, and every pair must overlap. Verified to reject serial
and accept a gather, so it discriminates instead of being green either way.

**`test_background_spawn_returns_started_and_enqueues`** waited a fixed 0.2 s
for a deliberately asynchronous enqueue — 6/6 alone, 5/6 alongside siblings,
so the margin was a coin flip. It now polls to a 10 s deadline with the mock
still patched (the patch has to stay open across the wait, or the watch task
un-mocks mid-flight and the enqueue never happens).

A first attempt at the second fix, using the deprecated
`asyncio.get_event_loop()`, made it **worse** (6/8 failing) and passed in
isolation. The working version uses `get_running_loop()`. Re-measuring a
proposed fix in the configuration it failed in is the only reason that was
caught.

`test_handle_terminal_connection_pumps_output` failed once during a 2h56m
oversubscribed run, then passed 8/8 standalone and 6/6 alongside neighbours.
Left alone and recorded rather than chased: round 2 touches no terminal code.

## Finding #53 — found by the conformance test written afterwards

`tests/test_gate_participation.py` (roadmap item #4) failed immediately on
something the 52-item sweep did not report:

> `_SHELL_BULK_OPS` held only the **singular** names (`run_command`), but the
> operation literal `bulk` actually accepts is the **plural** `run_commands`.
> `is_mutating` did not rescue it either — its bulk markers are
> write/delete/rename/kill, and `run_commands` contains none.

So `bulk(operation='run_commands')` — which fans out N shell commands — was
gated by **nothing**, in ask, edit, plan and read-only alike, while the single
`run_commands` tool was gated by all four. Fixed by putting the plural forms
(and the other shell aliases) into both `_SHELL_BULK_OPS` and
`_PLAN_BLOCKED_BULK_OPS`.

This is worth more than the bug: it is direct evidence that systemic pattern #1
was still live *after* all five originally-reported instances were fixed, and
that only a mechanical check finds the next one.

### The same test's discovery surface

93 of the 145 registered tools claim neither `is_mutating` nor
`is_shell_mutation`. Most are legitimately controlled elsewhere — handler-level
gates (`modelMemoryWrites`), the prompt caution bucket, or `bind_path` — but the
list is where the next instance of this class will surface:

```
analyze_media, board, brain_query, browser_*, bulk, camera_*, circuit_*,
clear_blackboard, create_html_artifact, create_pptx, customize_ui,
describe_environment, desktop_list_windows, desktop_mouse_position,
desktop_screen_size, desktop_screenshot, desktop_ui_tree, diagnose_proxy,
draw_circuit, enter_plan_mode, firmware_stimulus, forget, get_fallback,
harness_introspect, harness_propose, hdl_timing_diagram, interrupt_subagent,
job_notes, judge_artifact, kicad_render, list_*, load_skill, load_skills,
message_agent, module_context, pptx_*, read_blackboard, read_file, read_files,
remember, rename_session, render_chart, render_pages, render_video, search,
search_files, send_subagent_message, session_context, set_agent_mode,
setup_provider, spawn_daemon, spawn_subagents, submit_*, summarize_session,
tool_*, update_state, update_todos, vcd_parse, web_fetch, web_fetch_many,
web_search
```

`setup_provider` and `forget` are the two worth a look first: both change
durable state and neither reads as mutating. **Not fixed here** — deciding
whether each is correctly gated elsewhere is a policy question, not a mechanical
one, so it is recorded rather than guessed at.

## What still needs a human on the real desktop app

Everything above is verified by a green suite. Four fixes changed behaviour in
a way CI structurally cannot reach, so they are listed as **unverified** rather
than folded into the "all green" claim. `npm run dev:desktop` is the harness.

| # | Fix | How to check it |
|---|---|---|
| **9** | MCP registry now rehydrates at startup | Configure one MCP server, **restart the app**, and confirm it reappears in the tool list with its Authorization header intact. This is the fix with the largest behavioural delta — before it, nothing survived a restart. |
| **18** | Per-step shadow-git moved onto the event loop's executor | Run a multi-round turn that mutates files, and confirm the **Changes card still shows every step** in order. Awaited (not fire-and-forget) so ordering should hold, but ordering is the thing a concurrency change can silently break. |
| **7 / 30** | Browser page parks on `about:blank` after a refusal; `desktop_open_url` now enforces the URL policy | Drive the browser to a blocked address, then call `browser_get_content`. It must return nothing about that address. Then try `desktop_open_url('file:///...')` and confirm it is refused in every guard mode. Needs a live browser. |
| **6 / 14 / 34 / 35** | The EDA fixes | Their suites pass locally (143 tests), but **`AGENTS.md` records that the ngspice-dependent circuit tests run in no CI job at all** — only where the binary is staged. The `avr-objcopy` and ModelSim-transcript fixes in particular were never exercised against a real toolchain. |

Everything else — including all of the memory, ladder, tool-surface and
build-pipeline fixes — is covered by a suite that runs in CI.

## What is deliberately NOT fixed

Nothing. The 18 findings deferred after round 2 were then fixed in round 3;
each judgement call is recorded below, because several needed a decision
rather than a mechanical edit.


## How to read the register

- **status `confirmed`** — a second, independent agent opened the file and the
  call sites and agreed. These are the ones to trust.
- **status `single-reviewer`** — only one agent saw it. Plausible and
  code-cited, but unrefuted. Cheap to re-check.
- **status `weakened`** — real, but only reachable in a configuration that is
  off by default.

Eight entries are marked **[hand-verified]**: I opened those files and call
sites myself rather than relying on either agent. Ranks 1, 2, 9, 10, 11, 13, 14
and 17 all held up. Two are worse than reported (#9, #13), one is narrower than
reported (#11 — only one of the two refusals leaks), and one (#14) turned out to
have a correct-but-dead helper sitting right next to the bug.

That matters for triage: **every `single-reviewer` high item I checked came back
confirmed.** The unrefuted high-severity entries should be treated as real until
someone proves otherwise, not as speculative.

## Systemic patterns

52 entries are not 52 accidents. Five classes repeat, and each class is more
valuable to fix than any individual line.

### 1. Guards are keyed on the tool NAME, not the resolved operation

Every sandbox, permission and path guarantee is an inline `if toolName in (…)`
prologue at one call site, so every alias, aggregate or new-module entry point
runs unguarded.

- #2 — the running-session deletion guard is a name tuple, but `bulk_tools.py:307`
  routes `operation=delete_sessions` through the same handler. Notably
  `tool_policy.py:290/308` *does* resolve nested bulk operations — so two guards
  disagree about the same call.
- #6 — `firmware_compile`'s `name` never reaches `bind_path`, unlike the three
  sibling tools that all do.
- #8 / #30 — the `desktop_*` input tools and `desktop_open_url` bypass confirm,
  plan, read-only and the URL allowlist.
- #22 — `/api/git` mutating routes accept any caller-supplied `repoPath`.

**Blast radius:** every sandbox, permission and path guarantee for tool
execution. Nothing mechanically asserts that a new entry point passes a gate.

### 2. Success paths do not invalidate the cache they poison

Cache invalidation is a per-call-site responsibility inlined into each tool
inside a `try/except`, so a mutator that omits the block silently serves stale
content forever.

- #1 **[hand-verified]** — `_editLines` writes at `file_tools.py:593` and returns
  at `:603` with no `_cache_clear()`; `writeFile` clears at `:319-321`.
- #37 — `render_pages` serves stale pixels for an in-place-edited image.
- #44 — paged `read_file` caches under `path:start-end` while lookups use `path`,
  so the entries are unreachable *and* evict real ones.

### 3. Named contracts drift from the shape actually carried

Router Pydantic models, client row shapes and TS unions are hand-maintained in
three places with no generator, no exhaustive-switch check and no GET-then-PATCH
round-trip test.

- #21 — `PATCH /api/mcp/servers/{id}` rebuilds the row and drops `catalogId` and
  `headers`. Silent credential loss on every edit.
- #20 — `/api/august/tools/manage` returns MCP rows in plaintext while every
  `/api/mcp/servers` reader redacts via `redactedServerRow`.
- #17 — `skills_injected` is assigned inside `if _memoryBlock:`, and auto-inject
  is **OFF by default**, so the column is always NULL and `brain_config.py:522`
  / `turn_outcomes.py:523` learn skill relevance from an empty population.
- #38 / #52 — TS union members with no dispatcher case.

### 4. Durable state is written with a superset of fields and rehydrated with a subset

The write path runs every session; the load path runs once at launch and asserts
nothing. This is the pattern that directly threatens the install/update promise.

- #9 — `mcp-servers.json` is written but never rehydrated.
- #23 — `rehydrate_from_db` omits `expires_at` (present at spawn time), so the
  TTL reaper is blind and daemons resurrect every launch.
- #26 — daemon id is `f'{sessionId}_{name}_{int(time.time())}'`, which collides
  within one second and orphans a run loop permanently.
- #5 — project-memory filename is a title slug with no collision check.

### 5. Resource limits are per-call-site constants, and permits leak off the happy path

- #11 — the per-session worker permit is leaked when the GLOBAL slot acquire
  times out, shrinking the pool until all later spawns in that session fail.
- #12 / #32 — paging and the bulk object form both bypass the size ceilings.
- #45 — terminal sessions 51-100 hold a live OS shell and are never listable or
  closable.
- #46 — screenshot folders grow without bound and `privacy.clearLogs` misses them.

---

# The register

## Critical

### 1. `edit_lines` never invalidates the read cache, so the second edit in a session is refused — `file_tools.py:593` **[hand-verified]**
**Impact:** normal multi-file-edit sessions hard-block. Read → `edit_lines`
(succeeds) → `read_file` (served from the 30s cache) → `edit_lines` returns
`[edit-stale]` even though nothing else touched the file. This is the single most
common agent workflow in the product.

`writeFile` clears the cache at `:319-321`; `_editLines` writes at `:593` and
returns at `:603` with no clear. **Fix:** call `_cache_clear()` after
`write_bytes`, mirroring `writeFile`. One line. Add a test that edits twice with
a read between and asserts the second edit is accepted.

*Re-categorised from "security" — this is correctness, not a security issue.*

### 2. The "cannot delete the running session" guard is a literal name test, so `bulk` bypasses it — `workbench.py:5709` **[hand-verified]**
**Impact:** data loss. `toolName in ('delete_session', 'delete_sessions',
'delete_folder')` does not match a call named `bulk` with
`operation='delete_sessions'`, and `bulk_tools.py:307-308` routes straight to the
same handler. The model can destroy the running session's transcript in **every**
guard mode including Full Access, which the comment at `:5706` says is explicitly
blocked. `tool_policy.py:290/308` already knows how to resolve nested bulk
operations — this guard just doesn't ask it.

**Fix:** unwrap the `bulk` alias before the self-delete check; add a
self-session check inside `session_tools._deleteSessions` as defence in depth.

## High

### 3. Consolidation can delete a fact with no merge at all — `consolidation.py:422`
**Impact:** data loss. When the BM25 pass picks an already-removed row as
survivor, a fact's text is deleted and written nowhere while the run log claims
it was merged. Needs three mutually-similar same-scope facts. **Fix:** skip a
pair whose survivor is already in `removedKeys`, check the UPDATE rowcount, and
only DELETE when rowcount == 1.

### 4. Memory rollback/undo double-encodes the fact value — `rollback_store.py:236`
**Impact:** wrong answer, and it compounds. A fact value is stored
JSON-encoded; each Undo adds another JSON layer, so a recalled fact renders with
literal quote characters and repeated undos make the text unreadable. **Fix:**
decode once before handing to `save_fact`, or make it idempotent.

### 5. Project-memory filename is a title slug with no collision check — `project_memory.py:289`
**Impact:** data loss. Two distinct memories with the same slug collapse into one
file; the first is truncated away and `remember` still returns `ok:True`. **Fix:**
append a short title hash or counter; check the target file, not title identity.

### 6. `firmware_compile` `name` never goes through `bind_path` — `firmware_tools.py:205`
**Impact:** an absolute name escapes the temp dir and the sandbox write gate
entirely, planting model-controlled content at an arbitrary path that
`write_file` and `run_command` would both refuse. Three sibling tools already
sanitise this (`fpga_tools.py:269`, `kicad_tools.py:229`, `hdl_tools.py:172`).
**Fix:** run `name` through the same sanitiser and resolve the base through
`bind_path` unconditionally.

### 7. Browser read tools can read a page already parked on a blocked address — `browser/handlers.py:194`
**Impact:** a refused URL leaves the page live, so a follow-up
`browser_get_content` / `browser_screenshot` / `browser_evaluate` reads a blocked
internal target (cloud metadata, LAN hosts, unauthenticated local ports) despite
the allowlist. **Fix:** navigate to `about:blank` on refusal, or re-assert
`assertFinalUrlAllowed` inside `_page()` so every later tool revalidates.

### 8. Real-desktop input tools bypass confirm, plan and read-only guards — `tool_policy.py:183`
**Impact:** in exactly the modes a user picks to keep the agent off the machine,
`desktop_click` / `desktop_type` / `desktop_press_key` / `desktop_ui_act` /
`desktop_open_url` still drive the real desktop with no approval. **Fix:** add
them to the plan-blocked set or classify by `desktop_` prefix in `is_mutating`.

### 9. MCP server registry is persisted but never rehydrated — `mcp_client.py:184` **[hand-verified]**
**Impact:** every configured MCP integration must be re-entered by hand after
each restart while the on-disk file claims they exist. **Verified by repo-wide
grep:** `_loadConfig` appears exactly **once** in the whole backend — its own
`def` at `:184`. It is never called. `_servers` is initialised to `{}` at
`:179` and only ever written by the register path, so `_saveConfig()`'s output
is dead on every load. **Fix:** call `_loadConfig()` into `_servers`
(preserving `headers`, `catalogId`) from the `main.py` lifespan before
`refreshMcpTools()`, re-registering with `persist=False` and auto-starting only
enabled rows. *Upgraded from `single-reviewer` — this is now the best-evidenced
finding in the register.*

### 10. Daemon completions enqueue as `kind='daemon'`, which the consumer coerces to `'queue'` — `workbench.py:1669` **[hand-verified]**
**Impact:** the daemon auto-turn feature is dead. `daemon_manager.py:374` calls
`enqueueUserMessage(sid, text, kind='daemon')`, but the allowlist at
`workbench.py:1670` is `('queue', 'steer', 'subagent')`, so the stored entry's
`kind` is literally `'queue'` — meaning **any** consumer matching
`entry['kind'] == 'daemon'` can never fire. The comment at
`daemon_manager.py:351` asserts "routers/workbench drains kind='daemon' there",
so the code documents an intent the code contradicts. Notifications then sit
until the next user message, and each one silently burns a runaway-budget slot.
**Fix:** add `'daemon'` to the allowlist, or normalise at the enqueue site.
*`confirmed`, and hand-verified*

### 11. The per-session worker permit leaks on the GLOBAL-slot timeout — `subagent_orchestrator.py:1009` **[hand-verified]**
**Impact:** after repeated 600s global-slot stalls, every later subagent in that
session fails with "Timed out waiting for a per-session worker slot" and returns
an empty result — the leaked permits permanently shrink the pool.

Traced precisely. `:1003-1007` acquires the **session** slot; if that times out
it returns with `holdsSessionSlot` still `False`, so there is correctly nothing
to release. `:1009-1013` acquires the **global** slot; if *that* times out it
returns with `holdsSessionSlot == True` (set at `:1008`), and a plain `return`
does **not** pass through the `except BaseException` at `:1014` that releases
it. So exactly one of the two refusals leaks.

The comment at `:995-999` already describes this bug class verbatim — "returned
without releasing — because the releasing `finally` is further down and was
never entered" — which is strong evidence the maintainers knew of the shape and
fixed one instance, not the other. **Fix:** release before the `return` at
`:1013`. The test covers `CancelledError` but not the `False`-return path.
*Upgraded from `single-reviewer`.*

### 12. `read_file` paging disables the 20 MB ceiling and re-reads the file twice — `file_tools.py:216`
**Impact:** the documented escape hatch for a too-large file is the one path with
no ceiling. A 2 GB log costs ~4 GB RSS plus the full line list, reachable N-way
through `bulk read_files`. **Fix:** keep the ceiling on the paged path, stream
the sha256, and cap the `files` bulk form at `BULK_MAX_ITEMS`.

### 13. Stage-B tool-result spill reads the Anthropic-shaped `tools` list — `workbench.py:5039` **[hand-verified]**
**Impact:** this is the worst of the high findings and the report understated it.
`offeredNames = {_toolDefName(t) for t in tools}` at `:5039`, but `tools` is
populated only when `isAnthropic` (`:2626-2629`) — on the OpenAI and Responses
wires it is `[]`. So `canRetrieve` is False, and `_spillToolResult` returns
`None` outright (`loop/prompt.py:236-237`). The result is therefore **never
spilled at all**: no `.aug/spill` file, no locator, just a hard truncation with
the omitted content gone, on the wire formats most providers speak. The comment
at `:5035` says "`tools` is the live surface for this round" — that is true only
on one of the two paths. **Fix:** `(tools or openaiTools or [])`, the same
fallback `turn_close.py:262-267` already applies to the remember-offered check.
Add an OpenAI-wire case to `test_output_spill_stage_b.py`.

### 14. `vcd_summary` reports every multi-bit vector as zero activity — `hdl_tools.py:655` **[hand-verified]**
**Impact:** a debug tool tells the model a bus never toggled, so it debugs the
most active signal in the design. Every multi-bit vector in the design is
affected — a data bus, an address bus, a state register.

Traced precisely. A VCD vector change is two whitespace-separated tokens
(`b1010 data_bus`). The walker at `:652` skips a token only when the token
*itself* equals `'b'`/`'B'`/`'r'`/`'R'` — but the real token is `b1010`, so it
is **not** skipped. It then does `val, ident = 'b', '1010'` at `:655`, and
`ident not in ids` at `:658` drops it, because VCD idents are things like `!`
and `#`, never the bit-string. The transition is silently discarded, so
`edges` stays empty and the signal reports `'activity': False`.

`_parse_vcd_value_change` at `:526` handles the `b<bits> <ident>` split
correctly — and is **never called** by this function. It is written, correct,
and dead. **Fix:** wire it in for both walks. *Upgraded from `single-reviewer`.*

## Medium

### 15. Budget-ladder `surface` rung falls through into the terminal rung — `workbench.py:3210`
The documented three-rung ladder collapses to the tool-free ending when the
surface is already downgraded, so a soft-budget turn ends a round early instead
of narrowing then compacting. Dispatch on an exact match of `_rung`.

### 16. A6 clean-round restore silently undoes the ladder's bare-surface rung — `workbench.py:5090`
A turn that breached `budgetSoftUsd` keeps the full tool surface through rungs 2
and 3, because both authorities share one `surfaceDowngraded` flag.

### 17. `skills_injected` credit is nested inside `if _memoryBlock:` — `workbench.py:2976` **[hand-verified]**
At `:2976` the `if _memoryBlock:` guard wraps **both** the skills credit
(`:2979 _skillsInjectedNames = list(_skillsDetail.keys())`) and
`session._injected_facts` (`:2980`). Since memory auto-inject is **off by
default**, `_memoryBlock` is normally empty, so the column is always NULL and
`brain_config.py:522` / `turn_outcomes.py:523` learn skill relevance from an
empty population. Outdent the skills assignment so it runs whenever
`_skillsBlock` is non-empty. *`confirmed`, and hand-verified*

### 18. Per-step shadow-git snapshot blocks the event loop — `workbench.py:5241`
Four unbounded git subprocesses run inline on every mutating round, unlike the
turn-start baseline at `:2257-2274` which uses `run_in_executor`. Every mutating
round stalls the loop for the duration.

### 19. Live STT/TTS invents `/v1` on the provider baseUrl — `live_speech.py:65`
Contradicts the documented verbatim-baseUrl rule; a self-hosted or non-`/v1`
gateway 404s with an opaque "STT request failed". Append only the format leaf.

### 20. `/api/august/tools/manage {action:'list'}` returns MCP secrets in plaintext — `routers/august.py:948`
A raw GitHub token is readable from this one management call where
`/api/mcp/servers` correctly returns `ghp_••••`. Wrap in `redactedServerRow()`.

### 21. `PATCH /api/mcp/servers/{id}` drops `catalogId` and `headers` — `routers/mcp.py:158`
Silent credential loss: saving an installed server's detail pane loses its
Authorization header, and a validation error leaves the server stopped with the
old config gone. Mutate the existing dict in place.

### 22. `/api/git` mutating routes accept any `repoPath`, contradicting `git_restore`'s docstring — `routers/git.py:96`
The docstring asserts a containment property the resolver does not enforce. (The
web drive-by vector is closed by `TrustedOriginGuard`; this is a
trust-the-docstring hazard.)

### 23. Rehydrated daemons lose `expires_at` — `daemon_manager.py:255`
The TTL reaper can never kill them; they resurrect every launch and
`list_daemons` reports a false `expires_in_s=0`. Stamp it in `rehydrate_from_db`
and call `_ensure_reaper()` there.

### 24. Cancelling a subagent job never stops the wave loop — `harness_jobs.py:208`
A multi-wave batch keeps spending model calls after the user cancelled, and the
job flips back to `completed`. Cancel the driver task handle and make
`finish_job`'s UPDATE refuse to overwrite a terminal status.

### 25. `finish_job` unconditionally resets `dirty=0` and blanks `error` — `harness_jobs.py:127`
Erases the `mark_dirty` "worker mutated the environment" receipt; the run is
reported clean after the fleet settles. Preserve with
`dirty = CASE WHEN dirty = 1 THEN 1 ELSE ? END`.

### 26. Same-named daemons spawned in the same second collide on id — `daemon_manager.py:138`
An unkillable, unlistable provider poller wakes every 30s and calls the model
forever, invisible to `kill`, `list_daemons` and `rehydrate`. Append
`uuid4().hex[:6]`.

### 27. Sub-agent narration-retry is unbounded on the recurring-task path — `subagent.py:918`
Unlike the parent loop, a recurring task that passes neither `max_iterations` nor
`harness_job_id` can loop narration retries indefinitely against the provider.

### 28. `browser_click` / `browser_type` / `browser_scroll` schemas advertise arguments their handlers reject — `browser/handlers.py:210`
Scroll-by-ref — the only addressing the compact snapshot provides — is
unrecoverable, and the error receipt re-advertises the exact argument that
caused the TypeError.

### 29. `browser_get_content` `markdown` duplicates `text` but stamps `format: markdown` — `browser/handlers.py:363`
The model believes it got a structured extract and silently loses link targets,
headings and table structure. Run the HTML through the existing
`html_to_markdown` helper.

### 30. `desktop_open_url` performs no URL validation — `desktop_automation.py:119`
The headless browser's allowlist/SSRF gates have no desktop counterpart, so
`file://` and intranet hosts open in the user's real browser in every guard mode
including the default `full`.

### 31. `_broadcastExit` drops the exit sentinel when a queue is full — `terminal_service.py:206`
The terminal WebSocket never closes; the drawer shows a live shell that already
died, and a reconnect gets 4004 instead of the real output. Mirror
`_broadcastTerminal`: evict the oldest, then `put_nowait(None)`.

### 32. `bulk read_files` object form bypasses `BULK_MAX_ITEMS` — `bulk_tools.py:63`
5000 simultaneous whole-file reads plus sha256 digests, while the report claims a
40-item cap. *`single-reviewer`*

### 33. Project-memory undo failure is swallowed by its own `except` — `rollback_store.py:222`
Reports `ok=True`, restores nothing, and burns the rollback entry so the user
cannot retry. *`single-reviewer`*

### 34. Missing `avr-objcopy` is reported as objcopy success (rc 0) — `firmware_tools.py:305`
`firmware_compile` then fails on a nonexistent `.hex` with an opaque errno instead
of the install guidance the module docstring promises.

### 35. `hdl_simulate` on the ModelSim path writes the log to a file it never reads — `hdl_tools.py:456`
A testbench whose `assert … severity failure` fired is reported as a passing run
with zero asserts. *`weakened`*

### 36. `hdl_test` counts a SKIP as a failure in `failed` and in the JUnit `failures` attribute while `ok` does not — `hdl_tools.py:1075`
A fully-skipped run reports `ok:True, failed:3`, and the JUnit XML's `failures`
attribute disagrees with its own contents — which CI readers trust.

### 37. `render_pages` serves a stale cached page for an in-place-edited image — `artifact_judge.py:171`
The acceptance verdict is taken against pixels no longer in the workspace, so the
model's repair loop targets an already-fixed file. Key `_cache_dir` on
`(src, st_mtime_ns, st_size)` as the PDF path already does.

### 38. `turn_end` reason `budget` is coerced to `undefined` — `streamEvents.ts:424`
The documented amber "budget reached" badge can never render, and a budget turn
logs a spurious schema-mismatch warning. Add `'budget'` in lockstep to the Zod
enum, the TS union and the dispatcher whitelist.

### 39. Paged `read_file` output cannot be copied into `edit_lines`' `old` anchor — `file_tools.py:263`
Every line is separated by a blank line, so the edit is safely rejected *and* the
closest-match hint never fires (score ~0.57 < 0.60 threshold) — a wasted round.
Join with `''` instead of `'\n'`.

### 40. `strip_tail_patches` cuts at the first tail marker anywhere in the message — `durability.py:57`
A user who asks about the `<memory>` block and puts the tag on its own line
silently loses everything from that point in the persisted session. Prefer the
recorded `_tailFrom` offset.

### 41. Multi-command `run:` blocks report only the LAST exit code under pwsh — `release-desktop.yml:118`
`uv lock --check` can fail silently in the one release gate with no equivalent
elsewhere — and it runs late, after the payload and `backend-runtime.stamp` were
already staged from the same lockfile. Mirror the `if ($LASTEXITCODE -ne 0) {
throw }` style the file already uses at `:35-36`.

### 42. Consolidation merge overwrites the survivor with a stale snapshot — `consolidation.py:418`
In a merge chain only the last pair's `(merged from: …)` note survives, so
provenance is lost.

## Low

### 43. Undoing a project-memory delete recreates the file with no frontmatter — `project_memory.py:342`
The memory loses its description/type and recall silently falls back to the full
body text. Carry `description` and `kind` in the before-snapshot.

### 44. Paged `read_file` results are cached under a key that can never be read back — `file_tools.py:272`
Paging a large file repeatedly evicts the real entries the 30s cache exists to
serve, with zero cache benefit. Dead code.

### 45. Terminal sessions 51-100 hold a live shell and are never listed or closable — `terminal_service.py:305`
Cycling "new terminal" accumulates up to 50 unreachable OS shells and ~12 MB of
unaddressable buffers with no UI path to reclaim them.

### 46. Browser and desktop screenshots accumulate without bound — `browser/handlers.py:60`
Neither folder is pruned, and `privacy.clearLogs` only removes
`data/observations/*.png`.

### 47. `browser_wait` implements a `load` strategy the schema enum omits — `browser/handlers.py:303`
Unreachable through the tool surface: a model that reaches for the natural
`strategy='load'` burns a round inventing a CSS selector instead.

### 48. The wave loop names every unnamed work item `"item_1"` — `spawn_subagents_tool.py:767`
Hardcoded index 0. In a two-item unnamed wave the second lane overwrites the
first's outcome entry, and `cancel_wave` finds no taskId for `item_2`.

### 49. `bumpVersion` does not strip the semver prerelease component — `release-desktop.mjs:82`
`npm run release:patch` from a prerelease checkout yields `0.18.NaN` and throws.
Hard-blocks the next desktop release.

### 50. The pre-commit ruff hook is pinned six minor versions behind CI — `.pre-commit-config.yaml:12`
A new rule added between 0.10 and 0.15 fires in CI and blocks releases while
being invisible to the developer running the documented commit gate.

### 51. The pre-commit ruff hook excludes `backend-py/scripts/`, but CI lints it — `.pre-commit-config.yaml:20`
A green local hook means ~30 migration/maintenance scripts have had no lint check
at all.

### 52. `recovery` and `subagentFanout` frames are accepted by the schema but have no dispatcher case — `streamEvents.ts:40`
Documentation drift only — every degraded emit site already ships an adjacent
warning frame, so no degraded turn renders as clean. *`weakened`*

---

## Recommended landing order

1. **`file_tools.py:593`** — one line, unblocks the core edit workflow.
2. **`workbench.py:5709`** — one predicate, closes self-deletion via `bulk` in every mode.
3. **`workbench.py:5039`** — one fallback, restores tool-result spilling on the OpenAI wire.
4. **`workbench.py:1669`** — one word; the daemon auto-turn feature is currently dead.
5. **`daemon_manager.py:255` + `:138`** — restore `expires_at`, make ids unique.
6. **`harness_jobs.py:127` + `:208`** — stop clobbering `dirty`; make cancel real.
7. **`workbench.py:2976`** — outdent the skill credit; auto-inject is off by default so this trains on nothing.
8. **`rollback_store.py:222` + `:236`** — let undo failures propagate; stop double-encoding.
9. **`routers/mcp.py:158`** — preserve `catalogId`/`headers` through PATCH.
10. **`scripts/release-desktop.mjs:82`** — strip the prerelease suffix; a release is blocked.

## Coverage gaps: where defects are most likely still hiding

The three areas whose guarantees are asserted but not mechanically enforced:

1. **Gate participation of every reachable tool entry point**, including bulk
   operation aliases. Enumerate every name in `tool_registrations/*`,
   `tools/*.py`, the `bulk_tools.py` operation literals, and the
   `desktop_automation` / `firmware_tools` handlers, alongside the args each
   `tool_policy.py` gate inspects. *Proof = a reachable entry point with zero
   gate hits, or an alias whose operation is never mapped to a gate, reproduced
   by calling it with an absolute path or external URL.*
2. **Backend-to-frontend wire contracts.** Diff every FastAPI response model and
   SSE emitter against the matching TS union in `streamEvents.ts`, and check
   every union member has an exhaustive switch case. Then GET-then-PATCH each
   mutable row (mcp, providers, sessions, agents) and diff key sets. *Proof = an
   emitted key missing from the TS type, a union member with no dispatch case,
   or a key present after GET and absent after PATCH.*
3. **Startup/restore versus write-path field parity.** For each subsystem that
   writes then reloads at launch — `daemon_manager`, `mcp_client`,
   `project_memory`, `sessions`, `harness_jobs`, learned skills — extract the
   field set from the writer and from the loader and diff. *Proof = a field
   written but absent at load, or a content-derived key with no uniqueness
   check, confirmed by a restart test that registers before reload and asserts
   the entity survives with identical fields.*

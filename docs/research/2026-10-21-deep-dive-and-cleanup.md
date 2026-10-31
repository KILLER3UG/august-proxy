# August Proxy — Deep-Dive & Cleanup Review

**Subject:** `C:\Dev\augustHarness` (August Harness)
**Revision reviewed:** `34fcf7240158dd3d0ef47318dd793fc6cd4161b1` ("fix(router): an unknown URL rendered a blank app, and the tree warned about it"), branch `master`
**Date:** 2026-10-21
**Mode:** read-only. Nothing in the repository was modified, staged, committed, or executed. No model calls, no app runs, no network egress, no dependency installs. The only file this review adds is this report - `docs/research/2026-10-21-deep-dive-and-cleanup.md`.

> **Note on a moving target.** While the review was in flight, another session committed the in-flight artifact work and advanced `master` to `cd976795` ("docs(roadmap): the reference's OWN capture of the same job"), two commits ahead of the revision this review was written against. The delta is `docs/ROADMAP.md`, `scripts/lint-budget.json`, and 9 files under `frontend/desktop/src` — **no backend change**. Every finding below was re-verified against `cd976795`: `proxy_tools.py:381` still calls `tool_registry.dispatch` directly, `exec.py:81` still returns for MCP before the hook emit at `:167`/`:173`, `needs_approval_in` still has zero call sites, and both `lib/produced-files.ts` and `lib/produced-artifacts.ts` still coexist. All findings stand. `origin/master` had also been updated to match.

## Resolution (2026-10-21, after the review)

The code items were acted on the same day; this section records what changed
so the findings above are not read as the current state.

- **Finding 1 (`/v1` bypass):** the proxy's managed tools now route through
  `loop/exec.py::_executeTool` with a synthetic session, so they get the
  PRE/POST hook stack, the stale-write hash gate and the tool timeout. The
  guard-mode/approval layer still does not apply: the proxy has no workbench
  session, and the gateway key is the boundary for that surface.
- **Findings 2 and 3 (MCP):** MCP calls no longer return before the hooks;
  they execute after PRE_TOOL_USE and go through POST_TOOL_USE and
  post-observation. Every `mcp__*` tool is classified as mutating, so plan
  and ask modes gate it.
- **Finding 4:** `needs_approval_in` was deleted and
  `docs/ARCHITECTURE_FLOW.md` now names `_checkToolGuard` as the live
  authority instead of concluding the guards are unwired.
- **Finding 7:** tool arguments (and message content) are scrubbed of this
  install's credential values at both brain-write boundaries, so a denied
  call's secret no longer becomes durable.
- **Finding 8:** the secret-guard matcher now covers `edit_lines`,
  `delete_file`, `move_file`, `mkdir` and every MCP tool.

**Owner decisions (2026-10-21):** keep Finding 5's `full` default, keep
Finding 6's soft Windows sandbox with AppContainer opt-in, and keep the
gateway key as the `/v1` boundary with the full tool surface. These are
recorded rather than silently changed.

The packaged NSIS update matrix remains unrun. It needs a throwaway Windows
account or VM by its own header, and 0.18.19 is the signed build to run it
against.

---

## 0. Scope, method, and limits

**Working-tree state at review time (untouched, and unrelated to this review).** At the moment the review began, `master` carried 8 modified files and 1 untracked file under `frontend/desktop/src/`, and was 57 commits ahead of `origin/master`:

```
 M frontend/desktop/src/components/chat/ArtifactCard.tsx
 M frontend/desktop/src/components/chat/CircuitArtifactCard.tsx
 M frontend/desktop/src/components/shell/RightDrawerFileSection.tsx
 M frontend/desktop/src/components/shell/RightDrawerState.ts
 M frontend/desktop/src/lib/circuit-artifacts.ts
 M frontend/desktop/src/lib/tool-summary.ts
 M frontend/desktop/src/sections/chat/message/AssistantBlockTimeline.tsx
 M frontend/desktop/src/sections/chat/message/AssistantMessageContent.tsx
?? frontend/desktop/src/lib/produced-artifacts.ts
```

That in-flight change is one feature: **produced-artifact collection plus an artifact caption** (a result-side collector in `lib/produced-artifacts.ts`, merged into `ArtifactCard.collectDeliverables`, with a new `artifactCaption` field on the right-drawer store). It is coherent and well-factored — see §B2 for one residual risk inside it. It was subsequently committed as `bdc3724d`, so the working tree is now clean apart from this report.

**The repository is being worked on concurrently with this review.** After the review completed, another session began editing `AGENTS.md`, `ActivitySummary.tsx`, `ArtifactCard.tsx`, `ChangesCard.tsx`, `lib/produced-artifacts.ts` and `lib/produced-files.ts` in the working tree. This review made none of those edits. Where the concurrent work intersects a finding, §B2 records the current state rather than the state at first read.

**Method.** Full read of `AGENTS.md` (812 lines) and the root guidance; a static import-graph reachability analysis over `backend-py/app` (344 modules); targeted reads of the agent loop, tool registry, permission layer, hooks, sandbox, prompt assembly, Tauri shell, CI workflows and every gate script; plus four parallel read-only sweeps (backend runtime · tools/permissions/security · frontend/Tauri/CI · docs/roadmap). Every finding below is anchored to `path:line`. Where I could not confirm something first-hand, it is marked **Unverified** with what would verify it.

**What this review cannot see.** No code was executed. Static gates cannot tell whether the app *starts*; `e2e:smoke` is the only floor under that and it covers the backend alone. The Tauri shell is never launched in CI, so the update flow, the installer's NSIS template, and the per-install token channel are all verified by reading, never by running. The `docs/UPDATE_VERIFICATION.md` matrix has not been executed.

**Size.** 1,761 tracked files: 380 Python, 507 TS/TSX, 155 Markdown, 5 Rust. ~118k lines of Python, ~125k lines of TypeScript. 1,760 commits since 2026-06-07 (~390/month, one author at 1,310 commits).

---

# PART A — DEEP-DIVE REVIEW

## A1. Architecture

A three-surface product with a Python core:

| Layer | Location | Size | Role |
|---|---|---|---|
| Desktop shell | `frontend/desktop/src-tauri/` | 5 Rust files | Tauri v2; spawns/owns the backend, owns updates, owns the per-install token |
| Frontend | `frontend/desktop/src/` | 507 files | React SPA — chat/workbench, settings, shell |
| Backend | `backend-py/app/` | 344 modules | FastAPI + the agent loop |
| Mobile companion | `frontend/mobile/` | 19 files | Expo app; phone pairing over LAN |
| EDA/circuit domain | `backend-py/app/services/tools/circuit_tools.py` + 9 siblings | ~470 KB | Live, registered domain (PCB/firmware/HDL/simulation) |
| Bench harness | `backend-py/app/bench/` + `scripts/bench/{pier,harbor}/` | ~40 KB | Headless eval runner, driven by external boards |

The app factory is `backend-py/app/main.py:435` with `lifespan=main.py:135`; 37 routers are registered at `main.py:530-574`.

**Verdict: a serious, well-conceived system with an unusually strong gate and documentation culture for a project of this velocity — and one structural pathology, described in A5.**

---

## A2. Task lifecycle

The end-to-end path, first-hand verified:

| # | Step | Location |
|---|---|---|
| 1 | UI → `POST /api/workbench/chat` | `backend-py/app/routers/workbench.py:475` |
| 2 | Route spawns a background task | `routers/workbench.py:63` `_startTurnTask` → stored at `:178` `_activeStreams[sessionId]` |
| 3 | → service entry | `routers/workbench.py:106` → `services/workbench/workbench.py:2213` `sendWorkbenchMessageStream` |
| 4 | → the real turn | `workbench.py:2419` `_sendWorkbenchMessageStreamImpl` — **one function, ~3,400 lines** |
| 5 | Session load/create | `services/workbench/sessions.py` (2,016 lines) |
| 6 | Prompt assembly | `workbench.py:2834` → `workbench.py:716` `buildSystemPrompt` |
| 7 | History snapshot + compaction gate | `workbench.py:2896`, `_shouldAutoCompact` `:1187`, compaction `:2943` |
| 8 | Provider resolution | `services/workbench/providers.py:355` `resolve_chat_llm`; per-model format `providers/api_format.py` |
| 9 | Upstream call | `providers.py:707`/`:502`/`:1060` → transport `providers/clients/base.py:540` `requestJson`, `:634` `streamSse`; body scrubbed at `:399` `wireBody` |
| 10 | Stream → SSE frames | `services/workbench/stream_translate.py:44`; error text `:21` `_errorEventText` |
| 11 | Tool dispatch | `services/workbench/loop/exec.py:58` `_executeTool` → `:196` `await asyncio.wait_for(dispatchTool(...))` → `services/tool_registry.py:625` `dispatch` |
| 12 | Re-prompt | back to 7/9 in the same function; `toolRound` counter at `workbench.py:3255` |
| 13 | Mid-turn persistence | `workbench.py:3807`/`:5025`/`:5722` `_flushSessionBarrier` → `services/workbench/durability.py` |
| 14 | Turn close | `services/workbench/turn_close.py:479` `persistAndClose`; `services/turn_outcomes.py:249` `record_turn_outcome` |
| 15 | Final response | `workbench.py:5858`; SSE `done` + stop-reason badge |

**Other entry paths.** SSE resume `routers/workbench.py:561`; cancel `:587` `POST /chat/stop`; steer `:1051`; queue `:1022`. Proxy adapters `routers/proxy.py:462` `/v1/chat/completions`, `:408` `/v1/messages`, `:497` `/v1/responses`, `:585` `/v1/models` — all `Depends(require_gateway_key)`. MCP door `routers/harness_mcp.py:165` `POST /mcp/harness`. Bot DM `services/bot_mode/dm.py:341`.

**The producer/consumer split is the right call.** `POST /chat` returns immediately and the client subscribes to a per-session event log (`GET /chat/stream`), which is what makes reconnect, cancel, and the phone companion possible without a second protocol.

**Structural note.** The `services/workbench/loop/` package (`exec.py`, `guards.py`, `recovery.py`, `events.py`, `prompt.py`, `surface.py`) is an extraction effort that was **never finished**. Those modules are helpers *called by* `_sendWorkbenchMessageStreamImpl`; the function body itself was not decomposed. A defect inside the un-extracted ~3,400 lines is invisible to every static gate in the repo.

---

## A3. Model interaction

- **Routing.** `providers/api_format.py` (195 lines) + `providers/model_resolver.py:70`. A provider-level format plus a **per-model** override, which is what makes a single OpenCode-Zen-style gateway serve Claude via `v1/messages` and GPT via `chat/completions` correctly.
- **Upstream body hygiene.** `models/openai.py:67` `dump_openai_upstream_body` (`exclude_none`; `:78` strips August-only keys) and `models/anthropic.py:61`. This is the fix for the 0.12.21 `session_id: null` incident, and it is applied in the workbench, the model Test button, and the `/v1` adapters — correctly, at a serializer layer.
- **Transport scrub.** `providers/clients/base.py:399` `wireBody` wraps both httpx sends (`:566`, `:661`), so the credential scrub covers every provider path. `adapters/base.py:18`'s raw-httpx `streamSse` has **no callers** today — a trap for the next one.
- **Prompt assembly** is genuinely well-built: XML-tagged segments, each conditional on the tools actually offered (`workbench.py:1111` `submit_clarify`, `:1113` bulk, `:1124` web, `:1128` memory-write), an `<intake>` manifest enumerating exactly what the context carries (`:851-998`), and a byte-stable `<session>` block (`:1020`) so provider prefix caching keeps working.
- **Cancellation** exists at `loop/exec.py:196` (tool timeout) and `routers/workbench.py:587` (`POST /chat/stop`).

**Gap.** `MAX_MANAGED_TOOL_ROUNDS = 0` (`workbench.py:93`) — **uncapped by default**. The only default bound is the stall counter, and the stall counter resets on argument novelty (`loop/guards.py:242` `_assistant_round_is_novel`). A model calling a different pathless tool each round never trips it. This matches AGENTS.md exactly and is a deliberate product choice, but it is the honest answer to "what stops a runaway turn": **the context window**.

---

## A4. Tools

~180 tools, registered once via `tool_registry.register(name, description, handler, schema)` across 19 modules under `backend-py/app/services/tool_registrations/`, entered at `tool_registrations/__init__.py:39` `register_all()`. **Schemas are not duplicated at registration** — that is the right design.

Progressive disclosure is real, not aspirational: `tool_search`/`tool_describe`/`tool_call` (`services/tools/tool_bridges.py:207-240`) reach tools outside the advertised slice, and `tool_call` re-runs `_checkToolGuard` (`:138`) before dispatching.

**The deny-set design is the strongest part of the security model.** Enforcement is a *deny set*, not a withheld surface (`subagent.py:316` `_workerDeniedNames` → `:725` → published at `:818` as `currentSubagentDenied` → read at `tool_bridges.py:156-165`). A spawned worker attempting `write_file` is blocked at `subagent.py:1242-1248`, before any dispatch. The full chain — `_lineageCeiling` (`:275`) → `deriveChildPermissions` (`agent_registry.py:228`) → `_effectivePermissions` (`:184`) → `_declaredPermissions` (`:147`) — fails **closed** on a lineage cycle and **open** on a dangling `parentId`, which is the correct reading in both directions.

---

## A5. Human control & permissions — the central finding

> **The safety guards are implemented in exactly one place, and at least three other execution paths do not go through it.**

The guards live in `loop/exec.py::_executeTool` (`exec.py:58-255`) and `workbench.py::_checkToolGuard` (`workbench.py:6189-6373`). `exec.py` enforces, in order: the stale-write hash gate (`:99-159`), **PRE_TOOL_USE hooks** (`:161-186`), the tool timeout (`:196`), **POST_TOOL_USE hooks** (`:202-224`), and `post_observation.capture_after_tool` (`:226-231`). The workbench layer adds `_checkToolGuard` and `_resolveCommandApproval` (`workbench.py:4938`, `:4960`).

Three paths skip that stack:

### Finding 1 — HIGH — the `/v1` proxy bypasses the entire guard stack

**Verified first-hand.** `backend-py/app/adapters/proxy_tools.py:381` calls `tool_registry.dispatch(registry_name, normalized)` directly. I read `services/tool_registry.py:625` `dispatch` end to end: it holds **no approval logic, no grant check, no timeout, and no hook emission** — its only special case is `run_command` in a daemon context.

The proxy's tool surface is bounded by `is_proxy_managed_local_tool_name`: web tools, `bash`/`shell`-family names mapped to `run_command`, and (only when the harness orchestrator is enabled) `HARNESS_PROXY_TOOL_NAMES`. So `run_command` **is** reachable through the proxy.

What is therefore **lost** on the proxy path: `_checkToolGuard` (all four guard modes), `_resolveCommandApproval`, tool grants, the stale-write hash gate, the PRE/POST hook engine — and therefore `secret_guard` (whose write-deny and read-redact live in that engine), the `asyncio.wait_for` tool timeout, and the `currentSessionId`/`currentToolUseId` ContextVars that carry session-scoped state.

What **still holds**: `sandbox/hardline.py:813` `check_hardline_command` is applied *inside* the `run_command` handler (`sandbox/backends/__init__.py:139`), so credential-path protection and the destructive-pattern rules survive. `{dataDir}/config.json` and `{dataDir}/secrets.json` are refused by absolute path (`hardline.py:253-272` `_august_secret_files`), so the gateway key cannot be exfiltrated via the shell.

**Severity: HIGH but gated.** Every `/v1/*` route is `Depends(require_gateway_key)` (`routers/proxy.py:462`, `:409`, `:445`, `:498`, `:586`), so this requires the gateway key. That key cannot be read by the agent (hardline blocks the data-dir stores), which closes the obvious escalation chain. What remains is that **a holder of the gateway key gets a strictly more powerful tool surface through `/v1` than the desktop UI grants**, with no approval, no timeout, and no hook enforcement. The credential scrub *is* duplicated correctly into this path (via `wireBody`); the execution guards are not.

**Fix (one line of structure):** route the proxy's managed-tool resolution through `loop/exec.py::_executeTool` instead of `tool_registry.dispatch`, so every gate applies by construction rather than by duplication.

### Finding 2 — HIGH — MCP tool calls bypass every lifecycle hook

**Verified first-hand.** `loop/exec.py:79-97`: the `isMcpToolName(toolName)` branch **returns** at `:83-87`, before the PRE_TOOL_USE emit at `:161`, the POST emit at `:202`, and the hash-anchored stale-write gate at `:99`.

Consequences: `secret_guard`, `sensitive_code`, and `blast_radius` never see an MCP call. And even if they did, `secret_guard._WRITE_TOOLS` (`:39-42`) is exact-name matching, so `mcp__<srv>__<tool>` would not match it anyway.

### Finding 3 — HIGH — MCP tools are never classified as mutating

`tool_policy.is_mutating` (`:347-383`) matches known names and markers only. An MCP tool name resolves to `False`, so neither `needs_approval_in('ask'|'plan')` (`:403-408`) nor `isPlanModeBlocked` (`:206-266`) gates it. **An MCP server can write or delete with no approval in any guard mode.** Combined with Finding 2, an MCP server is the one tool surface with neither a hook nor an approval.

### Finding 4 — LOW/MEDIUM — `needs_approval_in` is dead code, and there are two authorities for one policy

**Verified first-hand:** `grep -rn "needs_approval_in"` across the entire repository returns the definition at `backend-py/app/services/tool_policy.py:386` and **zero call sites in code**. Every other hit is prose in `AGENTS.md` or `docs/ARCHITECTURE_FLOW.md:198`.

The live mechanism is `_checkToolGuard` (`workbench.py:6189`) + `_resolveCommandApproval` (`:6116`), called at `workbench.py:4938`/`:4960`, `subagent.py:1303`, `kernel.py:847`, and `tool_bridges.py:138`. The approval system is real and working.

But `docs/ARCHITECTURE_FLOW.md:198` states the predicate "has no call site" and concludes "guard modes are stored on the session but no code path consults this predicate". That sentence is **true and dangerously misleading** — a reader concludes there are no approvals, when in fact there are, in a different function. The two authorities also disagree by construction: `_checkToolGuard` mixes `is_mutating` (edit mode) with `isPlanModeBlocked` (ask mode), so the same call can be answered differently by each.

**Recommendation:** delete `needs_approval_in`, and correct `docs/ARCHITECTURE_FLOW.md:198` to say the predicate was *superseded* by `_checkToolGuard`, not that guards are unwired.

### Finding 5 — MEDIUM — the default guard mode is `full`, so there is no human in the loop by default

`file_tools.py:1527` `normalizeGuardMode(... or 'full')`, and `tool_policy.py:401-402` returns `False` for `full`. Combined with Finding 3, an MCP write is unapproved regardless of mode, and a `full`-mode session approves everything.

### Finding 6 — MEDIUM — the Windows sandbox is soft by default

`sandbox/backends/__init__.py` selects the `windows-appcontainer` backend only on opt-in; otherwise `fallback.run_soft` enforces by *inspection in the parent*. The child process is not OS-confined. `run_command`'s first-word allowlist (`file_tools.py:55-112`) admits `bash`, `sh`, `pwsh`, `cmd`, `python`, `node`, `curl`, `wget`, `docker` — and the check is first-word only (`:1463-1474`), so `bash -c "<anything>"` passes the dangerous-substring list (`:1475-1502`) and `_destructive_rm` (`:127-148`).

### Finding 7 — MEDIUM-HIGH — tool arguments are persisted verbatim to the brain database

`providers.py:1017-1025`/`:1342-1350` place `json.dumps(parsedArgs)` into the assistant message's `tool_calls`; `services/memory_store/sessions.py:307-315` writes that into `messages.content`. `scrubOutboundBody` is **transport-only** (`secret_guard.py:321-344` → `base.py:399-430`), so a secret in a tool argument is stored **in plaintext** in the SQLite brain DB. It is stored even when the hook later *denies* the call, because the assistant message is persisted independently of the tool result.

**This is the one place secrets become durable**, and it is the cheapest high-value fix in the whole review: scrub at the `memory_store/sessions.py:307` write boundary.

### Finding 8 — MEDIUM — the `secret_guard` write matcher omits four mutating tools

`secret_guard.py:39-42` `_WRITE_TOOLS` covers `write_file|write_files|edit_file|create_file|create_files|run_command|…` but **not** `edit_lines`, `delete_file`, `move_file`, or `mkdir`. An `edit_lines` call carrying an identical secret to `edit_file` is therefore **not denied**.

### What is genuinely strong

- The **hardline sandbox** is unusually thorough. It matches on the token the shell *would follow*, not the string the model typed (`hardline.py:816`); it refuses credential stores **by directory, not by filename** (`:134-145`), because `config.json` is secret inside `.docker` and ordinary in any project; `{dataDir}/config.json` and `secrets.json` join by absolute path (`:253-272`). The reasoning is recorded in the docstring and it is right.
- The **outbound scrub** is correct and complete for provider traffic, matched **by value** rather than by pattern, with a hoisted stat (1.94 ms vs 419.6 ms per-leaf on a 641 KB body).
- **Provider keys** were migrated out of `providers.json` into the encrypted store (`provider_credentials.py:240-298`), with DPAPI via `ctypes` on Windows (`secret_store.py:38-47`).
- **Error strings** are scrubbed before persistence (`turn_outcomes.py:952-979`).

### Residual, defense-in-depth only

`secret_guard._PROTECTED_PATH_PATTERNS` (`:34-37`) covers `.env|providers.json|credentials|.ssh/|id_rsa|.aws/|.npmrc|.pypirc` but **not** `config.json` — the one file the codebase itself says holds the gateway key (`secret_guard.py:150-155`). The shell path is covered by hardline's absolute-path rule; the *read-tool redaction* path is not. Not a demonstrated exploit (the data dir is outside the workspace root by default), but the two lists should agree.

---

## A6. Memory & context

Solid, and better than most systems of this kind:

- **Store:** SQLite `august_brain.sqlite` (`services/memory_conn.py:21`, resolved through `lib/paths.py:14` `dataDir()`, honouring `HARNESS_DATA_DIR`).
- **Recall:** BM25 (`services/memory_store/memory.py`) plus a boot-time index for the top-scoring memories, injected as a `<memory>` block.
- **Provenance:** `services/message_sources.py:40` `MACHINE_SOURCES` + migration `049_message_source.sql`, so a bot-authored row can be told from a human one.
- **Compaction:** `services/workbench/context_compressor.py:17` `DEFAULT_HEAD_COUNT = 4`, `:19` `DEFAULT_SUMMARY_MARKER = '<<compressed_summary'`, `:66` `reliefStrategy`, `:796` `compressMessages`. The rotate arm is armed only when the brain key `contextReliefRotate` is set **and** a summary note already exists (`loop/recovery.py:134`) — so the first relief never rotates, which is correct: before a note exists, the verbatim head *is* the live task.
- **Durable failure lessons:** `services/turn_outcomes.py:1014` `maybe_promote_failure_lesson` / `:894` `_review_lesson` — a model-vetted self-improvement loop that AGENTS.md does not mention.

---

## A7. Skills & extensibility

Skills are a first-class surface: `skills/` ships 7 bundled skills (`anatomy`, `augustHarness`, `august-tools`, `charts`, `circuit-sim`, `hdl-fpga`, `math-animation`, `tutor`); project skills live under `<workspace>/.aug/skills/` with shadowing; bot skills are private per Bot; `load_skill`/`list_skills` resolve through the session's workspace and Bot root (`tool_registrations/skill_tools.py:31-35`). The prompt advertises only relevant skills, and `harness_guide_for` (`prompt_build.py:170`) filters the tool-directed half of the guide by the surface the model was actually offered — a bare surface gets no guide, which is right.

The **MCP door** is the weak point of the extensibility story, and it is Findings 2 and 3: MCP is the one extension surface with neither lifecycle hooks nor mutating classification.

---

## A8. Delegation

`subagent.py:369` `executeSubAgent`; deny-set and lineage ceiling as described in A4; `currentSubagentDenied` published at `:818`.

Bot-to-bot has its own ceiling, and the reasoning is unusually careful. `bot_mode/dm.py:59` `BOT_TURN_PREFIX` marks Bot-authored rows; `:198` `_turnAuthor` returns **three** values, not two, because a two-way read fails in the dangerous direction: compaction writes its `<<compressed_summary` block as a *user* row with no provenance, so a binary "Bot or human?" test would call it human and disarm the ceiling in exactly the long chats where compaction runs. Machine rows neither count nor reset; `queued_user` is deliberately excluded because it *is* the human typing mid-turn. The ceiling guards the **model's** send door, not the store — a human send is the reset, so gating it would be a lockout. `maxUnattendedTurns` absent/0 means off, and 0 must stay writable so an armed ceiling can be disarmed.

**One caveat:** the `/mcp/harness` route carries `sessionId` supplied by the caller, so the synthetic session it runs under **carries no guard mode or agent binding** — documented at `docs/API_REFERENCE.md:209`. It is behind the gateway key, and it is a deliberate capability, but it should be read as a documented residual.

---

## A9. Persistence & recovery

- Sessions and messages: `services/memory_store/sessions.py:199` `save_workbench_session_sot`, `:158` `SELECT … FROM messages`, `:147` `_claim_client_rows` (client-side message-id claiming for idempotent replay — AGENTS.md does not mention it).
- Turn ledger: `services/turn_outcomes.py:249` `record_turn_outcome`; end-reason vocabulary at `:76` `TURN_END_REASONS` = `finished|length|cap|stall-stop|budget|error|interrupted|awaiting-input` — exactly the eight the front-end badge renders. Migrations reach `046_turn_verdict_telemetry.sql` and `049_message_source.sql`.
- Retention: `turn_outcomes.py:621` `sweep_old_outcomes`, called from `memory_store/consolidation.py:1848`.
- Archive: `services/transcript_archive.py:23` `archive_messages` — nothing is deleted; every repair rung archives what it replaces.
- **Turn-end event:** `turn_end {reason, rounds, error}` is emitted every turn, so "why did it stop" is answerable from the session log before auditing code. This is the single best operability decision in the repo.

---

## A10. Reliability & performance

- **Context overflow is routed before shape errors.** `turn_outcomes.py:150` matches `context_overflow` *before* `bad_request` at `:156`, and the branch additionally refuses anything `_isContextOverflowError` claims — so a too-long prompt can never be routed into a history-reshaping repair. Correct.
- **The stuck-request ladder escalates across turns** off `turn_outcomes` (`loop/recovery.py:473` `_stuckRequestEscape`, `:343` `_requestStuckStreak`, `:383` `_isShapeRefusal`): first refusal left alone, second flattens the tool pairing into text while keeping the conversation, third sends only the newest ask, fourth fails honestly. Each rung archives first and emits `recovery {kind:'stuck-request', degraded:true}`.
- **One error-extraction bug worth naming:** `stream_translate._errorEventText` flattened a nested envelope — `as_str` returns `''` for a dict, so the standard `{"error":{"type","message"}}` shape was stringified to nothing and every consumer read `Stream error HTTP 400: ` with the reason discarded. It was fixed at the extractor rather than at the formatters, which is the right place: `classify_error`, the deterministic-400 replay decision, the ladder, and the user-facing receipt all read that one string.
- **Large tool results spill to disk** rather than being truncated (`loop/prompt.py:238` `spill_file_relpath`, `:268` `_spillToolResult`) — a real feature AGENTS.md does not document.
- **Per-model surface narrowing** (`loop/surface.py:130` `_modelCapabilityProfile`) narrows the tool set for weaker models.

---

## A11. UX & front-end

**Good:** the activity-line collapse is a render-time arrangement that survives reload (the transcript still stores one block per tool call), a run containing a failure opens by default and carries a "failed" marker, and a call awaiting approval or carrying an action widget stays on its own so it is clickable. `DisclosureRow` owns its body via `content`, so the trigger advertises a real `aria-controls` in both states — verified at all five call sites (`ChangesCard.tsx:267`, `ThinkingDisclosure.tsx:113`, `ToolCallItem.tsx:213`, `CompactionNoticeCard.tsx:78`, `HandoffNoticeCard.tsx:32`).

**Gaps found:**

1. `components/chat/ActivityGroup.tsx:66-120` — the group header carries `aria-expanded` (`:72`) but **no `aria-controls`**, and the body (`:123`) has no `id`. Inconsistent with `DisclosureRow.tsx:110-112`/`:158-162`, which owns both ids deliberately.
2. `components/chat/WorkingIndicator.tsx:127-134` — same defect on the todo pill (`aria-expanded`, no `aria-controls`; the panel at `:153` has no id).
3. `sections/exam/ExamBanner.tsx:176-202` — the dialog has `role="dialog"`, `aria-modal`, `aria-label`, an ESC handler (`:174`) and a labelled close button (`:187`), but **focus is never moved into the dialog on open nor restored on close**.
4. No inert `truncate` was found in the chat path (`ActivityGroup.tsx:90`, `WorkingIndicator.tsx:143,179,238` are all flex items or block-level), so `check:truncate` is doing its job.

---

## A12. Gates & CI

| Gate | Asserts | Cannot see |
|---|---|---|
| `check:docs` | 10 doc-vs-code assertions in 4 modes (`scripts/check-docs-sync.mjs:48-171`) | Any claim not in the assertion list. **It guards `AGENTS.md` and `docs/API_REFERENCE.md` only — not `README.md`, `ROADMAP.md`, `ARCHITECTURE.md`, or `GAPS_AND_BUGS.md`**, which is exactly where the wrong numbers live (§B3) |
| `check:design` | 7 regex rules diffed against `scripts/design-baseline.json`; fails only on *new* violations (`check-design.mjs:42-91`) | Baseline-recorded debt; `style={{…}}` held in a variable |
| `check:naming` | New camelCase params in `app/services/**` vs `naming-baseline.json` | Naming outside `app/services`; function names; the frontend |
| `check:api` | Regenerates OpenAPI in a throwaway data dir, diffs vs `docs/api/openapi.json` (`check-api.mjs:14-21`) | Routes absent from the schema |
| `check:api-index` | Regenerates `docs/API_INDEX.md`, fails on drift | `docs/API_REFERENCE.md` is hand-written and **not gated** |
| `check:sse` | 7 checks: emitters **discovered** by regex vs Zod literals vs dispatcher cases; plus **handler supply** — every `handlers.onX?.()` must be supplied as `onX:` and not acknowledgement-only (`check-sse-parity.mjs:216-278, 420-440`) | A supplied handler that renders nothing |
| `check:version` | 9 version sources compared against the **majority** (`check-version-sync.mjs:9-12, 21-84`) | Whether the version is the one you meant to ship |
| `check:doc-links` | Relative markdown links under `docs/` + root `*.md`, depth ≤3 (`check-doc-links.mjs:17-33`) | **Inline-code path citations** — the dominant citation style in this repo — and anchors |
| `check:minisign` | The `minisign-verify` crate's **own published vector**, synthetic round-trip, wrong-key and key-id refusal, and that `tauri.conf.json`'s pubkey equals the key hardcoded in `backend.rs` (`check-minisign.mjs:30-45`) | Whether the *published artifact* is signed with that key — the release job's job |
| `check:truncate` | TS-compiler-API AST: every `truncate` sits on an element that can truncate (`check-truncate.mjs:16-35, 53-80`) | A `truncate` on a flex item whose parent lacks `min-w-0` |
| `check:brain-config` | Asks the backend which keys it accepts and what ranges they take; 4 assertions on `TurnLimitsSection.tsx` plus a report-only pending list (`check-brain-config.mjs:30-43`) | Keys the panel never renders |
| `lint:ratchet` | Fails on any eslint error, or on warnings above `scripts/lint-budget.json` (`lint-ratchet.mjs:46-88`) | Rule coverage gaps. When the count is *below* budget it only prints a note — the ratchet tightens manually |
| `e2e:smoke` | Imports the real app, runs its lifespan, asks ~10 doors a question (6 read-only, 1 config write, the closed MCP door, the local door twice — without and with the per-install token); `HARNESS_DATA_DIR` → temp dir (`backend-py/scripts/e2e_smoke.py:1-45`) | **The Tauri shell, the frontend, the update path.** Backend-only, by its own admission |

**CI coverage.** `type-check.yml`: ruff, mypy, `check:naming`, `check:api`, `check:api-index`, `check:brain-config`, `e2e:smoke`, `check:version`, `check:docs`, `check:doc-links`, `check:sse`, `check:minisign`; then `check:truncate`, `build:web`, `gen:api` + `git status --porcelain`, eslint, `check:design`, `lint:ratchet`; then the mobile typecheck/parity job. `release-desktop.yml`: a clean-provenance check, 7 gates, frontend typecheck, `download:node-binaries`, `prepare-desktop-backend --release`, backend lockfile/lint/typecheck, `build:web`, `cargo fmt --check` + `cargo check --locked`, then publish.

**Not covered anywhere:** the Tauri shell is never *run* — `cargo check` compiles it, nothing launches it, and the NSIS template is never asserted. No `clippy`. **No `cargo test` — the 5 inline `#[cfg(test)]` blocks never execute.** Nothing verifies the published artifact's signature against the pinned key.

**One structural note on the gates:** `check:sse`'s handler-supply check and `check:brain-config`'s "ask the backend what it accepts" are the two most valuable ideas in this repo, because both catch a defect class that is *invisible to every other gate* — a handler that exists but does nothing, and a settings key the backend silently rejects. `check:docs` should be extended the same way (see §B7, action 8).

---

## A13. The Tauri update flow

**All four alignment conditions confirmed in code.**

1. **`/UPDATE /S` → `reinst_done`.** `backend.rs:2491` (`/UPDATE`), `:2494` (`/S`); NSIS parses `/UPDATE` → `$UpdateMode=1` (`installer.nsi:563-566`) and routes `Goto reinst_done` (`:380-382`), bypassing the uninstaller branch (`:408-421`). `check:docs` pins the flag pair.
2. **Waiter scheduled before the installer.** `hooks/useAppUpdate.ts:209` `await schedulePostUpdateRelaunch()` precedes `:214` `await invoke('launch_installer_and_exit', …)`; Rust spawns a detached `powershell.exe` (`backend.rs:2065`, `:2132`).
3. **Marker written unconditionally; `ExecShell` skipped under `/UPDATE`.** `hooks.nsh:136-138` writes `$INSTDIR\.august-update-complete` with no `$UpdateMode` guard; `:149-157` wraps `ExecShell` in `${If} $UpdateMode = 0`.
4. **Waiter waits for the scheduling pid; the stale marker is deleted at schedule time.** `backend.rs:2090` `let old_pid = std::process::id();`; the script breaks on that pid at `:2107`; the marker is removed inside the scheduling call at `:2096-2097` — **not by the waiter**; the 180 s deadline always relaunches (`:2105`, `:2126-2129`).

`wipeStaleTree` refuses any target outside `backend-runtime/` before any filesystem call (`backend.rs:626-637`) — a runtime guard, not a static one.

**Not verified:** the flow on a packaged NSIS install. The 5 inline Rust test blocks cover instance-lock PID matching (`:2788`), payload-copy filtering (`:2825`), `wipeStaleTree` refusal/fallbacks (`:2910`), sandbox env forwarding (`:3110`), installer signature decoding (`:3195`), and port probing (`:3249`) — **none touches `schedule_post_update_relaunch` or `launch_installer_and_exit`**. The *ordering* of schedule-vs-launch lives only in TypeScript, and no static gate reads `useAppUpdate.ts`. `docs/UPDATE_VERIFICATION.md` is the check, and it has not been run.

---

## A14. Roadmap vs reality

`docs/ROADMAP.md` (732 lines) is a live, honest status document. I verified 24 sampled claims: **18 CONFIRMED, 6 WRONG, 4 STALE** — two of the stale ones being self-contradictions *inside the same file*.

Confirmed and worth calling out: the `/mcp/harness` gateway gate (`routers/harness_mcp.py:166` `Depends(require_gateway_key)`); `board_list`/`board_flash`/`board_monitor` all shipped (`firmware_tools.py:944, 1035, 1115`); `board_flash` *is* confirm-gated (`tool_policy.py:256` in `_PLAN_BLOCKED_EXACT`, with `circuit_add_board` at `:245` — "the same trap caught a second time, independently", as the roadmap says); exactly 80 `Si*` icons in `lib/icons.tsx`; `ExploreGroup` fully gone; `MAX_MANAGED_TOOL_ROUNDS = 0`; the 5 Rust test blocks; `contextReliefRotate` semantics.

**The roadmap's own honesty is a point in the repo's favour** — it lists "no test suite restored", "no history rewrite (85.6 MB Node binary)" and "`data/` untouched (1.58 GB)" as *deliberately not done*.

---

# PART B — CLEANUP REVIEW

Every item carries a disposition (**KEEP / UPDATE / MERGE / ARCHIVE / DELETE**) and a confidence (**SAFE / NEEDS CHECK / RISKY**). "SAFE" means I verified zero inbound references or a clean mechanical removal; it does not mean "I ran it and it worked", because nothing was run.

## B1. Dead code — DELETE (all SAFE unless noted)

| # | Target | Evidence | Disposition | Confidence |
|---|---|---|---|---|
| 1 | `backend-py/tag_context.txt` — **80,039 bytes, tracked in git** | `git grep -F tag_context` → **zero hits repo-wide**. It is a dump of source excerpts with no consumer | DELETE | **SAFE** — the clearest single win; it also directly violates the repo's own "no `_*.py` / `*.txt` scratch artifacts" rule |
| 2 | 13 tracked `backend-py/scripts/_*.py` probes | `_audit_tool_registry.py`, `_check_fts_query_hygiene.py`, `_check_phase4_indexes.py`, `_diff_memory_store_conflicts.py`, `_fix_parametrize_names.py`, `_list_api_paths.py`, `_live_db_fingerprint.py`, `_merge_memory_blob_conflicts.py`, `_pass2_drop_camel_tables.py`, `_prove_fts_column_bug.py`, `_recover_auto_mem_conflicts.py`, `_split_memory_store_package.py`, `_spotcheck_schema.py`, `_verify_fts_sync.py` | DELETE | **SAFE** — every reference is in a *document* (`docs/ARCHITECTURE.md`, `docs/REFACTOR_PROGRESS.md`, `docs/GAPS_AND_BUGS.md`, `docs/archive/…`); **5 of them are referenced by nothing at all**. `_` is literally the repo's own scratch marker |
| 3 | `scripts/e2e_smoke.py` (root, 8,950 B) | `scripts/run-python.mjs:75` resolves the target as `resolve(root, 'backend-py/scripts', script)` → the root copy **never runs**. The live file is `backend-py/scripts/e2e_smoke.py` (13,762 B). The root copy is a stale older implementation (urllib to `127.0.0.1:18999`, requires `HARNESS_DATA_DIR` at import) | DELETE | **SAFE** |
| 4 | `frontend/desktop/src/components/chat/DocumentBadge.tsx` | `git grep DocumentBadge` → only its own definition + a doc mention in `lib/file-kind.ts:21` | DELETE | **SAFE** |
| 5 | `frontend/desktop/src/components/chat/ProjectRulesBadge.tsx` **+ `lib/project-rules.ts`** | `ProjectRulesBadge` appears only in itself; `lib/project-rules.ts` is imported **only** by it → transitively orphaned | DELETE | **SAFE** |
| 6 | `backend-py/app/lib/api_envelope.py` (1,332 B) | Only references are `docs/archive/REMAINING_WORK_PLAN.md:203` and `docs/archive/BETTER_HARNESS_PLAN.md:1293,1566` — an **archived** plan for a migration that was never completed | DELETE | **SAFE** — or ARCHIVE with the plan if the envelope idea is still wanted |
| 7 | `backend-py/app/lib/error_messages.py` (4,220 B) | Only reference: `docs/archive/BETTER_HARNESS_PLAN.md:1157` | DELETE | **SAFE** |
| 8 | `backend-py/app/services/workbench/kernel.py:404` `reap_idle_warm_kernels` | Whole-tree grep returns only the definition; `kill()` already pops the entry, so the reaper is redundant | DELETE | **SAFE** |
| 9 | `backend-py/app/services/workbench/kernel.py:456` `clear_bridge_tokens` | No caller in `backend-py/`, contrast `issue_bridge_token`/`revoke_bridge_token` (used at `workbench.py:2171,2175,2183,2207`) | DELETE | **SAFE** |
| 10 | `backend-py/pyproject.toml:154` `"tests/**"` ruff ignore | No `tests/` directory exists — the suite was removed 2026-10-17 | DELETE | **SAFE** |
| 11 | `needs_approval_in` (`backend-py/app/services/tool_policy.py:386-409`) | Zero call sites repo-wide | DELETE | **SAFE** as code — but **first** correct `docs/ARCHITECTURE_FLOW.md:198` so the docs do not keep asserting a false conclusion |
| 12 | `backend-py/app/adapters/base.py:18` raw-httpx `streamSse` | No callers; a future caller would bypass `wireBody` and the credential scrub entirely | DELETE | **NEEDS CHECK** — it is a trap rather than dead weight; deleting it removes the trap |
| 13 | `frontend/desktop/vite.config.ts:32` `recharts` string | `recharts` appears only as a **string** in the config, never as an import | UPDATE | **SAFE** |

**Already fixed — do not redo.** Of the eight modules the 2026-08-11 sweep called "imported nowhere", **six are gone** (`memory_curator`, `memory_retention`, `knowledge_tree`, `cross_session_bridge`, `fuzzy_match`, `skill_manifest`). `memory_quality` (4 importers) and `tool_bridges` (1 importer) are now live. The old sweep's remaining named items `code_map` and `worktree_service` each have exactly 1 importer and are reachable.

**Verified NOT dead — do not delete.** `app/bench/*` (~40 KB) is driven by `scripts/bench/pier/run.sh:27` and `scripts/bench/harbor/run.sh:33` via `python -m app.bench`. `app/review_cli.py` is a documented CLI gate (`python -m app.review_cli --repo . --base HEAD`). `frontend/desktop/src/components/chat/ToolCallItem.tsx` is a **barrel** re-exporting `./tool/ToolCallItem`, not a duplicate. `sections/settings/IntegrationDirectoryModal.tsx` is a one-line shim used at `IntegrationsSection.tsx:18`. The whole EDA/circuit domain is **live and registered** (`tool_registrations/circuit_tools.py`).

## B2. Duplicates — MERGE / NEEDS CHECK

| # | Target | Evidence | Disposition | Confidence |
|---|---|---|---|---|
| 1 | **Residual key-normalisation mismatch** between `lib/produced-files.ts` and `lib/produced-artifacts.ts` | The *duplicate rule* was collapsed during this review by the concurrent session: `produced-files.ts` now imports `producedFilePath` from `produced-artifacts.ts` and its own copy is gone ("ONE implementation … they agreed by luck"). **The dedupe keys still disagree**: `produced-files.ts:29` uses `path.replace(/\\/g,'/').replace(/\/+$/,'')` — slash-normalised and trailing-slash stripped, but **case-sensitive**; `produced-artifacts.ts:108` and `:233` use `path.replace(/\\/g,'/').toLowerCase()` — slash-normalised and lowercased, but **no trailing-slash strip**. So `C:\Src\File.ts` and `c:/src/file.ts` are different keys to the two collectors, and `…/File.ts/` differs from `…/File.ts` in the artifact collector | MERGE the key function | **NEEDS CHECK** — the rule is shared but the *keys* are two spellings of one path; on Windows, case alone can put one file in two cards |
| 2 | `zod` version skew | Root `package.json:45` `^3.25.76` vs `frontend/desktop/package.json:52` `^3.23.8`. Sole consumer `src/api/schemas/workbench.ts:15`. In an npm workspace the root range wins the hoist — **the installed version and the declared one disagree** | UPDATE | **NEEDS CHECK** |
| 3 | Python `httpx` + the whole dev block declared twice | `pyproject.toml:11` (runtime) vs `:49` (dev); `[project.optional-dependencies] dev` (`:43`) and `[dependency-groups] dev` (`:103`) list the same nine entries | UPDATE | **NEEDS CHECK** — lockfile-gated |
| 4 | Two authorities for the approval policy | `tool_policy.needs_approval_in` (dead) vs `workbench._checkToolGuard` (live) | DELETE the dead one | **SAFE** (see B1 #11) |

## B3. Stale documentation — UPDATE / ARCHIVE

### The wrong numbers (verified first-hand)

The settings registry is the source of truth: `frontend/desktop/src/settings/settings-registry.ts:157-956` declares **45** sections with **45 distinct ids** — **19 `tier: 'basic'`, 26 `tier: 'hidden'`**. Three documents disagree with each other *and* with the code:

| Location | Claims | Truth | Disposition | Confidence |
|---|---|---|---|---|
| `docs/ROADMAP.md:171` | "26 of 44 … (18 basic, 26 hidden)" | **45 / 19 / 26** | UPDATE | **SAFE** |
| `docs/ARCHITECTURE.md:529` | "43 sections — 17 `basic` and 26 `hidden`" | **45 / 19 / 26** | UPDATE | **SAFE** |
| `docs/GAPS_AND_BUGS.md:73` | "43 tiered sections (17 `basic`, 26 `hidden`)" | **45 / 19 / 26** | UPDATE | **SAFE** |
| `docs/research/august-frontend-ui-audit.md:188` | stale hidden ids | — | UPDATE | **NEEDS CHECK** |
| `README.md:235` | "**eight** sources must match" | the gate has **9** (`check-version-sync.mjs:23,28,33,38,47,58,63,68,82`) | UPDATE | **SAFE** — `AGENTS.md:836` already says "All 9 sources", so README contradicts AGENTS.md |

### Roadmap self-contradictions — UPDATE (all SAFE)

- `ROADMAP.md:178` says a finished turn's todos are rendered nowhere; `ROADMAP.md:318-319` says they render in the layout-level Workbench sidebar. **Both are wrong**: todos render in the right drawer — `RightDrawerTasksSection.tsx:40`, mounted at `RightDrawer.tsx:495`. `ChatThreadMessagePane.tsx:348` gates the *working-indicator strip*, not the todos.
- `ROADMAP.md:179` calls `store/promptCacheLive.ts` and `store/contextSectionsLive.ts` dead context stores; `ROADMAP.md:262-271` says each has exactly one reader. **Both are wrong**: `ContextUsageReadout.tsx:35-36` imports both.
- `ROADMAP.md:175` / `:321-325` say the sidebar separator has no `tabIndex`/`aria-valuenow`; `useResizablePane.ts:138-145` sets `role='separator'`, `tabIndex:0`, `aria-valuenow/min/max`, and `:153` an `onKeyDown`. The item is **done**, not open.
- `ROADMAP.md:174` says the backdrop has no Escape handler and no focus trap; `Backdrop.tsx:142-164` has the ESC handler and `:133` calls `useFocusTrap`. **Done, not open.**
- `ROADMAP.md:176` cites `ClarifyTool.tsx:258` for `aria-modal="false"`; it is now at `:267`.
- `ROADMAP.md:172` cites `AssistantMessageContent.tsx:158`/`:182` for the `N t/s` and `answered via` readouts; the `N t/s` readout is **gone** (`:165-181` documents its removal) and `answered via` is at `:214`.

### Orphan documents — ARCHIVE (all SAFE; zero inbound references)

`docs/UI_UX_DEEP_DIVE_2026-10-15.md` · `docs/DEEP_SCAN_FINDINGS_2026-09-27.md` · `docs/BRANCH_RECONCILE_2026-10-14.md` · `docs/plans/2026-10-10-full-coverage-continuation-plan.md` · `docs/plans/AUGUST-UI-ENHANCEMENTS.md` · `docs/plans/2026-09-01-memory-enhancements.md` · `docs/plans/2026-09-01-messaging-gateway.md` · `docs/plans/2026-10-15-harness-reference-dsbot-abacus.md` · `docs/plans/2026-09-06-august-0.13-opensandbox-roadmap.md` · `docs/ui-refactor/**` (3 files) · `docs/superpowers/specs/**` (22 files)

**Superseded documents that are still indexed — ARCHIVE:** `docs/settings-audit.md` (still cited by `settings-registry.ts:8,10,144`) · `docs/SETTINGS_UX_REDESIGN.md` · `docs/FEATURE_INVENTORY_TEST_MATRIX.md` (every suite it maps is deleted) · `docs/plan-cross-map-2026-09-01.md` (self-declares "its own file inventory is out of date") · `docs/REFACTOR_PROGRESS.md` + `docs/REFACTOR_HANDOFF_PROMPT.md` · `docs/CHANGES_AUDIT_PASS_2026-08.md` · `docs/audit-2026-08/` (6 files) · `docs/AUDIT_RECOMMENDATIONS_2026-08-11.md` · `docs/CHAT_UI_DEEP_DIVE_2026-08-23.md`

**MERGE:** `docs/AUDIT_REPORT_REVIEW_2026-10-01.md` (228 lines of verdict on one report) → `docs/AUDIT_REPORT_2026-10-01.md`.

**KEEP — the live spine:** `ROADMAP.md` · `ARCHITECTURE.md` · `ARCHITECTURE_FLOW.md` (+ `architecture-flow.html`) · `API_REFERENCE.md` · `API_INDEX.md` (generated) · `CONFIGURATION.md` · `TROUBLESHOOTING.md` · `DEVELOPER_GUIDE.md` · `SETUP.md` · `SKILL_AUTHORING.md` · `LAN_ACCESS.md` · `UPDATE_VERIFICATION.md` · `HARNESS_AND_MEMORY_DEEP_DIVE_2026-10-17.md` (cited by `decision_ledger.py:3`) · `docs/releases/**` · `docs/archive/**` (the archive policy is sound — move things *there*) · `docs/plans/2026-10-14-harness-ui-claude-parity.md` · `docs/plans/2026-10-20-after-this-round.md` · `docs/plans/2026-09-05-harness-maintenance.md` (the source of the naming rule)

### Dead citations to removed tests — UPDATE (SAFE)

The repo's own rule says `tests/…` paths are historical, and `AGENTS.md` acknowledges its 8 such citations. But two live source comments still cite deleted test files as if live, which is the pattern `check:doc-links` cannot catch:

- `backend-py/app/services/workbench/loop/surface.py:13` — cites `tests/test_part26_wave2.py` and `tests/test_workbench_tool_loop.py`, both deleted.
- `docs/DEVELOPER_GUIDE.md:261,314,315` — cites `tests/test_providers.py`, `tests/test_gateway_base.py`, `tests/test_gateway_telegram.py`.

**No "Part 28+" violation was found.** `grep "Part ?(2[89]|[3-9][0-9])"` returns only `AGENTS.md:89` (the rule's own example) and `docs/plans/2026-09-05-harness-maintenance.md:196-197` (the rule's record). The "Part 1–27 is closed" rule is honoured. ~60 source comments still carry Part citations, which the rule permits as historical record.

### `CHANGELOG.md` and `docs/DOCUMENTATION.md` — UPDATE (SAFE)

- `CHANGELOG.md` is hand-written and 957 lines, but its oldest entry is `0.13.0 (2026-08-08)` while the app is at **0.18.18** — it does **not** cover 0.13.1–0.18.18. It has **four stacked "Unreleased" headings** (L3, 84, 112, 178, 223). It *does* correctly record the test removal ("627 deletions") and the verifier removal.
- `docs/DOCUMENTATION.md` (94 lines) is the index but omits `LAN_ACCESS.md`, `ARCHITECTURE_FLOW.md` and the 7 surviving plans, and `:67` says "Parts 15–27" when the series is 1–27 and closed.

## B4. Dependencies — DELETE / UPDATE

| Dependency | Evidence | Disposition | Confidence |
|---|---|---|---|
| **`react-icons`** (`frontend/desktop/package.json:44`) | All 11 repo-wide hits are **comments** in `lib/icons.tsx`, `lib/file-icon.ts`, `lib/tool-icon.ts`. `lib/icons.tsx:7` explains the icons were inlined deliberately because the barrel is "one 4.9 MB module holding ~3,000 icons" | DELETE | **RISKY** — genuinely dead, but removing it is a `package-lock.json` change, which AGENTS.md treats as release-gating |
| `vitest` (:80), `@playwright/test` (:58), `@axe-core/playwright` (:56), `jsdom` (:72), `@testing-library/jest-dom` (:60), `@testing-library/react` (:61) | Zero importers; no `**/*.test.*` or `vitest.config.*` exists; `backend-py/tests` and `frontend/desktop/e2e` do not exist; no script references them | DELETE | **RISKY** — same lockfile caveat. AGENTS.md explains they were retained because `uv lock --check` and the npm lockfile gate the release job |
| `playwright` (:73) | Sole consumer `frontend/desktop/scripts/capture-screenshots.mjs:6`; no npm script, no CI calls it | UPDATE | **NEEDS CHECK** — manual tool, not dead |
| `types-requests`, `types-PyYAML` (`backend-py/pyproject.toml:52-53`) | Neither `requests` nor `yaml` is imported anywhere in `backend-py`, nor declared as a runtime dep | DELETE | **SAFE** |
| pytest dev group (`pyproject.toml:44-48`, `:104-108`) | Every `pytest` hit in `app/` is a *string* in production code (`edit_verification.py:159-168` detects the user's own runner). No import | DELETE | **RISKY** — deliberate per `pyproject.toml:94-98`; lockfile-gated |
| `zod` skew | see B2 #2 | UPDATE | **NEEDS CHECK** |

**Used but undeclared: none.** Every backend import maps to a declared dependency, and every frontend runtime dependency has an importer (`react-router-dom` `main.tsx:6`, `react-query` `:7`, `framer-motion` `:8`, `sonner` `:9`, `zustand` 14 stores, `clsx`+`tailwind-merge` `lib/utils.ts:2-3`, `xterm` `BottomTerminalDock.tsx:22-23`, `uplot` `CircuitInstruments.tsx:13`).

## B5. Scripts — KEEP / ARCHIVE

**All 13 gate scripts are wired and live** (B1 §A12 table). `scripts/minisign-verify.mjs` deserves particular credit: it is checked against the `minisign-verify` crate's **own published vector**, so a signer and a verifier cannot agree on a mistake — the failure mode that made the original gate green while verifying the wrong format.

**Orphan scripts:**

| Target | Evidence | Disposition | Confidence |
|---|---|---|---|
| `scripts/e2e_smoke.py` (root) | see B1 #3 | DELETE | **SAFE** |
| `scripts/bench/harbor/` | Only self-references (`config.template.json:6-7`); no npm script, no CI | ARCHIVE | **NEEDS CHECK** — may be an intentional external harness |
| `backend-py/scripts/` — 20 non-`_` one-off migration/probe scripts (`migrateDbColumns.py`, `snakeToCamel.py`, `snakeToCamelMulti.py`, `merge_dual_schema_tables.py`, `replace_any.py`, `harness_eval.py`, `e2e_smoke.py`, `doctor.py`, `export_openapi.py`, …) | Mixed: `e2e_smoke.py`, `doctor.py`, `export_openapi.py`, `brain_config_probe.py` and `harness_eval.py` **are** referenced by npm scripts or CI; the migration one-offs are not | DELETE the unreferenced ones | **NEEDS CHECK** — the set is 20 scripts and needs one-by-one reference checking |
| `scripts/install-git-hooks.ps1`, `scripts/ensure-toolchain.sh` | Documented manual tools (`.pre-commit-config.yaml:5` commented out; `docs/DEVELOPER_GUIDE.md:75`; `docs/CONFIGURATION.md:910-914`) | KEEP | **SAFE** |
| `frontend/desktop/scripts/{capture-screenshots,count-warnings,show-warnings}.mjs` | Manual; no npm script, no CI | KEEP | **NEEDS CHECK** |
| `frontend/desktop/scripts/make-lab-pdf.cjs` | Its output is **committed and consumed** by `src/pages/design-lab-pdf.ts` and `DesignRoute.tsx:635` | **KEEP — must not be removed** | **SAFE** |

## B6. Tree hygiene — all strays are gitignored, but two deserve action

Verified against `.gitignore`; **none of these are tracked**, so none is a git-level leak:

| Artifact | Present | Ignored | Assessment |
|---|---|---|---|
| `backend-py/tag_context.txt` (80 KB) | yes | **no — TRACKED** | **Action required** — see B1 #1 |
| `backend-py/scripts/_*.py` (13) | yes | **no — TRACKED** | **Action required** — see B1 #2 |
| `tmp_rename_camel.py` | yes | `:134` | `.gitignore:135-139` names it as the sanctioned scratch pattern — leave it |
| `august-worktree-branches-20260925_0104.bundle` (55 MB) | yes | `:144` (`*.bundle`) | Not a credential leak, but **a bundle is the whole repo in one file** — it carries any secret ever committed. It belongs outside the working tree. `.gitignore:142-143` shows this is known |
| `.coverage` (root, 102 KB) + `backend-py/.coverage` (110 KB) + `.pytest_cache` + `.pytest_tmp` | yes | `:44`, `:43`, `:123` | Stale leftovers of the deleted suite; no coverage config remains (`pyproject.toml:94-98`). Safe to delete, harmless to keep |
| `tauri-signing.key` / `.pub` | yes | `:99`, `:100` | **The private key is in the tree.** `with-tauri-signing.ps1:11-19` reads it at signing time and never writes it — so it is the user's own working copy, correctly ignored. **Do not commit it**; consider moving it outside the repo |
| `.env` | yes | `:2` | Real credentials present locally (incl. `GATEWAY_API_KEY`), correctly ignored. Safe from commit; unsafe if the tree is zipped or copied |
| `data/` | yes | `:27` | Holds `providers.json` (provider API keys), `config.json`, `august_brain.sqlite*`. `scripts/desktop-backend-payload.mjs:38-54` refuses to stage exactly these names into a shipped payload — that guard is real and worth keeping |
| `web-dist/` | yes | `:15` | Build artifact |
| Root dot-dirs `.aug` (4.3 MB), `.opencode` (55 MB), `.tools` (42 MB), `.qoder`, `.workbuddy-ai`, `.zcode`, `.freebuff`, `.commandcode` | yes | untracked | Local agent-tool state, not repo content. `.cursor/` holds 1 tracked file. Leave them |
| `host_files/` | yes | tracked (`host_files/.gitkeep` only) | A tracked empty placeholder directory with no consumer — **ARCHIVE** (SAFE) |
| `frontend/mobile/.claude/settings.json`, `frontend/mobile/CLAUDE.md` | yes | tracked | Tool-specific config shipped inside a product folder — **ARCHIVE or relocate** (NEEDS CHECK) |

**No test files remain anywhere in the repository** — `git ls-files` for `*.test.*`, `*.spec.*`, `__tests__/`, `tests/` returns **0**. The CI step `npm run test -w frontend/mobile` is *not* a test suite: `frontend/mobile/package.json` defines `"test": "npm run typecheck && npm run audit:parity"`. Consistent.

---

## B7. Prioritized manifest

### Batch 1 — Security, highest value first (small, well-scoped)

| # | Action | Files | Size | Confidence |
|---|---|---|---|---|
| 1 | Route the `/v1` proxy's managed-tool resolution through `loop/exec.py::_executeTool` instead of `tool_registry.dispatch`, so approval, grants, timeout, and hooks apply by construction | `adapters/proxy_tools.py:381`, `adapters/openai.py:185` | ~1 h | SAFE (structural) |
| 2 | Move the MCP branch **below** the hook emits in `exec.py`, and add an `mcp__*` rule to `tool_policy.is_mutating` so MCP writes require approval | `loop/exec.py:79-97`, `tool_policy.py:347-383` | ~2 h | SAFE (structural) |
| 3 | Scrub tool arguments at the persistence boundary — `messages.content` should never store a secret in plaintext, and the assistant message is written even when the hook denies the call | `services/memory_store/sessions.py:307-315` | ~1 h | SAFE |
| 4 | Extend `secret_guard._WRITE_TOOLS` to `edit_lines`, `delete_file`, `move_file`, `mkdir` | `services/hooks/secret_guard.py:39-42` | 15 min | SAFE |
| 5 | Delete `needs_approval_in` and correct `docs/ARCHITECTURE_FLOW.md:198` to say the predicate was *superseded* by `_checkToolGuard`, not that guards are unwired | `tool_policy.py:386-409`, `docs/ARCHITECTURE_FLOW.md:198` | 30 min | SAFE |
| 6 | Add `config.json` and `secrets.json` to `secret_guard._PROTECTED_PATH_PATTERNS` so the read-redaction list agrees with hardline's absolute-path rule | `services/hooks/secret_guard.py:34-37` | 15 min | SAFE |

### Batch 2 — Numeric truth in the docs (3 files, 5 edits)

| # | Action | Files | Confidence |
|---|---|---|---|
| 7 | Set the settings count to **45 sections / 19 basic / 26 hidden** in all three places; fix README "eight sources" → **nine**; bump the example tag `v0.18.16` → `v0.18.18` | `ROADMAP.md:171`, `ARCHITECTURE.md:529`, `GAPS_AND_BUGS.md:73`, `README.md:235`, `README.md:247` | SAFE |

### Batch 3 — Roadmap self-contradictions (1 file, 4 edits)

| # | Action | Files | Confidence |
|---|---|---|---|
| 8 | Reconcile the todos contradiction (`:178` vs `:318-319`) and the context-store contradiction (`:179` vs `:262-271`); mark the sidebar separator (`:175`, `:321-325`) and the Backdrop (`:174`) **done**; fix the stale line refs at `:176` and `:172` | `docs/ROADMAP.md` | SAFE |

### Batch 4 — Delete tracked scratch (zero-risk, immediate)

| # | Action | Files | Confidence |
|---|---|---|---|
| 9 | Delete `backend-py/tag_context.txt` (80 KB, 0 references) and the 13 tracked `backend-py/scripts/_*.py` probes — this makes the tree comply with the repo's own "no `_*.py` / `*.txt` scratch artifacts" rule | `backend-py/tag_context.txt`, `backend-py/scripts/_*.py` | SAFE |
| 10 | Delete the stale root `scripts/e2e_smoke.py` duplicate; delete `DocumentBadge.tsx`, `ProjectRulesBadge.tsx`, `lib/project-rules.ts`, `app/lib/api_envelope.py`, `app/lib/error_messages.py`, `kernel.py:404`, `kernel.py:456`; drop the `tests/**` ruff ignore | see B1 | SAFE |

### Batch 5 — Document hygiene (13 orphans + 1 merge + 1 superseded set)

| # | Action | Confidence |
|---|---|---|
| 11 | Move the 13 zero-reference docs to `docs/archive/`; merge `AUDIT_REPORT_REVIEW_2026-10-01.md` into `AUDIT_REPORT_2026-10-01.md`; archive the 10 superseded-but-indexed docs; rewrite `docs/DOCUMENTATION.md` as a real index; collapse `CHANGELOG.md`'s four "Unreleased" headings and extend it to 0.18.x | SAFE |

### Batch 6 — Gate hardening (the highest-leverage change in the whole manifest)

| # | Action | Why |
|---|---|---|
| 12 | Add a `count` mode to `check:docs` that counts `tier: 'basic'`/`tier: 'hidden'` in `settings-registry.ts` and asserts the figure in **all four** docs, plus the version-source count in **README** (currently only `AGENTS.md` is asserted) | Every wrong number in §B3 was one a regex could have caught. This is the same trick `check:brain-config` already uses — ask the code, assert the doc — and it is the pattern that has already caught live bugs |
| 13 | Add a `check:doc-links` pass that resolves **inline-code** path citations in `docs/` and `AGENTS.md` | `check:doc-links` only sees `[]()` links, but this repo cites paths as inline code. That single gap is why `surface.py:13` and `DEVELOPER_GUIDE.md:261` still cite deleted tests |
| 14 | Add a CI assertion that no doc cites a `tests/…` path as *live*, with a dated allowlist for the historical ones | Closes the class, not the instance |

### Batch 7 — Deferred / needs a decision (do not batch these)

| # | Action | Why it is deferred |
|---|---|---|
| 15 | Remove `react-icons` and the vitest/playwright dev block | Lockfile-gated (release job). Worth doing in one deliberate lockfile PR with the reasoning recorded in `CHANGELOG.md` |
| 16 | Merge `lib/produced-files.ts` into `lib/produced-artifacts.ts` | Inside the uncommitted work; the two dedupe keys differ, so it is a behaviour decision |
| 17 | Decompose `_sendWorkbenchMessageStreamImpl` (~3,400 lines) | Large, risky, and only worth it when something concrete is being changed there. Extract the loop-state locals first (`workbench.py:3255-3314`) |
| 18 | Run `docs/UPDATE_VERIFICATION.md` on a packaged NSIS install | Needs a real machine and a real signed build. This is the only unverified item in the update promise, and it is the whole promise |
| 19 | Move `tauri-signing.key` and the 55 MB bundle outside the working tree | Correctly ignored, but a bundle carries every secret ever committed, and a private key inside a working tree is one `git add -f` away from being committed |

---

## What I would do first

**Batch 4, then Batch 1.** The tracked scratch files are zero-risk deletions that make the tree comply with the repo's own stated rule — do them in a single commit. Then Batch 1, because the three HIGH findings share one root cause: **the safety-critical guards live in one function and three other paths reach the tool registry without passing through it.** The fix is structural, not a checklist — route every path through `exec.py` and the class closes permanently. The individual MCP items (2 and 3) are the smallest high-value change in the manifest and can ship today.

**One caveat worth repeating:** the single largest thing this review could not see is whether the app *starts*. The static gates are excellent and the `e2e:smoke` floor is well-designed, but `e2e:smoke` exercises the backend only — the Tauri shell, the frontend, and the update path are verified by reading only. Item 18 is the most important line in this document.

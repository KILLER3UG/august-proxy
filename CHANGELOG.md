# August Proxy — Changelog

## 0.16.6 (2026-08-23)

**Self-improving harness — the model can now inspect and improve its own harness**

- `harness_introspect` tool: read-only aggregation of the registered tool surface (health, bucket counts, >300ch descriptions), skills catalogue + real usage telemetry, memory-store sizes, active brain-config knobs, latest golden-eval results, recent curation-ledger entries, and open proposals. The model sees what was previously operator-only.
- `harness_propose` tool: files a structured improvement proposal (`problem / evidence / proposal / rollback / kind`). Proposals land as `data/harness_proposals/*.json`, emit a brain SSE event, and are **never applied by the model** — approval runs one deterministic applier (`brain_config` patches via `validatePatch`; skill create/patch/delete via `skill_service`), everything else is recorded for human implementation. Every decision lands in the curation ledger. Endpoints: `GET /api/brain/harness/proposals`, `POST /api/brain/harness/proposals/{id}/decide`.

**Claude-style recall ritual (P1)**

- Turn 1 always recalls when any headroom exists — under pressure the LIMIT shrinks (floor 1) instead of dropping to zero (`_shouldAutoRecall` + `_probe_recall_limit`). Later turns stay cadence/probe-gated, but probe messages now recall under any pressure.
- Probe-triggered recalls are cached per session (`_probe_recall_cache`) so repeated "what did I say about X" turns refetch nothing.
- Always-visible memory pointer line in `<runtime_context>`: store size + newest ledger entry ("harness last change") so recall is never silently absent.

**Mid-task persistence nudge (P2)**

- Once per turn, from tool round ≥4, when recent user messages carry a correction/preference pattern and no `remember` call happened: a bounded `<memory_nudge>` rides in the last tool result suggesting one `remember()` capture. Suppressed under high/critical pressure.

**Prompt hygiene (P4) + tool registry**

- `<bulk_tools>` / `<web_research>` blocks are injected only when the corresponding tools are offered; `<clarify_policy>` stays unconditional on purpose (submit_clarify is loop-intercepted, not registered — documented).
- Descriptions trimmed ≤300ch: `remember`, `customize_ui`, `setup_provider`. New tools classified in `tool_policy` (`harness_introspect`=read, `harness_propose`=write).

**UI (Hermes/DeepSeek-aligned minimal pass)**

- Context ring popover gains an indented **MCP tools** sub-row; backend reports `mcp_tools` / `estimated_mcp_tokens` split. Fixed latent bug: `/capabilities` served snake_case but the client destructured camelCase — `toolTokenEstimate` never actually reached the UI until now (normalized in `WorkbenchClient.listCapabilities`).
- Git review pane (right drawer → diff): new commit composer with **Generate message** (drafts from the working-tree diff via `/btw` on the session's own model) and Commit action.
- Tasks drawer is now an interactive checklist: click/Enter toggles done via `PATCH /api/workbench/todos`, optimistic update with rollback on failure.
- Knowledge graph gains All / Learned / Recent scope pills (backend `?filter=` keeps agent-authored or last-7-days entities).
- Find-in-transcript verified already shipped (`InThreadSearch`, ⌘F + match navigation) — no rework needed.

**P0 fixes landed this round (verified against HEAD)**

- Truthful shell grounding on Windows: Tier 2 now says cmd.exe (+POSIX shim note) instead of PowerShell (`context_builder._osShellLine`).
- False `archive_skill` ledger entries fixed: curator refusal returns `False` → `deleteSkill` fallback reachable, no phantom `removed` counts (`memory_review.py`).
- Checked-off todos no longer re-save + re-embed every turn forever (`auto_memory.extractAndSaveTodos` gates on actual state change).

**Validation:** ruff ✓ · mypy 19 errors (baseline 20 — none introduced) · targeted backend suites 84 passed (recall/self-improve/curation/todos/routes) · vitest 773/773 · tsc clean · build:web ✓

## 0.16.5 (2026-08-21)

**Harness — well-structured like Hermes**

- **Full-result blob**: `subagent_runs.result_full` 20k + `data/cache/delegation/<taskId>.jsonl` live transcript (`GET /{taskId}/transcript`); drawer survives LRU/restart, no clipped Markdown.
- **Queued/stalling states**: `queued` with `queuePosition/queueTotal`, `stalling` (>90s no `touch`) + `lastActivityAt/apiCalls/iterations`; `AgentGlyph` clock for queued, amber `stalling · no progress`.
- **Well-structured config**: per-session `delegation {maxConcurrent, maxIterations, maxDepth, worktreeIsolation}` in `workbench.metadata` (`GET/POST /api/subagents/config`); `spawn` caps depth to `maxDepth` (leaf) and `maxIterations` defaults if `0`.
- **Drawer-only simplicity**: `SubagentLaunchList` pill removed from transcript; `ChatRunHeader` trimmed to 4 segments (Mode · Wave · live · ctx); worker detail only in right-drawer `Subagents` (roster + live timeline + persisted final + steer + `Harness` config + `Goal` card).
- **TimelineRail**: ≥5 prompts → slim rail with `Open in sidebar` → virtualized jump.
- **Artifacts gallery**: `lib/artifacts.ts` + `RightDrawerArtifactsSection` (files/images/links) with debounced search (200ms) + Enter jump, kind pills; `collectProducedFiles` reused.
- **Tracer fixes**: `021_subagent_full_result.sql` migrates existing DBs; `summary 500→4000`, `error 500→2000`; `terminate` appends `subagentDone` to transcript.

**Settings — 8 hubs, not 32 rows**

- `general/intelligence/tools/activity/security` → 8 hubs: System, Appearance, Models, Memory, Automations, Tools & Skills, Access, Insights — each hub stacks only its related sections as pill tabs (one active tab, no long scroll). `LEGACY_HUB_MAP` keeps old deep links; `Show advanced` toggle removed.
- `WorkspaceShell` rail now 8 hubs (`Activity/Palette/Boxes/BrainCircuit/Bot/Wrench/ShieldCheck/LineChart`); search bypasses hubs.
- Dark palette deepened to reference black: `background #0F0F0F`, `card #171717`, `sidebar #141414`, `border #262626`.

**Chat polish**

- Empty `ChatEmptyState` starter templates: Standup Git Summary / CI Failures / Create PowerPoint (like Z.ai) → `dispatchInsertComposerText`.
- `ChatThreadComposer` `Cmd+Shift+Space` quick-entry; `ComposerToolbar` `ContextRing 22px` + `pct%` label + `Artifacts` chip; `CommandPalette` `Recent chats` 8 sessions.
- `ThinkingDisclosure` + `ToolCallItem` `memo` for 60fps; `PANEL_MS 220→180ms`.

**Validation**: `build:web` ✓ · `773/99` vitest ✓

## 0.16.4 (2026-08-15)

Harness teammate pass — specialists, routines, attention, and a stacked composer so named work can keep going in the desktop app.

**Playbook lanes**
- Specialists (ask / ping-on-fail / keep going), routines saved from episode cards, Auto-Continue on silent completed lanes (capped hops), workspace-bound playbook, cancel-wave, last command/exit on the run header.

**Attention & idle**
- Inbox states working / needs you / unread; mark-read on open; workers badge is needs-you + running. Silent hops and scheduled routines pause after 24h idle until you send again. Cron + Pause on routines. Save skill from an episode (`lane-*`). Search across lanes, episodes, and routines.

**Composer**
- Decision stack (review / distill / pins / proposals). Distill Keep/Discard per item. `@lane:` continues a thread; `@routine:` runs a routine. Lane continue/done toasts, bell, and OS notify when the window is hidden.

**Motion**
- Live answers fade the growing tail (~140ms) without re-animating settled paragraphs; a light settle fade when the turn ends. Left and right sidebars open/close with a short width + fade (220ms). Honors reduced motion.

## 0.16.2 (2026-08-13)


Smoothness pass — cheap live markdown, terminal reconnect resume, line-buffered commands, and regression coverage for the cancel/progress paths.

**Live markdown is now incremental (A.1)**
- While streaming, `ChatMarkdown` splits the growing document at blank-line boundaries (fence-aware), renders every completed block **once** into a cache, and re-parses only the still-growing tail block each flush. Each block is its own keyed element with a cached `dangerouslySetInnerHTML` object, so React skips untouched blocks entirely — the whole-tree re-parse + DOM replace on every ~32ms flush is gone.
- The settle pass still produces the exact full-markdown parse (with highlight.js colors), so final output is byte-identical to before.
- **Measured:** growing 17KB stream, 120 flushes — 1373ms (full parse + whole-tree replace) → 249ms (block-cached incremental), **5.5× faster** (`ChatMarkdown.perf.test.tsx`).

**Terminal reconnect no longer duplicates history**
- Every WS reconnect previously replayed the full session buffer, duplicating the whole transcript under the grey "connection lost" line. The backend now tracks a monotonic `streamLen` and replays only the client's unseen suffix based on the `?offset=` the client sends (code-point counts match Python `len()` even for non-BMP chars; truncation-safe).

**run_command streams C program output (C.2)**
- `prefix_line_buffering()` wraps simple external commands with `stdbuf -oL -eL` on Unix when available — pip/npm/C progress lines now stream live instead of block-buffering until the command exits. Conservatively skipped for Windows, shell builtins, assignment prefixes, and the bwrap/seatbelt paths.

**New regression coverage** (all previously untested paths)
- `test_outer_task_cancel_kills_child` — chat Stop's cancel kills the child process, not just the asyncio task.
- `test_generic_tool_heartbeat` + `test_run_command_idle_warning` — eval-loop tests for the "Running…/Still working…" beats and the closed-stdin warning (heartbeat intervals extracted to constants so tests shrink the windows).
- `test_ddgs_subprocess_killed_on_timeout` — the isolated DDGS search subprocess is hard-killed on timeout.
- `test_resume_*` ×5 + `test_append_output_tracks_stream_len_*` — offset-based terminal reconnect math.
- `test_prefix_line_buffering_*` ×3 — stdbuf wrap/guard decisions.
- `session-stream-store.test.ts` ×3 — persist debounce coalescing + flush-on-end.
- `ChatMarkdown` +2 — append-only block rendering and fence-safe splitting.

Status ledger: `docs/SMOOTHNESS_PLAN_STATUS.md`.

## 0.16.1 (2026-08-12)

Release-notes feature pack — new features + reliability fixes across the harness, automations, sessions, and documents.

**New features**
- **PowerPoint element commenting** — two new workspace-bound tools: `pptx_list_elements` (slides + element ids/names/types/text/positions with stable `cNvPr` ids) and `pptx_comment` (adds an OOXML comment anchored at the selected element's position, author "August"). Hand-rolled `zipfile`+`lxml` — no python-pptx dependency; all five OOXML parts (comment list, author list, content types, presentation + slide rels, `cmAuthorLstIdLst`) are wired and verified by tests.
- **Headless sessions skip memory extraction** — automation-triggered workbench jobs run leaner: background review, auto-memory sync and diff learning are skipped (sidebar titles still generate); the flag persists across restarts.
- **GitHub MCP plugin sources** — `install_mcp_server` and `/api/august/tools/manage` accept `owner/repo` (or a github.com URL, optional `#ref`): git clone when git exists, otherwise the codeload tarball is downloaded and extracted over HTTP — public plugin sources install correctly even without Git. Entry-point detection (`dist/index.js` → `index.js` → …) registers the server as `node <entry>` with a best-effort `npm install`.

**Bug fixes**
- **Compacted usage details restore after restart** — per-turn usage is now attached to the persisted assistant message (the SSE `done` event is volatile, so usage chips vanished on a fresh load) and compaction aggregates the removed region's usage into the summary message.
- **Corrupted task index auto-recovery** — a corrupt `scheduled-jobs.json` / `automations.json` is backed up to `*.corrupt-<ts>` and the app starts with a clean index instead of silently losing the jobs or re-failing every boot.
- **Remote sessions resend missed updates after reconnecting** — the per-session SSE event log is now durable (JSONL under `data/event_log/`): after a backend restart, `sinceSeq` replays rehydrate from the file tail with seq continuity, so disconnected sessions catch up instead of losing updates.
- **Automation cancellation, limits, partial creation** — new `POST /api/automations/{id}/cancel` cancels the background workbench task and records a `cancelled` run; optional `maxRuns` auto-disables a job once the limit is reached (`limitReached` surfaced, further runs refused up-front); typed jobs missing their payload (workbench without a prompt, shell without a command, http without a url) now fail loudly with a 400 instead of landing as silent no-ops.
- **Provider quota errors stop retrying** — 402 and quota-marked failures (`insufficient_quota`, "payment required", "exceeded your current") are no longer treated as transient, so retries stop burning budget on billing failures (the generic "billing/credits" hint in August's own empty-response error stays retryable).
- **AI responses consistent across retries** — streamed text is buffered per attempt and flushed only when the attempt succeeds; a failed attempt no longer leaves partial `finalOutput`/`thinking` in the UI before the retry re-streams (no more duplicate/garbled answers).

**Validation:** 16 new tests (OOXML round-trip, tarball install, JSONL replay + torn-line tolerance, quota classification, headless round-trip, corrupt-index recovery, maxRuns/cancel/validation) · full backend suite green.

## 0.16.0 (2026-08-12)

Full-repo 12-agent audit sweep closed out: 1 CRITICAL + ~18 HIGH + ~30 MED/LOW findings fixed across every layer. Full report: `docs/audit-2026-08/SWEEP-2026-08-11.md`.

**Proxy adapters (CRITICAL)**
- Non-streaming `/v1/messages` → OpenAI upstreams returned EMPTY responses (the translator read the choice dict instead of `choices[0].message`) — now reads the nested message and both camel/snake spellings, with regression tests.
- Non-streaming responses re-snake-cased at the endpoint boundary (external clients were getting camelCase); responses-format models on `/v1/messages` fail loudly as intended; empty reasoning keys no longer leak upstream; images translate to valid data URIs both directions; `/v1/responses` `input` translates system→instructions / tool→function_call_output; Anthropic→OpenAI emits real tool_calls (never a bare `finish_reason: tool_calls`); prompt-cache breakpoints apply after tools attach; tool-loop round-2+ bodies keep sampling params and deep-None-strip; Anthropic client sends `x-api-key`; stream token accounting covers OpenAI-style usage keys.

**Harness**
- `get_session()` prefers the dispatch ContextVar — with 2+ open chats, `update_state`/verifier receipts/scratchpad/agent-mode no longer land on the wrong session (verifier gate verdicts, stall detection, routing evidence fixed).
- Malformed tool args can never execute as `{}` (Anthropic stream path + text protocol closed); verifier gate: receipts survive mid-turn plan-mode rebuilds, withheld answers are recorded as losses not wins, force-release is per-turn, auto-run skips cancelled turns; Stop no longer persists dangling tool_calls; JSON-aware model-visible truncation; per-turn refusal counters; documented 25-round cap is real again.

**Workbench services**
- Session delete cancels ALL in-flight work (chat turns, orchestrator tasks, watchers, recurring subagents) and detaches env-watcher threads; debounce snapshot race closed + flush on shutdown; status survives restart; sub-agent cap-breaks report failed/partial; fallback config can't override model pins; evals use throwaway sessions; terminal commands run in the session's cwd and exited sessions reap; AppleScript injection closed.

**Sandbox / tools**
- Read-only sandbox blocks interpreters (`python -c` / `node -e` could mutate anything) and scans interpreter payloads + env-var tokens (`$HOME/x`, `%USERPROFILE%`) against the workspace containment rule; child processes no longer inherit credential env vars; code mode enforces sandboxMode; `edit_lines` preserves EOF; browser: SSRF gate (private/loopback/metadata blocked), tight allowlist matching, no `--no-sandbox`, sessions closed on delete; `desktop_screenshot` writes files instead of corrupting multi-MB base64; bridge tools (`tool_call` etc.) actually execute; current-session deletion blocked in every guard mode.

**Memory**
- `brain_query` FTS+filters fixed (was a bindings crash); near-duplicate writes carry the newest text; pinned memories survive cap eviction; durable-only recall falls through correctly; LIKE wildcards escaped; FTS hyphenated queries split; migration 007/failure tracking; unique keys under concurrency; graph eviction cascades.

**MCP / connections / hooks / automations**
- MCP stdio procs reaped, legacy-SSE transport made protocol-correct (persistent reader + id correlation), `Mcp-Session-Id` captured, sessions terminated on stop; Google OAuth tokens refresh (was silently breaking ~1h after connect) with degraded status; OAuth callback requires exact state; hooks fail CLOSED on PRE exceptions; blast-radius scans non-blocking; interval automations can't fire every tick; curator dry-run param honored; skill names validated against path traversal.

**Security / surface**
- `/v1/models` is gateway-key-gated like every other `/v1/*` endpoint; FastAPI `/docs` off by default; `/api/mcp-env` masks secrets; error responses stop leaking `str(exc)`; profile summary edits survive.

**Frontend**
- SSE seq pairing fixed (reconnect replays gone); failed tools render red; memory/subagent-retry events reach the UI; Zod schemas match real payloads; no ghost bubbles / duplicate sends; deleted sessions can't resurrect transcripts; verifier shield works on turn 1; terminal Run works; 752 vitest tests + tsc clean.

**Desktop shell / release**
- Port fallback + identity-checked health; async restart (no UI freeze); stale-runtime re-bootstrap; stamp only after healthy; scoped orphan sweep; installer port kills ownership-scoped; tag-push releases publish (updater sees them); docker mount + healthcheck fixed; dead launchers removed; Python ≥3.12 enforced on the system-python fallback. `cargo check` clean.

**Validation:** backend ruff/mypy clean · 1495+ pytest (57.8% cov) · frontend 752 vitest + tsc clean · `cargo check` 0 errors · all 7 version sources synced.

## 0.15.0 (2026-08-11)

Full-repo audit delivery: 6-agent scan closed out — subagents usable end-to-end, proxy adapters hardened, harness self-tuning loops closed, spend guardrails, and a big UX pass.

**Subagents — usable end-to-end**
- One spawn tool (`spawn_subagents`) for single/batch/blocking; recursion guard + real runtime depth cap; HTTP launches stream into chat (session-bound); `yieldSchema` failures report `failed`; stream-rule/stall/compaction parity with the parent loop; per-row Stop + Stop-all; resume-by-task-id; composer spawn modal with advanced options (context, restricted tools, yieldSchema, model override, proposed mode).
- The inline Cursor-style launch list (dead code) is mounted in the transcript; the no-op approval stub is deleted.

**Proxy adapters**
- Schema-safe case converters (JSON Schema payloads no longer renamed); `tool_calls`/`toolCalls` dual-read (non-streaming managed tools restored); `message_stop` buffered between rounds; multi-round streaming loop; malformed tool JSON never executes as `{}` (all paths); `tool_result` role wrapping; timing-safe gateway auth; request-log secret sanitization; 400 for non-object bodies; `strict: null` omitted; usage keys normalized.

**Harness self-tuning**
- Routing wins exclude refusals/thinking-only/tool-error + verified tiebreak; epsilon-greedy exploration; two-way capability auto-detect with auto-apply/auto-revert experiments (`AUGUST_AUTO_PROFILE=1`); reversible in-turn downgrade; verifier reviewer sees receipts; bounded verifier retries with force-release; recovery steer with inferred commands; landmark-preserving compaction; `edit_lines` precision tool with line anchors; model-family `<IMPORTANT>` blocks; protocol few-shot exemplars; empty-response retry; tool-execution timeouts; code-mode `result` capture; per-model pricing (`cost_estimator`) powering the spend ceiling + usage cost.

**UI/UX**
- Compare action on messages (Arena lanes), History browse route, notes→memory promotion, capability probe with one-click apply, cost-ceiling chip, eval drill-down, wired File/View/Help chrome, themed context ring, lazy settings sections, sidebar aria-current, modal Escape coverage.

**Validation:** backend ruff/mypy clean · 1440+ pytest · frontend tsc clean · 738 vitest.

## 0.14.0 (2026-08-10)

Personal-assistant memory, harness model-agnosticism, and cache observability.

**Memory — a real user model**
- Deterministic preference capture: "I prefer X" / "my favorite Y" / "never Z"
  folds into the user profile the same turn (no LLM); communication-style
  inference; structured `<user_profile>` prompt block; stale facts excluded.
- In-chat 🧠 memory notices when August remembers / updates / forgets /
  learns a preference.
- Memory browse by project (Settings → Project Memories); `source_session_id`
  serialized + folder/session filters.
- Vector hybrid recall (FTS + embeddings); consolidation sleep cycle archives
  stale auto-memories (deterministic guard + timeline trail); per-model
  memory injection budgets (32k gets half of a 128k model's payload);
  `session_topics` finally written; cross-session recall in memory_search +
  recent-chat titles in Tier 3.

**Harness — handles every model**
- Text tool protocol: `toolSurface='text'` or automatic downgrade after a
  second refusal — non-tool-calling models work via `[TOOLCALL] name|json`.
- Tolerant JSON salvage (fences/prose/truncation) before self-heal rounds;
  sub-agent malformed-JSON parity; refusal detection with one reminder retry.
- Graded turn outcomes (error | refusal | thinking_only | tool_error |
  verified | ok) feeding routing evidence; per-turn trace store + model drift
  alerts; per-model capability fingerprints → automatic profile suggestions.
- Universal prompt caching: Anthropic `cache_control` breakpoints on every
  Anthropic-format call; OpenAI-compatible prefix stability; cache hit rate
  captured from both wire formats and shown in the context ring.

**Chat UX**
- Streaming scroll fix: you can scroll up and read while the model works.
- In-thread search jumps through the virtualizer; error blocks gain
  Retry / Switch model; styled confirm dialogs everywhere; grouped task
  sections; @conversation mentions; sub-agent reasoning effort; recurring
  tasks with custom models; automation minute presets + model/agent display;
  reconnect transcript hydration (no more blank conversations).

**Under the hood**
- Tool-loop caps wired (`maxWorkbenchToolLoops`), fallback-chain wire-format
  recompute, hardline `sed -i`/`find -delete` guard, sandboxed cron jobs,
  verifier asymmetries fixed, npm audit critical fixed (desktop workspace 0
  vulnerabilities), pytest-timeout, ~60 new tests.

## 0.13.1 (2026-08-09)

Bug fixes and pipeline completion since 0.13.0:

**Context & warnings**
- Fixed the false "⚠️ Context window nearly full" alarm — the backend emits a
  `contextPressure` frame every turn as a live meter; the warning now appears
  only on genuine high/critical pressure (a fresh session no longer screams
  "999,805 tokens left").
- SSE `lastSeq` is persisted by the per-turn stream consumer, so reconnects
  (mid-stream reload, auto-turns) resume from the right position instead of
  replaying from zero.

**Sub-agents**
- Background sub-agent completions that settle after the parent turn now
  trigger a coalesced, capped auto-turn — the parent model actually receives
  the result instead of waiting for the next user message.
- Live sub-agent output (text / tool calls / tool results) streams to the
  chat instead of only start + done.
- `subagentStart` carries the parent tool-use id, so nested checklist rows
  render under the parent tool call.
- Honest statuses: `error` / `blocked` / `partial` / `recovered` pass
  through instead of masquerading as `completed`; failure reasons are shown.
- `spawn_subagents(mode='proposed')` shows an inline approval bar above the
  composer (Launch / Reject).
- Provider calls and orchestrator slots have timeouts — hung workers can no
  longer block all spawns forever. Clean tool-only sub-agents no longer
  tally as failures. API agent jobs appear in the Runs tab. Recurring-task
  sub-agents are concurrency-capped.
- Durable per-session SSE subscriber wired (subagent/browser/queue events
  stay visible across tab switches; app-global focus/visibility resync).

**Sessions & modes**
- `agentMode` (chat/agent/code) and `turnCount` persist across restarts.
- Entering plan mode no longer permanently clobbers the agent role — it is
  stashed and restored on exit.
- Queued messages drain in arrival order (steers no longer jump the queue at
  send time; steer priority is applied when the turn is formatted).
- Stop button no longer inserts a dummy user turn on idle sessions.
- Removed the inert automatic sub-agent git-worktree creation (tool dispatch
  is workspace-bound); the manual worktree endpoint remains.
- Interactive terminal input in a workspace-bound terminal gets the same
  soft sandbox as one-shot commands (navigation and single-token inputs
  pass through).

**Integrations**
- MCP servers can now be edited in place (`PATCH /api/mcp/servers/{id}` +
  Edit-config form in Settings → Integrations); add/remove/start/stop were
  already available.

**Performance**
- Backend cold start: `httpx` is fully lazy-imported (zero imports while
  the app module loads).
- Frontend bundle: katex, xlsx, xterm, highlight.js, marked/mammoth and
  zod/zustand split into their own cached chunks — the main entry dropped
  from 2.58 MB to 0.69 MB.

**Reliability dashboard**
- Harness eval pass-rate trend strip (per-day bars) above the eval history,
  alongside the existing Run-now button and 6h auto-run loop.

**Internal cleanup**
- UTC-consistent cutoffs in memory lifecycle / friction / trends (were
  naive-local ISO compared against SQLite UTC timestamps — shifted windows).
- Skill quality scoring parses epoch-float and ISO timestamps (effectiveness
  and freshness previously never scored).
- Removed the legacy `/api/subagents/stream` endpoint, worker dead-letter
  bus topics, and the dead SubagentPanel/useSubagentStream frontend chain.
- Cron parsing consolidated onto one implementation; duplicate `_BRAINStores`
  catalog removed.
- Release script prefers the current-version artifact and cleans stale
  bundles; all demo/mock data removed from fresh installs.

## 0.13.0 (2026-08-08)

- Harness budgets & self-correction: managed tool-round caps, stall
  detection, malformed-JSON self-heal with tool-surface downgrade, stream
  rules that abort narrated tool calls, per-model capability profiles
  (`toolSurface`, `maxTools`, `maxToolResultChars`).
- Evidence-driven auto-routing v2: routing evidence records real outcomes,
  `routingSuggestion` SSE events, opt-in auto-route with flap guard.
- Agent modes: `set_agent_mode(chat | agent | code)` with the sandboxed
  fenced-python code runner.
- Verifier gate with deterministic receipts; optional one-shot reviewer
  critique; golden eval harness with scheduled 6h loop.
- Multi-agent teams, Agent Board workspace tab, Runs retry/cancel/resume,
  sub-agent launcher, debate presets.
- AI Setup wizard, Data & Privacy center, Health simulator, Arena replay +
  archive, Scheduled golden evals.
- Prompt templates, in-thread search, PDF export, edit history, provider
  availability, onboarding, daemon control.
- Full-repo sweep: P0 sandbox escape + regenerate-wipe fixes, 30+ P1 fixes,
  dead code and test cleanup (1367 backend tests, 736 frontend).

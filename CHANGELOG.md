# August Proxy — Changelog

## Unreleased (working tree)

**Verifier enforcement removed** — the opt-in gate that withheld final answers
until `update_state(phase='complete')` after a passing verification run is gone
entirely (the "[VERIFIER STEER]" prompts no longer exist):

- Backend: `_verifier_gated_emit`, `verifierEnforced` session flag, verifier
  auto-run, receipts, force-release counters, benchmark extra-allowlist, and the
  VERIFIER STEER/AUTO-RUN steer texts — all deleted. `update_state` keeps its
  phase tracking; `run_command` still surfaces exit codes. The dormant
  `verifier_gate_log` table stays (existing DBs keep working) but nothing
  writes to it.
- Frontend: verifier toggle UI, `verifierBlocked` banner handling, stream event
  plumbing, notification/drawer references, and schemas removed.
- Tests: `test_verifier_enforced_flag.py` / `test_verifier_gate_enforcement.py`
  replaced by ungated-passthrough assertions in `test_workbench.py`.

**Model picker rebuilt (OpenCode-style two-pane dropdown)** — clicking the
model chip now shows a provider list on the left and, on hover/tap of a
provider, its models on the right (active provider check-marked, context
window per model). A **Free only** toggle (persisted in localStorage) filters
both panes to free models; pin/unpin stays on every model row. Search flattens
across providers with owner tags.

**Working indicator speaks** — while August streams, the AUG wordmark is now
backed by progressive sentences from live turn activity ("Reading src/app.py",
"Running pytest -q …"): each finished step renders as its own line, newest at
the bottom with animated ellipsis dots, older lines dimming away Claude-style.
Idle state shows "Thinking…" with dots instead of a bare wordmark.

**Reasoning renders Claude-style again** — settled thoughts were collapsing to
a one-line summary because the collapse-thinking preference defaulted ON; it
now defaults OFF so long reasoning uses the multi-line clamp + "Show more"
(clock icon, fade) out of the box.

**Artifact creation tools** (`create_pptx` / `render_chart` / `render_video` /
`draw_circuit`) registered for real this round: python-pptx decks with bullets
+ speaker notes, matplotlib PNG charts (line/bar/pie/scatter/hist), MP4 video
assembly via bundled ffmpeg (imageio), and schemdraw schematic rendering. All
workspace-bound; JSON-string args tolerated.

**Circuit workbench (/circuit)** — Proteus/KiCad-inspired circuit capability,
gated behind the `/circuit` slash command:

- `/circuit` flips `session.metadata.circuitMode`, emits a `circuitMode` SSE
  event → the right drawer pops a dedicated **Circuit panel** (netlists,
  schematics, 3D renders land there as clickable artifacts); `/circuit off`
  closes it. While off, `circuit_*` tools are invisible to the model at both
  catalog level and dispatch time.
- Tools: netlist CRUD (`circuit_create/read/update/delete/list_netlists`,
  workspace-bound .cir/.net/.ckt/.sp files), `circuit_simulate` (**ngspice**
  batch engine — the same SPICE core Kicad's simulator uses; `.op/.dc/.tran/.ac`
  decks run like physical bench measurements with parsed node measures),
  `circuit_search_component` (offline datasheet library for classics — 7805,
  NE555, 2N2222… — plus web datasheet links), `circuit_render_3d`
  (KiCad-style mplot3d board preview PNG with footprint-style bodies).
- ngspice missing → actionable install guidance instead of a dead error.
- Research notes grounded against pfalstad/circuitjs1 (browser simulator,
  active upstream), PySpice-org/PySpice (Python↔ngspice bindings — the natural
  future upgrade path beyond raw batch runs), ahkab/ahkab (pure-Python SPICE).

## Older

**Avg cache hit rate now works for every provider shape** — the context ring's cache readout was silently reading 0% for most providers:

- Anthropic-format streams: `message_start` (which carries input tokens + the `cache_read`/`cache_creation` split) was never consumed by the stream aggregator — only `message_delta` was read. The aggregator now merges both events field-by-field (`_absorb_usage`) instead of letting the later event clobber the earlier.
- OpenAI-compatible gateways streaming the standard `usage.prompt_tokens_details.cached_tokens` (OpenAI, OpenRouter, most gateways): the field was dropped during stream aggregation, so every input token was booked as a cache miss and the ring pinned at 0%. Now preserved and honored.
- Turn loop accepts the aggregated flat `cached_tokens` alongside DeepSeek-style `prompt_cache_hit/miss_tokens` and Anthropic's disjoint buckets (hit = `cache_read`; miss = plain input + cache writes).
- Regression tests for all shapes in `tests/test_workbench.py::TestWorkbenchCacheSplitRecording`.

## 0.17.0 (2026-08-24)

**Self-improving harness v2 — the model can inspect and improve its own harness, safely**

- `harness_introspect` tool rebuilt for the post-refactor architecture: read-only aggregation of the registered tool surface (health, bucket counts, >300ch descriptions, broken registrations), skills catalogue stats, **a flow map of the turn loop itself** (tool-round budget, phases, agent/guard modes, auto-compact thresholds), memory-store sizes, active brain-config knobs (secrets filtered), recent harness changes from the ledger, and open proposals.
- `harness_propose` tool: files a structured improvement proposal (`problem / evidence / proposal / rollback / kind / expectedMetric / payload`). Proposals land as `data/harness_proposals/*.json`, emit a brain SSE event, and are **never applied by the model**. Duplicate guard refuses re-filing an open proposal with the same kind+problem.
- Deterministic applier behind human approval (`POST /api/harness/proposals/{id}/decide`): `brain_config` patches via the existing `validatePatch`; `skill_create`/`skill_patch`/`skill_delete` through skill_service with copy-on-write for bundled skills and prompt-cache busting. Everything else (`tool_bucket`, `tool_description`, `flow_map`, `observation`) is recorded-only, apply refused as "human-only".
- **Scheduled introspection loop**: every 6h (first pass at boot) mechanical findings are auto-filed as one deduped `observation` proposal — broken registrations, descriptions over 300ch. The loop eats its own dogfood without ever applying anything.
- Every file/approve/reject/dismiss is journaled to `data/harness_proposals/ledger.jsonl` — the single source of "why did the harness change" after the curation-ledger removal.
- New Settings section **Insights → Harness Improvements**: review queue with open/all filter, detail view (evidence, proposed change, rollback, expected metric, payload), approve-and-apply / reject / dismiss with decision notes.

**Skills settings restored + Claude-style viewer**

- Skills is its own settings tab again (Tools split into Tools · Skills). Card-grid catalogue with search; detail view renders SKILL.md as markdown with name, attribution ("by agent"/bundled), category badge, description see-more, and trigger panel. Create/edit forms with authoring-standard validation surfaced as toasts; delete with confirmation (bundled skills refused server-side).
- Skill authoring REST routes restored (`POST/PATCH/DELETE /api/skills`) plus `createSkill`/`patchSkill`/`deleteSkill` in skill_service — both the UI and the harness applier share them.

**Settings IA — tree sub-nav replaces pill tabs**

- Clicking a hub in the left rail expands its sections inline beneath it (folder ▸ files pattern) instead of stacking pill tabs in the content pane. Deep links unchanged.
- Rail bottom gains an Updates status row ("Up to date" / "Update available · vX.Y.Z") mirroring the model-dropdown affordance; click opens Updates.
- Models hub expands to **8 direct tree children** (Models & Providers, All Models, Aliases, Fallback, Background & Reflection, Model Fleet, Live STT/TTS, Quotas) — each mounts its real component with its own page header; orphaned wrapper deleted; registry audit extended (50 checks, green).

**Picker reference parity — anchoring, scrolling, effort list**

- Model/effort dropdowns anchor by their **bottom edge** just above the composer chips (Zed/Cursor-style): height follows content, viewport-clamped with a min-height floor — short lists no longer launch deep into the transcript.
- Both picker panes scroll internally again (`overflow-y-auto` had gone missing): tall provider/model lists scroll under a max-height cap instead of clipping; long model ids ellipsize inside the flyout.
- Effort picker rebuilt as the reference's **vertical list** — Low/Medium/High/Max rows with ✓ on the active one (`menuitemradio`), Extended-thinking toggle as a divider-separated footer; provider rows bumped to roomy 13px metrics.

**Viewer & drawer polish**

- File/artifact viewer gains **⤢ fullscreen**: portaled full-window overlay sharing zoom state with the drawer canvas; Esc / ⤡ exits without closing the drawer underneath.
- Workbench drawer header is now a **tab strip**: icon + label per open section, click to focus, ✕ closes just that tab, active underline; file-preview mode keeps its filename header.
- Trajectory ledger restyled into compact **activity-log rows**: outcome icon (tone-tinted) → "Turn N" → meta (rounds · duration) → right-aligned tool/self-heal chips; live turns get a pulsing marker; prompt previews moved to hover tooltips.
- Thinking-block manual expand/collapse **survives mid-turn streaming gaps** — only a genuine final-output block resets it (regression-tested, incl. a source-level guard against the old `!streaming` reset effect).

**Chat identity & composer polish**

- Sidebar bottom is now a Claude-style user row (avatar + display name + Free tag when signed out) opening the account menu; What's New and Notifications fall back to a bundled CHANGELOG digest when GitHub yields nothing (rate limit/offline no longer render a silent blank).
- Git branch selector chip lives in the composer footer on workspace chats — current branch shown, click to list/checkout others.
- Context ring popover restores the **average cache hit rate** bar and cached/total input counts against the 96% goal.
- Deliverable cards ("Files created") are Claude-style tiles with file-type labels (Presentation · PPTX etc.) that open the artifact in the right sidebar panel; pptx_* tool outputs now count as deliverables too.
- Verifier "Run it for me" button removed from the blocked banner (Copy command remains); verifier tooltip helper deleted with it.

**Fixes along the way**

- Circuit tools classified for prompt buckets + policy parity (`circuit_create/update_netlist` + `render_3d` → write, `circuit_delete_netlist` → destructive, `circuit_simulate` → shell like `simulate_circuit`, lookups → read) and mirrored into the parity-test oracle (which had also drifted on `analyze_media`). Wire-format tests now skip `/circuit`-gated tools on the default surface and positively assert they appear when circuit mode is ON.
- mypy fully clean across backend (265 files) — delegation-config narrowing errors fixed at their root in subagent router + orchestrator instead of silencing.
- `background_review_service` restored so `/api/config/background-review` and the Background & Reflection tab work again post-refactor.

**Validation:** ruff ✓ · mypy 0 errors (was 19 baseline) · backend pytest 1233 passed / 0 failed ✓ · vitest 727/727 ✓ · tsc clean ✓ · build:web ✓ · version sync ✓ (7 sources @ 0.17.0)

## 0.16.9 (2026-08-23)

**Folder picker returns + change toasts + Claude-style truncation + RAM/latency pass**

- **Workspace chip**: folder selection restored as a quiet pill in the composer footer (folder icon + project name, dashed "Set folder" when empty) — click opens the Tauri picker via the existing `august:open-folder` event. Replaces the boxed meta row removed in 0.16.7 without bringing back the bar.
- **Change feedback UI**: `useSelfMaintenanceToasts` listens on the brain SSE stream and raises quiet toasts when memories are updated (auto-review, boot maintenance) or skills created/evolved — deduplicated by event id, reconnect-safe. The in-chat SelfImprovementStrip stays.
- **Claude-parity search block**: `SearchResultsList` shows the first 4 hits inline with a "Show N more results" expander — no more nested scrollbar inside the transcript.
- **Reasoning clamp**: once a thought finishes, its body is clamped to a short window with Show more/Show less; long reasoning no longer dominates the chat (streaming keeps the live scroll-pinned preview).
- **Memory settings**: "By Project" tab removed (same pool as Recalled filtered to one folder); old deep links land on Recalled.
- **RAM**: workbench session recency window 200 → 60 (each cached session holds its full message array; SQLite transparently reloads evicted sessions).
- **Latency**: skills-catalogue memoized against skill-root mtimes (~0.5s cold build no longer re-runs on turns; mutations bust it explicitly), segments-cache TTL 30s→10min, code-map walk TTL 30s→120s.

**Validation:** ruff ✓ · mypy at baseline (19) · vitest 773/773 ✓ · tsc clean ✓ · build:web ✓ · session/skill suites green

## 0.16.8 (2026-08-23)

**Fresh-open full refresh — boot always updates everything, visibly**

- New `run_boot_maintenance()` pass fired automatically on every fresh app open: expired-memory TTL prune → vector-mirror reconciliation → skill stale/archive curation → **forced** LLM memory review (bypasses the 12h idle gate; a fresh open is exactly when everything should be current).
- The pass is observable: `GET /api/brain/auto-maintenance` now returns `running` + boot state; `SelfMaintenanceLine` polls it and shows a live spinner — *"Updating memory & skills…"* — while the pass runs (fast 1.5s poll while active, 60s idle), then settles into the quiet summary line. Brain SSE events mark start/done.
- `POST /api/brain/auto-maintenance/run` triggers the same full pass on demand.
- Safety details: double-run guard (`already-running`), `_bootRunning` flag cleared in `finally` so the spinner can never hang forever, per-step error capture reported as "(with errors)" instead of failing the whole pass.
- `run_memory_review(force=...)` parameter added so callers with their own schedule can bypass internal gates.

**Validation:** ruff ✓ · mypy at baseline (19) · vitest 773/773 ✓ · tsc clean ✓ · build:web ✓ · test_auto_review_loop.py extended to 6 tests (boot runs+clears flag, forced review asserted, no double-run).

## 0.16.7 (2026-08-23)

**Fully automatic self-maintenance — the user just chats**

- New backend loop `auto_review_loop`: scheduled LLM memory review (12h interval, calm-down after boot) that **auto-applies** the safe subset — improve / enhance / merge via `apply_review_actions`, each journaled in the curation ledger. **Removals are never automatic**: they become open harness proposals for one-click human approval. Emits a brain SSE event per run.
- The "Review what I remember" and "Curate skills (dry run)" pills are **removed from the UI**. Skill curation was already automatic (hourly curator loop); memory review now joins it. Replaced by `SelfMaintenanceLine` — a single quiet status line under the composer ("self-maintenance ran 2h ago · 3 improvements applied · 1 removal awaits approval") fed by `GET /api/brain/auto-maintenance`. Hidden until the first run.
- Composer minimalism pass: icon-only round send button (DeepSeek-style ↑ pill; mode context moved to tooltip; streaming keeps explicit Steer/Stop), removed the boxed project/plugins/model-echo meta row (project badge already lives above; model is in the picker), reasoning line rendered in italic like DeepSeek's "Thought for N s".

**Validation:** ruff ✓ · mypy at baseline (19, none introduced) · vitest 773/773 ✓ · tsc clean ✓ · build:web ✓ · new tests `test_auto_review_loop.py` (gating, safe-apply-only, removals→proposals, quiet summary)

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

# Increment Plan: Minimal Benchmark Mode + Run Telemetry + Proactive Skill Chip

**Status:** ready for implementation (handoff document)
**Scope:** three small-to-medium increments derived from the DeepSeek Harness /
Hermes comparison analysis. None of them touch the high-risk adapter
serialization paths (`dump_openai_upstream_body` / `dump_anthropic_upstream_body`)
or the sandbox policy core.

---

## 0. Ground rules (read first)

1. **The product is the Tauri desktop app.** Backend changes only count when they
   live in `backend-py/` (bundled into the installer). Do not build a separate
   web-app QA path.
2. **Validation commands** (must pass before declaring done):
   - Backend: `cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q`
   - Frontend: `npm run test:frontend` (from repo root)
3. **Do NOT touch** these high-risk coordination points (per AGENTS.md):
   - `dump_openai_upstream_body` / `dump_anthropic_upstream_body`
   - `backend-py/app/services/sandbox/` policy files
   - `_executeTool` hash-anchored edits / `toolDefinitions` ↔ `openaiToolDefinitions` sync
   - `adapters/stream_state.py` (`AnthropicNativeStreamState`)
4. **Version files:** do NOT bump versions in this increment. Version sync
   (7 files, `scripts/check-version-sync.mjs`) happens at ship time.
5. Follow existing code style: backend uses `camelCase` for dict keys crossing
   the SSE/API boundary and `snake_case` internally; frontend components live
   under `frontend/desktop/src/` with colocated `*.test.tsx` where the
   surrounding directory has tests.
6. Each increment is independently shippable. Commit per increment.

---

## Increment A — Minimal Benchmark Mode

**Goal:** a session mode that exposes only a bare two-tool surface
(persistent shell + editor) so raw model capability can be compared without
harness heuristics — August's analog of DeepSeek Harness "Minimal Mode".

### A.1 Design decisions (already made — do not re-litigate)

- New agent mode value: `'benchmark'`. It joins `chat | agent | code | orchestrator`.
- The tool surface is exactly: **`run_command` + `edit_lines`** — August's
  registered equivalents of DSH's `persistent_bash` + `str_replace_editor`.
  Note: `str_replace_editor` is NOT a registered tool in August (it only appears
  in policy frozensets as an alias guard). Canonical registered names verified
  in `backend-py/app/services/tool_registrations/file_tools.py:573-683`:
  `read_file`, `write_file`, `edit_lines`, `list_directory`, `search_files`,
  `run_command`.
- Exception: when the session is `verifierEnforced`, also allow `update_state`
  (the verifier gate cannot pass without it).
- Benchmark mode disables: skill injection, memory/context injection, planner
  scaffolding, subagents, and the reflection/stall nudges are left as-is (they
  are loop guardrails, not harness heuristics — benchmark purity is about the
  *tool surface and prompt*, not about removing infinite-loop protection).

### A.2 Backend changes

**File: `backend-py/app/services/harness_mode.py`** — follow the existing
planner pattern exactly (this file is the established template):

```python
BENCHMARK_ALLOWED_TOOLS = frozenset({'run_command', 'edit_lines'})
BENCHMARK_VERIFIER_EXTRA = frozenset({'update_state'})

def is_benchmark_mode(session: object | None) -> bool:
    mode = str(getattr(session, 'agent_mode', '') or '').strip().lower()
    return mode == 'benchmark'

def filter_benchmark_tools(session, tools):
    allowed = set(BENCHMARK_ALLOWED_TOOLS)
    if getattr(session, 'verifierEnforced', False):
        allowed |= BENCHMARK_VERIFIER_EXTRA
    return [t for t in tools if tool_name_of(t) in allowed]

def benchmark_block_message(tool_name: str) -> str:
    return (f'[Blocked] Benchmark mode: only run_command and edit_lines are '
            f'available (raw capability evaluation). `{tool_name}` is disabled.')
```

**File: `backend-py/app/services/workbench/workbench.py`**

1. `_finalize_session_tools` (~line 1385): after the planner filter branch, add
   the benchmark branch:
   ```python
   if is_benchmark_mode(session):
       return filter_benchmark_tools(session, tools)
   ```
   Order matters: benchmark filter runs *after* `_applyModelCapabilityProfile`
   and is mutually exclusive with the orchestrator branch.
2. Runtime block (~line 3237, next to the existing
   `is_orchestrator_mode(...) and toolName not in PLANNER_ALLOWED_TOOLS`
   check): add the symmetric benchmark check emitting a `toolResult` with
   `benchmark_block_message(toolName)` — copy the orchestrator block's emit
   shape exactly (`type: 'toolResult'`, `id`, `name`, `content`, `status: 'done'`).
3. Prompt injection (~line 2476-2519, the `<agent_mode>` block chain): add a
   `benchmark` branch with a one-line instruction: minimal surface, no
   scaffolding. Keep it short — benchmark purity means *less* prompt, not more.
4. Check every other `getattr(session, 'agent_mode', ...)` site in this file
   (grep shows ~10: lines 2476, 2493, 2506, 2512, 3106, 3161, 3221, 3272).
   The `code`-mode fenced-python branch (3106) and `chat`-mode block (3221)
   must NOT fire for benchmark. The "consider code mode" nudge (3272) should be
   suppressed in benchmark mode.

**File: `backend-py/app/services/tool_registrations/system_tools.py`**

- Line ~390: extend validation tuple to
  `('chat', 'agent', 'code', 'orchestrator', 'benchmark')`.
- Line ~619: extend the JSON-schema `enum` list with `'benchmark'`.
- Update the `set_agent_mode` tool description string to mention benchmark.

**File: `backend-py/app/routers/workbench.py`**

- Line ~1930-1934 (`agentMode` persistence endpoint): accept `'benchmark'` in
  the validation and update the 400 detail message.

**Suppression of harness heuristics:** locate where skills/memory context get
injected into the turn prompt (the context snapshot machinery feeding
`_last_context_snapshot`, ~line 4205) and gate skill + memory injection on
`not is_benchmark_mode(session)`. Search for `load_skill`/`capabilities_prompt`
call sites in the turn path. If injection is centralized in
`app/services/memory/context_builder.py`, gate it there with a flag passed from
the workbench turn.

### A.3 Eval integration

**File: `backend-py/app/services/harness_eval.py`**

- `run_turn` (~line 301) already sets `session.verifierEnforced` from the
  scenario spec (line ~363). Add the same treatment for a new optional
  `'agent_mode'` scenario key: `session.agent_mode = spec.get('agent_mode', '')`.
- Add two scenarios to `EVAL_SCENARIOS` (~line 429):
  ```python
  {
      'taskId': 'benchmark-mode-surface',
      'tier': 'benchmark',
      'agent_mode': 'benchmark',
      'script': [
          {'type': 'tool', 'name': 'web_search', 'arguments': {'query': 'x'}},
          {'type': 'tool', 'name': 'run_command', 'arguments': {'command': 'echo ok'}},
          {'type': 'text', 'text': 'done'},
      ],
      'expect': ['toolResult', 'done'],
      'mustHaveText': ['[Blocked] Benchmark mode'],
  },
  ```
  (The scripted model attempts a non-allowed tool first; the loop must block it
  with the benchmark message and still complete.)
- Mirror in `backend-py/tests/test_harness_evals.py` following the existing
  per-scenario test pattern.

### A.4 Frontend changes

- Mode selector: find where `agentMode` values are rendered/selected (search
  `frontend/desktop/src` for `'orchestrator'` — the mode chip
  `components/chat/HarnessModeChip.tsx` and composer controls). Add `benchmark`
  with a label like "Benchmark (2-tool)" and a short tooltip.
- The `PATCH`/session-update call already sends `agentMode`
  (`routers/workbench.py:1930` accepts `agentMode` or `agent_mode`); no API
  change needed beyond validation.

### A.5 Acceptance criteria

- [ ] `set_agent_mode(mode='benchmark')` succeeds; invalid modes still rejected.
- [ ] In benchmark mode, tool definitions sent upstream contain only
      `run_command` + `edit_lines` (+ `update_state` iff verifierEnforced).
- [ ] A model attempting `web_search` in benchmark mode gets the
      `[Blocked] Benchmark mode` toolResult and the turn continues.
- [ ] No skill/memory context injection in benchmark turns (assert via the
      context snapshot or a unit test on the gate).
- [ ] New eval scenario passes in `pytest -q`.
- [ ] Existing chat/agent/code/orchestrator behavior unchanged (full suite green).

---

## Increment B — Run Telemetry: Header + Tool Waterfall

**Goal:** surface what August already measures — cache hit rate, TTFT,
tokens/sec — in a sticky run header, plus a per-tool latency waterfall.

### B.1 What already exists (do not rebuild)

- Backend `done` SSE event already carries
  `usage: {inputTokens, outputTokens, contextTokens, durationMs, cacheHitTokens, cacheMissTokens}`
  (`workbench.py:4190-4197`). `durationMs` is model-generation-only.
- Server-side session usage endpoint computes `cacheHitRate`
  (`app/services/memory_store/rest.py:380`), consumed by
  `frontend/desktop/src/sections/chat/hooks/useChatUsage.ts` and already
  rendered in `ComposerToolbar.tsx:453` and `ContextRing.tsx:32-46`.
- TTFT is measured client-side: `frontend/desktop/src/lib/stream-perf.ts`
  (`ttftMs`, keyed `august-stream-ttft:{sessionId}`).

### B.2 Backend: tool latency in `toolResult` events

`toolResult` events currently carry `{type, id, name, content, status}` with no
timing (emit sites at `workbench.py:3116, 3226, 3246, 3280, 3302, 3322, 3341, 3355`).

1. Record `time.perf_counter()` immediately before dispatching each tool call
   (the dispatch goes through `app/services/workbench/tool_executor.py` —
   time at the single dispatch point if all sites route through it; otherwise
   at each emit site).
2. Add `durationMs: int(...)` to every `toolResult` payload. Also add
   `startedAtMs` (epoch ms, int) so the frontend can lay out a timeline.
3. Blocked-tool `toolResult` emits (chat-mode block, planner block, the new
   benchmark block) should carry `durationMs: 0` and a `blocked: true` flag so
   the waterfall can render them distinctly.
4. Parallel tool batches: `app/services/workbench/parallel_tools.py` exists —
   ensure each parallel result gets its own per-tool timing, not a shared batch
   duration.

**Wire compatibility:** additive fields only. Never rename existing keys.
Frontend `streamEvents.ts` must treat missing `durationMs` as `null` (old
backends / replayed sessions).

### B.3 Frontend: event plumbing

**File: `frontend/desktop/src/api/workbench/streamEvents.ts`**

- Extend the `onToolUse` handler payload with optional `startedAtMs` and the
  `onToolResult` payload (~line 84) with optional `durationMs`, `blocked`.
- Follow the file's existing defensive coercion style
  (`typeof p?.x === 'number' ? p.x : null`).

### B.4 Frontend: run header + waterfall component

1. **New component** `frontend/desktop/src/components/chat/RunTelemetryBar.tsx`:
   - Sticky bar shown while a turn is running and collapsed to a chip after
     `done`. Contents: cache hit % (from `useChatUsage().cacheHitRate`),
     TTFT (from `stream-perf.ts` summary), tokens/sec
     (`outputTokens / durationMs * 1000` from the `done` usage), and total
     round count.
   - Mount point: the chat thread header area — inspect
     `sections/chat/ChatThread.tsx` / `components/shell/ChatLayout.tsx` for the
     existing sticky element and mount adjacent to it. Do not displace the
     `ContextRing`.
2. **Waterfall:** expandable section inside the telemetry bar listing each tool
   call of the current turn as a horizontal bar: name, start offset relative to
   turn start, `durationMs`. Blocked calls render as a distinct (hatched/gray)
   zero-width marker. Collect events in the existing turn-state reducer (see
   `sections/chat/makeStreamHandlers*` / the hook that already accumulates
   `onToolUse`/`onToolResult` pairs — reuse its state, do not add a second
   event subscription).
3. Match the existing visual language (Tailwind utility classes, `cn()` helper,
   `text-[10px]`/`text-[11px]` density used by `EpisodeCard.tsx`).
4. **Tests:** colocated `RunTelemetryBar.test.tsx` — render with a scripted
   event sequence, assert cache %/TTFT/tokens-per-sec formatting and that
   blocked tools render distinctly. Follow
   `src/components/chat/__tests__/SubagentLaunchList.test.tsx` conventions.

### B.5 Acceptance criteria

- [ ] `toolResult` events carry `durationMs` + `startedAtMs`; blocked results
      carry `blocked: true`.
- [ ] Header shows cache hit %, TTFT, tokens/sec during/after a turn.
- [ ] Waterfall renders sequential and parallel tool calls with correct
      relative offsets.
- [ ] Frontend tolerates missing timing fields (no crash on old sessions).
- [ ] Backend suite + frontend suite green.

---

## Increment C — Proactive "Save as Skill" Chip

**Goal:** when a run completes with verified receipts, proactively suggest
turning it into a skill — instead of requiring the user to find the existing
"Save skill" button on the episode card.

### C.1 What already exists (reuse, do not rebuild)

- Generation path: `harness_ops.skill_from_episode(session_id, workstream, seq)`
  (`backend-py/app/services/harness_ops.py:163`) builds a SKILL.md from an
  episode and calls `skill_service.createSkill`.
- HTTP path: `POST /api/subagents/workstreams/{name}/save-skill`
  (`backend-py/app/routers/subagent.py:496`), frontend client
  `saveSkillFromEpisode` in `frontend/desktop/src/api/subagents.ts:313`.
- Manual UI: `EpisodeCard.tsx` "Save skill" button →
  `WorkstreamsPanel.tsx:63-66` mutation.
- Post-creation notification: `SkillEvolvedChip.tsx` (listens to
  `skill_genesis` brain events via `openBrainEventStream`).
- Draft/approval pipeline: `pending_skills` table
  (`app/services/memory_schema.py:366`) + approve/reject in
  `consolidation_daemon.py` (~lines 527-620).

### C.2 Backend: suggestion emission

1. At episode completion (the workstreams episode-close path — find where
   episode `status` becomes `completed` with `criteriaMet`, in
   `app/services/workstreams.py` / `harness_ops.py`), evaluate a suggestion
   predicate:
   - episode status `completed` AND `criteriaMet` truthy,
   - AND the episode used ≥ 4 tool calls (count from episode artifacts/events),
   - AND no skill already exists for this workstream slug
     (`skill_from_episode` names skills `lane-{slug}` — check via
     `skill_service` existence lookup).
2. When the predicate passes, emit a brain event:
   ```python
   emitBrainEvent(
       category='skill_suggestion',
       layer='workstreams.episode_completed',
       summary=f'Suggest skill: lane-{slug}',
       data={'workstream': workstream, 'seq': seq, 'suggestedName': f'lane-{slug}'},
   )
   ```
   (`emitBrainEvent` pattern: `app/services/brain_event_bus.py`, already used
   in `consolidation_daemon.py:585`.) Register the new category label in
   `routers/brain.py:593` (the category label list) if that list gates UI
   filtering.
3. Do NOT auto-create the skill. Suggestion only — user approval stays
   mandatory (the `pending_skills` flow is the existing approval mechanism;
   optionally stage the draft through it instead of emitting directly —
   implementer's choice, but the chip must lead to an *editable* draft, not a
   silent creation).

### C.3 Frontend: the chip

1. **New component** `frontend/desktop/src/components/chat/SkillSuggestionChip.tsx`,
   modeled directly on `SkillEvolvedChip.tsx` (same SSE subscription pattern,
   same auto-dismiss + fade style):
   - Listen for brain events with `category === 'skill_suggestion'`.
   - Render: `💡 Turn into reusable skill: lane-{slug}` with an action button.
   - Clicking opens a slide-over (reuse the skill form panel
     `sections/settings/skills/SkillFormPanel.tsx` if it can render standalone;
     otherwise navigate to `/skills` with the draft preloaded) pre-filled with
     the generated frontmatter/body from a new preview endpoint.
2. **New preview endpoint** (small):
   `GET /api/subagents/workstreams/{name}/skill-preview?seq=N` returning the
   `{name, description, body}` that `skill_from_episode` *would* create —
   refactor `skill_from_episode` to split body-building (pure function) from
   creation so both paths share it. Approval then calls the existing
   `save-skill` POST.
3. Mount the chip alongside `SkillEvolvedChip` (same layout slot — check where
   `SkillEvolvedChip` is mounted in the shell/chat layout).
4. **Tests:** component test asserting the chip renders on a scripted
   `skill_suggestion` event and dismisses; backend test for the predicate
   (completed+criteria+≥4 tools → emit; missing any → no emit) and the
   preview endpoint.

### C.4 Acceptance criteria

- [ ] Completing a qualifying episode emits exactly one `skill_suggestion`
      event; non-qualifying episodes emit none; duplicate suggestions for an
      existing `lane-{slug}` skill are suppressed.
- [ ] Chip appears, opens a pre-filled editable draft, and saving goes through
      the existing `save-skill` endpoint (no new creation path).
- [ ] No skill is ever created without explicit user action.
- [ ] Backend + frontend suites green.

---

## Suggested implementation order

1. **Increment A** (backend-heavy, isolated, eval-covered) — smallest blast
   radius, establishes the mode-plumbing the reviewer will check first.
2. **Increment B** (wire-additive + new UI component).
3. **Increment C** (cross-layer, depends on nothing in A/B but is the most
   product-judgment-heavy).

Each increment: implement → run both validation commands → commit with a
conventional prefix (`feat(harness):`, `feat(desktop):`).

## Reviewer checklist (for the reviewing agent — do not self-certify these)

- [ ] No changes to the four forbidden high-risk zones (ground rule 3).
- [ ] SSE/API changes are additive; no renamed or removed wire keys.
- [ ] `set_agent_mode` enum, JSON schema, router validation, and all
  `agent_mode` branch sites in `workbench.py` are consistent for `benchmark`.
- [ ] Benchmark mode verified end-to-end via the new eval scenario, not just
  unit tests.
- [ ] Frontend components follow existing density/style conventions and have
  colocated tests where sibling components do.
- [ ] No version bumps; `scripts/check-version-sync.mjs` still passes.
- [ ] Desktop-relevant behavior was checked in the desktop app context
  (bundled backend), per AGENTS.md.

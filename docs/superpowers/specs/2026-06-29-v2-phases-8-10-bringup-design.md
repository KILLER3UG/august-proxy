# v2 — Phases 8-10 Bring-up Design Doc

**Date:** 2026-06-29
**Status:** Draft for review
**Scope:** Bring all Phase 8-10 features (Subconscious Daemons, Autonomous Cognitive Maintenance, Advanced Cognitive Frontiers) from stub/skeleton state to working implementation, per `docs/design/cognitive-architecture-v1.md` §5.4, §5.5, §9, §10, and §10 of the model fleet architecture.
**Builds on:** v1.1 (tagged `v1.1.0`) — Phase 0-7 fixes are in place.
**Reference:** v1.1 design doc §6 (`docs/superpowers/specs/2026-06-29-cognitive-architecture-remediation-design.md`) contains the roadmap; this doc adds concrete component design for each Phase 8-10 piece.

---

## 1. Background

After v1.1, the cognitive architecture has:
- A working 3-tier system prompt with conditional injection
- All 12 brain_query stores (memory, auto_memories, heuristics, facts, sessions, messages, timeline, blackboard, graph, daemons, exams, exam_attempts)
- A working `<failure_feedback>` producer with 3-turn decay
- State drop on plan submit/reject
- Critical-pressure auto-compaction with 5-turn cooldown
- Unicode math rendering instead of red LaTeX

What's still stubbed (per the v1.1 verification report):
- `daemon_manager.py` — imports `get_model_for_role` from a module that doesn't exist; tool allowlist never enforced; no `[CRITICAL]` prefix; error not truncated
- `consolidation_daemon.py` — pure SQL time-based cleanup; no scheduler; no Hippocampus call; no write-queue use
- `delta_engine.py` — local-only fallback works; LLM path returns `None`; no env-watcher subscription
- `blackboard_service.py` — CRUD works; flat 60s TTL; no `ack`; Tier 3 not injected
- `environment_watcher.py` — only `pass`; only git branch polling; no fs watcher; no events; not injected
- `workbench.py` — accepts `verification_command` but never reads it to inject `<verifier_gate>`
- `pending_skills` table doesn't exist; no `data/skills/staging/` dir; no skill genesis

**v2 brings all of these to working state.** No new architecture — only bringing spec-defined stubs to life.

---

## 2. Goals and non-goals

### Goals

- Phase 8: daemons actually run on the Cerebellum model, with tool enforcement, `[CRITICAL]` prefix, and error truncation
- Phase 9a: consolidation daemon uses the **Hippocampus** LLM to merge duplicate heuristics, promote 5×-repeated patterns to permanent facts, and delete stale content (not just time-based)
- Phase 9b: delta engine's LLM path actually infers rules from user edits; subscribes to env-watcher events
- Phase 9c: episodic timeline gets populated on session end / major goal complete; `search_timeline` reachable via `brain_query(store="timeline")`; hourly sweep catches missed sessions
- Phase 10.1: blackboard has adaptive TTL (`max(poll_interval×2, 60s)` or 3 turns); `ack=True` deletes the note; `<blackboard_state>` injected in Tier 3
- Phase 10.2: environment watcher uses `watchdog` for fs mods, ignores noise patterns, rate-limits to 1 update/2s, emits events the delta engine subscribes to, injects `<environment>` into `<runtime_context>`
- Phase 10.3: `<verifier_gate>` injected on `update_state(phase="review"|"complete")` with specific or generic reminder; re-gates until verification passes
- Phase 10.4: `pending_skills` table + `data/skills/staging/` directory; consolidation daemon drafts SKILL.md using Prefrontal; quality guard (≥3 uses, max 1/day, `created_by: auto-gen`); user approval required before activation

### Non-goals

- No new cognitive layers. The five-layer model (conscious / subconscious / maintenance / metacognition / brain) is fixed.
- No new model providers. The fleet is Cortex / Cerebellum / Hippocampus / Prefrontal.
- No v3 (Brain dashboard UI) or v4 (August Live + UI redesign) work — those are separate plans.
- No changes to v1.1 features (those are locked in `v1.1.0`).

---

## 3. Architecture

The architecture does not change. v2 is a strict bring-up of existing stubs.

```
┌──────────────────────────────────────────────────────────────┐
│                      THE JARVIS BRAIN                         │
├──────────────────────────────────────────────────────────────┤
│  CONSCIOUS (per turn) — v1.1 ✅                               │
│  SUBCONSCIOUS — v2 brings online                              │
│    daemon_manager → spawn_daemon / list_daemons / kill_daemon│
│      ├─ restricted read-only tools                            │
│      ├─ Cerebellum model                                      │
│      ├─ [CRITICAL] prefix                                     │
│      └─ blackboard writes                                     │
│                                                               │
│  MAINTENANCE (idle / daily) — v2 brings online                │
│    consolidation_daemon (Phase 8 infra)                       │
│      ├─ Hippocampus LLM                                       │
│      ├─ merge / promote / delete                              │
│      └─ skill genesis (Prefrontal, staged)                    │
│    delta_engine                                               │
│      ├─ Hippocampus LLM (batch diffs)                         │
│      └─ env-watcher subscription                              │
│    episodic_timeline (sweep + populate)                       │
│                                                               │
│  ENVIRONMENT — v2 brings online                               │
│    environment_watcher                                        │
│      ├─ watchdog fs events                                    │
│      ├─ git branch / terminal                                 │
│      └─ rate-limited emissions                                │
│                                                               │
│  METACOGNITION — v1.1 + v2 small additions                    │
│    verifier_reflex (Phase 10.3)                               │
│                                                               │
│  BRAIN — v1.1 + v2 schema additions                           │
│    august_brain.sqlite + pending_skills table (v2)            │
│    db_writer (Phase 0, used by all v2 writers)                │
└──────────────────────────────────────────────────────────────┘
```

---

## 4. Cross-cutting: model fleet

Every Phase 8-10 feature needs to call an LLM. The fleet is defined once in a new module and looked up by role.

### 4.1 File: `backend-py/app/services/workbench/model_fleet.py` (new, ~60 lines)

```python
"""v2: Model fleet for the cognitive layers.

Maps each cognitive role to a model identifier. Users can override via
data/config.json → auxiliary.model_fleet. The 'cortex' role is special:
empty string means "use the session's primary model".

Four roles:
  - cortex:      main session model (Cortex tier — Sonnet 4, GPT-4o)
  - cerebellum:  fast, cheap — for daemons and watchers (Haiku, GPT-4o-mini)
  - hippocampus: moderate reasoning — for consolidation, delta engine,
                 context compaction (Haiku)
  - prefrontal:  highest reasoning — for skill genesis (Sonnet 4, Opus)
"""

DEFAULT_FLEET: dict[str, str] = {
    "cortex":      "",
    "cerebellum":  "claude-3-haiku-20240307",
    "hippocampus": "claude-3-haiku-20240307",
    "prefrontal":  "claude-3-5-sonnet-20240620",
}


def get_model_for_role(role: str) -> str:
    """Return the configured model for a role, or fall back to defaults.

    Reads `data/config.json → auxiliary.model_fleet` if present.
    Empty 'cortex' resolves to the session's primary model (caller's
    responsibility — get_model_for_role returns '' and the caller
    uses whatever the session has).
    """
    ...
```

### 4.2 Config integration

Read from `data/config.json`:

```json
{
  "auxiliary": {
    "model_fleet": {
      "cortex":      "",
      "cerebellum":  "claude-3-haiku-20240307",
      "hippocampus": "claude-3-haiku-20240307",
      "prefrontal":  "claude-3-5-sonnet-20240620"
    }
  }
}
```

If the user doesn't configure, defaults are used. If they configure a subset, defaults fill the rest.

### 4.3 Cost / latency impact

| Task | Without fleet | With fleet | Savings |
|------|--------------|------------|---------|
| Daemon monitoring (100×/day) | Sonnet: $3.00/day | Haiku: $0.10/day | 97% |
| Sleep cycle (1×/day) | Sonnet: $0.15/day | Haiku: $0.005/day | 97% |
| Skill genesis (1×/week) | Haiku (poor quality) | Sonnet (high quality) | correctness |
| Context compaction (rare) | Sonnet (expensive) | Haiku (cheap) | cost |

---

## 5. Phase 8 design — Daemons actually run

### 5.1 Goal

`spawn_daemon`, `list_daemons`, and `kill_daemon` become functional: daemons actually invoke the **Cerebellum** model, run with restricted tools, emit watch-condition triggers, and survive crashes gracefully.

### 5.2 Files

- **New:** `backend-py/app/services/workbench/model_fleet.py` (model fleet — §4.1)
- **Modify:** `backend-py/app/services/daemon_manager.py` (wire model, enforce tools, truncated tracebacks, `[CRITICAL]` prefix)
- **Modify:** `backend-py/app/services/tool_definitions.py` (already has spawn/list/kill; verify wiring)
- **Modify:** `backend-py/app/services/workbench/workbench.py` (`<subconscious_updates>` Tier 3 injection, `[CRITICAL]` prefix logic)

### 5.3 Daemon execution flow

```
spawn_daemon(name, prompt, watch_condition, tools=None)
  → DaemonSpec stored in daemon_manager._daemons[session_id]
  → asyncio.Task created with:
      - restricted tools (default: web_fetch, read_file, list_directory,
        search_files, run_command read-only)
      - tools=[] override: no tool access, pure text generation
      - tools=[...] allowlist: restricted to that subset
      - cerebellum model from model_fleet
      - watch_condition from spec
  → _run_loop polls every poll_interval (default 30s)
      - _run_once calls cerebellum with prompt + tools
      - result evaluated against watch_condition
      - on match → store as triggered result
      - on error → status="errored", truncated traceback stored
  → result is injected as <daemon> child of <subconscious_updates>
  → if result matches [CRITICAL] prefix → model must pause + inform user
```

### 5.4 Tool enforcement (the critical safety guarantee)

Daemons run unattended on the cheap Cerebellum model. They MUST NOT be able to mutate files or run destructive commands.

The `run_command` tool is gated behind a read-only flag at the daemon tier:
- When called from a daemon, `run_command` rejects any command matching a blocklist (rm, mv, del, format, mkfs, dd, shutdown, etc.)
- The blocklist is applied at the dispatch layer (tool_registry) — not the daemon code — so all daemons are protected uniformly

### 5.5 Watch conditions

| Condition | Behavior |
|-----------|----------|
| `"on_completion"` | Trigger fires after the daemon's first run |
| `"on_match:KEYWORD"` | Trigger fires if output contains `KEYWORD` (case-insensitive substring) |
| `"on_change"` | Trigger fires if output md5 differs from previous cycle |
| `null` | No proactive alert; model reads via `list_daemons` |

### 5.6 Lifecycle / error handling

- **Max 3 concurrent daemons per session** — enforced in `spawn()`
- **Result expiry: 5 turns** — `list_daemons()` clears triggered results when `turns_alive >= 5`
- **Crash recovery:** every run wrapped in `try/except Exception` → status `errored` + truncated traceback (last frame + type + message, same truncation as Phase 6)
- **Retries:** capped at 2 per daemon to avoid infinite restart loops
- **Exponential backoff:** on API failure, daemon backs off 5s → 15s → 45s → 135s (cap 5 min); resets to normal interval on success
- **Graceful shutdown:** all daemons cancelled via `asyncio.gather(..., timeout=5)` on app shutdown
- **`[CRITICAL]` prefix:** daemons can prefix their output with `[CRITICAL]` to force the model to pause; `<subconscious_updates>` rendering preserves this prefix

### 5.7 Tier 3 injection

`<subconscious_updates>` is injected in Tier 3 when at least one daemon has a triggered result, an error, or recent activity (within 5 turns):

```xml
<subconscious_updates>
  <daemon name="ci_watcher" status="triggered" watch_condition="on_match:FAIL"
          result="CI check returned FAIL: 3 failures in auth.py" />
  <daemon name="log_monitor" status="running" last_check="2s ago" />
</subconscious_updates>
```

### 5.8 Tests

- `test_v2_daemon_cerebellum.py` — daemon actually invokes model (mock the model call, verify prompt + tools passed)
- `test_v2_daemon_tool_allowlist.py` — `tools=[]` disables; restricted default enforced; `tools=["web_fetch"]` further restricts
- `test_v2_daemon_watch_conditions.py` — `on_completion` fires once; `on_match:KEYWORD` fires on substring; `on_change` fires on hash change
- `test_v2_daemon_max_concurrent.py` — 4th `spawn()` raises
- `test_v2_daemon_backoff.py` — API failure → exponential backoff schedule
- `test_v2_daemon_crash_recovery.py` — exception in run → status `errored`, traceback truncated
- `test_v2_daemon_graceful_shutdown.py` — all daemons cancelled on `daemon_manager.shutdown()`
- `test_v2_daemon_critical_prefix.py` — `[CRITICAL]` in daemon output preserved in `<subconscious_updates>`
- `test_v2_daemon_result_expiry.py` — triggered results cleared after 5 turns

### 5.9 Definition of Done

- Daemons actually call Cerebellum (verified via mock model call)
- Tool allowlist enforced; mutating commands rejected at dispatch layer
- `[CRITICAL]` prefix logic preserved through Tier 3
- Errors truncated to last frame, status set to `errored`, retries capped
- Max 3 concurrent; 5-turn expiry; exponential backoff
- Graceful shutdown
- `<subconscious_updates>` injected only when populated

---

## 6. Phase 9a design — Consolidation via Hippocampus

### 6.1 Goal

The consolidation daemon (currently a 30-day time-based heuristic delete) becomes a real LLM-driven pipeline that:
1. **Merges duplicates** — "User prefers Yarn" + "Use Yarn not NPM" → one canonical heuristic
2. **Promotes patterns** — same correction observed 5+ times → permanent `fact`
3. **Deletes stale** — content-aware, not just time-based ("Server is down" after server is back up)

### 6.2 Files

- **Modify:** `backend-py/app/services/consolidation_daemon.py` (replace SQL with Hippocampus pipeline)
- **New:** `backend-py/app/services/scheduler.py` (24h trigger + idle detection)
- **Modify:** `backend-py/app/services/workbench/workbench.py` (wire `run_consolidation()` as a daemon via Phase 8)

### 6.3 Consolidation flow

```
trigger (idle > 5 min OR every 24h)
  → scheduler fires run_consolidation()
  → collect recent auto_memories (last 100) + all learned_heuristics
  → call Hippocampus with prompt:
      "Review these memories and heuristics. Return a JSON plan:
       {'merge': [{'keep_id': int, 'remove_ids': [int, ...], 'merged_rule': str}],
        'promote': [{'pattern': str, 'fact_key': str, 'fact_value': str}],
        'delete': [int, ...]}
       Preserve all decisions. Do not delete the most recent 20."
  → validate response structure
  → apply merges (delete the duplicates, update the kept one)
  → apply promotions (insert into facts table with category='auto-promoted')
  → apply deletes (delete the rows)
  → write everything through db_writer (Phase 0 single-write-queue contract)
  → emit consolidation event to <subconscious_updates>
```

### 6.4 Why Hippocampus, not local logic

The spec (§9a) is explicit: the consolidation decisions are LLM-driven. Local heuristics (e.g., "rule text similarity > 0.9 → merge") cannot capture the semantic subtlety of "User prefers Yarn" + "Use Yarn not NPM" being equivalent. The LLM has the context to merge semantically equivalent but lexically distinct rules, and to recognize staleness ("Server is down") that pure time-based logic misses.

### 6.5 Cost control

Consolidation runs at most once per 24 hours + once per idle window. Each run uses Haiku (cheap). Estimated cost: <$0.01/day.

### 6.6 Safety constraints

- The Hippocampus prompt explicitly forbids deleting the 20 most recent rules (prevents accidentally erasing fresh knowledge)
- All writes go through `db_writer.enqueue_write` — concurrent edits from main loop won't conflict
- The LLM response is JSON-validated; malformed responses are dropped (no destructive writes)
- The fact-promotion uses `category='auto-promoted'` so the user can audit and revert in the Brain dashboard (v3)

### 6.7 Tests

- `test_v2_consolidation_scheduler.py` — scheduler fires at 24h + idle
- `test_v2_consolidation_merges_duplicates.py` — Hippocampus returns merges → duplicates removed, kept rule updated
- `test_v2_consolidation_promotes_patterns.py` — 5× repeated correction → fact inserted
- `test_v2_consolidation_deletes_stale.py` — Hippocampus returns deletes → rows removed
- `test_v2_consolidation_uses_write_queue.py` — all writes go through `db_writer.enqueue_write`
- `test_v2_consolidation_recent_protected.py` — most-recent 20 rules cannot be deleted
- `test_v2_consolidation_malformed_response.py` — non-JSON response → no destructive writes

### 6.8 Definition of Done

- Scheduler triggers at 24h interval and on idle (>5 min no activity)
- Hippocampus is actually called (mock the LLM)
- Merge / promote / delete operations execute correctly
- Writes go through `db_writer.enqueue_write`
- Recent rules (top 20) are protected from deletion
- Malformed responses are dropped safely
- Consolidation log visible in `<subconscious_updates>`

---

## 7. Phase 9b design — Delta engine LLM path + env-watcher subscription

### 7.1 Goal

The delta engine's `_call_hippocampus` stub is replaced with a real Hippocampus call that infers rules from batched file diffs. The engine subscribes to environment-watcher events (so it catches IDE edits the proxy never reads).

### 7.2 Files

- **Modify:** `backend-py/app/services/delta_engine.py` (implement `_call_hippocampus`, subscribe to env watcher)

### 7.3 Batched Hippocampus flow

```
queue accumulates diffs (write_file content hashes vs subsequent file reads/mtime changes)
  → every 24h OR when queue has 20+ entries:
    - flush queue
    - call Hippocampus with:
        "Review these diffs between the assistant's output and the user's edits.
         Infer up to 3 behavioral rules. Return JSON:
         {'rules': [{'rule': str, 'source': 'delta-engine', 'category': str}]}"
    - validate response
    - write rules to learned_heuristics via heuristics_service
```

### 7.4 Env-watcher subscription

When Phase 10.2 ships, the delta engine subscribes to `environment_watcher.on_change(path)` events. Each event triggers `check_and_diff(path)`. Until Phase 10.2 ships, the delta engine only catches edits via `read_file` after the model wrote the file.

### 7.5 Local fallback preserved

The local patterns (tabs vs spaces, quotes, semicolons, trailing commas) continue to work with `source="local-diff"` for users who haven't consented to LLM inference.

### 7.6 Tests

- `test_v2_delta_engine_llm_batch.py` — Hippocampus called with batched diffs, returns up to 3 rules
- `test_v2_delta_engine_writes_heuristics.py` — inferred rules persisted to `learned_heuristics`
- `test_v2_delta_engine_env_watcher_subscription.py` — env-watcher event triggers check_and_diff
- `test_v2_delta_engine_local_fallback.py` — local patterns still work when LLM consent is not granted

### 7.7 Definition of Done

- Hippocampus is actually called when consent is granted
- Up to 3 rules inferred per batch; rules written to `learned_heuristics`
- Env-watcher subscription works (skipped if env watcher not deployed)
- Local fallback continues to work

---

## 8. Phase 9c design — Episodic timeline

### 8.1 Goal

`episodic_timeline` table (already exists) gets populated on session end / major goal complete. `search_timeline` becomes reachable via `brain_query(store="timeline")`. An hourly sweep catches missed sessions.

### 8.2 Files

- **Modify:** `backend-py/app/services/memory_store.py` (timeline writer + hourly sweep registration)
- **New:** `backend-py/app/services/scheduler.py` (already new from §6; add hourly timeline sweep)

### 8.3 Population flow

On session end (`delete_workbench_session`):
1. Generate a 1-line summary of the session's main topic + outcome (Hippocampus call)
2. Insert into `episodic_timeline(timestamp, session_id, event_summary, category)`
3. If goal completed in mid-session, similar write

### 8.4 Hourly sweep

Every hour, scan for sessions that ended >5 minutes ago with no timeline entry. For each, generate the summary and insert. Handles crashes, abandoned sessions, disconnects.

### 8.5 Reachable via brain_query

The timeline store is already in `_BRAIN_STORES` (post-v1.1) so `brain_query(store="timeline", query=..., filters={"since": date, "category": str})` works. The brain_query path's existing FTS-style query handles search.

### 8.6 Tests

- `test_v2_timeline_populate_on_session_end.py` — session end → timeline row inserted with summary
- `test_v2_timeline_hourly_sweep.py` — sessions with no entry get one on next sweep
- `test_v2_timeline_brain_query.py` — `brain_query(store="timeline", query="auth")` returns matching rows

### 8.7 Definition of Done

- Session end triggers summary + insert
- Hourly sweep catches missed sessions
- `brain_query(store="timeline")` returns results

---

## 9. Phase 10.1 design — Blackboard adaptive TTL + ack + Tier 3 injection

### 9.1 Goal

Blackboard (currently flat 60s TTL, no ack, not injected) gets adaptive TTL, `ack=True` parameter, and `<blackboard_state>` Tier 3 injection.

### 9.2 Files

- **Modify:** `backend-py/app/services/blackboard_service.py` (adaptive TTL, ack support)
- **Modify:** `backend-py/app/services/workbench/workbench.py` (`<blackboard_state>` injection)
- **Modify:** `backend-py/app/services/tool_definitions.py` (`read_blackboard(ack=True)` parameter)

### 9.3 Adaptive TTL

TTL is `max(poll_interval_of_owning_daemon × 2, 60s)` or 3 turns, whichever comes first. A CI watcher polling every 30s gets notes that live ≥60s (covering its next poll). A fast env-watcher polling every 2s gets notes that live ≥4s.

The TTL is computed at note-creation time: the writer passes `poll_interval=...` based on its daemon context. For non-daemon writers (main loop, manual writes), default to 60s.

### 9.4 Ack mechanism

`read_blackboard(agent, key, ack=True)` reads a note and deletes it on read. Acknowledged notes are immediately removed from storage.

### 9.5 Tier 3 injection

In `workbench.build_system_prompt`, before final assembly:
1. Call `blackboard_service.read_notes(session_id, ttl_only=True)` to get all unexpired notes for this session
2. Format as `<blackboard_state><note agent="..." key="..." priority="...">value</note></blackboard_state>`
3. Inject conditionally — empty list = no block

### 9.6 Tests

- `test_v2_blackboard_adaptive_ttl.py` — `max(poll_interval×2, 60s)` computes correctly for various intervals
- `test_v2_blackboard_ack.py` — `ack=True` deletes the note immediately
- `test_v2_blackboard_tier3_injection.py` — notes appear in `<blackboard_state>` in next prompt
- `test_v2_blackboard_session_scoping.py` — notes from session A don't leak into session B
- `test_v2_blackboard_expired_cleanup.py` — expired notes are filtered before injection

### 9.7 Definition of Done

- TTL computed as `max(poll_interval×2, 60s)` or 3 turns
- `ack=True` parameter on `read_blackboard` deletes the note
- `<blackboard_state>` injected in Tier 3 when populated
- Session scoping holds
- Expired notes filtered before injection

---

## 10. Phase 10.2 design — Environment watcher

### 10.1 Goal

`environment_watcher.watch()` (currently `pass`) becomes a real `watchdog`-based observer that detects filesystem modifications, git branch changes, and terminal activity.

### 10.2 Files

- **Modify:** `backend-py/app/services/environment_watcher.py` (full implementation)
- **Modify:** `backend-py/pyproject.toml` (add `watchdog` dependency)
- **Modify:** `backend-py/app/services/workbench/workbench.py` (`<environment>` injection in `<runtime_context>`)
- **Modify:** `backend-py/app/services/delta_engine.py` (subscribe to events)

### 10.3 Watcher design

```python
class EnvironmentWatcher:
    """v2: watchdog-based observer for fs/git/terminal changes."""

    def __init__(self):
        self._observer = Observer()
        self._ignore_patterns = [
            "*.pyc", "__pycache__", "node_modules", ".git/objects",
            ".git/index.lock", "*.swp", ".DS_Store",
        ]
        self._rate_limit_seconds = 2.0
        self._last_emit = 0.0
        self._change_buffer: list[ChangeEvent] = []
        self._subscribers: list[Callable[[ChangeEvent], None]] = []

    def start(self, root_path: Path) -> None:
        self._observer.schedule(self._on_fs_change, str(root_path), recursive=True)
        self._observer.start()

    def _on_fs_change(self, event):
        if self._should_ignore(event.src_path):
            return
        now = time.monotonic()
        if now - self._last_emit < self._rate_limit_seconds:
            # Buffer; flush after rate-limit window
            self._change_buffer.append(event)
            return
        self._emit(event)

    def subscribe(self, callback: Callable[[ChangeEvent], None]) -> None:
        self._subscribers.append(callback)
```

### 10.4 What gets reported

- File changed (path, kind: create/modify/delete/move)
- Git branch (current branch + ahead/behind main)
- Terminal activity (last command, idle time)

### 10.5 Ignore patterns

`*.pyc`, `node_modules`, `.git/objects`, swap files, OS metadata. Without these, the rate limiter would fire constantly.

### 10.6 Tier 3 injection

In `<runtime_context>` (Tier 3), append an `<environment>` block:

```xml
<runtime_context>
  ...existing fields...
  <environment>
    File changed: src/auth.py (external edit, 2s ago)
    Git branch: feature/jwt-fix (ahead of main by 3 commits)
    Last command: git push origin feature/jwt-fix (15s ago)
  </environment>
</runtime_context>
```

### 10.7 Delta engine subscription

`delta_engine.start_subscribing(env_watcher)` registers a callback that calls `check_and_diff(path)` on file modification events. Until env watcher ships, delta engine only catches edits via `read_file`.

### 10.8 Tests

- `test_v2_env_watcher_fs_modify.py` — file modify event captured and emitted
- `test_v2_env_watcher_ignore_patterns.py` — `.pyc`, `node_modules`, `.git/objects` ignored
- `test_v2_env_watcher_rate_limit.py` — second event within 2s buffered, flushed after window
- `test_v2_env_watcher_tier3_injection.py` — `<environment>` block appears in prompt
- `test_v2_env_watcher_delta_subscription.py` — env event triggers delta engine check

### 10.9 Definition of Done

- `watchdog` integrated; fs mods detected
- Ignore patterns applied
- Rate limit enforced (1 update / 2s)
- `<environment>` injected in `<runtime_context>`
- Delta engine subscribed to events

---

## 11. Phase 10.3 design — Verifier reflex

### 11.1 Goal

`update_state(phase="review"|"complete")` triggers `<verifier_gate>` injection. The model must run a verification command before declaring done.

### 11.2 Files

- **Modify:** `backend-py/app/services/workbench/workbench.py` (inject `<verifier_gate>` based on session state)
- **Modify:** `backend-py/app/services/memory/context_builder.py` (render `<verifier_gate>` Tier 3 block)
- **Modify:** `backend-py/app/services/tool_definitions.py` (`update_state` already accepts `verification_command` — verify)

### 11.3 Trigger logic

When `build_system_prompt(session)` is called:
1. Read `session._execution_state` (set by `update_state`)
2. If `phase in ("review", "complete")`:
   - If `verification_command` is non-empty → inject specific gate:
     ```xml
     <verifier_gate>
       You marked step N as complete. Verify before proceeding:
       Run: <command>
       Confirm output shows "PASSED" or "0 failed".
       Only then use update_state to transition to "review".
     </verifier_gate>
     ```
   - If empty → inject generic gate:
     ```xml
     <verifier_gate>
       You are about to mark a step complete without verification.
       Run the appropriate test/lint/validation command, then confirm
       the result before calling update_state(phase="review").
     </verifier_gate>
     ```

### 11.4 Re-gating

When the model runs a verification command and it fails, the proxy allows fix attempts (tool calls still work). But `update_state(phase="review")` re-triggers the gate until the verification passes. The gate is per-`update_state` call — each call to `update_state(phase="review")` re-injects.

### 11.5 System constraint (already in Tier 1 from v1.1)

The Tier 1 already has:
> Verifier Gate: Before transitioning to "review" or "complete", you must execute a verification command. Include `verification_command` in your `update_state` call. If verification fails, fix the issue and re-verify. Do not skip or fake verification output.

v2 wires the gate injection; v1.1 added the rule text.

### 11.6 Tests

- `test_v2_verifier_gate_specific.py` — `phase="review"` + non-empty `verification_command` → specific gate with command
- `test_v2_verifier_gate_generic.py` — `phase="review"` + empty `verification_command` → generic reminder
- `test_v2_verifier_gate_no_gate.py` — `phase="implement"` → no gate
- `test_v2_verifier_gate_repeat.py` — second call to `update_state(phase="review")` re-injects gate

### 11.7 Definition of Done

- `<verifier_gate>` injected on `phase=review|complete`
- Specific command rendered when supplied, generic reminder when empty
- Re-gates on each `update_state(phase="review")` call
- No gate for other phases

---

## 12. Phase 10.4 design — Skill genesis

### 12.1 Goal

After successful complex sessions, the consolidation daemon (now Hippocampus-driven) drafts a SKILL.md using the **Prefrontal** model. Drafts go to `data/skills/staging/` + `pending_skills` table. The user must approve before activation.

### 12.2 Files

- **Modify:** `backend-py/app/services/consolidation_daemon.py` (add skill-drafting step after consolidation)
- **New table:** `pending_skills` in `memory_store.py` (id, name, draft_path, source_workflows, created_at, status)
- **Modify:** `backend-py/app/routers/brain.py` (existing /api/brain/learning returns pending_skills; v2 just makes them real)
- **New:** `data/skills/staging/` directory (created on demand)

### 12.3 Skill genesis flow

After consolidation completes:
1. Identify complex, multi-step sessions from the last 24h (heuristic: ≥3 `update_state` calls with phase changes, ≥5 tool calls, no errors)
2. For each such session, check if a skill for the same workflow already exists in `learned_heuristics` (cross-reference to avoid duplicates)
3. Call Prefrontal with session transcript + outcome:
   > "This session completed a complex multi-step workflow. Is this workflow generic enough to be turned into a reusable skill? If yes, draft a SKILL.md with: name, description, trigger, and step-by-step procedure body. Return JSON: {'name': str, 'description': str, 'trigger': str, 'body': str} or {'skip': true, 'reason': str}"
4. Validate response (name is unique, body is non-empty)
5. Write to `data/skills/staging/<name>.md`
6. Insert into `pending_skills(name, draft_path, source_workflows, status='pending')`
7. Surface in Brain dashboard's Learning tab (already plumbed in v3 stub) for user approval

### 12.4 Quality guard

- Minimum 3 successful uses before activation (counter in `pending_skills` incremented on each use)
- Max 1 auto-generated skill per day (rate-limited)
- All generated skills tagged `created_by: auto-gen` in their frontmatter

### 12.5 User approval flow

When the user opens the Skills section, they see pending skills with approve / edit / reject. Approve moves the file to active skills directory. Reject deletes the staging file and marks `pending_skills.status='rejected'`.

Staging entries persist **indefinitely** (per spec). Stale entries (>30 days, never matched by BM25) are surfaced once more as *"stale — review or dismiss"* and never auto-deleted.

### 12.6 Tests

- `test_v2_skill_genesis_quality_guard.py` — single-use session does NOT generate a skill
- `test_v2_skill_genesis_writes_staging.py` — generated skill written to `data/skills/staging/`
- `test_v2_skill_genesis_pending_table.py` — `pending_skills` row inserted with `status='pending'`
- `test_v2_skill_genesis_uses_prefrontal.py` — Prefrontal model called (mock the LLM)
- `test_v2_skill_genesis_rate_limit.py` — second skill in same day rejected
- `test_v2_skill_genesis_user_approval.py` — approved skill moves to active dir; rejected one cleaned up
- `test_v2_skill_genesis_staging_persistence.py` — staging entries persist indefinitely; 30-day stale surfaced but never auto-deleted

### 12.7 Definition of Done

- `pending_skills` table exists; staging directory exists
- Quality guard (≥3 uses) prevents single-use skills
- Max 1/day rate limit enforced
- Generated skills tagged `created_by: auto-gen`
- User approval flow works (approve → active, reject → cleanup)
- Stale entries surfaced but never auto-deleted

---

## 13. Cross-cutting: scheduler

### 13.1 File: `backend-py/app/services/scheduler.py` (new, ~80 lines)

Centralized scheduler for periodic and idle-triggered tasks:

```python
"""v2: Centralized scheduler for periodic and idle-triggered tasks."""

class Scheduler:
    def __init__(self):
        self._tasks: dict[str, ScheduledTask] = {}
        self._last_activity: dict[str, float] = {}  # session_id -> timestamp

    async def start(self) -> None:
        """Boot the scheduler; runs forever."""

    def register_periodic(self, name: str, fn: Callable, interval_seconds: int) -> None:
        """Run `fn` every `interval_seconds`."""

    def register_idle(self, name: str, fn: Callable, idle_threshold_seconds: int = 300) -> None:
        """Run `fn` when all sessions have been idle for `idle_threshold_seconds`."""

    def record_activity(self, session_id: str) -> None:
        """Called by workbench on each turn; resets the idle timer for that session."""
```

### 13.2 Scheduled tasks in v2

| Task | Trigger | Handler |
|------|---------|---------|
| Consolidation | Every 24h OR all-sessions idle >5 min | `consolidation_daemon.run_consolidation()` |
| Timeline sweep | Every 1h | `memory_store.timeline_sweep()` |
| Delta engine batch flush | Every 24h OR 20+ queued diffs | `delta_engine.flush_queue()` |

### 13.3 Tests

- `test_v2_scheduler_periodic.py` — periodic task fires at interval
- `test_v2_scheduler_idle.py` — idle task fires after threshold
- `test_v2_scheduler_record_activity.py` — activity resets idle timer

---

## 14. Testing strategy

- Each v2 component has its own test file(s) under `backend-py/tests/v2_*.py`
- Tests mock all LLM calls (Anthropic, OpenAI, local) — no real API calls in CI
- Tests use an in-memory SQLite or the existing test DB (idempotent)
- Daemon tests use `asyncio` with mocked async model calls
- Scheduler tests use a fake clock (`asyncio.sleep` patched) for fast iteration
- Total v2 test count target: ~40-50 tests

---

## 15. Risk register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Hippocampus returns malformed JSON for consolidation | Medium | Medium | JSON-validated; malformed → no destructive writes; logged |
| Daemon tool enforcement bypass (model finds a way to mutate) | Low | High | Blocklist at dispatch layer, not daemon code; test with adversarial prompts |
| Consolidation deletes a rule the model needed | Low | High | Most-recent 20 rules protected; reversible via re-add from session history |
| Env watcher floods context with file events | High | Medium | Rate limit + ignore patterns; buffered emission |
| Scheduler keeps running after app shutdown | Medium | Low | Cancel tasks in app lifespan shutdown; gather with timeout |
| Skill genesis drafts duplicate or low-quality skills | Medium | Medium | Quality guard (≥3 uses before activation); user approval required |
| Watchdog library missing on some platforms | Low | Medium | Fallback to 5s polling if watchdog import fails |
| Blackwell writes leak across sessions | Low | High | session_id scoping verified in tests |

---

## 16. Definition of Done (overall v2)

All 8 components (Phase 8, 9a, 9b, 9c, 10.1, 10.2, 10.3, 10.4) ship with:
- Working implementation (no stubs)
- Tests passing (TDD red-green for every task)
- All writes through `db_writer.enqueue_write`
- All model calls through `model_fleet.get_model_for_role`
- `<subconscious_updates>`, `<blackboard_state>`, `<environment>`, `<verifier_gate>` all conditionally rendered
- Trackers updated to reflect actual verified state
- No regressions to v1.1 chat loop

The system, after v2, behaves like a true cognitive partner: it has a subconscious, sleeps and consolidates, learns from your edits, validates its own work, and grows its own expertise.

---

## 17. Open questions

These are deliberately left for the v2 implementation plan to resolve:

1. **Scheduler lifetime:** does the scheduler run as a module-level singleton, or per-process via the app lifespan?
2. **Idle detection granularity:** per-session idle, or global "all sessions idle for X seconds"? (Spec implies per-session for daemons, global for consolidation.)
3. **Watchdog fallback behavior:** when `watchdog` isn't available, do we still try to install it (e.g., uv add at startup) or fall back silently to polling?
4. **Skill quality signal:** beyond "≥3 uses", what other signals indicate quality? (Could be: no user-corrections-during-use, prompt mentions the workflow again, etc.)
5. **Prefrontal default:** the spec recommends Sonnet 4 / Opus. For users without those, fallback to Cortex? Or require explicit config?

---

## 18. Glossary additions (vs v1.1)

- **Cerebellum** — fast, cheap model (Haiku, GPT-4o-mini) used by daemons and watchers
- **Hippocampus** — moderate model (Haiku) used by consolidation, delta engine, context compaction
- **Prefrontal** — highest-reasoning model (Sonnet 4, Opus) used by skill genesis
- **Skill genesis** — the process of the brain writing its own SKILL.md from successful workflows
- **Verifier gate** — the per-turn `<verifier_gate>` injection that forces the model to prove a task is done
- **Adaptive TTL** — blackboard note lifetime based on the writer's poll interval

---

**End of design doc. After your review, I'll invoke the writing-plans skill to produce the v2 implementation plan.**

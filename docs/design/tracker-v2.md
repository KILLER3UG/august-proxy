# Implementation Tracker — v2 (Phases 8–10)

> **Spec:** [`cognitive-architecture-v1.md`](./cognitive-architecture-v1.md)
> **Scope:** Autonomous layers — subconscious daemons, cognitive maintenance
> (sleep cycle / delta engine / timeline), and advanced frontiers
> (blackboard, environment watcher, verifier reflex, skill genesis).
> **Previous file:** [`tracker-v1.md`](./tracker-v1.md) — must be 100% complete first.
> **Next file after this one:** [`tracker-v3.md`](./tracker-v3.md)

## Gate — do not start until

- [ ] [`tracker-v1.md`](./tracker-v1.md) fully checked and **verified in production**
- [ ] Phase 0 DB write queue (`db_writer.py`) is live (every v2 daemon writes through it)
- [ ] `cognitive_layers` v2 flags exist in `data/config.json` (default `false`)

> Each v2 phase warrants its own design review (per spec). Phases 9 and 10 both
> depend on **Phase 8 daemon infrastructure** — build Phase 8 first. Within v2,
> flip each flag to `true` only when its DoD is met.

## Progress

| Phase | Component | Flag | Status | Owner | Notes |
|------:|-----------|------|--------|-------|-------|
| 8 | Subconscious Daemons | `daemons` | ✅ done & verified | | daemon_manager.py with asyncio task pool, lifecycle, restricted tools. spawn_daemon/list_daemons/kill_daemon registered. <subconscious_updates> injected. |
| 9a | Sleep Cycle (consolidation) | `daemons` (built on 8) | ☐ | | |
| 9b | Delta Engine (implicit prefs) | (opt-in consent) | ☐ | | needs Phase 10 env watcher for external edits |
| 9c | Episodic Timeline | (core tool) | ☐ | | |
| 10.1 | Shared Blackboard | `blackboard` | ☐ | | |
| 10.2 | Environment Watcher | `env_watcher` | ☐ | | |
| 10.3 | Verifier Reflex | `verifier_reflex` | ☐ | | |
| 10.4 | Skill Genesis | `skill_genesis` | ☐ | | |

Status legend: ☐ not started · ◐ in progress · ✅ done & verified · ⚠ blocked

---

## Phase 8 — Subconscious Daemons & Proactive Interrupts

### Tasks
- [x] New `services/daemon_manager.py` — asyncio task pool, lifecycle, result storage
- [x] Core tools `spawn_daemon` / `list_daemons` / `kill_daemon`
- [x] Daemons run on **Cerebellum** model (`get_model_for_role("cerebellum")`)
- [x] Restricted read-only tool set by default (web_fetch, read_file, list_directory, search_files, run_command read-only); `tools` allowlist param; `tools=[]` disables
- [x] Watch conditions: `on_completion` / `on_match:KEYWORD` / `on_change` / null
- [x] Inject `<subconscious_updates>` Tier 3 from results
- [x] Proactive interrupt rules in `<system_constraints>`; `[CRITICAL]` prefix → model must pause
- [x] Max 3 concurrent daemons/session; results expire after 5 turns
- [x] Crash handling: wrap each run in try/except → status `errored` + truncated traceback; cap 2 retries
- [x] Exponential backoff on API failure (5→15→45→135s, cap 5min); reset on success
- [x] Graceful cancel on app shutdown (`asyncio.gather`, 5s timeout)

### Files
`daemon_manager.py` (new), `workbench.py`, `system_constraints` (Tier 1).

### Tests
- [ ] spawn/list/kill lifecycle; result injection; expiry after 5 turns
- [ ] Max-daemon cap (3); critical trigger pauses; `errored` status propagates; backoff

### Definition of Done
Model can run bounded read-only background tasks that surface results/errors without blocking the main loop.

### Notes

---

## Phase 9 — Autonomous Cognitive Maintenance

### 9a. Sleep Cycle (Consolidation Daemon)
- [ ] New `services/consolidation_daemon.py` (built on Phase 8 infra)
- [ ] Trigger on idle or every 24h; uses **Hippocampus** model
- [ ] Merge duplicate heuristics; promote 5×-repeated corrections → `fact`; delete stale
- [ ] Writes through Phase 0 write queue

### 9b. Implicit Preference Delta Engine
- [ ] New `services/delta_engine.py`
- [ ] Track `write_file` content hashes (model-written files, last 24h only)
- [ ] **Opt-in first-run consent dialog** (default **No**); only diff after consent
- [ ] Local-only fallback (tabs/spaces, quotes, semicolons, trailing commas) → `source="local-diff"`, no LLM
- [ ] LLM path: batch diffs (flush at 24h or 20 entries), Hippocampus infers ≤3 rules → `learned_heuristics`
- [ ] Subscribe to env-watcher events (Phase 10); degrade to `read_file`-only edits if env watcher absent

### 9c. Episodic Timeline Indexing
- [ ] `episodic_timeline` table in `memory_store.py`
- [ ] Populate on session end / major goal complete (1-line summary)
- [ ] Hourly sweep for sessions ended >5min ago with no entry → Hippocampus summary
- [ ] Core tool `search_timeline(from_date, to_date, category)`
- [ ] Wire into `brain_query(store="timeline")` (§11)

### Files
`consolidation_daemon.py`, `delta_engine.py` (new ×2), `memory_store.py`, `tool_definitions.py`, `workbench.py`.

### Tests
- [ ] Sleep cycle merge/promote/delete; delta-engine consent gating + local fallback; batch flush
- [ ] Timeline populate + hourly sweep + `search_timeline` ranges

### Definition of Done
System consolidates memory on idle, learns from edits **only with consent**, and answers temporal queries.

### Notes

---

## Phase 10 — Advanced Cognitive Frontiers

### 10.1 Shared Blackboard
- [ ] New `services/blackboard_service.py`; `blackboard` table (session-scoped)
- [ ] Core tools `write_blackboard` / `read_blackboard(ack)` / `clear_blackboard`
- [ ] Adaptive TTL `max(poll_interval×2, 60s)` or 3 turns; auto-delete expired before injection
- [ ] Inject `<blackboard_state>` Tier 3; wire `brain_query(store="blackboard")`

### 10.2 Environment Watcher
- [ ] New `services/environment_watcher.py` (watchdog, 5s polling fallback)
- [ ] Watch fs mods / git branch / terminal activity; ignore `.pyc`, `node_modules`, `.git/objects`
- [ ] Rate-limit max 1 update / 2s; inject `<environment>` into `<runtime_context>`
- [ ] Emit file-change events the delta engine (9b) subscribes to

### 10.3 Verifier Reflex
- [ ] Extend `update_state` with `verification_command`
- [ ] On `phase=review|complete`: inject `<verifier_gate>` (specific cmd if supplied, generic if not)
- [ ] Proxy enforces verification happens; does NOT generate commands; re-gates until pass
- [ ] `<system_constraints>` verifier rule

### 10.4 Skill Genesis
- [ ] Upgrade consolidation daemon to draft SKILL.md from complex successes (**Prefrontal** model)
- [ ] Quality guard: ≥3 successful uses; max 1/day; tag `created_by: auto-gen`
- [ ] Write to `<data_dir>/skills/staging/` + `pending_skills` table (NOT active)
- [ ] **User approval required**; staging persists indefinitely; 30-day stale-with-zero-signal → surfaced once, never auto-deleted
- [ ] Approved skills move to active dir; BM25 manifest picks them up
- [ ] Surface `pending_skills` in Brain dashboard Learning tab (§12)

### Files
`blackboard_service.py`, `environment_watcher.py` (new ×2), `memory_store.py` (blackboard + episodic tables), `workbench.py`, `tool_definitions.py`, `consolidation_daemon.py`.

### Tests
- [ ] Blackboard CRUD + adaptive TTL + session scoping
- [ ] Env watcher file/git detection + ignore rules + rate limit
- [ ] Verifier gate injection (specific + generic); re-gate on failure
- [ ] Skill genesis quality gate; staging→approval flow; nothing auto-deleted
- [ ] Timeline search (if not covered in 9c)

### Definition of Done
Daemons and main loop coordinate via blackboard; the proxy sees the environment between turns; completion is gated behind verification; the system can propose (never silently activate) new skills.

### Notes

---

## v2 exit criteria (all must hold before [`tracker-v3.md`](./tracker-v3.md))
- [ ] Every phase box above checked
- [ ] v2 flags flipped `true` per-phase as DoD met; rollback (flag → false) verified
- [ ] Each shipped layer exposes a `selfcheck()` (consumed by §12 dashboard)
- [ ] No regression to v1 main chat loop with all v2 layers enabled
- [ ] v2 verified in production

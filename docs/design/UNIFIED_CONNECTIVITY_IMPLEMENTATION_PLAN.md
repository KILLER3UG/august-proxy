# Unified Connectivity & Memory Implementation Plan

> **Status:** Active — partially implemented (see § Progress snapshot)  
> **Created:** 2026-07-14  
> **Last updated:** 2026-07-14  
> **Standard:** Every deliverable is a **long-term fix** (see §0.1). Temporary bridges need a sunset.  
> **Purpose:** Single trackable plan for connectivity, sessions, memory, MCP/Live, and honest UI.  
> **How to use:** Check boxes as work ships. IDs below (S1, M1, G1, …) are **plan-internal only** — do **not** put them in git commit messages; use plain English instead.

### Language rules (commits **and** code comments)

Use plain English. Do **not** use plan IDs (`S1`, `G1`, `M1`, `B2`, …) in:

- git commit subjects/bodies  
- code comments or docstrings  

Plan IDs stay **only in this document** for tracking.

Good commit: `feat(sessions): store workbench sessions in SQLite`  
Bad commit: `feat: implement S1/B2`

Good comment: `// Primary store is SQLite; JSON file is export only`  
Bad comment: `// Phase B SoT write (S1/S2)`

---

## 0.1 Long-term fix standard (non-negotiable)

A change is **in scope** only if it meets **all** of:

| Criterion | Meaning |
|-----------|---------|
| **Single durable SoT** | One authoritative store per concern (sessions, brain facts, vectors, …). Secondary files are export/cache only, or are deleted. |
| **Crash-safe** | Process kill mid-write cannot leave permanent silent divergence without recovery (txn, outbox, or rebuild from SoT). |
| **One config / one API** | No dual readers, dual flag schemas, or “Node path vs Python path” forever. |
| **Honest product surface** | UI and tools either work end-to-end or are disabled/hidden — **no stub success**, no empty health “off” while boot runs. |
| **Removable migration** | Any bridge (JSON mirror, dual-write, compatibility alias) has a **sunset phase** and removal task. |
| **Test + smoke** | Unit/integration + `scripts/smoke_live.py` (or successor) covers the SoT path. |

### Explicitly **not** long-term (forbidden as end state)

| Anti-pattern | Why forbidden | Required end state instead |
|--------------|---------------|----------------------------|
| Forever dual-write JSON ↔ SQLite “best effort” | Diverges under crash/load | SQLite SoT; optional JSON export |
| Forever “or hide later” without a decision | Leaves dead code paths | **Wire into SQLite** *or* **remove UI/API** in same program |
| Forever two fleet modules / two flag maps | Silent no-ops | One module, one schema |
| Forever `/ui/mcp` + `/api/mcp` | Broken operator UX | One API family |
| Forever stub Live / proxy tools | False product claims | Real path or feature flag off by default + UI disabled |
| Forever health probing tables that don’t exist | False “unhealthy” / lies | Schema matches probes **or** probes match real storage |
| Forever age-dropping cognitive writes | Silent data loss | Never drop must-succeed brain writes |

### Migration bridges (allowed only with sunset)

| Bridge | Allowed through | Must remove by | Status |
|--------|-----------------|----------------|--------|
| JSON write-through of sessions | After SQLite SoT | Export-only or delete | **JSON is export only**; SQLite is primary |
| Dual-write as architecture | Until session SoT | Primary write only | **Largely retired** — chat persists via SQLite blob txn |
| Config key aliases | Until config SoT | Drop old readers | **Open** |
| camelCase/snake dual-get in brain_query | Permanent wire OK | N/A | Keep for API stability |

---

## Progress snapshot (2026-07-14)

### Shipped (do not re-open as greenfield)

| Area | Status | Notes |
|------|--------|--------|
| Prompt camel/snake + auto-memory + failure_feedback | Done | Dual-get permanent for API stability |
| Tool-round cap, session concurrency | Done | Keep |
| Settings tab without full page remount | Done | Keep |
| Remove dead Node `/ui/*` client paths | Done | Desktop + mobile audit on `/api/*` |
| MCP / services / terminal / usage routes on Python | Done | Live handlers under `/api/*` |
| Service connections + MCP global env | Done | Durable `config.json` |
| Automations durable store | Done | `data/automations.json` |
| Preview → terminal service | Done | Not an empty in-memory stub |
| Curator + subagent orchestrator always available | Done | Lifespan + lazy `runtime_services` |
| **Session SQLite SoT** (blob + messages) | **Done (core)** | `sessions.workbench_blob`; load SQLite first; JSON export only |
| Chat sticks `session.model` / `session.provider` | Done | BTW / Live reuse chat LLM |
| **BTW uses chat LLM only** | Done | No separate model/key; body is sessionId + question only |
| Live session/turn on real `wb_*` sessions | Partial | Real workbench ids; STT/TTS still fail-closed 501 |
| Usage analytics routes | Done | stats / heatmap / by-model / by-day |
| Host agent health shape | Done | Honest disconnected when URL unset |

### Still open (priority order)

| Area | Plain description | Plan IDs (internal) |
|------|-------------------|---------------------|
| Fleet dual path | One model-fleet module + cache bust on Settings save | F1, A1 |
| Cognitive config tree | Single `auxiliary.cognitive` for boot, health, Settings | C5, F2, A2 |
| Session reconcile UI | Chat sidebar only workbench session API; `/api/sessions` alias or non-chat | S4, L5, B3 |
| One cognitive scheduler | No double consolidation loops | C1–C2 |
| Env watcher real | Session workspace + SQLite log | C3 |
| Vector / graph | Wire writers into SQLite **or** remove UI claims | M1, M2, D2, D3 |
| db_writer honesty | Never age-drop must-succeed writes | M5, D1 |
| Full MCP protocol | Spec stdio/SSE, boot load, auto-start | G1, E1 |
| Live STT/TTS | Real providers **or** browser-only + hide server UI | G3, E2 |
| Proxy tool stubs | Route to tool_registry; no `"Stub:"` success | X1, E3 |
| Cognitive ops UI | Operator panel for layers / sync / consolidation | L1 |
| Host agent process | External agent URL **or** hide computer-use when down | — |

### Architecture now (as of update)

```
┌──────────── Frontend ────────────┐
│ Chat ──► /api/workbench/*        │  primary agent path
│ MCP ──► /api/mcp/* only          │  done (no /ui/mcp)
│ BTW ──► session chat LLM only    │  done
└───────────────┬──────────────────┘
                │
┌───────────────▼──────────────────┐
│ FastAPI                           │
│ Session SoT: SQLite               │
│   sessions.workbench_blob + msgs  │  done (core B)
│   JSON export optional            │
│ Brain tools / brain_query         │  same DB
│ vector/graph JSON                 │  still residual (open)
└───────────────────────────────────┘
```

---

## 0.1 North-star (final architecture) — unchanged goal

1. **One session SoT:** SQLite (blob + messages + FTS). JSON optional export only.  
2. **One brain write facade:** transactional multi-table updates.  
3. **One cognitive config:** `auxiliary.cognitive.{boot,features,fleet,orchestrator}`.  
4. **One fleet module** with cache invalidation and `dataPath`.  
5. **Honest surfaces:** MCP / Live / proxy tools real or feature-gated off.  
6. **One frontend API contract** per domain.  
7. **Memory planes in SQLite** (or removed from product).

---

## 2. Full gap inventory

Severity: **P0** product-broken / data integrity · **P1** operator/cognitive · **P2** feature · **P3** polish  

Status column: **Done** | **Partial** | **Open**

### 2.1 Sessions

| ID | Sev | Gap | Long-term end state | Status |
|----|-----|-----|---------------------|--------|
| **S1** | P0 | Multiple session planes | SQLite only SoT; memory is cache | **Done (core)** — blob + messages |
| **S2** | P0 | Dual-write architecture | Primary SQLite txn; no permanent dual SoT | **Done (core)** — chat uses `save_workbench_session_sot` |
| **S3** | P1 | Backfill / one-way migration | One-shot JSON→SQLite import | **Partial** — load migrates if SQLite empty |
| **S4** | P1 | ID / reconcile split | One chat ID scheme; workbench API only | **Open** |
| **S5** | P2 | Usage session id | Usage uses SoT session id | **Partial** |

### 2.2 Memory planes

| ID | Sev | Gap | Long-term end state | Status |
|----|-----|-----|---------------------|--------|
| **M1** | P2 | Vector JSON, no writers | SQLite + ingest **or** remove UI | **Open** |
| **M2** | P2 | Graph JSON, no writers | SQLite + pipeline **or** remove | **Open** |
| **M3** | P1 | Multi-plane chaos | One brain write facade | **Open** |
| **M4** | P1 | Hot path vs db_writer | Documented write classes | **Open** |
| **M5** | P1 | Fake priority / age-drop | Never drop must-succeed work | **Open** |
| **M6** | P2 | LIKE-only messages | messages_fts on write | **Partial** (FTS work elsewhere; keep verifying) |

### 2.3 Cognitive runtime

| ID | Sev | Gap | Long-term end state | Status |
|----|-----|-----|---------------------|--------|
| **C1** | P1 | Two schedulers | One CognitiveScheduler | **Open** |
| **C2** | P1 | Consolidation weak | Durable last run + real work | **Open** |
| **C3** | P1 | Env watcher disconnected | Session-scoped + SQLite log | **Open** |
| **C4** | P2 | Daemon placeholder | Real generate + fleet | **Open** |
| **C5** | P0 | Flag inconsistency | Single cognitive tree | **Open** |
| **C6** | P1 | Selfcheck vs schema | Probes match storage | **Partial** |
| **C7** | P2 | Cron shell-only | Job types enum | **Partial** (automations durable shell) |

### 2.4 MCP / gateway / live / proxy

| ID | Sev | Gap | Long-term end state | Status |
|----|-----|-----|---------------------|--------|
| **G1** | P0 | Incomplete MCP protocol | Spec client + boot load + auto-start | **Open** (HTTP registry works; protocol depth open) |
| **G2** | P2 | Gateway session map | Same SoT as workbench | **Open** |
| **G3** | P0 | Live stubs | Real workbench turn; STT/TTS real or off | **Partial** — real sessions/turn; STT/TTS 501 honest |
| **X1** | P0 | Proxy tool stubs | tool_registry only | **Open** |
| **X2** | P1 | Silent except | Metrics + policy | **Partial** |
| **X3** | P2 | Delta consent | Real consent store | **Open** |

### 2.5 Config & fleet

| ID | Sev | Gap | Long-term end state | Status |
|----|-----|-----|---------------------|--------|
| **F1** | P0 | Dual fleet + sticky cache | One module + invalidate | **Open** |
| **F2** | P1 | Orchestrator vs layers | Nested under cognitive | **Open** |
| **F3** | P2 | Policy weak | One enforcement path | **Open** |

### 2.6 Frontend

| ID | Sev | Gap | Long-term end state | Status |
|----|-----|-----|---------------------|--------|
| **L1** | P0 | No cognitive ops UI | Operator panel | **Open** |
| **L2** | P1 | Learning mutations | Wire mutations | **Open** |
| **L3** | P0 | Dead `/ui/*` paths | Python `/api/*` only | **Done** |
| **L4** | P0 | Node health dialect | Python health shapes | **Partial** |
| **L5** | P1 | Wrong reconcile plane | Workbench SoT API only | **Open** |

### 2.7 Product honesty extras (this track)

| Topic | Long-term end state | Status |
|-------|---------------------|--------|
| BTW LLM | Always session chat model; no separate key/model | **Done** |
| Service connections | Durable config + real routes | **Done** |
| Automations | Durable store | **Done** |
| Preview | Real terminal-backed | **Done** |
| Curator / subagents boot | Always initialized | **Done** |

---

## 3. Target architecture (to-be) — permanent

```
┌──────────────── Frontend ────────────────┐
│ Chat + reconcile ──► workbench session API │  same SoT
│ System Health ──► Python detailed health   │
│ Cognitive ops ──► /api/config/cognitive +  │
│                   /api/brain/* ops         │
│ MCP ──► /api/mcp/* only                    │
│ Learning ──► mutations + run consolidation │
│ BTW ──► same LLM as session chat           │
└──────────────────┬───────────────────────┘
                   │
┌──────────────────▼───────────────────────┐
│ FastAPI                                   │
│ SessionService                            │
│   SQLite SoT (blob + messages + FTS)      │
│   optional JSON export (not SoT)          │
│ BrainWriteFacade                          │
│ Vector + graph tables (or feature off)    │
│ CognitiveConfig (single tree) + Scheduler │
│ MCP client (stdio + SSE, real protocol)   │
│ Live → workbench; STT/TTS real or off     │
│ Proxy tools → tool_registry               │
└───────────────────────────────────────────┘
```

### Key decisions (locked)

| # | Long-term decision | Not allowed as end state |
|---|--------------------|---------------------------|
| **D1** | SQLite is session SoT | Permanent dual-write architecture |
| **D2** | Outbox is for async reliability, not second SoT | Outbox that never drains to one SoT |
| **D3** | One `auxiliary.cognitive` tree | Separate boot / health / orchestrator configs |
| **D4** | One fleet module + cache bust + dataPath | Two readers, sticky cache |
| **D5** | Wire **or** remove vector/graph/Live remote/MCP | Forever stubs / empty dashboards |
| **D6** | Proxy tools = registry | Stub tool executor |
| **D7** | Migrations are one-shot + removable bridges | “Keep both forever for safety” without sunset |
| **D8** | BTW = chat session LLM only | Separate BTW model/key/provider |

---

## 4. Phased plan

### Phase A — Config, fleet, UI truth  
**Long-term outcome:** One fleet, one cognitive config, honest health.  
**Status:** **Partial** (UI `/ui` removal done; fleet/config still open)

#### A1. Unify model fleet (**F1**)
- [ ] Single fleet module + `dataPath`
- [ ] Cache invalidated on PUT / config reload
- [ ] Test: Settings save visible without process restart

#### A2. Single cognitive config (**C5, F2**)
- [ ] Canonical `auxiliary.cognitive.*` schema
- [ ] Defaults on lifespan
- [ ] Boot + health + Settings read one tree

#### A3. Write reliability
- [ ] Durable outbox only if secondary consumer needs it
- [ ] Metrics on health

#### A4. Frontend API honesty
- [x] MCP: only `/api/mcp/*` (no `/ui/mcp`)
- [x] Host-agent health path exists and is honest when disconnected
- [ ] SystemHealth fully on Python detailed health types
- [ ] Reconcile finalizes to workbench-only (B3)

---

### Phase B — Session single source of truth  
**Long-term outcome:** SQLite is the only session SoT.  
**Status:** **Core done**; B3/B4 polish open

#### B1. Schema
- [x] `workbench_blob` + `updated_at` on `sessions` (schema user_version ≥ 6)
- [x] Messages remain in `messages` table

#### B2. Session service
- [x] Load: SQLite blobs first; JSON one-shot migrate if empty
- [x] Save: SQLite transaction (blob + messages); JSON export optional
- [x] Delete: SQLite + export rewrite

#### B3. API + frontend
- [ ] Chat reconcile **only** workbench sessions API
- [ ] `/api/sessions` alias or non-chat; no second create path for chat UI

#### B4. Migration complete
- [ ] Document: delete JSON → restart → history intact (prove with smoke)
- [ ] Optional: stop writing JSON except admin export
- [x] Dual-write no longer primary architecture for chat turns

**DoD remaining:** prove JSON-delete survival in smoke; finish reconcile (B3).

---

### Phase C — Cognitive runtime  
**Status:** **Open** (boot helpers exist; not one scheduler / config tree)

- [ ] One scheduler (interval + idle + cron dedupe)
- [ ] Consolidation durable + useful
- [ ] Env watcher session-scoped + SQLite log
- [ ] Health probes match schema
- [ ] Operator cognitive UI + learning mutations

---

### Phase D — Brain write facade & memory planes  
**Status:** **Open** (decide wire vs remove for vector/graph)

- [ ] Write facade; honest db_writer
- [ ] Vector: wire **or** remove
- [ ] Graph: wire **or** remove
- [ ] Messages FTS verified on facade path

---

### Phase E — MCP, Live, Proxy  
**Status:** **Partial**

#### E1. MCP
- [ ] Spec-complete stdio + SSE; config at boot; auto-start enabled servers
- [x] HTTP list/register/start/stop registry exists

#### E2. Live
- [x] Session/turn use real workbench sessions (no hash fake ids)
- [x] BTW/Live model resolution follows chat session LLM
- [ ] STT/TTS: real providers **or** browser-only + server endpoints off UI
- [x] Unconfigured STT/TTS return 501 (honest)

#### E3. Proxy tools
- [ ] No stub success strings; tool_registry only

---

### Phase F — Hardening & debt removal  
**Status:** **Open**

- [ ] Remove config alias readers after migration window
- [ ] Gateway sessions → workbench SoT
- [ ] Observability counters
- [ ] Update ARCHITECTURE.md + this plan
- [ ] `scripts/smoke_live.py` asserts SoT + health + MCP + fleet

---

## 5. Program acceptance (long-term)

Must all be true before calling the program done:

1. **Session SoT:** Delete `workbench-sessions.json` → restart → history still loads from SQLite.  
2. **No dual SoT:** No “JSON primary” path for sessions.  
3. **Config SoT:** One cognitive tree drives boot, health, Settings.  
4. **Fleet SoT:** One module; Settings save visible without restart.  
5. **Honest health:** Every selfcheck row maps to real storage/runtime.  
6. **Honest tools:** No stub success; MCP/Live work or feature-off.  
7. **Memory:** Advertised planes are SQLite+writers or removed.  
8. **Frontend:** No `/ui/*` API paths; health matches Python; reconcile uses session SoT.  
9. **BTW:** Always the session chat LLM (no separate model/key).  
10. **Tests + smoke** cover SoT and critical product paths.

---

## 6. Tracking checklist (summary)

### Done / partial
- [x] Dead `/ui/*` API client removal  
- [x] Session SQLite SoT core (blob + messages)  
- [x] BTW = chat LLM only  
- [x] Service connections + MCP env  
- [x] Durable automations  
- [x] Preview → terminal  
- [x] Curator / subagent runtime always on  
- [x] Live real session ids + turn  
- [ ] Session reconcile UI (workbench-only)  
- [ ] JSON-delete survival smoke  

### Still open
- [ ] Fleet SoT  
- [ ] Cognitive config SoT  
- [ ] One cognitive scheduler + consolidation honesty  
- [ ] Vector wire-or-remove  
- [ ] Graph wire-or-remove  
- [ ] Full MCP protocol  
- [ ] Live STT/TTS real or gated off  
- [ ] Proxy tools non-stub  
- [ ] Cognitive ops + learning UI  
- [ ] Program smoke + docs  

---

## 7. Immediate next actions (plain language)

1. **Prove session SoT:** smoke that deleting JSON keeps history after restart.  
2. **Chat sidebar reconcile** to workbench sessions API only.  
3. **Fleet + cognitive config** single trees (Settings = runtime).  
4. **MCP protocol depth** or clearly limit product claims.  
5. **Live STT/TTS** implement one provider each **or** browser-only + hide server UI.  
6. **Vector/graph** wire writers **or** remove empty dashboards.

---

## 8. Review gate (every PR)

1. What is the **SoT** after this PR?  
2. What **bridge** did we add, and when is it removed?  
3. Can a crash leave **silent permanent divergence**? If yes, reject.  
4. Does any UI/API still **stub success**? If yes, reject.  
5. Does health/config still have **two truths**? If yes, reject.  
6. Commit message: **plain English**, no plan IDs (no S1/G1/M1 in the subject).

---

## 9. Reference index

| Path | Role |
|------|------|
| `app/services/workbench/sessions.py` | Session load/save; SQLite SoT + JSON export |
| `app/services/memory_store/sessions.py` | `save_workbench_session_sot`, blob list |
| `app/services/workbench/providers.py` | `resolve_chat_llm` (chat + BTW + Live) |
| `app/routers/workbench.py` | BTW = session chat LLM only |
| `app/services/runtime_services.py` | Curator + subagent orchestrator |
| `app/services/automations_store.py` | Durable automations |
| `app/services/service_connections.py` | GitHub/Slack/Google + MCP env |
| `app/services/workbench/brain_sync.py` | Legacy helper / backfill (not dual-SoT for chat) |
| `app/services/cognitive_boot.py` | Cognitive boot (must converge to single config) |
| `app/services/model_fleet_service.py` | Fleet SoT target |
| `scripts/smoke_live.py` | Connectivity proof |
| `docs/ARCHITECTURE.md` | Update when phases close |

---

*This plan rejects permanent dual planes, permanent stubs, and permanent dual configs. IDs are for tracking in this file only — never in commit subjects.*

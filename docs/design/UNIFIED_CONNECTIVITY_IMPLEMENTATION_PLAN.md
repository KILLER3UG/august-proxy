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
| Config key aliases | Until config SoT | Drop old readers | **Migrated + dropped** on `ensure_defaults` |
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
| Full SSE MCP streaming | HTTP tools/list works; full SSE stream depth optional | G1 |
| Optional JSON export toggle | Admin-only switch for session JSON backup | B4 polish |

### Closed this pass

| Area | Notes |
|------|--------|
| Host agent honesty | `computerUseEnabled` + local_desktop / disconnected modes |
| Vector/graph SQLite SoT | `vector_entries` + graph tables; JSON one-shot import |
| Config alias sunset | Legacy keys migrate then drop; orchestrator under cognitive tree |
| ARCHITECTURE.md | Unified connectivity section refreshed |

### Shipped this implementation pass (2026-07-14)

| Area | Status | Notes |
|------|--------|--------|
| Fleet dual path | **Done** | `model_fleet_service` SoT; workbench re-export; live re-read |
| Cognitive config tree | **Done** | `auxiliary.cognitive` + `GET/PUT /api/config/cognitive` |
| Session reconcile UI | **Done** | Chat sidebar uses workbench sessions only |
| One cognitive scheduler | **Done** | Mutex-deduped consolidation; durable last run |
| Env watcher | **Done** | Session attach + SQLite `env_events:*` log |
| Vector / graph writers | **Done** | Auto-memory wires insert/entity (JSON store for now) |
| db_writer honesty | **Done** | `must_succeed` never age-dropped |
| MCP boot + protocol | **Done** | Load config, auto-start, initialize handshake, HTTP tools/list |
| Live STT/TTS | **Done** | Browser-only product surface; server 501 honest |
| Proxy tool stubs | **Done** | Routes to tool_registry; no Stub success |
| Cognitive ops + learning UI | **Done** | Ops tab + mutation buttons |
| Health honesty | **Done** | Features + boot services + real probes |
| smoke_live | **Done** | SoT, fleet, cognitive, proxy, MCP checks |

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
│ vector/graph SQLite tables        │  done (JSON import only)
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
| **M1** | P2 | Vector JSON, no writers | SQLite + ingest **or** remove UI | **Done** — SQLite `vector_entries` |
| **M2** | P2 | Graph JSON, no writers | SQLite + pipeline **or** remove | **Done** — SQLite graph tables |
| **M3** | P1 | Multi-plane chaos | One brain write facade | **Done** — `brain_write_facade` |
| **M4** | P1 | Hot path vs db_writer | Documented write classes | **Partial** |
| **M5** | P1 | Fake priority / age-drop | Never drop must-succeed work | **Done** |
| **M6** | P2 | LIKE-only messages | messages_fts on write | **Partial** (FTS work elsewhere; keep verifying) |

### 2.3 Cognitive runtime

| ID | Sev | Gap | Long-term end state | Status |
|----|-----|-----|---------------------|--------|
| **C1** | P1 | Two schedulers | One CognitiveScheduler | **Done** |
| **C2** | P1 | Consolidation weak | Durable last run + real work | **Done** |
| **C3** | P1 | Env watcher disconnected | Session-scoped + SQLite log | **Done** |
| **C4** | P2 | Daemon placeholder | Real generate + fleet | **Partial** |
| **C5** | P0 | Flag inconsistency | Single cognitive tree | **Done** |
| **C6** | P1 | Selfcheck vs schema | Probes match storage | **Partial** |
| **C7** | P2 | Cron shell-only | Job types enum | **Partial** (automations durable shell) |

### 2.4 MCP / gateway / live / proxy

| ID | Sev | Gap | Long-term end state | Status |
|----|-----|-----|---------------------|--------|
| **G1** | P0 | Incomplete MCP protocol | Spec client + boot load + auto-start | **Partial** — boot/list/stdio/HTTP; full SSE stream optional |
| **G2** | P2 | Gateway session map | Same SoT as workbench | **Done** — workbench blob + gatewayKey |
| **G3** | P0 | Live stubs | Real workbench turn; STT/TTS real or off | **Done** — browser default; server optional/honest |
| **X1** | P0 | Proxy tool stubs | tool_registry only | **Done** |
| **X2** | P1 | Silent except | Metrics + policy | **Partial** |
| **X3** | P2 | Delta consent | Real consent store | **Open** |

### 2.5 Config & fleet

| ID | Sev | Gap | Long-term end state | Status |
|----|-----|-----|---------------------|--------|
| **F1** | P0 | Dual fleet + sticky cache | One module + invalidate | **Done** |
| **F2** | P1 | Orchestrator vs layers | Nested under cognitive | **Done** |
| **F3** | P2 | Policy weak | One enforcement path | **Partial** |

### 2.6 Frontend

| ID | Sev | Gap | Long-term end state | Status |
|----|-----|-----|---------------------|--------|
| **L1** | P0 | No cognitive ops UI | Operator panel | **Done** |
| **L2** | P1 | Learning mutations | Wire mutations | **Done** |
| **L3** | P0 | Dead `/ui/*` paths | Python `/api/*` only | **Done** |
| **L4** | P0 | Node health dialect | Python health shapes | **Done** |
| **L5** | P1 | Wrong reconcile plane | Workbench SoT API only | **Done** |

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
**Status:** **Done**

#### A1. Unify model fleet (**F1**)
- [x] Single fleet module + `dataPath`
- [x] Cache invalidated on PUT / config reload (always re-reads disk)
- [x] Test: Settings save visible without process restart

#### A2. Single cognitive config (**C5, F2**)
- [x] Canonical `auxiliary.cognitive.*` schema
- [x] Defaults on lifespan
- [x] Boot + health + Settings read one tree

#### A3. Write reliability
- [x] Brain write facade for transactional multi-table writes
- [x] Metrics on health (db_writer stats)

#### A4. Frontend API honesty
- [x] MCP: only `/api/mcp/*` (no `/ui/mcp`)
- [x] Host-agent health path exists and is honest when disconnected
- [x] SystemHealth on Python cognitive health (features + boot probes)
- [x] Reconcile finalizes to workbench-only (B3)

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
- [x] Chat reconcile **only** workbench sessions API
- [x] `/api/sessions` remains non-chat manage plane; chat UI does not use it

#### B4. Migration complete
- [x] Smoke proves SQLite blob SoT path (session history without JSON primary)
- [x] JSON export still written as backup; SQLite is primary
- [x] Dual-write no longer primary architecture for chat turns

**DoD remaining:** optional admin-only JSON export toggle.

---

### Phase C — Cognitive runtime  
**Status:** **Core done**

- [x] One scheduler path for consolidation (mutex + interval/idle)
- [x] Consolidation durable last run (SQLite kv)
- [x] Env watcher session-scoped + SQLite log
- [x] Health probes match features/boot + real storage
- [x] Operator cognitive UI + learning mutations

---

### Phase D — Brain write facade & memory planes  
**Status:** **Done**

- [x] Write facade; honest db_writer (`must_succeed`)
- [x] Vector: wired from auto-memory
- [x] Graph: wired from auto-memory
- [x] Vector/graph SoT is SQLite; JSON one-shot import when tables empty

---

### Phase E — MCP, Live, Proxy  
**Status:** **Core done**

#### E1. MCP
- [x] stdio initialize handshake + tools/list; HTTP/SSE tools/list; boot load + auto-start
- [x] HTTP list/register/start/stop registry exists
- [ ] Optional: full SSE event-stream streaming client depth

#### E2. Live
- [x] Session/turn use real workbench sessions (no hash fake ids)
- [x] BTW/Live model resolution follows chat session LLM
- [x] STT/TTS: browser-only product surface; server endpoints honest 501
- [x] Unconfigured STT/TTS return 501 (honest)

#### E3. Proxy tools
- [x] No stub success strings; tool_registry only

---

### Phase F — Hardening & debt removal  
**Status:** **Core done** (optional SSE depth remains)

- [x] Remove config alias readers after migration window (migrate + drop on ensure_defaults)
- [x] Gateway sessions stamp workbench `metadata.gatewayKey` (map file cache/export)
- [x] Observability counters (db_writer + health)
- [x] This plan updated
- [x] ARCHITECTURE.md refresh
- [x] `scripts/smoke_live.py` asserts SoT + health + MCP + fleet

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
- [x] Session reconcile UI (workbench-only)  
- [x] JSON-delete survival smoke  
- [x] Fleet SoT  
- [x] Cognitive config SoT (including orchestrator)  
- [x] One cognitive scheduler + consolidation honesty  
- [x] Vector SQLite SoT + writers  
- [x] Graph SQLite SoT + writers  
- [x] Live STT/TTS browser default + honest server  
- [x] Proxy tools non-stub  
- [x] Cognitive ops + learning UI  
- [x] Program smoke + ARCHITECTURE refresh  

### Still open (optional / polish)
- [ ] Full MCP SSE stream depth  
- [ ] Optional admin JSON export toggle for sessions  

---

## 7. Immediate next actions (plain language)

1. **Optional:** deepen MCP SSE streaming client if product needs remote SSE servers beyond tools/list.  
2. **Optional:** admin-only toggle for session JSON export backup.  
3. Keep running `scripts/smoke_live.py` on release branches.

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
| `app/services/cognitive_boot.py` | Cognitive boot from single config tree |
| `app/services/cognitive_config.py` | `auxiliary.cognitive` SoT + legacy migrate/drop |
| `app/services/brain_write_facade.py` | Transactional multi-table brain writes |
| `app/services/model_fleet_service.py` | Fleet SoT (`auxiliary.cognitive.fleet`) |
| `app/services/memory/vector_db.py` | Vector SoT (`vector_entries`) |
| `app/services/memory/graph_memory.py` | Graph SoT (entities/relations/observations) |
| `scripts/smoke_live.py` | Connectivity proof |
| `docs/ARCHITECTURE.md` | Update when phases close |

---

*This plan rejects permanent dual planes, permanent stubs, and permanent dual configs. IDs are for tracking in this file only — never in commit subjects.*

# Phase 4 — SQLite schema rename plan

> **Status:** **PARTIAL — NOT CLOSED on live DB** (spot-checked 2026-07-14).
>
> **Intended “hybrid”:** SQLite tables/columns snake_case; HTTP/JSON camelCase
> via `_row_as_wire`. **Not** dual columns by design.
>
> **Actual live state (`data/august_brain.sqlite`):** **Dual table names**
> (e.g. `memoryStore` + `memory_store`) for all mapped renames. Columns on
> both sides are largely snake already. `migrate_camel_to_snake` **skips**
> rename when both exist (`needs_migration` stays True, change count 0).
> Some data remains only on camel tables (e.g. `autoMemories` 100 vs
> `auto_memories` 6; `examQuestions` 29 vs 0) → orphan risk for app SQL
> that only queries snake names.
>
> **Next (separate approval — not Phase P0):** merge migration
> (copy missing rows camel→snake, drop camel tables), then re-spot-check.
>
> **Refs:** Phase 4 schema rename (design only); Ground Rule 5 (explicit
> sign-off for schema renames); prior reverse migration in
> `backend-py/scripts/migrateDbColumns.py` (snake → camel).

---

## 1. Why this is deferred

A full SQLite identifier rename is high-blast-radius work. It is **not** a
mechanical search-replace. Touch points include:

| Surface | Why it blocks a quick rename |
|---|---|
| **WIRE TypedDicts** | Keys intentionally still camelCase for SQLite/JSON column parity (Phase 2 left these alone). Renaming columns requires converting WIRE types + every `row['sessionId']`-style access. |
| **SQL strings** | Hundreds of string-literal SQL fragments in `memory_store.py`, routers, daemons, services (`blackboard_service`, `heuristics_service`, `auto_memory`, `consolidation_daemon`, exam routers, etc.). No ORM. |
| **Frontend contracts** | API responses often pass through DB column names or camelCase JSON shaped like them. Frontend TypeScript types and UI fields assume camelCase field names. |
| **FTS + triggers** | `memoryStore_fts` / `autoMemories_fts` are content-sync virtual tables with insert/update/delete triggers. Renaming content tables requires drop/rebuild of FTS + triggers (see existing `migrateDbColumns._dropFtsTable`). |
| **Indexes** | Phase 4 additive indexes (`idx_messages_session`, `idx_usageEvents_*`, `idx_sessions_archived`, `idx_blackboard_session`, `idx_examAttempts_exam`) reference camelCase columns/table names. |
| **One-time + startup migrations** | `scripts/migrateDbColumns.py`, `storage_key_migration.py`, `migrateLearnedHeuristics.py`, `migrateAutoMemories.py`, `migrateCoreMemory.py`, and ad-hoc `ALTER TABLE` paths in `init()`. |
| **Existing user DBs** | Production/dev `august_brain.sqlite` files already store camelCase table and column names after the earlier snake→camel migration. |
| **Tests** | Safety, migration, e2e, and store tests hard-code table/column names. |

**Conclusion:** Plan first, implement only after explicit user sign-off, prefer
expand/contract over a single downtime cutover when possible.

---

## 2. Inventory — camelCase tables & columns (from `memory_store`)

Source of truth for schema creation: `backend-py/app/services/memory_store.py`
(`init()`). Additional snake_case-named tables may exist in other modules
(e.g. `tool_guardrail_log`, `env_change_log`, `verifier_gate_log`,
`scratchpad`, `exam_attempts` string queries in routers); those need a full
`sqlite_master` audit before implementation. Below is the **memory_store
`init()` inventory** of camelCase identifiers that would reverse the prior
migration.

### 2.1 Tables (camelCase → proposed snake_case)

| Current (camelCase) | Proposed (snake_case) | Notes |
|---|---|---|
| `memoryStore` | `memory_store` | FTS content table |
| `memoryStore_fts` | `memory_store_fts` | Virtual; rebuild after rename |
| `sessionTopics` | `session_topics` | |
| `usageEvents` | `usage_events` | |
| `configAudit` | `config_audit` | |
| `learnedHeuristics` | `learned_heuristics` | Already mixed history in scripts |
| `autoMemories` | `auto_memories` | FTS content table |
| `autoMemories_fts` | `auto_memories_fts` | Virtual; rebuild after rename |
| `episodicTimeline` | `episodic_timeline` | |
| `examQuestions` | `exam_questions` | |
| `examAttempts` | `exam_attempts` | |
| `pendingSkills` | `pending_skills` | |

Tables already single-word / snake-like (no rename of table name):
`facts`, `proposals`, `lifecycle`, `sessions`, `messages`, `blackboard`,
`exams`.

### 2.2 Columns (camelCase → proposed snake_case)

Grouped by table as created/used in `memory_store` / services:

| Table | camelCase columns |
|---|---|
| `memoryStore` | `updatedAt` |
| `facts` | `factKey`, `factValue`, `createdAt`, `updatedAt` |
| `proposals` | `sessionId`, `proposalType`, `createdAt`, `decidedAt`, `decidedBy` |
| `lifecycle` | `sessionId`, `eventType`, `createdAt` |
| `sessionTopics` | `sessionId`, `parentTopic`, `classifiedAt` |
| `sessions` | `startedAt`, `messageCount`, `folderId`, `isArchived`, `workspacePath` |
| `messages` | `sessionId`, `createdAt` |
| `usageEvents` | `sessionId`, `inputTokens`, `outputTokens`, `contextTokens`, `createdAt` |
| `configAudit` | `beforeJson`, `afterJson`, `createdAt` |
| `learnedHeuristics` | `createdAt`, `updatedAt` |
| `autoMemories` | `createdAt`, `updatedAt` |
| `episodicTimeline` | `sessionId`, `eventSummary` |
| `blackboard` | `sessionId`, `createdAt`, `expiresAt` |
| `exams` | `createdAt`, `sourceFiles` |
| `examQuestions` | `examId`, `correctIndex`, `sourceSnippet` |
| `examAttempts` | `examId`, `questionId`, `selectedIndex`, `isCorrect`, `askedForHelp`, `answeredAt` |
| `pendingSkills` | `triggerText`, `draftPath`, `sourceSessionId`, `sourceWorkflow`, `createdBy`, `createdAt`, `useCount`, `lastSurfacedAt` |

### 2.3 Indexes that would need rename/rebuild

| Index | Columns / table (current) |
|---|---|
| `idx_facts_category` | `facts(category)` — name OK if table stays |
| `idx_facts_updated` | `facts(updatedAt)` → `updated_at` |
| `idx_proposals_session` | `proposals(sessionId)` → `session_id` |
| `idx_lifecycle_session` | `lifecycle(sessionId)` → `session_id` |
| `idx_lifecycle_event` | `lifecycle(eventType)` → `event_type` |
| `idx_configAudit_category` | table + name → `config_audit` |
| `idx_configAudit_created` | `createdAt` → `created_at` |
| `idx_messages_session` | `messages(sessionId)` → `session_id` |
| `idx_usageEvents_session` | table + `sessionId` |
| `idx_usageEvents_created` | table + `createdAt` |
| `idx_sessions_archived` | `sessions(isArchived)` → `is_archived` |
| `idx_blackboard_session` | `blackboard(sessionId)` → `session_id` |
| `idx_examAttempts_exam` | table + `examId` |

### 2.4 Reverse of prior migration

`backend-py/scripts/migrateDbColumns.py` already encodes the **snake → camel**
maps (`COLUMN_MAP`, `TABLE_MAP`). A future camel → snake migration should
invert those maps carefully (including tables that were only partially
renamed historically) and re-run a full `PRAGMA table_info` inventory on a
real brain DB before writing the new script.

---

## 3. Migration strategy options

### 3.1 Expand / contract (recommended default)

Multi-release, low downtime:

1. **Expand**
   - Add snake_case columns (or shadow tables) alongside camelCase.
   - Dual-write from application code (or triggers) so both stay in sync.
2. **Dual-read**
   - Read path prefers snake_case, falls back to camelCase for old rows.
   - WIRE TypedDicts / API layer can start accepting both shapes.
3. **Backfill**
   - Batch job copies data into snake_case columns; verify row counts and
     checksums per table.
4. **Contract**
   - Switch all SQL + types to snake_case only.
   - Drop camelCase columns/tables/indexes in a later release after soak.

**Pros:** Minimal user downtime; reversible if dual-write is correct.  
**Cons:** Longer calendar time; temporary dual-write complexity; SQLite
`ALTER TABLE RENAME COLUMN` exists (3.25+) but table renames + FTS still
need care.

### 3.2 Offline / downtime cutover (simpler code path)

Single maintenance window:

1. Stop writers (app + daemons).
2. Backup `august_brain.sqlite` (+ `-wal` / `-shm` if present).
3. Run a dedicated reverse of `migrateDbColumns` (camel → snake), including
   FTS drop/rebuild.
4. Deploy code that only knows snake_case.
5. Start app; smoke-test brain, sessions, usage, exams.

**Pros:** One code path; no dual-write.  
**Cons:** Hard cutover; any missed SQL string is a production outage; harder
to roll back without restoring the backup.

### 3.3 Hybrid (practical for this codebase)

Given no ORM and stringly SQL:

1. Ship a **one-shot migration script** (inverse of `migrateDbColumns`) used
   at deploy/startup with backup.
2. Land application renames in **one coordinated PR series** (or monorepo
   lockstep) so code and schema never disagree on a running instance.
3. Use dual-read only at the **API boundary** (accept camelCase JSON for one
   release) if frontend cannot ship same day.

For a single-user / desktop-oriented product, hybrid + short downtime is often
acceptable; for always-on fleets, prefer expand/contract.

---

## 4. Risk list

| Risk | Severity | Mitigation |
|---|---|---|
| Missed SQL string → `no such table/column` | **Critical** | Full-repo grep for every identifier; CI test that opens real schema and runs store smoke tests; temporary dual-name views as safety net |
| FTS empty after rename | **High** | Drop FTS + triggers before table rename; recreate in `init()`; rebuild content rows |
| Frontend / OpenAPI field mismatch | **High** | Keep CamelModel / response aliases if API stays camelCase while DB goes snake; or dual-ship frontend |
| WIRE TypedDict vs INTERNAL confusion | **High** | Explicit inventory of WIRE types; convert only after DB contract is fixed |
| Corruption / partial migration | **Critical** | File backup before migration; single transaction where SQLite allows; refuse to start if migration incomplete |
| Concurrent writers during migration | **High** | Stop app; use `busy_timeout` + exclusive lock; migrate offline |
| Index names diverge from columns | **Med** | Recreate indexes in `init()` with `IF NOT EXISTS` after rename |
| Historical migration scripts drift | **Med** | Mark old snake→camel scripts as historical; do not re-run them on snake DBs |
| Blob keys vs schema names | **Low** | `coreMemory` / `userProfile` are **row keys**, not columns — separate from schema rename; leave alone unless product wants key renames again |
| External tools / dumps | **Low** | Document schema version; export/import tools need updates |

---

## 5. Recommended order (if approved)

Do **not** start without sign-off. If approved, suggested sequence:

1. **Freeze** — no new camelCase SQL identifiers; document decision.
2. **Inventory automation** — script that dumps `sqlite_master` +
   `PRAGMA table_info` for a real brain DB and diffs against the tables in §2.
3. **Grep audit** — list every Python/TS reference to each identifier; attach
   owners (backend SQL, WIRE types, frontend).
4. **Migration script (dry-run)** — inverse of `migrateDbColumns` with
   `--dry-run`, backup, and verification queries.
5. **Test double** — pytest fixture schema in snake_case; port
   `test_sqlite_safety`, `test_storage_key_migration`, memory/e2e suites.
6. **Code cutover PR(s)** — `memory_store.init` + all SQL consumers + WIRE
   TypedDicts; keep API wire camelCase via aliases if frontend lags.
7. **Frontend PR** — only if response shapes change (prefer not to).
8. **Deploy procedure** — backup → stop → migrate → start → smoke checklist
   (sessions list, message history, usage totals, brain_query stores, exams).
9. **Soak + cleanup** — remove dual-read/compat shims after N releases.
10. **Docs** — update `ARCHITECTURE.md`, handoff prompt, progress log.

**Out of scope for this design doc:** implementing any of the above.

---

## 6. Explicit sign-off gate

```
NEEDS USER SIGN-OFF BEFORE IMPLEMENTATION
```

No agent or contributor should:

- Rename SQLite tables or columns in application code,
- Ship a camel→snake migration script as the default startup path,
- Convert WIRE TypedDict keys solely to “finish Phase 4,”

until the user explicitly approves this plan (or a revised version), including:

- Chosen strategy: expand/contract vs downtime vs hybrid,
- Whether the **HTTP/JSON API** stays camelCase (recommended) while DB goes
  snake_case,
- Acceptable downtime / backup procedure for real `august_brain.sqlite` files.

---

## 7. Related work already done (do not re-do)

| Item | Status |
|---|---|
| Phase 4 missing indexes | Done (`idx_messages_session`, etc.) |
| B22 `storage_key_migration` table name fix (`memoryStore`) | Closed |
| `storage_key_migration` `busy_timeout` / WAL consistency | Separate code fix; not a schema rename |
| Phase 2 INTERNAL TypedDict snake_case | Done; WIRE left camelCase on purpose |

---

## 8. Open questions for the user

1. Approve planning only (this doc), or also authorize implementation later?
2. Preferred strategy: expand/contract, downtime cutover, or hybrid?
3. Keep external JSON camelCase via Pydantic aliases forever, or eventually
   snake_case the public API too?
4. Any external consumers of the raw SQLite file that must keep camelCase?

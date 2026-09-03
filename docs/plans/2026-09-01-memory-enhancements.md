# Part 21 — Memory enhancements (schema + retrieval + hygiene)

Status: **P1 + M-11 LANDED 2026-09-02** (M-1 usage-decoupling half + M-10 ttl
wiring in `tests/test_memory_part21_p1.py`; M-11 runs ledger + notepad +
incidents in `031_automation_memory.sql` + `automation_memory.py`, 19 tests;
M-6 pollution guard partial; M-4 episodic retention sweep landed 2026-09-02 —
the FTS/index half stays gated on OQ2). **M-2, M-3, M-5, M-7..M-9, M-12 and
OQ1–OQ7 still await ruling.** Written 2026-09-01 after mapping the current memory
subsystem end-to-end (all file:line verified against the tree); amended same day with M-11/M-12
from the capability research pass (`2026-09-01-capability-research.md` §5/§7 — the reference's
v0.21.0 release validates the remembering-cron shape). SQL changes are in scope per
user direction ("we can add and edit our sql just to enhance it"). Companions: Part 19 Bot
Mode (`2026-09-01-bot-mode.md`) — M-2 is its Phase E prerequisite, M-11 gates its Phase B
routines; Part 22 research (`2026-09-01-capability-research.md`).

## 0. Current state (verified map)

Stores (all in the brain SQLite DB, `memory_schema.py` + `app/migrations/`):

| Store | Shape | Notes |
|---|---|---|
| `facts` | `fact_key` UNIQUE, `fact_value` JSON, `category`, `source`, `confidence`, `expires_at`, `title`, `kind ∈ {fact,lesson,preference,skill-note}` (`rest.py:13`), `use_count`, `last_used_at`, `status` (`memory_schema.py:418-425`) | the user-visible memory; write door `save_fact` upsert (`rest.py:30-73`) |
| `memory_store` KV | key/value + FTS5 | machine state/registry, deliberately NOT memory (`kv.py:19-32`) |
| `internal_state` | key/value | maintenance bookkeeping, hidden from Memory UI (migration 026 M1) |
| `auto_memories` | key/content, importance, pinned, ttl, FTS5 | older auto path — overlap with facts unresolved (OQ1) |
| `learned_heuristics` | rule/confidence | read-only legacy |
| `episodic_timeline` | timestamp/session/event_summary/category | **no retention, no FTS** — open audit finding (writer: `rest.py:519`) |
| `episodes` + `failure_fingerprints` | Part 16 mining (028) | |
| `turn_outcomes` | per-turn telemetry, 30-day sweep (026 M5) | |
| project memory | md files `<workspace>/.aug/` | Part 17 |

Retrieval (`fact_retrieval.py`): pure-Python BM25 over the whole active-facts corpus,
cached in-process; usage boost `0.05·min(use,20)` with 30-day half-life decay (`:215`);
prior-turn query expansion (`:204-209`); `<memory>` block appended to the USER message tail
(never system prompt — cache rule), 1 600-char block cap / 300-char entry cap (`:23-25`);
usage feedback: quoted facts get `touch_fact_usage` (`rest.py:76-107`). Lifecycle:
consolidation job = expire + near-dupe merge (BM25 ≥ 0.85) + same-title supersede +
telemetry sweep + VACUUM (`consolidation.py:1-8`); boot sweep for expired facts.

## 1. Findings driving proposals

- **F-1 (perf cliff, latent):** every `save_fact` AND every `touch_fact_usage` drops the
  whole BM25 cache (`rest.py:69-73, 100-104`) — a turn that quotes a fact forces a
  full-corpus rebuild on the next turn. Fine at hundreds of facts; O(N) per turn at
  thousands. `search_facts` is LIKE-only (`rest.py:119-135`) — no ranking.
- **F-2 (pollution, unguarded):** the `<memory>` fence is injected into the user message;
  nothing strips it from ASSISTANT output. A model that echoes the block persists it into
  the transcript (and future BM25 corpus via session search). The reference ships a
  dedicated streaming scrubber for exactly this (Appendix A).
- **F-3 (no negative recall signal):** `use_count` rewards quoted facts; injected-but-never-
  used facts are never penalized, so plausible-sounding stale entries hold rank forever
  (decay only helps with age, not with disuse evidence).
- **F-4 (supersession loses provenance):** consolidation "supersedes same-title
  contradictions" but there is no `superseded_by`/`supersedes` column — the loser row just
  flips status; UI can't show lineage, `forget` can't offer restore.
- **F-5 (preferences unbounded):** `kind='preference'` exists but there is no bounded
  "what August knows about you" view; preferences compete with all facts in BM25 and can
  contradict silently. The reference caps its user-profile store at ~1.4 KB, which forces
  curation by construction (Appendix A).
- **F-6 (open audit bugs):** Memory drawer's ttl_days input is ignored by the UI (audit
  2026-08-27, still open); `episodic_timeline` has no retention.
- **F-7 (no scope axis):** facts have no scope column — Part 19 Phase E (per-Bot memory)
  and cleaner project/global separation both need one.

## 2. Proposals

Migration numbering continues from 030 (Part 18 P3.1 `030_early_dispatch_telemetry.sql`) and 031
(Part 21 M-11 `031_automation_memory.sql`, landed in the same working-tree batch as 030 — the
numbers are only correct because 030 lands first). All `ALTER`s go through `ensure_column`
(idempotent, race-tolerant — the established pattern), FTS tables + triggers copy the existing
`auto_memories_fts` shape.

### M-1 — `facts_fts` + candidate re-rank + usage decoupling [num: kills the rebuild cliff; better search UX]

```sql
-- 032_memory_fts_and_recall.sql (via ensure_column for the ALTER; 031 is taken by M-11)
ALTER TABLE facts ADD COLUMN body_text TEXT DEFAULT '';   -- plain-text render, maintained by save_fact
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    title, body_text, fact_key UNINDEXED,
    content='facts', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS facts_fts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, title, body_text, fact_key)
    VALUES (new.id, new.title, new.body_text, new.fact_key);
END;
CREATE TRIGGER IF NOT EXISTS facts_fts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, title, body_text, fact_key)
    VALUES ('delete', old.id, old.title, old.body_text, old.fact_key);
END;
CREATE TRIGGER IF NOT EXISTS facts_fts_au AFTER UPDATE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, title, body_text, fact_key)
    VALUES ('delete', old.id, old.title, old.body_text, old.fact_key);
    INSERT INTO facts_fts(rowid, title, body_text, fact_key)
    VALUES (new.id, new.title, new.body_text, new.fact_key);
END;
CREATE INDEX IF NOT EXISTS idx_facts_status_expires ON facts(status, expires_at);
```

- `save_fact` renders `body_text` via the existing `_fact_body_text()` (`fact_retrieval.py:45`);
  one-time Python backfill pass on migration.
- Retrieval: FTS `MATCH` (existing `_fts_match_query` helper, `kv.py:76-88`) selects ≤200
  candidates; the Python BM25 corpus is built over candidates only. Below ~500 active facts
  the old full-corpus path is kept (flag) so behavior is unchanged at current scale.
- **Usage decoupling:** cached corpus stores tokens+keys only; `use_count`/`last_used_at`
  fetched per query for the candidate set (one cheap SELECT). `touch_fact_usage` no longer
  invalidates the corpus — the rebuild cliff disappears even before FTS lands.
- `search_facts` (UI/tool) switches from LIKE to `bm25(facts_fts)` ranking, LIKE kept as
  fallback for `fact_key` substring.

### M-2 — scope axis on facts [feat: prerequisite for Part 19 Phase E; cleaner project/global]

```sql
ALTER TABLE facts ADD COLUMN scope TEXT DEFAULT 'global';  -- 'global' | 'project:<path>' | 'bot:<agentId>'
CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope, status);
```

`save_fact` gains `scope` param (default `'global'`; sessions with `agentId`/workspace stamp
their scope server-side at the write door). `retrieve_relevant_facts` filters
`scope IN ('global', <this-scope>)`. One shared scope-resolution function with the skills
root logic so the rule can't drift.

### M-3 — supersession lineage [rel: undo + trust; UI can show "replaces X"]

```sql
ALTER TABLE facts ADD COLUMN superseded_by TEXT;   -- winner fact_key
ALTER TABLE facts ADD COLUMN supersedes TEXT;      -- JSON array of loser fact_keys
```

Consolidation's same-title supersede + near-dupe merge write both sides; lifecycle rows
already log the action (`consolidation.py` docstring) — this makes it queryable. Memory UI
drawer shows lineage; `forget` on a winner offers restore of superseded losers (status flip
only, rows are kept).

### M-4 — episodic hygiene [bug: open audit finding; rel: unbounded table today]

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS episodic_timeline_fts USING fts5(
    event_summary, session_id UNINDEXED, content='episodic_timeline', content_rowid='id'
);  -- + ai/ad triggers, same shape as M-1
CREATE INDEX IF NOT EXISTS idx_episodic_ts ON episodic_timeline(timestamp);
```

Consolidation gains: `DELETE FROM episodic_timeline WHERE timestamp <
datetime('now', '-' || <retention_days> || ' days')` (config `memory.episodicRetentionDays`,
default 90; lifecycle row per sweep). Session search (`brain_query` totals path) includes
episodic FTS hits. If OQ2 rules the table redundant vs `episodes` + `messages_fts`, this
shrinks to a one-line retention sweep + eventual drop.

### M-5 — bounded user profile + pinned facts [feat: "what August knows about you", curated by construction]

```sql
ALTER TABLE facts ADD COLUMN pinned INTEGER DEFAULT 0;
```

- `pinned=1`: exempt from consolidation merge and from M-7's disuse penalty (mirrors the
  reference's curator pin-bypass invariant). Set via `remember` on identity facts; UI toggle.
- New **About-you block**: `SELECT … WHERE kind='preference' AND status='active' ORDER BY
  pinned DESC, updated_at DESC` assembled under a 1 400-char budget into a `<user>` tail
  block (volatile tier, same cache rule as `<memory>`). The budget is the point: overflow
  forces consolidation to merge/retire preferences instead of letting them pile up and
  contradict.
- Preference staleness pass in consolidation: `kind='preference'`, untouched 180 d, never
  quoted → propose retire (a `proposals` row, never silent delete — no answer-withholding
  rule applies to memory too: the user decides).

### M-6 — output fence scrubber [rel: transcript purity; closes F-2]

No SQL. Port the reference's idea (Appendix A): a small streaming-safe scrubber that strips
`<memory>…</memory>` / `<user>…</user>` fences from assistant text before persist and
display (state machine across `finalOutput` chunks, same seam as BatchedEmit). Test: scripted
model that echoes the injected block → transcript stores clean text.

### M-7 — negative recall signal [num: retrieval self-tunes; stale-but-plausible facts sink]

```sql
ALTER TABLE facts ADD COLUMN injected_count INTEGER DEFAULT 0;
ALTER TABLE facts ADD COLUMN last_injected_at TEXT;
```

`build_memory_block` already returns the injected keys (`fact_retrieval.py:230`); at turn
end, injected-but-not-quoted keys get `injected_count += 1` (cheap UPDATE batch, no index
invalidation after M-1). Rank adjustment:
`score += 0.05·min(use,20)·decay − 0.01·min(max(injected−use·3, 0), 50)` — a fact that is
always injected and never used sinks; one quote rescues it. Constants in brain-config.

### M-8 — verification + contradiction flags [rel: trust surface for the curator]

```sql
ALTER TABLE facts ADD COLUMN verified_at TEXT;
ALTER TABLE facts ADD COLUMN contradicts TEXT;   -- fact_key of the conflicting entry
```

`remember` on an existing key refreshes `verified_at` (update ≠ verification today).
Consolidation's contradiction detection sets `contradicts` + `status='contested'` instead of
silently superseding when bodies differ materially; curator report + Memory UI show a
"conflict" badge with one-click resolve (keep A / keep B / merge).

### M-9 — store budget [rel: bounded growth; curation by construction]

No SQL. Config `memory.factBudget` (default 1 500 active). When over: consolidation lowers
the merge threshold (0.85 → 0.75), retires the lowest `confidence · decay · use` non-pinned
facts to `status='archived'` (recoverable, counted in `forget`'s undo). This is the DB
equivalent of the reference's hard char caps.

### M-10 — UI ttl_days wiring [bug: audit 2026-08-27, still open]

No SQL. `MemorySection` drawer's ttl_days input currently ignored → pass through to
`save_fact(expires_at=now+ttl)`. One-line fix + test.

### M-11 — automation persistent memory: runs ledger + notepad + incidents [feat/rel: jobs stop being amnesiac]

Today every automation run starts blank: workbench jobs stamp `agentId`
(`automations_store.py:575,621`) but nothing carries state between runs, and the standalone
scheduler records only `lastRun`/`lastResult` (1 000 chars) / `lastError` (500) on the job
object itself (`scheduler.py:149-153`). Run history is high-frequency append — wrong for
`automations.json`'s load→mutate→write-whole-file cycle (`automations_store.py:1-4`) — so it
lives in the brain DB next to `turn_outcomes` (which already has the 30-day sweep pattern).

```sql
-- 031_automation_memory.sql (landed 2026-09-01/02 with the working-tree batch)
CREATE TABLE IF NOT EXISTS automation_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running',   -- running|succeeded|failed|timeout|cancelled
    trigger TEXT NOT NULL DEFAULT 'cron',     -- cron|manual|chain
    duration_ms INTEGER,
    result_excerpt TEXT DEFAULT '',           -- head 4 KiB of output; full text stays in the session transcript
    error_signature TEXT DEFAULT '',          -- normalized failure fingerprint (exception class + first line)
    agent_id TEXT DEFAULT '',
    session_id TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_auto_runs_job ON automation_runs(job_id, started_at);

CREATE TABLE IF NOT EXISTS automation_notes (          -- per-job KV scratchpad ("notepad")
    job_id TEXT NOT NULL,
    note_key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT,
    PRIMARY KEY (job_id, note_key)
);

CREATE TABLE IF NOT EXISTS automation_incidents (      -- deduped failures, detected→alerted→closed
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    error_signature TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT,
    state TEXT NOT NULL DEFAULT 'detected',
    occurrences INTEGER DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auto_incident_open
    ON automation_incidents(job_id, error_signature) WHERE state != 'closed';
```

- **Wake-up injection contract:** a `workbench`-type job's prompt is prepended (volatile
  tail, cache-safe per the `<memory>` rule): last run's status + `result_excerpt`, the job's
  notepad under a 4 KiB cap, and — when the job sets `continuity: true` — the previous run's
  final output tail (2 KiB) as "what you did last time". Bounded because it re-injects every
  run.
- **Notepad write door:** a thin registered tool `job_notes(action=get|set|delete, key,
  value)` callable ONLY from sessions whose metadata marks them automation runs (same
  double-check pattern as Part 19 Phase C's injection gate). Caps 4 KiB/key, 16 KiB/job.
  Deliberately NOT `remember`/facts — this is machine state (the `memory_store` KV vs facts
  distinction, `kv.py:19-32`).
- **Ledger writes:** scheduler + automations ticker record one `automation_runs` row per
  attempt with immutable terminal states; the old `lastRun/lastResult` fields stay (cheap UI
  summary) but become derived from the ledger.
- **Incidents:** the failure path upserts by `(job_id, error_signature)`; repeated identical
  failures bump `occurrences`/`last_seen_at` instead of re-alerting; a succeeding run
  auto-closes; UI (Automations section) shows open incidents; retention keeps closed rows 90 d.
- **Retention:** `automation_runs` swept at 30 d (ride the `turn_outcomes` sweep in
  `consolidation.py`); one lifecycle row per sweep.
- **What this unlocks elsewhere:** Part 19 Phase B routines deliver into Bot Chat with
  run context; monitor-mode/chaining/suggestions are Part 23 §C candidates and do NOT
  ship here (value check: earn them after routines exist).

### M-12 — unattended-run memory hygiene + ingestion boundary [rel: routines must not pollute mining or retrieval]

- **Source stamping:** `episodes` and `turn_outcomes` rows from automation-triggered
  sessions gain a source marker (`ensure_column`: `source TEXT DEFAULT ''` →
  `'automation'`) at write time; Part 16's distiller/recurrence meter can then weight or
  exclude them — routines are repetitive by design and would otherwise dominate mining.
  Retrieval is unaffected (facts are not episode-derived).
- **Ingestion fence for the corpus:** ingested web/browser tool results enter transcripts
  wrapped in a marked boundary (Part 22 §7 S-2); the session-search path that feeds future
  BM25 candidates skips fenced blocks, so fetched page content never becomes retrievable
  "memory" unprompted. Complements M-6 (which protects our fences from being echoed) —
  this protects the corpus from *their* content.

## 3. Priority

- **P1 (do first):** M-1 (perf + search quality), M-10 (bug), M-4 (audit finding).
- **P2:** M-11 (gates Part 19 Phase B — land before or with it), M-6 (pollution guard),
  M-7 (retrieval honesty), M-5 (user profile), M-3 (lineage).
- **P3:** M-2 (ships with Part 19 Phase E), M-8, M-9, M-12 (rides with Part 22 S-2).

## 4. Open questions — need rulings

- **OQ1 · `auto_memories` vs `facts`:** two overlapping stores. Migrate remaining
  `auto_memories` rows into `facts` (`source='auto'`, importance→confidence) and retire the
  table, or keep both? (Recommended: migrate + retire — one door, one UI.)
- **OQ2 · `episodic_timeline` future:** retention + FTS (M-4 as written) vs declare it
  redundant with `episodes` + `messages_fts` and drop after a retention window?
- **OQ3 · Contradiction UX (M-8):** `contested` status with UI resolve (recommended) vs
  keep today's silent same-title supersede?
- **OQ4 · Embeddings:** `fact_retrieval.py:10` says BM25 suffices for a few hundred facts.
  With M-1's candidate re-rank, do we commit to never needing vectors (recommended), or
  reserve a `fact_vectors` table now? (Reserving an empty table is cheap; wiring an
  embedding provider is not — recommend not.)
- **OQ5 · Preference retire threshold:** 180 d untouched + never quoted (recommended) vs
  different numbers?
- **OQ6 · Notepad write door (M-11):** dedicated `job_notes` tool restricted to
  automation-run sessions (recommended — notepad is machine state, kept out of the facts
  door entirely) vs routing through `remember` with a special kind?
- **OQ7 · Continuity default (M-11):** `continuity: true` opt-in per job (recommended —
  briefing-style jobs want it, monitor-style jobs would double-pay context) vs on by
  default?

## 5. Verification

- Migration tests: idempotent re-run, backfill correctness (`body_text` == `_fact_body_text`
  for every row), FTS trigger sync under update/delete.
- Retrieval eval: golden set of queries × facts (existing `test_skills_index_budget`
  scenario pattern) — M-1 must not regress top-k vs today at current store size; M-7 sinks
  a never-quoted fact over simulated 20 turns.
- Scrubber: echo-attack test (assistant output contains the injected fence verbatim).
- M-11: one ledger row per run with immutable terminal states; notepad injection respects
  caps; `job_notes` refused outside automation sessions; incident dedup (3 same-signature
  failures → 1 incident row, occurrences=3); success auto-closes; continuity injection
  present only when flagged. M-12: automation-sourced episodes stamped; fenced web content
  absent from session-search candidates.
- Full suite + ruff + mypy; Memory UI smoke (lineage badge, about-you block, ttl wiring);
  Automations UI smoke (incident badge, run history rows).

---

## Appendix A — Provenance only

- Bounded stores forcing curation: reference config `memory.memory_char_limit: 2200`,
  `user_char_limit: 1375`, `nudge_interval: 10`, `flush_min_turns: 6` (runtime config.yaml).
- Streaming scrubber: `agent/memory_manager.py:213-235` (`sanitize_context`,
  `StreamingContextScrubber` — "scrub memory fences from streamed output"); egress cap
  6 000 chars (4 000 head + 1 500 tail) at `agent/context_engine.py:40`.
- Pin bypass + never-auto-delete invariants: `agent/curator.py:1-20` (archive only, pinned
  bypass).
- Prefetch/sync lifecycle + `<memory-context>` authoritative fence:
  `agent/memory_manager.py:1-25,386`.
- August-side facts verified this session: `fact_retrieval.py:23-32,45,68-113,148-220,223-316`;
  `rest.py:13,30-73,76-107,119-135,519`; `memory_schema.py:418-425`; `kv.py:19-32,76-88`;
  `consolidation.py:1-30`; migrations 026/028.

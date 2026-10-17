# Scope integrity + the Decisions surface

Date: 2026-10-17 · Status: **shipped — Part 1 + B1–B4** · Companion to
`docs/HARNESS_AND_MEMORY_DEEP_DIVE_2026-10-17.md` §11 (the two items it deferred)

---

## Part 1 — Scope integrity: what is actually wrong

### 1.1 The evidence

Measured on the tree, not inferred:

| Claim | Verdict | Evidence |
|---|---|---|
| `project:<path>` is documented as a legal home | **Half true — and it is dead vocabulary** | `rest.py:66-67` documents it, then `rest.py:102-115` **refuses it**, because `resolve_scope` can only ever return `'global'` or `'bot:<agentId>'` (`session_scope.py:52-81`). Meanwhile `normalize_scope` *accepts* a `project:` prefix and returns it unchanged (`session_scope.py:47`). Three modules, three answers, and no code path produces the third. |
| Callsers hand-namespace keys because the schema cannot hold them | **True, and it has a side effect nobody counted** | `fact_key TEXT UNIQUE NOT NULL` (`memory_schema.py:34`) means one key has exactly one home. The only per-scope mechanism is `_deriveFactKey`, which prefixes non-global *derived* keys with `model:<scope-slug>:` (`session_tools.py:118-129`). |
| The write door is unguarded | **False — it is well guarded** | `rest.py:117-142` refuses a bot→global overwrite *and* a global→bot overwrite, and only allows same-scope or global→global. The earlier audit's "no isolation" framing was overstated. |
| The namespacing workaround is harmless | **False** | Consolidation partitions by `(scope, slug(fact_key))` (`consolidation.py:613-631`) and `_slug` lowercases and strips non-alphanumerics, so `model:bot-x:foo` slugs to `modelbotxfoo` while the global `model:foo` slugs to `modelfoo`. **Two rows holding the same content can never be merged**, because their slugs differ and they are also in different scopes. The workaround manufactures exactly the near-duplicates the merge pass exists to remove, permanently. |
| NULL scope is a fourth answer | **Minor** | `_visibility_where` treats NULL as global when reading (`rest.py:268-272`), while `save_fact` always writes an explicit scope. NULL rows can only come from older writers or imports. |

### 1.2 Why now

`data/august_brain.sqlite` currently holds **0 facts**, and there is no `data/bots`
directory — no Bot has ever written a row. The composite-unique migration is
therefore a **schema change with an empty table to rebuild**, which is the cheapest
it will ever be. The window closes the day a Bot writes its first fact, because at
that point the rebuild has to preserve per-scope rows and the namespaced derived
keys.

### 1.3 The design

**A new unique constraint, not a new convention.**

```sql
CREATE TABLE facts_v2 (
    fact_key   TEXT NOT NULL,
    fact_value TEXT,
    title      TEXT,
    kind       TEXT DEFAULT 'fact',
    category   TEXT DEFAULT 'general',
    source     TEXT,
    confidence REAL DEFAULT 1.0,
    created_at TEXT,
    updated_at TEXT,
    expires_at TEXT,
    description TEXT,
    status     TEXT DEFAULT 'active',
    use_count  INTEGER DEFAULT 0,
    last_used_at TEXT,
    scope      TEXT NOT NULL DEFAULT 'global',
    UNIQUE (scope, fact_key)
);
INSERT INTO facts_v2 (…14 live columns…)
    SELECT fact_key, fact_value, title, kind, category, source, confidence,
           created_at, updated_at, expires_at, description, status, use_count,
           last_used_at, COALESCE(scope, 'global')
      FROM facts;
DROP TABLE facts;
ALTER TABLE facts_v2 RENAME TO facts;
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_facts_updated  ON facts(updated_at);
CREATE INDEX IF NOT EXISTS idx_facts_scope    ON facts(scope, status);
```

`SELECT COALESCE(scope, 'global')` retires the fourth answer at the same time — NULL
becomes the global it was always read as.

### 1.4 The one hard constraint: migrations are not atomic today

`run_migrations` applies each file with `conn.executescript(sql)`
(`app/lib/migrations.py:190`), and `executescript` **commits any pending
transaction first** and then runs the statements as written. A multi-statement
rebuild would therefore be applied statement-by-statement: a failure between
`DROP TABLE facts` and `ALTER TABLE … RENAME` leaves the install with no `facts`
table and a stray `facts_v2`, on the *next* boot.

So `055_scope_fact_key.sql` must open with `BEGIN;` and close with `COMMIT;`
(explicit transaction control is legal inside `executescript`, and SQLite DDL is
transactional). The `BEGIN;` must be the first statement — `executescript`'s
implicit commit happens before it, so this is safe.

The existing safety nets stay: `_snapshot_before_migration` already copies the DB
to `<db>.pre-migration` before any DDL runs (`migrations.py:130-184`), and that
rolling snapshot is what the Oct 7 `august_brain.sqlite.pre-migration` file is.
The plan does not need a new backup; it needs to **verify** the snapshot is
integrity-clean before trusting it, which `brain_backup.py` already knows how to
do (`integrity_check`, `brain_backup.py:79-93`).

### 1.5 Stages

| # | Stage | Files | Acceptance |
|---|---|---|---|
| A0 | Evidence + safety | — | Row counts by scope recorded (0 today); `data/august_brain.sqlite.pre-migration` passes `PRAGMA integrity_check`; app not running. |
| A1 | Migration 055 | `app/migrations/055_scope_fact_key.sql` | `BEGIN;…COMMIT;` as above. Applies from scratch on an empty DB; applies again idempotently (guard on `PRAGMA index_list(facts)` containing `sqlite_autoindex_facts_1` for the composite, or on the new table already absent). Row count in == row count out. |
| A2 | The one writer | `memory_store/rest.py:170` | `ON CONFLICT(fact_key)` → `ON CONFLICT(scope, fact_key)`. This is the only upsert site in the tree (verified by grep), so the blast radius is one line. `allow_scope_override` semantics unchanged. |
| A3 | Kill the dead vocabulary | `session_scope.py:47`, `rest.py:102-115` | `normalize_scope` no longer accepts `project:`; the refusal block in `save_fact` becomes unreachable and is deleted with a comment pointing at the real project-memory layer (`<workspace>/.aug/memory`, `project_memory.py`). One answer instead of three. |
| A4 | Drop the namespacing workaround | `session_tools.py:118-129` | `_deriveFactKey` stops prefixing by scope — the composite unique makes it unnecessary, and a Bot and a global session now legitimately own their own `model:foo`. Cross-scope merge stays forbidden by design (the 2.5 rule, `consolidation.py:642-644`). |
| A5 | Verify | script | `integrity_check` ok; counts match; **the same key written from two scopes produces two rows, both readable in their own scope and neither visible in the other**; a bot write still refuses to touch a global key (the A2/rest.py guard); consolidation still partitions by scope and now merges within it; the BM25 corpus rebuilds (it queries `facts` fresh, so a boot after migration is enough). |
| A6 | Rollback story | docs | Restore `<db>.pre-migration` at next startup via the existing staged-restore path (`brain_backup.py`, `brain-restore.pending`). Documented, not automated. |

**Risk:** LOW today (empty table, one writer). It rises the moment Bot-scoped facts
exist. Nothing else in the tree reads `fact_key` uniqueness directly — the BM25
corpus and the boot index both query by scope.

---

## Part 2 — The Decisions surface

### 2.1 What the live UI actually is

Driven with Playwright against the running app on `127.0.0.1:8085`
(`web-dist`, dark theme). Not a guess — observed:

- **Learning is a top-level nav destination**, not under Settings: sidebar shows
  `New chat / Automations / Board / Learning`. Route `/learning`.
- The hub (`sections/learning/LearningHub.tsx`) is a four-tab rail —
  **Inbox / Skills / Memory / Scheduler** — and each tab renders an *existing*
  settings section. Its header comment says the file is "strictly ADDITIVE", so a
  fifth tab is the sanctioned move.
- The **Scheduler** tab renders `<LearningPanel defaultExpanded />`, the 869-line
  component. It currently shows:
  - "August has not learned anything yet — run a learning pass after real
    sessions." with `Episodes 0 · Tier 2 0 · Judged 0 · Fingerprints 3 · Resolved 0 ·
    Precision —`. **That is the §5 diagnosis rendered in the product.**
  - `TURN VERDICTS (7D)`: answered 12, errored 3; **Rounds avg 3.33, max 20**;
    Malformed tool args 0; Tool-surface downgrades 0; **Edit-verification misses
    "not recorded · 15 not recorded"**; Guardrail blocks 0. It carries the honest
    line "These are finished turns — every answer still reached you. Nothing here
    gates a response." — the tone a Decisions tab must match.
  - `BACKGROUND JOBS`: introspection / consolidation / refine / reviewer / outcome /
    review, each `every Xh · last Y ago` + a **run now** button.
- Conventions to copy exactly: `data-testid="learning-*"`,
  `useQuery` + `api.get` + `queryClient`, `rounded-lg border border-border/50
  bg-card/60 px-3 py-1.5 text-xs` rows, section headings
  `text-2xs font-semibold uppercase tracking-wider text-muted-foreground`, and a
  `run now` button per row.
- The **Memory** tab holds the toggles (`Auto-inject relevant memories each turn` =
  `memoryAutoInject`, `Model can save memories`, `Learn from finished conversations
  (off by default)`), Backups & restore, and Import.

Because the running server predates today's backend changes, `/api/brain/decisions`
currently 404s and `journal` is absent from BACKGROUND JOBS — both appear on the
next restart.

### 2.2 One consequence to expect, not fear

`turn_outcomes.rounds` now counts **model dispatches** (`modelRounds`) instead of
the loop's budget counter, because self-heal decrements `toolRound` in place. On a
turn that self-healed, the two differ. So on the first run after this change the
Scheduler tab's `Rounds avg 3.33` will **rise**, and `max 20` may rise too. That is
the fix working, not a regression. The label should change with it: "Rounds" →
"Model calls", so the stat says what it counts.

### 2.3 Stages

| # | Stage | Files | Acceptance |
|---|---|---|---|
| B1 | The journal row earns its line | `LearningPanel.tsx` `jobOutcomeLine` | A `journal` case. Without it the new Background-jobs row renders as bare `every 24h · last 3h ago` — a job that looks dead. Suggested: `12 decided · 9 resolved · 3 unscorable · Brier 0.18`. |
| B2 | New section component | `sections/settings/DecisionsSection.tsx` | Reads `/api/brain/decisions?days=30`. Renders: a digest strip (logged / resolved / unscorable / expired / cost per resolved), a by-model table, a by-kind table, and the newest rows with status pills and the rejected-alternatives affordance. **`unscorableRate` sits next to `brier`, never alone.** Copy the "not recorded" honesty pattern already on screen for edit-verification misses. |
| B3 | Wire the tab | `LearningHub.tsx` | Add `{ id: 'decisions', label: 'Decisions', Icon: Scale }` to `TABS` and a render branch `<DecisionsSection />`. No badge in v1: the Inbox badge counts *proposals a human must act on*, and an open ledger row is not that — a badge would train the user to ignore the Inbox. |
| B4 | Make `record_decision` reachable | `tools/model_tools.py` + a config knob | The tool is deliberately not in `AUGUST_CORE_TOOLS`, so on a large tool surface progressive disclosure can defer it and the user never sees a counterfactual logged. Add a `decisionJournal` brain-config key (default **on**) that injects the tool into the core set for the next turn, and surface the same switch on the Decisions tab next to the other memory toggles. |
| B5 | Verify | — | `npm run check -w frontend/desktop` (tsc + eslint), `npm run check:design`, then a real look: restart the backend, re-drive `/learning` with the same Playwright harness, and confirm the tab renders, the journal row reads correctly, and `Rounds` still sums. Screenshot before/after into `docs/plans/` for the record. |

**Risk:** additive UI (B1–B3) is LOW. B4 changes the per-turn tool surface and
therefore the prompt bytes a provider sees, which is the one change here that can
move the prefix cache — it belongs behind a default-on-but-documented knob, and it
is the only stage that needs a live check rather than a static gate.

---

## Recommended order

1. **Part 1 (A0–A6) now, while `facts` is empty.** It is a schema change with no
   data, one writer, and an existing pre-migration snapshot. Every week it waits,
   a Bot fact makes it more expensive.
2. **B1 immediately after** — one `if` branch, and it is the difference between the
   journal job looking alive and looking dead.
3. **B2–B3 together**, verified by looking at the running app.
4. **B4 last**, behind its knob, because it is the only stage that changes what a
   model sees.

Both parts are already backed by the code in the tree from
`docs/HARNESS_AND_MEMORY_DEEP_DIVE_2026-10-17.md` §11: the ledger, the journal job
and the endpoint exist; Part 1 fixes the store they will one day be measured
against, and Part 2 makes them readable by a human.

---

## Implementation status (2026-10-17, later pass)

Part 1 and B1 are done; see `memory/2026-10-17.md` for the detail.

**Shipped:** migration is `_ensure_fact_scope_key` in `memory_schema.py` (not a
`.sql` file — see §1.4, and the note below about *why* that decision changed
again), `ON CONFLICT(scope, fact_key)` at the single upsert site, the dead
`project:` branch deleted, `_deriveFactKey` de-namespaced, and B1's `journal`
case in `jobOutcomeLine`. Verified on throwaway databases, ruff + mypy +
tsc + eslint + all static gates clean.

**One real bug found while testing:** `PRAGMA table_info` reports a column
default as `datetime('now')` — SQLite strips the parentheses — so emitting the
reported text verbatim is `near "(": syntax error`. `_default_clause()` now
parenthesises anything that is not a plain literal or number. Worth knowing
before anyone writes another generated-DDL path.

**Shipped in the same pass:** B2 (`DecisionsSection.tsx` — digest strip,
by-model/by-kind buckets, status-filtered rows, honest empty state, `alternatives`
mapped snake_case→camelCase in one place), B3 (the `decisions` tab in
`LearningHub.tsx`, `Scale` icon, no badge in v1 per §2.3) and B4 (`decisionJournal`
brain-config key in `brain_config_service.py`, read behind the default-off
gate in `workbench.py::_decisionJournalArmed`). The resolve-now control uses
the `Button` primitive, and the lint ratchet is re-baselined at 166 in the same
state it reports — zero new warnings are hiding in the budget.

**Interface the UI runs against:** `GET /api/brain/decisions?days=&status=&limit=`
and `POST /api/brain/decisions/resolve` (see `decision_ledger.py`; `check:api`
confirms the committed OpenAPI schema matches).

### Concurrency hazard — resolved

At 20:18 this session found `workbench.py` mid-rewrite by a second author:
a `_finishTurn(...)` single terminal writer that duplicated the
`_recordPreLoopExit` work, left **syntactically invalid** (a deleted `def` line,
a call using the def-only `*` marker) and fatal on every turn (the call site
referenced undefined locals, and the bad import expected
`maybe_promote_failure_lesson` in `decision_ledger` when it lives in
`turn_outcomes`).

The file was restored from HEAD and the verified `_recordPreLoopExit` changes
re-applied. The tree now carries exactly one terminal writer: `_recordPreLoopExit`
covers the four pre-loop exits, and `turn_close.py` writes the main turn row once
per turn. `_finishTurn` is gone from the working tree; the buggy in-flight copy is
preserved at `C://Users//rober//AppData//Local//Temp//workbench.parallel-agent.py`
if anyone ever wants to revive the idea — it must import the lesson function
from `turn_outcomes`, not `decision_ledger`.

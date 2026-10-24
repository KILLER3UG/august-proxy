# Memory and skills re-anchored on this repo (2026-10-24)

Inbound spec: "SKILL.md-compatible skills + memory loop for August". Its context
section was written from an older snapshot of the harness. **The repo is the
source of truth; where they disagree, the repo wins.** This document is the
re-anchoring, and it is also the status file — one item per commit.

## Step 0 — checkout status: current

`master` == `origin/master`, 0/0. `9a686bec` "Merge branch
'harness-skill-autonomy'" (2026-10-06) is an ancestor, bringing
`harness_rails.py` (+620) and `harness_self_improve.py` (+261). Nothing to pull,
nothing sitting in another worktree.

An earlier "these do not exist" pass was **wrong in two cases** because it grepped
only `backend-py/app` + `frontend/desktop/src` with three extensions:

- `harness-skill-autonomy` is a merge commit, not a file. It is merged.
- `self_evolution` and `db_writer` have repo-wide references.

Corrected picture: `db_writer` is referenced in docs and
`backend-py/scripts/smoke_live.py` but **no `db_writer.py` module exists** — it is
a documented concept, not code. `self_evolution.py` is **already deleted**; only
migration-025 SQL, three `_*.py` scratch scripts and a doc mention remain.
`skill_view`, `memory_str_replace` and `RecalledMemorySection` are genuinely
absent repo-wide.

Live DB: `schema_migrations` max version **54** while files run to
`055_fact_lineage_and_signals.sql`, yet `facts` already carries 055's columns
(`supersedes`, `superseded_by`, `contradicts`, `injected_count`,
`last_injected_at`). Either the ledger is stale or numbering differs. **Not
acted on** — no migration is run or altered on the live DB from here. The spec's
"052 not yet run" is stale: 052 is applied.

`auto_memories` is **retired** (`memory_schema.py:168`, "Part 21 OQ1 ruling,
2026-09-04"). Every remaining mention is a comment recording removal. Part C is
re-anchored onto `facts`. No table is recreated.

## Step 1 — write path: works, and the bench was the broken thing

Chain proved through the real loop (bench + scripted provider, isolated
`AUGUST_DATA_DIR`, no network, no credentials):

```
no workspace bound  -> remember wrote facts: 1 row, key 'bench-package-manager'
                        (caller's key honored), kind=fact, category=general,
                        source='model'
workspace bound     -> remember wrote <ws>/.aug/memory/*.md + MEMORY-INDEX.md
                        and reported scope:"project" regardless of category
```

Two findings:

1. **Fixed in `8dde3c0d`.** The bench never bootstrapped the brain schema, so a
   throwaway run had **0 tables** while `list_facts` returned
   `{"ok": true, "count": 0}`. A missing store was indistinguishable from an
   empty one, so any memory assertion built on the bench would have passed
   vacuously. Now `ensure_schema` runs at bench start and a failure exits loudly.
2. **Not a defect, but a trap.** A bound workspace diverts `remember` to the
   markdown layer — the documented two-store split (`project:<path>` is refused at
   the DB door on purpose). It means a bench run with `--workspace` exercises a
   different store than a chat run would. **Any memory test in this plan must run
   without a bound workspace, or assert against `.aug/memory` explicitly.**

Live brain DB re-confirmed unchanged after all of this: `facts` 0 rows,
`memory_store` 1 row.

## Step 2 — memory gap audit (re-anchored on `facts`, names kept)

Tool names stay `remember` / `list_facts` / `forget` / `brain_query`. No
Hermes-style renames.

| spec item | status | evidence / what is missing |
| --- | --- | --- |
| provenance on facts; only user-stated writable by chat agent | **met, differently and more honestly than asked** | The spec asks for a `tag: stated|observed|inferred`. What exists is `facts.source`, stamped by the CODE PATH that wrote the row, not by the writer's claim: `'model'` (the chat `remember` door, `session_tools.py:729`), `'harness'` (the distiller, `skill_distiller.py:13`), `'user'` (the Memory UI add-box, `routers/august.py:551`), `'bench'` (the bench corpus seeder, observed live), `'promoted-from:<ws>'` (`harness_promote.py:279`) — which is exactly C1's actual requirement ("other tags come only from clearly separate code paths"), and is machine-set rather than self-reported. `verified_at` adds the axis the spec has no answer for: it is set only by a human door and is now read by recall, which renders an unverified harness fact with a `[distilled]` mark. A model-declared `stated` flag would be a claim nothing can check — `remember` is already the only model write door and its own instructions already say user-stated only. **Recommendation: keep `source`, do not add a self-reported tag.** |
| version field + optimistic locking, conflict returns current content | **done** (`if_version`) | Was: no compare-and-swap anywhere, so a concurrent edit silently overwrote. Now `save_fact(..., if_updated_at=...)` puts the guard INSIDE the `ON CONFLICT DO UPDATE` statement (`WHERE facts.updated_at = ?`) and raises `FactVersionConflict`, a `ValueError` subclass carrying the live row, so every caller that already treats a `ValueError` as a refusal still refuses. No column, no table, no store: the token is `updated_at`, which is microsecond-precise (`timeutil.utc_now_text`) and is ALREADY handed to the model by `list_facts` as `updated` — so the knob is satisfiable with no new read surface. `remember` advertises `if_version` and returns `{'ok': false, 'conflict': 'version', 'current': {...}}` naming the stamp to retry with; the project (markdown) door compares the same token against the entry's own `updated`. A token against a non-existent key is refused rather than inserting, in both stores — the token is a claim that the entry exists. |
| edit-in-place with history; forget = delete + derived lines | **met, except the derivation cascade** | `remember` updates by key and `record_rollback(type='restore_memory_item', before=<the prior row>, after=<the new one>)` snapshots both sides, so history is kept and the write is byte-exactly undoable — just not inlined into the fact body as "now X, previously Y". That omission is deliberate: the body is what BM25 ranks and what rides into every later turn, so prose about a superseded value would recall AS the current value. `_forget` DELETES (`session_tools.py:779` → `memory_store.delete_fact` at `:906` → `DELETE FROM facts` at `rest.py:584`), it does not retire — `status='retired'` belongs to consolidation, not to this door — and `delete_fact` first calls `restore_superseded_losers`, so a winner the user forgets does not leave the facts it replaced parked forever. Gated by `_FORGET_ALLOWED_SOURCES` so system-owned rows survive model cleanup, and snapshotted first. **Still missing, and not cheap**: "plus anything derived solely from it" has no edge to follow — `supersedes`/`contradicts` record succession between facts, not derivation from a source row, and the distiller's lessons carry `source='harness'` but no parent key. Adding a `derived_from` column plus the cascade is a schema change, so it is deferred rather than ported. |
| subagents and cron read-only for memory | **exists** | AGENTS.md: "Sub-agents read and recall but never write; the parent turn is the only MODEL-facing memory write door." Verified this session that the deny-set path, not the offered surface, is what enforces it. |
| write-time filters (secrets, IDs, sensitive flag, reject "never disagree") | **done** | Present before: `isSensitiveMemory`, a secret scanner (`hooks/secret_guard.scan_secrets`) refused at the `save_fact` door, `_REMEMBER_MIN_FACT_CHARS`, and `memoryIsJunk` on the distiller path. Added now: `memory_quality.coercivePreferenceReason` at the `remember` door — honesty-suppressing, flattery-requiring and self-elevating text is refused with the matched phrase named. Calibrated before it was allowed to refuse: **28/28 gold accepted, 18/18 coercive refused**, and proved end to end through the scripted loop (refusal arrives as an ERROR tool result, `facts` stays empty). Deliberately NOT behind `memorySensitiveTopics`: a rule the model installed cannot be argued away from the inside, and a human writing it from Settings is their own choice about their own assistant — the same split the sensitive gate uses. **`memoryIsJunk` was NOT wired onto `remember`**: measured, its `MIN_STATEMENT_CHARS = 24` refuses the spec's own example ("I use bun." → "statement is under 24 chars"). It is a bar for distilled lessons, not for user-stated facts. |
| compact write/recall trigger block in the prompt | **partial** | `<memory_policy>` exists and is kept in step with the frozen boot index. Not yet compared line-by-line against spec C4/C5 — **do that before adding text**, since the trimming goal applies and a duplicate block costs tokens on every turn. |

### Step 2 item 1 verified live (no network, no credit, throwaway `AUGUST_DATA_DIR`)

Store door (11 assertions, all pass): unversioned write lands (control); the stamp
is on the wire at microsecond precision; the CURRENT token updates; a STALE token
raises and stores nothing while returning the live row; a token against a missing
key is refused and creates nothing; `FactVersionConflict` is a `ValueError`; and of
two writes both claiming the same read, exactly one lands (`landed=1 lost=1`).

Model door, through the real loop with the scripted provider
(`list_facts` → `remember if_version=<stale>` → retry): the read returns
`updated`, the stale write comes back `status:"error"` with
`{"ok": false, "conflict": "version", "current": {...}}`, and the retry writes. A
version conflict is an ERROR tool result, so the loop's failure taxonomy sees it —
a refused write cannot read as a successful one.

Gates: ruff, mypy (349 files), naming, docs, api, api-index, sse,
tool-registration, brain-config, truncate, lint:ratchet, `e2e:smoke` 20/20. Live
brain DB re-checked after every run: `facts` 0, `memory_store` 1 (`agent_registry`),
no `probe:`/`bench:` rows.

**Gate defect found on the way**: `scripts/check-naming.mjs` matches
`^\s*def\s+\w+\s*\(`, so it never sees an `async def` signature — every camelCase
parameter of every async tool handler is invisible to it, `remember` included. The
new param was named snake_case regardless (it matches `expires_at` in the same
tool), so the gate passes honestly rather than being baselined. Widening the scan
is its own item: it will pull existing async-def camelCase params into the
baseline, which is a census, not a fix.

## Step 3 — skills gap audit: not started

`docs/SKILL_AUTHORING.md` is the format spec and much of Part B already ships
(SKILL.md folders, `references/`, `metadata.hermes` parsing, unknown keys
round-tripping through patches, lazy `catalogue()` as the single prompt door,
`tool_search` → `tool_call` for on-demand load). To be audited item by item:
frontmatter validation with skip-and-log, `platforms` / `requires_*` /
`fallback_for_*` gating, L2 traversal and symlink rejection, `${...}` substitution,
install/import confirmation, size caps.

## Step 4 — the two confirmed gaps to build

- **A1 combined budget.** One budget for skills catalogue + memory index, scaled
  to the active model's window, injected at one point, surviving model switches
  and handoffs. Today they are separately budgeted (`skillsBytes` and
  `memoryBytes` are already measured independently in the bench's
  `context/pressure` event — that instrumentation is the starting point).
- **C6 deterministic alias pre-read.** String-match the user message against
  memory subjects/aliases and skill names, no extra LLM call; attach a one-line
  description or at most 2 non-sensitive records; for skills, hint only.
  Negligible latency, must never delay first token.

## Sequencing and rules carried forward

Item by item, one commit each, updating this file. Isolated temp storage only —
never the live DB, re-confirming live row counts after each live check. Everything
async with timeouts. No swallowed exceptions, hardcoded statuses, or mocked
parallel APIs. Existing skill creation and evolution rails (`harness_rails.py`,
version restore, undo, shadow mode, cooldown, auto-apply off) are not weakened.
The `memoryIsJunk` bar is **not** loosened: it measured 0 false refusals on gold
and 5/5 detection on junk, so it is calibrated, and a paired-delta measurement
would make it redundant rather than letting it be bypassed.

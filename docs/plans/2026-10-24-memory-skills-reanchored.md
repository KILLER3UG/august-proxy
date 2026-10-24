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
| provenance on facts; only user-stated writable by chat agent | **partial** | A provenance axis exists but is not the stated/observed/inferred vocabulary: `facts.source` distinguishes `'model'` (chat `remember`) from `'harness'` (distiller) from `'bench'`, and `verified_at` is set only by three human/UI doors and is now read by recall (`9e460c25`). Missing: a `stated` tag, and the distiller's `source='harness'` facts are now marked `[distilled]` on render — which is the disclosure half. |
| version field + optimistic locking, conflict returns current content | **missing** | No `if_version` on any write path. `facts` has lineage columns (`supersedes`, `superseded_by`, `contradicts`) but they record succession, not a compare-and-swap. A concurrent edit silently overwrites. |
| edit-in-place with history; forget = delete + derived lines | **partial** | `remember` updates by key. `forget` retires rather than deletes. Lineage columns exist. Missing: the "now X, previously Y" history text, and deleting anything derived *solely* from a forgotten fact. |
| subagents and cron read-only for memory | **exists** | AGENTS.md: "Sub-agents read and recall but never write; the parent turn is the only MODEL-facing memory write door." Verified this session that the deny-set path, not the offered surface, is what enforces it. |
| write-time filters (secrets, IDs, sensitive flag, reject "never disagree") | **partial** | Present: `isSensitiveMemory`, a secret scanner (`hooks/secret_guard.scan_secrets`) refused at the `save_fact` door, `_REMEMBER_MIN_FACT_CHARS`, and `memoryIsJunk` — measured 0/14 false refusals on gold, 5/5 caught on junk. Missing: the rejection of honesty-suppressing / flattery-requiring / elevated-permission preference statements. That is a content-class filter that does not exist anywhere. |
| compact write/recall trigger block in the prompt | **partial** | `<memory_policy>` exists and is kept in step with the frozen boot index. Not yet compared line-by-line against spec C4/C5 — **do that before adding text**, since the trimming goal applies and a duplicate block costs tokens on every turn. |

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

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

## Step 3 — skills gap audit

Format spec: `docs/SKILL_AUTHORING.md`. Most of Part B already ships, so this is a
census, not a build plan. Statuses marked ✓ were re-read in the code by me; the
rest are the audit agent's findings and are cited to a file:line but not yet
independently opened.

| Part B item | status | evidence |
| --- | --- | --- |
| folder + `SKILL.md`, `---` at byte 0, YAML mapping, non-empty body | ✓ exists | `re.match('^---\s*\n(.*?)\n---\s*\n(.*)', …)` — anchored at byte 0, so a leading blank line fails; an empty body is refused at `skill_service.py:432`. Both proved live with fixtures. |
| required `name` / `description` at DISCOVERY | partial | `_parseSkill` falls back to the DIRECTORY name for `name` and `''` for `description`; the caps and required-ness are enforced only on the write door |
| skip a bad skill, log a reason, keep the siblings loading | ✓ **built now** | was: invalid *name* logged, every other failure mode vanished silently. Now `_parseSkill` names each cause (unreadable / no closing frontmatter / empty body) at `skill_service.py:417-432` |
| recursive discovery with an optional category level | ✓ **built now** | was exactly one level (`root.iterdir()` + `entry/'SKILL.md'`), so `<root>/<category>/<name>/SKILL.md` was invisible while `skill_packs` could install that layout — it flattened on write to work around the gap. One shared walker `_iterSkillMd` now feeds BOTH discovery and the memo key, depth- and count-bounded, never descending a dot-dir or a symlinked directory |
| roots + precedence, user overrides bundled, bundled read-only | partial | four roots (bot → project → agent → bundled), earlier wins, `overrides` badge. Missing: no config-supplied external root. And `migrate_flat_skills` WRITES into the bundled/install tree, so "bundled is read-only" is not true today |
| unknown frontmatter keys round-trip; `metadata.hermes` parsed | ✓ exists | both ends opened: `_parse_frontmatter_block` (`skill_service.py:469`) parses nested blocks to any depth and keeps leaves as raw strings so a write is byte-identical; `_renderSkillMd` (`:1210`) re-emits unknown keys after the canonical ones. A falsy unknown value is dropped — the agent's claim, not yet opened |
| `platforms` / `requires_tools` / `requires_toolsets` / `fallback_for_*` gating | **missing** | only `disabled: true` and `status: retired` gate visibility (`:647`, `:650`); the `requires_*`/`fallback_for_*` names appear nowhere in `backend-py/app` |
| L1 body + file list + absolute dir; L2 one file, traversal rejected | ✓ **built now (L1)** | `load_skill` returned neither the directory nor a usable path — see the fix. L2 is `read_file` on the absolute path, which is now proven to pass `bind_path`; per-skill containment is the generic door, not a skill-specific one |
| `${SKILL_DIR}` / `${SESSION_ID}` substitution | ✓ **built now** | none existed; added with the Hermes aliases |
| soft line target / hard char cap on the body | missing | a 500-char cap on the DESCRIPTION only (`:219`); `load_bodies` budgets preloads at 24000 chars (`:565`) |
| install with confirmation + exfiltration scan | partial | remote pack install is solid (source + sha256 recorded, traversal refused, 20 MB cap, non-owned collisions refused) but it is a single click with no content scan, and there is no local-folder import at all. `harness_rails._content_check` exists and is wired ONLY to the proposal/auto-apply lane |
| scripts run through the existing terminal tool | ✓ exists | no dedicated skill-script door; `scripts/*.mjs` go through the general gated `run_command` |

Verified live on throwaway dirs (`e2e` of the walker, not a read of the code):
a category-nested skill is discovered and its 9 bundled siblings are unaffected;
three malformed fixtures are each skipped WITH a logged reason while a good
sibling in the same root still loads; a dot-directory is not walked; editing a
NESTED `SKILL.md` busts the catalogue memo (the key and the build now come from
one walker — before, the key could not even see the file). One control could NOT
be run here: creating a directory symlink needs a privilege this shell does not
have, so "symlinked directory is not descended" is implemented and unproven.

Still open, with a recommendation rather than a build: `platforms` gating (cheap,
low value on a single-user Windows desktop); making `name`/`description` required
at discovery (would silently hide existing learned skills that lack a description —
needs a census of the user's own skills first); `list_skills` truncating every
description to 60 chars while the index renders the whole trigger
(`skill_tools.py:132`); the bundled root being writable by a migration.

## Step 4 — A1 + C6 (A1 foundation committed; wiring listed below is the handoff)

**Committed foundation** (`indexBudget` ContextVar in `workbench/context.py`,
`tier1IndexBudget` / `publishTier1IndexBudget` / `currentIndexBudget` in
`workbench/prompt_build.py`, published at the top of `buildSystemPrompt`).
Shrink-only: `_TIER1_INDEX_MAX_CHARS` is today's combined spend, so 128k keeps
exactly today's caps and smaller windows get less — measured: 8192 →
`(157, 129, 6)`, 32000 → `(616, 504, 25)`, 128000 and 200000 → `(2400, 2000, 40)`
(memory chars, skills chars, skills names). The window comes from the loop's own
`_resolveModelContextWindow`, so `august-bench --context-window` drives this
surface too. mypy 349 files, smoke 20/20, prompt byte-stable. Until a renderer
reads the var, nothing changes — every surface keeps its shipped cap.

### A1 remaining wiring, in order

1. **`format_skill_index` is unbounded** (`capabilities_prompt.py:385`): it prints
   every discovered name with no cap. Bound it by the skills slice
   (`currentIndexBudget()[1]`), cutting at a line boundary with a visible
   `… +N more` like the intake line already does.
2. **`brain_index_snippet`'s bare `2400`** (`memory_store/brain.py:843`): take
   `currentIndexBudget()[0]` instead. Keep the line-boundary cut.
3. **The intake name list** (`workbench.py` `shownSkills = skillNames[:40]`, a bare
   literal): take `currentIndexBudget()[2]`. The intake count and the index bound
   MUST come from the same `currentIndexBudget()` call — one budget, two consumers,
   or the two surfaces drift.
4. **`_caps_block_cache` key** (`workbench.py`, `capsKey = workspacePath + tool
   names`): append the budget triple. Without it, a session that starts on 128k
   caches the large index and a switch to an 8k local model serves the cached big
   one — the budget would be real on paper only.
5. **Subagent surface is unbudgeted**: `subagent.py:750` renders the DESCRIPTIVE
   catalogue (`format_skills_by_category`, `_SKILLS_INDEX_BYTE_BUDGET = 24 KiB`,
   `capabilities_prompt.py:181`). Decide: bind it to the same combined budget, or
   document subagents as out of scope. Default recommendation: bind it — a worker
   inherits the parent's context var, so it is one line.
6. **Live proof**: `august-bench --context-window 128000` vs `8192` (same script),
   assert `skillsBytes` + `memoryBytes` from the `context/pressure` event
   (`tailSectionSizes` `workbench.py:245-277`, emitted `:3428-3447`) shrink on the
   small window and are unchanged on the big one.
7. **Document the frozen-index tradeoff**: `_frozen_mem_index` is decided by the
   window at the session's FIRST build, so a later switch to a smaller model does
   not shrink it — re-slicing after a switch would bust the byte-stable prefix the
   freeze exists to protect. State this in the A1 docstring, not just here.

### C6 — deterministic pre-read (not started)

- Use the list-safe `lastUserMessageText` (`turn_close.py:167`) for the user
  message. The extractor at `workbench.py:3173` returns `''` when content is a
  list, so a pre-read built on it silently never fires on multipart messages.
- Match against fields that exist — facts have NO aliases column (DDL
  `memory_schema.py:33-74`): fact `key` + `title` + `description`; skills already
  carry `trigger` + `keywords`. The per-scope fact corpus is already cached
  (`fact_retrieval.py:129`), so the match adds zero I/O at `workbench.py:3173`,
  before any DB call.
- Attach at most 2 records; skip any row whose text trips
  `sensitiveMemoryReason` — there is no `sensitive` column, so the read-time check
  reuses the write-door pattern.
- Skills: on a match add a ONE-LINE hint to call `load_skill`. Never auto-load a
  body.
- Whatever is attached counts against the A1 budget, or A1 is decorative.
- Prove: an alias match attaches; no match attaches nothing; a matched
  sensitive-shaped row is skipped; first token is not delayed (the match is
  in-process string work on a cached corpus).

### Step 2/3 leftovers, recorded with recommendations

- **One-level glob census: CLEAN.** Repo-wide grep finds no other `*/SKILL.md`
  glob — recursive discovery and the memo key were the only two. Still open: the
  walker's `_SKILL_WALK_MAX_FILES = 400` cap truncates SILENTLY; log when it fires.
- **Symlink descent**: implemented (`_iterSkillMd` never follows a symlinked
  directory), unproven — creating a directory symlink needs a privilege this shell
  does not have.
- **`platforms` / `requires_*` / `fallback_for_*` gating**: missing entirely; only
  `disabled` and `status: retired` gate visibility (`skill_service.py:647/650`).
  Cheap, low value on a single-user Windows desktop.
- **Install/import**: remote pack install is solid (source + sha256, traversal
  refused, 20 MB cap, collision refused) but has no confirmation step, no
  exfiltration/destructive scan, and no local-folder import.
  `harness_rails._content_check` exists and is wired ONLY to the proposal/auto-apply
  lane — the wiring is the cheap half of this.
- **`list_skills` truncates every description to 60 chars** (`skill_tools.py:132`)
  while the index renders the whole 500-char trigger. The listing defeats the
  trigger it exists to advertise.
- **Bundled root is not read-only**: `migrate_flat_skills` writes/unlinks inside
  the install tree.
- **`name`/`description` required at discovery** would hide existing learned skills
  that lack a description — census the user's own skills before tightening.
- **Part D save chip**: memory writes surface as generic `memoryWrite`-classified
  tool receipts (`AssistantBlockTimeline.tsx:461/1056`), not a dedicated chip, and
  there is no one-click undo in the transcript. Undo exists as DATA (rollback
  snapshots in `rollback_store`; Settings → Memory delete). Decide: build the chip
  with undo, or accept the receipt + a Settings-side undo.
- **`stated`/`inferred` UI marker**: recommended against — `facts.source` is
  machine-set by the code path, which a model-declared tag cannot be. If a marker
  is wanted anyway, the honest fields are `source`/`verified_at`, and
  `_recalled_row` (`fact_retrieval.py:685`) deliberately emits only 4 keys — adding
  one is a documented-contract change.
- **Forget + derived lines**: no derivation edge exists (`supersedes` records
  succession, not derivation); a cascade needs a `derived_from` column. Deferred.
- **`<memory_policy>` vs spec C4/C5**: not yet compared line-by-line. Do that
  BEFORE adding any prompt text — the trimming goal applies and a duplicate block
  costs tokens every turn.

### Process

Eight commits unpushed (`8dde3c0d` bench schema bootstrap through the A1
foundation). The final report (Phase 0 findings, what shipped, what was verified
live, what was deferred) is outstanding and should be written when this list is
empty or explicitly parked.

## Sequencing and rules carried forward

Item by item, one commit each, updating this file. Isolated temp storage only —
never the live DB, re-confirming live row counts after each live check. Everything
async with timeouts. No swallowed exceptions, hardcoded statuses, or mocked
parallel APIs. Existing skill creation and evolution rails (`harness_rails.py`,
version restore, undo, shadow mode, cooldown, auto-apply off) are not weakened.
The `memoryIsJunk` bar is **not** loosened: it measured 0 false refusals on gold
and 5/5 detection on junk, so it is calibrated, and a paired-delta measurement
would make it redundant rather than letting it be bypassed.

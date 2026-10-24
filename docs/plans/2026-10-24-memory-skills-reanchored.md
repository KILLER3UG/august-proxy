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
| compact write/recall trigger block in the prompt | **met — no text to add** | Compared 2026-10-24. The inbound spec text is not in the tree, so the comparison ran against this file's own record of C4/C5 ("compact write/recall trigger block"). **C4 (write triggers)**: `<memory_policy>` (`prompt_segments_cache.py` `MEMORY_BLOCK`) already carries every trigger — the four save categories, the description-first shape with `details` + `[[key]]` cross-refs, the anti-triggers (task steps, code structure, git-derivable), the necessity bar with "when in doubt, save nothing" (that IS the trimming goal, present verbatim in effect), update-don't-duplicate with the frozen-index honesty note, self-correction, and the sensitive-refusal notice. ~1.6k chars, no duplication inside it. **C5 (recall triggers)**: met by MECHANISM, not prompt text — the per-turn BM25 tail (auto-inject, armed by default), the boot index in `<intake>` whose own header line says "read via brain_query store=facts", the memory-delta block, and the read tools. The model needs no instruction to RECEIVE deterministic injection; the only recall instruction is the on-demand pointer, and the intake line + harness guide already carry it. Adding C5 text to `<memory_policy>` would duplicate the intake line on every turn for behaviour the harness already performs — exactly the duplicate-block cost this row warned about. Verdict: **add nothing**. One wording check: the block's "your memory index (in context at session start)" makes no completeness claim, so A1's partial slice at small windows does not contradict it. |

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

**WIRING SHIPPED 2026-10-24** — all seven items below are done and verified live;
the numbers in each row are from the runs, not from reading the code.

1. **`format_skill_index` bounded** (`capabilities_prompt.py`): the NAME lines
   draw on `currentIndexBudget()[1]`, stop-packing at the first line that
   would overflow (same rule as the descriptive renderer) with a visible
   `… +N more (list_skills for all)` receipt. The fixed header prose is exempt
   on purpose — it is the same bytes on every build regardless of window.
   With the 9-skill bundled catalogue the 128k render is byte-identical to
   the unbounded legacy (726 chars, 9 names); at the 8k slice it packs 7
   names + the receipt.
2. **`brain_index_snippet` takes the memory slice** (`memory_store/brain.py`):
   the bare `2400` is now `currentIndexBudget()[0]` (the unscaled fallback IS
   2400, so an unpublished read is unchanged). Line-boundary cut kept.
3. **The intake name list** takes `_indexBudget[2]` from the ONE
   `publishTier1IndexBudget` call at the top of `buildSystemPrompt` — the
   intake count and the index bound cannot drift.
4. **`_caps_block_cache` key** carries the budget triple, so a 128k→8k model
   switch rebuilds at the small window instead of serving the cached big
   index.
5. **The subagent descriptive index is bound**: `subagent.py` passes
   `skills_max_bytes=sum(currentIndexBudget()[:2])` — the combined envelope,
   whole, because a worker has no memory boot index to share it with. The
   worker inherits the PARENT's published var (context vars copy into spawned
   tasks); a worker routed to a different model inherits the parent's window,
   an accepted limit stated in the call site. The shipped 24 KiB cap remains
   the fallback for direct callers. **This is the one surface where 128k
   changes deliberately**: a catalogue big enough to hit 24 KiB now packs at
   ~4.4k chars with the renderer's own truncation receipt and warning.
6. **Live proof** (`august-bench`, scripted provider, throwaway data dir,
   12-fact corpus, same script both arms): `context/pressure` now carries
   `indexMemoryBytes` / `indexSkillsBytes` inside `contextSections` (the
   build records the rendered byte sizes on the session; the tail keys
   `memoryBytes`/`skillsBytes` keep meaning the per-turn tail, which this
   budget does not touch). Measured: **128k → index memory 1245 B / skills
   730 B; 8k → 103 B (−92%, cut at a line boundary) / 728 B** — the skills
   delta is small only because the 9-name bundled catalogue's name lines
   fit the 129-char slice; a larger catalogue packs harder. Tail blocks are
   flat across arms (796/792 memory, 1403/1403 skills), confirming the
   budget targets the Tier-1 index. `trajectory.json` steps record the pair
   as `index_bytes`. The smoke's byte-stable prompt (7839 chars across
   rebuilds) still holds — the default build is unchanged.
7. **The frozen-index tradeoff is a stated decision**, not a silent one: the
   boot index is frozen as TEXT at the session's FIRST build, so a mid-session
   switch to a smaller window does NOT shrink it — re-slicing would rewrite
   bytes inside the prefix-cached system block, the exact bust the freeze
   exists to prevent. Stated at the freeze site in `buildSystemPrompt` and in
   the `tier1IndexBudget` docstring. The skills index DOES follow a switch
   (its cache key carries the budget); the boot index does not, on purpose.

### C6 — deterministic pre-read (SHIPPED 2026-10-24, proven end-to-end)

- `alias_preread_facts` (`fact_retrieval.py`): substring-matches the message
  against `key`, `title`, `description` — plus the key's own SEGMENTS and
  their spaced forms, because keys are namespaced by convention
  (`bench:gpu-setup`, the `feedback:<topic>` shape `<memory_policy>`
  recommends) and a message that names the subject almost never contains the
  full key. No aliases column, no migration. At most 2 records, newest first,
  each carrying `matched_field` for audit. A row whose text trips
  `sensitiveMemoryReason` is dropped at READ time (there is no `sensitive`
  column; this reuses the write-door detector, so rows written before that
  rule or by another door are caught). `exclude_keys` drops what the turn
  already rendered.
- `alias_preread_skills` (`capabilities_prompt.py`): matches `name` (raw,
  spaced), `keywords` (≥4 chars) and the whole `trigger`; hint-only by
  contract — the caller renders ONE line pointing at `load_skill`, never a
  body. Skills the Relevant-skills tail already rendered (or the user pinned)
  are excluded, so one skill is never shown twice.
- The message text comes from the list-safe `messageText`
  (`turn_close.py`), not the `''`-on-list extractor — a multipart
  (image+text) message gets its text blocks joined instead of silently never
  matching. (`lastUserMessageText` now shares the same helper. The tail
  patch itself still replaces a list content with a string — latent, not
  live: current senders normalize to strings; flagged here, not fixed.)
- **No second budget**: the memory attachment's byte cap IS
  `currentIndexBudget()[0]` and the skill hints' IS `currentIndexBudget()[1]`
  — at the 8k slice the attachment shrinks with the boot index; at 128k the
  ≤2-record count bound does the work. Gated by `memoryAutoInject` exactly
  like the BM25 lane beside it (a user who turned per-turn injection off
  opted out of tail memory); the skill hints are ungated (the skills tail has
  no opt-out to honour).
- **Zero added I/O**: the match reads the same per-scope cached corpus
  `build_memory_block` loads for the turn, and the catalogue is
  mtime-memoized. Measured (Test 23): **20 µs/call facts, 16 µs/call skills**
  on a 2-row store / 9-skill catalogue — in-process string scans, no
  round-trip on the first-token path.
- **Proven through the real loop** (scripted provider): a task naming
  `gpu-setup` attaches `bench:gpu-setup` to the `recalledMemories` event in
  both window arms — BM25 alone never surfaced it (it is absent from the
  first five ranked rows). No-match tasks attach nothing. A task naming a
  skill whose tail line already rendered attaches nothing (exclusion); with
  the relevance gate off (`skillRelevanceMatch: false`) the tail renders
  nothing and the hint block fires verbatim: `Aliased skills (matched this
  message — bodies load via load_skill): - anatomy`. A sensitive-shaped row
  is skipped; its non-sensitive sibling in the same match still attaches.

### Step 2/3 leftovers, recorded with recommendations

- **One-level glob census: CLEAN.** Repo-wide grep finds no other `*/SKILL.md`
  glob — recursive discovery and the memo key were the only two. The walker's
  `_SKILL_WALK_MAX_FILES = 400` cap now LOGS when it fires (warning naming the
  root), so a silent truncation can no longer read as "that is every skill".
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
- **Part D save chip** — RECOMMENDATION (owner ruling needed): accept the
  receipt + the Settings-side undo. Memory writes already surface as
  `memoryWrite`-classified receipts (`AssistantBlockTimeline.tsx:461/1056`),
  the undo already exists as data (rollback snapshots in `rollback_store`,
  Settings → Memory delete), and a chip with in-transcript undo is new UI
  surface for a low-frequency, low-risk action. Revisit only if the usage
  counters show users actually reaching for the Settings path after a write.
  A `stated`/`inferred` marker is recommended against — `facts.source` is
  machine-set by the code path, which a model-declared tag cannot be; if a
  marker is wanted anyway, the honest fields are `source`/`verified_at`, and
  `_recalled_row` (`fact_retrieval.py`) deliberately emits only 4 keys, so
  adding one is a documented-contract change.
- **Forget + derived lines**: no derivation edge exists (`supersedes` records
  succession, not derivation); a cascade needs a `derived_from` column. Deferred.

### Verified after the discovery changes (spec test list)

- **Test 7** (evolution pipeline): a fixture skill carrying unknown
  frontmatter keys (`origin`, `supersedes`, `learned_from`, a flat unknown,
  and the nested `metadata.hermes` block) round-trips parse →
  `_renderSkillMd` → parse BYTE-IDENTICALLY, and is still discovered with
  `created_by: agent`. `renderSkillBody` emits the canonical sections from a
  distiller-shaped draft (`steps` as do-pairs), `bodySubstance` passes the
  substantive draft and refuses a thin one (it refused this probe's own
  first, wrongly-keyed draft), and the pipeline's output parses back with
  valid name/description/body.
- **Test 21** is the A1 live proof in item 6 above (both surfaces survive a
  window switch; the small window shrinks).
- **Test 23** is the C6 timing line above.

### Process

Eight commits unpushed (`8dde3c0d` bench schema bootstrap through the A1
foundation). The final report (Phase 0 findings, what shipped, what was verified
live, what was deferred) is delivered in-session; this file is its durable copy.

## Sequencing and rules carried forward

Item by item, one commit each, updating this file. Isolated temp storage only —
never the live DB, re-confirming live row counts after each live check. Everything
async with timeouts. No swallowed exceptions, hardcoded statuses, or mocked
parallel APIs. Existing skill creation and evolution rails (`harness_rails.py`,
version restore, undo, shadow mode, cooldown, auto-apply off) are not weakened.
The `memoryIsJunk` bar is **not** loosened: it measured 0 false refusals on gold
and 5/5 detection on junk, so it is calibrated, and a paired-delta measurement
would make it redundant rather than letting it be bypassed.

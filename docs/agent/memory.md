# Memory

Stored memory reaches a turn through three lanes, and only one of them is a
keyword search. Confusing them is the usual reason a "why did it not remember"
investigation goes wrong. The model-facing tools are `remember`, `list_facts`,
`forget` and `brain_query`; the store is the SQLite `facts` table.

## The three lanes

**Durable memory** — the `Relevant memory:` tail is BM25 over the brain `facts`
table, gated by brain-config `memoryAutoInject` (**ARMED BY DEFAULT since
2026-10-24**; it was OFF, which was a trust decision rather than a measured one —
the write door that feeds this lane, `memoryIsJunk`, refuses 0 of 14 durable
rules and catches 5 of 5 junk cases, so the content is already filtered). An
install that turned it off keeps it off: verified through the real
`PUT /api/brain/config` door, a persisted `false` beats the new default.

Three things are true regardless of that gate:

- `kind='profile'` facts are an always-in lane (rendered first, ~600-char
  budget, injected even with auto-inject off — this is what makes August
  remember *who you are* without a keyword coincidence).
- A fact dropped for budget is **named** in a `recall partial:` line rather
  than vanishing.
- `build_memory_delta_block` appends a plain `new in memory since this chat
  opened:` section listing facts whose `updated_at` is newer than the session's
  own creation stamp — so a fact written by `remember` is visible on the NEXT
  request without the model having to call `list_facts` first.

The delta is a **projection over the facts table, not a cursor and not a second
store**: an UPDATE to an existing key is delivered like a new write, a retired
row cannot resurface, keys the recall lane already showed are skipped, and an
unparseable session stamp returns NOTHING rather than dumping the whole store
into the tail. It rides the tail (stripped before persistence), so the cached
prefix is untouched; `memory_context_preview` deliberately omits it, because a
preview has no session.

DB scopes are `global` and `bot:<agentId>` only; `project:<path>` is refused at
the write door on purpose, because workspace memory is the separate
`.aug/memory` markdown layer that the tail already carries.

## Model-managed memory (CRUD is a set)

`remember` (write/update by key), `list_facts` (enumerate keys) and `forget`
(retire/delete) are all **core** tools: they are in `HARNESS_CORE_TOOLS` so
progressive disclosure can never hide the key lookup that `remember`'s own
instructions depend on, and in `_BARE_TOOL_ALLOW` so a weak/downgraded model can
still correct what it remembers instead of only accumulating.
`retrieve_relevant_facts(min_query_chars=…)` splits the two callers: the
automatic tail keeps the 8-character floor (a 4-character message must not spend
context), while a deliberate `brain_query(store='facts')` search answers even for
`"gpu"`.

## Bringing a memory export in

Settings → Memory → Import has two doors. The file door parses one `.md`/`.json`
in the webview and previews it. The **whole-export door** hands the folder (or
`.zip`) another agent shipped to `POST /api/august/memory/import-claude`
(`memory_import.py`), which reads every file and writes into `facts` — never a
second store:

* `profile.md` lands as `kind='profile'`, `preferences.md` as `kind='preference'`
  — the two kinds the always-in-context lane reads, so an imported identity is
  recalled without winning a BM25 slot. `areas/*` → `category='project'`,
  `topics/*` → `category='reference'`.
* one bullet = one fact, keyed by the same slug `remember` derives, so re-importing
  the same export reports `unchanged` instead of restating rows;
* a near-duplicate under a **different** key is reported as folded into that key
  and not written (the store's own `DEDUPE_SIMILARITY` bar, not a new one);
* **two bars run before anything is written.** `memoryIsJunk` refuses task state,
  completed-work logs and fragments — except in the `profile`/`preference` lane,
  where "Goes by Sheesh" IS the memory and the under-24-char rule measured as a
  false positive. Then one batched review-model call (`_model_review`, 40 lines
  per call) answers `KEEP` or `DROP <why>` for every survivor, and the report
  names how many each bar removed. A line the reviewer never answered is kept and
  counted as `reviewMissing`: an outage must not block a migration, and it must
  not be reported as approval either.
* every write goes through `save_fact`, so the credential refusal still applies,
  and each landed row gets a rollback entry — the import is undoable per row.

`dry_run` reads the store exactly like the real run and writes nothing, so the
plan's numbers are the outcome's numbers. Fuzzy merges (paraphrases that miss the
similarity bar) stay with the AI-arrange door, which spends one model call to
decide add/update/delete.

The import is the only bulk door, so it is the only one with a pre-write judge.
What is already stored gets its model read from the standing review pass
(`memoryReview`, daily): one call across the durable corpus flags duplicates,
stale entries and retirements — those land as proposals, and a retirement is the
one memory action that still waits for a human, because it removes rather than
adds.

The boot memory index is **frozen per session** to protect the provider prefix
cache, so `<memory_policy>` tells the model to re-read `list_facts` after
writing rather than trusting that index — keep the prompt text and that
behaviour in step if either changes.

Sub-agents read and recall but never write; the parent turn is the only
MODEL-facing memory write door (internal/UI routes also call `save_fact`).

**That read is enforced, and the read is now complete.** `remember` refuses its
first write in a turn until `list_facts` (or `brain_query` over a memory store)
has run once that turn — only when the store actually holds something to check,
and never when `modelMemoryRead` is off, since a gate the model cannot satisfy
would make memory unwritable. A sentence already stored under a different key is
refused with that key in the result (`existingKey`), because "update, don't
duplicate" was advice, not a mechanism.

On the read side `list_facts` takes `offset` and reports `total`/`hasMore` — it
used to be hard capped at the 50 newest rows, so a store the model could write
to was one it could only partly read back — and `include_retired` exposes the
rows consolidation parked, which recall skips but which are still stored memory.
`brain_query` advertises the `memory` (KV notes) store for the same reason:
reachable-but-unadvertised is a door the model has to guess at.

## Serialization traps

A fact/KV value is **stored JSON-encoded**, so every read door must decode it or
the human browse list shows `“"a sentence"”` where the boot index shows the
sentence (and the edit field re-encodes it on every save) —
`memory_store.brain_browse` decodes a JSON *string* and leaves an object
verbatim, because unwrapping one would drop `details` on the next save.

## The markdown mirror

`<dataDir>/memory/` is a one-way, human-readable view: one `.md` per active fact
plus a `MEMORY.md` index. **Reads never touch it** — recall, BM25, the boot index
and `brain_query` read the database only, so the two can never disagree about
what a turn injects. Every mutating write updates one file and rewrites the
index; hand edits are overwritten, and the index header states that rule.
`memory` is in `hardline._AGENT_STATE_DIRS`, so `write_file`, the terminal and
code mode refuse `<dataDir>/memory/**`: a model that can write the human-readable
view can install instruction-shaped content beside the facts a person reads to
audit it. The project layer (`<workspace>/.aug/memory`) is a different path and
stays model-writable by design. Settings → Memory → "Open folder" opens it
through the backend so the frontend never learns the data dir.

## Backups and restore

**Memory survives independently of recall** — `app/services/brain_backup.py`
takes online copies through SQLite's backup API (read-only handle, no write lock
on the live file), runs `PRAGMA integrity_check` on every copy before trusting
it, and prunes to a verified rolling set; `GET /api/brain/integrity` is the
health read. Settings → Memory shows the backups card. A restore is staged
through `POST /api/brain/backups/restore` and applied at the next launch.

**A restore is staged and applied at the next launch, never in place:**
`memory_store.close()` closes only a thread-local connection while other threads
still hold the live file, so an in-process swap yields a half-old database (and
fails to rename on Windows). `apply_pending_restore()` therefore runs in
`main.py` before the store initializes and keeps what it replaced as
`.pre-restore`; the pending marker is a file, not a row, because the case needing
a restore is one where the database may not open. A copy on a newer schema is
refused using the migration runner's own version discovery. Do not add an
in-process swap or a second version constant.

## The memory-user experience

The current user-facing surfaces (Settings → Memory list, Library, save chip,
proposals, backups) and the open UX work are in
[../specs/memory-and-skills.md](../specs/memory-and-skills.md). This file is the
rule set; that one is the product state.

# The memory markdown mirror + the ZCode type vocabulary

**Ruling (2026-10-27):** adopt both actionable pieces of the ZCode memory
design reviewed that day — the human-readable markdown layer for the global
facts store, and its type vocabulary as input aliases. The third option
(file-as-record-of-truth) was declined: it would rebuild ranking, versioning,
CAS, scopes and lineage on files, which is the "never add a parallel system"
trap.

## 1. The markdown mirror (`memory_store/mirror.py`)

`<dataDir>/memory/` — one `.md` per active fact plus a ZCode-shaped
`MEMORY.md` index (one bullet per fact: title, relative file, description).
The file frontmatter carries the ZCode `type:` alongside August's canonical
`subject:`, `tag:`, `scope:`, `updated:`, `version:` and the exact `key:`.

**The derivation goes one way, and three fences keep it honest:**

- **Reads never touch it.** Recall, BM25, the boot index and brain_query all
  read the database only. Nothing parses these files back, so the two can
  never disagree about what a turn injects. The store of record is unchanged.
- **Hand edits are overwritten.** Every mutating write updates one file and
  rewrites the index (a single SELECT + one file write); `run_consolidation`
  rebuilds wholesale once per pass; boot does the same, so hand edits and
  out-of-band writes are repaired. The index header states the rule in plain
  words.
- **Model-write fenced.** `memory` joins `hardline._AGENT_STATE_DIRS`, so
  `write_file`/terminal/code-mode refuse `<dataDir>/memory/**` — same reason
  the proposal inbox is fenced: a model that can write the human-readable
  view can install instruction-shaped content beside the facts a person
  reads to audit it. The code-mode port inherits the tuple mechanically.
  The project layer (`<workspace>/.aug/memory`) is a different path and stays
  model-writable by design.

Exclusions mirror the boot index exactly: `sensitive=1`,
`subject_type='person'`, non-active (retired/archived) and expiring rows
never get a file; a write that revives or de-sensitizes them brings it back.
Deleted/retired rows drop the file. Body text renders the JSON value
(fact + details), and 059's `previous_value` renders as a "Previously:"
blockquote.

Buttons: Settings → Memory → "Open folder" (backups card header) →
`POST /api/brain/memory/open-folder` (os startfile/open/xdg-open; the
backend owns the path so the frontend never learns the data dir).

## 2. The ZCode type vocabulary as input aliases

`user / feedback / project / reference` are accepted wherever a
`subject_type` is written and normalized to the canonical record:
`user→profile`, `feedback→preference`, `project→area`, `reference→topic`.
The normalization lives once in `save_fact` (the only write door), so a
prompt written in ZCode's dialect lands canonically while every reader keeps
seeing the five canonical words. Unknown words fall through to the existing
derivation.

## What was deliberately NOT built

- No ingest-back of hand edits (the mirror is a view; ingesting edits would
  make it a second write path with its own conflicts).
- No per-scope mirrors, no watch mode, no sync engine — one derived folder,
  maintained at write time.

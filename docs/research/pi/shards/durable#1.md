# pi / durable#1

## Shard shape

This shard is the whole of pi's **durable harness runtime** (`packages/durable`, 89 files): the package entry
point (`package.json`, `README.md`, `CHANGELOG.md`, `docs/spec.md`), the `codemode/` sub-package, the root type
surface (`src/types.ts`, `src/documents.ts`, `src/entries.ts`, `src/errors.ts`, `src/truncate.ts`, `src/timers.ts`,
`src/search.ts`), the execution-environment abstraction (`src/env/`), the harness itself (`src/harness/` — the
scheduler, the generation/tool/compaction task state machines, the inbox, the prompt planner, the event stream), the
session kernel (`src/session/` — the mutation line, transactions, forks, observation), four storage backends
(`src/storage/` — memory, SQLite, IndexedDB, JSONL), the built-in coding tools (`src/tools/`), the image pipeline
(`src/images/`), and the runner-independent conformance suites (`src/testing/`).

The shape of the whole thing is: **a durable task scheduler over an event-sourced store**. A `Harness` owns a
`Session` (one mutation line over one `Storage` backend); the `Session` owns transactions, document incarnations and
an ordered transcript of immutable entries. The harness's *work* is not a loop but a set of **durable task state
machines** (`GenerationTask`, `ToolTask`, `CompactionTask` — plus anything an extension registers), each of which
advances through named phases, each of which commits its next state *before* the effect it authorises. The scheduler
reserves a task, runs one phase, and adopts the committed state; a crash therefore loses at most one phase, never a
committed fact. Everything else — the inbox of queued/steering submissions, the live view of the current round, the
usage ledger, the tool-result ordering, the compaction cut — hangs off that one mechanism.

**How they fit together:** `src/types.ts` is the contract (`Storage`, `Tx`, `TaskDefinition`, `TaskRuntime`,
`DocumentSemantics`); `src/session/` implements it (`SessionImpl` = the mutation line + document cache + commit
publication; `Transaction` = one commit); `src/storage/` implements `Storage` four times; `src/harness/` puts a
scheduler and the three built-in tasks on top of a `Session`; `src/tools/` and `src/codemode/` are ordinary
extensions. August is the mirror image: it runs a live in-process loop with its own turn budget and stall detection,
and the interesting question for the August harness is which of these durability mechanisms are worth the cost.

## Per-file notes

### packages/durable/CHANGELOG.md
- **Purpose:** Release history 1.0.0 → 1.4.0, written as behaviour changes with issue links rather than as a list
  of commits. It is the most honest place in the repo for design rationale, because every entry is phrased as
  "what broke, and what we changed".
- **Key abstractions:** None; it is prose. The recurring nouns are the task lifecycle (`phase`, `checkpoint`,
  `sleeping`, `restartLimit`), the document model (`checkpointWhen`, `migrate`), the tool surface (`replay`,
  `callers`, `structuredOutputSchema`) and the storage backends.
- **Data flow:** n/a.
- **Non-obvious design decisions:** `TaskRuntime.sleep()` was removed because "it waited inside a phase, which
  holds an invocation and, after a restart, reruns the phase and restarts the wait" (`:9`) — a task now *ends* its
  phase asleep. `defineDoc()`/`defineDocFamily()` require an explicit `checkpointWhen` predicate with no default
  (`:14`) — a policy, not a heuristic. A task cut off by a crash 5 times in a row without committing a new state is
  *parked* rather than run again (`:13`).
- **Edge cases / failure handling:** The crash-loop guard is the headline: the limit is a setting
  (`settings.restartLimit`, `Infinity` restores the old behaviour), and `TaskInspection`'s blocked reasons gain
  `restart_limit`.
- **Surprising:** The changelog records that a *prompt-cache baseline* bug and the removal of a second compaction
  call site were both found by *counting call sites* rather than by a failing test — the same class of bug August
  hit with `_compactionCall`.

### packages/durable/docs/spec.md
- **Purpose:** The **normative specification** of the package: 5618 lines in 13 sections (§1 core records and
  invariants, §2 documents and Chord deltas, §3 transactions, §4 tasks, §5 scheduler, §6 submissions/inbox, §7
  extensions/hooks/tools/system prompt, §8 built-in tasks, §9 document observation, §10 storage contract, §11
  backends, §12 API footguns, §13 non-goals). Every other file in the package is an implementation of it, and the
  source comments repeatedly cite its section numbers (`spec §5.5`, `spec §8.7`, `spec §6`).
- **Key abstractions:** The record kinds (conversation, entry, task, submission, document), the document
  `scope`/`history`/`fork` triple, the task state machine (`pending | running | waiting | sleeping | completing |
  terminal`), the `ToolControl` add/terminate/handoff triple, and the commit/transaction contract.
- **Data flow:** §3 defines a commit as the only unit of atomicity; §5 defines the scheduler's reservation and
  step; §8 defines the generation/tool/compaction tasks' phases and their effect sandwiches.
- **Non-obvious design decisions:** The scheduler's fault rule is spelled out as an ordered list (§`packages/durable/docs/spec.md:2006`,
  `:2010`): an uncaught error writes terminal `faulted`, and a **checkpoint unchanged** writes terminal `faulted`
  "because no durable progress" — a task that keeps re-committing the same state is a failure, not a retry. The
  wait-for graph is required to be **acyclic**, and only a wait adds an edge (so checking each wait maintains the
  invariant). `ToolControl.terminate` is still typed `terminate?: true` at `packages/durable/docs/spec.md:3035` while the 1.4.0 changelog
  says it is now `boolean` — see Uncertainties.
- **Edge cases / failure handling:** §12 ("API footguns") is the part a host must read: what a read may not do
  after a write, what a fork copies, what a storage error does to the whole harness.
- **Surprising:** The spec is the *only* place that states the invariants the code relies on (e.g. "the transcript
  is append-only, entries are immutable, a fork's entries are a prefix segment of the parent's"), and the code
  depends on them without re-stating them.

### packages/durable/package.json
- **Purpose:** The package manifest of `@earendil-works/pi-durable` 1.4.0.
- **Key abstractions:** A 19-condition `exports` map that splits the public surface into `env`, `codemode`, `tools`,
  `images`, `storage` and `testing` entry points, so a host that only wants the harness never loads TypeBox, the
  image WASM or the storage backends.
- **Data flow:** n/a.
- **Non-obvious design decisions:** The package root deliberately loads TypeBox (the tool task validates arguments
  with pi-ai's `validateToolArguments()`), which the README quantifies at "about 23 MB of peak RSS unbundled, about
  4 MB in a tree-shaken bundle" (`packages/durable/README.md:817`) — the split exports exist to keep that cost off hosts that do not
  install tools.
- **Edge cases / failure handling:** n/a.
- **Surprising:** The `test` script is a **two-pass** run (a source pass and a built pass), and there are ten
  standalone `bench:*` scripts — the package treats benchmarks as first-class entry points.

### packages/durable/README.md
- **Purpose:** The host-facing API tour: ten core concepts, the entry/task diagram of one answered input, and one
  section per feature (persist/resume, tools, code mode, system prompt, compaction, steering/inbox, subagents, task
  graph, storage, the three error rules).
- **Key abstractions:** `Harness`, `Conversation`, `Submission`, `Registry`, `Extension`, `Task`, `Document`,
  `Context`, `Settings`.
- **Data flow:** `submit()` → a durable `Submission` → a generation task → an assistant entry → the inputs settle
  `done`/`unanswered` (`:74-78`).
- **Non-obvious design decisions:** "Run policy shared by every conversation is passed as `settings`. It is read at
  every use and never stored, so getters make it live" (`:405`) — a live settings getter is the whole config story,
  no persisted config file. The three error rules at `:819-825` are the contract a host must internalise: a storage
  error ends the Harness, an invalid read fails only that call, and "your code fails only its own unit" (a throwing
  task phase faults that task; a throwing hook is reported and skipped; a throwing commit callback rolls back that
  commit) — with exactly one exception, a registry whose `snapshot()` throws, because the Harness cannot schedule
  without it.
- **Edge cases / failure handling:** `:823` — after a storage error, "resubmitting with the same `requestId` finds a
  submission that was already admitted", which is the idempotency door an August-style retry needs.
- **Surprising:** Steering and follow-up are **not** a separate API: a busy conversation queues the submission in
  its `pi.inbox` document, and `steeringMode: "all"` / `followUpMode: "all"` place every queued item at once instead
  of one per turn (`:506-521`).

### packages/durable/src/codemode/codemode.ts
- **Purpose:** The `codemode` tool for the durable harness. The model writes raw JavaScript; the tool runs it in a
  QuickJS sandbox where `await tools.<name>(args)` invokes the conversation's callable tools as **nested tool
  calls**. The defining property is that the script *survives a restart*: after a crash, `execute()` runs again,
  restarts the script from stored start data, and re-feeds it the results it got before, in order, from a journal
  written **before** each delivery.
- **Key abstractions:** Three documents with different lifetimes. `pi.codemode.run` (`scope: "task"`,
  `checkpointWhen: () => false`) holds the `Start` record (module version, `startedAt`, random `seed`, VM
  `fingerprint`, deadline, the tool declarations the script sees, namespaces, globals, `maxOutputTokens`, a snapshot
  of the conversation's `store()` values) plus the decided `result`. `pi.codemode.journal` (also task-scoped) holds
  one entry per delivered result: the VM call `id`, the clock value `at`, `issuedAfter` (how many calls the VM had
  issued after processing it) and, for a *global* call, its name, args and outcome. `pi.codemode.store` is
  **conversation-scoped, `history: "rewindable"`, `fork: "asOf"`**, so a fork sees the values as they were at its
  entry. Above them sits `CodemodeCall`, a state machine with a `gate` promise (nothing is delivered or admitted
  before the VM's fingerprint is checked), a `replaying` flag, a `durableIssued` counter, a `held`/`waiting` queue of
  calls, and a `ready` map of replayed outcomes.
- **Data flow:** `execute()` → `parseCodemodeSource` → `api.agent(context)` to snapshot the callable tools → one
  `api.commit` that reads the run document → the VM starts with the stored start data → each result the VM awaits
  is journalled *before* it is delivered → the VM's next call is admitted only once the issued-count barrier
  (`issuedAfter`) is committed.
- **Non-obvious design decisions:** The issued-count barrier exists to make "a call is launched only once the count
  of calls issued in the drain that made it is committed" true (`:28-30`): every key an earlier attempt admitted is
  at most its last recorded count, so a replay that releases its calls has made every call an earlier attempt could
  have admitted. The tool is declared `replay: "safe"` (`:245`) and `callers: ["model"]` only, and it carries a
  **constrained-sampling grammar** for capable models (`:243`) because "capable models write the script as raw text
  instead of a JSON-escaped string". `CODEMODE_MODULE_VERSION = 2` (`:86`) is a replay guard: a rerun refuses when
  the module version or the VM's fingerprint changed.
- **Edge cases / failure handling:** A rerun refuses to replay (no new nested calls; the earlier ones may still
  resume and are aborted by the call's cleanup) when the version/fingerprint changed, the deadline passed, or **the
  script diverged** — it made another call, or called in another order, than the journal says (`:32-35`). The
  divergence check compares the replayed part's end against where the live run went on, and reports the exact
  result index (`:492-507`).
- **Surprising:** The *internal* tools (`pi.codemode.*`) are filtered out of the script's `tools` object, out of
  `ALL_TOOLS` and out of tool search (`:378-380`) — a script reaches `models.classify()` only through a global, so
  the paid effect is a real durable task rather than an in-sandbox call.

### packages/durable/src/codemode/describe.ts
- **Purpose:** Builds the code-mode prompt surface: the tool's **fixed** description (the script environment and its
  globals) and the `codemode` **system section** that lists the callable tools as TypeScript declarations, grouped by
  namespace and fitted to a token budget.
- **Key abstractions:** `CodemodeNamespace` (a name, a description, an instructions block and a `prefix`; "the
  longest matching prefix wins"), `declarationOf()` (a `ToolRegistration` → the four fields a script sees), and
  `selectCatalog()` (the budget fitting).
- **Data flow:** `codemodeDescription(models)` is constant per conversation; the `codemode` section is rendered per
  turn from `agent.callable` and changes with it.
- **Non-obvious design decisions:** The two halves have deliberately different lifetimes — "the tool's description
  never does" (`:5-6`). The budget is `DEFAULT_CODEMODE_INLINE_BUDGET = 3000` tokens estimated at 4 chars/token
  (`:23-25`), and `selectCatalog()` fits "every namespace represented before any namespace completes", so a model
  always sees at least one tool per server rather than a full server and nothing else.
- **Edge cases / failure handling:** A namespace whose tools did not fit is rendered with an explicit
  `" (tools not listed)"` / `" (some tools not listed)"` marker, and a namespace with none visible is still listed
  with `" (tools not listed)"` — the model is told what is missing rather than shown a silently shortened list.
- **Surprising:** Tools that do not fit are found with `searchTools()` (a BM25 over the same catalogue), so the
  section and the search tool are two views of one index rather than two sources of truth.

### packages/durable/src/codemode/index.ts
- Boilerplate barrel: re-exports the code-mode extension/tool factory, the `CodemodeNamespace` type and
  `DEFAULT_CODEMODE_INLINE_BUDGET` from `./codemode.ts` and `./describe.ts`; no logic of its own.

### packages/durable/src/codemode/models.ts
- **Purpose:** The `models.*` globals for code-mode scripts: catalog lookups, plus `models.classify()` and
  `models.generateImages()`.
- **Key abstractions:** `CODEMODE_INTERNAL_PREFIX = "pi.codemode."` with two reserved tool names
  (`CLASSIFY_TOOL`, `GENERATE_IMAGES_TOOL`), `MODEL_CALLS` (global name → internal tool), `CATALOG_GLOBALS` (the
  three read-only catalog functions) and `MAX_CONCURRENT_MODEL_CALLS = 4`.
- **Data flow:** A script calls `models.classify(...)`; the code-mode tool turns that into a call of the internal
  tool, which runs as a nested durable call with its own task, live row, abort and usage accounting.
- **Non-obvious design decisions:** The two paid effects are *tools* (`callers: ["tools"]`, reserved names, hidden
  from scripts' listings) rather than sandbox functions, precisely so that "paid effects get their own durable task,
  live row, abort and usage accounting" (`:5-8`). Model resolution is by **provider+id only**, so a script can never
  inject a `baseUrl` or headers.
- **Edge cases / failure handling:** At most 4 classify/generateImages calls run at once; more wait (`:43`). The
  globals are journaled like any global, so a restart replays their outcomes.
- **Surprising:** The catalog functions are host globals (journaled), while the two *paid* functions are durable
  tasks — the split is by cost, not by kind.

### packages/durable/src/codemode/output.ts
- **Purpose:** Formats a code-mode script's result for the model: a "Script completed/failed" header with the wall
  time, the script's text items, its `console` lines, the returned value, and on failure the error with the calls
  already made.
- **Key abstractions:** `OutputFile` (the host's file writer), `Limits` (`maxBytes`/`maxLines`, the Harness's
  enforced cut), and `formatItems()` / `joinAdjacentText()` / `truncate()` / `saveImages()`.
- **Data flow:** `CodemodeOutputItem[]` → `formatItems` (items + one `<console_output>` block) → `joinAdjacentText`
  → `saveImages` (images written to temp files, their paths beside them) → `truncate` (head+tail, the complete text
  spilled to `output.txt`) → the final header + content.
- **Non-obvious design decisions:** With more than one text item each starts with a `==> text N/M <==` line, so the
  model can tell the items apart (`:54`). `joinAdjacentText` joins adjacent text items, and the separator check
  looks at "the last non-empty part, not the joined text: reading the end of a growing concatenation makes V8 copy
  it on every item, which is quadratic" (`:64-66`).
- **Edge cases / failure handling:** Text past the token budget is cut to its **start and end**, with the complete
  text spilled to a file — an image's path stays next to it even after truncation, because truncation "joins the
  text items and moves images after them, so each path stays next to its image" (`:199-200`).
- **Surprising:** The output file writer is injected, not global: the same formatter is used with a real filesystem
  (Node) and with a host-provided sink.

### packages/durable/src/documents.ts
- **Purpose:** The durable document model: `defineDoc` / `defineDocFamily` with typed scope (session /
  conversation / task), history (`latest` / `rewindable`) and fork semantics (`current` / `initial` / `asOf`); plus
  the resolution of a document's logical address to a stable string id and the materialisation of a stored value
  through the definition's `migrate()`.
- **Key abstractions:** `DocToken` / `DocFamilyToken` (a typed handle), `AnyDocDefinition` (the erased shape the
  Session works with), `DocumentSemantics` (the scope/history/fork union) and `CheckpointInfo`.
- **Data flow:** `defineDoc(definition)` validates and returns `{ definition }`; the Session's transaction resolves
  the address, loads the incarnation, and `materializeDocumentValue()` runs `migrate()` when the stored version is
  older than the definition's.
- **Non-obvious design decisions:** `checkpointWhen` is **required** on every definition, with no default (`:89`) —
  the storage policy is part of the definition, not a framework default. `history` and `fork` are only meaningful
  for conversation-scoped documents: a session or task document is always current-only (the type union enforces it).
- **Edge cases / failure handling:** A stored value whose version has no `migrate()` throws
  `"Document … requires migration from version …"` (`:188`) rather than silently mis-reading it. `checkRecordScope`
  and `checkRecordVersion` reject an incarnation that does not belong to the address or the version.
- **Surprising:** A document is an *incarnation*, not a value: retiring one and creating another at the same
  address produces a new ID, and the old one is still addressable for as-of reads. That is what makes fork-as-of
  possible at all.

### packages/durable/src/entries.ts
- **Purpose:** Declares the six transcript entry kinds (`pi.user`, `pi.assistant`, `pi.system`, `pi.tool-result`,
  `pi.reset`, `pi.compaction`) with `is()` type guards.
- **Key abstractions:** `defineEntry(kind)` returns `{ kind, is }`; the guards narrow `EntryRecord` to `TypedEntry<D>`.
- **Data flow:** Writers are named in each docstring: submissions write `pi.user`, generation writes
  `pi.assistant` and `pi.system`, tool tasks write `pi.tool-result`, `Conversation.reset()` and the `handoff` tool
  control write `pi.reset`, compaction tasks write `pi.compaction`.
- **Non-obvious design decisions:** The kinds are namespaced with the `pi.` prefix, and the `InputEntry` kind a host
  submits "must not start with `pi.`" (`packages/durable/README.md:537`) — the reserved namespace is not negotiable.
- **Edge cases / failure handling:** `defineEntry` throws on an empty kind.
- **Surprising:** `pi.tool-result`'s `model` field "ends with the rendered diagnostics block" while `data` holds the
  structured diagnostics — the transcript and the machine-readable view are the same entry, not two.

### packages/durable/src/env/decode.ts
- **Purpose:** Byte-exact UTF-8 decoding helpers: `rangeDecoder()`, `startsWithBom()` and `StreamDecoder`.
- **Key abstractions:** A `TextDecoder` with `ignoreBOM: true`, plus a class that holds back an incomplete character
  across chunk boundaries.
- **Data flow:** `StreamDecoder.decode(bytes?)` → the streaming decoder → a leading-U+FEFF strip on the first call.
- **Non-obvious design decisions:** Node's streaming decoder **with** BOM handling "can drop a U+FEFF that follows a
  chunk boundary, not only a leading byte-order mark", so these decoders turn BOM handling off and drop a leading
  mark themselves (`:2-4`). The reasoning is stated in the code: "U+FEFF encodes only as EF BB BF, so a leading
  U+FEFF is exactly a byte-order mark at the stream's start" (`:27`).
- **Edge cases / failure handling:** A file that starts with a BOM decodes identically whether it is read in one
  piece or in chunks — which is the property the line scanner and the read tool both depend on.
- **Surprising:** This is a 30-line file that exists solely because a "streaming vs whole-input" difference was a
  real bug.

### packages/durable/src/env/index.ts
- **Purpose:** The `ExecutionEnv` contract: the environment abstraction the harness and the tools use for files,
  directories, watches and shells, with a `Result<T, E>` error convention instead of exceptions.
- **Key abstractions:** `Result`/`ok`/`err`/`getOrThrow`/`getOrUndefined`, `FileError` (with a `code` union:
  `aborted | not_found | permission_denied | not_directory | is_directory | invalid | not_supported | unknown`),
  `ExecutionError` (`aborted | timeout | shell_unavailable | spawn_error | callback_error | unknown`, with a
  `spillPath`), `FileSystem`, `BinaryReader`, `TextLineReader`, `DirReader`, `FileWatcher`, `Shell` and
  `ExecutionEnv = FileSystem & Shell`.
- **Data flow:** Every environment call takes a Chord `Context` and returns a `Result`; `getOrThrow` is the opt-in
  at the call site.
- **Non-obvious design decisions:** Expected failures are **returned**, not thrown (`:3`), so a missing file is not
  an exception but a value the caller must handle. `Shell.exec` takes `string | readonly string[]`: an array runs
  `command[0]` directly "without a shell, so they reach the program unparsed" (`:361-363`).
- **Edge cases / failure handling:** `ExecutionError.spillPath` is the file a command that timed out or was aborted
  wrote its output to — the error carries the evidence.
- **Surprising:** `BinaryReader` is opened on a *file*, not a path: "all calls see the same file even if its path is
  renamed", and `info()` reports "the opened file, not of whatever its path names now" (`:95-99`).

### packages/durable/src/env/line-scan.ts
- **Purpose:** Computes a `LineScan` (the byte and line boundaries of a line range) from a file's bytes fed **in
  order**, so an environment can scan any file size in bounded memory.
- **Key abstractions:** The `LineScanner` class: `push(chunk)` / `finish()`, with two streaming decoders (one for
  the selected range, one for the first line) and a three-byte head buffer held until it is known whether the file
  starts with a BOM.
- **Data flow:** `push` → head/BOM resolution → `#process` walks the chunk for newline bytes, feeding the open
  decoders and recording the selection start/end and the first-line end → `finish()` closes the open ranges.
- **Non-obvious design decisions:** The decoded sizes are "those of the text `new TextDecoder().decode(file)` would
  produce for that range, so a byte-order mark at the start of the file is not counted" — the scanner reimplements
  WHATWG decoding rather than approximating it.
- **Edge cases / failure handling:** The constructor rejects a non-integer or inverted range with `RangeError`
  (`:36-41`); a file whose last line has no newline still yields a `lastLineStart` (`:107`).
- **Surprising:** The newline byte between two selected lines is excluded from the selection ("It belongs to the
  selection between selected lines only", `:68`) — an off-by-one that the read tool's line accounting depends on.

### packages/durable/src/env/node-watch.ts
- **Purpose:** The Node file watcher: native `fs.watch` or polling, with a debounce, a directory budget and a
  snapshot-diff fallback.
- **Key abstractions:** `NodeWatchOptions` (`mode`, `pollIntervalMs`, `maxDirectories`), `Entry` (a snapshot entry:
  kind, dev, ino, size, mtimeMs, optional content hash), `Snapshot` and `Installed` (a watcher plus the identity of
  what it was installed on).
- **Data flow:** `open()` installs watchers → a scan builds the first snapshot → native events only *trigger* a
  debounced rescan → the rescan diffs the new snapshot against the old one and reports the difference.
- **Non-obvious design decisions:** "Watches by snapshots: native events only trigger a debounced rescan, and
  changes are the difference between snapshots plus the event paths" (`:134-135`) — the event stream is a *hint*,
  the snapshot is the truth. On macOS, `fs.watch` returns before libuv's FSEvents stream is live and "about 2% of
  changes made right after the call" are never reported, so a rescan 500 ms later catches them (`:48-52`).
- **Edge cases / failure handling:** A file replaced by another file needs a **new** watcher, so the installed
  watcher is keyed by `(dev, ino)`. Polling mode additionally hashes recently-modified small files (<256 KiB, last
  5 s) because "a second write within the file system's timestamp granularity can keep size and modification time"
  (`:55-58`). Linux file systems that accept watches but do not report remote changes (NFS, SMB, CIFS, FUSE, 9P,
  Lustre, GPFS, Ceph, OpenAFS, kAFS, sdcardfs) are detected via `statfs` and force polling (`:61-74`).
- **Surprising:** By default **polling** is chosen on Windows, "where native watchers keep directories open and so
  block renaming their parents" (`:12-13`) — a Windows-specific failure mode that is invisible on Linux.

### packages/durable/src/env/node.ts
- **Purpose:** The Node implementation of `ExecutionEnv`: files, directories, watches and shell execution.
- **Key abstractions:** `NodeExecutionEnv` (with `cwd`, `shellPath`, `shellEnv`, watch options and a live child-PID
  set), `BinaryReader` / `TextLineReader` / `DirReader` implementations, and the spill machinery for a command
  whose output exceeds the thresholds.
- **Data flow:** `exec(command, options, context)` → resolve the program (a string goes through the shell, an argv
  array runs directly) → `spawn` → stdout/stderr chunks are streamed to `onOutput` within a retained window and, past
  the spill thresholds, appended to a spill file → on exit, `{ exitCode, spillPath? }`.
- **Non-obvious design decisions:** A string command and an argv array are **different execution models**, and the
  array form deliberately skips shell parsing (`:673`). The output spill is a file the error result names
  (`:792-798`), so a command that produced 10 MB of output leaves the evidence on disk.
- **Edge cases / failure handling:** The timeout is bounded by `MAX_TIMEOUT_MS` and an invalid timeout is a typed
  `ExecutionError`, not a crash (`:59-70`). A symlink is refused where `noFollow` is requested, using
  `O_NOFOLLOW` — and on Windows, where there is no `O_NOFOLLOW`, the final component is checked before opening,
  honestly labelled "not race-free" (`:981-986`). Aborting the context kills the **process tree**, not just the
  child. `cleanup()` kills everything still running.
- **Surprising:** A `file://` URL in a path is converted with `fileURLToPath`, and a malformed one is left as an
  ordinary path "so filesystem methods preserve their non-throwing contract" (`:80-83`).

### packages/durable/src/errors.ts
- **Purpose:** The package's four error classes and one safe error formatter.
- **Key abstractions:** `errorMessage(error)` (never throws — `String()` throws for `Object.create(null)`),
  `ReadAfterWrite`, `StorageRequestError`, `SessionFailed`, `ConversationBusy`.
- **Data flow:** `StorageRequestError` is thrown by storage reads; `SessionFailed` wraps the first fatal storage
  error as its `cause`; `ConversationBusy` is thrown when a `whenBusy: "reject"` submission reaches a busy
  conversation.
- **Non-obvious design decisions:** `StorageRequestError` is the **only** storage error that does not fail the
  Session: "Unlike any other error a Storage throws, it fails only that read, not the Session; from `commit()` it is
  fatal like any other" (`:25-28`). `SessionFailed`'s message tells the host what to do — "close and reopen it" —
  and the docstring says why reopening is safe: "reopening recovers from what was committed" (`:38-40`).
- **Edge cases / failure handling:** A code path that formats an error must not fail for the value it formats
  (`:4-5`).
- **Surprising:** The distinction between "a bad read" and "a broken backend" is a **type**, and every storage
  backend has to import it to be correct.

### packages/durable/src/harness/agent.ts
- **Purpose:** The `pi.agent` document (the conversation's agent choices) and the resolution of harness settings.
- **Key abstractions:** `AgentDoc` (conversation-scoped, `history: "rewindable"`, `fork: "asOf"` — "so forks start
  from the agent at their fork entry"), `AgentState` / `AgentChange`, `resolveSettings()`, and the built-in policy
  constants `DEFAULT_RETRY_POLICY` (3 retries, 2 s base delay, 60 s cap), `DEFAULT_COMPACTION_POLICY`
  (16 384 reserve / 20 000 keep-recent / 32 768 background tokens), `DEFAULT_PROGRESS_POLICY` (100 ms partial and
  output intervals) and `DEFAULT_RESTART_LIMIT = 5`.
- **Data flow:** `configure(tx, conversationId, change)` applies one change to `pi.agent` in a commit; the harness
  reads the agent at each resolution to compute the callable tools, the prompt sections and the environment.
- **Non-obvious design decisions:** `resolveSettings` merges **field by field** so "an explicitly undefined
  interval keeps its default" (`:72-76`) — a spread would let an explicit `undefined` erase a default. The
  `instructions` section key is reserved (`INSTRUCTIONS_KEY`) and an extension that claims it is refused.
- **Edge cases / failure handling:** `restartLimit` is normalised: a number ≥ 1 floored, anything else the default
  (`:60-62`), so `Infinity` (never park) survives but a nonsense value cannot disable the guard.
- **Surprising:** The agent is *rewindable* even though it is a single current value — that is what lets a fork
  inherit the agent its parent had **at the fork entry** rather than the parent's current one.

### packages/durable/src/harness/compaction.ts
- **Purpose:** The `CompactionTask`: the durable summarizer that shrinks what the model sees.
- **Key abstractions:** `CompactionInput` (`reason` + optional `instructions`), `SummaryRequest` (attempt, model,
  thinking level, stream options, max tokens, `tail`, `firstKept`), and the checkpoint union
  `{ phase: "select" } | { phase: "summarize", … } | { phase: "retry", until, … }`.
- **Data flow:** `select` → choose the cut (`selectCut`) → `summarize` → build the pinned summarization request
  (a fixed system prompt + a fixed section format) → stream the summary → write a `pi.compaction` entry holding the
  summary and heading the first kept entry → `complete`/`fail`.
- **Non-obvious design decisions:** The summarization prompt is a **fixed contract**, not a free-form request
  (`:70-104`): "Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output
  the structured summary." and a mandated section layout (Goal / Constraints & Preferences / Progress / Key
  Decisions / Next Steps / Critical Context). The summarizer's budget is derived from the policy
  (`Math.floor(0.8 * policy.reserveTokens)`, `:149`), not from the model's window.
- **Edge cases / failure handling:** A failed summarization retries on a durable backoff (`phase: "retry"`, with
  `until`), and the failure is published in `pi.live` as a `CompactionFailure` so the UI can show it. A compaction
  that finds nothing to compact completes **without** a summary rather than failing.
- **Surprising:** The summarization is itself a durable task with its own usage accounting, so summarization spend
  is in `pi.usage` and is visible next to the model's spend — an August-style usage page would need the same split.

### packages/durable/src/harness/context.ts
- **Purpose:** Reads the *context* — the ordered set of entries the model sees — and derives the `ContextView`
  (messages, entries, contributions, head marker).
- **Key abstractions:** `ContextBounds` (the head marker and the newest visible entry), `ContextRange` (the entries
  scanned, the view, the edited targets, the settled and open message halves, the baseline system message), and
  `orderToolResults()`.
- **Data flow:** `captureContextBounds()` does two O(1) reads (the newest entry and the head marker) →
  `readContextFrom()` scans the entries in the range and derives the view → `leadWithSystem()` puts the baseline
  system message first.
- **Non-obvious design decisions:** Two O(1) reads, not a scan: "entries at or below the tail never change, so a
  later read with the same head marker extends both" (`:46-47`). A tool result with no matching call is
  **synthesised** as an error result ("Tool result unavailable: history ends before this call completed.", `:11`)
  rather than dropped — a dropped result would leave a dangling `tool_use` and brick the provider request.
- **Edge cases / failure handling:** `orderToolResults()` reorders tool results to match the order of the calls in
  the assistant message that produced them, because a provider validates the pairing.
- **Surprising:** `leadWithSystem` moves **only the first** system message to the front, "so replaying [the rest]
  does not change the request's tool list and invalidates the whole prompt cache" (`:208`) — the prompt-cache
  strategy is a first-class design constraint, expressed as a comment on a three-line function.

### packages/durable/src/harness/define.ts
- **Purpose:** The four authoring helpers for extensions: `defineExtension`, `defineTool`, `section`, `hook`, plus
  `wrapTool` and `wrapSection`.
- **Key abstractions:** `PromptSection` (a `key` + a `render` + an optional `tag`), `HookRegistration` (a task name
  plus handlers), `Wrap` (a target name plus a wrapper).
- **Data flow:** n/a — these are identity functions that exist to type their argument.
- **Non-obvious design decisions:** A section is *tagged* by default (its text is wrapped as `<key>…</key>`) and
  `tag: false` opts out — the default is the safe one.
- **Edge cases / failure handling:** n/a.
- **Surprising:** `hook(task, handlers)` keys hooks by **task name**, not by task object, so a hook survives a
  re-registration of the same task kind.

### packages/durable/src/harness/events.ts
- **Purpose:** The agent event stream: the `SnapshotEvent` (a full state snapshot) plus the incremental
  `AgentEvent`s (`run_start`/`run_end`, `turn_start`/`turn_end`, `message_start`/`message_update`/`message_end`,
  `tool_execution_start`/`update`/`end`, `compaction_*`).
- **Key abstractions:** `MessageChange` (the delta kinds of an in-flight assistant message), `AgentEvent` (the
  discriminated union) and `watchEvents()`.
- **Data flow:** The harness's `pi.live` document is watched; each commit publication advances the mount, and the
  mount emits a snapshot first and then deltas derived from the committed ops.
- **Non-obvious design decisions:** The event stream is **shaped like the coding agent's session events** so an
  existing TUI can consume it unchanged — including the rule that "a tool's end directly precedes its result's
  message" (`:348`).
- **Edge cases / failure handling:** A tool call that faulted or was orphaned has **no** result entry and no result
  message; the event carries neither, and the consumer must tolerate that.
- **Surprising:** The `tool_execution_update` output is a *windowed* delta — `{ trimStart, append }` or `{ set }` —
  so a consumer that missed a frame can still reconstruct the retained window by applying the trim and the
  append (`:73-77`).

### packages/durable/src/harness/generation.ts
- **Purpose:** The `GenerationTask`: the durable state machine that talks to the model, commits the assistant
  entry, runs the tool round and hands control on.
- **Key abstractions:** `GenerationCheckpoint` — the union `{ phase: "prepare" } | { phase: "request" } | {
  phase: "retry" } | { phase: "poll" } | { phase: "tools" }` — plus `GenerationResult` and the helper
  `convertPartial()`.
- **Data flow:** `prepare` (render sections, plan the system entries, compact if needed) → `request` (stream the
  model) → `classify` (toolUse → `startToolRound`; stop/length → `answer`; error → retry or compact) → `tools`
  (wait for the round's tool tasks) → back to `request`.
- **Non-obvious design decisions:** "An overflow is never retried: only a compaction can make the next request
  fit" (`:560`) — the overflow branch checks the compaction policy and starts a compaction instead of a retry, and
  a context overflow is a *different* failure class from a bad request. The retry and compaction policies are read
  at the moment of failure rather than pinned at preparation, "so they are read now rather than pinned at
  preparation" (`:540-541`) — a host can change the policy mid-turn. A deferred (provider-side) response becomes a
  `sleeping` phase with a `pollAt` that is strictly later than the last one (`:515`), so a poll cannot spin.
- **Edge cases / failure handling:** The retry path reads the failure record **before** the commit's first table
  write (`:569`), because the transaction forbids a read after a write. A tool round is owned by the generation
  (`phase: "tools"` records the tool tasks created so far and the calls not started yet), so a crash resumes the
  round rather than restarting it.
- **Surprising:** The `request` phase stores the *stream options* it used, so a resend after a recovery uses them
  unchanged — a recovered request is byte-identical to the one that was lost.

### packages/durable/src/harness/harness.ts
- **Purpose:** The `Harness` — the host-facing object: opens a `Session` over a `Storage`, owns the registry, the
  settings, the scheduler, the submissions and the conversation views.
- **Key abstractions:** `HarnessImpl`, `ConversationImpl` (a handle over a `ConversationRecord`), `ConversationHost`
  (the private services a handle uses) and `CreateTarget` (`root` / `independent` / `fork`).
- **Data flow:** `Harness.open(storage, options, context)` → check the registry has the built-in tasks → construct
  the harness → `openTasks()` (resume the tasks that were live when the process died) → the scheduler takes over.
- **Non-obvious design decisions:** `Harness.open` **refuses** a registry that lacks the built-in tasks with
  "Registry lacks built-in tasks …; create it with createRegistry()" (`:546-551`) rather than failing later with a
  missing-task error. If `openTasks()` throws, the harness is closed *without the caller's context* — "The caller's
  context may be what failed open" (`:556`).
- **Edge cases / failure handling:** `safeNow()` (`:478`) wraps the host's clock so a throwing clock is reported
  rather than escaping into a commit listener.
- **Surprising:** `SCHEDULER_INDEX_SIZES` is a `Symbol.for("pi-durable.schedulerIndexSizes")` exported "for tests"
  (`:103`) — the scheduler's internal index sizes are reachable from outside without being part of the API.

### packages/durable/src/harness/inbox.ts
- **Purpose:** The `pi.inbox`: the durable queue of submissions waiting for a boundary, and the boundary logic that
  places them.
- **Key abstractions:** `InboxItem` (`steer` | `followUp` | `write`), `InboxState` (`{ items }`), `Boundary` (what a
  boundary reads: the inbox draft, the two queue modes, the current head) and `BoundaryResult`.
- **Data flow:** `prepareBoundary(tx, conversationId, modes)` reads the inbox and the head marker (a read, so it
  must precede the commit's first write) → `applyBoundary(tx, boundary, at, now)` selects and places the items →
  the inbox is updated positionally.
- **Non-obvious design decisions:** The queue mode is read at the boundary, not at submission time, so "one at a
  time" vs "all" is a live setting. Writes are placed **first** and user items after them, each in ID order, "so
  user items queued before a reset run in the new context" (`:66-67`). A selected reset turns a `postTools`
  boundary into a `final` one.
- **Edge cases / failure handling:** A write whose head targets an entry before the active range — including a
  range started earlier in the same commit — is **stale** and is dropped. `withdrawQueuedInputs` settles every
  queued input `unanswered` with a reason but leaves queued *writes* for later placement.
- **Surprising:** `isDisplayOnly(entry)` (`:135`) marks an entry that a boundary places without starting a run —
  a display-only entry is written to the transcript but does not wake the model.

### packages/durable/src/harness/json.ts
- **Purpose:** `assignJson(target, key, value)` — assigns a value into a JSON container **leaf by leaf** so a
  streaming update publishes a delta rather than a whole-object set.
- **Key abstractions:** One function, plus `isRecord`.
- **Data flow:** A streamed partial message is assigned through `assignJson` into the draft, and the Chord tracker
  turns the change into ops.
- **Non-obvious design decisions:** "Chord records a container assignment as one full set and only emits an append
  when a string leaf is reassigned with a longer string, so writing the partial whole would store and publish the
  complete message on every flush" (`:6-8`).
- **Edge cases / failure handling:** Keys present in the current value but absent in the new one are deleted
  (`:14`); arrays grow by push, and are only merged in place when the new array is at least as long.
- **Surprising:** One 31-line file exists purely to avoid a quadratic publish path during streaming — the
  difference between "the model sees its own text" and "every flush re-sends the whole message".

### packages/durable/src/harness/live.ts
- **Purpose:** The `pi.live` document: the live presentation state of a conversation (the current run, the current
  generation attempt, the tool slots, the nested-call slots, the compaction statuses).
- **Key abstractions:** `ToolSlot` and `NestedToolSlot` (both extend `SlotProgress`: status, retained output,
  dropped bytes/lines, details, diagnostics), `NestedToolSummary` (error flag, duration, usage, ≤500 chars of
  error text), `CompactionStatus` and `CompactionFailure`, and `LiveState`.
- **Data flow:** The generation and the tool tasks write their progress into `pi.live`; the events module watches
  it; `settleSchedulerOutcome()` converts a task outcome into the matching slot state (finish the slot, remove
  nested slots, fail the compaction status, end the run).
- **Non-obvious design decisions:** `pi.live` is a **conversation-scoped, rewindable** document whose
  `checkpointWhen` is a predicate over the value (`:123`) — the live view is the one document whose storage policy
  is decided by its content.
- **Edge cases / failure handling:** A tool slot whose task faulted or was orphaned has no result entry, and the
  slot is finished anyway so the UI does not hang on a spinner. A failed run settles the run's inputs
  `unanswered` with the reason (`faulted` or the outcome's reason).
- **Surprising:** The live state is durable, so a UI that reconnects after a crash renders the *same* live view
  instead of a blank spinner.

### packages/durable/src/harness/prompt.ts
- **Purpose:** The system-prompt planner: renders the agent's sections, replays the sections already in the
  transcript, and plans the `pi.system` entries that make the replayed state equal the desired state.
- **Key abstractions:** `replaySections(messages)` (replay the section map in order), `renderSections()`,
  `planSystemEntries(view, desired, tools, timestamp)` and `planTools()` / `planSections()`.
- **Data flow:** The desired sections are rendered per turn → `planSystemEntries` compares them with the replayed
  ones → it returns zero, one or more `pi.system` drafts → the generation commits them.
- **Non-obvious design decisions:** Three cases, in order: (a) a head marker with no later `pi.system` entry means
  one **complete baseline** that omits every retained earlier `pi.system` entry, "written even when it restates the
  replayed values" (`:57-60`); (b) otherwise, when a minimal patch would leave a different order, remove every
  shown section and re-add every desired one in order; (c) otherwise the minimal patch of changed values and `null`
  removals, or nothing (`:61-62`). Tool changes ride on the last planned entry, or on one entry of their own.
- **Edge cases / failure handling:** A section whose `render` throws keeps its previously shown text and is
  reported — a broken extension does not delete the section from the prompt — but an error *after* the context is
  aborted propagates (`:33-43`).
- **Surprising:** `planTools` compares declarations with `declarationsEqual()`, and a **changed** declaration is
  removed and re-added rather than patched, because the provider's tool list is positional.

### packages/durable/src/harness/provider.ts
- **Purpose:** The `pi.provider` document: a stable provider-facing identity for a conversation.
- **Key abstractions:** `ProviderState` (`{ sessionId }`), `ProviderDoc` (conversation-scoped, `history: "latest"`,
  `fork: "initial"`) and `ensureProviderSessionId()`.
- **Data flow:** `ensureProviderSessionId(runtime, context)` reads the document; if it is absent (a legacy
  conversation) it makes **one migration commit** whose `tx.doc()` runs `initial()` — and `initial()` mints a
  `uuidv7()`.
- **Non-obvious design decisions:** `fork: "initial"` — "every fork starts with a fresh identity instead of
  copying its parent" (`:11`). A forked conversation must not present the parent's provider session id.
- **Edge cases / failure handling:** The read happens on the normal path without a write; the write only happens
  for a legacy conversation, so the common case costs nothing.
- **Surprising:** The provider identity is a **document**, not a runtime value, so it survives a restart and a fork
  gets a new one — the same discipline August would need for a per-conversation upstream session id.

### packages/durable/src/harness/registry.ts
- **Purpose:** The extension registry: install/uninstall extensions, publish the immutable snapshot, and validate
  what an extension may claim.
- **Key abstractions:** `Registry` (mutable) and `RegistrySnapshot` (immutable, published), `BUILTIN_TASKS`
  (`GenerationTask`, `ToolTask`, `CompactionTask` — "they are not an extension and cannot be removed or replaced",
  `:9-10`), and `validateExtension()`.
- **Data flow:** `install(extension)` → validate → build the next `RegistryState` → publish synchronously and
  notify the listeners → the scheduler re-resolves the tasks it could not find before.
- **Non-obvious design decisions:** The next state is built **before** it is published, so a task-name collision
  throws without leaving the registry half-changed (`:88-92`). A section key must match
  `/^[a-z][a-z0-9_-]*$/` and may not be the reserved `instructions` key (`:104-105`).
- **Edge cases / failure handling:** Two tools with the same name in one extension, or two sections with the same
  key, are refused at install time.
- **Surprising:** Extensions are stored **by name**, so "a stored name outlives its code: after an extension is
  uninstalled, conversations that select it just stop getting it until it is installed again" (`packages/durable/README.md:401`) — the
  registry is deliberately tolerant of a missing extension.

### packages/durable/src/harness/scheduler.ts
- **Purpose:** The task scheduler: reserves runnable tasks, runs one phase of each, adopts the committed state,
  handles abort cascades, sleeps, waits, restarts and the task graph. 2507 lines, and the heart of the package.
- **Key abstractions:** `TaskScheduler` (the class), `BlockedSubject` / `BlockedReason` (`missing_task |
  task_too_old | migration_failed | restart_limit`), `Resolution` (`ready` vs `blocked`), `Fit` (a definition that
  can take a record), `Invocation` (a running phase, its controller and its telemetry) and the wait-for graph.
- **Data flow:** A commit publication → `#observe` (update the live index, detect aborts and completions) →
  `#scheduleReconcile` → a reservation pass (which tasks may run) → an invocation (run the phase) → `#commitState`
  (validate the wait, adopt the new state) → publish → repeat. Sleeping tasks are woken by a foreground timer
  (`#armTimer`) that is deliberately *not* unreferenced: "a process with a sleeping task has work left" (`:1340`).
- **Non-obvious design decisions:** The reservation is separated from the run so that deciding a task is runnable
  "runs no task code" (`:100-101`). The scheduler's own state is derived from commit publications, never from a
  side channel. A task that commits a **state identical to its current one** is not progress, and a run that ends
  with the checkpoint unchanged is a fault: "Checkpoint unchanged: write terminal `faulted` because no durable
  progress" (`packages/durable/docs/spec.md:2010`, implemented at `packages/durable/src/harness/scheduler.ts:1828`).
- **Edge cases / failure handling:** The crash-loop guard: a task cut off `restartLimit` times **in a row** without
  committing a new state is parked, with the message "Task … was cut off N times without progress; it is parked
  until retryTask()" (`:407-409`); the predicate is `#parked` (`:1366-1367`) and it deliberately does not park a
  task whose abort was requested. The wait-for graph is kept acyclic by validating every wait (`:1973-1994`): a
  wait may not name a non-existent task, `failFast` may only wait on tasks the waiter owns, and an abort handler
  may not wait at all. A `completing` outcome is held while the task's ordinary owned work is still live, so the
  cleanup waits for the final commit (`:1927-1935`).
- **Surprising:** The scheduler **re-reads the settings on every resolution** and wraps the read in a try/catch
  that reports and falls back to 0 (`:708-715`), because a throwing settings getter must not escape into a commit
  listener.

### packages/durable/src/harness/submissions.ts
- **Purpose:** Admission, waiting and withdrawal of the durable submissions of one Harness.
- **Key abstractions:** `Submissions` (the class), `SubmissionHandle`, `Admission` (`queued | placed | done`) and
  `admitSubmission(tx, conversationId, draft, now, modes, span)`.
- **Data flow:** `submit()` → `session.commitWith(admitSubmission)` → the handle → `wait()` resolves when the
  submission settles; the settlement arrives through the commit publication.
- **Non-obvious design decisions:** The whole admission is **one commit** and one decision: a write is placed
  immediately; an input to an idle conversation is placed and starts a run; an input to a busy conversation goes to
  the inbox (queued) unless `whenBusy: "reject"`, which throws `ConversationBusy` (`:240`). The telemetry span
  records only the *status* on failure, because "Error text may contain caller content" (`:95-96`).
- **Edge cases / failure handling:** A write that is stale settles `unanswered` with reason `stale`; a queued input
  that is withdrawn settles `unanswered` with the reason. `submit()` calls `this.#resume()` first, so admitting a
  submission always wakes the scheduler.
- **Surprising:** The `requestId` makes admission **idempotent**: resubmitting with the same `requestId` finds the
  submission that was already admitted (`packages/durable/README.md:823`) — the retry door an August-style HTTP layer needs.

### packages/durable/src/harness/task-graph.ts
- **Purpose:** The live task graph: a durable, watchable view of every live task, its state, its owner and why it
  is blocked.
- **Key abstractions:** `TaskGraphState` (the status union), `TaskGraphNode` (id, kind, conversation, owner,
  background, abort flag, state, `blocked?`, owned conversations), `TaskGraph` and `TaskGraphView`.
- **Data flow:** The view is built on the Session line by its first observer and dropped with its last; it advances
  from the commit publications, which are durable.
- **Non-obvious design decisions:** The graph keeps only a `BlockedSubject` per task (id, kind, version, abort flag,
  restarts) and not the checkpoint or outcome payloads, "so a registry change can derive it again without
  payloads" (`:64-65`). A `blocked` reason "follows registry changes": installing the missing task definition can
  un-block a task that was parked as `missing_task`.
- **Edge cases / failure handling:** Terminal records never reach the graph — they leave it.
- **Surprising:** The graph is a *mount* on the Session's commit stream, so it is consistent with the transcript by
  construction rather than by a poll.

### packages/durable/src/harness/telemetry.ts
- **Purpose:** The package's telemetry vocabulary: `DURABLE_TELEMETRY_SCHEMA`, with two spans, three events and
  three metrics.
- **Key abstractions:** Spans `pi.durable.submit` and `pi.durable.phase`; events `pi.durable.entry`,
  `pi.durable.submission` and `pi.durable.report`; metrics `pi.durable.reports` (counter),
  `pi.durable.phase.duration` (histogram) and `pi.durable.tasks.active` (up-down counter).
- **Data flow:** The harness opens a typed span per submission and per phase invocation; the report event carries
  the `ReportInfo` type.
- **Non-obvious design decisions:** The schema is **content-free**: "IDs address durable records, never content"
  (`:49`). The report event records "no error payload" (`:37`) — only the fixed reason and the extension name. The
  `ReportInfo.type` enum is closed (nine values) and the `reason` enum is closed (four values), so a dashboard
  cannot drift.
- **Edge cases / failure handling:** The phase span's status rule states which outcomes keep `ok`: "Aborted
  outcomes keep status ok", while faulted/failed/orphaned use their own types with "a diagnostic capped at 500
  characters" (`:110-114`).
- **Surprising:** `pi.durable.submit` spans "Inputs start root traces linked to their callers; writes are
  children" — the tool-call → submission relationship is expressed in the trace topology, not in a log line.

### packages/durable/src/harness/tool.ts
- **Purpose:** The `ToolTask`: the durable state machine behind every tool call, model-issued or nested, and the
  output/diagnostic machinery around it.
- **Key abstractions:** `ToolTaskInput` (`{ kind: "model", assistant, callId }` | `{ kind: "nested", parent,
  parentCallId, key, call, progress? }`), `ToolTaskCheckpoint` (`{ phase: "call" }` | `{ phase: "execute",
  arguments, replay }`), `ToolTaskResult` (`{ kind: "model", entryId, control? }` | `{ kind: "nested" }`), and
  `NestedCallDoc` (the family document holding a nested call's result).
- **Data flow:** `call` (resolve the tool, check the agent's tool set) → `execute` (record the **durable intent** —
  the final arguments and the replay policy — before running) → run the tool → collect the output within the
  retained window → `afterTool` hooks → validate the structured output → commit the terminal state.
- **Non-obvious design decisions:** The tool's arguments and its replay policy are committed **before** execution
  (`:76-77`), so a crash during the effect leaves a durable record of what was about to happen. A **replay-safe**
  tool reruns after a restart; a tool that is not replay-safe never reruns (`:185`).
- **Edge cases / failure handling:** A nested call's identity is (parent, key, target, arguments): calling the same
  key with a different tool or different arguments throws "Nested call … was already made with another tool or
  other arguments" (`:754`) rather than silently starting a second call. A tool whose structured output does not
  match its schema is an error for a nested call, but for a **model-issued** call the model's call stands and the
  host is told (`final = rest` + a report) — "The model never sees structured output, so its call stands"
  (`:575-576`). Diagnostics are rendered into the result text in a `<harness>…</harness>` block (`:916`).
- **Surprising:** A tool with no `structuredOutputSchema` gets its output value as `structuredOutput` for nested
  callers only (`:587-589`) — the model never sees it, so the program does.

### packages/durable/src/harness/types.ts
- **Purpose:** The harness's type surface: `HarnessOptions`, `HarnessSettings`/`Settings`, `Registry`,
  `Extension`, `ToolRegistration`, `ToolControl`, the hook interfaces, `ContextView`, `PromptInput` and the
  `TaskRuntime`/`TaskDefinition` contracts used by extension authors.
- **Key abstractions:** `ModelRef` (`{ provider, modelId }`), `UserInput`, `InputEntry`, `SubmissionDraft`,
  `QueueMode` (`one-at-a-time | all`), `ToolExecutionMode` (`parallel | sequential`), `AfterFailedRun`
  (`keep | continue | withdraw`), `Extension` (tools + sections + tasks + hooks) and the hook interfaces
  (`GenerationHooks`, `ToolHooks`, `CompactionHooks`).
- **Data flow:** n/a — these are the types the rest of the package implements.
- **Non-obvious design decisions:** `HarnessSettings` is read "at every resolution and never copied; getters are
  fine. Synchronous: some readers run on the Session line" (`:544-545`) — a settings getter may not be async,
  because the Session's mutation line calls it. `ToolRegistration.callers` decides "Who may call the tool: the
  model, other tools through `executeTool()`, or both" (`:320`).
- **Edge cases / failure handling:** The `executeTool` contract (`:262-288`) is the most detailed in the file and
  states the exactly-once caveat: "A nested call a crash interrupted before its result [arrived] … throws" on
  mismatch, "A tool that is not replay-safe never reruns".
- **Surprising:** `ToolControl` is a *result* value, not an argument: a tool returns `{ addTools, terminate,
  handoff }` and the harness applies them (this is how `tool_search` loads a tool and how a subagent hands off).

### packages/durable/src/harness/usage.ts
- **Purpose:** The `pi.usage` document: the conversation's own spend ledger, split into model spend and tool spend.
- **Key abstractions:** `UsageState` (`{ models, tools }`, each a map of key → usage), `UsageDoc`,
  `recordUsage(tx, conversationId, bucket, key, usage)` and `addUsage()` / `addUsageState()`.
- **Data flow:** Every model response and every tool call adds its usage **in the commit that records the
  response**, so the ledger cannot disagree with the transcript.
- **Non-obvious design decisions:** A tool may be called `toString` — so the ledger uses `Object.hasOwn` and
  `Object.defineProperty` rather than plain assignment, "assigning a tool named `__proto__` would set the
  prototype" (`:62-69`). Optional counters (`cacheWrite1h`, `reasoning`) are added once either side reports them
  (`:48-49`), and providers may leave them `undefined`, so the stored value drops undefined properties
  (`:36-37`).
- **Edge cases / failure handling:** Compaction summarization attempts are counted too, and they have no model
  identity, so they land in the `models` bucket under the summarizer's key (`:6-7`).
- **Surprising:** The usage ledger is a **conversation document with `fork: "initial"`**, so a fork starts with an
  empty ledger rather than the parent's spend — spend is attributed to the conversation that incurred it.

### packages/durable/src/harness/util.ts
- **Purpose:** Three small shared helpers: the `Waiters` multimap, `scanAll()` and `closedError()`.
- **Key abstractions:** `Waiters<K, T>` — pending waits keyed by K, each settling once, through `resolve`,
  `rejectAll` or the cancellation of its context.
- **Data flow:** `add(key, context)` returns a promise; the abort listener removes the waiter and rejects it.
- **Non-obvious design decisions:** The abort listener detaches itself when the promise settles
  (`:22-23`), so a long-lived waiter map does not accumulate listeners. `closedError()` returns a `SessionFailed`
  with the cause when the session closed because of a failure, and a plain `Error("Harness is closed")` otherwise —
  so a host can tell "closed normally" from "closed broken" (`:57-61`).
- **Edge cases / failure handling:** A wait on an already-aborted context rejects immediately with the signal's
  reason (`:11`).
- **Surprising:** `scanAll` exists because every scan in the package is paginated with a 256-item page, and the
  internal callers want the whole list.

### packages/durable/src/harness/view.ts
- **Purpose:** The conversation view mount: a structural view of one conversation's active transcript and its
  built-in documents, advanced from the Session's commit publications.
- **Key abstractions:** `ConversationView` (`{ conversation, entries, docs }`), `ViewObserver` (`advance`,
  `publication`, `closeSession`), `ConversationViews` and the `MOUNTED` list (`AgentDoc`, `LiveDoc`, `InboxDoc`,
  `ProviderDoc`, `UsageDoc`).
- **Data flow:** The Session's commit publications → `advance()` → the mount's value and its ops → the observers.
  A document whose incarnation or version changed is set **whole** (`:60-61`).
- **Non-obvious design decisions:** The mount is built on the Session line by its first observer and dropped with
  its last, so a conversation nobody watches costs nothing. Ops are re-prefixed when a document is mounted under a
  conversation (`prefixed()`), so the same op vocabulary serves both levels.
- **Edge cases / failure handling:** A document's retirement is published as the canonical root replacement
  `[["r", null]]`, so every observer sees the same "this is gone" signal.
- **Surprising:** `conversationViews(harness)` is a `WeakMap` lookup that throws "Not a Harness" for anything else
  (`:68-72`) — a stable, private handle for adapters built on the views.

### packages/durable/src/ids.ts
- Boilerplate: two identity functions that apply the erased `Id`/`Seq` numeric brands at a trusted allocation or
  decoding boundary (`idFromNumber`, `seqFromNumber`); no mechanism beyond the type-level branding.

### packages/durable/src/images/cloudflare.ts
- **Purpose:** A 10-line adapter: `createCloudflarePhotonImages()` for Cloudflare Workers and Durable Objects,
  built with Wrangler.
- **Key abstractions:** None of its own; it imports `photon_rs_bg.wasm` as a *module* and passes it to
  `createPhotonImages()`.
- **Data flow:** n/a.
- **Non-obvious design decisions:** The file's first comment names the constraint: "Wrangler's default
  `CompiledWasm` rule turns this import into a `WebAssembly.Module`; Workers cannot compile WebAssembly from
  bytes at runtime. Other bundlers do not support it: use `createPhotonImages()` there" (`:1-2`).
- **Edge cases / failure handling:** n/a.
- **Surprising:** The same WASM binary is used two ways — as bytes on Node, as a compiled module on Workers — and
  the difference is a one-line import.

### packages/durable/src/images/exif.ts
- **Purpose:** Reads the EXIF orientation of a JPEG or WebP **from the bytes, without decoding the image**.
- **Key abstractions:** `exifOrientation(bytes)` (1–8, or 1 when absent or unreadable) and the helpers
  `tiffStart()`, `isExifHeader()` and `ascii()`.
- **Data flow:** `tiffStart` finds the TIFF header (the APP1 segment of a JPEG, the EXIF chunk of a WebP) → the
  IFD is walked → tag `0x0112` (Orientation) is read → the value is clamped to 1–8.
- **Non-obvious design decisions:** Both endiannesses are handled inline with a `u16`/`u32` pair, rather than
  through `DataView`, because the file is a hot path for every image read.
- **Edge cases / failure handling:** Every bound is checked against `bytes.length`; an out-of-range entry returns
  1 (upright) rather than throwing. A WebP chunk may be prefixed with `"Exif\0\0"`, which the code handles
  explicitly (`:52-53`).
- **Surprising:** The WebP chunk walk respects RIFF's even-size padding (`:54-55`) — getting that wrong reads
  garbage as the next chunk header.

### packages/durable/src/images/index.ts
- **Purpose:** The Photon (Rust→WASM) image processor: decode, orient, scale and re-encode an image so a provider
  can take it inline.
- **Key abstractions:** `createPhotonImages(wasm)` and the private `prepare()` / `encodeWithin()` / `transposed()`.
- **Data flow:** `prepare(bytes, mimeType, limits)` → read the EXIF orientation → if the image is already upright,
  inline, within the pixel and byte limits, return it as it is (**but only after decoding it**, "a damaged file is
  an error, not an image the provider rejects") → otherwise orient it, scale it, and encode as PNG or JPEG at
  falling qualities until the base64 fits, then at smaller dimensions, 3/4 at a time.
- **Non-obvious design decisions:** The JPEG quality ladder is `[80, 70, 55, 40]` (`:16`) and the dimension
  fallback is a 0.75 factor (`:78-81`), i.e. a bounded search rather than an analytic one. Photon's own `rotate`
  "drops pixels at right angles", so orientations 5–8 are transposed in JS (`:119-140`).
- **Edge cases / failure handling:** A file Photon cannot decode is caught and returns `undefined` (the caller
  treats it as "not an image"). The upright copy is freed *before* the transposed one is allocated, "so the upright
  copy reuses its WebAssembly memory" (`:55-57`), and `finally { image?.free() }` releases the image whatever
  happens.
- **Surprising:** The work runs on the calling thread — "about a second and a half for a 12-megapixel photo" — and
  the file says plainly: "leave the processor out on memory-constrained hosts", because the decoded RGBA size never
  shrinks again.

### packages/durable/src/images/node-worker.ts
- **Purpose:** The worker thread that runs Photon off the caller's event loop.
- **Key abstractions:** `PrepareRequest` (`{ id, bytes, mimeType, limits }`) and `PrepareReply`
  (`{ id, result }` | `{ id, error }`).
- **Data flow:** `parentPort.on("message")` → `images.prepare(...)` → `postMessage` with the id.
- **Non-obvious design decisions:** The worker resolves the WASM itself with `createRequire(import.meta.url)`,
  because a worker has its own module resolution; the request id correlates the reply with the request.
- **Edge cases / failure handling:** A rejected preparation is replied as an error string rather than thrown, so
  the parent's pending promise rejects with a message.
- **Surprising:** The worker imports `node-worker.ts` under a TypeScript runtime and `node-worker.js` when built —
  the same trick the parent uses at `packages/durable/src/images/node.ts:73`.

### packages/durable/src/images/node.ts
- **Purpose:** The Node/Bun image processor: Photon in a worker thread by default, on the calling thread as a
  fallback.
- **Key abstractions:** `NodePhotonImagesOptions` (`worker`, `idleMs`), `PhotonThread` (one worker and its pending
  requests) and `WorkerUnavailable` (the worker could not start, as opposed to failing on one image).
- **Data flow:** `prepare()` → `PhotonThread.prepare()` (a `postMessage` with a **transferred** copy of the
  bytes) → the reply resolves the request; on `WorkerUnavailable` the processor falls back to `inProcess()`
  permanently.
- **Non-obvious design decisions:** The worker `unref()`s itself so it does not keep the process alive, but a
  pending image `ref()`s it ("A pending image keeps the process alive, as one prepared on the calling thread
  would", `:107-108`). The worker **exits 30 s after its last image**, "freeing Photon's WebAssembly memory, which
  never shrinks while it lives" (`:15-18`).
- **Edge cases / failure handling:** A worker that fails *after* it answered once is an image failure; a worker
  that fails *before* its first answer is an unavailability, and the processor falls back. The bytes are copied
  and transferred so the caller keeps its own (`:109-111`).
- **Surprising:** The idle timeout exists purely to reclaim WASM memory, and the next image pays a fresh worker
  start — a deliberate memory/latency trade stated in the type's docstring.

### packages/durable/src/images/photon-wasm.d.ts
- A 5-line ambient module declaration for `@silvia-odwyer/photon/photon_rs_bg.wasm`, so `cloudflare.ts`'s
  `WebAssembly.Module` import type-checks; no mechanism of its own.

### packages/durable/src/index.ts
- The package's public barrel: 216 lines re-exporting the document/entry/task definitions, the four error classes,
  the harness and its types, the session factory, `MemoryStorage` and the type surface. It is the API contract
  other packages compile against, so every export here is a promise; no logic of its own.

### packages/durable/src/search.ts
- **Purpose:** BM25 ranking for code mode's `searchTools()` and the `tool_search` tool.
- **Key abstractions:** `SearchDocument` (`{ name, text }`), `tokenize()` and `rankDocuments(query, documents,
  limit)`.
- **Data flow:** The query is tokenized → each document's term counts and length are computed → Okapi BM25
  (k1 1.2, b 0.75) with an IDF that is floored at `log(1 + …)` → the matches are sorted by score and cut to the
  limit.
- **Non-obvious design decisions:** The tokenizer splits at camelCase boundaries *and* lowercases *and* applies a
  naive singular stemmer, so `issues` matches `issue` and `readFile` matches `read` and `file` (`:32-49`). Ties keep
  document order, so the ranking is stable.
- **Edge cases / failure handling:** An empty query, an empty document set or a non-positive limit returns `[]`.
- **Surprising:** The file's header says "durable keeps its own copy of what it needs from the coding agent" — a
  deliberate copy rather than a shared dependency, which is the same trade August makes with its own BM25.

### packages/durable/src/session/forks.ts
- **Purpose:** Selects the documents a forked conversation copies.
- **Key abstractions:** `ForkDocumentCopy` (`{ record, source }`) and `prepareForkDocumentCopies(storage, parent,
  at, child, context)`.
- **Data flow:** Resolve the fork point's entry → collect the copies from the **entry's own conversation** at the
  fork point with the `asOf` policy → collect the copies from the **parent conversation** with the `current`
  policy → mint a new document id for each.
- **Non-obvious design decisions:** The two passes are not redundant: a document whose `fork` policy is `asOf` is
  copied at the fork point, and one whose policy is `current` is copied as it is now — so a fork's document set
  depends on each document's own declared fork semantics (`:74-75`).
- **Edge cases / failure handling:** If two source documents resolve to the same address, the fork throws "Fork
  selects multiple source documents for …" (`:90`) rather than silently picking one.
- **Surprising:** A fork **mints new document incarnations** rather than pointing at the parent's; the copy's
  history is the parent's up to the fork point, and the parent's own history stays intact.

### packages/durable/src/session/observation.ts
- **Purpose:** The bridge between the Session's committed state and Chord's replicated-state model: a document or a
  conversation view becomes an attachable, advancing source.
- **Key abstractions:** `CommittedStateSource` (one source per attached state), `SessionSourceAttachment` (the
  per-consumer attachment), `ObservedDocumentValue` and `RETIREMENT_OPERATIONS` (`[["r", null]]`).
- **Data flow:** `advance(value, ops, context)` increments a cursor and publishes a frame to the attachments → the
  attachment queues frames until its listener activates → the frames are delivered → a `null` value retires the
  source.
- **Non-obvious design decisions:** Frames are queued while the consumer is not yet active, and the queue is
  **bounded**: at 100 pending frames the queue is cleared and replaced by a root replacement frame, so a slow
  consumer gets a correct full value rather than an unbounded buffer (`:229-230`).
- **Edge cases / failure handling:** A failure in the consumer's listener ends the watch with that error; a
  retirement ends it with reason `retired`.
- **Surprising:** A watch that is closed twice, or closed after the session closed, is idempotent — `#terminate`
  settles once (`:278-287`).

### packages/durable/src/session/session.ts
- **Purpose:** The Session kernel: one mutation line, the loaded-document cache, the commit protocol and the
  publication of committed state. 1123 lines.
- **Key abstractions:** `createSession(storage, options)`, `SessionImpl`, `GuardedStorage` (the wrapper that decides
  whether a backend error is fatal), `documentRetention()` and the `LoadedDocument` cache.
- **Data flow:** `commit(callback, context)` → the callback runs **on the mutation line** with a `Transaction` →
  the transaction's writes are handed to the storage as one atomic batch → the commit is adopted (the in-memory
  trackers are updated) → the publication goes to the internal listeners, then to the host's.
- **Non-obvious design decisions:** Every commit callback, preparation, storage settlement, adoption and
  publication enqueue runs **while the mutation line is held**, so there is exactly one writer. The document cache
  is bounded by *use*: a document nobody observes leaves it after the retention period, and the next access loads
  it from storage. The hot-document reordering is amortised over a "granule, a tenth of the retention up to 1 s",
  "it may then leave up to a granule early, which costs a reload, while a commit-heavy workload skips the
  reordering" (`:631-632`).
- **Edge cases / failure handling:** `GuardedStorage` (`:961`) decides fatality: "rethrows the backend's error,
  unless it is a `StorageRequestError` or a read whose caller's context was aborted" (`:957-958`, `:1109-1110`); a
  `commit()` error is **never** exempt, "once a batch is admitted, whether it committed is unknown" (`:973`,
  `:1093`). A storage failure **fails the Session** (`SessionFailed`) and every later operation rejects.
- **Surprising:** The same rule that makes the Session safe ("a storage error ends the harness") is implemented in
  exactly one place — the `GuardedStorage` wrapper — and the conformance suite tests it for every backend.

### packages/durable/src/session/transaction.ts
- **Purpose:** One commit: the staged document acquisitions, the table reads and writes, the fork copies, and the
  adoption plan.
- **Key abstractions:** `Transaction` (the commit object), `TransactionHost` (the Session services it uses),
  `LoadedDocument`, `DocumentEntry` / `DocumentTarget` / `DocumentPlan` (the acquisition state machine) and
  `SubmissionChange`.
- **Data flow:** `tx.doc(token, address...)` acquires (or creates) a document incarnation and returns its draft →
  the callback mutates the drafts → `tx.appendEntry` / `tx.createTask` / `tx.createSubmission` stage the table
  writes → the commit resolves the drafts into a base or a delta per document → the plan is handed to the storage.
- **Non-obvious design decisions:** A transaction **may not read after it has written**: `#read` throws
  `ReadAfterWrite` (`:950-953`), and the reason is a deadlock-avoidance rule, not a style choice — "Read every
  required row before writing" (errors.ts `:16`). A document's `checkpointWhen` predicate is consulted on the
  *prepared* change, so the base/delta decision is made with the final value in hand.
- **Edge cases / failure handling:** A task-scoped document cannot be acquired for a terminal task ("Task … is
  terminal", `:630`). Acquiring a document whose stored version is older than the definition's runs the migration
  and *publishes* it, "which includes a migration-only base so observers of the older shape receive the new value"
  (`:1065-1067`). Retirement of an acquired draft persists its final content before retiring (`:594-596`).
- **Surprising:** A document write becomes a **base** or a **delta** per the definition's own predicate, and the
  `deltasSinceBase` counter is carried on the loaded document so the next predicate call needs no read (`:95-96`).

### packages/durable/src/storage/indexeddb.ts
- **Purpose:** The IndexedDB storage backend: the browser's `Storage` implementation.
- **Key abstractions:** `IndexedDbStorage`, the `STORES` and `INDEXES` name tables, the row types (`MetaRow`,
  `ConversationRow`, `EntryRow`, `TaskRow`, `SubmissionRow`, `DocumentRow`) and the index-selection logic in
  `scanTasks`.
- **Data flow:** `open()` creates the database and its stores → every read opens a transaction over the stores it
  needs → every write opens a `readwrite` transaction and applies the writes in order.
- **Non-obvious design decisions:** `scanTasks` picks **one** index to drive the scan — by status, then
  conversation, then kind, then abort flag, then background — and filters the rest in memory (`:617-632`); the
  other filters become an in-memory predicate. The `meta` store holds `nextId` and `nextSeq` in one row, so the id
  allocation is a single read-modify-write.
- **Edge cases / failure handling:** A multi-store read runs inside one transaction so the record and its revisions
  observe one committed state. The `close()` path drains admitted reads before closing the database.
- **Surprising:** The store and index names are duplicated between `indexeddb.ts` and `sqlite/schema.ts` — two
  independent backends that must expose the same logical schema, each with its own copy of the names.

### packages/durable/src/storage/jsonl/index.ts
- A 6-line barrel re-exporting `JsonlStorage`, `JsonlCorruptionError`, `JsonlStoragePoisonedError` and the
  options type; no logic of its own.

### packages/durable/src/storage/jsonl/node.ts
- A 14-line adapter: `openNodeJsonlStorage(directory, context, options)` opens a JSONL storage directory over the
  local Node filesystem, and re-exports the storage class; no logic of its own.

### packages/durable/src/storage/jsonl/storage.ts
- **Purpose:** The JSONL storage backend: a **crash-safe append-only log** of commits, with big payloads spilled to
  per-record sidecar files.
- **Key abstractions:** `MainMarker` (the commit marker: format, type, seq, writes), `MainOperation` (a write
  reduced to a pointer), `SidecarRecord` / `SidecarPayload` (the payload of a task or a document), `JsonlStorage`,
  `JsonlCorruptionError` and `JsonlStoragePoisonedError`.
- **Data flow:** `commit(writes)` → the small writes are inlined into a **main marker**; the big ones (task
  records, document revisions) are written to a sidecar file `doc-<id>.jsonl` / `task-<id>.jsonl` and the marker
  holds only `(file, seq, ordinal)` → the sidecars are flushed first (optionally fsynced) → the marker is appended
  → the marker is what makes the commit visible. On open, the log is replayed: the last complete marker wins, and a
  torn tail is truncated.
- **Non-obvious design decisions:** The main file holds only *pointers* to sidecars, so a commit marker is small
  and constant-size. Sidecar **reclamation** (a retired current-only document's sidecar is emptied; a terminal
  task's sidecar is removed) is "retryable best-effort maintenance" that runs *after* the marker is published
  (`:507-515`) — the marker already published the state, so a failed reclamation is safe.
- **Edge cases / failure handling:** A torn last line is truncated to the last complete record
  (`:802-803`), and a failed truncation throws a `JsonlCorruptionError`. A backend error **poisons** the storage:
  every later call throws `JsonlStoragePoisonedError` ("must be reopened"), because the log's state after a failed
  write is unknown.
- **Surprising:** The JSONL backend is a *crash-safe log with a compaction-free history*, which is a very different
  durability model from the SQLite and IndexedDB backends — the same `Storage` contract, three different
  consistency stories.

### packages/durable/src/storage/memory.ts
- **Purpose:** The in-memory storage backend: the reference implementation of the `Storage` contract, and the
  engine behind the JSONL backend.
- **Key abstractions:** `State` (the maps and indexes), `StoredDocumentState` (a record plus its revisions),
  `DocumentAction`, `clone()` and `freeze()`.
- **Data flow:** `commit(writes)` applies the writes in order to the in-memory maps and the indexes; reads are
  answered from the maps.
- **Non-obvious design decisions:** `clone()` (`:94-114`) is a **structural** deep copy that preserves a
  null-prototype object, and uses `Object.defineProperty` when the key already exists in the target — so a
  `__proto__` key in a stored record cannot reach the prototype. `freeze()` is applied to returned values, so a
  caller cannot mutate the store through a returned record.
- **Edge cases / failure handling:** A document revision chain that crosses a stored version boundary without a base
  throws "Document … crosses a stored version boundary without a base" (`:60-61`) — the store refuses to serve a
  history it cannot interpret. An unknown conversation in a scan throws a `StorageRequestError`.
- **Surprising:** The head marker is resolved by walking the **parent chain** of a forked conversation, narrowing
  the upper bound at each level (`:500-513`) — the fork-aware visibility rule implemented once, in the backend.

### packages/durable/src/storage/scan.ts
- **Purpose:** The shared scan-cursor rules: how a scan's order and position are resolved, and how a continuation
  cursor is built.
- **Key abstractions:** `ScanStart` (`{ order, after }`), `scanStart(requested, cursor, fallback)` and
  `nextCursor(id, order)`.
- **Data flow:** Every `scan*` method in every backend starts with `scanStart(query.order, cursor, default)`.
- **Non-obvious design decisions:** A cursor **carries its own order**: a scan given a cursor continues in that
  order "whether the query repeats that order or omits it", and a different `order` throws "The cursor continues a
  … scan; the query asks for …" (`:31-33`). A cursor written before scans had an order falls back to the default.
- **Edge cases / failure handling:** An invalid order or a malformed cursor throws a `StorageRequestError` — which
  is the *exempt* error class, so a bad cursor fails only that read.
- **Surprising:** One 40-line file removes an entire class of pagination bug (a cursor silently continuing in the
  wrong direction) across four backends.

### packages/durable/src/storage/sqlite/cloudflare.ts
- **Purpose:** A 15-line adapter: `openDurableObjectSqliteStorage(storage, options)` opens the SQLite backend over
  a Durable Object's SQLite storage; it also re-exports the Chord database types.
- **Key abstractions:** None of its own.
- **Data flow:** n/a.
- **Non-obvious design decisions:** The `prefix` option lets several Durable Objects share one SQLite database
  without colliding — "Calls given the same storage object share an operation queue".
- **Edge cases / failure handling:** n/a.
- **Surprising:** The same `SqliteStorage` class serves a local file, a Workers Durable Object and a browser
  IndexedDB-shaped backend; only the `SqliteDatabase` adapter differs.

### packages/durable/src/storage/sqlite/database.ts
- A 1-line re-export of the Chord `SqliteDatabase` / `SqliteExecutor` / `SqliteValue` types; no logic of its own.

### packages/durable/src/storage/sqlite/index.ts
- An 8-line barrel re-exporting the Chord SQLite types, the migration helpers (`applySqliteMigrations`,
  `SQLITE_MIGRATIONS`, `CURRENT_SQLITE_SCHEMA_VERSION`) and `SqliteStorage`; no logic of its own.

### packages/durable/src/storage/sqlite/migrations.ts
- **Purpose:** The SQLite schema history: two ordered migrations that build the durable tables and indexes.
- **Key abstractions:** `createSqliteMigrations(schema)` (renders the history for a given identifier set),
  `SQLITE_MIGRATIONS` (the default-schema history) and `CURRENT_SQLITE_SCHEMA_VERSION`.
- **Data flow:** `applySqliteMigrations(database, migrations)` applies the pending versions atomically, recording
  the applied version in the `durable_schema` table.
- **Non-obvious design decisions:** `next_id` is **TEXT**, not INTEGER, "because node:sqlite rejects INTEGER results
  outside JavaScript's safe integer range" (`:13-14`). Version 2 adds the `sleeping` task status, and because
  "SQLite cannot change a CHECK constraint in place, the table is rebuilt" (`:91-92`) — the migration creates
  `tasks_v2`, copies, drops and renames. Every table is `STRICT` and every JSON column carries
  `CHECK (json_valid(...))`.
- **Edge cases / failure handling:** The migration list is a pure function of the identifier set, so a prefixed
  schema gets the same history rendered with its own names.
- **Surprising:** The identifier names live in `schema.ts` as an "immutable identifier history" — "Never change or
  remove an existing value; a rename adds a new entry so historical migrations keep rendering their original object
  names" (`packages/durable/src/storage/sqlite/schema.ts:6-7`).

### packages/durable/src/storage/sqlite/node.ts
- **Purpose:** A 22-line adapter: `openNodeSqliteStorage(path, options)` opens a file-backed durable storage over
  Node's built-in SQLite.
- **Key abstractions:** `NodeSqliteStorageOptions` (the Node database options plus the durable options).
- **Data flow:** n/a (it opens the database and hands it to `SqliteStorage.open`).
- **Non-obvious design decisions:** The `prefix` is validated with Chord's `validateSqliteSchemaPrefix` before the
  database is opened, so an invalid prefix fails before any file is touched.
- **Edge cases / failure handling:** n/a beyond the prefix validation.
- **Surprising:** The durable storage can live in the *same* SQLite database as the host's own tables, under a
  prefix — no separate file, no separate migration lane.

### packages/durable/src/storage/sqlite/schema.ts
- **Purpose:** The immutable table and index identifier history, and the prefixing rule.
- **Key abstractions:** `TABLE_NAMES`, `INDEX_NAMES`, `SqliteSchema` and `createSqliteSchema(prefix)`.
- **Data flow:** n/a — the identifiers are used by the migrations and by every storage query.
- **Non-obvious design decisions:** The comment is the design: "Immutable identifier history for migrations and
  runtime queries. Never change or remove an existing value; a rename adds a new entry so historical migrations
  keep rendering their original object names" (`:5-8`).
- **Edge cases / failure handling:** `createSqliteSchema` validates a prefix with Chord's validator, and
  `DEFAULT_SQLITE_SCHEMA` is the unprefixed default.
- **Surprising:** The names are *keys* in an object, not raw strings, so a rename is a diff in one place and the
  17 index names are type-checked against the 9 table names.

### packages/durable/src/storage/sqlite/storage.ts
- **Purpose:** The SQLite storage backend: the durable tables, the scans and the commit.
- **Key abstractions:** `SqliteStorage`, `SqliteStorageOptions` (the `prefix`), the row types, `scanSql()` (the
  id condition and the `ORDER BY` direction of a scan) and `scopeColumns()`.
- **Data flow:** `commit(writes)` opens a transaction, applies the writes (conversations, entries, tasks,
  submissions, document creations/changes/retirements) and bumps the `durable_metadata` counters; reads are
  parameterised SQL.
- **Non-obvious design decisions:** Indexed strings are JSON-encoded before they are stored in an indexed column
  ("Some SQLite bindings replace lone UTF-16 surrogates. JSON encoding keeps indexed identities lossless",
  `:74-75`). A document read that needs both the record and its revisions runs inside a **transaction**, "a commit
  between them can replace the base" (`:551-552`).
- **Edge cases / failure handling:** `close()` waits for the admitted reads to drain before closing the database
  (`:594-601`), and `admitRead()` counts them — so a read in flight never reaches a closed database. A cursor with
  a non-safe-integer `after` is a `StorageRequestError`.
- **Surprising:** The `documents` table stores `kind`, `scope_kind`, `owner_id`, `family` and `key_value` as
  *columns* for indexing, and the whole record as JSON — the address is a queryable key, the record is opaque.

### packages/durable/src/tasks.ts
- An 8-line identity function: `defineTask(definition)` types a task definition; the comment says "Register it in
  the registry so a Harness can run tasks of its kind"; no logic of its own.

### packages/durable/src/testing/assertions.ts
- **Purpose:** Adapts a Vitest/Jest-compatible `expect` to the suite's own assertion interface, without importing
  either runner.
- **Key abstractions:** `ExpectLike` and `createExpectAssertions(expect)`.
- **Data flow:** The conformance suite calls `assertions.strictEqual(...)` etc.; the adapter forwards them to
  `expect`.
- **Non-obvious design decisions:** The suite is **runner-independent**: the durable package ships the *cases*, and
  the host's test runner supplies the assertions. That is what lets the same conformance suite run against four
  storage backends in four different repositories.
- **Edge cases / failure handling:** n/a.
- **Surprising:** `rejects` is adapted as `expect(operation).rejects.toThrow(...)` — a promise is passed to
  `expect` rather than awaited first.

### packages/durable/src/testing/env-conformance.ts
- **Purpose:** The runner-independent conformance suite for the `ExecutionEnv` contract: 633 lines of cases that
  any environment implementation must pass.
- **Key abstractions:** `createEnvConformance(options)` returning `EnvConformanceCase[]`, plus the helpers
  `readAll`, `listed`, `covers` and `watching`.
- **Data flow:** Each case receives a fresh environment from the provider and exercises one contract point: file
  reads and writes, directory listing, symlinks, watch semantics, and shell execution.
- **Non-obvious design decisions:** The argv case passes a deliberately hostile command — `"it's $(touch pwned)
  `touch pwned` *; touch pwned"` — and asserts that no `pwned` file appears, proving the argv form reaches the
  program unparsed (`:397-408`). The windowed-exec case asserts the *exact* tail and the *exact* count of skipped
  bytes and newlines, so a backend cannot "approximately" honour the output window (`:438-472`).
- **Edge cases / failure handling:** The suite distinguishes `timeout` from `aborted` by their error codes
  (`:474-481`); a missing program and an empty argv are both `spawn_error`; a watch that is closed twice reports
  nothing afterwards.
- **Surprising:** The suite is **optional** about features: `listFiles` and `symlinks` are opt-in flags, and the
  symlink cases only run when the environment says it supports them — a conformance suite that assumes every
  feature is a conformance suite nobody passes.

### packages/durable/src/testing/index.ts
- A 27-line barrel re-exporting the assertion adapter, the two conformance suite factories, the runners, the
  benchmark dataset helpers and the option types; no logic of its own.

### packages/durable/src/testing/runner.ts
- **Purpose:** Registers the runner-independent conformance cases with a Vitest/Jest-compatible runner.
- **Key abstractions:** `StorageConformanceRunner` (a `describe`/`it`/`expect` triple) and
  `registerStorageConformance` / `registerEnvConformance`.
- **Data flow:** `createStorageConformance({ assertions, withStorage })` → an array of named cases → the runner's
  `describe`/`it`.
- **Non-obvious design decisions:** The env cases pass a per-case `timeoutMs` (`:36`) because "Cases that wait for
  an environment's watch latency need longer than a test runner's default timeout" (`packages/durable/src/testing/types.ts:43-44`).
- **Edge cases / failure handling:** n/a.
- **Surprising:** The durable package ships the *contract* and the *cases*; the host supplies the runner, the
  assertions and the environment. That is a reusable conformance suite, not a test file.

### packages/durable/src/testing/storage-benchmark.ts
- **Purpose:** A deterministic benchmark dataset and the read/write benchmark definitions, so the storage backends
  can be compared on the same data.
- **Key abstractions:** `StorageBenchmarkScale` (`{ name, entryCount, taskCount, documentCount }`),
  `STORAGE_MEMORY_SCALES` (`1k` and `10k`), `TIMING_SCALE`, `StorageBenchmarkDataset` and
  `STORAGE_READ_BENCHMARKS` / `STORAGE_WRITE_BENCHMARKS`.
- **Data flow:** `seedStorageBenchmark(storage, scale)` writes the dataset **through only the public `Storage`
  contract** (`:87`), in batches of 100, and returns the ids the benchmarks need.
- **Non-obvious design decisions:** The dataset deliberately includes a **fork chain 8 deep** with 32 entries per
  fork (`FORK_DEPTH`, `ENTRIES_PER_FORK`) and documents with several replay tails (`[0, 16, 128, 1024]`) — the
  shapes that are actually slow. `storageBenchmarkPrimaryRecordCount()` computes the exact number of records so a
  benchmark can report a per-record cost.
- **Edge cases / failure handling:** n/a.
- **Surprising:** The benchmark data is seeded *through the public API*, so a backend's write path is measured
  rather than a private bulk-insert path that no real caller uses.

### packages/durable/src/testing/storage-conformance.ts
- **Purpose:** The runner-independent conformance suite for the `Storage` contract: 1682 lines, the largest file
  in the package after the scheduler.
- **Key abstractions:** `createStorageConformance(options)` returning `StorageConformanceCase[]`, the
  `assertionFacade` and the helpers `createRoot`, `pendingTask` and `entry`.
- **Data flow:** Each case gets a fresh storage from the provider and exercises one contract point: id
  allocation, entry appends, fork visibility, head markers, cursor pagination, document incarnations and
  revisions, task and submission lifecycles, and the closing behaviour.
- **Non-obvious design decisions:** The suite pins the *fork* semantics precisely: a grandchild's descending scan
  returns the grandchild's tail, then the grandchild's head, then the child's fork point, then the root's fork
  point, then the root's first entry (`:429-435`) — the fork-aware visibility rule, asserted with exact arrays. A
  cursor used with a different `order` is **rejected** (`:456-458`).
- **Edge cases / failure handling:** The id space is exhausted deliberately: a commit with
  `Number.MAX_SAFE_INTEGER` as an entry id makes every later `mintId()` reject with "ID space is exhausted" (`
  :1666-1671`), and every operation after `close()` rejects with "closed" (`:1674-1680`).
- **Surprising:** The suite is the **only** description of the storage contract that is executable. The
  5618-line spec says what the contract is; this file says whether an implementation keeps it.

### packages/durable/src/testing/types.ts
- **Purpose:** The option and case types of the two conformance suites and the assertion interface they use.
- **Key abstractions:** `StorageConformanceAssertions`, `StorageConformanceProvider`, `EnvConformanceProvider`,
  `EnvConformanceOptions` and `EnvConformanceCase` (which carries an optional `timeoutMs`).
- **Data flow:** n/a — these are the seams between the durable package and a host's test runner.
- **Non-obvious design decisions:** `EnvConformanceProvider` is "Calls `use` once with an environment whose `cwd` is
  a fresh, empty, writable directory, then cleans up" (`:27-28`) — the suite never assumes a particular filesystem
  state.
- **Edge cases / failure handling:** n/a.
- **Surprising:** The `EnvConformanceAssertions` interface is literally `StorageConformanceAssertions` — one
  assertion vocabulary for two different contracts.

### packages/durable/src/timers.ts
- **Purpose:** The host's timer abstraction: `nativeTimer` and `hostTimers(setTimer, report)`.
- **Key abstractions:** `SetTimer` (the host's injected timer), `Timers` (`foreground` / `background`) and
  `MAX_TIMER_DELAY` (2 147 483 647 ms).
- **Data flow:** The Session and the Harness arm their timers through `Timers`; a host timer that throws or
  declines is caught and reported.
- **Non-obvious design decisions:** A **foreground** timer "must fire, or work stalls", so one the host throws on
  or declines falls back to `setTimeout` (`:60-68`); a **background** timer only frees memory, so one the host
  throws on is reported and declined. A background timer is `unref()`ed so it never keeps the process alive — and
  where `unref` does not exist, the timer is cleared and declined rather than kept (`:31-34`).
- **Edge cases / failure handling:** A delay beyond `setTimeout`'s limit is waited for in several steps (`:19-28`).
  In Cloudflare Workers a background timer is declined outright, because there a pending timer keeps a Durable
  Object from hibernating, "even an unreferenced one" (`:7-9`).
- **Surprising:** Only the *first* failure is reported (`reported` latch, `:54-57`) — a host whose timer is broken
  gets one report, not one per timer.

### packages/durable/src/tool-search/index.ts
- A 7-line barrel re-exporting the `tool_search` extension/tool factories, the default limit and the tool name; no
  logic of its own.

### packages/durable/src/tool-search/tool-search.ts
- **Purpose:** The `tool_search` tool: the model searches the tools it is not offered yet, and the matches are
  loaded with `control.addTools` so the next request offers them.
- **Key abstractions:** `TOOL_SEARCH_TOOL_NAME`, `DEFAULT_TOOL_SEARCH_LIMIT = 8`, `ToolSearchToolDetails`
  (`{ loaded: string[] }`), `searchText()` and `schemaText()`.
- **Data flow:** `execute({ query, limit })` → `api.agent(context).deferred` (the tools not offered) → BM25 over
  their search text → the result is a text list plus `control: { addTools: loaded }`.
- **Non-obvious design decisions:** The tool's **description is fixed**, "so it does not change while deferred tools
  are registered, for example as MCP servers connect" (`:14`) — a moving description would invalidate the prompt
  cache. The search text is the tool's name, its name with `_` as spaces, its description and its parameters'
  schema text (`:49-53`), so a parameter name alone can surface a tool. The tool is `callers: ["model"]` and
  `replay: "safe"`.
- **Edge cases / failure handling:** An empty query and a non-positive or non-integer limit are refused. When
  nothing matches, the result is "No matching tools found." and **no** `control` is returned, so the agent's tool
  set is not touched.
- **Surprising:** Loading a tool writes the conversation's `modelTools`, so "loaded tools stay offered on that
  branch, also after a compaction" (`:4-5`) — the discovery is sticky, which is what makes progressive disclosure
  safe to rely on.

### packages/durable/src/tools/bash.ts
- **Purpose:** The `bash` and `powershell` tools: run a command in the environment's working directory and turn the
  result into a tool result.
- **Key abstractions:** `BashExecution` (the command, cwd, env and `inheritEnv`), `BashPrepare` (a hook that may
  change the execution), `BashToolOptions` / `PowerShellToolOptions`, and the structured output schema
  (`output`, `truncated`, `fullOutputPath`, `exitCode`).
- **Data flow:** `execute` → `validateTimeout` → `prepareExecution` (prefix + the `prepare` hook) → `runCommand` →
  the exit code and the retained output become the result.
- **Non-obvious design decisions:** A **nonzero exit is an error result**, not a throw: the result is
  `{ isError: true, diagnostics: [{ severity: "error", code: "exit_code", … }] }` (`:133-135`), and the exit code
  is still in the structured output. A failure such as a timeout *throws*. Output past the limits is spilled to a
  file whose path is reported as a diagnostic (`:142`).
- **Edge cases / failure handling:** The timeout must be a finite positive number of seconds and at most
  `MAX_TIMEOUT_SECONDS` (`:55-63`). The PowerShell tool tries `pwsh` then `powershell` and skips one that cannot
  start. The output window is "tail" (`outputLimits: { retain: "tail" }`), so a long command's *end* survives.
- **Surprising:** The `prepare` hook can rewrite the command, the cwd and the environment, so a host can inject a
  sandbox prefix without forking the tool.

### packages/durable/src/tools/edit-diff.ts
- **Purpose:** The shared diff and edit-application utilities behind the `edit` tool.
- **Key abstractions:** `detectLineEnding`, `normalizeToLF`, `restoreLineEndings`, `normalizeForFuzzyMatch`,
  `stripBom`, `applyEditsToNormalizedContent` and `generateDiffString` / `generateUnifiedPatch`.
- **Data flow:** The file is read, its BOM stripped, its line ending detected, its content normalised to LF → the
  edits are matched and applied in **normalized** space → the result is written back with the original BOM and
  line ending restored → a diff and a unified patch are generated for the details.
- **Non-obvious design decisions:** All edits are matched against the **same original content** and the
  replacements are applied in reverse order so the offsets stay stable (`:292-299`). The fuzzy normaliser strips
  trailing whitespace, maps smart quotes to ASCII, maps Unicode dashes to `-` and special spaces to a plain space
  (`:30-50`). A fuzzy match works in normalized space and then "overlays those line-level changes onto the
  original content so unchanged line blocks keep their original bytes" (`:298-300`).
- **Edge cases / failure handling:** An empty `oldText` is refused; text that is not found and text that occurs
  more than once produce **different, index-aware error messages** ("Could not find edits[2] in …" vs "Found 3
  occurrences of edits[2] in …", `:254-274`).
- **Surprising:** The `diff` library is used for the *diff*, but the edit application is hand-written — the
  matching rules (unique, non-overlapping, all against the original) are stricter than any diff library's.

### packages/durable/src/tools/edit.ts
- **Purpose:** The `edit` tool: exact-text replacement in a single file, with a diff and a patch in its details.
- **Key abstractions:** `editSchema` (`path` + `edits[]`), `EditToolDetails` (`{ diff, patch, firstChangedLine? }`),
  `prepareEditArguments` and `validateEditInput`.
- **Data flow:** `prepareArguments` repairs the argument shape → `execute` → the file is read through the
  environment → the edits are applied to the LF-normalised content → the file is written back with its original
  BOM and line ending → the diff and the patch are produced.
- **Non-obvious design decisions:** The tool **repairs the shapes models commonly send**: `edits` as a JSON string,
  `edits` as a single edit object, and a top-level `oldText`/`newText` pair — "Works on a copy; the call's
  arguments stay unchanged" (`:45-48`). The schema tells the model that each `oldText` "must be unique in the
  original file and must not overlap with any other edits[].oldText in the same call".
- **Edge cases / failure handling:** An empty `edits` array is refused; a path that is not a file is refused; a
  read or write failure becomes `Could not edit file: <path>. Error code: <code>.` (`:86-88`). The abort signal is
  checked before, between and after the read-modify-write (`:105`, `:114`, `:120`, `:125`).
- **Surprising:** The whole read-modify-write is serialised through the **file mutation queue**, so two concurrent
  edits of the same file cannot interleave — the classic lost-update bug, closed at the tool level.

### packages/durable/src/tools/env.ts
- An 8-line helper: `requireEnv(api)` returns the call's execution environment, or throws "No execution
  environment is configured" — a tool without one fails with an ordinary error result.

### packages/durable/src/tools/file-mutation-queue.ts
- **Purpose:** Serialises `edit` and `write` mutations of **one file** within the process.
- **Key abstractions:** `withFileMutationQueue(env, path, fn, context)` and the private `mutationKey` / `canonical`.
- **Data flow:** The key is `env.id` + the canonical path → the queue's tail promise for that key is chained → the
  function runs → the slot is released and the entry removed if it is still the tail.
- **Non-obvious design decisions:** The key is the **canonical** path, so a `write` that creates a file and a later
  mutation of it share one key even under a symlinked directory: for a file that does not exist yet, the canonical
  *parent* joined with the name is used (`:12-26`). The slot is taken **without awaiting** ("Take the slot without
  awaiting, so no other call can take it in between", `:40-41`).
- **Edge cases / failure handling:** "Other files, and other file systems, never wait" — the queue is per
  (environment id, canonical path). It is explicitly "**Not a lock against `bash` or other processes**" (`:31`).
- **Surprising:** The `env.id` component means two environment objects for the same directory do **not** share a
  queue unless they share an id — a deliberate scope choice, stated in the comment.

### packages/durable/src/tools/image-processor.ts
- **Purpose:** The image-processor contract and the base64 helpers, shared by the `read` tool and the Photon
  implementation.
- **Key abstractions:** `ImageLimits` (`maxWidth`, `maxHeight`, `maxBytes`), `DEFAULT_IMAGE_LIMITS` (2000 × 2000
  pixels, 4.5 MiB of base64 — "below Anthropic's 5 MB", `:7`), `PreparedImage` (data, mimeType, `resized?`,
  `convertedFrom?`) and `ImageProcessor`.
- **Data flow:** `prepare(bytes, mimeType, limits)` returns a `PreparedImage` or `undefined`; `toBase64` and
  `base64Length` convert and size the payload.
- **Non-obvious design decisions:** `toBase64` builds the binary string **8 KiB at a time**, because "a single
  `String.fromCharCode` call with megabytes of arguments overflows the stack" (`:43-45`).
- **Edge cases / failure handling:** `INLINE_IMAGE_TYPES` is the set of formats every provider takes inline
  (`:40`); anything else (BMP) needs converting, and `convertedFrom` tells the model the format changed.
- **Surprising:** The `resized` field carries the **before and after** dimensions "for the model to map coordinates
  back" (`:18-21`) — the model is told the picture was scaled so it can convert a coordinate it reads in the
  image back to the file.

### packages/durable/src/tools/image.ts
- **Purpose:** Image format detection and header-only dimension reading — no decoding.
- **Key abstractions:** `ByteSource` (positional reads of a file), `detectSupportedImageMimeTypeOf(source)`,
  `detectSupportedImageMimeType(buffer)`, `imageDimensions(bytes, mimeType)` and the header readers.
- **Data flow:** For a file, only the 32-byte header is read; for a PNG, the chunk headers are walked in 64 KiB
  blocks until the first `acTL` or `IDAT`.
- **Non-obvious design decisions:** An **animated** PNG is not supported: the chunk walk looks for `acTL` (animation
  control) before `IDAT` and refuses the file if it finds one (`:22-44`). The JPEG SOF scan excludes `0xc4` (DHT),
  `0xc8` (JPG) and `0xcc` (DAC), "which share the range" (`:109-110`).
- **Edge cases / failure handling:** A JPEG whose fourth byte is `0xf7` (a lossless JPEG variant) is refused.
  A BMP is accepted as `image/bmp` and left to the processor to convert.
- **Surprising:** The PNG walk is **bounded in memory** — it reads 64 KiB blocks and reuses the block, so a
  500 MB PNG's dimensions are known without reading the file.

### packages/durable/src/tools/index.ts
- **Purpose:** The `coding-tools` extension: `read`, `write`, `edit` and `bash` — "nothing installs it
  automatically" (`:28`).
- **Key abstractions:** `createCodingTools(options)` and the exported `CodingTools` constant (the same extension
  without an image processor).
- **Data flow:** n/a (an extension is a list of tools).
- **Non-obvious design decisions:** `createPowerShellTool()` is exported but **not** part of `createCodingTools()`:
  the extension stays platform-neutral, and the host adds `powershell` explicitly.
- **Edge cases / failure handling:** n/a.
- **Surprising:** The extension is created by a factory rather than exported as a constant, because the `read`
  tool's options (an image processor) are part of the tool's identity.

### packages/durable/src/tools/path-utils.ts
- **Purpose:** The two path-resolution helpers the file tools use: `resolveToolPath` and `resolveReadToolPath`.
- **Key abstractions:** `normalizeToolPath` (Unicode spaces → a plain space, a leading `@` stripped) and the variant
  list in `resolveReadToolPath`.
- **Data flow:** `resolveReadToolPath` resolves the path, then tries the variants in order and returns the first
  that **exists**.
- **Non-obvious design decisions:** The variants are the path as given, the path with " AM."/" PM." replaced by a
  narrow no-break space, the NFD-normalised path, the path with `'` replaced by `’`, and the combination (`:18-24`).
  This exists because a model that copied a filename out of a document with a typographic apostrophe or a
  non-breaking space would otherwise fail to read the file it is looking at.
- **Edge cases / failure handling:** If no variant exists, the resolved path is returned anyway, so the read fails
  with the *canonical* path in the error rather than a variant.
- **Surprising:** A leading `@` is stripped from a tool path — the same convention as the `@`-mention syntax in a
  chat composer, so a pasted mention works as a path.

### packages/durable/src/tools/read.ts
- **Purpose:** The `read` tool: reads text files and images, with a line/byte window, an offset/limit, and optional
  image preparation.
- **Key abstractions:** `readSchema` (`path`, `offset`, `limit`), `ReadToolDetails` (`{ truncation? }`),
  `ReadToolOptions` (`{ images? }`), `readHead()` and `sliceIndex()`.
- **Data flow:** The path is resolved (with the Unicode variants) → the file is opened as a binary reader → its
  metadata is read → the head is decoded (enough for `truncateHeadOf`) or the requested line range is scanned with
  `LineScanner` → the text is truncated to the line/byte limits → the truncation is reported as a **diagnostic**,
  not as prose in the output.
- **Non-obvious design decisions:** The head is read only until it holds `DEFAULT_MAX_LINES` newlines or
  `DEFAULT_MAX_BYTES + 1` bytes, so a huge file is never read whole (`:75`). Truncation is a diagnostic with the
  exact continuation instruction: "Showing lines 1-2000 of 50000. Use offset=2001 to continue." (`:295`). The image
  formats offered depend on whether a processor is configured: without one, BMP is not in the list (`:90`).
- **Edge cases / failure handling:** The file is re-checked after the read: if its size or mtime changed while it
  was read, the read is retried once and then fails with "<path> changed while it was read" (`:122-124`) — a
  read-modify-write race is caught rather than silently returning torn content.
- **Surprising:** The tool's **content** is only the file text (or one image); "Remarks about truncation,
  continuation, and image processing are diagnostics" (`:86-88`) — the remarks are structured, so a UI can render
  them and a program can read them.

### packages/durable/src/tools/write.ts
- **Purpose:** The `write` tool: write content to a file, creating it and its parents if needed.
- **Key abstractions:** `writeSchema` (`path`, `content`) and `createWriteTool()`.
- **Data flow:** The path is resolved → the write runs inside the file mutation queue → the abort signal is checked
  before and after the write → the result is "Successfully wrote to <path>".
- **Non-obvious design decisions:** The tool **re-uses the file mutation queue** (`:26-36`), so a `write` and an
  `edit` of the same file cannot interleave — the same lost-update protection the `edit` tool gets.
- **Edge cases / failure handling:** An aborted context throws "Operation aborted" before and after the write.
- **Surprising:** The confirmation names the path **as the model wrote it**, not the resolved absolute path — the
  model is not shown a path it did not choose.

### packages/durable/src/truncate.ts
- **Purpose:** The shared truncation utilities: two independent limits (lines and bytes), "whichever is hit first
  wins", and never a partial line.
- **Key abstractions:** `TruncationResult` (content, `truncated`, `truncatedBy`, totals, output sizes,
  `lastLinePartial`, `firstLineExceedsLimit`, the applied limits), `TruncationOptions`, `truncateHead`,
  `truncateHeadOf`, `formatSize` and the re-exported `utf8ByteLength`.
- **Data flow:** `truncateHead(content)` counts the lines and bytes and delegates to `truncateHeadOf(prefix, totals,
  options)`, which is also the form the `read` tool uses when it has already read only a prefix of a file.
- **Non-obvious design decisions:** The defaults are 2000 lines and 50 KB (`:12-13`). `truncateHeadOf` exists so a
  caller that has only read a *prefix* can truncate it correctly without reading the whole file — the contract is
  that the prefix "must be the whole text, or longer than `maxBytes + 1` UTF-8 bytes, or hold at least `maxLines`
  newlines" (`:87-89`).
- **Edge cases / failure handling:** A first line that alone exceeds the byte limit returns **empty** content with
  `firstLineExceedsLimit: true` rather than a partial line. The `truncatedBy` discrimination is subtle: without a
  byte break, only omitted lines prove the line limit was reached; "otherwise a trailing newline exceeded bytes"
  (`:155-156`).
- **Surprising:** The result carries `firstLineExceedsLimit` and `lastLinePartial` — two flags that exist so a
  caller can tell "your file has one enormous line" from "your file was cut off", which are different instructions
  to give a model.

### packages/durable/src/types.ts
- **Purpose:** The durable package's root type contract: the branded ids, the `Seq`, the document semantics, the
  task state machine's records, the query and pagination types, and the `Storage` interface every backend
  implements. 1274 lines, and the file the rest of the package is written against.
- **Key abstractions:** `Id<Kind, Type>` (a branded number — `ConversationId`, `EntryId`, `TaskId<Result>`,
  `SubmissionId`, `DocumentId`), `Seq` (a branded commit sequence), `ROOT_CONVERSATION_ID = 1`,
  `DocumentSemantics` (the scope/history/fork union), `CommonDocDefinition` / `DocDefinition` /
  `DocFamilyDefinition`, `TaskRecord` / `TaskState` / `TaskRuntime` / `PhaseHandler` / `HookRunner`, `DocumentRecord`,
  `Page<T, C>` / `Cursor` / `ScanOrder`, the four query types, and `Storage`.
- **Data flow:** The `Storage` interface (`:1179`) is the backend contract: `commit(writes, context)` returns a
  `Seq` (`:1183`) and `mintId<I>()` allocates an id (`:1189`); everything else is a read.
- **Non-obvious design decisions:** The `PhaseHandler` contract is stated in the type itself: a phase "must commit a
  changed checkpoint or a terminal outcome through `runtime.commit()`; **returning without durable progress faults
  the task**" (`:223-224`). The `Seq` docstring notes that "gaps are permitted" (`:36-37`) — a commit sequence is
  monotonic, not gapless, because not every sequence number is a commit. `Cursor` is "Backend-owned JSON
  continuation state that callers only round-trip to the same scan" (`:758-760`) — the caller may not inspect or
  forge it.
- **Edge cases / failure handling:** The `Storage` contract's error rule is in the docstring above the interface:
  "rejection because its caller's context was aborted. Any error from `commit()` or `mintId()` is fatal"
  (`:1177-1178`) — the exemption lives in the contract, not only in the implementation. A task record's `restarts`
  counts "how many times in a row a crash, eviction, or reset cut the task off while it ran, without the task
  changing its state since; open counts them, and a close does not" (`:681-686`) — a deliberate close is not a
  failure.
- **Surprising:** The ids are **numbers**, not strings: the type brand exists only to stop a `TaskId` being passed
  where an `EntryId` is expected, and `idFromNumber` (`ids.ts`) is the one function allowed to erase the brand.

## Ideas worth stealing

- **A durable task state machine whose "no progress" is a failure** — `packages/durable/src/harness/scheduler.ts:1828`
  — the spec's fault rule is "Checkpoint unchanged: write terminal `faulted` because no durable progress"
  (`packages/durable/docs/spec.md:2010`). August's stall detection is argument-novelty-based and can be defeated by
  a model that calls a different no-argument tool every round; pi's rule is structural — a task that re-commits the
  *same* state has made no durable progress and is failed. That is exactly the invariant August's runaway backstop
  wants, expressed in a form that cannot be gamed by argument variety.
- **A crash-loop guard that parks rather than retries** — `packages/durable/src/harness/scheduler.ts:409` — "Task …
  was cut off N times without progress; it is parked until retryTask()", with the predicate at
  `packages/durable/src/harness/scheduler.ts:1367` (a task whose abort was requested is never parked). August's
  runaway backstop counts rounds; this counts *state changes*, which is the signal that actually distinguishes work
  from spinning.
- **A read-after-write ban inside a transaction, enforced by the type of the error** —
  `packages/durable/src/session/transaction.ts:953` — `ReadAfterWrite` is thrown by the transaction's own `#read`
  wrapper, so a commit callback that reads after writing fails loudly instead of reading a torn snapshot. August's
  loop reads and writes the same SQLite brain inside one request; a rule like this (with an explicit "read
  everything first" door) would remove a whole class of ordering bugs.
- **The one-error-exemption rule for storage reads** — `packages/durable/src/session/session.ts:1109` — a
  `StorageRequestError` or a caller-cancelled read fails only that read, while *any* error from `commit()` is fatal
  ("once a batch is admitted, whether it committed is unknown", `packages/durable/src/session/session.ts:973`).
  August's backend has the same distinction but it is spread across call sites; one wrapper that decides fatality
  is both cheaper and testable.
- **A replay-safe tool is one whose *intent* is committed before the effect** —
  `packages/durable/src/harness/tool.ts:76` — the `execute` phase records "the final arguments and the replay
  policy" before the tool runs, so a crash during the effect leaves a durable record of what was about to happen.
  The nested-call identity check at `packages/durable/src/harness/tool.ts:754` ("was already made with another tool
  or other arguments") then refuses to re-admit a call that changed shape. August's `run_command` and `write_file`
  have no such record.
- **Overflow is never retried, only compacted** — `packages/durable/src/harness/generation.ts:560` — "An overflow is
  never retried: only a compaction can make the next request fit." August has a whole ladder for context overflow
  (auto-compact, budget rung, reactive rescue) and a separate retry path; pi's rule is one sentence and it removes
  the possibility of a retry storm against an oversized prompt.
- **The compaction cut may never land between an assistant's tool call and its result** —
  `packages/durable/src/harness/compaction.ts:303` — the candidate predicate refuses a cut "that a result of the
  preceding assistant's calls that follows this entry, before the next assistant, belongs before it". A summary
  that orphaned a `tool_use` would brick the next request; this is a structural invariant on the cut, not a
  post-hoc repair.
- **Only the first system message moves, to keep the prompt cache warm** —
  `packages/durable/src/harness/context.ts:208` — "Only the first system message moves, so replaying [the rest] does
  not change the request's tool list and invalidates the whole prompt cache." August freezes its memory index per
  session for the same reason; pi states the cache constraint at the point where the message list is built, which is
  where it can actually be enforced.
- **The system-prompt planner has exactly three shapes, and the "head marker" case writes a full baseline** —
  `packages/durable/src/harness/prompt.ts:66` and `packages/durable/src/harness/prompt.ts:62` — a complete baseline
  when no later `pi.system` entry exists, a remove-all/re-add-all when a minimal patch would change the order, and
  otherwise the minimal patch. August's `<memory_policy>` and its per-turn section assembly would benefit from
  having the "what shape is this update" question answered once, explicitly, instead of per-surface.
- **A bounded watch frame queue that degrades to a full replacement** —
  `packages/durable/src/session/observation.ts:229` — at 100 pending frames the queue is dropped and the consumer
  receives a root replacement. The durable live state is a *document*, so a slow UI can always resynchronise from
  the store; August's SSE stream has no such fallback.
- **A snapshot diff instead of trusting the filesystem's events** —
  `packages/durable/src/env/node-watch.ts:134` — "native events only trigger a debounced rescan, and changes are the
  difference between snapshots plus the event paths", with a 500 ms settle on macOS because "about 2% of changes
  made right after the call" are never reported. Any August feature that watches a directory (skills, hooks,
  automations) should diff, not trust the event.
- **One file-mutation queue keyed by the canonical path** —
  `packages/durable/src/tools/file-mutation-queue.ts:33` — "Serialize `edit` and `write` mutations of one file
  within this process", with the key built from the canonical path so a create and a later mutation share it even
  under a symlinked directory. August's `write_file`/`edit` have no such serialization; a lost update there is a
  silent data-loss bug.
- **A cursor that carries its own order and refuses a different one** —
  `packages/durable/src/storage/scan.ts:32` — "The cursor continues a ascending scan; the query asks for
  descending". One 40-line file removes an entire class of pagination bug across four backends; August's
  `list_facts` offset pagination has the same shape of hazard.
- **A runner-independent conformance suite, shipped as the package** —
  `packages/durable/src/testing/storage-conformance.ts:95` and
  `packages/durable/src/testing/env-conformance.ts:398` — the package ships the *cases* and the host supplies the
  runner, the assertions and the implementation. The argv case passes a deliberately hostile command and asserts
  that no `pwned` file appears. August has no equivalent: its rules live in prose in AGENTS.md and in scattered
  `if` statements, and August has no test suite at all.
- **Seed the benchmark data through the public contract** —
  `packages/durable/src/testing/storage-benchmark.ts:88` — "Seed deterministic representative data through only the
  public `Storage` contract", with a fork chain 8 deep and several replay tails in the shape. A benchmark that
  measures a private bulk path measures nothing a real caller uses.
- **A nonzero exit is an error *result*, not a throw** —
  `packages/durable/src/tools/bash.ts:133` — the exit code stays in the structured output and the result carries
  `isError: true` plus an `exit_code` diagnostic, while a *failure* (a timeout) throws. August's `run_command`
  surfaces exit codes in prose; making the distinction structured is what lets a UI colour a failing command
  without parsing text.
- **The provider identity is a document, and a fork gets a fresh one** —
  `packages/durable/src/harness/provider.ts:11` — "every fork starts with a fresh identity instead of copying its
  parent", with `fork: "initial"`. If August ever forks a chat to a different upstream session, this is the rule
  that stops the two chats sharing a provider session id.
- **Tool-search loads are sticky, and the search tool's description is fixed** —
  `packages/durable/src/tool-search/tool-search.ts:14` — the description never changes "while deferred tools are
  registered, for example as MCP servers connect", and a load writes the conversation's `modelTools`, so the tools
  stay offered "also after a compaction" (`:4-5`). August's progressive disclosure and its compaction do not
  currently agree about what survives.

## Files skipped (with reasons)

None. Every one of the 89 files in the `durable#1` shard was opened and read; the largest — `docs/spec.md`
(303 KB, 5618 lines), `src/harness/scheduler.ts` (108 KB, 2507 lines), `src/testing/storage-conformance.ts`
(62 KB, 1682 lines), `src/harness/types.ts` (44 KB, 907 lines), `src/storage/indexeddb.ts` (43 KB, 1208 lines),
`src/session/session.ts` (42 KB, 1123 lines), `src/session/transaction.ts` (42 KB, 1071 lines),
`src/harness/tool.ts` (42 KB, 964 lines), `src/env/node.ts` (41 KB, 1235 lines), `src/harness/generation.ts`
(34 KB, 774 lines), `src/storage/memory.ts` (33 KB, 864 lines), `src/storage/sqlite/storage.ts` (36 KB, 957 lines),
`src/storage/jsonl/storage.ts` (30 KB, 846 lines) and `src/testing/env-conformance.ts` (27 KB, 633 lines) — were
read in full across multiple passes. No file in this shard is generated, vendored or binary.

## Uncertainties

- **The manifest's shard labelling changed between the two passes, and I did not change it.** The first pass's
  report stated that the manifest's 4th column "contains no literal `durable#1`" and that the durable rows were
  labelled `packages-durable-01` … `packages-durable-08`. The manifest as it stands now has exactly **89** rows
  whose 4th column is `durable#1` (manifest lines 1615–1703), and the first pass's five files are a strict subset
  of them. I did not touch the manifest, per the assignment. I checked its history: `git show HEAD:docs/research/pi/
  manifest.tsv` has the same 89 rows under `durable#1`, and the only difference between HEAD and the working tree
  is the `status` and `note` columns (HEAD has `pending` and an empty note) — so the shard column itself is intact
  and uncorrupted, and the working-tree delta is the lead's own manifest-population pass, not mine. The first
  pass's "Uncertainties" claim about the manifest is therefore stale and I have not carried it forward; the shard
  list I worked from is the manifest's current `durable#1` rows, and every one of them has a note below and a row
  in the ledger.
- **The spec's `ToolControl.terminate` type is stale relative to the changelog.** `packages/durable/docs/spec.md:3035`
  types it as `terminate?: true`, while the 1.4.0 changelog entry says it is now `boolean` and that `false` does not
  end the run. I did not resolve which is normative, and I did not check whether `packages/ai` (outside this shard)
  has caught up.
- **The spec references a pi-ai PR that is not in this clone.** `packages/durable/docs/spec.md:37-39` and `:124-141`
  describe a `SystemMessage` with `sections` / `toolsAdded` / `toolsRemoved` and say "`Message` includes that type
  once the PR lands", so §7.4's system-prompt patch mechanism depends on an API that may not be in the cloned
  `packages/ai`. I did not open `packages/ai` to check.
- **The three storage backends are only partly comparable from the source alone.** `MemoryStorage`,
  `SqliteStorage` and `IndexedDbStorage` implement the same `Storage` contract, but their *failure* semantics differ
  (the SQLite backend drains admitted reads before closing, the IndexedDB one runs multi-store reads in a
  transaction, and the JSONL one poisons itself after a failed write). The conformance suite is what makes them
  comparable, and I read the suite rather than running it.
- **`env/node-watch.ts`'s polling and native paths are only partly traceable from the source.** I read the
  snapshot-diff logic, the FSEvents settle window, the unreliable-filesystem table and the hashing rules, but I did
  not trace every branch of `#reconcileWatchers` (lines ~412–470), where the budget exhaustion and "coverage was
  uncertain" paths live.
- **I did not read `packages/durable/test/` — it is a different shard** (`durable#2` in the manifest). This shard
  covers `packages/durable/src/**` plus the four package-level files, so the *tests* that pin the behaviour described
  above were not consulted.
- **Line numbers are exact for the clone as it stands** (`spec.md` 5618 lines, `scheduler.ts` 2507,
  `codemode.ts` 1044, `README.md` 876, `storage-conformance.ts` 1682). If the lead re-reads a different commit of
  the clone, the anchors will drift.

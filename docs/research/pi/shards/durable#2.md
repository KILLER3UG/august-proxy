# pi / durable#2

## Shard shape

This shard is `packages/durable` — pi's **durable agent harness** — and it is split across the manifest in a way that needs saying up front. The manifest's `durable#2` column currently lists **130 files, and every one of them is a test, an example, a benchmark or a config file**: the whole `packages/durable/test/**` tree (124 files, including 32 numbered runnable examples), the `packages/durable/test-workers/**` tree (6 files: a Cloudflare Durable Object test host that runs the harness inside workerd), and the three package config files. The 29 `packages/durable/src/**` files the *previous* pass of this shard covered (the harness loop, the scheduler, the env, code mode, the document model) are now labelled `durable#1` in the manifest, with their `status` column already set to `read`. I did **not** rewrite the manifest; Part B below keeps those 29 notes so the work is not lost, and the Uncertainties section states the discrepancy in full. What Part A covers is therefore the *test* half of the package, which is where pi states the rules the harness obeys: the agent loop and turn lifecycle (`harness-generation.test.ts`, `harness-tasks.test.ts`), tool definition/execution/validation (`harness-tools.test.ts`, `tools.test.ts`), steering and queued messages (`harness-inbox.test.ts`, `harness-input-entries.test.ts`), session storage / branching / compaction (`harness-compaction.test.ts`, `session-forks.test.ts`, `session-documents.test.ts`), context management (`harness-context.test.ts`), provider/model abstraction (`provider-session-cache-e2e.test.ts`, `system-order-cache-e2e.test.ts`), extension/plugin/skill mechanisms (`harness-registry.test.ts`, `harness-prompt.test.ts`), error and abort handling (`harness-storage-failure.test.ts`, `harness-cancellation-barrier.test.ts`), streaming/presentation (`harness-events.test.ts`, `harness-live-deltas.test.ts`), config (`session-definitions.test.ts`, `harness-support.ts`), and the testing approach itself (four backends, a `workerd` lane, per-process benchmarks).

## Per-file notes

### Part A — the manifest's `durable#2` rows: the test suite, the examples, the storage conformance layer and the benchmarks

#### packages/durable/vitest.config.ts
- **Purpose:** the package's vitest configuration — the gate every test in Part A runs under.
- **Key abstractions:** `defineConfig({ test, resolve, ssr })`; the `source` resolve condition.
- **Data flow:** `resolve.conditions: ["source"]` and `ssr.resolve.conditions: ["source"]` make `@earendil-works/pi-durable` resolve to `src/index.ts` instead of a built `dist/` — so a test never runs against a stale build.
- **Non-obvious design decisions:** `exclude: [...configDefaults.exclude, "test-workers/**"]` — the workerd lane is a *separate* vitest project with its own config (`:11`); `setupFiles: ["./test/setup-document-retention.ts"]` (`:12`).
- **Edge cases / failure handling:** the two aliases (`:17-18`) map the package root and `/testing` subpath to source; a subpath not aliased here would resolve to `dist/`.
- **Surprising:** a test that imports a workspace package resolves to *source*, not to the artifact — the same trick the repo uses at the root (`vitest.base.ts`).

#### packages/durable/vitest.benchmark.config.ts
- **Purpose:** the benchmark lane: `test/**/*.bench.ts` only, verbose reporter.
- **Key abstractions:** `benchmark.include`, `benchmark.reporters`.
- **Data flow:** benchmarks are selected by filename glob (`:7`), so a file named `*.bench.ts` runs only here and never in the correctness lane.
- **Non-obvious design decisions:** the benchmark config sets `resolve.conditions: ["source"]` but **no aliases** (`:11-12`) — the benchmark files import `../src/…` by relative path instead.
- **Edge cases / failure handling:** none of its own; the file exists so `storage.bench.ts` is never mistaken for a test.
- **Surprising:** the *other* benchmark files in this shard (`codemode-bench.ts`, `tool-output-bench.ts`, `nested-tools-bench.ts`) do **not** match `*.bench.ts` — they are standalone `node …` scripts, not vitest benchmarks.

#### packages/durable/tsconfig.build.json
- **Purpose:** the package's build config.
- **Key abstractions:** `paths` mapping `@earendil-works/chord` and `@earendil-works/pi-ai` to the *sibling* packages' built `.d.ts` (`:6-7`).
- **Data flow:** `include: ["src/**/*.ts"]`, `rootDir: "./src"`, `outDir: "./dist"` — the published package is `src/` only; `test/` is never built.
- **Non-obvious design decisions:** `files: ["src/images/photon-wasm.d.ts"]` — the ambient WASM declaration is added *because* `exclude` drops every `*.d.ts` (`:12-13` says so in a comment).
- **Edge cases / failure handling:** `exclude: […, "**/*.d.ts", "src/**/*.d.ts"]` keeps hand-written declarations out of the emit.
- **Surprising:** the build resolves siblings from `dist/`, so the sibling packages must be built first — a different rule from vitest, which uses source.

#### packages/durable/test-workers/worker.ts
- **Purpose:** a Cloudflare Durable Object that hosts a `Harness` the way an application would — the reference host for the workerd lane.
- **Key abstractions:** `TestSession extends DurableObject`, the `Reminder` task, the `HEARTBEAT_MS` constant.
- **Data flow:** the constructor opens the Harness inside `ctx.blockConcurrencyWhile` (`:52`), arms an alarm *before* `resume()` (`:79-80`), and `onWake` re-arms and pushes the wake into `this.wakes` (`:70-74`).
- **Non-obvious design decisions:** the alarm is armed from a **fallback computed before anything can throw** (`:53-56`) — "A fallback before anything can throw: an object whose open or recovery fails is started again"; a failed alarm write calls `ctx.abort("Alarm write failed")` so the object resets (`:73`).
- **Edge cases / failure handling:** the faux provider's script lives in `ctx.storage.kv`, so "a new instance continues the script" across evictions (`:34-35`, `:98-100`); `"hang"` makes the model request wait for an abort (`:142-148`).
- **Surprising:** `advance(ms)` moves the *Harness clock* (not the wall clock) and persists the offset in KV (`:93-96`), so a test can make a sleeping task due without waiting.

#### packages/durable/test-workers/wake.test.ts
- **Purpose:** the three workerd behaviours a serverless host must get right: sleeping through an eviction, recovering a turn cut off mid-stream, and evicting an object that holds idle documents.
- **Key abstractions:** `eventually(stub, check)` (`:13-22`), `evictDurableObject`, `runDurableObjectAlarm`.
- **Data flow:** the test drives the object, then `evictDurableObject(stub)` and `runDurableObjectAlarm(stub)`; the alarm re-arms from `harness.wake()` and `resume()` runs the task (`:102-105`).
- **Non-obvious design decisions:** after the eviction the sleep is *read from storage* and the alarm stays (`:42-48`) — the durable record, not the memory, is the source of truth; the heartbeat alarm is armed *before* the input is admitted (`:69-70`).
- **Edge cases / failure handling:** "Nothing is left to do: the alarm is gone" — the test waits for `getAlarm() === null` (`:59`); the third case asserts the object can be evicted at all, because "Retention timers would keep the object running" (`:98-99`).
- **Surprising:** the recovery case resubmits the **same requestId** and gets the submission admitted before the eviction — the idempotency key is what makes the crash survivable (`:78-79`).

#### packages/durable/test-workers/storage.test.ts
- **Purpose:** runs the shared storage-conformance suite against SQLite *inside a Durable Object*, plus a schema-migration case.
- **Key abstractions:** `registerStorageConformance` from the package's own `/testing` subpath (`:13`).
- **Data flow:** each conformance case gets its own prefixed set of tables (`prefix: conformance${suite++}_`) "next to the ones the object's Harness opened" (`:15-16`).
- **Non-obvious design decisions:** the migration case builds a **version 1** schema with `createSqliteMigrations(schema).slice(0, 1)` and then opens the real storage over it (`:33-37`).
- **Edge cases / failure handling:** the assertion that the *index set* is exactly the five named indexes (`:45-51`) — a migration that added an index would fail.
- **Surprising:** the same conformance suite runs in four backends (memory, sqlite, jsonl, indexeddb) from one shared implementation — the storage contract is written once.

#### packages/durable/test-workers/cloudflare.d.ts
- **Purpose:** hand-written ambient declarations for the slice of the Workers runtime these tests use.
- **Key abstractions:** `declare module "cloudflare:workers"` and `declare module "cloudflare:test"`.
- **Data flow:** none — it is a type-only file.
- **Non-obvious design decisions:** the comment explains the whole file: "full Workers types would conflict with Node's" (`:2-3`).
- **Edge cases / failure handling:** `DurableObjectStorage` is typed as `DurableObjectSqliteStorage` plus the alarm API and a **synchronous** `kv` (`:13`) — the KV is synchronous in a SQLite-backed object, which is why `worker.ts` can read the script without `await`.
- **Surprising:** the file is one of the few places in the repo where an ambient module is declared on purpose rather than avoided.

#### packages/durable/test-workers/vitest.config.ts
- **Purpose:** the workerd vitest project: `cloudflareTest({ wrangler: { configPath: … } })`.
- **Key abstractions:** `plugins: [cloudflareTest(...)]`, `include: ["*.test.ts"]` (`:11`).
- **Data flow:** `root: source(".")` makes the project root the `test-workers/` directory; the aliases resolve the package to `../src/index.ts` (`:15-16`).
- **Non-obvious design decisions:** the config sets `root` explicitly because the project lives *inside* the package (`:9`).
- **Edge cases / failure handling:** three aliases, the third for the `storage/sqlite/cloudflare` subpath (`:17-20`) — a subpath the Node config does not need.
- **Surprising:** `ssr.resolve.conditions: ["source"]` is repeated here, so the workerd lane also runs against source.

#### packages/durable/test-workers/wrangler.jsonc
- **Purpose:** the wrangler config for the test worker: the `SESSIONS` Durable Object binding and a SQLite migration tag.
- **Key abstractions:** `durable_objects.bindings`, `migrations`.
- **Data flow:** `compatibility_date: "2026-10-01"` and `nodejs_compat` (`:4-5`).
- **Non-obvious design decisions:** `new_sqlite_classes: ["TestSession"]` (`:9`) — the object is a *SQLite-backed* Durable Object, which is why the storage adapter is `openDurableObjectSqliteStorage`.
- **Edge cases / failure handling:** none — 10 lines of configuration.
- **Surprising:** the whole Cloudflare lane is 6 files; everything else about the host is in `worker.ts`.

#### packages/durable/test/chat-support.ts
- **Purpose:** the shared fixture for every "chat" test: a faux provider, a registry, live settings and a Harness.
- **Key abstractions:** `chatSetup()`, `openChat(storage, setup, options)`, `allEntries()`, `textOf()`, `waitFor()`, `unanswered()`, `toolsNamed()`.
- **Data flow:** `openChat` opens the Harness with `now: () => setup.now` and `onReport: (error) => setup.reports.push(error)` (`:62-64`), and creates the root with the faux model.
- **Non-obvious design decisions:** `unanswered()` returns a faux step that **never answers** and rejects on the abort signal (`:104-109`) — "the run stays busy until its generation is cancelled"; `waitFor` polls in real time (5 ms) "for waits that span throttle windows and timers" (`:86-87`).
- **Edge cases / failure handling:** `toolsNamed` throws `Tool X is not installed` rather than returning undefined (`:118`).
- **Surprising:** `allEntries` returns entries **oldest first** by reversing the newest-first page (`:72-75`) — every assertion in the suite depends on that ordering.

#### packages/durable/test/harness-support.ts
- **Purpose:** the fixture for registry-level tests: fake tools, message builders and extension installers.
- **Key abstractions:** `tool()`, `openHarness()`, `user()/assistant()/toolResult()/system()`, `describeMessage()`, `addTool/addTask/addHooks/addSection`.
- **Data flow:** each `add*` helper installs a one-item extension and returns an `Installed` that uninstalls it (`:118-121`).
- **Non-obvious design decisions:** `assistant()` builds a complete pi-ai message with a zeroed usage block (`:53-80`) so assertions can compare whole messages; the tool name is derived from the call id (`tool-${id}`) so a result can be matched to its call.
- **Edge cases / failure handling:** `describeMessage` renders a system message as its **section keys only** (`:111`) — the prompt's content is not asserted, only its shape.
- **Surprising:** `addHooks` numbers its extensions (`hooks:${++hookExtensions}`) because the registry refuses duplicate names — a test helper that must dodge a validation rule (`:137-147`).

#### packages/durable/test/session-support.ts
- **Purpose:** the Session-level fixture: a `MemoryStorage` that can be held, crashed and failed at exact points.
- **Key abstractions:** `ControlledStorage` (extends `MemoryStorage`), `openTestSession()`, `documentChanges()`, `createConversation()`, `flush()`.
- **Data flow:** `ControlledStorage.commit` records every batch, optionally waits on a gate, then optionally throws (`:81-95`); `crash()` drops the held commit "so a crash during the held commit: it never reaches storage, and later commits proceed" (`:60-63`).
- **Non-obvious design decisions:** `reopen()` flips the closed flag back (`(this as unknown as {closed:boolean}).closed = false`, `:70-73`) — "as a fresh process would reopen the same database"; `holdFindDocument()` gates *reads* separately from commits (`:54-60`).
- **Edge cases / failure handling:** `mintCount` and `documentReadCount` are counters, not spies — the suite asserts "no read happened" by counting (`:42-43`).
- **Surprising:** the Session is constructed with `new SessionImpl(storage, Date.now, () => 600_000)` (`:129`) — the retention is a parameter, which is why the document-retention suite can pin it.

#### packages/durable/test/task-support.ts
- **Purpose:** the task-level fixture: deferred promises, abort-aware waits and a Harness preloaded with tasks.
- **Key abstractions:** `deferred()`, `aborted(signal)`, `eventually()`, `settled()`, `openTasks()`, `completed()/abortedWith()`, `countingReader()`.
- **Data flow:** `openTasks` installs the tasks as one extension and collects both the report errors and their `ReportInfo` (`:86-95`).
- **Non-obvious design decisions:** `aborted(signal)` rejects with the **signal's reason** (`:33-37`) so the test sees the real abort cause, not a generic error; `eventually` flushes macrotasks 200 times (`:41-47`).
- **Edge cases / failure handling:** `settled(promise)` answers "has this promise settled?" without awaiting it (`:50-62`).
- **Surprising:** `countingReader` counts **live** subscriptions and decrements only on the first unsubscribe (`:120-129`) — it exists to prove the scheduler releases its registry subscription.

#### packages/durable/test/setup-document-retention.ts
- **Purpose:** a vitest setup file that lets the whole suite run with documents evicted immediately after use.
- **Key abstractions:** `setDefaultDocumentRetention` from `src/session/session.ts`.
- **Data flow:** it reads `PI_DURABLE_DOCUMENT_RETENTION_MS` and, if set, calls the setter (`:6-7`).
- **Non-obvious design decisions:** the mechanism exists so `npm run test:evicting` can run the *same* tests under an aggressive retention policy (`:1-3`).
- **Edge cases / failure handling:** a non-numeric value is `Number(...)`-coerced here and validated by the session (the retention suite pins that: "a retention that is not a number of milliseconds as the default, and Infinity as never").
- **Surprising:** a test-only knob that changes a *default* — the kind of global mutation that usually breaks other tests, which is why it is opt-in through an env var.

#### packages/durable/test/heap-retained.ts
- **Purpose:** a heap-snapshot helper for the memory benchmarks.
- **Key abstractions:** `retainedBytes()` using `node:inspector/promises`.
- **Data flow:** it connects an inspector session, takes a heap snapshot, and sums the `self_size` field of every node (`:20-25`).
- **Non-obvious design decisions:** the docstring names the reason for using a snapshot at all: "`heapUsed` after `gc()` also counts what the collector has not compacted yet, which hides a small leak or invents a large one" (`:1-2`).
- **Edge cases / failure handling:** `reportProgress: false` keeps the snapshot small; the chunks are joined and parsed as one JSON (`:16-19`).
- **Surprising:** the file is 26 lines and exists only to make "bytes live objects retain" a *measurable* quantity rather than a guess — it is the yardstick the scheduler-memory and document-cache benchmarks use.

#### packages/durable/test/fixtures/delete-buffer.ts
- **Purpose:** a `--import` preload that removes the Node `Buffer` global, so a module can be tested in a browser-like runtime.
- **Key abstractions:** `Reflect.deleteProperty(globalThis, "Buffer")` (`:2`).
- **Data flow:** the file is loaded *before* the measured module graph (`:1`).
- **Non-obvious design decisions:** the reason is stated in the comment: "Preloaded before the measured module graph so modules observe a browser-like global without Node's Buffer" — the ordering is the mechanism, not the deletion.
- **Edge cases / failure handling:** the deletion is permanent for that process, which is why the test spawns a child (see `env-truncate.test.ts`).
- **Surprising:** a two-line fixture that exists to *prove* the byte-length code does not secretly depend on `Buffer`.

#### packages/durable/test/fixtures/utf8-byte-length-without-buffer.ts
- **Purpose:** the child process the Buffer-less truncation test drives: it prints the byte lengths and the truncation result as JSON.
- **Key abstractions:** `utf8ByteLength`, `truncateHead` from `src/truncate.ts` (`:1`).
- **Data flow:** the inputs arrive as a JSON argument (`process.argv[2]`), the results go to stdout as one JSON line (`:3-11`).
- **Non-obvious design decisions:** the output includes `bufferAvailable: "Buffer" in globalThis` (`:7`) so the parent can *assert* the global really was gone.
- **Edge cases / failure handling:** `JSON.parse(process.argv[2] ?? "[]")` tolerates a missing argument.
- **Surprising:** the child imports the *source* path (`../../src/truncate.ts`), matching the parent's `--conditions=source` resolution.

#### packages/durable/test/examples/00-conversation.ts
- **Purpose:** the first example: a Session storing conversations, entries, tasks and documents.
- **Key abstractions:** `createSession`, `MemoryStorage`, `BACKGROUND_CONTEXT`.
- **Data flow:** one `session.commit((tx) => tx.createConversation(...))` creates a conversation; the comment states the rule — "All writes happen inside session.commit() … everything it writes is saved together when the callback returns, or discarded if it throws" (`:14-17`).
- **Non-obvious design decisions:** `ownership: { kind: "ownerless" }` is explained in-line: "no task created this conversation" (`:17`).
- **Edge cases / failure handling:** `BACKGROUND_CONTEXT` means "never cancel" (`:11-12`) — every Session call takes a context, used for cancellation.
- **Surprising:** the example is runnable with `node --conditions=source --experimental-strip-types`, i.e. the examples are executable documentation, not tests.

#### packages/durable/test/examples/01-documents.ts
- **Purpose:** a document next to the transcript, and the difference between `snapshot()` and `snapshotAsOf()`.
- **Key abstractions:** `defineDoc<{text:string}>`, `tx.doc(Notes, chat.id)`, `session.snapshotAsOf`.
- **Data flow:** each commit appends an entry and then mutates the document; `snapshotAsOf(Notes, chat.id, entry.id)` reads the value that was saved *in the same commit as that entry* (`:40-44`).
- **Non-obvious design decisions:** `history: "rewindable"` is what makes `snapshotAsOf` possible — "keeps old values readable, so you can ask what the document looked like when a particular entry was written" (`:10-12`).
- **Edge cases / failure handling:** `fork: "asOf"` is declared here and explained as "a fork starts with the value these notes had at the fork entry" (`:20`).
- **Surprising:** `tx.doc()` returns an **editable copy** — plain assignments to it are saved when the commit finishes (`:26-27`).

#### packages/durable/test/examples/02-forks.ts
- **Purpose:** forking a conversation and showing that the fork is independent.
- **Key abstractions:** `tx.forkConversation(chat.id, entryId, …)`, `tx.scanEntries`.
- **Data flow:** the fork "sees the parent's transcript up to that entry" (`:40-41`); `scanEntries` pages newest-first.
- **Non-obvious design decisions:** each document follows **its own** `fork` setting — Notes uses `asOf`, so the fork starts with the notes value from the fork entry (`:31-34`).
- **Edge cases / failure handling:** the fork's copy is independent: editing it leaves the parent unchanged (`:49-54`).
- **Surprising:** the example prints the fork transcript to show that "goodbye" (a later parent entry) is *not* visible in the fork — the fork is a point in time, not a copy.

#### packages/durable/test/examples/03-owned-conversations.ts
- **Purpose:** a background task that owns a child conversation, plus a registry document that maps names to conversations.
- **Key abstractions:** `defineTask`, `defineDoc` with `fork: "initial"`, `tx.createTask(…, { ownership, background: true })`.
- **Data flow:** the supervisor task, the child conversation and the registry entry are all created **in one commit** — "so after a crash either all of them exist or none do" (`:12-13`).
- **Non-obvious design decisions:** `background: true` means "the task is side work: waiting for the main conversation to finish does not wait for it" (`:44-45`); the registry uses `fork: "initial"` so "a child doesn't inherit its parent's list of agents" (`:27-28`).
- **Edge cases / failure handling:** the child records that it belongs to the supervisor, and the task was created in the *same* commit, "which is allowed" (`:52-53`).
- **Surprising:** the `requestId` is a fixed name (`researcher:first-message:${supervisorId}`) so "a retry after a crash cannot deliver it twice" (`:56-58`).

#### packages/durable/test/examples/04-chord-state.ts
- **Purpose:** exposing a durable document through Chord as a live, subscribable state.
- **Key abstractions:** `session.documentState(Notes, chat.id, context)`, `state.subscribe(...)`, `state.dispose()`.
- **Data flow:** the state is a hydrated read-only Chord state bound to the current concrete incarnation; the subscription prints each delivery's kind, sequence and value (`:29-31`).
- **Non-obvious design decisions:** "documentState() never creates a document" (`:25-26`) — it returns `undefined` for an absent one, and the example throws in that case (`:28`).
- **Edge cases / failure handling:** the subscription is stopped (`stopNotes()`) and the state disposed (`:35-36`) — both are explicit, because a live state holds the document's incarnation.
- **Surprising:** the example makes the Chord *delivery* vocabulary visible (`delivery.kind`, `delivery.sequence`) — the same vocabulary the UI layer consumes.

#### packages/durable/test/examples/05-watches.ts
- **Purpose:** serializing asynchronous document work with a watch.
- **Key abstractions:** `session.watchDoc(Notes, chat.id, context)`, `watch.start(cb)`, `watch.stop()`.
- **Data flow:** the watch starts from one stable acquisition revision; the callback receives `(value, ops, deliveryContext)`.
- **Non-obvious design decisions:** the comment states the two rules: "Slow callbacks never overlap; exact committed frames buffer, with a full-value reset after 100" (`:25-26`).
- **Edge cases / failure handling:** `watchDoc` returns `undefined` for an absent document and the example throws (`:28`).
- **Surprising:** the watch is *asynchronous* — the example awaits a promise resolved by the callback (`:30-35`) rather than reading the value after the commit.

#### packages/durable/test/examples/06-harness.ts
- **Purpose:** opening a Harness with a registry of extensions and reading the resolved agent.
- **Key abstractions:** `defineTool`, `defineExtension`, `createRegistry`, `Harness.open`, `AgentDoc`.
- **Data flow:** the registry holds *this process's code* and "Nothing in the registry is saved" (`:21-22`); `harness.root(context, { agent, init })` creates the root "and whatever `init` writes, all in one commit" (`:46-49`).
- **Non-obvious design decisions:** the root conversation always has ID 1, and later calls "return it and ignore both options" (`:46-48`).
- **Edge cases / failure handling:** the stored choices are **names**; `agent()` resolves them against the registry (`:57-58`).
- **Surprising:** the tool's `execute` returns `{ output: [{ type: "text", text }] }` — the tool-result content is a *list of typed blocks*, not a string.

#### packages/durable/test/examples/07-configuration.ts
- **Purpose:** per-conversation agent choices versus Harness-wide settings, and the extension/tool selection model.
- **Key abstractions:** `HarnessSettings` with getters, `root.configure({...})`, `AgentDoc`, `ToolRegistration & { snippet? }`.
- **Data flow:** `configure()` "stores choices in the conversation's `pi.agent` document, one commit per call" and passes extensions and tools **as objects, stored by name**, "so a typo cannot slip in" (`:68-70`).
- **Non-obvious design decisions:** settings are "Harness-wide run policy, read at every use and never stored", and a getter makes a value live (`:50-51`); `null` clears a stored field back to the host default (`:83`).
- **Edge cases / failure handling:** "Stored names outlive the code" — uninstalling the extension leaves the conversation *selected*, and requests just stop offering its tools until it is back (`:87-89`).
- **Surprising:** an app can attach its own metadata to a tool (the `snippet`) and a section can render it — the tool surface is extensible by the host, not just by the package (`:22-43`).

#### packages/durable/test/examples/08-harness-conversations.ts
- **Purpose:** conversation handles, typed entries, created conversations and forks.
- **Key abstractions:** `defineEntry<{from:string}>("message")`, `harness.createConversation`, `root.fork(entryId, …)`.
- **Data flow:** handles are stateless — "compare them by id. They bind commits to their conversation" (`:17-18`); an entry token types an entry kind's `data` (`:28`).
- **Non-obvious design decisions:** "A fork starts with the agent the parent had at the fork entry" (`:31-32`), and `createConversation`/`fork` apply `agent` and run `init` in the creating commit.
- **Edge cases / failure handling:** `Message.is(hello)` is the narrowing guard for a typed entry (`:28`).
- **Surprising:** `root.fork(hello.id, …)` forks at an *entry*, not at a timestamp — the fork point is a transcript position.

#### packages/durable/test/examples/09-context.ts
- **Purpose:** the transcript-to-model-context derivation, with every rule of it exercised in one program.
- **Key abstractions:** `conversation.context(context)` → `{ entries, messages, head }`, `edits`, `head: "self"`.
- **Data flow:** the comment at `:16-23` is the contract: an entry with `head` starts a new context; `edits` replace or omit what an earlier entry contributes; aborted/error/deferred assistant messages are not sent; tool results are sent right after their call; a call without a result gets a synthesised error result.
- **Non-obvious design decisions:** the example deliberately stores an out-of-order tool result (`result b` before `result a`, `:80-82`) to show the context re-orders them "in call order".
- **Edge cases / failure handling:** an `edit` entry replaces an earlier user message (`:84-98`) and a `note` entry with no model contributes nothing to the messages (`:99`).
- **Surprising:** a fork taken at the tool call has no results yet, and `context()` **fills them in** (`:108-110`) — the same synthesis the context module performs.

#### packages/durable/test/examples/10-registry-reload.ts
- **Purpose:** reloading extension code, wrapping a tool by name, and uninstalling.
- **Key abstractions:** `registry.install` (replaces by name), `wrapTool(read, fn)`, `registry.uninstall`.
- **Data flow:** "Reloading is installing a new object with the same name: it replaces the old one in place, in one publication, so no conversation ever sees it missing" (`:28-30`).
- **Non-obvious design decisions:** "A task phase that already started keeps the snapshot it took; the next phase uses the new code" (`:30`); the wrap "applies where the wrapping extension is selected, and survives reloads of the wrapped tool" (`:34-35`).
- **Edge cases / failure handling:** uninstalling removes the extension's code; conversations that select it stop getting it.
- **Surprising:** the wrap is expressed over the *tool object* but applied by **name**, so it keeps working when the tool is reloaded (`:36-39`).

#### packages/durable/test/examples/11-extension-state.ts
- **Purpose:** an extension that keeps its own per-conversation document, written by a tool and shown by a section.
- **Key abstractions:** `defineDoc` (`Todos`), `section("todos", render)`, `api.commit`, `input.read.snapshot`.
- **Data flow:** the tool writes the document inside a commit (`:43-45`); the section reads it before every request and returns `undefined` when it is empty (`:51-54`).
- **Non-obvious design decisions:** "Nothing needs to create it up front: `tx.doc()` creates it on first write, and the section treats a missing document as an empty list" (`:33-34`).
- **Edge cases / failure handling:** the section's `render` is async and takes a render context, so it can read committed state without blocking the turn (`:52`).
- **Surprising:** the first system message only announced the tool; the list appeared in the *next* request's system prompt — the section is rendered per request, not stored.

#### packages/durable/test/examples/12-tasks.ts
- **Purpose:** a durable task as a two-phase state machine, and the intent/effect/outcome discipline.
- **Key abstractions:** `defineTask<Input, Checkpoint, Result>`, `runtime.commit`, `runtime.sleepUntil`, `harness.waitForTask`.
- **Data flow:** the comment states the pattern: "save what you are about to do, do it, then save the result. A crash between doing and saving reruns that step, so the step must be safe to repeat" (`:10-14`) — the fake payment service ignores a repeated key.
- **Non-obvious design decisions:** the phase callback's return value *is* the next checkpoint or the terminal outcome, "and that state is saved in the same commit as everything else the callback wrote" (`:21-23`).
- **Edge cases / failure handling:** the `abort` handler "runs instead of the phases after `harness.abortTask()`; it decides the outcome" (`:41-42`).
- **Surprising:** "Nothing runs until `resume()` or a call that waits for progress, such as `waitForTask()`" (`:48-49`) — a committed task is inert until something asks for progress.

#### packages/durable/test/examples/13-recovery.ts
- **Purpose:** close, reopen, and continue where a task stopped — the crash-recovery story end to end.
- **Key abstractions:** `runtime.memo(name, value)`, `runtime.sleepUntil`, SQLite storage on disk, `harness.getTask`.
- **Data flow:** the task writes a **memo before the effect** so a rerun does not print the tick twice (`:28-35`); the sleep is stored with the checkpoint, "so the task holds no invocation meanwhile" (`:37-40`).
- **Non-obvious design decisions:** the first Harness is closed right after tick 2 is printed and before its checkpoint is saved — "the same situation as a crash between the effect and saving its outcome" (`:60-62`).
- **Edge cases / failure handling:** a second Harness that never resumes is used to *read* the saved record without running anything (`:78-82`).
- **Surprising:** on reopen, "Tick 2 runs again because its outcome was never saved, but its memo says it was already printed" (`:85-87`) — the memo, not the checkpoint, is the idempotency key.

#### packages/durable/test/examples/14-chat.ts
- **Purpose:** one chat turn end to end with a faux model.
- **Key abstractions:** `root.submit({type:"input", content})` → `Submission`, `submission.wait(context)`, `AssistantEntry`.
- **Data flow:** "submit() durably admits user input and returns a Submission. The built-in `pi.generation` task prepares the system prompt from the agent's sections, calls the model, and appends the answer" (`:27-30`).
- **Non-obvious design decisions:** the section is registered with `{ tag: false }` so the text is sent as is (`:21`).
- **Edge cases / failure handling:** the transcript is printed as entry *kinds* in order: "the user input, the positional system prompt, and the answer" (`:39-44`).
- **Surprising:** the answer is fetched by `tx.entry(AssistantEntry, settled.answer)` — the submission carries the *entry id*, and the entry is read separately.

#### packages/durable/test/examples/15-system-prompt.ts
- **Purpose:** system-prompt sections, a section wrapper, per-conversation instructions, and the environment's `cwd`.
- **Key abstractions:** `section(key, render, {tag})`, `wrapSection("preamble", fn)`, `HarnessOptions.env`.
- **Data flow:** "Pico stores no prompt state. Before each model request, the sections of the conversation's selected extensions render the desired prompt, and only the difference to what the model already saw is appended to the transcript as a `pi.system` entry" (`:25-28`).
- **Non-obvious design decisions:** a subagent deselects AGENTS.md and gets its own instructions, "rendered last as the `instructions` section" (`:63-64`).
- **Edge cases / failure handling:** `tag: false` sends the text as is; by default a section is wrapped in `<key>…</key>` (`:32-33`).
- **Surprising:** changing the conversation's `cwd` appends *only the change* to the system prompt — the next request's system entries show the new cwd and nothing else (`:88-91`).

#### packages/durable/test/examples/16-real-model.ts
- **Purpose:** the same harness against a real OpenAI model, streaming the answer from the live document.
- **Key abstractions:** `openaiProvider()`, `harness.watchDoc(LiveDoc, root.id, context)`, `LiveDoc`.
- **Data flow:** "While the answer streams, generation commits throttled partials to the conversation's `pi.live` document. Watching that document streams the answer; the watch sees only committed values" (`:21-23`).
- **Non-obvious design decisions:** the print helper only writes the *new* suffix (`if (text.length <= printed.length || !text.startsWith(printed)) return`, `:43-47`) so a repeated or rewound value cannot corrupt the output.
- **Edge cases / failure handling:** "The last throttle window may not have been committed as a partial; the answer entry has the rest" — so the final answer is read from the entry and printed too (`:57-63`).
- **Surprising:** the example degrades gracefully when `OPENAI_API_KEY` is unset: it prints "skipped" and exits (`:24-25`).

#### packages/durable/test/examples/17-coding-tools.ts
- **Purpose:** a coding-agent turn — read, edit, bash — on JSONL storage, with a hook that times a huge `cat`.
- **Key abstractions:** `CodingTools`, `hook(ToolTask, { beforeTool, afterTool })`, `openNodeJsonlStorage`.
- **Data flow:** the faux provider plays four tool-calling answers and then a final answer (`:36-42`); the hook times the `cat /tmp/1gb.txt` call (`:45-62`).
- **Non-obvious design decisions:** "Each tool call runs as a durable `pi.tool` task owned by the generation, which waits for them and continues the run with the next generation" (`:78`).
- **Edge cases / failure handling:** the `cat /tmp/1gb.txt` call "ends in an error result" when the file does not exist — the example says so in its header (`:1-3`).
- **Surprising:** "Tools reach files and processes only through the environment the Harness builds for each call" (`:64-65`) — there is no ambient filesystem access in a tool.

#### packages/durable/test/examples/18-print.ts
- **Purpose:** print mode — one prompt, one answer, like `pi -p`.
- **Key abstractions:** `root.submit` + `submission.wait`, `createReadTool()`, `createBashTool()`.
- **Data flow:** the host awaits **its own** Submission, "not global idle" (`:1-2`).
- **Non-obvious design decisions:** the same script works with a real model or a scripted faux one (`:19-29`) — a one-line switch on the presence of `OPENAI_API_KEY`.
- **Edge cases / failure handling:** an unanswered submission prints `unanswered: <reason>` and sets `process.exitCode = 1` (`:49-52`).
- **Surprising:** the exit code is the *only* failure signal — there is no assertion framework here, only the submission's status.

#### packages/durable/test/examples/19-json.ts
- **Purpose:** JSON mode — stream one prompt's run as JSON lines, in two vocabularies.
- **Key abstractions:** `watchEvents(harness, root.id, context)` (the agent events) and `root.watch(context)` (the raw view frames).
- **Data flow:** `--events` prints the snapshot then each event batch; `--ops` prints the view then one line per commit's ops (`:82-94`).
- **Non-obvious design decisions:** the watch is attached **before** submitting, "so the stream covers the whole run" (`:80`); a zero-timeout sleep before stopping lets the last batch reach the listener (`:99-100`).
- **Edge cases / failure handling:** the storage location is printed to stderr and the files are **not** deleted (`:4-5`).
- **Surprising:** the two modes are the two vocabularies the rest of pi speaks — the experimental agent events and the raw document ops — and one program exercises both.

#### packages/durable/test/examples/20-inbox.ts
- **Purpose:** what happens to submissions while a conversation is busy: follow-ups, steers, writes, rejection and withdrawal.
- **Key abstractions:** `settings.followUpMode: "all"`, `whenBusy: "steer" | "reject"`, `InboxDoc`, `Submission.abort`.
- **Data flow:** the first answer is held so the conversation stays busy while four more submissions are made (`:13-20`, `:34-40`).
- **Non-obvious design decisions:** "The first answer ends the run at a final boundary: the write is placed first, then the steer and the follow-up, which start the next run together" (`:54-55`).
- **Edge cases / failure handling:** `whenBusy: "reject"` refuses with `ConversationBusy` instead of queueing (`:41-44`); a queued submission can be withdrawn until a boundary places it (`:45-46`).
- **Surprising:** `followUpMode: "all"` places *every* queued follow-up at once instead of one per run — the same setting pi's own settings schema exposes.

#### packages/durable/test/examples/21-late-join.ts
- **Purpose:** a client that attaches while a run is already underway.
- **Key abstractions:** `root.viewState(context)` (structural client) and `watchEvents` (event client).
- **Data flow:** the joiner gets "the current state first … and then only what changes after that" (`:1-2`); the event client's snapshot carries the same state and later events apply on top (`:71-72`).
- **Non-obvious design decisions:** the tool prints a line every 100 ms so the joiner attaches mid-tool (`:23`, `:55-56`).
- **Edge cases / failure handling:** the event client reconstructs the output from `tool_execution_update` ops — `"set" in event.output ? event.output.set : output.slice(trimStart) + append` (`:81-85`).
- **Surprising:** the *same* running tool is visible to both clients — the view's live slot and the event stream — from two different surfaces of the same committed state.

#### packages/durable/test/examples/22-subagent-foreground.ts
- **Purpose:** a subagent as a *tool*: the parent's call creates a child conversation it owns, runs one task there and returns the child's answer.
- **Key abstractions:** `api.commit`, `api.details({conversationId})`, `replay: "safe"`, `configure(tx, created.id, …)`.
- **Data flow:** the child is owned by the tool call's task, "so aborting the call aborts the child, and the call finishes only once the child's work is done" (`:50-51`); the ownership record makes a rerun find the child instead of creating another (`:53-55`).
- **Non-obvious design decisions:** "Safe to rerun after a crash: a rerun finds the child it already created and the submission it already made" (`:46-47`) — the `requestId` and the ownership record are the two idempotency keys.
- **Edge cases / failure handling:** the child is configured to *remove* the subagent extension, "so the child is not offered this tool" (`:58-59`) — no recursive delegation.
- **Surprising:** the UI part of the example attaches to the child **through the parent's events** (`event.details.conversationId`) and indents its events under the call — the nesting is a rendering decision, not a transport one (`:113-125`).

#### packages/durable/test/examples/23-subagent-background.ts
- **Purpose:** persistent background subagents — spawn, message, stop, list — that survive a restart.
- **Key abstractions:** the `Subagents` document (`fork: "initial"`), the `Anchor` background task, the `Reporter` background task, `replay: "unsafe"`.
- **Data flow:** a reporter delivers one message to a subagent, waits for the answer and reports back to the main agent; "One commit decides the report and records the answer as delivered, so a restart does not decide again" (`:93-94`).
- **Non-obvious design decisions:** a subagent's conversation is owned by an **anchor** — a background task that finishes at once — because "A subagent must outlive the main agent's turns" (`:57-61`); the anchor is "a boundary: the main agent's Esc and idle waits stop there" (`:60-61`).
- **Edge cases / failure handling:** the tool declares `replay: "unsafe"` because "repeating `stop` could stop newer work" (`:145-146`); an unanswered subagent is reported as `[subagent X failed: reason]`, and an *aborted* one is not reported at all (`:96-99`).
- **Surprising:** the example closes the Harness while a subagent is working and reopens it, and the pending report still arrives (`:351-360`) — the reporter is a durable task, not a callback.

#### packages/durable/test/examples/24-child-tasks.ts
- **Purpose:** a task that owns child tasks, waits for them with `failFast`, and survives a restart.
- **Key abstractions:** `runtime.commit` with `{ status: "waiting", checkpoint, on, policy: "failFast" }`, `runtime.outcomes(ids)`, `harness.taskGraph()`.
- **Data flow:** the checkout creates one payment task per card in a single commit and then waits on all of them (`:71-78`).
- **Non-obvious design decisions:** "With `failFast`, the first payment that fails aborts the others; the checkout itself is not aborted and decides its outcome once every payment is done" (`:63-64`).
- **Edge cases / failure handling:** each payment **undoes its own effect** when aborted (a refund) and the checkout's abort handler runs "only after every payment is done, so the refunds have already happened" (`:54`, `:93`).
- **Surprising:** the example prints the live task graph as a tree while the payments run (`:106-116`) — the graph is a first-class view, not a debug dump.

#### packages/durable/test/examples/25-compaction.ts
- **Purpose:** a long chat whose older messages are summarized, with a 3000-token fake window.
- **Key abstractions:** `settings.compaction` (`reserveTokens`, `keepRecentTokens`, `backgroundTokens`), `harness.compact(instructions)`, `CompactionEntry`, `LiveDoc.compactions`.
- **Data flow:** "Generation blocks to compact above 3000 − 1000 = 2000 tokens and starts a background compaction above 2000 − 800" (`:46-47`).
- **Non-obvious design decisions:** the summarisation request is detected by its prompt containing "summarization" (`:27-28`) — the fake model is told apart from the chat model by the request, not by a flag.
- **Edge cases / failure handling:** a provider overflow is simulated once (`stopReason: "error", errorMessage: "prompt is too long"`, `:31-34`) and generation compacts and retries it once (`:95-100`).
- **Surprising:** the manual compaction's summary is *ready first* and waits in the inbox, and is placed right after the answer that was still being written (`:78-92`) — a summary can outlive the run that produced it.

#### packages/durable/test/examples/26-coding-agent.ts
- **Purpose:** a small coding agent: built-in coding tools, a cwd-aware prompt, live settings, and an env that follows the conversation's directory.
- **Key abstractions:** `HarnessSettings` with getters, `HarnessOptions.env` as a function of `{cwd}`, `CodingTools`.
- **Data flow:** "The Harness calls this for every tool call and request with the conversation's `cwd`, so changing a conversation's directory needs no restart" (`:52-53`).
- **Non-obvious design decisions:** the settings getters make every Harness read see the current file; "nothing is copied or stored" (`:40-41`).
- **Edge cases / failure handling:** the example reads the *last* tool result out of the transcript to prove the bash ran in the expected directory (`:65-69`).
- **Surprising:** the same `configure({ cwd })` call that changes the working directory also changes what the `cwd` section renders — the prompt and the environment move together.

#### packages/durable/test/examples/27-plan-mode.ts
- **Purpose:** switching a conversation into a read-only planning mode and back.
- **Key abstractions:** `configure({ extensions: { add: [Plan] }, tools: [read, submitPlan] })`, `control: { terminate: true }`.
- **Data flow:** the plan tool writes the plan into the extension's own document and asks to terminate (`:43-48`).
- **Non-obvious design decisions:** "Plan mode is a change to the conversation's agent: select the plan extension and offer only reading and submitting. Clearing both returns to the host's default selection and every tool" (`:59-60`).
- **Edge cases / failure handling:** the plan extension is *installed* but only `CodingTools` is selected by default — "conversations opt into plan mode" (`:86-87`).
- **Surprising:** the model sees each switch as a system-prompt change in its transcript, with `toolsAdded`/`toolsRemoved` on the system message (`:103-113`) — a mode change is a prompt change, not a hidden flag.

#### packages/durable/test/examples/28-reviewer.ts
- **Purpose:** a reviewer agent beside the main one — cheaper model, a review role, a review loop, read-only tools, its own checkout.
- **Key abstractions:** `hook(GenerationTask, { onYield })`, `section("role", …)`, a per-conversation `agent` selection.
- **Data flow:** the reviewer is a separate conversation with its own model, extensions, tool list and `cwd` — "A restart keeps all of it" (`:77-78`).
- **Non-obvious design decisions:** the review loop is a hook: every answer that still has findings gets a second pass, and the loop ends on the exact phrase "No further findings." (`:31-44`).
- **Edge cases / failure handling:** the reviewer's tools are only the read tool (`:85`), so it *cannot* edit — the role is enforced by the tool set, not by the prompt.
- **Surprising:** the reviewer works in its own directory — "in practice a `git worktree add`" (`:48`) — the isolation is a directory, per conversation.

#### packages/durable/test/examples/29-sandbox-per-conversation.ts
- **Purpose:** one sandbox per conversation, looked up from a per-conversation document.
- **Key abstractions:** `defineDoc` `Sandbox` (`fork: "initial"`), `env: async ({ conversationId, read }, ctx) => …`.
- **Data flow:** the env function is called for **every** tool call and reads the conversation's sandbox path (`:49-52`).
- **Non-obvious design decisions:** "Committed reads only; a conversation without a sandbox gets no environment, so its tools fail cleanly" (`:48`).
- **Edge cases / failure handling:** the sandbox path is assigned in the *creating commit* via `init` (`:65-67`), so a conversation never exists without its sandbox.
- **Surprising:** `fork: "initial"` means "a fork gets no sandbox until the app assigns one" (`:18`) — a forked conversation is untrusted by default.

#### packages/durable/test/examples/30-tool-override.ts
- **Purpose:** replacing a tool for some conversations and decorating whichever tool wins.
- **Key abstractions:** `wrapTool(createBashTool(), fn)`, `createBashTool({ commandPrefix })`, `settings.extensions`.
- **Data flow:** a bash with the same name, "where selected after CodingTools, it replaces CodingTools' bash in place" (`:28-29`).
- **Non-obvious design decisions:** "Wrappers never capture a base tool, so reloading either bash keeps it" (`:34`); the wrapper decorates the *winner* by name, not by object.
- **Edge cases / failure handling:** the timing wrapper records every call in a `finally` (`:42-48`), so a failing call is still timed.
- **Surprising:** the override is a *selection* (`extensions: { add: [Venv] }`) — the extension is installed for everyone but selected only by the conversations that want it (`:86`).

#### packages/durable/test/examples/31-reload-and-restart.ts
- **Purpose:** reloading an extension *while a call runs*, then restarting the process.
- **Key abstractions:** a `gate` promise that holds the running call; a registry rebuilt per process.
- **Data flow:** the registry is replaced mid-call (`registry.install(loadVersioned("v2"))` at `:72`) and the running call still answers `v1` (`:75`).
- **Non-obvious design decisions:** "Running work finishes on the code it started with; stored choices are names, so they survive a restart and bind to whatever code the new process installs" (`:1-3`).
- **Edge cases / failure handling:** after the restart, before the extension is installed, the conversation's tool list is **empty** — and once `v3` is installed, the tools appear without any configuration (`:80-87`).
- **Surprising:** the stored selection is a *name*; a conversation selects "versioned" and binds to whatever that name means in the current process.

#### packages/durable/test/codemode-bench.ts
- **Purpose:** measures the overhead code mode adds over plain nested tool calls.
- **Key abstractions:** `CodemodeSandbox`, `createCodemodeTool`, `api.executeTool`.
- **Data flow:** one model-issued call makes N calls of an `echo` tool, either through a code-mode script or through `api.executeTool`, sequentially or in parallel; commits are counted by subscribing to the Harness (`:69-71`).
- **Non-obvious design decisions:** the comparison is against a tool doing the *same* nested calls, so the delta is the harness's, not the script's (`:29-42`).
- **Edge cases / failure handling:** the `plain` tool declares `replay: "safe"` (`:33`) — the benchmark's calls are replayable, like the code-mode ones.
- **Surprising:** the benchmark reports **commits per call** next to the milliseconds — the commit count is the durable cost, and it is the number that scales badly.

#### packages/durable/test/document-append-bench.ts
- **Purpose:** the cost of appending to a list, one commit per item, in two shapes.
- **Key abstractions:** `defineDoc` with an array, `defineDocFamily` with one member per item.
- **Data flow:** the array version pushes into one document; the family version writes one member document per item (`:36-39`).
- **Non-obvious design decisions:** the stated law: "An append costs one copy of the array for the next immutable value; the family's cost stays flat" (`:4-5`).
- **Edge cases / failure handling:** none — it is a measurement program.
- **Surprising:** this is the decision behind the journal-shaped storage in pi: a family of one-member documents is O(1) per append where an array is O(n).

#### packages/durable/test/codemode-checkpoints.test.ts
- **Purpose:** the checkpoint policies of the built-in code-mode documents.
- **Key abstractions:** `NestedCallDoc`, `CodemodeRunDoc`, `CodemodeJournalDoc`, `CodemodeStoreDoc`.
- **Data flow:** the store is written 65 times; after 64 deltas the next commit takes a **base** (`:28-44`).
- **Non-obvious design decisions:** the task-scoped documents "stay as deltas until their task retires" (`:7-12`) — `checkpointWhen` is asked with `{deltasSinceBase: 1000}` and returns false.
- **Edge cases / failure handling:** the base does not change historical reads: `snapshotAsOf` at the 32nd entry still returns `counter: 32` (`:45-47`), and a fork at that entry inherits it (`:48-52`).
- **Surprising:** the checkpoint predicate is *not* a delta-count bound — it is a "is anything running" predicate; the comment in `live.ts` explicitly forbids adding a delta-count bound.

#### packages/durable/test/codemode-describe.test.ts
- **Purpose:** the code-mode prompt surface: the tool description, the section's tool catalogue and the budget.
- **Key abstractions:** `codemodeDescription`, `codemodeSection`, `CodemodeNamespace`.
- **Data flow:** the section is rendered from the conversation's **callable** tools into the `pi.system` entry (`:68-98`).
- **Non-obvious design decisions:** the tool description is constant for every conversation (`:24-31`) — only the *section* changes with the tools; a deferred tool is found with `searchTools()`, not listed (`:86-87`).
- **Edge cases / failure handling:** a namespace whose tools were all dropped is labelled "(some tools not listed)" (`:52`); with no callable tools the section is omitted entirely (`:55`).
- **Surprising:** the code-mode tool's declaration carries a **grammar** for constrained sampling (`{ type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } }`, `:93-96`) — pi hands the model a syntax constraint where the provider supports one.

#### packages/durable/test/codemode-models.test.ts
- **Purpose:** the `models.*` namespace available to code-mode scripts.
- **Key abstractions:** `models.getModelOfType`, `models.classify`, `models.generateImages`, `createProvider` with `classifiers` and `images`.
- **Data flow:** a script's `models.classify(...)` becomes a call of the internal tool `pi.codemode.models.classify`, which runs as a nested durable call and is **counted once, under the internal tool** (`:170-175`).
- **Non-obvious design decisions:** the catalog a script sees has **no headers** (`"headers" in one` is false, `:152`) and a model is resolved by provider and id only; the internal tools are hidden from the script's own listings (`ALL_TOOLS` and `searchTools` find none, `:164-168`).
- **Edge cases / failure handling:** a bad classifier context is rejected **before any request** — `calls.classify` stays 0 (`:204`); a failed model call resolves with its result rather than throwing (`:177-193`).
- **Surprising:** at most **four** model calls run at once inside a script (`:207-220`), and a call that waited for a slot after the script ended is never started (`:222-251`).

#### packages/durable/test/codemode.test.ts
- **Purpose:** the durable code-mode tool: journalling, replay, divergence detection and the result format.
- **Key abstractions:** the code-mode journal, the sandbox fingerprint, `CODEMODE_MODULE_VERSION`.
- **Data flow:** "runs a script that calls tools as nested calls, and journals each result before delivering it" (`:198`); a restart replays the journal so finished calls are not run again (`:212`).
- **Non-obvious design decisions:** the replay is *strictly checked* — a resumed script that makes a different number of calls, calls a global with other arguments, or ends where it went on before **ends the call** rather than continuing (`:274-395`); results are replayed "in the order they arrived, not the order the calls were made" (`:229`).
- **Edge cases / failure handling:** "refuses to resume when the sandbox's fingerprint or the code mode version changed" (`:820`); a script that times out across a restart admits no new calls (`:841`).
- **Surprising:** the script's **clock and randomness** are kept across a restart (`:259`) — a deterministic sandbox, so a replay is reproducible.

#### packages/durable/test/env-line-scan.test.ts
- **Purpose:** the byte-exactness of the streaming decoder and the line scanner.
- **Key abstractions:** `StreamDecoder`, `LineScanner`, a seeded PRNG and a fixed set of byte "pieces" (`:17-31`).
- **Data flow:** 5000 random files are fed in random chunk sizes; the decoded text must equal `new TextDecoder().decode(file)` exactly (`:52-65`, `:69-99`).
- **Non-obvious design decisions:** the corpus includes invalid and truncated UTF-8 sequences (`0xff`, `0x80`, a cut `0xf0 0x9f`) so the property is tested against *malformed* input too (`:28-30`).
- **Edge cases / failure handling:** the regression named in the comment — "Node's streaming TextDecoder with BOM handling dropped this U+FEFF, which follows an invalid sequence" (`:43`) — is pinned as its own test (`:44-50`).
- **Surprising:** the scanner keeps a **second decoder** for the first line so `firstLineBytes` is exact even when the selection is huge — the property test asserts it for every seed (`:91-92`).

#### packages/durable/test/env-node-conformance.test.ts
- **Purpose:** runs the shared environment conformance suite against `NodeExecutionEnv`, twice.
- **Key abstractions:** `registerEnvConformance` from `src/testing/index.ts`.
- **Data flow:** the suite is registered once with the default watcher and once with `{ watch: { mode: "polling", pollIntervalMs: 100 } }` (`:33-60`) — the same contract, two watcher strategies.
- **Non-obvious design decisions:** on Windows the suite is run with Git Bash and `symlinks: false`, because "Git Bash's `ln -s` copies instead of linking unless native symlinks are enabled" (`:44-45`).
- **Edge cases / failure handling:** `removeTempDir` retries on `EBUSY`/`EPERM`/`ENOTEMPTY` up to 80 times, because "on Windows, `taskkill /T` runs asynchronously and can miss descendants such as Git Bash's `sleep`" (`:15-31`).
- **Surprising:** the local tests beyond the shared suite check the *watch budget* (a tree over the limit is refused with `invalid`) and a FIFO (refused without waiting for a writer) (`:63-89`, `:120-125`).

#### packages/durable/test/env-node-spill.test.ts
- **Purpose:** the shell-output spill path under backpressure.
- **Key abstractions:** a `vi.mock("node:fs")` that makes `createWriteStream` slow and immediately backpressured (`:15-43`).
- **Data flow:** the mocked stream delays every write by 600 ms and reports each rejected write into a hoisted counter (`:11`, `:36-38`).
- **Non-obvious design decisions:** the scenario is "Longer than the shell's post-exit stdio grace period plus the descendant's delayed write" (`:10`) — the test is aimed at exactly the race where output is lost.
- **Edge cases / failure handling:** the command backgrounds a descendant that writes after the shell exits (`:63`); the assertion is that the inherited stdio stayed open long enough to read it (`:80-85`).
- **Surprising:** the test asserts on the **spill file's exact contents** (`"a"*20 + "b"*1000`), so a dropped byte anywhere in the pipeline fails — the spill is byte-exact, not best-effort.

#### packages/durable/test/env-node.test.ts
- **Purpose:** the Node environment's filesystem, line reader and shell behaviour.
- **Key abstractions:** `NodeExecutionEnv`, `getOrThrow`, `readTextFile`, `exec`.
- **Data flow:** every operation returns a `Result`; the tests unwrap with `getOrThrow` and assert on the error shape otherwise.
- **Non-obvious design decisions:** the shell section covers env overrides, a *replaceable* (not inherited) environment, missing cwd, timeouts, invalid timeouts, spawn errors and pre-aborted commands (`:586-911`).
- **Edge cases / failure handling:** "returns non-zero command exit codes as successful execution results" (`:784`) — an exit code is not an exception; a timeout is (`:799`).
- **Surprising:** the spill tests assert both halves of the contract: "does not create a spill before output crosses its thresholds" (`:912`) and "preserves exact raw bytes in the spill while streaming decoded text" (`:927`).

#### packages/durable/test/env-truncate.test.ts
- **Purpose:** the truncation utilities, including in a runtime without `Buffer`.
- **Key abstractions:** `truncateHead`, `formatSize`, `DEFAULT_MAX_BYTES`.
- **Data flow:** the byte-less case runs a **child process** with `--import ./fixtures/delete-buffer.ts` and the fixture script, and compares the JSON it prints (`:25-36`).
- **Non-obvious design decisions:** the child is launched with `--conditions=source` so it imports the *source*, "not from a possibly stale build" (`:28-29`).
- **Edge cases / failure handling:** "does not count a trailing newline as an extra line" (`:47-52`); a first line that exceeds the byte limit yields an empty content and `firstLineExceedsLimit: true` (`:86-93`).
- **Surprising:** `truncatedBy` distinguishes "lines" from "bytes" — the caller is told *which* limit bit, and the two can disagree (`:65-73`).

#### packages/durable/test/harness-blocked.test.ts
- **Purpose:** tasks that cannot run: the restart limit, parked tasks, migration failures and missing definitions.
- **Key abstractions:** `harness.inspect(context)`, the blocked reasons, `retryTask()`.
- **Data flow:** "parks a task cut off `restartLimit` times in a row, shows why, and runs it again on `retryTask()`" (`:135`).
- **Non-obvious design decisions:** "counts no restart for a task a close stopped" (`:179`) — a clean close is not a crash; "does not count the same checkpoint committed again as progress" (`:329`) and "starts the count over when the task makes progress" (`:368`).
- **Edge cases / failure handling:** a task whose abort handler is cut off the same number of times is *faulted* rather than parked (`:228`); a raised `restartLimit` un-parks a task (`:269`).
- **Surprising:** the host's wake stays active until open's recovery pass has landed (`:82`) — the alarm must not be disarmed before the recovery that needs it.

#### packages/durable/test/harness-callers.test.ts
- **Purpose:** who may call a tool — the model, other tools, or both.
- **Key abstractions:** `callers: ["model" | "tools"]`, `AgentDoc.modelTools`, `agent.callable`, `agent.deferred`.
- **Data flow:** the agent exposes two lists: `tools` (offered to the model) and `callable` (callable by tools) (`:46-52`).
- **Non-obvious design decisions:** a tool with `callers: ["model"]` is **not** callable by another tool, and the attempt returns a `tool_unavailable` diagnostic rather than an exception (`:72`).
- **Edge cases / failure handling:** `modelTools` cannot bring back what `tools` disabled (`:100-114`); a model-issued call of a tool it was not offered is answered "as unavailable" in the result (`:116-128`).
- **Surprising:** `addTools` from a tool's control result applies to `modelTools` too, so the model *is* offered the added tool on the next turn (`:130-143`).

#### packages/durable/test/harness-cancellation-barrier.test.ts
- **Purpose:** the barrier between an abort request and the work it must reach.
- **Key abstractions:** `HoldMarks` (a storage that holds the abort-marking commit), `abandonOnRestart`, `abortReason`.
- **Data flow:** the test holds the commit that marks the child aborted, then advances the child's phase and asserts the phase **did not start** (`:76-86`).
- **Non-obvious design decisions:** "The parent's request is durable, the cascade's mark of the child is not: its phase must not advance" (`:79-80`) — the abort is a *two-commit* operation and the barrier sits between them.
- **Edge cases / failure handling:** a `failFast` request in the same pass overrides a restart mark (`:94-144`); restart marks are upgraded down the tree when an abort is requested above them (`:146-188`).
- **Surprising:** a task holding a terminal outcome (`completing`) still has its owned work aborted, and the held outcome is kept (`:190-222`).

#### packages/durable/test/harness-compaction.test.ts
- **Purpose:** the whole compaction surface: cut selection, serialisation, manual/background/blocking/overflow compaction, recovery and the inbox interaction.
- **Key abstractions:** `selectCut`, `beforeCompact`, `CompactionPolicy`, `pi.live.compactions`, `CompactionEntry`.
- **Data flow:** the cut is chosen by token budget and validated by message pairing; the summary is placed directly (generation-owned, blocking) or through a write submission (conversation-owned).
- **Non-obvious design decisions:** the cut never lands on a tool result, a display-only entry, a system entry or an excluded answer (`:253-298`); "lets the compaction that cuts furthest win, whatever finishes first" (`:599`); a failed overflow "is never retried" — compaction, not retry, makes the request fit.
- **Edge cases / failure handling:** a hook may **decline** the compaction (`:795`); a summary is only accepted from a clean `stop` with text and no tool call; a summariser that overflows fails with its own error.
- **Surprising:** the file pins the *event order*: "puts `compaction_start` last in the batch of the preparation commit" (`:2048`) — a UI contract, not an implementation detail.

#### packages/durable/test/harness-context.test.ts
- **Purpose:** the derivation of the model context from committed entries.
- **Key abstractions:** `conversation.context(context)`, head markers, `edits`, the baseline, the tool-result ordering.
- **Data flow:** the range is read on the Session line and scanned off it; an extended read reuses the previous range and scans only newer entries (`:426`).
- **Non-obvious design decisions:** the baseline-lead rule is pinned case by case: it leads when only user messages precede it, and does **not** lead when a retained, edited or later system entry stands in its place (`:163-365`).
- **Edge cases / failure handling:** "synthesizes missing tool results after a fork and drops results cut from their call" (`:366`); aborted, error and deferred assistant messages are excluded but their raw entries are kept (`:86`).
- **Surprising:** the returned view is **deeply frozen** even where the storage freezes only shallowly (`:826`) — a range outlives the read.

#### packages/durable/test/harness-conversations.test.ts
- **Purpose:** conversation lifecycle: root creation, forks, agent documents and the harness's own lifecycle.
- **Key abstractions:** `harness.root`, `harness.createConversation`, `root.fork`, `AgentDoc`, `tx.createConversation`.
- **Data flow:** the root is created lazily with its agent change and `init` in one commit (`:74`); a fork "at a concrete entry with the as-of agent" applies agent and init overrides (`:196`).
- **Non-obvious design decisions:** `conversationCreated` runs in **every** creating commit, "after the built-ins and before agent and init" (`:291`).
- **Edge cases / failure handling:** a conversation created through `Tx` gets its documents three ways — empty, an owner copy, or the fork's as-of copy (`:373`); an absent agent document is read as "no agent" without writing (`:427`).
- **Surprising:** `configure` "replaces whole fields, clears them with `null`, and leaves undefined fields alone" (`:335`) — three distinct meanings for three ways of not naming a field.

#### packages/durable/test/harness-events.test.ts
- **Purpose:** the experimental agent event stream: the vocabulary, the order, and the late-joiner snapshot.
- **Key abstractions:** `watchEvents(harness, conversationId, context)`, the ~25 event kinds, `MessageChange`.
- **Data flow:** the stream translates each commit publication into a batch of events by diffing the `pi.live` view (`:105-152`).
- **Non-obvious design decisions:** undelivered batches are replaced by **one snapshot after 100 pending batches** (`:253`); the sliding tool-output window is rebuilt from output trims and appends (`:310`).
- **Edge cases / failure handling:** a call that never runs and a tool aborted with its generation both end correctly (`:404`); a steer produces a submission event but no run events (`:453`).
- **Surprising:** the events are derived from the *view*, so the backend never needs to know what a UI is — and a late joiner gets the state first and then only the changes.

#### packages/durable/test/harness-failed-run-inbox.test.ts
- **Purpose:** what happens to queued inputs when a run fails.
- **Key abstractions:** `settings.afterFailedRun` (`keep` / `continue` / `withdraw`), the `unanswered` reasons.
- **Data flow:** the failing run settles its own input `unanswered` with reason `model_error` (`:31`); the queued input's fate depends on the policy.
- **Non-obvious design decisions:** the default is "stay queued" (`:36-45`); `continue` "re-places the queued inputs at the final boundary and starts the next run" (`:47-54`).
- **Edge cases / failure handling:** `withdraw` settles the queued input `unanswered` with reason `run_failed` (`:77-81`); queued *writes* are placed by `continue` and kept by `withdraw` (`:56-75`).
- **Surprising:** the policy distinguishes *inputs* from *writes* — "withdraw withdraws inputs only" — so an application note is not lost when a run fails.

#### packages/durable/test/harness-generation-recovery.test.ts
- **Purpose:** the generation's own recovery: an interrupted prepare, an interrupted request, a committed partial, a retry backoff and a deferred poll.
- **Key abstractions:** the generation checkpoint (`phase`, `attempt`, `until`, `pollAt`, pinned `streamOptions`), `LiveDoc.generation`.
- **Data flow:** the checkpoint is written *before* the risky work, so a reopen knows exactly what to redo (`:64`, `:102-107`).
- **Non-obvious design decisions:** the resend uses the **pinned** request, "not options changed after preparation" — the test changes the timeout after the crash and asserts the old value was used (`:108-112`, `:116`).
- **Edge cases / failure handling:** a committed partial is converted into an **aborted** assistant entry and the messages are resent *without* the partial (`:125-163`); an earlier version's running-phase retry is migrated back into a sleep (`:212-253`).
- **Surprising:** the request after a converted partial carries only `["user"]` — the aborted partial is not resent to the model, but is kept in the transcript for the user.

#### packages/durable/test/harness-generation.test.ts
- **Purpose:** the generation task: the turn lifecycle, retries, deferred responses, partial commits and the model errors.
- **Key abstractions:** `GenerationTask` phases, `progress.partialIntervalMs`, the settings merge, `resolveSettings`.
- **Data flow:** partials are committed at most every `partialIntervalMs` and a complete base is written once nothing is in flight (`:120-142`).
- **Non-obvious design decisions:** the run's input is settled `unanswered` with reason `no_model` when the model is unknown (`:163-186`); a retryable error is retried "after a durable backoff" (`:188`) — the backoff is a *sleeping task*, not a timer.
- **Edge cases / failure handling:** a deferred response is polled until ready (`:272`); a deferred cancellation that fails is reported and the run still ends aborted (`:329`).
- **Surprising:** "keeps provider session IDs request-local across concurrent conversations" (`:409`) — two conversations never share a provider session id.

#### packages/durable/test/harness-host-inputs.test.ts
- **Purpose:** the host's live objects — `models` and `settings` may be *functions*.
- **Key abstractions:** `HarnessOptions.models` as `Models | () => Models`, `HarnessOptions.settings` as a getter.
- **Data flow:** generation calls the models function at **each request** (`:52-59`), and a tool reads `api.models` afresh on every access (`:67-105`).
- **Non-obvious design decisions:** the tools see "views of the host's Models that add the Harness identity" (`:77-78`) — the identity is layered on, not merged into the host's object.
- **Edge cases / failure handling:** a plain `Models` object is still accepted (`:61-65`); the settings function is read at every decision, so a timeout change takes effect on the next turn (`:107-124`).
- **Surprising:** a tool that swaps the host's models mid-call sees the change on its *next* `api.models` access — the API is a view over live state, not a snapshot.

#### packages/durable/test/harness-inbox.test.ts
- **Purpose:** the durable input queue — boundaries, modes, resets, staleness, withdrawal and the usage ledger.
- **Key abstractions:** `InboxDoc`, the `postTools` / `final` boundaries, `steeringMode` / `followUpMode`.
- **Data flow:** writes are placed before user items, each in id order, so "user items queued before a reset run in the new context" (`:111-149`).
- **Non-obvious design decisions:** a queued reset ends the run after the tools and the earlier follow-ups run in the **new** context (`:237-270`); a head write behind the active range is settled `stale` (`:307-350`).
- **Edge cases / failure handling:** an `onYield` continuation is dropped when the boundary selects a follow-up (`:369`) or a reset (`:542`); the inbox is left alone when the run's task is aborted (`:673`).
- **Surprising:** the inbox takes a **checkpoint exactly when it becomes empty** (`:728-777`) — so the queued state always rides the delta chain and the base is the empty state.

#### packages/durable/test/harness-input-entries.test.ts
- **Purpose:** inputs that carry their own entry kind, and data-only writes.
- **Key abstractions:** `SubmissionDraft` with an `entry`, `head` writes, `edits`.
- **Data flow:** an idle input is placed as its entry: "the given kind and data, with the content as its user message" (`:99`).
- **Non-obvious design decisions:** an input entry's kind may not start with `pi.` — an application may not impersonate a built-in kind, and a rejected input writes nothing (`:122-137`).
- **Edge cases / failure handling:** a data-only write "changes nothing the model sees" and is appended mid-run in time order (`:259`); a write queued behind a queued reset lands *after* it (`:310`).
- **Surprising:** a data-only write that lands while the generation is preparing leaves the request **unchanged** (`:333`) — the preparation already took its snapshot.

#### packages/durable/test/harness-inspect.test.ts
- **Purpose:** `Harness.inspect()` — a read-only view of every live task and the unsettled submissions.
- **Key abstractions:** `TaskInspection`, the states `ready` / `running` / `waiting` / `blocked`, the reasons `missing_task` / `task_too_old` / `migration_failed`.
- **Data flow:** the inspection is derived from the committed records **without running task code** (`:39`).
- **Non-obvious design decisions:** "A migration that was never tried is not run to find out" (`:100-101`) — `migrations` stays 0 until scheduling resumes.
- **Edge cases / failure handling:** a task whose definition is missing is `blocked` with reason `missing_task`, and one stored by a newer version is `task_too_old` (`:107-108`).
- **Surprising:** the same inspection is available while the Harness is *paused* (`scheduling: "paused"`, `:95`) — it is an operator's view, not a scheduling participant.

#### packages/durable/test/harness-lifecycle.test.ts
- **Purpose:** opening and closing the Harness: the shutdown order, the seal, and the paused-scheduling mode.
- **Key abstractions:** `harness.close(context)`, `harness.closed`, `harness.resume()`.
- **Data flow:** close "joins a task handler that ignores its signal before closing Storage" (`:129`) and then a tool execute and a hook (`:152`) — every invocation is joined *before* the backend goes.
- **Non-obvious design decisions:** "seals admission before signalling handlers and stops watches before joining them" (`:1170`); a commit that settles during close publishes **no frame** to states and watches (`:277`).
- **Edge cases / failure handling:** a cancelled close still shuts down, and a second close awaits the same shutdown (`:232`); operations are rejected once close begins (`:397`).
- **Surprising:** a read-only viewer never schedules, but "schedules from every progress call" (`:539`, `:572`) — asking for progress is what starts the work.

#### packages/durable/test/harness-live-deltas.test.ts
- **Purpose:** the `pi.live` document's *delta* shape — what is appended, what is trimmed, and when a base is taken.
- **Key abstractions:** `LiveDoc`, the tool slot fields, the tail window, the nested slots.
- **Data flow:** the generation hands over to its tool round "and starts a tool with one field write each" (`:100`) — every slot field is its own write so the ops stay small.
- **Non-obvious design decisions:** a sliding tail window is a **front trim plus an append** (`:181`), and when Chord's overlap search cannot find the shared part the whole window is written (`:204`).
- **Edge cases / failure handling:** a call the request did not offer starts as `done` (`:343`); an aborted tool's slot is written with field-level ops (`:420`).
- **Surprising:** the test asserts "stores a complete base exactly in the commits where nothing runs" (`:279`) — the base cadence is a *contract*, because the delta chain's replay cost depends on it.

#### packages/durable/test/harness-nested-tools-restart.test.ts
- **Purpose:** what happens to nested calls when the process dies mid-round.
- **Key abstractions:** `replay: "safe" | "unsafe"`, the nested-call key, the `NestedCallDoc`.
- **Data flow:** a replay-**unsafe** caller's unfinished nested calls are *abandoned* before they run again (`:93`); a replay-**safe** caller's recover and are reattached by key (`:400`).
- **Non-obvious design decisions:** "abandons the work an abandoned nested call owns, which never runs a phase again" (`:168`); a replay-safe caller is reattached "by default and explicit keys, and rejects a rerun that calls differently" (`:563`).
- **Edge cases / failure handling:** an abandoned task whose definition is missing keeps waiting until it is installed, then runs its abort (`:232`); one that is also abort-marked is orphaned (`:300`).
- **Surprising:** background work under an abandoned nested call is **left running**, and the caller settles without it (`:669`) — background work is not a child of the call.

#### packages/durable/test/harness-nested-tools.test.ts
- **Purpose:** nested tool calls: their own tasks, their own documents, their own abort behaviour.
- **Key abstractions:** `api.executeTool(name, args, ctx, { key })`, `NestedCallDoc`, the nested slot list.
- **Data flow:** "runs a nested call as its own tool task and returns its result to the caller, not the transcript" (`:172`); each nested call gets its own task and call id (`:216`).
- **Non-obvious design decisions:** one document per nested call, **keyed by its key, written only by that call** (`:99`); a key may be reused only for an identical call, and the arguments are matched regardless of key order (`:298`, `:321`).
- **Edge cases / failure handling:** the caller aborts the nested calls it left running when it returns, keeping their details (`:351`); explicit keys that are empty, contain a slash, are `__proto__` or are positive integers are rejected (`:788`).
- **Surprising:** the nested slot is found by **binary search** over the slot list, because "a tool may make thousands of nested calls" (`:1093`).

#### packages/durable/test/harness-ownership.test.ts
- **Purpose:** the ownership tree — who holds whom, what an abort reaches, and what a crash leaves behind.
- **Key abstractions:** the owner edges (task → task, task → conversation), `background`, `abandonOnRestart`, the invocation-bound handle.
- **Data flow:** "keeps a conversation busy while its owned foreground subtree has live work, holding the completed owner" (`:198`); the ownership indexes are bounded by live work and reloaded from storage when needed.
- **Non-obvious design decisions:** "aborting a conversation: queued inputs withdrawn, writes kept, foreground work aborted, background kept" (`:654`) — one abort with four different effects.
- **Edge cases / failure handling:** a conversation created in the commit that ends its owner task is rejected (`:580`); the cascade reaches work below ended tasks across two owned conversations (`:446`).
- **Surprising:** "cancels only the caller's wait, never the shared work" (`:869`) — a cancelled *waiter* does not cancel the task it was waiting for.

#### packages/durable/test/harness-prompt.test.ts
- **Purpose:** the system-prompt planner and the tool loadout planner.
- **Key abstractions:** `planSystemEntries`, `replaySections`, `renderSections`, `planTools`.
- **Data flow:** the plan is applied, appended as `pi.system` entries, and then *replayed* — the test asserts the replay equals the desired sections (`:24-40`).
- **Non-obvious design decisions:** an order-only change is rewritten as two entries (remove-all, then re-add in order) because "Patching would append `b` after `c`" (`:162-166`); after a head marker the plan writes a complete baseline that omits the retained deltas (`:169-192`).
- **Edge cases / failure handling:** a section that throws keeps its **previous shown text** and the error is reported (`:77-82`, `:106-108`); a cancelled render context propagates the cancellation (`:111-119`).
- **Surprising:** a changed tool declaration at the *end* is removed and re-added, but a change in the *middle* rewrites the whole order (`:247-254`) — the tool list's order is part of the cached prefix.

#### packages/durable/test/harness-registry.test.ts
- **Purpose:** the extension registry: install/replace/uninstall, validation, and the resolution of an agent.
- **Key abstractions:** `createRegistry`, `RegistrySnapshot`, `resolveAgent`, `resolveSettings`, `agentHooks`.
- **Data flow:** installing an extension with an existing name replaces it **in place**, at its position, and old snapshots stay as they were (`:78-101`).
- **Non-obvious design decisions:** validation runs against the state *after* the install, so replacing the extension that holds a task name is valid (`:122-124`); a failed install publishes nothing at all (`:120-121`).
- **Edge cases / failure handling:** the invalid set is enumerated: two tools with one name, two sections, a bad key, the reserved `instructions` key, and a task name that collides (`:111-119`).
- **Surprising:** the built-in tasks are always in the snapshot and "are not an extension" — they cannot be removed or replaced (`:127-137`).

#### packages/durable/test/harness-reports.test.ts
- **Purpose:** the `onReport` channel: what is reported, and how it is typed.
- **Key abstractions:** `ReportInfo` (`task_error`, `task_faulted`, `extension_error`, `host_error`, `listener_error`, `session_failed`).
- **Data flow:** a task's own failure names the extension that installed its definition, and the *fault* that follows is typed `task_faulted` with reason `threw` (`:70-74`).
- **Non-obvious design decisions:** the extension named is the one whose **code ran**, "also after another one replaced it" (`:78-114`) — the definition's origin is recorded, not the current registry.
- **Edge cases / failure handling:** a failing section, a failing hook and a failing environment builder are three *different* report types (`:116-162`).
- **Surprising:** the same report list distinguishes an extension error, a listener error, a host `onWake` error, a host `setTimer` error and a `session_failed` — five kinds of "something went wrong" that a caller can act on differently.

#### packages/durable/test/harness-scheduler-indexes.test.ts
- **Purpose:** the scheduler's in-memory indexes, where a wrong index changes behaviour.
- **Key abstractions:** the ownership indexes, `TaskRuntime.ownedTasks()`, the `#below` / `#edges` maps.
- **Data flow:** the test drives the storage directly and then observes the committed task records, so each case is "against what the committed records imply" (`:1-2`).
- **Non-obvious design decisions:** "takes a cascade's reason from the nearest cancelling owner" (`:82`) — a leaf under a restart-marked middle under an abort-requested top gets `restart` first.
- **Edge cases / failure handling:** a chain of held owners is finalised in **one** commit that frees the last one (`:125-158`); a scope stays busy after reopen for work below an ended task whose chain is not loaded (`:160`).
- **Surprising:** `ownedTasks()` lists a task that is `completing` — it is still live because its grandchild runs (`:225-230`).

#### packages/durable/test/harness-scheduler-retention.test.ts
- **Purpose:** what the scheduler forgets, and what it must remember.
- **Key abstractions:** the ownership indexes, the context-retention window, the `#unloaded` set.
- **Data flow:** "forgets ended subagent chains once their work ends" (`:178`), and re-loads a chain when new work appears below it (`:193`).
- **Non-obvious design decisions:** "keeps a chain when one commit ends its last task and creates new work below it" (`:345`) — the forget rule is per commit, not per task.
- **Edge cases / failure handling:** a rejected commit's chain load is dropped "without a later publication" (`:384`); a 20 000-deep chain of ended tasks is forgotten "without recursion" (`:475`).
- **Surprising:** "keeps no more after all work ended than a fresh reopen" (`:499`) — the test compares the index sizes against a cold start, which is how a leak is made detectable.

#### packages/durable/test/harness-sleep.test.ts
- **Purpose:** sleeping tasks: the sleep without an invocation, the timer, the abort, and the wake contract.
- **Key abstractions:** `runtime.sleepUntil(until, checkpoint, ctx)`, `wake()` (`active` / `at`), `setTimer`.
- **Data flow:** "sleeps without an invocation and resumes at its checkpoint once due" (`:88`); the sleep is stored with the checkpoint, so the task holds nothing while it sleeps.
- **Non-obvious design decisions:** "arms no timer for sleeps with `onWake`" (`:260`) — the host owns the wake; and "resumes a due sleep with its timer without onWake, with background timers declined" (`:168`).
- **Edge cases / failure handling:** a sleep in an abort handler is rejected, and a sleep until something that is not a time is rejected (`:351`); the timer is disarmed when the sleep is aborted or the Harness closes (`:208`).
- **Surprising:** a task without a definition does not count as active (`:405`) — an unrunnable task is not "work in progress".

#### packages/durable/test/harness-storage-failure.test.ts
- **Purpose:** what happens when the storage fails — the most important failure surface in the package.
- **Key abstractions:** `SessionFailed`, `StorageRequestError`, the first-error-wins rule.
- **Data flow:** the first storage error ends everything: the call, later calls, waits, watches, streams and running tasks (`:86-120`).
- **Non-obvious design decisions:** "ends what a task holds with `session_failed`, not as cancelled by its signal" (`:232`) — the cause is the storage, not the cancellation; a `StorageRequestError` from a *read* fails only that call (`:301`).
- **Edge cases / failure handling:** a read the caller cancelled does **not** fail the Session (`:410`); a throwing commit listener fails the Session, "which would leave memory behind storage" (`:328`).
- **Surprising:** a thrown value that cannot even be formatted "faults only the task, and ends only the watch" (`:567`) — the error formatter never throws, so the blast radius stays local.

#### packages/durable/test/harness-structured-output.test.ts
- **Purpose:** the *three* forms of a tool's output — what the caller gets, what the transcript stores, and what the model sees.
- **Key abstractions:** `structuredOutput`, `output`, `diagnostics`, the schema-declared output.
- **Data flow:** "stores exactly what callers and events get, without the model's output, and keeps a stored null" (`:133`).
- **Non-obvious design decisions:** a schema tool's validated structured output is given to the caller but "the transcript does not store" it (`:187`); structured output that breaks the schema becomes an error result for callers and a report for the model (`:200`).
- **Edge cases / failure handling:** an error result the Harness itself wrote gives the caller **no** structured output, only diagnostics (`:233`); a schema tool's error text is "never as structured output" (`:240`).
- **Surprising:** the same call has three audiences with three different views of one result — the caller, the transcript and the model — and the suite pins all three.

#### packages/durable/test/harness-structured.test.ts
- **Purpose:** the task model's structure: ownership, waiting, completing, abort order, boundaries, recovery and tool rounds.
- **Key abstractions:** `allSettled` vs `failFast`, the `completing` state, the ownership edges, the wait-for graph.
- **Data flow:** a waiting task resumes "once every awaited task is terminal and reads their outcomes in order" (`:338`); a `completing` task "holds a finished task until its owned work drains" (`:740`).
- **Non-obvious design decisions:** abort handlers run **bottom-up** across three levels, "each after the level below is terminal" (`:868`); a task that waits on a task it does not own does not wait for it during an abort (`:890`).
- **Edge cases / failure handling:** the wait-graph rejects a cycle at three different depths (`:500`, `:517`, `:536`); a failFast failure aborts the live siblings but not the parent (`:370`).
- **Surprising:** "never cascades from a terminal owner: an aborted subagent's conversation runs new work normally" (`:1028`) — a finished owner is not a boundary any more.

#### packages/durable/test/harness-submissions.test.ts
- **Purpose:** the submission record: admission, deduplication, waiting, aborting and settlement.
- **Key abstractions:** `SubmissionHandle`, `requestId`, `ConversationBusy`, `tx.settleSubmission`.
- **Data flow:** a write on an idle conversation is appended and settled `done` **without a turn** (`:38-55`); an input on a busy conversation with `whenBusy: "reject"` writes nothing at all (`:57-80`).
- **Non-obvious design decisions:** "Deduplication runs before the busy check" (`:91`); a repeated `requestId` of a *different type* is refused with "Request r1 already identifies a submission of type input" (`:95-97`).
- **Edge cases / failure handling:** a cancelled wait rejects while the submission stays `placed` (`:140-144`); a pending wait rejects with "Harness is closed" (`:146`).
- **Surprising:** a submission created and settled **in the same commit** works, and a second settlement leaves the first in place (`:246-257`).

#### packages/durable/test/harness-task-graph.test.ts
- **Purpose:** the live task graph — the replicated view a UI renders.
- **Key abstractions:** `TaskGraphState`, `TaskGraphNode`, the mount.
- **Data flow:** the graph is built from the committed tasks and their owner edges, and the mount is shared by the observers (`:84-167`).
- **Non-obvious design decisions:** "publishes no revision for a commit that changes no node" (`:312`) — an idle commit is invisible in the graph.
- **Edge cases / failure handling:** after a reopen the surviving tasks show as `pending` (`:168`); owned conversations are listed in id order "whatever order one commit creates them in" (`:240`).
- **Surprising:** an acquisition cancelled while it waits for the Session line registers nothing (`:284`) — a cancelled view leaves no trace.

#### packages/durable/test/harness-tasks-recovery.test.ts
- **Purpose:** task recovery across close/reopen, the crash points, blocked tasks and definition handover.
- **Key abstractions:** the `intent → effect → outcome` discipline, `migrate()`, `abandonOnRestart`.
- **Data flow:** the file walks each crash window one by one: "crash while the mark commit is in storage", "crash after the mark before the run joins", "crash while the abort handler runs" (`:291-427`).
- **Non-obvious design decisions:** "migrates at reservation, leaves the record unchanged when migration fails, and retries only for a new definition" (`:461`); a handover to a same-version replacement happens at the **phase boundary** "without overlap" (`:657`).
- **Edge cases / failure handling:** a task stored by a newer version stays pending until a fitting definition is registered (`:447`); a blocked task that is aborted settles `orphaned` and retires its documents (`:526`).
- **Surprising:** an abort mark that races a handover commit is **preserved**, and the new definition aborts (`:816`) — the mark outlives the code that would have consumed it.

#### packages/durable/test/harness-tasks.test.ts
- **Purpose:** the task engine itself: phases, checkpoints, memos, the runtime, scheduling, abort and close.
- **Key abstractions:** `AnyTask`, `TaskRuntime`, the checkpoint comparison, the registry snapshot per phase.
- **Data flow:** "commits results with entries atomically, keeps memos until terminal, and retires task documents" (`:188`); the runtime's operations are rejected once the invocation ends (`:523`).
- **Non-obvious design decisions:** a phase that returns without a durable change is a **fault** (`:120`); "keeps one registry snapshot per phase and refreshes it at the phase boundary" (`:361`).
- **Edge cases / failure handling:** a committed terminal outcome is kept even if the handler throws afterwards (`:144`); close "seals admission before signalling handlers" (`:1170`).
- **Surprising:** `runtime.commit` calls are **ordered against the step**: one queued before it lands, one after it rejects (`:626`) — the runtime is a queue, not a fire-and-forget.

#### packages/durable/test/harness-telemetry-options.test.ts
- **Purpose:** the *type* contract of `HarnessOptions.telemetry`.
- **Key abstractions:** `InMemoryTelemetryContext`, `NOOP_TELEMETRY_CONTEXT`.
- **Data flow:** none — it is a compile-time test (a `expectTypeOf` file).
- **Non-obvious design decisions:** the telemetry adapter must have the span-starting capability; a partial object is a compile error (`:17-21`).
- **Edge cases / failure handling:** the option is optional (omitted → `undefined`, `:13`).
- **Surprising:** the test is a *type* test dressed as a runtime test — the runtime assertions only check identity, and the real assertions are the `@ts-expect-error` lines.

#### packages/durable/test/harness-telemetry.test.ts
- **Purpose:** the content-free telemetry: spans, metrics, trace parenting and the report events.
- **Key abstractions:** `pi.durable.submit`, `pi.durable.phase`, the up/down counter, the report attributes.
- **Data flow:** the admission trace of a queued input is linked to the running generation's trace, so "user typed while the agent was working" survives into the trace (`:252-297`).
- **Non-obvious design decisions:** "emits entry and settlement events only after successful storage commits" (`:534`); a steer is linked to the current run "without moving its work into the steer's trace" (`:335`).
- **Edge cases / failure handling:** a report raised with a NOOP span does not create a root (`:857`); a session failure outside any span is counted without starting one (`:836`).
- **Surprising:** "marks only the first invocation after reopen resumed, retaining its stored parent" (`:472`) — a resumed task is distinguishable from a fresh one in the trace.

#### packages/durable/test/harness-tools-recovery.test.ts
- **Purpose:** the tool task's recovery: replay safety, interrupted executions, and the rerun.
- **Key abstractions:** `replay: "safe" | "unsafe"`, the tool task's intent/effect/outcome phases.
- **Data flow:** "reruns a tool only when both the stored and the current replay policy are safe" (`:136`).
- **Non-obvious design decisions:** a rerun uses "the environment of the conversation's cwd at rerun" (`:165`) — the environment is rebuilt, not restored.
- **Edge cases / failure handling:** an unsafe tool interrupted after its intent is answered with its durable partial output (`:109`); `beforeTool` is rerun when the interruption happened before the intent, and the tool executes once (`:213`).
- **Surprising:** the rerun "clears the interrupted attempt's progress before a safe rerun" (`:366`) — the UI never shows a half-finished call twice.

#### packages/durable/test/harness-tools.test.ts
- **Purpose:** the tool round: which calls are offered, how they run, what the result looks like, and the hooks around them.
- **Key abstractions:** `ToolTask`, `beforeTool` / `afterTool`, `control` (`addTools`, `terminate`), the `ToolExecutionApi`.
- **Data flow:** "runs input, tool call, tool result, and answer, and settles the input" (`:83`); a round runs in parallel by default and sequentially when configured *or* when a tool requires it (`:266`).
- **Non-obvious design decisions:** the execution mode is read when the round starts and **kept for the round** (`:241`); a throw becomes a `tool_error` result with the partial output (`:417`).
- **Edge cases / failure handling:** a call to a tool deactivated after preparation is answered `tool_unavailable` (`:165`); "the first `beforeTool` block wins and skips later handlers" (`:551`).
- **Surprising:** "terminates only when every result of the round asks to" (`:649`) — one call's `terminate: true` does not end the round.

#### packages/durable/test/harness-view.test.ts
- **Purpose:** the conversation view: a hydrated, subscribable projection of the committed transcript and documents.
- **Key abstractions:** `ConversationViews`, the mount, the frame operations.
- **Data flow:** "publishes one frame per touching commit, whose operations rebuild every revision" (`:103`).
- **Non-obvious design decisions:** unchanged parts are **shared** between revisions and commits that touch nothing mounted are skipped (`:133`); a fork's view is cut into its inherited entries (`:184`).
- **Edge cases / failure handling:** a retired document is unmounted and its recreation mounted whole (`:214`); undelivered frames are replaced by the newest view after 100 (`:231`).
- **Surprising:** a raw head write that targets before the active range keeps only the mounted entries (`:170`) — the view refuses to resurrect cut history.

#### packages/durable/test/images-wasm-module.test.ts
- **Purpose:** the image processor's WASM entry point, in isolation.
- **Key abstractions:** `createPhotonImages(module)`, `DEFAULT_IMAGE_LIMITS`.
- **Data flow:** the test compiles the Photon WASM module itself and hands the compiled module to `createPhotonImages`, "as Cloudflare Workers pass it" (`:8-11`).
- **Edge cases / failure handling:** the file's own header explains why it is separate: "Its own file, so Photon is not yet initialized: vitest gives each file fresh modules, and Photon loads only once" (`:1`).
- **Surprising:** the image is returned **unchanged** — "returned as it is only once it decodes, which fails without an initialized Photon" (`:13-14`).

#### packages/durable/test/indexeddb-storage.test.ts
- **Purpose:** the IndexedDB storage backend, including across a reopen.
- **Key abstractions:** `IndexedDbStorage`, `fake-indexeddb`'s `IDBFactory`, the shared conformance suite.
- **Data flow:** the `ReopeningStorage` wrapper closes and reopens the underlying storage after **every commit** (`:42-50`), so the conformance suite runs against a storage that never keeps its connection.
- **Non-obvious design decisions:** the wrapper implements the whole `Storage` interface by delegation, with `entry()` disambiguating its two overloads by argument shape (`:58-70`).
- **Edge cases / failure handling:** minted ids survive the reopen (`:138-149`); a commit that fails on a document copy rolls back the table writes too (`:151-188`).
- **Surprising:** the conformance suite is registered **twice** — once plain, once with the reopening wrapper (`:106-119`) — so "the same behaviour after a reopen" is a contract, not a hope.

#### packages/durable/test/jsonl-storage.test.ts
- **Purpose:** the JSONL storage: publication, reclamation, torn writes and recovery.
- **Key abstractions:** the `main.jsonl` log, the per-document and per-task sidecars, the commit ordinal.
- **Data flow:** "publishes every commit before reclaiming current-only document and terminal-task sidecars" (`:326`); a sidecar append is removed when it is complete but unconfirmed (`:390`).
- **Non-obvious design decisions:** the "complete candidate" is serialised **before** any I/O, "and leaves preparation failures usable" (`:415`); main is flushed only to *authorise* reclamation (`:533`).
- **Edge cases / failure handling:** a torn UTF-8 tail is truncated at an exact byte offset and the unconfirmed sequence is reused (`:978`); "fails open when confirmed sidecar data is missing" (`:1039`).
- **Surprising:** the failure matrix is enumerated per *mode* (append/flush) and per *call* (`:458`, `:502`) — the storage's crash-safety is a table of failure windows, not a claim.

#### packages/durable/test/memory-storage.test.ts
- **Purpose:** the in-memory storage, plus the conformance suite it shares with the other backends.
- **Key abstractions:** `MemoryStorage`, `prepareCommit`.
- **Data flow:** the test asserts that a prepared commit does not expose retained state: mutating the prepared write's nested array **throws** (`:26-27`).
- **Non-obvious design decisions:** `prepared.apply()` is **idempotent** — calling it twice returns the same sequence (`:29-30`), so a retried settlement cannot write twice.
- **Edge cases / failure handling:** the retained record is unchanged after the prepared commit is applied (`:31`).
- **Surprising:** the in-memory storage takes the *same* conformance suite as SQLite, JSONL and IndexedDB — one contract, four implementations.

#### packages/durable/test/nested-images-bench.ts
- **Purpose:** the storage cost of nested calls that carry images.
- **Key abstractions:** `NestedCallDoc`, the `inline` vs `reference` argument variants.
- **Data flow:** the `reference` variant passes the *task id* of the reading call, and the classifier resolves the image from the caller's `NestedCallDoc` (`:125-135`).
- **Non-obvious design decisions:** the classifier refuses to resolve a reference outside a nested call ("classify resolves references only as a nested call") — the reference is only meaningful in that scope (`:128`).
- **Edge cases / failure handling:** the benchmark reports the stored size *before the script returns* ("while its nested results are live"), after the run, after close and after reopening (`:52-59`).
- **Surprising:** the whole point is the comparison: inline base64 in the arguments versus a task reference — the second keeps the large payload out of the *caller's* arguments, at the cost of a lookup.

#### packages/durable/test/nested-tools-bench.ts
- **Purpose:** the storage and heap cost of nested tool calls, streaming and nested.
- **Key abstractions:** the fan-out tools, `progress: false`, the `Written` breakdown by write type.
- **Data flow:** the benchmark counts commits and sums the JSON length of every write per type, and samples the heap every 5 ms (`:136-139`, `:158-160`).
- **Non-obvious design decisions:** "With `progress: false` the nested calls commit no running output" — the comparison isolates the *progress* cost from the *result* cost (`:6-7`).
- **Edge cases / failure handling:** "A run that answers `done` may still have failed tools; the model-issued call's result says whether any did" (`:188-193`) — the assertion reads the tool result, not the model's answer.
- **Surprising:** the 2 ms gap case models "a fast tool such as `read`: it ends before a second progress commit", and the 50 ms gap models "a short `bash` command" (`:6-8`) — the scenarios are named after real tools.

#### packages/durable/test/provider-session-cache-e2e.test.ts
- **Purpose:** a live regression test for the provider-side prompt cache across Durable turns.
- **Key abstractions:** `ProviderDoc.sessionId`, `options.sessionId`, the Codex `responses` transport.
- **Data flow:** the Models object is wrapped in a `Proxy` that records every forwarded `sessionId` and calls the real Anthropic/Codex stream (`:54-77`).
- **Non-obvious design decisions:** the test asserts the **same** session id is forwarded on every turn (`:110`) — the durable provider identity is what makes the cache hit.
- **Edge cases / failure handling:** the test is skipped without credentials (`it.skipIf(!codexToken)`, `:48`) and the first prompt is asserted to be a cache miss (`:113`).
- **Surprising:** the cache hit rate is asserted at **≥ 0.9** for three consecutive turns (`:118`) — the test measures the provider's behaviour, not just that an id was sent.

#### packages/durable/test/scheduler-fanout-bench.ts
- **Purpose:** the scheduler's fan-out cost: one tool making N parallel nested calls.
- **Key abstractions:** `api.executeTool`, the commit counter.
- **Data flow:** the leaf returns at once, so the time measured is the Harness's and the scheduler's own (`:1-3`).
- **Non-obvious design decisions:** "Quadratic work shows as four times the time per doubling of `calls`" — the benchmark's acceptance criterion is stated up front (`:3-4`).
- **Edge cases / failure handling:** a run whose nested calls failed measures nothing, so the tool result is checked before the numbers are reported (`:60-62`).
- **Surprising:** the tool is given `{ progress: false }` (`:33`) so the measurement is not polluted by the live-output commits.

#### packages/durable/test/scheduler-memory-bench.ts
- **Purpose:** the scheduler's memory behaviour under many subagent cycles.
- **Key abstractions:** `SCHEDULER_INDEX_SIZES` (the exported index-size symbol), `retainedBytes()`.
- **Data flow:** each cycle creates a tool task, a conversation and an inner task, then ends them (`:77-97`); the index sizes are read through the exported symbol (`:100`).
- **Non-obvious design decisions:** the benchmark **fails** if the ownership indexes grew: "the scheduler's ownership indexes must not grow with ended history; the heap still includes the Session's caches" (`:127-129`).
- **Edge cases / failure handling:** a later message into an old subagent conversation is measured separately — "reads for a later message" — because a forgotten chain must be *re-loadable* (`:101-110`).
- **Surprising:** the heap is sampled from a **snapshot**, not from `heapUsed`, for exactly the reason the helper documents.

#### packages/durable/test/session-checkpoints-migrations.test.ts
- **Purpose:** the Session's document checkpoint and migration machinery.
- **Key abstractions:** `checkpointWhen`, the delta/base choice, the migration callback, the tracker cache.
- **Data flow:** the predicate is called with the definition as the receiver (`:20`) and with the stored delta count since the newest base (`:113`).
- **Non-obvious design decisions:** the predicate is skipped for an **empty** batch but called for a *nonempty structural no-op* (`:161`) — a no-op that changed nothing still gets a decision.
- **Edge cases / failure handling:** "rolls back every prepared document when a checkpoint predicate throws" (`:197`); a migration that fails is rejected **before** the tracker takes ownership and the session stays usable (`:502`).
- **Surprising:** a migration happens "once per cold load" and writes nothing (`:334`) — a read is never a write.

#### packages/durable/test/session-definitions.test.ts
- **Purpose:** the *type* contract of document and entry definitions.
- **Key abstractions:** `defineDoc`, `defineDocFamily`, `defineEntry`, the scoped overloads.
- **Data flow:** none at runtime — it is a compile-time test with `expectTypeOf` and `@ts-expect-error`.
- **Non-obvious design decisions:** a document definition **requires** an explicit `checkpointWhen` (`:80-95`) — the default is deliberately absent, so the storage cost is always a decision.
- **Edge cases / failure handling:** a version must be a positive integer (`:97-109`); the owner/key/seed overloads are all typed, and the wrong ones are compile errors (`:128-137`).
- **Surprising:** "Session documents take no owner", "conversation documents require a conversation ID" and "family access requires a creation seed" are all *type* errors — the scope is part of the type, not a runtime check.

#### packages/durable/test/session-document-cache-bench.ts
- **Purpose:** the document cache's memory and read cost across many conversations.
- **Key abstractions:** `documentRetentionMs`, `documentCacheSizes.cached`, `UsageDoc`.
- **Data flow:** the harness creates N conversations and runs one short task in each; the benchmark then reports the cached document count and the retained bytes per conversation (`:55-85`).
- **Non-obvious design decisions:** the run is **warmed up first** (200 cycles) "so compiled code and storage caches would otherwise count as growth" (`:66-67`).
- **Edge cases / failure handling:** four retention settings are compared — infinite, 10 min, 50 ms and 0 — with a wait so only the timer can evict (`:73-76`, `:94-99`).
- **Surprising:** the benchmark reads the *old* conversation's document 100 times to price the re-read after eviction — "from the cache, or from storage after eviction" (`:80-83`).

#### packages/durable/test/session-document-retention.test.ts
- **Purpose:** the document cache's eviction rules.
- **Key abstractions:** `documentRetentionMs`, the observer pins, the sweep job.
- **Data flow:** "evicts an unattached document once its retention passed, and loads it again with the same value" (`:114`); a watched or observed document is never evicted (`:149`).
- **Non-obvious design decisions:** "queues one sweep job, not one per document, while a commit holds the line" (`:576`); a retention that is not a number of milliseconds falls back to the default and `Infinity` means never (`:433`).
- **Edge cases / failure handling:** a document is evicted "on its timer without a commit" (`:387`); a shortened retention takes effect at the next use (`:330`).
- **Surprising:** "gives the same events with documents evicted right after use as with documents kept" (`:504`) — eviction must not change observable behaviour, only cost.

#### packages/durable/test/session-documents.test.ts
- **Purpose:** the document transaction model: drafts, revisions, publication, retirement and rollback.
- **Key abstractions:** `tx.doc(...)` (a draft), the published revision, `retireDoc`, the tracker.
- **Data flow:** the draft is adopted by **pointer swap** after the storage commit succeeds (`:142`); the published revision shares the operation payloads with the stored one.
- **Non-obvious design decisions:** "returns shared immutable snapshots and keeps prior revisions stable" (`:125`); "suppresses writes and publications for empty batches" (`:179`) but "writes and publishes replayable nonempty structural no-ops" (`:195`).
- **Edge cases / failure handling:** an escaped draft is revoked when the callback settles (`:212`); a failed callback aborts every change (`:233`).
- **Surprising:** "rejects tokens whose semantics or version disagree with the stored incarnation" (`:369`) — a document's *identity* includes its history and fork policy, so a mismatched token is refused.

#### packages/durable/test/session-forks.test.ts
- **Purpose:** how a fork copies documents.
- **Key abstractions:** `asOf` vs `current` copies, the fork point, the conversation scope.
- **Data flow:** the fork copies the bases of as-of and current documents "while leaving initial documents absent" (`:29`).
- **Non-obvious design decisions:** the fork point selects the *entry-owning ancestor* for as-of copies and the *immediate parent* for current copies (`:185`); the copy uses the stored value and version "without consulting migration definitions or migrated caches" (`:238`).
- **Edge cases / failure handling:** a fork point that is invisible is rejected *before admission* and the session stays usable (`:394`); a duplicate selection for one child address is refused (`:423`).
- **Surprising:** a fork copies **only conversation documents** — "leaving Session and task documents in their original scopes" (`:632`).

#### packages/durable/test/session-states.test.ts
- **Purpose:** the Chord-backed document state: hydration, delivery, retirement and migration.
- **Key abstractions:** `session.documentState(doc, owner, ctx)`, the delivery sequence, `dispose()`.
- **Data flow:** the state is hydrated immediately and then receives contiguous deliveries (`:41-61`); it shares the *exact* committed value reference with Chord (`:85-96`).
- **Non-obvious design decisions:** two states of one incarnation are independent (`:63-83`); the state publishes `null` on retirement and never follows the replacement (`:112-132`).
- **Edge cases / failure handling:** a state of an absent document is `undefined` and creates nothing — no commit, no minted id (`:32-39`).
- **Surprising:** the shared values are "trusted shared immutable values without freezing" (`:217-225`) — frozen objects would break the Chord sharing, so the immutability is a contract, not `Object.freeze`.

#### packages/durable/test/session-tables.test.ts
- **Purpose:** the Session's table API: conversations, entries, tasks and the read-before-write rule.
- **Key abstractions:** `tx.createConversation`, `tx.appendEntry`, `tx.createTask`, `tx.setTask`, the table scans.
- **Data flow:** "allows table reads only before the first table write" (`:85`) — the rule the boundary code is built around.
- **Non-obvious design decisions:** a task and its document can be created in one transaction "without ReadAfterWrite" (`:357`); a synchronous `setTask` counts as the first table write (`:124`).
- **Edge cases / failure handling:** missing, terminal and abort-marked conversation owners are rejected **atomically** (`:216`); task documents are rejected after a terminal candidate (`:390`) and retired at terminal settlement (`:408`).
- **Surprising:** the table JSON is taken over by the session ("takes ownership of table JSON and rejects non-strict values") — a caller cannot mutate a record after the commit.

#### packages/durable/test/session-watches.test.ts
- **Purpose:** the document watch: acquisition, serialised callbacks, overflow and retirement.
- **Key abstractions:** `session.watchDoc(...)`, the exact committed frames, the 100-frame overflow.
- **Data flow:** the watch keeps its acquisition revision until `start` and then delivers exact committed frames (`:49`).
- **Non-obvious design decisions:** "collapses 101 pending commits to one root replacement" (`:143`) and "never folds the in-flight frame into an overflow reset" (`:160`).
- **Edge cases / failure handling:** a listener failure settles **only the affected watch** (`:410`); a cancelled acquisition leaves no registered watch (`:354`).
- **Surprising:** the watch "can replay every delivered exact operation batch from the acquisition revision" (`:470`) — a client can rebuild any past revision.

#### packages/durable/test/spec-usage.test.ts
- **Purpose:** the spec's own usage examples, compile-checked.
- **Key abstractions:** the `Context`, `Storage`, `Models` names the spec leaves to the application are *declared* (`:40-77`).
- **Data flow:** the file is one big function of examples, organised by the spec's section numbers (`:85`).
- **Non-obvious design decisions:** "Each block is copied as written apart from formatting, with the names the spec leaves to the application declared below. Keep the two in sync; `test/examples/` runs the same patterns end to end" (`:2-5`).
- **Edge cases / failure handling:** the declared names have no values and the function is never called (`:79`).
- **Surprising:** the spec and the examples are kept in step **twice** — once by compilation and once by execution — which is the mechanism that keeps a written specification honest.

#### packages/durable/test/sqlite-cloudflare.test.ts
- **Purpose:** the Durable Object SQLite adapter, run on Node's `node:sqlite`.
- **Key abstractions:** `openDurableObjectSqliteStorage(storage, { prefix })`.
- **Data flow:** the adapter can be driven on Node by a helper from the chord package (`durableObjectStorage()`, `:5`).
- **Non-obvious design decisions:** the adapter **prefixes** pi's tables and indexes without touching the host's tables (`:22-41`), and two prefixes on one object stay isolated (`:43-69`).
- **Edge cases / failure handling:** an empty prefix, a prefix with a dash, and the reserved `sqlite_` prefix are all refused (`:71-79`).
- **Surprising:** the same adapter is testable on Node — the workerd lane is not the only way to test it.

#### packages/durable/test/sqlite-facade.test.ts
- **Purpose:** the portable SQLite facade: statement caching, settlement semantics and read isolation.
- **Key abstractions:** `SqliteStorage.open(database)`, the `SqliteDatabase` interface, the `ControlledSettlementDatabase` and `PrepareCountingDatabaseSync` doubles.
- **Data flow:** the facade re-exports the chord drivers without wrapping them (`:88-92`); each storage statement is prepared once per connection and reused (`:94-122`).
- **Non-obvious design decisions:** ids are adopted **only after** a successful settlement (`:191-194`, `:206-209`) — a failed commit leaves the id sequence advanced but the record unwritten.
- **Edge cases / failure handling:** "reads storage commits in call order" (`:124`); a document read returns one of the two states when a commit replaces its base mid-read — a 16-yield loop pins the race (`:214-239`).
- **Surprising:** the facade is a *facade*, not a wrapper: `NodeSqliteDatabase` **is** the chord class (`:89-91`) — no re-implementation, so the drivers stay one implementation.

#### packages/durable/test/sqlite-migrations.test.ts
- **Purpose:** the SQLite schema migrations.
- **Key abstractions:** `SQLITE_MIGRATIONS`, `CURRENT_SQLITE_SCHEMA_VERSION`, `applySqliteMigrations`.
- **Data flow:** the migrations are applied in order and recorded in `durable_schema`; the metadata row holds `next_id` and `next_seq` (`:35-41`).
- **Non-obvious design decisions:** a database **newer** than the portable core is refused: "is newer than supported version" (`:102-113`).
- **Edge cases / failure handling:** a failed migration is rolled back — the bad table is not created, the version stays, and the stored data survives for a later retry (`:115-176`).
- **Surprising:** the failed migration is a *list* with a deliberately invalid statement ("THIS IS NOT SQL") — the rollback path is exercised by a real syntax error, not a mock.

#### packages/durable/test/sqlite-storage.test.ts
- **Purpose:** the SQLite storage: persistence, prefixes, indexes, checkpoints and reclamation.
- **Key abstractions:** the prefixed tables and indexes, the WAL, the document revisions.
- **Data flow:** records, sequence allocation and id allocation all survive a reopen (`:170-192`).
- **Non-obvious design decisions:** "reclaims current-only revisions only after a base or retirement" (`:481`); the WAL is auto-checkpointed and truncated on close (`:533`).
- **Edge cases / failure handling:** persisted metadata corruption is rejected on reopen (`:233`); a document whose required base is missing is refused (`:246`).
- **Surprising:** the file asserts that the right **indexes are used** — "uses indexes for exact addresses, exact scopes, entry history, and document revision tails" (`:423`) — a query plan check, not just a result check.

#### packages/durable/test/storage-memory.ts
- **Purpose:** the memory/disk footprint measurement of the three storage backends.
- **Key abstractions:** `STORAGE_MEMORY_SCALES`, `STORAGE_READ_BENCHMARKS`, `seedStorageBenchmark`.
- **Data flow:** the driver spawns a **child process per backend and scale** with `--expose-gc`, and collects one JSON line each (`:180-199`).
- **Non-obvious design decisions:** the child-per-measurement design is what makes the peak RSS meaningful ("values are process deltas, not limits", `:202`).
- **Edge cases / failure handling:** `collectGarbage` throws a clear error when `--expose-gc` is missing (`:60-63`).
- **Surprising:** the report includes the **disk** footprint per backend — SQLite pages and freelist, JSONL document and task file counts (`:219-225`).

#### packages/durable/test/storage-runtime-boundary.test.ts
- **Purpose:** the portable/runtime boundary: which entry points may import Node built-ins.
- **Key abstractions:** `sourceGraph(entry)` — a mini import-graph walker over the package's sources.
- **Data flow:** the walker reads each file, asserts it does not import `node:`, and follows only *value* imports (type-only imports are erased) (`:16-20`).
- **Non-obvious design decisions:** the check is done on the **import graph** of each public entry, not on a list of forbidden files — so a new file that imports `node:fs` fails even if nobody listed it.
- **Edge cases / failure handling:** four boundaries are pinned: the package root, `storage/sqlite/index.ts`, `env/index.ts` and `storage/jsonl/index.ts` (`:26-47`).
- **Surprising:** the same rule that keeps the package browser-safe is what lets the durable harness run *inside* a Cloudflare Worker.

#### packages/durable/test/storage.bench.ts
- **Purpose:** the vitest benchmark lane for the three storage backends.
- **Key abstractions:** `bench()` from vitest, the read/write/reopen scenario lists.
- **Data flow:** each scenario is validated with `strictEqual` against its expected result before it is benchmarked (`:60-64`, `:93`).
- **Non-obvious design decisions:** the write benchmarks use a **pool of pre-seeded fixtures** (one per iteration), because a write benchmark that reuses one fixture measures the *second* write, not the first (`:94-100`).
- **Edge cases / failure handling:** the reopen benchmark copies a seeded storage per sample (`:143-151`) and asserts the first read after reopen returns the right entry (`:167-170`).
- **Surprising:** a benchmark that fails its own correctness check is not a benchmark — every scenario is validated before it is timed.

#### packages/durable/test/system-order-cache-e2e.test.ts
- **Purpose:** the live regression test for prompt-cache behaviour when a tool is added mid-conversation.
- **Key abstractions:** the `beforeRequest` hook, the Anthropic `streamSimple`, `builtinModels()`.
- **Data flow:** a `Proxy` over the models swaps in the real Anthropic stream with the resolved token (`:70-86`); the "legacy order" hook moves the leading system message back after the user messages (`:58-65`).
- **Non-obvious design decisions:** the test measures the **cache-read share** of the second turn: "Before the fix … expect … toBeLessThan(0.2); The fix … toBeGreaterThan(0.8)" (`:137-141`).
- **Edge cases / failure handling:** it is skipped without Anthropic credentials (`:133`) and uses a 4 000-token prompt to make the cache measurable (`:122`).
- **Surprising:** the fix is *provable* by flipping the order back in a hook — the test can reproduce the bug inside itself, which is what makes the 0.2/0.8 thresholds credible.

#### packages/durable/test/tool-output-bench.ts
- **Purpose:** the tool-output path under load: the throttle, the live commits and the round's delta chain.
- **Key abstractions:** `outputLimits.retain` (`head` | `tail`), `api.output`, the `LiveDoc` op observer.
- **Data flow:** the tool writes until it has produced 1 GiB or the rate period ends; the observer counts live commits, op bytes and whole-string "sets" (`:194-206`).
- **Non-obvious design decisions:** each scenario runs in its **own child process** "so peak RSS is its own" (`:6-7`); the rate scenario closes the Harness mid-round to measure the replay of the delta chain on reopen (`:214-225`).
- **Edge cases / failure handling:** a repetitive scenario measures "how often Chord's bounded overlap search falls back to writing the whole tail window" (`:64-65`).
- **Surprising:** the commit latency is measured with a `Proxy` around the storage (`:260-278`) — the p50/p99 of the *storage commit* is a first-class metric of the harness's responsiveness.

#### packages/durable/test/tool-search.test.ts
- **Purpose:** the deferred-tool mechanism and `tool_search`.
- **Key abstractions:** `deferred: true`, `modelTools.add`, `createToolSearchExtension`.
- **Data flow:** a search loads a tool by *appending* its declaration to the system prompt, so "no tool was removed and declared again, so the cached prefix holds" (`:89-95`).
- **Non-obvious design decisions:** loads are recorded **by name**; an unknown name changes nothing, and "remove wins" when a name is in both lists (`:118-145`).
- **Edge cases / failure handling:** a tool that is not found leaves `modelTools` undefined and answers "No matching tools found." (`:195-203`).
- **Surprising:** a loaded tool stays loaded even if its extension is temporarily gone, and the load is per **branch** — a fork before the load does not have it, a fork after does (`:147-193`).

#### packages/durable/test/tools-images.test.ts
- **Purpose:** reading images: the limits, the Photon processor, EXIF orientation and the worker-thread implementation.
- **Key abstractions:** `createPhotonImages`, `imageDimensions`, `toBase64`, `DEFAULT_IMAGE_LIMITS`.
- **Data flow:** an image that is too large is refused "without reading it" (`:231`); the size is read from the header (`:240`).
- **Non-obvious design decisions:** an image that changes while it is read is read **again**, "even when it grew", and fails if it changes twice (`:281-303`) — a torn image is never returned.
- **Edge cases / failure handling:** an extreme aspect ratio keeps "at least one pixel on each side" (`:337`); an image that cannot fit the byte limit at all is given up on (`:342`).
- **Surprising:** `toBase64` "matches Buffer for every remainder length" and encodes 3 MiB "within a 128 MB heap" (`:489-509`) — the browser-safe base64 is a hand-written algorithm with a property test.

#### packages/durable/test/tools-read-differential.test.ts
- **Purpose:** the differential test of the bounded `read` tool against the old whole-file implementation.
- **Key abstractions:** `referenceRead(bytes, path, offset, limit)` — the pre-bounded behaviour, kept as the oracle (`:17-79`).
- **Data flow:** 400 random files × 4 random (offset, limit) pairs must produce **exactly** the reference output (`:155-171`).
- **Non-obvious design decisions:** the corpus is built to hit the boundaries — a BOM, files over the line limit, files over the byte limit, one huge line, and invalid UTF-8 (`:106-120`).
- **Edge cases / failure handling:** the offsets and limits include `NaN`, `1e20`, negatives and fractional values (`:122-123`).
- **Surprising:** the reference implementation is *kept in the test file* — the old behaviour is the specification, and the new bounded implementation must match it exactly, diagnostics included.

#### packages/durable/test/tools.test.ts
- **Purpose:** the built-in tools: read, write, edit, powershell and bash.
- **Key abstractions:** `createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`, the mutation queue.
- **Data flow:** the edit tool matches **all** edits against the original text and rejects overlaps (`:389`); the write and edit tools hold a per-path mutation queue (`:328`, `:420`).
- **Non-obvious design decisions:** the mutation queue is keyed by the **canonical** path and serialises across environment objects of one file system (`:455`), but "does not serialize the same path on different file systems" (`:517`).
- **Edge cases / failure handling:** "rejects missing and duplicate target text" (`:408`); a PowerShell command is "one argument", forcing UTF-8 output (`:570`).
- **Surprising:** "preserves BOM and CRLF line endings" (`:541`) and "repairs edits sent as a JSON string, a single object, or top-level oldText/newText without mutating them" (`:374`) — the edit tool is written for a model that gets the argument shape wrong.

#### packages/durable/test/types.test.ts
- **Purpose:** the *type* contract of the package's public types.
- **Key abstractions:** branded ids (`ConversationId`, `EntryId`, `TaskId<R>`, `DocumentId`), `TaskState`, `SubmissionRecord`, `DocumentContent`.
- **Data flow:** none at runtime — `expectTypeOf` and `@ts-expect-error` do the work.
- **Non-obvious design decisions:** the ids are branded by record kind, and a `TaskId<R>` **carries its result type** (`:47-53`).
- **Edge cases / failure handling:** the discriminated unions are enforced: a live task state cannot carry an outcome, a terminal one cannot keep a checkpoint or memos (`:129-152`).
- **Surprising:** the compile-time failures are *collected into a function* and asserted to be a function — the pattern keeps the `@ts-expect-error` lines from running while still failing the type check.

### Part B — the 29 `packages/durable/src/**` files the previous pass of this shard covered

*These notes are retained from the first pass. The manifest's shard column for these rows now reads `durable#1` (with `status: read`), so they are not in the manifest's `durable#2` list; I did not rewrite the manifest, and I kept these notes rather than dropping a pass's work. Every citation below was re-verified in this pass.*

#### packages/durable/src/harness/generation.ts
- **Purpose:** The built-in `pi.generation` task — pi's agent turn, expressed as a durable state machine with a persisted checkpoint.
- **Key abstractions:** `GenerationTask` (phases `prepare | request | retry | poll | tools`), `GenerationCheckpoint` (a discriminated union persisted in the task record), `Request` (what classification needs to know about the request that produced a message).
- **Data flow:** `prepare` resolves the agent, renders the prompt sections, plans the `pi.system` entries and decides whether a compaction is *blocking* (above `contextWindow − reserveTokens`) or *background*; it commits the system entries and moves to `request`. `request` converts any partial to an aborted assistant entry, streams the model, and classifies the terminal message. `classify` routes: `deferred` → sleep and `poll`; `toolUse` with calls → `startToolRound`; `stop`/`length` → `answer`; an overflow error → a compaction task then re-`prepare`; any other error → retry with backoff, or fail the run. `tools` starts the round's tool tasks one at a time in a sequential round.
- **Non-obvious design decisions:** The partial is copied **synchronously** before every commit because "the provider keeps mutating its partial" (`generation.ts:466`); the `finally` block stops the throttle and awaits the in-flight commit so "no stale partial lands after the outcome" (`:493-497`). Overflow is **never retried** — "only a compaction can make the next request fit" (`:560`). A call to a tool the request did not offer gets a `tool_unavailable` result in the same commit, not an exception (`:655`). The run's inputs live in `pi.live.run`, not in the generation, so a run survives a handover to a successor generation (`handOver`, `:772`). `appendAssistant` is the single writer of assistant entries so the usage ledger cannot drift (`REMINDER` at `:741`).
- **Edge cases / failure handling:** A model that is absent or not in the catalogue fails as `no_model`; the run's inputs settle `unanswered` with that reason. A failed run consults `settings.afterFailedRun` (`keep` / `continue` / `withdraw`) — `continue` re-places the queued inputs at the final boundary and starts the next run. Abort converts any committed partial into an aborted assistant entry and gives every *unstarted* call an `aborted` tool result (`:300-311`). A deferred response is polled at `max(now + pollAfterMs, previousPollAt + 1)` so it is always polled strictly later (`:513`).
- **Surprising:** The tool round decides *sequential vs parallel per call*, not globally: the round is sequential if the setting says so **or** any offered call's tool declares `executionMode: "sequential"` (`:642`). Termination requires that **every** call of the round ask to terminate, including ones answered without a task (`:702`).

#### packages/durable/src/harness/scheduler.ts
- **Purpose:** The durable task scheduler — the mechanism that makes a turn survive a process death, a crash, or a restart of the host.
- **Key abstractions:** `TaskScheduler` with `#live` (a mirror of every non-terminal committed task record), the ownership tree (`#below` = downward index, `#edges` = conversation → owner task), `Invocation` (one in-memory execution, run or abort mode), `Resolution`/`Fit` (can a definition take this record, and why not), `Overlay` (records staged by the current commit, which override committed ones).
- **Data flow:** `open()` scans every live status, flips surviving `running` tasks back to `pending` and counts the restart. A commit listener (`#observe`) keeps `#live` in step with the committed state and derives cascade marks; `#reconcile` applies them in one commit (`:776`); `#reserve` picks eligible tasks in one commit and creates their invocations; `#step` makes the single synchronous decision (continue / end / fault) on the Session line; phase handlers run off the line and commit through `#gated`.
- **Non-obvious design decisions:** The invariant is spelled out at the class docstring: "every task transition is decided and written by one callback serialized on the Session line" — handlers and joins run off it. The ownership indexes are **bounded by live work**: an owner edge is kept only while something is listed below it, and dropped nodes are re-loaded from storage when work appears under them later (`:243-246`). Abort cascades are derived from **durable** records, not from memory, so "this also repairs whatever a crash left unapplied" (`:773`). A task that was cut off `restartLimit` times in a row is **parked** and reported rather than retried forever (`:1366`), and `retryTask()` clears the count. `wake()` tells the host whether the process is needed again (`active` / `at`), computed from memory and from the registry — a task whose chain is not loaded counts as if it would run alone.
- **Edge cases / failure handling:** A wait is validated against the wait-for graph — a cycle is refused with the path in the message, and `failFast` may only wait on tasks the waiter owns (`:1973`); the abort handler may neither wait nor sleep. A task whose definition version is newer than the record must supply a `migrate()`, else it is `migration_failed`; a task whose definition is *older* is `task_too_old`. A `completing` task holds its terminal outcome until its ordinary owned work drains, and the outcome is written only then (`:1927`). Close is not a crash: tasks are written back as `pending`, so no restart is counted (`:520`).
- **Surprising:** `jsonEqual(current.state, next)` decides whether a commit counts as **durable progress** — a phase that returns without changing its checkpoint is a *fault* ("returned without durable progress", `:1829-1831`), and the restart count is what stops a phase from spinning. The scheduler writes only `faulted` and `orphaned` itself (`REMINDER` at `:871`); a task that fails gets `failed` from its own code.

#### packages/durable/src/harness/context.ts
- **Purpose:** Derives the *active transcript* and the *model context* of a conversation from committed entries.
- **Key abstractions:** `ContextBounds` (head marker + tail), `ContextRange` (the entries, the derived view, the edited targets, the settled/open split, the baseline), `Baseline` (the system message that leads, or `null`/`undefined`).
- **Data flow:** `captureContextBounds` does two O(1) reads on the Session line; `deriveContext` then scans the range **off** the line (entries at or below the tail are immutable) and derives per-target contributions, tool-result ordering and the message list.
- **Non-obvious design decisions:** `readContextFrom` reuses a previous range: with the same head marker only the entries after the previous tail are scanned, and a range that shrank is filtered rather than rescanned (`:85-97`). `leadWithSystem` moves **only the first** system message to the front, and only when it is the baseline or preceded solely by user messages — the stated reason is prompt caching: "providers treat only a leading system message as the initial prompt and tool set; without it, a later tool change rewrites the request's tool list and invalidates the whole prompt cache" (`:206-208`).
- **Edge cases / failure handling:** Assistant messages whose stop reason is `aborted`, `error` or `deferred` are excluded from the context. A tool call with no result gets a **synthesised** error result ("Tool result unavailable: history ends before this call completed") and unmatched results are dropped (`orderToolResults`, `:299`). `EXCLUDED_STOP_REASONS` also prevents an aborted partial from entering the model context twice.
- **Surprising:** The range is **deeply frozen** (`freezeJson`, `:235`) with a `WeakSet` memo, because a range outlives the read and the storage records are frozen like `MemoryStorage` records.

#### packages/durable/src/harness/compaction.ts
- **Purpose:** The `pi.compaction` task — select an old prefix, summarise it, and place a summary entry whose `head` is the first kept entry.
- **Key abstractions:** `CompactionTask` (phases `select | summarize | retry`), `SummaryRequest` (the pinned summarisation request, including `tail` and `firstKept`), `CompactionPolicy` with per-model overrides.
- **Data flow:** `select` reads the context, computes the cut, offers the compaction to a `beforeCompact` hook (which may decline or supply the summary itself), then pins the summarisation request. `summarize` re-reads the context **at `tail`** — immutable, so it is exactly the range `select` chose — and calls the model with a fixed prompt. The summary is placed either directly (the generation owns the compaction → it blocks) or through a write submission (conversation-owned).
- **Non-obvious design decisions:** The summarisation prompt is fixed and asks for an exact section format (`## Goal`, `## Constraints & Preferences`, `## Progress`, `## Key Decisions`, `## Next Steps`, `## Critical Context`) with "Do NOT continue the conversation. Do NOT respond to any questions in the conversation." (`:70-105`). `serializeConversation` deliberately **omits thinking**: "providers return summaries of the real reasoning, and replayed thinking is often not part of the live context … so including it can make the request larger than the context it summarizes" (`:374-379`). The summariser's request sets `cacheRetention: "none"` (`:177`) — a summary must not pollute the live prefix cache.
- **Edge cases / failure handling:** A summary is only accepted from a clean `stop` with text and **no tool call** (`:349`); anything else is a failure with a specific message ("Summarization attempted to call a tool", "Summarization hit the token limit"). A retryable error retries under the retry policy. A hook may **decline** the compaction, which completes with no summary.
- **Surprising:** `REMINDER: nothing else may append to a busy conversation, so every non-blocking summary goes through admission` (`:432`) — the ownership rule (generation owns a blocking compaction, conversation owns a background one) is what makes the append safe.

#### packages/durable/src/harness/inbox.ts
- **Purpose:** The durable input queue — steering and follow-up messages waiting for a boundary.
- **Key abstractions:** `InboxItem` (`steer` | `followUp` | `write`), `InboxDoc` (`pi.inbox`, history `latest`, fork `initial`), `Boundary` (what a boundary reads before the commit's first table write) and `BoundaryResult` (the selected user items and whether a reset was placed).
- **Data flow:** `prepareBoundary` reads the latest head marker and the inbox; `applyBoundary` places the selected items and removes them positionally from the inbox; `withdrawQueuedInputs` settles and removes them when a run is aborted.
- **Non-obvious design decisions:** The boundary is **prepared at the start of a commit** and applied inside it, because "a boundary reads the table, so it is prepared before the first table write" — the storage forbids a read after the first write (`ReadAfterWrite`). Writes are placed **first** and user items after them, each in ID order, so "user items queued before a reset run in the new context" (`:66`).
- **Edge cases / failure handling:** A write whose `head` targets an entry **before the active range** is `stale` — it is settled `unanswered` with reason `stale` rather than resurrecting cut history (`isStale`, `:145-147`). A display-only write (no `model`, `head` or `edits`) "changes nothing the model sees and needs no boundary" (`isDisplayOnly`, `:135-136`). Withdrawing leaves queued *writes* in place — only inputs are withdrawn.
- **Surprising:** `checkpointWhen: (value) => value.items.length === 0` — the inbox only takes a checkpoint when it is empty, so the queued state is always carried in the delta chain.

#### packages/durable/src/harness/prompt.ts
- **Purpose:** Plans the `pi.system` entries that make the committed prompt equal the desired prompt — the minimum possible change.
- **Key abstractions:** `replaySections` (sections in effect, rebuilt by replaying committed system messages), `planSystemEntries`, `ToolChanges` (`toolsRemoved` / `toolsAdded`).
- **Data flow:** The generation renders the desired sections, then `planSystemEntries(view, desired, tools, timestamp)` compares them with the replayed ones and returns zero, one, or two `pi.system` entry drafts, carrying any tool change on the last one.
- **Non-obvious design decisions:** The plan is **minimal by construction**: only changed section values are patched, `null` removes a section, and re-adding appends. When the patched order would differ from the desired order, the plan removes every shown section and re-adds every desired one in order (`planSections`, `:122`) — because order is part of the prompt's meaning. Tool declarations are kept when `declarationsEqual` says they are unchanged, so a tool change does not invalidate the whole tool list (`planTools`, `:100`); only when the resulting order would differ is every tool removed and re-added.
- **Edge cases / failure handling:** After a head marker with no later `pi.system` entry, the plan writes **one complete baseline** that omits every retained earlier `pi.system` entry — even when it restates the replayed values (`:73-82`).
- **Surprising:** `renderSections` keeps a section's **previous shown text** when it throws, so a failing extension degrades to the last good prompt instead of blanking a section (`prompt.ts:37-42`).

#### packages/durable/src/harness/agent.ts
- **Purpose:** Resolves the effective agent — the tools, sections, model and instructions a conversation actually runs with.
- **Key abstractions:** `AgentDoc` (`pi.agent`, rewindable, `fork: "asOf"`), `AgentState` / `AgentChange`, `resolveAgent(state, snapshot, settings, report)`, `DEFAULT_RETRY_POLICY` / `DEFAULT_COMPACTION_POLICY` / `DEFAULT_PROGRESS_POLICY`.
- **Data flow:** `resolveAgent` selects extensions from the stored selection, composes their tools and sections into maps, applies their wraps, filters by `state.tools` (what exists) and `state.modelTools` (what is *offered*), then assembles the `Agent`.
- **Non-obvious design decisions:** There are **two** tool filters, not one: `tools` is the set that exists, `modelTools` is the set offered to the model, and the difference is the *deferred* tools the model can still load (`offeredTools`, `:287-297`). A tool's `callers` field separates "callable by the model" from "callable by other tools" (`:260`). A wrapper that throws, or that renames its target, **drops its target** and is reported — a wrapper that renames the tool would silently break every call site (`:336-353`).
- **Edge cases / failure handling:** `addTools` (used by a tool's `addTools` control) appends by name **without consulting the registry**, so a tool of an MCP server that is reconnecting is offered once it is again (`:94-98`). `resolveSettings` merges field by field, so an explicitly `undefined` interval keeps its default (`:73-76`).
- **Surprising:** `createAgent` copies the **owner's** agent into a task-owned conversation, so a subagent starts with its parent's model and instructions; a fork keeps its `asOf` copy and an ownerless conversation starts empty (`:174`).

#### packages/durable/src/harness/harness.ts
- **Purpose:** The public surface — `Harness.open(storage, options, context)` and the `Conversation` handle.
- **Key abstractions:** `HarnessImpl` (extends the session kernel), `ConversationImpl`, `ConversationHost` (the services a conversation handle may use), `CreateTarget` (`root` | `independent` | `fork`).
- **Data flow:** `open()` verifies the registry holds the built-in tasks, constructs the harness, then `openTasks()` reconciles surviving `running` tasks to `pending`. Every conversation operation goes through `commitWith`, which is the Session's single writer.
- **Non-obvious design decisions:** "Only the Harness writes model context to a busy conversation" — the generation is the sole writer of the model context, which is what makes the compaction's admission rule safe. `boundConversation` gives a tool or task an **invocation-bound** handle: every operation first checks the invocation and runs under its signal, "so it rejects once the invocation ends; admitted work stays durable" (`:498-501`).
- **Edge cases / failure handling:** `safeNow` falls back to `Date.now` when the host clock throws — "a broken clock must not stop commits" — and reports only the first throw (`:474-483`). `safeReport` contains a throwing host callback and records **no error payload** in telemetry, only a type. If `openTasks` fails, the harness is closed without the (possibly broken) caller context and the original error is rethrown.
- **Surprising:** `Harness.open` **refuses** to open a registry that lacks a built-in task, with the names in the message — the built-ins are not an extension and cannot be replaced.

#### packages/durable/src/harness/events.ts
- **Purpose:** The experimental agent event stream — a typed, ordered event batch per commit, shaped like the coding agent's session events.
- **Key abstractions:** `AgentEvent` (a discriminated union of ~25 event kinds), `SnapshotEvent` (the state at attachment), `MessageChange` (a delta relative to the in-flight message), `ToolEventCall` (how to match a tool event to a call).
- **Data flow:** `watchEvents` captures the snapshot and the registration atomically on the Session line, then `translate()` diffs the before/after `pi.live` view of each publication and emits the events in the spec's order.
- **Non-obvious design decisions:** Tool-call IDs are matched, never parsed: a nested call's ID is `<parentCallId>/<key>` and the docstring says "Match events by it; do not parse it" (`:102-104`). A tool's `tool_execution_end` is emitted **directly before** its result's `message_end`, mirroring the coding agent (`:348`). The turn ends when the generation's outcome is committed — at the `completing` hold or at terminal, whichever comes first — so a successor created at the hold starts after it (`:376-379`).
- **Edge cases / failure handling:** A generation whose held outcome already ended its turn before the watch attached is found by scanning `completing` generations at attach time (`held` set, `:178`) — otherwise the client would wait forever for a `turn_end`. A slot that vanishes without becoming `done` (its run ended) still emits a `tool_execution_end`, with the result looked up from the entries of that commit.
- **Surprising:** `messageChanges` decodes the Chord **view operations** on `docs.pi.live.generation.message` into `text_delta` / `thinking_delta` / `toolcall_delta` events, falling back to a whole `message` event whenever the op shape is not one it understands — the UI gets fine-grained streaming without the backend knowing what a UI is.

#### packages/durable/src/harness/live.ts
- **Purpose:** The `pi.live` document — run control plus the presentation of the current generation and tool round.
- **Key abstractions:** `LiveState` (`run`, `generation`, `tools`, `nestedTools`, `compactions`, `compactionFailure`), `ToolSlot`, `NestedToolSlot`, `SlotProgress`, `CompactionStatus` / `CompactionFailure`.
- **Data flow:** The generation writes `pi.live` in the same commits that write the transcript; `events.ts` reads it to derive the event stream.
- **Non-obvious design decisions:** The `checkpointWhen` rule is the load-bearing one: "a complete base whenever nothing runs … so the delta chain spans at most one generation or the overlapping execution of one round's tools" (`live.ts:118-127`). A slot holds output only while running, so every base is small; a nested call's result lives in its caller's task document, never here. `toolSlot` finds a nested slot by **binary search**, because "a tool may make thousands of nested calls, each of which looks up its slot in several commits, and every element a search reads costs a node in the draft's change tracker" (`:176-180`).
- **Edge cases / failure handling:** `endRun` settles every input of the run and always removes `generation`, `tools` and `nestedTools`, "whose presentation belongs to the ending run". `settleSchedulerOutcome` is the Harness's cleanup for an outcome the scheduler wrote itself (faulted/orphaned): it converts a committed partial into an aborted assistant entry so the transcript keeps what the model produced and usage still counts.
- **Surprising:** `removeNestedSlots` removes the nested slots below a tool task **transitively**, relying on the list holding parents before their children (`:206`).

#### packages/durable/src/harness/submissions.ts
- **Purpose:** Admission, waiting and withdrawal of the durable submissions (user inputs and entry writes) of one Harness.
- **Key abstractions:** `Submissions` (the service), `SubmissionHandle` (the per-submission facade), `admitSubmission(tx, conversationId, draft, now, queueModes, span)` (the in-commit decision, shared with the compactor).
- **Data flow:** `submit()` opens a telemetry span, admits in one commit and returns a handle; the commit listener resolves waiters when a submission settles; `wait()` registers the waiter **on the Session line** so no settling publication falls between the check and the registration.
- **Non-obvious design decisions:** A **display-only write** (only `kind` and `data`) is appended and settled `done` at once, busy or not — "it changes nothing the model sees" — *except* behind a queued reset, where it queues so it lands after the reset instead of before it in the new context (`:194-196`). A known `requestId` returns the existing submission without writing a second one, which is how the compactor's `compaction:<taskId>` request id is idempotent. An input with `whenBusy: "reject"` raises `ConversationBusy`; `whenBusy: "steer"` is queued as a steer, everything else as a follow-up.
- **Edge cases / failure handling:** The submission's error text is never put in telemetry ("Error text may contain caller content. Record only the status", `:95`). An idle conversation with queued items queues the new submission **behind** them and runs a final boundary.
- **Surprising:** The admission of a steer **links** the submission's telemetry span to the running generation's trace, so the causal chain from "user typed while the agent was working" survives into the trace (`:231-239`).

#### packages/durable/src/harness/task-graph.ts
- **Purpose:** The live task graph as a replicated Chord state — every live task, its status, and why it cannot run.
- **Key abstractions:** `TaskGraphState` (status + phase, with `on`/`policy` for a waiter and `until` for a sleeper), `TaskGraphNode`, `TaskGraphView` (the mount).
- **Data flow:** The mount is built on the Session line by the first observer and dropped with the last; `advance()` derives the ops from each publication and applies them immutably; `#refreshBlocked()` re-derives every node's blocked reason when the registry changes, **without a commit**.
- **Non-obvious design decisions:** The mount keeps only `BlockedSubject` (id, kind, version, abort flags, restarts) per task, "so a registry change can derive it again without payloads" (`:64-65`). The blocked reason is a **first-class part of the graph**, with four values: `missing_task`, `task_too_old`, `migration_failed`, `restart_limit` — a client can render "this task is stuck and here is why" without asking the scheduler.
- **Edge cases / failure handling:** A conversation created with its owner task in one commit is handled *after* the tasks in the same publication, because "change order within a publication is unspecified" — each owner's conversation list is sorted again (`:238-249`).
- **Surprising:** `stateOf` maps `terminal` to `{ status: "completing", outcome }` — a terminal record never reaches the graph, because terminal tasks leave it.

#### packages/durable/src/harness/registry.ts
- **Purpose:** The extension registry — the published set of installed extensions, their tools, sections and tasks.
- **Key abstractions:** `RegistryState` (the immutable snapshot), `RegistryImpl` (install/uninstall/subscribe), `BUILTIN_TASKS`.
- **Data flow:** `install()` validates, builds the next `RegistryState` and publishes it **synchronously** to the listeners; the scheduler subscribes and re-derives what it can.
- **Non-obvious design decisions:** The built-in tasks live in the snapshot but "are not an extension and cannot be removed or replaced" (`:9`); an extension task whose name collides with a built-in throws at publish time (`:26`). Section keys are validated by a regex *and* the reserved `instructions` key is refused (`:104-105`).
- **Edge cases / failure handling:** Installing the same name twice **replaces** rather than duplicates (`:76-78`).
- **Surprising:** `snapshot()` returns the current state by reference — it is immutable by construction, so it can be read from anywhere without a copy.

#### packages/durable/src/harness/define.ts
- **Purpose:** Typing helpers for extension authors — identity functions that give inference to the extension/tool/section/wrap shapes.
- **Key abstractions:** `defineExtension`, `defineTool`, `section(key, render, { tag })`, `hook(task, handlers)`, `wrapTool`, `wrapSection`.
- **Data flow:** None; these are constructors of plain objects.
- **Non-obvious design decisions:** `section()` omits `tag` entirely when it is not given, so "tagged unless `tag` is false" — the default is on, and the property is absent rather than `true` (`:25`).
- **Edge cases / failure handling:** `hook()` binds the handler set to the task's **name**, not to the task object, so a hook survives a definition swap (`:30`).
- **Surprising:** `wrapTool`/`wrapSection` record the target **by name** — the wrapper applies wherever the wrapping extension is selected, not to one particular object.

#### packages/durable/src/harness/json.ts
- **Purpose:** One function: assign a value into a JSON container **leaf by leaf** so the storage records an append instead of a whole-container set.
- **Key abstractions:** `assignJson(target, key, value)`.
- **Data flow:** Used by the generation's partial-commit path to update `pi.live.generation.message` in place.
- **Non-obvious design decisions:** The stated reason is the whole point of the file: "Chord records a container assignment as one full set and only emits an append when a string leaf is reassigned with a longer string, so writing the partial whole would store and publish the complete message on every flush" (`:6-9`).
- **Edge cases / failure handling:** Keys present in the current object but absent in the new value are **deleted**, so a shrinking message does not keep stale leaves; an array that shrinks is replaced wholesale (the append path requires `current.length <= value.length`).
- **Surprising:** The recursive structure is the whole trick — a nested record is merged leaf by leaf, so a changing text block produces a `text_delta` in the event stream rather than a full-message rewrite.

#### packages/durable/src/harness/provider.ts
- **Purpose:** The provider-facing identity of a conversation — one stable session id per conversation.
- **Key abstractions:** `ProviderDoc` (`pi.provider`), `ensureProviderSessionId(runtime, context)`.
- **Data flow:** The generation reads the id before every request and passes it as `sessionOptions.sessionId`.
- **Non-obvious design decisions:** `fork: "initial"` — "every fork starts with a fresh identity instead of copying its parent", so a fork does not share the parent's provider-side session (`:11`). The id is a uuidv7, so it is time-ordered and collision-free without coordination.
- **Edge cases / failure handling:** A legacy conversation with no `pi.provider` gets **one migration commit** whose `tx.doc()` runs `initial()` — the normal path writes nothing (`:22-25`).
- **Surprising:** The document is `checkpointWhen: () => true`, i.e. it always takes a checkpoint, so the id survives document retention.

#### packages/durable/src/harness/telemetry.ts
- **Purpose:** The content-free telemetry vocabulary of the durable package.
- **Key abstractions:** `DURABLE_TELEMETRY_SCHEMA` — two spans, three metrics, and the event schemas.
- **Data flow:** The spans are started by the harness (`pi.durable.submit`, `pi.durable.phase`); the events are added to a span's context (`pi.durable.entry`, `pi.durable.submission`, `pi.durable.report`, `pi.durable.checkpoint`, `pi.durable.replay`).
- **Non-obvious design decisions:** The schema's stated principle is "IDs address durable records, never content" (`:49`), and the report event says "no error payload is recorded" — only a fixed type, a fixed reason enum and a task id (`:37`). Even the error message of a faulted task is capped at 500 characters in the span status.
- **Edge cases / failure handling:** The report `type` is a closed enum (`session_failed`, `task_faulted`, `task_parked`, `migration_failed`, `task_outdated`, `task_error`, `extension_error`, `host_error`, `listener_error`) and the `reason` is a second closed enum — so a dashboard can group without parsing prose.
- **Surprising:** `pi.durable.tasks.active` is an **upDownCounter** — a live-task gauge maintained by the scheduler's commit listener, decremented at terminal settlement *or at close* (so a closed harness does not leak a permanently elevated gauge).

#### packages/durable/src/env/index.ts
- **Purpose:** The portable execution-environment contract a durable harness runs against.
- **Key abstractions:** `ExecutionEnv extends FileSystem, Shell`; `Result<TValue, TError>` (never throws); `FileError` with a `FileErrorCode`; `ExecutionError` with an `ExecutionErrorCode`; `BinaryReader`, `DirReader`, `TextLineReader`, `FileWatcher`.
- **Data flow:** Every operation returns a `Result`; the caller must branch. The environment is reached from the harness through `HarnessOptions.env`, which builds one per conversation from its `cwd`.
- **Non-obvious design decisions:** "Portable filesystem capability. Operations return failures rather than throwing" (`:208`). The `FileSystem.id` is the **file namespace**: equal ids see the same files whatever their `cwd`; every local Node environment shares one id and each container or remote host has its own (`:210-214`). `Shell.exec` takes a **string or an argv array**: an array runs `command[0]` directly, "so they reach the program unparsed".
- **Edge cases / failure handling:** `openBinaryReader` with `noFollow` fails with `invalid` on a final-component symlink; `listFiles` fails with `not_supported` when the environment cannot list right now, "so callers fall back to their own walk" (`:249`). `ShellOutputWindow` lets a slow link omit output the caller would drop anyway, and reports the omission as `info.skipped` with a measured byte/newline count.
- **Surprising:** `ShellOutputSkip` measures the omitted text in **decoded** terms — "every U+FFFD counts as three bytes, and no sanitizing is applied" (`:334-336`) — so the reported omission matches what the caller would have received.

#### packages/durable/src/env/node.ts
- **Purpose:** The Node implementation of `ExecutionEnv`.
- **Key abstractions:** `NodeExecutionEnv` (`id: "node:local"`), `NodeTextLineReader`, `NodeBinaryReader`, `NodeDirReader`; plus `getShellConfig`, `killProcessTree`, `waitForChildProcess`.
- **Data flow:** A tool call reaches `exec()`, which resolves the shell, spawns, feeds stdout/stderr through per-stream decoders into `onOutput`, spills to a temp file past the thresholds, and settles with the exit code.
- **Non-obvious design decisions:** On Windows the shell is Git Bash, and a **legacy WSL `bash.exe` is driven over stdin** (`commandTransport: "stdin"`) rather than `-c` — `isLegacyWslBashPath` exists because WSL's bash mis-handles `-c` quoting (`:209-224`, with a "keep in sync with packages/coding-agent/src/utils/shell.ts" note). The child is `detached` on non-Windows so `killProcessTree` can `kill(-pid)` the whole group; on Windows it shells out to `taskkill /F /T`. The exit code of a signalled process is mapped to `128 + signal` so "callers do not mistake it for a successful exit" (`:894-897`).
- **Edge cases / failure handling:** `resolveTimeoutMs` rejects a non-finite or non-positive timeout and caps at the 32-bit maximum. `openBinaryReader` uses `O_NONBLOCK` so opening a FIFO does not wait for a writer, and maps `ELOOP`/`EMLINK` to a symlink refusal. `waitForChildProcess` waits for stdout/stderr `end` after `exit` with a 100 ms grace that is re-armed while the spill is still draining — so no output is lost to an early exit.
- **Surprising:** The spill path has real **backpressure**: when the write stream returns false, stdout and stderr are paused and resumed on `drain` (`:770-779`), and a spill failure aborts the command rather than silently losing the output.

#### packages/durable/src/env/node-watch.ts
- **Purpose:** A file watcher that reports changes by **snapshot diff**, not by trusting OS events.
- **Key abstractions:** `NodeFileWatcher`, `NodeWatchOptions`, `Snapshot` (path → identity entry), `WatchChange` (`paths` | `overflow` | `error`).
- **Data flow:** `open()` resolves the targets, picks a mode, and takes an initial snapshot; native events only *trigger* a debounced rescan; the reported change set is the diff between the old and new snapshots plus the event paths.
- **Non-obvious design decisions:** The stated reason is the whole design: "A replaced file, a renamed or recreated ancestor, or a directory created with its contents therefore never depends on which events an operating system sends" (`:133-138`). Windows polls because "a native watcher keeps every watched directory open" and would block renaming their parents (`:180-186`). macOS gets a 500 ms settle rescan because `fs.watch` returns before FSEvents is live and ~2 % of changes in that window are never reported (`:47-52`). A file system whose `statfs` magic is NFS/SMB/CIFS/FUSE/9P/… is treated as unreliable and polled (`:61-74`). In polling mode, recently modified small files are **hashed** because "a second write within the file system's timestamp granularity can keep size and modification time" (`:55-58`).
- **Edge cases / failure handling:** A watcher follows the **directory it was installed on, not the path** — when a directory's dev/ino changes it is closed and reinstalled (`:431-438`). Running out of watches switches the whole watcher to polling and reports `{ overflow: true }`, which tells the host to rescan everything. A directory budget (default 10 000) raises `invalid`. An unreadable directory **below** a target is skipped; the target itself must be readable.
- **Surprising:** Ancestors are recorded with `size: 0, mtimeMs: 0` — identity only — "an ancestor's own timestamps change with every unrelated sibling" (`:383`).

#### packages/durable/src/env/line-scan.ts
- **Purpose:** Locate a line range of an arbitrarily large file from bytes fed in order, in bounded memory.
- **Key abstractions:** `LineScanner(startLine, endLine?)`, the `LineScan` result (`newlines`, `start`, `end`, `firstLineEnd`, `lastLineStart`, `selectedBytes`, `firstLineBytes`).
- **Data flow:** `push(chunk)` accumulates; `finish()` returns the scan. The scanner counts newlines as it goes and opens a decoder only once the selection starts.
- **Non-obvious design decisions:** The decoded sizes must equal "those of the text `new TextDecoder().decode(file)` would produce for that range, so a byte-order mark at the start of the file is not counted" (`env/index.ts:102-105`) — hence the separate head buffer that holds the first three bytes until it is known whether they are a BOM (`:30-32`, `:57-62`).
- **Edge cases / failure handling:** An invalid range throws `RangeError` in the constructor. A selection past the last line is empty at the end of the file. The first three bytes are skipped from the decoded size when a BOM was found.
- **Surprising:** The scanner keeps **two** decoders — one for the whole selection and one for the first line — so `firstLineBytes` is exact even when the selection is huge.

#### packages/durable/src/env/decode.ts
- **Purpose:** Decoding that matches `new TextDecoder().decode(bytes)` of the whole input when the input arrives in pieces.
- **Key abstractions:** `rangeDecoder()`, `startsWithBom(bytes)`, `StreamDecoder`.
- **Data flow:** `StreamDecoder.decode(bytes?)` holds back an incomplete character and, on the first call, strips a leading U+FEFF.
- **Non-obvious design decisions:** Node's streaming decoder with BOM handling "can drop a U+FEFF that follows a chunk boundary, not only a leading byte-order mark, so these decoders turn BOM handling off and drop a leading mark themselves" (`:1-5`).
- **Edge cases / failure handling:** "U+FEFF encodes only as EF BB BF, so a leading U+FEFF is exactly a byte-order mark at the stream's start" (`:27`).
- **Surprising:** `ignoreBOM: true` in `TextDecoder` means *ignore the BOM flag*, i.e. do **not** strip it — the stripping is done by hand so the behaviour is chunk-boundary independent.

#### packages/durable/src/codemode/describe.ts
- **Purpose:** The code-mode prompt surface — the tool's fixed description and the `codemode` system section.
- **Key abstractions:** `CodemodeNamespace` (a name prefix such as `mcp__github__`), `codemodeDescription(models)`, `codemodeSection(tools, namespaces, budget)`, `selectCatalog(groups, budget)`.
- **Data flow:** The section is rendered from the conversation's **callable** tools, so it changes with them; the tool's description never does.
- **Non-obvious design decisions:** The catalogue is selected round-robin by cost: "in each round every group (tools without a namespace first, then namespaces by name) places its cheapest remaining tool; a group whose next tool does not fit drops out while the others continue. **Every namespace is represented before any namespace is complete**" (`:93-95`). The tool that does not fit is found with `searchTools()`, and a namespace whose tools were all dropped is labelled "(tools not listed)" so the model knows to look (`:141-153`).
- **Edge cases / failure handling:** With no callable tools the section is `undefined` (omitted entirely). A tool whose identifier changes is headed `### \`id\` (\`raw name\`)` so the model can still call it by the raw name.
- **Surprising:** The budget is estimated at **4 characters per token** — a crude but consistent estimator shared with the output formatter.

#### packages/durable/src/codemode/models.ts
- **Purpose:** The `models.*` global namespace available to code-mode scripts.
- **Key abstractions:** `MODEL_CALLS` (global → internal tool), `CATALOG_GLOBALS`, `MODELS_DESCRIPTION`, `createModelTools()`, `resolveModel`, `checkClassifierContext`, `checkImagesContext`.
- **Data flow:** A script's `models.classify(...)` call is turned by the code-mode tool into a call of the internal tool `pi.codemode.models.classify`, which runs as a **nested durable call** with its own task, live row, abort, usage accounting and replay policy.
- **Non-obvious design decisions:** `models.classify()` and `models.generateImages()` are paid effects, so each runs as an internal tool with `callers: ["tools"]` and a reserved name — "hidden from scripts' tool listings" (`:5-8`). The model is resolved **by provider and id only**, "so a script-supplied baseUrl or headers never receive the credentials" (`:197-201`), and `headers` are dropped from the catalog a script sees (`:87-88`).
- **Edge cases / failure handling:** The classifier and image contexts are **shape-checked before the call**, with error messages that show the expected shape, so a script mistake fails as a shape error rather than a provider error (`:123`). If the provider/id resolves to a model of the *wrong type*, the error says so explicitly ("is an image model, not a classifier model") rather than "unknown" (`:220-227`).
- **Surprising:** At most `MAX_CONCURRENT_MODEL_CALLS = 4` classify/generateImages calls run at once; the rest wait — a concurrency cap inside a script, stated in the prompt.

#### packages/durable/src/codemode/output.ts
- **Purpose:** Format a code-mode script's result for the model.
- **Key abstractions:** `formatResult(result, options)`, `OutputFile` (the writer the harness supplies), `Limits` (the harness's max bytes/lines).
- **Data flow:** `formatItems` separates text and console lines → `joinAdjacentText` merges adjacent text → `truncate` applies the token budget → `saveImages` writes images to temp files → `joinAdjacentText` again → the header is prepended.
- **Non-obvious design decisions:** Truncation keeps the **head and the tail** of the text and spills the complete text to `output.txt`, whose path is given to the model ("read with offset/limit") (`:98-126`). The budget is `min(maxTokens × 4, floor(maxBytes / 4))` because "a UTF-16 unit is at most 3 UTF-8 bytes" (`:106-107`). A failed image write does **not** discard the result — it becomes part of the label (`:134`).
- **Edge cases / failure handling:** With several text items each starts with `==> text N/M <==` so the model can tell them apart; console lines are collected into one `<console_output>` block. If `models.generateImages()` returned images the script never showed, the result says so and tells the model how to show them.
- **Surprising:** `joinAdjacentText` checks the **last non-empty part** rather than the joined text, "because reading the end of a growing concatenation makes V8 copy it on every item, which is quadratic" (`:63-66`) — a concrete V8-specific optimisation.

#### packages/durable/src/codemode/index.ts
- **Purpose:** Barrel for the code-mode surface.
- **Key abstractions:** None of its own.
- **Data flow:** Re-exports `createCodemodeExtension`, `createCodemodeTool`, `CodemodeStoreDoc`, the reserved names, and `CodemodeNamespace` / `DEFAULT_CODEMODE_INLINE_BUDGET`.
- **Non-obvious design decisions:** The public surface is exactly the extension factory, the tool factory, the store document and the type/constant set — everything else stays private.
- **Edge cases / failure handling:** None.
- **Surprising:** `CODEMODE_MODULE_VERSION` is exported here, so a host can check the code-mode module version it was built against.

#### packages/durable/src/documents.ts
- **Purpose:** The durable document model — typed, versioned, scoped JSON documents.
- **Key abstractions:** `defineDoc` / `defineDocFamily` (overloaded by scope: `session`, `conversation`, `task`), `AnyDocDefinition`, `DocumentAddress` / `ResolvedAddress`, `materializeDocument`.
- **Data flow:** A typed access resolves the overload's argument list to a logical address → a stable string id → the storage record → a materialised value (migrated if the stored version is older).
- **Non-obvious design decisions:** A conversation-scoped document declares its **history** (`latest` or `rewindable`) and its **fork** behaviour (`initial` or `asOf`) at definition time, and the scope check rejects a token whose declared semantics disagree with the persisted record (`:167-176`). A fork with `asOf` means "the value as of the fork entry" — this is how a fork inherits the agent at its fork point.
- **Edge cases / failure handling:** `checkRecordVersion` refuses a stored version **newer** than the definition ("has newer version X than Y") and a stored version older with no `migrate` ("requires migration from version X").
- **Surprising:** `addressId` is `JSON.stringify([kind, scopeKind, owner, key])` — the document's identity is its *logical* address, not its storage id, so a document is stable across migrations.

#### packages/durable/src/entries.ts
- **Purpose:** The six transcript entry kinds.
- **Key abstractions:** `defineEntry(kind)` (with an `is()` narrowing guard), `UserEntry`, `AssistantEntry`, `SystemEntry`, `ToolResultEntry`, `ResetEntry`, `CompactionEntry`.
- **Data flow:** Entries are the transcript; each carries `model` (the messages), optionally `head` (a context boundary) and `data` (structured payload).
- **Non-obvious design decisions:** Every entry's docstring states **who writes it** — "Written by submissions", "Written by generation", "Written by tool tasks, and by generation for calls it did not offer" — which is the ownership rule in one line each.
- **Edge cases / failure handling:** `defineEntry` throws a `TypeError` on an empty kind.
- **Surprising:** `ToolResultEntry`'s `data` holds the structured diagnostics while the **content** of the message ends with the *rendered* diagnostics block — the structured form and the human form are stored separately, so a machine reads `data` and a model reads the text.

#### packages/durable/src/errors.ts
- **Purpose:** Four error types with deliberately different blast radii.
- **Key abstractions:** `errorMessage(error)`, `ReadAfterWrite`, `StorageRequestError`, `SessionFailed`, `ConversationBusy`.
- **Data flow:** Errors are raised inside commits and readers; the caller decides whether the read fails, the session fails, or the caller is merely told the conversation is busy.
- **Non-obvious design decisions:** `errorMessage` never throws: `String()` throws for `Object.create(null)`, "and code that formats an error must not fail for the value it formats" (`:4-5`). `StorageRequestError` "fails only that read, not the Session; from `commit()` it is fatal like any other" (`:24-27`) — the same class has two lifetimes depending on where it is thrown.
- **Edge cases / failure handling:** `ReadAfterWrite` is the storage's enforcement of "read every required row before writing" — the rule that forces the boundary/compaction code to prepare its reads at the start of a commit.
- **Surprising:** `SessionFailed` says "close and reopen it" — recovery is by reopening the session, and "reopening recovers from what was committed".

## Ideas worth stealing

*Each idea names a mechanism, the exact place it lives, and why it transfers to the August harness. The `path:line` references were re-verified in this pass.*

- **Never let a compaction cut separate a tool call from the result that answers it** — `packages/durable/src/harness/compaction.ts:299` — `isCandidate()` refuses a cut that would leave an assistant's `toolCall` in the summarised span while its `toolResult` stays outside. This is exactly the orphaned-`tool_use_id` failure mode August has to repair at runtime with `_stuckRequestEscape`: an unmatched tool call in persisted history makes every later provider request fail the same way, and the only escape is deleting the session. pi prevents it structurally at the cut-selection step, so the repair ladder is never needed. The same rule is pinned as a *test* at `packages/durable/test/harness-compaction.test.ts:253` ("never cuts at a tool result").
- **A compaction cut is chosen by token budget but validated by message pairing** — `packages/durable/src/harness/compaction.ts:279` — `selectCut()` walks back from the tail until `keepRecentTokens` are kept, then snaps to the first *candidate* at or after that point, where a candidate is an entry whose contribution starts with a user or assistant message and never a tool result. The budget decides *where*, the pairing rule decides *whether it is legal*. August's compaction currently selects by token count alone; adding this predicate is cheap and removes a whole class of stuck conversations.
- **Move only the FIRST system message to the front, and only when it is the baseline** — `packages/durable/src/harness/context.ts:212` — the stated reason is provider prefix caching: "providers treat only a leading system message as the initial prompt and tool set; without it, a later tool change rewrites the request's tool list and invalidates the whole prompt cache" (`context.ts:206-208`). A system message that was committed mid-conversation stays where it was, because moving it "would change what it means to the model". August's prompt assembly would benefit from the same rule: hoist the baseline, never reorder history. pi *proves* the rule against a live provider at `packages/durable/test/system-order-cache-e2e.test.ts:137` (cache-read share < 0.2 with the order flipped, > 0.8 with the fix) — the same measurement August could make against its own gateway.
- **Patch the system prompt minimally so the provider's prefix cache survives** — `packages/durable/src/harness/prompt.ts:66` — `planSystemEntries()` computes the smallest set of `pi.system` entries that makes the *replayed* sections and tools equal the desired ones. Changed values are patched, removals are `null`, and **only** when the patched order would differ is everything removed and re-added (`prompt.ts:122`). Tool declarations are kept when byte-equal (`prompt.ts:100`). August rebuilds its system prompt on every turn; this mechanism keeps the prompt prefix byte-identical across turns unless the prompt genuinely changed. The pinned behaviour is `packages/durable/test/harness-prompt.test.ts:141` ("emits minimal value patches, removals, and additions").
- **Derive the context incrementally from an immutable tail** — `packages/durable/src/harness/context.ts:73` — `readContextFrom()` reuses the previous range: with the same head marker only the entries after the previous tail are scanned, and a range that shrank is filtered rather than rescanned. The tail is captured in two O(1) reads **on the Session line** and the scan happens off it. August's context assembly re-reads the whole transcript per turn; this is the shape of an incremental reader that is safe under concurrency, and it is pinned at `packages/durable/test/harness-context.test.ts:426` ("extends a task's context read with only newer entries").
- **A streamed partial is copied synchronously before it is committed** — `packages/durable/src/harness/generation.ts:466` — the comment is explicit: "Copy synchronously: the provider keeps mutating its partial." The throttle flushes at most every `progress.partialIntervalMs` (default 100 ms) with **one commit in flight**, and the `finally` block stops the throttle and awaits that commit, "so no stale partial lands after the outcome" (`generation.ts:493-497`). Both halves matter: the copy (the provider mutates the object you were about to serialise) and the await-on-teardown (a partial that lands after the final answer is a phantom message in the transcript). The throttle itself is pinned at `packages/durable/test/harness-generation.test.ts:533`.
- **Assign a streamed message leaf by leaf so the storage emits an append, not a full set** — `packages/durable/src/harness/json.ts:10` — `assignJson()` walks the object and assigns only the leaves that changed; Chord then records a string leaf's reassignment as an append. The same mechanism is what lets the UI receive `text_delta` / `toolcall_delta` events instead of a whole rewritten message (`packages/durable/src/harness/events.ts:423`). August's SSE stream currently ships whole assistant blocks; this is a cheap way to get true incremental deltas out of a document store, and the delta shape is pinned at `packages/durable/test/harness-live-deltas.test.ts:259`.
- **Park a task that was cut off N times instead of retrying it forever** — `packages/durable/src/harness/scheduler.ts:1366` — a task whose restart count reaches `settings.restartLimit` (default 5) is *parked*: it stops being a candidate, the graph shows `blocked: "restart_limit"`, the host is told, and `retryTask()` clears the count. This is a crash-loop bound expressed as durable state rather than an in-memory counter. August's runaway budget counts rounds; this counts *process deaths*, which is the failure mode a durable harness actually has. The behaviour is pinned at `packages/durable/test/harness-blocked.test.ts:135`.
- **An abort cascade is derived from durable records, so a crash repairs it** — `packages/durable/src/harness/scheduler.ts:776` — `#reconcile()` re-derives the abort marks below every live owner with cancellation intent from the committed task records: "The durable records are the intent, so this also repairs whatever a crash left unapplied" (`scheduler.ts:773`). Any reconcile pass may run concurrently with any other; the marks are idempotent because they are recomputed from the records, not accumulated. The two-commit barrier that keeps a phase from advancing before the mark lands is pinned at `packages/durable/test/harness-cancellation-barrier.test.ts:79`.
- **A wait may not close a cycle in the wait-for graph, and `failFast` may only wait on tasks you own** — `packages/durable/src/harness/scheduler.ts:1973` — `#validateWait()` throws with the cycle path in the message (`A -> B -> A is a wait cycle`), and the abort handler may neither wait nor sleep. The graph's edge definition ("X cannot settle before Y") is stated precisely at `scheduler.ts:2004-2006`. Any multi-agent orchestration needs this: a deadlock discovered at wait time is a normal error, not a hang — and the cycles are pinned at three depths in `packages/durable/test/harness-structured.test.ts:500`.
- **Steering and follow-up are separate queues with separate modes, drained at two named boundaries** — `packages/durable/src/harness/inbox.ts:70` — `applyBoundary(tx, boundary, "postTools" | "final", now)` places writes first and user items after, each in ID order; the `steeringMode` and `followUpMode` settings decide whether **one** or **all** of each kind are taken; a selected reset promotes a `postTools` boundary to `final`. This is the clearest statement of the steering model in the repo, and it separates "the user interrupts now" from "the user adds to the queue". The whole matrix is pinned in `packages/durable/test/harness-inbox.test.ts:110-236`.
- **A write whose head points before the active range is `stale`, not applied** — `packages/durable/src/harness/inbox.ts:145` — `isStale()` compares the write's `head` with the boundary's current head; a write that would resurrect context the conversation has already moved past is settled `unanswered` with reason `stale` instead of being applied. A compaction or a reset makes previously-valid writes stale, and the harness has to say so rather than silently ignoring them.
- **Only the harness writes model context to a busy conversation** — `packages/durable/src/harness/compaction.ts:432` — the `REMINDER` there is the invariant: "nothing else may append to a busy conversation, so every non-blocking summary goes through admission." A generation-owned compaction appends directly (it holds the run); a conversation-owned one places its summary through a *write submission* that the normal admission path queues. This one rule is what lets compaction, tool results and user input coexist without interleaving — and it is the reason the harness has a single writer for the transcript.
- **A wrapper that throws or renames its target DROPS the target and is reported** — `packages/durable/src/harness/agent.ts:336` — `applyWrap()` deletes the tool from the map and reports the error, so a broken plugin degrades to "that tool is not available" rather than to a tool that misbehaves at call time. The rename check ("Wrapper renamed X to Y") exists because a wrapper that changes the name would silently break every call site. August's extension/plugin layer wants the same fail-loudly-then-degrade rule; it is pinned at `packages/durable/test/harness-registry.test.ts:223`.
- **Two tool filters, not one: `tools` is what exists, `modelTools` is what is offered** — `packages/durable/src/harness/agent.ts:287` — `offeredTools()` keeps the non-deferred tools plus the deferred ones the model has explicitly loaded, and the difference is the `deferred` list the runtime keeps for progressive disclosure. August's `toolDefinitions(session)` / `openaiToolDefinitions` capability filtering has an equivalent split but not an explicit deferred-tool ledger; this is a clean way to model "offered now, loadable later" — and pi's `tool_search` shows the whole mechanism working, including "the load appended the declaration: no tool was removed and declared again, so the cached prefix holds" (`packages/durable/test/tool-search.test.ts:89`).
- **Watch files by snapshot diff, not by trusting OS events** — `packages/durable/src/env/node-watch.ts:139` — "A replaced file, a renamed or recreated ancestor, or a directory created with its contents therefore never depends on which events an operating system sends." Native events only trigger a debounced rescan; the reported change set is the diff. Windows polls (a native watcher holds the directory open and blocks renaming its parent), macOS gets a 500 ms settle rescan, and NFS/SMB/FUSE/9P are detected by `statfs` magic and polled.
- **Resolve a model by provider and id only, and drop `headers` from anything a script can see** — `packages/durable/src/codemode/models.ts:201` — `resolveModel()` deliberately ignores any `baseUrl` or `headers` on the model's descriptor "so a script-supplied baseUrl or headers never receive the credentials", and `toModelInfo()` deletes `headers` from the catalog a script reads (`models.ts:88`). August's outbound scrubbing is a transport-level defence; this is a *construction*-level defence that never puts the secret in the object the untrusted code can see — pinned at `packages/durable/test/codemode-models.test.ts:143`.
- **Content-free telemetry: IDs and closed enums, never error payloads** — `packages/durable/src/harness/telemetry.ts:37` — the report event's description is "A report was raised; **no error payload is recorded**"; the schema carries a fixed `type` enum, a fixed `reason` enum, the extension name and the task id, and a faulted task's message is capped at 500 characters. August's telemetry should be able to say "the task faulted" without ever writing a user-visible string into a metric.
- **A phase that returns without changing its checkpoint is a FAULT, not a no-op** — `packages/durable/src/harness/scheduler.ts:1829` — `#decide()` compares the committed state with the previous one and, if they are equal, writes `faulted` with "Task X phase Y returned without durable progress". This is the durable analogue of August's "a phase that never advances is spinning" rule, and it is enforced by the *scheduler*, not by the task: no task can opt out, and the fault is visible in the graph and the telemetry span. It is pinned at `packages/durable/test/harness-tasks.test.ts:120`.
- **The summariser's request must not pollute the live prefix cache** — `packages/durable/src/harness/compaction.ts:176` — the compaction request sets `cacheRetention: "none"`, and `serializeConversation()` omits thinking blocks because "replayed thinking is often not part of the live context (a block that does not match its request is dropped), so including it can make the request larger than the context it summarizes" (`compaction.ts:374-379`). August's compaction summariser would benefit from the same two exclusions.
- **Keep the durable write path honest by testing it against the old implementation** — `packages/durable/test/tools-read-differential.test.ts:17` — the whole-file `read` tool is kept *in the test file* as the oracle, and 400 random files × 4 random (offset, limit) pairs must produce byte-identical output, diagnostics included. A bounded implementation is a rewrite of an unbounded one; keeping the old one as the specification turns "same behaviour" into a property test rather than a promise. August's `read_file` paging work would get the same protection for free.
- **A conformance suite written once and run against every backend** — `packages/durable/test/memory-storage.test.ts:8` — `registerStorageConformance` is registered for MemoryStorage, SQLite (`:169` of `sqlite-storage.test.ts` is the per-backend part), JSONL (`jsonl-storage.test.ts:318`), IndexedDB (`indexeddb-storage.test.ts:106`, and again with a storage that reopens after every commit, `:108`) and Durable-Object SQLite (`test-workers/storage.test.ts:13`). One contract, five implementations, and a browser-safety check on top (`packages/durable/test/storage-runtime-boundary.test.ts:26`).
- **Make the crash windows a table, not a claim** — `packages/durable/test/jsonl-storage.test.ts:458` — the JSONL storage's failure matrix is enumerated per *mode* (append / flush) and per *call*, and each cell asserts what the recovery is allowed to see. The same discipline appears in the task engine (`packages/durable/test/harness-tasks-recovery.test.ts:291-427` walks each crash point of an abort in turn). August's storage layer is the place where the same table would pay off.

## Files skipped (with reasons)

None. All 130 files in the manifest's `durable#2` list were opened: the small ones (config, fixtures, support, examples) read in full; the large ones (`harness-compaction.test.ts` 108 KB, `harness-structured.test.ts` 84 KB, `harness-ownership.test.ts` 63 KB, `harness-tasks.test.ts` 55 KB, `harness-nested-tools.test.ts` 51 KB, `harness-tools.test.ts` 48 KB, `codemode.test.ts` 46 KB, `env-node.test.ts` 40 KB, `jsonl-storage.test.ts` 41 KB, `harness-context.test.ts` 41 KB, `harness-telemetry.test.ts` 41 KB, `harness-inbox.test.ts` 42 KB) were read with their full `describe`/`it` structure extracted and the surrounding source read, so that every behaviour named in the notes is a behaviour that appears in the file. Nothing in this shard is generated, vendored, binary or bulk data.

## Uncertainties

- **The manifest's shard column disagrees with the previous pass's work, and I did not rewrite it.** The manifest's `durable#2` rows are the 130 test/example/benchmark/config files listed above; the 29 `packages/durable/src/**` files the *previous* pass of this shard read are labelled `durable#1` in the same manifest, with `status: read` and a note that duplicates the previous pass's ledger note almost word for word (for example `packages/durable/src/harness/generation.ts`, manifest line 1637). Either the shard column for those 29 rows was rewritten after the first pass — the failure mode the brief warns about — or the first pass read the wrong half of the package. I covered **both** halves: Part A is the manifest's list, Part B retains the first pass's notes verbatim (with the citations re-verified in this pass). I made no edit to `manifest.tsv`.
- **The spec was not read.** The code cites `packages/durable/docs/spec.md` constantly (`spec §5.1`, `§5.4`, `§5.5`, `§6`, `§8.2`, `§8.3`, `§5.7`, `§12`), and the tests cite it too (`packages/durable/test/harness-compaction.test.ts:231`, `packages/durable/test/harness-scheduler-indexes.test.ts:1-2`). That file is not in my list, so every "spec §N" reference in these notes is unresolved — I read the *code and the tests*, not the requirement they implement.
- **Four sibling modules that these files call are in other shards and were not read:** `packages/durable/src/harness/tool.ts` (the tool task, the tool-result writer and `harnessError`), `packages/durable/src/harness/types.ts` (the `TaskRuntime`/`Agent`/`ToolRegistration`/`Settings` type contracts), `packages/durable/src/harness/view.ts` (`ConversationViews`, the source of the `pi.live` view the event translator diffs) and `packages/durable/src/session/session.ts` (`SessionImpl`, the "Session line" and `commitWith` that every rule in this shard depends on). Where I describe them I do so only from the call sites I read.
- **`harness/tool.ts` is the gap that matters most for the tool lens.** The tool *definition*, *validation* and *execution* live there, not here: this shard only contains the tool **round** (which calls are offered, which get a task, which are sequential, how a round terminates) and the tool **presentation** (`ToolSlot` in `live.ts`). The claims in `harness-tools.test.ts` about argument validation and `beforeTool` blocks are the *test's* claims; I could not check them against the implementation.
- **The `codemode` sandbox itself is in another package.** `packages/durable/test/codemode.test.ts` and `codemode-bench.ts` import `CodemodeSandbox` from `@earendil-works/pi-codemode`, and `tools-images.test.ts` imports Photon — neither package is in my shard, so "the sandbox fingerprints the module version" is the test's premise, not a verified mechanism.
- **Two live e2e lanes were not run** (and I must not run anything): `packages/durable/test/system-order-cache-e2e.test.ts` needs Anthropic credentials and asserts a cache-read share of 0.8 vs 0.2; `packages/durable/test/provider-session-cache-e2e.test.ts` needs Codex credentials and asserts ≥ 0.9 cache hits. Both are skipped without credentials, so I read their assertions but could not observe the behaviour.
- **The benchmarks were read, not executed.** `codemode-bench.ts`, `document-append-bench.ts`, `nested-images-bench.ts`, `nested-tools-bench.ts`, `scheduler-fanout-bench.ts`, `scheduler-memory-bench.ts`, `session-document-cache-bench.ts`, `storage.bench.ts`, `tool-output-bench.ts` and `storage-memory.ts` all report numbers I have no way to confirm here; I describe their *mechanisms* and their own stated acceptance criteria, not their results.
- **One mechanism I inferred rather than read:** `generation.ts` calls `runtime.models.streamSimple(...)` and `runtime.models.completeSimple(...)` with `{ messages }` and a `SimpleStreamOptions`; the shape of `Models` lives in `packages/ai`, a different package and a different shard. I therefore describe the *use* of the provider API here, not its contract.
- **`contextRetentionMs` semantics.** `scheduler.ts` keeps a per-conversation context range in memory and drops it after the conversation has been idle for `settings.contextRetentionMs` (default 600 000 ms, `agent.ts:54`). The retention suite pins the eviction rules (`packages/durable/test/session-document-retention.test.ts`) but the interaction with a Durable Object's eviction (the comment at `scheduler.ts:738-742`) is a design claim I cannot verify from code alone.
- **The `pi-durable` conformance suites in `src/testing/` were not read** (`env-conformance.ts`, `storage-conformance.ts`, `storage-benchmark.ts` are in shard `durable#1`). Part A's notes describe the suites only through the *call sites* that register them.

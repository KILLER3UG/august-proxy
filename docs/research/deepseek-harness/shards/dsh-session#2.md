# deepseek-harness / dsh-session#2

## Shard shape

This shard holds the **session-retrieval family** (`packages/session-query/`: the unified `ctx.sessionQuery` service, its SQLite FTS5 backend, and the Web session-log ZIP export) and the **session-service family** (`packages/session/`: the log-backed title service and its two LLM title providers, the session-telemetry capture seam with its OpenTelemetry backend, the whole-log turn-outline projection, and the working-directory service plus its model tool). The three families interlock through one append-only event log: `dsh-session` owns the log, `session-projection` owns derived read models, and everything here is either (a) a *reader* of that log — query, telemetry, outline — or (b) a *writer* of a specific log-only event type — `session/title`, `working-directory/change`, `session/title-llm-request`. The recurring architectural move across all of them is that **derived state is a fold over the log, and every side effect is a log event plus a detached clone**: titles are `session/title` events folded by `foldSessionTitle`; the effective working directory is a `working-directory/change` event folded by a projection unit; telemetry records are one-per-event deep copies handed to a backend; the turn outline is a pure projection fold. A second recurring move is the **closed, machine-routable error taxonomy** (`SessionQueryErrorCode` has 17 members) and the **"exact reads concrete, search abstract"** split — the base service implements reads, filters and traces once, and only two full-text methods stay abstract for a backend to own.

## Per-file notes

### packages/session-query/README.md
- Purpose: package-group map for the session retrieval capability family, listing `session-query` (`ctx.sessionQuery`), `session-query-sqlite` (registers on the same key), and `session-log-export` (`ctx.sessionLogDownload`, browser side).
- Key abstractions: none — a navigation page.
- Data flow: none; links to `docs/subsystems/session-query.md` and two archived design notes.
- Non-obvious design decisions: states plainly that "Search results agree with the conversation history the model sees" — retrieval is a separate concern from compaction.
- Edge cases / failure handling: none.
- Surprising: the group README explicitly separates retrieval from compaction, so the query service never has to know about the compactor.

### packages/session-query/README.zh.md
- Chinese mirror of the group README; same three-package table and same "independent of compaction" framing, links to `.zh.md` variants of the subsystem reference.

### packages/session-query/README.i18n.yaml
- Per-heading en/zh content hashes for the group README, re-recorded by `pnpm run verify-translation-pairing --write`; each heading path carries one 16-hex hash per language.

### packages/session-query/session-query/README.md
- Purpose: package reference for the unified query service — the operation table (`listSessions`, `readSession`, `filterSessions`, `filterEvents`, `readTitleSnapshots`, `listEvents`, `readSurface`, `readEvent`, `traceSession`, `traceEvent`, `searchSessions`/`searchEvents`), the filter semantics (arrays ANDed, list values ORed, ranges inclusive), the three config knobs, and the failure codes.
- Key abstractions: "live-preferred logical corpus", "detached results", "exact reads concrete / search abstract", "one canonical surface fold".
- Data flow: a read resolves live `ctx.sessions` first, falls back to optional `ctx.sessionPersistence`, and returns clones from one consistent observation.
- Non-obvious design decisions: the `text` filter is deliberately a *literal whitespace-flexible scan*, not full-text — the README says to use the mounted backend's search methods when ranking is needed. It also states that body-free records expose only `isSeeded`, while body-bearing reads carry the exact `inheritedEventCount` so a caller can distinguish inherited from owned events without inferring a cut.
- Edge cases / failure handling: `SESSION_QUERY_SOURCE_CONFLICT` when live and persisted observations disagree on immutable headers; `SESSION_QUERY_CORRUPT_SESSION` when a durable record fails Session validation *or* a projection computation fails; "Reads targeting a known live session never consult persistence, so a failing backend cannot make current in-memory history unreadable."
- Surprising: the "Known Limitations" section admits exact reads replay whole logs, so very large histories pay full inspection per call.

### packages/session-query/session-query/README.zh.md
- Chinese mirror of the session-query README; preserves the four design commitments and the same failure list.

### packages/session-query/session-query/README.i18n.yaml
- Per-heading en/zh hash record for the session-query README (35 heading hashes).

### packages/session-query/session-query/src/index.ts
- Purpose: the abstract `SessionQueryEngine` Cordis service — the whole public contract for session reads, traces, filters and titles.
- Key abstractions: `SessionQueryEngine` (abstract; only `searchSessions`/`searchEvents` are abstract), the concrete `readSession`/`readSurface`/`readEvent`/`listEvents`/`filterSessions`/`filterEvents`/`readTitle*`/`traceSession`/`traceEvent` methods, and the `SessionObservation` lease returned by `observeSession`.
- Data flow: `readSession` → `corpus.load` → `Session.create(...)` (replay-validate) → cloned header + `snapshotSessionEvent` per event. `readSurface` → `tracing.currentSurfaceEvents` (one `foldSurface` pass). `readEvent` → `corpus.load` → a bounded slice of `loaded.events` with the target singled out as a snapshot.
- Non-obvious design decisions: `readSession` deliberately re-runs `Session.create` so resume's validation is reused rather than reimplemented (`src/index.ts:184`). `readTitleSnapshots` folds the title from *the same* event log observation as the header (`src/index.ts:251`), so header and title can never come from different sources.
- Edge cases / failure handling: config validated in the constructor — `readWindowMax` must be a non-negative integer, `persistedReadConcurrency`/`preparedSessionCacheSize` positive safe integers, else `SESSION_QUERY_INVALID_CONFIG`. `_readWindow` rejects a non-integer or out-of-range `before`/`after` with `SESSION_QUERY_INVALID_WINDOW`. A missing target event is `SESSION_QUERY_EVENT_NOT_FOUND`.
- Surprising: the read window is bounded by a *configurable* maximum (default 50) rather than being unbounded — a bounded read of a huge log is the API, not an accident.

### packages/session-query/session-query/src/corpus.ts
- Purpose: resolves the "logical corpus" — the union of live sessions and persisted sessions — and serves detached observations of it.
- Key abstractions: `SessionCorpus` (list/load/projectMany), `LogicalSession` (detached header + inherited count + cloned events), `LogicalSessionSource` (borrowed, valid only for the projection call), `LogicalProjectionResult<Value>` (fulfilled/rejected per id).
- Data flow: `listSessions` lists persistence, merges live over it, asserts header compatibility, sorts newest-first by `createdAt` then id. `load` snapshots a live session without touching persistence; otherwise it lists, reads the full log through a handle, then **re-checks for a live attachment** before cloning. `projectMany` runs one metadata listing plus a bounded-concurrency worker pool, isolating per-session failures.
- Non-obvious design decisions: "A known live target never consults persistence, so an optional backend's failure cannot make current in-memory history unreadable" (`src/corpus.ts:92-95`) — the read path for the current session is deliberately independent of an optional service. `projectMany` borrows the full log only for the synchronous projection call and never retains it (`src/corpus.ts:130-136`), so a batch of N sessions holds one log at a time.
- Edge cases / failure handling: `listPersisted` wraps any listing failure as `SESSION_QUERY_PERSISTENCE_FAILED`; `inspectPersisted` distinguishes `SessionPersistenceCorruptionError` → `SESSION_QUERY_CORRUPT_SESSION` from everything else. Cancellation is distinguished from failure everywhere (`if (signal?.aborted) signal.throwIfAborted()` before mapping to a taxonomy error) so an abort is never misreported as a persistence fault.
- Surprising: the optional persistence service is bound through a Cordis *fiber* (`ctx.inject(['sessionPersistence'], …)`) with a disposer that clears the reference only if it is still the current binding — a stale disposer cannot clear a replacement.

### packages/session-query/session-query/src/observation.ts
- Purpose: point observations of one session (`observeSession`), with a bounded cache of cold prepared sessions.
- Key abstractions: `SessionObservation` (a disposable lease with `source: 'live' | 'prepared'`, header, cursor, optional projections, and `retain()`), `SessionObservationOptions` (`signal`, `projectionMode: 'all' | 'none'`), `PreparedEntry` (persistence identity + revision + unpublished Session + frozen events + `refs`).
- Data flow: live → `this.live()` fixes the cut at the current log length and materialises `events` lazily on first read. Cold → `stat` the stored session, look up the cache by `(persistenceIdentity, revision)`, else `readColdSessionLog` + `ctx.sessions.prepare(...)` (an *unpublished* restored Session, never entered into the store), then hydrate projections via the registry or the projection cache.
- Non-obvious design decisions: the cache is keyed by *both* the persistence instance identity (a `symbol`) and the `stat` revision, so "revisions from different instances are incomparable, so the cached entry must not be reused" (`src/observation.ts:210`, pinned by `tests/observation.spec.ts:463`). Entries pinned by live leases are never evicted, and a lease's cut stays valid even after a newer revision lands (`src/observation.ts:74-77`). The live path defers `snapshotEvents` until `events` is actually read, so a header-only consumer never copies the log.
- Edge cases / failure handling: `ctx.sessions.prepare` rejecting because a live owner now holds the id → retry the live path rather than report corruption (`src/observation.ts:130-140`). A revision mismatch reloads; a replaced persistence instance discards the entry. All four abort points (pre, stat-time, post-stat, read-time, post-read) map to `SESSION_QUERY_ABORTED`.
- Surprising: the `retain()`/`dispose()` pair is a manual reference count over an immutable snapshot — `retain()` after disposal throws, and double-dispose is a no-op — so a caller can hand the same cut to two consumers safely.

### packages/session-query/session-query/src/cold-read.ts
- Purpose: one-shot cold read of a stored session log through the handle-based persistence seam.
- Key abstractions: `ColdSessionLog` (`eventState`, `header`, `inheritedEventCount`, `events`), `interruptedTurnClosers` from `dsh-session`.
- Data flow: `persistence.open(id, 'read')` → `handle.read(0, undefined)` → `handle.close()` → return `[...events, ...interruptedTurnClosers(events)]`.
- Non-obvious design decisions: a log whose writer crashed mid-turn is balanced **in memory only** — "persistence is never mutated by a read" (`src/cold-read.ts:22-25`). The synthetic closers are locally owned; the persisted events keep their own aliasing state.
- Edge cases / failure handling: if `read` throws, the handle is closed in a `catch` and the close failure is swallowed because "The read failure is the actionable cause" (`src/cold-read.ts:42-46`). Only `SessionPersistenceNotFoundError` maps to `undefined`; every other failure propagates unmapped so each caller owns its taxonomy.
- Surprising: the closers are *appended to the returned array* rather than mutating the stored events — the caller's copy is balanced, the store's copy is not.

### packages/session-query/session-query/src/sources.ts
- Purpose: the single compatibility check between two observations of one logical session.
- Key abstractions: `assertSessionHeadersCompatible(a, b)`.
- Data flow: compares `id`, `createdAt`, `cwd`, `parentSession`, `isSeeded`, `delegationDepth`.
- Non-obvious design decisions: conflicting immutable headers **fail** rather than merge — the code says "Reject incompatible observations of one logical session source" and raises `SESSION_QUERY_SOURCE_CONFLICT`. Silently preferring one side would let a stale durable copy masquerade as truth.
- Edge cases / failure handling: `delegationDepth` is compared with `?? 0` so an absent value and an explicit 0 agree.
- Surprising: this 25-line file is the entire consistency policy of the service; everything else trusts it.

### packages/session-query/session-query/src/config.ts
- Purpose: inherited config constants and the closed failure taxonomy.
- Key abstractions: `SESSION_QUERY_READ_WINDOW_MAX = 50`, `SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY = 4`, `SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5`, `SessionQueryErrorCode` (17 members), `SessionQueryError extends HarnessError`.
- Data flow: the constructor narrows `HarnessError`'s open string `code` to the closed union.
- Non-obvious design decisions: the taxonomy is a *closed* union — "Stable machine-routable failure taxonomy for session reads, traces, and search" — so a caller can switch on it exhaustively.
- Edge cases / failure handling: `SessionQueryError` keeps `cause` (the original error) so the actionable cause is never lost.
- Surprising: `HarnessError`'s base stores an open string code and the subclass only narrows the *type*; the comment says so explicitly.

### packages/session-query/session-query/src/types.ts
- Purpose: the public record/filter/request/page vocabulary.
- Key abstractions: `SessionRecord` (header + `live` + `persisted` + optional `formatStatus`), `SessionSurfaceSnapshot`, `SessionLogSnapshot`, `SessionEventRecord`, `SessionLineageTrace` (a discriminated union on `complete`), `SessionEventTrace`, `SessionEventWindow`, `SessionTitleObservation`, `SessionTitleObservationResult` (fulfilled/rejected), `SessionResultFilter`, `SessionEventResultFilter`.
- Data flow: pure types; the runtime values are produced by `index.ts`, `corpus.ts` and `tracing.ts`.
- Non-obvious design decisions: `SessionLineageTrace` is a *discriminated union* — `complete: true` carries `root`, `complete: false` carries `unresolvedParentId` — so "the parent chain leaves the visible corpus" is a type-level state, not a nullable field.
- Edge cases / failure handling: `formatStatus?: 'current' | 'migration-required'` is optional because the persistence backend may not report one.
- Surprising: `SessionEventSurface` is `'current' | 'shadowed' | 'log-only'` — the query service reasons about the *model surface*, so a search result can be labelled with exactly where the event sits in the model's context.

### packages/session-query/session-query/src/filters.ts
- Purpose: pure, provider-independent predicates for sessions and events, plus the literal text scan.
- Key abstractions: `materializeSessionResultFilters` / `materializeSessionEventResultFilters` (copy + validate a caller-owned filter array before an async boundary), `filterSessionResults`, `filterSessionEventDocuments`, `compileSessionTextFilter`.
- Data flow: filters → `materialize*` (deep copy, validate) → predicate closure per clause → `every(predicate)`.
- Non-obvious design decisions: the text filter is compiled into a **regex-escaped** Unicode pattern — each whitespace-delimited part has its metacharacters escaped and the parts joined by `\s+`, so user text can never be executable regex (`src/filters.ts:105-118`). It is case-insensitive and Unicode-aware.
- Edge cases / failure handling: unknown filter kinds, non-array values, non-string entries, out-of-range or inverted ranges, and unknown closed-union values all fail `SESSION_QUERY_INVALID_FILTER`. `unknownFilter(filter: never)` makes the compiler exhaustive.
- Surprising: `materialize*` copies the filter values, so mutating the caller's array after the call cannot change what is matched — pinned by `tests/session-query.spec.ts:960`.

### packages/session-query/session-query/src/extraction.ts
- Purpose: first-party semantic text extraction per session event, used for the literal scan and the FTS documents.
- Key abstractions: `extractSessionEventText(event)`, per-type switches for `user/message`, `assistant/message`, `tool/call`, `tool/result`, `todo/write`, `turn/end`.
- Data flow: event → per-type text → newline-joined, trimmed, non-empty parts.
- Non-obvious design decisions: **reasoning blocks contribute nothing** — `case 'reasoning': return []` (`src/extraction.ts:74-75`), so a model's private chain of thought is never indexed or searchable. Structural events (`turn/start`, `step/*`, `assistant/attempt`, `request/header`) and unknown merge-extensible events also contribute nothing: "Unknown events remain non-searchable until a concrete first-party consumer defines semantics."
- Edge cases / failure handling: `turn/end` extracts the error message for `error` reasons, the literal `aborted`/`max-tokens`/`interrupted`, and nothing for `completed` — a successful turn is not searchable text.
- Surprising: the `todo/write` event is searchable (`status` + `content`), so a session's own plan is recallable.

### packages/session-query/session-query/src/documents.ts
- Purpose: projects a raw log into surface-aware records and into searchable semantic documents.
- Key abstractions: `buildSessionEventRecords`, `buildSessionEventSearchDocuments`, `classifySurface` (one `foldSurface` pass → `current` / `shadowed` / `log-only`).
- Data flow: events → `foldSurface(events, currentSessionMessageProjections)` → surface map → per-event record or document.
- Non-obvious design decisions: the classification uses the **same** `foldSurface` the model-history derivation uses, so search and trace results cannot disagree with what the model sees. A document whose extracted text is empty is *omitted* entirely rather than indexed as an empty row.
- Edge cases / failure handling: a malformed surface (a replacement pointing at a non-existent seq) raises `SESSION_QUERY_INVALID_SURFACE` with the original error as `cause`.
- Surprising: `buildSessionEventRecords` and `buildSessionEventSearchDocuments` each call `classifySurface` independently — the fold is recomputed rather than shared, trading a little CPU for a much simpler contract.

### packages/session-query/session-query/src/tracing.ts
- Purpose: one-shot session-lineage and event-relationship tracing.
- Key abstractions: `eventRecords`, `currentSurfaceEvents`, `traceEvent`, `traceSession`, and the internal `analyzeEventLog` (one fold → `records`, `replacedBy`, `replacedEventSeqs`, `currentSeqs`).
- Data flow: `traceSession` reads the corpus once, walks parents upward (with a cycle guard), builds a `childrenByParent` index sorted by `(createdAt, id)`, then walks descendants with an explicit **stack**, not recursion.
- Non-obvious design decisions: descendants are built with an explicit stack so a 3000-deep lineage does not consume the JavaScript call stack (`src/tracing.ts:226-250`, pinned by `tests/tracing.spec.ts:288`). Cited-source links are kept **non-transitive**: `sourceEventSeqs` are the direct citations only. The replacement chain follows positional replacers to the final node.
- Edge cases / failure handling: a cycle in the ancestry raises `SESSION_QUERY_INVALID_LINEAGE`; a missing target raises `SESSION_QUERY_SESSION_NOT_FOUND`; an event whose seq is not present raises `SESSION_QUERY_EVENT_NOT_FOUND` *before* any surface analysis.
- Surprising: `traceEvent` checks target existence first, so a request for a non-existent seq reports "not found" rather than "invalid surface" — the cheap check precedes the expensive one.

### packages/session-query/session-query/src/cursor.ts
- Purpose: the branded opaque cursor type for search pagination.
- Key abstractions: `SessionSearchCursor = Branded<'SessionSearchCursor'>` and its branding function.
- Data flow: the backend encodes/decodes the opaque value; this package only owns the identity.
- Non-obvious design decisions: the cursor is explicitly *provider-owned* — the base service never interprets it, so a backend may change its encoding freely.
- Edge cases / failure handling: none here.
- Surprising: a 15-line file that exists purely so the base service can type a cursor it does not own.

### packages/session-query/session-query/package.json
- Manifest for `@deepseek-ai/dsh-session-query` 0.2.1-rc.2; peers on cordis/llm/session/session-title/tool-todo, *optional* peers on session-persistence and the two projection packages, and a single runtime dependency on `dsh-session-format-catalog`.

### packages/session-query/session-query/tsconfig.json
- Project config extending `tsconfig.base.json` with `rootDir: src`, `outDir: lib/types`, and project references to cosmokit, cordis, brand, llm, core/session, session-title, tool-todo, session-persistence, session-projection, session-projection-cache, and session-format-catalog.

### packages/session-query/session-query/tests/test-service.ts
- Test-only concrete `SessionQueryEngine` whose two search methods return empty pages; used by every other test in the package.

### packages/session-query/session-query/tests/search-helpers.spec.ts
- Unit tests for extraction (including that `plugin:text` and unknown content blocks stay opaque and that reasoning yields ''), surface classification, every session/event filter clause, the regex-escaped text scan (`CAFÉ` matches `café`), malformed ranges, and filter materialisation rejecting malformed runtime shapes.

### packages/session-query/session-query/tests/session-query.spec.ts
- The exact-read suite: a cancellation matrix over listing and exact reads (pre-abort reason preserved, in-flight abort waits for backend cleanup, abort ignored by the backend), live-vs-persisted precedence with a live owner attaching mid-inspection, batch title reads (one listing, bounded concurrency, per-session failure isolation, cancellation draining started inspections without starting queued ones), header-conflict detection, and detachment of returned headers.
- Notable: `tests/session-query.spec.ts:641` — "folds and discards each completed log before its worker dequeues another inspection" — a deterministic ordering guard proving the batch does not retain every full log (the comment says heap-retention assertions would depend on nondeterministic GC, so it asserts ordering instead).

### packages/session-query/session-query/tests/observation.spec.ts
- The observation reader suite: live leases and `retain()`-after-dispose, lazy materialisation of live events, a fixed cut when the log grows, the cold path balancing an interrupted turn in memory, revision-keyed cache hits and reloads, pinned entries surviving eviction, LRU eviction at capacity, discarding cached revisions from a replaced persistence instance, and the four abort points.

### packages/session-query/session-query/tests/tracing.spec.ts
- The tracing suite: complete/partial lineage, cycle rejection, one-corpus-observation reads, a 3000-deep descendant tree, replacement chains and cited-source ordering, fresh arrays per trace, live-over-persisted preference, and a table of nine invalid-surface logs (non-surface sources, invalid source arrays, empty/sparse/duplicate sources, a missing or future source, a replacement without sources, a replacement missing a shadowed source).

### packages/session-query/session-query-sqlite/README.md
- Purpose: package reference for the FTS5 backend — the config table (path, `openAt`, `journalMode`, `defaultLimit`, `maxLimit`, `snippetChars` + three inherited knobs), the search behaviour, ranking determinism, cursor staleness, and the failure codes.
- Key abstractions: the derived index (never the source store), live-preferred observation, generation-bound cursors, literal phrases as data.
- Data flow: one serialized observation per search — list persistence snapshots, compare per-session revisions with the indexed rows, read only new/changed logs through a handle, extract semantic documents, commit the reconciliation in one transaction, then run the query.
- Non-obvious design decisions: the `unicode61` tokenizer is chosen knowingly — "`AI` does not match the token `BRAID`" — and the README tells the reader to use `filterEvents()` for literal substring scans. The index refuses to open a database owned by another application or a canonical database, and only a *recognised* incompatible derived schema is reset in place.
- Edge cases / failure handling: `SESSION_QUERY_SEARCH_DISABLED` for `openAt: never`; `SESSION_QUERY_INDEX_FAILED` for open/reconcile failures; `SESSION_QUERY_STALE_CURSOR` when the corpus changed between pages; "Cancellation is honored between synchronous SQLite calls; a statement already executing on the JavaScript thread cannot be interrupted."
- Surprising: the "Known Limitations" list says the tokenizer choice trades substring recall for index size and two-character token support, and that "the trigram alternative was measured and rejected."

### packages/session-query/session-query-sqlite/README.zh.md
- Chinese mirror of the session-query-sqlite README; preserves the tokenizer caveat, the 14/13 predicate budget and the 32,766 binding limit.

### packages/session-query/session-query-sqlite/README.i18n.yaml
- Per-heading en/zh hash record for the session-query-sqlite README.

### packages/session-query/session-query-sqlite/src/index.ts
- Purpose: the concrete `ctx.sessionQuery` backend — reconciliation, FTS execution, and cursors.
- Key abstractions: `SqliteSessionQueryEngine`, `Config` (extends the base query `Config`), `OpenAt = 'startup' | 'first-search' | 'never'`, `CursorPayload` (version/instance/scope/fingerprint/generation/offset), the persistence `Binding` (identity + service), `ObservedSession` (header + documents + fingerprint).
- Data flow: `searchSessions`/`searchEvents` → `_assertSearchEnabled` → normalize → `_serialized` (a promise-tail gate serialising all work) → `_ensureReady` → `_reconcile` → decode cursor → `_querySessions`/`_queryEvents` → page + encode cursor.
- Non-obvious design decisions: (a) `_assertSearchEnabled` refuses **before any request normalisation**, so `openAt: 'never'` never imports `node:sqlite` or opens the index (`src/index.ts:333-344`). (b) The observation is *stabilised*: list persistence, load changed logs, list again, and retry once if the snapshot population changed (`_observeStable`, `src/index.ts:495`) — `STABLE_OBSERVATION_ATTEMPTS = 2`, and the comment says "One transient source change gets a retry; repeated churn fails rather than monopolizing the queue." (c) Live sessions live in **TEMP** tables that shadow the durable base and reveal it again when the live owner detaches. (d) Cursors carry the corpus *generation*; a generation change yields `SESSION_QUERY_STALE_CURSOR` rather than a shifted page (`src/index.ts:1003`).
- Edge cases / failure handling: the whole reconciliation runs inside `BEGIN IMMEDIATE`/`COMMIT` with a `ROLLBACK` fallback; a source or transaction failure commits nothing and the next search retries. A replaced persistence instance invalidates the epoch even when opaque revisions collide (pinned by `tests/sqlite.spec.ts:991`). `waitWithAbort` normalises a non-`Error` rejection into an `Error` with the original as `cause`.
- Surprising: the persisted index is a *derived* database with `application_id` ownership and its own schema version; the session-persistence store is never opened here, so a search can never corrupt the source of truth.

### packages/session-query/session-query-sqlite/src/query.ts
- Purpose: request normalisation, parameterised predicate compilation, snippet shaping, and the two resource budgets.
- Key abstractions: `normalizeSessionRequest`/`normalizeEventRequest`, `buildSessionWhere`/`buildEventWhere` (returning `{sql, params, predicateCount}`), `requestFingerprint` (the canonical request identity a cursor binds to), `makeSnippet`, `quoteFtsData`, `sanitizeFtsText`, `SQLITE_MAX_PAGE_LIMIT`, `SQLITE_PORTABLE_VARIABLE_LIMIT = 32_766`, `SQLITE_FTS5_OUTER_PREDICATE_LIMIT = 14`.
- Data flow: request → normalise (own copies of filter values, trimmed query, clamped limit) → fingerprint → SQL fragment + ordered bindings → statement.
- Non-obvious design decisions: (a) caller query text is quoted into **one FTS5 phrase** so `OR`, `NEAR`, `*` and quotes are data, never syntax (`quoteFtsData`, `src/query.ts:223`). (b) The reserved highlight markers (U+FDD0/U+FDD1) are stripped from document text before indexing so a document cannot forge a highlight span. (c) Two independent budgets are enforced *before statement preparation*: the portable 32,766-binding limit and the 14-predicate FTS5 outer-predicate budget. (d) The fingerprint canonicalises filter ordering and value ordering so two semantically identical requests produce the same cursor identity.
- Edge cases / failure handling: a NUL in the query is rejected (`SESSION_QUERY_INVALID_QUERY`); an empty/whitespace query is rejected; a `text` clause in a metadata filter list is rejected; an unknown filter discriminant is rejected.
- Surprising: `makeSnippet` positions the window on the *match*, not the start of the document, and bounds by Unicode code points rather than UTF-16 units.

### packages/session-query/session-query-sqlite/src/schema.ts
- Purpose: the derived-index database schema, ownership rules, and file creation.
- Key abstractions: `SESSION_QUERY_SQLITE_SCHEMA_VERSION = 8`, `SESSION_QUERY_SQLITE_APPLICATION_ID = 0x44534851` ("DSHQ"), `JournalMode`, `DERIVED_USER_TABLES` (the exact set of tables this package owns).
- Data flow: `openSearchDatabase(path, journalMode)` → create the file owner-only (`open(path, 'wx', 0o600)`) → open → read `application_id`/`user_version`/user tables → refuse foreign or canonical files → reset a recognised incompatible derived schema → apply journal mode → create the persistent and TEMP schemas.
- Non-obvious design decisions: (a) The mutating pragmas are applied **only after** refusing foreign files — the comment says so explicitly (`src/schema.ts:68-70`). (b) An empty file with `application_id = 0` is refused if it already has user tables, but a *wildcard* table named `sqliteX` counts as a user table, so it is refused too. (c) Only tables in `DERIVED_USER_TABLES` are considered owned; an unknown user table is refused rather than dropped, so a foreign database is never touched. (d) Missing directories are created `0o700` and the file `0o600` before the process umask.
- Edge cases / failure handling: an existing file keeps its mode; a filesystem error propagates (mapped to `SESSION_QUERY_INDEX_FAILED` by the caller).
- Surprising: the schema version is bumped to 8 and an incompatible version triggers an **in-place reset** — the derived index is disposable by design, so it is cheaper to rebuild than to migrate.

### packages/session-query/session-query-sqlite/package.json
- Manifest for `@deepseek-ai/dsh-session-query-sqlite`; depends on `schemastery`, peers on session/persistence/query, and dev-depends on the real JSONL persistence backend so the e2e can run against it.

### packages/session-query/session-query-sqlite/tsconfig.json
- Project config referencing cosmokit, cordis, schemastery, core/session, session-persistence, and session-query.

### packages/session-query/session-query-sqlite/locale/en.json
- Locale metadata stub with only `meta.title`.

### packages/session-query/session-query-sqlite/locale/zh.json
- Chinese locale metadata with a title and a one-line description.

### packages/session-query/session-query-sqlite/tests/query.spec.ts
- Unit tests for the normaliser (both scopes, default arrays/limits, cursor preservation, and rejection of non-text/blank/NUL queries and out-of-range limits), the SQL builders (every clause including empty and nullable lists, the predicate budget, unknown discriminants), the fingerprint's order-canonicalisation, and code-point-bounded snippet positioning.

### packages/session-query/session-query-sqlite/tests/load-path.e2e.ts
- Keyless real-Loader-path smoke: unwraps the module through `Loader.unwrapExports`, mounts it with the real JSONL persistence backend against a temp directory, writes a session, and asserts the search finds it as `persisted: true, live: false`.

### packages/session-query/session-query-sqlite/tests/sqlite.spec.ts
- The 1880-line wire suite: `openAt` policy (startup/first-search/never, including that `never` never touches the filesystem), shared readiness across concurrent first searches, two-character token search, reasoning excluded from the index, all three surfaces searchable by default, metadata applied before ranking, the 14/13 predicate boundary and its rejection, literal phrase semantics (`OR`, `*`, quotes are data), deterministic ranking and tie-breaks, cursor binding and staleness (within-session cursors survive unrelated session changes, cross-session cursors do not), the two resource budgets, the reconciliation state machine (retry on live-owner attach, replacement source with colliding revisions, continuous churn fails after one retry), persistence-topology changes invalidating cursors, generation preservation across a reopen, TEMP overlay drop on reopen, external-writer repair detection, recovery after a source failure and a SQLite transaction failure, POSIX file modes, the schema-ownership refusals (unknown table, foreign app id, canonical table, wildcard `sqliteX`), the no-unhandled-rejection check, the cancellation matrix, and the real-JSONL-backend integration.

### packages/session-query/session-log-export/README.md
- Purpose: package reference for the Web session-log ZIP export — the command contract (`/export` accepts no path), the archive layout, the three dialog phases, and the host/browser split.
- Key abstractions: the Host half (command + Fetch route) and the browser half (controller + UI), split by `src/index.ts` / `src/client/index.ts`.
- Data flow: `/export` → `command/executed` on the submitting browser → `HEAD api/session.export?sessionId=…&includeDescendants=true` → the browser download manager fetches the GET → the host streams a ZIP of canonical JSONL logs plus attachments.
- Non-obvious design decisions: the dialog reports only *pre-stream* failures — "a descendant or attachment failure after the browser accepts the GET is reported by the browser download manager, not by the dialog". The export *includes* the `command/run`/`command/done` pair, because the host flushes the live root before reading.
- Edge cases / failure handling: the host answers 500 without echoing the backend error (which may carry absolute host paths), 404 for an absent session, 400 for a missing/invalid query parameter.
- Surprising: "Generic-file bytes are read and compressed as bounded chunks, so exporting a large upload does not buffer it in full" — the export never materialises the archive.

### packages/session-query/session-log-export/README.zh.md
- Chinese mirror of the session-log-export README; same archive paths and the same preflight-only failure reporting.

### packages/session-query/session-log-export/locale/en.json
- Locale metadata stub with only `meta.title` for the session-log-export package.

### packages/session-query/session-log-export/locale/zh.json
- Chinese locale metadata with a title and a one-line description of the session log export command and download.

### packages/session-query/session-log-export/README.i18n.yaml
- Per-heading en/zh hash record for the session-log-export README.

### packages/session-query/session-log-export/src/archive.ts
- Purpose: builds the export ZIP as a streaming, pull-driven `ReadableStream`.
- Key abstractions: `SessionLogExportDeps` / `SessionLogExportReady`, `SessionLogZipEntry` (content / data / chunks), `serializeSessionLog`, `readSessionLogText`, `flushLiveSessionLog`, `sessionLogZipEntries` (async generator), `streamSessionLogZip`, `ResponseCapacityGate`.
- Data flow: the root log is read and serialised by the caller (so a missing root answers cleanly *before* streaming starts); the generator yields the root log, then each subagent descendant in lineage order (flushing live ones, reading through a handle right before yielding, dropping the log after), then the deduplicated images, then the streamed generic files; each entry is pushed into a `ZipDeflate` in bounded chunks.
- Non-obvious design decisions: (a) Every log is serialised as **canonical JSONL** — one header line then one line per event — so every backend exports identically (`serializeSessionLog`, `src/archive.ts:110`). (b) The push loop **never splits a surrogate pair**: it backs off one code unit when the boundary lands inside one, because a lone high surrogate re-encodes as U+FFFD and would silently corrupt the artifact (`src/archive.ts:504-528`). (c) Production **waits for consumer pull** whenever the response queue reaches its 64 KiB high-water mark, so a slow consumer bounds accumulation to the queue plus one synchronous fflate push (`ResponseCapacityGate`, `src/archive.ts:416`). (d) Attachment collection reads only *declared* first-party content fields and completed assistant blocks — unknown event payloads stay opaque and cause no reads (`src/archive.ts:224-281`).
- Edge cases / failure handling: a descendant with no stored log **errors the stream** (fail-loud, never a silent under-export). A read failure closes the handle and rethrows the actionable cause. The consumer's `cancel()` aborts the producer signal and terminates the zip. Path segments are sanitised: session ids become `[A-Za-z0-9_-]+`, and a file name that is `.`, `..` or empty becomes `file`.
- Surprising: the media path is content-addressed by attachment id, so one archive never duplicates a shared image — and a shared lineage node is exported once via a `seen` set.

### packages/session-query/session-log-export/src/index.ts
- Purpose: the Host plugin — registers the `/export` command and the authenticated `GET`/`HEAD /api/session.export` Fetch route.
- Key abstractions: `Config` (`compressionLevel`), `apply(ctx, config)`, `sessionLogExportResponse`.
- Data flow: the route validates the query, resolves the services, flushes and reads the root log, and only then constructs the streaming `Response`.
- Non-obvious design decisions: the root preparation happens **before** the `Response` is constructed so a missing session yields a clean 404 instead of an errored stream; the `HEAD` path cancels the body and returns the status and headers only (`src/index.ts:97-100`).
- Edge cases / failure handling: a missing service → 500 naming the missing service; a root read failure → 500 with the fixed body `'session log export failed to read the stored log'` and **no** echoed error, "which may carry absolute host paths into the browser error bar" (`src/index.ts:142-147`); cancellation is re-thrown rather than translated to a 500.
- Surprising: the `/export` command accepts **no path** — a path argument is an error, because the browser chooses the destination.

### packages/session-query/session-log-export/src/routes.ts
- The absolute registration path `/api/session.export` and its document-relative form `api/session.export` for the browser.

### packages/session-query/session-log-export/src/client/controller.ts
- Purpose: the browser-side download controller and the shared modal state.
- Key abstractions: `SessionLogDownloadController`, `SessionLogDownloadState` (`bySession`), `SessionLogDownloadEntry` (`open`/`status`/`error`), `downloadUrl`, `sessionLogZipFilename` (browser-side copy of the naming convention).
- Data flow: `download(sessionId)` → `HEAD` the relative route → on `ok`, `save(route, filename)` (an `<a download>` click) → publish `success`; on failure publish `error` with the status and body detail.
- Non-obvious design decisions: **one in-flight download per session** — a second gesture returns the *same* promise (`src/client/controller.ts:76-79`), so the modal shows one operation. The `HEAD` preflight reports pre-stream failures to the dialog while the browser handles post-accept failures. `dismiss()` closes the dialog without cancelling the download, and the settled state preserves a dismissed dialog (`open` is re-read from the store before publishing).
- Edge cases / failure handling: a non-`Error` rejection is stringified; a body that cannot be read yields `Export failed: HTTP 503` with no detail; `dispose()` aborts every active fetch and awaits quiescence, and later requests are ignored.
- Surprising: the download is handed to the browser by an anchor `click` on a **document-relative** URL, so the ZIP never passes through JavaScript.

### packages/session-query/session-log-export/src/client/index.ts
- Purpose: the browser plugin — provides the controller, registers the header slot, registers the locale dictionary, and wires `/export` to the download.
- Key abstractions: `ctx.sessionLogDownload`, the `conversation.session.header.utilities` slot contribution.
- Data flow: `ctx.on('command/executed', …)` starts a download **only** when the command name is `export` and the result was `success` — so a non-submitting browser never downloads.
- Non-obvious design decisions: the feedback row's availability is a separate injected snapshot so the menu updates live when the feedback plugin loads or unloads; `openFeedback` tolerates the feedback plugin unloading between render and click (`ctx.get('feedbackUi')?.openSession(sessionId)`).
- Edge cases / failure handling: the controller is disposed with the plugin fiber; the slot contribution is removed on disposal.
- Surprising: the plugin listens for `command/executed` instead of registering a client-side command, so the *host* owns the command contract and the browser only reacts.

### packages/session-query/session-log-export/src/client/HeaderAction.tsx
- Purpose: the Session Header "more actions" menu offering Download and (optionally) Feedback.
- Key abstractions: `SessionLogDownloadHeaderAction`, `SessionLogDownloadHeaderInjected`.
- Data flow: reads the controller snapshot and the feedback-availability snapshot via injected selector hooks.
- Non-obvious design decisions: the download row is disabled **and** the trigger carries `aria-busy` while a download is in flight, so the state is visible to both the pointer and assistive tech.
- Edge cases / failure handling: none beyond the disabled state.
- Surprising: the Feedback row appears and disappears as the optional feedback plugin loads/unloads, while Download stays available independently.

### packages/session-query/session-log-export/src/client/Dialog.tsx
- Purpose: the shared modal rendering the three download phases.
- Key abstractions: `SessionLogDownloadDialog`, `SessionLogDownloadDialogInjected`.
- Data flow: one selector read of `state.bySession[sessionId]` drives title, description and error text.
- Non-obvious design decisions: an error with no detail falls back to the generic `dialog.commandFailed` copy rather than rendering an empty body.
- Edge cases / failure handling: `entry` may be undefined (no state yet) — treated as closed.
- Surprising: the modal is shared by the header button and the `/export` command, so a session has exactly one dialog.

### packages/session-query/session-log-export/src/client/locales.ts
- The `session-log-download` locale namespace with the zh and en string tables and the `SessionLogDownloadKey` union.

### packages/session-query/session-log-export/src/client/HeaderAction.module.css
- The 28×28 square more-button style; a comment notes the shared compact Button owns radius, height and interaction fills.

### packages/session-query/session-log-export/src/css-modules.d.ts
- Ambient declarations for `*.module.css` and `*.css`.

### packages/session-query/session-log-export/package.json
- Manifest with dual host/client exports, `fflate` as the only runtime zip dependency, and a `dsh.client` block listing the browser injects and `platform: web`.

### packages/session-query/session-log-export/tsconfig.json
- Solution config referencing the host and client projects.

### packages/session-query/session-log-export/tsconfig.host.json
- Host project config listing `archive.ts`, `index.ts`, `routes.ts` and the host-side references.

### packages/session-query/session-log-export/tsconfig.client.json
- Client project config listing the six browser files and their references.

### packages/session-query/session-log-export/tsdown.config.ts
- Reuses the shared `clientBundle` helper with `{ hostPhase: true }`, producing both `lib/index.js` and `lib/client.js`.

### packages/session-query/session-log-export/tests/archive.host.spec.ts
- The host-tier suite: compression config, canonical JSONL serialisation (including the v2 lineage marker and the `delegationDepth` default), `readSessionLogText` mapping only not-found to `undefined`, the route's status matrix, HEAD preflight, descendants under `subagents/<id>/`, per-session flush before each read, dedup of a shared lineage node, private-error-safe 500s, request-signal forwarding, consumer-cancel aborting descendant and attachment reads, the surrogate-pair boundary case, the pull-capacity backpressure case (fake timers must not advance a full queue), media and file path layout, and the refusal to discover attachment lookalikes in unrelated fields.

### packages/session-query/session-log-export/tests/route.host.spec.ts
- Host route tests: one GET/HEAD registration removed with the fiber, query validation before service checks, and compression-level validation.

### packages/session-query/session-log-export/tests/command.host.spec.ts
- Asserts `/export` registers one pathless command, errors on a path argument, and unregisters with the plugin fiber.

### packages/session-query/session-log-export/tests/loader-composition.host.spec.ts
- Real Loader composition: a `cordis.yml` listing session + commands + session-log-export is loaded, the command appears in the registry, and executing `/export` records a `command/run` + `command/done` pair while `deriveMessages()` stays empty.

### packages/session-query/session-log-export/tests/client-apply.client.spec.tsx
- Browser plugin tests: feedback-availability tracking, controller provisioning and slot removal on disposal, download only for an `export` execution acknowledged by *this* browser, and re-registration after the header slot collapses and returns.

### packages/session-query/session-log-export/tests/controller.client.spec.ts
- jsdom tests for the controller: HEAD preflight then save, concurrent gestures collapsing to one operation, a dismissed dialog staying dismissed, HTTP and transport failures published without leaking rejections, disposal aborting active fetches, the document-relative default carrier, and the fallback when the state is cleared before settlement.

### packages/session-query/session-log-export/tests/dialog.client.spec.tsx
- jsdom tests for the modal's error, in-flight and success states and the generic-copy fallback.

### packages/session-query/session-log-export/tests/header-action.client.spec.tsx
- jsdom tests for the menu: feedback opens without downloading, export available without the feedback plugin, live menu updates as feedback loads/unloads, `aria-expanded` tracking, Escape closing without downloading, and the row disabled while either entry path downloads.

### packages/session/session-title/README.md
- Purpose: package reference for the log-backed title service — three sources (fallback, provider, user rename), the required config, provider registration, and the two projection units.
- Key abstractions: the `title` projection unit (a plain string for client list rows) and the host-only `titleInput` unit (first/last eligible message + count) that makes scheduling O(1).
- Data flow: an eligible human `user/message` schedules a fallback immediately and (after the route is logged) a provider revision; each accepted revision appends a `session/title` event; `foldSessionTitle` picks the latest.
- Non-obvious design decisions: a user rename **pins** the session — later user messages schedule no automatic revision, and an explicit `refresh()` is the deliberate unpin. The full eligible prefix for one provider generation is scanned from the log at execution time rather than retained by the O(1) projection, so the projection stays bounded at 5000+ messages.
- Edge cases / failure handling: automatic failures warn and keep the fallback; an explicit `refresh()` rejects on provider error or caller cancellation and does not roll back an already accepted fallback event.
- Surprising: the "Model Experience" section states plainly that `session/title` is log-only and never enters the session surface, `deriveMessages()`, the system prompt, tool schemas, or the request prefix — so titles cost zero tokens and invalidate no KV cache.

### packages/session/session-title/README.zh.md
- Chinese mirror of the session-title README; same three sources, same pin/unpin rule.

### packages/session/session-title/README.i18n.yaml
- Per-heading en/zh hash record for the session-title README (35 heading hashes).

### packages/session/session-title/src/index.ts
- Purpose: the `ctx.sessionTitle` service — durable titles, a deterministic fallback, and a one-provider registry.
- Key abstractions: `SessionTitleService` (a Cordis `Service`), `SessionTitleProvider` / `SessionTitleProviderRequest` / `SessionTitleProviderResult`, `SessionTitleProviderId`, `SessionTitleInvalidError`, `titleProjectionDefinition` and the `titleInput` projection, `foldSessionTitle`, `SessionTitleWorkState` (revision counter + in-flight fallback + pending/active work).
- Data flow: `session/event` for `user/message` → schedule a fallback (deferred) and possibly a provider revision; `request/header` or a marked `llm/stream` starts the pending revision once the route is known; the provider's result is validated and appended as a `session/title` event.
- Non-obvious design decisions: (a) `session/title` is declared **log-only** in the `SessionEventMap` (`src/index.ts:71-79`) so it can never enter the model surface. (b) The provider's result must name **unique, ordered seqs from the request** (`validateResult`, `src/index.ts:635-682`) — a provider cannot claim a message it was not given. (c) Supersession is revision-based: `supersede` aborts the active work and bumps a per-session revision (`src/index.ts:715`), and `assertCurrent` refuses to append when the provider, revision, session, or signal is stale (`src/index.ts:685`). (d) A provider starts only after the *exact* main-request route is logged, and `onMainRequest` additionally accepts a marked loop request whose route matches the logged header (`src/index.ts:546`).
- Edge cases / failure handling: `rename` rejects a title that normalises to empty with the dedicated `SessionTitleInvalidError` (the one failure that blames the input) and rejects a non-live session with a plain `Error`. A second provider registration throws until the first one's disposal starts, so a replacement can activate while the previous drains — and the closing provider's late results never commit.
- Surprising: `ensureFallback` is **synchronous in its critical section** — derivation and append happen with no `await` between them, so it needs neither in-flight dedup nor a liveness re-check, while `appendFallback` (the refresh-unpin path) is deliberately separate and overwrites a pinned user title on purpose.

### packages/session/session-title/src/normalize.ts
- Purpose: title cleaning, UTF-8-safe truncation, and the deterministic fallback derivation.
- Key abstractions: `cleanTitleText`, `truncateTitleUtf8`, `normalizeSessionTitle`, `fallbackSessionTitle`.
- Data flow: raw text → strip OSC/CSI/ESC sequences and C0/C1 control characters and directional/invisible controls → collapse whitespace → trim → truncate to a byte budget without splitting a code point.
- Non-obvious design decisions: the control-character set includes **directional and invisible controls** (U+200B, U+200E/200F, U+202A-202E, U+2060-2064, U+2066-206F, U+FEFF) because "Directional and invisible controls that can make a displayed title deceptive" (`src/normalize.ts:12`). The OSC pattern also matches an *unterminated* tail.
- Edge cases / failure handling: non-positive or fractional limits throw; a byte cap that cannot hold the first code point yields an empty title (and therefore no title event).
- Surprising: `truncateTitleUtf8` iterates by code point and accumulates UTF-8 byte lengths, so an emoji is never cut in half — the same class of bug the ZIP export guards against for surrogate pairs.

### packages/session/session-title/src/types.ts
- Purpose: the pure title-domain types and the one home of the projection-key declarations.
- Key abstractions: `SessionTitleSource` (fallback / provider / **user**), `SessionTitleEventData`, `SessionTitleSnapshot`, `SessionTitleUserMessage`, `TitleInputState`, and the `SessionProjectionStateMap` / `SessionProjectionMap` augmentations.
- Data flow: types only; the values come from the service.
- Non-obvious design decisions: the `user` source is documented inline as "Explicit user rename: pins the title — automatic generation stops scheduling" (`src/types.ts:36`) — the type carries the semantic, not just the shape.
- Edge cases / failure handling: none.
- Surprising: this file exists specifically so the host and the client can share one declaration of the projection keys with **zero content duplication** (the client gets `./client`, a pure re-export).

### packages/session/session-title/src/client.ts
- A ten-line pure re-export of `./types.ts` for the client namespace.

### packages/session/session-title/package.json
- Manifest with three export outlets (`.`, `./types`, `./client`), peers on cordis/agent/brand/llm/session/projection, and `zod` + `dsh-util-values` as runtime dependencies.

### packages/session/session-title/tsconfig.json
- Project config referencing cosmokit, cordis, schemastery, brand, llm, core/session, session-projection, and core/agent.

### packages/session/session-title/locale/en.json
- Locale metadata stub with only `meta.title`.

### packages/session/session-title/locale/zh.json
- Chinese locale metadata with a title and a one-line description.

### packages/session/session-title/tests/session-title.spec.ts
- Title normalisation and fallback tests (terminal-control stripping, word and byte caps, an emoji fitting in a 5-byte cap), the fallback-after-first-eligible-message flow, derivation from the direct prompt rather than injected context, waiting through synthetic/empty/non-text messages, and the pure `foldSessionTitle` behaviour on a replayed log.

### packages/session/session-title/tests/projection.spec.ts
- The `title` unit tests: null before the first title, last-wins with change-feed notification carrying the causing seq, the version-1 string checkpoint format, late mounting folding pre-existing titles, HMR key removal on unload, 5000 title inputs held as a bounded aggregate, and rejection of a checkpoint whose counters disagree.

### packages/session/session-title/tests/provider.spec.ts
- Provider lifecycle tests: title inheritance across a fork, `first-prompt` vs `all-prompts` cadences, the current-title snapshot captured immediately before the call, an underivable fallback omitting `currentTitle`, input order preserved across 70 prompts, the watermark cut at the scheduled seq, provider disposal draining stale work, replacement during drain, supersession of an older revision, an unchanged route starting work from the marked loop request, non-loop streams ignored, and automatic failure contained while explicit refresh rejects.

### packages/session/session-title/tests/rename.spec.ts
- Rename tests: normalisation and acceptance, rejection of an empty title and of a dead session, the pin (no automatic scheduling afterwards) with `refresh()` as the unpin, the fallback-only unpin, supersession of an in-flight generation by a rename, and the pinned title surviving a refresh when no fallback is derivable.

### packages/session/session-title/tests/service-contracts.spec.ts
- Service contract tests: required positive config with `fallbackMaxBytes ≤ maxTitleBytes`, empty input, detached and pre-aborted refreshes, caller cancellation and session disposal propagating to the provider signal, one shared fallback across concurrent refreshes, a title accepted before the queued fallback commits, the newest overlapping refresh winning, service unload cancelling queued work, a detached session preventing fallback publication (warn only), an underivable byte cap, provider-registration validation, queued work dropped when the provider is disposed, and a table of 19 malformed provider results each rejected without replacing the fallback.

### packages/session/session-title/tests/persistence.spec.ts
- Round-trip test: a fallback title written by one context is read back by a remounted context over the same JSONL root and folds to the same snapshot.

### packages/session/session-title-llm/README.md
- Purpose: package reference for the shared auxiliary-request executor.
- Key abstractions: `executeSessionTitleLlm(ctx, config, request, titleProvider, prepared)` and `SessionTitleLlmPreparedRequest` (`system`, `input`, `messageSeqs`, `selectReasoningEffort`).
- Data flow: provider prepares → executor validates the byte ceiling → resolves the route → `ctx.llm.prepareCall` under a deadline → records `session/title-llm-request` → streams and assembles → returns blocks + finish + model identity.
- Non-obvious design decisions: the provider owns the prompt, the framing, the reasoning selection and the output interpretation; the executor owns route, bounds, cancellation, logging and assembly — so operational behaviour cannot drift between providers.
- Edge cases / failure handling: "It measures the final prepared user input against `maxInputBytes` before logging or dispatch instead of truncating it" and "rechecks timeout and caller cancellation while consuming the stream and after it completes, so a late successful result cannot be accepted even if an interceptor or adapter ignores abort."
- Surprising: `provider`/`model` overrides are optional but must be supplied **together**; without them the executor uses the exact route captured from the session's logged `request/header`, so an explicit refresh before any route exists needs the overrides.

### packages/session/session-title-llm/README.zh.md
- Chinese mirror of the session-title-llm README; same route/failure contract.

### packages/session/session-title-llm/README.i18n.yaml
- Per-heading en/zh hash record for the session-title-llm README.

### packages/session/session-title-llm/src/index.ts
- Purpose: the shared executor for model-backed title requests.
- Key abstractions: `SessionTitleLlmConfig` (maxInputBytes, maxOutputTokens, timeoutMs, optional paired provider/model), `resolveSessionTitleLlmConfig`, `executeSessionTitleLlm`, `SessionTitleLlmPreparedRequest`, `SessionTitleLlmResponse`, `SessionTitleLlmFinish`, `SessionTitleLlmRequestEventData` (the log-only `session/title-llm-request` event).
- Data flow: `resolveRoute` (explicit pair, else the logged route) → `ctx.llm.prepareCall` under `deadline(request.signal, timeoutMs, …)` → the provider's effort selector runs inside `prepareCall`'s callback → the exact request is appended to the log → `BlockAssembler` consumes the stream → `terminalFinish` maps the finish reason.
- Non-obvious design decisions: (a) The **output cap is independent of the conversation's cap** — `const maxTokens = config.maxOutputTokens` (`src/index.ts:251`) — so a small conversation `maxTokens` cannot truncate a title. (b) The executor **never chooses a reasoning effort**; it applies whatever the provider's selector returns, and omits the field entirely when the selector returns `undefined`. (c) The deadline is re-checked *after* the stream completes (`src/index.ts:282`), so a late success cannot be accepted. (d) `resolveSessionTitleLlmConfig` rejects unknown config keys by name.
- Edge cases / failure handling: an absent route with no overrides throws "no logged request route is available"; an empty `messageSeqs` throws; a `max-tokens` finish is *returned* for the provider to interpret while `error`/`aborted` throws with the failure's message and code preserved.
- Surprising: the request is logged **before** dispatch, so even a failed generation leaves an exact record of what was asked — and the test asserts the record exists for a failed run.

### packages/session/session-title-llm/tests/llm.spec.ts
- Executor tests: dispatch with the provider's exact system and input, the request logged at dispatch time, effort forwarding (floor and ceiling selectors), the independent output cap, the multibyte byte ceiling enforced *before* logging or dispatch, an unregistered route rejected before the request is recorded, no effort when the selector leaves it unset, paired route overrides, the full config-validation table, absent route / empty attribution / pre-abort rejection, terminal-failure detail preservation, `max-tokens` and `tool-calls` returned to the provider, a cooperative stream aborted at the deadline, a *successful* stream that completes after the deadline still rejected, and caller cancellation propagated.

### packages/session/session-title-llm/package.json
- Manifest for `@deepseek-ai/dsh-session-title-llm`; peers on llm/session/session-title/timeout, dependency on `dsh-util-values` and `schemastery`.

### packages/session/session-title-llm/tsconfig.json
- Project config referencing cosmokit, cordis, schemastery, llm, util/timeout, and session-title.

### packages/session/session-title-first-prompt-llm/README.md
- Purpose: package reference for the first-message title provider.
- Key abstractions: `Config` (the shared execution controls plus `targetWords` and `targetCjkCharacters`), the provider registration with `automatic: 'first-prompt'`.
- Data flow: the service schedules a revision → the provider frames only `request.messages[0]` as JSON → the executor dispatches → the response is parsed into a title → the service validates and appends it.
- Non-obvious design decisions: the automatic cadence is limited to a **fresh session with no parent and no prior title**; forks keep their inherited title and never retitle automatically, "even when their seeded first message came from the parent."
- Edge cases / failure handling: a generation failure (missing route, oversized input, timeout, cancellation, invalid output) warns and keeps the current title; only an explicit `refresh()` retries.
- Surprising: the provider's "Model Experience" says it "never receives a `currentTitle`" — the first-prompt strategy deliberately ignores the previous title.

### packages/session/session-title-first-prompt-llm/README.zh.md
- Chinese mirror of the first-prompt provider README.

### packages/session/session-title-first-prompt-llm/README.i18n.yaml
- Per-heading en/zh hash record for the first-prompt provider README.

### packages/session/session-title-first-prompt-llm/src/index.ts
- Purpose: the first-prompt title provider plugin.
- Key abstractions: `Config`, `systemPrompt`, `frameMessages`, `titleFromOutput`, `titleFromResponse`, `selectReasoningEffort`.
- Data flow: `apply(ctx, config)` validates the config and registers a `first-prompt` provider whose `generate` takes `request.messages[0]`, frames it, executes, and interprets the response.
- Non-obvious design decisions: (a) The **reasoning effort is the route's least supported one** — `model.reasoning?.efforts[0]?.id` (`src/index.ts:75-76`) — a cheap call for a cheap task. (b) The messages are framed as a **JSON array**, "so user text cannot break structural delimiters" (`src/frameMessages`). (c) Output parsing unwraps asterisk emphasis **only when it wraps the whole line**: `EMPHASIS_WRAPPER` requires the inner text not to contain the marker, so `**a** and **b**` keeps its markers while `**Title**` loses them (`src/index.ts:97-113`). (d) The system prompt is language-aware and asks for a best-effort title ("such as Greeting") instead of an explanation.
- Edge cases / failure handling: a `tool-calls` finish or any tool-call block is rejected ("title output must contain text only"); a `max-tokens` finish is rejected; a reasoning-only response is rejected ("produced no text"); an empty provider request is rejected at the provider's own boundary.
- Surprising: the parser's stated limit — "A line that is entirely `*` emphasis loses the marker pair even when the model meant it literally" — is documented rather than fixed.

### packages/session/session-title-first-prompt-llm/tests/provider.spec.ts
- Provider tests: only the first message is ever used (including on refresh), the exact system prompt and JSON framing are pinned in the test, the least reasoning effort is selected, a table of seven output-parsing cases (`**Continuing Previous Session**`, `*Greeting*`, `**a** and **b**`, `Use **bold**`, `Fix *args*`, `*args`, `****`), rejection of tool-call and max-token finishes, rejection of a tool-call block and of a reasoning-only response, positive-integer target validation, and an impossible empty request rejected at the provider's boundary.

### packages/session/session-title-first-prompt-llm/tests/provider.e2e.ts
- Real-API e2e, skipped unless `DEEPSEEK_API_KEY` is set; asserts the model title replaces the fallback and fits the byte budget.

### packages/session/session-title-first-prompt-llm/tests/loader-composition.spec.ts
- Loader composition tests: the provider boots from the shipped YAML shape and titles a session; and a second case proves the title request *inherits the route but not its effort* on a pi-ai adaptive-thinking gateway — the output cap holds the visible title instead of max-effort thinking.

### packages/session/session-title-first-prompt-llm/package.json
- Manifest for the first-prompt provider; peers on llm/session/session-title/session-title-llm, dependency on `dsh-util-values` and `schemastery`.

### packages/session/session-title-first-prompt-llm/tsconfig.json
- Project config referencing cosmokit, cordis, schemastery, util/values, llm, session-title, and session-title-llm.

### packages/session/session-title-first-prompt-llm/locale/en.json
- Locale metadata stub with only `meta.title`.

### packages/session/session-title-first-prompt-llm/locale/zh.json
- Chinese locale metadata with a title and a one-line description.

### packages/session/session-telemetry/README.md
- Purpose: package reference for the capture seam — the three-member backend contract, the two capture modes, the sharing disclosure, and the redaction waterfall.
- Key abstractions: `SessionTelemetryBackend` (a Cordis `Service`) / `SessionTelemetrySink` (the minimum contract), `SessionTelemetryRecord` (sourceEvent + channel + time + severity + attributes + body), `SessionTelemetrySeverity` (`info | warn | error`).
- Data flow: the coordinator captures canonical events (live or on-demand), builds one record per event, runs it through the `session-telemetry/record` waterfall, and hands it to the backend's non-blocking `emit`.
- Non-obvious design decisions: (a) The package **ships no redaction rules** — "with no listener mounted records reach the backend as captured, so exported data is exactly as clean as the rules a deployment mounts" (`src/index.ts:28-33`). (b) The record's `sourceEvent.envelope` excludes `data`; `body` carries the only payload copy, so a backend can reconstruct the event without bypassing redaction. (c) `sharing` is a **deployment-selected mode, not a delivery receipt** — the README says so twice.
- Edge cases / failure handling: `emit` must be non-blocking because it runs on the session-event hot path; backend errors are contained and never reach the agent loop. A backend implementing `flush()` must order concurrent flushes with the final `shutdown()` drain.
- Surprising: the "Known Limitations" section is unusually candid — "No built-in redaction rules — with no `sessionTelemetry/record` listener mounted, records leave the process exactly as captured, including any credentials embedded in file contents or command output."

### packages/session/session-telemetry/README.zh.md
- Chinese mirror of the session-telemetry README; same waterfall contract and the same candid limitations.

### packages/session/session-telemetry/README.i18n.yaml
- Per-heading en/zh hash record for the session-telemetry README.

### packages/session/session-telemetry/src/index.ts
- Purpose: the seam's Service Definition — the backend contract, the record vocabulary, and the redaction waterfall declaration.
- Key abstractions: `SessionTelemetryBackend` (abstract `sharing`, `emit`, `shutdown`; optional `flush`), `SessionTelemetrySink`, `SessionTelemetryRecord`, `SessionTelemetrySeverity`, and the `session-telemetry/record` waterfall event.
- Data flow: declarations only; the coordinator drives them.
- Non-obvious design decisions: the waterfall is declared with `@mode waterfall` and a documented contract — listeners transform `next()`'s return value, and "returning without `next()` replaces everything beneath". Redaction applies to the **exported copy only**; the canonical session log is never rewritten.
- Edge cases / failure handling: a throwing listener withholds that one record (fail-closed) and never reaches the agent loop.
- Surprising: `ops` records deliberately omit `event.seq`-style identity "so they can never be mistaken for ledger rows".

### packages/session/session-telemetry/src/coordinator.ts
- Purpose: the capture coordinator — live and on-demand capture, redaction, the handoff cursor, and failure containment.
- Key abstractions: `SessionTelemetryCoordinator`, `SessionTelemetryCapture = 'live' | 'on-demand'`, `SessionTelemetryCaptureOptions` (`capture`, `includeHistory`), `handoffCursor` (a module-scope `WeakMap<Session, SessionSeqCursor>`).
- Data flow: live → `session/created` adopts (replaying after the cursor), `session/event` captures each event, `session/flush` forwards a flush hint, `session/disposed` emits the shutdown marker and retires the session, `agent/error` is relayed as an `agent-error` ops record. On-demand → `captureSession(session, throughSeq?)` reads the canonical log prefix.
- Non-obvious design decisions: (a) The handoff cursor is **module-scope ambient state**, explicitly "a narrow, documented exception to the registrations-are-effects discipline" — cordis has no HMR state-handover API, and keying by the `Session` object is the only lifetime that lets a re-adopting fiber *resume* instead of re-handing history (`src/coordinator.ts:47-58`). It marks **handed-off, not delivered**. (b) Containment is per event: one rejected record is withheld fail-closed while the rest of the replay proceeds. (c) `severityOf` pre-maps the outcome flag at capture so a receiver can alert with **zero configuration** (`src/coordinator.ts:270`). (d) `severityOf` uses a merge-extensible fall-through (no `assertNever`), so plugin-merged event types pass through as `info`.
- Edge cases / failure handling: `contain` wraps every synchronous step because cordis `emit` is stop-on-throw and a throwing listener would starve every subscriber registered after this plugin. A backend shutdown failure warns rather than failing application teardown.
- Surprising: the shutdown marker is emitted at the session's *own* disposal edge, not at coordinator dispose — "receivers classify a session with activity and no marker as crashed, so a normally closed session in a long-running host must not look like a crash".

### packages/session/session-telemetry/tests/redact.spec.ts
- The waterfall contract tests: pass-through with no listener, a mounted rule applied to ledger *and* ops records, the canonical log untouched by a rule, outermost-first stacking around `next()`, a listener that skips `next()` replacing everything beneath, and a throwing rule withholding the record fail-closed.

### packages/session/session-telemetry/tests/telemetry.spec.ts
- The 776-line coordinator suite: envelope identity and deep-copy isolation, header facts stamped on every record, severity mapping (including an unknown merged event type), complete assistant streams shipped in canonical order, on-demand prefix capture, `includeHistory` only when requested, the redaction policy applied at capture time, per-event failure containment, a pending prefix captured after a coordinator reload, no continuous listeners in on-demand mode, seeded-session restoration across all four capture/history combinations, the child-owned fork marker and closers, a new fork replaying from its constructor boundary, a restored post-migration session, `session.seed_length` stamped from the exact cut, single adoption across the enter/announce window, resuming from the handoff cursor on re-adoption, replaying past a record the backend rejects, disposal ordering, the shutdown marker at the session's own edge, and the `agent/error` relay for Error and non-Error values.

### packages/session/session-telemetry/package.json
- Manifest for `@deepseek-ai/dsh-session-telemetry`; peers on agent, session, and cordis only — the seam itself has no runtime dependency.

### packages/session/session-telemetry/tsconfig.json
- Project config referencing cosmokit, cordis, core/session, and core/agent.

### packages/session/session-telemetry-otel/README.md
- Purpose: package reference for the OTel backend — modes, config, what leaves the machine, and shutdown semantics.
- Key abstractions: `SessionTelemetryMode` (`FEEDBACK_ONLY | DISABLED`), `Config` (mode, exporter, processor, shutdownTimeoutMillis, maxRequestBytes), the `SessionLogReporter` from the shared `dsh-otel` package.
- Data flow: a canonical feedback event → the coordinator captures the unhanded prefix through that event's seq → the reporter serialises OTLP/HTTP JSON → the collector.
- Non-obvious design decisions: `FULL` is **rejected, not an alias** — "Programmatic TypeScript configuration uses the exported `SessionTelemetryMode` enum; raw string literals are not assignable." Direct `ctx.sessionTelemetry.emit()` calls are no-ops in every mode, so the feedback gate cannot be bypassed. Inherited parent feedback does not authorise a child export; the child needs feedback of its own.
- Edge cases / failure handling: invalid byte limits, non-positive queue/timer values, `maxExportBatchSize > maxQueueSize`, invalid endpoints, and invalid shutdown deadlines all fail **at load**. A single oversized event produces one rejection diagnostic **without truncation**. At the shutdown deadline the remaining queue is discarded and no further sends start, while an active request may still settle.
- Surprising: the README says "Withdrawal exports a deletion event, not remote erasure" — the privacy semantics of a delete are stated explicitly.

### packages/session/session-telemetry-otel/README.zh.md
- Chinese mirror of the session-telemetry-otel README; same mode table and the same wire description.

### packages/session/session-telemetry-otel/README.i18n.yaml
- Per-heading en/zh hash record for the session-telemetry-otel README.

### packages/session/session-telemetry-otel/src/index.ts
- Purpose: the OTel backend plugin — mode resolution, fail-closed config validation, feedback authorisation, coordinator wiring, and an outer shutdown deadline.
- Key abstractions: `OpenTelemetrySessionBackend extends SessionTelemetryBackend`, `SessionTelemetryMode`, `isFeedback(session, event)`, `resolveMode`, `sharingStatusFor`.
- Data flow: a `session/event` whose type is a feedback event and whose object is the canonical log entry → `coordinator.captureSession(session, event.seq)` → `reporter.reportSessionLog({ sessionId, event: {…envelope, data: body}, severityNumber, attributes })`. A `feedback/committed` snapshot is restored into a detached Session and captured through its last event.
- Non-obvious design decisions: (a) **Only this Session's own explicit feedback authorises replay; fork seeds do not** — `isFeedback` returns false for `event.seq < session.inheritedEventCount` (`src/index.ts:43-51`). (b) The backend checks that the event is the *canonical* appended event before capturing (`session.eventAt(event.seq) !== event` → warn "session telemetry ignored an event absent from the canonical session log", `src/index.ts:225-230`), so a synthetic event cannot authorise an export. (c) `DISABLED` constructs no SDK state and reads **no** transport config — the test uses throwing getters to prove it. (d) The outer shutdown deadline abandons the queue rather than hanging the disposer.
- Edge cases / failure handling: `exporter.url` is required and must parse as http(s); `maxExportBatchSize` must be a positive integer (rejected at load because "the SDK accepts a non-positive batch size but its shutdown drain then splices empty batches forever — dispose would hang"); `shutdownTimeoutMillis` must be positive, finite, and ≤ the Node timer limit; a redaction rule that removes `sourceEvent` withholds the record with a diagnostic.
- Surprising: the backend deliberately does **not** implement the optional `flush()` hint, because "the OTel backend leaves it unimplemented for exactly that hazard" (concurrent SDK flushes versus the shutdown drain).

### packages/session/session-telemetry-otel/tests/otel.spec.ts
- The 862-line wire suite against the SDK's real pipeline and a scripted `node:http` collector: only the submitted prefix ships, resource identity (`service.name`, `user.id`), severity numbers (INFO 9 / WARN 13 / ERROR 17), `attributes.content` carrying the complete event, direct emits being no-ops, draining records enqueued after a timer export began, the shutdown deadline stopping queued sends while observing the active transport, exporter options passed through verbatim (gzip), the `warn` severity mapped from a policy, each session suffix replayed only at the next feedback event, non-canonical feedback ignored, `DISABLED` constructing no transport, the sharing disclosure per mode, direct construction defaulting to feedback-only, live ratings/notes/withdrawal uploading, cold snapshots without a last own feedback event ignored, a cold fork restored with its exact inherited cut, cold put/edit/withdraw without opening a live Session, the fail-loud config table, direct-mode rejection before reading transport config, the real-Loader-path guard (`unwrapExports` keeps the Service class), oversized records reported without truncation, and a redaction policy that removes the envelope withholding the record.

### packages/session/session-telemetry-otel/tests/egress.spec.ts
- Egress test proving the export reaches the collector **directly**, ignoring the ambient HTTP proxy configuration, for every provider including `deepseek-official` — with a positive control showing a fetch-based exporter *would* have hit the proxy.

### packages/session/session-telemetry-otel/tests/loader-composition.e2e.ts
- Real-composition e2e through the shipped headless profile: the redacted feedback-authorised prefix leaves the machine while the canonical log keeps the secret; `FULL` is rejected; no feedback captures nothing; `DISABLED` keeps the feedback local and prints the stable warning.

### packages/session/session-telemetry-otel/tests/fixtures/driver.ts
- The e2e driver: starts a mock OTLP collector, boots the production profile with the patch overlay, runs two fixture turns with a credential in the first, records feedback, emits an agent error, and writes the captures to `otlp-captures.json`.

### packages/session/session-telemetry-otel/tests/fixtures/telemetry-redact-rule.ts
- A deployment-style scrub rule mounted on the `session-telemetry/record` waterfall, replacing a fake credential with `[E2E-REDACTED]` — the same shape a real deployment would mount.

### packages/session/session-telemetry-otel/tests/fixtures/telemetry.patch.yml
- The test-only YAML overlay enabling the telemetry plugin, disabling the headless runner, and injecting the fixture scrub rule.

### packages/session/session-telemetry-otel/package.json
- Manifest for the OTel backend; depends on `@opentelemetry/api-logs` 0.222.0 and `schemastery`, peers on the feedback packages, llm, session, the telemetry seam, anonymous-user-id, cordis, and `dsh-otel`.

### packages/session/session-telemetry-otel/tsconfig.json
- Project config referencing cordis, schemastery, core/session, both feedback packages, llm, the telemetry seam, anonymous-user-id, and the shared otel package.

### packages/session/session-telemetry-otel/locale/en.json
- Locale metadata stub with only `meta.title`.

### packages/session/session-telemetry-otel/locale/zh.json
- Chinese locale metadata with a title and a description of feedback-authorised OTel upload.

### packages/session/session-turn-outline/README.md
- Purpose: package reference for the whole-log turn outline — the entry fields, the preview budgets, the whole-value wire rule, and the fold rules.
- Key abstractions: `TurnOutlineEntry` (`turn`, `seq`, `prompt`, `response`), `TurnOutlineState` (`turns` + `draft`), the `turnOutline` projection unit.
- Data flow: `turn/start` appends an entry; the first human `user/message` fills `prompt`; each text-bearing `assistant/message` overwrites a draft; `turn/end` commits the draft into `response`.
- Non-obvious design decisions: (a) The entry is anchored on **`turn/start`, not the prompt** — "its seq is the load-through target for a jump: the loop logs `turn/start` before the turn's prompt and steps, so a window paged back through that seq contains the whole turn" (`src/projection.ts:6-11`). This is the context-window-management trick of the shard: the client can jump to any turn without holding the events. (b) The wire value is the **complete** entry array (whole-value rule) — consumers replace, never merge. (c) The response buffers as a draft and commits at `turn/end`, because `turn/end` carries no text.
- Edge cases / failure handling: the unit is inert without the projection registry (`inject` keeps the fiber pending); unloading removes the key because registrations are effects on the mounting fiber; a persisted checkpoint whose turns are not strictly increasing is discarded rather than seeding a broken fold.
- Surprising: the preview budgets (50 chars for a prompt, 120 for a response) are chosen to match the chat rail's loaded-turn previews, "so a turn shows the same words before and after its events load".

### packages/session/session-turn-outline/README.zh.md
- Chinese mirror of the session-turn-outline README; same anchor rationale and the same whole-value rule.

### packages/session/session-turn-outline/README.i18n.yaml
- Per-heading en/zh hash record for the session-turn-outline README.

### packages/session/session-turn-outline/src/projection.ts
- Purpose: the `turnOutline` projection fold.
- Key abstractions: `turnOutlineProjectionDefinition`, `PROMPT_PREVIEW_LIMIT = 50`, `RESPONSE_PREVIEW_LIMIT = 120`, `preview(content, limit)`, the zod state schema.
- Data flow: each committed event is folded into the state; `turn/start` appends, `user/message` fills the prompt (only while the newest entry is still empty), `assistant/message` overwrites the draft, `turn/end` commits it.
- Non-obvious design decisions: (a) **Uninteresting events return the same state reference** and draft-only changes keep the `turns` array's identity — the registry's two `Object.is` gates then hold the change feed to at most three pushes per turn (boundary, prompt, settled response) (`src/projection.ts:91-93`). (b) The preview reads a **bounded slice** of each text block (`limit * 2` code units) so a single multi-megabyte block is never concatenated and regex-normalised whole (`src/projection.ts:45-54`). (c) A `turn/start` that does not advance the turn number is skipped, so the outline stays sorted and a retried boundary's previews land on the standing entry.
- Edge cases / failure handling: a whitespace-only prompt normalises to nothing and leaves the entry unlabelled; a `turn/end` with no draft is a no-op; a draft with no entry to commit into clears itself.
- Surprising: the wire view projects `state.turns` while the *persisted* state schema wraps the wire schema with the `draft` field — the draft is host-only and never shipped.

### packages/session/session-turn-outline/src/index.ts
- A 29-line function plugin whose only job is to register the `turnOutline` projection unit on the mounting fiber.

### packages/session/session-turn-outline/src/types.ts
- The pure turn-outline types and the one home of the `turnOutline` projection-key declaration.

### packages/session/session-turn-outline/src/client.ts
- A ten-line pure re-export of `./types.ts` for the client namespace.

### packages/session/session-turn-outline/package.json
- Manifest with three export outlets, peers on cordis/llm/session/projection, and `zod` as the only runtime dependency.

### packages/session/session-turn-outline/tsconfig.json
- Project config referencing cosmokit, cordis, llm, core/session, and session-projection.

### packages/session/session-turn-outline/locale/en.json
- Locale metadata stub with only `meta.title`.

### packages/session/session-turn-outline/locale/zh.json
- Chinese locale metadata with a title and a description of the session turn outline.

### packages/session/session-turn-outline/tests/projection.spec.ts
- Projection tests: an empty outline before any turn, the folded entries with their boundary seq, the response staying empty while the turn is open, a bounded slice of a 500 KB block, whitespace collapsing and the card budgets, non-human message sources ignored, **at most three pushes per turn**, a draftless turn end staying quiet, fabricated-envelope narrow paths (skipping non-text blocks, the raw reading bound, an orphan draft clearing, an identical re-commit keeping identity), a regressive turn number skipped, late mounting folding pre-existing turns, HMR key removal, and a checkpoint whose turns are not strictly increasing being rejected.

### packages/session/session-turn-outline/tests/loader-composition.spec.ts
- Loader composition test: the shipped YAML shape boots and serves the outline; and it pins that the function plugin has **no default export**, because "A default export beside the named form makes the Loader discard the namespace (postmortem 0001)".

### packages/session/working-directory/README.md
- Purpose: package reference for the working-directory service — change one Session's directory, survive replay, appear in user context, and recover to the original project when the selected directory disappears.
- Key abstractions: `ctx.workingDirectory`, the `workingDirectory` projection unit, the `working-directory/change` event.
- Data flow: the effective directory lives in a projection (initialised from `header.cwd`); `set` validates through the filesystem provider and commits an event; `ensure` re-validates and recovers; prompt assembly injects the current value as a **required user context**.
- Non-obvious design decisions: the **session header keeps the original project** — the effective directory is a separate, mutable projection — so a resumed session knows both where it started and where it is now. The directory context is deliberately **outside the system prompt**: "Directory transitions append context without replacing the stable system-prompt prefix."
- Edge cases / failure handling: a missing current directory recovers to the original project (or the configured default) and injects a recovery notice; when both are unavailable, prompt assembly rejects every model turn — the service does not choose or recreate a repository.
- Surprising: if notice queuing fails after the commit, the operation still returns the committed directory and only warns — the durable state wins over the notification.

### packages/session/working-directory/README.zh.md
- Chinese mirror of the working-directory README.

### packages/session/working-directory/README.i18n.yaml
- Per-heading en/zh hash record for the working-directory README.

### packages/session/working-directory/src/index.ts
- Purpose: the working-directory service.
- Key abstractions: `WorkingDirectoryService`, `Config` (`defaultDirectory`), the `workingDirectory` projection unit, the `working-directory/change` event, the `working-directory` message source, the `working-directory:current` system-prompt context.
- Data flow: `get(session)` reads the projection; `ensure(agent)` resolves and stats the directory and recovers if it vanished; `set(agent, path)` resolves relative to the current directory, validates it is a directory, and commits. `system-prompt/assemble` (prepended) awaits `ensure` and then **re-asserts** the required context contribution, re-inserting it if a later transform removed it.
- Non-obvious design decisions: (a) The projection is initialised from `header.cwd` and the *header is never mutated* — the original project and the effective directory are separate facts. (b) Changes are **serialised per session** through a `pending` promise chain, so two relative `cd`s compose (`a` then `a/b`) rather than racing. (c) The required context is re-asserted **after** the assembly transform: the handler mutates `assembly.contexts` to put the fresh text back (`src/index.ts:97-110`) — a downstream transform cannot strip a required fact. (d) `interpolate: false` means a path containing `{{project}}` is rendered literally rather than substituted.
- Edge cases / failure handling: an empty path is rejected ("cd must not be empty"); a non-directory is rejected; a cancelled or disposed operation commits nothing; an Agent disposed during inspection is refused via `fiber.assertActive()`; service disposal aborts the lifecycle signal and drains pending operations.
- Surprising: `ensure` is called *during prompt assembly*, so the directory is validated at the moment the request is built rather than when it was last set.

### packages/session/working-directory/tests/admission.spec.ts
- The admission test: a directory change, a sandbox-mode change, and an approval-policy change made **after** assembly (at `agent/pre-step` or inside `prepareCall`) are what the *request* carries — the model sees the current directory and the current policies, not the ones captured when the prompt was assembled.

### packages/session/working-directory/tests/working-directory.spec.ts
- The 358-line suite: origin metadata preserved while the effective directory changes, sibling sessions unaffected, log-backed restore, the wire projection visible without an Agent, serialised concurrent relative changes, recovery to the original project, a missing original project reported, rejection of files/empty paths/cancellation without state change, unchanged reads producing no transition notice, the required context not appearing in the system prompt, the configured launch fallback, rejection of a relative deployment default, recovery for a session with no origin metadata, the required context surviving an assembly transform that removes or replaces it, a directory name containing `{{project}}` rendered literally, a cancelled filesystem lookup committing nothing while the next queued change proceeds, disposal aborting and draining pending operations, an Agent disposed mid-inspection refused, a notice-queue failure warning while the committed state stands, and the tool surface being unregistered on disposal.

### packages/session/working-directory/package.json
- Manifest for `@deepseek-ai/dsh-working-directory`; peers on agent/fs/llm/session/projection/system-prompt; dependencies on `schemastery` and `zod`.

### packages/session/working-directory/tsconfig.json
- Project config referencing cordis, core/agent, fs, llm, core/session, session-projection, core/system-prompt, and schemastery.

### packages/session/tool-working-directory/README.md
- Purpose: package reference for the `working_directory` tool — read the current directory or enter an existing one with the same call.
- Key abstractions: the tool's optional `cd` argument and its canonical `cwd` result.
- Data flow: the tool delegates entirely to `ctx.workingDirectory.ensure` / `.set`.
- Non-obvious design decisions: the tool owns no directory state at all — "The tool delegates validation, recovery, persistence, and context notices to the directory owner."
- Edge cases / failure handling: the tool requires an Agent (`exec.agent === undefined` → error); it changes neither existing processes nor write permissions.
- Surprising: the returned absolute path is meant to be passed straight to other tools — one tool call establishes the workspace for the next.

### packages/session/tool-working-directory/README.zh.md
- Chinese mirror of the tool-working-directory README.

### packages/session/tool-working-directory/README.i18n.yaml
- Per-heading en/zh hash record for the tool-working-directory README.

### packages/session/tool-working-directory/src/index.ts
- Purpose: registers the `working_directory` tool.
- Key abstractions: `defineTool({ name, description, parameters, output, execute })`.
- Data flow: `execute(args, exec)` → no `cd` → `ensure(exec.agent, exec.signal)`; with `cd` → `set(exec.agent, args.cd, exec.signal)` → returns `{ cwd }`.
- Non-obvious design decisions: the tool description tells the model explicitly that "Existing shells and running processes keep their own directories" — the tool's contract states its own limits.
- Edge cases / failure handling: a missing Agent throws; the result schema is `additionalProperties: false` with a required `cwd`.
- Surprising: the same tool both reads and writes, distinguished by the presence of the optional argument.

### packages/session/tool-working-directory/package.json
- Manifest for `@deepseek-ai/dsh-tool-working-directory`; peers on tools and working-directory, no runtime dependencies.

### packages/session/tool-working-directory/tsconfig.json
- Project config referencing cordis, core/tools, and working-directory.

## Ideas worth stealing

- **Live-first reads that never touch an optional backend** — `packages/session-query/session-query/src/corpus.ts:92` — a read of a *known live* session snapshots it without consulting persistence, so "a failing backend cannot make current in-memory history unreadable". August's session reads, history panels, and resume paths should have the same property: the optional/derived store must never be on the critical path of reading the thing the user is looking at right now.
- **A revision-keyed observation cache with lease pinning** — `packages/session-query/session-query/src/observation.ts:204` and `:233` — the cache key is `(persistence instance identity, durable revision)`, so a replaced backend's revisions are never confused with the old one's; entries pinned by an active lease are never evicted, and the lease's immutable cut stays valid even after a newer revision lands. Directly transferable to August's cold-session restore path.
- **Fail on conflicting immutable headers instead of merging** — `packages/session-query/session-query/src/sources.ts:11` — two observations of one session that disagree on `id`/`createdAt`/`cwd`/`parentSession`/`isSeeded`/`delegationDepth` raise `SESSION_QUERY_SOURCE_CONFLICT`. A merge would silently pick a winner and make the durable copy look authoritative when it is stale.
- **Repair a crashed writer's log in memory, never on disk** — `packages/session-query/session-query/src/cold-read.ts:55` — `[...events, ...interruptedTurnClosers(events)]` balances a log whose writer died mid-turn for the reader only. August's persistence read path should do the same rather than mutating the store during a read.
- **Cursors that carry a corpus generation and go stale loudly** — `packages/session-query/session-query-sqlite/src/index.ts:1003` — a cursor whose generation no longer matches raises `SESSION_QUERY_STALE_CURSOR` instead of returning a page shifted by an insertion. August's paginated history/search surfaces need the same: a stale cursor must be an error the UI can offer to restart from, not a silently wrong page.
- **Refuse to search before doing any work, so "disabled" costs nothing** — `packages/session-query/session-query-sqlite/src/index.ts:338` — with `openAt: 'never'` the search methods fail *before request normalisation*, so `node:sqlite` is never imported and no file is created. A feature flag that still pays the startup cost of the feature is not a flag.
- **Quote the user's query as data so query syntax stays inert** — `packages/session-query/session-query-sqlite/src/query.ts:223` — `quoteFtsData` wraps the whole query in one escaped FTS5 phrase, so `OR`, `NEAR`, `*` and quotes are data. August's own search/filter surfaces should treat model- and user-supplied query text the same way.
- **Two independent resource budgets, refused before statement preparation** — `packages/session-query/session-query-sqlite/src/query.ts:36` and `:49` — the portable 32,766-binding ceiling and a 14-predicate FTS5 outer-predicate budget are checked at *compile* time, not at execution, so an oversized filter fails with a typed error instead of an SQLite failure. Any August surface that compiles user filters into a query needs the same two-layer guard.
- **A derived index that refuses to touch a database it does not own** — `packages/session-query/session-query-sqlite/src/schema.ts:46` and `:87` — `application_id` + `user_version` + an explicit allow-list of owned tables; a foreign application id, a canonical table, or an unknown user table is refused, and only a *recognised* incompatible derived schema is reset in place. This is the pattern August needs for any SQLite sidecar (usage ledger, session stats) so a mis-pointed `path` can never corrupt the session store.
- **Never split a surrogate pair when chunking a stream** — `packages/session-query/session-log-export/src/archive.ts:521` — the push loop backs off one code unit when the boundary lands inside a surrogate pair, because a lone high surrogate re-encodes as U+FFFD and silently corrupts the output. The same bug class exists in any chunked text emitter (SSE frames, log shipping, tool output truncation) — and this repo also fixes it for UTF-8 *byte* truncation in `packages/session/session-title/src/normalize.ts:39`.
- **Backpressure driven by consumer pull, not by a timer** — `packages/session-query/session-log-export/src/archive.ts:416` — `ResponseCapacityGate` blocks the producer whenever the response queue hits its 64 KiB high-water mark and releases on the next `pull()`. The test proves that exhausting fake timers does **not** advance a full queue. August's streaming endpoints (SSE, export, log tailing) should use the same pull-driven gate instead of a sleep-and-hope loop.
- **Answer 500 without echoing the backend error** — `packages/session-query/session-log-export/src/index.ts:142` — the root read failure returns a fixed body because "the error … may carry absolute host paths into the browser error bar". A one-line rule worth adopting for every August error surface.
- **One in-flight operation per subject, with concurrent gestures collapsed** — `packages/session-query/session-log-export/src/client/controller.ts:76` — a second `download(sessionId)` returns the *same* promise; `dismiss()` closes the dialog without cancelling the download, and the settled state preserves a dismissed dialog. The same "collapse concurrent gestures into one operation" shape belongs on August's long-running UI actions (regenerate, compact, export).
- **A title that is durable log state and never enters the model** — `packages/session/session-title/src/index.ts:71` — `session/title` is declared log-only, so a title survives replay, resume and paging like any other event while costing zero tokens and invalidating no KV cache. August's per-chat naming should be a log event, not a UI-only field, for exactly that reason.
- **A deterministic offline fallback so the feature never depends on the model** — `packages/session/session-title/src/normalize.ts:70` and `packages/session/session-title/src/index.ts:809` — the fallback is derived from the first eligible human message's leading words within word and byte caps, and it is committed *before* the provider is called. The provider then only *upgrades* an already-present title, so a provider outage degrades quality rather than removing the feature.
- **A provider must name the exact seqs it used, and they must be from the request** — `packages/session/session-title/src/index.ts:635` — `validateResult` rejects a result whose `messageSeqs` are missing, duplicated, out of order, or not in the supplied message list. Any August mechanism that lets a model summarise a corpus should require the model to attribute its inputs, so an unverifiable summary is refused rather than stored.
- **Revision-based supersession for asynchronous side work** — `packages/session/session-title/src/index.ts:715` and `:685` — a newer revision aborts the older work, and a completion whose provider/revision/session/signal is stale cannot append. This is the pattern August needs for every async side-task (memory writes, summaries, background indexing) that runs concurrently with the next turn.
- **Split a model call into provider-owned and executor-owned halves** — `packages/session/session-title-llm/src/index.ts:230` — the provider owns the prompt, the framing, the reasoning selection and the output interpretation; the executor owns route resolution, the byte ceiling, the output-token cap, the deadline, cancellation, request logging and stream assembly. Two providers (first-prompt, all-prompts) then share all operational behaviour and differ only in strategy.
- **Reject an oversized prompt rather than truncate it** — `packages/session/session-title-llm/src/index.ts:241` — the final prepared input is measured against `maxInputBytes` *before* logging or dispatch, and the request is refused. Truncating a prompt silently changes the task; refusing it surfaces a budget problem.
- **An auxiliary call's output cap is independent of the conversation's** — `packages/session/session-title-llm/src/index.ts:251` — `maxTokens` comes from the title config, never from the session's logged request header, so a conversation configured for short answers cannot truncate a title.
- **Pick the cheapest reasoning effort the route supports** — `packages/session/session-title-first-prompt-llm/src/index.ts:75` — `model.reasoning?.efforts[0]?.id`. A model-specific adaptation for a cheap task, applied at call time rather than by configuration.
- **Re-check the deadline after the stream completes** — `packages/session/session-title-llm/src/index.ts:282` — a stream that finishes successfully *after* the deadline is still rejected, so a late success cannot be accepted even if the adapter ignored the abort. The same final check belongs on every August request that has a timeout.
- **Unwrap whole-line emphasis but keep inner markers** — `packages/session/session-title-first-prompt-llm/src/index.ts:97` — the regex requires the inner text not to contain the marker, so `**Title**` becomes `Title` while `**a** and **b**` and `Fix *args*` are left alone. Models wrap output in Markdown constantly; a targeted unwrap beats a strip-everything pass.
- **Redaction as an extension point that ships no rules** — `packages/session/session-telemetry/src/index.ts:44` — the `session-telemetry/record` waterfall is declared with a documented contract, ships no listeners of its own, and a throwing rule **withholds that record fail-closed** rather than letting it through. The canonical log is never rewritten; only the exported copy is redacted.
- **A module-scope cursor as a documented exception to the effects discipline** — `packages/session/session-telemetry/src/coordinator.ts:47` — the `WeakMap<Session, seq>` handoff cursor exists because cordis has no HMR state-handover API; keying by the `Session` object is the only lifetime that lets a re-adopting fiber *resume* instead of re-handing history, and the cursor marks **handed-off, not delivered**. The comment states the exception plainly instead of hiding it.
- **Pre-map severity at capture so a receiver needs zero configuration** — `packages/session/session-telemetry/src/coordinator.ts:270` — `tool/result.isError` and `turn/end` error reasons become `error` at the source, and merge-extensible unknown event types fall through as `info` without an `assertNever`. August's telemetry should decide alertability where the fact lives, not in the exporter.
- **Authorise an export with an explicit user action, not with the session's existence** — `packages/session/session-telemetry-otel/src/index.ts:43` and `:227` — only this session's *own* feedback event authorises capture (fork seeds do not), and the event must be the canonical appended entry (`session.eventAt(event.seq) !== event` → warn). A synthetic or inherited event must never be able to release a transcript.
- **A shutdown deadline that abandons the queue instead of hanging** — `packages/session/session-telemetry-otel/src/index.ts:259` — at the deadline the remaining queue is discarded, no further sends start, and an in-flight request may still settle. August's exporter must never be able to block the app's exit.
- **Anchor a navigation entry on the boundary event, not the payload** — `packages/session/session-turn-outline/src/projection.ts:7` — `turn/start` is the anchor because its seq is the load-through target: paging a window back through it contains the whole turn. This is the cheapest possible answer to "how does a client jump to a turn in a long session without holding the events?" — and the outline carries only bounded previews.
- **Bound the preview *read*, not just the preview length** — `packages/session/session-turn-outline/src/projection.ts:48` — each text block is sliced to `limit * 2` code units before being concatenated, so a 500 KB message is never normalised whole for a 50-character preview.
- **Use array identity to keep a change feed quiet** — `packages/session/session-turn-outline/src/projection.ts:91` — uninteresting events return the same state object and draft-only changes keep the `turns` array's identity, and the registry's two `Object.is` gates then hold the feed to three pushes per turn. Identity, not a version counter, is the cheapest change-suppression mechanism in a reactive read model.
- **Keep the original project and the effective directory as two separate facts** — `packages/session/working-directory/src/index.ts:33` and `:86` — the session header is immutable and keeps the original project; the effective directory lives in a mutable projection and a `working-directory/change` event. August's cwd handling should not rewrite the session's identity when the agent changes directory.
- **Put mutable runtime facts in user context, never in the system prompt** — `packages/session/working-directory/src/index.ts:97` — the directory is published as a *required user context* contribution with `interpolate: false`, and it is re-asserted after the assembly transform so a downstream transform cannot strip a required fact. This is how August can expose changing runtime state without invalidating the provider's cached prefix.
- **A committed change survives a failed notification** — `packages/session/working-directory/src/index.ts:186` — the directory change is committed to the log first; only then is the user-context notice queued, and a queue failure warns while the committed state stands. Durable state first, notification second.
- **Serialise per-session mutations instead of racing them** — `packages/session/working-directory/src/index.ts:208` — a `pending` promise chain per session makes two relative `cd`s compose (`a`, then `a/b`) instead of both resolving against the same base.
- **Reject unknown configuration keys by name** — `packages/session/session-title-llm/src/index.ts:123` — `resolveSessionTitleLlmConfig` walks `Object.keys(value)` against an explicit key set and throws `unknown config key "extra"`. A silently ignored typo in a config field is a bug that survives to production.
- **A mode enum that refuses to be a string literal, and refuses a wrong alias** — `packages/session/session-telemetry-otel/src/index.ts:31` and `:54` — `SessionTelemetryMode` is a TypeScript enum (raw strings are not assignable), `FULL` is rejected rather than treated as an alias, and `DISABLED` reads *no* transport config at all (proven with throwing getters in the test). A privacy mode must not be silently upgradable by a string.
- **Every package documents what the model sees, the token effect, and the KV-cache effect** — e.g. `packages/session/session-title/README.md:114` and `packages/session/working-directory/README.md:58` — each README has a "Model Experience" section with those three headings, and the answers are usually "nothing / zero / none" because the feature is log-only or user-context. August should adopt the same three-question template per feature; it is the cheapest way to keep prompt-prefix stability an explicit, reviewable claim.
- **Per-heading bilingual hash records** — `packages/session/session-title/README.i18n.yaml:1` — each heading section carries an en hash and a zh hash, re-recorded by `pnpm run verify-translation-pairing --write`. A translation cannot silently drift from its English source, and the gate is mechanical. Cheap to copy into August's docs.
- **Pin the absence of a default export on a function plugin** — `packages/session/session-turn-outline/tests/loader-composition.spec.ts:93` — "A default export beside the named form makes the Loader discard the namespace (postmortem 0001) — pin its absence." A one-line test that prevents a whole class of silent loader breakage.

## Files skipped (with reasons)

None. Every one of the 151 files in the shard was opened and read; there are no generated, vendored, binary or huge-data files in this shard (the largest file is `packages/session-query/session-query-sqlite/tests/sqlite.spec.ts` at 85 KB / 1880 lines, read in full). The `README.i18n.yaml` files and the `locale/*.json` files are small generated-ish metadata, but each was opened and its content described above.

## Uncertainties

- **`packages/session/session-title/src/index.ts` — the `onMainRequest` hook.** I read the code and the tests, but I could not establish *from this shard* what `markAgentLoopRequest` / `isAgentLoopRequest` do inside `@deepseek-ai/dsh-llm` (that package is outside this shard). I can state that the title service requires an *agent-loop-marked* request whose provider/model matches the session's logged `request/header` before it will start a pending automatic revision (`src/index.ts:546-558`), and that `tests/provider.spec.ts:506` shows an unmarked stream and a loop request for a different session are both ignored — but the exact marking mechanism lives in another package.
- **The `working-directory` service's relationship to `dsh-fs`.** `ctx.fs.resolve/stat/processPath` are used (`src/index.ts:137-183`) but `dsh-fs` is outside this shard; I could not check whether `processPath` canonicalises symlinks or only normalises the path, which would matter for the "session id may be any string" and path-traversal questions. The test suite does cover symlink-free absolute paths and `realpath`-ed temp roots only.
- **The compaction / context-window machinery itself is not in this shard.** The `turnOutline` package is a *navigation* read model over the whole log; the packages that actually drop or summarise events (`dsh-session-projection`, `dsh-llm` compaction) belong to other shards. I therefore describe the outline's contribution to context management, but I could not verify how it interacts with an actual compaction pass.
- **The `session-query` "exact reads replay whole logs" limitation.** The READMEs state it; I did not measure it, and I could not establish the typical session size in this repo that would make it matter.
- **Bilingual pairing coverage.** I read every `README.i18n.yaml` and every `README.zh.md` in the shard and confirmed they exist and correspond section-for-section, but I did not run the `verify-translation-pairing` gate (running anything from the clone is forbidden by the assignment), so I cannot confirm that the recorded hashes currently match the file contents.
- **`packages/session/session-telemetry-otel/tests/fixtures/driver.ts`** imports from `test-support/loader-smoke/tests/fixtures/production-profile.ts`, which is outside the shard; I read the driver and the patch file it uses, but the production profile itself was not part of this shard, so I can only state that the driver boots that profile with the fixture overlay.

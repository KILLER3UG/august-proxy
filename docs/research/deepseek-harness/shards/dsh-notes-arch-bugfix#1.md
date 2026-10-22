# deepseek-harness / dsh-notes-arch-bugfix#1

## Shard shape

This shard is the entire `.agents/notes/archived/bug-fix/` archive of the deepseek-harness repo as it existed on 2026-09-04: **260 files, 87 bug-fix notes, each shipped as a trilingual trio** — an English `.md` note, a Chinese `.zh.md` translation, and a `.i18n.yaml` "bilingual-pair consistency record" that pins the git blob hash of both sides. The notes are not source code; they are **decision records** — each has a `Status: implemented` / `Archived:` header and a fixed four-part shape (`## Problem` → `## Decision` → `## Alternatives considered` → `## Consequences`, plus `## Testing` / `## Deferred` where relevant), and each records *why a shipped fix has the shape it has*, usually with the rejected alternatives and their reasons. Substantively the shard is a post-mortem corpus for the harness's own agent loop, compaction, tool-execution, persistence and UI layers: the LLM adapters and retry policy, the compaction engine and its KV-cache interaction, the session/checkpoint/persistence seam, the Cordis plugin lifecycle and config hot-reload, the sandbox, the preset/subagent delegation machinery, and the TUI + Web client rendering. Nearly every note carries a **measured** number (6.5px of copy spill, 12.2 s → 7.2 s render, 32.0 MiB → 0.0 MiB fd-3 peak, 168 top-level entries, 419.6 ms → 1.94 ms), and the recurring lesson is that a *schema-level* or *presentation-level* guarantee is not an enforcement guarantee, and that a projection built on the wrong source (the model-visible surface instead of the append-only log) silently erases history. The shard's audience is a harness author: it is a catalogue of the specific failure modes that a Cordis-plugin, streaming, multi-provider agent runtime tends to hit, each paired with the mechanism chosen to fix it.

## Per-file notes

### .agents/notes/archived/bug-fix/2026-07-19-windows-atomic-write-dacl-preservation.i18n.yaml
- Purpose: bilingual-pair consistency record for the DACL-preservation note; stores the git blob hash of the English side (`d389f42d…`) and the Chinese side (`a0d5bf81…`) as of the last confirmed-consistent state, with a header comment naming the `pnpm run verify-translation-pairing --write <file>` command that re-records it.
- Read in full; the pairing record is boilerplate shared by all 87 notes in this format, differing only in the two hashes and the file name.

### .agents/notes/archived/bug-fix/2026-07-19-windows-atomic-write-dacl-preservation.md
- Purpose: why an atomic file replacement on Windows must preserve the target's DACL instead of inheriting the parent directory's.
- Key abstractions: `dsh-fs-local`'s Windows replacement path; `GetFileSecurityW` / `ReplaceFileW` via Koffi, loaded only on Windows replacement paths.
- Data flow: read the existing target's DACL → apply it to the empty temp file with inheritance *protected* → write content → publish the closed temp with `ReplaceFileW`.
- Non-obvious design decisions: staging under the target's parent and relying on inheritance is sufficient for a *new* file but not for replacing one whose explicit/protected DACL is narrower than its parent's (line 14); the ACL merge may reserialize auto-inheritance or duplicate equivalent ACEs, so self-relative descriptor buffers are deliberately *not* an equality contract.
- Edge cases / failure handling: replacing a Windows file now needs permission to read the target DACL and set the temp DACL, and failure is loud *before* content is written; a read-only Windows target still fails publication.
- Surprising: the shipped DACL tests compare the final replacement's *ordered, de-duplicated ACE policy* rather than asserting inherited account names with `Get-Acl`/`icacls` — the latter verifies machine policy, and localized well-known account names make the output unstable across hosts.

### .agents/notes/archived/bug-fix/2026-07-19-windows-atomic-write-dacl-preservation.zh.md
- Chinese twin of the English note: same Problem/Decision/Alternatives/Consequences structure with 问题/决策/备选方案/影响 headings, translating the `GetFileSecurityW` + `ReplaceFileW` decision, the four rejected alternatives, and the "failure is loud before content is written" consequence; all 8 backticked identifiers match the English side exactly.

### .agents/notes/archived/bug-fix/2026-07-20-code-mode-result-card-completeness.i18n.yaml
- Bilingual-pair record for the Code Mode result-card note (`aff755e4…` English / `275e870c…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-20-code-mode-result-card-completeness.md
- Purpose: why the Code Mode result card lost the program's return value once it also produced a log line.
- Key abstractions: the canonical tool registry pipeline; `run_code`'s output renderer; `presentResult`; `presentationMeta`; the host API proxy's `event.data.content` vs `view.view.content`.
- Data flow: the registry pipeline renders captured logs then the return value (or an explicit no-output marker) → a post-execute block may replace the result with error content → the durable `tool/result.content` is the card's only result-content source; the UI's generic result fallback renders it.
- Non-obvious design decisions: the outer `run_code` tool persisted complete rendered content but the *presenter* ignored it and rebuilt the body from a logs-only `presentationMeta` projection (line 10); `run_code` therefore omits `presentResult` entirely rather than adding a presenter (line 18).
- Edge cases / failure handling: runtime failures and pre-execution policy denials are normalized into error content by `ToolRegistry` *without* invoking the renderer; a spill policy's final head/tail preview was vulnerable to the same split ownership.
- Surprising: nested Code calls emit `tool/code-dispatch` events but no `tool/call`/`tool/result` cards, so one outer `run_code` invocation produces exactly one card — nested calls are execution-local and never model-facing, so multiple cards would expose an implementation trace.

### .agents/notes/archived/bug-fix/2026-07-20-code-mode-result-card-completeness.zh.md
- Chinese twin: translates the presenter-vs-pipeline split and the "omit `presentResult`, let the generic fallback render the durable content" decision, plus the four rejected alternatives; all 14 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-20-config-hot-reload-resilience.i18n.yaml
- Bilingual-pair record for the config hot-reload note (`0a60a7c2…` English / `6d534945…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-20-config-hot-reload-resilience.md
- Purpose: how a live `cordis.yml` edit can fail without killing or half-replacing a running agent.
- Key abstractions: the vendored Cordis lifecycle/Loader/Include/HMR plugins (logged as local modifications 6, 8, 9 in `vendor/README.md`); `Fiber.update()`'s `internal/update` waterfall; `EntryTree.await()`.
- Data flow: Loader imports the changed module name *before* disposing the active fiber → awaits candidate application → on failure disposes candidate effects and restores the prior plugin/config → group reconciliation concurrently starts candidates, awaits every outcome, and restores changed/added/removed/moved entries before rejecting; persistence happens only after successful programmatic mutation.
- Non-obvious design decisions: this is a *compensating* transaction — lifecycle effects may be briefly visible, and a failed rollback is reported as an `AggregateError` rather than misrepresented as a retained tree (line 18); a fiber waiting on an absent service stays a valid pending entry instead of making settlement hang.
- Edge cases / failure handling: `refresh()` rejects to its caller after a parse, validation, application or rollback failure; initial load stays fail-loud and only an absent file may use `initial`; HMR normalizes a failure to `Error`, logs it, broadcasts `hmr/config-update-failed(filename, error)`, and logs rejecting observers without stopping later refreshes.
- Surprising: HMR's `registerConfig(filename, refresh)` watches one exact path *from the nearest existing ancestor*, which is how a personal config file or parent directory created after startup is still observed.

### .agents/notes/archived/bug-fix/2026-07-20-config-hot-reload-resilience.zh.md
- Chinese twin: translates the compensating-transaction decision, the HMR exact-path watcher and failure broadcast, and the vendored-divergence consequence; all 15 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-20-error-cause-chain-diagnostics.i18n.yaml
- Bilingual-pair record for the error-cause-chain note (`bec8ba82…` English / `8fea93cc…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-20-error-cause-chain-diagnostics.md
- Purpose: why a TUI run against an unreachable DeepSeek endpoint printed only `fetch failed`.
- Key abstractions: `dsh-llm`'s `errorChain(value)` renderer; `HarnessError.code`; `LlmError('TRANSPORT')` / `LlmError('ABORTED')`; `SettleReason`.
- Data flow: undici wraps every transport failure in a bare `TypeError: fetch failed` and puts the actionable detail (`ECONNREFUSED`, `bad port`, the Happy Eyeballs `AggregateError`) on `error.cause`; the DeepSeek adapter wraps a pre-response rejection in `LlmError('TRANSPORT')` naming the configured `baseURL` and chaining the original as `cause`; every diagnostic boundary then renders through `errorChain` (line 19).
- Non-obvious design decisions: `errorChain` lives in `dsh-llm` beside `HarnessError` because that is the leaf package every consumer already imports, so sharing it costs no new dependency edge (line 22); routing still happens on `HarnessError.code`, so the renderer is diagnostic-output only.
- Edge cases / failure handling: circular causes and hostile `toString` coercion are contained; an aborted request becomes `LlmError('ABORTED')` and the loop still classifies the turn as cancellation rather than recovery.
- Surprising: `errorChain` renders `message` *without* the class name, so a bare `TypeError` in a log line loses its type label — the note argues the chain detail is worth more than the class name at these boundaries; and `dsh-stdio` previously rendered *no* failure reason at all, so the same failure in `demo:repl` was pure silence.

### .agents/notes/archived/bug-fix/2026-07-20-error-cause-chain-diagnostics.zh.md
- Chinese twin: translates the `errorChain` renderer, the DeepSeek adapter wrapping, the four diagnostic boundaries, and the "class name vs cause chain" trade-off; all 47 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-20-jsonl-storage-identity.i18n.yaml
- Bilingual-pair record for the JSONL storage-identity note (`b62ac9cc…` English / `82bffc96…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-20-jsonl-storage-identity.md
- Purpose: preventing a JSONL log selected for session A from declaring session B's id or cwd and redirecting a repair or later append to B's path.
- Key abstractions: `findLog(id)` (the provider's single physical resolver); the fused `loadCurrentStored(id)`; `PersistenceBackend<TornMarker>`; the persistence coordinator.
- Data flow: `findLog` scans every project directory and requires at most one matching encoded session directory with a transcript; the generation operation translates its header in memory, then validates `header.id === id` **and** that the selected path either equals `logPath(root, header.cwd, header.id)` or canonicalizes to the same transcript — before any write (line 14).
- Non-obvious design decisions: the coordinator keeps a detached copy of validated metadata and derives append/repair paths from *that* copy, so the generic `PersistenceBackend` interface needs neither a scope-specific live lookup nor a storage-locator type (line 16); an out-of-tree provider keeps its own medium-specific locator inside its own primitives.
- Edge cases / failure handling: mismatched, misplaced and duplicate JSONL logs fail before repair or coordinator state mutation; `list()` applies the same path validation and rejects duplicate ids across project directories; an existing configured JSONL root must be a readable directory at load, an absent root is created on first materialization.
- Surprising: the backend supports exactly one live writer per session — a second backend instance or process must not mutate that session until the owner finishes disposal — but no-overwrite hard-link publication still arbitrates an initial same-id creation race.

### .agents/notes/archived/bug-fix/2026-07-20-jsonl-storage-identity.zh.md
- Chinese twin: translates the identity-binding decision, the coordinator's detached metadata copy, and the one-live-writer limitation; all 8 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-21-compaction-summary-prefix-cache-reuse.i18n.yaml
- Bilingual-pair record for the compaction prefix-cache note (`7a433324…` English / `db5b2d05…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-21-compaction-summary-prefix-cache-reuse.md
- Purpose: why automatic compaction paid the full prompt-processing cost of the whole replayed history **twice**.
- Key abstractions: `SummarizationInput` (`{ system?, tools?, messages }`); `COMPACTION_INSTRUCTION`; `session.requestHeader()`; `session.deriveEventMessage`; `region.ts`'s `buildSummarizationInput`.
- Data flow: the summarization directive moves from the **front** of the request (a fresh `system` prompt) to the **end** of the conversation (a trailing `user` message), so the auxiliary call reproduces the last routed request's prefix verbatim and appends one instruction — a genuine prefix-extension of the warm request (line 14).
- Non-obvious design decisions: `tools` ride along even though the summarizer never calls one, because dropping them would shorten the token sequence and break alignment with the cached request (line 18); the old flattening path (`renderTranscript`/`renderContentBlocks`) had no remaining consumer and was deleted with its export.
- Edge cases / failure handling: cache reuse is best-effort — manual mid-range `compactRegion` still replays the true prefix and stays correct but forgoes reuse, and a `summarizationProvider`/`summarizationModel` differing from the conversation's route also forgoes reuse.
- Surprising: the shadowed region always ends on a tool-pairing-balanced boundary, so appending a `user` message after it is valid message ordering for both OpenAI-compatible and DeepSeek adapters; and a second note (`2026-07-31-english-compaction-checkpoints.md`) later required the checkpoint to be English *because* it becomes part of the next request's durable prefix.

### .agents/notes/archived/bug-fix/2026-07-21-compaction-summary-prefix-cache-reuse.zh.md
- Chinese twin: translates the front-to-back directive move, the `SummarizationInput` shape, the "tools ride along anyway" reasoning, and the best-effort reuse caveats; all 29 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-21-semantic-session-checkpoints.i18n.yaml
- Bilingual-pair record for the semantic-checkpoints note (`d4438b0d…` English / `6dd9755f…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-21-semantic-session-checkpoints.md
- Purpose: choosing crash-recovery boundaries finer than "one per turn" without putting `fsync` on the streaming hot path.
- Key abstractions: `dsh-session-checkpoint-policy` (a zero-config plugin beside a persistence backend); `agent/pre-step`; the lazily-wrapped `llm/stream`; `tools/execute`; the loop's final `turn/end` checkpoint.
- Data flow: at `agent/pre-step` it flushes pending prompt input or the preceding response/result batch before the next request is derived; it wraps `llm/stream` and flushes the live session after `request/header` is logged but *before* the adapter stream is constructed; it wraps top-level `tools/execute` after ordered pre-execute policy and flushes the recorded `tool/call` before the tool body (line 14).
- Non-obvious design decisions: persistence and checkpoint *scheduling* stay separate plugins — a backend makes requested `session/flush` boundaries durable but does not choose them, so loading a backend without the policy is valid and keeps the loop's coarser checkpoints (line 16).
- Edge cases / failure handling: checkpoint failure and cancellation are fail-closed at effect boundaries — a rejected request checkpoint prevents adapter dispatch, a rejected tool checkpoint becomes an error result without invoking the tool body, and cancellation landing while a tool checkpoint is pending yields the canonical `ABORTED_BEFORE_DISPATCH` result.
- Surprising: crash repair distinguishes durable evidence — an assistant tool request without a `tool/call` becomes `TOOL_NOT_STARTED` (retryable if still needed), while a durable `tool/call` without a result becomes `TOOL_OUTCOME_UNKNOWN`, whose model-visible result permits retry only for read-only or idempotent operations (line 22); the Harness explicitly does *not* claim generic exactly-once effects.

### .agents/notes/archived/bug-fix/2026-07-21-semantic-session-checkpoints.zh.md
- Chinese twin: translates the three flush boundaries, the fail-closed cancellation semantics, and the two crash-recovery classifications; all 17 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-22-collapsed-sidebar-control-rail.i18n.yaml
- Bilingual-pair record for the collapsed-sidebar note (`6b61f5c6…` English / `b487950f…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-22-collapsed-sidebar-control-rail.md
- Purpose: why closing the sidebar removed every visible way to reopen it.
- Key abstractions: `SIDEBAR_COLLAPSED` (56px); the layout solver's fixed-width sidebar track; `AppFrame`; `SidebarRoot`; the deepsuite sider curve (`--ds-ease-in-out`, `--ds-transition-duration-slow`).
- Data flow: the close action persisted width `0`, which the layout mapped to a *zero-width grid track* that clipped the only toggle and the settings entry; the fix maps a closed sidebar to the fixed 56px track (a 24px icon column between the sidebar's 16px horizontal paddings) and the rail keeps its right border (line 14).
- Non-obvious design decisions: the sidebar track is fixed-width in the solver — open or collapsed it never concedes to viewport pressure (only details shrinks, then auto-closes); the collapsed state is derived from the *persisted width preference*, not from the resolved track width.
- Edge cases / failure handling: at settle the wide-only content (brand, labels, input, session tree) unmounts, dropping the sessions subscription and leaving the rendered and accessibility trees; each rail control keeps its expanded counterpart's behaviour (the search icon expands the sidebar and focuses the search box after the slide) and carries a tooltip.
- Surprising: the search query lives with the root and survives the collapse round-trip; transitions pause during drags and under `prefers-reduced-motion`.

### .agents/notes/archived/bug-fix/2026-07-22-collapsed-sidebar-control-rail.zh.md
- Chinese twin: translates the 56px collapsed track decision, the animation tokens, the rail control inventory, and the three rejected alternatives; all 10 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-22-pi-ai-transport-truncation-classification.i18n.yaml
- Bilingual-pair record for the pi-ai truncation note (`09bbfe05…` English / `4183bc76…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-22-pi-ai-transport-truncation-classification.md
- Purpose: why a recoverable mid-stream connection drop was treated as a permanent failure and never retried.
- Key abstractions: `classifyPiAiError` in `dsh-llm-pi-ai`; `llm-retry`'s `DEFAULT_RETRYABLE_CODES` (`RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`); the catch-all `PI_AI_ERROR`.
- Data flow: pi-ai reduces a caught error to `error.message` before pushing the terminal `error` event, discarding the original `Error` and its `cause` chain; undici's actionable `SocketError` lives on `cause` but the fetch wrapper only hands pi-ai a bare `terminated` (line 12).
- Non-obvious design decisions: the classifier carries an `XXX(pi-ai upstream)` note naming the flattening site and stating the intended fix — classify on `code`/`cause` if pi-ai ever forwards the original `Error` — so the string matching is marked as a workaround, not the desired end state (line 19).
- Edge cases / failure handling: two wordings are now recognized and mapped to `TRANSPORT` — a bare `terminated` / `Premature close`, and any provider's "stream ended before/without …" truncation wording; classification stays provider-wording-dependent, so a future pi-ai rewording would silently fall back to `PI_AI_ERROR`.
- Surprising: widening `llm-retry`'s retryable set to include the catch-all was explicitly rejected — `PI_AI_ERROR` also covers genuinely non-retryable failures, and the fix is to classify the recoverable case rather than blur the bucket; pi-ai 0.81.1 exposes no fetch/dispatcher/client hook that could capture the `cause` before flattening.

### .agents/notes/archived/bug-fix/2026-07-22-pi-ai-transport-truncation-classification.zh.md
- Chinese twin: translates the cause-flattening diagnosis, the two recognized wordings, the `XXX(pi-ai upstream)` marker, and the "don't widen the catch-all" argument; all 35 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-23-demo-web-builds-client-bundles.i18n.yaml
- Bilingual-pair record for the demo-web build note (`abd031c4…` English / `70604b34…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-23-demo-web-builds-client-bundles.md
- Purpose: why `demo:web` showed "Failed to load plugins" on a clean checkout.
- Key abstractions: `dsh web`'s `GET /plugins/<id>/client.js`; each package's `exports["./client"]` → `lib/client.js`; the root `pnpm run build` (`tsc -b` + per-package `tsdown.client.ts`); the Vite `build:web` step.
- Data flow: the plugin bundles are produced only by the root build, but `demo:web` and the README ran only `build:web` — so every plugin bundle 404s, the client loader marks every plugin failed, and the boot screen shows "Failed to load plugins" (line 10).
- Non-obvious design decisions: `demo:web` now runs `npm run build` before `npm run build:web`; building the bundles inside `dsh web` at startup was rejected because the app runs from source via tsx and owns no build step, and folding an artifact build into server boot crosses the source/artifact separation.
- Edge cases / failure handling: a caller who already built can invoke `dsh web` directly; the README's Web UI section runs `pnpm run build && pnpm run build:web` for the installed `~/.dsh/source` checkout, which the installer never builds.
- Surprising: the frontend shell built fine, so the missing artifact was hidden behind a runtime browser failure rather than a build failure.

### .agents/notes/archived/bug-fix/2026-07-23-demo-web-builds-client-bundles.zh.md
- Chinese twin: translates the 404-diagnosis, the two-step build decision, and the "source/artifact separation" alternative; all 19 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-23-thinking-row-disclosure-target.i18n.yaml
- Bilingual-pair record for the thinking-row note (`9f748b6d…` English / `e33c951c…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-23-thinking-row-disclosure-target.md
- Purpose: making a collapsed reasoning entry's visible labels actually open it.
- Key abstractions: `ToolRow`'s opt-in `expandOnRowClick` policy; `ThinkRow`.
- Data flow: `ThinkRow` enables the policy so the title and reasoning summary form one accessible disclosure target; pointer clicks, Enter and Space toggle the same component-local expanded state (line 14).
- Non-obvious design decisions: the policy is *opt-in* rather than global — generic tool rows use row clicks for details selection, so sharing the behaviour would conflate two controls, and the leading control already owns argument expansion.
- Edge cases / failure handling: tool rows that do not opt in retain row-to-details selection and leading-control argument expansion.
- Surprising: the generic row component carries one optional policy precisely because disclosure ownership differs between reasoning and tool calls.

### .agents/notes/archived/bug-fix/2026-07-23-thinking-row-disclosure-target.zh.md
- Chinese twin: translates the `expandOnRowClick` opt-in and the three rejected alternatives; all 4 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-23-tui-generic-card-markdown.i18n.yaml
- Bilingual-pair record for the TUI generic-card Markdown note (`5c092c4d…` English / `93e6388c…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-23-tui-generic-card-markdown.md
- Purpose: why generic tool cards showed raw fence markers while assistant/user content in the same transcript was rendered.
- Key abstractions: the TUI's shared Markdown theme; the card's head-and-tail line limit; the `console` fence used by background-task acknowledgements.
- Data flow: generic-card *result* content is rendered with the shared Markdown theme and only then truncated by the card's head/tail line limit; terminal and diff cards keep their specialized plain-text renderers, and generic-card *raw input* stays literal because it represents tool arguments (line 14).
- Non-obvious design decisions: rendering precedes truncation so collapsed-card line counts and boundaries describe the visible terminal rows rather than Markdown source rows.
- Edge cases / failure handling: the shared theme hides fence syntax, retains the optional language label, and colours the fenced body as code.
- Surprising: stripping fences in the Bash presenter was rejected — it would fix one producer, leave every other tool's generic-card Markdown unrendered, and make the presenter depend on TUI behaviour.

### .agents/notes/archived/bug-fix/2026-07-23-tui-generic-card-markdown.zh.md
- Chinese twin: translates the render-before-truncate ordering and the three rejected alternatives; all 1 code identifier matches the English side.

### .agents/notes/archived/bug-fix/2026-07-24-empty-model-response-is-retryable.i18n.yaml
- Bilingual-pair record for the empty-response note (`e2dbb0c2…` English / `e67070ee…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-24-empty-model-response-is-retryable.md
- Purpose: why a provider returning a well-formed but content-free completion ended the turn as a silent success.
- Key abstractions: `EMPTY_RESPONSE_CODE` (`'EMPTY_RESPONSE'`) in `dsh-llm`, beside `CONTEXT_WINDOW_EXCEEDED_CODE`/`QUOTA_EXCEEDED_CODE`; `mapStopReason` in `dsh-llm-pi-ai`; `translate` in `dsh-llm-deepseek`; `finishError` → `agent/request-error` → `dsh-llm-retry`.
- Data flow: a terminal `stop` whose assistant message has no content blocks becomes a `finish {kind: 'error'}` carrying `EMPTY_RESPONSE`; the DeepSeek adapter does the same at `[DONE]` when a `stop` (or absent) finish has no opened blocks (line 18).
- Non-obvious design decisions: the classification lives in the *adapter*, not the loop or the `BlockAssembler` — the adapter is where wire facts become harness classification, with the overflow reclassification as exact precedent, and the loop stays provider-neutral (line 27).
- Edge cases / failure handling: detection is scoped to `stop` finishes only — `max-tokens` with empty content keeps its meaning, `tool-calls` cannot be block-empty, error/aborted finishes already fail; reasoning-only streams count as content and stay successful; whitespace-only responses are deliberately *not* empty, to avoid retry loops on models that intentionally stop after reasoning.
- Surprising: `EMPTY_RESPONSE` is in the provider-owned *normal* retry default because the attempt produced nothing durable, so repeating it is safe — and a model that genuinely intends to say nothing is retried and, if consistently empty, fails the turn.

### .agents/notes/archived/bug-fix/2026-07-24-empty-model-response-is-retryable.zh.md
- Chinese twin: translates the `EMPTY_RESPONSE` code, the two adapter mappings, the "stop finishes only" scoping, and the deliberate cost of retrying a genuinely silent model; all 27 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-24-recursive-python-sdk-session-notifications.i18n.yaml
- Bilingual-pair record for the Python SDK notification note (`a60e2ff5…` English / `81ffb4df…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-24-recursive-python-sdk-session-notifications.md
- Purpose: why grandchild lifecycle events and all descendant `session.event`s were dropped by the Python SDK.
- Key abstractions: `HarnessClient`'s child-to-parent edge map; `TurnResult.notifications` / `on_notification` / `TurnResult.events`; the `subagent.started` / `subagent.finished` notifications.
- Data flow: the SDK used to filter turn notifications by comparing each payload with the root session id, admitting only direct children; `HarnessClient` now records every valid `subagent.started` child-to-parent edge before dispatch, and other session notifications resolve their session id by walking that client-lifetime ancestry graph to the requested root (line 14).
- Non-obvious design decisions: a later `subagent.finished` routes by its *immutable* parent id but never rewrites current ancestry, so an older run that settles after its child id has been reused cannot displace the replacement session.
- Edge cases / failure handling: the graph survives successive subscriptions, so a descendant outliving one `Session.run()` is still attributable when it emits during a later turn; it resets when the client starts a new runtime process; ancestry lookup is cycle-safe.
- Surprising: only `session.event` notifications whose `sessionId` equals the requested root enter `TurnResult.events` or final-response reconstruction — descendants are observable, but a child response can never replace the root response.

### .agents/notes/archived/bug-fix/2026-07-24-recursive-python-sdk-session-notifications.zh.md
- Chinese twin: translates the ancestry-graph decision, the immutable-parent routing rule, and the "descendant events observable, root response protected" split; all 10 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-24-tui-turn-end-stop-reason-notices.i18n.yaml
- Bilingual-pair record for the turn-end stop-reason note (`62784ed7…` English / `162ba4ed…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-24-tui-turn-end-stop-reason-notices.md
- Purpose: why a `disposed` turn end and any plugin-added `TurnEndReasonMap` kind left the user with no visible reason.
- Key abstractions: the `turn/end` case in `packages/ui/tui/src/index.ts`; `TurnEndReasonMap`; the merge-extensible default branch.
- Data flow: the switch covers every kind — `completed` stays silent (the settled assistant message and its `Completed` timing header already present that outcome), `disposed` appends `Turn stopped: the agent was disposed.`, and the merge-extensible default appends `Turn ended: <kind>.` so an unknown plugin-added outcome still names why the agent stopped (line 14).
- Non-obvious design decisions: the turn-end notice is kept even though live disposal also appends `Agent "<id>" was disposed.`, because the two state different facts and only the turn-end notice survives replay of a persisted log.
- Edge cases / failure handling: live disposal during a running turn shows two notices; a replayed log shows the turn-end notice alone.
- Surprising: hiding the control entirely was rejected — an unknown merge-extensible kind is exactly the case where the user has no other way to learn why the agent stopped; and a notice for `completed` turns was rejected as noise.

### .agents/notes/archived/bug-fix/2026-07-24-tui-turn-end-stop-reason-notices.zh.md
- Chinese twin: translates the per-kind notice table, the "silent `completed`" reasoning, and the two rejected alternatives; all 15 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-26-intent-draft-same-tick-echo.i18n.yaml
- Bilingual-pair record for the intent-draft echo note (`3ef91b12…` English / `d890a68f…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-26-intent-draft-same-tick-echo.md
- Purpose: why typing in the hero composer jumped the caret and corrupted IME input.
- Key abstractions: `SessionManager.updateIntent`; `Session.updatePendingPrompt`; the Notifier's `notifyNow()` vs `markDirty()`; `EmptyState`'s binding to `intent.prompt` via `useSessions`.
- Data flow: typing flushed the *Session's own* notifier synchronously, but the composer renders from the sessions **list** snapshot, which only heard about the change through the intent watch subscription calling `markDirty()` — a microtask-deferred flush; React compares the DOM value against the still-stale snapshot in the same tick as `onChange` and rolls the textarea back (line 12).
- Non-obvious design decisions: the fix is channel-scoped, not global — `updateIntent` calls `this.notifier.notifyNow()` because a direct echo of a user gesture whose controlled input renders from this snapshot uses `notifyNow`, while the intent watch keeps `markDirty` for every other (async) intent transition (line 16).
- Edge cases / failure handling: with Pinyin "nihao" the committed fragments were "nnini hni hani hao你好"; the resident composer was unaffected because its draft lives in the chat store (sync flush) or comes from `updateSessionPrompt`, which reads the Session snapshot directly.
- Surprising: changing the intent watch callback to `notifyNow` was rejected as the *wrong channel* — the watch also fires on frame-driven Session changes, and the architecture note bans `notifyNow` for frame-driven sources because it collapses batching.

### .agents/notes/archived/bug-fix/2026-07-26-intent-draft-same-tick-echo.zh.md
- Chinese twin: translates the controlled-input rollback mechanism, the IME corruption symptom, the channel-scoped `notifyNow` fix, and the three rejected alternatives; all 16 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-27-glob-sampling.i18n.yaml
- Bilingual-pair record for the glob-sampling note (`99f2e1a2…` English / `83339a2b…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-27-glob-sampling.md
- Purpose: why an agent described one subfolder as if it were the whole project.
- Key abstractions: `globMaxResults`; the required `sampleOverCapGlobResults` config; the canonical output's `root` field; ripgrep's `--sort=modified`.
- Data flow: a pattern without `/` matches basenames at any depth, `--sort=modified` is *ascending* (so a restored archive sorts first), and the inline page took the head of that order without saying it was one concentrated slice — 100 inline paths all under one subtree out of 22 top-level entries and 11,485 files (line 12).
- Non-obvious design decisions: `sampleOverCapGlobResults` has **no fallback** — `false` keeps the modification-time head, `true` samples round-robin across the complete result's top-level entries, and misconfiguration fails at load rather than picking an implicit contract (line 16).
- Edge cases / failure handling: in sampling mode every entry gets one slot before any gets a second, exhausted groups drop out, relative order stays stable within each group, and grouping is relative to the actual search root including an explicit `path`; the footer states the page is a cross-entry sample and reports how many top-level entries it reaches, telling the model to narrow `path` when there are more entries than slots.
- Surprising: a model-facing `list` tool was rejected after implementation review — the default coding composition already exposes general bash, and a duplicate tool would add permanent schema/prompt tokens plus ordering, pagination, symlink, escaping, UI and snapshot contracts with no distinct security benefit; sampling balances only the *first* segment beneath the search root, so a deeper hot subtree can still dominate within one top-level entry.

### .agents/notes/archived/bug-fix/2026-07-27-glob-sampling.zh.md
- Chinese twin: translates the three composing behaviours, the no-fallback sampling config, the round-robin rules, and the "don't add a `list` tool" argument; all 16 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-27-question-composer-rows-do-not-shrink.i18n.yaml
- Bilingual-pair record for the question-composer layout note (`47e581a2…` English / `a1b72cab…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-27-question-composer-rows-do-not-shrink.md
- Purpose: why option rows in the question composer painted on top of each other and on top of the question title.
- Key abstractions: `.options` (`flex-direction: column`, `overflow-y: auto`, `min-height: 0`); `.option` / `.custom` / `.optionCopy`; the card's `max-height: min(60vh, 520px)`.
- Data flow: `.options`' children default to `flex-shrink: 1`, so under-allocation shrank the rows first instead of overflowing the scroll container; a row shrank to its `min-height: 42px` while `.optionCopy` kept the taller intrinsic height of its wrapped copy, and with `align-items: center` the copy painted outside the row's border box in both directions (line 12).
- Non-obvious design decisions: the fix is two declarations — `.option` and `.custom` declare `flex-shrink: 0` — because the rows are the scroll *content* of a capped card, and the card's overflow belongs to `.options` (line 18).
- Edge cases / failure handling: clipping or ellipsizing the copy was rejected as trading a visible defect for a silent one (the description is decision-relevant content); dropping `align-items: center` fixes nothing because a shrunk row still overflows onto the row below.
- Surprising: only rows whose copy wraps can reproduce the defect — a one-line row has slack between its content and the 42px minimum, which is why the pre-existing e2e fixture rendered correctly at every size; and reproducing the shortfall requires a short *viewport*, not a short container, because a single-axis scroller computes the other axis to `auto`.

### .agents/notes/archived/bug-fix/2026-07-27-question-composer-rows-do-not-shrink.zh.md
- Chinese twin: translates the flex-shrink diagnosis with its measured 6.5px/10px spill, the two-declaration fix, the four rejected alternatives, and the "stale `lib/`" testing caveat; all 30 code identifiers match the English side (the English side alone spells out the `scrollHeight === clientHeight` comparison).

### .agents/notes/archived/bug-fix/2026-07-27-stable-snapshot-refresh-volatiles.i18n.yaml
- Bilingual-pair record for the snapshot-volatiles note (`c408a383…` English / `bc309348…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-27-stable-snapshot-refresh-volatiles.md
- Purpose: why a behaviourally unchanged snapshot refresh rewrote fixtures with new UUIDs and host-specific paths.
- Key abstractions: the shared snapshot support's structural message-ID owner; `isAppendSurfaceEvent`/surface carriers; `agent/inbox/spliced`; `normalizeSessionLog`; `sessionProjectionCache.cachedSnapshot`.
- Data flow: the owner recognizes surface carriers through the session package's authoritative surface-type predicate, fingerprints every complete message with its top-level `id` removed, and records every ID-to-fingerprint edge across all parent/child logs; it reuses an existing UUID only when both its ID and fingerprint have *degree one* in the fresh and existing graphs, then rewrites only validated message `id` fields (line 16).
- Non-obvious design decisions: the write-back compares *normalized* leaves, so normalized-equivalent leaves retain the existing raw value while normalized-distinct leaves retain the fresh semantic value; normalized-equivalent changed strings must form a log-wide bijection (one fresh string ↔ exactly one existing string) or the log disables normalized string reuse.
- Edge cases / failure handling: an unexplained record mismatch, a conflicting mapping, a resized array, a string with both semantic and volatile changes, a malformed message, or any message graph with a non-unique ID or fingerprint all use fresh values rather than risk reusing misaligned data.
- Surprising: complete message IDs in surface or inbox carriers are *excluded* from the leaf path, so positional reuse and structural reuse cannot independently assign the same committed UUID; and the fresh and existing graphs both have to agree on degree one — a weaker "reuse if the ID looks unique" rule would re-associate a changed message with an unrelated one.

### .agents/notes/archived/bug-fix/2026-07-27-stable-snapshot-refresh-volatiles.zh.md
- Chinese twin: translates the degree-one fingerprint rule, the leaf-level normalized comparison, the bijection requirement, and the conservative fallback list; all 3 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-27-tool-card-single-row-fields-inline.i18n.yaml
- Bilingual-pair record for the tool-card inline-fields note (`23989e08…` English / `8358f7b8…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-27-tool-card-single-row-fields-inline.md
- Purpose: why a multi-line bash script title garbled the whole tool card.
- Key abstractions: `displayText` (preserves `\n` as structural layout) vs `displayInlineText` (escapes `\n` to the literal `\x0a`).
- Data flow: the bash tool sets the card title and description directly from the model's command and description, which for a multi-line script contain real newlines; escaped with `displayText` these broke onto extra terminal rows the card's line accounting did not reserve, so the title's later lines overwrote the description, the output, or the editor's steering hint (line 10).
- Non-obvious design decisions: single-row card fields — the title, the terminal card's `description` and `cwd` meta rows, and the pending `$ <command>` echo — use `displayInlineText`; genuinely multi-line fields (captured command output and the `contentText` result body) keep `displayText` plus `split('\n')` (line 14).
- Edge cases / failure handling: stripping newlines in the bash presenter was rejected because it hides the model's real command shape from every consumer of the view and pushes a UI concern into the tool.
- Surprising: removing the gutter bar is what made the collision *visible*, because those rows no longer sat behind a per-line prefix.

### .agents/notes/archived/bug-fix/2026-07-27-tool-card-single-row-fields-inline.zh.md
- Chinese twin: translates the `displayText`/`displayInlineText` split and the two rejected alternatives; all 14 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-27-tui-diff-card-redundant-path-header.i18n.yaml
- Bilingual-pair record for the diff-card path-header note (`608a1189…` English / `bf7f1c1e…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-27-tui-diff-card-redundant-path-header.md
- Purpose: why the `edit`/`write` cards printed the target path twice.
- Key abstractions: `diffLines`'s new `showPath` flag; `ToolCardComponent.renderBody`; `resultView?.title ?? callView.title`.
- Data flow: each tool's `presentCall`/`presentResult` returns a diff card whose title is `Edit <path>`/`Write <path>` and whose single `FileDiff` carries the same `path`; the TUI's `diffLines` unconditionally rendered `palette.bold(diff.path)` as a per-file header (line 10).
- Non-obvious design decisions: the suppression lives in the TUI renderer, not in each tool's presenter, because the redundancy is a presentation concern shared by every current and future single-file diff card; the tools keep emitting the path in both places so non-TUI consumers still get it (line 25).
- Edge cases / failure handling: multi-file diff cards keep every per-file header; an empty or blank diff path collapses under the same `String.includes` check, which is the intended noise removal.
- Surprising: the existing snapshot fixture had *hidden* the bug by titling the card `Edit renderer` (no path) and giving the result two diffs, so the title never matched a diff path; the fix also had to re-mirror the fixture to production shape.

### .agents/notes/archived/bug-fix/2026-07-27-tui-diff-card-redundant-path-header.zh.md
- Chinese twin: translates the `showPath` suppression rule, the "renderer not presenter" placement, and the two rejected alternatives; all 22 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-27-tui-step-timing-trails-tool-cards.i18n.yaml
- Bilingual-pair record for the step-timing note (`00256fc0…` English / `a566b521…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-27-tui-step-timing-trails-tool-cards.md
- Purpose: why the per-step timing summary sat above the tool cards it was supposed to close.
- Key abstractions: the standalone `StepTimingComponent`; `StreamingAssistantComponent.timing`; `trailStreamingTiming()`.
- Data flow: the timing summary was a child of the assistant message component, so it rendered directly under the assistant text; the fix makes it its own component, attached to the chat as a sibling following the assistant message, and `trailStreamingTiming()` moves the footer back to the tail of the chat whenever a `tool/call`/`tool/result` of the open step appends a card (line 14).
- Non-obvious design decisions: event ordering makes the exact behaviour fall out — within a step the loop appends `tool/call` and `tool/result` before `step/end`, so the footer is repositioned while `streaming` is still set, then frozen when the step ends.
- Edge cases / failure handling: `removeStreaming` and the reasoning-toggle rebuild detach and reattach the footer together with its streaming component; on `step/end` the footer is completed in place and stays pinned while the next step's output follows.
- Surprising: recomputing a single trailing footer for the whole turn was rejected, because a multi-step turn shows each step's own completed timing and collapsing them would drop the per-step buckets the existing timing tests pin.

### .agents/notes/archived/bug-fix/2026-07-27-tui-step-timing-trails-tool-cards.zh.md
- Chinese twin: translates the sibling-footer restructure, the `trailStreamingTiming()` repositioning, the event-ordering argument, and the three rejected alternatives; all 24 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.i18n.yaml
- Bilingual-pair record for the themed-scrollbar note (`6f01f605…` English / `5939507e…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.md
- Purpose: why the dark theme showed a light native scrollbar, and why the workspace list's timestamps sat under an overlay scrollbar.
- Key abstractions: the four `--dsw-alias-scrollbar-*` tokens (`bg-l1`, `bg-l2`, `hover-l1`, `hover-l2`); `packages/client/ui-theme/src/styles/scrollbar.css`; the `--dsh-scrollbar-thumb` / `--dsh-scrollbar-thumb-hover` indirection pair; `@supports not selector(::-webkit-scrollbar)`.
- Data flow: the token set was declared in `design-platform.css` with *no consumer anywhere in the client*, so every scrolling region rendered the user agent's own scrollbar; the new sheet is the sole consumer, sits on `body` (not `html`, where the alias tokens resolve to guaranteed-invalid and `scrollbar-color` computes to `auto`), and re-declares `scrollbar-width`/`scrollbar-color` on `body, body *` so each element substitutes the variable as it sees it (line 20).
- Non-obvious design decisions: the standard properties and the `::-webkit-scrollbar*` pseudo-elements are **mutually exclusive** — a non-`auto` `scrollbar-width`/`scrollbar-color` makes Chromium and Safari discard every `::-webkit-scrollbar*` rule including `:hover` — so the standard properties live inside `@supports not selector(::-webkit-scrollbar)`, which is true only where the pseudo-element is unimplemented (line 22).
- Edge cases / failure handling: the elevated-surface set is derived from the palette's own dark elevation ladder rather than from the sheets that already rebind, because a derived-from-rebind set can only confirm what someone already remembered — a surface nobody has rebound yet would define itself as unelevated (`--dsw-specific-tip` proved it); the check is per sheet, not per rule, and cannot detect a scrolling component embedded in another package's elevated card (`DirectoryBrowser` inside `Modal`).
- Surprising: `scrollbar-gutter: stable` on `.list` and the sheet's `::-webkit-scrollbar` width are *jointly* necessary against an overlay scrollbar — measured by deleting each from the live cascade with the other in force, either deletion alone takes the band from 8 to 0; and the WebKit rules are deliberately *not* gated, because unknown selectors are already dropped.

### .agents/notes/archived/bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.zh.md
- Chinese twin: translates the token/consumer inversion, the `body`-vs-`html` scoping, the mutual-exclusion `@supports` gate, the elevation-ladder derivation, and the joint-necessity measurement; all 81 code identifiers match the English side (the English side alone carries the literal `scrollbar-color: auto`).

### .agents/notes/archived/bug-fix/2026-07-28-web-agent-runtime-context.i18n.yaml
- Bilingual-pair record for the Web runtime-context note (`ccbb2882…` English / `b5f22469…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-28-web-agent-runtime-context.md
- Purpose: why a Web request like "change this page's theme" made the agent search the project for an unspecified page.
- Key abstractions: the `dsh-base` and `dsh-web-app` bundles; the `app:web-surface` prompt section; the `surfaceContext` composition setting; `harness:source`.
- Data flow: the shared CLI base configured an empty deployment persona, the Web overlay did not replace it, and the launcher added no source or interaction-surface section; the Web profile now composes `dsh-base` + `dsh-web-app`, the Web bundle supplies a concise coding-agent persona containing the resolved `{{model}}` and session `{{cwd}}`, and its `web-runtime` plugin adds the `app:web-surface` section when `surfaceContext` is true; the `dsh web` alias reads the same composed setting and installs `harness:source` only when the surface context is enabled (line 14).
- Non-obvious design decisions: the Web section treats unqualified "this page"/"this GUI"/"this app" as the DeepSeek Harness Web GUI *and* states that the browser provides no implicit DOM, route or screenshot context — so the model can identify the product without claiming visual state it did not receive.
- Edge cases / failure handling: the headless bundle and a profile that owns its complete prompt set `surfaceContext: false`, suppressing the Web prompt and managed shell facts; every mounted prompt contribution still activates before the agent loop can emit a request header, preserving the model-visible ⟺ logged invariant.
- Surprising: the source-checkout/workdir distinction is deliberately *not* a blanket statement that the checkout is never the working directory, because `dsh meta` intentionally makes them the same path.

### .agents/notes/archived/bug-fix/2026-07-28-web-agent-runtime-context.zh.md
- Chinese twin: translates the persona/section composition, the `surfaceContext` gating, the no-DOM/no-route/no-screenshot boundary, and the four rejected alternatives; all 12 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-28-web-conversation-polish-sweep.i18n.yaml
- Bilingual-pair record for the conversation polish note (`338b687c…` English / `16666207…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-28-web-conversation-polish-sweep.md
- Purpose: a batch of six web conversation presentation defects found in one design review.
- Key abstractions: the portal menu's hidden pre-render + `useLayoutEffect` measure; the chat flow derivation; `ToolRowOwnerProps.cwd`; `toolRowModel`; the ShimmerText glare-band pattern.
- Data flow: all six fixes are presentation-layer only and nothing enters the session log — portal menus mount with `visibility: hidden` at (0,0) and measure before paint; the chat flow drops a finalized assistant node whose blocks are only tool-call heads and blank text/reasoning (interrupted nodes always render, they carry the 已停止 marker); tool row summaries relativize workspace-rooted paths via `toolRowModel`; the running sweep becomes a fixed-width `::after` gradient band; the hero workspace chip becomes a selector with a "Choose workspace" placeholder; one 16px vertical rhythm replaces the 10px in-group gap plus negative cross-group margin (lines 16-22).
- Non-obvious design decisions: filtering empty assistant messages *host-side* was rejected because the node is real model output that Trajectory and replay must keep — only the chat presentation skips it, and the web layer is pure presentation by contract.
- Edge cases / failure handling: path relativization is a prefix check against the session cwd, so a workspace rename mid-session shows absolute paths until the summary re-derives — accepted as display-only staleness.
- Surprising: the mask-based running sweep was rejected because it dims the entire row content *including state dots*, and its exit transition fought the hover icon crossfade.

### .agents/notes/archived/bug-fix/2026-07-28-web-conversation-polish-sweep.zh.md
- Chinese twin: translates the six-bullet fix list, the "presentation only, nothing enters the session log" framing, and the five rejected alternatives; all 12 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-28-web-gui-feedback-loop.i18n.yaml
- Bilingual-pair record for the Web GUI feedback-loop note (`1410804b…` English / `60ab1d61…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-28-web-gui-feedback-loop.md
- Purpose: giving a GUI edit an executable acceptance target instead of an unrelated one.
- Key abstractions: the `web-runtime` plugin's canonical loopback URL; the `app:web-surface` prompt section; `DSH_WEB_URL` as a managed shell fact; `apps/web`'s Vite configuration; the always-mounted client-plugin HMR receiver.
- Data flow: the Web composition publishes one canonical loopback URL as both model-visible orientation and a managed shell fact; the prompt section says unqualified references identify this GUI and names the URL, and `DSH_WEB_URL` carries the same fact into every foreground or managed background bash call; the `apps/web` dev script and Vite config reject serve mode *before* opening a port, explaining that only `dsh web` injects `window.__DSH_BOOT__` (line 20).
- Non-obvious design decisions: the prompt makes the *agent*, not the user, own the hidden startup contract — automatic client-plugin reload additionally requires a same-checkout `pnpm run dev:web` watcher, which the agent verifies before promising no-refresh updates, and the agent does not launch a replacement GUI unless asked.
- Edge cases / failure handling: the host reads `index.html` and static assets on each request and serves client bundles with `no-cache`, so a refresh of the *existing* URL is the acceptance path after rebuilding the affected shell and plugin bundles; starting a separate server proves only that a separate server works.
- Surprising: `apps/web/package.json` exposed `vite` as its `dev` script and bare Vite returned HTTP 200 even though it could not inject `window.__DSH_BOOT__` — the repository affordance made the wrong substitute look valid; removing the dev script without guarding Vite was rejected because the incident command was `npx vite`, which bypasses package scripts.

### .agents/notes/archived/bug-fix/2026-07-28-web-gui-feedback-loop.zh.md
- Chinese twin: translates the loopback-URL contract, the serve-mode rejection, the "agent owns the startup contract" framing, and the four rejected alternatives; all 18 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-29-atomic-web-image-admission.i18n.yaml
- Bilingual-pair record for the image-admission note (`9e7372d3…` English / `193a4171…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-29-atomic-web-image-admission.md
- Purpose: preventing an image-bearing prompt and a concurrent `session.selectModel` from contradicting each other.
- Key abstractions: each live Web agent's private promise chain; the shared LLM runtime's projection of durable image blocks to text placeholders.
- Data flow: image prompt admission and `session.selectModel` each cross asynchronous model and attachment lookups; without one ordering point, an image prompt could validate an image-capable target while a concurrent selection installed a text-only target, and selection could change the route after admission had begun but before the durable message event was published; the shared promise chain gives the two operations a deterministic order (line 14).
- Non-obvious design decisions: text-only prompts *bypass* the chain, because they cannot create this ordering conflict — a broader lock would add latency and ownership without closing another modality race.
- Edge cases / failure handling: a failed operation settles its caller normally and leaves the chain usable; when selection runs first, later image admission observes the selected model and refuses an unsupported image *before* persistence; when admission runs first, attachment and event publication complete before selection changes the route.
- Surprising: provider adapters remain the final enforcement boundary — the host ordering only prevents its mutable route and pending image state from contradicting each other before request assembly; and text-only model selection remains available after images enter durable history, because request assembly projects those images to placeholders.

### .agents/notes/archived/bug-fix/2026-07-29-atomic-web-image-admission.zh.md
- Chinese twin: translates the promise-chain ordering decision, the text-only bypass, the three rejected alternatives, and the placeholder-projection consequence; all 1 code identifier matches the English side.

### .agents/notes/archived/bug-fix/2026-07-29-human-transcript-append-origin.i18n.yaml
- Bilingual-pair record for the human-transcript note (`c68865cd…` English / `8a927c48…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-29-human-transcript-append-origin.md
- Purpose: why a successful compaction made the terminal drop every message it shadowed.
- Key abstractions: `isAppendSurfaceEvent(event)` / `isReplacementSurfaceEvent(event)` (the marker split, over the two `SurfaceOp` variants, from the browser-safe `surface` module); `session.surface`; `transcriptToolCallIds`; `isCompactCheckpointSource`; `session.history`.
- Data flow: the terminal and the host history gateway both treated the *model-visible surface* as the human transcript, so a compaction's single replacement node erased the shadowed conversation; model and human projections are now separate and the event's own marker decides which one an event belongs to — append-origin events are the durable source for a transcript, replacement copies stay model-only (line 16).
- Non-obvious design decisions: everything that must send exactly what the model sees (`deriveMessages`, token accounting, the compaction backends, tool pairing, injected-context liveness, cross-session reference projection) keeps reading `session.surface` — the split is per *reader*, not a change to the surface itself.
- Edge cases / failure handling: a landed compaction contributes one dim `… earlier context was compacted …` row at its own log position rather than erasing it; only replay re-derives `tool/call` pairing, because a call event carries no marker of its own and inherits membership from the `assistant/message` that advertised it; `session.history` counts only append-origin messages toward `maxMessages`, so a page stays one contiguous raw event range and a compaction's `compaction/summary` event stays on the page of the replacement that cites it.
- Surprising: a checkpoint is recognized through the compaction seam's *declared* contract (`isCompactCheckpointSource`), not by shape — recognizing it as "a replacement `user/message`" reads a coincidence of the shipped producer set, and any future producer replacing a range with a user message would silently inherit the compaction marker; the cost of the fix is that `rebuildTranscript` now materializes a component per append-origin event in the whole log, so cost grows with session length instead of with the surface.

### .agents/notes/archived/bug-fix/2026-07-29-human-transcript-append-origin.zh.md
- Chinese twin: translates the marker split, the append-origin vs replacement-source distinction, the compaction marker row, the pagination quota change, and the five rejected alternatives; all 35 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-29-pnpm-setup-runner-isolation.i18n.yaml
- Bilingual-pair record for the pnpm runner-isolation note (`74e68ea1…` English / `b6c0ad80…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-29-pnpm-setup-runner-isolation.md
- Purpose: why three concurrent CI jobs failed in Node's `uv_cwd` initialization.
- Key abstractions: `pnpm/action-setup@v4`'s default `dest: ~/setup-pnpm`; the self-hosted six-runner failover; `PNPM_CONFIG_STORE_DIR`; `scripts/ci-workflow.spec.ts`.
- Data flow: the action replaces its install destination during setup, and the self-hosted failover runs six runner services under one VM user, so concurrent jobs shared that destination; in the reproducing run three jobs entered pnpm setup within 73 ms and one setup removed another process's cwd (line 10).
- Non-obvious design decisions: every non-Windows setup step now uses `dest: ${{ runner.temp }}/setup-pnpm-${{ github.run_id }}-${{ github.run_attempt }}` — the run/attempt suffix also protects sequential jobs on the same runner from a stale locked `pnpm.exe`; Windows jobs use a separate `setup-pnpm-js-${{ run_id }}-${{ run_attempt }}-${{ job }}` executable (not `standalone: true`, because the destination keeps that executable apart).
- Edge cases / failure handling: a retry on another runner passed, which made the failure timing-dependent rather than a repository-test regression; persistent store reuse remains separate through `PNPM_CONFIG_STORE_DIR`.
- Surprising: the workflow regression test *discovers* every `pnpm/action-setup` step in the three workflows and rejects one without the runner-private destination, so newly added jobs stay inside the isolation boundary; and assigning a separate Unix user per runner was rejected because it moves the invariant into external VM provisioning and complicates ownership of the deliberately shared persistent store.

### .agents/notes/archived/bug-fix/2026-07-29-pnpm-setup-runner-isolation.zh.md
- Chinese twin: translates the 73 ms collision timeline, the per-runner `dest` scheme, the Windows variant, and the three rejected alternatives; all 13 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-29-sticky-composer-conversation-scroll.i18n.yaml
- Bilingual-pair record for the sticky-composer note (`e861439d…` English / `3cc252d2…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-29-sticky-composer-conversation-scroll.md
- Purpose: why a wheel gesture over the stats line or the input did nothing.
- Key abstractions: `ConversationRoot`'s `data-conversation-scroll` body; the `data-composer-seat`; the strict `conversation.session` / `conversation.session.header` / `conversation.composer` outlets; `data-chat-anchor-key`; `closest('[data-conversation-scroll]')`.
- Data flow: the chat view owned `overflow-y: auto` while the composer sat as a sibling below that scrollport, so a wheel over the footer hit a non-scrolling region; the fix makes `ConversationRoot` always own one scroll body with the strict session view outlet *before* a composer seat around the whole `'conversation.composer'` chain output, and the header remains `flex: none` chrome above it (line 14).
- Non-obvious design decisions: the composer sticks *inside* the transcript scrollport (`position: sticky; bottom: 0`) rather than being a fixed sibling that forwards wheel deltas — the product requires the footer to be part of the scroll hit-testing surface; a portal into ChatView's scroller was rejected because the composer is shared across view tabs.
- Edge cases / failure handling: the InputBar textarea chains `wheel` with `{ passive: false }` — while the capped textarea can still scroll in that direction it keeps the native gesture, and only at its own edge does it `preventDefault` and apply `deltaY` to the host; history prepend follows reader intent through stable rendered node/call identities rather than whole-scrollport height deltas, and reaching the bottom or appending the reader's own message cancels the paging anchor.
- Surprising: the note explicitly *deferred* modelling every browser scroll input source, leaving pointer/touch, native-scrollbar dragging, keyboard scrolling, focus navigation and nested overflow ownership outside the model — a deferral later closed by `2026-08-06-reader-scroll-attribution-observed-top-ledger.md`.

### .agents/notes/archived/bug-fix/2026-07-29-sticky-composer-conversation-scroll.zh.md
- Chinese twin: translates the single-scrollport tree, the wheel-chaining rule, the anchor-based prepend following, the five rejected alternatives, and the explicit input-source deferral; all 23 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-29-web-details-session-lifecycle.i18n.yaml
- Bilingual-pair record for the details-lifecycle note (`b749a7e2…` English / `a7b9c7cf…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-29-web-details-session-lifecycle.md
- Purpose: why selecting a different Session inherited stale details-panel geometry.
- Key abstractions: `AppFrame`'s Session id and `blank` summary flag; the transient layout store; the session-scoped store from the slot-type-chain standard.
- Data flow: the details entry is Session-scoped but its preferred grid width is root-scoped; `AppFrame` now reads the current Session id and its `blank` flag from the authoritative Session projection and records the last non-blank selected id only when that Session can own details, so hero and other unselected states neither trigger closure nor replace the last owner — their rendered track derives as zero without changing the stored preference (line 14).
- Non-obvious design decisions: the layout store is transient and starts details closed — it neither reads nor writes `localStorage`, so reload restores the sidebar default and details closed and needs no Session-baseline exception; per-Session geometry was rejected because the product contract needs stale context *removed*, not a new map of remembered widths.
- Edge cases / failure handling: returning to the same Session restores its current width; selecting a different Session closes the root-scoped details preference through the layout store *before* paint; closing details in the New Session click handler was rejected because an unselected surface has no Session-scoped details and must not mutate geometry.
- Surprising: treating every current-projection change as a Session switch was rejected because startup materialization, hero, clearing selection and invalidation are not transitions between two Session owners.

### .agents/notes/archived/bug-fix/2026-07-29-web-details-session-lifecycle.zh.md
- Chinese twin: translates the owner-tracking rule, the transient-layout-store choice, the four rejected alternatives, and the stale-mirror consequences; all 3 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-30-approval-panel-command-cap.i18n.yaml
- Bilingual-pair record for the approval-panel cap note (`98e54379…` English / `07483899…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-30-approval-panel-command-cap.md
- Purpose: why the user could read a sandbox escalation but not answer it.
- Key abstractions: `--dsh-composer-text-max-height: 336px` on `ConversationRoot`'s `.composerSeat`; the `data-approval-scroll` region; the `--dsh-scrollbar-thumb{,-hover}` l2 rebinding.
- Data flow: the approval panel replaces the InputBar in the composer seat with the model's justification, the paired command and a refuse/allow row; both texts are unbounded model output and the card had no cap, so a long command grew the card until the action row left the viewport — the buttons existed, off screen, in a sticky footer that had already used the whole column (line 10).
- Non-obvious design decisions: the cap is *one value with two consumers* declared on `.composerSeat` — the composer chain's only shared ancestor, since the fallback InputBar and an elected takeover render as siblings — so the seat cannot cap its two states differently; "unify it with the input box's max height" becomes a stylesheet fact rather than a number repeated in two files (line 18).
- Edge cases / failure handling: the scroll region is a tab stop (`tabIndex={0}`, named `role="group"`) because, unlike the question composer, it holds nothing but text — without its own tab stop a keyboard-only user could reach the buttons and never the command's tail, and approve what they could not finish reading; ellipsizing the command was rejected because the panel is the whole approval UI, so there is no "show more" surface to fall back to.
- Surprising: reproducing the off-screen buttons needs a card taller than the scrollport, not merely a tall card — while the card still fits, the sticky seat holds the bottom edge and the buttons stay visible; and the scenario keeps exactly one golden (the waiting panel) because an answered transcript golden cannot hold, as the OS's own refusal text is platform-specific.

### .agents/notes/archived/bug-fix/2026-07-30-approval-panel-command-cap.zh.md
- Chinese twin: translates the shared-cap decision, the tab-stop requirement, the four rejected alternatives, the measured 1798px-vs-336px comparison, and the golden-stability argument; all 24 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-30-bounded-overwrite-diff-basis.i18n.yaml
- Bilingual-pair record for the bounded-diff-basis note (`d07a592c…` English / `3751cc72…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-30-bounded-overwrite-diff-basis.md
- Purpose: bounding the presentation-only pre-read an overwrite did to build a contextual diff.
- Key abstractions: `LocalFileSystem.Config.diffBasisMaxBytes` (positive safe integer, 10 MiB default); `FsWriteOutcome.before`; `tool-fs.readStreamMinSize`.
- Data flow: the provider returned the complete prior file in `before`; the fix supplies `before` only when the UTF-8 replacement is strictly below the limit *and* the prior file opened for the basis also ends below it — the prior read opens a descriptor, checks *that descriptor*, and reads at most the configured byte count in cancellation-aware chunks, returning `null` at the boundary (line 14).
- Non-obvious design decisions: the local provider owns this decision because `before` is its optional, best-effort basis — it can avoid acquiring prior content the configured pair limit already made ineligible; `tool-fs` continues to own diff computation, retention and presentation, and the setting is *independent* of `tool-fs.readStreamMinSize` because read routing and overwrite presentation are different policies.
- Edge cases / failure handling: a size change after the descriptor stat returns `null` even if the final size is below the limit, because a partial prefix would be an incorrect diff basis; binary or invalid UTF-8 prior content, and any descriptor-phase errno, likewise return `null` — a prior file deleted between the caller's preflight and the basis open cannot fail a write the caller already committed to; only cancellation and non-errno faults propagate, and none of these outcomes block the atomic write.
- Surprising: trusting the initial `probe()` size was rejected because that size can become stale before the read — the bound must be enforced on the object actually read, not on a path stat.

### .agents/notes/archived/bug-fix/2026-07-30-bounded-overwrite-diff-basis.zh.md
- Chinese twin: translates the descriptor-bounded read, the `null` outcome matrix, the provider/tool-fs ownership split, and the four rejected alternatives; all 11 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-30-composer-context-stack-order.i18n.yaml
- Bilingual-pair record for the composer-stack note (`7f9aca5e…` English / `9c5cd6c1…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-30-composer-context-stack-order.md
- Purpose: why Goal, Todo and Queue rendered in an order that inverted the design's hierarchy.
- Key abstractions: the `conversation.input.dock` list; `ConversationRoot`'s 6px inter-card space; the Goal 752×36px card; the collapsed Todo 752×44px card; Queue's 776px wrapper with a named 5px layout overlap.
- Data flow: the three contribute independently to the same dock list, but their registration order and spacing rules did not encode the composition matrix — the renderer placed Todo before Queue and Goal, while both Queue and Goal carried negative margins intended for the composer boundary, so with all three present Queue joined Goal and Goal joined the composer (line 10).
- Non-obvious design decisions: order and overlap are *separate contracts* — registration order establishes semantic hierarchy, CSS variables on the stack establish shared geometry; Queue does not infer that it may overlap merely from being the last visible entry, because Goal or Todo can be the last visible card when no queue exists and must stay separated from the composer (line 18).
- Edge cases / failure handling: empty entries render null and consume no gap; new input-dock plugins must choose an order relative to Todo `0`, Goal `10` and Queue `20`.
- Surprising: rendering each known dock id separately in `ConversationRoot` was rejected because it turns an extensible list slot into a hardcoded component inventory and forces the owner to change for every new registrant; the Todo-first order is later fixed by `2026-08-02-todo-first-composer-context-order.md`.

### .agents/notes/archived/bug-fix/2026-07-30-composer-context-stack-order.zh.md
- Chinese twin: translates the composition-matrix problem, the order/overlap separation, the four rejected alternatives, and the plugin-order contract; all 5 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-30-hover-popup-pointer-grace.i18n.yaml
- Bilingual-pair record for the pointer-grace note (`b770ac85…` English / `1ebe2d2d…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-30-hover-popup-pointer-grace.md
- Purpose: why hover-raised popups closed before the pointer could reach them.
- Key abstractions: `usePointerGrace` (`packages/client/ui-primitives/src/pointer-grace.ts`) with `POINTER_GRACE_MS` = 200; `HoverCard`; `Menu`'s `closeOnPointerLeave`.
- Data flow: `HoverCard` closed on the first `pointerleave` from its anchor and rendered its card `pointer-events: none`, but the card sits 8px off the anchor's right edge, so every path to it crossed ground belonging to neither; `Menu` put its leave handler on the portaled list, so aiming back at the `...` trigger closed it (line 10).
- Non-obvious design decisions: one shared cancelable delayed close owns both behaviours; leaving arms the close and coming back cancels it, while re-entering an already-open card cancels the pending close *without restarting the dwell*, so the card does not blink when the pointer crosses the gap; `Menu` moves the leave handler to the wrapper span, because React's enter/leave traversal runs over the React tree where the trigger and the portaled list are one region (lines 16-18).
- Edge cases / failure handling: an owner-driven close (selection, Escape, outside click) disarms a pending grace close in an effect keyed on `open` *alone* — folding it into the outside-click effect would cancel the grace on every re-render, since owners pass a fresh `onClose` closure each time.
- Surprising: keeping the hover card `pointer-events: none` and only adding the grace was rejected, because a pointer resting on the card would hit whatever is behind it, so the grace would expire and close the card the user had just reached; the price of reachability is that the now-hit-testable card covers 244px of whatever it overlays.

### .agents/notes/archived/bug-fix/2026-07-30-hover-popup-pointer-grace.zh.md
- Chinese twin: translates the shared grace hook, the React-tree enter/leave argument, the owner-close disarm, and the four rejected alternatives; all 14 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-30-multi-select-custom-answer-composition.i18n.yaml
- Bilingual-pair record for the multi-select note (`271c554e…` English / `67b67e6c…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-30-multi-select-custom-answer-composition.md
- Purpose: why typing a custom answer on a multi-select question discarded the options already selected.
- Key abstractions: the user-questions result vocabulary `{ id, selected, custom? }`; `multiSelect`; the Web host's response validation.
- Data flow: the original semantics made the two fields mutually exclusive for *every* question; for a question with `multiSelect: true` one answer item may now contain both a non-empty `selected` array and non-empty `custom` text, and the Web draft preserves both values regardless of which the user did first (line 14).
- Non-obvious design decisions: the result shape is unchanged, so no wire or tool-output schema changes; single-select and optionless questions keep exclusive semantics, where custom text overrides any selected option.
- Edge cases / failure handling: allowing the combination for every question was rejected because a single-select question represents one answer and permitting a selected option plus custom text would make its cardinality ambiguous.
- Surprising: encoding custom text as another `selected` label was rejected because it would erase the distinction between caller-provided option labels and human-authored text, weakening validation and forcing consumers to infer which value was custom.

### .agents/notes/archived/bug-fix/2026-07-30-multi-select-custom-answer-composition.zh.md
- Chinese twin: translates the conditional-composition rule, the unchanged result shape, and the two rejected alternatives; all 5 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-30-source-checkout-workdir-distinction.i18n.yaml
- Bilingual-pair record for the source/workdir note (`a6ebd1ed…` English / `570f9502…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-30-source-checkout-workdir-distinction.md
- Purpose: why DeepSeek V4 answered "what's the workdir?" with the harness checkout.
- Key abstractions: the `harness:source` prompt section at first-party order −900; `{{cwd}}`.
- Data flow: in a normal TUI configuration that does not state `{{cwd}}` in its persona, the checkout path may be the only fixed absolute path near the start of the system prompt; the section now identifies it as the "DeepSeek Harness implementation checkout", says the checkout location and current working directory are separate values that may differ, forbids inferring one from the other, directs the model to use `pwd`, and limits the checkout's purpose to inspecting or extending DSH itself (line 16).
- Non-obvious design decisions: describing the values as *conceptually separate* rather than always unequal keeps the instruction accurate in both ordinary project sessions and `dsh meta`, where the two are deliberately the same path.
- Edge cases / failure handling: the cost is a longer prompt and possibly one inexpensive `pwd` tool call for a direct working-directory question; putting the cwd in the global source section was rejected because the source section is launcher-global while the working directory belongs to each session.
- Surprising: the TUI `source-checkout-workdir` snapshot mounts the section with `/opt/dsh-source` and requires the replayed transcript to *run* `pwd` and report the generated workspace rather than the checkout — the check is behavioural, not textual.

### .agents/notes/archived/bug-fix/2026-07-30-source-checkout-workdir-distinction.zh.md
- Chinese twin: translates the "checkout vs workdir" wording, the conceptual-separation framing, the three rejected alternatives, and the behavioural snapshot; all 9 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-30-tui-adapter-registration-race.i18n.yaml
- Bilingual-pair record for the adapter-race note (`051f5e6a…` English / `1706acb1…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-30-tui-adapter-registration-race.md
- Purpose: why every fresh TUI session printed "Could not resolve model context: no adapter registered for provider …".
- Key abstractions: the `llm/adapters-updated` registry commit event; `resolveModelInfo`'s `NO_ADAPTER` rejection; the TUI model controller.
- Data flow: Cordis activates plugins by service availability, not configuration order, so the TUI (whose `inject` requires only the `llm` service) can mount before a configured adapter plugin finishes registering its routes; the controller now treats a `NO_ADAPTER` rejection as transient — it parks the resolution silently and re-resolves on the next `llm/adapters-updated` commit, the payload-free registry notification `LlmService` already fires at every route commit point (line 14).
- Non-obvious design decisions: a commit that still lacks the route parks the wait *again*, so unrelated topology changes stay silent; any target change re-enters the resolution and clears the pending wait, so the deferred state can never go stale against the current selection.
- Edge cases / failure handling: every other resolution error still prints the notice; a genuinely misconfigured provider name now surfaces at first dispatch rather than at startup.
- Surprising: polling with a timer was rejected as guessing at activation latency and adding a tunable with no owner, while "wait for boot to settle" was rejected because the TUI has no Loader dependency and "settled" is not observable from inside a plugin — subscribing to the registry's existing announcement is precise and free.

### .agents/notes/archived/bug-fix/2026-07-30-tui-adapter-registration-race.zh.md
- Chinese twin: translates the defer-on-`NO_ADAPTER` decision, the silent re-park behaviour, the stale-wait clearing, and the four rejected alternatives; all 12 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-30-web-details-default-closed.i18n.yaml
- Bilingual-pair record for the details-default-closed note (`e4271917…` English / `3b943206…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-30-web-details-default-closed.md
- Purpose: why the app reserved a right column before the user selected any detail content.
- Key abstractions: the transient layout store's zero-width default; `openDetails()`'s 360px contract width; the mounted zero-width details slot.
- Data flow: the store initialized details to its 360px contract width, so the first connected Session and every full reload reserved a right column; it now initializes to zero while retaining 360px for an explicit `openDetails()`, and `AppFrame` keeps the details slot mounted at zero width so an explicit entry point such as Trajectory event selection can open the panel without remounting its subtree (line 14).
- Non-obvious design decisions: the details column and layout service were kept because Trajectory already opens event details through this seam, and keeping the mounted slot preserves that working interaction.
- Edge cases / failure handling: panel geometry remains transient — no browser storage key is introduced, and reload restores the sidebar default while details returns to zero; switching to another Session closes an opened panel.
- Surprising: persisting the last open/closed preference was rejected because reload should have a deterministic closed baseline, and persisting geometry would reintroduce stale viewing state across browser sessions; Chat tool rows deliberately remain geometry-inert.

### .agents/notes/archived/bug-fix/2026-07-30-web-details-default-closed.zh.md
- Chinese twin: translates the zero-width default, the mounted-slot rationale, the three rejected alternatives, and the transient-geometry consequences; all 2 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-30-web-transcript-log-ordered-projection.i18n.yaml
- Bilingual-pair record for the browser transcript note (`b16a87d5…` English / `871894f2…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-30-web-transcript-log-ordered-projection.md
- Purpose: the browser's counterpart to the terminal fix — replacing `FoldAdapter` with a log-ordered `TranscriptAdapter`.
- Key abstractions: `TranscriptAdapter` vs `FoldAdapter`; `CompactionSummaryNode`; `CommandNode`; `ConversationSnapshot.foldDegraded` (removed); `COMPACT_CHECKPOINT_SOURCE` / `isCompactCheckpointSource` in the new cordis-free leaf `packages/compaction/compaction/src/checkpoint.ts`.
- Data flow: `FoldAdapter` ran the core `SurfaceManager` over the history window and read `surface.nodes`, so a landed compaction collapsed every shadowed message into one dim context row; the new adapter never consults surface order and projects the raw window in log order — every append-origin surface event at its own log position plus one marker per landed compaction checkpoint (line 16).
- Non-obvious design decisions: checkpoint recognition needs *all three* of `event.type === 'user/message'`, the compaction seam's checkpoint plugin source, **and** `isReplacementSurfaceEvent(event)` — a plugin-sourced `user/message` that *appends* is injected context, not a compaction; because the client program cannot reach the `dsh-compaction` root (the host `sessions: SessionStore` merge collides with the client's `sessions: ISessions` — `TS2717`), the predicate moved to a cordis-free leaf subpath and the client pins its literal with a **type-only** import, so renaming the Service Definition's plugin id becomes a compile error in the client (line 34).
- Edge cases / failure handling: a window whose checkpoint cites a shadowed range outside it has no range to resolve, so the marker renders and nothing is logged; `foldDegraded` is *deleted* rather than kept as a defensive flag, along with the padding sentinels, the `baseSeq` arithmetic and `degradedSeqs()` — the flag described a failure of a fold that no longer runs, and was reachable only through a `console.error`.
- Surprising: node order is seq-monotonic by construction, which is what lets the log-only `command/run`/`command/done` pair fold into `CommandNode`s that splice into an already-monotonic array with no anchors and no reordering; and the manual-compaction command pairs with a checkpoint only through the `CommandResult.sourceEventSeq` reference, never by proximity, because context injection may land between them.

### .agents/notes/archived/bug-fix/2026-07-30-web-transcript-log-ordered-projection.zh.md
- Chinese twin: translates the adapter replacement, the three-condition checkpoint recognition, the cordis-free leaf + type-only import mechanism with its `TS2717`/`TS2322` diagnostics, the `foldDegraded` removal, and the seven rejected alternatives; all 62 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-31-code-runtime-python-settlement-fixes.i18n.yaml
- Bilingual-pair record for the code-runtime settlement note (`6ad9faad…` English / `a9228821…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-31-code-runtime-python-settlement-fixes.md
- Purpose: a review-driven set of independent corrections to the CPython subprocess backend behind PTC mode, each fixing a contract the seam had already promised.
- Key abstractions: the fd-3 frame protocol (`packages/experimental/code-runtime-python/src/index.ts` and `py/bootstrap.py`); `CodeRunResult`; `FRAME_PARSE_CAP_BYTES` (64 MiB); `FRAME_ENVELOPE_BYTES`; `OUTPUT_BUDGET_WORST_CASE_ADDRESS_SPACE_MULTIPLE` (twelve); `INTERPRETER_BASELINE_BYTES`; `RLIMIT_AS`/`RLIMIT_CPU` clamping; `detachResidual`; `jsonStringCostUpTo`; `accrueStrayCost`.
- Data flow: the seam promises that every program outcome resolves as a `CodeRunResult` (never a rejection), that `run()` rejects only for seam misuse, and that disposal is quiescent. The fixes include: the fd-3 boot-frame write moved after the `const` bindings so a synchronous write failure no longer hits a temporal-dead-zone `ReferenceError` and rejects `run()` (line 26); `LogBuffer` taking one re-entrant lock shared by both streams so a daemon thread's `print` cannot interleave with settlement's flush (line 30); the fd-3 residual detached into a fresh right-sized `Buffer` so a view no longer pins the whole concat allocation while `pendingBytes` under-reports (line 34); the output-cap load bound changed from `parse-cap / 6` to `parse-cap − envelope` because both budgets are metered in already-escaped serialized bytes (line 38).
- Non-obvious design decisions: same-group survivors are reaped with a **ref'd** poll timer so the host event loop stays alive until the SIGKILL actually reaps the group — an `unref`'d timer lets a short-lived host exit and reparent the survivor to init, breaking the "no subprocess outlives the fiber" promise; settlement therefore neither resolves `finished` nor drops the run from `live` while a group is non-empty (line 42). The SIGKILL timer is cancelled the moment the group is confirmed empty, because a pending `kill(-pid)` after the leader was reaped could hit a *recycled* pgid, and the danger is precisely the kill that succeeds against a reused group (line 44).
- Edge cases / failure handling: `process.kill(-pid, 0)`'s ESRCH probe is not used as the reap assertion (a SIGKILL'd process lingers as a zombie until its parent `wait()`s it, and in a container whose PID 1 does not reap orphans the probe keeps succeeding — so a heartbeat file that stops advancing is used instead); a leader's start time is read from `/proc/<pid>/stat` field 22 and re-read before each signal, with a *present-and-different* reading withholding the signal and an *absent* reading proceeding (absent is the ordinary case for every escalation); a blocked event loop past both timers is handled by the deadline branch sending SIGKILL itself and granting one more margin; `_clamped` bounds each rlimit side against its *own* inherited counterpart, because clamping only against the inherited hard limit silently *raises* a stricter inherited soft limit; and `RLIMIT_CPU` soft is lowered one unit below hard so SIGXCPU can fire at all.
- Surprising: the note names **eleven** behavioural fixes that ship *without* a fail-before test, with the reason for each (the chunked frame read is a syscall-count improvement; the confirmed-empty finalize's only seam-observable effect is a frozen heartbeat that the pre-fix code also produced; the shared stdout/stderr budget's difference turns on nondeterministic cross-pipe arrival timing; the done-value TOCTOU pre-encoding's concurrent-mutation race is not deterministically constructible through the seam) — an unusually honest accounting of what a green suite does not prove.

### .agents/notes/archived/bug-fix/2026-07-31-code-runtime-python-settlement-fixes.zh.md
- Chinese twin: translates all 22 sub-sections, the ref'd-poll reap mechanism, the recycled-pgid guard, the rlimit-clamping rules, the eleven no-fail-before fixes, the eight rejected alternatives, and the full test inventory; all 312 code identifiers match the English side exactly.

### .agents/notes/archived/bug-fix/2026-07-31-composer-text-layers-share-one-scrollport.i18n.yaml
- Bilingual-pair record for the composer-scrollport note (`eb50673b…` English / `f0af130d…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-31-composer-text-layers-share-one-scrollport.md
- Purpose: why swiping a long draft threw the caret out of its own text.
- Key abstractions: the composer's two text layers — the `<textarea>` (value, selection, caret, `color: transparent` glyphs) and the `[data-input-backdrop]` div (visible glyphs, claim-token highlight, chips, ghost hint); the single `[data-input-scroll]` scrollport; the hidden mirror div.
- Data flow: the backdrop was `position: absolute; inset: 0; overflow: hidden` — clipped, not scrolled — and nothing linked its offset to the textarea's, so past the 14-line cap the caret moved and the words stayed frozen; a `scroll` listener mirroring `scrollTop` fixed it *at rest* but not in motion, because the wheel gesture scrolls the textarea on the compositor and the `scroll` event is dispatched afterwards — measured separation 203px (chromium), 202px (firefox), 203px (WebKit), settling to a fixed 3/2/3px line-box constant a frame or two later (line 16).
- Non-obvious design decisions: the fix is structural, not behavioural — `[data-input-scroll]` is the composer's *only* scrollport and holds both layers, the auto-grow stack is as tall as the whole draft (the hidden mirror is in normal flow and no longer capped), and the textarea is `overflow: hidden` with no scrollable overflow of its own, so it can no longer hold an offset at all; the browser then applies one offset to both layers in the same frame on the same compositor, and the caret is bound to its glyphs *by construction* (line 24). The decisive test reads the separation **before the task ends**, i.e. before any `scroll` listener could have run: 0 with one scrollport, the full delta with a mirror.
- Edge cases / failure handling: Safari's native text control retains the former line layout after a soft-wrap threshold deletion, handled by a separate recovery note; the caret after a trailing newline sits on a line with nothing to measure, so chromium returns no client rects at all, firefox reports the line above and WebKit the right one — the helper therefore measures the newline the caret just left and steps one line down, landing all three on the same offset (649 of 652).
- Surprising: "no listener can close that gap, because the gap is the definition of a listener: it runs after the thing it reacts to" (line 18) — and the superseded `scrollTop` mirror needed two premises (equal extents, equal wrap widths) to stay true, *each of which had already failed once*; a `scroll-driven animation` (`animation-timeline: scroll()`) would have run on the compositor but is rejected on support grounds (Safari does not implement it), and `contenteditable` was rejected as far out of proportion because it would put IME composition, undo/redo, selection semantics and paste normalization back on the team.

### .agents/notes/archived/bug-fix/2026-07-31-composer-text-layers-share-one-scrollport.zh.md
- Chinese twin: translates the two-layer split, the 203/202/203px measurement, the single-scrollport restructure, the Safari caret-reveal engine disagreement, the ten rejected alternatives, and the "the gap is the definition of a listener" argument; all 33 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-31-english-compaction-checkpoints.i18n.yaml
- Bilingual-pair record for the English-checkpoint note (`62db12bb…` English / `bea53cbf…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-31-english-compaction-checkpoints.md
- Purpose: keeping a multilingual conversation from permanently changing the model's reasoning register.
- Key abstractions: `COMPACTION_INSTRUCTION`'s English-language requirement; the framed checkpoint's structured headings.
- Data flow: a compaction checkpoint becomes part of the next model request's durable prefix; when a multilingual conversation led the compactor to preserve its narrative material in the conversation language, the checkpoint introduced a large amount of a language absent from the code, tool output and existing reasoning prefix, which then persisted across later compaction cycles (line 10).
- Non-obvious design decisions: the requirement is integrated into the *first sentence* of the trailing compaction instruction, and the model is asked to translate narrative source material as needed while preserving exact literals — paths, commands, errors, identifiers, signatures and quoted wording where exactness matters.
- Edge cases / failure handling: the replayed system prompt, tools and conversation history stay byte-identical to the routed request, so the change retains the prefix-cache reuse owned by the compaction summary note; requiring ASCII-only output was rejected as a character-set constraint rather than an engineering-register constraint, which would distort legitimate literals.
- Surprising: constraining the *conversation* model's language was rejected — the policy targets an internal checkpoint, not the user's visible conversation, and a conversation-wide rule would unnecessarily change normal interaction.

### .agents/notes/archived/bug-fix/2026-07-31-english-compaction-checkpoints.zh.md
- Chinese twin: translates the durable-prefix argument, the "English engineering register with exact literals" rule, the four rejected alternatives, and the cache-alignment guarantee; all 1 code identifier matches the English side.

### .agents/notes/archived/bug-fix/2026-07-31-fail-loud-releases-the-terminal.i18n.yaml
- Bilingual-pair record for the fail-loud release note (`770b5e4a…` English / `af3eb559…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-31-fail-loud-releases-the-terminal.md
- Purpose: why a failed `dsh` launch left the user's shell in raw mode with a stray device-attributes reply in it.
- Key abstractions: `installFailLoud`'s optional `release` teardown; `FAIL_LOUD_RELEASE_TIMEOUT_MS` (2s); the root context captured in `boot()`'s `prepare` hook; pi-tui's `ProcessTerminal.start()`/`stop()` and `drainInput()`.
- Data flow: the Loader mounts entries concurrently, so entry failure order is not startup order; `ui-tui` activated, put stdin in raw mode, enabled bracketed paste and wrote the Kitty keyboard-protocol probe, ending in a Device Attributes query (`ESC [ c`); a sibling entry then rejected, `installFailLoud` wrote one stderr line and called `process.exit(1)` immediately, so `ProcessTerminal.stop()` never ran and the terminal's answer (`1;2;4c`) arrived after exit and was read by the shell as typed input (line 21).
- Non-obvious design decisions: the diagnostic is written **before** the release, so a hanging or failing disposer cannot swallow the reason; a *latch*, not an uninstall, keeps the first rejection the reported one (removing the listener during teardown would let a second concurrent rejection become uncaught and Node would kill the process mid-teardown); the release is bounded by `FAIL_LOUD_RELEASE_TIMEOUT_MS` and its rejection is swallowed — a wedged disposer delays the fatal exit, it never cancels it (line 31).
- Edge cases / failure handling: the timeout timer stays **referenced** — an `unref`'d one lets Node reach an empty event loop and exit 0 on the very failure being reported, because an `unhandledRejection` listener suppresses the default fatal exit; omitting `release` keeps the previous behaviour exactly, so the ACP, JSON-RPC and demo bins are unchanged.
- Surprising: the `/exit` path was never affected because it disposes the tree and reaches the TUI's own `shutdown()`, which calls `drainInput()` (absorbing the pending reply) — the defect was that a *failed boot* had no path to that same teardown; and the guarantee belongs to whichever bin owns the terminal, since `installFailLoud` cannot detect on its own that a mounted plugin grabbed terminal state.

### .agents/notes/archived/bug-fix/2026-07-31-fail-loud-releases-the-terminal.zh.md
- Chinese twin: translates the raw-mode/stray-reply sequence, the latch-before-release ordering, the referenced-timer rule, the four rejected alternatives, and the PTY regression test; all 34 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-31-fork-anchor-floors-to-event-seq.i18n.yaml
- Bilingual-pair record for the fork-anchor note (`054bda7a…` English / `7a7529c7…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-31-fork-anchor-floors-to-event-seq.md
- Purpose: why the fork button on a stopped assistant message did nothing at all.
- Key abstractions: the fractional flow-ordering seq `turnEnd.seq - 0.9`; `SessionRuntime.fork`; `session.fork`'s wire contract (non-negative integer).
- Data flow: the frozen node behind that message is not a log event — both the live projection and the history replay mint it with a flow-ordering seq of `turnEnd.seq - 0.9`, and the chat view hands that seq to the fork entry point unchanged; the host rejects a fractional anchor as invalid-params before the request reaches it, and the chat entry's fork call swallows failures, so nothing distinguished the rejection from an inert button (line 12).
- Non-obvious design decisions: `SessionRuntime.fork` floors `atSeq` before the RPC, because the fractional-seq convention belongs to `dsh-client-runtime` (which mints it in both projections) — so the same package converts it back at the wire boundary instead of every UI caller remembering to (line 18).
- Edge cases / failure handling: flooring lands *inside* the anchor's own turn rather than clipping backward, because every turn opens with `turn/start`, so `turnEnd.seq - 1` cannot itself be an earlier turn's `turn/end`; the host's first-`turn/end`-at-or-after rule then closes on the turn the reader clicked.
- Surprising: the host's cut rule was never the obstacle — an aborted turn ends with a logged `turn/end` carrying reason `aborted`, so it is a completed prefix like any other and the anchor simply never arrived; and fork failures remain silent in the chat entry, which is why this bug survived.

### .agents/notes/archived/bug-fix/2026-07-31-fork-anchor-floors-to-event-seq.zh.md
- Chinese twin: translates the fractional-seq mechanism, the wire-boundary flooring, the "flooring stays inside the turn" argument, and the three rejected alternatives; all 12 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-31-hero-visible-while-blank-session-opens.i18n.yaml
- Bilingual-pair record for the hero-visible note (`1b1f35d8…` English / `91c1a372…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-31-hero-visible-while-blank-session-opens.md
- Purpose: why launching into a recent workspace looked like a full-page refresh.
- Key abstractions: `ConversationRoot`'s `settling` phase; the session list summary's `blank` flag; `WorkspacesService.startInitialSelection`; `openState`.
- Data flow: the hero-versus-docked outcome is unknowable until history arrives, so the composer seat is hidden (`visibility:hidden`) rather than flashing the centred hero; startup auto-selection turned that guard into the defect, because `openState` flips to `loading` the moment `open()` lands, so the centre column went blank for the whole history round-trip (line 10).
- Non-obvious design decisions: the fix reads the *list summary's* `blank` flag alongside the conversation snapshot and exempts summary-proven blank sessions from settling — `settling` additionally requires `summaryBlank !== true`, and `hero` accepts a blank composer whenever the summary proves the session blank, in every open state rather than only `loading` (line 14).
- Edge cases / failure handling: whenever the summary does not prove the session blank — a row reporting `blank: false`, or no row at all because the list has not caught up — the conservative settling hide is unchanged; the summary flag and the snapshot's own `blank` are distinct sources, and only the summary is available early enough to decide the phase.
- Surprising: the e2e holds the `session.history` response open at the browser's network boundary, because against a loopback host the open settles too fast to sample and the held window is precisely when the root would report `settling` — making the second case a regression test rather than a race.

### .agents/notes/archived/bug-fix/2026-07-31-hero-visible-while-blank-session-opens.zh.md
- Chinese twin: translates the settling-phase guard, the summary-flag exemption, the three rejected alternatives, and the network-boundary hold technique; all 21 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-31-resume-selector-batch-projection.i18n.yaml
- Bilingual-pair record for the resume-selector note (`c30abf7f…` English / `f0898242…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-31-resume-selector-batch-projection.md
- Purpose: why the TUI `/resume` selector took tens of seconds to open on a real store.
- Key abstractions: `session-title`'s `title` projection unit; `sessionProjectionCache.cachedSnapshot` / `coldSnapshot`; `readTitleSnapshots`; `resumeScanConcurrency`; `sessionPersistence.locate()`; `SessionCorpus.load()`.
- Data flow: the selector called `sessionQuery.readSession()` once per listed session under an unbounded `Promise.all`; each call re-listed the whole persistence store inside `SessionCorpus.load()` (O(N²) listings), read and decompressed the complete log, replay-validated every event through the `Session` constructor, and deep-cloned the header and events up to three times — all to derive one row's title, timestamp, turn label, route and goal phase; on 185 sessions / 87 MB compressed / ~353k events it took tens of seconds (line 10).
- Non-obvious design decisions: selector rows fold **nothing but titles**; everything else comes from metadata — a live row reads the registry snapshot, a persisted row reads the durable checkpoint row (one file read per session), and only a row without a usable checkpoint pays a `coldSnapshot`, which is written back so the next scan is zero-I/O; cold reads are bounded by `resumeScanConcurrency` (line 16).
- Edge cases / failure handling: the activity timestamp never reads a log — a persisted Session stats the artifact named by the optional `sessionPersistence.locate()` (mtime), falling back to the header's creation time; any append moves the mtime, so a merely-browsed Session floats up, accepted as the price of a metadata-only timestamp; a per-row failure is isolated into a disabled "Unreadable session" fallback; the overlay opens synchronously on `/resume` with a "Loading sessions…" placeholder, and closing it aborts the scan through the `AbortSignal`, with a staleness check dropping a signal-ignoring backend's late settlement.
- Surprising: a generic batch projection (`projectSessions`) was implemented first and then rejected — it still decompressed and parsed every log on every `/resume`, so browsing cost stayed O(total log bytes), and it grew the session-query public API for one consumer; and the last-turn label, provider/model route and goal phase columns were removed from rows entirely, with route availability enforced instead by an Enter-time preflight that fully reads and replay-validates the one chosen log.

### .agents/notes/archived/bug-fix/2026-07-31-resume-selector-batch-projection.zh.md
- Chinese twin: translates the O(N²)/triple-clone cost analysis, the title-only fold, the mtime-based timestamp, the abort/staleness handling, the four rejected alternatives, and the O(session count) consequence; all 28 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-31-same-basename-workspace-adoption.i18n.yaml
- Bilingual-pair record for the same-basename note (`2d589009…` English / `bfc9e4de…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-31-same-basename-workspace-adoption.md
- Purpose: why `/a/xx` and `/b/xx` could not both exist as Workspaces.
- Key abstractions: `ctx.workspaceRegistry.create(path, title?)`; `WorkspaceId`; the Host's `workspace.create({ path })` adoption route; `workspace.rename`.
- Data flow: a Workspace is identified by its stable id and canonical directory path while its title is mutable display metadata, yet the registry rejected a new canonical path whose directory-derived title matched another Workspace; the fix treats canonical path as the only uniqueness key — repeating the same path stays idempotent and preserves the registered title, while different canonical paths create different records and may share a title (line 14).
- Non-obvious design decisions: explicit naming stays stricter — `workspace.rename` still rejects a title already registered, which prevents a user from *deliberately* introducing another ambiguous label while accepting collisions imposed by existing directory names.
- Edge cases / failure handling: the durable schema does not change (records already store id, path and title independently; bootstrap can derive equal basenames; startup validates duplicate paths rather than titles); two Workspace rows may carry the same visible title but remain independently selectable because ids own identity, and the sidebar hover card exposes each canonical path.
- Surprising: auto-suffixing colliding titles (`xx (2)`) was rejected because a generated label would need stable allocation rules across deletion and reload and would add state solely to conceal an identity mistake; and the durable schema needed no migration because the bug was purely in the registry's uniqueness key.

### .agents/notes/archived/bug-fix/2026-07-31-same-basename-workspace-adoption.zh.md
- Chinese twin: translates the path-only uniqueness key, the "explicit rename stays strict" asymmetry, the four rejected alternatives, and the no-migration consequence; all 7 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-31-tui-diff-context-line-accounting.i18n.yaml
- Bilingual-pair record for the diff-context note (`5172069c…` English / `b9a9863f…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-31-tui-diff-context-line-accounting.md
- Purpose: why a one-line edit appeared as seven removals plus seven additions.
- Key abstractions: `FileDiff.oldText` / `FileDiff.newText`; `maxDiffEditLength` (default 1000); the shared `diff` package.
- Data flow: result-time filesystem diffs carry the applied change with three surrounding context lines on each side, and the TUI rendered every old-side row as removed and every new-side row as added, including the identical context present on both; the TUI now compares each `FileDiff` whose old and new text are both available — added/removed rows keep their `+`/`-` markers while equal context rows use the recessed body tone with a neutral two-space prefix, and the footer sums only added or removed rows (line 14).
- Non-obvious design decisions: this stays a *consumer-side interpretation* of the existing `FileDiff` contract — filesystem tools continue to persist contextual before/after snippets, so other consumers keep their placement context and existing session logs replay with corrected TUI presentation.
- Edge cases / failure handling: `maxDiffEditLength` bounds the exact comparison by its combined added/removed line count; exceeding it renders the complete old side as removed and the new side as added, marks the footer approximate, and caches that result so redraws do not repeat the comparison; a tool result clears the pending-view cache before deriving the settled view, including when a presenter mutates and reuses the same view object; when `oldText` is `null` the renderer shows every non-empty new-side row as added without claiming those rows were absent from an existing file.
- Surprising: extending `FileDiff` with persisted per-line tags was rejected because the tags can be derived deterministically from the existing before/after pair — persisting them would widen the cross-package and session-log contract solely for one renderer; and matching equal lines by position without a diff algorithm was rejected because insertions and deletions shift subsequent context.

### .agents/notes/archived/bug-fix/2026-07-31-tui-diff-context-line-accounting.zh.md
- Chinese twin: translates the neutral-context rendering, the `maxDiffEditLength` bound and approximate fallback, the `oldText: null` rule, and the four rejected alternatives; all 12 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-07-31-web-stop-preserves-queue.i18n.yaml
- Bilingual-pair record for the web-stop note (`8580869a…` English / `44aa39a5…` Chinese).

### .agents/notes/archived/bug-fix/2026-07-31-web-stop-preserves-queue.md
- Purpose: why the Web stop button discarded every queued user submission.
- Key abstractions: `session.cancel`; `agent.cancel({ kind: 'user' }, { keepInbox: true })`; the AgentLoop's FIFO driver; `agent/inbox/dequeue`; the Host's `session/queue` snapshot.
- Data flow: `session.cancel` mapped to broad `agent.cancel({ kind: 'user' })`, and during an active turn ordinary composer submissions are already accepted as independently addressable Queue occurrences; the fix makes `session.cancel` the Web Host API's active-turn stop — it rejects session-backed subagents with `agent-busy` and otherwise calls `agent.cancel({ kind: 'user' }, { keepInbox: true })`, preserving queued and steering entries (line 16).
- Non-obvious design decisions: the AgentLoop starts no concurrent replacement turn — it closes and flushes the interrupted turn, reaches cancellation quiescence, and *then* claims the next waking queued occurrence through its existing FIFO driver; the claim emits `agent/inbox/dequeue`, so the authoritative Host snapshot retires the claimed row and leaves the remaining tail visible, and the browser neither resends nor promotes any row.
- Edge cases / failure handling: work that ignores cancellation delays the handoff until it settles; the default `Agent.cancel()` contract remains broad, ACP and TUI retain their cancellation policies, and `AgentHandle.dispose()` still clears pending work during teardown.
- Surprising: the browser *cannot* repair the loss by resending visible rows — it does not own their live `InboxItemId`, wake policy or claim race, and a resend can duplicate work the Host has already claimed; starting the next turn before cancelled work reached quiescence was rejected because two turns would concurrently mutate one session log and share Agent-owned resources.

### .agents/notes/archived/bug-fix/2026-07-31-web-stop-preserves-queue.zh.md
- Chinese twin: translates the `keepInbox` mapping, the quiescence-then-claim ordering, the four rejected alternatives, and the "browser cannot resend" argument; all 10 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-01-ask-user-delegated-caller-guard.i18n.yaml
- Bilingual-pair record for the ask-user guard note (`2382ead2…` English / `0aa173b0…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-01-ask-user-delegated-caller-guard.md
- Purpose: why a one-shot subagent calling `ask_user_question` could block indefinitely.
- Key abstractions: `AskUserQuestionRequest.agent`; `UserQuestionService.ask()`; `ctx.agents.roots()`; the `CALLER_NOT_LIVE` / `DELEGATED_CALLER` error codes; `ctx.userQuestions.ask()`.
- Data flow: the call waits for a human answer, but the child has no independently owned human channel, so the child's completion and the parent waiting on it both stall; when `AskUserQuestionRequest.agent` is present, the service authenticates the exact live agent through `ctx.agents` and admits it only when `ctx.agents.roots()` contains that instance — a missing registry or stale same-id object fails with `CALLER_NOT_LIVE`, and a live agent owned by another live agent fails with `DELEGATED_CALLER` (line 16).
- Non-obvious design decisions: **runtime ownership is the authority** — a lineage-bearing session resumed without an owner is a runtime root and may ask, while a live child remains ineligible even when its durable `delegationDepth` is zero; the check runs after the aborted and empty-batch guards and before intent validation or provider dispatch, so an owned child never creates a UI wait.
- Edge cases / failure handling: the shared failure text is consumer-neutral and actionable — the child includes the unresolved question or decision in its final result, and the parent already receives that result through the delegation contract and can decide whether to ask the human; neither the service nor a child claims an upward messaging or answer-forwarding capability that does not exist.
- Surprising: durable lineage cannot decide whether an answerer exists, so `session.header.delegationDepth > 0` was rejected (it rejects valid resumed roots and can admit a live child whose durable header is incomplete); the guard is placed in the *service* rather than in `dsh-tool-ask-user` because `exit_plan_mode` and direct callers share `ctx.userQuestions.ask()`; and the change leaves model-visible schemas and system-prompt prefixes untouched — only the appended error result differs, so existing KV-cache prefixes remain reusable.

### .agents/notes/archived/bug-fix/2026-08-01-ask-user-delegated-caller-guard.zh.md
- Chinese twin: translates the live-agent authentication rule, the runtime-ownership-over-lineage argument, the four rejected alternatives, and the KV-cache-prefix preservation consequence; all 12 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-02-goal-round-wrapup-message.i18n.yaml
- Bilingual-pair record for the goal-round note (`c4a62a33…` English / `11c4bbc3…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-02-goal-round-wrapup-message.md
- Purpose: why an autonomous goal round ended on a bare `update_goal` card, reading as an agent stopping mid-sentence.
- Key abstractions: `update_goal`'s `complete`/`blocked` actions; `concludeTurn()`; the `{ kind: 'plugin', plugin: 'tool-goal' }` message source; `COMPACTION`-style structured instruction headings; `dsh-llm-replay`'s `{{fromRequest:<regex>}}` placeholders.
- Data flow: the goal-round prompt and the tool description never said the call was terminal, but the standard tool-use expectation is one more assistant message after a tool result; a `complete`/`blocked` success no longer calls `concludeTurn()` — the tool defers one wrap-up context onto its own result (a plugin-sourced user message carrying a `<goal_complete>`/`<goal_blocked>` instruction to write a grounded closing message and call no more tools), and the turn then ends through the agent loop's ordinary no-tool-calls stop (line 14).
- Non-obvious design decisions: no new loop primitive exists and steering semantics are untouched; the instruction wording was selected by A/B sampling on `deepseek-v4-pro` with a reconstructed goal-round transcript — a structured instruction (outcome, verification, artifacts, next steps) consistently beat a minimal "summarize" one, a session-grounding clause shifted unsupported detail from asserted fact to hedged suggestion, and the no-instruction control produced high-variance closings including confidently fabricated file-level detail.
- Edge cases / failure handling: direct-human mutations remain uninstructed exactly as before; the cost is one additional model request per goal *lifecycle*, not per round.
- Surprising: instructing inside the tool result content was rejected because the goal tools' canonical output is compact JSON consumed programmatically — a prose instruction block inside it would mix the model-facing contract with the tool's replayable value; and scripting the keyless proof needed a snapshot-harness addition, because a static sidecar cannot know the randomly minted goal id the model must echo into `update_goal`.

### .agents/notes/archived/bug-fix/2026-08-02-goal-round-wrapup-message.zh.md
- Chinese twin: translates the wrap-up-context mechanism, the A/B-sampled instruction rationale, the three rejected alternatives, and the `{{fromRequest:...}}` scripting addition; all 18 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-02-message-fork-actions-require-completed-turn-tail.i18n.yaml
- Bilingual-pair record for the fork-tail note (`43462e85…` English / `c16c4ad0…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-02-message-fork-actions-require-completed-turn-tail.md
- Purpose: why the branch icon appeared beneath an assistant response while more rows of the same turn remained below it.
- Key abstractions: `ConversationSnapshot.turnEnds`; the IconActions row; `aria-disabled` / `aria-describedby`.
- Data flow: the Web conversation attached branch to the last assistant node with nonempty text in each turn, but a later tool result, interrupted reasoning node or terminal error has no content-text IconActions and so did not take ownership; the view now walks transcript nodes through each `turn/end` boundary and enables branch only when the boundary's last node is a user message, a durable steering message, or a content-bearing assistant message (line 14).
- Non-obvious design decisions: an unavailable control stays **visible, focusable and hoverable** — `aria-disabled`, a tooltip and `aria-describedby` explain the completed-tail requirement without sending a Host request; hiding ineligible controls was rejected because a disappearing control does not explain the boundary requirement and shifts otherwise stable message chrome.
- Edge cases / failure handling: open turns have no eligible message; the durable `turn/end` event is the authoritative completion fact, since retry and steering turns need not align with the next visible user bubble and a paged window may omit that bubble; an aborted turn is durably closed and its final interrupted text can be the true transcript tail, so eligibility depends on the completed boundary and node order, not the outcome kind.
- Surprising: cutting the event log at the clicked assistant message was rejected because an assistant message can sit inside an open step and contain tool calls whose results occur later — a raw prefix at that seq is not a balanced turn and may not be a valid provider transcript.

### .agents/notes/archived/bug-fix/2026-08-02-message-fork-actions-require-completed-turn-tail.zh.md
- Chinese twin: translates the turn-tail eligibility rule, the "visible but unavailable" presentation, the four rejected alternatives, and the later user-bubble removal; all 5 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-02-todo-first-composer-context-order.i18n.yaml
- Bilingual-pair record for the todo-first note (`146b5f23…` English / `61e989ec…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-02-todo-first-composer-context-order.md
- Purpose: why Goal rendered before Todo and why Todo was wider than both adjacent panels.
- Key abstractions: the `conversation.input.dock` list order values Todo `0`, Goal `10`, Queue `20`; the 752px card column inside the 800px composer cap; Queue's 776px wrapper with its 12px transparent inset.
- Data flow: the renderer placed Goal before Todo even though the Harness design orders the current task plan before its ongoing goal and pending Queue; the fix uses one ascending product order in the dock list, with the composer bar following the list outside it, and registration order remains the semantic source of truth (line 14).
- Non-obvious design decisions: Todo, Goal and the visible Queue panel share the 752px card column, but Queue keeps a 776px wrapper because that wrapper owns the composer overlap — Todo is a standalone card, so its responsive width and maximum width subtract both inset layers directly; using CSS `order` was rejected because accessibility and keyboard order must match the visual hierarchy.
- Edge cases / failure handling: the renderer does not hardcode known component ids or repair their order with CSS; future input-dock plugins choose an explicit position relative to Todo `0`, Goal `10` and Queue `20`, and only Queue owns the terminal wrapper overlap.
- Surprising: reordering the known panels inside `ConversationRoot` was rejected because `conversation.input.dock` is an extensible ordered list — a hardcoded component inventory would make plugin activation order and rendered order disagree.

### .agents/notes/archived/bug-fix/2026-08-02-todo-first-composer-context-order.zh.md
- Chinese twin: translates the three-value order, the shared 752px column vs Queue's 776px wrapper, the three rejected alternatives, and the 1680px/640px bounding-box comparison; all 6 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-03-cli-signal-shutdown-escalation.i18n.yaml
- Bilingual-pair record for the signal-shutdown note (`8f8dce5f…` English / `1b3a56ed…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-03-cli-signal-shutdown-escalation.md
- Purpose: why `dsh --profile headless` hung after the observation URL and ignored repeated `Ctrl+C`.
- Key abstractions: `createProcessShutdown` (one process-level controller around root disposal); the OTel backend's `shutdownTimeoutMillis` (3s); `BatchLogRecordProcessor.shutdown()` / `forceFlush()`; the 5-second exit backstop.
- Data flow: OTel's `BatchLogRecordProcessor.shutdown()` awaits `exporter.forceFlush()` before the `exportTimeoutMillis`-bounded completion promise, and the OTLP exporter's `forceFlush()` waits directly on its in-flight HTTP Promise, so a proxy/sandbox connection that never obtains a socket leaves provider shutdown pending despite both configured SDK timeouts; the backend now bounds the SDK provider's complete shutdown Promise, and the launcher bounds the whole tree (line 20).
- Non-obvious design decisions: normal shutdown calls coalesce onto one disposal and retain the first requested exit code; successful disposal records that code through `process.exitCode` and lets Node drain its remaining handles naturally, because root disposal proves the *application tree* is quiescent, not that Node and its native dependencies have retired every async handle — and an immediately forced exit after an Undici request can trip Node's Windows libuv async-handle assertion (line 24).
- Edge cases / failure handling: a signal received while shutdown is pending forces immediate exit with that signal path's code; the five-second bound is a process-safety invariant, not a deployment tunable; headless preserves exit 0 for a completed turn, 1 for another turn-end reason or API business error, 130 for SIGINT and 143 for SIGTERM, and Web preserves its existing SIGTERM 0 / SIGINT 130 behaviour; a disposer whose `cancel` returns but whose `done` never settles holds a slot forever.
- Surprising: the one-way boolean latch that caused the unkillable CLI was itself the bug — the first SIGINT joined the same pending disposal and set the latch, so later SIGINTs returned at the latch and the process had no remaining escape; and adding only the five-second timeout was rejected because a user pressing `Ctrl+C` again is asking to stop waiting *now*.

### .agents/notes/archived/bug-fix/2026-08-03-cli-signal-shutdown-escalation.zh.md
- Chinese twin: translates the OTel `forceFlush()` gap, the two-layer shutdown ownership, the `process.exitCode` reasoning, the exit-code table, the four rejected alternatives, and the PTY regression with a never-settling disposer; all 17 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-03-hmr-initial-scan-boot-deadlock.i18n.yaml
- Bilingual-pair record for the HMR deadlock note (`9a3b8b84…` English / `9f9c34ff…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-03-hmr-initial-scan-boot-deadlock.md
- Purpose: why a `dsh` launch with an invalid config exited 13 with no diagnostic at all.
- Key abstractions: the vendored `include/src/index.ts` and `hmr/src/index.ts` (logged in `vendor/README.md`); chokidar's `ignoreInitial`; the `EntryGroup.update` transaction.
- Data flow: the HMR main watcher's chokidar initial scan re-announced every existing file as `add`, and the config file's `add` triggered `Include.refresh()` while the Include's initial apply was still in flight; two concurrent `EntryGroup.update` calls on one group interleaved create and rollback on the same entries, so the Include fiber never settled — `loader.create` hung, `boot()` neither resolved nor rejected, and Node exited 13 once the loop drained (line 14).
- Non-obvious design decisions: the group's transactional `update` is **not reentrant**, so funnelling every child-tree mutation — initial apply, refresh, and `internal/update` patch re-application — through one per-Include promise queue is a correctness requirement, not a throughput choice; separately, `hmr/src/index.ts` passes `ignoreInitial: true` to the main watcher, while `registerConfig()` keeps its own `ignoreInitial: false` watcher because a personal config present at registration must apply exactly once (line 22).
- Edge cases / failure handling: serialized applies alone deadlock the failure rollback — rollback disposes every mounted entry including `hmr`, whose teardown drains its refresh tasks, and the scan-triggered refresh sits in the Include queue behind the very apply whose rollback is disposing HMR: rollback waits on HMR, HMR waits on the refresh, the refresh waits on the apply; with both fixes a failing boot now disposes the tree (running the TUI's own shutdown, restoring the terminal), `loader.create` rejects, and `boot()` rethrows the labelled diagnostic with exit 1.
- Surprising: the note names a **latent gap it deliberately leaves open** — a config edit made during a *failing* initial apply can still queue a refresh that the rollback's HMR teardown waits on, the same deadlock shape with a human-scale trigger window of one failing boot.

### .agents/notes/archived/bug-fix/2026-08-03-hmr-initial-scan-boot-deadlock.zh.md
- Chinese twin: translates the two compounding defects (concurrent group update, rollback deadlock), the queue-serialization plus `ignoreInitial` fix, the three rejected alternatives, the named latent gap, and the exit-1 PTY assertion; all 25 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-03-tui-long-session-render-costs.i18n.yaml
- Bilingual-pair record for the render-cost note (`2f6e909a…` English / `eeff7bc3…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-03-tui-long-session-render-costs.md
- Purpose: why a 196k-event session took ~12 s to render and ~800 ms to echo one keystroke.
- Key abstractions: `StepTimingTracker` (`packages/ui/tui/src/chat/timing.ts`); `ToolCardComponent` / `ContextCardComponent` width-keyed `linesCache`; pi-tui's per-component `(text, width)` caches; the `seq = log length` append-only contract.
- Data flow: every step's timing footer called `stepTimingAt`, which replayed the whole event log from index 0 per footer — O(steps × events), ~6 s of CPU; the tracker is one accumulator per chat mount, created in `createTuiChat` and threaded through `StreamingAssistantComponent` into each `StepTimingComponent`, and a query advances a cursor over events appended since the previous query, keeping per-step bucket state in a map, so all footers together cost O(events) (line 17).
- Non-obvious design decisions: the card caches restore upstream pi's own component convention (persistent child components plus explicit `cachedWidth`/`cachedLines` where rendering is custom) that the imperative `render(width)` bodies had silently defeated; the cache drops on every state mutator (`updateResult`, `setVisibility`, `setExpanded`) and on `invalidate()`, so a state change always re-renders while every keystroke frame returns the cached rows.
- Edge cases / failure handling: the tracker drops the removed implementation's mid-scan `time > at` cutoff, because per-footer `at` values make it impossible in a shared scan — under a backward wall-clock step each bucket clamps at zero, which can differ from the old cutoff's totals; the tracker assumes step coordinates are not reused after `step/end`, and a duplicate `step/start` for a closed step is ignored rather than restarting the step.
- Surprising: measured 12.2 s → 7.2 s resume and 796 ms → 17 ms per keystroke (fresh-session parity); the residual per-frame cost is pi-tui's tree traversal, and the remaining ~4 s is pi-tui's one-time initial layout — and card `render()` is no longer a pure function of `(state, width)` per call, so a new mutator that forgets to drop `linesCache` shows stale rows.

### .agents/notes/archived/bug-fix/2026-08-03-tui-long-session-render-costs.zh.md
- Chinese twin: translates the O(steps × events) diagnosis, the `StepTimingTracker` cursor design, the width-keyed card cache and its invalidation contract, the three rejected alternatives, and the measured 12.2 s → 7.2 s / 796 ms → 17 ms figures; all 35 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-04-composer-tab-gutter-reservation.i18n.yaml
- Bilingual-pair record for the tab-gutter note (`b072b683…` English / `8533c879…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-04-composer-tab-gutter-reservation.md
- Purpose: why the composer card moved 4px sideways when switching view tabs.
- Key abstractions: `.scrollBody`; `scrollbar-gutter: stable` vs `auto`; the `data-conversation-composer-overlay` attribute; the seat-width compensation note.
- Data flow: in Chat the composer seat is a sticky *child* of the column's scroller, so it rides that scroller's content box — a box a space-consuming scrollbar shortens; a view declaring `data-conversation-composer-overlay` (Trajectory does) moves the column's scrolling into the view, leaving the scroller `overflow: hidden` and positioning the seat absolutely against the padding box, which no scrollbar reduces — so for as long as the transcript overflowed, the two tabs disagreed by exactly the bar's width (line 14).
- Non-obvious design decisions: `stable` rather than `auto`, because `auto` reserves only while the box actually overflows and "overflowing or not" is precisely the difference between Chat's two phases — an `auto` gutter would state the bug rather than fix it; the reservation is Chat's alone, and the overlay branch stays a scroll container on both axes (`overflow-x: hidden; overflow-y: auto`) so a single-axis scroller does not compute the other axis to `auto` and grow a horizontal scrollbar.
- Edge cases / failure handling: the reservation must live on an `overflow-y: auto` box — WebKit applies `scrollbar-gutter` to an `overflow-y: auto` box and ignores it on a hidden one, so a reservation on a hidden box would hold in Chromium and silently not in Safari.
- Surprising: hardcoding an 8px inset was rejected because the number is the *engine's*: the WebKit path draws the sheet's 8px bar, the Firefox path draws whatever `scrollbar-width: thin` resolves to, and a hardcoded inset would line the states up in Chromium while drifting everywhere else; and the e2e must launch Chromium *without* Playwright's default `--hide-scrollbars`, because under that argument a bar consumes no layout width and every comparison in the file holds vacuously.

### .agents/notes/archived/bug-fix/2026-08-04-composer-tab-gutter-reservation.zh.md
- Chinese twin: translates the sticky-child vs absolutely-positioned geometry split, the `stable`/`auto` argument, the WebKit `overflow-y: auto` requirement, the four rejected alternatives, and the `--hide-scrollbars` vacuity trap; all 19 code identifiers match the English side (the English side alone carries the `visible` token).

### .agents/notes/archived/bug-fix/2026-08-04-large-history-pagination-call-stack.i18n.yaml
- Bilingual-pair record for the pagination note (`12e9bbf7…` English / `288687b0…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-04-large-history-pagination-call-stack.md
- Purpose: why `session.history` returned HTTP 500 on a session with a very long stream.
- Key abstractions: `sourceEventSeqs`; the per-element minimum scan.
- Data flow: a finalized assistant message can reference hundreds of thousands of streamed chunks through `sourceEventSeqs`; pagination found the message group's first event with `Math.min(event.seq, ...sourceEventSeqs)`, so a valid session could exceed the JavaScript engine's function-argument limit; the fix scans `sourceEventSeqs` and updates the earliest sequence number one element at a time (line 14).
- Non-obvious design decisions: the algorithm remains linear in the provenance size and preserves the existing page boundary — a page starts before all recorded sources of its oldest included message.
- Edge cases / failure handling: raising the JavaScript stack or argument limit was rejected as engine- and deployment-dependent; truncating `sourceEventSeqs` during pagination was rejected because it could cut a page inside a message and violate replay grouping; capping streamed chunk count at the provider boundary was rejected because providers may legitimately emit long streams.
- Surprising: the regression test *rejects multi-argument minimum calls* and verifies every provenance event stays on the page with its finalized message — it exercises the failure mechanism without making the default suite allocate a production-sized chunk stream; and the note explicitly says this does not bound the byte size of a history page or the browser cost of replaying it.

### .agents/notes/archived/bug-fix/2026-08-04-large-history-pagination-call-stack.zh.md
- Chinese twin: translates the argument-limit failure, the one-element-at-a-time scan, the three rejected alternatives, and the stated non-goals; all 3 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-05-context-meter-blind-to-compaction.i18n.yaml
- Bilingual-pair record for the context-meter note (`3ce22570…` English / `43c5a9d7…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-05-context-meter-blind-to-compaction.md
- Purpose: why the context meter ring did not move across a compaction.
- Key abstractions: `contextPressure.pressureTokens` vs the new `projectedTokens`; `sampledSurfaceTokens`; the shared `surface-fold.ts`; `contextOccupancy`; `stateVersion` 3.
- Data flow: the meter read the newest provider-reported prompt size, which moves only when a request reports usage — and compaction reports none, because `compaction-basic` summarizes through a direct `ctx.llm.stream()` call and appends `compaction/start`, `compaction/summary`, the replacement `user/message` and `compaction/end`, with no `assistant/message` and no usage chunk; the measured before/after showed ring 4% and header `~4227/100000` on both sides while the composition rows dropped 93% (line 12).
- Non-obvious design decisions: `contextPressure` publishes a second numerator — the provider sample plus the heuristic repricing of everything the surface gained or lost since that sample, clamped at zero — and the fold stamps `sampledSurfaceTokens` when a usage sample lands **before** the same event joins the surface, so an `assistant/message` anchors against the surface its own request actually carried (line 23).
- Edge cases / failure handling: only the delta is estimated, so the anchor stays provider-exact and the estimator's systematic CJK and JSON-schema underpricing stays out of the occupancy figure; `contextOccupancy` falls back to the bare sample, so a projection restored from a pre-field checkpoint degrades to the old behaviour instead of vanishing; `sampledSurfaceTokens` assumes nothing joins the surface between a step's request and its usage report, and if that stops holding the error is bounded by one message and self-corrects at the next sample.
- Surprising: the change deliberately **reverses** the earlier decision's "the ring, header and bar length stay provider-exact" half — what it protected (not fabricating precision by scaling heuristic rows to a provider total) is preserved, because the rows stay unscaled and the header still does not equal their sum; what changed is the recognition that "provider-exact but describing a request two compactions ago" is not the more truthful figure; the cost is one more projection frame per surface event on the wire.

### .agents/notes/archived/bug-fix/2026-08-05-context-meter-blind-to-compaction.zh.md
- Chinese twin: translates the before/after measurement, the two-numerator design, the pre-join anchor stamping, the "reverses the earlier decision" framing, and the four rejected alternatives; all 33 code identifiers match the English side (the English side alone carries the `~used / capacity` literal).

### .agents/notes/archived/bug-fix/2026-08-05-turn-tail-actions-require-a-completed-turn.i18n.yaml
- Bilingual-pair record for the turn-tail actions note (`2c01f52f…` English / `b727c871…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-05-turn-tail-actions-require-a-completed-turn.md
- Purpose: why copy, branch and a clock appeared under an intermediate sentence, then shifted and vanished.
- Key abstractions: `assistantActionsSeqs`; `ConversationSnapshot.turnEnds`; `hasContentText` (moved to `chat-flow.ts`); `turnTimings`.
- Data flow: IconActions were derived from the finalized transcript alone — the last content-text assistant of each turn owned the row, a quantity that is stable only after the turn closes; while a turn is still producing steps, the narration a model writes before a tool call *is* the last content assistant so far, so it took the row for as long as the tool ran and then lost it; the fix grants the row only within a turn that has a `turn/end` in the window (line 16).
- Non-obvious design decisions: this is the *same completion fact* the branch control and the run-time label already use, so the three parts of one row now agree; and turn completion is read from the durable `turn/end` event rather than inferred from `running`, the streaming partial or in-flight tool calls.
- Edge cases / failure handling: every reason kind closes a turn, so an aborted turn's frozen tail keeps its footer and a crash-orphaned turn receives its `turn/end` from log repair on load; a turn whose `turn/end` is outside the loaded window grants nothing, which cannot arise from paging because a turn's end follows its own nodes.
- Surprising: an earlier version *did* infer completion from `running` plus the streaming partial or first in-flight tool call, and it was dropped — it needed a special case so a turn accepted before its first step did not strip the previous answer's seat, and it is exactly the inference the completed-turn-tail decision had rejected for the branch control; `hasContentText` moving to `chat-flow.ts` exists so the ownership gate and the mount gate cannot drift apart.

### .agents/notes/archived/bug-fix/2026-08-05-turn-tail-actions-require-a-completed-turn.zh.md
- Chinese twin: translates the mid-turn ownership defect, the `turn/end`-gated grant, the dropped inference-based variant, the four rejected alternatives, and the `chat-flow.ts` co-location; all 12 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-05-workspace-blank-session-reuse-membership.i18n.yaml
- Bilingual-pair record for the blank-session membership note (`bbc362da…` English / `b84c892f…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-05-workspace-blank-session-reuse-membership.md
- Purpose: why "New Session" opened a session the sidebar showed under Ungrouped.
- Key abstractions: `connectWorkspace`'s blank-session reuse scan; `workspace.sessionIds`; `summary.cwd`; `session.create({ workspaceId })`; `defaults.cwd = process.cwd()`.
- Data flow: the host's own membership rule requires **both** an id in the Workspace account (`sessionIds`) **and** a session header whose canonical cwd equals the Workspace path, but the reuse scan ignored the account slot and matched on cwd alone — so any live blank session whose cwd matched qualified, including the `main-session-*` sessions the CLI/TUI/headless entry points birth at the host cwd (line 12).
- Non-obvious design decisions: the fix makes the reuse scan require `blank` AND `summary.cwd === workspace.path` AND `workspace.sessionIds.includes(summary.id)` AND not archived; a cwd-only match falls through to `session.create({ workspaceId })`, the same arm the flow already used for "no blank session exists".
- Edge cases / failure handling: adopting the stray instead of minting was rejected — silently attaching CLI-born sessions to a Workspace crosses the account boundary by surprise, and the client cannot distinguish "stray" from "the Workspace's own blank" without the membership view, which is the fix itself; one observable stale-mirror edge remains, where a duplicate blank is minted instead of the old failure shape.
- Surprising: the defect was specific to Workspaces registered at the directory the CLI runs from, because that is the only path where unaccounted blank sessions accumulate — one per CLI run — and the host-cwd Workspace accumulated one per run while other paths were unaffected.

### .agents/notes/archived/bug-fix/2026-08-05-workspace-blank-session-reuse-membership.zh.md
- Chinese twin: translates the two-part membership rule, the stray-session adoption rejection, the four-outcome test list, and the stale-mirror edge; all 16 code identifiers match the English side (the English side alone carries the `New Session` literal).

### .agents/notes/archived/bug-fix/2026-08-06-api-key-format-validation.i18n.yaml
- Bilingual-pair record for the API-key note (`d3524d47…` English / `8844fd08…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-06-api-key-format-validation.md
- Purpose: why an API key containing an emoji saved successfully and failed only at request time.
- Key abstractions: `normalizeApiKey` (a module of the `dsh-llm` Service Definition beside `attribution.ts`); `assertUsableApiKey(raw, pkg, ref)`; `INVALID_CREDENTIAL_CODE`; `namesCredential`; `routeAuth`; the client mirror `packages/client/ui-settings-models/src/apiKey.ts`.
- Data flow: a key with characters no HTTP header value can carry was accepted by every configuration surface; the rule is one predicate — after trimming, non-empty, and every character within `[\x21-\x7E]` (printable ASCII, space excluded) — which is exactly the constraint that produced the ByteString failure, so the failures share one definition rather than two coincidentally related fixes (line 20).
- Non-obvious design decisions: **invariants belong at every layer, heuristics belong where the human is** — the charset rule is enforced in the browser, in each resolver and on every credential read because a non-ASCII character cannot travel in a header value for any provider, while the *shape* rule (matching `^[A-Z][A-Z0-9_]*=[^=]` or a wrapped quoted line) runs **only in the browser**, because `llm-pi-ai` fronts OpenAI, Anthropic and arbitrary hand-declared gateways whose key formats this repository does not own, and a resolver-level rule would lock a user out with no escape (line 30).
- Edge cases / failure handling: "absence is a configuration state, not a missing key" — a pi-ai profile omitting `apiKeyEnv` may authenticate outside the harness-held path (`routeAuth` keeps the installed catalog provider's own auth so ambient discovery and `openai-codex`'s OAuth survive), and a blank field in the web UI means *keep what is stored*, so `ProviderEditor` skips `credentials.set` entirely; therefore `normalizeApiKey` takes `string`, never `string | undefined`.
- Surprising: `llm-deepseek` mislabelled the ByteString failure `TRANSPORT` because `fetch` builds the `Bearer` header inside the `try`, and `TRANSPORT` is in `DEFAULT_RETRYABLE_CODES` — so a permanent deterministic fault was retried three times; and `INVALID_CREDENTIAL` is deliberately outside that set. The note also explains why a *save-time* provider probe was rejected as unbuildable: `discoverModels` short-circuits to the installed catalog before any network call for exactly the providers pi-ai ships catalogs for, so it verified nothing about the key, and the DeepSeek card has no probe at all.

### .agents/notes/archived/bug-fix/2026-08-06-api-key-format-validation.zh.md
- Chinese twin: translates the single charset predicate, the "invariants everywhere / heuristics only in the browser" split, the four-surface behaviour table, the "absence is a state" analysis, the six rejected alternatives, and the headless end-state assertion; all 68 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-06-bwrap-private-pid-namespace.i18n.yaml
- Bilingual-pair record for the bwrap PID-namespace note (`eb5818a9…` English / `396ee74b…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-06-bwrap-private-pid-namespace.md
- Purpose: why a bwrap-confined command could follow procfs magic links into a host process's mount view.
- Key abstractions: `--unshare-pid`; the profile builder shared by the functional probe and real wraps; the Landlock fallback ladder.
- Data flow: the bwrap backend mounted a fresh `/proc` while retaining the host PID namespace, so a confined command could see host processes and follow `/proc/<pid>/root`, `/proc/<pid>/fd` or `/proc/<pid>/cwd` into a host process's mount view and escape the profile's read-only host-root bind and `workspace-write` allow-list; every bwrap profile now uses `--unshare-pid` and mounts `/proc` for that private namespace, so the confined command can observe and control its own descendants while host processes and their magic links are absent (line 16).
- Non-obvious design decisions: the functional bwrap probe uses the *same profile builder* as real wraps, so a host that cannot create the PID namespace rejects bwrap during selection and falls back to Landlock instead of accepting a weaker probe and failing later; and this is a bwrap backend invariant, not a new `SandboxMode` promise — Landlock and Seatbelt continue to leave process visibility unchanged, and no backend restricts network access.
- Edge cases / failure handling: bubblewrap supplies the namespace's PID 1 to reap descendants; masking selected procfs links was rejected because per-process entries are dynamic and covering only `root` leaves equivalent crossings through `fd`, `cwd`, `exe` and future magic links; relying on ptrace and procfs ownership checks was rejected as deployment-dependent defence in depth rather than the profile's authority.
- Surprising: the original sandbox decision *deliberately* left process visibility unchanged because `SandboxMode` promises file effects rather than general process isolation — but procfs magic links make host process visibility part of the file-effect boundary for bwrap, so that choice could not preserve the promised modes; the real-bwrap tests verify a write through `/proc/1/root` is rejected while the command can still observe, terminate and wait for its own descendant.

### .agents/notes/archived/bug-fix/2026-08-06-bwrap-private-pid-namespace.zh.md
- Chinese twin: translates the procfs-magic-link escape, the `--unshare-pid` decision, the shared-probe-builder argument, the three rejected alternatives, and the "not a new `SandboxMode` promise" scoping; all 13 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-06-host-backed-web-preferences.i18n.yaml
- Bilingual-pair record for the host-backed preferences note (`fcbcb040…` English / `45ece0f9…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-06-host-backed-web-preferences.md
- Purpose: why reopening `dsh web` on another port lost the user's appearance, language and busy-Enter choices.
- Key abstractions: the Host Config schemas' volatile locale/theme/busy-Enter preferences; `ConfigEditor`; `dsh-client-ui-settings`'s settings describe mirror; `ctx.configForms.get(entryId)`; `ctx.settingsSchema`; the per-entry write queue.
- Data flow: browser storage is scoped to an origin, so a different port is a different partition even with the same DSH home; the owning Host Config schemas now declare the volatile preferences, `ConfigEditor` stores explicit choices in the active profile patch, and the authenticated settings API projects those Config fields and redacts secret roles (line 16).
- Non-obvious design decisions: the mirror installs its `settings/document-updated` and `connection/reset` listeners **before** starting its background read, so no settings transport can block plugin activation and an invalidation cannot fall into a read-before-subscribe gap; domain services take the namespace scope as an ordinary constructor collaborator, publish their provisional defaults immediately (browser-derived locale, system theme, Queue) and then adopt an accepted Host section **without writing it back**.
- Edge cases / failure handling: a service constructed without a scope (standalone dictionary or policy fixtures) simply stays process-local; the provider owns one write queue per entry, and its disposal skips queued work, suppresses late publication and waits for the in-flight operation; the Client keeps Host persistence disabled on non-loopback pages.
- Surprising: the per-field preference controller with paired sync/persist callbacks was rejected because the mutual callbacks forced two-phase construction — a defaulted no-op writer later replaced via `bindPersistence` — and every additional field of a namespace would have carried its own controller and whole-document read; and awaiting the initial read was rejected because *configuration availability is not a prerequisite for drawing the page*, so a background read may cause one live convergence but keeps failure isolated.

### .agents/notes/archived/bug-fix/2026-08-06-host-backed-web-preferences.zh.md
- Chinese twin: translates the origin-scoping defect, the listener-before-read ordering, the namespace-scope collaborator model, the six rejected alternatives, and the two-host-two-ports verification scenario; all 11 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-06-list-agents-residency-vocabulary.i18n.yaml
- Bilingual-pair record for the list-agents vocabulary note (`d174bcbf…` English / `37b5b1f3…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-06-list-agents-residency-vocabulary.md
- Purpose: why a model reading `complete` looked for a result that did not exist.
- Key abstractions: `SubagentListEntry.activity` (`'running' | 'inactive'`); the model-facing adapter's `ready` mapping; the `list_agents` output schema's `status` enum.
- Data flow: `list_agents` projected a continuable child's process residency as `running | idle | complete`; `complete` reads as a terminal unit of work with a result somewhere, but the underlying fact says only that no Activation is resident — the conversation is intact and `send_message` can continue it; the model-facing projection now reports `running | idle | ready`, where `ready` means only the durable conversation remains and the status is resumable rather than terminal (line 20).
- Non-obvious design decisions: the service layer is unchanged — `SubagentListEntry.activity` retains `'running' | 'inactive'`, which accurately describes corpus residency for UI consumers, and only the model-facing adapter maps `inactive` to `ready`; the tool description states the distinctions and directs the model away from polling, saying the parent is told when a child finishes and that listing is for recalling which children it started.
- Edge cases / failure handling: `send_message` remains the authoritative delivery check because either snapshot may race another process or a later message; the rendered line reads `<id> [ready] — <label>`.
- Surprising: keeping `complete` and qualifying it in the description was rejected because "a description saying that `complete` does not mean complete fights the rendered status on every read" — *the line the model scans must carry the correct distinction itself*; and `active | dormant` was rejected because it removes the useful distinction between a resident Agent between turns and a storage-only conversation, and makes the storage-only state sound unavailable.

### .agents/notes/archived/bug-fix/2026-08-06-list-agents-residency-vocabulary.zh.md
- Chinese twin: translates the `complete` → `ready` vocabulary change, the service-layer/mode-facing split, the four rejected alternatives, and the "the scanned line must carry the distinction" argument; all 19 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-06-onboarding-step-owned-takeover-chrome.i18n.yaml
- Bilingual-pair record for the onboarding chrome note (`f573f72a…` English / `14af4505…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-06-onboarding-step-owned-takeover-chrome.md
- Purpose: why the app flashed white on every reload.
- Key abstractions: the new zero-cordis primitive `OnboardingSurface` (ui-primitives); the `settings.onboarding` slot contract; `SettingsRoot`'s coordinator; `#root` inert.
- Data flow: the settings shell mounted the takeover chrome — a body-portaled overlay, a blur mask and `#root` set inert — the moment a `settings.onboarding` step was *registered* and not yet locally completed; every step decides whether it actually needs to show by loading a private fact first and renders `null` while that fact is in flight, and rendering `null` could not suppress the chrome, because the opaque stage was painted by the shell around the slot outlet, not by the step (line 10).
- Non-obvious design decisions: the takeover chrome belongs to the step, not the shell — `OnboardingSurface` renders the portal/mask/stage (CSS class names and geometry moved verbatim from `SettingsRoot.module.css`) and holds `#root` inert for exactly its own mount lifetime, and both step components wrap only their **visible** branch in it, so their `null` branches now paint and block nothing *by construction*.
- Edge cases / failure handling: `SettingsRoot` keeps the coordinator exactly as it was but renders the elected step bare; the slot contract JSDoc now states that registrants own the surface wrap and must render `null` while their private facts are undecided.
- Surprising: the trade is explicit — for a genuinely unconfigured user the takeover now appears one join round-trip *later* than before, but with its content already present, instead of an empty stage that fills in; and detecting empty slot output at the render site was rejected because `renderSlot` returns an outlet element unconditionally, so probing rendered DOM emptiness needs a commit-then-retract dance whose dynamic transitions lose the pre-paint guarantee.

### .agents/notes/archived/bug-fix/2026-08-06-onboarding-step-owned-takeover-chrome.zh.md
- Chinese twin: translates the shell-vs-step chrome ownership problem, the `OnboardingSurface` primitive, the three rejected alternatives, and the held-network-boundary regression with its 8 ms in-page sampler; all 19 code identifiers match the English side (the English side alone carries the `inert` token).

### .agents/notes/archived/bug-fix/2026-08-06-plan-narrow-viewport-regression.i18n.yaml
- Bilingual-pair record for the plan-chip note (`c42a110b…` English / `3df4f8ac…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-06-plan-narrow-viewport-regression.md
- Purpose: reproducing dsh-external/issues#107, where the model selector covered the plan control's click area at 800×720.
- Key abstractions: the composer control row's `display: flex; justify-content: space-between` with `.trailing { flex: none }`; `.row { flex-wrap: wrap }` + `.trailing { margin-left: auto }`; the `commands.execute` channel; the host-plane e2e TypeScript pairing (excluded from `apps/web/tsconfig.json`, included in `tsconfig.host.json`).
- Data flow: when the combined control width exceeds the card, the shrinking `.tools` group keeps its flow children inside its `min-width: 0` box, so the chip — the last flow child before the overflow — is painted over the trailing group; the measured overlap at 800×720 was 36.9px and the chip's centre hit-tested to the trigger's label; the fix wraps the row instead of shrinking the left group into the right group's area (line 12).
- Non-obvious design decisions: wrapping is the acceptance's own "wrap, fold, or re-arrange controls when space runs out" option, keeps every control at full width (no label folding that would hide the model name or the Plan wordmark), and holds at every viewport width by construction rather than at a calibrated container-query threshold; the test enters plan mode with the real `/plan` command and no argument, so it needs no model call in any mode and no API key in replay/refresh.
- Edge cases / failure handling: the geometry golden records stable facts — viewport membership on both axes and disjoint click areas — never absolute coordinates, whose pixel values depend on installed fonts and differ between macOS and Linux.
- Surprising: container-query label folding was rejected *for the fix* because two packages would need calibrated thresholds and the chip's own icon-only fold still leaves ~7px of overlap at the reported viewport unless the trigger folds too; and the file joins the host-plane e2e pairing like every sibling, so exactly one TypeScript program owns it.

### .agents/notes/archived/bug-fix/2026-08-06-plan-narrow-viewport-regression.zh.md
- Chinese twin: translates the 36.9px overlap measurement, the wrap-not-fold fix, the four rejected alternatives, and the host-plane program pairing; all 19 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-06-provider-credential-lifecycle.i18n.yaml
- Bilingual-pair record for the provider-credential note (`dfb1f975…` English / `9166a914…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-06-provider-credential-lifecycle.md
- Purpose: why a Models-page credential failure was unrecoverable, and why deleting a provider left its key in `.env`.
- Key abstractions: the two-stage settings-then-credentials operation; the redacted descriptor returned by the settings stage; the joined row identifying the exact `<ROUTE>_API_KEY` reference; the `Display Name (route-id)` identity string.
- Data flow: the card committed provider settings before storing the API key but kept the revision and original subtree from when the card opened, so a credential-write failure made retry replay the already-committed settings mutation with a stale revision and produce a conflict; the card now treats the successful settings response as a *commit checkpoint* — it replaces its comparison subtree and expected revision with the returned redacted descriptor before attempting `credentials.set`, so a second-stage failure leaves the draft key and card visible and retry produces no settings ops and repeats only the credential write (line 14).
- Non-obvious design decisions: deletion removes a credential only when the joined row identifies the exact reference derived by this page *and* reports it configured and writable, and it unsets that credential **before** the user-layer profile, so a settings-stage failure leaves the row and its frozen target visible for retry; a cross-domain transaction RPC was rejected because settings and credentials have separate owning services and durable stores.
- Edge cases / failure handling: custom references, environment credentials, missing credentials and targets the join cannot identify are retained; both unsets are idempotent; rows expose API-key state only from the value-free join (green solid dot for a confirmed referenced credential, red for a confirmed missing named reference, no dot for reference-free provider-native auth or unavailable enrichment); save and delete are still not atomic across durable stores, but their order and idempotence leave an observable, retryable state.
- Surprising: a blank pi-ai key previously wrote the derived `apiKeyEnv` without a credential, which prevented pi-ai from using provider-native discovery — now a blank key materializes an empty, reference-free profile, preserving Bedrock, Vertex and other provider-native authentication; and the note records that the *inverse* leak at deletion (profile gone, page-stored key still in `.env`) had been left in place.

### .agents/notes/archived/bug-fix/2026-08-06-provider-credential-lifecycle.zh.md
- Chinese twin: translates the commit-checkpoint save design, the narrow credential-ownership rule for deletion, the value-free status dots, the three rejected alternatives, and the "still not atomic, but retryable" consequence; all 8 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-06-reader-scroll-attribution-observed-top-ledger.i18n.yaml
- Bilingual-pair record for the reader-scroll note (`8021eecf…` English / `f19190f4…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-06-reader-scroll-attribution-observed-top-ledger.md
- Purpose: why touch panning, native-scrollbar dragging and keyboard paging could not leave the bottom of a streaming transcript.
- Key abstractions: ChatView's observed-top ledger (`observedTopRef`); `FOLLOW_THRESHOLD`; the `scroll` event as the only listener.
- Data flow: bottom-follow recognized only wheel/trackpad gestures, so a scroll event without matching wheel movement was treated as programmatic and snapped back; the fix records the last `scrollTop` either delivered on the main thread or written by the component, synchronously at every programmatic write site — bottom follow, open restore, prepend anchoring, resize follow, and scroll delivery itself — and treats a position deviating from `min(ledger, floor)` by more than half a pixel as reader input, while a position on the ledger (a delayed programmatic delivery) or exactly on the shrunken floor (a browser clamp after content shrank) preserves the current ownership state (line 14).
- Non-obvious design decisions: the wheel listener and its epoch bookkeeping are *deleted*, so the component listens to `scroll` alone and wheel, touch, scrollbar, keyboard and any future input source are covered by one rule; enumerating input devices was rejected because native-scrollbar dragging exposes no input event to latch before its scrolls arrive and every listener would need its own compositor-delivery grace window — the input state machine the earlier note had already declined to build.
- Edge cases / failure handling: a shrink clamp whose layout regrows inside the same rendering update before the clamp's scroll event is delivered is geometrically indistinguishable from reader input, so it now reads as the reader and releases follow (recoverable via "Back to bottom"); real React-commit-driven shrink and regrow is still absorbed, because the layout-effect follow re-pins and re-records the ledger per commit.
- Surprising: absorbing that coalesced clamp with grace windows was rejected because streaming rewrites the floor at chunk pace (24 ms) against ~16 ms frames — any grace window either swallows genuine touch input during streaming or is too short to cover the race it targets, so the mis-attribution is accepted and made recoverable instead; and the note records that the e2e lane's Chromium cannot synthesize any non-wheel device scrolling, so keyboard carries the real-input-pipeline proof and the fling scenario replays touch's signature through the scrollport directly.

### .agents/notes/archived/bug-fix/2026-08-06-reader-scroll-attribution-observed-top-ledger.zh.md
- Chinese twin: translates the observed-top ledger rule, the half-pixel deviation threshold, the accepted coalesced-clamp contract change, the four rejected alternatives, and the "Chromium cannot synthesise non-wheel scrolling" limit; all 15 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-06-token-surface-unpriced-replace-compatibility.i18n.yaml
- Bilingual-pair record for the token-surface note (`9522758c…` English / `94d7edb0…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-06-token-surface-unpriced-replace-compatibility.md
- Purpose: why a session recorded before the shadow-price protocol could never be opened again.
- Key abstractions: `contextPressure` and `contextBreakdown` (both O(1) over a session's life); the `compaction/summary` / `compaction/prune` metering event and its `shadowedTokenCount`; `foldSurfaceProjection`.
- Data flow: the projections keep a running surface-token total plus at most one pending shadow-price claim; current replace producers append a metering event immediately before the replacement, and the fold turns `shadowedTokenCount` into the signed delta — but sessions recorded before that protocol log replacements with no adjacent metering event, and the O(1) state cannot reconstruct the replaced range's price, so the fold treated every unpriced replacement as a contract violation and threw, leaving the session permanently unopenable at its first replacement (line 12).
- Non-obvious design decisions: a replace with no armed claim folds **price-neutrally** — `deltaTokens: 0`, pricing the replaced range as if it had cost exactly what its replacement costs — and a claim expired by an intervening event reaches the same neutral path, since the fold cannot distinguish it from a log that never metered; but an armed claim naming a **different** range still throws, because there the metering event was adjacent and the producer wrote contradictory adjacent events (line 18).
- Edge cases / failure handling: both projections share the one fold, so neither gains state fields nor bumps its `stateVersion`; `surface-fold.ts` and `ctx.tokenMeter.measure()` are unaffected because they hold the per-node priced surface and never needed the claim protocol.
- Surprising: the neutral fold means the compacted-away span stays *counted*, so `contextBreakdown.messageTokens` retains the overcount and `contextPressure.projectedTokens` overestimates occupancy until the next usage sample re-anchors it — but overestimating occupancy can only trigger an *earlier* compaction, which is the safe direction; persisting the full priced surface was rejected because it grows the checkpoint by one node per model-visible message without bound, defeating the O(1) constraint the shadow-price protocol exists to preserve.

### .agents/notes/archived/bug-fix/2026-08-06-token-surface-unpriced-replace-compatibility.zh.md
- Chinese twin: translates the neutral fold, the mismatched-claim throw, the two rejected alternatives, and the "overestimate triggers earlier compaction" safety argument; all 15 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-07-cancel-convergence-wake-latch.i18n.yaml
- Bilingual-pair record for the cancel-convergence note (`ad42de04…` English / `2c2973ff…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-07-cancel-convergence-wake-latch.md
- Purpose: why a message sent during a cancellation's convergence window stayed parked until another wake arrived.
- Key abstractions: the `running` phase's `wakeRequested` latch (mirroring the existing `maintenance` phase field); `wakeDriver()`; `kick`'s and `runMaintenance`'s `finally` blocks; `inbox.hasPending`; `signal.aborted`.
- Data flow: `Agent.cancel(cause, { keepInbox: true })` returns immediately after firing the abort signal, but the active driver may not have converged to `idle` yet — LLM stream teardown, tool cancellation and the `turn/end` append all unwind asynchronously; a waking send arriving in that window was placed into `next-turn` while `wakeDriver()` returned early on the still-`running` phase, and the exiting driver never replayed the wake (line 10).
- Non-obvious design decisions: the latch is armed only when the current activity *cannot* deliver the wake — a maintenance task never reads the queue and an aborted activity converges without restarting — while a live driver needs no latch because it claims queued work itself; the replay lives in the old driver's `finally`, which guarantees `turn/end N` lands before the replayed driver opens `turn/start N+1` and that `whenIdle()` sees the replayed driver through its `activityDone` loop (line 14).
- Edge cases / failure handling: the replay sites run only while `inbox.hasPending`, so a latched wake removed from the inbox before convergence does not start an empty driver; a `disposed` cancel never latches; and the `signal.aborted` discriminator is load-bearing, separating pre-abort queued work (which `keepInbox` parks) from post-abort explicit wakes (which must run after convergence).
- Surprising: the "idle → running → idle" transition is an *observable contract* — a wake sent while the agent is already idle keeps its turn boundary even when its message is cleared before the driver claims it, and the goal-round-driver's pause/disarm fallback fires on that `idle` transition, so moving the guard into `wakeDriver()` would suppress the boundary; and setting the phase to `idle` immediately in `cancel()` was rejected because it overlaps two drivers, failing 14 of 83 tests with several deadlocks.

### .agents/notes/archived/bug-fix/2026-08-07-cancel-convergence-wake-latch.zh.md
- Chinese twin: translates the `wakeRequested` latch, the "only when the activity cannot deliver" rule, the `finally`-placement guarantee, the four rejected alternatives, and the named sub-microtask gap deliberately left open; all 27 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-07-ptc-executor-collapse.i18n.yaml
- Bilingual-pair record for the PTC executor note (`de804762…` English / `a8bc6b1f…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-07-ptc-executor-collapse.md
- Purpose: why `mode: 'ptc'` announced one tool but still executed any native tool the model named.
- Key abstractions: `ToolRuntime.resolveExecution(name, scope, nested)`; `collapses(name, nested)`; `modeFor(scope)`; `createExecution` (the first stage of `prepare`); `wireSchemas()` vs `get()`/`schemas()`; the `parent` token.
- Data flow: `wireSchemas()` sent the model exactly one tool — `run_code` — but the executor resolved every call through `get()`, which returns the full visible map plus the reserved transport, so a model that emitted a native tool name bypassed `run_code` entirely and the call executed; the fix applies the mode collapse at the operation boundary that owns it, so under `ptc` a model-direct call may only name the reserved transport and every native name resolves to `undefined` and surfaces as the executor's existing `UNKNOWN_TOOL` error (line 16).
- Non-obvious design decisions: the package contract names the anti-pattern explicitly — "schema omission is not enforcement when a direct caller can bypass it; denial must be tested through the executor" (line 12); a collapsed call terminates at `createExecution`, *before* the extensible policy pipeline, so `tools/pre-execute` listeners, approval `ask` and guards never observe a call that is deterministically denied, and a human is never prompted to approve it; and the public registry view (`get`) and SDK projection (`schemas`) keep their semantics, because presentation, inspection and binding enumeration must still see the full visible set.
- Edge cases / failure handling: an already-aborted caller signal keeps the cancellation contract (`ABORTED_BEFORE_DISPATCH`) with the visible tool's finalizer applied; a collapsed call with non-JSON-serializable arguments reports the parameter `TypeError` (the invalid-args contract) rather than `UNKNOWN_TOOL`, and the body still never runs and policy still does not; a nested sub-dispatch (`nested = true` — a `parent` token set, which only the `run_code` SDK binding sets in production code) may call any visible tool.
- Surprising: the prompt must *state* the collapse in a `tools:ptc-only` section ordered ahead of first-party per-tool guidance, because those sections name their tool without qualifying how it is reached — a model that read only them emitted a native call, received `UNKNOWN_TOOL` for a tool the same prompt had declared, and concluded the deployment was inconsistent rather than correcting itself; and the TypeScript SDK section emits a complete `run_code` call around `tools.bash(...)` when the current `bash` parameter schema accepts the example arguments, because the declaration list can otherwise be read as native tool availability.

### .agents/notes/archived/bug-fix/2026-08-07-ptc-executor-collapse.zh.md
- Chinese twin: translates the executor-boundary enforcement, the "denial must be tested through the executor" contract, the four rejected alternatives, the prompt-statement requirement, and the SDK section's worked `run_code` example; all 45 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-09-broken-preset-roster-rows.i18n.yaml
- Bilingual-pair record for the broken-preset note (`ba69a510…` English / `48b73437…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-09-broken-preset-roster-rows.md
- Purpose: why a hand-edited preset could break silently and a deleted one left an unremovable ghost.
- Key abstractions: `scanRoot`; the loader's own `entryListSchema` (the `!!js` dialect); `PRESET_ID` (moved to `types.ts`); `AgentPreset`; the `agentPreset.list` wire entry; `resolveMountable`; `presetOptions`.
- Data flow: a preset whose `agent.cordis.yml` no longer parsed listed as a perfectly ordinary row — selectable, copyable, settable as the default — and failed only when the next session mounted it; a directory whose composition file was deleted vanished from the roster while still occupying its id on disk, so `copy` refused the name with "delete the existing preset first" and `remove` answered "not found"; discovery now treats every directory whose name is a usable preset id as a preset slot, and a damaged one becomes a roster row carrying a `broken` reason (line 14).
- Non-obvious design decisions: the shape check parses with the *loader's own* schema, so health can never call broken what the loader would accept; directories whose names fail `PRESET_ID` are skipped outright, because no copy could ever collide with them; and the surfaces split by their job — the management section renders broken rows as marked cards (red border, Broken badge, verbatim reason, body and duplicate disabled) while both pickers drop broken presets entirely via `presetOptions`, because they choose the *next* session's composition and offering one that cannot compose only defers the failure.
- Edge cases / failure handling: `mount`/`recompose`/`standingKeyFor` refuse a broken preset up front with the discovery-reported reason, while `resolve` still answers (delete/read/report need the row); the reason is one line, because js-yaml appends a multi-line code-frame snippet and the roster card is not a terminal; a default that later breaks still fails the session start loudly, because nothing rewrites a stored default.
- Surprising: `copy`'s roster check now sees ghosts, which turns the "already exists" refusal *actionable* — the broken card to delete is on the same page; and health runs on every `list()` (one read+parse per preset per roster read), accepted for the same reason unmemoized discovery was: rosters are small and freshness is the contract.

### .agents/notes/archived/bug-fix/2026-08-09-broken-preset-roster-rows.zh.md
- Chinese twin: translates the two failure shapes, the broken-row-as-default decision, the surface split, the load-bearing details, the alternatives, and the "the freed id is immediately claimable" consequence; all 25 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-09-filesystem-absence-observation.i18n.yaml
- Bilingual-pair record for the filesystem-absence note (`6fb2ec19…` English / `3a0f2f48…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-09-filesystem-absence-observation.md
- Purpose: why a file deleted by an external command left the model in an unrecoverable retry loop.
- Key abstractions: the `dsh-fs` observation union `{ kind: 'present', version: FsVersion } | { kind: 'absent' }`; `dsh-fs-observation-policy`'s three logical states; `str_replace_editor`'s `view`/`str_replace`/`insert`; `dsh-fs-local`'s hard-link publication; `dsh-fs-e2b`'s remote `ln -T`.
- Data flow: the event-gated policy recorded only successful reads and mutations as a target version, so an external delete left the old positive version forever — write kept choosing `replaceIfVersion`, the provider kept rejecting the missing target, and the model-facing "re-read the file, then retry" instruction became an unrecoverable loop; a metadata miss from `read` or the editor commands now emits an *absent* observation synchronously before returning `FS_NOT_FOUND` (line 16).
- Non-obvious design decisions: the policy stores three logical states per owner and target *without injecting or calling `ctx.fs`* — missing map entry is unseen, `absent` is confirmed absence, `present(version)` is a replacement/edit basis — so write maps unseen and absent to `createIfAbsent` and present to `replaceIfVersion`, while edit maps unseen to `FS_NOT_OBSERVED`, absent to `FS_NOT_FOUND` and present to its version guard.
- Edge cases / failure handling: every provider must enforce `createIfAbsent` **at the publication point**, not only at its initial probe — `dsh-fs-local` stages and fsyncs in a private sibling directory, then hard-links the staged file to the destination, and after a failed link inspects the destination entry so a regular-file collision returns `FS_NOT_OBSERVED`, a non-regular entry returns `FS_NOT_REGULAR_FILE`, and a failure against a still-missing target returns `FS_IO_ERROR`; other read failures do not manufacture absence.
- Surprising: the decision explicitly does *not* claim cross-process linearizability for `replaceIfVersion` — the narrower guarantee is exact and sufficient for absence recovery: guarded creation never clobbers a target that appears before publication; and deleting the cached version on a not-found read was rejected because it conflates unseen with confirmed absence and cannot give edit the correct `FS_NOT_FOUND` result.

### .agents/notes/archived/bug-fix/2026-08-09-filesystem-absence-observation.zh.md
- Chinese twin: translates the absence-observation union, the three-state policy mapping, the hard-link publication, the four rejected alternatives, and the explicitly narrowed cross-process guarantee; all 23 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-10-child-agents-join-their-parent-preset.i18n.yaml
- Bilingual-pair record for the child-agent preset note (`cae95345…` English / `e93f42c8…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-10-child-agents-join-their-parent-preset.md
- Purpose: why a one-shot child agent reached the model with zero tools.
- Key abstractions: `AgentPresets.composeFrom(agentCtx, parentCtx)`; `standingMountFor()`; `applyChildComposition(childCtx, parent, composition)`; `AgentPresets.composedPreset()`; `ToolRuntime.view()` / `restrict()`; `dsh-scope`'s parent chain.
- Data flow: tool and prompt-section visibility is inherited along the scope's parent chain, but the two in-process subagent drivers composed their children through `applyChildComposition()`, which installed only the per-child persona and tool filter — so a child's scope chain had length one and its registry view resolved the global layer alone, which is empty in any deployment with a preset roster (the web-app patch layer disables every host-plane tool row); the fix joins one agent to the standing composition another already runs on, binding the child's key to the parent's standing key (line 18).
- Non-obvious design decisions: this is a **bind, not a mount** — the child gets the parent's exact generation, so a composition file edited since the parent started cannot hand the child a different one, and a preset deleted since cannot fail a child whose parent keeps running; it is also synchronous, which is what lets the child creation windows use it; and `applyChildComposition` *takes the parent*, which makes composing a child without the join unrepresentable at the call sites (line 22).
- Edge cases / failure handling: a parent that joined no preset yields no join and no error — that is the rosterless deployment, where the child's rows sit in the host composition; `childSessionMeta()` records the joined id through `composedPreset()`, read from the parent's *live* scope chain rather than its header, because a parent that switched preset while blank runs on the newer composition while its header still names the older one.
- Surprising: giving the child its parent's tools exposed a second defect from the same move — `ToolRuntime` exempted *scoped* registrations from a restriction and filtered only the global layer, so once every model-facing row became an ancestor contribution a child's `toolFilter` stopped constraining anything, and with the global layer empty `restrict()` rejected every name as unknown and failed the child outright; the exempt set is "the tools a scope registers *itself*", and the own-layer exemption is load-bearing because the delegation runtime registers a child's structured-output tool into the child's own layer.

### .agents/notes/archived/bug-fix/2026-08-10-child-agents-join-their-parent-preset.zh.md
- Chinese twin: translates the bind-not-mount distinction, the parent-taking parameter, the `ToolRuntime` exemption-set correction, the six rejected alternatives, and the assembled-e2e-versus-snapshot distinction; all 28 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-10-minimal-preset-owns-rl-composition.i18n.yaml
- Bilingual-pair record for the minimal-preset note (`fd901f37…` English / `7e725428…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-10-minimal-preset-owns-rl-composition.md
- Purpose: why the shipped Web configuration had two owners for one agent contract.
- Key abstractions: the per-session `minimal` preset; the process-wide `core-web.cordis.yml` patch; the entry-local `pty` realm; the `complete: true` `PromptSection`; the `system-prompt/assemble` waterfall; the `sdk-minimal` bundle.
- Data flow: once per-session agent presets became the agent-composition boundary, the preset's scoped `deployment:persona` shadowed the overlay's corrected global persona with stale coding-agent text, and the preset mounted one-shot Bash rather than the persistent Bash the RL harness uses; the shipped Web `minimal` preset is now the sole Web owner of the RL composition, declaring an entry-local PTY registry and local backend, persistent `bash` with the RL environment description and 300-second timeout, and `str_replace_editor` (line 16).
- Non-obvious design decisions: the final prompt constraint lives at the *registry that assembles the prompt* — after the `system-prompt/assemble` waterfall the prompt registry restores a detached copy of the complete section as the sole system-prompt section and discards every dynamic context contribution, and multiple effective complete sections reject assembly; disabling every known prompt contributor was rejected because host rows are process-wide and new contributors would reopen the prompt (line 18).
- Edge cases / failure handling: the preset persona is exactly `You are a helpful software engineer assistant.` and suppresses runtime context for its agent scope; a complete `PromptSection` still participates in ordinary assembly so tools, variables and cooperative listeners still resolve; the process-wide patch is absent, and browser UI, workspace attachment, persistence, subprocess, sandbox, permission and model routing remain host-owned.
- Surprising: the fix was to remove the process-wide patch rather than keep it as a compatibility layer, because a process patch and a session preset are two independent owners for one agent contract and precedence makes either one capable of silently undoing the other; and a prepended waterfall listener was rejected as enforcement because *another* prepended wrapper can run outside it and append after the filter.

### .agents/notes/archived/bug-fix/2026-08-10-minimal-preset-owns-rl-composition.zh.md
- Chinese twin: translates the single-owner decision, the final registry constraint, the four rejected alternatives, and the "does not support Windows agents" consequence; all 14 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-10-pre-plugin-theme-bootstrap.i18n.yaml
- Bilingual-pair record for the theme-bootstrap note (`f3b09ed7…` English / `76ae6812…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-10-pre-plugin-theme-bootstrap.md
- Purpose: why a persisted dark preference still flashed light on the loading page.
- Key abstractions: ui-theme's host half; the `webserver/index-inject` collection and `bootThemeInjection`; the `ui-theme.preference` settings section; `document.documentElement.style.colorScheme` and `body[data-ds-dark-theme]`.
- Data flow: ui-theme's token styles arrive with its dynamic client bundle, so the framework-free loading page uses a private light/dark fallback palette; the host half now answers every `webserver/index-inject` collection with one body-placed script row, which `renderIndex` renders as a synchronous inline script immediately after the opening `<body>` tag — by which point the body exists but the shell's module script and the boot page have not yet run (line 16).
- Non-obvious design decisions: `dshClient.immediately` only includes the bundle in first-stage prefetching and cannot make the plugin execute before HTML parsing, so the fix is an inline script at the earliest parse position that can write the final DOM fields directly; the script embeds the schema-validated built-in preference (or the `system` default), resolves `system` through `prefers-color-scheme`, and writes only the two pieces of DOM state that ThemePresenter later owns.
- Edge cases / failure handling: the subscription is unconditional — a composition without a web server never emits the event, so ui-theme still activates and contributes nothing; a missing `matchMedia` falls back to light; input without a body is covered by a unit test.
- Surprising: the bootstrap recognizes only the built-in `light`/`dark`/`system` semantics, registers no listeners, and does not resolve third-party themes or token overrides — a custom theme still applies fully only after the browser plugins activate, and during the loading interval the page uses its private fallback palette; and hard-coding the logic in `apps/web/index.html` was rejected because static HTML cannot embed the current Host setting and would duplicate the preference resolution and DOM fields owned by ui-theme.

### .agents/notes/archived/bug-fix/2026-08-10-pre-plugin-theme-bootstrap.zh.md
- Chinese twin: translates the inline-script bootstrap, the `body`-vs-`head` placement argument, the four rejected alternatives, and the "custom themes apply only after plugin activation" limit; all 18 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-10-session-row-identity-covers-the-preset.i18n.yaml
- Bilingual-pair record for the session-row identity note (`7d9fc5e5…` English / `4e707f8b…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-10-session-row-identity-covers-the-preset.md
- Purpose: why a session's preset switch was reported by the manager but read by nobody.
- Key abstractions: `SessionManager.buildListSnapshot`'s value-based memoization; `noteAgentPreset`; `applyMutation`; `SessionSummary.agentPreset`; `projectionValues`.
- Data flow: a wire refresh mints all-new summary objects, so an entry equal to the cached one is replaced by the cached instance; the comparison enumerated the fields by hand and did not enumerate `agentPreset`, and a confirmed preset switch moves exactly that one field (the merge deliberately does not take the mutation's `updatedAt`), so the guard judged the row unchanged and served the stale instance permanently (line 12).
- Non-obvious design decisions: the fix is one field added to the comparison — "every field matches" already claimed that; nothing else changes, because the memoization, the merge and the chip's no-op check are each correct once the row they read is correct.
- Edge cases / failure handling: the hero chip compares its pick against that row before sending anything, so switching back to the creation-time preset looked like "already on that preset" and the chip dropped the stage and sent no RPC at all — the chip label moved while the composition did not.
- Surprising: a generic deep comparison cannot be added blind, because the row carries `projectionValues` whose *reference identity* is the deliberate signal that the projection store republished — folding it into a value comparison would either re-render on every projection tick or mask a real one; and the guard is still a hand-written enumeration, so a field added to `SessionSummary` later must be added there too, which the `sessions-service` projection test names as the failure mode for the next such field.

### .agents/notes/archived/bug-fix/2026-08-10-session-row-identity-covers-the-preset.zh.md
- Chinese twin: translates the memoization-vs-field-enumeration defect, the one-field fix, the three rejected alternatives, and the "projectionValues reference identity" argument; all 15 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-10-slash-catalog-follows-preset-switch.i18n.yaml
- Bilingual-pair record for the slash-catalog note (`e5e4a670…` English / `f2d4b10a…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-10-slash-catalog-follows-preset-switch.md
- Purpose: why the `/` menu kept serving a composition the session no longer ran.
- Key abstractions: `CommandDirectory` (`dsh-client-ui-commands`); the single-flight fetch map in `dsh-client-ui-skill`; the `agent-preset/selected(sessionId, agentPreset)` owner event; `ctx.remote.$on`; `SessionEventMap` augmentation.
- Data flow: both browser catalogs cache per session and the composer warms both at scope birth, under whatever preset the session was created with; the hero chip then lets the user recompose the still-blank session, and neither cache had an invalidation edge — `commands/change` is registry-wide and `connection/reset` needs a reconnect, and `agentPresets.recompose` re-parents the agent's scope onto a standing mount that may already exist, so it registers nothing and the registry-wide signal never fires (line 12).
- Non-obvious design decisions: the switch's commit point is the **logged** `agent-preset/selected` event, re-emitted by the preset owner as a client-safe cordis owner event and forwarded verbatim by the host stream; deriving the owner event from the logged event rather than from the RPC handler's return keeps one authority for "this session's composition changed", so every connected client observes the switch, not only the tab that issued it (line 22).
- Edge cases / failure handling: `ui-commands` soft-refreshes the key (the old snapshot keeps serving the open menu until the new one lands) while `ui-skill` invalidates it, aborting an in-flight prewarm so a warm racing the switch cannot publish the stale catalog — a skill catalog has no partial-serve mode, so a menu opened inside the refetch window shows no skills for that instant rather than the wrong ones.
- Surprising: the client cannot reach the logged event through the existing `session/event` mux frame, because narrowing `event.type` to `agent-preset/selected` requires the `SessionEventMap` augmentation, and the only ways to load it in the Client program are a project reference to `dsh-agent-presets` — which drags the host `ctx.sessions` merge into a program that publishes its own — or a cast that defeats the discriminant; and the owner event remains a *second publication* of a logged fact, so a future switch path that recomposes without logging would go unannounced.

### .agents/notes/archived/bug-fix/2026-08-10-slash-catalog-follows-preset-switch.zh.md
- Chinese twin: translates the logged-event-as-commit-point decision, the soft-refresh-vs-invalidate split, the `SessionEventMap` face-separation argument, the four rejected alternatives, and the "second publication of a logged fact" caveat; all 30 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-10-subagent-empty-terminal-message-output.i18n.yaml
- Bilingual-pair record for the subagent-output note (`83e4fa58…` English / `a4136321…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-10-subagent-empty-terminal-message-output.md
- Purpose: why a child's real partial answer vanished from `SubagentResult.output`.
- Key abstractions: `dsh-subagent`'s `src/assistant-output.ts`; the incremental `AssistantOutputFold` (`push(event)`, `pushText(text)`, `collect()`); `finalAssistantOutput(events)`; `BlockAssembler.blocks()`; `subagent/end.lastAssistantMessage`.
- Data flow: the agent loop appends an empty-content `assistant/message` when a `max-tokens` step assembled only tool-call blocks (the assembler drops truncated tool calls); three consumers selected the child's output independently and treated that record as output, so in a multi-step turn cut off at max-tokens the final empty message caused the real partial answer to be omitted; the fix is one canonical selection rule — select the last non-empty Assistant message, and without one select accumulated `text-delta` content from embedded `assistant/message` and `assistant/attempt` streams or a chunk-only transport (line 14).
- Non-obvious design decisions: the shared rule is owned by `dsh-subagent` and used by the in-process driver, the continuable Activation's capture, the SDK backend and the foreground delegation tool, because observers of one run must agree on its output; `SubagentResult.output` defines the result contract and `subagent/end.lastAssistantMessage` uses the same rule.
- Edge cases / failure handling: when a child produces neither form of output the lifecycle field is *absent* rather than an empty array, for both one-shot and continuable runs; a `max-tokens` or `aborted` result retains its actual stop reason; a non-`completed` delegation result remains an `isError` tool result but presents the optional safe Provider diagnostic after the stop-reason headline and appends the child's partial text afterwards, so the parent model receives the failure, the separate infrastructure detail and the available output without conflating them.
- Surprising: the rule tests *content length* rather than text presence, so a reasoning-only non-empty message is selected instead of streamed text, and a non-empty message is selected instead of text streamed after it; and stopping the loop from appending the empty message was rejected because the message records usage and preserves the step in the durable log ("model-visible ⟺ logged").

### .agents/notes/archived/bug-fix/2026-08-10-subagent-empty-terminal-message-output.zh.md
- Chinese twin: translates the single canonical selection rule, the fold API, the "absent rather than empty array" convention, the three rejected alternatives, and the content-length-vs-text-presence subtlety; all 22 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-10-web-favicon-dark-mode.i18n.yaml
- Bilingual-pair record for the favicon note (`22e1d063…` English / `dff90567…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-10-web-favicon-dark-mode.md
- Purpose: why the tab icon was invisible under a dark colour scheme.
- Key abstractions: `apps/web/public/favicon.svg`; the `prefers-color-scheme` media query; the 32×32 PNG fallback (`favicon-32x32.png`, DeepSeek brand blue `#4D6BFE`); `manifest.webmanifest`.
- Data flow: the favicon painted the mark solid black (`fill="#000"`) and `index.html` declared only that one SVG icon, so under a dark scheme the black mark was invisible; the favicon stays one file and adapts through the browser's own signal — `favicon.svg` embeds `@media (prefers-color-scheme: dark) { path { fill: #fff } }` — while `index.html` and the manifest also declare the PNG fallback that pre-26 Safari renders (line 14).
- Non-obvious design decisions: the theme signal is the OS/browser scheme, not the GUI's in-app `dsh.theme` toggle, because the favicon lives in browser chrome whose background follows the browser scheme, so `prefers-color-scheme` is the correct semantic and needs no JavaScript.
- Edge cases / failure handling: known browser quirks are accepted — Chromium may not repaint the tab icon until reload after a scheme switch, and pre-26 Safari ignores the SVG variant, which the PNG fallback covers.
- Surprising: a theme presenter that swaps the icon href on `theme/change` was rejected because it would follow the in-app toggle rather than the browser scheme that actually colours the tab strip, and it would add client code and a presenter for a chrome asset; a second `<link rel="icon" media=…>` was rejected as two files to keep in sync with no benefit over the in-file media query.

### .agents/notes/archived/bug-fix/2026-08-10-web-favicon-dark-mode.zh.md
- Chinese twin: translates the in-file media query, the PNG fallback rationale, the three rejected alternatives, and the accepted Chromium repaint quirk; all 13 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-11-bounded-background-job-admission.i18n.yaml
- Bilingual-pair record for the job-admission note (`8eee8834…` English / `1c08bbfc…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-11-bounded-background-job-admission.md
- Purpose: why a model could grow live background processes without bound.
- Key abstractions: `LocalJobRegistry`'s `maxConcurrentJobsPerOwner` (default 10); the generic job runtime's Task lifecycle; `JobHooks.done`; `JobStart.run()`; `maxParallelToolCalls`.
- Data flow: `maxParallelToolCalls` limits only calls still executing inside one step, while each background producer returns a job id immediately, so repeated starts grow live processes without bound; `start()` now performs admission after the existing task-controller, task-field and live-owner checks and before `JobStart.run()`, deriving the active count from the registry's current records rather than storing another counter (line 20).
- Non-obvious design decisions: occupancy is derived from the registry's *own* status records — `running` and `stopping` both occupy capacity and release only when the producer's `done` settles, while `completed`/`killed`/`failed` are already terminal — because a `stopping` producer may still own its process, PTY or child, so releasing capacity on a cancellation request would be incorrect (line 22).
- Edge cases / failure handling: owned tasks are bucketed by exact `Agent` object identity, matching owner cleanup, so replacement agents reusing a session id get an independent bucket, and jobs without an owner share one service-level bucket so omitting ownership is not an unlimited bypass; when the bucket is full `start()` throws *before* producer execution and task-id allocation, and rejection creates no execution resource, queue entry, reservation or public job record (line 30).
- Surprising: continuable background subagents are deliberately outside this budget, because they own durable child sessions and live Activations rather than Task records, and limiting them needs a separate result and lifecycle contract; and the diagnostic tells the model to use `job_kill`, wait until the task finishes stopping, and retry — an explicit rejection lets the model decide which work is no longer needed instead of the system queueing, preempting or terminating the oldest task.

### .agents/notes/archived/bug-fix/2026-08-11-bounded-background-job-admission.zh.md
- Chinese twin: translates the per-owner bucket, the occupancy table, the throw-before-id-allocation rule, the four rejected alternatives, and the "a producer whose `done` never settles holds a slot for the service lifetime" consequence; all 16 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-11-owned-run-finish-reason.i18n.yaml
- Bilingual-pair record for the owned-run note (`cfa1ec02…` English / `cc169caa…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-11-owned-run-finish-reason.md
- Purpose: giving Python SDK consumers a concise classification of how an owned run finished.
- Key abstractions: `RunResult.finish_reason`; `SdkProtocolError`; the owned-run boundary decision.
- Data flow: `RunResult.finish_reason` is the string `kind` from the last root-session `turn/end` collected between the submitted message's durable inbox receipt and the next whole-agent idle; it is `None` when the interval contains no `turn/end`, and a `turn/end` without a string `data.reason.kind` raises `SdkProtocolError` rather than being reported as an interval without a turn ending (line 14).
- Non-obvious design decisions: the field describes the owned run *interval* and does not assign that ending to the submitted prompt — the owned-run boundary decision continues to prohibit prompt-level result attribution.
- Edge cases / failure handling: only the kind is exposed because callers need a stable classification and the complete structured reason remains available in `RunResult.events`; transport loss, timeout and protocol failures still raise instead of producing a finish reason.
- Surprising: the field is named `finish_reason` rather than `stop_reason` because ACP and the subagent seam map turn-ending reasons into their own `stopReason` value sets — sharing the name would imply a mapping this interface does not perform; and a model `FinishReason` was rejected because a run may contain multiple model steps and intermediate `tool-calls` endings do not finish the run.

### .agents/notes/archived/bug-fix/2026-08-11-owned-run-finish-reason.zh.md
- Chinese twin: translates the `finish_reason` definition, the `SdkProtocolError` on a malformed reason, the four rejected alternatives, and the "must not be presented as the initiating prompt's causal outcome" caveat; all 18 code identifiers match the English side.

### .agents/notes/archived/bug-fix/2026-08-11-preset-authoring-agent-validates-its-own-composition.i18n.yaml
- Bilingual-pair record for the preset-authoring note (`0246fb72…` English / `2e47aa49…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-11-preset-authoring-agent-validates-its-own-composition.md
- Purpose: correcting four false statements in the only guidance an agent had for authoring a preset.
- Key abstractions: `ctx.agentPresets`; `standingKeyFor(id)` → `ensureStanding()`; `copy(from, id, name)`; `cordis_inspect what:"api"` and `what:"services"`; the `inject: ['agentPresets', 'tools']` plugin pattern; `AgentPresets`' derived `<dshHome>/.agent-presets` root.
- Data flow: the `cordis` preset ships `editing-cordis-compositions`, and four of its statements were false — `tool-bash` was named as a row that "provides `bashEnv`" (it provides nothing; `bashEnv` comes from the host composition's `shell-env` row), its `isolate` example composed host-plane `jobs-local` with `tool-jobs` (contradicting the file next to it), it described a string realm label as pooling one instance across subtrees, and it sent the agent to a package's README to learn whether a row publishes a service (no package ships its README); the fix teaches the agent to mount-validate its own composition, with `standingKeyFor(id)` running the same real mount a session start performs, minus the agent (line 26).
- Non-obvious design decisions: the agent reaches the roster service the way `cordis_mount` documents — a temporary plugin declaring `inject: ['agentPresets', 'tools']` that registers a tool *for itself*, because a mount returns only its own acknowledgement and a registered tool is how a service answer reaches the model on the next step; and the skill states plainly that `list()`'s `broken` field is **not** validation, since discovery's health check only proves the file parses in the loader's dialect and holds named rows.
- Edge cases / failure handling: a failed mount deletes the standing entry and disposes its scope, leaving nothing behind; a successful one installs the standing generation the first real session would have installed anyway, so the skill places the check at the end of a finished edit rather than in a per-line loop; the prohibition on touching the shipped install is promoted to a top `## Off-limits` section and extended to editing the host composition as a workaround.
- Surprising: the note includes a **measured behaviour table** of six broken compositions, all of which pass `list()`'s `broken` check with an empty value and are caught only by `standingKeyFor()` — including "service row with no realm, name the host does not supply" (`row(s) published process-global service(s) [workflows]`) and "row missing a required config field" (`invalid config: $.allowParallelInProgress missing required value`); and it names the cost honestly — a successful validation leaves a standing generation that is never reclaimed, so the agent pays the standing-mount cost once at the end of an edit instead of the user paying it at the first session.

### .agents/notes/archived/bug-fix/2026-08-11-preset-authoring-agent-validates-its-own-composition.zh.md
- Chinese twin: translates the four corrected statements, the `standingKeyFor` validation mechanism, the temporary-plugin service-reach pattern, the six-row measured table, the three rejected alternatives, and the standing-generation cost; all 55 code identifiers match the English side (the English side alone carries the `name` token).

### .agents/notes/archived/bug-fix/2026-08-11-preset-card-description-clamp.i18n.yaml
- Bilingual-pair record for the preset-card note (`b9088b46…` English / `a7a3c4f2…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-11-preset-card-description-clamp.md
- Purpose: why one long preset description set the height of the whole roster.
- Key abstractions: the settings section's card grid with `grid-auto-rows: 1fr`; the shared `Tooltip` with its new optional `maxWidth`; `ResizeObserver`.
- Data flow: a preset publishes its own `description` of any length; the description had a `min-height` and no upper bound while the grid sizes rows with `grid-auto-rows: 1fr` — which makes *every* implicit row the same height, not just the row holding the tall card, so a 250-character description made all four cards measure 421px (line 10).
- Non-obvious design decisions: the description clamps to four lines and offers the rest through the shared `Tooltip`, attached only while the element actually overflows (`scrollHeight > clientHeight`, re-measured through a `ResizeObserver` because the settings pane width follows the window) — mirroring the chat stats line, which clamps to one line on the same measure-then-attach rule.
- Edge cases / failure handling: card height stays *derived* rather than fixed, because with the description bounded `grid-auto-rows: 1fr` already equalizes the grid while a card carrying the broken-preset reason or a revealed path still sizes itself; the description carries `title=""` so the card body's native tooltip does not climb to it and a cut-off description answers with one bubble instead of two; `Tooltip` flips a `top`/`bottom` bubble when the viewport has no room, and keeps the requested placement rather than oscillating when neither side fits.
- Surprising: a fixed card height was rejected because it clips the two rows whose height legitimately varies; and the badge copy was changed from `Broken` (`已损坏`) to `Failed to load` (`加载失败`), because discovery sets `broken` when the composition file is missing, unreadable or malformed — most often a file the user just edited or deleted — so a damage claim overstates what was observed, while the verbatim reason under the badge already names the file and the fix.

### .agents/notes/archived/bug-fix/2026-08-11-preset-card-description-clamp.zh.md
- Chinese twin: translates the grid-`1fr` sizing mechanism, the measure-then-attach clamp, the `title=""` trick, the tooltip flip, the four rejected alternatives, and the `Broken` → `Failed to load` badge change; all 19 code identifiers match the English side (the English side alone carries the `set as default` literal).

### .agents/notes/archived/bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.i18n.yaml
- Bilingual-pair record for the subprocess-exit note (`b312ec63…` English / `2881bee9…` Chinese).

### .agents/notes/archived/bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.md
- Purpose: why a TERM-resistant child could outlive the host process.
- Key abstractions: `LocalSubprocessRuntime`'s synchronous Node `exit` listener; the service's live sets; the local-only final operations absent from the public `SubprocessHandle` / `SubprocessTerminalHandle` interfaces; the subprocess seam's terminate-and-join path.
- Data flow: the local subprocess provider reached its process trees only through asynchronous Cordis disposal, but a fatal launcher may call `process.exit()` before that disposal finishes — the fail-loud release waits at most two seconds while a local process can have a longer termination grace, and once Node enters its synchronous exit phase pending promises and escalation timers do not continue; the runtime therefore installs one synchronous `exit` listener in its Cordis effect (removed only after normal disposal settles) that immediately SIGKILLs a detached POSIX process group or runs synchronous `taskkill /PID <pid> /T /F` on Windows, and for a terminal handle synchronously signals every captured and currently observable descendant, kills the PTY root, then rescans once (line 16).
- Non-obvious design decisions: ordinary and terminal handles stay in the service's live sets while asynchronous cleanup is pending, so a shorter outer exit bound still sees and force-terminates them; the listener's operations are *local-only* — adding a public raw `forceKill()` was rejected because consumers need one cooperative termination contract and immediate final termination is an implementation responsibility.
- Edge cases / failure handling: the service contains each target's failure and continues with the remaining handles; the callback creates no promise or timer, writes no diagnostic, and does not change the original exit code or error; the synchronous path requests final termination but does not publish a completion result or claim the OS tree is already gone; a cleanup failure during awaited disposal invokes the same synchronous operations before clearing the sets and removing the listener.
- Surprising: the note includes a three-row table of host paths and completion evidence, and states plainly that `SIGKILL`, fatal OOM, `process.abort()`, native crash or power loss require an external supervisor, container or OS ownership, because no in-process action can run; and it names a residual ownership gap it does not close — a terminal descendant that escaped before the provider ever observed it is tracked by Issue #1726.

### .agents/notes/archived/bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.zh.md
- Chinese twin of the subprocess-exit note: same structure, translating the synchronous `exit` listener, the three host-path rows, the four rejected alternatives, and the Issue #1726 gap. Read in full for verification; the manifest assigns this Chinese file to a different shard, so it is not a row in this shard's ledger.

## Ideas worth stealing

- **Make the compaction summarisation call a true prefix-extension of the last routed request** — `.agents/notes/archived/bug-fix/2026-07-21-compaction-summary-prefix-cache-reuse.md:14` — the summarisation directive moves from the *front* of the auxiliary request (a fresh `system` prompt) to the *end* (a trailing `user` message), and the request replays the routed request's `system` + `tools` + history byte-identically, so the provider reuses the warm KV cache. The `tools` ride along even though the summariser never calls one, because dropping them shortens the token sequence and breaks alignment (`:18`). August should build its compaction summary the same way: same system prompt, same tools, same leading messages, instruction last — otherwise every compaction pays double prompt-processing on the largest part of the conversation, exactly when the context is biggest.
- **Classify a provider's degenerate empty completion as a retryable failure at the adapter boundary** — `.agents/notes/archived/bug-fix/2026-07-24-empty-model-response-is-retryable.md:16` and `:19` — a terminal `stop` with zero content blocks becomes `finish {kind: 'error'}` with a canonical `EMPTY_RESPONSE` code, and that code sits in the provider-owned *normal* retryable set because "the attempt produced nothing durable, so repeating it is safe". The scope is deliberately `stop` finishes only (reasoning-only and whitespace-only responses stay successful) to avoid retry loops on models that intentionally stop after reasoning. August's turn loop should treat an empty assistant message as a bounded retry, not a silent `completed` turn.
- **Choose crash-recovery boundaries that are semantic, and distinguish "not started" from "outcome unknown"** — `.agents/notes/archived/bug-fix/2026-07-21-semantic-session-checkpoints.md:14` and `:22` — flush before the next request is derived, after `request/header` is logged but before the adapter stream is constructed, and after pre-execute policy but before the tool body; then classify a crash by durable evidence, so an assistant tool request with no `tool/call` becomes `TOOL_NOT_STARTED` (retryable) while a durable `tool/call` with no result becomes `TOOL_OUTCOME_UNKNOWN`, whose model-visible result permits retry only for read-only or idempotent operations. August's `turn_outcomes` ledger and its "re-read then retry" remedies are exactly this shape; the durable-evidence split is the part worth copying.
- **Enforce a tool-restriction mode at the executor, not at the schema** — `.agents/notes/archived/bug-fix/2026-08-07-ptc-executor-collapse.md:12` and `:16` — the package contract states the rule outright: "schema omission is not enforcement when a direct caller can bypass it; denial must be tested through the executor". The collapse is applied inside `resolveExecution`, so a model-direct native call resolves to `undefined` and surfaces as `UNKNOWN_TOOL`, and it terminates at `createExecution` *before* the extensible policy pipeline — so approval prompts, pre-execute listeners and guards never see a call that is deterministically denied, and no human is asked to approve it. August's "schema is the whole tool surface" assumption needs the same audit: every advertised-tool restriction should have a matching executor-side denial, tested through the executor.
- **Bound background work with a per-owner bucket whose occupancy is derived from the registry's own status records** — `.agents/notes/archived/bug-fix/2026-08-11-bounded-background-job-admission.md:22` and `:30` — `running` *and* `stopping` both occupy capacity and release only when the producer's `done` settles (a `stopping` producer may still own its process), and when the bucket is full `start()` throws *before* producer execution and id allocation, so a rejection creates no execution resource, queue entry or reservation. Bucketing is by exact `Agent` object identity, matching owner cleanup. August's job/automation surfaces need a per-owner ceiling, not a global one, and the "cancel requested" state must not be mistaken for "resource released".
- **Render the whole `cause` chain at every diagnostic boundary, from one shared renderer in the leaf package** — `.agents/notes/archived/bug-fix/2026-07-20-error-cause-chain-diagnostics.md:17` and `:19` — undici's `fetch` wraps every transport failure in a bare `TypeError: fetch failed` and puts the actionable detail on `error.cause`; a single `errorChain(value)` in the leaf `dsh-llm` package (chosen because every consumer already imports that package, so sharing costs no new dependency edge) then replaces `error.message`/`String(error)` at the loop's durable `turn/end` message, its logger warnings, the TUI notice and the stdio startup lines, and three per-package `renderThrown` copies are deleted. Routing stays on `HarnessError.code`; the renderer is diagnostic output only. August's error surface should do the same — one chain renderer, applied everywhere, with the structured code kept separate from the human string.
- **Separate the human projection from the model projection, and let the event's own marker decide which one it belongs to** — `.agents/notes/archived/bug-fix/2026-07-29-human-transcript-append-origin.md:16` — a compaction's replacement node is a *model-only* copy, and using the model-visible surface as the human transcript made the terminal erase every message the replacement shadowed. The split is `isAppendSurfaceEvent` / `isReplacementSurfaceEvent` over the two `SurfaceOp` variants; everything that must send exactly what the model sees keeps reading the surface. The browser twin of the same fix is in `2026-07-30-web-transcript-log-ordered-projection.md:16`, which also shows the compile-time half: a shared predicate moved into a cordis-free leaf subpath and pinned by a **type-only** import, so renaming the plugin id becomes a client-side compile error. August's transcript and its log are the same shape of hazard.
- **Fold a projection that lacks a price claim *neutrally* rather than throwing, but keep a contradictory adjacent claim loud** — `.agents/notes/archived/bug-fix/2026-08-06-token-surface-unpriced-replace-compatibility.md:16` and `:18` — a replace with no armed shadow-price claim folds as `deltaTokens: 0` so a pre-protocol session stays replayable, while an *armed* claim naming a different range still throws, because there the metering event was adjacent and the producer wrote contradictory events. The overcount that results can only trigger an *earlier* compaction, which is the safe direction. This is a reusable rule for August's O(1) checkpointed projections: historical data folds neutrally, live contract violations still fail loud.
- **Let the composer's two text layers share one scrollport instead of keeping them in sync** — `.agents/notes/archived/bug-fix/2026-07-31-composer-text-layers-share-one-scrollport.md:18` and `:24` — the note's core observation is that "no listener can close that gap, because the gap is the definition of a listener: it runs after the thing it reacts to"; the mirror was correct *at rest* and wrong in motion, measured at 203/202/203px of caret-to-glyph separation in chromium/firefox/WebKit. The fix is structural: one scrollport holds both layers, the textarea gets `overflow: hidden` so it cannot hold an offset at all, and the browser applies one offset to both in the same frame on the same compositor. The decisive test reads the separation *before the task ends*, before any `scroll` listener could have run. August's textarea-plus-overlay composers have the same two-layer hazard.
- **Latch a wake-up that lands in a cancellation's convergence window, and replay it at the old driver's own settlement boundary** — `.agents/notes/archived/bug-fix/2026-08-07-cancel-convergence-wake-latch.md:14` — the `running` phase carries a `wakeRequested` latch, armed only when the current activity cannot deliver the wake; the replay lives in the exiting activity's `finally`, which guarantees `turn/end N` lands before the replayed driver opens `turn/start N+1` and that `whenIdle()` sees the replayed driver. The `signal.aborted` discriminator separates pre-abort queued work (parked) from post-abort explicit wakes (run after convergence), and the replay only fires while `inbox.hasPending`. August's cancel/queue paths have the same window.
- **Make a bounded overwrite's diff basis a provider-owned, descriptor-enforced bound — and treat a partial read as no basis at all** — `.agents/notes/archived/bug-fix/2026-07-30-bounded-overwrite-diff-basis.md:14` — `before` is supplied only when the replacement and the *descriptor-checked* prior file are both under `diffBasisMaxBytes`; a size change after the descriptor stat returns `null` even if the final size fits, because a partial prefix would be an incorrect diff basis; and any descriptor-phase errno returns `null` rather than failing a write the caller already committed to. Trusting the earlier path `probe()` was rejected because that size can go stale before the read. August's write path needs the same "the bound must be enforced on the object you actually read" rule.
- **Say out loud what a tool's status word means, and make the word describe the *action available*, not an outcome** — `.agents/notes/archived/bug-fix/2026-08-06-list-agents-residency-vocabulary.md:20` — `list_agents` reported `complete` for a child with no resident Activation but an intact conversation, and a model reading `complete` looked for a result that did not exist; the model-facing vocabulary became `running | idle | ready`, where `ready` means "the same conversation accepts another turn", while the service layer kept its accurate `'running' | 'inactive'`. The note's rule: *the line the model scans must carry the correct distinction itself* — a description saying "`complete` does not mean complete" fights the rendered status on every read. August's tool outputs deserve the same audit.
- **Give the subagent's output one canonical selection rule, shared by every consumer** — `.agents/notes/archived/bug-fix/2026-08-10-subagent-empty-terminal-message-output.md:14` — three consumers selected the child's output independently and diverged, so `dsh-subagent` owns one rule (last non-empty Assistant message, else accumulated `text-delta`, ignore empty-content messages) used by the in-process driver, the continuable Activation, the SDK backend, the ACP backend and the foreground delegation tool. The rule tests *content length*, not text presence, so a reasoning-only message still wins over streamed text. August's subagent/child results should have exactly one selector, in one place, with the stop reason kept separate from the partial text.
- **Preserve a fail-loud path's ability to release the terminal — and keep the timeout timer referenced** — `.agents/notes/archived/bug-fix/2026-07-31-fail-loud-releases-the-terminal.md:31` — the diagnostic is written *before* the release so a wedged disposer cannot swallow the reason, a *latch* keeps the first rejection the reported one, and the bounded release timer must stay referenced: an `unref`'d one lets Node reach an empty event loop and exit 0 on the very failure being reported, because an `unhandledRejection` listener suppresses the default fatal exit. August's crash paths should treat "the process may exit 0 on a fatal error" as a real failure mode.
- **Bound the whole tree at the launcher, not just the known offender** — `.agents/notes/archived/bug-fix/2026-08-03-cli-signal-shutdown-escalation.md:24` — a telemetry disposer that never settled turned a one-way boolean latch into an unkillable CLI; the fix has two layers: the OTel backend bounds its own provider shutdown (3 s) and the launcher owns the outer guarantee (5 s backstop, a second signal forces immediate exit, and normal shutdown sets `process.exitCode` rather than calling `process.exit()` so Node can retire its own async handles). The note's rule: any current or future disposer can wedge, so the process boundary — not the plugin — must preserve both a graceful first attempt and a user-controlled way out.
- **Share a scroll-position ledger instead of enumerating input devices** — `.agents/notes/archived/bug-fix/2026-08-06-reader-scroll-attribution-observed-top-ledger.md:14` — bottom-follow recognised only wheel gestures, so touch, scrollbar and keyboard readers could not take ownership from a streaming tail; the fix records the last `scrollTop` written or delivered at every programmatic write site and treats a position deviating from `min(ledger, floor)` by more than half a pixel as reader input, so *one* `scroll` listener covers every input source. Enumerating devices was rejected because native-scrollbar dragging exposes no input event to latch before its scrolls arrive.
- **Fail the executor before the policy pipeline, so a denied call never reaches a human** — `.agents/notes/archived/bug-fix/2026-08-07-ptc-executor-collapse.md:16` (repeated because the mechanism is the transferable part) — the collapsed call terminates at `createExecution`, so `tools/pre-execute` listeners, approval `ask` and guards never observe a call that is deterministically denied. August's approval prompts should only ever fire for calls that could actually succeed.
- **Make the model-visible status of a subagent reflect the *live* scope chain, not a header snapshot** — `.agents/notes/archived/bug-fix/2026-08-10-child-agents-join-their-parent-preset.md:22` and `:26` — a child's preset is recorded from the parent's live scope chain (`composedPreset()`) rather than the parent's creation header, because a parent that switched preset while blank runs on the newer composition while its header still names the older one; and the same note catches the second defect — a scope's restriction exempt set is "the tools this scope registers *itself*", not "the global layer", which is what made a child's `toolFilter` stop constraining anything once every model-facing row became an ancestor contribution. August's delegation and capability filters need the same re-reading of what "inherited" means.

## Files skipped (with reasons)

- None. All 260 files in this shard were opened and read: the 87 English notes line by line, all 86 Chinese twins in full (plus one Chinese twin of `2026-08-11-synchronous-subprocess-exit-cleanup.md` that the manifest assigns to a neighbouring shard, read for verification), and all 87 `.i18n.yaml` pairing records.
- The largest file, `.agents/notes/archived/bug-fix/2026-07-31-code-runtime-python-settlement-fixes.md` (72,832 bytes, 152 lines with six very long paragraphs), was read in full via the `read` tool plus targeted reads of the six truncated lines; the same was done for its 73,798-byte Chinese twin. No generated, vendored, binary or huge-data file is present in this shard — every file is prose, a YAML pairing record, or a markdown translation.

## Uncertainties

- **The manifest and the filesystem disagree on one file.** The manifest assigns 86 `.zh.md` files to this shard, but `2026-08-11-synchronous-subprocess-exit-cleanup.zh.md` also exists on disk (it is the Chinese twin of the English note this shard *does* own). I read it for verification and it is a faithful translation with 19 matching code identifiers, but I did not claim it as a shard file because the manifest assigns it elsewhere. If the lead's merge expects 87 zh rows for this shard, that file is the missing one.
- **I did not verify the notes' claims against the code they describe.** Every note here is a *decision record*; the mechanisms it attributes to `dsh-llm`, `dsh-compaction-basic`, `dsh-session-checkpoint-policy`, `packages/client/ui-theme`, `packages/experimental/code-runtime-python` and the rest were not re-read in the source, because the shard contains only notes. Where a note asserts a package behaviour (e.g. that `llm-pi-ai` 0.81.1 exposes no fetch/dispatcher/client hook, or that `dsh-session-checkpoint-policy` is mounted by every first-party app), I report the note's assertion, not an independently confirmed fact.
- **Some "measured" numbers could not be re-derived.** The notes cite specific measurements (6.5px/10px of copy spill, 12.2 s → 7.2 s, 796 ms → 17 ms, 203/202/203px caret separation, 32.0 MiB → 0.0 MiB fd-3 peak, 168 top-level entries, 11,485 files, 185 sessions / 87 MB / ~353k events, 36.9px control overlap, 419.6 ms → 1.94 ms elsewhere in the repo). I report them as the notes state them; the measurement harness itself is not in this shard.
- **The `.i18n.yaml` records' blob hashes were not re-derived.** I read every pairing record and confirmed each names exactly its own English/Chinese pair with two 40-hex blob hashes, but I did not run `git hash-object` (that would execute a repo tool) to confirm the hashes match the current file contents.
- **One note is explicitly a work in progress rather than a settled decision.** `2026-07-20-config-hot-reload-resilience.md` describes the vendored Cordis Loader/Include/HMR divergence as maintained in the vendor manifest, and `2026-08-03-hmr-initial-scan-boot-deadlock.md` names a latent gap it deliberately leaves open (a config edit during a *failing* initial apply can still queue a refresh the rollback waits on). I report these as stated, not as resolved.
- **A handful of cross-note references point outside this shard.** Several notes link to `../feature/`, `../architecture/`, `../simplification/` and `../process/` notes (for example the compaction-seam note, the slot-type-chain standard, the owned-run boundary decision, the copy-only preset authoring note). I did not open those; where a note's decision depends on one of them, I attributed the dependency to the note rather than claiming to have verified the referenced document.
- **The Chinese twins were verified structurally as well as by reading.** For every one of the 86 zh files I compared heading count, `Status:`/`Archived:` metadata, and the complete set of backticked code identifiers against its English twin: 83 pairs match exactly on identifiers, and 3 differ only by a literal that the translator rendered in Chinese (the `scrollHeight === clientHeight` comparison, the `scrollbar-color: auto` value, the `visible` token, the `~used / capacity` label, the `New Session` and `set as default` UI strings, the `inert` and `name` tokens). No zh file contained a code identifier absent from its English twin.


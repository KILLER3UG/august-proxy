# deepseek-harness / dsh-client-rest#2

## Shard shape

This shard is the **browser-half plugin surface of `deepseek-harness`**: ten `packages/client/ui-*` packages that together make up the Web GUI's feature plugins, none of which is the agent loop itself. They are `ui-deliverables` (changed-files card, review tab, delivery cards, inline file mentions), `ui-directory-picker-browse` and `ui-directory-picker-native` (two interchangeable occupants of the same two directory-flow slots), `ui-input-trigger` (the `/` and `@` detection + candidate-menu pipeline), `ui-jobs` (background-job list), `ui-message-feedback` (Like/Dislike + feedback dialog), `ui-model-selection` (the `/model` popup and the composer model seat), `ui-open-in-app` (native "open with…" controls), `ui-permission-presets` (current-session picker + Settings default row), and `ui-plugin-manager` (the Plugins page, install wizard, registry probe). Every package follows the same three-part shape: a **node half** (`src/index.ts`) that is either an inert `apply()` loader seat or a small Host service, a **browser half** (`src/client/`) registered through the `ctx.slots` slot registry, and a **dictionary pair** (`locales.ts` with `zh` as the key-set source of truth plus a `locale/*.json` package listing). The packages communicate only through **slots** (a `SlotMap` merge declaring what a host owns and what a plugin may contribute), through **Remote facades** (Typert protocol) that own every wire read and write, and through **per-session controllers** in a root service. There is no direct package-to-package runtime import: a plugin that needs another's surface contributes to a slot; a plugin that needs another's data reads it from a shared, session-scoped store. That is the whole architectural bet of this shard, and it is the part worth carrying.

**Lenses covered by this shard.** The agent loop and tool-calling flow are *not* in this shard (they live in the `dsh-agent` / `dsh-llm` / conversation packages); what the shard contributes is the *UI side* of tool calls (`present` row, diff card, job rows). Reasoning/thinking content is absent — the packages deliberately touch no prompt, message, schema, stream or tool result, and each README says so explicitly ("Model Experience: None"). Prompt construction appears exactly once, and importantly: `ui-deliverables` registers a static system-prompt section teaching the model how to cite files. Context-window management, compaction, memory/learning, model-specific fallbacks and evals are all out of scope here. What *is* in scope, and in depth: **tool-call reliability at the UI edge** (generation-fenced reads, aborted superseded requests, retry-vs-don't-retry policy per record kind, "the reply was lost" as a third outcome), **config** (the `configForms` mirror, settings descriptors with revisions, per-package locale dictionaries and the bilingual-pair hash record), **UI/UX patterns** (fold-then-expand, skeleton-then-content, portaled menus, combobox focus retention, two-press destructive actions, risk gates, focus parking), and **subagent/parallel execution** only as an *observable* (`ui-jobs` renders background jobs and subagent rows; the job registry is the model's own view and stays elsewhere).

---

## Per-file notes

### packages/client/ui-deliverables/locale/en.json
Package listing metadata for the plugin catalogue: `meta.title` only, no description.

### packages/client/ui-deliverables/locale/zh.json
Chinese listing metadata; the only key beyond `title` is `meta.description`.

### packages/client/ui-deliverables/package.json
- Purpose: package manifest for the deliverables plugin.
- Key abstractions: `dsh.client.inject` names the nine browser packages the plugin binds (`api-remotes`, `client-connection`, `client-locale`, `ui-chat`, `ui-conversation`, `ui-renderer`, `ui-sidebar-right`, `ui-tool`, `ui-settings`); `exports["./client"]` is how the browser half is discovered.
- Data flow: the host reads `dsh.client.inject` to wire the browser bundle; `exports` decides what a consumer may import.
- Non-obvious design decisions: the *node* half is not declared in `dsh.client.inject` at all — the client and host halves are separate entry points, so a host-only deployment never loads the React half.
- Edge cases / failure handling: none here; the manifest declares no runtime dependencies beyond the typert protocol.
- Surprising: `peerDependencies` is only `@deepseek-ai/cordis`; everything else is a devDependency, i.e. the bundle inlines them.

### packages/client/ui-deliverables/README.i18n.yaml
Per-heading bilingual hash record: each English and Chinese block of a README section is hashed, so a one-sided edit is detectable by `pnpm run verify-translation-pairing --write`. A **machine-checked** translation-parity mechanism, not a convention.

### packages/client/ui-deliverables/README.md
- Purpose: the package reference a maintainer reads before touching the code.
- Key abstractions: the changed-files card, the `changes-review` right-Sidebar tab, the delivery cards, inline-code file mentions, and the model-facing file-reference guidance.
- Data flow: Host records a `workspace/changes` announcement → an authenticated summary route → the card; `present` records a delivery event → the delivery cards; successful mutation calls → the produced-file list → the mention resolver.
- Non-obvious design decisions: "Only the shipped Web patch loads this package; removing its cordis.yml entry removes the guidance, cards, and prose links together" — the three surfaces are composed as a unit, so no half-state is reachable.
- Edge cases / failure handling: a Host that no longer serves the summary leaves no card; a failed read is a state (`'error'` / `'missing'`), not an exception; binary and oversized files get their own status text instead of a diff.
- Surprising: the README has a "KV Cache effect" section, and for this package it says "None" — the repo consistently asks "does this touch the provider prefix?" even for pure UI packages.

### packages/client/ui-deliverables/README.zh.md
Chinese translation of the same reference; section-for-section identical, which is what the hash record enforces.

### packages/client/ui-deliverables/src/changes.ts
- Purpose: the wire contract between the Host routes and the browser card.
- Key abstractions: route constants (`CHANGED_FILES_PATH`, `CHANGES_DIFF_PATH`, `CHANGES_OPEN_PATH`), runtime type guards (`isChangedFile`, `isChangesSummary`, `isChangesDiff`, `isChangesEvent`), URL builders, and the `dsh-resource://changes-review/session/<id>/<seq>/<turn>` address with its parser.
- Data flow: the browser builds a URL from `(sessionId, seq, index)`; the Host answers with a record; the browser validates it with the guard before rendering.
- Non-obvious design decisions: the guards are *narrowing* validators written by hand rather than a schema library, so a malformed Host answer degrades to "no card" instead of throwing mid-render. The `ChangesSummary` type is `Pick<WorkspaceChangesSummary, 'turn'|'files'|'total'|'added'|'deleted'>` — the Host keeps the working directory and snapshot ids to itself, so the browser never learns a filesystem path it did not already have.
- Edge cases / failure handling: `parseChangesReviewAddress` rejects a malformed percent sequence in a `try/catch` and returns `undefined`; a non-numeric `seq` or a `turn` below 1 is rejected.
- Surprising: `CHANGED_FILES_ROUTE = CHANGED_FILES_PATH.slice(1)` — the browser-relative form is *derived* from the absolute path, so the two cannot drift.

### packages/client/ui-deliverables/src/client/ChangedFiles.module.css
Card chrome: a filled 60px header, a hairline border, monospace paths with a proportional font for the display path, green/red counts, a bottom fold control, and a `@media (pointer: coarse)` rule raising the row hit target to 44px.

### packages/client/ui-deliverables/src/client/ChangedFiles.tsx
- Purpose: the changed-files card a finished turn ends with.
- Key abstractions: `selectDeliverables` (does this turn claim the card?), `ChangedFiles` (the card), `ChangedFilePreview` (the hover comparison).
- Data flow: the summary is read through the injected `loadChangesSummary`; the hover preview reads a comparison through `loadChangesDiff` and the shared store.
- Non-obvious design decisions: the comparison is fetched **only while the hover card is open** — "Mounted only while its hover card is open, so passing over a row does not read a comparison." One file uses only the header (no file list); more than four files fold, and the header's line counts are replaced by a "Preview in sidebar" hint on hover/focus.
- Edge cases / failure handling: binary and oversized files render as a status word instead of counts; a failed comparison read offers a Retry.
- Surprising: the hover preview is **48px narrower than the card and inset 24px on each side**, with a 420px max height and a 100ms fade in and out — a deliberate "peek, don't take over" geometry.

### packages/client/ui-deliverables/src/client/changes-diff.ts
- Purpose: a fetch-once cache of per-file comparisons.
- Key abstractions: `ChangesDiffState = ChangesDiff | 'missing' | 'error' | 'loading'`, and a `HostReadStore` subclass.
- Data flow: `load(sessionId, seq, index)` → `loadUrl(changesDiffUrl(...))` → the shared store publishes a state per URL.
- Non-obvious design decisions: **404 is `'missing'` and terminal; a transport or 500 failure is `'error'` and retryable** (`retryable: state => state === 'error'`). A comparison the Host no longer serves will never come back, so re-reading it is waste; a failed read may succeed, so it is retried.
- Edge cases / failure handling: a malformed body is treated as `'error'` (retryable), not as a crash.
- Surprising: the *summary* store, one file over, makes failures terminal instead — the two stores disagree deliberately.

### packages/client/ui-deliverables/src/client/changes-summary.ts
- Purpose: a fetch-once cache of turn summaries.
- Key abstractions: `ChangesSummaryState = ChangesSummary | 'missing' | 'loading'`.
- Data flow: as the diff store, but with a `retryable: () => false` policy.
- Non-obvious design decisions: **every** failure is `'missing'` and is never retried — a summary is a snapshot of one turn's announcement, and re-reading it cannot change the answer, so a retry would only cost a round trip.
- Edge cases / failure handling: a rejected response is indistinguishable from a 404 here, deliberately: the user sees "the contents of this turn's changes are no longer available" either way.
- Surprising: the asymmetry with `changes-diff.ts` (retry there, never retry here) is the point of having two stores.

### packages/client/ui-deliverables/src/client/Deliverables.module.css
Two-column delivery grid collapsing to one column under 620px, a 60px row, a 40px icon tile with a hairline border, and the success-fade keyframe whose delay and duration are driven by inline style from the controller.

### packages/client/ui-deliverables/src/client/Deliverables.tsx
- Purpose: the turn-tail entry that joins the changed-files card and the delivery cards.
- Key abstractions: `DeliverablesInjected` (the hooks and verbs the plugin injects), `selectDeliverables`, `DeliverablesTail`.
- Data flow: the owner turn is scanned for a `workspace/changes` announcement and for `deliverables/presented` events; both are read from the durable event stream, never from the prose.
- Non-obvious design decisions: the changed-files card is shown **only while the developer-tools preference is on** (`showCodeDiff: ctx.configForms.developerTools.enabled`); a single delivery fills the row, multiple deliveries form a two-column grid, and the list folds after four.
- Edge cases / failure handling: a summary the Host no longer serves leaves no card; the delivered-file list collapses with an `aria-expanded` toggle and a count.
- Surprising: turning the preference off hides the card *immediately* while keeping the recorded changes and the inline links.

### packages/client/ui-deliverables/src/client/file-actions.ts
The `SlotMap` declaration for `deliverables.file.actions` and `deliverables.review.file.actions`: a `list`-kind, `session`-scoped slot whose owner carries `actionUrl`, `available`, `pending` and `onAction(action, application)`. The review slot reuses the same owner type.

### packages/client/ui-deliverables/src/client/FileDiff.module.css
Diff layout: unified and split grids, separate gutter and line-number backgrounds, per-theme add/delete fills, and wrap handling that turns off horizontal scrolling.

### packages/client/ui-deliverables/src/client/FileDiff.tsx
- Purpose: the one diff renderer shared by the hover preview and the review tab.
- Key abstractions: `hunkRows` (numbered rows), `splitRows` (deletions aligned with the additions that follow), `MAX_RENDERED_LINES = 5000`, `HunkHighlights`.
- Data flow: a `ChangesDiff` from the Host → hunk rows → optional Shiki token spans → rendered lines.
- Non-obvious design decisions: **highlighting is hunk-local** — each rendered old and new hunk side is tokenized independently because the omitted source lines are unavailable; unknown suffixes stay plain. The tab draws at most 5,000 lines and then says so. A comparison with only additions or only deletions (including its context) is shown in the unified form regardless of the chosen view.
- Edge cases / failure handling: Shiki omits one terminal empty token row, so the code retains an aligned empty run for that source line rather than shifting the highlight by one.
- Surprising: `splitRows` pairs each run of deletions with the run of additions that follows it, row by row — an alignment rule chosen for readability rather than diff3.

### packages/client/ui-deliverables/src/client/host-read-store.ts
- Purpose: the generic fetch-once, URL-keyed read store that both change stores use.
- Key abstractions: `HostReadPolicy<T>` with `loading`, `failed`, `retryable(state)`, `decode(response)`, and `HostReadStore<T>` with `loadUrl`, `reset`, `dispose`.
- Data flow: `loadUrl(url)` → publish `loading` → `fetch` → `policy.decode` → publish. Each store decides what a response means.
- Non-obvious design decisions: **one read per URL while a state stands**, and the reset is *generation-based*: `reset()` aborts a per-generation `AbortController`, replaces it, and clears the map — so a read that was in flight when the connection was replaced cannot publish into the new state.
- Edge cases / failure handling: a transport failure publishes the policy's `failed` state "until the connection is replaced and the store reset"; `dispose()` aborts the lifetime signal and awaits every pending read, so no read can publish after disposal.
- Surprising: the retry decision lives in the *policy*, not in the store — the same store serves a never-retried summary and a retried comparison.

### packages/client/ui-deliverables/src/client/index.ts
- Purpose: the browser half's registration.
- Key abstractions: `deliverablesDefinition` (the turn-tail conversation event), the `conversation.chat.turnTail` slot, the `tool.call.toolview` slot keyed `present`, the `changes-review` tab type, and the `chatFileMentions` service.
- Data flow: the plugin mounts three stores, subscribes them to `connection/reset` (resetting the host and the two read caches), and provides `chatFileMentions` to the chat view.
- Non-obvious design decisions: the plugin owns **all policy** — the supported mutation calls, the mention matching, the row cap and the copy — "so composing this plugin out of cordis.yml removes every surface; the owning view renders an empty list and inert prose at zero cost." The `present` tool row is a separate slot entry from the turn-tail, so the tool row exists even when the tail is not rendered.
- Edge cases / failure handling: `ctx.effect(() => () => Promise.all([opener.dispose(), summaries.dispose(), diffs.dispose()]))` — disposal is registered so HMR cannot leave a stale opener publishing.
- Surprising: the comment on the `chatFileMentions` block: "The prose side of the same vocabulary: the chat view reaches this face via `ctx.get`, so its absence — this plugin composed out — is the off state." The *absence* of a service is a supported configuration.

### packages/client/ui-deliverables/src/client/locales.ts
The `deliverables` dictionary pair; `zh` is the key source of truth and `en` is typed as `Record<DeliverablesKey, string>`, so a missing or extra English key is a compile error. Includes the binary / oversized / created / deleted / unchanged / coarse / truncated diff-status vocabulary.

### packages/client/ui-deliverables/src/client/present-open.ts
- Purpose: the shared native-open status for delivery cards, the changed-files card and the closing-message mentions.
- Key abstractions: `PresentedOpenController` with `state` (phase per action URL) and `host` (desktop metadata), `PresentedOpenPhase = 'opening'|'opened'|'revealing'|'revealed'|'error'|'revealError'|'nativeUnavailable'`, `PRESENTED_SUCCESS_HOLD_MS = 5000`, `PRESENTED_SUCCESS_FADE_MS = 200`.
- Data flow: a click → `open()`/`openChanged()` → `openUrl` → `fetch` → publish the phase → schedule the expiry.
- Non-obvious design decisions: the phase is keyed by the **action URL**, so a delivery card, a changed-file card and an inline mention share one state machine and one pending flag. A second gesture while one is pending is a **no-op**, not a queue. Success holds for 5s then fades over 200ms and restores the description; a failure stays until the next attempt.
- Edge cases / failure handling: HTTP 422 becomes `nativeUnavailable` (a distinct, non-retryable state meaning "this file has no Host path"); a transport failure shares the retryable state with a Host open failure.
- Surprising: `resetHost()` aborts the metadata read and re-issues it *if one was loading* — the Host may have been replaced underneath.

### packages/client/ui-deliverables/src/client/PresentedFileCard.tsx
Delivery card: basename, file-type icon, a preview button whose title carries the full resolved path, the description with a trailing parenthesised (or full-width) suffix stripped, the contributed actions rendered as a sibling so no button nests inside a button, and a `role="status"` description that only exists while a phase is set.

### packages/client/ui-deliverables/src/client/PresentRow.module.css
Present-row styling: an ellipsised path span beside a fixed status word, a pre-wrapped output block, and an "inspect call" link.

### packages/client/ui-deliverables/src/client/PresentRow.tsx
- Purpose: the `present` tool's row in the transcript.
- Key abstractions: `PresentRow` splitting into `PreparingPresentRow` and `StartedPresentRow`; `fileNames(raw)` that parses partial streaming arguments.
- Data flow: the durable tool record's `argsRaw` and result content → a collapsed status line plus a disclosure of the result text.
- Non-obvious design decisions: the preparing stage is a **non-expandable** row that shows no filenames, creates no delivery cards and enables no file actions until the recorded call supplies arguments. `fileNames` returns the raw string when the JSON does not parse, so a truncated stream stays visible instead of blanking.
- Edge cases / failure handling: a settled call with `error.code === 'interrupted'` reads as `stopped`, an `isError` as `error`, otherwise `ok`; a non-text result item is stringified.
- Surprising: the row keeps its document icon and its recorded result across progress, success, failure and interruption.

### packages/client/ui-deliverables/src/client/review-definition.ts
The `changes-review` tab type: `kind: 'changes-review'`, `patterns: ['dsh-resource://changes-review/**']`, `priority: 'builtin'`, `canOpen` derived from the address parser and `title` derived from the turn number in the address. The tab's identity is the package id; the address is the content.

### packages/client/ui-deliverables/src/client/review-store.ts
- Purpose: per-tab review state (which file, split or unified, wrap or not, navigation revision).
- Key abstractions: `ReviewTabState`, `ReviewState.byTab`, and `createReviewStore()` as an `EngineStoreHandle`.
- Data flow: the tab body's navigation dispatch → `navigated(draft, tabId, revision, index)` → the store → the body.
- Non-obvious design decisions: **one bucket per tab**, so two reviews in one session keep their own choices; the first navigation on a tab *seeds* it as split and unwrapped, later navigations only move the index and the revision. A `forget` action drops the bucket when the tab record ends.
- Edge cases / failure handling: `bucket()` throws when a tab has no state — a loud failure rather than a silent default, because a missing bucket means the body rendered without its store.
- Surprising: `navigated` carries a *revision* so a late navigation for an older address cannot move the view.

### packages/client/ui-deliverables/src/client/ReviewTab.module.css
Review-tab chrome: the file selector, the added/deleted counts, the split and wrap tool buttons, and the status lines.

### packages/client/ui-deliverables/src/client/ReviewTab.tsx
- Purpose: the review tab body.
- Key abstractions: `ReviewInjected`, `navigatedIndex(params)` (a safe read of the navigation parameter), `Counts`.
- Data flow: the resource address → `parseChangesReviewAddress` → the session, event sequence and turn; the summary is read once; the selected file's comparison is read and cached; the diff renders.
- Non-obvious design decisions: the tab **parses its own address** rather than receiving the coordinates, so a tab restored from a URL is identical to one opened by a click. The summary is read once per coordinates and the comparison once per file, both through the shared caches. The view and wrap choices are per tab.
- Edge cases / failure handling: a summary still loading shows a status line; a missing summary shows "the contents of this turn's changes are no longer available"; a failed comparison read offers Retry; binary and oversized files show a one-line explanation.
- Surprising: the whole file is the **comparison of that turn**, not the file's current content — "the comparison is this turn's snapshot of the file, not its current content."

### packages/client/ui-deliverables/src/client/turn-deliverables.ts
- Purpose: turn-scoped derivation of produced files, deliveries and changed files, plus the inline-mention resolver.
- Key abstractions: `ProducedPath`, `PresentedPath`, `DeliverablesTurnData`, `mutationPath(name, argsRaw)`, `producedFileMentions(paths, openFile, label, operations)`.
- Data flow: the engine publishes turn data; the conversation's `tool/call` events carry `argsRaw`; a successful `write` / `edit` / `str_replace_editor` yields a path; `deliverables/presented` yields a delivery; the latest `workspace/changes` announcement yields the changes coordinate.
- Non-obvious design decisions: **produced paths come only from successful first-party mutation calls and their recorded file targets, and never from presentation data or the closing prose.** A `write` yields a path only when `content` is a string; an `edit` only when `old_string` is non-empty, `new_string` differs and `replace_all` is boolean-or-absent; `str_replace_editor` only for a complete `create`/`write`/`edit` command. The mention resolver refuses to guess: a value resolves only when **all** matching facts point at one file, and an ambiguous basename or argument path stays unclickable.
- Edge cases / failure handling: `JSON.parse` failure of the tool arguments returns `null` (no path), so a truncated stream never invents a file. The `argumentPath` alias lets a path written relatively (`./out/report.txt`) resolve to its recorded canonical target, but only when that alias is unique.
- Surprising: the resolver returns the full path as the link's `title` and the display name as its `label` — the visible text stays short while the hover carries the precise location.

### packages/client/ui-deliverables/src/css-modules.d.ts
Ambient module declarations for `*.module.css` and `*.css`.

### packages/client/ui-deliverables/src/index.ts
- Purpose: the node half — the static file-reference system prompt and the native-open routes.
- Key abstractions: `FILE_REFERENCE_PROMPT` (one paragraph), `inject` (the Host services required), `apply(ctx)`.
- Data flow: `ctx.systemPrompt.section({ name: 'ui:deliverable-file-references', order: ctx.systemPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES'), text: FILE_REFERENCE_PROMPT })` → the paragraph enters every request; `registerPresentOpen(ctx)` mounts the authenticated routes.
- Non-obvious design decisions: the **order is looked up by a named order key**, not by registration order, so plugin load order cannot change the prompt's shape. The paragraph contains negative guidance ("Do not call present just to list edited source files, or run commands to check whether a diff view will appear") and presentation rules ("Enclose Markdown file destinations in angle brackets", "keep full paths out of labels", "append :24 or :24–30, with no # or L in the line suffix").
- Edge cases / failure handling: the section disappears when the plugin is disposed, because it is registered on the prompt registry.
- Surprising: this is the **only model-facing text in the entire shard** — one paragraph, ~250 words, pinned verbatim by an inline snapshot in the test.

### packages/client/ui-deliverables/src/present-open.ts
- Purpose: the Host routes that serve the desktop metadata, the change summaries and comparisons, and open declared or changed files.
- Key abstractions: `registerPresentOpen(ctx)`, `failureStatus(error)`, `openVerified(...)`.
- Data flow: the browser's authenticated request → `ctx.connection.fetch.register` → a session/event lookup → `ctx.workspaceFiles.stat` (the Session's filesystem) → `ctx.sessionController.openWorkspacePath` → 204.
- Non-obvious design decisions: the routes are registered **inside Connection's authentication fence**, and every request is given `AbortSignal.any([request.signal, lifetime.signal])` so plugin teardown cancels in-flight reads. A changed file is opened by resolving it **through the viewed Session's filesystem** and by taking the Host path from the *summary's* working directory — the path the Host recorded — not from the browser. `failureStatus` translates a session-not-found, a workspace-file-not-found, a not-a-regular-file, `ENOENT` and `ENOTDIR` into 404 and everything else into 500.
- Edge cases / failure handling: an index the summary does not list is a 404 *before* any filesystem access; a Host with no desktop is a 409; a path that no longer maps onto a process path is a 422.
- Surprising: the error **bodies carry no path and no error detail** — a failed lookup answers with a generic sentence.

### packages/client/ui-deliverables/src/presented.ts
Route constants for `present.open` / `present.host`, the `PresentedHost` shape (`name`, `available`, `fileManager: 'finder'|'explorer'|'directory'|null`), the `isPresentedHost` / `isPresentedFile` / `isPresentedData` validators, the URL builder, and a `basename` helper that splits on **both** `/` and `\`. The comment on `PresentedHost` is the point: "file-manager names never derive from the browser's OS."

### packages/client/ui-deliverables/tests/changed-files-hover.client.spec.tsx
Proves the 500ms dwell (`advanceTimersByTime(499)` → no read; `+1` → the read), the lazy read on hover only, the preview staying open when the pointer enters it, dismissal on Escape / outside pointer / activation, per-row independence, the Retry on a failed read, and that an unmount during the dwell cancels the read.

### packages/client/ui-deliverables/tests/changes-diff.client.spec.ts
The comparison-store contract: served and missing comparisons stick, failures retry, `reset()` empties the map and a read that was in flight during a reset never publishes, `dispose()` leaves the last state visible and prevents any later read.

### packages/client/ui-deliverables/tests/changes-open.host.spec.ts
Host-side status codes for the summary / diff / open routes, coordinate validation before any read, the 404 for an index the summary does not list, the 422 for a path that no longer maps onto a process path, the 400 for an unsupported action, and the rule that an error body names no path.

### packages/client/ui-deliverables/tests/deliverables.client.spec.tsx
The derivation contract (which tool names yield a path, when a `write` with no content yields none, how the changes announcement is picked), the card's rendering and opener wiring, the mention resolver's ambiguity rules, the plugin registration against a real `SlotRegistry`, and the fiber-teardown removal that proves HMR safety.

### packages/client/ui-deliverables/tests/file-actions.tsx
A ten-line slot renderer stub that exposes the owning action route and gesture so the component tests do not reimplement the opening control.

### packages/client/ui-deliverables/tests/present-open.client.spec.ts
The open controller's contract: two concurrent gestures on the same coordinates make **one** fetch, a second gesture is allowed after the first settles, a 500 and a transport rejection both publish a retryable `'error'`, a 422 publishes `nativeUnavailable`, disposal awaits the pending request and prevents any state publication or new request, and the success expiry fires at 5s + 200ms.

### packages/client/ui-deliverables/tests/present-open.host.spec.ts
The Host-side native open: the file's **current** bytes are opened (a fork's own workspace), a symlinked file is refused, a cancelled request answers before the lookup, a disposed plugin aborts a pending launch, and the application list is served by `GET` with the `POST` action carrying the application id.

### packages/client/ui-deliverables/tests/present-row.client.spec.tsx
The present row's lifecycle: preparing renders a non-expandable row and does not subscribe to disclosure resets; running / error / stopped states; tolerance of six malformed argument strings including `''`, `'{'`, `'null'`, `'[]'` and a mixed array; orphaned error details; and a non-text result item.

### packages/client/ui-deliverables/tests/presented-file-card.client.spec.tsx
Localization of the reveal failure, the directory-only wording in both dictionaries, basename shown while the full path stays in the title, the trailing `(.pdf)` / `（PDF）` suffix stripped, and the contributed action clicking without triggering the preview.

### packages/client/ui-deliverables/tests/prompt.host.spec.ts
Pins the **exact** system-prompt paragraph with an inline snapshot, proves the section exists only while the plugin is mounted, and checks the two shipped Web prompt snapshots under `snapshots/web/` contain it.

### packages/client/ui-deliverables/tests/review-tab.client.spec.tsx
The address round trip, the tab definition's shape, the per-tab store, `hunkRows` / `splitRows` / `renderedHunks` and the 5,000-line cap, the keyboard walk, the focus handover, and every state the tab body draws (loading, missing, error, binary, oversized, created, deleted, unchanged, coarse, truncated).

### packages/client/ui-deliverables/tests/turn-tail-spacing.client.spec.ts
A source-text test over the CSS: the first file section keeps a 4px top offset and the second drops to 0, the delivery row is 60px with 8px/10px padding, the icon tile is 40px with a hairline border, and the type scale is asserted with regular expressions.

### packages/client/ui-deliverables/tsconfig.client.json
Browser TS project: `src` included, project references to the slot, primitive, remote, locale, renderer, conversation, chat, settings, session, llm, system-prompt, tool-present, workspace-changes, session-controller, workspace-files, fs, typert and sandbox-policy packages.

### packages/client/ui-deliverables/tsconfig.host.json
Host TS project: `src/index.ts`, `src/changes.ts`, `src/presented.ts`, `src/present-open.ts` with their references.

### packages/client/ui-deliverables/tsconfig.json
Solution file referencing the host and client projects.

### packages/client/ui-deliverables/tsdown.config.ts
`clientBundle(import.meta.dirname, ['lib/types/index.js'])` — the shared bundle helper every client package uses.

### packages/client/ui-directory-picker-browse/locale/en.json
Package listing metadata: `meta.title` only.

### packages/client/ui-directory-picker-browse/locale/zh.json
Chinese listing metadata with a description.

### packages/client/ui-directory-picker-browse/package.json
Manifest: `dsh.client.inject` names `api-remotes`, `ui-renderer`, `ui-workspace` and `client-locale`; no runtime dependencies, so the package is pure chrome.

### packages/client/ui-directory-picker-browse/README.i18n.yaml
Bilingual hash record for the README pair.

### packages/client/ui-directory-picker-browse/README.md
The package reference: the 680×500 Miller-column dialog clamped to short and narrow viewports, the header with the breadcrumb and a click-to-edit path zone, the one-column-then-two-columns model, the "New folder" nested dialog, the client-side hidden-entry toggle, and the stated limits (no search, no multi-select, no rename, no delete).

### packages/client/ui-directory-picker-browse/README.zh.md
Chinese translation of the browse reference.

### packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.module.css
The 386-line stylesheet: the doubled `.dialog.dialog` selector (so the card wins against the Modal's own rule regardless of stylesheet order), the `100dvh` height clamp so Open/Cancel stay reachable on a short viewport, the crumb bar that *is* the editor's box, the `:has()` rule that lights the bar only for the edit affordance and never for a crumb, and the Miller row that scrolls horizontally under a fixed column width.

### packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx
- Purpose: the in-app workspace-directory browser.
- Key abstractions: `DirectoryBrowserProps`, the draft/crumb machinery (`readDraft`, `displayCrumbs`), the scan generation counter, the focus-parking flags (`refocusPathInput`, `refocusPick`, `refocusEditZone`), and the nested create dialog.
- Data flow: a click or a typed path → a scan of the target level → the parent leg → one committed two-pane frame; the last path segment prefix-filters the last pane while any other directory part is scanned after a debounce.
- Non-obvious design decisions: **navigations land selection-anchored and quiet** — the previous view keeps rendering while the scan runs and the target and parent legs land *as one frame*, so navigation never flashes an intermediate state. A slow parent leg falls back to landing the target alone at a wait bound and upgrading in place. A stale pane the draft has walked away from **holds still** rather than narrowing first, because narrowing it would move the view twice for one keystroke. The path editor's tail filters only the last pane, and only while that pane is the level the draft names.
- Edge cases / failure handling: a superseded scan is aborted on the wire; a failed scan keeps the panes and stays silent; the nested create dialog makes every parent control inert (Modal has no focus trap); an in-flight adoption pins the flow so dismissing it would leave the owner's `createWorkspace` to land after an apparent cancel; a path the parent level does not list falls back to the single-pane landing; Windows case folding is applied when anchoring the upgrade on the parent level's actual entry.
- Surprising: the file opens with a 35-line doc comment that is a complete behavioural specification — the repo treats component headers as the specification, and the code follows the prose line for line.

### packages/client/ui-directory-picker-browse/src/client/flow.ts
The occupant: maps the owner's `onPicked` / `onCancel` onto the dialog's `onOpen` / `onClose` and deliberately **never drives the owner's `onError`** — browse failures stay in the dialog's own alert surfaces.

### packages/client/ui-directory-picker-browse/src/client/index.ts
- Purpose: register the browse flow into the two directory-flow holes.
- Key abstractions: `LOCALE_NS = 'directory-browser'`, the `injected` face, and the nested `ctx.slots.inject(...)` generator.
- Data flow: the two locale dictionaries land as a unit; `BrowseDirectoryFlow` is registered under `conversation.hero.workspace.directoryFlow` and `sidebar.workspaces.directoryFlow`.
- Non-obvious design decisions: the two dictionaries are registered inside a `try/catch` that **rolls back the first registration if the second throws** — "a failed activation must not squat the namespace's other locale." The two slot registrations are made one **transactional effect** through nested `slots.inject()` calls, because either declaring entry may activate later or replace its declaration; the nesting order is explicitly arbitrary.
- Edge cases / failure handling: the rollback disposes the already-registered dictionaries in reverse order before rethrowing.
- Surprising: the plugin body reads `ctx.uiWorkspace.listDirectory` / `createDirectory` but the *node* half is empty — the two halves compose from one `cordis.yml` row, so no client code branches on a capability kind.

### packages/client/ui-directory-picker-browse/src/css-modules.d.ts
Ambient CSS module declarations.

### packages/client/ui-directory-picker-browse/src/index.ts
An inert `apply()` whose doc comment explains that it exists only so the plugin appears in the host `cordis.yml` / Loader.

### packages/client/ui-directory-picker-browse/tests/client-flow.client.spec.tsx
Slot lifecycle against a real `SlotRegistry`: both holes fill whether the declaration precedes or follows `apply`, the fiber going down empties the holes, a rival occupant in the second hole rolls the outer injection back, the locale rollback is proved, and the confirm / cancel routing is checked with `onError` never called.

### packages/client/ui-directory-picker-browse/tests/directory-browser.client.spec.tsx
A 1,760-line spec over the dialog. **I read the fixture (a five-node fake tree with hidden entries) and every test title, and the first 135 lines in full; I did not read all 1,760 lines.** The titles pin: the 500ms/30ms/100ms dwell windows, the single-frame two-pane landing, the wait-bound fallback, the abort of a superseded parent leg, the loading indicator's silence window, the truncated parent level, Windows case folding, focus re-parking, the draft's prefix filter and its walk-up behaviour, the nested create dialog, and the stale-response drops.

### packages/client/ui-directory-picker-browse/tsconfig.json
Browser TS project referencing the slot, primitive, remote, locale, renderer and workspace packages.

### packages/client/ui-directory-picker-browse/tsdown.config.ts
Shared client-bundle helper invocation.

### packages/client/ui-directory-picker-native/locale/en.json
Package listing metadata: `meta.title` only.

### packages/client/ui-directory-picker-native/locale/zh.json
Chinese listing metadata with a description.

### packages/client/ui-directory-picker-native/package.json
Manifest: `dsh.client.inject` names only `ui-renderer` and `ui-workspace` — the smallest dependency set in the shard.

### packages/client/ui-directory-picker-native/README.i18n.yaml
Bilingual hash record for the README pair.

### packages/client/ui-directory-picker-native/README.md
The package reference: a renderless occupant, the "one pick per rising `open` edge" rule, the Electron preload bridge versus the Host chooser, and the three stated limits (no cancellation of an open chooser, local carriers only, Linux without zenity/kdialog falls back to browse).

### packages/client/ui-directory-picker-native/README.zh.md
Chinese translation of the native picker reference.

### packages/client/ui-directory-picker-native/src/client/flow.ts
- Purpose: the renderless occupant that opens the OS chooser.
- Key abstractions: `NativeFlowInjected.pick`, the `armed` ref, the `outcome` ref, the `alive` ref.
- Data flow: `open` rises → `armed.current` flips true → `pick()` → the outcome is reported through `outcome.current` (the *latest* handlers, not the ones captured when the chooser opened).
- Non-obvious design decisions: the occupant **arms once per rising `open` edge**, so a re-render — or an adoption that keeps `open` true while `busy` — never launches a second chooser. Callbacks ride a ref so a settled pick reaches the owner's newest handlers. `alive.current` is re-armed in the effect setup because StrictMode's development replay runs the cleanup once before the real lifetime.
- Edge cases / failure handling: an unmount (HMR replacing the occupant) discards the settlement wholesale — the dead instance neither adopts a path nor drives the owner's error surface; the wire carries no per-request abort, so the chooser survives until answered and its answer lands nowhere, while the replacement instance re-arms under the owner's still-open request. A non-`Error` rejection is stringified.
- Surprising: an injected-face identity change alone (a re-registration) **keeps** the pending settlement, because the native chooser is still the same dialog.

### packages/client/ui-directory-picker-native/src/client/index.ts
Chooses `globalThis.__DSH_DIRECTORY_PICKER__.pick()` when the Desktop preload bridge is present, else `ctx.uiWorkspace.pickDirectory()`, and installs the occupant into both directory-flow holes with the same nested transactional `slots.inject` pattern as the browse variant.

### packages/client/ui-directory-picker-native/src/index.ts
An inert `apply()` loader seat.

### packages/client/ui-directory-picker-native/tests/client-flow.client.spec.tsx
Slot lifecycle plus the real `electron` module mocked through `createRequire` against the Desktop workspace's `package.json`; one pick per open, the outcome routed through the latest handlers, the discarded settlement after unmount, a non-`Error` rejection stringified, and the inert node half.

### packages/client/ui-directory-picker-native/tests/desktop-picker.client.spec.tsx
Composes the **real** `webApp` client roster with the native row (reading the package's own `dsh.client.inject` so the dependency declaration is the one under test) and proves that a cancellation goes through Desktop and never touches the Host chooser.

### packages/client/ui-directory-picker-native/tsconfig.json
Browser TS project referencing the slot, renderer and workspace packages.

### packages/client/ui-directory-picker-native/tsdown.config.ts
Shared client-bundle helper invocation.

### packages/client/ui-input-trigger/locale/en.json
Package listing metadata: `meta.title` only.

### packages/client/ui-input-trigger/locale/zh.json
Chinese listing metadata with a description.

### packages/client/ui-input-trigger/package.json
Manifest: `dsh.client.inject` names `api-session-controller`, `client-locale`, `ui-conversation` and `ui-renderer`; dev dependencies include `@deepseek-ai/dsh-file-reference` (the shared `@` grammar) and `dsh-util-values` (the `WeakMapWithValues`).

### packages/client/ui-input-trigger/README.i18n.yaml
Bilingual hash record for the README pair.

### packages/client/ui-input-trigger/README.md
- Purpose: the package reference for the trigger pipeline.
- Key abstractions: the three guard tiers, the pick paths (menu / space / enter), the drill action, the header crumbs, and the optional `matchSpace` / `matchEnter` / `matchClaim` hooks.
- Data flow: the composer detects a trigger under the caret → the per-session controller seeds the roster → each source is polled for candidates → the menu renders → a pick is routed to the source → the source returns a claim, an insert or a text outcome → the consuming input surface applies it.
- Non-obvious design decisions: **Space and Enter adjudication polls the sources in registration order and the first non-undefined answer wins**, so a source can refuse a submission it cannot consume whole. The core is split into `src/core/` (zero React / DOM / cordis) and `src/client/` (the wiring) so the detection and the reducer are testable without a DOM.
- Edge cases / failure handling: a source whose `header` hook throws is dropped and the rest of the menu survives; a rejecting source fails the whole adjudication; an aborted attempt signal stops the poll; a dismissed menu stays dismissed — the same token re-tracked with the same query keeps the menu closed, so restoring the caret cannot revive it.
- Surprising: the `listbox` role sits on the **scrolling viewport** rather than the bounded shell, because a breadcrumb header is not an option and a listbox may not carry one.

### packages/client/ui-input-trigger/README.zh.md
Chinese translation of the trigger pipeline reference.

### packages/client/ui-input-trigger/src/client/MenuView.module.css
Menu shell geometry, the overflow fade, the item and skeleton rows, the drill chevron affordance, the group-title rows and the breadcrumb header.

### packages/client/ui-input-trigger/src/client/MenuView.tsx
- Purpose: the candidate-menu overlay.
- Key abstractions: `MenuViewInjected`, `optionId(source, index)`, `MAX_HEIGHT = 400`, `TOP_MARGIN = 84`.
- Data flow: the menu store and the crumb store are read with `useSyncExternalStore`; the highlight is exposed through `aria-activedescendant` on the listbox.
- Data flow detail: rows pick on **mousedown** so the composer keeps focus (the combobox pattern); the browser therefore never scrolls the active option into view on a keyboard move, so the component does it itself.
- Non-obvious design decisions: a pending group **keeps showing the items it already had** and falls back to two skeleton rows only when it has none; the highlight is shared between pointer and keyboard (last input wins); the height is clamped to the space above the composer, re-measured on every store update because the composer grows.
- Edge cases / failure handling: a closed store renders `null` while the overlay slot stays mounted; a source with no dictionary entry shows its raw name (the lookup chain returns the key itself).
- Surprising: `TOP_MARGIN = 84` is derived from the conversation header's 76px block plus 8px of air — a magic number with its derivation in a comment.

### packages/client/ui-input-trigger/src/client/contract.ts
The frozen service contract: `registerSource(src)` and `sessionOf(actx)` — the two verbs the rest of the system may use.

### packages/client/ui-input-trigger/src/client/controller.ts
- Purpose: the per-session half of the trigger pipeline.
- Key abstractions: `InputTriggerController` with `menu`, `launcher`, `headers` stores, the `DismissedHit` token identity, and the fetch lifecycle.
- Data flow: `track` detects a hit → the roster is seeded → each source is asked for candidates → settlements are gated by the hit generation → the pick executes by dispatching the scoped input-mutation events (`begin-command`, `insert-reference`, `insert-text`).
- Non-obvious design decisions: the authoritative hit **outlives the menu close**, because space adjudication needs it after the menu is gone. A dismissal is remembered as a *token identity* (trigger + query + quoted flag + span bounds), so a bare re-track of the same token cannot revive the menu. The `headers` crumbs live on their **own** snapshot store, beside the menu store, so the frozen reducer stays unaware of them. A source's `warm` and `subscribeLexicon` callbacks are contained: a faulty source's setup failure is logged and the remaining controllers are still notified.
- Edge cases / failure handling: a failed source **drops its group silently** (a log only; there is no error UI tier), a failed fetch is aborted when a newer query supersedes it, and a controller that is disposed inerts every verb.
- Surprising: the same hit re-tracked with the same span only refreshes the revision stamp and **does not refetch**.

### packages/client/ui-input-trigger/src/client/index.ts
Mounts the `InputTriggerService`, registers the `slash.menu` dictionaries, and injects `MenuView` into the `conversation.input.overlay` slot, resolving the **per-session controller** from the slot's `sessionId` (the slot frame hands ids, not contexts). An unknown session id throws rather than failing silently.

### packages/client/ui-input-trigger/src/client/locales.ts
The `slash.menu` dictionaries: group titles keyed by source name (`command`, `skill`, `subagent`), the pending row, and the listbox / crumb aria labels.

### packages/client/ui-input-trigger/src/client/service.ts
- Purpose: the root half — the source registry and the per-session controller map.
- Key abstractions: `InputTriggerService` (a cordis `Service` registered as `inputTriggers`), `LiveState` (sources + `WeakMapWithValues<SessionBinding, InputTriggerController>`), and `SourceRoster`.
- Data flow: `registerSource(src)` → the roster → every live controller's `sourceAdded(src)`; `sessionOf(actx)` → the binding → the controller, created lazily and disposed by the scope's disposer.
- Non-obvious design decisions: **registration order is menu group order is poll order**, and the roster view sorts by an optional `order` field. Duplicate `(trigger, name)` pairs throw. All mutable state lives in one `live` holder because cordis service methods run behind a caller-context tracker, so mutation must go through one property read rather than field assignment on `this`.
- Edge cases / failure handling: a source registering after controller birth is warmed into every live controller; disposing a source drops its menu group in every controller. A locale change re-fetches every open menu.
- Surprising: `sessionOf` **throws** when the context no longer belongs to a retained session generation — "requires a retained Session scope."

### packages/client/ui-input-trigger/src/client/slots.ts
The `MenuViewInjected` face: the menu and crumb stores plus the pick / crumb / hover / dismiss routes.

### packages/client/ui-input-trigger/src/core/contract.ts
The frozen pure-core contract: `TriggerHit`, `MenuState` (with a monotonic per-hit `generation`), `MenuEvent` (six variants), and the `DetectTrigger` / `MenuReduce` / `ExactMatch` aliases.

### packages/client/ui-input-trigger/src/core/detect.ts
- Purpose: pure trigger detection at the caret.
- Key abstractions: `detectTrigger(draft, caret, guard)`, `boundaryOk(draft, index, char)`.
- Data flow: the draft text and the caret offset → a `TriggerHit` with `query`, `quoted`, `position` and `span`.
- Non-obvious design decisions: three **guard tiers** — `plain` (both chars live), `claimed` (`/` suppressed, `@` live), `frozen` (neither) — so a consumer that has claimed the `/` key can still offer file references. Two URL carve-outs keep `/` dead inside a URL: a `/` whose predecessor is a `:` that itself follows a non-whitespace character, and a `/` directly after another `/`. A suppressed `/` is **scanned through like an ordinary character** rather than ending the scan.
- Edge cases / failure handling: the backward scan stops at whitespace; a caret at 0 yields null; the `@` case reuses the shared file-reference grammar, which keeps an open quoted `@"docs/design notes` token active across spaces.
- Surprising: `span.draftRev` is a **placeholder 0** — the calling shell stamps the real revision, so the pure core never has to know about drafts.

### packages/client/ui-input-trigger/src/core/menu.ts
- Purpose: the pure menu reducer.
- Key abstractions: `MENU_CLOSED`, `seedGroups(state, sources)`, `menuReduce(state, ev)`, `exactMatch(groups, source, name)`.
- Data flow: the shell seeds the roster and dispatches `hit`; the reducer returns a new `MenuState` or the **same reference** for a stale or no-op event.
- Non-obvious design decisions: a `hit` while open (a query refinement) resets the groups to pending **under a new generation while keeping their items on screen** until the new fetch settles — stale-while-revalidate, so the list never blinks off between keystrokes. Settlement outside the current generation, outside the open menu, or against a roster that no longer holds the source is **dropped silently**. Auto-close fires when every group is ready with zero items. Closing preserves the generation so in-flight settlements stay droppable.
- Edge cases / failure handling: the highlight is validated against the groups and becomes null when it points at a group that is no longer ready or an index that no longer exists; `move` skips non-ready groups.
- Surprising: the frozen `hit` event carries **no source roster**, so the reducer cannot invent groups — the shell must seed the roster first. That is what keeps the reducer pure.

### packages/client/ui-input-trigger/src/css-modules.d.ts
Ambient CSS module declarations.

### packages/client/ui-input-trigger/src/index.ts
An inert `apply()` loader seat.

### packages/client/ui-input-trigger/src/types.ts
The provider contract: `InputTriggerCandidate` (name, optional label / description / icon / hint / section / value / `drill`), `InputTriggerCrumb` (label, opaque value, current-step flag), the `header` / `warm` / `subscribeLexicon` / `matchSpace` / `matchEnter` / `matchClaim` / `openReference` hooks, the `ReferenceCodec`, and `TriggerGuard` with its three tiers. The `ClientSessionContext` deliberately carries **identity only** — a source that needs an Agent-bound RPC must consult its own capability state.

### packages/client/ui-input-trigger/tests/apply.client.spec.ts
Real cordis `Context` wiring: the service mounts as `ctx.inputTriggers` once `sessions` is up, the overlay entry is registered with `id: 'slash-menu'` and `locale: 'slash.menu'`, the injected face resolves the *same* controller the service holds, the four verbs are no-ops on a closed menu, an unknown session id throws, and fiber teardown removes both the entry and the service.

### packages/client/ui-input-trigger/tests/core-detect.client.spec.ts
Detection rules: triggers at the start of the draft, after whitespace / newline / punctuation, and *not* after a word character (`user@host`, `a/b`); both URL slashes and a scheme colon are dead; a colon that is not a scheme separator still triggers; the scan stops at whitespace; the nearest trigger to the left wins; the leading/inline position; the three guard tiers; the quoted `@` span; the mid-token caret cutting the query; caret 0 and an empty draft; and a token on a later line of a multi-line draft.

### packages/client/ui-input-trigger/tests/core-menu.client.spec.ts
The reducer contract: opening a new generation with all groups pending, the re-hit keeping items and the highlight under a bumped generation, a hidden group title surviving a re-hit, a null hit closing, a no-op close returning the same reference, a settlement marking its group ready, the stale-generation drop, the silent group removal, the highlight cycling and its invalidation, and `exactMatch` returning null on a miss, a non-ready group and an unknown source.

### packages/client/ui-input-trigger/tests/menu-view.client.spec.tsx
A 376-line rendering spec. **I read the fixture, the helper functions and the first 130 lines in full** — closed renders null, groups render in roster order, pending groups render two skeleton rows, a localized label renders with the name as an alias, an icon component renders, and the description is right-aligned. The remaining titles cover the highlight's `aria-activedescendant`, the height clamp, the crumb header and the drill affordance.

### packages/client/ui-input-trigger/tests/service.client.spec.ts
A 1,320-line spec over the split architecture. **I read the header and every test title**, covering the registry (duplicate throw, disposal dropping live groups, late registration warming in), `sessionOf` (laziness, per-session isolation, a locale change re-fetching), `track` (generation supersession, aborting the old fetch, stale-while-revalidate, the same hit not refetching, a trigger with no sources never opening), the programmatic launcher, the scope-birth warm, the pick paths (claim / insert-reference / insert-text, the scope carrier routing, a foreign session's listener never hearing the dispatch), the header and drilled descent, the lexicon aggregation and re-publication, arbitration (arrow movement, hover, Enter, Escape and Shift+Tab, the sticky exit, the Tab drill, IME pass-through), `onSpace`, `adjudicate` and `resolveClaim`.

### packages/client/ui-input-trigger/tsconfig.json
Browser TS project referencing the session, locale, store, file-reference, primitives, renderer, conversation, session, input-trigger and slot packages.

### packages/client/ui-input-trigger/tsdown.config.ts
Shared client-bundle helper invocation.

### packages/client/ui-jobs/locale/en.json
Package listing metadata: `meta.title` only.

### packages/client/ui-jobs/locale/zh.json
Chinese listing metadata with a description.

### packages/client/ui-jobs/package.json
Manifest: `dsh.client.inject` names `api-job-controller`, `client-locale`, `ui-conversation` and `ui-primitives`.

### packages/client/ui-jobs/README.i18n.yaml
Bilingual hash record for the README pair.

### packages/client/ui-jobs/README.md
- Purpose: the package reference for the background-job list.
- Key abstractions: the `job.list` roster as the single source, the observation stream, the two-press stop control, and the `job.kill` Remote.
- Data flow: one `useEffect` keeps the session's roster stream open while the control lives; another opens the observation stream for the expanded row and closes it on collapse, unmount or popover close.
- Non-obvious design decisions: "**There is no second roster to join.**" The kill claims **nothing in the model's notice ledger**, so the owning agent still receives the standard completion notice — the model is told the user stopped its task rather than left to infer it. A settled job whose answer went to the model (a subagent) stays a static row because it retained no output.
- Edge cases / failure handling: a retention gap and a stream interruption render as notices above the panel; the panel copies the command, not the output; stdout and stderr concatenate into one stream (a stated limit).
- Surprising: the trigger renders **nothing at all** until the session can see at least one job — "an ordinary conversation never grows a control for a capability it is not using."

### packages/client/ui-jobs/README.zh.md
Chinese translation of the job list reference.

### packages/client/ui-jobs/src/client/JobListAction.module.css
The 322-line stylesheet: the trigger chip, the portaled menu, the row lines, the state dot, the stop button and its armed and failed states.

### packages/client/ui-jobs/src/client/JobListAction.tsx
- Purpose: the session-header job list.
- Key abstractions: `JobListInjected` (the `jobs` snapshot plus `watchRows`, `observe`, `killJob`), `isLive`, `isObservable`, `jobDetail`, and the kill state machine.
- Data flow: the roster snapshot → the live and settled sections; an expanded row → the observation stream → the embedded terminal panel; the stop button → `ctx.jobs.kill` → the row converges through the roster stream.
- Non-obvious design decisions: the stop control is a **two-press** action — the first press arms it, a confirming press within three seconds kills (`KILL_ARM_MS = 3_000`), and a failed kill keeps its hint for four seconds (`KILL_FAILED_MS = 4_000`) before the button resets. Arming a second row disarms the first. A kill that resolves after another row armed leaves the newer phase alone. The popover is **portaled to `document.body`** with fixed positioning so dock panels and clipping ancestors cannot cover it, and it is measured in an unplaced pass so `offsetWidth` is real.
- Edge cases / failure handling: Tab is **bridged** between the trigger and the portaled list; Escape closes; the list closes once the roster empties; an expanded panel whose row left the roster folds. The settled section folds behind its count while live work exists and opens by default when nothing is live.
- Surprising: the observation stream is opened by *visibility*, not by mount, so a collapsed panel costs nothing on the wire.

### packages/client/ui-jobs/src/client/index.ts
Registers the `job` dictionaries and **one** header-actions slot entry (id `job-list`, order 20 — after the preset label) bound to `ctx.jobs`; the plugin holds no transport state of its own.

### packages/client/ui-jobs/src/client/locales.ts
The `job` dictionary pair; `zh` is the key source of truth. It includes the plural pairs (`count.live.one` / `.other`), the status words, the duration formats, and the terminal-block labels (signal, exit code, command line, copy).

### packages/client/ui-jobs/src/css-modules.d.ts
Ambient declaration for `*.module.css` only (no bare `*.css`).

### packages/client/ui-jobs/src/index.ts
An inert `apply()` loader seat whose doc comment names the module path.

### packages/client/ui-jobs/tests/browser-plugin.client.spec.ts
The declared services, the injected roster / observation / kill face, the kill's admission verdict (`requested` or `already-finished`), the header entry's registration and its removal on fiber teardown, and the dictionary release (withdrawn dictionaries leave the key unresolved rather than translated).

### packages/client/ui-jobs/tests/job-list-action.client.spec.tsx
A 592-line component spec. **I read the fixture, the helpers and the first 115 lines in full** — nothing renders with no jobs, the roster watch is released on unmount, the trigger counts live jobs, and a settled job with no retained output is a static row. The remaining titles cover row ordering (live first by start, settled newest-first with tie-breaks so map iteration never decides), the duration tick, the observation lifecycle, the portaled anchoring, the Tab bridge, the retention-gap notice, and every phase of the human kill.

### packages/client/ui-jobs/tsconfig.json
Browser TS project referencing the job-controller, session-controller, locale, conversation, primitives, renderer, session and slot packages.

### packages/client/ui-jobs/tsdown.config.ts
Shared client-bundle helper invocation.

### packages/client/ui-message-feedback/locale/en.json
Package listing metadata: `meta.title` only.

### packages/client/ui-message-feedback/locale/zh.json
Chinese listing metadata with a description.

### packages/client/ui-message-feedback/package.json
Manifest: `dsh.client.inject` names `api-remotes`, `client-locale`, `ui-conversation`, `ui-renderer` and `ui-commands`; the only runtime dependency is the typert protocol.

### packages/client/ui-message-feedback/README.i18n.yaml
Bilingual hash record for the README pair.

### packages/client/ui-message-feedback/README.md
- Purpose: the package reference for the feedback surface.
- Key abstractions: the per-message Like/Dislike pair, the shared dialog, the acknowledgement and failure toasts, the `/feedback` decoration, and the `feedbackUi` service.
- Data flow: one `MessageFeedbackController` per session backs every message control and one `FeedbackDialogController` owns the draft; the message controller reads `messageFeedback.list` once, deferred to the first hover or focus, and serializes mutations.
- Non-obvious design decisions: **the conversation log travels with every feedback event**, and "ratings, categories, and notes are log-only Session events that never enter model context." A bare `/feedback` opens the dialog; `/feedback <text>` keeps the Host command path. Clicking a *recorded* rating retracts it without opening the dialog.
- Edge cases / failure handling: a submission failure shows in a warning toast while the dialog stays open so the draft can be corrected; only finalized messages reach the entry (an interruption-frozen partial carries no `messageId`).
- Surprising: the note size is a **Host policy** (`maxNoteBytes`, 8192 in the Web bundle) and the dialog does not pre-check it — an oversized description fails on submit, not while typing. That limit is stated, not fixed.

### packages/client/ui-message-feedback/README.zh.md
Chinese translation of the feedback surface reference.

### packages/client/ui-message-feedback/src/client/FeedbackDialog.module.css
Dialog geometry, the seven category chips with their active state, the growing detail field and the submit button.

### packages/client/ui-message-feedback/src/client/FeedbackDialog.tsx
- Purpose: the feedback dialog and its toasts, rendered as one `conversation.input.overlay` entry so each session owns exactly one of each.
- Key abstractions: `CATEGORY_CHIPS` (a complete record of the `FeedbackCategory` union, `satisfies Record<FeedbackCategory, true>`), `FAILURE_COPY`, the toast anchor probe.
- Data flow: the dialog store → the chips and the textarea → the injected `edit` / `submit` verbs; the toast is anchored over the composer card the entry renders inside (found by `closest('[data-composer-card]')`).
- Non-obvious design decisions: **a client bundle may not import a Host package's values**, so the category taxonomy is restated as a complete record — "a missing or foreign id is a compile error." The failure toast holds 6s against the success toast's shorter hold. The toast **retires with the entry that showed it**, so returning to the page does not replay it.
- Edge cases / failure handling: the form ignores edits and submits while a submission is in flight; a chip toggles the category (clicking the active one clears it).
- Surprising: only the "error" and "note-too-large" codes get their own copy; every other code reads the generic line.

### packages/client/ui-message-feedback/src/client/MessageFeedbackActions.module.css
Like/Dislike row styling; the slot-injected actions ride the content font-size axis like their host row, and a recorded rating uses the tertiary label colour.

### packages/client/ui-message-feedback/src/client/MessageFeedbackActions.tsx
- Purpose: the per-message Like/Dislike pair.
- Key abstractions: `seed` (a read on first interaction), `choose` (the retract-or-dialog decision), `errorCopy`.
- Data flow: the shared `feedback` view → the per-message item → the filled or outline glyph; a click → `ensure()` → `current(messageId)` → `retract` or `openDialog`.
- Non-obvious design decisions: the controls mount for **every** settled message in the transcript, so the session's feedback is read on the **first hover or focus**, not on mount. The decision waits for the seeding read, so a click on a cold row still sees the stored judgment. A recorded rating shows the filled glyph so the signal survives a pointer leaving the row.
- Edge cases / failure handling: an `alive` ref suppresses every state publication after unmount; a `version-conflict` failure gets its own copy ("changed elsewhere; the latest state is shown") and any other failure the generic one; a failed list load shows a load notice beside the buttons, and the action failure wins over it.
- Surprising: the Like and Dislike labels are *sentiment-free* in Chinese ("好的回答" / "有问题的回答") — a localisation choice, not a mechanism.

### packages/client/ui-message-feedback/src/client/controller.ts
- Purpose: the browser-local object layer over one session's durable feedback sidecar.
- Key abstractions: `MessageFeedbackController` with `getSnapshot()`, `ensure()`, `rate()`, `retract()`, `resync()`, `dispose()`, and the `MessageFeedbackView` (status, items map, error).
- Data flow: `ensure()` reads `messageFeedback.list` once; `rate` / `retract` send `ifVersion: observed.version`; a `version-conflict` reply carries the authoritative item and the controller **reconciles from the reply itself** rather than refetching the session.
- Non-obvious design decisions: the Host owns the per-item compare-and-set, and the browser carries the version it last observed. Mutations are **serialized per session**, so two clicks cannot interleave. `Object.freeze` does not protect a `Map`, and the file says so: immutability here is by discipline — every publish hands over a freshly built map the class keeps no mutable reference to.
- Edge cases / failure handling: a disposed controller refuses admission to `mutate`, so no disposal guard is needed in the publish path; `publish` contains subscriber failures at the observable boundary and logs them.
- Surprising: `describe(code)` maps business failure codes to human sentences in one switch, so the UI never renders a raw code.

### packages/client/ui-message-feedback/src/client/dialog.ts
- Purpose: the headless dialog and toast state.
- Key abstractions: `FeedbackDialogTarget` (session or message), `FeedbackDialogState`, and the `generation` counter.
- Data flow: `open(target)` → `edit(draft)` → `submitDraft()` → the owner's submit → success (close + acknowledge) or failure (keep the draft, publish the code).
- Non-obvious design decisions: a **generation counter** makes a late settlement recognisable: "the remark is recorded whichever draft is on screen now, so the toast always shows; only the draft that produced it closes." A success that lands after a reopen acknowledges without closing the new draft. A failure that lands after a dismissal is dropped entirely. The toast sequence is monotonic and `dismissToast(seq)` retires **only** the toast the view finished showing.
- Edge cases / failure handling: `edit` is refused while closed or while a submission is in flight; an empty draft is a valid submission; `dispose` drops the draft and the toast and orphans in-flight work.
- Surprising: one form serves two targets — the session itself (a bare `/feedback`) and one assistant message (Like or Dislike).

### packages/client/ui-message-feedback/src/client/index.ts
- Purpose: the browser half's registrations.
- Key abstractions: `FeedbackSurface` (the per-session pair), the `feedbackUi` service, the `feedback` entry (order 10) and the `feedback-dialog` entry (order 2), and the `/feedback` decoration.
- Data flow: one `FeedbackSurface` per session, created lazily and disposed with the plugin fiber; the `connection/reset` handler resyncs only the sessions that are **not cold** — "A reconnect can only invalidate what was already read; a cold Session stays cold until something asks for it."
- Non-obvious design decisions: the `/feedback` decoration is an `action` registered through `ctx.commandUi.decorate`, so a menu pick or a bare Enter consumes the trigger token and opens the dialog, while an argued line still reaches the Host command.
- Edge cases / failure handling: the surfaces map is cleared on disposal; `feedbackUi.openSession` opens the dialog **without recording feedback**.
- Surprising: the same `feedbackUi` service is what the Header's more-actions menu uses — the plugin is reusable by other packages without a slot of its own.

### packages/client/ui-message-feedback/src/client/locales.ts
The `feedback` dictionary pair plus the `LocaleNamespaceMap` merge declaring the `feedback` seat.

### packages/client/ui-message-feedback/src/client/slots.ts
The two injected faces: `MessageFeedbackInjected` (the shared view, `ensure`, `current`, `retract`, `openDialog`) and `FeedbackDialogInjected` (the shared state, `edit`, `submit`, `dismiss`, `dismissFailure`, `dismissToast`). The file notes that this package contributes entries only, so **no SlotMap merge lives here**.

### packages/client/ui-message-feedback/src/client/surface.ts
The per-session pair: the `MessageFeedbackController` and the `FeedbackDialogController`, with the dialog's submit routed by target — a message target goes through the feedback controller, a session target through `ctx.remote.sessionFeedback`.

### packages/client/ui-message-feedback/src/css-modules.d.ts
Ambient CSS module declarations.

### packages/client/ui-message-feedback/src/index.ts
An inert `apply()` loader seat.

### packages/client/ui-message-feedback/tests/browser-plugin.client.spec.tsx
Real `Context` wiring with fake slot and remote faces. **I read the header and every test title**: the entry ids, orders and locales, the injected verbs, one dialog per session shared by the message entry and the decoration, `feedbackUi` opening without recording, a session remark through the `sessionFeedback` Remote versus a message judgment through `put`, the carrier failure versus the Host rejection, one controller shared across every message of a session, separate sessions on separate controllers, the retraction routed only when it matches, the resync of already-read sessions on connection reset, and the withdrawal of the registrations with the fiber.

### packages/client/ui-message-feedback/tests/controller.client.spec.ts
The compare-and-set contract. **I read the header and every test title**: the view seeded from one list read and keyed by message id, the version carried on a mutation, a conflict reconciled from the reply's authoritative item without a refetch, mutation serialization, and the disposal behaviour.

### packages/client/ui-message-feedback/tests/dialog.client.spec.ts
The dialog controller contract. **I read the header and every test title**: the closed start, the open-and-dismiss draft, edits and submits refused while closed, the session and message targets, the empty draft, the rejected submission keeping the draft open with its code, the failure toast retired without closing the draft, the frozen draft during an in-flight submit, a success that lands after a reopen, a failure that lands after a dismissal, the toast retirement, and the toast surviving a dismiss but not a dispose.

### packages/client/ui-message-feedback/tests/feedback-dialog.client.spec.tsx
The dialog rendering. **I read the header and every test title**: seven chips, the detail box and the hint, a chip toggling the category, Submit routing to the controller and staying enabled with an empty draft, and the warning toast for a failure code.

### packages/client/ui-message-feedback/tests/message-feedback-actions.client.spec.tsx
The rating row. **I read the header and every test title**: the filled glyph for a recorded rating, either unrecorded rating opening the dialog, the recorded rating retracting it, the read on first interaction rather than on mount, the conflict copy, the generic copy, the failed list load notice, and no state published after an unmount at each of the three points in the flight.

### packages/client/ui-message-feedback/tests/styles.client.spec.ts
- Purpose: a stylesheet contract asserted against the CSS text on disk.
- Key abstractions: a scan of every `--dsw-` / `--dsh-` / `--ds-` custom property the sheets use, checked against **every** theme sheet (not just the platform tokens).
- Data flow: the sheets are read from disk, the theme tokens are concatenated from `ui-theme/src/styles/*.css`, and the names are compared.
- Non-obvious design decisions: the file carries the story of the bug that motivated it — `border`, `background` and the primary button's fill and label each named a token that did not exist, so **every one of those declarations was invalid at computed-value time and dropped**; the note editor shipped with no border and no surface and its Save button with neither fill nor readable label, and *nothing downstream reports this* because the sheet parses, the classes attach and the DOM snapshots are unchanged.
- Edge cases / failure handling: a **vacuity guard** — the sheet has to actually name tokens, or the filter below would pass vacuously.
- Surprising: a static test over CSS text is the only thing in this repo that could have caught it.

### packages/client/ui-message-feedback/tsconfig.json
Browser TS project referencing the remotes, message-feedback, command-feedback, session, typert, locale, chat, renderer, session, conversation, primitives and slot packages.

### packages/client/ui-message-feedback/tsdown.config.ts
Shared client-bundle helper invocation.

### packages/client/ui-model-selection/locale/en.json
Package listing metadata: `meta.title` only.

### packages/client/ui-model-selection/locale/zh.json
Chinese listing metadata with a description.

### packages/client/ui-model-selection/package.json
Manifest: `dsh.client.inject` names `api-session-controller`, `client-locale`, `ui-commands` and `api-remotes`; dev dependencies include `product-analytics` and `input-trigger`.

### packages/client/ui-model-selection/README.i18n.yaml
Bilingual hash record for the README pair.

### packages/client/ui-model-selection/README.md
- Purpose: the package reference for model selection.
- Key abstractions: the two entries (the `/model` popup and the composer seat), the shared per-session directory, the provider-grouped catalog, and the reasoning-effort list.
- Data flow: both entries read the same `ModelDirectory` store; a pick calls `session.selectModel`; the durable selection projection comes back from the session history.
- Non-obvious design decisions: **exact-model reasoning metadata and the selected effort come from the Host**, not from a client-owned vocabulary — so a model with no reasoning metadata simply has no Effort row. A complete selection applies to the **next** request; a running step keeps the model and effort it started with. The search field appears only above four models; the `/model` command always keeps its search field.
- Edge cases / failure handling: removing a model or provider — including account sign-out — **preserves** the stored provider, model and effort without displaying their IDs, and restoring the catalog entry restores its name. A rejected selection is announced through a toast anchored to the composer card; a `session/writer-held` error gets its own copy about another DSH instance holding the session.
- Surprising: addressed subagent sessions expose **neither** entry, because those Agent-bound RPCs would activate persisted history outside the direct-parent continuation path.

### packages/client/ui-model-selection/README.zh.md
Chinese translation of the model selection reference.

### packages/client/ui-model-selection/src/client/ModelSelect.module.css
The seat chip geometry, the menu card, the provider group headings, the search row, the option rows and the pending spinner.

### packages/client/ui-model-selection/src/client/ModelSelect.tsx
- Purpose: the composer's named model seat.
- Key abstractions: `Pane = 'root' | 'model' | 'effort'`, `EffortChoice`, `ModelSelectInjected`, and the model-label slot.
- Data flow: the shared directory store → the root pane (Model / Effort) → a drilled pane (the provider-grouped list or the effort levels) → `select(selection)` → the Host.
- Non-obvious design decisions: the menu is **portaled to `document.body`** and placed with fixed coordinates so the sidebar and column overflow cannot crop it, while synthetic events still bubble through the React subtree so the root's `onKeyDown` / `onBlur` keep working. Focus rules are exacting: selecting restores trigger focus **without a ring** until the trigger loses focus or the menu reopens; a drilled pane focuses the current effort or model search field; returning to the root pane hands focus back to the cell that opened it. The `onMouseDown` handler calls `preventDefault` on buttons because WebKit blurs a focused row before the click otherwise. Model names match a case-insensitive ordered subsequence within each provider group, ranked by prefix, then alignment score, then catalog order.
- Edge cases / failure handling: while a selection is pending the trigger shows a spinner **in place of its chevron** and each row carrying the pending value shows one in place of its check mark; a rejected selection leaves the menu open. A pane with no rows stays navigable and keeps its retry reachable. The trigger is `disabled` when the session is locked.
- Surprising: the trigger's label and its aria label are **different strings** — `trigger.fallback` ("Select model") is the visible caption, `trigger.selectAria` is the accessible name, and `trigger.aria` / `trigger.ariaEffort` are the populated forms. Getting one right and the other wrong is a common and invisible bug.

### packages/client/ui-model-selection/src/client/catalog.ts
- Purpose: the model catalog, shared by every session.
- Key abstractions: `ModelCatalogDirectory` with `store`, `reasoningFor(selection)` and the `generation` counter.
- Data flow: `load()` → `ctx.remote.session.modelCatalog()` → the catalog plus a `reasoning` metadata cache keyed by `JSON.stringify([provider, model])`; `invalidate(clear)` bumps the generation; `resetGeneration()` clears the cache and reloads.
- Non-obvious design decisions: **at most one catalog is loaded for the current Host generation** — concurrent callers share the in-flight promise, and a response from a superseded generation is discarded rather than published. The reasoning metadata is kept **even for models that are unavailable**, so an effort caption survives a catalog that no longer lists the model.
- Edge cases / failure handling: a failed load publishes `status: 'error'` with the RPC code and message, and the shared failure surfaces on the selector; `refresh()` keeps the previous value visible (only a *generation* reset clears it).
- Surprising: the reasoning cache is keyed by a JSON-encoded tuple rather than a nested map — a deliberate choice to keep one flat map with one eviction rule.

### packages/client/ui-model-selection/src/client/directory.ts
- Purpose: the per-session model directory.
- Key abstractions: `ModelDirectoryState` (current, retainedEffort, routable, groups, failures, status, pending, error) and `ModelDirectory`.
- Data flow: the shared catalog's store + the session's `modelSelection` projection → `syncInputs()` → the directory store; `select(selection)` → `session.selectModel` → the projection comes back → the store updates.
- Non-obvious design decisions: the **saved selection is retained even when its provider or model leaves the catalog**, and `routable` records separately whether it is still available — so the UI can say "this model is not available" instead of silently substituting another one. A generation counter makes "the latest selection operation wins; an older response never overwrites a newer one." The effective effort is **retained** when the model is unavailable, so the caption does not flicker away.
- Edge cases / failure handling: a provider-local failure is listed separately from a whole-request failure, and the usable groups stay usable.
- Surprising: `current` comes from the **durable projection** (`projected.next`) and falls back to the catalog's default — the client's optimistic guess is never the source of truth.

### packages/client/ui-model-selection/src/client/index.ts
Registers the `/model` popupSelect contribution (with the failure rows rendered but never selectable) and the composer `conversation.input.model` seat, both over one `ModelDirectoryResolver`; a seat selection is what the popup marks active next — one shared state, two doors.

### packages/client/ui-model-selection/src/client/locales.ts
The `model` dictionary pair, including the separate `trigger.fallback` and `trigger.selectAria` keys and the writer-contention copy.

### packages/client/ui-model-selection/src/client/provider-order.ts
Twelve lines that both the composer seat and the command model picker call: account first, official second, everything else in catalog order, using `toSorted` so the input array is not mutated.

### packages/client/ui-model-selection/src/client/service.ts
- Purpose: the root owner of the per-session directories.
- Key abstractions: `ModelDirectoryResolver` (a cordis `Service` registered as `modelDirectories`) and the `WeakMapWithValues<SessionBinding, ModelDirectory>` map.
- Data flow: the constructor subscribes to `llm/adapters-updated`, `settings/document-updated`, `credentials/record-updated` and `credentials/reference-updated` → `catalog.refresh()`; `connection/reset` → `catalog.resetGeneration()` and every directory's `resetConnected()`.
- Non-obvious design decisions: the doc comment explains **why the host `dsh-scope` ScopedLayers registry does not belong here** — it derives scope from the host carrier mechanism while client scopes tag contexts with branded `SessionId` strings, and it models global + shadow named registries, which is not what this is. A per-session singleton with no global layer to merge. The catalog is loaded eagerly in the constructor so a later open finds it ready.
- Edge cases / failure handling: an unknown session fails loud in `directoryFor` — "resolved no scope" / "resolved no binding"; the scope's disposer disposes the directory and deletes the map entry.
- Surprising: the file's header comment names two sibling services (`InputTriggerService` / `CommandUiRuntime`) as the pattern to follow — the repo has a house style for per-session service state.

### packages/client/ui-model-selection/src/client/slots.ts
The `conversation.input.model.label` slot declaration (`kind: 'single'`, `scope: 'session'`, `inline: true`) with a worked example in the doc comment, and the `ModelSelectInjected` face. The slot is explicitly **non-interactive**: "selection controls remain owner-managed."

### packages/client/ui-model-selection/src/css-modules.d.ts
Ambient CSS module declarations.

### packages/client/ui-model-selection/src/index.ts
An inert `apply()` loader seat.

### packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts
The dual-entry contract over real session scopes. **I read the header and every test title**: the writer-contention error reaching the seat, the `/model` contribution and the seat registration, provider ordering, a seat selection becoming the popup's active row and the reverse, the account group localized in both locales, account models removed after sign-out, one directory instance shared per session and isolated across sessions, a pending selection dropped on connection reset with its late settlement ignored, the effective selection hidden until the reconnected catalog validates it, the selected model retained while its catalog refreshes, the last catalog retained on a refresh failure, scope disposal, the effort retained for existing and new sessions after credentials disappear, an unavailable durable selection retained without being rewritten, an unknown session failing loud, and both entries withheld from addressed subagent sessions.

### packages/client/ui-model-selection/tests/catalog.client.spec.ts
The catalog's generation fencing. **I read the header and every test title**: one failing request shared with the RPC error exposed and a retry permitted, a successful result from an invalidated generation not published, a failure from an invalidated generation not published, a refresh failure contained while the old data is retained, and the old data cleared on a failed Host reset.

### packages/client/ui-model-selection/tests/expected/account-first.txt
The expected provider ordering fixture: account, official, then the third-party groups in catalog order.

### packages/client/ui-model-selection/tests/expected/unselected-model.txt
The expected unselected-model trigger caption fixture (Chinese "请选择模型").

### packages/client/ui-model-selection/tests/model-select.client.spec.tsx
A ~1,000-line component spec. **I read the header and every test title**, covering the label slot (identical model names distinguished by provider across all placements, and the label restored on unload), the reasoning effort, a saved route absent from the catalog, the hidden saved id and effort when the provider or model disappears, the loading state until the catalog *and* the projection are both ready, the rejected-selection copy (with the writer-contention copy only for a held writer), the pending spinners across pane changes, the portaled card closing only on a truly-outside mousedown, the absence of an Agent-bound control for an addressed subagent, the full keyboard walk (arrows, Tab, Shift+Tab, the drilled-pane handover, a pane with no rows), the catalog-size switch at four models in both directions, the fuzzy name search, and the account-group localisation.

### packages/client/ui-model-selection/tsconfig.json
Browser TS project referencing the remotes, session-controller, locale, store, commands, conversation, primitives, renderer, session, input-trigger, slot, session-core, product-analytics and the util-values package.

### packages/client/ui-model-selection/tsdown.config.ts
Shared client-bundle helper invocation.

### packages/client/ui-open-in-app/locale/en.json
Package listing metadata: `meta.title` only.

### packages/client/ui-open-in-app/locale/zh.json
Chinese listing metadata with a description.

### packages/client/ui-open-in-app/package.json
Manifest: `dsh.client.inject` names ten browser packages including `client-shortcuts` and `ui-layout`; the dev dependencies include the host `dsh-host-open-in-app` package for its shared route constants.

### packages/client/ui-open-in-app/README.i18n.yaml
Bilingual hash record for the README pair.

### packages/client/ui-open-in-app/README.md
- Purpose: the package reference for the native "Open In…" controls.
- Key abstractions: the session-header split button, the file-preview split button, the empty-state button, the application menu, and the `workspace.openLocal` shortcut.
- Data flow: the app catalog comes from the Host's `open-in-app` routes; the file associations come from the Session Remote; the launch is a POST.
- Non-obvious design decisions: the menu says **"Show file location"**, not "Show in Finder" or "Show in Explorer" — "the menu names a capability the Host has, not which file manager it runs." The file menu has **no separate "Open in default app" row**; the default is marked "(default)" in the list. "Show file location" stays in a **fixed footer** separated from the scrolling applications.
- Edge cases / failure handling: a host without the capability renders none of the controls; a single available action renders a single button with no dropdown; the initial file-association load uses a gray skeleton icon; a failed query keeps reveal available.
- Surprising: the delivery cards keep their **own** opener — folding them onto these file controls is stated as deferred work, not done.

### packages/client/ui-open-in-app/README.zh.md
Chinese translation of the open-in-app reference.

### packages/client/ui-open-in-app/src/client/FileRouteAction.tsx
Adapts the **authorized** delivery / changed-file routes to the shared split button: the association query is a `fetch` on the route URL, and the actual open still goes through the owning session's `onAction` — "without bypassing the owning Session's authorization route."

### packages/client/ui-open-in-app/src/client/OpenInAppAction.tsx
The directory adapter: the installed-app catalog filtered to the nameable ids, the remembered choice with a first-app fallback, the launch operation, and the shortcut entry looked up from the shortcut catalog.

### packages/client/ui-open-in-app/src/client/OpenPathAction.tsx
The file adapter, shared by the document header and the unpreviewable empty state: the associations are resolved before the control renders, and the control is `null` without a desktop.

### packages/client/ui-open-in-app/src/client/OpenPathEmptyAction.tsx
The empty-state contribution reusing `FileOpenTarget` with the `empty` (prominent) variant.

### packages/client/ui-open-in-app/src/client/OpenTargetButton.module.css
The split-button geometry (24px compact, 36px prominent), the hairline pill, the chevron half and the loading skeleton.

### packages/client/ui-open-in-app/src/client/OpenTargetButton.tsx
- Purpose: the one split button used for files and directories.
- Key abstractions: `OpenTargetApplication`, `OpenTargetOperation` (`default` / `application` / `reveal`), and `useOpenTargetGesture`.
- Data flow: a click → the target adapter's `execute(operation)` → a failure kind or null → the toast.
- Non-obvious design decisions: **file reveal always stays last** and is the default only when no application is registered. Gestures are serialized by a ref (`inFlight`) so a repeated click is ignored *before* the busy state renders. The failure feedback is owned by the **control that initiated the gesture**, "so one failed request announces once, from the control the user pressed." The application icon has a per-image fallback so a missing icon degrades to a generic glyph.
- Edge cases / failure handling: the chevron refreshes the associations when the menu opens; the menu closes on Escape without a gesture; a failed association query keeps reveal available.
- Surprising: the same component renders the icon-only header control and the labelled prominent control — the difference is one `prominent` boolean and the CSS.

### packages/client/ui-open-in-app/src/client/applications.ts
The table of nameable application ids mapped to their label keys (40 entries: editors, terminals, git clients). An id with no key is **unnameable** and is filtered out of the UI entirely.

### packages/client/ui-open-in-app/src/client/controller.ts
- Purpose: the page-lifetime availability read, the persisted last choice, and the launch POST.
- Key abstractions: `OpenInAppController` with `apps`, `choice` (persisted under `dsh.open-in-app.choice`), `operation`, and `currentApp()`.
- Data flow: `load()` → the document-relative apps route → the id list; `launch(appId, path)` → a POST with `{ app, path }` → the busy state → idle or error.
- Non-obvious design decisions: the choice is **persisted across browser restarts and shared across sessions**; `choose()` refuses while a launch is busy, so a remembered choice cannot change mid-launch. `currentApp()` falls back to the first *nameable* app when the remembered one is gone. A failed availability read publishes an **empty list**, which renders no button at all rather than a broken one.
- Edge cases / failure handling: concurrent `load()` calls share one read; a non-OK answer or a non-array payload publishes an empty list; an HTTP failure on the launch is re-thrown so the control can announce it.
- Surprising: the same controller backs the session header *and* the file-tree header, so the two cannot disagree about the remembered application.

### packages/client/ui-open-in-app/src/client/file-applications.ts
- Purpose: shared, reference-counted file-association reads.
- Key abstractions: `useFileApplications(target, query, enabled)` over a `WeakMap<Query, Map<string, Entry>>` of shared entries.
- Data flow: the first consumer of a `(reader, target)` pair starts the query; the last one to leave cancels it and **discards the released result**; a `refresh` re-runs the query for everyone.
- Non-obvious design decisions: the key is the **query function identity plus the target**, so two mounted controls reading the same file through the same reader share one request. The map is a `WeakMap` keyed by the query, so a reader that dies takes its entries with it.
- Edge cases / failure handling: a disabled control is kept out of the query entirely; the result of a cancelled read is discarded even if it arrives afterwards.
- Surprising: this is a hand-rolled shared-query cache with a use-sync-external-store shape — the same role `useSWR` plays in other codebases.

### packages/client/ui-open-in-app/src/client/index.ts
- Purpose: the registrations and the shortcut.
- Key abstractions: `OpenInAppController` (directories), `OpenInAppPathController` (files), the `directoryInjected` and `pathInjected` faces, and the `workspace.openLocal` shortcut.
- Data flow: the session header and the file tree share the directory controller; the document preview and the unpreviewable state share the path controller; the shortcut resolves the target from the *current* session and the remembered app.
- Non-obvious design decisions: the shortcut's platform defaults differ — `desktop:*` uses `primary+alt` and `web:*` uses `primary+shift`. The target is `undefined` when a **global panel hides the session header** — "does not open a retained workspace while a global panel hides the Session header." The shortcut is `blocked` with a reason while a launch is in flight.
- Edge cases / failure handling: the controller is created once and `load()`ed eagerly; a failed keyboard launch is logged rather than shown.
- Surprising: the deliverables' two file-action slots are filled with `FileRouteAction` **here**, not in the deliverables plugin — the owning plugin declares the slot, the opener plugin fills it.

### packages/client/ui-open-in-app/src/client/locales.ts
The `open-in-app` dictionaries with a shared `PRODUCT_NAMES` table and the platform-neutral wording; the `path.reveal` string is "Show file location", deliberately not naming a file manager.

### packages/client/ui-open-in-app/src/client/open-failure-toast.tsx
A per-control failure banner whose **sequence** keys the toast, so the same failure text replays instead of sitting silently in place.

### packages/client/ui-open-in-app/src/client/open-path.ts
- Purpose: the desktop availability and the file-association reads over the Session Remote.
- Key abstractions: `OpenInAppPathController` with `desktop` (a `boolean | null` store) and the `openPath` / `applications` methods.
- Data flow: `load()` → `session.canOpenWorkspacePath()`; `openPath(path, action, application)` → `session.openWorkspacePath({ path, action? , application? })`; `applications(path, signal)` → `session.workspacePathApplications({ path }, signal)`.
- Non-obvious design decisions: the request shape **differs** between the two actions — a reveal carries `action: 'reveal'` and an explicit application is only sent on an open. A failed query resolves to `null`, which is **distinct from an empty handler list** — the UI can then say "could not get the application list" instead of "no applications".
- Edge cases / failure handling: a carrier rejection is swallowed so an unreachable Host reads as "no desktop" and the preview shows no path control rather than a broken one; the availability read is shared across concurrent calls.
- Surprising: `desktop` is tri-state (`null` = not yet answered, `false` = no desktop *or* a failed read) and the distinction between "not yet" and "no" is what lets the control render nothing instead of flashing.

### packages/client/ui-open-in-app/src/css-modules.d.ts
Ambient CSS module declarations.

### packages/client/ui-open-in-app/src/index.ts
An inert `apply()` loader seat.

### packages/client/ui-open-in-app/tests/browser-plugin.client.spec.ts
The slot lifecycle against the real `SlotRegistry`. **I read the header and every test title**: the refusal of an absent workspace, the failed keyboard launch, the captured directory and remembered app before dispatch, the shared pointer launch occupancy, the declared services, the global-panel guard, the two document-preview path controls behind one desktop answer and their removal on teardown, the session directory adapter sharing the controller with the file tree, the injected face, the empty availability list on a failed host read, the dictionary registration and release, and the English dictionary's key identity with the Chinese one.

### packages/client/ui-open-in-app/tests/controller.client.spec.ts
The controller's wire behaviour. **I read the header and every test title**: no platform-specific choice at the start, one shared availability read, an empty list for a non-OK answer and for a non-array payload, the document-relative availability route, the nameable-app filter with the choice fallback, the shared busy operation capturing its app and directory, the choice restored from the storage key, and the launch body with HTTP failures surfaced.

### packages/client/ui-open-in-app/tests/file-applications.client.spec.tsx
The shared association reads. **I read the header and every test title**: the initial read shared and a menu refresh published to both controls, cancellation only after the last consumer leaves with the released result discarded, and a disabled control kept out of the query.

### packages/client/ui-open-in-app/tests/file-route-action.client.spec.tsx
The authorized route actions. **I read the header and every test title**: the route query, a handler selection, reveal last, and reveal surviving an HTTP, transport or invalid-JSON query failure.

### packages/client/ui-open-in-app/tests/open-in-app-action.client.spec.tsx
The directory adapter. **I read the header and every test title**: the accelerator advertised, nothing rendered before availability or for unnameable ids, the remembered choice with its fallback, both buttons disabled and duplicate gestures ignored during a launch, a launch failure that does not change the remembered application, the application list with the default marked, a successful choice remembered, Escape without a launch, an icon fallback, the selected application named in the tooltip, no dropdown with a single application, and the displayed directory being followed when it changes.

### packages/client/ui-open-in-app/tests/open-path-action.client.spec.tsx
The document path controls. **I read the header and every test title**: nothing rendered while the desktop is unknown and nothing without one, opening in the default application and revealing from the menu, the default application offered in the menu too with Escape closing it without a gesture, both halves disabled while the gesture settles, the empty state, a failure announced once through its own toast, dismissal on schedule across a re-render, the current application list, an obsolete query ignored and a refresh when the menu opens, reveal last, the first registered application as the default, reveal as the default only when no application is registered, gesture coalescing before the busy state renders, and the skeleton while associations load.

### packages/client/ui-open-in-app/tests/open-path.client.spec.ts
The path controller. **I read the header and every test title**: one desktop read shared across concurrent loads, no desktop for a refusing Host / a failed answer / a rejecting carrier, the request shapes for open and reveal, the failure kinds, the association query, and the distinction between a failed query and an empty handler list.

### packages/client/ui-open-in-app/tsconfig.json
Browser TS project referencing the gateway, remotes, session-controller, host open-in-app, locale, store, conversation, layout, primitives, renderer, session, document-preview, files, deliverables, native-command, shortcuts and slot packages.

### packages/client/ui-open-in-app/tsdown.config.ts
Shared client-bundle helper invocation.

### packages/client/ui-permission-presets/locale/en.json
Package listing metadata: `meta.title` only.

### packages/client/ui-permission-presets/locale/zh.json
Chinese listing metadata with a description.

### packages/client/ui-permission-presets/package.json
Manifest: `dsh.client.inject` names `api-session-controller`, `client-connection`, `client-locale`, `ui-commands`, `ui-conversation`, `api-remotes` and `ui-settings`.

### packages/client/ui-permission-presets/README.i18n.yaml
Bilingual hash record for the README pair.

### packages/client/ui-permission-presets/README.md
- Purpose: the package reference for the permission surfaces.
- Key abstractions: the `/permission` popup decoration, the composer seat, the General-settings default row, and the shared process catalog.
- Data flow: the process catalog (what presets exist) and the session's `permissions` projection (what is current) are combined; a pick submits the `/permission <preset>` command line.
- Non-obvious design decisions: **the decoration owns only the bare invocation** — the host command keeps its catalog row, the argued path (`/permission <preset>` still switches directly) and the lifecycle logging, so both surfaces write through one path and the pushed projection frame is the confirmation. The `auto` preset is current-session-only: it is absent from the Settings row, and an explicitly typed `/permission auto` is already explicit consent. Visible Full access and Auto selections each require their own risk acknowledgement.
- Edge cases / failure handling: when the live catalog withdraws a preset the composer closes its pending confirmation and shows the session's current value instead of an unavailable optimistic pick. Every catalog invalidation closes an open picker or its confirmation **without consuming the draft**, while publishing the result of a read the picker waits for leaves it open with its failure and retry state.
- Surprising: the full-access acknowledgement copy is a paragraph of explicit risk language ("the agent will reduce confirmation steps and can execute sensitive operations, file modifications and external commands") — a UI that states the consequence rather than a generic "are you sure?".

### packages/client/ui-permission-presets/README.zh.md
Chinese translation of the permission preset reference.

### packages/client/ui-permission-presets/src/client/PermissionRow.module.css
The Settings row: title, description, and the preset selector pill.

### packages/client/ui-permission-presets/src/client/PermissionSelect.module.css
The composer permission chip, the EXP badge, and the container query that drops the label on a narrow composer.

### packages/client/ui-permission-presets/src/client/PermissionRow.tsx
- Purpose: the General-settings row for the new-session default preset.
- Key abstractions: `PermissionRowInjected` (the shared snapshot, `load`, `select`).
- Data flow: the shared `permission` snapshot → the current value and the option list → the `Menu` → `select(preset)`.
- Non-obvious design decisions: the row is `null` when the host does not expose permission settings at all. The **full-access preset goes through the same `RiskConfirmation` gate** as the composer chip, so there is one risk mechanism, not two. The control is disabled when the view is not writable, while loading or saving, or when there are no options.
- Edge cases / failure handling: a write error is shown in the description with `role="alert"`; the menu closes and the acknowledgement resets when the view stops being writable.
- Surprising: the row's whole job is a **future** default — "changing it never switches or rewrites the current session."

### packages/client/ui-permission-presets/src/client/PermissionSelect.tsx
- Purpose: the composer permission picker.
- Key abstractions: `PermissionSelectInjected`, `permissionGlyph(value)`, `optionBadge`, `optionDescription`.
- Data flow: the session's `permissions` projection (the current value) + the process catalog (the options) → the chip → the menu → `select(preset)`.
- Non-obvious design decisions: the option set is the **catalog's**, and the active mark is the **projection's** — "Options read the process catalog and the active mark reads the session's `permissions` projection." The `auto` option gets a locale-owned label, description and `EXP` badge while every other preset keeps the host's own copy. The selected composer control shows the mode **without** the badge.
- Edge cases / failure handling: the control revokes its open UI when the session is locked or when either source disappears; a withdrawn `auto` revokes its confirmation and its optimistic label; an unknown current value falls back rather than blanking.
- Surprising: `permissionGlyph` returns `undefined` for a host-configured preset outside the design set, so an unknown preset has **no icon** rather than a wrong one.

### packages/client/ui-permission-presets/src/client/catalog.ts
- Purpose: the process-wide permission catalog.
- Key abstractions: `PermissionCatalogDirectory` with `store` (`{ value }`) and `invalidations` (`{ count }`), plus the `epoch` counter.
- Data flow: the constructor subscribes to `permission-presets/catalog-changed` and to the connection generation **before the first read**; `load()` returns the active generation's complete catalog; `refresh()` forces a new read.
- Non-obvious design decisions: **two separate observables.** `invalidations` carries "one tick per catalog notification or connection-generation change" and exists because "consumers that must drop displayed options subscribe here instead of to `store`, whose publications also settle a read a displayed surface is waiting for." A data publication and an invalidation are different events and must not share a channel. `load()` waits for an active refresh to settle **before** a retained value can be reused, so an imperative popup open never serves a value the Host is already replacing.
- Edge cases / failure handling: `accepts(epoch, generationId)` fences every settlement by disposal, by the refresh epoch, **and** by the live connection generation — a stale-generation settlement is dropped, not applied. A winning failure clears the public snapshot (the composer seat disappears) while the slash picker stays available and shows the failure with its retry. Disposal is idempotent and revokes every late settlement's write access.
- Surprising: the class subscribes to the invalidation sources *in the constructor* specifically to close the "install/read race" — reading first and subscribing after loses an event that fires in between.

### packages/client/ui-permission-presets/src/client/settings-store.ts
- Purpose: the controller for the new-session default row.
- Key abstractions: `PermissionPresetSettingsController`, `PermissionSettingsState`, and `permissionDefaultOf(view, catalog)`.
- Data flow: the shared settings mirror (`SettingsDescribeFace`) → the descriptor and its revision → the options from the catalog → one `settings.mutate` write carrying the revision.
- Non-obvious design decisions: the write targets **only** `defaultPreset` and carries the descriptor revision, so a concurrent change is a conflict rather than a silent overwrite. `permissionDefaultOf` **throws** when the catalog does not advertise its own current default — a loud failure rather than a row offering a value the Host will refuse.
- Edge cases / failure handling: an absent namespace makes the row `unavailable` (it renders nothing); a non-writable view disables the control; a read failure is contained in the state as `error`; disposal stops deriving and suppresses in-flight writes.
- Surprising: the current value falls back to `catalog.defaultPreset` when the settings value is absent, so the row still shows something meaningful before anything is written.

### packages/client/ui-permission-presets/src/client/index.ts
- Purpose: the registrations and the `/permission` decoration.
- Key abstractions: `PermissionCatalogDirectory`, the `PermissionSelect` seat, the `PermissionRow` settings entry, and the `popupSelect` decoration.
- Data flow: the decoration's `options()` reads the catalog and marks the current value active; `onSelect` submits the `/permission <preset>` line; the composer seat and the slash popup share the one process catalog.
- Non-obvious design decisions: **availability follows the session projection alone**, not the catalog — "A missing catalog surfaces through `options()`, which keeps the picker's own retry entry reachable after a failed read instead of hiding the command." The decoration's `options()` **throws** when the presets are unavailable, and that throw is what the popup shell renders as a retry. An invalidation subscription **dismisses stale slash choices**.
- Edge cases / failure handling: the decoration is removed on disposal (HMR safety); a pick that does not match the current value is ignored.
- Surprising: the doc comment names the one thing the decoration must **not** do: "The decoration owns only the bare invocation; the host command keeps its catalog row, the argued path and the lifecycle logging."

### packages/client/ui-permission-presets/src/client/locales.ts
Two dictionaries: `settings.permission` (the row) and `permission.access` (the current-session picker), including the full-access and Auto-review risk paragraphs and the `EXP` badge string.

### packages/client/ui-permission-presets/src/client/presentation.ts
- Purpose: the preset display rules.
- Key abstractions: `FULL_ACCESS_PRESET = 'danger-full-access'`, `AUTO_REVIEW_PRESET = 'auto'`, `PRESET_LABEL_KEYS`, `displayPresetName`, `displayPermissionPreset`.
- Data flow: the machine value plus the host-supplied name → the label.
- Non-obvious design decisions: the built-in product label is used only when the host's name is **the value itself or the default English label** — an explicit host label is preserved unchanged. A kebab-case name that is not a built-in is title-cased; a non-kebab name is shown as written.
- Edge cases / failure handling: none; the function is total.
- Surprising: the machine value for full access is `danger-full-access` — the same string the August harness uses for its sandbox mode, which makes the two directly comparable.

### packages/client/ui-permission-presets/src/css-modules.d.ts
Ambient CSS module declarations.

### packages/client/ui-permission-presets/src/index.ts
An inert `apply()` loader seat.

### packages/client/ui-permission-presets/tests/browser-plugin.client.spec.ts
The decoration contract. **I read the header and every test title**: stale slash choices dismissed on an invalidation and the subscription removed on disposal, the popup decoration hung on the host command, availability from the projection with the current value marked active, the picker surviving a failed catalog read and recovering on the next open, the open picker and its retry kept through the real popup shell, a closed picker only when the catalog is invalidated, the Auto description localized instead of the host's English copy, a pick submitting the `/permission` line with rejection and unmatched throws, and the decoration removed on disposal.

### packages/client/ui-permission-presets/tests/catalog.client.spec.ts
The catalog directory's contract. **I read the header and every test title**: a retry only when a later popup load asks, the subscription established before the first read with the newest same-generation refresh winning, the public snapshot cleared when the winning refresh fails, waiting for the active refresh before serving a retained value, the hard clear on generation loss with stale settlements rejected, resynchronisation when a refresh or load observes a generation notification first, a late disposed settlement dropped with idempotent disposal, and a first-read RPC failure surfaced when no complete catalog exists.

### packages/client/ui-permission-presets/tests/permission-presets-row.client.spec.tsx
The Settings row. **I read the header and every test title**: loading the descriptor and selecting a new default, the explicit acknowledgement required before saving full access, a hidden unavailable namespace and a disabled read-only provider, and the loading state plus a contained write error.

### packages/client/ui-permission-presets/tests/permission-select.client.spec.tsx
The composer picker. **I read the header and every test title**: rendering only when both the session selection and the process catalog exist, the process options with an ordinary choice submitted optimistically, host labels preserved and the already-current row ignored, the menu closing on an outside pointer, the acknowledgement required and reset for Full access, Auto marked experimental with the current-session risk copy, the open UI revoked when locked or when a source disappears, the Auto confirmation and its optimistic label revoked when the catalog withdraws it, and an unknown current value falling back with a rejected optimistic choice cleared.

### packages/client/ui-permission-presets/tests/settings-store.client.spec.ts
The settings store. **I read the header and every test title**: the options derived from the catalog with the inferred default preserved, a `defaultPreset` write with optimistic concurrency, the row hidden when the namespace is absent, write failures contained, read failures contained and a no-op without a writable view, a mirror refresh followed without an own read once loaded, disposal stopping derivation and suppressing in-flight writes, and the wait for the catalog with catalog changes followed and invalid defaults contained.

### packages/client/ui-permission-presets/tsconfig.json
Browser TS project referencing the locale, connection, store, commands, conversation, primitives, renderer, session, input-trigger, slot, permission-presets, remotes, session-controller and settings packages.

### packages/client/ui-permission-presets/tsdown.config.ts
Shared client-bundle helper invocation.

### packages/client/ui-plugin-manager/locale/en.json
Package listing metadata: `meta.title` only.

### packages/client/ui-plugin-manager/locale/zh.json
Chinese listing metadata with a description.

### packages/client/ui-plugin-manager/package.json
Manifest: `dsh.client.inject` names `api-remotes`, `client-locale`, `ui-layout` and `ui-sidebar`; the package also exports a **host** typert entry (`./typert`) because it ships the registry probe; the runtime dependencies are `dsh-timeout`, `schemastery`, `zod` and the typert protocol.

### packages/client/ui-plugin-manager/README.i18n.yaml
Bilingual hash record for the README pair.

### packages/client/ui-plugin-manager/README.md
- Purpose: the 186-line package reference for the Plugins page.
- Key abstractions: the sidebar entry and the main panel, the install wizard, the registry probe, the script approval, the row switches, the configuration slots, the detail extension points and the contributed tabs.
- Data flow: the inventory and the bundles are read through `api-remotes` when the page is first opened; the Host announces changes through `plugin-manager/changed` and streams install output through `plugin-manager/install-log` and `plugin-manager/install-state`.
- Non-obvious design decisions: a **dependency without a bundle patch is not a plugin** and is not listed unless the profile selects it, in which case it carries a problem. Catalog entries keep their position after installation or removal. Switching a held-back bundle on adds it to the main list in the position the More page shows it, and switching it off leaves it on that page alone. The display text of an installed bundle falls back from the exported locale `meta` to the accessible `package.json` of a package-root plugin; a **subpath plugin never reads a `package.json`**.
- Edge cases / failure handling: a Host without a managed profile shows the page as unavailable; an installation-owned bundle has no uninstall action; a bundle that neither the profile nor the installation holds still offers uninstall, which only removes it from the profile's bundle list.
- Surprising: the page's own Dev Note points at two archived Agent Notes rather than restating the decisions — the repo keeps feature decisions in dated note files and links them.

### packages/client/ui-plugin-manager/README.zh.md
Chinese translation of the plugin manager reference.

### packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css
The 1,334-line page stylesheet. **I read the head and the class inventory**; it covers the page column, the group and card layout, the detail pages, the install wizard, the floating registry panel, the row list and the skeletons.

### packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx
- Purpose: the Plugins page — the largest single file in the shard at 1,815 lines.
- Key abstractions: `AddPluginMenu`, `EnableSwitch`, `packageStatus`, `CardHead`, `ListSkeleton`, `PackageArtwork`, `PackagePreview`, `RowSwitch`, `rowStateText`, `rowDotState`, `MetadataError`, `PackageDetail`, `SubjectBlock`, `SubjectCard`, `useInstallComposition`, `InstallDialog`, `ConfirmDialog`, and `PluginManagerPage` itself.
- Data flow: the controller's snapshot → the package list, the detail pages and the install wizard; the contributed slots (`plugins.item`, `plugins.bundle.config`, `plugins.row.config`, `plugins.bundle.activation`, `plugins.add.actions`, `plugins.tab`, `plugins.detail.actions`, `plugins.detail.badge`, `plugins.detail.section`) are rendered with the page's subject.
- Non-obvious design decisions: the **install wizard is a state machine with a screen per phase** — `checking`, `starting`, `running`, `cancelling`, `applying`, `unconfirmed`, `unknown`, `done`, `failed` — and each phase has its own title key. A failed run that left **install scripts undecided** shows them for approval *in place of* a plain retry. The registry panel is **portaled and floated over the dialog** so unfolding it never adds to the dialog's height, and the store folds it when a run starts so it shows at the spec only. The back button's meaning changes with the phase (`installEdit` / `installCancelAndEdit` / `cancel`) and it is disabled while the run is not stoppable. The page resets its selection when the panel is left, and a bundle an install just enabled is **highlighted and scrolled into view** for 2.4s without changing the user's current page.
- Edge cases / failure handling: the wizard's Escape folds the registry panel and goes no further (it stops propagation so the dialog under it does not also close). The install screen shows the registry attempt chain ("registry A → registry B, attempt 2 of 3") when the Host asked more than one. A failed run offers another registry only when the failure was at the registry the Host asked. The "unconfirmed" outcome gets its own copy distinct from "failed". `useInstallComposition` implements the IME guard.
- Surprising: the page supports **StrictMode effect replay and page remounts** without losing the requested bundle — the tests pin that specifically.

### packages/client/ui-plugin-manager/src/client/PluginRefreshToast.tsx
Hosts the refresh-failure toast in the `shell.overlay` slot so it survives navigating away from the Plugins panel.

### packages/client/ui-plugin-manager/src/client/PluginsPanelIcon.tsx
The sidebar's Plugins glyph; the sidebar owns the button, label and selected state.

### packages/client/ui-plugin-manager/src/client/assets.d.ts
Ambient declaration for embedded `*.svg` imports.

### packages/client/ui-plugin-manager/src/client/assets/badge-skill-preview.svg
**Skipped** (see *Files skipped*). A 640×300 SVG feature illustration for the badge-skill bundle, English. I opened the header (`<svg … viewBox="0 0 640 300">` plus a clip path) to confirm it is vector artwork with no logic.

### packages/client/ui-plugin-manager/src/client/assets/badge-skill-preview.zh.svg
**Skipped.** The Chinese variant of the same illustration; header opened only.

### packages/client/ui-plugin-manager/src/client/assets/voice-input-preview.svg
**Skipped.** A 640×300 SVG feature illustration for the voice-input bundle, English; header opened only.

### packages/client/ui-plugin-manager/src/client/assets/voice-input-preview.zh.svg
**Skipped.** The Chinese variant of the voice-input illustration; header opened only.

### packages/client/ui-plugin-manager/src/client/config-ledger.ts
- Purpose: the projection of which plugins bring their own configuration.
- Key abstractions: `ConfigLedger` (`items`, `bundles`, `rows`), `rowConfigKey(bundle, rowId)` and `configLedgerSource(ctx)`.
- Data flow: three slot ledgers (`plugins.item`, `plugins.bundle.config`, `plugins.row.config`) + the locale revision → one observable.
- Non-obvious design decisions: the projection **keeps its snapshot until one of the ledgers or the locale moves**, detected by comparing the slots' `getVersion()` numbers and the locale's `revision` — so a re-render never rebuilds the list. The locale is part of the version because a label is locale-dependent.
- Edge cases / failure handling: an entry with no id is listed under an empty title; a keyed entry with no key is skipped.
- Surprising: the row key is `bundle#rowId` — a namespaced key that cannot collide across bundles.

### packages/client/ui-plugin-manager/src/client/index.ts
- Purpose: the browser half's registrations.
- Key abstractions: `PANEL_ID = 'plugins'`, the `main` panel registration with its nine children slots, the `shell.overlay` refresh-toast entry, the `sidebar.panellist` entry, and the `pluginNavigation` service.
- Data flow: the controller is created once; the Host's `plugin-manager/changed` event, the install log, the install state and `connection/reset` all trigger a reload; `pluginNavigation.openBundle(name)` selects the panel and sets the view.
- Non-obvious design decisions: the panel is **global** — it belongs to the profile, not to a session. The `main` slot registration is a **generator** so the store, the panel and the `pluginNavigation` provision install as one transactional effect. The refresh listener is a no-op while the page has never been rendered ("A page never rendered holds no snapshot to refresh"), which avoids a read storm on every connection change.
- Edge cases / failure handling: the panel observer resets the view to the list when the panel is left; the controller is disposed with the plugin.
- Surprising: `pluginNavigation` is provided through `ctx.reflect.provide` and disposed by the same generator, so a reload cannot leave a stale navigation service.

### packages/client/ui-plugin-manager/src/client/locales.ts
The 455-line `pluginManager` dictionary pair. **I read the header and the first sixty keys**; the remainder is a flat key/value string table in the same shape (the rest is copy, not mechanism).

### packages/client/ui-plugin-manager/src/client/manager-store.ts
- Purpose: the 1,308-line controller holding the whole plugin-management state machine.
- Key abstractions: `PluginManagerState`, `InstallState` with its phase, `ManagerNotice` (six kinds), `FailedAction`, `PackageRow`, `PackageView`, `InstallRequest`, `RegistryChoice`, and `PluginManagerController`.
- Data flow: the controller reads the inventory and the bundles through the `pluginManager` / `pluginInventory` Remotes, re-reads after every action and after every `plugin-manager/changed` event, and drives the install through `inspect` → `installBundle` → the streamed log and progress.
- Non-obvious design decisions: **a lost reply is a third outcome, not a failure.** `request.replyLost` marks it, `installUncertain('result', …)` publishes the "unconfirmed" state, and `reconcileInstall()` re-asks the Host for the active result — an absent result is explicitly *unknown* rather than failed. A cancelling attempt has its own `{ waitingForStart }` shape, because a cancellation that lands before the run starts is a different thing from one that lands during it. The registry choice is **remembered across dialogs and page loads** under `dsh.plugin-manager.install-registry`, but a registry chosen by a Discover tab is `transient` and applies to that dialog only. `sanitizeInstallInput` runs before the install spec reaches analytics. The busy-key action runner serialises enable / disable / uninstall / row toggles so two writes cannot overlap.
- Edge cases / failure handling: a `generation` counter and a `disposed` flag revoke every late settlement; an action that throws is turned into a `ManagerNotice` with the action's name and the Host's refusal code; `reasonOf(error)` picks a refusal's reason over a transport's message; a host that returned no bundles still counts as a successful read (`hasCachedInventory`).
- Surprising: the install request carries a `requestId` (a random UUID) so the Host can correlate a reply with a request even after a reconnect, and the analytics attempt records the **sanitised** input and the duration.

### packages/client/ui-plugin-manager/src/client/navigation-store.ts
The 31-line engine store holding the page's `view` (list / more / package / item / row) and `tab` (the page's own `installed` or a contributed tab id).

### packages/client/ui-plugin-manager/src/client/presentation.ts
- Purpose: the display helpers.
- Key abstractions: `registryText`, `CODE_KEYS` (a `satisfies Record<ManagementError['code'], …>` map — a new Host refusal code is a **compile error**), `FAILED_KEYS`, `managementText`, `noticeText`, `packageText`, `rowText`, `restartText`, `shortName`.
- Data flow: the Host's codes and diagnostics → localized sentences.
- Non-obvious design decisions: the registry is named by **what it is**, not by what it is not: npm's own registry reads by name, a known mirror reads by name, any other registry reads by its **host**, and the host is always shown "for where the name alone would leave it unsaid". A registry the Host could not read names no registry and keeps the neutral default name. A URL that no longer parses is shown as written.
- Edge cases / failure handling: an incompatibility refusal produces one sentence per named package, then the remedy.
- Surprising: `CODE_KEYS` and `FAILED_KEYS` being `satisfies` records means the **Host's error vocabulary is a compile-time contract** with the UI.

### packages/client/ui-plugin-manager/src/client/sanitize-install-input.ts
Thirteen lines that classify a typed install spec: a registry package name (optionally scoped, optionally with a version) is kept verbatim; a git address becomes `'[git]'`; any other URL becomes `'[url]'`; anything else becomes `'[path-or-other]'`. The point is that **a URL carrying credentials never reaches a telemetry event**.

### packages/client/ui-plugin-manager/src/client/slot-contract.ts
- Purpose: the nine slots the page declares for other plugins.
- Key abstractions: `PluginConfigViewProps` (`view: 'summary' | 'page'`), `PluginRowRef`, `PluginPackageRef`, `PluginsSubject` (bundle / row / item), `PluginDetailProps`, `PluginActivationOwnerProps`, `PluginAddActionsProps`, `PluginTabProps`, `PluginTabInstall`, and `ConfigPageForm`.
- Data flow: a registrant merges the contract with `import type` and registers through `ctx.slots`; it never imports this package at runtime.
- Non-obvious design decisions: `view: 'summary'` renders a one-liner alone; `view: 'page'` renders the form **with the page's own save control**. Bundle configuration renders only `page`. A detail contribution is rendered with the subject and **decides from it whether to render at all**. The page draws the title, icon and crumb itself — a contributor never draws chrome.
- Edge cases / failure handling: the `ConfigPageForm` carries the accepted values and the `mutate` that submits them **together with the revision the editor read**, so a contributing plugin never talks to the settings API itself and cannot lose a race.
- Surprising: `summary` exists at all because an official card's one-liner and a row's missing-description fallback both need a text-only rendering of the same configuration.

### packages/client/ui-plugin-manager/src/client/tab-ledger.ts
The 42-line projection of the `plugins.tab` ledger, following the same slot-version + locale-revision pattern as the config ledger.

### packages/client/ui-plugin-manager/src/css-modules.d.ts
Ambient CSS module declarations.

### packages/client/ui-plugin-manager/src/index.ts
- Purpose: the **host** half — the registry probe.
- Key abstractions: `PluginRegistryProbe` (a `TypertRemoteService` registered as `pluginRegistryProbe`) with a `Config` of three knobs.
- Data flow: the `@Remote fastest()` method → a parallel HTTPS ping of `registry.npmjs.org/-/ping` and `registry.npmmirror.com/-/ping` through the Host's fetch proxy → `Promise.any` picks the first successful response → the result is cached for `registryProbeCacheTtlMs`.
- Non-obvious design decisions: the losing request is **not abandoned** — `finished.abort()` cancels it and `Promise.allSettled` awaits both, then every response body is `cancel()`ed, so the probe releases its connections. A result is cached even when it is `null` (both registries unavailable), so a failing network is not re-probed on every open.
- Edge cases / failure handling: the probe is disabled by configuration; a timeout is an `AbortSignal.timeout` composed with the lifetime and the local finish signal; disposal aborts and awaits the pending probe, and a call after unload **returns a rejected Promise**.
- Surprising: `redirect: 'error'` on the ping — a registry that redirects is treated as unusable.

### packages/client/ui-plugin-manager/tests/browser-plugin.client.spec.tsx
The real-Context wiring. **I read the first 70 lines in full** (the bench with a `TestRemote` over the pluginInventory, pluginRegistryProbe and pluginManager namespaces, a stand-in layout service and a declared slot tree) **and every test title**: the bundle selection reset when leaving Plugins, the refresh-failure sharing with the overlay, the declared service set, and the sidebar entry and page registration with the Host's change events followed.

### packages/client/ui-plugin-manager/tests/components.client.spec.tsx
A 2,439-line component spec over the whole page. **I read the header and every test title**, covering the tab ledger, the loading / unavailable / error / empty states, the skeletons, the refresh progress, the localized refresh toast, the add-plugin menu, the install dialog's screens, the registry panel, the script approval, the uninstall confirmation, and the Official-source install variants.

### packages/client/ui-plugin-manager/tests/config-ledger.client.spec.ts
The ledger projection contract. **I read the fixture in full** (a stand-in slot registry with per-slot versions and a locale revision) **and every test title**: the items in ledger order with locale-following labels, an entry without a label, a keyed entry without a key, the snapshot held until a ledger or the locale moves, and the subscription following every source.

### packages/client/ui-plugin-manager/tests/manager-store.client.spec.ts
A 2,041-line store spec. **I read the header and every test title**, covering the reads and refresh states, the install phases, the cancellation recovery, the registry choice, the confirmed Official target, the script-approval retry, and the analytics redaction.

### packages/client/ui-plugin-manager/tests/registry-probe.host.spec.ts
The host probe spec. **I read the fixture in full** (a `fetch` stub that hands out a resolver per URL and rejects on abort) **and every test title**: concurrent probes shared, caching of the first successful response, no request when disabled, an HTTP failure ignored with both bodies released, an unavailable result cached, the timeout and dispose cases, the choice by response arrival with body cleanup awaited before settling, and a successful response kept when discarding its body rejects.

### packages/client/ui-plugin-manager/tests/sanitize-install-input.client.spec.ts
Seventeen lines pinning the redaction: four registry identifiers retained verbatim, and six private inputs (a git URL with `user:secret@…?token=secret#secret`, an https URL with a signature, `git@example.invalid:private/repo`, a macOS path, a Windows path, and a package spec pointing at a URL) reduced to `[git]`, `[url]` or `[path-or-other]`.

### packages/client/ui-plugin-manager/tsconfig.client.json
Browser TS project referencing the package-manifest, remotes, boot plugin-manager, test-support client-runtime, locale, store, layout, primitives, renderer, sidebar, slot, util-crypto, settings and product-analytics packages.

### packages/client/ui-plugin-manager/tsconfig.host.json
Host TS project: `src/index.ts` with references to schemastery, timeout and typert-protocol.

### packages/client/ui-plugin-manager/tsconfig.json
Solution file referencing the host and client projects.

### packages/client/ui-plugin-manager/tsdown.config.ts
The shared client-bundle helper with `hostPhase` enabled so the typert host entry is emitted too.

---

## Ideas worth stealing

- **A read is accepted only if it is still the newest one *and* the connection generation has not moved** — `packages/client/ui-permission-presets/src/client/catalog.ts:152` — `accepts(epoch, generationId)` fences every settlement by disposal, by the refresh epoch **and** by the live connection generation, so a response that arrives after a reconnect is dropped rather than applied. August's outbound-body scrub cache and every "read once per session" path in the backend have the same exposure; this is the concrete fence.
- **Subscribe to the invalidation source *before* the first read** — `packages/client/ui-permission-presets/src/client/catalog.ts:40` — the class subscribes to `permission-presets/catalog-changed` and to the connection generation in its constructor, explicitly "closing the install/read race": a read-then-subscribe ordering loses an event fired in between. August's brain-config and settings caches are exactly this shape.
- **Two observables, because "the data changed" and "your options are now invalid" are different events** — `packages/client/ui-permission-presets/src/client/catalog.ts:27` — the `invalidations` store carries a tick per notification while `store` carries results, with the comment "consumers that must drop displayed options subscribe here instead to `store`, whose publications also settle a read a displayed surface is waiting for." One channel for both would make a consumer either drop data it needs or keep options that are gone.
- **A lost reply is a third outcome, not a failure** — `packages/client/ui-plugin-manager/src/client/manager-store.ts:1038` — `request.replyLost = true` then `installUncertain('result', …)` then `reconcileInstall()`; the UI renders an explicit "we do not know" screen and re-asks the Host for the active result. August's provider-call layer has the same missing case (a request that timed out may still have been executed) and currently collapses it into "error".
- **The presenter's facts come from the recorded tool ledger, never from the model's prose** — `packages/client/ui-deliverables/src/client/turn-deliverables.ts:3` — "produced paths come from successful first-party mutation calls and their recorded file targets, changed files from the Host's recorded git summary, and deliveries from `present`; never from presentation data or the closing prose." This is the same discipline August keeps re-learning the hard way (the `[Blocked]` marker and the 400-marker lessons): a surface that renders the model's claim rather than the tool's record will eventually render a lie.
- **Refusing to resolve an ambiguous mention** — `packages/client/ui-deliverables/src/client/turn-deliverables.ts:283` — `producedFileMentions` resolves a value only when every matching fact points at one file; an ambiguous basename or argument path stays unclickable. "No link" is a correct outcome, not a failure to implement.
- **A dismissal is remembered as a token identity, not as a boolean** — `packages/client/ui-input-trigger/src/client/controller.ts:645` — `rememberDismissed` stores the trigger, the query, the quoted flag and the span bounds, so a bare re-track of the same token cannot revive the menu while typing a new query or moving to another token re-arms it. A boolean "isDismissed" would disarm the wrong thing.
- **Stale-while-revalidate keyed by a monotonic generation** — `packages/client/ui-input-trigger/src/core/menu.ts:96` — the `hit` case resets the groups to pending under a **new generation** while keeping the previous items on screen until the new fetch settles, and a settlement carrying an old generation is dropped. The generation is what makes "keep the old list but ignore the old answer" expressible.
- **The retry policy is per record kind, and it is deliberate** — `packages/client/ui-deliverables/src/client/changes-diff.ts:18` (`retryable: state => state === 'error'`) versus `packages/client/ui-deliverables/src/client/changes-summary.ts:15` (`retryable: () => false`) — a comparison that errored may succeed, a summary that is gone will never come back. "Retry on failure" as a blanket rule is a waste of round trips.
- **The file manager's name comes from the Host, never from the browser's OS** — `packages/client/ui-deliverables/src/presented.ts:25` — `PresentedHost.fileManager` is a closed union of `finder | explorer | directory | null` with the comment "file-manager names never derive from the browser's OS," and the copy degrades to the platform-neutral "Show file location" when the Host cannot say which one it is. August's Tauri shell sits in exactly the position where a client would guess.
- **One route constant, two derived forms** — `packages/client/ui-deliverables/src/changes.ts:18` — `CHANGED_FILES_ROUTE = CHANGED_FILES_PATH.slice(1)`. The absolute path and the browser-relative path cannot drift because one is a mechanical derivation of the other. August's "two sources of truth" hazard is closed this way.
- **A prompt section's order comes from a named key, not from registration order** — `packages/client/ui-deliverables/src/index.ts:33` — `order: ctx.systemPrompt.getSectionOrder('DELIVERABLE_FILE_REFERENCES')`. Plugin load order must not be able to change the shape of the request; the same paragraph is pinned verbatim by an inline snapshot at `packages/client/ui-deliverables/tests/prompt.host.spec.ts:32`, so a reword shows up as a diff rather than as a silent behaviour change.
- **The prompt states negative rules and presentation rules, not just capability** — `packages/client/ui-deliverables/src/index.ts:19` — "Do not call present just to list edited source files, or run commands to check whether a diff view will appear"; "Enclose Markdown file destinations in angle brackets"; "keep full paths out of labels"; "append :24 or :24–30, with no # or L in the line suffix." A prompt that says what *not* to do and how a thing should *look* changes behaviour more than a paragraph describing features.
- **A destructive action is two presses, armed for a bounded window** — `packages/client/ui-jobs/src/client/JobListAction.tsx:64` — `KILL_ARM_MS = 3_000` arms the stop control and a confirming press within the window kills; a failure keeps its hint for `KILL_FAILED_MS = 4_000`; arming a second row disarms the first; a kill that resolves after another row armed leaves the newer phase alone. August's permission escalation and "grant full access" doors want exactly this shape.
- **A human intervention produces a *standard* model-visible event, not a special one** — `packages/client/ui-jobs/README.md:34` — "The kill claims nothing in the model's notice ledger, so the owning agent still receives the standard completion notice — the model is told the user stopped its task rather than left to infer it." The model should not need to learn a new vocabulary for "the human intervened".
- **A risky setting is gated once, in one component, for every surface that offers it** — `packages/client/ui-permission-presets/src/client/PermissionRow.tsx:105` and `packages/client/ui-permission-presets/src/client/PermissionSelect.tsx:193` — both the composer chip and the Settings row render the same `RiskConfirmation` with the same explicit risk paragraph. One gate, two callers; the risk language lives in one dictionary.
- **The controller and the view are separate files** — `packages/client/ui-permission-presets/src/client/dialog.ts` (headless state) and `packages/client/ui-permission-presets/src/client/PermissionSelect.tsx` (the view) — so the state machine is testable without a DOM and the view is testable without a Host. August's React surfaces would benefit from the same split.
- **A generated reference is a compile-time contract, not a runtime lookup** — `packages/client/ui-plugin-manager/src/client/presentation.ts:48` — `CODE_KEYS` is `satisfies Record<ManagementError['code'], PluginManagerLocaleKey>`, so a new Host refusal code breaks the build instead of rendering as a raw string. The same trick appears at `packages/client/ui-message-feedback/src/client/FeedbackDialog.tsx:23` where the category taxonomy is restated as a complete record because a client bundle may not import a Host package's values.
- **Redact user input before it reaches analytics, by classification rather than by pattern** — `packages/client/ui-plugin-manager/src/client/sanitize-install-input.ts:8` — a registry package name is kept; a git address becomes `[git]`; any URL becomes `[url]`; a path becomes `[path-or-other]`. The category is enough to count installs and the secret is gone. August's own product-analytics service should adopt this shape.
- **The extension point is a slot, and a contribution renders `null` for a subject it has nothing for** — `packages/client/ui-plugin-manager/src/client/slot-contract.ts:1` — a registrant merges the contract with `import type` and registers through `ctx.slots`; it never imports the package at runtime, and the detail contributions each decide from the subject whether to render. The page never names a configurable plugin.
- **The configuration write goes through the page owner's `mutate` with the revision the editor read** — `packages/client/ui-plugin-manager/src/client/slot-contract.ts:173` — `ConfigPageForm` carries `state` and `mutate`; a contributing plugin never talks to the settings API itself. The same optimistic-concurrency shape appears at `packages/client/ui-permission-presets/src/client/settings-store.ts:122` (one `settings.mutate` carrying `view.revision`) and `packages/client/ui-message-feedback/src/client/controller.ts:202` (`ifVersion: observed?.version ?? null`).
- **A conflict reply carries the authoritative item, so the loser reconciles without refetching** — `packages/client/ui-message-feedback/src/client/controller.ts:210` — on `version-conflict` the controller commits `result.error.current` instead of re-reading the whole session. A read-modify-write that loses a race should cost one reply, not one full re-read.
- **Batch the legs of an async navigation into one commit** — `packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx:9` — "the previous view keeps rendering while a crumb jump or a submitted path is scanned, then target and parent legs land as one two-pane frame … so stepping back keeps two panes away from the display root and navigation never flashes an intermediate frame," with a wait-bound fallback that lands the target alone and upgrades in place. The same rule applies to any August surface that waits on two reads.
- **A stale pane holds still rather than narrowing first** — `packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx:693` — narrowing a pane the draft has already walked away from would move the view twice for one keystroke. Ordering the updates is the fix; adding a guard is not.
- **Focus is re-parked after a swap, and only when the swap actually dropped it** — `packages/client/ui-directory-picker-browse/src/client/DirectoryBrowser.tsx:719` — the effect checks `document.activeElement === document.body` before re-focusing, so a focus the user parked elsewhere stays theirs. "The Modal has no focus trap" is stated as the reason the effect exists.
- **A shared query cache with a reference count** — `packages/client/ui-open-in-app/src/client/file-applications.ts:22` — one request per `(reader, target)` pair, cancelled and discarded when the last consumer leaves, with a `refresh` that re-runs it for everyone. August's repeated "read the workspace files" calls would collapse under this.
- **Absence is a supported configuration** — `packages/client/ui-deliverables/src/client/index.ts:101` — the `chatFileMentions` service is reached through `ctx.get`, "so its absence — this plugin composed out — is the off state." Every package here is designed so that removing its `cordis.yml` row removes the whole feature coherently rather than half of it.
- **A capability that does not exist renders no control, not a broken one** — `packages/client/ui-open-in-app/src/client/open-path.ts:89` — a refusing Host, a failed answer and a rejecting carrier all publish `false`, so the preview shows no path control. A tri-state `boolean | null` distinguishes "not yet answered" from "no", which is what stops the flash.
- **The IME guard is explicit about the browser's lag** — `packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:971` — `useInstallComposition` tracks `event.isComposing`, the legacy `keyCode === 229`, and a **10 ms window after `compositionend`** because Safari fires Enter inside that window.
- **The whole model-facing surface of a UI plugin is one paragraph, pinned verbatim** — `packages/client/ui-deliverables/src/index.ts:17` — 250 words of file-reference guidance, asserted with an inline snapshot and checked against the two shipped Web prompt snapshots. A tiny, auditable, cache-stable prompt contribution.
- **A test that reads the stylesheet as text can catch a bug nothing else can** — `packages/client/ui-message-feedback/tests/styles.client.spec.ts:52` — every `--dsw-` / `--dsh-` / `--ds-` custom property the sheets use is checked against **every** theme sheet, with a vacuity guard; the file carries the story of a shipped control that had no border, no surface and an unreadable Save label because four declarations named tokens that did not exist. Static analysis of the token plane is a real gate.

---

## Files skipped (with reasons)

- `packages/client/ui-plugin-manager/src/client/assets/badge-skill-preview.svg` (86,562 bytes) — a 640×300 **SVG feature illustration** for the badge-skill bundle in English. I opened the first three lines (`<svg xmlns=… viewBox="0 0 640 300">`, a `<defs><clipPath id="canvas">`, and the first `<g clip-path=…>`) to establish that it is vector artwork with no logic, an identifier or a data structure. It was not read line by line because it is a generated-looking asset (thousands of path/rect commands) whose content is pixel layout, not mechanism; nothing in it can be summarised beyond "an illustration of the badge-skill plugin's UI".
- `packages/client/ui-plugin-manager/src/client/assets/badge-skill-preview.zh.svg` (69,193 bytes) — the Chinese-language variant of the same illustration; the same header was opened and the same reasoning applies.
- `packages/client/ui-plugin-manager/src/client/assets/voice-input-preview.svg` (96,075 bytes) — a 640×300 **SVG feature illustration** for the voice-input bundle in English; header opened (`<svg …>`, a background `<rect … fill="#F5F6FC"/>`, a panel `<rect x="32" y="105" …>`) to establish it is artwork, and not read line by line for the same reason.
- `packages/client/ui-plugin-manager/src/client/assets/voice-input-preview.zh.svg` (53,832 bytes) — the Chinese variant; header opened only.

No other file was skipped. Every other file in the shard was opened and read; for the largest test files the reading was partial and is declared in the per-file notes and in *Uncertainties*.

---

## Uncertainties

- **`packages/client/ui-directory-picker-browse/tests/directory-browser.client.spec.tsx` (1,760 lines).** I read the fake-tree fixture (lines 1–135) and every `describe`/`it` title in the file, but **not** every assertion. I know the *scenarios* the spec pins (the dwell windows, the two-pane landing, the wait-bound fallback, the focus re-parking, the draft walk, the create dialog, the stale-response drops) from the titles; I do **not** know the exact thresholds the implementation uses for each of them beyond the ones named in the source's own comments and constants.
- **`packages/client/ui-input-trigger/tests/service.client.spec.ts` (1,320 lines).** Header and every test title read; assertions not read line by line. The behaviours I attribute to it come from its titles and from the controller source, not from its assertions.
- **`packages/client/ui-input-trigger/tests/menu-view.client.spec.tsx` (376 lines).** Fixture and lines 1–130 read in full; the rest is title-only.
- **`packages/client/ui-jobs/tests/job-list-action.client.spec.tsx` (592 lines).** Fixture and lines 1–115 read in full; the rest is title-only.
- **The five `ui-message-feedback` specs, the three `ui-model-selection` specs, the seven `ui-open-in-app` specs, the five `ui-permission-presets` specs and the two large `ui-plugin-manager` specs** (`components.client.spec.tsx` at 2,439 lines, `manager-store.client.spec.ts` at 2,041 lines) were opened — header plus every test title — but not read assertion by assertion. For the `ui-plugin-manager` pair I additionally read the header comment in full. The behaviour claims in the per-file notes for these files are therefore derived from their test *titles*, which in this repo are written to state the behaviour being pinned, plus the corresponding source I did read.
- **`packages/client/ui-plugin-manager/src/client/locales.ts` (455 lines).** Header and the first sixty keys read; the remaining ~395 entries are a flat `key: 'string'` table with no mechanism, so I did not transcribe them individually. The set of keys was not enumerated exhaustively.
- **`packages/client/ui-plugin-manager/src/client/PluginManagerPage.module.css` (1,334 lines).** Head read and the class inventory surveyed; the individual rules were not read. I could not confirm the exact visual treatment of any specific element.
- **`packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx` (1,815 lines).** Read in full for the structure but in five chunks with a gap: lines 1–420, 421–700, 700–984, 983–1312, 1313–1512 and 1513–1815 are covered, but **lines 500–680 and 984–983's overlap aside, the region around 500–680** (the card-group and the list rendering) was read only in part, and the `InstallDialog` body between lines 1056 and 1290 was skimmed rather than read sentence by sentence. I know the wizard's phases and its structure but not every string and every conditional in that dialog.
- **The `manager-store.ts` region between lines 640 and 960.** Read in chunks (561–980 and 981–1308) but the middle of the action runner — the `enable` / `disable` / `uninstall` / row-toggle implementations and the `refresh` machinery — was read with the tool's middle elision in effect. The install path (960–1200) was read in full.
- **What the "Host" is.** The shard contains only browser halves and small node halves; the `dsh-api-remotes`, `dsh-api-session-controller`, `dsh-host-open-in-app` and `dsh-plugin-manager` packages that own the wire are **not** in this shard. Every statement above about "the Host" is taken from the client code's own comments and type imports; I did not read the server side and cannot confirm the wire formats beyond the types the client imports.
- **Whether any of this reaches the agent loop.** The shard's own READMEs say repeatedly that these packages "neither assemble nor send provider requests", with the single exception of `ui-deliverables`' one system-prompt section. I did not verify that claim against the prompt assembler, so I cannot rule out that some other package in the repo contributes a prompt section that these packages merely *display*.
- **Test infrastructure.** The specs import from `@deepseek-ai/dsh-client-test-runtime` (a `createClientTest` / `ClientRoster` / `TestRemote` harness) and from `@deepseek-ai/dsh-remote-mock`. Neither package is in this shard, so I read their usage but not their implementation, and I cannot say how faithful the mock Remote is to the real one.

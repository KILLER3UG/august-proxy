# deepseek-harness / dsh-apps-web#3

## Shard shape

This shard is the **entire browser end-to-end lane of the `apps/web` package** — 176 files, all under `apps/web/tests/`. It contains no product code at all: it is the *harness that drives* the product. Three groups make it up. (1) `scaffold.ts` (1,796 lines) plus `prefix-proxy.ts` and `support.ts` (the latter lives in another shard) form the **scaffold**: an in-process boot of the *real* shipped web composition — the `dsh-base` and `dsh-web-app` bundle patches applied over an empty profile root through the vendored Cordis Loader — plus a small plain-HTTP prefix-stripping reverse proxy, a temp world, and a set of golden/aria helpers. The scaffold runs in three snapshot modes selected by `$DSH_SNAPSHOT` (`replay` / `record` / `refresh`), drives real model traffic either from a recorded `session.jsonl` script (replay) or from a real key (record), and it is what lets the ~130 scenario files below assert against a *real* HTTP uplink, a real WebSocket downlink, a real agent loop, real tools and real JSONL persistence. (2) Roughly 60 `*.e2e.ts` / `*.spec.ts` scenarios, each booting the scaffold, driving a real Chromium (occasionally WebKit) and pinning either an **aria snapshot** or a **normalized geometric fact** into a committed golden. (3) A `fixtures/` tree of Cordis include-patches, plugin bundles, a registry-ping interceptor, a startup barrier, and three binary legacy Office documents. The whole lane is governed by two rules stated in `README.md`: the tests are **Host-face** (they type-check in `tsconfig.host.json`, not the Client aggregate, because they read `ctx.connection` and the Host `SessionStore`), and they **must not import `@deepseek-ai/dsh-client-*`** (a Client import drags its whole TS project into the Host build graph; the lane mirrors the few constants it needs instead, so drift surfaces as a loud failure). The shard's own shape is thus: *the product is never mocked* — the only doubles are at the network boundary (a mocked npm registry, a mocked upstream LLM), at the filesystem boundary (a temp workspace) and at the clock boundary (a pinned `Date`).

## Per-file notes

### apps/web/tests/scaffold.ts
- Purpose: the lane's core — boots the real shipped web composition in-process and provides the fixture/golden vocabulary every other file in this shard uses.
- Key abstractions: `launchWebScaffold(options)` → `WebScaffold` (`baseUrl`, `authenticatedUrl`, `ctx`, `workspaceCwd`, `persistenceRoot`, `harnessHome`, `hostFetch`, `whenTurnSettled`, `close`); `webSnapshotMode()` (`replay`/`record`/`refresh`); `seedSession` / `realizeSeedFixture` / `parseSeedFixture` / `renderSeedFixture`; `captureStableAria` / `captureExpandedTurnProcessAria`; `compareOrRefreshGolden`; `assertFixtureInventory`; `watchConsole` / `acknowledgeReloadConnectionLoss`; `RouteOnlyAdapter`; `rawSessionLog` / `normalizeWebSessionVolatiles`.
- Data flow: compose the shipped bundle patches → apply the scaffold's own hermetic include patches → mount the root Include through the Loader → boot the real tree in-process → exchange a browser token for a session cookie → the browser talks to the real webserver over HTTP/WS; scenarios then either *seed* a recorded `session.jsonl` through the real JSONL persistence API or *replay* it through `dsh-llm-replay`; the transcript is compared back against the fixture at teardown.
- Non-obvious design decisions: the divergences from `dsh web` are written as **include patches over the SAME tree, never a second yml** (`:573`) — "a patch id that stops matching a row fails the boot sweep loudly instead of drifting"; live fields are split into a shared deployment layer while process-specific ports/roots stay in CLI overlays (`:711`); the `RouteOnlyAdapter` (`:234`) answers `listProviders`/`resolveModel` but **throws on any stream** (`:259`), so a fixture-less scenario that accidentally issues a model call fails loud instead of passing quietly; `deepSeekMissingCredential` keeps the real adapter *mounted* while masking its credential, which is how the first-run credential lane works without a key.
- Edge cases / failure handling: the teardown asserts the replay fixture was **fully consumed** before it disposes the world (`:1001`), so a scenario that drove fewer model calls than recorded fails rather than drifting green; cleanup collects every independent failure and throws an `AggregateError`; a missing golden in replay mode throws with the healing command rather than silently bootstrapping itself (`:1717`); `assertFixtureInventory` (`:1728`) fails when a scenario directory carries an unlisted file or a JSONL that still holds prompt text or unredacted identities.
- Surprising: `normalizeWebSessionVolatiles` (`:1144`) replaces every run-local string — cwd, checkout path, web URL, browser timezone, time-context timestamps, anonymous user id — with tokens, and the cwd replacement is **boundary-aware** (`isWebCwdMatch`, `:1105`): a cwd that is a substring of a longer path is left alone, because a blind `split().join()` would corrupt it.

### apps/web/tests/prefix-proxy.ts
- Purpose: a test-only plain-HTTP reverse proxy that serves the app under a **deployment prefix**, the way a real static-host/reverse-proxy deployment does.
- Key abstractions: `startPrefixProxy({ prefix })` → `PrefixProxy` (`port`, `setTarget`, `close`).
- Data flow: browser → proxy (external authority preserved) → strip the mount prefix → loopback backend; responses come back with hop-by-hop headers removed and `Path=/` cookies rewritten to the mount path; WebSocket upgrades are replayed raw at both ends.
- Non-obvious design decisions: an upgrade "speaks its own hop-by-hop framing, so it cannot ride the request handler" (`:92`) — the upgrade path re-serialises the request line and raw headers itself rather than forwarding an HTTP request; the listen socket is unaffected by the prefix, and the proxy authority is added to `trustedHosts` because "the direct composition grants no trust" (`scaffold.ts:661`).
- Edge cases / failure handling: requests before `setTarget` answer `502` (`:76`); requests outside the prefix answer `404` (`:71`); `close()` destroys live sockets and resolves only once every listener *and* socket has closed.
- Surprising: the cookie rewrite (`:59`) is the part a naive proxy forgets: the backend's `Path=/` cookie would not be sent to the mount, and the browser would silently lose its session.

### apps/web/tests/README.md
- Purpose: the lane's charter — modes, fixtures, goldens, and the two structural rules that govern every file in this shard.
- Key abstractions: the `replay`/`record`/`refresh` vocabulary; the "completion observations" rule; the Host-face typing rule; the Client-import ban.
- Data flow: n/a — documentation.
- Non-obvious design decisions: "Driving a browser at runtime does not make a file part of the Client program — the two faces merge Cordis `Context` under the same keys with different services" (`:29`), which is why these files cannot be moved into the Client aggregate; when a scenario needs a Client-owned constant, "mirror it here instead, next to the commented-out import that names the source module. A drift then surfaces as a missed selector or a stale mirrored value — a loud failure, never a silent pass" (`:35`).
- Edge cases / failure handling: "Nothing mechanically enforces this rule; keep it in review" (`:39`) — the one rule in the lane with no gate behind it.
- Surprising: the same file is duplicated in Chinese (`README.zh.md`) and the pairing is hash-recorded in `README.i18n.yaml`, so a translation that drifts from the English text is a *static* failure.

### apps/web/tests/README.i18n.yaml
- Purpose: per-heading translation-pairing hashes for `README.md`, so the bilingual README cannot drift unnoticed.
- Key abstractions: `/<heading-path>: { en: <hash>, zh: <hash> }`.
- Data flow: `pnpm run verify-translation-pairing --write apps/web/tests/README.md` recomputes the hashes after either side is edited.
- Non-obvious design decisions: the hash covers only the blocks *outside* code fences and generated regions, so a code sample is not required to be translated.
- Edge cases / failure handling: editing one side without the other turns the gate red — a static failure, not a runtime one.
- Surprising: the same pairing mechanism is used for `fixtures/office/README.md`, showing it is a repo-wide convention rather than a one-off.

### apps/web/tests/README.zh.md
- Purpose: the Chinese counterpart of the lane charter, section-for-section identical to the English file.
- Key abstractions: same four sections (lane intro, completion observations, Host-face tests, Client-import ban).
- Data flow: n/a.
- Non-obvious design decisions: it states the same Host-face reason ("运行时驱动浏览器并不使一个文件成为 Client 程序的一部分") and the same review-only enforcement.
- Edge cases / failure handling: the pairing hashes in `README.i18n.yaml` compare the two.
- Surprising: it is the only file in the shard whose *content* is duplicated wholesale — and that duplication is itself gated.

### apps/web/tests/scaffold-generation.spec.ts
- Purpose: unit-level tests of the fixture *generation* rules the scaffold depends on, without booting anything.
- Key abstractions: `parseSeedFixture`, `selectedSessionFixture`, `recordedSessionFixturePath`, `assertFixtureInventory`.
- Data flow: writes synthetic `session.jsonl` generations into a temp dir, then asks the scaffold's helpers to select, record beside, or inventory them.
- Non-obvious design decisions: the fixture role is encoded in the **filename** (`session.jsonl` = parent role 0, `session.1.jsonl` = child role 1) and the generation in a `.vN` suffix, so "the highest committed generation" is a filename question, not a content one; retained generations count as **one** inventory role, so a scenario that keeps a historical generation does not have to list it separately.
- Edge cases / failure handling: an absent canonical parent is only tolerated for an override-only replay script (`allowAbsent`), and a missing role otherwise throws "missing parent session fixture"; an invalid fixture path throws "invalid Session fixture path".
- Surprising: the first describe asserts that a v2/v3 fixture's **embedded stream timestamps survive projection** — i.e. re-projecting a fixture must not perturb its timing, which is what makes the seed a faithful recording rather than a re-render.

### apps/web/tests/scaffold-hermetic.e2e.ts
- Purpose: proves the scaffold's skill discovery is hermetic — no ambient host skill root can leak into a replayed request.
- Key abstractions: `ctx.agents.create` with a `setup` that mounts the agent preset; `ctx.get('skills').list({ cwd, scope })`.
- Data flow: writes three ambient `SKILL.md` files under fake `DSH_HOME` / `DSH_AGENTS_HOME` / `DSH_BUNDLED_SKILL_DIR` roots → boots the scaffold → lists skills through the agent's preset scope → asserts none of the ambient names appear.
- Non-obvious design decisions: the roots are only reachable through a **composed agent's view**, because local skill discovery belongs to the agent's preset *layer* of the host registry, not to the global one (`:43`).
- Edge cases / failure handling: the three environment variables are restored in a `finally` and the ambient tree is removed, so the test cannot poison the rest of the lane.
- Surprising: the ambient roots are pinned for the *scaffold lifetime*, not just the boot, because presets mount when a session is created (`scaffold.ts:537`).

### apps/web/tests/minimal-preset.snapshot.ts
- Purpose: pins the **minimal agent preset** end to end — its exact RL system prompt, its three-tool roster, its persistent shell, manual compaction, and image reading.
- Key abstractions: `ctx.agentPresets.mount(agentCtx, 'minimal')`; `ctx.systemPrompt.section({ name, order, text })`; `session.requestHeader()`; `session.deriveMessages()`; `session.surface.replaceGeneration`.
- Data flow: the scaffold boots with a replay fixture → an agent is created on the `minimal` preset → a user prompt drives one turn → the durable `request/header` and the derived system message are read back and compared to an inline snapshot.
- Non-obvious design decisions: the test registers its own system-prompt section at `order: 999` containing "THIS TEXT MUST NOT REACH THE MODEL." (`:48-51`) — a **negative control** proving the preset's prompt is the whole prompt; the runtime-context message is asserted as an exact string (`:91`) rather than by presence; the tool list is compared both as a sorted name list and against `ctx.tools.schemas(agent)` (`:139`).
- Edge cases / failure handling: manual compaction is asserted to emit `command/run` → `compaction/start` → `compaction/summary` → `compaction/end` → `command/done` and to bump `surface.replaceGeneration` by exactly one; the follow-up turn must still see the same minimal prompt and tools.
- Surprising: `ctx.agentPresets.serviceFor(agent, 'fs')` is asserted to be `undefined` while `compaction` is defined (`:93-94`) — the minimal preset removes the fs service entirely, and the test proves it by service presence rather than by tool list alone.

### apps/web/tests/live-interactions.e2e.ts
- Purpose: the lane's **tool-call reliability** surface — cancellation mid-stream, non-retryable auth failure, quota errors, transient-failure recovery, and retry exhaustion, all proven in the browser.
- Key abstractions: `ReplayOverrideDoc` sidecars (`hang` with a `readyFile` marker, `throw` entries with stable codes, `{ patches }` augmentation); `deriveReplayScript(parseSessionLog(fixture))`; `RetryPolicyConfig`; `turnEndReasons(events)`.
- Data flow: one recorded base fixture → its script is *derived* (no committed copy of the chunks) → the scenario authors a per-run sidecar override in a temp dir → the scaffold installs it → the browser drives the turn and the durable `turn/end` reasons and the goldens are asserted.
- Non-obvious design decisions: "the sidecar CONTENT is authored here (single-sourced against the fixture via `deriveReplayScript` — no committed copy of recorded chunks); the file is a per-run artifact in the temp workspace" (`:9-12`); the sidecar must exist **before** the scaffold boots because `installLlmReplay` resolves the script at install time (`:97`); the mid-stream cancel is made deterministic *by construction* — the script waits for a file the test creates — rather than by a timeout.
- Edge cases / failure handling: a non-retryable AUTH error must not retry at all; a transient SERVER failure must recover through `llm-retry`; exhaustion must surface a terminal turn error; the teardown comment states that `scaffold.close()` failures MUST fail the scenario, because `assertConsumed()` is the fixture-drift tripwire (`:72`).
- Surprising: the partial text of a failing attempt "must disappear when the attempt fails" — the retry surface is asserted to clean up the previous attempt's output, which is the kind of thing only an end-to-end browser assertion catches.

### apps/web/tests/idle-submission-handoff.e2e.ts
- Purpose: proves a message submitted while the harness is idle lands in Chat exactly once, regardless of whether the Inbox projection or the transcript frame arrives first.
- Key abstractions: `HistoryDeliveryGate` — a `page.routeWebSocket('**/api/remote.mux')` interceptor that buffers server frames per logical stream and releases them in FIFO order on demand; `placement(page)` — a DOM probe returning `{ echo, dock, durable, messageTop, composerTop }`.
- Data flow: the gate intercepts the real mux socket → it recognises `session/control` (projection, key `inbox`) and `session/follow` (events) frames → the test releases them one milestone at a time → after each release the DOM's echo/dock/durable counts and the element's vertical position are polled.
- Non-obvious design decisions: the test runs under **6× CPU throttling** via `Emulation.setCPUThrottlingRate` (`:142`) so the ordering race is real rather than theoretical; the assertion is *positional* — the message's `messageTop` and the composer's `composerTop` must be identical at every phase (`:193-194`), so a submission that jumps in the transcript between phases fails.
- Edge cases / failure handling: the second scenario drives three rapid submissions in **all six host orders** (ABC…CBA) and asserts the final transcript order matches the host order; the prompt HTTP route is blocked per-submission so the test controls exactly when each turn starts.
- Surprising: `whenTurnSettled` is called with the rejection swallowed (`:101`) — "the caller's await reports Turn failure; an earlier assertion may bypass that await" — so an early assertion failure cannot be masked by a later await's unhandled rejection.

### apps/web/tests/pinned-clock.e2e.ts
- Purpose: proves the fixture-day clock pin keeps the page's timers native at every real-to-fixture clock distance.
- Key abstractions: `pinBrowserClock(page)` (a `Date` Proxy installed as an init script for every later document and on the current one); `WEB_FIXTURE_TIME`.
- Data flow: the Host `Date.now` is spied to `WEB_FIXTURE_TIME - shift` → the page's `Date` is offset by the same delta → the page is navigated twice (initial document and a replacement) → a `requestAnimationFrame` and a `setTimeout` are observed and the page's calendar is read.
- Non-obvious design decisions: the shifts are spread over **one 2^32 ms period** (`:8`) — exactly the range where a 32-bit truncation of the delay breaks: Playwright's `page.clock` records its clock state with the Vitest worker's `Date.now`, which the pin replaces, so after a navigation the page clock replays the gap between the real and fixture days and hands a *negative* delay to native `setTimeout`; the browser truncates that delay to a 32-bit integer and, in about half the dates, the result is a positive delay of **weeks** that stops every page timer.
- Edge cases / failure handling: `new Date(0)` and `Date.parse(...)` must still return their true values (the override must not touch explicit instants), and `Date.now()` must be monotonic against the page's own start time.
- Surprising: the fix is *not* `page.clock` but a `Date` Proxy that leaves native timers and `requestAnimationFrame` on real scheduling — the calendar is faked, the scheduler is not.

### apps/web/tests/hmr-live.e2e.ts
- Purpose: proves the built client-plugin source really hot-reloads in the browser without a page refresh.
- Key abstractions: `clientArtifactPaths()` (glob of everything `dev:web` can rewrite); `waitForOutput(child, pattern, label)` (a readiness barrier on the child's stdout/stderr with a 60 s deadline); `readClientBuildRecord(REPO_ROOT).environment`.
- Data flow: spawns `pnpm run dev:web --skip-build --no-serve` → spawns the built `dsh web` → edits `packages/client/ui-conversation/src/client/locales.ts` → waits for the new copy to paint → compares an in-page identity token.
- Non-obvious design decisions: the page identity is minted with `crypto.getRandomValues` **inside the page** (`:137`) — "an import would not survive serialization, and the page entropy source available in every context is `getRandomValues`" — so a reload would change it; the whole built artifact set is snapshotted before the test and restored afterwards, and a *new* artifact created by the watcher is deleted.
- Edge cases / failure handling: every teardown step runs even when the assertion failed, and all failures are collected into one `AggregateError` so a failed test cannot leave the checkout dirty.
- Surprising: the test runs against the **built** `dsh` binary and the **built** tree, treating the build as a precondition rather than something the test rebuilds — "the built tree is this lane's precondition rather than something to rebuild" (`:112`).

### apps/web/tests/katex-fonts.spec.ts
- Purpose: proves the shipped KaTeX stylesheet ships all 20 WOFF2 faces with byte-identical fonts, and that the build refuses a non-WOFF2 KaTeX face.
- Key abstractions: `bundleStyle(source)` — runs the app's **own** Vite config and plugin list (minus the product-isolation plugin) against a temp root with `write: false`; `layoutCss(css)` — a lightningcss visitor that strips the `source` property from every `@font-face`.
- Data flow: the KaTeX stylesheet is resolved from the client-primitives package → Vite builds it in memory → the emitted font assets are compared byte-for-byte with the package's own fonts → the emitted CSS is compared after the `source`-stripping normalizer.
- Non-obvious design decisions: the CSS comparison normalizes away only `source`, so layout rules are compared "independently of emitted font URLs and format fallbacks" (`:39`); the negative cases assert that a KaTeX face with a plain `woff` source is *rejected* by the build while an unrelated stylesheet's `woff` face is *preserved* — the rule is scoped to KaTeX, not global.
- Edge cases / failure handling: the app's Vite config is loaded with `loadConfigFromFile` and the product-isolation plugin is filtered out, because that plugin "requires the full application's HTML entry".
- Surprising: this is the one file in the shard that is a **build-level** test rather than a browser test — it runs Vite inside Vitest to prove a font policy, and the assertion is about bytes, not appearance.

### apps/web/tests/jobs-menu-layering.e2e.ts
- Purpose: proves the background-job menu paints *above* the Browser dock, stays anchored, and dismisses correctly.
- Key abstractions: `placement(page)` — a DOM probe computing real overlap via `document.elementFromPoint` at a 3×3 grid over the intersection, plus `position`, `bodyMounted`, `anchored` and `viewportBounded`.
- Data flow: a background bash job is started through the real tool executor → the job row appears in the sidebar → the Browser dock is opened and a fake page loaded → the menu is opened with the keyboard and its geometry measured.
- Non-obvious design decisions: "Measure actual overlap and hit testing; ARIA alone cannot expose clipping or stacking" (`:26`) — the test proves the menu is *above* the dock by hit-testing the intersection area, not by reading a z-index; the expected anchor position is recomputed from the trigger's rect and the viewport, so the assertion is relative, not absolute.
- Edge cases / failure handling: `Escape` must restore focus to the trigger; an outside click must dismiss without stopping the job; the teardown writes the barrier file and waits for the job to settle, failing loudly if it is still running.
- Surprising: the background job is held by a **file barrier** inside the workspace (`printf ...; for _ in $(seq 1 3000); do [ -e <file> ] && break; sleep 0.2; done`) so the process cannot settle on its own and no CI stall can occur.

### apps/web/tests/focus-rings.e2e.ts
- Purpose: browser regressions for focus-ring *paint* — not just the modality publisher's attribute.
- Key abstractions: `paint(target)` — reads `:focus-visible`, the `data-input-modality` attribute, and resolves the ring/hover colours through a throwaway probe element so the *computed* value is compared, not the token string.
- Data flow: a real page is driven by pointer and keyboard; a second describe compiles a source-only fixture with Vite and drives it too.
- Non-obvious design decisions: the assertions are per-theme (`light`/`dark`) and per-input-modality — "pointer keys stay silent; navigation and menu activation retain feedback" (`:95`); a **negative control** exists (`:404`): "blanket shadow suppression destroys input and card paint and misses descendants", which proves the suppression rule is scoped rather than global.
- Edge cases / failure handling: high-specificity table rings must be silenced *without* hiding selected-state shadows (`:436`); clicked text-input paint and card elevation must survive while descendant rings are suppressed.
- Surprising: reading a CSS custom property's resolved colour needs a probe element appended to the document — the token string alone does not tell you what was actually painted.

### apps/web/tests/markdown-wide-table.e2e.ts
- Purpose: markdown table layout across the message column and the transcript width.
- Key abstractions: relations over pixels — `titleSingleLine`, `placement` (`beside`/`below`/`overlapping`), `contained`, `fill`, `scroll`.
- Data flow: a closed turn is assembled through the Session API and seeded cold (zero model calls — "a stray stream would fail loud with NO_ADAPTER", `:20`); the real engine lays out the tables and the relations are measured at viewport stops.
- Non-obvious design decisions: tables under four columns fill and wrap, four-or-more-column tables keep their natural width, scroll horizontally inside their wrapper, and *break out* to the full transcript width through the renderer's `md-table-wide` hook plus a container-query breakout — with the table content still starting at the message column's left edge; when the transcript is narrower than the message column the breakout clamps to neutral and the plain in-column scroll remains.
- Edge cases / failure handling: the wide table must stay keyboard-scrollable, reveal its scrollbar on hover only, keep a fitting table and its following paragraph stationary during interaction, and give the gutter to *painted* content rather than transparent breakout padding; the same relations must hold under page zoom and on a high-DPI page.
- Surprising: "The golden records relations and booleans, never pixels: absolute widths document the platform, not the behavior" (`:15-16`) — a golden that is portable by construction.

### apps/web/tests/schedule-header.e2e.ts
- Purpose: geometry of the Automation tasks header in both languages across seven viewport widths.
- Key abstractions: `document.createRange().selectNodeContents(title)` → `getClientRects()` for a true line count.
- Data flow: the page is opened at each width and the header's title/button rects and client-rect counts are polled until stable.
- Non-obvious design decisions: a `Range` over the title's text nodes is the only reliable way to count *rendered* lines — `offsetHeight` would report the box, not the wrap; the golden records a phrase per viewport rather than coordinates.
- Edge cases / failure handling: at 509 px the sidebar collapses to its rail and expanding it leaves the column at a measured 172 px, which is what forces the wrap — the case is constructed deliberately rather than found by accident.
- Surprising: the title is asserted to stay single-line at *every* width; only the button moves, so the failure mode being guarded is "New" wrapping *onto* the title.

### apps/web/tests/sidebar-scrollbar.e2e.ts
- Purpose: distinguishes a *reserved* scrollbar gutter from a bar painted over content, and pins the themed thumb.
- Key abstractions: `ListMetrics` (`gutter`, `width`, `track`, `band`, `timeCoveredBy`).
- Data flow: 24 seeded sessions overflow the 800 px sidebar → the list's geometry and the resolved `::-webkit-scrollbar` pseudo-element style are read from the cascade.
- Non-obvious design decisions: "Chromium uses overlay scrollbars, so the reserved band and `timeCoveredBy` together distinguish reserved space from a bar painted over content" (`:2`) — `timeCoveredBy` measures how much of the trailing relative-time cell sits under the bar, which must be `0`.
- Edge cases / failure handling: the thumb draws no paint until the pointer is over the column and lingers on the way out; the row background stays inset when the overflow disappears.
- Surprising: the pseudo-element's computed style also folds in `:hover`, so the test has to read the declaration *from the cascade* rather than from a static stylesheet.

### apps/web/tests/startup-rpc-budget.e2e.ts
- Purpose: bounds cold boot to at most **two** `settings/describe` calls regardless of client plugin count.
- Key abstractions: a `page.on('request')` collector of every `/api/*` path.
- Data flow: the page loads → the collector records every API call → boot settles when the workspace picker is interactive → a 3 s tail absorbs the first-connection reset wave → the count is asserted.
- Non-obvious design decisions: "One eager read plus one first-connection reset closes the pre-subscription commit window" (`:9`) — the budget of 2 is a *design statement* about the boot's commit window, not a measured number.
- Edge cases / failure handling: the failure message lists every `/api` call the page made (`:42`), so a regression shows what else was called.
- Surprising: this is a **performance contract** expressed as a test — an RPC-budget gate that would catch a client plugin multiplying boot chatter.

### apps/web/tests/message-feedback-protocol.snapshot.ts
- Purpose: snapshots the Host's message-feedback Remote protocol — strict list, put, conflict and delete — through the real web Host.
- Key abstractions: `createdVersion(response)` — a strict extractor that walks `result.ok` → `result.value.ok` → `result.value.value.version` and throws if any layer is missing (`:32`); `normalizeProtocol(exchanges, version)`.
- Data flow: seven RPC envelopes are POSTed to `/api/<endpoint>` in the `client-request` shape → each `{ endpoint, request, status, response }` is recorded → the whole exchange list is serialized to a golden.
- Non-obvious design decisions: "Replace only run-owned UUID/time values; all protocol names and business fields stay exact" (`:42`) — the normalizer is a `JSON.stringify` replacer keyed on `messageId`/`version`/`ifVersion`/`createdAt`/`updatedAt`, so the *shape* of the protocol is itself the assertion.
- Edge cases / failure handling: the returned version is asserted to be a UUIDv4, and a conflicting put with `ifVersion: null` must still succeed; every exchange must answer `200`.
- Surprising: an "invalid-rating" put is included in the snapshot — the *rejection* is part of the protocol contract and is pinned alongside the happy path.

### apps/web/tests/preset-migration.snapshot.ts
- Purpose: cold V2 restoration — a zstd predecessor generation is migrated to the current format and the shipped PTC preset is mounted and published.
- Key abstractions: `generationLogPath(root, cwd, id, version, 'zstd')`; `scanZstdFrames`; `ctx.sessionController.list/resolveAgent/page`.
- Data flow: a V2 zstd generation is written by hand into the persistence root (with a child and a deliberately broken sibling) → the scaffold lists sessions → the resolved agent's preset, events and child catalogue are asserted → a flush publishes the successor generation.
- Non-obvious design decisions: the corrupt-header sibling is written with the literal bytes `'invalid Zstandard header frame'` (`:56`) and must be **excluded from the session list** but still throw on a direct open with `/invalid frame magic/` (`:132`); the migration is expected to leave the predecessor bytes untouched (`expect(await readFile(predecessor)).toEqual(source)`, `:131`) — a migration that rewrites its input is a defect.
- Edge cases / failure handling: the published successor is asserted to contain a specific tail — a `subagent/catalog` row per child, then `session/end-seed`, `permission/preset`, `sandbox/mode` and `approval/policy` — because "Agent activation closes its restored prefix with a fresh seed marker" (`:123`).
- Surprising: a session whose stored preset is `code` is migrated to `ptc` **in the published record** while the predecessor row is left alone — the migration is a forward projection, not a rewrite.

### apps/web/tests/fixtures/registry-ping.mjs
- Purpose: a Host-side fixture that controls npm registry ping responses inside one isolated web-test Host.
- Key abstractions: `apply(ctx, config)` with `config.requestLog` and `config.winner`.
- Data flow: it replaces `globalThis.fetch` with a wrapper that only intercepts the two ping endpoints, logs the request to a file, answers the winner immediately and hangs the loser on an `AbortSignal.any([init.signal, lifetime.signal])` promise.
- Non-obvious design decisions: the interception is **endpoint-scoped** — every other fetch falls through to the original transport unchanged (`:13`) — so the rest of the Host still talks to the network exactly as it would; the pending set lets `close()` await every hung request before restoring the original.
- Edge cases / failure handling: an already-aborted signal rejects immediately; the original `fetch` is restored on unload.
- Surprising: it makes the registry *selection* deterministic (fastest responder wins) without touching the product code — the fixture replaces a global, and the product's own registry probe decides the winner.

### apps/web/tests/fixtures/restart-startup.js
- Purpose: holds application startup until the restart test releases it, over a process IPC channel.
- Key abstractions: `inject = ['typertGateway', 'connection', 'webServer']`; `ctx.reflect.provide('webRestartReady', {})`.
- Data flow: when `DSH_WEB_RESTART_HOLD_STARTUP === '1'`, the plugin sends `startup-blocked` to the parent and waits for a `resume-startup` message; it only then provides `webRestartReady`, which the `session-controller` row injects on.
- Non-obvious design decisions: the fixture refuses to run without an IPC channel (`throw new Error('web restart startup fixture requires an IPC channel')`, `:14`) — a hold that silently never releases would look like a hung product; the disposal path resolves the barrier with `false` so a torn-down plugin unblocks the boot instead of deadlocking it.
- Edge cases / failure handling: the barrier is released by *either* the message or the plugin's disposal, so teardown can never hang the process.
- Surprising: the barrier is implemented as a Cordis `ctx.effect` cleanup — the same effect-returns-disposer idiom the whole Cordis tree uses, used here to model a process-level lifecycle.

### apps/web/tests/fixtures/plugins/fixture-live-client/client.js
- Purpose: a browser-half plugin that exercises the published registration protocol — locale registration, slot injection, detail contributions and menu items.
- Key abstractions: `window.__ModuleLoader__.load({ id, factory(require) })`; `ctx.effect`, `ctx.locale.register`, `ctx.slots.inject` / `ctx.slots.register`; `inject: ['slots', 'locale']`.
- Data flow: the factory runs in the browser, registers a locale namespace (`fixtureLive`) for both `zh` and `en`, injects five slots, and increments counters on `document.documentElement.dataset` for mounts, saves and disposals.
- Non-obvious design decisions: the detail contributions are **scoped by subject**: `const mine = (subject) => (subject.kind === 'bundle' || subject.kind === 'row') && subject.pkg.name === '@fixture/live-client'` (`:32`) — "another bundle's page gets nothing from these entries"; the session menu items are registered with explicit `order` values 500 and 600 so they follow the shipped rows as one group, opened by the export row's hairline.
- Edge cases / failure handling: the plugin listens for `dsh-fixture-ping` on `window` and removes the listener on disposal, incrementing `liveDisposals` (`:103`) — so the HMR-lifecycle test can prove a plugin was actually torn down, not merely hidden.
- Surprising: it writes a `<style>` element into `document.head` at load time and counts mounts in a DOM dataset — the fixture is instrumented so a test can observe lifecycle from the outside.

### apps/web/tests/fixtures/plugins/fixture-input-extension/client.js
- Purpose: a published-protocol consumer of composer *activities* and bundle-activation guidance.
- Key abstractions: the `conversation.input.activity` slot with `inputActions.captureInsertion()` / `insertText(text, span)`; the `plugins.bundle.config` and `plugins.bundle.activation` slots.
- Data flow: the plugin registers an activity button → the user clicks it → the composer captures the current selection span → the plugin inserts text into that span → on a stale span `insertText` returns false and the plugin shows a "Draft changed" status instead of overwriting.
- Non-obvious design decisions: the insert is **undoable** (`ControlOrMeta+z` restores the draft) and **stale-safe** (`:30`) — the plugin must not clobber a newer draft, so the composer's insert API returns a boolean the plugin must honour.
- Edge cases / failure handling: `onActiveChange(false)` is called on unmount through a `useEffect` cleanup, so the composer is not left locked when the activity disappears.
- Surprising: the fixture writes `require('react')` and `require('@deepseek-ai/dsh-client-ui-primitives')` inside the module factory — the plugin's dependency on the client's primitives is a *runtime require*, not a build-time import, which is what lets a browser-half plugin be shipped without the client build graph.

### apps/web/tests/office-fixture.ts
- Purpose: supplies small, real binary Office and OOXML documents for the converter path.
- Key abstractions: `realOfficeBytes(extension, font)` → `Uint8Array`.
- Data flow: for `docx`/`xlsx`/`pptx` the OOXML parts are built as strings and zipped with `fflate`; for `doc`/`xls`/`ppt` the committed OLE fixtures are read from disk and returned verbatim.
- Non-obvious design decisions: the generated documents contain Latin *and* Chinese text (`'Office preview 中文文档'`) with an explicit `eastAsia="宋体"` font, and the PowerPoint case deliberately emits **two** slides so the "generated documents have two pages" rule is exercised; the `.rels` and `[Content_Types].xml` parts are hand-written so the zip is a genuinely valid package.
- Edge cases / failure handling: the legacy branch reads the committed fixture synchronously and returns it unchanged — the binary path is a real conversion test, not a mock.
- Surprising: the helper mixes a *generated* path (OOXML) with a *committed* path (OLE), so the same call site covers both the modern and the legacy importer.

### apps/web/tests/model-input-layout.ts
- Purpose: one shared geometric assertion for the expanded model editor's capacity fields.
- Key abstractions: `assertModelInputLayout(page, editor)`.
- Data flow: the viewport is set to the caller's size and then to 760 px → the three fields' bounding boxes are read → their relative positions are asserted → the viewport is restored.
- Non-obvious design decisions: the assertion is *relational* (`Math.abs(context.y - output.y) < 1`, input-type group below both, input-type group wider than the context field) rather than pixel-absolute; the viewport is restored in a `finally` block even when an assertion fails, so one failing call cannot poison the rest of the suite.
- Edge cases / failure handling: an absent viewport is a hard error ("Model input layout checks require an explicit viewport") rather than a silent skip — the helper refuses to guess.
- Surprising: `models-settings.e2e.ts` calls it with a deliberately unsized page first, to prove the *helper* refuses an implicit viewport before the real check runs.

### apps/web/tests/replay-round-trip.e2e.ts
- Purpose: the lane's canonical "does the whole thing work" scenario — a real chromium types a prompt, the wire, gateway, agent loop and the **real bash tool** all run.
- Key abstractions: `expandAssistantStream` (streaming fidelity asserted from the durable embedded stream, not the transient DOM); `whenTurnSettled` as the only completion signal; `page.routeWebSocket` for the reconnect checkpoints.
- Data flow: the scaffold boots with the replay fixture → the composer is typed into → the model adapter answers from the recorded script → the bash tool actually executes `echo` in the temp workspace → the durable log is compared with the fixture and the aria golden is captured.
- Non-obvious design decisions: "Drive steps run in every mode and wait only on generic completion (`whenTurnSettled` — never model-content selectors, so record cannot hang on a live model answering differently)" (`:4-6`); assertion steps run in replay/refresh only; the suite sets up the page clock and the routed mux socket **once** in `beforeAll`, "so the reconnect checkpoints rely on both without re-pinning or re-routing them" (`:11`).
- Edge cases / failure handling: a "system prompt" row must not appear in the transcript even when the Turn process is expanded; the reconnect checkpoint must leave the console clean.
- Surprising: it asserts that value-free Web guidance lives in the system prompt while *process* values live in runtime context — a deliberate separation of "what the model is told" from "what the host reports".

### apps/web/tests/permission-policy-context.e2e.ts
- Purpose: proves the **current** sandbox policy reaches the model before any tool runs.
- Key abstractions: `systemPrompts(events)` and `runtimeContexts(events)` — both read the durable `SessionEvent` log, not the DOM.
- Data flow: the `/permission` command is driven through the real GUI path across all three presets → the durable header, the runtime-context user message and the tool calls are asserted.
- Non-obvious design decisions: "Assertions read the exact durable header, runtime-context messages, and tool calls, so assistant prose alone cannot satisfy the scenario" (`:4`) — the model could *say* it is read-only; the test checks what the host actually declared.
- Edge cases / failure handling: record mode uses the real provider and replay keeps the same provider-authored behaviour keyless; the final workspace snapshot is asserted so the scenario proves the file was (or was not) written.
- Surprising: the prompts ask the model to answer without calling a tool — "Do not call a tool just to discover the policy" — so the *policy statement* itself is the assertion target.

### apps/web/tests/goal-multi-turn-actions.e2e.ts
- Purpose: a real two-round Goal run where each autonomous round ends as its own turn.
- Key abstractions: `whenTurnsSettled(scaffold, count, timeoutMs)` — counts exactly N `turn/end` events and then flushes; `goalRounds(events)` and `createdObjectives(events)` — read the durable log.
- Data flow: the goal is submitted through the composer → two turns end → the events are inspected → the two `request/header` reasons are asserted as `['initial', 'series']`.
- Non-obvious design decisions: the fixture is replayed with a `replay.override.json` sidecar so the second round's content is scripted; a *stable package inventory* is materialised inside the workspace (`:50-51`) so the model's file-structure answer has something real to read.
- Edge cases / failure handling: the first answer must keep its IconActions when Goal opens round two and the final answer must own a *second, distinct* action row — asserted by counting branch buttons and checking both are enabled.
- Surprising: the test also drives the content-font-size setting through the real settings service mid-flight and asserts the process row, the trigger and the group all resize together and are exactly 16 px apart — a typography contract asserted through live settings.

### apps/web/tests/smoke-real.e2e.ts
- Purpose: a real-host smoke that spawns `dsh web` with a real key and walks the full flow list.
- Key abstractions: `messagesResponse(text, complete)` — an SSE frame builder for a mock upstream; `authenticatedCookies` — a per-origin cache of the browser token exchange.
- Data flow: the built CLI is spawned on a probed free port → the browser signs in → chat rounds run → geometry and theme are checked → reload recovery is checked last.
- Non-obvious design decisions: "Selector convention: CSS Modules hash as `[hash]_[local]`, so class-substring selectors are unreliable — anchor on `data-*` attributes … prefer `data-*` for anything new" (`:8`); "Flow order matters: chat rounds first (the bash round reuses the first send's session) … Tests run sequentially in-file" (`:14`); the scenario self-skips without `DEEPSEEK_API_KEY` (repo e2e convention) and the vitest config loads the repo-root `.env` first, because "the CLI only auto-loads `.env` from its cwd — a temp dir here, so sessions never land in the repo's `.sessions`".
- Edge cases / failure handling: `DSH_TOOLS_MODE=ptc` collapses the provider wire tools to `run_code` with the SDK prompt section, and a partial transport failure must be retried through the shipped composition.
- Surprising: this file is the only place in the shard that talks to a **real provider**, and it is explicitly a manual/CI-with-key lane rather than part of the keyless default.

### apps/web/tests/plan-review.e2e.ts
- Purpose: the plan-review takeover — `/plan <task>` enters plan mode for real and the composer is occupied by a plan **decision card**, not the generic question flow.
- Key abstractions: `deriveReplayScript`; `captureExpandedTurnProcessAria`; two goldens (the waiting state owns the decision card, the approved state owns the transcript the approval leaves behind).
- Data flow: the recorded turn ends on `exit_plan_mode` blocking against the live `userInteraction` seam → the card mounts in the composer → the test clicks approve → the turn completes with the approval in the log.
- Non-obvious design decisions: "Replay is deterministic: the plan content arrives from replayed chunks, the review wait is real, and the approve click is the test's own gesture (the turn cannot complete without it, in record and replay alike)" (`:7-9`); a review that arrives while a global panel is open, and one that arrives for a Session whose sidebar layout was never saved, are separate cases.
- Edge cases / failure handling: a dismissed review must leave a permanent plan card that can be reopened; a pending review must survive a sidebar seat change and a Session switch.
- Surprising: the plan-review flow reuses the *same* mechanism as the question composer — a mid-turn block on the `userInteraction` seam — but with a different surface, which is why two separate files test the two surfaces.

### apps/web/tests/question-composer.e2e.ts
- Purpose: the resident question composer — the model asks, the browser answers, the turn completes.
- Key abstractions: `TIMED_WAIT_PARAMETER` from `@deepseek-ai/dsh-user-questions` (`:18`); `fixtureUserPrompts`.
- Data flow: `ask_user_question` blocks mid-turn → the composer renders in the browser → the test answers → the answer is in the log and the turn ends.
- Non-obvious design decisions: the test explicitly names the one legitimate place a drive step may react to model content: "the ONE place a drive step legitimately reacts to model content: the turn cannot complete without it, in record and replay alike" (`:8`).
- Edge cases / failure handling: an optionless answer grows to the same cap as an optioned one; a cancelled question expands to the cancellation verdict and the original questions; a queued reply stays read-only across a reload; a late answer is read as an answered question and its answers can be reopened.
- Surprising: the question surface and the plan surface are the *same* host seam with different clients, and both files document that the wait is real even in replay — only the model's words are scripted.

### apps/web/tests/session-log-upload.e2e.ts
- Purpose: the browser's "upload session log" switch, proven against real DeepSeek HTTP requests.
- Key abstractions: `startMockLlmServer` (a scripted upstream); `credentialRef('DSH_UPLOAD_BROWSER_KEY')`.
- Data flow: the switch is toggled in Settings → the profile patch is re-read → three prompts are sent → the mock server's captured bodies are inspected for the `dsh_session_log` field.
- Non-obvious design decisions: when the switch is off the field is **omitted entirely**, and when it is re-enabled the request resumes with `afterSeq` set to the earlier `throughSeq` and an event list containing the message sent while it was off (`:68-70`) — so the log is continuous, not restarted.
- Edge cases / failure handling: the switch's persisted state is verified in the profile patch file itself, not just in the DOM; the assertion polls the YAML rather than reading it once.
- Surprising: `deepSeekMissingCredential: true` is used even though a key is set — the scaffold masks the *environment* key so the credential must come from the credentials store.

### apps/web/tests/public-mount.e2e.ts
- Purpose: real Chromium exercises plugin bundles, RPC and the bidirectional Gateway stream through the prefix-stripping proxy.
- Key abstractions: `launchWebScaffold({ publicMount: { prefix } })`; the proxy's `public.localhost` authority.
- Data flow: the browser talks to `http://public.localhost:<port>/tools/dsh/` → the proxy strips the prefix → the backend answers; the test records every request URL and every mux frame sent/received.
- Non-obvious design decisions: the browser-facing authority is `public.localhost` because "Chromium maps `*.localhost` to loopback without a resolver" (`scaffold.ts:493`), and the proxy's authority is added to `trustedHosts` because the direct composition grants no trust.
- Edge cases / failure handling: Node-side requests emulate the browser by keeping the proxy's port while connecting to loopback.
- Surprising: the public mount is the only way this lane exercises the *deployment* shape; the same scaffold serves the plain loopback case with a different `baseUrl`.

### apps/web/tests/session-replay-reload.e2e.ts
- Purpose: recorded-session recovery — an active stream, a completed turn and a reopened session all survive a reload.
- Key abstractions: an `llm/stream` interceptor with `{ prepend: true }` that pauses the first text delta on a promise.
- Data flow: the recorded stream is held until the reloaded page has received its active baseline → the page reloads mid-stream → the same partial text must still be on screen → the stream is released → the turn settles → a second reload after completion → the session is reopened from the tree.
- Non-obvious design decisions: the scenario runs in **Chromium and WebKit** and shares the `fresh-round-trip` recording and expected output "without rewriting them" (`README.md:5`) — one expected file, two engines.
- Edge cases / failure handling: `acknowledgeReloadConnectionLoss(tripwire, warningStart)` removes only the connection-loss warnings emitted *after* the intentional reload, while gap-repair and discontinuity warnings stay fatal.
- Surprising: the reload happens *while* the stream is paused, so the recovery path is exercised against a genuinely in-flight stream rather than a completed one.

### apps/web/tests/queue-actions.e2e.ts
- Purpose: pending queue actions over the real HTTP/SSE wire.
- Key abstractions: `deriveReplayScript` + a per-run `replay.override.json` that parks consecutive turns; `expectTooltipOnTop`.
- Data flow: consecutive turns are parked → the page edits and removes exact queue occurrences by button or by keyboard → the active turn is stopped → the preserved Queue advances in FIFO order.
- Non-obvious design decisions: the same scenario runs with `method: 'button'` and `method: 'keyboard'` so both gesture paths are covered by one spec; a prompt sent *after* Stop must still run when a Goal round was queued behind stopped work (`:425`).
- Edge cases / failure handling: the layout must order Todo before Goal and Queue on one responsive card column; the collapsed, editing, sending and writer-held states each get their own golden.
- Surprising: the "writer-held" golden exists because a submission can be blocked on the session writer — a state the user sees as a spinner and which therefore needs its own snapshot.

### apps/web/tests/models-settings.e2e.ts
- Purpose: the Models settings page end to end over the real wire.
- Key abstractions: `assertModelInputLayout`; the derived credential reference.
- Data flow: the add card is opened → a key is typed → the reference is derived from the provider id → the key is stored **write-only** under that reference → the settings document records only the reference → the row appears after route-topology invalidation.
- Non-obvious design decisions: "a blank key saves a reference-free profile for provider-native auth, and typing an API key later stores it write-only under the derived reference (`MINIMAX_CN_API_KEY`) while the settings document records only that reference" (`:3-6`); the provider under test is `minimax-cn` "so a developer's real ANTHROPIC/OPENAI environment keys can never shadow the derived reference"; the customized-settings fold writes **merge patches** against the stored profile rather than whole objects.
- Edge cases / failure handling: "Each saved row appears after route topology invalidation **without presenting liveness as provider status**"; the deletion dialog distinguishes a reference-free profile from a page-managed key *before* the unsets reach the wire; a key no HTTP header can carry is refused before anything is written.
- Surprising: the test deliberately re-routes HTTP traffic so it can assert that the *upstream body* never carries the key.

### apps/web/tests/seeded-history.e2e.ts
- Purpose: the lane's broadest scenario — a recorded session seeded cold renders purely from the log with zero model calls.
- Key abstractions: `parseSeedFixture` / `realizeSeedFixture` / `renderSeedFixture`; `pinHostClock` + `pinBrowserClock`; `expandOwningTurnProcess`.
- Data flow: the fixture is realized against the scaffold's workspace, seeded through the real persistence API, then rendered by the client fold + the Host history RPC with no Agent activation at all.
- Non-obvious design decisions: "The cold session also carries keyless command-row surfaces: the seeded manual `/compact` lifecycle folds into its checkpoint, an Access-chip pick later runs `/permission` on the host, and `/feedback` pins its expandable correlation ids" (`:6-9`); ordinary instructions are omitted from Chat while their logged content is retained (`:481`).
- Edge cases / failure handling: short injected context stays out of Chat without dropping the event; blank reasoning rows around recorded text are omitted; the recorded file preview is restored in its original tab after a page reload.
- Surprising: "cold history paging **without Agent activation**" (`:3`) — the surface is deliberately exercised with no live agent, which is what makes it a history-RPC test rather than a session test.

### apps/web/tests/shipped-composition.e2e.ts
- Purpose: asserts the shipped Web composition's catalog, defaults, Loader lifecycle and one complete Auto producer-to-tool path.
- Key abstractions: `auditStartupEntries`, `composeEntries`, `loadOverlayPatches`; `RUN_CODE_NAME`; a test-local `LlmAdapter`.
- Data flow: the shipped base and web-app bundle patches are composed and audited → a preset producer is allowed to reach the background-job registry → a browser-authored Auto request is routed through the same model and asks the user after a denial → child calls are reviewed independently → a failed Auto initialization is rolled back before publishing tools.
- Non-obvious design decisions: "ships PTC with `run_code` but **without** the general workflow SDK binding" (`:650`) — the shipped tool surface is pinned exactly; the Auto rollback test proves the failure happens "before publishing or intercepting tools", so a half-initialised Auto never intercepts a call.
- Edge cases / failure handling: withdrawing Auto on Loader unload must not restore migrated live sessions.
- Surprising: this file asserts the *absence* of a shipped capability as carefully as its presence — a bundle accidentally pulling in the workflow SDK is a regression.

### apps/web/tests/sidebar-right.e2e.ts
- Purpose: the shipped right Sidebar over the real plugin graph — the largest single file in the shard.
- Key abstractions: `data-rightbar-col`, `data-sidebar-right-panel`, grip handles, fullscreen mode.
- Data flow: the frame owns the right column as a track; the panel anchors to the column's edge and slides in and out; the way back in while collapsed is "one button in the conversation header", which leaves when the panel opens.
- Non-obvious design decisions: "Which of the two presentations draws the panel is a recorded, reversible choice, so this file asserts against the frame's track as much as against the panel itself" (`:7`); "No overlay is applied — this scenario proves the surface is in the product's own composition" (`:2`); the copy is asserted in English on an English page and the Chinese draft is asserted and captured on its own page at the end.
- Edge cases / failure handling: the panel must keep the conversation still during fullscreen entry and install the hidden track without animation; a capacity-closed panel stays closed after widening and uses fullscreen on a narrow viewport; grip drags past both clamps survive; a pane whose last tab closes is dropped and follows the last-tab rule; the open surface survives a reload.
- Surprising: two tests are labelled "CONTROL" (`:357`, `:755`) — they call the host endpoint *directly*, bypassing the wire, to prove that the wire (not the endpoint) is what the other failures are about.

### apps/web/tests/session-archive-active.e2e.ts
- Purpose: archiving a Session whose turn is still running.
- Key abstractions: a replay override whose first stream calls bash with a long-running command; `readPersistedEvents`.
- Data flow: the plain archive is refused by the Host → the sidebar turns that refusal into a stop-and-archive confirmation → confirming stops the turn the way the stop button does → the aborted bash call settles with a `tool/result` and the turn ends as cancelled → the row hides.
- Non-obvious design decisions: the confirmation is a *different* gesture from the plain archive, and it routes through the same stop path — so the turn is genuinely cancelled rather than orphaned.
- Edge cases / failure handling: the restored Session continues the conversation from a regular log; the durable events are read back through a throwaway read handle that carries no synthetic closers.
- Surprising: "Unarchiving restores a Session that continues the conversation" — the restore is a *resume*, not a replay of dead text.

### apps/web/tests/plugin-install-approve.e2e.ts
- Purpose: an install whose build script the package manager refuses becomes an approval prompt, and the retry installs.
- Key abstractions: `profile.packageManager` — the scaffold's launcher-owned package-manager invocation.
- Data flow: Node stands in for pnpm: a `view` script answers the metadata check, and an `add` script first leaves the script undecided in `pnpm-workspace.yaml` (the way pnpm 11 does) and exits non-zero → the dialog offers an approval block naming the package → the test clicks "allow these scripts and retry" → the permission is persisted and the same `add` installs.
- Non-obvious design decisions: "pnpm's refusal becomes the approval block, naming the package whose script waits; **plain retry is not offered**" (`:56`) — the UI must not present a retry that will fail identically.
- Edge cases / failure handling: the policy file's exact pending text is asserted before the approval and the exact `native-package: true` after it.
- Surprising: the stub pnpm is a two-file shim in the profile directory, so the whole approval path runs against a real package-manager *process* rather than a mock.

### apps/web/tests/plugin-install-registry.e2e.ts
- Purpose: registry selection and fallback during a plugin install.
- Key abstractions: the `registry-ping.mjs` fixture (endpoint-scoped fetch interception); the `pnpm_command` overlay.
- Data flow: the dialog offers the configured registries → the check asks them in turn → the fastest responder is remembered → an install that loses its registry mid-run moves on to the next.
- Non-obvious design decisions: the stub `config` script names npm's own registry as pnpm's own so the mirror is a *fallback* for it; the stub `view` answers only when asked at the mirror and prints the refusal as JSON on stdout, the way pnpm does.
- Edge cases / failure handling: the request log is written to a file and the scenario asserts which registries were actually pinged (`:81-82`).
- Surprising: the "fastest responder" is decided by the *product's* probe — the test title itself is "selects the fastest responding registry %s, remembers it, and falls back after a registry failure" (`:16`) — and the fixture only controls the network.

### apps/web/tests/plan-control-row.e2e.ts
- Purpose: composer click areas and content-sized model collapse at the narrow viewport.
- Key abstractions: the `/plan` command changes mode without a model round; a providers-only fixture supplies the model catalog.
- Data flow: the plan chip is toggled through the live `/plan` command → the row is measured at 800×720 and after resizes.
- Non-obvious design decisions: "Goldens retain visibility, containment, and stability facts rather than pixel coordinates, which depend on platform fonts" (`:5-6`).
- Edge cases / failure handling: the model text collapses **only when the row needs space**, and the plan chip stays clickable at every width.
- Surprising: the scenario reaches the plan surface with a *providers-only* fixture — no model call — because the mode switch is a pure command.

### apps/web/tests/fold-blank-matrix.e2e.ts
- Purpose: the lane's largest *matrix* scenario — it proves that "On next message" folding never leaves a hole in the transcript, across ~30 combinations of surface, message origin, reader position, verbosity, fold timing and landing rule.
- Key abstractions: `Case` (surface × origin × reader × bodyParagraphs × mode × timing × landing, plus the `anchorFolds` / `roomUntilReply` exemptions); `Geometry` (`top`, `floor`, `spacer`, `maxGap`, `gapAt`, `tailGap`, `following`, `collapsing`); `installMeasure()` (the in-page `window.foldMeasure`); `holdFinishOf()` (a model-call barrier keyed on streamed *content*).
- Data flow: a seeded 8-turn / 6-step session is written through the real persistence API → the reader is placed (bottom, or a marker row centred/top) → the folding message arrives by one of seven origins → after the fold settles, and again after the Turn settles, the page's blank-area geometry is measured on **every animation frame** and compared against a 120 px limit.
- Non-obvious design decisions: the fold gate is the **largest uncovered band**, not the bottom of the last row — `installMeasure` unions the bounding boxes of every visible flow row (`:158`) and reports the biggest gap none of them covers, so a row that has faded but not finished shrinking still counts as covering its space (`:43-47`); the model-call barrier identifies its call by **streamed text content**, not by call order, "so auxiliary or reordered calls cannot shift the barrier" (`:447`); a "control" case asserts that **nothing** folded, because a steer or a parent notice opens no exchange (`:119-120`, `:845`).
- Edge cases / failure handling: seven message origins are covered, including a Turn that **fails before its user message is recorded**, a message from a *second tab*, a message queued behind a long live Turn, a message *steered into* a running Turn, and a parent Agent messaging the child Session; per-frame evidence JSON is written only on failure, or for every case under `FOLDMX_EVIDENCE=1` (`:841-843`); cleanup collects failures and rethrows them singly or as an `AggregateError` (`:864-869`).
- Surprising: a `roomUntilReply` case *exempts* the post-fold gap from the limit — "Content above the viewport never slides back down, so a short body leaves room until newer content fills it" (`:91`) — so the harness admits that a hole in the middle of a long transcript is not a defect, but a hole *above* the fold is.

### apps/web/tests/lifecycle-chrome.e2e.ts
- Purpose: the lane's "workspace flow / reload / dark mode" spec — the empty-state hero's first send materialises a real Workspace and Session over the wire, a reload rebuilds the whole surface from the log alone, and the dark palette is proven to cascade from a body attribute to a painted surface.
- Key abstractions: `fixtureUserPrompts` (the recorded prompt set, asserted against the live send); `captureStableAria` / `captureExpandedTurnProcessAria` / `compareOrRefreshGolden`; `acknowledgeReloadConnectionLoss`; a `session/event` collector on the Host `ctx` (`:60`).
- Data flow: the scaffold boots with the recorded `session.v3.jsonl` + a replay override and a 100 ms pace → a fresh Workspace is connected → the hero's composer sends → the Host materialises `<workspaceCwd>/workspace` as the Session's durable cwd → the page reloads and the transcript is re-rendered from the log with **zero further model calls** → the recovered conversation is compared to the pre-reload golden byte for byte.
- Non-obvious design decisions: the file deliberately **pins no theme golden** — "aria snapshots are color-blind (lane scope: the browser-e2e-lane Agent Note)" (`:10-12`) — so the dark case asserts *computed styles* instead; the theme scenario drives the `body[data-ds-dark-theme]` attribute directly rather than through Settings, "because the ThemeRuntime's DOM contract … [is] pinned independently of the settings surface's own lifecycle" (`:463-466`); the recovery claim is a *byte-equal* golden, "rebuilt from the log, it must render the same settled transcript the live turn produced" (`:447-448`).
- Edge cases / failure handling: the reasoning preview is asserted to be **empty once the reasoning stream ends** (`data-preview` is null and no streaming child is visible), so a stale preview cannot survive the turn (`:350-356`); the Think header's sticky rule is asserted in both states — collapsed it must **not** be `position: sticky`, open it must be `sticky` with `top: 0px` (`:413-424`); the test restores the settled state in a `finally` so the reload goldens are captured in the same shape (`:425-430`).
- Surprising: the workspace flow is proven from the **Host side** — `scaffold.ctx.sessions.list()` must show exactly one session whose header cwd is `<workspaceCwd>/workspace`, "the proof the send went through workspace materialization rather than a bare default-cwd session" (`:386-391`); and the first-turn reload works because the replay cursor was *fully consumed* before the reload, so any stray request would fail the scenario at `close()` (`:441-444`).

### apps/web/tests/layout-bottom.e2e.ts
- Purpose: the geometry and *lifetime* of the `shell.bottom` slot in the shipped Web composition.
- Key abstractions: `geometry(page)` — one `page.evaluate` that returns the bottom/main/sidebar/rightbar/overlay rects, every `[data-side]` handle and the page height; the `check(height, caption)` helper, which asserts the whole column system against one reserved height.
- Data flow: the scaffold boots with the `pin-browse-picker` overlay and the `@fixture/layout-bottom` bundle installed as an extra install anchor → the fixture registers into `shell.bottom` and owns its own height (240 → 360 → 0) → the test navigates to the Plugins panel and back, rewrites `data-platform`, shrinks the viewport, unregisters and re-registers the bundle, and collapses the slot.
- Non-obvious design decisions: the assertions are **relational across the whole column system** — bottom, main, sidebar, rightbar and every drag handle must all agree with the reserved height, and the page must not scroll (`pageHeight === viewportHeight`), so a bottom slot that pushes the document instead of reserving space fails (`:43-49`); the **occupant is not remounted** on main-panel navigation, proven by comparing the DOM node identity of the input across the navigation (`:62-63`).
- Edge cases / failure handling: the platform matrix (`darwin` / `windows` / `browser`) is faked by rewriting `data-platform` and `--dsh-windows-titlebar-height` on the document element, so the Windows title bar's 40 px caption is accounted for in the same assertions (`:66-74`); after unregistering, the slot must be *detached*, and after re-registering the input must be **empty** — a fresh occupant, not a resurrected one (`:78-86`); the console tripwire must be empty.
- Surprising: a re-registered bundle gets a **fresh** input (`:83`), so "the bottom occupant keeps its state" is bounded by the *bundle's registration*, not by the slot's.

### apps/web/tests/input-plugin-extensions.e2e.ts
- Purpose: proves an optional browser plugin can contribute to the composer *and* to the plugin-guidance surface without stealing the editor's ownership.
- Key abstractions: `fixture(enabled)` — a scaffold whose profile carries the fixture bundle with `enabled` true or false; the `conversation.input.activity` slot; the bundle-config / bundle-activation slots.
- Data flow: the fixture is installed through the **real Loader** → the activity button appears in the composer row → clicking it expands the activity and the model picker collapses → the plugin captures the current selection and inserts text → the insert is undone with the editor's own undo → the draft is then replaced and the insert is refused as stale.
- Non-obvious design decisions: the layout assertion is **relational at two viewports** (1280 and 420) — the activity button must sit between the model picker and the send button at both, and the bounds are read only after all three are non-null (`:36-43`); the stale-insert path is proven by the *status* the plugin shows ("Draft changed"), not by the text alone, so the plugin is forced to honour the boolean the editor API returns (`:56-57`).
- Edge cases / failure handling: the second scenario drives the **disabled** bundle: the activation dialog must not exist until the switch is flipped (`:69`), "Later" must leave the switch checked, and "Open setup" must navigate to the plugin's configuration page and *close* the dialog (`:78-80`); the tripwire must be clean in both.
- Surprising: the same file is the lane's proof that an extension point can be **offered and then declined** — the second test never sends a message at all, because a plugin's *configuration* surface is a product surface too.

### apps/web/tests/fixtures/account-login/cordis.patch.yml
- Cordis overlay for the account-login scenario: points the shipped deepseek-account provider at a loopback Platform double via a `{{origin}}` placeholder (no port committed) and marks `ui-settings-account` as step=done/completion=completed.

### apps/web/tests/fixtures/assembled-remote.fixture.json
- Generated 5,778-line JSON catalogue of canned Remote-RPC responses (`sessionList`, `settingsDescribe`, `credentialsDescribe`, `modelCatalog`, `agentPresets`, `commands`, `workspace`, `control`, `remoteEvents`, `follow`, `attachment`); sampled the head, tail and every top-level key instead of reading all 5,778 lines — see "Files skipped".

### apps/web/tests/fixtures/bonus-notice/cordis.patch.yml
- Same loopback-Platform-origin overlay as account-login, but deliberately overrides NO notice timing so the bonus notice comes from the product's own startup and settings-refresh paths.

### apps/web/tests/fixtures/context-meter-no-chat.patch.yml
- Two-line overlay that disables the `ui-chat` row so the context meter renders without the chat surface present.

### apps/web/tests/fixtures/deepseek-model-label-1017/account.overlay.yml
- Overlay that disables `llm-deepseek-account` (replay supplies the account route) and pins `agent-default-model` to provider `deepseek-official` / model `deepseek-flash`.

### apps/web/tests/fixtures/deepseek-model-label-1017/session.v4.jsonl
- Single-line session header row (type=session, version=4) with `{{session:1}}` and `{{cwd}}` placeholders — the fixture's only recorded event.

### apps/web/tests/fixtures/inspector-copy.patch.yml
- Four-line overlay setting `experimental-inspector` port=0 and `captureFetch: false` so the Inspector copies a random port and records no fetches.

### apps/web/tests/fixtures/native-open-on.patch.yml
- Three-line overlay pinning `session-controller.nativeOpen: true` so native-open controls render identically in headless CI.

### apps/web/tests/fixtures/office/preview.doc
- Binary OLE2 compound file (magic `d0cf11e0a1b11ae1`) — a legacy Word 97 document exported from LibreOffice Kit; cannot be read as text, and the accompanying README documents its content ("Office preview 中文文档") — see "Files skipped".

### apps/web/tests/fixtures/office/preview.ppt
- 606 KB binary OLE2 compound file — a legacy PowerPoint 97 fixture; not read line by line because it is a binary format, and its content is documented in `fixtures/office/README.md` — see "Files skipped".

### apps/web/tests/fixtures/office/preview.xls
- Binary OLE2 compound file — a legacy Excel 97 fixture; not read line by line because it is binary, and its content is documented in `fixtures/office/README.md` — see "Files skipped".

### apps/web/tests/fixtures/office/README.i18n.yaml
- Translation-pairing record for `fixtures/office/README.md`: per-heading-section hashes of the English and Chinese blocks, with the `pnpm run verify-translation-pairing --write` command to refresh them.

### apps/web/tests/fixtures/office/README.md
- Documents that `preview.doc`/`.xls`/`.ppt` are the one-page/one-sheet/one-slide fixtures from `dsh-libreoffice-kit` exported by LibreOffice 26.8.0.3, contain no user documents, and need no Office app or generator at test time.

### apps/web/tests/fixtures/office/README.zh.md
- Chinese counterpart of the binary Office fixtures README, stating the same provenance and the same "simple legacy imports, not complex-document fidelity" limit.

### apps/web/tests/fixtures/onboarding-native/cordis.patch.yml
- Three-line overlay setting `ui-settings-models.credentialOnboarding: false` so the native-onboarding lane skips the API-key dialog.

### apps/web/tests/fixtures/plugins/fixture-bundle/cordis.patch.yml
- Inserts three fixture rows (`@fixture/bundle`, `@fixture/bundle/search`, `@fixture/bundle/review`) so a bundle can expose independently localized subpath plugins.

### apps/web/tests/fixtures/plugins/fixture-bundle/fallback-icon.svg
- One-line 36×36 SVG circle with no fill — the icon served for the bundle's exported subpath entries via the `package.json` exports map.

### apps/web/tests/fixtures/plugins/fixture-bundle/icon.svg
- One-line 36×36 SVG circle filled `#145AF3` — the bundle's manifest icon.

### apps/web/tests/fixtures/plugins/fixture-bundle/index.js
- Five-line inert Cordis plugin (name = `fixture-bundle`, `apply()` with nothing to mount) used as the bundle's Host half.

### apps/web/tests/fixtures/plugins/fixture-bundle/locale/review/en.json
- Three-line locale file with an empty `meta` object — the English side of the review subpath plugin, deliberately forcing a per-field locale fallback.

### apps/web/tests/fixtures/plugins/fixture-bundle/locale/review/zh.json
- Six-line Chinese locale for the review subpath plugin, carrying `meta.title` "代码审查" and `meta.description`.

### apps/web/tests/fixtures/plugins/fixture-bundle/locale/search/en.json
- Five-line English locale for the search subpath plugin, carrying only `meta.title` "File Search" (the description falls back).

### apps/web/tests/fixtures/plugins/fixture-bundle/locale/search/zh.json
- Six-line Chinese locale for the search subpath plugin, carrying both `meta.title` and `meta.description`.

### apps/web/tests/fixtures/plugins/fixture-bundle/package.json
- Manifest declaring the bundle's exports map (`.`, `./search`, `./review`, `./icon`, `./search/package.json`, `./search/locale/*.json`, `./review/locale/*.json`) and its `dsh.bundle.patch` pointer to `cordis.patch.yml`.

### apps/web/tests/fixtures/plugins/fixture-bundle/review.js
- Two-line inert plugin module exporting `apply()` — the browser half of the review subpath plugin.

### apps/web/tests/fixtures/plugins/fixture-bundle/search.js
- Two-line inert plugin module exporting `apply()` — the browser half of the search subpath plugin.

### apps/web/tests/fixtures/plugins/fixture-bundle/search.package.json
- Five-line metadata sidecar for the exported search plugin ("Search plugin", its own icon and description).

### apps/web/tests/fixtures/plugins/fixture-input-extension/cordis.patch.yml
- Three-line overlay inserting the `@fixture/input-extension` bundle row.

### apps/web/tests/fixtures/plugins/fixture-input-extension/index.js
- Two-line no-op Host companion for the optional input-extension fixture.

### apps/web/tests/fixtures/plugins/fixture-input-extension/package.json
- Manifest declaring `dsh.client.platform: web` and exports `{".": "./index.js", "./client": "./client.js"}` — the split between a Host half and a browser half.

### apps/web/tests/fixtures/plugins/fixture-layout-bottom/client.js
- Purpose: the browser half of a client-only fixture that occupies the shell's bottom slot and owns its own height.
- Key abstractions: `window.__ModuleLoader__.load({ id, factory(require) })`; `ctx.slots.inject('shell.bottom', …)`; `ctx.slots.register({ name, locale })`; `ctx.locale.register('fixtureBottom', { en, zh })`.
- Data flow: the factory loads in the browser → the plugin registers a locale namespace and injects a `Bottom` React component into `shell.bottom` → the component renders a labelled input and two buttons that change its own height.
- Non-obvious design decisions: the height is **occupant-owned** — the plugin keeps it in its own React state (240 → 360 → 0) rather than the shell owning it, and `height === 0` returns `null` so the component *unmounts* instead of collapsing to zero (`:9-10`); the locale is registered for **both** `en` and `zh` from the same object, so the fixture is language-agnostic (`:22-23`).
- Edge cases / failure handling: the buttons use exact accessible names ("Grow bottom", "Collapse bottom") and the section carries `data-bottom-fixture` so the test can wait for it to detach; the `inject: ['slots', 'locale']` array declares the two services the plugin needs.
- Surprising: this bundle has **no** `cordis.patch.yml` — it is a client-only plugin, which is why the layout test installs it through `extraInstallAnchors` rather than through a Host overlay.

### apps/web/tests/fixtures/plugins/fixture-layout-bottom/index.js
- Two-line no-op Host companion for the bottom-slot browser fixture.

### apps/web/tests/fixtures/plugins/fixture-layout-bottom/package.json
- Nine-line manifest with `dsh.client.platform: web` and no bundle patch — the client-only fixture shape.

### apps/web/tests/fixtures/plugins/fixture-live-client/cordis.patch.yml
- Three-line overlay inserting the `@fixture/live-client` bundle row.

### apps/web/tests/fixtures/plugins/fixture-live-client/index.js
- Two-line no-op Host companion for the live browser lifecycle fixture.

### apps/web/tests/fixtures/plugins/fixture-live-client/package.json
- Manifest with both `dsh.bundle.patch` and `dsh.client.platform: web` — the fixture that is both mounted by the Host and loaded by the browser.

### apps/web/tests/fixtures/restart-startup.overlay.yml
- Five-line overlay injecting `web-restart-startup` and making `session-controller` inject `webRestartReady`.

### apps/web/tests/fixtures/shared-inspector.patch.yml
- Six-line overlay: `experimental-inspector` on port 0 with `captureFetch: false`, and `session-inspector` disabled so the shared Inspector owns the surface.

### apps/web/tests/fixtures/sidebar-terminal.patch.yml
- Eleven-line overlay pinning the `terminal-controller` row to `maxTerminals: 2`, a 2 s unattended timeout, 100 ms poll/retry intervals and an explicit `/bin/bash` shell.

### apps/web/tests/fork-mid-turn.e2e.ts
- Forks a recorded session at its first `tool/call` over HTTP and pins the two model-visible branch closers (outcome-unknown vs not-started) the fork seeds into the child's inherited history.

### apps/web/tests/github-ready-review.e2e.ts
- Signs a real GitHub JSON body with HMAC-SHA256, points the webhook overlay at a loopback server and asserts the ingress creates a browsable Workspace Session through the real adapter.

### apps/web/tests/goal-bar.e2e.ts
- Renders one active Goal strip, disarms it through the Host API, and clears it with a double-click to prove the acknowledged tombstone leaves neither stale chrome nor a duplicate-mutation error.

### apps/web/tests/goal-bar.overlay.yml
- Disables `goal-round-driver` so an active Goal cannot issue an unrelated model request during the bar test.

### apps/web/tests/goal-command-presentation.e2e.ts
- Proves `/goal` opts the command input into the human transcript while the command itself stays log-only, and that the bubble and result reload from the persisted command lifecycle.

### apps/web/tests/home-path-tilde.expected.e2e.ts
- jsdom assembled check that a home-descendant Workspace path renders as `~/Documents/project` while the copy button's `aria-label` still carries the full `/home/fixture/Documents/project`.

### apps/web/tests/image-display.expected.e2e.ts
- Assembled multimodal surfaces: history image galleries load real fixture bytes over `sessions.attachment` (blob scheme, not a `data:` fallback), plus paste/drop intake, ordered thumbnails, and batch refusal at the projected limit.

### apps/web/tests/inspector-late-enable.e2e.ts
- Enabling the Developer Tools bundle on an already-loaded page mounts the bottom DevTools without a reload; a `window` marker proves the document was never re-created.

### apps/web/tests/inspector-panels.e2e.ts
- Drives the real packaged DevTools Elements/Memory/Performance panels against the Host, inspecting CDP WebSocket frames to confirm `HeapProfiler.takeHeapSnapshot` and `Profiler.start/stop` actually completed.

### apps/web/tests/inspector-source-build.e2e.ts
- Loads the built DevTools under a nested deployment prefix with every cross-origin request aborted, then proves the formatter worker runs and a Memory snapshot renders — zero remote resource requests.

### apps/web/tests/interrupted-turn.e2e.ts
- Borrows a seeded recording and rewrites its final `turn/end` reason to `interrupted`, then pins the stopped summary and the interruption notice with no model call.

### apps/web/tests/live-job-stream.e2e.ts
- Real background bash run whose job row arrives over the job roster stream; expanding it opens the output observation stream and the panel shows live stdout, then settles in place on kill.

### apps/web/tests/markdown-cjk-strong.e2e.ts
- Eight CJK-adjacent strong-emphasis cases (full-width and ASCII punctuation before CJK text) rendered from a hand-built Session fixture and asserted through the real markdown renderer.

### apps/web/tests/markdown-file-links.e2e.ts
- Previews relative and absolute file links at the requested line without duplicate tabs, and opens parent-path prose and read-card links while retaining each address across reload.

### apps/web/tests/markdown-images.e2e.ts
- Real browser image loading with authentication of file requests, isolation of directly opened active content, and authored fallback text for failures.

### apps/web/tests/markdown-inline-code-links.e2e.ts
- Opens a complete HTTP URL written in inline code while leaving other code inert — the URL must be a full http(s) address, not a bare token.

### apps/web/tests/math-rendering.e2e.ts
- Renders every supported math delimiter (`$`, `\(..\)`, `\[..\]`, `$$..$$`, and inside table cells) with zero `.katex-error` elements and all 20 KaTeX font faces loaded.

### apps/web/tests/max-tokens-notice.expected.e2e.ts
- Assembled golden for the max-tokens turn-end notice, pinning the dot state (`dot=warning`) beside the copy because that is what distinguishes it from the error row.

### apps/web/tests/menu-material.e2e.ts
- Account and Session menus share transparency, blur, radius and shadow across palettes, the macOS backing tracks the card exactly with `pointer-events: none`, and the Settings dialog uses its own mask.

### apps/web/tests/message-actions.e2e.ts
- Message IconActions and clocks on settled history: branch is enabled only on the completed tail, the action tooltip must clear the sticky composer, and a fork from the settled message or the sidebar row preserves the completed fork prefix.

### apps/web/tests/message-feedback.e2e.ts
- Durable per-message feedback against the Host's canonical log: both ratings through the dialog, the Dislike persists, it can be retracted, and Session-level feedback records only on submit.

### apps/web/tests/model-menu-observer.e2e.ts
- Sticky model-group menus in Chromium and WebKit, counting only synchronous rect reads (`window.__modelMenuRectReads`) rather than FPS or latency.

### apps/web/tests/models-settings-recovery.e2e.ts
- Stored catalog drift stays repairable: a failed provider is shown beside healthy ones, an invalid edit is refused without persisting, and removing the obsolete model clears the error.

### apps/web/tests/navigation-panes.e2e.ts
- Trajectory ledger, timing overview, local record inspector, sidebar content search, session export and the bash terminal card, all over one rich two-turn seeded fixture rendered purely from the log.

### apps/web/tests/new-session-refused.e2e.ts
- An explicit New Session the Host refuses (a preset naming an unresolvable plugin) surfaces as a Workspace notice and leaves the Workspace without a Session and without an editable composer.

### apps/web/tests/no-sidebar-browser.overlay.yml
- Disables `ui-sidebar-browser` so the settings surface renders without a built-in browser provider.

### apps/web/tests/notice-wake-tail.e2e.ts
- A Turn the client did not submit (a subagent-settled notice) wakes while the reader follows the tail of a long Turn; the long Turn stays expanded and the notice and its reply appear at the tail.

### apps/web/tests/official-subagent-bundle.e2e.ts
- Official bundle activation reaches the real Claude SDK/CLI: a held native endpoint defers the child's completion until after the parent's first turn, and the workspace snapshot proves nothing else changed.

### apps/web/tests/onboarding-deepseek-config.e2e.ts
- First-run DeepSeek credential setup: the key is stored write-only, the takeover chrome never repaints on a configured reload, and removing the key empties the model list without replacing the saved default.

### apps/web/tests/onboarding-native.e2e.ts
- Native credential onboarding (with and without a desktop marker) shows the notice and Models settings without a second credential dialog and without any credential write.

### apps/web/tests/onboarding-usable-provider.e2e.ts
- A user who configures some other provider is never asked for the official DeepSeek key again, and the first-run setup card is closable without discarding the add card.

### apps/web/tests/open-in-app-ssh.e2e.ts
- Under SSH, the remembered Open-In app is hidden once the real host returns an empty catalog, while the remembered choice stays in `localStorage`.

### apps/web/tests/pin-browse-picker.overlay.yml
- Thirteen-line disable+insert pair that pins the in-browser directory picker, because the shipped `-auto` row resolves to a native OS chooser a Playwright page cannot drive.

### apps/web/tests/plugin-config.e2e.ts
- Plugin configuration pages: official host-plane namespace pages edited down to `$DSH_HOME/cordis.patch.yml`, the override badge and reset, staged edits that write only on save, and a community bundle's row configuration.

### apps/web/tests/plugin-hmr-lifecycle.e2e.ts
- Real pnpm plus the live profile's HMR: install, disable, enable, upgrade, uninstall, reinstall and a linked directory, with each step checked against the version its apply/disposal trace records.

### apps/web/tests/plugin-install-cancel.e2e.ts
- Cancels an installation, retries it, highlights the enabled plugin at 40% alpha, and recovers an unknown install result; also checks invalid-input styling in light and dark.

### apps/web/tests/plugin-install-github.e2e.ts
- A real Git reaches a controlled proxy failure or stall; the browser offers a mirror for a replacement spec and then another way, without retrying the failed address.

### apps/web/tests/plugin-manager.e2e.ts
- The plugin manager page over a managed scaffold profile: installed bundles and rows, bundle enablement, first-read skeleton alignment, delayed refresh hints, optional-feature previews, exported per-field locale fallback and IME-safe install fields.

### apps/web/tests/present-svg.e2e.ts
- An explicit file-card request delivers a real SVG: the file is written validly, the card appears before the final reply, and the compact card opens the single edited file.

### apps/web/tests/present-svg.overlay.yml
- Sets `session-controller.nativeOpen: false` so the transcript includes the no-desktop state on every test platform.

### apps/web/tests/present.e2e.ts
- Recorded source-file delivery, edits, reload, deletion and Session ZIP behaviour; a nested delivery is declared even when the enclosing program later throws a non-Error string.

### apps/web/tests/present.overlay.yml
- Pins `session-controller.nativeOpen: true` so native commands behave identically in headless CI.

### apps/web/tests/preview-boot.e2e.ts
- Boots the browser-only worker deployment out of the packed VFS image and reaches an interactive page, then proves the boot is the served profile boot (optional bundles listed, patches layered, lazy chunk fetched on demand).

### apps/web/tests/produced-file-mentions.e2e.ts
- Inline-code mentions of produced files: a unique name becomes a link, an ambiguous basename stays inert, and an unknown name stays inert.

### apps/web/tests/ptc-escalation.e2e.ts
- Real PTC sandbox denial followed by one approved program execution: the file stays absent until "Allow once", the denial result and the escalation arguments are both in the log.

### apps/web/tests/ptc-round.e2e.ts
- PTC mode round with nested sub-calls: the durable log carries `run_code` with full-content sub-dispatches, the code parent row shows always-visible nested sub-rows, and the trajectory exposes the recorded source.

### apps/web/tests/pwa-manifest.e2e.ts
- Checks the built web manifest carries no explicit `id` (so each mount keeps its own identity) and that the light and dark favicons are the same SVG with only the fill swapped.

### apps/web/tests/pwsh-terminal.e2e.ts
- Seed-authored pwsh call/result presented by the real `tool-pwsh` on replay must render as a terminal card with a parsed exit-status pill, not a generic console-fenced card.

### apps/web/tests/pwsh-terminal.overlay.yml
- Thirty-line overlay swapping the shipped bash stack for the PowerShell twin and disabling the permission row (which would refuse an unconfined executor) so the lane can render a seeded session.

### apps/web/tests/queue-image.e2e.ts
- A text-plus-image submission queued during a running turn renders a durable thumbnail, survives a stop as parked work, and delivers as the next turn's user message — the log holds only attachment references, never base64.

### apps/web/tests/rail-search-expand.e2e.ts
- Proves the rail's search control survives its own document-level bubble: the one real click must expand the sidebar AND leave the search expanded, a case jsdom cannot reproduce.

### apps/web/tests/reasoning-preview.e2e.ts
- A paused model adapter yields reasoning deltas stage by stage so the preview's completed paragraph first lines and right-edge fade can be observed across blank lines.

### apps/web/tests/reference-composer.e2e.ts
- The real Host discovers local files and cold sessions into one shared `@` menu, projects each pick as a complete inline range, and keeps a folder an atomic chip with breadcrumb drilling.

### apps/web/tests/remote-settings.e2e.ts
- A trusted remote browser uses the same Host settings service as loopback: welcome acknowledgement, model configuration and appearance persist across reloads and independent browser contexts.

### apps/web/tests/schedule-after.e2e.ts
- Conversational Schedule delivery: an "After" reminder renders as an ordinary assistant follow-up, "Every" records batch one latest occurrence and advance both schedules, and a local "At" reminder uses request-local browser context.

### apps/web/tests/search-card.expected.e2e.ts
- Assembled search card golden: the grep card's kind, truncation summary, per-file headers, visible match lines, expand control and recovery footer, serialized from the built bundles.

### apps/web/tests/server-restart.e2e.ts
- Persisted Session recovery across two real `dsh` server processes on the same port, with and without the startup barrier fixture that holds application boot.

### apps/web/tests/session-inspector.e2e.ts
- The optional Inspector renders a recorded Session through the shipped Web composition and highlights nearby Chat content when the selected recorded call is not currently displayed.

### apps/web/tests/session-unarchive.e2e.ts
- Archives a seeded session, restores it through the sidebar's archived filter, and keeps it restored across a reload from the Host baseline.

### apps/web/tests/sessionless-header.e2e.ts
- Global navigation before the first Session across web/win32/linux/darwin: the empty header geometry is preserved and the sidebar's open/close animation is settled before the reverse gesture.

### apps/web/tests/settings-appearance.e2e.ts
- Built settings controls share radius, border, fill and height across account, model and plugin pages in both palettes.

### apps/web/tests/settings-chrome.e2e.ts
- The settings modal shell and the Host-backed General preferences: section switching, both close paths, the dark-theme cascade, content/code font sizes, busy-state Enter behaviour and language persistence.

### apps/web/tests/settings-import.e2e.ts
- A `settings.yaml` left by earlier releases is imported into the profile once through the shipped entries, renamed to `settings.yaml.imported`, and its values reach the page.

### apps/web/tests/shared-inspector.e2e.ts
- The shared Inspector iframe toggled from the page and the iframe with no Session selected, a retained Client tree marked disconnected when the page goes away, and the open surface kept across Sessions.

### apps/web/tests/shell-command-details.e2e.ts
- A settled shell call rendered from durable arguments and its original result: the full command is selectable and the exit-status pill is parsed, in both foreground and background shapes.

### apps/web/tests/shortcuts-desktop.e2e.ts
- Desktop shortcut persistence through a substituted Electron preload transport: single keys and chords are recorded, persisted and prioritized over recorded history on macOS and Windows.

### apps/web/tests/shortcuts-fixed.e2e.ts
- Fixed approval rejection keys — Reject+Enter and Escape in the approval scroll container — reject through the real Remote waterfall without running the requested write.

### apps/web/tests/shortcuts-panels.e2e.ts
- Sidebar commands bound through the shipped Loader and the real sidebar/file/terminal owners, and rebound through the Web keybinding editor without touching browser-reserved defaults.

### apps/web/tests/shortcuts-workspace.e2e.ts
- Seven workspace owner operations run with saved bindings, and a first-turn fork refusal is explained and retried from the completed prefix.

### apps/web/tests/shortcuts.e2e.ts
- The shortcut reference sheet: opens, searches and restores nested focus in zh-CN/MacIntel and en-US/Win32, with inline editing and localized system feedback.

### apps/web/tests/sidebar-browser.e2e.ts
- Keyless Browser-tab coverage through the shipped composition, using a lifecycle-chrome recording as the session seed.

### apps/web/tests/sidebar-browser.overlay.yml
- Enables `ui-sidebar-browser` for its integration scenarios.

### apps/web/tests/sidebar-subagent-activity.e2e.ts
- A running descendant subagent is pinned on its visible idle owner row in the sidebar.

### apps/web/tests/sidebar-terminal.e2e.ts
- Shipped sidebar terminal over the real Loader, Remote mux, Chromium and local PTY: palettes, shell selection, resize, quota accounting, uplink frame validation and reconnection without minting a new terminal.

### apps/web/tests/sidebar-title-hover-scroll.e2e.ts
- Hovering a clipped session title marquees it to its own far edge, fades the moved left edge and returns to its start — the jsdom lane can only pin the positions the handler writes.

### apps/web/tests/skill-invocation-policy.e2e.ts
- The real host serves every user-invocable skill to the browser slash source, marking user-only (disable-model-invocation) entries while user-disabled quadrants stay hidden.

### apps/web/tests/skill-menu-plugin-change.e2e.ts
- Two pages: a blank Session's slash menu updates live when a second page switches the official badge skill bundle, while a global skill stays listed throughout.

### apps/web/tests/skill-tool-row.e2e.ts
- The real skill-load recording, seeded cold through the persistence seam, renders through `ui-skill`'s keyed toolview with replay-stable naming and exact durable output.

### apps/web/tests/skill-user-invoke.e2e.ts
- A user invokes a disable-model-invocation skill from the composer: the gesture becomes an ordinary user prompt, the rendered body is injected as named instructions context, and the answer is replayed.

### apps/web/tests/snapshots/agent-team-panel/resize.expected.md
- Committed aria golden for the Agent Team dialog after a resize: members, shared-task count, and a long task description truncated behind a "Show more" control.

### apps/web/tests/snapshots/agent-team-panel/task.expected.md
- Committed aria golden for the Agent Team dialog with one shared task, pinning its owner, status and write scopes.

### apps/web/tests/snapshots/live-job-stream/settled.expected.md
- Committed aria golden for the background-job list after the job was killed: the expanded row shows its command, the SIGTERM signal and the captured output line.

### apps/web/tests/snapshots/live-job-stream/streaming.expected.md
- Committed aria golden for the background-job list while the job is still running, with a Stop task control and a duration placeholder.

### apps/web/tests/snapshots/preview-boot/source-chooser.expected.md
- Committed aria golden for the Preview data source chooser: three radio options with the showcase checked and the WebFS directory disabled.

### apps/web/tests/snapshots/streaming-fence-highlight/mid-stream.expected.md
- Committed mid-stream golden pairing the aria snapshot with the Shiki token-by-token style array for a TypeScript fence.

### apps/web/tests/standalone-string-editor.e2e.ts
- A standalone global tool from a custom Host patch reaches the PTC SDK: the request carries only `run_code`, the system prompt mentions the editor, and the sub-dispatch is persisted.

### apps/web/tests/standalone-string-editor.overlay.yml
- Inserts the `optional-tool-str-replace-editor` row.

### apps/web/tests/startup-auto-selection.e2e.ts
- Startup Session opening preserves the resident Hero tree, observed by recording every distinct conversation-root phase during one page load.

## Ideas worth stealing

- **The replay fixture must be FULLY CONSUMED, or the scenario fails** — `apps/web/tests/scaffold.ts:1003` — `replayHandle?.assertConsumed()` runs in teardown, *before* the world is disposed, so a scenario that drove fewer model calls than the recording contains fails loudly instead of drifting green. Transfer to August: an LLM replay/record harness should assert that the scripted transcript was completely consumed; a test that silently under-exercises the model path is worse than no test, because it looks green.
- **An adapter that answers route queries but THROWS on any stream** — `apps/web/tests/scaffold.ts:234` (the `RouteOnlyAdapter`) and `apps/web/tests/scaffold.ts:259` (its `stream()` throws "a model call was issued by a scenario that declared no replay fixture") — the tree must still answer `listProviders()`/`resolveModel` because surfaces legitimately gate on whether any adapter serves a session's route, but a scenario with no fixture must not be able to make a model call quietly. Transfer to August: keep a "route-only, stream-hostile" adapter registered in the default test profile.
- **Capture an aria snapshot only when it has stopped changing** — `apps/web/tests/scaffold.ts:1647` — `expect.poll` compares two consecutive *normalized* captures and only then returns one. The comment says why: "a single-shot capture races the last React commits". Transfer to August: every golden that reads live DOM should poll for stability, and the normalizer must run *before* the comparison so that volatile values (durations, uuids, cwd) cannot mask a real change.
- **Console tripwires: a reconnect warning or a page error fails the scenario** — `apps/web/tests/scaffold.ts:1778` — the regex `/connection lost|gap repair|discontinuous/i` collects warnings, and `pageerror` collects exceptions; both are asserted empty at scenario end. The escape hatch is precise: `acknowledgeReloadConnectionLoss` (`apps/web/tests/scaffold.ts:1790`) removes *only* the connection-loss warnings emitted after an intentional reload, leaving gap-repair and discontinuity fatal. Transfer to August: make silent wire degradation a test failure with a narrow, explicitly-scoped exemption.
- **A missing golden fails with the healing command; only refresh mode may write** — `apps/web/tests/scaffold.ts:1717` — "missing golden … — run `DSH_SNAPSHOT=refresh` … to generate it". The golden is never self-bootstrapped in replay mode. Transfer to August: goldens must have exactly one writer and a named regeneration command; a test that silently creates its own expectation proves nothing.
- **A boundary-aware path replacer, not a blind string replace** — `apps/web/tests/scaffold.ts:1105` (`isWebCwdMatch`) — the cwd token is only substituted when the surrounding characters form a path boundary, so a cwd that is a prefix of a longer path is left intact. Transfer to August: snapshot normalisation that rewrites paths must respect boundaries or it will corrupt unrelated text.
- **Composition divergences are include patches over the SAME tree, never a second file** — `apps/web/tests/scaffold.ts:573` — "a patch id that stops matching a row fails the boot sweep loudly instead of drifting". A test tree that diverges from the product by editing a copy of the config file tests the copy. Transfer to August: the harness must patch the *shipped* configuration in place, so an id rename breaks the test loudly.
- **Split the configuration into "live fields" and "process-specific" fields** — `apps/web/tests/scaffold.ts:711` — live fields (agent, model, provider, preset, locale, permission…) live in a shared deployment layer, while ports, roots and file paths stay in CLI overlays; the scaffold moves the former into a synthetic "deployment defaults" bundle that sits *below* the editable profile values. Transfer to August: keep product defaults and machine-local values in separate layers so a test can override the machine without changing the product.
- **A real provider catalog with a deliberately large context window** — `apps/web/tests/scaffold.ts:214` — the replay provider publishes `contextWindow: 128_000` (and 1,000,000 for the vision model) specifically so that "compaction-basic's post-step pressure check would warn every step" does not fire on small fixtures; the comment at `:205-209` explains that a catch-all route would leave `resolveModelInfo` unroutable. Transfer to August: when a fixture is small, widen the declared context window rather than letting pressure heuristics fire spuriously.
- **The client-import ban, and the mirror-it-instead rule that makes drift loud** — `apps/web/tests/README.md:35` and `apps/web/tests/scaffold.ts:104` — importing a Client package from a Host-face test drags its whole TS project into the Host build graph (it has bitten this lane once). The fix is not a lint rule but a convention: mirror the constant next to a commented-out import, so a drift shows up as a missed selector or a stale value — "a loud failure, never a silent pass". Transfer to August: cross-layer constant duplication is acceptable *only* if the drift is guaranteed to fail a test.
- **Host-face tests type-check in a different program than the Client aggregate** — `apps/web/tests/README.md:27` — "Driving a browser at runtime does not make a file part of the Client program — the two faces merge Cordis `Context` under the same keys with different services, so one program cannot see both." Transfer to August: keep the browser-driving test files in the host program so that moving them into the client program fails to compile, rather than silently changing which services they see.
- **Hold real Host frames at the WebSocket, per stream, and release them in FIFO order** — `apps/web/tests/idle-submission-handoff.e2e.ts:36` (the `page.routeWebSocket('**/api/remote.mux')` interceptor) and `apps/web/tests/idle-submission-handoff.e2e.ts:76` (`releaseThrough`) — this makes delivery-order races deterministic *by construction* instead of by timing luck, and the scenario then runs under 6× CPU throttling (`apps/web/tests/idle-submission-handoff.e2e.ts:142`) so the race stays real. Transfer to August: a gateway-level frame gate is the only way to test "the same event delivered in two orders" honestly.
- **Assert the *position* of a message, not just its presence** — `apps/web/tests/idle-submission-handoff.e2e.ts:193` — the message's `messageTop` and the composer's `composerTop` must be identical at every phase of the handoff, so a submission that jumps in the transcript between phases fails. Transfer to August: for any "it landed in the right place" requirement, assert the geometry, not the presence.
- **Drive steps must wait on generic completion, never on model content** — `apps/web/tests/replay-round-trip.e2e.ts:4` — "Drive steps run in every mode and wait only on generic completion (`whenTurnSettled` — never model-content selectors, so record cannot hang on a live model answering differently)". The one exception is named explicitly: a step that reacts to model content is allowed only where the turn genuinely cannot complete without the human's answer (`apps/web/tests/question-composer.e2e.ts:8`). Transfer to August: this removes the entire class of "the live model said something different and the test timed out".
- **Failure injection through a sidecar, authored against the derived script** — `apps/web/tests/live-interactions.e2e.ts:9` — the recorded chunks are *derived* from the fixture (`deriveReplayScript`), and the sidecar is authored per run in a temp dir with three verbs: `hang` (plus a ready-file marker that makes a mid-stream cancel deterministic), `throw` (with stable codes) and `{ patches }` (transient failures before or instead of the recorded success). Transfer to August: a failure-mode test should patch the transcript, not fork a second recording.
- **The teardown comment that says the cleanup failure IS the assertion** — `apps/web/tests/live-interactions.e2e.ts:72` — "scaffold.close() failures MUST fail the scenario: `assertConsumed()` is the fixture-drift tripwire and cleanup problems are real defects. Run every teardown step regardless, then rethrow what failed." Transfer to August: never swallow teardown errors; the cleanup step often carries the strongest assertion you have.
- **Prove "no reload" with an in-page entropy token** — `apps/web/tests/hmr-live.e2e.ts:137` — `crypto.getRandomValues` inside the page (the only entropy source available in every context) is compared before and after the change; an import would not survive serialization. Transfer to August: HMR/streaming claims need a document-identity witness, not a timing heuristic.
- **Measure real overlap and hit-testing, because ARIA cannot see stacking** — `apps/web/tests/jobs-menu-layering.e2e.ts:26` — `document.elementFromPoint` over a 3×3 grid of the intersection proves the menu paints *above* the dock; z-index and DOM order prove nothing about a clipped overlay. Transfer to August: any "it is on top / not clipped" requirement needs a hit test.
- **A negative control inside the regression** — `apps/web/tests/focus-rings.e2e.ts:404` — "negative control: blanket shadow suppression destroys input and card paint and misses descendants" — the test proves that the *over-broad* fix is worse than the bug, so the rule is scoped rather than global. Transfer to August: every suppression rule should carry a case that shows the blunt version breaks something.
- **Goldens record relations, never pixels** — `apps/web/tests/markdown-wide-table.e2e.ts:15` — "The golden records relations and booleans, never pixels: absolute widths document the platform, not the behavior"; the same idea recurs in `apps/web/tests/plan-control-row.e2e.ts:5` ("visibility, containment, and stability facts rather than pixel coordinates, which depend on platform fonts"). Transfer to August: geometry goldens must be portable across machines, or they will be regenerated rather than respected.
- **Fake the calendar, not the scheduler** — `apps/web/tests/pinned-clock.e2e.ts:8` — the host shift is spread over one 2^32 ms period because the browser truncates a negative `setTimeout` delay to 32 bits, and in about half of that period the result is a *positive* delay of weeks that stops every page timer. The fix is a `Date` Proxy installed for every later document, leaving native timers and `requestAnimationFrame` on real scheduling. Transfer to August: any test that pins time must not accidentally pin the scheduler; the 2^32 boundary is the reason a naive clock mock breaks.
- **Read the cascade, not the stylesheet** — `apps/web/tests/sidebar-scrollbar.e2e.ts:2` — the reserved band and `timeCoveredBy` together distinguish reserved space from a bar painted over content, because headless Chromium uses overlay scrollbars; the pseudo-element's computed style is read because it folds in `:hover`. Transfer to August: scrollbar/thumbnail assertions need two independent facts, not one.
- **Assert a request budget, and make the failure message list the calls** — `apps/web/tests/startup-rpc-budget.e2e.ts:10` and `apps/web/tests/startup-rpc-budget.e2e.ts:42` — cold boot may issue at most two `settings/describe` calls regardless of plugin count ("One eager read plus one first-connection reset closes the pre-subscription commit window"), and the failure prints every `/api` call the page made. Transfer to August: an RPC-budget gate is a cheap, high-value guard against a client plugin multiplying boot chatter.
- **The PWA manifest must have no explicit `id`** — `apps/web/tests/pwa-manifest.e2e.ts:13` — "a browser resolves an explicit `id` against the start URL's origin, so only an absent `id`, which defaults to the resolved `start_url`, gives each mount its own identity". Transfer to August: if the harness can be served under multiple prefixes, the manifest identity must be derived, not fixed.
- **A migration must not rewrite its input** — `apps/web/tests/preset-migration.snapshot.ts:131` — `expect(await readFile(predecessor)).toEqual(source)` after the forward projection, alongside a corrupt-header sibling that must be excluded from the listing but still throw on a direct open (`apps/web/tests/preset-migration.snapshot.ts:132`). Transfer to August: forward-migrate by publishing a new artifact and leave the old bytes alone; a migration that rewrites history cannot be re-run.
- **A plugin's detail contribution is scoped by subject** — `apps/web/tests/fixtures/plugins/fixture-live-client/client.js:32` — `const mine = (subject) => (subject.kind === 'bundle' || subject.kind === 'row') && subject.pkg.name === '@fixture/live-client'` — "another bundle's page gets nothing from these entries". Transfer to August: extension points must be able to decline a subject, and the decline must be the default for other extensions' surfaces.
- **An extension's insert must be stale-safe and undoable** — `apps/web/tests/fixtures/plugins/fixture-input-extension/client.js:30` — `if (inputActions.insertText(' from plugin', span)) close()` — the API returns a boolean and the plugin shows a "Draft changed" status instead of overwriting a newer draft; the insert is undoable with the editor's own undo. Transfer to August: an editor extension API must refuse a stale insert rather than clobber.
- **Restore the original transport on unload and scope the interception to the endpoints under test** — `apps/web/tests/fixtures/registry-ping.mjs:13` — only the two npm ping URLs are intercepted; everything else falls through to the original `fetch`, and the hung requests are awaited via `AbortSignal.any` before the original is restored. Transfer to August: a test double for the network should be as narrow as possible and must be reversible.
- **A startup barrier that cannot deadlock** — `apps/web/tests/fixtures/restart-startup.js:13` — the hold waits on a process IPC message, refuses to start without an IPC channel (`:14`), and resolves the barrier with `false` on disposal so a torn-down plugin unblocks the boot instead of hanging the process. Transfer to August: any test barrier needs an abort path, not just a release path.
- **Node standing in for pnpm, refusing the build script the way pnpm 11 does** — `apps/web/tests/plugin-install-approve.e2e.ts:23` — the stub `add` leaves the script undecided in `pnpm-workspace.yaml` and exits 1, so the *product's* approval path runs against a real package-manager process; and the UI must not offer a plain retry, because it would fail identically (`apps/web/tests/plugin-install-approve.e2e.ts:56`). Transfer to August: stub the package manager at the process boundary, not the API boundary, and forbid retry affordances that cannot succeed.
- **A registry choice is made by the product's own probe, not by the fixture** — `apps/web/tests/plugin-install-registry.e2e.ts:16` — the fixture only controls the network (which registry answers, which one stalls); the "fastest responder" logic is the product's. Transfer to August: control the environment, not the decision.
- **The "CONTROL" tests bypass the wire on purpose** — `apps/web/tests/sidebar-right.e2e.ts:357` and `apps/web/tests/sidebar-right.e2e.ts:755` — two tests call the host endpoint directly to prove that the *wire* (not the endpoint) is what the other failures are about. Transfer to August: when a chain test fails, add a control that isolates which link broke.
- **A test that jsdom provably cannot do, done in a real browser** — `apps/web/tests/rail-search-expand.e2e.ts:5` — "The package-level jsdom test cannot replay that continuation (`fireEvent` does not re-bubble through listeners mounted mid-dispatch), so the guard … is pinned here, in the assembled application under a real browser click." Transfer to August: when a unit environment cannot reproduce an event order, say so in the test file and move the assertion to the layer that can.
- **A proxy that rewrites cookies and replays upgrades raw** — `apps/web/tests/prefix-proxy.ts:59` (`rewriteCookies`, rewriting the backend's `Path=/` to the mount) and `apps/web/tests/prefix-proxy.ts:95` (the upgrade handler) — an upgrade "speaks its own hop-by-hop framing, so it cannot ride the request handler". Transfer to August: if the harness serves the app under a prefix, cookies and websockets both need explicit handling.
- **A fold is measured as the largest UNCOVERED BAND, not as the last row's bottom** — `apps/web/tests/fold-blank-matrix.e2e.ts:158` — the measurement unions the boxes of every visible flow row and reports the biggest gap none of them covers, so a row that has faded but not finished shrinking still counts as covering its space. Transfer to August: a compaction or collapse-animation test should measure *coverage*, not a last-row offset; the naive measure passes while a hole is on screen.
- **A model-call barrier keyed on streamed CONTENT, not on call order** — `apps/web/tests/fold-blank-matrix.e2e.ts:447` — "The call is identified by its replayed content, so auxiliary or reordered calls cannot shift the barrier." Transfer to August: when a harness must hold "the model's Nth answer", identify it by what it said, because auxiliary and reordered calls are the normal case in a real loop.
- **A negative case that asserts NOTHING happened** — `apps/web/tests/fold-blank-matrix.e2e.ts:845` — a steer or a parent notice "opens no exchange and folds nothing", and the case asserts that no sample was ever `collapsing`. Transfer to August: a positive-only matrix hides the cases where a mechanism fires when it should not; the control cases are what prove the trigger is narrow.
- **Bound the number of frames allowed to violate the limit** — `apps/web/tests/fold-blank-matrix.e2e.ts:849` — `expect.soft(transient.length, 'animation frames with a layout gap').toBeLessThanOrEqual(TRANSIENT_FRAMES)`: the steady state is bounded to 120 px, and a *single* animation frame is allowed to exceed it. Transfer to August: a layout/animation invariant should be stated as "settled state + at most N transient frames", not as an instantaneous one.
- **Pin the theme contract by driving the attribute, not the settings surface** — `apps/web/tests/lifecycle-chrome.e2e.ts:477` — the test sets `body[data-ds-dark-theme]` directly "because the ThemeRuntime's DOM contract … [is] pinned independently of the settings surface's own lifecycle", and it asserts three things: the alias token flips, a *painted* surface repaints, and removing the attribute restores the light values exactly. Transfer to August: separate the theme *mechanism* from the theme *UI*; a variable that flips but paints nothing is a silent failure.
- **Assert a sticky rule in BOTH states, including the state where it must be absent** — `apps/web/tests/lifecycle-chrome.e2e.ts:415` — collapsed, the header's `position` must **not** be `sticky`; open, it must be `sticky` with `top: 0px`. Transfer to August: a CSS-behaviour test that only checks the "on" state will not notice a rule that leaks into the "off" state.
- **Prove the workspace flow from the Host side, not from the DOM** — `apps/web/tests/lifecycle-chrome.e2e.ts:390` — `scaffold.ctx.sessions.list()` must show exactly one session whose durable header cwd is `<workspaceCwd>/workspace`, "the proof the send went through workspace materialization rather than a bare default-cwd session". Transfer to August: assert the *durable* effect (the stored record), not the visible effect (the row that appeared).
- **Re-registering a slot's occupant gives it a FRESH state** — `apps/web/tests/layout-bottom.e2e.ts:83` — after the bundle is removed and re-created, the bottom input is empty and the height is back to its default. Transfer to August: when an extension is disabled and re-enabled, say explicitly whether its state survives; the test should pin whichever answer the product intends.
- **An extension point that is offered and then DECLINED is still a product surface** — `apps/web/tests/input-plugin-extensions.e2e.ts:69` — the disabled bundle's activation dialog must not exist until the switch is flipped, "Later" must leave the switch checked, and "Open setup" must navigate to the configuration page. Transfer to August: a plugin's install/activation UX is part of the product and deserves its own end-to-end coverage, including the path where the user says no.

## Files skipped (with reasons)

- `apps/web/tests/fixtures/office/preview.doc` — a binary OLE2 compound file (magic `d0cf11e0a1b11ae1`), 9,216 bytes, a legacy Word 97 document. Not read line by line because it is binary; I read its header bytes to confirm the OLE2 signature and took its content and provenance from `fixtures/office/README.md`.
- `apps/web/tests/fixtures/office/preview.xls` — a binary OLE2 compound file, 5,632 bytes, a legacy Excel 97 workbook. Same reason; header bytes confirmed the signature.
- `apps/web/tests/fixtures/office/preview.ppt` — a binary OLE2 compound file, 606,720 bytes, a legacy PowerPoint 97 presentation (the largest file in the shard). Same reason; header bytes confirmed the signature.
- `apps/web/tests/fixtures/assembled-remote.fixture.json` — a **generated** 5,778-line / 155,885-byte JSON catalogue of canned Remote-RPC responses for the built-client harness. I read the first ~3,000 characters, the last ~80 lines and enumerated every top-level key (`sessionList`, `settingsDescribe`, `credentialsDescribe`, `modelCatalog`, `agentPresets`, `commands`, `workspace`, `control`, `remoteEvents`, `follow`, `attachment`) and inspected the `control` block's permission options, plan state, token usage, context pressure/breakdown, session statistics and image limits plus the base64 PNG in `attachment`; I did not verify the interior of every RPC group line by line.

## Uncertainties

- **`apps/web/tests/fixtures/assembled-remote.fixture.json` is only partially read.** I established its shape (11 RPC groups, an `ok`/`value` envelope per group, a `control` block carrying permissions/plan/goal/tokenUsage/contextPressure/contextBreakdown/sessionStats/imageLimits) but did not check the interior of `commands`, `workspace`, `remoteEvents`, `follow` or `agentPresets`. The file's consumers (`assembled-boot.ts` / `assembled-remote.ts`, both in other shards) were outside my shard, so I could not confirm which of its branches are actually exercised.
- **The largest scenario files were read by structure, not line by line.** `plugin-manager.e2e.ts` (1,128 lines), `sidebar-right.e2e.ts` (1,122), `settings-chrome.e2e.ts` (1,094), `shipped-composition.e2e.ts` (1,036), `schedule-after.e2e.ts` (1,201), `seeded-history.e2e.ts` (926), `smoke-real.e2e.ts` (836), `fold-blank-matrix.e2e.ts` (875), `preview-boot.e2e.ts` (783), `sidebar-terminal.e2e.ts` (678), `lifecycle-chrome.e2e.ts` (650), `question-composer.e2e.ts` (650), `models-settings.e2e.ts` (545), `navigation-panes.e2e.ts` (534), `queue-actions.e2e.ts` (503), `message-actions.e2e.ts` (490), `plan-review.e2e.ts`, `plugin-config.e2e.ts` (405), `sidebar-scrollbar.e2e.ts` (403), `reference-composer.e2e.ts` (387) and `shared-inspector.e2e.ts` (335) were read via their headers (30–40 lines, which carry the design comment and the imports) plus a complete inventory of their `it`/`describe` titles. Their per-assertion detail is therefore characterised by the *scenario names and the header comment* rather than by every assertion; I did not verify the body of any individual test in those files. `scaffold.ts` (1,796 lines) is the one large file I read in full, and in this pass I also read `fold-blank-matrix.e2e.ts` (header, case matrix, measurement function, model-call barrier and the case loop), `lifecycle-chrome.e2e.ts` (header, all 13 test titles, the first-send / reload / dark-theme / Think-sticky scenarios) and `layout-bottom.e2e.ts` and `input-plugin-extensions.e2e.ts` in full.
- **`support.ts` is not in my shard but shapes every file in it.** I read it (339 lines) to understand the shared helpers (`connectFreshWorkspace`, `writeComposerDraft`, `pinBrowserClock`, `pinHostClock`, `scrollIntoView`, `expectTooltipOnTop`, `captureStableAria`'s sibling `expandTurnProcesses`, `requireBuilt`, `PLUGIN_TOGGLE_SETTLE_MS`), and several notes above cite its reasoning (e.g. the Playwright `page.clock` 32-bit truncation note). Those helpers are owned by another shard; if that shard's owner read it differently, my reading of *why* the tests behave as they do may need revisiting.
- **`chat-scroll-fixture.ts` is not in my shard** but `fold-blank-matrix.e2e.ts` depends on it for the seeded 8-turn / 6-step transcript (`createChatScrollFixture`). I read the *call site* and the shape of what it must produce, not the generator itself.
- **The `expected/` and `snapshots/` golden directories are mostly outside my shard.** `apps/web/tests/expected/` holds eight files (not in my shard) and `apps/web/tests/snapshots/` holds exactly my six files; the much larger `snapshots/` tree at the repo root (`snapshots/web/…`, `snapshots/session/…`) is owned by other shards. Where a scenario points at a committed golden I named the *file* it compares against but did not read that golden's content, except for the six under `apps/web/tests/snapshots/` that are in my shard.
- **The `cordis.patch.yml` include-patch semantics were inferred, not read at the source.** I read the lane's own overlays and the schema import (`entryListSchema`), and `scaffold.ts:573-596` describes the composition order and the disable+insert idiom, but the implementation of `composeEntries` / `loadOverlayPatches` / `mountRootInclude` lives in `@deepseek-ai/dsh-app-boot`, outside this shard. My description of how a patch id stops matching a row is therefore the lane's own stated intent, not something I verified in the implementation.
- **I did not verify that the lane actually passes.** The rules forbid executing anything from the clone, so no scenario was run; every statement about behaviour is derived from the code and its comments. Where a file asserts a *product* behaviour (e.g. that `preset-migration` publishes a specific event tail), I report the assertion, not a confirmed outcome.
- **`apps/web/tests/fixtures/plugins/fixture-layout-bottom/cordis.patch.yml` does not exist** — the bundle is client-only and has no patch file (its `package.json` carries only `dsh.client.platform: web`), which I confirmed by reading the manifest list and the bundle's `package.json`; and `apps/web/tests/fixtures/plugins/fixture-bundle/fallback-icon.svg` is referenced only from the bundle's `exports` map, which I read.
- **The manifest was not modified.** I found no evidence that its `dsh-apps-web#3` column is wrong for this shard — every one of the 176 rows named a file that exists in the clone — so I left it read-only as instructed.

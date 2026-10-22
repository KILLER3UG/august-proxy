# deepseek-harness / dsh-apps-web#2

## Shard shape

This shard is **the golden-snapshot corpus of the `apps/web` browser e2e lane** — 232 files, 229 KB, all under `apps/web/tests/`. It contains two kinds of artefact that belong together. (a) Three Playwright/Vitest e2e specs at the top of `apps/web/tests/` (`feedback-command.e2e.ts`, `feedback-release.e2e.ts`, `file-upload-round.e2e.ts`), each of which boots the **real** shipped web composition in-process (the `dsh-base` + `dsh-web-app` bundle patches over an empty profile root, through the vendored Cordis Loader) and drives a real Chromium over real HTTP and WebSocket. (b) 229 committed expected-state files under `apps/web/tests/expected/`, arranged in 81 scenario directories plus 8 root-level files, which are the *only* comparison surface those specs assert against. The expected files are not ordinary unit-test snapshots: they are a mix of Playwright `ariaSnapshot()` accessibility trees (219 `.md`), browser-measured geometry JSON/JSONL-in-markdown (6 `.json`), and hand-written scenario transcripts that read like a lab notebook (4 `.txt`). Every expected file is written by exactly one writer — `DSH_SNAPSHOT=refresh` — and compared byte-for-byte in replay mode; a missing golden is a hard failure with a healing command, never a silent bootstrap. The lane's mechanics live in `apps/web/tests/scaffold.ts` (which I read for context but which is owned by another shard); the three specs in *this* shard are the lane's three most mechanism-heavy scenarios: the `/feedback` command that settles **without a model turn**, the feedback **telemetry release contract**, and the **file upload round trip** through the real assembly. Together they pin down the agent loop's front door (how a turn starts, what a user can interject while it runs, what may be released out of it, and what a staged attachment must guarantee before the model is allowed to touch it).

---

## Per-file notes

### apps/web/tests/feedback-command.e2e.ts
- **Purpose:** Keyless browser e2e for the `/feedback` slash command, which is a **command-plane** operation: the host appends a log-only `command/run` + `feedback/record` + `command/done` lifecycle and settles **without a model turn**. The transcript must render the acknowledgement as a persistent command row carrying the session id and an anonymous user id.
- **Key abstractions:** `launchWebScaffold({ compareReplaySession: true, replayFixture, paceMs: 5 })`; `scaffold.whenTurnSettled()` as a turn-boundary barrier; `captureStableAria` / `captureExpandedTurnProcessAria` for two golden shapes (collapsed vs fully expanded activity groups); `compareOrRefreshGolden` for the only write path; `watchConsole` tripwire; `assertFixtureInventory` for a closed fixture directory.
- **Data flow:** `beforeAll` boots the composition, launches Chromium, navigates to `scaffold.authenticatedUrl`, waits for the frame selector, then `connectFreshWorkspace(page, scaffold.workspaceCwd)` births the blank session whose live composer accepts the slash line. The drive test fills the composer and presses Enter. In `record` mode `recordFixture(scaffold, sessionId, FIXTURE)` harvests the session JSONL; in replay mode a **drift guard** asserts the committed fixture carries exactly the drive prompt.
- **Non-obvious design decisions:** The turn-boundary waiter is armed **before** the send (`const settled = scaffold.whenTurnSettled()` precedes `input.press('Enter')`) — comment at :62-64 says a burst replay could otherwise miss the `turn/end` that settles the recorded turn. The assertion order also checks the **anonymous user id regex** (`/Anonymous user: [0-9a-f-]+\.$/`) and the **composer clearing + re-enabling** (`:84-85`), because a `/feedback` that leaves the composer stuck is a different bug from one that does not acknowledge.
- **Edge cases / failure handling:** `onTestFailed(() => saveFailureShot(page, ...))` captures a screenshot on failure. The tripwire asserts `tripwire.pageErrors` and `tripwire.warnings` are both empty at :95-96, so a reconnect/gap-repair console warning fails the scenario rather than being masked by eventual consistency.
- **Surprising:** A slash command that produces **no model turn at all** is a first-class, separately-tested path — the "command plane" and the "model plane" are different products sharing one transcript, and the golden covers the acknowledgement as a *persistent command row*, not as an assistant message.

### apps/web/tests/feedback-release.e2e.ts
- **Purpose:** The privacy/consent contract for feedback telemetry. A loopback OTLP collector must receive **each authorised suffix before the next UI action** — i.e. after the user records feedback, the collector may see the session log **up to and including** the feedback event, and nothing beyond it.
- **Key abstractions:** `OtlpCapture` (the OTLP/JSON envelope the collector parses: `resourceLogs[].scopeLogs[].logRecords[].attributes[]` with `sessionId`, `content`, `eventName`); `expectFeedbackRelease(type, count)` — the central assertion; `readPersistedEvents(scaffold, sessionId)` to read the canonical session log from disk rather than from the UI; `suffixes[]`/`releasedCount` to track the incremental delivery boundary; `headerlessExpected` for the headerless-session case.
- **Data flow:** A local `http.createServer` collector is bound to `127.0.0.1:0`; the scaffold is launched with `telemetryUrl` pointing at it, `telemetryMode: 'FEEDBACK_ONLY'` and `telemetryScheduledDelayMillis: 10`. `expectFeedbackRelease` (`:66-85`) flushes the agent's session, reads the persisted events, filters to the events of the given type, takes the **last** one's `seq` as the boundary, computes `authorized = events.filter(e => e.seq <= boundary.seq)`, and then asserts via `expect.poll(captured)` that the collector received **exactly** that prefix — no more, no less. The `describe.each` runs the lane twice (official provider, and a `feedback-mock` provider), and the drive test proves switching the model in the UI **does not change the request header** and does not trigger any upload.
- **Non-obvious design decisions:** `compareReplaySession: false` is deliberate — the fixture is *borrowed* from the `feedback-command` scenario, and comparing or refreshing it here would rewrite that shared source with this lane's feedback events (`:123-127`). The two scenarios therefore share one recorded turn but assert different things about it. The negative test at `:206-217` asserts that command tails, provider changes and **browser reloads** release nothing, and that the last persisted event is a `command/done` whose `seq` is **greater** than the last authorised event's `seq` — i.e. the collector is provably behind the transcript, not just coincidentally equal.
- **Edge cases / failure handling:** The `afterAll` hook asserts `captured()` equals the authorised prefix **plus** the headerless tail, so a shutdown that drains an illicitly queued tail fails the suite. `acknowledgeReloadConnectionLoss(tripwire, warningStart)` (`:214`) forgives only the connection-loss warning produced by the intentional reload — every other warning stays fatal. The headerless case (`:287-315`) proves a feedback submitted in a session with **no model request** (`expect(headerless.requestHeader()).toBeUndefined()`) is still released, but that the *other* session's provider-change tail is not captured with it.
- **Surprising:** `captured()` parses the OTLP envelope and asserts `expect(record.eventName).toBe('session-log')` and `expect(typeof content).toBe('string')` **inside the collector callback** — the collector is not a dumb sink, it validates the shape of what it was sent while the test is running.

### apps/web/tests/file-upload-round.e2e.ts
- **Purpose:** The generic file-upload round trip through the real request assembly: a real Chromium picks files through the composer's hidden `<input type="file">`, the upload RPC stores the exact bytes under the scaffold's isolated `DSH_HOME`, the prompt cites the staged reference, request assembly projects the file block to handle text, and the model (replayed or live) reads the saved copy with the **real** `read` tool.
- **Key abstractions:** `DraftRailGeometry` and `HistoryAttachmentGeometry` — two typed interfaces of *browser-measured relations* rather than pixel coordinates; `renderDraftRailGeometry` / `renderHistoryAttachmentGeometry` which render those relations to a stable markdown string; `inspectTrajectoryAttachments()` which walks the Trajectory inspector's Summary/Preview/Raw tabs and returns a concatenated snapshot; `scaffold.ctx.attachments.readImage` spied with `vi.spyOn(...).mockImplementationOnce` to inject a failure.
- **Data flow:** The composer picks `poem.txt` (constant bytes `UPLOAD_ROUND_OK\n`) plus ten `reference-N.png` copies of a fixture image. The upload receipt gates the send button (`:276-279`). After the turn settles, the test reads the `user/message` event's content blocks, finds the `file` block, and asserts `attachment.attachmentId` matches `/^sha256:[0-9a-f]{64}$/` — a **content-addressed** id. It then finds the `tool/call` for `read`, the matching `tool/result` (matched on `message.source.callId`), and asserts the result text contains `UPLOAD_ROUND_OK` and `isError` is false.
- **Non-obvious design decisions:** The content-addressed store is what makes the saved path identical across record and replay **once the workspace cwd is tokenized**, so the recorded read arguments replay verbatim against a freshly re-uploaded object (header comment, :5-8). Because the saved path still differs per run, the replay uses a `replay.override.json` sidecar that rescripts the recorded read arguments with a `{{fromRequest:…}}` placeholder (`:203-206`). The submission check at `:282-293` polls for up to 10 s and, on failure, throws with the retained-card count, the text of every `[role="alert"], [role="status"]` region **and** the full event-type sequence — a diagnostic triple rather than a bare assertion failure.
- **Edge cases / failure handling:** The thumbnail-failure test (`:389-429`) reloads to clear the browser image cache, mocks `readImage` to throw, and asserts the loading and failed feedback **fits inside the attachment row** (`scrollHeight <= clientHeight && scrollWidth <= clientWidth`) before and after the error — then verifies the retry button restores the image and that `read` was called exactly twice. The `finally` block resolves the deferred and restores the spy so a failing assertion cannot hang the suite.
- **Surprising:** The Trajectory inspector's **Raw** tab is asserted to render each content block as a `<details>` whose `<pre>` parses back to the *exact* JSON block that was persisted — the raw view is a round trip, not a formatted display.

---

### apps/web/tests/expected/access-confirmation/auto-confirmation.expected.md
Golden for the **auto-review (experimental)** permission confirmation dialog: a warning paragraph stating that auto-review runs **without a sandbox**, that **the same model as the current agent** reviews every native tool call *and every PTC inner call* before it runs, that a refused call is escalated to the human, and that the feature is experimental and costs extra tokens; plus a risk checkbox that gates the disabled `启用自动审查` button.

### apps/web/tests/expected/access-confirmation/current-session-picker.expected.md
Golden for the four permission modes as a flat menu — 仅可查看 (read only) / 工作区内修改 (workspace write) / 完全权限 (full) / 自动审查 EXP.

### apps/web/tests/expected/access-confirmation/slash-picker.expected.md
Golden for the `/permission` command picker: a filter textbox over a listbox of the four modes, 工作区内修改 preselected, and the auto-review option carrying an `EXP` superscript and a one-line description of the no-sandbox, per-call model review.

### apps/web/tests/expected/access-confirmation/ui.expected.md
Golden for the **full-access** confirmation dialog: a paragraph enumerating what full access removes (confirmation steps, sensitive operations, file modification, external commands) and the recommendation to use it only on trusted tasks, plus a risk checkbox that must be ticked before `启用完全权限` leaves `[disabled]`.

### apps/web/tests/expected/account-login/avatar-retry.expected.md
Non-ARIA golden: a six-line load-state transcript of the avatar **retry ladder** — the sidebar fails, the first Settings entry fails, the second succeeds, the third reuses the cached image (request count frozen at 3), a *rendered* image failure drops both to `failed` with images at 0, and the next entry recovers without a new request.

### apps/web/tests/expected/agent-preset-authoring/section.expected.md
Golden for the **Agent 预设** settings section: the four built-in presets (`standard`, `ptc`, `minimal`, `cordis`) each with a capability paragraph and 模式说明 / 如何使用 / 查看配置 buttons, a pressed `新任务默认` marker on the default preset, and a `让 Agent 帮我创建预设模式` entry point — i.e. the agent can author its own preset.

### apps/web/tests/expected/agent-preset-selection/header.expected.md
Golden for the header of a Minimal-mode session: the session-hierarchy navigation, the mode name, a `1 subagent` button, More actions and Open right sidebar.

### apps/web/tests/expected/agent-preset-selection/hero.expected.md
Golden for the empty-session hero: a `Choose workspace` button and a `Standard mode` preset button — the only two choices offered before the first turn.

### apps/web/tests/expected/agent-preset-selection/menu.expected.md
Golden for the preset picker menu: one `menuitem` per mode carrying its full capability paragraph (Standard / PTC / Minimal / Creator), so the mode is chosen from a description, not a name.

### apps/web/tests/expected/bonus-notice/notice-flow.expected.md
Hand-written scenario transcript of the whole bonus-credit notice flow: the ack `POST /api/v0/users/ack_bonus_notified` body shape, the card lifecycle (held → shown → painted-under-settings → dismissed), reload idempotence with no added storage keys, a retry with exponential backoff that keeps the body, two failing usage links both pointing at `/usage`, the English locale, and a stacked-card layout assertion (3 cards → 2 promoted → 0 dismissed, with the promoted card keeping the same DOM node).

### apps/web/tests/expected/clickable-links-gallery/ui.expected.md
The largest single-turn ARIA golden in the shard: it covers **every tool-call card kind** — Write, Edit (with the diff and a Wrap lines toggle), Read (with a code block and an `Expand 4 more lines` control), Grep (per-file match counts and a spill), Glob, Bash (Success / Failed / no-output / timed-out, including a long one-line command and a very long failure message), Search, Fetch, and a custom `design_tokens_sync` tool — plus a markdown link gallery covering http links, `mailto:`, footnotes, inline-code links, inert `javascript:` and `pnpm run build` code spans, and a produced-file card that opens in the sidebar. Ends with the composer footer and a `1 turns 2 steps` counter.

### apps/web/tests/expected/client-plugin-live/bootstrap-rebuild.expected.md
Golden for a **client-plugin bootstrap rebuild failure**: a per-module error row naming the module and the reason (`replacing bootstrap module @deepseek-ai/dsh-client-modules requires a page reload`), the explicit promise that the server-side enabled state is unchanged, and a `重试本页面同步` button.

### apps/web/tests/expected/client-plugin-live/enabled.expected.md
Golden for the client-plugin enabled toast (`动态插件已启用`).

### apps/web/tests/expected/client-plugin-live/recovered.expected.md
Golden for the post-recovery client-plugin toast, which names the recovered plugin (`动态插件 r1 已启用`).

### apps/web/tests/expected/client-plugin-live/session-actions.expected.md
Golden for the session action menu after a live client plugin contributed rows: the five built-in items, a separator, then the plugin's `Export session` and `Copy session ID` entries.

### apps/web/tests/expected/cold-blank-session/queue.expected.md
Golden for a queued message that survived a Host restart: its label (`Accepted before the Host restarted`), Edit and Remove buttons, and a `[disabled]` Steer button — the disabled state is the assertion.

### apps/web/tests/expected/composer-draft-scroll/geometry.expected.md
Browser-measured geometry for the **14-line-capped composer**: one editable surface that holds **no scroll offset of its own**, a separate scrollport, and the paste case where the composer scrolls to the caret the paste left behind.

### apps/web/tests/expected/composer-focus/focus.expected.md
Measurement transcript for whitespace-only composer focus: focusing any padding or gap region selects the whitespace run (`"beta"`, offsets 10 → 6), returning from outside restores the same selection, and typing replaces the restored selection while resuming at the restored caret (`alpha BET!A gamma`). Asserted identically for a fresh and an existing session.

### apps/web/tests/expected/composer-placeholder/visibility.expected.md
State table for the composer placeholder: hidden on a single space, hidden on consecutive spaces, hidden on pasted spaces, hidden while focused, hidden after a whitespace-only submission is rejected, and visible again once all content is deleted.

### apps/web/tests/expected/composer-tab-geometry/geometry.expected.md
Browser-measured proof that switching between the Chat and Trajectory tabs does **not** move the input card: Chat reserves a 5px scrollbar-gutter band and scrolls, Trajectory reserves 0px and does not, and the card's left/right edges and width all move 0px. A third block is a **control** that removes the gutter compensation in the page and shows the card then moving 2.5px — the counterfactual that makes the measurement meaningful.

### apps/web/tests/expected/cordis-history/ui.expected.md
Full ARIA golden for a three-turn **Cordis plugin authoring** session: the `Inspect plugins` / `Register` / `Run` / `Stop` tool cards, a client/host source tablist with the host code in a `Wrap lines`-toggled code block, the "awaiting user approval (run-1)" step, the `插件状态更新` toast with a timestamp, and the usage footer `66.8K tok · Cache hit 77%` plus `0% of context used`.

### apps/web/tests/expected/cot-translation-paid/paid-choices.expected.md
Golden for the **paid** variant of the thinking-translation plugin: a `DeepSeek Flash · 账号（付费）` option beside Bing and Google, `已覆盖` override markers with `恢复默认` buttons, and an explicit paragraph stating that **every uncached fragment is a separate paid DeepSeek Flash request** and that re-expanding reuses saved translations while changing service/language/source/request settings may send new paid requests.

### apps/web/tests/expected/cot-translation-paid/paid-result.expected.md
Golden for a paid-translated reasoning block: the `思考` toggle, `查看原文`, and the translated paragraph.

### apps/web/tests/expected/cot-translation/bing.expected.md
Golden for a Bing-translated reasoning block: the `思考` toggle and `查看原文` over the translated paragraph.

### apps/web/tests/expected/cot-translation/failure.expected.md
Golden for a **failed** translation: `查看译文` is `[disabled]`, a status reads `翻译暂不可用，已显示原文`, a `重试` button is offered, and the original English reasoning is still rendered — the failure degrades to the source, it does not hide the reasoning.

### apps/web/tests/expected/cot-translation/preferences.expected.md
Golden for the thinking-translation plugin preferences: the enabled switch, the Bing/Google service combobox, the `auto` target-language field with its explanation that `auto` means the UI language, and the two-component list with per-component switches.

### apps/web/tests/expected/declared-reasoning/pointer-menu.expected.md
Golden for the combined **model + reasoning-level** picker: a model searchbox and a per-provider grouped menu of `menuitemradio` entries, with the selected model checked.

### apps/web/tests/expected/declared-reasoning/ui.expected.md
Golden for the reasoning-effort submenu itself: `Default` / `Off` / `High` / `Max` radio items, with Default checked.

### apps/web/tests/expected/deepseek-messages-settings/cards.expected.md
Golden for the DeepSeek **Anthropic-Messages** provider card in Models settings: the API key field, an API base URL field whose placeholder names `https://api.deepseek.com/anthropic` and the `DEEPSEEK_BASE_URL` env override, the note that the URL must speak the Anthropic Messages protocol, and a two-model catalogue with per-model options and delete buttons.

### apps/web/tests/expected/deepseek-messages-settings/picker.expected.md
Golden for the model picker when the provider declares its own catalogue: `Messages Flash` checked alongside `DeepSeek-V4-Pro`.

### apps/web/tests/expected/deepseek-model-label-1017/models.expected.md
Golden for the model menu where **three different providers offer the same display name** (`DeepSeek-V4.1-Flash 1017` under DeepSeek 账号, under DeepSeek, and `DeepSeek-V4.1-Flash` under External) — the provider grouping is what disambiguates identical labels.

### apps/web/tests/expected/default-model/background-save.expected.md
Golden for the composer after a **background save** of the default model: the trigger label already reads `Acme Large` before the menu closes.

### apps/web/tests/expected/default-model/command-picker.expected.md
Golden for the `/model` command picker: a listbox grouped by provider with the selected `Acme Large` marked.

### apps/web/tests/expected/default-model/model-labels.expected.md
JSON golden listing every model label as `provider` / `model` / `name` / `slot` / `inline` — one table that drives the composer trigger, the `/model` picker and the command-picker group headers.

### apps/web/tests/expected/default-model/search.expected.md
Golden for the model picker's fuzzy search: the typed query `ACMLG`, a clear-search button, and only the matching Acme group left standing.

### apps/web/tests/expected/default-model/unselected.expected.md
Golden for the composer with **no** model chosen: a `请选择模型` trigger instead of a model name.

### apps/web/tests/expected/default-workspace/failure.expected.md
Golden for the default-workspace creation failure: an alert that routes the user to 选择工作区 instead of leaving the app in a half-initialised state.

### apps/web/tests/expected/desktop-locale/automatic.expected.md
Golden for the Chinese Settings dialog with appearance set to follow-system: the full General-tab control set (permission, language, appearance, font size, work-detail level, collapse timing, coding view, shortcuts, busy-send behaviour, usage verbosity, session-log upload, version).

### apps/web/tests/expected/desktop-locale/selected.expected.md
Golden for the English Settings dialog after explicitly selecting English — the identical control set, localised.

### apps/web/tests/expected/desktop-onboarding/bonus-after-onboarding.expected.md
Non-ARIA golden: onboarding completes with the bonus notice **not** shown (`notice=false`, `acks=0`), and the notice only appears once a workspace exists, with exactly one ack recorded.

### apps/web/tests/expected/desktop-onboarding/credit-en-dark.expected.md
Golden for the English dark-theme Add-credits onboarding step: the token-billing explanation and the Add credits / Next / Back / Skip actions.

### apps/web/tests/expected/desktop-onboarding/credit-funded-en-dark.expected.md
Golden for the same Add-credits step **once a balance exists**: the primary action becomes `Continue`.

### apps/web/tests/expected/desktop-onboarding/credit.expected.md
Golden for the Chinese Add-credits step, which states that credits are deducted by model and tool token consumption and that the balance is only consumed while the agent actually works.

### apps/web/tests/expected/desktop-onboarding/process-en-dark.expected.md
Golden for the English work-detail radio step: `Results only` / `Key details` / `Full details`, with the explicit note that this changes presentation only, not capability.

### apps/web/tests/expected/desktop-onboarding/process.expected.md
Golden for the Chinese work-detail radio step with `完整过程` checked by default.

### apps/web/tests/expected/desktop-onboarding/purpose-en-dark.expected.md
Golden for the English purpose step: Office & creative work / Coding & development checkboxes, each with a one-line description.

### apps/web/tests/expected/desktop-onboarding/purpose.expected.md
Golden for the Chinese purpose step, with the product name rendered as `emphasis` inside the heading.

### apps/web/tests/expected/desktop-onboarding/welcome-en-dark.expected.md
Golden for the English welcome step, which states plainly that DSH works in a local folder and reads/writes files on the user's computer.

### apps/web/tests/expected/desktop-onboarding/welcome.expected.md
Golden for the Chinese welcome step — the mirror of `welcome-en-dark.expected.md`.

### apps/web/tests/expected/file-upload-round/draft.expected.md
Browser-measured geometry for the mixed composer attachment rail: 11 cards in one non-wrapping 64px-tall row, a 28×28 solid-fill file icon, horizontal overflow when crowded, and the selection order asserted explicitly.

### apps/web/tests/expected/file-upload-round/history.expected.md
Browser-measured geometry for the durable mixed attachment flow: one wrapping, right-aligned group where the image is a 64px tile and the file card is wider.

### apps/web/tests/expected/fork-mid-turn/ui.expected.md
Golden for **forking a session mid-turn**: the parent prompt, the branch's user message, a branch answer that admits it has no read results and would check the parent first, and the Copy / Good / Bad / Branch action row.

### apps/web/tests/expected/github-ready-review/conversation-expanded.expected.md
Golden for the GitHub-webhook review session with every activity group **expanded** — the same tree and reply as `conversation.expected.md`, with the tool groups opened.

### apps/web/tests/expected/github-ready-review/conversation.expected.md
Golden for the GitHub-webhook review session: a `GitHub event received` toast, a completed turn, the `Read Only` access mode and a model named `github-webhook-review-test/reply`.

### apps/web/tests/expected/goal-bar/active.expected.md
Golden for an **active** ongoing-goal bar: `Pause goal` / `Edit goal` / `Clear goal`.

### apps/web/tests/expected/goal-bar/inactive.expected.md
Golden for a **paused** goal bar, where `Pause` becomes `Resume`.

### apps/web/tests/expected/goal-command-presentation/ui.expected.md
Golden for the `/goal` command presentation: the typed slash line in a `Command input` group, a button that states no goal is set and prints the full usage string (`/goal [<objective>|clear|edit <objective>|pause|resume]`), and the composer beneath it.

### apps/web/tests/expected/home-path-tilde/workspace-hover.expected.txt
Non-ARIA golden proving the hover label shows the tilde path (`~/Documents/project`) while the copy action yields the absolute path (`/home/fixture/Documents/project`).

### apps/web/tests/expected/input-plugin-extensions.expected.md
Golden for an **input plugin extension** rendering into the composer: a `Draft` paragraph plus `Cancel activity` / `Insert result` / `Send message` controls — the plugin contributes to the input surface, not to the transcript.

### apps/web/tests/expected/jobs-menu-layering/geometry.expected.md
Measured JSON proving the background-jobs dock stays **above** the browser dock in collapsed, expanded and resized states: `dockMode: "push"`, `bodyMounted`, `fixed`, `anchored`, `viewportBounded`, `overlapsBrowser: true`, `aboveBrowser: true` in all three, with `escapeRestoresFocus` and `outsideDismisses` both true.

### apps/web/tests/expected/layout-bottom/geometry.expected.md
Measured layout JSON for the bottom dock across eight states (empty / open / grown / darwin / windows / browser / narrow / unregistered / collapsed), showing that `pageHeight` never exceeds the viewport and that the OS chrome (a 40px title bar on Windows) is subtracted from the main/sidebar/rightbar rects rather than overlapped.

### apps/web/tests/expected/markdown-cjk-strong/ui.expected.md
Golden for CJK strong emphasis: full-width and half-width punctuation both close the strong span, and `句号。` and `提醒！` are treated as terminators.

### apps/web/tests/expected/markdown-images/ui.expected.md
Golden for the Markdown **image policy**: remote, local and workspace images become `View full image` buttons, while oversized, missing and corrupt images degrade to an explicit `Image preview unavailable · <reason>` line — and the corrupt case names the resolved path.

### apps/web/tests/expected/markdown-inline-code-links/ui.expected.md
Golden for link handling inside inline code: an http(s) code span becomes a live link, while `javascript:alert(1)` and a bare command stay inert.

### apps/web/tests/expected/markdown-wide-table/geometry.expected.md
Measured table relations at three viewport widths: a `fill` table fits the column, a `wide` table scrolls, and a `long-cell` table wraps before it scrolls. The "wrap-first engagement" block asserts the long-cell table is **taller** at the narrowest stop than at the widest — the wrap is the engagement, not a fallback.

### apps/web/tests/expected/math-rendering/ui.expected.md
Golden for math rendering: inline `$`, backslash `\( \)` and block forms all become `math` nodes, including inside a table cell.

### apps/web/tests/expected/max-tokens-notice/history-turn.expected.txt
Non-ARIA golden for the output-token-limit notice: a warning dot, the title `Output token limit reached`, and the hint that the reply was cut off, **earlier output is preserved in the conversation**, and `Send "continue"` lets the model resume.

### apps/web/tests/expected/menu-material/materials.expected.json
Measured menu material tokens (fill, blur, radius, shadow) for the web and darwin builds in light and dark — the menu's own glass material, kept distinct from the modal scrim.

### apps/web/tests/expected/menu-material/modal-masks.expected.json
Measured modal mask fill and blur for web/darwin × light/dark — the scrim behind an open dialog, deliberately blurred `none` while the menu itself blurs `40px`.

### apps/web/tests/expected/menu-material/session-menu.expected.md
Golden for the session context menu: Pin / Rename / Fork / Archive / Copy Session ID.

### apps/web/tests/expected/models-settings-recovery/stored-error.expected.md
Golden for the Models settings **recovering from a stored configuration error**: each broken provider row carries an alert quoting the backend's own remediation text (`needs an api; the installed catalog does not describe it, so set the route's api to the wire protocol its endpoint speaks`).

### apps/web/tests/expected/models-settings/catalog-inputs.expected.md
Golden for a provider with an env-detected API key (`已检测到环境变量（OPENAI_API_KEY）`) and a custom catalogue, including the `获取可用模型` fetch button and the per-model context-window / output-cap / modality fields.

### apps/web/tests/expected/models-settings/configured.expected.md
Golden for the Models settings after a successful save, including the `已保存 minimax-cn。` status line.

### apps/web/tests/expected/models-settings/declared-edit.expected.md
Golden for editing a custom provider: display name, base URL, an **API 协议** combobox (`OpenAI Chat Completions` / `OpenAI Responses` / `Anthropic Messages`), a custom model catalogue, and a **reasoning-effort tier table** — three tier comboboxes (`off`/`minimal`/`medium`/`xhigh`/`max`, `low`, `high`) each with its own `API 参数值` textbox and a `删除档位` button.

### apps/web/tests/expected/models-settings/declared.expected.md
Golden for the Models list with one built-in provider and one custom provider, each with edit and delete buttons.

### apps/web/tests/expected/models-settings/delete.expected.md
Golden for the custom-provider delete confirmation, which states that deleting removes both the configuration **and** the stored API key.

### apps/web/tests/expected/models-settings/empty.expected.md
Golden for the empty Models settings with the `添加方式` tablist (third-party providers / custom model API) and the full third-party provider catalogue.

### apps/web/tests/expected/models-settings/image-only.expected.md
Golden for an **image-only** custom model: `Anthropic Messages` protocol selected, the text modality unchecked and the image modality checked but `[disabled]`, and a `high` reasoning tier whose API parameter value is **`deep`** — a provider-specific wire value behind a semantic tier name.

### apps/web/tests/expected/models-settings/model-picker.expected.md
Golden for the add-models dialog: a searchable checklist of the provider's available models with a select-all-clear action.

### apps/web/tests/expected/models-settings/native-delete.expected.md
Golden for deleting a **built-in** provider, whose copy states that its configuration is removed but its credentials are managed elsewhere and will be kept.

### apps/web/tests/expected/models-settings/native-keyless.expected.md
Golden for the native-provider add form when no environment credential is present: the env var name is named explicitly and the key field sits behind `自定义设置`.

### apps/web/tests/expected/models-settings/refreshing.expected.md
Golden for the Models settings mid-refresh: every row button **and** the add-provider button are disabled rather than hidden.

### apps/web/tests/expected/navigation-panes/code-card.expected.md
Golden for a code card: the `Wrap lines` toggle `[pressed]`, a `Copy` button and the code content.

### apps/web/tests/expected/navigation-panes/command-wrap.expected.md
JSON golden proving the **copied** text of a code card is the unwrapped source in both light and dark colour schemes — the clipboard carries the source, not the rendering.

### apps/web/tests/expected/new-session-refused/notice.expected.md
Golden for a **refused** session creation: an alert naming the offending preset plugin id and the `never started` reason.

### apps/web/tests/expected/office-font-notice.md
Measured checklist for the Office font warning: a centred 28px spinner with a visible rendering status in both themes, translucent blue selection, cool-grey light / matte-black dark backdrops, 12px page gaps, the warning **preceding** reload in the same toolbar with shared button geometry, details opening only on request and naming the absent family, Escape restoring focus to the warning, closing details preserving the document position, and continuous pinch-zoom redrawing the Office PDF at device resolution up to 400% with the percentage updated live (166%).

### apps/web/tests/expected/onboarding-deepseek-config/default-models.expected.md
Golden for the default DeepSeek model catalogue: adapter-default models with a `1M` context window, a `256K` max output placeholder, and text + image modality checkboxes.

### apps/web/tests/expected/onboarding-deepseek-config/empty.expected.md
Golden for the model picker with no models available: a `暂无可用模型` status.

### apps/web/tests/expected/onboarding-deepseek-config/missing.expected.md
Golden for the missing-credential dialog: an API key field whose `保存并继续` button is disabled until a key is typed, plus a `稍后配置` escape.

### apps/web/tests/expected/onboarding-deepseek-config/models.expected.md
Golden for a **customised** DeepSeek catalogue: the `已自定义模型目录` marker, a `恢复默认模型` button, a context window typed **literally** as `131072` (against the `1M` placeholder default), a `64K` output cap, and text + image modalities.

### apps/web/tests/expected/onboarding-deepseek-config/sign-in.expected.md
Golden for the sign-in dialog offering either an API key or a DeepSeek account login, and stating that projects and files stay local.

### apps/web/tests/expected/onboarding-deepseek-config/welcome.expected.md
Golden for the preview-build notice dialog: the two-paragraph product notice and a `继续` button.

### apps/web/tests/expected/onboarding-native/models.expected.md
Golden for the native DeepSeek provider card with no stored key: the env-var placeholder (`留空使用环境认证（DEEPSEEK_API_KEY）`) and the `未检测到环境变量` explanation.

### apps/web/tests/expected/onboarding-native/signed-out-menu.expected.md
Golden for the signed-out overflow menu: 设置 / 意见反馈 / 登录.

### apps/web/tests/expected/onboarding-usable-provider/dismissed.expected.md
Golden for the dismissed onboarding: the Models settings show the API key missing (`API 密钥缺失`) and the full third-party provider catalogue with `minimax-cn` selected, and the env var `MINIMAX_CN_API_KEY` named.

### apps/web/tests/expected/plan-narrow-viewport/layout.expected.md
Measured layout for the composer controls at an 800×720 viewport: the plan chip and model trigger stay fully in view and their click areas stay disjoint; above a 360px row the model label collapses to an icon, the compact controls share a line, and a shorter model or a wider row **restores** the text — i.e. the collapse is width-driven, not permanent.

### apps/web/tests/expected/plan-review/temporary.expected.md
Golden for the `Temporary review` plan surface: an Implementation heading with a short checklist and the note that review happens **without a tool invocation**.

### apps/web/tests/expected/plugin-config/bundle.expected.md
Golden for a fixture bundle detail page: the enable switch, its single component with its own switch, a `file:` code source, and a fixture-provided region.

### apps/web/tests/expected/plugin-config/official.expected.md
Golden for the plugins page: the four built-in configurable plugins (subagent, web search, agent loop, terminal), four experimental plugins each behind a switch, and the installed-plugins list.

### apps/web/tests/expected/plugin-config/row.expected.md
Golden for a single plugin configuration row: a dynamic config form with a `问候语` textbox and a Save button, plus the fixture region.

### apps/web/tests/expected/plugin-config/subagent.expected.md
Golden for the **subagent** plugin config: `最大递归深度` (value `2`) and `子智能体并行数量上限` (value `12`), each with an explanation button, an `已覆盖` override marker and a `恢复默认` button, plus a switch for letting the agent choose a subagent's model (with the note that a chosen model is retained when the switch is turned off).

### apps/web/tests/expected/plugin-config/web-search.expected.md
Golden for the web-search plugin config: the new Search/Fetch API switch, a docs link, an API key field explicitly **not written to the settings file**, an overrideable base URL with the rule that the program appends `/search` or `/fetch`, and a per-query result count bounded 1–50 with the note that it does not control the number of search calls.

### apps/web/tests/expected/plugin-install-approve/blocked.expected.md
Golden for an install blocked on a package that declares install scripts: the package is named, the consequence of allowing (scripts run with the user's permissions, the approval is stored in the current profile) is stated, and the advice is to allow only trusted packages.

### apps/web/tests/expected/plugin-install-cancel/cancelled.expected.md
Golden for the cancelled install dialog, which keeps the typed package name and the install-source selector.

### apps/web/tests/expected/plugin-install-cancel/highlight.expected.md
Mixed golden: the installed-plugin row plus the measured focus-ring box shadows under reduced-motion on/off in light and dark — the ring uses `oklab(...)` and **animates** only when motion is allowed, dropping to a static `color(srgb ...)` ring under `prefers-reduced-motion: reduce`.

### apps/web/tests/expected/plugin-install-cancel/invalid-registry.expected.md
Mixed golden: the invalid custom-registry field marked `[invalid]` with a message requiring an `http://` or `https://` prefix, plus the measured focused/blurred ring and border colour per colour scheme for both the registry and package-name fields.

### apps/web/tests/expected/plugin-install-cancel/preparing.expected.md
Golden for the preparing-install dialog: a `正在准备安装…` status and **both** a cancel-and-return-to-edit and a cancel-and-close affordance.

### apps/web/tests/expected/plugin-install-cancel/unconfirmed.expected.md
Golden for the unconfirmed-cancel dialog, which states the backend has not yet acknowledged the task and that the cancellation will be retried automatically once it does.

### apps/web/tests/expected/plugin-install-cancel/unknown.expected.md
Golden for the unknown-result dialog telling the user the backend has no such install task and to check the plugin list before retrying.

### apps/web/tests/expected/plugin-install-github/another-way.expected.md
Golden for the GitHub-unreachable fallback: the package-name field, an expanded install guide with a fill-example button, and the mainland-mirror source selector.

### apps/web/tests/expected/plugin-install-github/failed-on-mirror.expected.md
Golden for the GitHub-unreachable dialog **while the mirror is already selected**, offering `试试其他方式` instead of the mirror.

### apps/web/tests/expected/plugin-install-github/failed.expected.md
Golden for the GitHub-unreachable dialog on the official source, offering `改用国内镜像`.

### apps/web/tests/expected/plugin-install-github/mirror.expected.md
Golden for the mirror source selected in the add-plugin dialog.

### apps/web/tests/expected/plugin-install-github/timeout-on-mirror.expected.md
Golden for the GitHub timeout dialog while the mirror is selected.

### apps/web/tests/expected/plugin-install-github/timeout.expected.md
Golden for the GitHub timeout dialog on the official source.

### apps/web/tests/expected/plugin-install-registry/fastest-default.expected.md
Golden for the registry picker with the mainland mirror preselected (the fastest-source default) and a custom-address field.

### apps/web/tests/expected/plugin-install-registry/installed.expected.md
Golden for a successful install that **failed on the mirror and succeeded on the official source**: both attempts are listed with the failing command, its exit code 1 and the `ERR_PNPM_META_FETCH_FAIL` text, the succeeding command, the install location, and an `立即启用` button.

### apps/web/tests/expected/plugin-install-registry/official-default.expected.md
Golden for the registry picker with the official npm source preselected.

### apps/web/tests/expected/plugin-install-registry/picker.expected.md
Golden for the registry picker opened with the mirror preselected and the custom address empty.

### apps/web/tests/expected/plugin-manager/exports-en.expected.md
Golden for the English bundle detail page: three components all shown as `Off`, with their package ids rendered as code.

### apps/web/tests/expected/plugin-manager/exports.expected.md
Chinese counterpart of `exports-en.expected.md`, showing `已关闭` as the component-off state.

### apps/web/tests/expected/plugin-manager/header-responsive.expected.md
Measured responsive header across two locales and seven widths: the action row stays single-line and contained, moves below the heading at 390px, and focus is retained across the reflow. A closing paragraph records that a forced no-wrap layout at 390px fails the same measured check in both locales and that restoring wrap passes.

### apps/web/tests/expected/plugin-manager/icons.expected.md
Measured icon audit: every card and detail icon **decodes** to a real image at 36×36, the independent search row at 30×30, and the independent review row correctly falls back to generic artwork.

### apps/web/tests/expected/plugin-manager/ime-enter.expected.md
Golden for **IME-safe Enter**: five different composition shapes (`isComposing=true`; Safari `isComposing=false, keyCode=229`; `compositionstart` + unmarked Enter; `compositionend` + immediate unmarked Enter; `compositionend` + 9ms unmarked Enter) each with `inspect=0, install=0; editable; value retained`, and only a plain Enter performing `inspect=1, install=1`. The header states plainly that these are **synthetic browser KeyboardEvents, not an OS input-method test**.

### apps/web/tests/expected/plugin-manager/live-enabled.expected.md
Golden for the plugins page after a live plugin is enabled: the plugin's registry description appears and its switch is checked.

### apps/web/tests/expected/plugin-manager/loading.expected.md
Golden for the plugins page while loading: header actions disabled with **empty 36×20 action spaces and no switch placeholders**, plus the measured row alignment (page/group headers, rows, icons and text line origins align within 0.1px) and the motion contract — 13 opacity-only pulses of 2000ms, all stopped under reduced motion.

### apps/web/tests/expected/plugin-manager/manager.expected.md
Golden for the baseline plugins page with the fixture bundle installed but disabled.

### apps/web/tests/expected/plugin-manager/missing-bundle.expected.md
Golden for a bundle that is **enabled in settings but not installed**: an `异常 未安装` badge plus the resolver's own remediation command (`run 'dsh plugin --profile scaffold install' if its dependency is not installed`).

### apps/web/tests/expected/plugin-manager/preview.expected.md
Golden for an experimental plugin detail page with a preview image, its single disabled component and the `内置` source.

### apps/web/tests/expected/plugin-manager/refresh.expected.md
Golden for the refresh button: a **500 ms** hover/focus tooltip delay (and none at 499 ms), then a failed refresh that ends *settled* — no spinner, one `刷新失败，请重试` toast, no alert, no retry counter.

### apps/web/tests/expected/quota-notice/account_quota.expected.md
Golden for an **account-level** quota failure, which shows the message plus the structured code `ACCOUNT_QUOTA`.

### apps/web/tests/expected/quota-notice/quota.expected.md
Golden for a **request-level** quota failure, showing the message plus the code `QUOTA` — a different code for a different scope.

### apps/web/tests/expected/reasoning-preview/running.expected.md
Golden for the **live reasoning preview**: a `Running` label and a single button whose accessible name carries the streaming reasoning text and grows with it.

### apps/web/tests/expected/reference-composer/menu.expected.md
Golden for the `@` reference menu: a `Files & folders` group (with a `Browse folder` button) and a `Sessions` group listing sessions by path and age.

### apps/web/tests/expected/reference-composer/order.expected.md
Golden proving **reference order is preserved** in the rendered message: the referenced session's title precedes the referring text.

### apps/web/tests/expected/schedule-after/at-conversation.expected.md
Golden for a schedule triggered at the end of a conversation: one reminder paragraph.

### apps/web/tests/expected/schedule-after/conversation.expected.md
Golden for a schedule attached to a conversation: the `Automation task` heading and its reminder paragraph.

### apps/web/tests/expected/schedule-after/every-conversation.expected.md
Golden for a schedule running on every conversation, which **merges** multiple reminders into a single paragraph.

### apps/web/tests/expected/schedule-header.expected.md
Measured responsive header for the Automation tasks panel across two locales and eight widths, including the sidebar-expanded case where `New` moves below the title.

### apps/web/tests/expected/search-card/grep-card.expected.txt
Non-ARIA golden for the grep card: the shown/total match count (`Showing 9 of 42 matches · 3 files`), the per-file match counts, the collapsed line rows with their source paths and line numbers, and the **spill pointer** (`Full grep result stored at: fixture://spill/grep-66. Read it to see every match.`) — the full result is a readable artifact, not a truncation.

### apps/web/tests/expected/seeded-history/blank-reasoning.expected.md
Golden for a seeded reasoning block that carries **no text**: the `Think` toggle opens an empty paragraph and the row count is reported as 1 — the empty case is rendered, not dropped.

### apps/web/tests/expected/session-archive-active/dialog.expected.md
Golden for **archiving a session with work in progress**: a `Stop and archive this session?` dialog that enumerates exactly what will be stopped in a `Work that will be stopped` list — "The turn in progress" and the **literal background job command** — and says the stopped work will not resume on its own and how to restore the session later.

### apps/web/tests/expected/session-row-hover/actions.expected.json
Measured hover choreography for a session row: the hover details appear, a tooltip shows only **after** the dwell (for `Archive` or `Pin`), and moving back to the title clears it.

### apps/web/tests/expected/session-row-hover/grouped.expected.json
Measured hover choreography for grouped session rows, proving the reveal is **exclusive** between rows, survives a portal round trip (the tooltip is rendered in a portal), and cools down on leaving.

### apps/web/tests/expected/session-row-hover/mixed-rows.expected.json
Measured invariant that the hover reveal stays exclusive when workspace groups and session rows are mixed in one list.

### apps/web/tests/expected/settings-appearance/account.expected.md
Golden for the account and balance panel: a masked email (`r***@example.com`), the balance and bonus rows, and links to the platform usage and top-up pages.

### apps/web/tests/expected/settings-appearance/dark.expected.md
Measured design tokens for the dark appearance: card, selector, usage, top-up and save button radius / border / stroke / fill / height.

### apps/web/tests/expected/settings-appearance/light.expected.md
Measured design tokens for the light appearance — the counterpart of `dark.expected.md`.

### apps/web/tests/expected/settings-chrome/collapse-timing-en.expected.md
Golden for the English work-detail collapse-timing menu: `On completion` / `On next message`.

### apps/web/tests/expected/settings-chrome/collapse-timing-zh.expected.md
Chinese counterpart of `collapse-timing-en.expected.md`.

### apps/web/tests/expected/settings-chrome/dialog-en.expected.md
Golden for the English Settings dialog in its baseline state, with the coding-view switch off.

### apps/web/tests/expected/settings-chrome/dialog-no-browser.expected.md
Golden for the English Settings dialog when the browser panel is unavailable; the control set is byte-identical to `dialog-en.expected.md`.

### apps/web/tests/expected/settings-chrome/dialog.expected.md
Golden for the Chinese Settings dialog in its baseline state.

### apps/web/tests/expected/settings-chrome/plugin-instances.expected.md
Golden for the plugin-instances list, enumerating the four subagent tool instances (`tool-subagent-control`, `tool-subagent-list-agents`, `tool-subagent`, `tool-subagent-fork`) with their ids and enabled state — **delegate** and **fork** are separate tools with the same description.

### apps/web/tests/expected/settings-chrome/plugins.expected.md
Golden for a single plugin-instances row: the subagent delegation tool with its description and package id.

### apps/web/tests/expected/shared-inspector/bottom.expected.md
Measured bottom-panel inspector: a 12px header with a collapse button, the main/bottom split heights before and after resize (495/405 → 540/360), and the same iframe document and height retained across collapse and reopen with Sources still selected.

### apps/web/tests/expected/shared-inspector/client-status.expected.md
Measured client inspector status: the `disconnected` attribute while down, one surviving (Host) console context, and the attribute count dropping to zero after reconnect.

### apps/web/tests/expected/shared-inspector/connections.expected.md
Measured inspector **context topology**: an embedded page gets its own Client context (2 contexts = Host + its own), the embedded page evaluates against its embedding page, and the direct devtools sees 3 contexts (Host + both Clients).

### apps/web/tests/expected/shared-inspector/metadata-en.expected.md
Golden for the English developer-tools metadata catalogue: the bundle, its components, the session-sidebar entry and the NodeJS bottom panel.

### apps/web/tests/expected/shared-inspector/metadata-zh.expected.md
Chinese counterpart of `metadata-en.expected.md`.

### apps/web/tests/expected/shared-inspector/page.expected.md
Golden for the inspector panel tablist: Elements, Console, Sources (selected), Network, Performance, Memory, Application, Security, Lighthouse, Recorder.

### apps/web/tests/expected/shell-command-details/background-long-token.expected.md
Golden for a background shell command whose command line carries a **very long token**, proving the full command is rendered without truncation.

### apps/web/tests/expected/shell-command-details/background.expected.md
Golden for a background shell command card with its full command line and an Inspect button.

### apps/web/tests/expected/shell-command-details/foreground-multiline.expected.md
Golden for a foreground multiline shell command: the `Done` prefix, the whole command including the trailing `echo done`, the output, and a Copy button.

### apps/web/tests/expected/shortcuts-desktop/chord.expected.md
Golden for a **chord** shortcut (`A B`) recorded for New Session.

### apps/web/tests/expected/shortcuts-desktop/fixed-conflict.expected.md
Golden for a shortcut conflict with a **fixed** (non-editable) command, naming the command that already owns the binding.

### apps/web/tests/expected/shortcuts-desktop/font-sizes.expected.md
Measured font-size ladder: text / code / terminal sizes step together (14/11/13 → 15/12/14 → 16/13/15), survive a reload, and restore to the default, with the increase/decrease control order pinned.

### apps/web/tests/expected/shortcuts-desktop/macos-copy-override.expected.md
Golden for the macOS copy override, where New Session binds `⌘C`.

### apps/web/tests/expected/shortcuts-desktop/modal-layers.expected.md
Measured **modal layering**: Settings and Keyboard shortcuts are mutually exclusive, focus follows the foreground layer, no stray dialogs remain after toggling, and no closed windows leak.

### apps/web/tests/expected/shortcuts-desktop/recording.expected.md
Golden for the shortcut recorder row showing Restore default / Remove / Press a shortcut.

### apps/web/tests/expected/shortcuts-desktop/windows-copy-override.expected.md
Golden for the Windows copy override, where New Session binds `Ctrl+C`.

### apps/web/tests/expected/shortcuts-panels/browser.expected.md
Golden for the Browser panel chrome: tab, new tab, split, fullscreen, collapse, the address bar, a disabled `Open in system browser` button and the empty-state prompt.

### apps/web/tests/expected/shortcuts-panels/guide-close.expected.md
Golden for the start-guide tab after it is closed, leaving the panel actions and the three entry buttons.

### apps/web/tests/expected/shortcuts-panels/page-actions.expected.md
Golden for the Files panel with a file listed, alongside the terminal tablist.

### apps/web/tests/expected/shortcuts-panels/panels.expected.md
Golden for the Files panel in its empty state, with `Split` disabled because only one panel is open.

### apps/web/tests/expected/shortcuts-panels/tab-menu.expected.md
Golden for the panel tab overflow menu containing a single `Close` item.

### apps/web/tests/expected/shortcuts-workspace/files-open.expected.md
Golden for the workspace files panel: the workspace path, a Reload button, `Open in Finder` and `More ways to open`.

### apps/web/tests/expected/shortcuts-workspace/fork-unavailable.expected.md
Golden for the **refused** fork of a session with no completed turn (`This session has no completed turn`).

### apps/web/tests/expected/shortcuts-workspace/fork.expected.md
Golden for the session search results after forking: an `Ungrouped` group and two rows, the newer one selected.

### apps/web/tests/expected/shortcuts-workspace/macos-defaults.expected.md
Golden for the **macOS** default shortcut table, which differs from the Windows one (`⌘` instead of `Ctrl`, `⌥` instead of `Alt`, and `Refresh current page` unbound) — the defaults are per-platform, not one table rendered twice.

### apps/web/tests/expected/shortcuts-workspace/session-menu.expected.md
Golden for the session context menu reached from the workspace tree.

### apps/web/tests/expected/shortcuts/edit-stale.expected.md
Golden for the **stale-configuration gate**: `Restore default` is disabled, a notice states that the shortcut configuration or the available commands changed and the latest bindings must be reviewed before saving, and an `I have reviewed the latest configuration` button is the only way forward.

### apps/web/tests/expected/shortcuts/en-US-conflict.expected.md
Golden for the English conflict alert naming the command that already owns the binding.

### apps/web/tests/expected/shortcuts/en-US-empty.expected.md
Golden for the English shortcuts dialog with a search that matches nothing, plus the `1 customized` counter in the footer.

### apps/web/tests/expected/shortcuts/en-US-inline.expected.md
Golden for the inline shortcut editor hint, which states the accepted chord shapes (including three or four distinct modifiers) and warns that browser or system shortcuts may not reach the page.

### apps/web/tests/expected/shortcuts/en-US-reset-confirm.expected.md
Golden for the restore-defaults confirmation, which scopes the reset to the current platform and says other platforms are unaffected.

### apps/web/tests/expected/shortcuts/en-US-saved.expected.md
Golden for the `Modified` alert on a customised shortcut.

### apps/web/tests/expected/shortcuts/en-US.expected.md
Golden for the full English shortcut table: 16 application bindings plus the fixed regions for the message input (Queue/Steer, reference menu, newline, send, command menu, stop), menus and dialogs, and the approval area (Allow once / Reject).

### apps/web/tests/expected/shortcuts/zh-CN-conflict.expected.md
Chinese counterpart of `en-US-conflict.expected.md`.

### apps/web/tests/expected/shortcuts/zh-CN-empty.expected.md
Chinese counterpart of `en-US-empty.expected.md`.

### apps/web/tests/expected/shortcuts/zh-CN-inline.expected.md
Chinese counterpart of `en-US-inline.expected.md`, with the macOS modifier names.

### apps/web/tests/expected/shortcuts/zh-CN-reset-confirm.expected.md
Chinese counterpart of `en-US-reset-confirm.expected.md`.

### apps/web/tests/expected/shortcuts/zh-CN-saved.expected.md
Chinese counterpart of `en-US-saved.expected.md`.

### apps/web/tests/expected/shortcuts/zh-CN.expected.md
Golden for the full Chinese shortcut table — the mirror of `en-US.expected.md`.

### apps/web/tests/expected/sidebar-subagent-activity/owner-running.expected.md
Golden for the session tree showing a **child subagent row** annotated `1 subagent running` with its delegated job summary — subagent activity is visible in the parent's tree.

### apps/web/tests/expected/sidebar-terminal/colors.expected.md
Measured terminal colour tokens: default text, ANSI and 256-colour foregrounds, the light RON theme, and a white-on-black variant — the terminal keeps its own palette, separate from the app theme.

### apps/web/tests/expected/sidebar-terminal/disconnected.expected.md
Golden for a disconnected terminal: a `Disconnected.` status with a `Reconnect` button.

### apps/web/tests/expected/sidebar-terminal/guide.expected.md
Golden for the terminal guide row with the `Choose shell` menu expanded.

### apps/web/tests/expected/sidebar-terminal/limit.expected.md
Golden for the terminal limit error, which states that **exited** terminals also count toward the limit — a resource claim the user can reason about.

### apps/web/tests/expected/sidebar-terminal/running.expected.md
Golden for a running terminal: the `Terminal` textbox.

### apps/web/tests/expected/sidebar-terminal/shell-menu.expected.md
Golden for the shell chooser offering `bash` and `sh`.

### apps/web/tests/expected/sidebar-terminal/theme.expected.md
Measured terminal theme surfaces (surface, viewport, underlay, foreground) for light and dark — the terminal viewport, its underlay and the app surface are three separately-pinned colours.

### apps/web/tests/expected/sidebar-terminal/unavailable.expected.md
Golden for a terminal that no longer exists: `This terminal no longer exists. Open a new terminal.` plus a New terminal button.

### apps/web/tests/expected/skill-invocation-policy/menu-fuzzy.expected.md
Golden for a fuzzy skill search that surfaces only the user-invocation-policy skill, tagged `user-only · Available only to user invocation`.

### apps/web/tests/expected/skill-invocation-policy/menu.expected.md
Golden for the skill picker listing one shared-invocation and one user-only skill, with the **policy spelled out in the option label** rather than in a tooltip.

### apps/web/tests/expected/skill-invocation-policy/preview.expected.md
Golden for the skill preview panel: the `name` and `description` terms and the skill heading.

### apps/web/tests/expected/skill-user-invoke/ui-expanded.expected.md
Golden for a **user-invoked** skill turn with the activity group expanded, showing the `/user-invoke-demo` and file-reference chips and the usage footer.

### apps/web/tests/expected/skill-user-invoke/ui.expected.md
Golden for a user-invoked skill turn with the activity group collapsed, including the `272 tok · Cache hit 0%` and `0% of context used` footer.

### apps/web/tests/expected/stats-paged-history/ui.expected.md
Large ARIA golden for a **28-turn paged history**: a `Turn navigation` rail with 28 `Jump to turn N` buttons, the whole transcript, and a `28 turns 28 steps` counter — the rail is the pagination affordance for a long session.

### apps/web/tests/expected/steer-all/mid-steer.expected.md
Golden for **steering a running turn**: the in-flight reasoning collapsed into a `Think` button, two injected interjection user messages (`BANANA`, `ORANGE`), a `Deep diving` status with a live duration (`Deep diving for {{duration}} ···`), and `Stop generating` in place of Send.

### apps/web/tests/expected/steer-all/replay.override.json
Hand-written replay override: two scripted chunk streams carrying a reasoning block, an `ask_user_question` tool call, usage and finish chunks — a throw/hang scenario expressed as a chunk script rather than a recorded session.

### apps/web/tests/expected/steer-all/settled-expanded.expected.md
Golden for the settled steered turn with the `Asked questions` group expanded, showing the answered-question chip and the merged final answer (`Got it: BANANA and ORANGE.`).

### apps/web/tests/expected/steer-all/settled.expected.md
Golden for the settled steered turn with the `Asked questions` group collapsed, both interjections rendered as user messages, and the `40 tok · Cache hit 0%` footer.

### apps/web/tests/expected/subagent-conversation/migration-required-child.expected.md
Golden for a subagent session that needs a **format migration**: the tree row is labelled `Migration required · not running` with an `Open … in sidebar` button, and opening one child switches the tree to the other — a broken child does not block the parent.

### apps/web/tests/expected/thinking-markdown/ui.expected.md
The largest golden in the shard (10 KB): Markdown rendered **inside a reasoning block** — heading levels 1–6, ordered / unordered / loose lists, blockquote, separator, a 21-row table with a long-cell row, math in list items and paragraphs (short subscript, short scripts, a long atom, inline math), a fenced typescript block with `Wrap lines` `[pressed]`, and a long-token paragraph.

### apps/web/tests/expected/todo-row/parallel-plan.expected.txt
Non-ARIA golden for the todo row: the tool name (`todo_write`), the title, a `1/4 completed` summary with a `+1` suffix, the panel counts (`1 completed · 2 in progress · 1 pending`) and each item with its state — a todo list is a **row**, not a modal.

### apps/web/tests/expected/trajectory-virtualization/load-more.expected.md
Golden for the virtualised trajectory's `Load earlier history` row with its button and status.

### apps/web/tests/expected/voice-download-fallback.expected.md
Golden for a failed voice-model download naming the file (`model.int8.onnx`), the HTTP status (502), the remediation advice, and the **download source in use**.

### apps/web/tests/expected/voice-download.expected.md
Golden for a failed voice-model download from the primary mirror, naming the file and the HTTP 503.

### apps/web/tests/expected/voice-setup.expected.md
Golden for the pre-recording voice setup dialog, which sends the user to the plugin details to review disk, memory and time estimates before starting.

### apps/web/tests/expected/voice-source-auto.expected.md
Golden for the voice download-source picker in `Automatic (recommended)` mode: the disk / memory / first-setup estimates with their caveats, and the rule that the first responding source wins and another is tried if a download fails.

### apps/web/tests/expected/voice-source-manual.expected.md
Golden for the same picker with the China mirror selected: downloads only from that source, and verified downloaded files are reused.

### apps/web/tests/expected/web-runtime-context/file-reference-prompt.expected.md
Golden holding the **runtime prompt paragraph** that tells the model how to cite files: angle-bracket destinations, the `present` tool and when to use it, the path/line-suffix convention, and the rule to keep full paths out of labels. The prompt text itself is the assertion.

### apps/web/tests/expected/web-runtime-context/web-surface-prompt.expected.md
Golden holding the runtime prompt paragraph that disambiguates "this page" as the Web GUI, states that the browser provides no implicit DOM/route/screenshot context, and warns that only the `dev:web` watcher hot-reloads client plugins.

### apps/web/tests/expected/workspace-management/grouping-options.expected.md
Golden for the sidebar view-options menu: grouping (workSpace / workspace tree / one list), ordering (manual / last updated) and archived filtering.

### apps/web/tests/expected/workspace-management/parent-folders.expected.md
Golden for a workspace tree where a folder group expands to show the parent folders around the selected session.

### apps/web/tests/expected/workspace-new-session-folding/first-batch.expected.md
Golden for a session tree folding the first batch of new sessions, ending with a `Show 6 more sessions` button.

### apps/web/tests/expected/workspace-new-session-folding/sidebar.expected.md
Golden for the collapsed sidebar tree, where the workspace row carries its action buttons and a `Show 11 more sessions` button.

### apps/web/tests/expected/workspace-new-session-folding/watermark-kept.expected.md
Golden for the tree after the watermark session is kept, showing one more row and a `Show 7 more sessions` button.

---

## Ideas worth stealing

- **Surface the provider cache-hit rate next to the token totals, and a context-used meter beside it** — `apps/web/tests/expected/cordis-history/ui.expected.md:73` (`button "66.8K tok · Cache hit 77%"`) and `apps/web/tests/expected/skill-user-invoke/ui.expected.md:27-28` (`272 tok · Cache hit 0%` / `0% of context used`). August's own notes admit it freezes the boot memory index *specifically to protect the provider prefix cache* — an invisible optimisation with no observable readout. A one-line footer carrying `tokens · Cache hit N%` turns "we think the prefix is stable" into a measured fact that a regression in prompt assembly would break, and `N% of context used` gives the user a compaction trigger before the window is full.

- **The send button unlocks only after the staged-attachment receipt lands, and a failed submission dumps the feedback regions and the event-type sequence** — `apps/web/tests/file-upload-round.e2e.ts:276-293`. August's `write_file` and its edit-verify gate are the same class of problem: the model must never be asked to act on a file the host has not yet made durable. The second half matters more — the failure throws `submission retained N draft cards; feedback=[…]; events=…`, which is a debugging affordance, not just an assertion. Transfer it to August's staged-edit / staged-upload doors.

- **The "authorised suffix" release contract: the collector may see the log up to and including the consent event, and nothing after** — `apps/web/tests/feedback-release.e2e.ts:66-85` (the `expectFeedbackRelease` helper computes `authorized = events.filter(e => e.seq <= boundary.seq)` and asserts the collector received exactly that), and the negative twin at `:206-217` (command tails, provider changes and browser reloads must release nothing, proved by the last persisted event's `seq` being *greater* than the last authorised one). August has no equivalent of "only ship what the user consented to ship" for feedback, session logs, or memory exports. This is a mechanically checkable privacy boundary expressed as a prefix, and it composes with a `seq`-ordered event log for free.

- **A "the same model reviews every native tool call *and every inner call*" permission mode, with the refusal escalated to the human** — `apps/web/tests/expected/access-confirmation/auto-confirmation.expected.md:4`. Three details transfer: the reviewer is the *acting* model (no separate critic model to prompt), the review happens at the **inner** call boundary and not merely at the outer tool boundary, and a review refusal becomes a human decision rather than a dropped call. August's tool-boundary guard (`hooks/secret_guard.py`) is a static policy; this is a dynamic one.

- **IME-safe Enter, with the `compositionend + 9ms` case pinned** — `apps/web/tests/expected/plugin-manager/ime-enter.expected.md:2-22` (five composition shapes all with `inspect=0, install=0; editable; value retained`; only a plain Enter at `:22` performs the action). The 9ms case is the one that bites: a naive `isComposing` check fires the submit immediately after `compositionend`, which on a CJK IME still lands mid-composition. August runs on Windows with a CJK-primary user, and the composer's Enter-to-send path is exactly the door this covers.

- **A per-model reasoning-effort TIER TABLE with per-tier wire values, not a flat enum** — `apps/web/tests/expected/models-settings/declared-edit.expected.md:62-88` (three tier comboboxes each with its own `API 参数值` textbox and a delete button) and `apps/web/tests/expected/models-settings/image-only.expected.md:62-88` where the semantic tier `high` carries the wire value **`deep`**. August's per-model configuration today is flat fields (`priceInPerM`, `maxTools`, `toolSurface`); a reasoning-capable gateway needs *semantic tier → provider-specific wire value*, because `high` on one provider is `xhigh` or `deep` on another. The table shape also makes "remove a tier" a first-class operation.

- **A stale-configuration acknowledgement gate that blocks saving until the human re-reads the changed bindings** — `apps/web/tests/expected/shortcuts/edit-stale.expected.md:1-5` (`Restore default` `[disabled]` + a notice + an `I have reviewed the latest configuration` button). This is the generic "the world changed under your form" pattern. August's brain-config keys and its Settings panel are exactly this shape — the backend's accepted key set and ranges can move under a form the user already filled in — and a silent save of a stale form is how a key ends up written that the backend rejects.

- **Archiving a session with live work enumerates exactly what will be stopped, by process** — `apps/web/tests/expected/session-archive-active/dialog.expected.md:5-7` (a `Work that will be stopped` list containing "The turn in progress" and the literal `node -e "…"` background-job command). August's session archive and its bot-DM ceilings both leave "what happens to work in flight" ambiguous; naming the actual process is what makes a destructive action informed rather than scary.

- **The golden refresh is the ONLY writer; a missing golden fails with a healing command** — the mechanism lives at `apps/web/tests/scaffold.ts:1710-1720` and is used by every one of the 229 expected files in this shard (e.g. `apps/web/tests/feedback-command.e2e.ts:87`). The property that transfers is not the snapshot format but the **one-writer rule**: `DSH_SNAPSHOT=refresh` is the only code path that may write a golden, and a missing golden in replay mode is a hard error naming the exact command. August's `check:*` gates are static and cannot catch "the UI changed"; a golden corpus with a single writer and a healing command can.

- **Bind the recorded fixture to the driving script by exact equality on the user prompt** — `apps/web/tests/feedback-command.e2e.ts:56-59`, repeated at `apps/web/tests/feedback-release.e2e.ts:159-162` and `apps/web/tests/file-upload-round.e2e.ts:225-228` (`expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])`). The recorded model output and the script that drives the browser are two artefacts that drift apart silently; asserting the exact prompt list makes a re-record fail loudly instead of quietly changing the question the test is asking.

- **A fixture-inventory gate that also asserts the committed JSONL is a fixed point of the prompt-bulk scrubber and the identity redactor** — used at `apps/web/tests/feedback-command.e2e.ts:99-103` and `apps/web/tests/file-upload-round.e2e.ts:431-437`; the implementation is `apps/web/tests/scaffold.ts:1728-1755`. This is a gate on the **test corpus**, not on the code: the directory must contain exactly the named files, and every committed session log must be unchanged by `scrubModelRequestBulk` (no prompt text, no tool-schema bulk) and by `redactSessionSnapshotIds` (no unredacted identities). August removed its test suite; this is the kind of self-audit a repo without tests is most exposed to.

- **A console tripwire that treats "gap repair" and "discontinuous" as failures, and forgives only the connection-loss warning produced by an intentional reload** — `apps/web/tests/scaffold.ts:1773-1796` (`watchConsole` / `acknowledgeReloadConnectionLoss`), asserted empty at `apps/web/tests/feedback-command.e2e.ts:95-96`. August's SSE reader consumes a live stream; a gap repair is a silent discontinuity in the loop's view of the world, and "eventual consistency" is exactly the excuse that hides it. Making the wire's health a test tripwire is how you make it visible in production too.

- **A route-only adapter that throws if a scenario that declared no model call actually issues one** — `apps/web/tests/scaffold.ts:259-264` (`stream()` throws "a model call was issued by a scenario that declared no replay fixture") and `:899-909` (the route-only registration for a UI scenario that needs provider labels but must never call a model). A UI test that accidentally triggers a model turn should **fail**, not quietly cost money and pass. August's UI-only harnesses would benefit from the same "declared no model calls ⇒ any model call is a failure" contract.

- **Express a hang/throw scenario as a chunk script via a replay override, not as a recorded session** — `apps/web/tests/expected/steer-all/replay.override.json:1-45` (block-start / reasoning-delta / tool-call-delta / block-end / usage / finish chunks for two turns). It lets the steering surface be tested without a real model, by scripting the exact wire chunks — including a tool call the model would never make. August's turn-boundary and stall scenarios currently need a live provider or a bespoke fake.

- **Measure hover choreography as a named-stage state machine instead of a screenshot** — `apps/web/tests/expected/session-row-hover/grouped.expected.json:1-40` (ten named stages proving the reveal is exclusive, survives a portal round trip and cools down) and `apps/web/tests/expected/session-row-hover/actions.expected.json:1-37` (the tooltip appears only after a dwell and clears on return to the title). A hover-only affordance is a trap if it lingers or if two rows reveal at once; asserting the *sequence* of states makes the timing reviewable in a diff.

- **One model-label table drives the composer trigger, the `/model` picker and the command-picker group headers** — `apps/web/tests/expected/default-model/model-labels.expected.md:1-42` (provider / model / name / **slot** / inline). The `slot` key is the useful part: it names *which* surface the label belongs to, so a label can be shared without the two surfaces drifting. August's own notes record that `getProvidersAsModels()` and `_provider_to_dict` rebuild model entries field by field and a new per-model field must be named in **both** or it is silently dropped — a table with explicit slots is the fix for that class of bug.

- **Let the model declare its context window and output cap, accepting both a human-formatted default and a literal override** — `apps/web/tests/expected/onboarding-deepseek-config/models.expected.md:37-43` (context window typed literally as `131072`, output cap `64K`) against the default catalogue's `1M` / `256K` placeholders at `apps/web/tests/expected/onboarding-deepseek-config/default-models.expected.md:36-41`. August's `contextWindow` / `defaultMaxTokens` come from the provider catalogue today; a per-model override that is editable in the UI is what lets a gateway advertise a real window instead of a guess.

- **The output-limit notice names the recovery verb and promises the earlier output survived** — `apps/web/tests/expected/max-tokens-notice/history-turn.expected.txt:1-3` ("The reply was cut off; earlier output is preserved in the conversation. Send \"continue\" to let the model resume."). August records `turn_end {reason: 'length'}` and renders an amber stop-reason badge, but the *contract with the user* — that a specific word resumes and that nothing was lost — is the transferable half.

- **Measure the browser-facing geometry as *relations*, never as pixels** — `apps/web/tests/expected/composer-tab-geometry/geometry.expected.md:1-40` (a Chat-vs-Trajectory control that removes the scrollbar-gutter compensation in the page and shows the card then moving 2.5px, against the production 0px), and `apps/web/tests/expected/markdown-wide-table/geometry.expected.md:1-21` (fill / wide / long-cell relations at three widths, plus the "wrap-first engagement" assertion). The counterfactual block is the key idea: the golden proves the *cause* of the 0px, not just the 0px.

---

## Files skipped (with reasons)

None. All 232 files in the shard were opened and read in full — the three e2e specs line by line, and the 229 expected files end to end. There are no generated, vendored, binary or huge-data files in this shard: the largest file is `apps/web/tests/expected/thinking-markdown/ui.expected.md` at 10,107 bytes and the whole shard totals 229,048 bytes, so no file needed a partial read. The ledger at `shards/dsh-apps-web#2.rows.tsv` records 232 `read` rows whose paths were verified to match the manifest's `dsh-apps-web#2` rows exactly.

---

## Uncertainties

- **The lane's mechanics live in files outside this shard.** `apps/web/tests/scaffold.ts` (1,796 lines), `apps/web/tests/support.ts`, `apps/web/tests/README.md` and the `snapshots/web/**` fixture directories are owned by other shards. I read `scaffold.ts` (lines 1–998 and 1290–1796) and `README.md` for context so that the expected-file notes are accurate, but the e2e specs in this shard depend on helpers I did not fully review — in particular `captureStableAria`'s normalisation (`scaffold.ts:1574-1605`), `whenTurnSettled` (`:964-978`), `compareOrRefreshGolden` (`:1710-1720`) and `assertFixtureInventory` (`:1728-1755`). The claims I make about those in *Ideas worth stealing* are anchored to the shard files themselves and to the specific scaffold lines I read; I did not verify the behaviour of `scaffold.ts:999-1289`, which I did not read.

- **The 229 expected files are assertions, not implementations.** Each one records what the browser produced at the moment it was captured. I can say with confidence what each golden *asserts* (that is what is written in it), but I cannot say from this shard alone *which component* produces each element, nor whether a golden is currently green. Several goldens encode behaviour whose implementation I did not read: the `Think` / reasoning toggle (`seeded-history/blank-reasoning.expected.md`), the `Trajectory` tab (`navigation-panes`, `trajectory-virtualization`), the `present` file card (`clickable-links-gallery`), the cache-hit and context-used footer (`cordis-history`, `skill-user-invoke`, `steer-all`), and the permission-mode picker (`access-confirmation`). For the same reason I could not establish whether the `Cordis` scenario's `{{cacheReadTokens}}` accounting matches a real provider's cache semantics, only that the UI renders a percentage.

- **Locale split is partial and I could not determine the rule.** Roughly half the expected files are Chinese and half English, and some scenarios ship both (`desktop-locale/automatic` + `selected`, `shortcuts/en-US` + `zh-CN`, `settings-chrome/dialog` + `dialog-en`, `plugin-manager/exports` + `exports-en`, `shared-inspector/metadata-en` + `metadata-zh`, `plugin-install-github/failed` vs `failed-on-mirror`). Some Chinese goldens use Chinese labels for the *same* control that other scenarios label in English (`clickable-links-gallery/ui.expected.md` is English while `cordis-history/ui.expected.md` is also English but `cot-translation/*` is Chinese). I could not determine whether the language follows the UI locale, the scenario, or the fixture, because the deciding code lives in the e2e specs outside this shard.

- **The `{{fromRequest:…}}` replay-override placeholder** is described in `apps/web/tests/file-upload-round.e2e.ts:203-206` and appears in the shard's `apps/web/tests/expected/steer-all/replay.override.json`, but the override file in this shard does **not** itself contain a placeholder (it is a plain chunk script). The placeholder lives in the file-upload scenario's override, which is in `snapshots/web/file-upload-round/` — outside this shard. I verified the substitution machinery exists at `packages/test-support/llm-replay/src/index.ts:536-604` by grep, but I did not read it in full, so I have not confirmed its exact resolution semantics (last match, first capture group) beyond the README's description.

- **Two files in this shard are *not* what their directory name suggests**, and I could not resolve why: `apps/web/tests/expected/new-session-refused/notice.expected.md` and `apps/web/tests/expected/office-font-notice.md` sit at the root of `expected/` and `expected/office-font-notice.md` respectively, but the manifest and directory listing disagree about which of the two is the `office-font-notice` file — the manifest lists `apps/web/tests/expected/office-font-notice.md` and the directory contains exactly that file, so both are present and distinct. I read both and described them separately; I could not determine from this shard which e2e spec consumes the `office-font-notice.md` checklist (its content is a measurement checklist rather than an ARIA tree, so it belongs to an Office-document scenario not in this shard).

- **The `expected/` tree has no README or index.** There is no in-shard document explaining the golden conventions, so the meaning of the `{{cwd}}` / `{{workspace}}` / `{{clock}}` / `{{duration}}` / `{{throughput}}` / `{{age}}` / `{{uuid}}` / `{{version}}` / `{{fixtures}}` / `{{home}}` / `{{linkUrl}}` / `{{longToken}}` placeholder vocabulary was reconstructed from `scaffold.ts:1574-1605` and from the goldens themselves, not from a specification in this shard.

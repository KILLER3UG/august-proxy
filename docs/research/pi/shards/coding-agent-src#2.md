# pi / coding-agent-src#2

## Shard shape

This shard is the **presentation and headless-protocol layer** of pi's `coding-agent` package — everything between the agent core (`AgentSession`, the tool registry, session storage, compaction and the provider layer, all of which live in `core/` and are out of shard) and the user. It holds four clusters that fit together like this:

1. **`modes/interactive/`** — the TUI. `interactive-mode.ts` (7,082 lines) is the hub: it owns the component tree, subscribes to `AgentSessionEvent`s, and translates them into rendered chat, a pending-queue area, status indicators and tool-execution components. Around it sit ~45 leaf components (selectors, message renderers, an animated logo, two easter eggs), a four-file theme system (`theme/`) that can *generate* a theme from the terminal's own reported colours, and the chat-viewport / TUI-factory pair that let the whole renderer be swapped between "regular" (normal scrollback) and "fullscreen" (alt-screen) at runtime.
2. **`modes/rpc/` + `modes/json-event.ts` + `modes/print-mode.ts`** — the headless surface. A JSON-lines protocol on stdin/stdout with a typed client, plus a one-shot print mode. This is where the *wire* shape of a turn is decided, including what "the model is streaming" looks like on the wire.
3. **`utils/`** — 37 small, mostly platform-boundary helpers: clipboard (six platforms, three backends), image conversion/resize (Photon WASM in a worker thread), shell discovery, child-process lifetime, ANSI stripping for streamed output, syntax highlighting, path canonicalisation, safe output files, git-URL parsing.
4. **`package-manager-cli.ts`** — the `pi install/remove/update/list/config` CLI, including a *managed* self-update that stages an npm install, **verifies it by executing the new binary**, and atomically flips a `current-version` pointer.

What this shard does *not* contain: the agent loop, tool definitions/execution, session storage/branching, compaction, and the model/provider abstraction. Its contribution to those is the **boundary contract**: which events the UI reacts to, what queue semantics the UI exposes to the user, and what shape a turn takes on the wire.

---

## Per-file notes

### packages/coding-agent/src/modes/index.ts
- Purpose: barrel re-export of the four run modes (interactive, print, json, rpc).
- Non-obvious: exports the `RpcClient` class and the `RpcCommand`/`RpcResponse` types from the same barrel as the runners, so an embedder never has to reach into `modes/rpc/`.

### packages/coding-agent/src/modes/interactive/assets/clankolas.png
- Purpose: bundled PNG banner shown by the "pi has joined Earendil" announcement.
- Note: binary asset — verified as a real PNG (89 50 4E 47 signature, IEND trailer, 539,053 bytes) but not read line by line. See *Files skipped*.

### packages/coding-agent/src/modes/interactive/bug-report.ts
- Purpose: the `/bug` flow — consent, optional model-written summary, then upload or zip export.
- Key abstractions: `BugReportContext` (session, ui, editorContainer, editor, keybindings, showStatus/showError) plus a small overlay protocol (`showOverlay` / `restoreEditor`) that swaps the editor slot for a dialog component and puts the editor back.
- Data flow: `promptForOptions` → optional `session.summarizeForBugReport` → `buildBundle` (metadata + diagnostics + optional session JSONL) → `uploadBugReport` or `writeBugReportArchive` → `appendCustomEntry` records the report in the session.
- Non-obvious design decisions: the consent dialog names the *destination host* (`new URL(getRadiusGatewayUrl()).host`) so the user knows where the transcript goes; choosing "no transcript" offers to attach a model-written summary instead, and warns that "the transcript is sent to `<provider>` with your credentials and tokens. Only the generated summary is attached; the transcript stays on your machine."
- Edge cases: upload failure offers "Export as Zip" rather than dead-ending; `PI_OFFLINE` refuses upload and points at the zip path; a cancelled summary aborts via the loader's `signal`.
- Surprising: the summary is written by the *same* model the user is reporting a bug in.

### packages/coding-agent/src/modes/interactive/chat-viewport.ts
- Purpose: builds the shared layout — a scrolling transcript plus a fixed input dock.
- Key abstractions: `createChatViewport` returns `{ root, transcript }`; the dock is a `VStack` of pendingMessages / status / widgetsAbove / editor / widgetsBelow / footer.
- Non-obvious: the transcript is `follow: "end"` with `primary: true` and `overscroll: "chain"`, and the editor slot is given `minSize: 3` so a long transcript can never squeeze the input out of existence.

### packages/coding-agent/src/modes/interactive/components/armin.ts
- Purpose: XBM-bitmap easter egg — a 31×36 pixel "Armin" rendered with half blocks under one of seven random reveal effects.
- Key abstractions: `isArminPixel(x, y)` reads a packed LSB-first bit array; `getChar` packs two vertical pixels into `█ ▀ ▄`.
- Non-obvious: the `rain` effect computes each column's *target row* (the lowest non-space pixel of the silhouette) so drops settle onto the shape rather than the bounding box; `glitch` runs at 60 fps, everything else at 30.
- Edge cases: the grid is clipped to the available width before colouring, and the right pad is computed from the clipped length.

### packages/coding-agent/src/modes/interactive/components/assistant-message.ts
- Purpose: renders an assistant message (text + thinking blocks) with streaming updates.
- Key abstractions: `thinkingVisibilityOverrides: Map<number, boolean>` keyed by *thinking run index* — a per-run click override that survives re-renders.
- Data flow: `updateContent(message, isStreaming)` clears and rebuilds the content container on every delta.
- Non-obvious: consecutive `thinking` blocks are merged into one markdown run, and a spacer is added only when another visible block follows — "This avoids a superfluous blank line before separately-rendered tool execution blocks." Tool calls are rendered as separate components, so the assistant component never draws them.
- Edge cases: `stopReason === "length"` renders "Response was truncated before completion."; `aborted`/`error` are only rendered when there are no tool calls, because the tool components carry the error themselves.
- Surprising: the whole message is wrapped in OSC 133 shell-integration zone markers (`\x1b]133;A` … `\x1b]133;B\x1b]133;C`), so a terminal shell can tell what the agent printed — but only when the message has no tool calls.

### packages/coding-agent/src/modes/interactive/components/auth-url.ts
- Purpose: renders an OAuth sign-in URL with a click hint and a copy hint.
- Non-obvious: hosts call `copy()` when `app.message.copy` is pressed, "since a long URL wraps and often cannot be selected or clicked as a whole (SSH, tmux)". The click hint is platform-specific (Cmd+click on macOS, Ctrl+click elsewhere).

### packages/coding-agent/src/modes/interactive/components/bash-execution.ts
- Purpose: displays a bash command with streaming output.
- Key abstractions: `colorKey: "dim" | "bashMode"` — `!!` commands (output excluded from model context) are rendered dim instead of the bash-mode colour, so the user can see at a glance that the model will *not* see the output.
- Data flow: `appendOutput` strips ANSI, normalises line endings, and stitches the first line of each chunk onto the last incomplete line.
- Non-obvious: two truncations are applied in sequence — the *context* truncation (`truncateTail` with the LLM's `DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`) and then the *preview* truncation (last 20 lines). The preview uses `truncateToVisualLines` with a per-width cache, so a long single line is measured in wrapped lines, not logical lines.
- Edge cases: the truncation notice names the full-output path, so the user can recover the bytes the model did not get.

### packages/coding-agent/src/modes/interactive/components/bordered-loader.ts
- Purpose: a cancellable loader wrapped in borders, used by extension UI and the share/bug flows.
- Non-obvious: a *non*-cancellable loader still exposes a `signal` (a private `AbortController`) so callers can use one code path for both.

### packages/coding-agent/src/modes/interactive/components/branch-summary-message.ts
- Purpose: renders a branch-summary message with collapsed/expanded state.
- Note: shares the `customMessageBg` background with custom messages "for visual consistency"; a left click toggles expansion.

### packages/coding-agent/src/modes/interactive/components/compaction-summary-message.ts
- Purpose: renders a compaction summary with collapsed/expanded state.
- Non-obvious: the collapsed line states the token count it replaced ("Compacted from 71,234 tokens") so the user can see what the context relief cost.

### packages/coding-agent/src/modes/interactive/components/config-selector.ts
- Purpose: the TUI for enabling/disabling package resources (extensions, skills, prompts, themes) at global or project scope.
- Key abstractions: `ResourceGroup` keyed by `origin:scope:source:baseDir`, with `ResourceSubgroup` per resource type; the flat list mixes `group` / `subgroup` / `item` entries so one cursor walks the whole hierarchy.
- Data flow: `buildGroups` → flat list → filter (matching items pull their group and subgroup along) → toggle writes `+pattern` / `-pattern` entries into the settings array.
- Non-obvious design decisions: the project scope has a *three-state* override — `inherit` / `load` / `unload` — and the next state is computed from the **inherited global** state (`getNextOverrideState`), so pressing space always changes something visible. A project entry that overrides an inherited global file must name the file itself plus the `+`/`-` marker ("Project entries name inherited files to override them").
- Edge cases: an inherited global item is dimmed while its project state is `inherit`; a package with no remaining filters is collapsed back to a bare source string so the settings file does not accumulate empty objects.
- Surprising: `packageSourceStringMatches` resolves two local-path sources against their own scope base dirs before comparing, so the same directory written as an absolute path in one scope and relative in another is recognised as the same package.

### packages/coding-agent/src/modes/interactive/components/countdown-timer.ts
- Purpose: a 1-second-tick countdown used by the retry indicator and by dialog timeouts.
- Note: `onTick` fires immediately in the constructor, so the first frame already shows the correct remaining seconds.

### packages/coding-agent/src/modes/interactive/components/custom-editor.ts
- Purpose: the main input editor, extending pi-tui's `Editor` with app-level keybindings.
- Key abstractions: `actionHandlers: Map<AppKeybinding, () => void>` — the app registers named actions (`app.clear`, `app.model.cycleForward`, …) and the editor dispatches by name, so a rebindable key table drives behaviour.
- Non-obvious design decisions: `embedWorkingStatus` makes the editor draw the working/compaction/retry indicator **in its own top border** instead of a separate status row, and `renderTopBorder` degrades in three steps (full status + overflow count → spinner only → bare spinner) as the width shrinks. The Escape handler is `app.interrupt` and is *not* fired while the autocomplete dropdown is open. Explicit history bindings (`tui.editor.historyPrevious/Next`) take precedence over app actions "so users can bind Ctrl+P even though it cycles models by default."
- Edge cases: Ctrl+D (`app.exit`) only fires when the editor is empty; otherwise it falls through to the editor's delete-char-forward.
- Surprising: `onEscape`, `onCtrlD`, `onPasteImage` and `onExtensionShortcut` are *replaceable* properties, so a mode that wants a different Escape behaviour (compaction, retry) temporarily rebinds them and restores the original.

### packages/coding-agent/src/modes/interactive/components/custom-entry.ts
- Purpose: renders a custom session entry produced by an extension.
- Non-obvious: the extension renderer is called inside a try/catch and a failure produces a visible `[<customType>] renderer failed: <message>` box rather than an empty row. The host owns transcript spacing; the renderer supplies only content.

### packages/coding-agent/src/modes/interactive/components/custom-message.ts
- Purpose: renders a custom *message* from an extension, distinct from user messages.
- Non-obvious: if the extension supplies a renderer, it owns its own styling; the default `[<customType>]` label + markdown body is only the fallback, and a throwing renderer falls through to it.

### packages/coding-agent/src/modes/interactive/components/diff.ts
- Purpose: renders a unified diff with colour and intra-line change highlighting.
- Key abstractions: `renderIntraLineDiff` uses `Diff.diffWords` (which groups whitespace with the adjacent word) and applies `theme.inverse` to the changed tokens.
- Non-obvious: intra-line highlighting is only applied when the hunk is **exactly one removed and one added line** — "indicating a single line modification"; otherwise the lines are shown as-is, because a word diff across a whole block is noise. Leading whitespace is stripped from the inverse region so indentation is not highlighted.
- Edge cases: tabs are expanded to three spaces; a line that does not parse is rendered as context.

### packages/coding-agent/src/modes/interactive/components/dynamic-border.ts
- Purpose: a horizontal rule that adapts to the viewport width.
- Non-obvious: the docstring warns that the global `theme` may be `undefined` when the component is used from a jiti-loaded extension ("jiti creates a separate module cache"), so an explicit colour function should always be passed for extension-facing use.

### packages/coding-agent/src/modes/interactive/components/earendil-announcement.ts
- Purpose: the "pi has joined Earendil" banner.
- Note: the PNG is loaded once and cached as base64; the load is attempted lazily and the banner renders without the image if the asset is missing.

### packages/coding-agent/src/modes/interactive/components/easter-egg-3d.lazy.ts
- Purpose: lazy loader for the fullscreen 3D easter eggs.
- Non-obvious: the screen is captured *before* the module is imported, because the effect dissolves the rendered screen into braille dust and needs the pre-dissolve pixels. Only `TuiAltScreen` can play it; the loader returns `false` so the caller can fall back to the inline 2D version.

### packages/coding-agent/src/modes/interactive/components/easter-egg-3d.ts
- Purpose: a fullscreen 3D animation: the current screen dissolves into braille dust while a ray-cast block model spins in the centre and plays a sliding puzzle; leaving replays the timeline backwards so the screen reassembles.
- Key abstractions: `Model` (a bitmap of blocks with camera distance, radius, width share, a per-cycle `puzzleMoves` function and an optional origin), `ScreenCell` (per-cell fg/bg/delay/ink/seed), `BlockRaster` (per-braille-dot ray casting), `Pose` (centre, scale, yaw/pitch/roll).
- Non-obvious design decisions: one pixel of the half-block bitmap is exactly 2×2 braille dots, so the 4×2-cell header logo is 8×8 dots when it lifts off. A *puzzle* phase follows the spin, and `shuffleSteps` is deterministic per cycle (`cycle * 7_919 + 1` seeds a hash) so the shuffle is reproducible. Blocks that just moved are excluded from the next move so the puzzle does not look like one block jittering. On light backgrounds the logo gets a halo, "because on light backgrounds most of each braille cell shows the bright background, which washes the logo out."
- Edge cases: `parseScreen` skips OSC/APC/cursor sequences and understands both `38;5;n`/`38;2;r;g;b` and the colon-sub-parameter form; the animation self-terminates if it has not rendered for 1000 ms (the overlay was hidden), so it can never spin forever.
- **Uncertainty:** I read lines 1–350 and 860–979 in full and skimmed the middle (the rasteriser, the starfield and the pose maths). The mechanism above is verified; the exact rasterisation and the dust/halo timing constants are not.

### packages/coding-agent/src/modes/interactive/components/extension-editor.ts
- Purpose: a multi-line editor for extension dialogs.
- Non-obvious: it stops the TUI, hands the text to `$EDITOR`/`$VISUAL`/`nano`/`notepad` and restarts the TUI in a `finally` block, so a crashed external editor cannot leave the TUI stopped.

### packages/coding-agent/src/modes/interactive/components/extension-input.ts
- Purpose: a single-line text input for extension dialogs.
- Non-obvious: a `timeout` turns the title into a live countdown (`<title> (12s)`) and cancelling the countdown calls the cancel callback — the extension's promise is always settled.

### packages/coding-agent/src/modes/interactive/components/extension-selector.ts
- Purpose: a list-of-strings selector for extension dialogs.
- Non-obvious: it also accepts raw `"k"`/`"j"`/`"\n"` alongside the configured keybindings, and forwards `app.tools.expand` so a dialog can toggle the transcript expansion while open.

### packages/coding-agent/src/modes/interactive/components/first-time-setup.ts
- Purpose: the first-run dialog — theme choice, then analytics opt-in.
- Non-obvious: the whole dialog is rebuilt on every change ("so theme previews recolor all text"), and the analytics paragraph states exactly what is stored ("a tracking identifier in settings.json and enables anonymous usage analytics") and that `/privacy` shows what is shared.

### packages/coding-agent/src/modes/interactive/components/footer.ts
- Purpose: the status line — cwd, git branch, session name, token counts, cache hit rate, cost and context percentage.
- Key abstractions: `getSessionStats()` caches the whole-session usage scan, invalidated by the tuple `(session, sessionId, leafId, entryCount, limitsModel)`.
- Non-obvious design decisions: the cache key is derived from an *argument*, not a timer: "Entries are append-only and every append moves the leaf, so the results only change with the session, leaf, entry count, or the model whose context window applies." The scan covers *all* entries (not just post-compaction messages) so the totals survive compaction. The context percentage is coloured error above 90 % and warning above 70 %. A subscription-backed provider shows ` (sub)` next to the cost.
- Edge cases: the dim wrapper is applied to the two halves **separately** — `statsLeft` contains a colour reset that would clear an outer dim wrapper; a routed (virtual) model appends `→ <model>` so the user can see where the request actually went.
- Surprising: `formatCwdForFooter` uses `relative()` and then checks that the result is not `..`-prefixed, so a cwd outside home is shown absolute rather than as a chain of `..`.

### packages/coding-agent/src/modes/interactive/components/index.ts
- Purpose: barrel re-export of the components that extensions may use.
- Note: it deliberately exports `truncateToVisualLines` and `renderDiff` as well, so extension renderers truncate the same way the built-ins do.

### packages/coding-agent/src/modes/interactive/components/keybinding-hints.ts
- Purpose: formats keybinding hints for the UI.
- Non-obvious: `alt` is displayed as `option` on macOS; hints are two-tone (dim key, muted description) so the key is scannable.

### packages/coding-agent/src/modes/interactive/components/login-dialog.ts
- Purpose: the OAuth / API-key login dialog that replaces the editor during authentication.
- Key abstractions: a single `Input` reused for manual-code, prompt and OAuth-select flows, with `inputResolver` / `inputRejecter` swapped per flow.
- Non-obvious: `showPrompt` *appends* to the content container rather than clearing it, so the sign-in URL stays visible while the code is asked for. `cancel()` aborts the shared `AbortController` and rejects the pending input promise, so the login promise never dangles. `app.message.copy` copies the sign-in URL while the dialog is open.
- Edge cases: the submitted input is replaced by a static `> value` line so the transcript shows what was entered; `showInfo` renders provider-owned links as OSC 8 hyperlinks.

### packages/coding-agent/src/modes/interactive/components/markdown-transform.ts
- Purpose: chains extension markdown transformers.
- Non-obvious: each transformer receives the *previous* transformer's output, and a transformer that throws is skipped — "Keep the current Markdown and continue with the next transformer."

### packages/coding-agent/src/modes/interactive/components/mermaid.ts
- Purpose: replaces mermaid code blocks with Unicode terminal diagrams.
- Non-obvious design decisions: the diagram is only substituted if it fits `context.availableWidth`; otherwise the original code block is kept. In `final` mode a diagram with warnings is not rendered and a warning is appended instead; in `streaming` mode it is rendered live. The `codeSpan` encoder picks a backtick fence **longer than any backtick run in the content** and pads with a space when the content starts or ends with a backtick, because CommonMark removes the padding. Blank rows use a non-breaking space, "because an empty code span has no visible height."
- Edge cases: thinking blocks are never transformed.

### packages/coding-agent/src/modes/interactive/components/model-selector.ts
- Purpose: the `/model` picker with fuzzy search, a scoped/all toggle, and a background catalog refresh.
- Non-obvious design decisions: the list is rendered from the **cached snapshot immediately** and the catalog refresh happens in the background, so the picker is usable before the network answers. A refresh timeout or a per-provider error downgrades to a warning and the cached list is kept. Typing "default" ranks the default model first. The sort order is current model, then default model, then provider.
- Edge cases: `dispose()` aborts the in-flight refresh, and a `closed` flag stops a late refresh from touching the UI; the selector is disposed on select *and* on cancel.

### packages/coding-agent/src/modes/interactive/components/oauth-selector.ts
- Purpose: the `/login` and `/logout` provider picker.
- Non-obvious: `formatAuthSelectorProviderStatus` distinguishes a *matching* configured type (green "✓ configured") from a *mismatched* one (amber "subscription configured") and names the source — an env var (`env: OPENAI_API_KEY`) is distinguished from a stored credential. The auth-type label is only shown when more than one auth type is on offer.

### packages/coding-agent/src/modes/interactive/components/pi-logo.ts
- Purpose: the 4-cell × 2-line pi logo, drawn with half blocks in fixed brand colours.
- Non-obvious: `supportsPiLogo()` returns false on Apple Terminal, "because Apple Terminal draws gaps between rows and misaligns the half blocks", so those users get the text wordmark instead. The brand colours are fixed across themes but follow the terminal's colour mode.

### packages/coding-agent/src/modes/interactive/components/radius-login-selector.ts
- Purpose: the `/login` menu whose "Sign in with Radius" option shimmers in the Radius logo colours.
- Non-obvious: the shimmer is applied by *replacing* the line the parent selector drew — it re-renders the expected selected line and searches for it in the output; if the parent's row style or wrapping changes, the match fails and the option renders normally instead.

### packages/coding-agent/src/modes/interactive/components/scoped-models-selector.ts
- Purpose: the `/scoped-models` picker that decides which models the Ctrl+P cycle visits, and in what order.
- Key abstractions: `EnabledIds = string[] | null`, where `null` means "all enabled" — and `normalizeEnabled` collapses an explicit list back to `null` when it covers every available model, so the persisted settings never enumerate the whole catalogue.
- Non-obvious: changes are **session-only until explicitly persisted** (`app.models.save`); the footer shows "(unsaved)" while dirty. "Enable all" and "clear all" operate on the *filtered* set when a search is active. A model that is enabled but no longer in the catalogue is shown struck through as `[unavailable]` and counted separately in the footer.
- Edge cases: reordering is bounds-checked and only allowed for enabled models.

### packages/coding-agent/src/modes/interactive/components/session-selector-search.ts
- Purpose: the search grammar and ranking for the session picker.
- Key abstractions: `ParsedSearchQuery` with `mode: "tokens" | "regex"` and tokens of `kind: "fuzzy" | "phrase"`.
- Non-obvious design decisions: `re:<pattern>` switches to regex; a quoted segment is an exact phrase; bare words are fuzzy. An **unclosed quote falls back to plain whitespace tokenisation** rather than erroring, so a half-typed search still filters. The search corpus is `id + name + allMessagesText + cwd`.
- Edge cases: a regex that fails to compile returns `error`, and the caller renders *no* results rather than crashing.

### packages/coding-agent/src/modes/interactive/components/session-selector.ts
- Purpose: the `/resume` picker — scope (current folder vs all), sort mode, name filter, rename, delete.
- Key abstractions: `SessionList` builds a *threaded* tree from `parentSessionPath`, sorted by the latest activity in each subtree; the other sort modes use a flat list.
- Non-obvious: the two scopes are loaded **separately and lazily** with their own `AbortController`s, and a scope switch shows the already-loaded list immediately while the other loads in the background. Each load reports progress (`loaded/total`) and partial results, so the list fills in as the scan runs.
- Edge cases: deleting the *current* session is refused ("Cannot delete the currently active session"). `deleteSessionFile` tries the `trash` CLI first and falls back to `unlink`; "If trash reports success, or the file is gone afterwards, treat it as successful". A path starting with `-` is passed after `--` so it cannot be read as an option.
- Surprising: the delete confirmation state intercepts **all** keys until confirmed or cancelled.

### packages/coding-agent/src/modes/interactive/components/settings-selector.ts
- Purpose: the `/settings` panel — ~35 settings, each a `SettingItem` with an id, label, description, current value and a value list or a submenu.
- Key abstractions: `SettingsConfig` (the whole state, read once) and `SettingsCallbacks` (one callback per setting), so the component is a pure view over a config object and the host applies the change.
- Non-obvious design decisions: the "Theme" setting opens a two-mode submenu — a single theme, or "automatic" (`light/dark` pair) that follows the terminal's appearance; cancelling restores the original theme by calling `onThemePreview(originalThemeSetting)`. The per-model thinking-level override is a `SteppedSubmenu` (pick model → pick level → optionally "(clear override)"), and it *loops* so several models can be configured in one visit. Image-related settings are spliced in conditionally — "Show images" and "Image width" only exist when the terminal supports images, while "Auto-resize" and "Block images" are always present.
- Edge cases: the callback switch is exhaustive over the item ids, so a new setting without a callback branch is a type error.

### packages/coding-agent/src/modes/interactive/components/settings-submenu.ts
- Purpose: reusable single-step (`SelectSubmenu`) and multi-step (`SteppedSubmenu`) selectors.
- Non-obvious: `SteppedSubmenu` steps can be *functions of the shared context*, so step 2's options depend on step 1's answer; Esc goes back one step and deletes that step's context key, Esc at step 0 cancels. `loop: true` returns to step 0 after completing the last step, which is what makes the per-model thinking override usable.

### packages/coding-agent/src/modes/interactive/components/show-images-selector.ts
- Purpose: a yes/no picker for inline image rendering.
- Note: preselects the current value; the select list is a `SelectList` with fixed column widths.

### packages/coding-agent/src/modes/interactive/components/skill-invocation-message.ts
- Purpose: renders a `skill:` invocation block.
- Non-obvious: only the skill block is rendered here — the accompanying user message is rendered separately by the host, so the two are visually distinct.

### packages/coding-agent/src/modes/interactive/components/status-indicator.ts
- Purpose: the four status indicators (working, retry, compaction, branch summary) plus a blank idle status.
- Non-obvious: `renderInBorder` / `renderSpinnerInBorder` exist so the indicator can be drawn *inside* the editor's border; the retry indicator owns a `CountdownTimer` and shows "Retrying (2/5) in 3s... (Esc to cancel)".
- Edge cases: the compaction indicator distinguishes `manual` ("Compacting context…") from `threshold`/`overflow` ("Context overflow detected, Auto-compacting…").

### packages/coding-agent/src/modes/interactive/components/theme-selector.ts
- Purpose: a theme picker that previews as you move.
- Non-obvious: `onSelectionChange` triggers the preview, so the whole UI recolours live while the list is still open.

### packages/coding-agent/src/modes/interactive/components/themed-text.ts
- Purpose: text whose content is rebuilt from a callback on every invalidation.
- Non-obvious design decision: plain `Text` freezes the colours its string was built with, so "a theme change, or the system theme receiving the terminal's colors, would leave it stale". The docstring also warns: "`build` must return the same content each time, apart from colors. Snapshot changing data before creating the component, or call `invalidate()` after changing state that `build` reads."

### packages/coding-agent/src/modes/interactive/components/thinking-selector.ts
- Purpose: the thinking-level picker with per-level token-cost descriptions.
- Non-obvious: the level descriptions are the *only* place the user learns that `high` is "~16k tokens"; the picker also has a separate "set as default" binding distinct from "select for this session".

### packages/coding-agent/src/modes/interactive/components/tool-execution.ts
- Purpose: renders one tool call — the arguments, the result, and any images.
- Key abstractions: `ToolRenderers` (`renderCall` / `renderResult` / `renderShell`) resolved from the extension registry with a built-in fallback (`withBuiltInRenderers`); `getRenderContext()` hands the renderer `args`, `toolCallId`, `invalidate`, `lastComponent`, a persistent `state` object, `cwd`, `executionStarted`, `argsComplete`, `isPartial`, `expanded`, `showImages`, `isError`, `durationMs` and `outputPad`.
- Data flow: `markExecutionStarted()` → `updateArgs()` (as the model streams arguments) → `setArgsComplete()` (at `message_end`) → `updateResult()` (possibly partial, then final). The background colour is derived from the state: pending / success / error.
- Non-obvious design decisions: a tool renderer that **throws** falls back to the generic `formatToolCallWithArgs` rendering rather than blanking the row. `renderShell: "self"` lets a tool own its own framing, and the mouse handler translates the click coordinates when the shell is self-rendered. Image components are **reused** across re-renders when the data, mime type and width are unchanged, so the converted PNG is not recomputed.
- Edge cases: a tool with no renderer and no output renders nothing at all (`hideComponent`), rather than an empty box.

### packages/coding-agent/src/modes/interactive/components/tree-selector.ts
- Purpose: the `/tree` picker — the session's entry tree, with branching, folding, filtering and labels.
- Key abstractions: `FlatNode` (node, indent, connector flags, per-ancestor gutter info); `renderHorizontalViewport` pans the row bodies while keeping the 2-column gutter always visible.
- Non-obvious design decisions: the branch containing the active leaf is ordered **first** (computed by an iterative post-order traversal "to avoid stack overflow"), and roots are ordered the same way. Indentation follows a rule set: a branch point's children get +1, the first generation after a branch gets +1 for visual grouping, and a single-child chain stays flat. When a filter hides intermediate entries, `recalculateVisualStructure` re-attaches descendants to the nearest **visible** ancestor and recomputes the indentation to match the unfiltered semantics, "so single-child chains don't drift right". `lastSelectedId` is only updated when the filtered list is non-empty, so switching through an empty result preserves the selection.
- Edge cases: typed search input rejects control characters, "so a stray escape sequence cannot become a filter"; Escape clears the search first and only cancels on the second press; a node is foldable only if it has visible children *and* is a root or a branch-point child.

### packages/coding-agent/src/modes/interactive/components/trust-selector.ts
- Purpose: the `/trust` picker — save a project trust decision.
- Non-obvious: the current saved decision is shown with its inheritance chain ("trusted (inherited from /other/path)"), and the selection is pre-positioned on the saved option.

### packages/coding-agent/src/modes/interactive/components/user-message-selector.ts
- Purpose: the `/fork` picker — pick a user message to fork the session from.
- Non-obvious: the list is chronological and defaults to the **most recent** message; each row is two lines (message + "Message N of M") so the user can see where they are in the history.
- Edge cases: an empty list auto-cancels after 100 ms rather than showing an empty picker.

### packages/coding-agent/src/modes/interactive/components/user-message.ts
- Purpose: renders a user message.
- Non-obvious: the markdown component pads and colours its own background — "a Box around it would keep a second full-width copy of every line, with identical output". Ordered-list markers and backslash escapes are preserved so a pasted snippet is not mangled.
- Note: also wrapped in OSC 133 shell-integration zone markers.

### packages/coding-agent/src/modes/interactive/components/visual-truncate.ts
- Purpose: the shared "collapse to N visual lines" primitive used by tool output and bash output.
- Non-obvious design decisions: it limits **visual** lines (after wrapping) rather than logical lines, "because a single long line (such as minified JSON) wraps across the whole screen". `VisualLinePreview` caches its result per width, "since it renders on every frame for every result in the transcript". The hint line goes *before* the kept tail and *after* the kept head, matching which end was preserved.

### packages/coding-agent/src/modes/interactive/external-editor.ts
- Purpose: hand the editor buffer to `$EDITOR` and read it back.
- Non-obvious: it uses async `spawn`, **not** `spawnSync`: "On Windows, synchronous child_process calls can keep Node/libuv's console input read active after the parent pauses stdin, racing vim/nvim for the console input buffer until Ctrl+C cancels the pending read." The temp directory is removed in a `finally` block.

### packages/coding-agent/src/modes/interactive/interactive-mode.ts
- Purpose: the TUI hub. Owns the component tree, subscribes to `AgentSessionEvent`, dispatches slash commands, drives the queueing model, and handles every lifecycle event (startup, reload, shutdown, crash).
- Key abstractions: `InteractiveMode` (the class) over `AgentSessionRuntime`; `ExtensionUIContext` (the extension-facing UI surface) and `commandContextActions` (the extension-facing session surface: `waitForIdle`, `newSession`, `fork`, `navigateTree`, `switchSession`, `reload`).
- Data flow: `session.subscribe` → `handleEvent` → per-event rendering (`agent_start`, `turn_start`, `queue_update`, `entry_appended`, `message_start/update/end`, `tool_execution_start/update/end`, `agent_end`, `agent_settled`, `compaction_start/end`, `auto_retry_start/end`, `summarization_retry_*`).
- Non-obvious design decisions (the important ones):
  - **The event loop is `while (true) { const userInput = await this.getUserInput(); await this.session.prompt(userInput); }`** (`:1254`) — the TUI never owns the turn; the session does.
  - **Queueing is two-dimensional and mode-specific** (`:3335`, `:4462`): while streaming, Enter queues a *steer* and Alt+Enter queues a *follow-up*; during compaction, submissions are held in a **separate local queue** (`compactionQueuedMessages`) because the session is busy.
  - **Two queues are presented as one** (`:4660` `getAllQueuedMessages`): the session's steering/follow-up queues plus the compaction queue, so the user sees one list.
  - **Nothing is lost on abort** (`:4711` `restoreQueuedMessagesToEditor`): every queued message is pulled back and merged into the editor text, *then* the session is aborted.
  - **Queued messages survive compaction** (`:4750` `flushCompactionQueue`): extension commands execute immediately, the first non-extension message starts a prompt with its original mode, the rest are re-queued, and a failure restores the entire queue (`restoreQueue`) rather than dropping it.
  - **The transcript is rebuilt, not patched, after compaction** (`:3420`): the chat container is cleared and re-rendered from `buildContextEntries()`, with the compaction summary inserted at its *chronological* position and an `entriesRenderedByBoundaryCompaction` set preventing a double render.
  - **Escape is temporarily re-bound** during compaction (`:3634`), retry (`:3703`) and branch summarisation (`:5611`) to abort that specific operation, and restored afterwards. The retry handler is restored on `agent_start`, not on the retry-success event, because "retry success event fires later, but we need main handler now" (`:3376`).
  - **Dialogs are a stack** (`:2693` `pushExtensionDialog` / `:2707` `showTopExtensionDialog`): a new dialog hides the visible one, closing it shows the previous one again, and "Every dialog stays answerable, so no dialog promise is left pending".
  - **The renderer can be swapped without rebuilding the tree** (`:892` `switchTuiMode`): the old renderer's children are moved to the new renderer, focus is preserved, and the main-screen render state is captured and restored.
  - **The TUI handle is a Proxy** (`tui-renderer.ts:53`) so components hold a stable reference while the renderer behind it is replaced.
  - **A crash names the likely culprit** (`:306` `formatCrashExtensionHint`): the stack is matched against the loaded extensions and the message says which extension "may be involved" and how to disable it.
  - **"The app was updated under you" is a first-class error** (`:2195` `maybeShowInstallChangeWarning`): after any error, the install is checked; if it changed, the user is told that code loaded on demand will fail until restart, and given the exact resume command.
  - **`/reload` restores the chat *before* `session_start` fires** (`:6403`), so an extension's `session_start` handler sees the transcript.
  - **Startup is incremental** (`:945`): the TUI starts and accepts text *before* the managed tools (`fd`, `rg`) finish downloading, with only interrupt/exit/submission-feedback enabled until then; a submit during startup is answered "Startup is still in progress" rather than being lost.
- Edge cases / failure handling: three-tier shutdown — graceful (`:4260`), signal-triggered (extension teardown runs **before** the terminal is touched, "Extension teardown such as removing sockets does not write to the tty, so it must not be skipped if a later terminal-restore write fails"), and `emergencyTerminalExit` (`:4301`) for EIO/EPIPE/ENOTCONN/ENOTTY, which exits 129 *without* restoring the terminal. `uncaughtCrash` (`:4321`) restores cooked mode and the cursor so the user does not need `stty sane`. A missing session cwd raises `MissingSessionCwdError`, which is caught and turned into a **prompt** offering a fallback cwd. A `models.json` parse error is surfaced as a startup error.
- Surprising: `showStatus` collapses consecutive status messages into one line by remembering the last spacer and text children; `getChangelogForDisplay` shows the changelog only for a *fresh* session and only for versions newer than the last seen one; install telemetry is sent only when a new version was actually detected, and is fire-and-forget with a 5 s timeout.

### packages/coding-agent/src/modes/interactive/model-catalog-refresh.ts
- Purpose: a coordinator that shares one in-flight model-catalog refresh per runtime.
- Key abstractions: `ModelCatalogRefreshCoordinator` with a `WeakMap<ModelCatalogRuntime, ActiveModelCatalogRefresh>`; each active refresh has its own controller and a waiter count.
- Non-obvious design decisions: concurrent callers *share* the network request, but each caller's cancellation is independent — `raceWithAbortSignal(active.promise, signal)` lets one caller walk away without cancelling the shared operation. The shared operation is aborted only when the **last** waiter leaves (`active.waiters === 0`).
- Why it matters: the interactive mode, the model picker and the scoped-model picker all refresh; without this they would triple-fetch.

### packages/coding-agent/src/modes/interactive/model-search.ts
- Purpose: the two search-text builders for the model pickers.
- Non-obvious: `getModelSearchText` puts the bare model id in the *leading* position, while `getModelSelectorSearchText` deliberately does not — "so exact provider-prefixed queries rank before proxy-provider IDs like openrouter/openai/gpt-5".

### packages/coding-agent/src/modes/interactive/program-status-reporter.ts
- Purpose: reports the agent's state to the terminal via OSC 7501 (`working` / `blocked` / `done` / `error` / `idle`).
- Non-obvious design decisions: the reported text is limited to the session name, dialog titles and the **first line** of errors — "prompts and assistant output are never reported." Blocked dialogs are held in a `Map` keyed by source, and the most recently opened one wins. The outcome is decided by the **latest** assistant message, "so a retried error is replaced by its successful retry". A failed recovery compaction ends the run as an error; an aborted one ends it as idle.
- Edge cases: `report()` compares the serialised status and skips the terminal write when nothing changed.

### packages/coding-agent/src/modes/interactive/session-share.ts
- Purpose: the `/share` flow — export the session and upload it to Radius or a GitHub gist.
- Key abstractions: `createShareTrailingEntries` appends a `pi.share` custom entry carrying the **system prompt and the tool schemas**, so a viewer can render the session exactly.
- Non-obvious: the destination is `settingsManager.getSessionShareDestination()` — `auto` prefers Radius when authenticated, otherwise a gist; an explicit `radius` refuses to fall back to a gist and tells the user to run `/login radius`.
- Edge cases: the gist path checks `gh auth status` first and reports a specific error for "not installed" versus "not logged in"; the HTML export is only produced for the gist path.

### packages/coding-agent/src/modes/interactive/theme/dark.json
- Purpose: the built-in dark theme.
- Note: 50 colour tokens in OKHSL plus a `vars` block of reusable colours; the `export` block carries the HTML-export background colours. Three tokens are omitted and fall back (`scrollbarTrack`→`muted`, `scrollbarThumb`→`text`, `searchMatchBg`→`selectedBg`).

### packages/coding-agent/src/modes/interactive/theme/light.json
- Purpose: the built-in light theme.
- Note: the same token set as `dark.json` with light-appearance values; keeping the two files structurally identical is what makes the "automatic light/dark" theme pair possible.

### packages/coding-agent/src/modes/interactive/theme/system-theme.ts
- Purpose: generates a complete theme from the terminal's own reported colours.
- Key abstractions: `FAMILIES` (a hue + saturation range + an ANSI palette slot per colour family), `TOKEN_FAMILIES` (which family each token belongs to), `LEVELS` (a polynomial target-lightness curve per contrast level, for dark and light), and `RULES` (which token must reach which level on which surface).
- Data flow: `generateSystemThemeColors` → detect the appearance → solve the tokens in dependency order (`SOLVE_ORDER`, every surface before the tokens drawn on it) → if some level cannot be reached (mid-gray background), **relax** by binary search on a relaxation parameter → finally enforce the WCAG floor on body text.
- Non-obvious design decisions: colours are built in OKHSL, whose saturation is relative to the sRGB gamut, so a palette colour never gains chroma when it moves to another lightness ("pastel palettes stay pastel"). `anchored()` caps the chroma at the source colour's, with the same falloff. Text keeps at least **4.5:1** contrast on every surface it is drawn on, even on a relaxed mid-gray background (`withTextContrast` moves it toward white/black by bisection). The terminal's own foreground is used for body text where it is clearly stronger than muted text.
- Edge cases: with no reported background at all, the theme falls back to ANSI palette indices and the terminal's default colours, and the neutral tokens are rendered faint (SGR 2) because "bright black, which some themes make nearly invisible". A `saturation: 0` multiplier renders the first frame in grayscale while the terminal's colours are still in flight.

### packages/coding-agent/src/modes/interactive/theme/theme-controller.ts
- Purpose: applies the theme setting and keeps it in sync with the terminal.
- Non-obvious design decisions: the terminal colour query has a **100 ms timeout with a late-reply callback**, so a terminal that answers after the timeout still gets its colours applied; the system theme renders in grayscale until then. `applyTerminalColors` merges the reported colours field by field with the previous ones (a timeout must not erase the palette) and re-renders only when something actually changed. `reapplyForTerminal` re-resolves the theme *pair* when the terminal's appearance changes, but leaves extension-set or previewed themes ("`<in-memory>`") alone.
- Edge cases: the controller is re-bound to the TUI when the renderer is swapped (`rebindTui`), so the colour-scheme listener survives a regular↔fullscreen switch.

### packages/coding-agent/src/modes/interactive/theme/theme-schema.ts
- Purpose: JSON-Schema validation for user-authored theme files.
- Non-obvious: the validator is kept **out of** `theme.ts` on purpose — "Validating user-authored theme files needs typebox, which costs ~17 MB of module graph to import. Palette lookup does not, so a presentation that only uses built-in themes should never pay for it." `main.ts` installs it; other consumers opt in via `setThemeJsonValidator()`. The error message names the *missing required colour tokens* explicitly and points at the built-in themes.

### packages/coding-agent/src/modes/interactive/theme/theme-tokens.ts
- Purpose: the token metadata — slot (foreground/background), description and optional fallback.
- Non-obvious: `defineThemeTokens` validates at module load that every fallback token exists and is in the **same colour slot**, so a theme can never fall back from a foreground token to a background one. The `ThemeColor` / `ThemeBg` types are *derived* from the slot field, so the TypeScript type and the runtime data cannot drift.

### packages/coding-agent/src/modes/interactive/theme/theme.ts
- Purpose: the theme class, the theme registry, the file watcher and the TUI theme helpers.
- Key abstractions: `Theme` (a resolved set of colours plus precomputed ANSI sequences); `theme` is a **Proxy over a `globalThis` slot** keyed by `Symbol.for("@earendil-works/pi-coding-agent:theme")`, so node and jiti (dev) module instances see the *same* theme instance.
- Non-obvious design decisions: `fg()`/`bg()` are hot-path calls, so the escape sequences are precomputed into maps at construction. A token set to `""` means "terminal default" and is filled from the terminal's reported foreground/background at read time; the resolved colour map is cached by the *identity* of the terminal colours object. Theme variables support nesting with **circular-reference detection** (`resolveVarRefs` throws on a cycle). A theme name may not contain `/` because that is reserved for the automatic light/dark pair.
- Edge cases: an invalid theme falls back to the system theme *silently* and the watcher is not started for it; the file watcher debounces by 100 ms, ignores stale timers after a theme switch, and **keeps the last good theme** if the file is temporarily missing (editors write in two steps).

### packages/coding-agent/src/modes/interactive/tui-renderer.ts
- Purpose: the composition root for the TUI — creates the renderer and a stable handle to it.
- Key abstractions: `createInteractiveTui` (overloaded to return `TuiAltScreen` or `TuiMainScreen` by mode) and `createInteractiveTuiReference`, a `Proxy` that re-resolves the underlying TUI on every property access and every method call, so components can hold one reference across a renderer swap.
- Non-obvious: the fullscreen renderer's `copySelection` returns the error *message* (not `false`) so the TUI can show it; the scroll-to-end indicator embeds the current keybinding, so it stays truthful when the keys are rebound.

### packages/coding-agent/src/modes/json-event.ts
- Purpose: converts internal `AgentSessionEvent`s into the wire shape used by the JSON and RPC protocols.
- Key abstractions: `JsonAgentSessionEvent` = the event union with `message_update` replaced by a version that carries only the delta.
- Non-obvious design decisions: cumulative assistant snapshots are removed from the wire — "`message_start` provides the initial message, deltas build it, and `message_end` provides the final authoritative message. Cumulative usage, tool-call ids, and tool names remain available because their size is constant." The `toolcall_start` event asserts its own invariant: it throws if the content at `contentIndex` is not a tool call.
- Edge cases: a `message_update` whose message is not an assistant message throws rather than being silently reshaped.

### packages/coding-agent/src/modes/print-mode.ts
- Purpose: the one-shot mode (`pi -p "prompt"`, `pi --mode json`).
- Key abstractions: `PrintModeOptions` (`mode: "text" | "json"`, `initialMessage`, `messages`, `initialImages`).
- Non-obvious design decisions: the `prompt` call is `void`ed and the authoritative answer is the **final assistant message**: in text mode only its text is printed, and the exit code encodes the outcome — `error` or `aborted` → 1, `length` → 1 with "Response was truncated: the model reached its output token limit." on stderr. In JSON mode the session header is written first, then one JSON line per event.
- Edge cases: SIGTERM/SIGHUP kill the tracked detached children and dispose the runtime; SIGHUP exits 129 and SIGTERM 143 (128 + signal). The stdout is flushed in the `finally` block.

### packages/coding-agent/src/modes/rpc/jsonl.ts
- Purpose: strict JSON-lines framing for the RPC protocol.
- Non-obvious design decisions: framing is **LF-only**, and the reader deliberately does **not** use Node's `readline`, "because readline splits on additional Unicode separators that are valid inside JSON strings and therefore does not implement strict JSONL framing" (U+2028 / U+2029). A trailing `\r` is trimmed for CRLF tolerance.
- Edge cases: a final line without a newline is still emitted on stream end.

### packages/coding-agent/src/modes/rpc/rpc-client.ts
- Purpose: a typed client that spawns the agent in RPC mode and exposes every command.
- Key abstractions: `pendingRequests: Map<id, {resolve, reject}>` with a 30 s per-request timeout; `onEvent` listeners.
- Non-obvious: the client rejects **all** pending requests when the child exits, errors or closes its stdin, and includes the collected stderr in the message so a failure is diagnosable. `handleLine` iterates a **snapshot** of the listener array "so listeners that unsubscribe during dispatch do not cause later listeners to miss this event". `prompt()` returns the **disposition** rather than waiting for the run, and the doc says: "If the disposition is 'handled', no run started for this prompt, so don't wait for agent_settled." `stop()` sends SIGTERM, waits 1 s, then SIGKILLs.

### packages/coding-agent/src/modes/rpc/rpc-mode.ts
- Purpose: the headless JSON-lines server.
- Key abstractions: `createDialogPromise` implements the extension-UI request/response protocol; `handleCommand` is one large switch over `RpcCommand`.
- Non-obvious design decisions: a `prompt` command does **not** respond immediately — it responds when the session's preflight succeeds, reporting the `disposition` ("Queued and immediately handled prompts also count as success"), and a preflight failure is reported as an error only if no success was already emitted. Extension dialogs resolve to their **default** on abort or timeout rather than rejecting, so a headless extension can never hang the agent. Every TUI-only method is an explicit no-op with a comment saying why ("Component factories are not supported in RPC mode - would need TUI access"). `setWidget` supports only string arrays.
- Edge cases: a JSON parse error is reported as a `parse` failure and does not kill the process; `process.stdin.on("end")` triggers a graceful shutdown; SIGTERM skips the stdout flush (the pipe is already gone) while other exits flush; the shutdown handler is checked on `agent_settled`.

### packages/coding-agent/src/modes/rpc/rpc-types.ts
- Purpose: the typed wire contract — `RpcCommand`, `RpcResponse`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`, `RpcSessionState`, `RpcSlashCommand`.
- Non-obvious: commands and responses are separate unions, so a handler returning the wrong shape is a type error; every response carries the `command` name as well as the `id`, so a multiplexed client can route by command as well as by id. The `get_commands` response merges three sources — extension commands, prompt templates and skills — each tagged with its `source`.

### packages/coding-agent/src/package-manager-cli.ts
- Purpose: the `install` / `remove` / `update` / `list` / `config` CLI.
- Key abstractions: `parsePackageCommand` returns a **structured** error (`invalidOption`, `missingOptionValue`, `conflictingOptions`, `invalidArgument`) rather than printing and exiting, so the caller decides the exit code and the wording; `UpdateTarget` is a discriminated union of `all | self | extensions | models`.
- Non-obvious design decisions: the managed self-update is staged — fetch `package.json` + `package-lock.json`, `npm ci --ignore-scripts --omit=dev`, **run the new binary's `--version` and compare it to the expected version**, rename the staging directory into `releases/<version>`, then flip `current-version` atomically (write to a temp file and `rename`). A `proper-lockfile` lock on `<root>/update` prevents two updates at once ("Another managed Pi update is already running."). Pruning keeps the active release *and* the one currently running, "which other open sessions likely still use and which allows rolling back by editing current-version".
- Edge cases: a managed install refuses `--force` ("rerun the installer to repair this installation"); `update` with no target updates pi only and prints "Extensions are skipped. Run `pi update --extensions` to update extensions."; on Windows, self-update is only supported for npm and pnpm installs; a failed npm update prints the exact command to run manually. The managed-install root is only recognised when the package directory is inside it *and* the marker file has the exact `kind`/`schemaVersion`/`layout` — "The launcher environment is inherited by child processes. Do not classify a source checkout or another Pi installation launched from managed Pi as managed."
- Surprising: `prepareWindowsNpmSelfUpdate` *quarantines* the loaded native addons (renames them aside, then copies them back) so npm can overwrite a locked `.node` file. Project-local writes are refused unless the project is trusted ("Project is not trusted. Use --approve to modify local package config.").

### packages/coding-agent/src/rpc-entry.ts
- Purpose: the shebang entry point that forces `--mode rpc`.
- Non-obvious: it also sets `process.title`, `PI_CODING_AGENT=true` and `AI_AGENT=pi` so child processes and telemetry can identify the harness, and silences `process.emitWarning` so Node warnings cannot corrupt the JSON-lines stdout.

### packages/coding-agent/src/utils/abort.ts
- Purpose: abort-aware promise helpers.
- Non-obvious: `raceWithAbortSignal` still *observes* the abandoned operation — "Stop waiting on abort while observing the abandoned operation through settlement" — it attaches a rejection handler so an aborted operation does not become an unhandled rejection, and it re-checks `signal.aborted` after wiring the listener to close the race window.

### packages/coding-agent/src/utils/ansi.ts
- Purpose: ANSI stripping and incomplete-escape handling for streamed output.
- Non-obvious design decisions: `splitIncompleteAnsiSuffix` holds back a trailing unfinished escape sequence (an OSC without its terminator, or a CSI without its final byte) so it can be prepended to the next chunk — otherwise a streamed escape sequence split across two renders corrupts the output. The held-back window is capped at 256 characters ("Longest unfinished sequence held back while streaming. Longer ones are processed as-is.").
- Edge cases: `stripAnsi` has a fast path for strings with no ESC/C1 introducer.

### packages/coding-agent/src/utils/changelog.ts
- Purpose: parses `CHANGELOG.md` into versioned entries and rewrites its links.
- Non-obvious: `normalizeChangelogLinks` rewrites `main`/`master` blob and tree links to the *tagged* URL, maps legacy `badlogic/pi-mono` and `earendil-works/pi-mono` URLs to the current repo, and refuses to touch absolute URLs, protocol-relative URLs or pure fragments. A `##` header whose version does not parse resets the current entry rather than attributing the text to the previous version.

### packages/coding-agent/src/utils/child-process.ts
- Purpose: cross-platform spawn wrappers and a safe wait.
- Non-obvious design decisions: `waitForChildProcess` re-arms a 100 ms idle timer on **every chunk** received after `exit`, because "A short-lived child can `exit` while a detached descendant keeps its stdout/stderr pipe open. We must not resolve and destroy the streams on a fixed deadline measured from `exit`, or output still being written past that deadline is silently lost (earendil-works/pi#5303)." The same timer also releases the wait when a quiet inherited handle never fires `close`. On Windows the spawn goes through `cross-spawn` so `.cmd` shims work.

### packages/coding-agent/src/utils/clipboard-command.ts
- Purpose: runs a clipboard helper with a timeout and a size cap.
- Non-obvious: the helper is spawned **detached** on POSIX and with no output pipe, because "Clipboard writers can daemonize… Detach on POSIX so the daemon leaves pi's process group and Ctrl+Z suspend (SIGTSTP to the group) does not stop the clipboard owner (#11179)." stdin errors are swallowed ("A writer may exit before consuming all input"). A 50 MB output cap aborts the command.

### packages/coding-agent/src/utils/clipboard-image.ts
- Purpose: reads an image from the system clipboard across platforms.
- Key abstractions: three outcomes — `undefined` = the backend failed, `null` = it has no image, an object = an image.
- Non-obvious: the distinction matters: "an empty Wayland clipboard must not fall through to stale X11 clipboard contents." On WSL, PowerShell is used to reach the Windows clipboard, because the Linux clipboard does not receive Windows screenshots (Win+Shift+S). A DIB-wrapped BMP is converted to PNG through Photon. The preferred mime type is chosen from the clipboard's own type list, preferring PNG/JPEG/WEBP/GIF in that order.

### packages/coding-agent/src/utils/clipboard.ts
- Purpose: text clipboard read/write across macOS, Windows, Linux (Wayland/X11), Termux and WSL.
- Non-obvious design decisions: OSC 52 is emitted for remote sessions (`SSH_CONNECTION`/`SSH_CLIENT`/`MOSH_CONNECTION`/`PI_CLIPBOARD_OSC52=1`) and for headless Linux with no display; a desktop session with a display *reports the failure* instead of silently using OSC 52, because "OSC 52 cannot be verified". The WSL path prefers OSC 52 in Windows Terminal and otherwise round-trips through PowerShell, reading the text from a **file** — "because `clip.exe` and PowerShell stdin decode piped bytes with the console code page, which mangles non-ASCII UTF-8." Native clipboard writes precede the command-line tools, because "Linux tools retain clipboard selection ownership after this call returns."
- Edge cases: a 100 KB OSC 52 payload limit produces a specific "text exceeds the OSC 52 size limit" error; each platform gets its own actionable error message ("install `xclip` or `xsel`, or check X11 access").

### packages/coding-agent/src/utils/deprecation.ts
- Purpose: emit a deprecation warning once per distinct message.
- Note: `clearDeprecationWarningsForTests` is exported for tests.

### packages/coding-agent/src/utils/exif-orientation.ts
- Purpose: reads the EXIF orientation tag from JPEG and WebP and applies it to a Photon image.
- Non-obvious: the TIFF/EXIF header is parsed by hand (both byte orders, the `0x0112` IFD entry) rather than by pulling in an EXIF library; WebP's `EXIF` chunk may carry an extra `"Exif\0\0"` prefix before the TIFF header, and RIFF chunks are padded to even sizes. Every bounds check returns orientation 1 (normal) rather than throwing.

### packages/coding-agent/src/utils/frontmatter.ts
- Purpose: YAML front-matter extraction.
- Non-obvious: the end of the front-matter block is found with `indexOf("\n---", 3)`; a document that does not start with `---`, or whose block is never closed, is returned whole with an empty front-matter object. The body is trimmed and CRLF is normalised.

### packages/coding-agent/src/utils/fs-watch.ts
- Purpose: `fs.watch` with an error handler and a close that cannot throw.
- Note: `FS_WATCH_RETRY_DELAY_MS = 5000` is exported for the caller's retry loop; a synchronous throw from `watch()` is converted into the same `onError` callback.

### packages/coding-agent/src/utils/git.ts
- Purpose: parse a git package source into host / path / ref.
- Key abstractions: `GitSource` with a `pinned` flag ("True if ref was specified (package won't be auto-updated)").
- Non-obvious: the safety check `hasUnsafeGitInstallPart` runs on **both** the raw value and its percent-decoded form, and rejects NUL, backslash, a leading slash, any `..` segment, and a slash in the host — so a crafted URL cannot escape the install directory. A bare `host/path` is only accepted for `git:`-prefixed sources and only when the host contains a dot. Without the `git:` prefix only explicit protocol URLs are accepted.

### packages/coding-agent/src/utils/highlight-js.d.ts
- Purpose: hand-written ambient declarations for the `highlight.js` deep imports.
- Non-obvious: it declares only the four functions pi uses, so the (large) upstream `highlight.js` types are never pulled into the build.

### packages/coding-agent/src/utils/html.ts
- Purpose: minimal HTML entity decoding for the highlighter's output.
- Non-obvious: `decodeHtmlEntityAt` refuses an entity longer than 16 characters, which bounds the work a pathological `&` can cause.

### packages/coding-agent/src/utils/image-convert.ts
- Purpose: converts arbitrary image bytes to PNG (Kitty's graphics protocol needs `f=100`).
- Non-obvious: `ensurePngTranscoder` registers Photon as pi-tui's transcoder **only** on Kitty-protocol terminals and only once; the `onRegistered` callback exists so callers can re-render images that were showing a text fallback. The photon module is loaded once and the promise is cached.

### packages/coding-agent/src/utils/image-process.ts
- Purpose: normalise and resize an image before it goes into the prompt.
- Non-obvious: the returned `hints` are *text* the model reads ("[Image converted from image/bmp to image/png.]"), and the dimension note tells it the coordinate mapping.

### packages/coding-agent/src/utils/image-resize-core.ts
- Purpose: the resize algorithm, shared by the worker and the in-process fallback.
- Non-obvious design decisions: a four-step strategy — resize to the dimension caps, try PNG *and* JPEG and take the smaller, drop the JPEG quality (80 → 85 → 70 → 55 → 40), and finally shrink the dimensions by 25 % per round until 1×1. The byte cap is 4.5 MB of base64 "to provide headroom below Anthropic's 5MB limit". The worker's replies carry a type tag because "Node can post its own messages on the worker channel (for example `{ "watch:require": [...] }` under `node --watch`)".
- Edge cases: if nothing fits, it returns `null` rather than shipping an over-budget image.

### packages/coding-agent/src/utils/image-resize-worker.ts
- Purpose: the worker-thread entry point for image resizing.
- Note: it validates the request shape before touching Photon and always replies with a tagged response (result or error).

### packages/coding-agent/src/utils/image-resize.ts
- Purpose: runs the resize in a worker thread so WASM decoding does not block the TUI event loop.
- Non-obvious: the bytes are **copied** before being transferred ("Transfer detaches the buffer, so transfer a worker-owned copy and leave the caller's bytes intact"); if the worker cannot be loaded the call falls back to in-process resizing so image reads still work; under Bun the worker is resolved by string path first because "Bun compiled executables resolve worker entrypoints by string path, not via `new URL(..., import.meta.url)`". `formatDimensionNote` emits the model's coordinate-mapping instruction.

### packages/coding-agent/src/utils/json.ts
- Purpose: strip `//` comments and trailing commas from JSON.
- Non-obvious: it does so with two alternation regexes that *match string literals first*, so a `//` inside a string is not treated as a comment.

### packages/coding-agent/src/utils/management-http.ts
- Purpose: a bounded, retrying fetch for *idempotent management* requests.
- Non-obvious design decisions: two distinct timeout layers — an overall budget (`timeoutMs`) that is **terminal**, and a per-attempt timeout (`attemptTimeoutMs`) that aborts only the current attempt so a hung connection can be retried. Caller cancellation and the overall timeout are never swallowed; only an attempt timeout is retried. Retryable statuses are 408/425/429/500/502/503/504 and the response body is cancelled before the retry.
- Why the restriction matters: the doc says it "must not be used for agent/model operations: those can fail after the HTTP request starts and are retried by their semantic caller instead."

### packages/coding-agent/src/utils/mime.ts
- Purpose: image mime sniffing from raw bytes.
- Non-obvious: it validates the *structure*, not just the signature — a PNG is checked for a valid IHDR chunk and for the absence of an `acTL` chunk (an animated PNG is rejected), and a BMP is checked for consistent declared size, pixel-data offset and DIB header size. The sniff reads only the first 4100 bytes.

### packages/coding-agent/src/utils/open-browser.ts
- Purpose: open a URL or file in the platform default handler.
- Non-obvious design decision: it **never invokes a shell** — "On Windows, do not use `cmd /c start`: cmd.exe re-parses metacharacters (&, |, ^, ...) before `start` runs, which would make attacker-controlled URLs injectable." It uses `rundll32 url.dll,FileProtocolHandler` instead. The launcher failure is swallowed because "callers still present the target to the user".

### packages/coding-agent/src/utils/output-files.ts
- Purpose: the single place where pi writes output files (truncated tool output, binary MCP resources, codemode images).
- Non-obvious: the files are created with mode `0o600` ("Output can carry private data, so only the user may read the files") and the `wx` flag, "which never follows a link someone else placed at the path". The location (currently the OS temp directory) can change in one place.

### packages/coding-agent/src/utils/paths.ts
- Purpose: path canonicalisation, normalisation and containment.
- Key abstractions: `PathInputOptions` (trim, expandTilde, homeDir, stripAtPrefix, normalizeUnicodeSpaces).
- Non-obvious: `getCwdRelativePath` returns `undefined` for anything outside the cwd, and that single predicate is reused for the managed-install check, the Windows quarantine and the config selector. `canonicalizePath` falls back to the raw path when the target does not exist, so callers never crash on a missing file. `getFileRevision` stamps a file with `dev:ino:size:mtimeNs:ctimeNs` using bigint stats, for nanosecond-resolution change detection. `normalizeWindowsShellPath` converts Git Bash / MSYS / Cygwin / WSL drive paths into a form native Windows APIs accept. `markPathIgnoredByCloudSync` sets the Dropbox / iCloud "ignore" xattr so cloud sync does not fight the agent over the data directory.

### packages/coding-agent/src/utils/photon.ts
- Purpose: a lazy, failure-tolerant wrapper around the Photon WASM image library.
- Non-obvious design decisions: photon-node's CJS entry does `fs.readFileSync(__dirname + '/photon_rs_bg.wasm')`, "which bakes the build machine's absolute path into Bun compiled binaries" — so `readFileSync` is **patched** for the duration of the import to redirect a missing WASM read to a fallback next to the executable, and restored afterwards. `loadPhoton` returns `null` on failure rather than throwing, so image features degrade instead of failing the app.

### packages/coding-agent/src/utils/pi-user-agent.ts
- Purpose: a one-line helper returning pi's `User-Agent` for its own network requests.
- Note: it delegates to `pi-ai`'s `formatUserAgent({ userAgent: "detailed", version })` so the agent's own calls are indistinguishable in format from the provider calls — one place to change, two consumers (the version check and the tool downloader).

### packages/coding-agent/src/utils/shell.ts
- Purpose: shell and PowerShell discovery, the shell environment, binary-output sanitisation and detached-child tracking.
- Non-obvious design decisions: the legacy WSL `bash.exe` is detected and given `-s` with **stdin transport** instead of `-c`, because that build interprets arguments differently. `shellPathExists` deliberately avoids `existsSync` on Windows, "since its extra stat check rejects runnable Store aliases (nodejs/node#36790)". `getShellEnv` prepends pi's own bin directory to `PATH` (finding the `Path` key case-insensitively on Windows). `sanitizeBinaryOutput` strips control characters *and* the U+FFF9–U+FFFB interlinear-annotation characters, "which crash string-width due to a bug"; the regex is written so surrogate pairs are never split.
- Edge cases: detached child PIDs are tracked so a parent SIGTERM/SIGHUP kills them; the process-group kill falls back to the single PID, and on Windows the trusted `System32\taskkill.exe` is used so cleanup does not depend on `PATH`.

### packages/coding-agent/src/utils/sleep.ts
- Purpose: an abort-aware `sleep(ms, signal?)`.
- Note: it rejects with `new Error("Aborted")` — and, unlike `utils/abort.ts`, it does *not* attach a rejection handler to the timeout it clears, so the abort listener is left on the signal after the sleep settles. Small, but a caller that reuses one signal across many sleeps accumulates listeners.

### packages/coding-agent/src/utils/syntax-highlight.ts
- Purpose: syntax highlighting with theme-coloured output.
- Non-obvious design decisions: 22 languages are registered eagerly; the rest are loaded lazily in a `setImmediate` *after* the first frame ("Eager languages and plaintext fallback remain available" if the load fails). `renderHighlightedHtml` parses highlight.js's HTML into a scope stack and applies the theme formatters itself, decoding entities with a length-capped decoder — so no highlight.js span markup ever reaches the terminal. The scope lookup falls back from `a.b` to `a` and from `a-b` to `a`.

### packages/coding-agent/src/utils/text.ts
- Purpose: BOM handling.
- Note: `splitBom` returns the BOM separately so a caller can preserve it; `stripBom` is the common case. Used by the theme loader, the changelog reader and the package manager.

### packages/coding-agent/src/utils/tool-result-images.ts
- Purpose: normalise image blocks that come back from *tools* (extensions, MCP bridges, screenshot tools) before they enter the session history.
- Non-obvious: `read` and `@file` attachments already run through `processImage`, but a tool that produces an image itself hands back arbitrary base64 "that go straight into session history and every subsequent provider request" — and "Oversized images make the provider reject the whole conversation, not just the offending turn, so normalize them once as they enter history." A conversion failure **keeps the original block** (deleting a tool's output silently would be worse). The original array is returned unchanged when nothing changed, so callers can skip the rewrite.

### packages/coding-agent/src/utils/tools-manager.ts
- Purpose: ensures the two managed helper binaries (`fd`, `rg`) are available, downloading them from GitHub releases when the system does not already have them.
- Key abstractions: `ToolConfig` (repo, binary name, alternative system command names, tag prefix, and a per-platform asset-name function); `getToolPath` (look in pi's own bin dir, then the system `PATH`); `ensureTool` (the public entry point, with a status callback).
- Data flow: `getToolPath` → if absent, `getLatestVersion` (resolve the tag from the release-page **redirect**, not the API) → `downloadTool` (download the asset, extract it, locate the binary, `rename` it into place, `chmod 0o755`) → return the path.
- Non-obvious design decisions: the version is resolved from `https://github.com/<repo>/releases/latest` with `redirect: "manual"` rather than `api.github.com`, because "The api.github.com releases endpoint counts against the anonymous API quota (60 requests/hour per IP), which is permanently exhausted behind shared egress IPs such as corporate proxies and CI runners. The web endpoint answers with a redirect to the tagged release at no quota cost and lives on the same origin as the binary download itself." The response body is explicitly cancelled so the connection can be reused. Extraction goes into a **unique** temp directory ("fd and rg downloads can run concurrently during startup, so sharing a fixed directory causes races"), and the binary is located by trying the two known layouts before falling back to a recursive search. `fd` on darwin/x64 is pinned to 10.3.0 because that release has no x64 asset.
- Edge cases: `PI_OFFLINE` skips the download entirely; on Android/Termux the user is told to `pkg install` instead, because "Linux binaries don't work due to Bionic libc incompatibility". Extraction has a **fallback chain** — on Windows `System32\tar.exe` (bsdtar, which handles zip) then `Expand-Archive` via PowerShell; on Unix `unzip` then `tar` — and the error message lists every attempt. The download failure message walks the `cause` chain up to depth 5, because "fetch failures surface as a bare 'fetch failed' TypeError with the actionable detail (DNS, TLS, timeout) hidden in the cause".
- Surprising: the *system* `fd` is preferred over the managed one if it is on `PATH` — and `fd`'s Debian package also installs `fdfind`, which is why `systemBinaryNames` is a list.

### packages/coding-agent/src/utils/version-check.ts
- Purpose: the "is there a newer pi?" check and its semver comparison.
- Non-obvious: `formatVersionCheckError` unwraps Node's generic "fetch failed" through `AggregateError` causes and surfaces the errno codes, which are otherwise hidden. `isNewerPackageVersion` falls back to a string comparison when either version is not valid semver, so a non-semver tag still triggers an update. `PI_OFFLINE` and `PI_SKIP_VERSION_CHECK` both short-circuit the check.

### packages/coding-agent/src/utils/windows-self-update.ts
- Purpose: work around Windows' inability to overwrite a loaded native addon.
- Non-obvious: it reads `process.report.getReport().sharedObjects` to find the `.node` files actually loaded from the package directory, then for each one **renames it into a quarantine directory and copies it back** — so the path still exists but the file is unlocked. The quarantine root is `<node_modules>/.pi-native-quarantine`, found by walking up to the nearest `node_modules`. The cleanup step tolerates a previous process still exiting.

### packages/coding-agent/src/utils/wsl.ts
- Purpose: detect WSL.
- Note: it checks `WSL_DISTRO_NAME`/`WSLENV` **and** greps `/proc/version` for "microsoft"/"wsl", so it works in a container where neither is set.

### packages/coding-agent/src/utils/zip.ts
- Purpose: writes the small classic ZIP archives used by bug reports, with no dependency.
- Non-obvious: the archive is assembled by hand (local file headers, central directory, end-of-central-directory) using `zlib.deflateRawSync` and `zlib.crc32`; the DOS date/time fields are derived from the current date with a 1980 floor.

---

## Ideas worth stealing

- **A prompt's response carries an explicit DISPOSITION, and the response is deferred until preflight succeeds** — `packages/coding-agent/src/modes/rpc/rpc-mode.ts:394-414` (and the client's doc at `packages/coding-agent/src/modes/rpc/rpc-client.ts:193-205`). The server starts the prompt, then answers *only* when the session's preflight has decided "handled" vs "queued"; a failure before that point is reported as an error, and a failure after it is suppressed because a success was already emitted (`preflightSucceeded`). The client then documents the follow-on rule: "If the disposition is 'handled', no run started for this prompt, so don't wait for agent_settled." **Why it transfers:** August's HTTP/WS harness has exactly the same ambiguity — a submitted prompt may start a turn, be queued behind a running turn, or be rejected. Returning a disposition instead of a bare 200 makes the client correct without the client guessing, and it is the only way to avoid the "accepted but nothing happened" bug class.

- **Two timeout layers with different terminality, and a written rule about which requests may be retried at the transport level** — `packages/coding-agent/src/utils/management-http.ts:24-25` and `:39-50`. "Caller cancellation and timeoutMs are terminal. attemptTimeoutMs aborts only the current attempt so a hung connection can be retried." The three signals are composed with `AbortSignal.any`, and the catch block distinguishes "the attempt timed out" from "the caller gave up" so only the former is retried. The header comment names the boundary explicitly: "It must not be used for agent/model operations: those can fail after the HTTP request starts and are retried by their semantic caller instead." **Why it transfers:** August's proxy has the same two clocks (per-request and per-turn) and the same trap (a 400 that is really a stale request being replayed). Naming the rule in the helper's docstring is what stops the next caller from getting it wrong.

- **The wire format drops cumulative snapshots but keeps the constant-size parts** — `packages/coding-agent/src/modes/json-event.ts:40-61`. "Remove cumulative assistant snapshots from streaming wire events. `message_start` provides the initial message, deltas build it, and `message_end` provides the final authoritative message. Cumulative usage, tool-call ids, and tool names remain available because their size is constant." **Why it transfers:** August's SSE stream currently re-sends the whole assistant message on every delta. This is the exact rule for making it a delta stream without losing the fields the UI needs on the first frame — and the *reason* (constant size) is what tells you which fields are safe to keep inline.

- **Queued messages are merged back into the editor on abort, and two separate queues are presented as one** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4660-4730` (`getAllQueuedMessages` + `restoreQueuedMessagesToEditor`). The session's steering/follow-up queues and the local compaction queue are two different data structures but one user-visible list; on abort, every queued message is pulled back out and merged into the editor text *before* the session is aborted. **Why it transfers:** August's Bot-to-Bot and unattended paths already have a queue; this is the "nothing the user typed is ever silently dropped" property, and it is only four lines once the two queues are merged at the display boundary rather than at the storage boundary.

- **A queued message survives an operation that interrupts it, and a failure restores the whole queue** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:4750-4827` (`flushCompactionQueue`). After a compaction, the queued messages are replayed: extension commands execute immediately, the first non-extension message starts a prompt with its original steer/follow-up mode, and the rest are re-queued. If the replay throws, `restoreQueue` puts the entire batch back rather than dropping the remainder. **Why it transfers:** August has the same situation whenever a turn is interrupted by a context relief or a reconnect. The "replay, don't drop" rule with a full restore on failure is what keeps a queued instruction from vanishing.

- **Dialogs are a STACK, and the invariant is that no dialog promise is left pending** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2687-2715` (`pushExtensionDialog` / `showTopExtensionDialog`) and the comment at `:2690`: "Dialogs form a stack: a new dialog hides the visible one, and closing the visible dialog shows the previous one again. Every dialog stays answerable, so no dialog promise is left pending, and dialogs opened from inside another dialog (for example a confirm from a custom component) work." The same discipline appears in the RPC path, where an extension dialog resolves to its *default* on abort or timeout rather than rejecting (`packages/coding-agent/src/modes/rpc/rpc-mode.ts:91-131`). **Why it transfers:** August's approval prompts and interactive questions have exactly the same nesting and cancellation problem. Naming the invariant ("no dialog promise is left pending") is what makes it checkable, and the "resolve to a default, never reject" rule is what keeps a headless run from hanging.

- **A three-tier shutdown that distinguishes "the terminal died" from "the program should stop"** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:296-304` (`DEAD_TERMINAL_ERROR_CODES`), `:4260` (graceful), `:4301` (`emergencyTerminalExit`) and `:4321` (`uncaughtCrash`). A dead terminal (EIO/EPIPE/ENOTCONN/ENOTTY) exits 129 *without* attempting a restore, because the restore write would fail again; a signal-triggered shutdown disposes the runtime **before** touching the terminal, because "Extension teardown such as removing sockets does not write to the tty, so it must not be skipped if a later terminal-restore write fails"; and an uncaught exception restores cooked mode and the cursor so the user does not need `stty sane`. **Why it transfers:** August's Tauri app has the same class of failure (a detached console, a revoked pipe). Encoding "the terminal is gone" as a distinguishable error code and giving it its own exit path is what stops a crash from leaving the user's shell in raw mode.

- **A crash names the extension that probably caused it** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:306-321` (`formatCrashExtensionHint`) with the matching in `core/crash-log.ts`. The stack is matched against the loaded extensions and the message says which extension "may be involved" and how to disable it ("Try disabling it with `pi config`, or run `pi -ne` to confirm"). **Why it transfers:** August's plugin system has the same failure mode, and August's own AGENTS.md records a whole class of bugs where an extension-side defect was invisible. A crash that names the suspect converts an unbounded debugging session into a one-line check.

- **A crash report asks about the transcript SEPARATELY from a model-written summary, and names exactly what is in each** — `packages/coding-agent/src/modes/interactive/bug-report.ts:107-147` (`promptForOptions`). Choosing "no transcript" offers to attach a model-written summary instead, with the warning "The transcript is sent to `<provider>` with your credentials and tokens. Only the generated summary is attached; the transcript stays on your machine." **Why it transfers:** August's crash/telemetry path has the same privacy decision, and separating "the data" from "a description of the data" is a strictly better default than an all-or-nothing consent dialog.

- **A shared refresh coordinator: one network request, independent per-caller cancellation, abort only when the last waiter leaves** — `packages/coding-agent/src/modes/interactive/model-catalog-refresh.ts:13-51`. A `WeakMap` keyed by the runtime holds the single in-flight refresh; each caller races its own signal against the shared promise, and `active.controller.abort()` fires only when `waiters === 0`. **Why it transfers:** August refreshes provider catalogs and model lists from several places. This is a small, self-contained pattern that removes N× network load without letting one caller's cancellation kill another's request.

- **The "the app was updated under you" failure mode is a first-class diagnostic** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:2190-2210` (`maybeShowInstallChangeWarning`). After *any* error, the install is checked for a change; if it changed, the user is told that "Features that load code on demand can fail until restart" and is given the exact resume command (`formatResumeCommand`, `:341-354`). The check is attached to the error path, not to a startup path, because the failure only appears mid-session. **Why it transfers:** August ships a bundled backend and an in-place update, so a long-running session can straddle an update. Without this, the symptom is "missing module" errors with no explanation.

- **A cache key derived from an argument, not a timer, with the derivation stated** — `packages/coding-agent/src/modes/interactive/components/footer.ts:97-118` (`getSessionStats`). "Usage totals and context usage scan the whole session, and the footer renders on every frame. Entries are append-only and every append moves the leaf, so the results only change with the session, leaf, entry count, or the model whose context window applies." The cache is keyed on exactly that tuple. **Why it transfers:** August's footer/readout panels also recompute a whole-session aggregate on every frame. The transferable part is the *reasoning*: write down why the value can only change at these moments, and the invalidation rule falls out of it.

- **A tool renderer that throws falls back to a generic rendering instead of blanking the row** — `packages/coding-agent/src/modes/interactive/components/tool-execution.ts:287-302` and `:312-330`. Both the `renderCall` and `renderResult` calls are wrapped, and a failure substitutes `formatToolCallWithArgs` / the text output. The same pattern appears for extension *message* and *entry* renderers (`components/custom-message.ts:69-85`, `components/custom-entry.ts:52-59`, where the failure produces a visible `[<type>] renderer failed: <message>` box). **Why it transfers:** This is the direct fix for August's own `check:sse` lesson — "a dispatcher that calls `handlers.onX?.(...)` when nothing supplies `onX` — the optional call is a no-op, so the frame validates, reaches the handler and vanishes." A renderer that throws and takes the whole row with it is the same bug in the TUI.

- **The tool render context distinguishes "arguments still streaming" from "arguments complete"** — `packages/coding-agent/src/modes/interactive/components/tool-execution.ts:120-140` (`getRenderContext`) and the call site `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3545-3548`. The context carries `executionStarted`, `argsComplete`, `isPartial`, `expanded`, `isError` and `durationMs`; `setArgsComplete()` is called at `message_end` with the comment "Args are now complete - trigger diff computation for edit tools". **Why it transfers:** August's edit-tool diff and its Edit-gate need the *final* arguments, not the last streamed fragment. Making "the args are final" an explicit event on the render context is how the renderer knows the difference without re-deriving it.

- **Strict LF-only JSONL framing that deliberately does not use `readline`** — `packages/coding-agent/src/modes/rpc/jsonl.ts:14-21` and `:29-66`. "Framing is LF-only. Payload strings may contain other Unicode separators such as U+2028 and U+2029. Clients must split records on `\n` only." and "This intentionally does not use Node readline. Readline splits on additional Unicode separators that are valid inside JSON strings and therefore does not implement strict JSONL framing." **Why it transfers:** August's own SSE/JSONL surfaces carry model output, which can contain U+2028. Using the platform's convenience line reader is a latent framing bug.

- **A protocol message is TAGGED because the runtime posts its own messages on the same channel** — `packages/coding-agent/src/utils/image-resize-core.ts:21-29` and `packages/coding-agent/src/utils/image-resize.ts:50-56`. "Node can post its own messages on the worker channel (for example `{ "watch:require": [...] }` under `node --watch`), so replies must be identifiable." **Why it transfers:** Any worker/port/queue protocol August builds should carry a discriminant on every message, and the reason should be written down so nobody "simplifies" it away.

- **Buffer ownership is explicit when transferring to a worker** — `packages/coding-agent/src/utils/image-resize.ts:12-16` (`toTransferableBytes`): "Transfer detaches the buffer, so transfer a worker-owned copy and leave the caller's bytes intact." **Why it transfers:** August's image handling and any zero-copy path has the same trap: a `postMessage(..., [buf])` silently detaches the sender's buffer, and the failure appears far from the cause.

- **A shared-process-safe path write: mode 0600 and the `wx` flag** — `packages/coding-agent/src/utils/output-files.ts:14-28`. "Output can carry private data, so only the user may read the files" and `flag: "wx"` — "`wx` never follows a link someone else placed at the path." **Why it transfers:** August writes tool output, MCP resources and images to disk. The `wx` flag is the difference between "write a file" and "write a file an attacker pre-created as a symlink".

- **A writer that streams to a terminal must not resolve on a fixed deadline after exit** — `packages/coding-agent/src/utils/child-process.ts:38-48` and `:88-96`. "A short-lived child can `exit` while a detached descendant keeps its stdout/stderr pipe open. We must not resolve and destroy the streams on a fixed deadline measured from `exit`, or output still being written past that deadline is silently lost (earendil-works/pi#5303)." The 100 ms grace timer is re-armed on every chunk, so an actively writing descendant keeps the reader alive while a quiet inherited handle still releases it. **Why it transfers:** August's shell tool has the same shape, and the failure mode is silent output loss, not an error.

- **A "system theme" generated from the host's own colours, with contrast as a solved constraint** — `packages/coding-agent/src/modes/interactive/theme/system-theme.ts:1-19` (the design note) and `:464-587` (`generateSystemThemeColors`). Every token belongs to a colour family; lightness comes from a per-contrast-level target curve; the tokens are solved in dependency order (every surface before the tokens drawn on it); when a mid-gray background cannot satisfy every level, a **binary search on a relaxation parameter** finds the least relaxation that fits; and body text is finally moved toward white/black until it reaches **4.5:1 on every surface it is drawn on**. The chroma is capped at the source colour's so a palette colour never gains chroma when it moves to another lightness. **Why it transfers:** August's desktop app must live inside a host application that owns the palette. Rather than shipping a fixed dark theme, deriving one from the host's colours *and proving* the contrast floor is a directly portable design.

- **The theme singleton is shared through `globalThis` with a `Symbol.for` key, and the module loader is part of the reason** — `packages/coding-agent/src/modes/interactive/theme/theme.ts:646-664`. "Use globalThis to share theme across module loaders (node + jiti in dev mode)." The old symbol key is also written, for compatibility. **Why it transfers:** August's Tauri app loads the backend and the frontend separately and hot-reloads in dev; any process-wide singleton that both halves must agree on has to be anchored somewhere that survives two module graphs.

- **A theme validator kept out of the hot path because it costs 17 MB** — `packages/coding-agent/src/modes/interactive/theme/theme-schema.ts:1-9`. "Validating user-authored theme files needs typebox, which costs ~17 MB of module graph to import. Palette lookup does not, so a presentation that only uses built-in themes should never pay for it." The validator is installed by `main.ts` and opt-in elsewhere. **Why it transfers:** August's `check:brain-config` gate asks the backend which keys it accepts; the same "validate only the thing that came from a user" discipline applies to any config file a user can hand-edit.

- **Token fallbacks are validated at module load and must stay in the same colour SLOT** — `packages/coding-agent/src/modes/interactive/theme/theme-tokens.ts:9-21` (`defineThemeTokens`) with the slot-typed `ThemeColor`/`ThemeBg` unions derived from the data. A theme can never fall back from a foreground token to a background one, and the TypeScript type and the runtime table cannot drift. **Why it transfers:** Any August config surface with token-style fallbacks (thinking-level colours, tool-state colours) gets the same guarantee for free by deriving the types from the table.

- **A file watcher that keeps the last good value while the file is being rewritten** — `packages/coding-agent/src/modes/interactive/theme/theme.ts:757-787` (`scheduleReload`). The reload is debounced by 100 ms, stale timers are ignored after a theme switch, and "Keep the last successfully loaded theme active if the file is temporarily missing" — because editors write in two steps. **Why it transfers:** August hot-reloads its own config and extensions; without this rule the UI blanks for a frame every time the user saves.

- **A file watcher is re-bound when the renderer is swapped** — `packages/coding-agent/src/modes/interactive/theme/theme-controller.ts:93-97` (`rebindTui`) and the call site `packages/coding-agent/src/modes/interactive/interactive-mode.ts:933-934`. The theme controller holds a subscription to the terminal's colour-scheme notifications, and that subscription is torn down and re-created when the TUI object behind the stable Proxy changes. **Why it transfers:** Any component that subscribes to a renderer event must be re-bound when the renderer is replaced — the "stable handle" is not enough on its own.

- **A terminal query with a short timeout AND a late-reply callback** — `packages/coding-agent/src/modes/interactive/theme/theme-controller.ts:20-40` (`requestTerminalColors`) and `:197-211` (`applyTerminalColors`). The query times out after 100 ms (so a terminal that answers nothing does not stall startup) but a late reply is still applied through `onLateReply`; the reported colours are merged field by field with the previous ones so a timeout does not erase the palette, and a re-render happens only when something actually changed. **Why it transfers:** Any "ask the host for information" step in August's startup path should have both a short timeout and a late-arrival path, and should not re-render the whole UI for a no-op.

- **One "is this path inside that root" predicate, reused everywhere** — `packages/coding-agent/src/utils/paths.ts:109-118` (`getCwdRelativePath`) and its uses at `packages/coding-agent/src/package-manager-cli.ts:63` and `packages/coding-agent/src/utils/windows-self-update.ts:41`. The predicate returns `undefined` for anything outside the root, and it is the single answer to "may I touch this path". **Why it transfers:** August's AGENTS.md already insists on a single listing door (`sandbox.paths.listable_root` / `listable_entry`) and a single path-containment rule; this is the same idea applied to "is inside the managed install root" and "is inside the package directory".

- **A git URL is validated on both the raw and the percent-decoded form** — `packages/coding-agent/src/utils/git.ts:76-102` (`hasUnsafeGitInstallPart`). NUL, a backslash, a leading slash, any `..` segment and a slash in the host are rejected — and the check runs on the decoded value too, so a double-encoded `..` cannot survive. **Why it transfers:** August's extension/package sources are user- and model-supplied strings; a single decode-then-check would be enough for most, but checking *both* forms is the belt-and-braces version that also catches the double-encoding trick.

- **A search grammar with a graceful fallback instead of an error** — `packages/coding-agent/src/modes/interactive/components/session-selector-search.ts:39-114` (`parseSearchQuery`). `re:<pattern>` is regex, a quoted segment is an exact phrase, bare words are fuzzy, and an **unclosed quote falls back to plain whitespace tokenisation** rather than erroring — so a half-typed search still filters. A regex that fails to compile renders *no* results instead of crashing. **Why it transfers:** August's session and file search should support the same grammar, and "malformed input degrades to a simpler parse" is the rule that keeps the UI responsive while the user types.

- **The filter must not change the shape of what remains** — `packages/coding-agent/src/modes/interactive/components/tree-selector.ts:437-560` (`recalculateVisualStructure`). When a filter hides intermediate entries, descendants re-attach to the nearest **visible** ancestor and the indentation is recomputed to match the unfiltered semantics, "so single-child chains don't drift right". The selection is preserved by id, and `lastSelectedId` is only updated when the filtered list is non-empty, "This preserves the selection when switching through empty filter results". **Why it transfers:** August's transcript tree and any filtered list need this: filtering should narrow the set, not re-interpret the hierarchy.

- **Shortest-unique-suffix labelling, decided globally** — `packages/coding-agent/src/modes/interactive/components/interactive-mode.ts:1526-1581` (`getCompactNonPackageExtensionLabel` + `getCompactExtensionLabels`). For each path the algorithm tries the last 1 segment, then 2, then 3, and uses the first suffix that is unique among *all* the paths; the uniqueness is computed for the whole set at once, not per item. **Why it transfers:** August's tool and extension lists are long and their names repeat; this produces short labels that are still unambiguous.

- **A relative path that preserves the `node_modules` topology** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1437-1472` (`getShortPath`). When a path is under the same `node_modules` root as the package's base directory, the relative path is taken from the *shared root*, not from the package, "so two packages with the same internal path stay distinguishable". **Why it transfers:** August's extension and skill lists have the same collision problem, and the fix is to pick the right base for the relative path rather than to disambiguate later.

- **An error is a first-class thing with a cause, and the cause is unwrapped for the user** — `packages/coding-agent/src/utils/version-check.ts:14-32` (`formatVersionCheckError`). Node's generic "fetch failed" hides the errno, so the error is unwrapped through `AggregateError` causes and the codes are surfaced. And `packages/coding-agent/src/utils/abort.ts:14-47` (`raceWithAbortSignal`) attaches a handler to the *abandoned* operation so an abort does not become an unhandled rejection, and re-checks `signal.aborted` after wiring the listener to close the race window. **Why it transfers:** August's `classify_error` taxonomy is exactly this concern; the abort helper in particular is the fix for "the aborted request's rejection shows up as an unhandled error".

- **A status indicator reports the session name, a dialog title and the first line of an error — never the prompt and never the assistant's output** — `packages/coding-agent/src/modes/interactive/program-status-reporter.ts:11-16`. "Messages are limited to the session name, dialog titles, and the first line of errors; prompts and assistant output are never reported." The outcome is decided by the **latest** assistant message, "so a retried error is replaced by its successful retry". **Why it transfers:** August's tab-bar / window-title status should have the same content limit, and the same "latest message wins" rule for a retried turn.

- **The renderer can be swapped and the component tree is never rebuilt** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:892-943` (`switchTuiMode`) and `packages/coding-agent/src/modes/interactive/tui-renderer.ts:52-80` (`createInteractiveTuiReference`). The old renderer's children are moved to the new one, the focus target is preserved, the main-screen render state is captured and restored, and components hold a `Proxy` that re-resolves the underlying TUI on every call. **Why it transfers:** August's desktop app has both a "normal window" and a "fullscreen/immersive" presentation of the same conversation; this is the mechanism that makes them one component tree.

- **`/reload` restores the transcript BEFORE `session_start` fires** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:6403-6491` (`handleReloadCommand`). The chat is rebuilt inside a `beforeSessionStart` callback, so "an extension's session_start handler sees the transcript" — and the chat is restored again afterwards if the callback did not run. **Why it transfers:** August reloads extensions and skills at runtime; the ordering rule ("the model sees the restored state before any extension hook runs") is easy to get wrong and hard to notice.

- **Startup accepts input before it is ready, and says so** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:993-997` and `:3151-3154`. The editor is wired for clear/exit/submission-feedback immediately, the full key handlers are enabled only after the managed tools (`fd`, `rg`) finish downloading ("so slow downloads do not make startup appear frozen"), and a submission during startup is answered "Startup is still in progress" rather than being swallowed. **Why it transfers:** August's desktop app also has a slow first launch (backend spawn, provider discovery). Accepting the user's first keystroke early and answering honestly beats a frozen window.

- **The changelog is shown only for a fresh session, and only for versions newer than the last one seen** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:1330-1359` (`getChangelogForDisplay`). A resumed session shows nothing; a fresh install records the version, sends the (opt-in) telemetry ping and shows no changelog at all. **Why it transfers:** August's update notice should not fire in the middle of an existing conversation.

- **A version check is short-circuited by two different environment switches, and the comparison degrades gracefully** — `packages/coding-agent/src/utils/version-check.ts:43-49` and `:97-108`. `PI_OFFLINE` disables the check outright; `PI_SKIP_VERSION_CHECK` disables the notification; and `isNewerPackageVersion` falls back to a string comparison when either version is not valid semver, so a non-semver tag still triggers an update. **Why it transfers:** August already has `PI_OFFLINE`-style switches; the "degrade the comparison rather than skip the update" fallback is the part worth copying.

- **The image resize strategy is explicit, staged, and refuses to ship an over-budget image** — `packages/coding-agent/src/utils/image-resize-core.ts:56-68` and `:118-164`. Resize to the dimension caps; try PNG *and* JPEG and take the smaller; drop the JPEG quality (80 → 85 → 70 → 55 → 40); finally shrink the dimensions by 25 % per round until 1×1. The cap is 4.5 MB of base64, "below Anthropic's 5MB limit". If nothing fits, it returns `null` — and `packages/coding-agent/src/utils/tool-result-images.ts:46-52` then keeps the *original* block rather than dropping a tool's output. **Why it transfers:** August attaches images too, and the "refuse rather than ship something the provider will reject" rule is the important half; the provider rejects the whole conversation, not just the offending turn.

- **Stripping ANSI from STREAMED text holds back an unfinished escape sequence** — `packages/coding-agent/src/utils/ansi.ts:42-66` (`splitIncompleteAnsiSuffix`) with the 256-character cap. A colour code split across two chunks would otherwise leave visible garbage in the transcript. **Why it transfers:** August streams bash output and tool output into the UI; the same split happens there.

- **A pasted image goes through a temp file, and the temp file is written with a random name** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3128-3139`. The clipboard image is written to `os.tmpdir()` as `pi-clipboard-<uuid>.<ext>` and its *path* is inserted into the editor, so the user can see and edit what will be sent. **Why it transfers:** August's image attachment path should show the user the artifact rather than an invisible blob.

- **A clipboard failure names the exact missing tool** — `packages/coding-agent/src/utils/clipboard.ts:136-149`. "Clipboard unavailable: install `xclip` or `xsel`, or check X11 access" / "install `wl-clipboard` (`wl-copy`) or check Wayland access" / "install the Termux:API app and `termux-api` package". **Why it transfers:** Small, but it is the difference between an error and an action. August's clipboard-adjacent failures ("could not read the file", "the image backend is unavailable") should name the fix.

- **A launcher is never given a shell** — `packages/coding-agent/src/utils/open-browser.ts:6-23`. "This intentionally never invokes a shell. On Windows, do not use `cmd /c start`: cmd.exe re-parses metacharacters (&, |, ^, ...) before `start` runs, which would make attacker-controlled URLs injectable." **Why it transfers:** August opens URLs and files from model- and user-supplied strings. This is the concrete form of the rule August's own AGENTS.md states in the abstract.

- **Resolve a "latest version" from a redirect, not from a rate-limited API** — `packages/coding-agent/src/utils/tools-manager.ts:105-139` (`getLatestVersion`). "The api.github.com releases endpoint counts against the anonymous API quota (60 requests/hour per IP), which is permanently exhausted behind shared egress IPs such as corporate proxies and CI runners. The web endpoint answers with a redirect to the tagged release at no quota cost and lives on the same origin as the binary download itself." The response body is explicitly cancelled so the connection can be reused, and the redirect target is validated to actually be a `/releases/tag/` URL before the tag is read off it. **Why it transfers:** August does exactly this kind of "is there a newer version / model / provider" check, and behind a shared egress IP an API-based check is a coin flip.

- **Every extraction attempt is tried, and the failure message lists all of them** — `packages/coding-agent/src/utils/tools-manager.ts:220-256` (`extractZipArchive`). On Windows: `System32\tar.exe` (bsdtar, which handles zip) then PowerShell `Expand-Archive`; on Unix: `unzip` then `tar`. Each attempt's stderr is captured, and the thrown error joins them with "; ". **Why it transfers:** August's own install/update path runs on machines with wildly different tooling; a single-command extractor with no fallback is a support ticket. Note also the comment explaining *why* System32's tar is preferred over Git Bash's GNU tar.

- **A download failure reports the cause chain, not the wrapper** — `packages/coding-agent/src/utils/tools-manager.ts:382-400`. "fetch failures surface as a bare 'fetch failed' TypeError with the actionable detail (DNS, TLS, timeout) hidden in the cause", so the `cause` chain is walked to depth 5 (capped "to guard against circular cause chains") and the distinct messages are joined. **Why it transfers:** August's `classify_error` taxonomy is the same concern; this is the transport-side version, and the depth cap is the detail worth copying.

- **A concurrent download extracts into a unique directory** — `packages/coding-agent/src/utils/tools-manager.ts:287-293`. "fd and rg downloads can run concurrently during startup, so sharing a fixed directory causes races." The directory name carries the pid, a timestamp and a random suffix. **Why it transfers:** August's asset pipeline has the same concurrency, and the race (two workers extracting into one temp dir) is exactly the kind of bug that only appears on a fast machine.

- **A managed binary is preferred over a system one only when the system one is missing, and the system one is found by running it** — `packages/coding-agent/src/utils/tools-manager.ts:73-103` (`commandExists`, `getToolPath`). The check is `spawnSync(cmd, ["--version"])` and "Check for ENOENT error (command not found)" — i.e. it asks the OS, rather than globbing `PATH` and guessing. `fd`'s Debian package also installs `fdfind`, hence the list of alternative system command names. **Why it transfers:** August's sandbox resolves tools the same way; the "ask the OS" approach is robust to PATH quirks, aliases and Windows shims.

- **A markdown transformer that throws is skipped, not fatal** — `packages/coding-agent/src/modes/interactive/components/markdown-transform.ts:12-29`. "Keep the current Markdown and continue with the next transformer." The same rule appears for extension *message*, *entry* and *tool* renderers (see the tool-renderer idea above). **Why it transfers:** August's `check:sse` gate exists because a handler that is invoked but produces nothing is invisible. The runtime counterpart is a renderer that throws and takes the row with it.

- **A markdown diagram is substituted only if it fits, and its rows are encoded as code spans with a fence longer than any backtick in the content** — `packages/coding-agent/src/modes/interactive/components/mermaid.ts:18-36` and `:71-87`. "If `art.width > context.availableWidth` return token.raw" — the original block is kept rather than a truncated diagram. Blank rows use a non-breaking space, "because an empty code span has no visible height". **Why it transfers:** August renders model-produced diagrams and tables; the "do not substitute something that does not fit" rule is what keeps the transcript honest.

- **The transcript is rebuilt from the session entries after a compaction, and the summary is inserted at its chronological position, not at the top** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3420-3443`. The chat container is cleared, `buildContextEntries()` is rendered, and the compaction summary is spliced in where it belongs; an `entriesRenderedByBoundaryCompaction` set prevents a double render. The same rebuild happens on `compaction_end` (`:3664-3686`), where the code *throws* if the completed compaction is missing from the session context. **Why it transfers:** August's compaction card and transcript ordering have the same two problems — a stale transcript and a summary in the wrong place. The "rebuild from the source of truth" approach fixes both at once.

- **A compaction that was aborted is distinguished from one that failed, and the retry is a separate event** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3649-3699` and `:3729-3758`. `compaction_end` carries `aborted`, `result` and `errorMessage` separately; the summarization retry has its own `summarization_retry_scheduled` / `_attempt_start` / `_finished` events, and the branch-summary variant gets a different indicator from a context compaction. **Why it transfers:** August's compaction has the same three outcomes and the same need to distinguish "the user cancelled" from "it broke" from "it is retrying".

- **A tool call's arguments are marked complete at `message_end`, and that is when a diff is computed** — `packages/coding-agent/src/modes/interactive/interactive-mode.ts:3545-3548` and `packages/coding-agent/src/modes/interactive/components/tool-execution.ts:181-185`. **Why it transfers:** see the render-context idea above; this is the trigger half.

---

## Files skipped (with reasons)

- `packages/coding-agent/src/modes/interactive/assets/clankolas.png` — a 539,053-byte PNG binary (verified: `89 50 4E 47 0D 0A 1A 0A` signature, `IEND` trailer), loaded and base64-encoded by `components/earendil-announcement.ts` for the "pi has joined Earendil" banner. It is image data, not source, so there is nothing to read line by line; its only contract is the file name and the `image/png` mime type, both of which are visible at the call site.

No other file in this shard was skipped. `easter-egg-3d.ts` (1,292 lines) was **partially** read — lines 1–350 and 860–979 in full, the middle skimmed — and is flagged in its per-file note and in *Uncertainties* below.

---

## Uncertainties

- **The manifest was renumbered while I worked, and the shard id I was given no longer exists in it.** At the start, `C:/Dev/augustHarness/docs/research/pi/manifest.tsv` had owner-shard values like `coding-agent-src#2`; partway through my run the file was rewritten and the same paths now carry ids `packages-coding-agent-10`, `packages-coding-agent-11` and `packages-coding-agent-12` (and `packages/coding-agent/src/modes/interactive/assets/clankolas.png` was reclassified to the `-` bucket, alongside the other binaries). I re-derived my file set from the current manifest: the 111 files I was assigned are exactly the `src/modes/**` + `src/utils/**` + `package-manager-cli.ts` + `rpc-entry.ts` rows that now sit under ids 10/11/12, plus `clankolas.png`. **This ledger uses that 111-file set.** If the lead re-splits ids 10/11/12 differently, the rows file still carries one line per file with an explicit path, so it can be re-cut on path alone.
- **One file was initially invisible to me**: `packages/coding-agent/src/utils/tools-manager.ts` was in my original 111 but fell inside a truncated region of my first listing query, so I did not open it until late. I have now read it in full and its note is included; I have re-verified that every one of the 111 paths in this ledger was opened.
- **`packages/coding-agent/src/modes/interactive/components/easter-egg-3d.ts` was not read end to end.** I read lines 1–350 (the model construction, the sliding-puzzle shuffle, the timing constants, the SGR/braille helpers and the start of the screen parser) and lines 860–979 (the `EasterEgg3dAnimation` class, its exit animation and the render loop). I did not read the `BlockRaster` ray-caster, the starfield generator, the dust/halo rasteriser or the pose maths (roughly lines 350–860 and 980–1292). The high-level mechanism is verified from the header comment and the code I did read; the exact rendering internals are not. This is a 1,292-line animation with no bearing on the harness's agent loop, so I did not spend the budget on it.
- **The shard's own description of the agent loop, tool execution, session storage and compaction is second-hand.** Those live in `core/`, which is not in this shard. Everything I wrote about the turn lifecycle, the tool registry, the compaction algorithm and the provider layer is inferred from what this shard *consumes* — the `AgentSessionEvent` union, the `AgentSession` API surface (`prompt`, `steer`, `followUp`, `abort`, `compact`, `navigateTree`, `clearQueue`, `getContextUsage`), the `ToolRenderers` contract and the `ExtensionUIContext` surface. I did not open those files.
- **`config-selector.ts` and `settings-selector.ts` are declarative surfaces.** Their *content* (which settings exist, which resource patterns are written) I read in full; the *effect* of writing `+pattern` / `-pattern` entries lives in `core/settings-manager.ts` and `core/package-manager.ts`, which I did not open. My description of the three-state project override is based on this file's own logic, not on the resolver that consumes it.
- **The `theme/` system was read in full, but the colour maths in `system-theme.ts` was verified by reading, not by running.** The target-lightness curves, the relaxation binary search and the WCAG floor are implemented as described; I have not observed the generated colours.
- **`interactive-mode.ts` is 7,082 lines and I read all of it**, but the shard also contains four other large files I read in full yet whose *runtime* behaviour I could not exercise (`tree-selector.ts` 1,428 lines, `session-selector.ts` 1,045 lines, `config-selector.ts` 951 lines, `settings-selector.ts` 1,009 lines). The notes for those describe the code as written; I did not check them against a running terminal.
- **I did not read anything outside this shard.** In particular, `core/agent-session.ts` (the event union and the queue semantics this UI consumes), `core/agent-session-runtime.ts`, `core/extensions/types.ts` and `core/session-manager.ts` are referenced constantly from this shard and would sharpen several notes, but they belong to other shards.

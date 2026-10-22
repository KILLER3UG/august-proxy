# pi / tui

## Shard shape

This shard is the whole `packages/tui` package of the `pi` repo (125 files: 119 text files, ~1.5 MB, plus 6 compiled native prebuilds totalling 179 KB): a **framework-agnostic terminal UI library** (`@earendil-works/pi-tui`, v1.4.0) that has no knowledge of agents, models, tools or sessions. It is a rendering substrate, not a harness. The package splits into four layers:

1. **Renderer core** — `src/tui.ts` holds the abstract `TuiBase` (overlay stack, focus, render scheduling, terminal-reply routing, cursor-marker protocol) plus the shared `Component`/`Container`/`TUI` interfaces and the line-compositing primitives. Two concrete renderers extend it: `src/tui-main-screen.ts` (renders into the main buffer, preserves scrollback, does *differential* line-by-line updates) and `src/tui-alt-screen.ts` (fixed-height viewport in the alternate buffer, application-owned scrolling, mouse selection, transcript search, Kitty image placement).
2. **Layout & components** — `src/layout.ts` + `src/layout-node.ts` build a *tree* of layout boxes with clip rects and a per-(component,width) render cache; `src/components/*` are the widgets (Editor, Input, Markdown, SelectList, SettingsList, ScrollView, VStack/HStack, Loader, Image, …). `src/stack.ts` implements the flex-like grow/shrink allocator.
3. **Terminal plumbing** — `src/terminal.ts` (raw mode, bracketed paste, Kitty-keyboard negotiation), `src/keys.ts` (key-id parsing/matching across legacy, CSI-u, modifyOtherKeys), `src/stdin-buffer.ts` (re-assembly of chunked escape sequences), `src/terminal-image.ts` (Kitty/iTerm2 graphics + capability detection), `src/terminal-colors.ts` (OSC 10/11/4 palette queries), `src/utils.ts` (ANSI-aware width/wrap/slice — the single source of truth for cell arithmetic).
4. **Native helpers** — `native/{napi.h,clipboard.h}` plus per-platform C/ObjC sources for clipboard and modifier-key state, loaded at runtime via `dlsym`/`GetProcAddress` so there is no link-time dependency on Node.

The test directory (57 files) is unusually disciplined: an **xterm-headless virtual terminal** (`test/virtual-terminal.ts`) is the substrate for renderer tests, assertions are made against the *emulator's cell attributes* rather than emitted strings, there are dedicated benchmark scripts that measure render churn, and nearly every bug fix in the 1300-line CHANGELOG has a named regression test.

**Scope caveat up front:** the lenses the brief lists (agent loop, tool definition/execution, steering/queued messages, session storage/branching/compaction, context management, provider/model abstraction, extension/plugin/skill mechanisms, system-prompt philosophy) have **no counterpart in this package**. There is no agent loop, no tool registry, no session store, no provider client and no prompt assembly anywhere under `packages/tui`. The lenses that do apply here — UI/TUI rendering and streaming, config (keybindings), error/abort handling (terminal restore, bounded writes, native-helper timeouts) and testing approach — are covered in depth below.

## Per-file notes

### packages/tui/CHANGELOG.md
- Purpose: 1302-line release history for the TUI package; the single best index of which rendering bugs the maintainers considered worth fixing.
- Key abstractions: version sections with Added/Changed/Fixed, each entry linking a GitHub issue/PR.
- Data flow: n/a (doc).
- Non-obvious design decisions: 1.2.0 records that `Editor.render()`/`Input.render()` now wrap the drawn cursor in **zero-width APC markers** instead of emitting `\x1b[7m` — the renderer resolves them, and code rendering outside a TUI must strip them. 1.2.0 also records that `showHardwareCursor` now shows *only* the terminal cursor, because terminals that extend edge cell colors into window padding stretched the drawn cursor.
- Edge cases / failure handling: 1.4.0 fixed terminal modes (mouse tracking, focus reporting, Kitty keyboard, bracketed paste, alt screen) staying enabled when the process exits without `stop()` — an `exit` handler now restores them synchronously.
- Surprising: 0.79.0 changed the Kitty keyboard-protocol fallback from timeout-driven to **response-driven**; 0.78.1 fixed a "tab width accounting" bug that let tab-containing output exceed the terminal width.

### packages/tui/README.md
- Purpose: 949-line public API tour of the package.
- Key abstractions: `TUI` interface (component management, focus, overlays, input, lifecycle, terminal queries, rendering) with two concrete renderers; theme interfaces; component list.
- Data flow: `new ProcessTerminal()` → `new TuiMainScreen(terminal)` → `addChild` → `setFocus` → `start()` → `requestRender()`.
- Non-obvious design decisions: `TuiAltScreen` "when stopped, restores the main buffer and prints the complete final document" — the alt screen is a *transient* view over a persistent document, not a terminal mode the user lives in.
- Edge cases / failure handling: documents that in raw mode Ctrl+C does not send SIGINT, so the app must intercept it via `addInputListener` + `matchesKey(data,'ctrl+c')`.
- Surprising: `PI_TUI_WRITE_LOG` captures the raw ANSI stream to stdout — a debug hook for the whole renderer.

### packages/tui/package.json
- Purpose: package manifest for `@earendil-works/pi-tui` v1.4.0.
- Key abstractions: `main: dist/index.js`, `type: module`, `engines.node >= 22.19`.
- Data flow: `npm test` = `node --test --test-reporter=dot test/*.test.ts` (Node's own test runner, no test framework dependency).
- Non-obvious design decisions: runtime deps are deliberately tiny — `get-east-asian-width`, `marked`, `marked-cjk-friendly`; everything else (colors, layout, ANSI) is hand-written. `@xterm/headless` and `chalk` are **dev** deps only, so the published package has no test-time baggage.
- Edge cases / failure handling: `files[]` ships `native/napi.h`, `native/clipboard.h`, the win32 C sources and the build script so a consumer can rebuild a prebuild.
- Surprising: `marked` is re-exported from the package index (`export { Marked, type Token, ... } from "marked"`) so downstream packages can extend the same Markdown parser the TUI uses.

### packages/tui/tsconfig.build.json
- Purpose: build config; extends the monorepo base, `rootDir: ./src`, `outDir: ./dist`, includes only `src/**/*`.
- Key abstractions: none beyond TS compiler options.
- Data flow: `npm run build` = `tsc -p tsconfig.build.json`.
- Non-obvious design decisions: `test/**` is excluded from the build, so the test tree is never published.
- Edge cases / failure handling: n/a.
- Surprising: the file is 9 lines — the whole package's build contract is "compile src, nothing else".

### packages/tui/src/index.ts
- Purpose: the package's public surface (195 lines of explicit re-exports).
- Key abstractions: groups colors, components, key handling, keybindings, layout-free utilities, terminal interface, terminal image, and the two renderers.
- Data flow: consumers import from `@earendil-works/pi-tui`; `marked` is re-exported so consumers share the TUI's Markdown tokenizer.
- Non-obvious design decisions: `TUI`, `ViewportTUI`, `OverlayHandle`, `TuiMouseEvent*` and `SizeValue` are exported as *types* while `Container`, `CURSOR_MARKER`, `compositeTuiLine`, `renderFakeCursor` are exported as *values* — the value exports are the ones a custom renderer needs.
- Edge cases / failure handling: `isViewportTUI` is exported so a caller can detect the alt-screen renderer by its `VIEWPORT_TUI` symbol rather than by `instanceof`.
- Surprising: `export { visibleWidth }` appears twice in the file's history — `utils.ts` re-exports it, and `tui.ts` re-exports it again (line 209), so the width function is reachable from two module paths.

### packages/tui/src/tui.ts
- Purpose: the core of the framework — `Component`, `Container`, `Focusable`, the `TUI` interface, the overlay stack, the mouse-dispatch protocol, and the abstract `TuiBase`.
- Key abstractions: `Component` (`render(width)`, optional `handleInput`, optional `handleMouse`, optional `wantsKeyRelease`, `invalidate()`); `Focusable` (a `focused: boolean` flag); `OverlayHandle` (hide/setHidden/focus/unfocus/isFocused/getBounds); `TuiBase` (render scheduling, focus, overlays, terminal-reply consumption, overlay layout resolution, cursor extraction).
- Data flow: `start()` → `terminal.start(onInput, onResize)` → `handleTerminalInput(data)` → consume terminal replies → run `inputListeners` (each may consume or rewrite the data) → dispatch to the focused component → `requestImmediateRender()`. Render path: `requestRender()` → nextTick → `scheduleRender()` (16 ms throttle) → `doRender()` (subclass) → `resolveFakeCursors` → `compositeOverlays` → `extractCursorPosition` → `applyLineResets`.
- Non-obvious design decisions: (a) **The cursor position is a protocol, not a coordinate.** A focused component emits the zero-width APC `CURSOR_MARKER` (`\x1b_pi:c\x07`) at the cursor; the renderer finds it, computes the visual column from the text *before* it, strips it, and positions the hardware cursor there. The fake cursor is a second pair of markers (`FAKE_CURSOR_START/END`) that the renderer turns into reverse video — `packages/tui/src/tui.ts:196-207`. (b) **The overlay focus restore is an explicit state machine** (`packages/tui/src/tui.ts:343-353`, `:625-724`): `inactive` / `eligible` / `blocked{blockedBy, resume}`, so an overlay that had focus gets it back unless something deliberately took it, and the "resume" carries either the overlay or an explicit target. (c) **Keyboard input preempts the render throttle**: `packages/tui/src/tui.ts:1153-1155` — "Keyboard input is latency-sensitive. Avoid the throttled timer path, where even setTimeout(0) can take a full 16 ms tick on Windows." (d) A container that forwards a mouse event to a child keeps focus itself rather than focusing the child, because the child may be detached (a closed submenu) — `packages/tui/src/tui.ts:84-90`.
- Edge cases / failure handling: `packages/tui/src/tui.ts:578-585` installs a `process.on("exit")` handler that calls `terminal.restoreOnExit?.(prefix, suffix)` so a direct `process.exit()` still restores terminal modes; the comment states the limit plainly ("Hard kills and native aborts run no JavaScript and cannot be covered"). Terminal colour queries resolve on a DA1 sentinel reply, and a query that times out keeps collecting late replies through `onLateReply` (`:1512-1542`). The cell-size reply (`CSI 6;h;w t`) is consumed without blocking unrelated input (`:1217-1235`).
- Surprising: `compositeOverlays` deliberately does **not** use `maxLinesRendered` when padding the screen to terminal height — `packages/tui/src/tui.ts:1421-1424` says the "historical high-water mark caused self-reinforcing inflation that pushed content into scrollback on terminal widen".

### packages/tui/src/tui-main-screen.ts
- Purpose: renderer that draws into the terminal's main buffer, preserving scrollback, and updates only the lines that changed.
- Key abstractions: `BoundedTerminalWriter` (1 MiB chunked writer); `TuiMainScreenRenderState` (capture/restore of the renderer's previous-frame memory); `TuiMainScreen`.
- Data flow: `doRender()` renders all components → resolves fake cursors → composites overlays → extracts the cursor → applies per-line resets → either a **full redraw** (`\x1b[2J\x1b[H\x1b[3J` + every line) or a **differential update** (move to the first changed line, rewrite to the last changed line) → position the hardware cursor.
- Non-obvious design decisions: (a) `BoundedTerminalWriter` (`packages/tui/src/tui-main-screen.ts:18-74`) streams output in 1 MiB chunks and **backs off a split that would land between a surrogate pair**, because a single render string larger than V8's max string length throws. (b) Every frame is wrapped in CSI 2026 synchronized output (`:281`, `:303`) so the terminal presents the frame atomically and does not flicker. (c) Kitty images are *reserved rows*: an image line occupies N physical rows, and the changed-range computation is expanded to cover the whole reserved block (`expandChangedRangeForKittyImages`, `:210-231`) so a partial redraw cannot erase half an image. (d) A height change normally forces a full redraw, **except under Termux** (`:345-352`) where the software keyboard toggling height would replay the entire history on every toggle.
- Edge cases / failure handling: `clearOnShrink` is off by default so an empty row is not cleared on shrink (fewer redraws on slow terminals) — `:604-615`. When content shrinks so far that the deleted lines move the viewport up, it escalates to a full redraw (`:409-412`). `beforeTerminalStop` writes a trailing newline so the shell prompt starts on a fresh line unless `preserveScreen` was requested (`:168-176`).
- Surprising: the redraw path is logged to `pi-tui-debug.log` when `PI_TUI_DEBUG_REDRAW=1`, with the *reason* for each full redraw ("terminal width changed (80 -> 100)") — the renderer explains itself.

### packages/tui/src/tui-alt-screen.ts
- Purpose: renderer for a fixed-height viewport in the terminal's alternate buffer, with application-owned scrolling, mouse selection, transcript search and Kitty image placement.
- Key abstractions: `TuiAltScreen`; `LayoutFrame` (from `layout.ts`); `SelectionPoint`/`SelectionRange`/`SelectionGranularity` (character/word/line); `ClickTarget` (double/triple click detection); `CachedKittyImage` (transmission/decoded byte accounting for offscreen image cache eviction).
- Data flow: `doRender()` (`packages/tui/src/tui-alt-screen.ts:1690-1796`) → `renderLayoutFrame(root, width, height)` → resolve fake cursors → apply search highlights → composite the "scroll to end" indicator → composite overlays → slice to viewport height → apply selection → composite flashes → extract cursor → apply line resets → write rows that changed → position the cursor.
- Non-obvious design decisions: (a) **Double-click word selection keeps paths and kebab-case tokens whole** — `TERMINAL_WORD_SELECTION_JOINERS = new Set(["/", "-"])` (`:83-85`) mirrors what a terminal emulator's own selection would do, because fullscreen mode owns the mouse. (b) The wheel is *accelerated by velocity* (`WheelScrollAccelerator`, `wheel-scroll.ts`), and Alt+wheel multiplies by 5 (`:719-721`). (c) A wheel event that no component handles scrolls the transcript rather than reaching the focused overlay as raw input — CHANGELOG 1.2.0 records this as the fix for "focused fullscreen overlays blocking mouse-wheel scrolling of the transcript"; the overlay must implement `handleMouse` to scroll with the wheel. (d) Offscreen Kitty images are cached with a byte budget (`MAX_CACHED_OFFSCREEN_KITTY_TRANSMISSION_BYTES = 32 MiB`, decoded 64 MiB, 16 entries) — `:78-80`.
- Edge cases / failure handling: `shouldDeferViewportInputToOverlay()` (`:680-682`) routes viewport keys to a non-focused overlay. The exit path restores the main buffer and prints the complete final document. WezTerm is special-cased (`:1720-1733`, `:1756-1781`): it erases intersecting Kitty image cells when a later row write touches a covered row, so images are drawn *last* in a separate pass.
- Surprising: the alt screen's own mouse-selection implementation competes with the terminal emulator's, and the code comments say so explicitly ("Regular mode delegates double-click selection to the terminal emulator. Fullscreen owns mouse selection").

### packages/tui/src/terminal.ts
- Purpose: the `Terminal` interface and `ProcessTerminal` — raw mode, resize, bracketed paste, Kitty-keyboard negotiation, program status, progress.
- Key abstractions: `interface Terminal` (`start`, `stop`, `restoreOnExit?`, `drainInput`, `write`, `moveBy`, cursor, `clearLine`, `clearScreen`, `setTitle`, `setProgress`, `setProgramStatus`); `ProcessTerminal`; `parseKeyboardProtocolNegotiationSequence`.
- Data flow: `start()` enables raw mode, writes `\x1b[?2004h` (bracketed paste), installs a resize handler, refreshes dimensions, enables Windows VT input, then `queryAndEnableKittyProtocol()`. Stdin bytes go through `StdinBuffer.process()`, which emits one complete sequence at a time, each of which is checked against (a) the program-status reply, (b) the keyboard-protocol negotiation grammar, then forwarded to the TUI.
- Non-obvious design decisions: (a) **The keyboard-protocol handshake is response-driven, not timeout-driven.** The query is `CSI > 7 u` (request flags) + `CSI ? u` (query) + a trailing `CSI c` (DA1). The comment at `:279-293` explains that *every* terminal answers DA1, so the DA reply is a sentinel that ends the negotiation with no startup timeout; the OSC 7501 program-status query rides on the same sentinel. (b) A split Kitty response is buffered and flushed after 150 ms as *input* rather than misparsed (`:339-388`, `KEYBOARD_PROTOCOL_RESPONSE_FRAGMENT_TIMEOUT_MS`). (c) `refreshTerminalDimensions()` sends SIGWINCH to self to re-read dimensions after suspend/resume, and swallows EACCES because restricted seccomp/LSM environments refuse `kill(2)` (`:48-60`).
- Edge cases / failure handling: `drainInput(maxMs, idleMs)` drains stdin before exit so Kitty key-release events do not leak to the parent shell over slow SSH. `restoreOnExit(before, after)` is a synchronous last-resort restore. `normalizeNativeShiftEnterInput` rewrites a bare Return into `CSI 13;2 u` when a *native* modifier probe says Shift is held — needed on Apple Terminal and Windows, which send plain Return for Shift+Enter.
- Surprising: `isAppleTerminalSession()` and the Windows equivalent are the only reason the package links a native addon at all — modifier key state cannot be read from a terminal protocol.

### packages/tui/src/keys.ts
- Purpose: key identifiers, parsing and matching across legacy, CSI-u (Kitty) and xterm modifyOtherKeys.
- Key abstractions: `KeyId` (a *type-level* union of every legal key id, built by a recursive `ModifiedKeyId` mapped type, `:144-152`); `Key` (an object of typed constants, `:163`); `KeyEventType` (`press | repeat | release`); `matchesKey(data, keyId)`; `parseKey(data)`.
- Data flow: raw bytes → `parseKittySequence` (CSI-u with alternate keys, arrows, function keys, Home/End) or the legacy/modifyOtherKeys paths → a `{codepoint, modifier, eventType}` → comparison against the key id.
- Non-obvious design decisions: (a) **The base-layout fallback is deliberately narrow** — `packages/tui/src/keys.ts:700-717` only consults the Kitty "base layout key" when the reported codepoint is *not* a recognized Latin letter or known symbol, so Ctrl+С (Cyrillic) matches Ctrl+c but Dvorak/Colemak/xremap remaps do not produce false matches (Ctrl+K must not match Ctrl+V). (b) **Logical shifted-symbol matching** (`:686-696`): Kitty reports "+" as Shift plus the physical "=" key, so a binding naming the produced symbol consumes that implicit Shift while preserving Ctrl/Alt/Super; the physical `shift+=` spelling still matches. (c) Raw `0x08` is ambiguous; it is only treated as Ctrl+Backspace under a Windows-Terminal heuristic (`:748-760`).
- Edge cases / failure handling: `isKeyRelease` filters release events unless a component sets `wantsKeyRelease`. `rawCtrlChar` uses the universal `code & 0x1f` formula and maps `-` to the same control char as `_` (same physical US key).
- Surprising: the *type system* is the first line of defence against typos in key ids — `KeyId` enumerates every legal letter/digit/symbol/special key and every modifier combination, so `matchesKey(data, "ctrl+shft+a")` will not compile.

### packages/tui/src/keybindings.ts
- Purpose: the global, user-overridable keybinding registry.
- Key abstractions: `interface Keybindings` (a declaration-merging point: downstream packages add their own ids, `:7-59`); `TUI_KEYBINDINGS` (defaults + human descriptions, `:71`+); `KeybindingsManager` (`:231`); `KeybindingConflict`.
- Data flow: `getKeybindings()` lazily builds a singleton `KeybindingsManager(TUI_KEYBINDINGS)`; a host calls `setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, userBindings))`; components ask `kb.matches(data, "tui.editor.cursorUp")`.
- Non-obvious design decisions: **a user rebinding never evicts a default belonging to another action.** `rebuild()` (`:243-268`) computes conflicts only among *user* claims, so rebinding `tui.input.submit` leaves `tui.select.confirm` on Enter. The rationale is pinned by `test/keybindings.test.ts:49-80`: "does not evict selector confirm when input submit is rebound" and "still reports direct user binding conflicts without evicting defaults".
- Edge cases / failure handling: unknown ids in a user config are ignored (`if (!(keybinding in this.definitions)) continue;`, `:249`).
- Surprising: several actions are deliberately **unbound by default** — `tui.editor.historyPrevious`/`historyNext` and the half-page/line alt-screen nav keys default to `[]`, so a host must opt in rather than inherit a surprising binding.

### packages/tui/src/utils.ts
- Purpose: the single source of truth for cell arithmetic on ANSI-bearing strings.
- Key abstractions: `visibleWidth`, `wrapTextWithAnsi`, `truncateToWidth`, `sliceByColumn`, `sliceWithWidth`, `extractSegments`, `stripTerminalSequences`, `normalizeTerminalOutput`, `extractAnsiCode`, `AnsiCodeTracker`, `getGraphemeCellRange`, `getOsc8LinkAtColumn`, `flattenLines`, plus the CJK-aware `autocompleteSeparatorRegex`/`autocompleteBoundaryRegex`.
- Data flow: a styled string → `AnsiCodeTracker` (which SGR attributes are active) → grapheme segmentation via `Intl.Segmenter` → per-grapheme width via `get-east-asian-width` → wrap/slice/truncate.
- Non-obvious design decisions: (a) **`flattenLines` is a memory trick, documented as such** (`:891-898`): V8 keeps a concatenation-built string as a tree of its parts, and a cached line kept that way retains several times its own size; `Number(line)` reads the string whole, which flattens it in place. (b) `getLineEndReset()` closes *only* underline (`\x1b[24m`), not a full reset, so a wrapped line's background colour survives; the OSC 8 hyperlink is closed and re-opened on the next line (`:753-768`). (c) The OSC 8 terminator is preserved verbatim, because some terminals only make BEL-terminated links clickable — the comment at `:560-563` names OAuth login URLs as the motivating case.
- Edge cases / failure handling: an unterminated escape sequence is treated as zero-width (the `visible-width` test asserts `visibleWidth("\x1b[31") === 3`); a partial regional-indicator grapheme is measured as **width 2** so a streamed "🇨" before "🇨🇳" cannot make the differential renderer drift; tabs count as three columns.
- Surprising: `cjkBreakRegex` and `cjkPunctuationRegex` are exported and reused by the *editor* and *autocomplete* — the CJK knowledge lives in the width module, not in the widget.

### packages/tui/src/layout.ts
- Purpose: builds a layout **tree** with clip rectangles for the alt-screen renderer, and provides hit-testing helpers.
- Key abstractions: `LayoutBox` (`rect`, `clip`, `children`, `lines`, `lineOffset`, `scrollView`, `scrollContentLines`, `layer`); `LayoutFrame` (`root`, `width`, `height`, `lines`, `primaryScrollView`); `ScrollbarGeometry`; `LayoutContext` (viewport, render cache, requestRender).
- Data flow: `renderLayoutFrame(root, width, height)` → for each component, `getLayoutNode(component)` (the `LAYOUT_NODE` symbol method) → a stack/scroll node is laid out recursively, everything else is measured by rendering it; the resulting lines are sliced to each box's clip.
- Non-obvious design decisions: the render cache is keyed by **(component, width)** — `renderCached` (`:68-81`) — so a re-layout at the same width reuses the exact same string array and the cache check is an identity comparison, not a string compare. Clip rects are intersected down the tree (`updateClips`, `:101-104`), so a child that overflows its parent is clipped, not spilled.
- Edge cases / failure handling: `getScrollViewsAt` (`:439-449`) returns the *deepest* scroll view under a point, sorted by depth, which is what makes wheel scrolling pick the innermost scroller.
- Surprising: the layout tree is separate from the component tree — a component opts into layout by implementing `[LAYOUT_NODE]()`, and everything else is measured by rendering. That is what lets `ScrollView` and `VStack` coexist with plain `Text` children in the same tree.

### packages/tui/src/layout-node.ts
- Purpose: the opt-in protocol between a component and the layout engine.
- Key abstractions: `LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node")` (a **global** symbol, so a component from another copy of the package still works); `StackLayoutNode`; `ScrollLayoutNode`; `ScrollLayoutState`.
- Data flow: `getLayoutNode(component)` (`:48-51`) probes for the symbol method and calls it; the node then describes size/visibility rules to the engine.
- Non-obvious design decisions: `Symbol.for` rather than `Symbol()` — the layout protocol survives duplicate installs of the package in a dependency tree.
- Edge cases / failure handling: `visible?: (viewport) => boolean` on a stack entry lets a child disappear based on the viewport, and `visibleStackEntries` filters before allocation so a hidden child consumes no space.
- Surprising: the node is the *only* channel; the engine never inspects a component's internals, which is why `Box`, `Text` and `Markdown` need no layout code at all.

### packages/tui/src/components/stack.ts
- Purpose: the flex-like size allocator shared by `VStack` and `HStack`.
- Key abstractions: `StackEntryOptions` (`basis`, `grow`, `shrink`, `minSize`, `maxSize`, `visible`); `allocateStackSizes`; `distribute`.
- Data flow: intrinsic sizes (measured by rendering the child) → `clampSize` against min/max → compare the sum against the available space minus gaps → `distribute` the difference.
- Non-obvious design decisions: **growth and shrinkage are weighted differently.** Growth is weighted by the `grow` factor (`:113-119`); shrinkage is weighted by `shrink * max(1, size)` — a *larger* item gives up more (`:114`). Each distribution step is at least 1 unit, and the loop stops when no candidate can absorb more, so it terminates.
- Edge cases / failure handling: `normalizeSize` floors and clamps, and `maxSize` defaults to `Number.MAX_SAFE_INTEGER`.
- Surprising: `basis: "auto"` means "use the intrinsic size", and `basis: 0` means "start at zero and grow" — the bench files rely on exactly that (`basis: 0, grow: 1` for the transcript, `basis: "auto"` for the dock).

### packages/tui/src/components/v-stack.ts
- Purpose: vertical stack container.
- Key abstractions: `VStack extends Stack` with `layoutType: "vstack"`.
- Data flow: render each visible child at the viewport width → allocate heights → emit gap lines → pad each child to its allocated size.
- Non-obvious design decisions: the VStack's own `render()` passes `availableSize: undefined` to the allocator (`:14-19`), so the *layout engine* is what constrains the stack; the component's standalone render is unbounded. The two paths therefore cannot disagree about sizes.
- Edge cases / failure handling: a child that renders fewer lines than its allocated size is padded with empty lines, so the stack's total height is stable across frames.
- Surprising: `v-stack.ts` is 33 lines — the real algorithm is in `stack.ts`.

### packages/tui/src/components/h-stack.ts
- Purpose: horizontal stack container.
- Key abstractions: `HStack extends Stack` with `layoutType: "hstack"`.
- Data flow: measure each child's intrinsic *width* (the widest rendered line) → allocate widths → re-render each child at its allocated width → composite rows with `compositeTuiLine`.
- Non-obvious design decisions: `align` (`stretch | start | center | end`) is implemented by offsetting the child's rows within the tallest row's band, not by re-rendering (`:30-39`).
- Edge cases / failure handling: a child allocated width 0 is not rendered at all (`:24`).
- Surprising: the HStack measures width by rendering each child at the *full* width first and then re-rendering at the allocated width — two renders per child per frame.

### packages/tui/src/components/scroll-view.ts
- Purpose: a scrollable viewport with follow-end, overscroll policy and an optional scrollbar.
- Key abstractions: `ScrollViewOptions` (`axis`, `follow`, `primary`, `overscroll`, `scrollbar`, thumb/track styles, hide delay); `ScrollViewScrollToOptions.disableFollow`.
- Data flow: `updateLayout(contentHeight, viewportHeight, requestRender)` → the scroll view reports its content height to the layout engine → the engine positions it; `scrollTo`/`scrollBy` mutate `currentScrollTop`; the renderer asks the node for the visible slice.
- Non-obvious design decisions: (a) `follow: "end"` is a *sticky* mode that turns itself off the moment the user scrolls away, and turns back on when the user returns to the end — `followSuppressedAtEnd` (`:34-35`, `:196-200`). (b) The scrollbar can be `hidden | auto | always`; `auto` shows it only while there is activity, and a hide timer (default 1000 ms) retracts it. (c) `ScrollView` refuses `addChild`/`removeChild`/`clear` — it has exactly one child.
- Edge cases / failure handling: `getContentWidth` reserves one column for the scrollbar only when the scrollbar is `always` (`:93-95`); a zero-width allocation is clamped to 1.
- Surprising: `ScrollViewScrollToOptions.disableFollow` exists so a *programmatic* scroll to the end does not silently re-arm follow-end — an explicit opt-out for the sticky behaviour.

### packages/tui/src/components/editor.ts
- Purpose: the multi-line editor with word wrap, undo, kill-ring, history, bracketed-paste markers and autocomplete — 2473 lines, the largest file in the package.
- Key abstractions: `Editor`; `EditorTheme`; `TextChunk` (a wrap chunk with its position in the original line); `wordWrapLine` (exported and unit-tested directly); `segmentWithMarkers` (a segmenter that merges paste markers into single atomic graphemes).
- Data flow: `handleInput(data)` → keybinding match → mutate `state = {lines, cursorLine, cursorCol}` → `pushUndoSnapshot()` (a `structuredClone` onto the `UndoStack`) → `onChange`/`onSubmit` → the TUI re-renders. Autocomplete: `requestAutocomplete` → debounce → `startAutocompleteRequest` (token + abort controller + snapshot) → provider → `applyAutocompleteSuggestions`.
- Non-obvious design decisions: (a) **Large pastes become a marker, and the marker is a single grapheme.** A paste over 10 lines or 1000 characters is stored in a `Map` and replaced in the buffer by `[paste #N +M lines]` (`:1301-1316`); `segmentWithMarkers` (`:49-101`) makes the segmenter treat a marker with a *valid id* as one atomic unit, so arrow keys, backspace, word motion and word wrap all treat it as one thing. The real text is expanded only at submit (`submitValue`, `:1364-1378`). (b) **Stale autocomplete responses are dropped by a snapshot check, not just by abort** — `isAutocompleteRequestCurrent` (`:2416-2430`) compares the request id, the abort signal, the *text*, the cursor line and the cursor column against the snapshot taken before the request, so a provider that ignores its AbortSignal still cannot write into a changed buffer. (c) The autocomplete request chain is serialised: each request awaits the previous one (`:2322-2338`), so two providers cannot interleave. (d) `shouldSubmitOnBackslashEnter` (`:1353-1362`) makes a trailing backslash a submit only when Shift+Enter is a configured submit key.
- Edge cases / failure handling: a paste marker whose id is not in the registry is *not* atomic (so hand-typed marker-like text behaves like normal text — pinned by `editor.test.ts:4051`); a marker wider than the terminal width must not crash the wrap (`editor.test.ts:4066`); the paste registry is renumbered in ascending id order when markers appear out of order (`editor.test.ts:3986`).
- Surprising: `expandPasteMarkers` runs at *submit* time, so the transcript never contains a 300 KB paste unless the user actually sends it — the buffer stays small while the user is still editing.

### packages/tui/src/components/input.ts
- Purpose: the single-line input with horizontal scrolling, bracketed paste, undo, kill-ring and a styled placeholder.
- Key abstractions: `Input`; `InputOptions` (`prompt`, `placeholder`, `placeholderStyle`); `InputState` (`value`, `cursor`).
- Data flow: `handleInput(data)` → bracketed-paste buffering → keybinding match → mutate value/cursor → `UndoStack` snapshot → `onChange`/`onSubmit`; `render(width)` slices the value around the cursor and emits the hardware-cursor marker + fake cursor.
- Non-obvious design decisions: the prompt is fixed and the *value* scrolls horizontally under it; the cursor is drawn by replacing the grapheme under it with `renderFakeCursor(...)` and prepending `CURSOR_MARKER` when focused (`:483-497`). Bracketed paste is re-assembled across chunk boundaries and any bytes after the end marker are re-entered recursively (`:84-106`).
- Edge cases / failure handling: `killRing` + `lastAction` implement Emacs-style kill/yank accumulation; word motion uses `findWordBackward/Forward` with the Unicode word segmenter, preserving ASCII punctuation boundaries.
- Surprising: the single-line `Input` explicitly does **not** implement the backslash-Enter submit escape hatch (the editor does) — pinned by `input.test.ts:7-26` ("Input is single-line, no backslash+Enter workaround").

### packages/tui/src/components/markdown.ts
- Purpose: the Markdown renderer for transcript messages.
- Key abstractions: `Markdown`; `MarkdownTheme` (heading/link/code/quote/list/emphasis hooks); `StrictStrikethroughTokenizer`; `LatexToken` (with a `pending` flag); `DefaultTextStyle`.
- Data flow: markdown source → `marked` lexer (extended with a strict `~~` tokenizer, a LaTeX inline/block tokenizer, and `marked-cjk-friendly`) → `renderToken` per node → styled lines → `wrapTextWithAnsi` → padded to width.
- Non-obvious design decisions: (a) **The LaTeX tokenizer emits a `pending` token when the closing delimiter has not arrived yet**, so a streamed `$$…` block does not swallow the rest of the message; the 1.4.0 changelog records a follow-up fix where a block-math token could span a GFM table. (b) A `$…$` is only treated as math when it is not a currency-like token (the guards at `:73-83` reject a trailing digit, a SCREAMING_CASE word, or a backtick inside). (c) Heading styling is applied through a *separate* style context so that inline `codespan`/`bold` tokens restore the heading style after their own ANSI resets rather than falling back to the default (`:499-513`).
- Edge cases / failure handling: `getDefaultStylePrefix()` (`:438-470`) computes the ANSI prefix of the default text style *once* by styling a `\u0000` sentinel and slicing at the sentinel — a cheap way to re-open the default style after any inner reset.
- Surprising: the source-order of GFM list markers is preserved by an opt-in renderer option (changelog 0.76.0) because the transcript renders `+` items from the model and `-` looked like a rendering bug.

### packages/tui/src/components/select-list.ts
- Purpose: the command/option picker used for slash commands and model pickers.
- Key abstractions: `SelectItem` (`value`, `label`, `description`); `SelectListTheme`; `SelectListLayoutOptions` (`minPrimaryColumnWidth`, `maxPrimaryColumnWidth`, `truncatePrimary`).
- Data flow: `setFilter` (prefix match) → `render(width)` → visible range with scrolling → per-item primary column + description column → scroll indicator `"(3/17)"`.
- Non-obvious design decisions: the **description column is aligned across items even when the primary text is truncated** — the primary column has a fixed width band (default 32 + gap 2) so descriptions line up. `truncatePrimary` is a *callback* so the host can decide how to elide (`…` vs `...` vs a path-aware elision) without the list component knowing about paths.
- Edge cases / failure handling: descriptions are normalised to a single line (`normalizeToSingleLine`, `:9`) so a multi-line description cannot break the row; a truncated trailing quote is not counted in the cursor offset (`:454-460`).
- Surprising: `setFilter` uses `startsWith`, not fuzzy matching — fuzzy matching lives in `SettingsList` (which uses `fuzzyFilter`), and the two pickers deliberately differ.

### packages/tui/src/components/settings-list.ts
- Purpose: the settings panel list with value cycling, nested submenus and optional fuzzy search.
- Key abstractions: `SettingItem` (`values` for cycling, or `submenu(currentValue, done)` for a nested component); `SettingsListTheme`; `SettingsListOptions.enableSearch`.
- Data flow: `handleInput(data)` → if a search box is open, the *text* goes to the search `Input`; otherwise Enter/Space cycles `values` or opens the submenu; the submenu's `done(selectedValue, {navigateTo})` closes it and can move the cursor to a named item afterwards.
- Non-obvious design decisions: **Space is a change shortcut until a search query exists** — the test `settings-list.test.ts:23-57` pins that typing "TUI mode" into the search box does not toggle the setting, but a lone Space before any query does. The `navigateTo` option in `done()` means a submenu can hand the cursor back to a *different* row, which is how "open a submenu, pick a model, land on the model row" works.
- Edge cases / failure handling: `updateValue(id, newValue)` mutates the item in place so the host can push new state without rebuilding the list; `selectItem(id)` moves the cursor by id.
- Surprising: the search box is a full `Input` component rendered *above* the list, so the settings panel is a composition of the same widgets as the rest of the app.

### packages/tui/src/components/box.ts
- Purpose: a container that applies padding and a background function to its children.
- Key abstractions: `Box(paddingX, paddingY, bgFn)`; `RenderCache` (`childLines`, `width`, `bgSample`, `lines`).
- Data flow: render children unpadded → concatenate → compare with the cache → if unchanged, return the cached lines; else apply the background, pad, and cache.
- Non-obvious design decisions: **the children are rendered unpadded** so the cache check is a per-line *identity* comparison (`:114-116`: "children usually return the same string objects every frame, so the cache check below is a cheap identity comparison per line. Padding here would create new strings that must be compared character by character"). The background function is detected by *sampling* it with the literal string `"test"` rather than by comparing function references (`:132-133`).
- Edge cases / failure handling: `setBgFn` deliberately does not invalidate the cache — the sample check catches the change.
- Surprising: `Box` also builds a `mouseLayout` during render so that `handleMouse` can hit-test its children without re-rendering them (`:86-90`).

### packages/tui/src/components/text.ts
- Purpose: the multi-line text widget with wrapping, margins and an optional background.
- Key abstractions: `Text(text, paddingX, paddingY, customBgFn)` with a `(text,width)` render cache.
- Data flow: tabs → three spaces → margins reduced if the width is too small → `wrapTextWithAnsi` → margins + background → vertical padding.
- Non-obvious design decisions: the horizontal margin is *reduced* when the width cannot fit it (`:69`) so the content never gets a negative width; empty text renders nothing at all (not one blank line).
- Edge cases / failure handling: `flattenLines(result)` is called on the result, so the cached lines are flat strings rather than rope trees.
- Surprising: `Text` is the base class of `Loader` (which overrides `render` to prepend a blank line) — the spinner is a text widget.

### packages/tui/src/components/truncated-text.ts
- Purpose: a single-line text widget that truncates to the viewport width.
- Key abstractions: `TruncatedText(text, paddingX, paddingY)`.
- Data flow: take the first line only → `truncateToWidth` → pad to exactly `width`.
- Non-obvious design decisions: it renders exactly **one** line plus optional vertical padding; a multi-line string is truncated at the first newline (`:37-41`).
- Edge cases / failure handling: the ANSI reset is emitted before the ellipsis, so a truncated styled string does not leave the style open (pinned by `truncated-text.test.ts:65-77`).
- Surprising: unlike `Text` it has no render cache — it is cheap enough not to need one.

### packages/tui/src/components/spacer.ts
- Purpose: N blank lines.
- Key abstractions: `Spacer(lines = 1)` with `setLines`.
- Data flow: `render(width)` returns `lines.length` empty strings.
- Non-obvious design decisions: `invalidate()` is a no-op with the comment "No cached state to invalidate currently" — the widget is stateless.
- Edge cases / failure handling: n/a.
- Surprising: the strings are `""` rather than `" ".repeat(width)`, so the caller pads them.

### packages/tui/src/components/loader.ts
- Purpose: an animated "working" indicator.
- Key abstractions: `Loader(ui, spinnerColorFn, messageColorFn, message, indicator)`; `LoaderIndicatorOptions` (`frames`, `intervalMs`).
- Data flow: `setInterval` advances the frame → `updateDisplay()` sets the text → `ui.requestRender()`.
- Non-obvious design decisions: the indicator is rendered **verbatim** when the host supplies `indicator` (so a host can use its own glyphs) and coloured with `spinnerColorFn` otherwise (`:69-75`, `:88-91`). An empty `frames` array hides the indicator entirely.
- Edge cases / failure handling: `stop()` clears the interval; `invalidate()` re-renders the display so a theme change is visible.
- Surprising: `Loader extends Text`, so a loader is a text widget with an animation.

### packages/tui/src/components/cancellable-loader.ts
- Purpose: a loader that can be aborted with Escape.
- Key abstractions: `CancellableLoader` with an `AbortSignal`, `onAbort` and `aborted`.
- Data flow: `handleInput(data)` → `kb.matches(data, "tui.select.cancel")` → `abortController.abort()` → `onAbort?.()`.
- Non-obvious design decisions: the abort is a **standard `AbortSignal`**, so the work being cancelled can be any async function that takes a signal — the loader does not have to own it.
- Edge cases / failure handling: `dispose()` stops the animation; the escape binding is the *shared* `tui.select.cancel`, so a user rebind applies here too.
- Surprising: the documented usage is `doWork(loader.signal).then(done)` — the loader is a cancellation token, not a spinner.

### packages/tui/src/components/alt-screen-flash.ts
- Purpose: transient messages (e.g. "Copied!") composited by the alt-screen renderer.
- Key abstractions: `AltScreenFlashContainer(requestRender)` with `flash(message, durationMs = 1000)`.
- Data flow: `flash()` pushes an entry with a `setTimeout` that removes it → `requestRender()`; `render(width)` maps entries to reverse-video lines.
- Non-obvious design decisions: the timers are `unref()`ed (`:33`) so a pending flash cannot keep the Node process alive.
- Edge cases / failure handling: `dispose()` clears every pending timer; the message is truncated to the width.
- Surprising: the flash container is a `Component` that renders *nothing* into the layout — the renderer composites it separately, so a flash never disturbs the layout tree.

### packages/tui/src/components/mouse-region.ts
- Purpose: adds mouse handling to an existing component without changing its rendering.
- Key abstractions: `MouseRegion(child, onMouse)`; `MouseRegionHandler`.
- Data flow: `handleMouse(event)` → dispatch to the child first → fall back to the region handler.
- Non-obvious design decisions: the child gets first refusal; the region handler only fires when the child did not handle the event.
- Edge cases / failure handling: n/a.
- Surprising: this is the adapter that lets a plain `Text` become clickable without a new widget.

### packages/tui/src/components/image.ts
- Purpose: inline image rendering (Kitty / iTerm2) with a text fallback.
- Key abstractions: `Image(base64Data, mimeType, theme, options, dimensions)`; `ImageTranscoder`; `setImageTranscoder`.
- Data flow: `render(width)` → cell dimensions → `renderImage(...)` → for Kitty, a single line with the image sequence plus `rows-1` empty lines (so the TUI accounts for the image height); for iTerm2, `rows-1` empty lines then a "move up, draw, move down" line.
- Non-obvious design decisions: (a) Kitty only accepts PNG, so a host registers a `transcoder`; the converted PNG is cached in a 32-entry LRU and **failures are not cached**, so a later transcoder can retry (`:62-63`, `:33-41`). (b) The PNG's own dimensions are preferred over the original because conversion may apply EXIF rotation (`:109-110`).
- Edge cases / failure handling: a terminal without image support renders `imageFallback(...)` — `[Image: image/png 800x600]`, with the path shortened to `~/…` and, if OSC 8 is available, hyperlinked to `file://`.
- Surprising: the `Image` component *allocates* a Kitty image id on first render and keeps it, so re-renders replace the image rather than re-uploading it.

### packages/tui/src/autocomplete.ts
- Purpose: the combined slash-command / file-path / argument autocomplete provider.
- Key abstractions: `AutocompleteProvider`; `AutocompleteItem`; `AutocompleteSuggestions`; `SlashCommand`; `CombinedAutocompleteProvider`.
- Data flow: `getSuggestions(lines, cursorLine, cursorCol, {signal, force})` → decide the *kind* of completion (slash command / command argument / `@file` / path) → produce items + the prefix they replace → `applyCompletion(lines, cursorLine, cursorCol, item, prefix)` rewrites the buffer and returns the new cursor.
- Data flow detail: file suggestions are produced by shelling out to `fd` with a **regex** built from the typed path (`:21-44` `buildFdPathQuery`), with every segment regex-escaped — the fix for the changelog entry "`@` file autocomplete returning no results for queries containing regex metacharacters such as `[` or `(`".
- Non-obvious design decisions: (a) The provider distinguishes a *slash command name* (line starts with `/` and has no further `/`) from a *command argument* (the line contains both `/` and a space) from an `@file` mention from a plain path — and each gets a different completion shape (`:428-497`). (b) Quoted paths are handled explicitly: the prefix keeps its opening quote, the closing quote is adjusted, and the cursor offset excludes the trailing quote. (c) `stripLeadingWrappers` (`:60-70`) removes an unmatched opening bracket/paren/brace/backtick before a path but keeps it if the token also contains the closer, so `app/[slug]/pa` still completes.
- Edge cases / failure handling: the whole `fd` path is wrapped in a try/catch that returns `[]` (`:841-843`), so a missing `fd` degrades to "no suggestions" rather than an exception. `shouldTriggerFileCompletion` refuses to fire on a slash command at the start of a line (`:847-857`).
- Surprising: the provider is fully *async* and takes an `AbortSignal`; the editor's staleness rules (see above) are the thing that makes an async provider safe.

### packages/tui/src/alt-screen-search.ts
- Purpose: transcript search over the rendered alt-screen lines.
- Key abstractions: `AltScreenSearchComponent`; `AltScreenSearchIndex`; `AltScreenSearchMatch`; `SearchCorpus`/`SearchSourceSpan`.
- Data flow: `buildSearchCorpus(lines)` strips ANSI and builds a flat text plus a span map (text offsets → row/column) → `findAltScreenSearchMatches` runs a case-insensitive regex over the flat text → the match's text offsets are mapped back to per-row column ranges for highlighting.
- Non-obvious design decisions: (a) **an ASCII fast path** (`:50-78`): "Rendered transcripts are overwhelmingly ASCII. Index complete non-space runs at once instead of segmenting and allocating one mapping per cell." The slow path segments per grapheme and uses `visibleWidth` for the column. (b) Spaces become a single separator between runs, so a search term cannot match across a line break. (c) The overlay renders a boxed search bar with prev/next buttons whose hit rectangles are computed during render and stored on the component (`:300-326`).
- Edge cases / failure handling: the search is re-run after a layout change (`refreshSearch(nextLayout)` in `tui-alt-screen.ts:1696-1698`) so a resize re-indexes.
- Surprising: the search is a *screen* search, not a document search: it indexes what is currently rendered, including the fact that the transcript is a scroll window.

### packages/tui/src/latex.ts
- Purpose: renders a LaTeX math expression as terminal-friendly Unicode.
- Key abstractions: `renderLatex(source, {display})`; `LatexParser`; `LayoutNode` (`fraction | operator | script | matrix`); symbol tables (`SYMBOLS`, `BLACKBOARD`, `SUPERSCRIPTS`, `SUBSCRIPTS`, `VARIANTS`).
- Data flow: source → `LatexParser.render()` → a string with **layout markers** (`\u{f0000}<index>\u{f0001}`) where a multi-line construct (a matrix, a stacked fraction) belongs → `renderLayout` expands the markers into multi-line bands → `normalizeOutput` trims → the result is returned.
- Non-obvious design decisions: (a) The parser returns `undefined` for unsupported or malformed syntax, so the caller can fall back to the raw source rather than render nonsense (`:1488-1496`). (b) `PROTECTED_SPACE` (`\u{f0002}`) marks alignment padding inside a matrix cell so that a later `trim()` does not destroy the column layout. (c) Unicode sub/superscripts are used when the whole script is representable; otherwise a stacked layout is used instead (`:974-1004`).
- Edge cases / failure handling: `\begin{cases}` renders a brace-delimited two-column layout with a centred middle brace (`:1393-1422`); unknown environments set `this.supported = false` and return the body verbatim.
- Surprising: the symbol table is a *port* of a LaTeX-to-Unicode mapping and it distinguishes `\varepsilon`/`\epsilon` and `\phi`/`\varphi` — the level of typographic fidelity is unusual for a TUI library.

### packages/tui/src/terminal-image.ts
- Purpose: capability detection, Kitty/iTerm2 image encoding, cell-dimension math and image metadata.
- Key abstractions: `TerminalCapabilities` (`images`, `trueColor`, `hyperlinks`); `ImageProtocol`; `CellDimensions`; `ImageRenderOptions`; `ImageCellSize`.
- Data flow: `detectCapabilities()` reads the environment → `getCapabilities()` caches it → `renderImage(data, dimensions, options)` computes a cell size and emits the protocol sequence; `isImageLine(line)` tells the renderers that a line carries an image and must not be width-checked.
- Non-obvious design decisions: (a) **tmux is probed, not guessed** (`:54-68`): the code runs `tmux display-message -p '#{client_termfeatures}'` and only enables OSC 8 hyperlinks when tmux says it forwards them. (b) The Herdr check comes *before* the Kitty check, because `KITTY_WINDOW_ID` can leak into a Herdr pane's environment (`:89-93`). (c) Under tmux, image protocols are disabled outright ("Image protocols are unreliable under tmux"). (d) `calculateImageCellSize` has an `optimizeAspectRatio` mode that picks the cell count with the *less* distortion, using a polynomial fit of the ideal rows (`:470-525`).
- Edge cases / failure handling: PNG/JPEG/GIF/WebP dimension parsers are hand-written header readers that return `null` on any mismatch rather than throwing (`:535-660`).
- Surprising: `getImageDimensions` covers four formats by sniffing magic bytes, because a TUI cannot depend on an image library.

### packages/tui/native/darwin/prebuilds/darwin-arm64/darwin-platform.node
- Purpose: the shipped macOS arm64 native addon — the compiled form of `native/darwin/src/darwin-platform.m`.
- Key abstractions: not applicable; it is a Mach-O binary, not source.
- Data flow: loaded by `src/native-platform.ts` via `require` and resolved against the N-API symbols at load time.
- Non-obvious design decisions: the binary is 52 KB for a 132-line source file, because it embeds the AppKit/CoreGraphics/Foundation frameworks' usage and the `dlsym` symbol table; it carries the `__TEXT` segment with `cf fa ed fe` (MH_MAGIC_64) and cputype `0x0100000c` (arm64).
- Edge cases / failure handling: a failed load is cached as "unavailable" by `src/native-platform.ts:38-52` and the caller degrades to command-line clipboard tools.
- Surprising: the exported symbol names are visible in the raw bytes — `napi_register_module_v1`, `getText`, `getImage`, `setText`, `getFilePaths`, `isModifierPressed` — which is how I confirmed the binary matches `darwin-platform.m` without executing it.

### packages/tui/native/darwin/prebuilds/darwin-x64/darwin-platform.node
- Purpose: the shipped macOS x64 native addon, the Intel build of the same source.
- Key abstractions: n/a (binary).
- Data flow: same as the arm64 build; `src/native-platform.ts:56` selects by `process.platform` and `process.arch`.
- Non-obvious design decisions: it is 22 KB against the arm64 build's 52 KB — the size difference is pointer width and the arm64 build's larger `__TEXT` segment, not a feature difference; the export list is identical.
- Edge cases / failure handling: only `x64` and `arm64` are attempted; any other arch returns `undefined` without touching the filesystem (`src/native-platform.ts:30`).
- Surprising: `getFilePaths` is present in the binary even though `native-platform.ts` only types it as optional — the macOS build supports it while the Linux build does not.

### packages/tui/native/linux/prebuilds/linux-arm64/linux-platform-x11.node
- Purpose: the shipped Linux arm64 X11 clipboard addon, the compiled form of `native/linux/src/linux-platform-x11.c`.
- Key abstractions: n/a (binary).
- Data flow: loaded lazily by `src/native-platform.ts:61-65` only when `process.platform === "linux"` **and** `DISPLAY` is set.
- Non-obvious design decisions: the binary is 67 KB (the largest of the six) because it is built with `-nostdlib` and unversioned `libxcb`/`pthread` imports, so it must carry more of its own machinery. It is also the one prebuild that has a hard packaging constraint, and I verified it independently: both `PT_LOAD` segments are 64 KB-aligned, which is exactly what `packages/tui/test/native-platform.test.ts:8-27` asserts so the module loads on a 64 KB-page system.
- Edge cases / failure handling: a stalled X11 read is bounded by the private worker's 3 s deadline and leaves the helper "unavailable" rather than hung.
- Surprising: the raw bytes contain `xcb_get_property`, `CLIPBOARD`, `dlsym` and `pthread_` but **no** `setText` export — the Linux helper is deliberately read-only.

### packages/tui/native/linux/prebuilds/linux-x64/linux-platform-x11.node
- Purpose: the shipped Linux x64 X11 clipboard addon.
- Key abstractions: n/a (binary).
- Data flow: same as the arm64 build; the path is derived from `process.arch` in `src/native-platform.ts:31-37`.
- Non-obvious design decisions: 18 KB against the arm64 build's 67 KB for the same source — the aarch64 build carries `-mno-outline-atomics`-style inline atomic helpers and more relocation metadata.
- Edge cases / failure handling: an unresolvable `libxcb` at load time is tolerated by the linker flags (`--unresolved-symbols=ignore-all`), so the module still loads and reports "unavailable" instead of failing the import.
- Surprising: the same three exports (`napi_register_module_v1`, `getText`, `getImage`) as arm64 — the Linux helper deliberately has no `setText` and no `getFilePaths`.

### packages/tui/native/win32/prebuilds/win32-arm64/win32-platform.node
- Purpose: the shipped Windows arm64 native addon — console input setup, modifier state and clipboard.
- Key abstractions: n/a (binary).
- Data flow: loaded by `src/native-platform.ts:55-58` on `win32`; the exported `enableVirtualTerminalInput` is what `src/terminal.ts:225` calls after raw mode.
- Non-obvious design decisions: the binary is only 9 KB — by far the smallest — because it links `kernel32` and `user32` directly and resolves the N-API surface through `GetProcAddress` (the string is present in the binary) rather than carrying a runtime.
- Edge cases / failure handling: `OpenClipboard` contention is retried 10 × 5 ms inside the binary; the exported `isModifierPressed` returns false for an unknown key name.
- Surprising: the exports include `enableVirtualTerminalInput`, which has no counterpart in the macOS or Linux builds — console VT input is a Windows-only problem.

### packages/tui/native/win32/prebuilds/win32-x64/win32-platform.node
- Purpose: the shipped Windows x64 native addon, the Intel build of the same source.
- Key abstractions: n/a (binary).
- Data flow: same as the arm64 build; `src/native-platform.ts:56` gates the load on `process.platform === "darwin" || "win32"`.
- Non-obvious design decisions: 8.5 KB — a PE/COFF image with an `MZ` header, a 0x78 PE offset and the same seven exports as the arm64 build.
- Edge cases / failure handling: the module registers its own `_DllMainCRTStartup` (`native/win32/src/win32-platform.c:227`), so it does not depend on the CRT being initialised first.
- Surprising: the two Windows builds differ by under 1 KB, while the two Linux builds differ by 49 KB — the Linux difference comes from the `-nostdlib` link, not from the source.

### packages/tui/src/terminal-colors.ts
- Purpose: parsing of the terminal's colour-scheme and palette replies.
- Key abstractions: `TerminalColors` (`foreground`, `background`, `palette`); `TerminalColorScheme` (`dark | light`); `OscColorTarget`; `parseOscColorResponse`; `parseTerminalColorSchemeReport`.
- Data flow: the terminal replies to OSC 10/11/4 → `parseOscColorResponse` returns `{target, rgb}` → the TUI accumulates the replies → the palette is only set when **all 16** arrived.
- Non-obvious design decisions: the hex parser accepts both 6-digit `#rrggbb` and 12-digit `#rrrrggggbbbb` (16-bit channels) and scales the latter (`:27-36`). A reply that parses but has an unparseable colour returns `rgb: undefined` rather than being treated as "not a reply".
- Edge cases / failure handling: the OSC pattern is anchored and accepts both BEL and ST terminators.
- Surprising: the palette is `undefined` unless *every* index replied — a partial palette is not silently half-applied.

### packages/tui/src/colors.ts
- Purpose: colour values, parsing, mixing and ANSI style emission.
- Key abstractions: `Color = IndexedColor | RgbColorValue | OklchColorValue`; `TextStyle`/`TextAttributes`; `TerminalColorMode` (`256color | truecolor`); `OkhslChannels`.
- Data flow: `parseColor("#20242a" | "oklch(70% 0.12 220)" | "okhsl(250 60% 55%)")` → a `Color` → `mixColors`/`colorToRgb` → `foregroundAnsi`/`backgroundAnsi` → `styleText(text, style, mode)`.
- Non-obvious design decisions: **every colour is convertible to sRGB, so colour math never fails** (`:23-24`). `styleText` builds the prefix and the suffix so that the resets close in *reverse* order of the opening sequences (`:336-366`).
- Edge cases / failure handling: the constructors validate ranges and throw with a precise message (`"l must not be negative: -1"`, `"s must be between 0 and 1"`); the colour-mode argument decides 256-colour vs truecolour output.
- Surprising: `okhslColor` is a *convenience constructor* that returns an **RGB** value (already gamut-mapped), while `oklchColor` returns an `OklchColorValue` that is gamut-mapped lazily by `colorToRgb`.

### packages/tui/src/oklab.ts
- Purpose: Oklab / OKHSL ↔ sRGB conversion.
- Key abstractions: the conversion matrices; `maxSaturation`, `cusp`, `maxChroma`, `chromaStops`.
- Data flow: OKHSL (h,s,l) → Oklab L → chroma stops → Oklab (L,a,b) → linear sRGB → encoded sRGB.
- Non-obvious design decisions: the file is an attributed **port of Björn Ottosson's reference implementation** with the MIT licence text kept in the header (`:5-15`). Max saturation is found by a per-channel polynomial fit plus **one Halley step** (`:109-123`), and the chroma curve is a two-piece fit through `c0`, `cMid` and `cMax` (`:153-179`).
- Edge cases / failure handling: out-of-gamut results are clipped per channel; greys return `h=0, s=0`.
- Surprising: OKHSL's saturation is *relative to the sRGB gamut at that hue and lightness*, so equal saturation looks equally colourful across hues — a perceptual property the TUI themes rely on.

### packages/tui/src/fuzzy.ts
- Purpose: fuzzy matching and filtering for command and settings pickers.
- Key abstractions: `fuzzyMatch(query, text) → {matches, score}`; `fuzzyFilter(items, query, getText)`.
- Data flow: lower-case both sides → walk the query characters through the text, scoring → sort ascending (lower is better).
- Non-obvious design decisions: (a) The score *rewards* consecutive matches (`-5` per extra consecutive character), word-boundary hits (`-10`) and an exact match (`-100`), and *penalises* gaps (`+2` per skipped character) and late matches (`+0.1 * index`). (b) **A swapped alnum retry** (`:76-93`): "codex52" matches "gpt-5.2-codex" because the query is also tried with its letters and digits exchanged, at a +5 penalty.
- Edge cases / failure handling: `fuzzyFilter` splits the query on whitespace **and slashes** and requires *every* token to match (`:105-112`), which is exactly the "provider/model" query shape.
- Surprising: the multi-token split on `/` is why `openai-codex/gpt-5.5` still matches a model whose id and provider are stored separately.

### packages/tui/src/word-navigation.ts
- Purpose: pure functions for word-wise cursor movement.
- Key abstractions: `findWordBackward(text, cursor, options)`; `findWordForward(text, cursor, options)`; `WordNavigationOptions` (`segment`, `isAtomicSegment`).
- Data flow: slice the text at the cursor → segment it (default `Intl.Segmenter` word granularity) → skip whitespace → land on the previous/next word or punctuation run.
- Non-obvious design decisions: the functions are **pure** (no state) and accept an injected segmenter plus an `isAtomicSegment` predicate, which is how the editor makes a paste marker move as one unit.
- Edge cases / failure handling: inside a word-like segment the cursor stops at the last ASCII punctuation boundary rather than at the segment edge, so `foo.bar` navigates `foo` / `.` / `bar` (`:50-56`).
- Surprising: the atomic-segment hook is a generic concept ("segments that must move as one") that the editor reuses for a purpose the function's author did not have in mind.

### packages/tui/src/kill-ring.ts
- Purpose: the Emacs kill ring.
- Key abstractions: `KillRing.push(text, {prepend, accumulate})`; `peek()`; `rotate()`.
- Data flow: consecutive kills accumulate into the last entry (prepending for backward deletion, appending for forward), `peek` returns the newest, `rotate` moves it to the front for yank-pop.
- Non-obvious design decisions: `accumulate` is an explicit option, so the editor decides when two kills are one operation.
- Edge cases / failure handling: empty text is ignored; `rotate` is a no-op with fewer than two entries.
- Surprising: `peek` does not modify the ring — the yank-pop implementation has to delete the yanked text separately (`editor.ts:2078`).

### packages/tui/src/undo-stack.ts
- Purpose: a generic undo stack.
- Key abstractions: `UndoStack<S>` with `push(state)`, `pop()`, `clear()`.
- Data flow: `push` stores a `structuredClone`; `pop` returns the stored snapshot directly (no re-clone, because it is already detached).
- Non-obvious design decisions: clone-on-push rather than copy-on-write, so the editor can mutate its state freely after a snapshot.
- Edge cases / failure handling: `structuredClone` will throw on non-cloneable values — the editor only stores plain data.
- Surprising: the doc comment states the pop-side optimisation explicitly, which is the kind of detail that saves an allocation per keystroke.

### packages/tui/src/wheel-scroll.ts
- Purpose: converts wheel events into a number of scrolled lines.
- Key abstractions: `WheelScrollLines = number | "auto"`; `WheelScrollAccelerator`.
- Data flow: `next(direction, now)` → gap since the last event → if the gesture continues, `lines = min(6, max(1, 100 / averageGap))` plus a carried fraction.
- Non-obvious design decisions: (a) A **burst guard**: events less than 5 ms apart are one physical notch (Ghostty emits them ~4 ms apart) and never accelerate (`:4-11`, `:67`). (b) A gesture ends after a 200 ms pause or a direction change, which resets the average. (c) macOS local terminals already accelerate the wheel at the OS level, so acceleration is disabled there — but only when no `SSH_*` variable is present, because over SSH the client platform is unknown (`:18-26`).
- Edge cases / failure handling: fractional lines are carried between events so a slow scroll does not drift (`:70-73`).
- Surprising: the "auto" mode's constant (100 ms reference gap) is a hand-tuned velocity curve, not a physical model.

### packages/tui/src/stdin-buffer.ts
- Purpose: re-assembles stdin chunks into complete escape sequences.
- Key abstractions: `StdinBuffer` (an `EventEmitter` with `data` and `paste` events); `StdinBufferOptions`.
- Data flow: `process(data)` → append to a buffer → `isCompleteSequence` decides whether to emit → emit `data` per sequence, or `paste` for a bracketed-paste body.
- Non-obvious design decisions: (a) The completeness test is *type-specific* (CSI / OSC / DCS / APC / SS3 / meta) rather than a generic "is there a final byte" (`:38-87`); the old-style mouse sequence `ESC [ M` needs exactly 3 more bytes. (b) A **terminal-reply header pattern** (`:29`) keeps a partially-received OSC colour/program-status/XTVersion/Kitty reply from being mistaken for a batched legacy Alt keystroke.
- Edge cases / failure handling: an escape timeout (10 ms, 100 ms over SSH) flushes a lone ESC as an Escape key; bracketed paste is re-wrapped in markers so downstream components see the same shape as before.
- Surprising: the file credits OpenTUI as its origin (`:16-18`), and the reply-header pattern was added later precisely because a fragmented OSC reply was being delivered as Alt+key.

### packages/tui/src/program-status.ts
- Purpose: the OSC 7501 "program status" protocol (idle / working / blocked / done / error / clear).
- Key abstractions: `ProgramStatus` (`state`, `app`, `kind`, `message`); `PROGRAM_STATUS_QUERY`; `isProgramStatusReply`; `formatProgramStatus`.
- Data flow: the app calls `formatProgramStatus(status)` → the terminal renders an indicator (a spinner, a "blocked on permission" badge) and can answer the query so the app knows the terminal supports it.
- Non-obvious design decisions: (a) **Control characters are replaced with spaces** because "Terminals discard reports whose text contains control characters" (`:45-50`). (b) The message is base64-encoded and truncated at a **UTF-8 boundary** to 2048 bytes, chosen so the base64 stays under the spec's 2732-byte limit (`:29-43`). (c) The app name is pattern-validated (`[A-Za-z0-9_.+-]{1,32}`) and simply omitted when invalid.
- Edge cases / failure handling: `kind` is only emitted for the `blocked` state; `clear` removes the status.
- Surprising: this is the only place in the repo where a TUI reports its *own* state to the terminal — the shape of an agent's turn lifecycle, expressed as a terminal capability.

### packages/tui/src/native-platform.ts
- Purpose: loads the native clipboard / modifier helper at runtime.
- Key abstractions: `NativeClipboard` (`getText`, `getImage`, `getFilePaths?`, `setText?`); `getNativePlatformHelper`; `getNativeClipboard`.
- Data flow: `getNativePlatformHelper()` → build the platform prebuild path → try each candidate from `getNativeModuleCandidates` → `require` the first one that exports the expected functions.
- Non-obvious design decisions: (a) The **three-state return contract**: `undefined` = unavailable, `null` = no content, and a rejection = transfer failure (`:9-18`) — so a caller can tell "this platform cannot do it" from "the clipboard is empty". (b) The module cache stores *loading* results, not availability: "Cache module loading, not display availability: a disconnected display can recover" (`:25`). (c) Only `x64`/`arm64` are supported. (d) On Linux the helper is loaded lazily and only when `DISPLAY` is set, because Wayland reads use `wl-paste` instead.
- Edge cases / failure handling: a failed load is cached as `undefined` and each candidate is tried in turn.
- Surprising: the Linux clipboard deliberately has **no** `setText` — "Linux uses command-line tools to retain clipboard ownership instead" — so the native path is read-only there.

### packages/tui/src/native-module-path.ts
- Purpose: computes the candidate paths for the native prebuild.
- Key abstractions: `getNativeModuleCandidates(nativePath, {moduleUrl, execPath, resolvePackage})`.
- Data flow: candidate 1 = the installed `@earendil-works/pi-tui` package root; candidates 2-4 = relative to the module, relative to the module's parent, and next to the executable.
- Non-obvious design decisions: the function takes `moduleUrl`, `execPath` and `resolvePackage` as *injectable* parameters purely so the test can exercise the resolution without a real install (`:8-12`).
- Edge cases / failure handling: a package that cannot be resolved is skipped, and the standalone-binary candidates remain.
- Surprising: the first candidate is the *package root* rather than the module directory, because a bundled application (esbuild chunk) has the TUI in `node_modules` while the native binary is packaged next to the executable.

### packages/tui/src/native-modifiers.ts
- Purpose: a safe wrapper around the native modifier-key probe.
- Key abstractions: `isNativeModifierPressed(key)`.
- Data flow: call the helper's `isModifierPressed`; any failure returns `false`.
- Non-obvious design decisions: the `try/catch` is deliberate — a missing native module or an unsupported platform must not break the input path.
- Edge cases / failure handling: returns `false` when the helper is absent or throws.
- Surprising: it is used for exactly one thing — detecting Shift+Enter on Apple Terminal and Windows, which send a plain Return.

### packages/tui/src/editor-component.ts
- Purpose: the interface a *custom* editor must implement.
- Key abstractions: `EditorComponent` (required: `getText`, `setText`, `handleInput`; optional: `onSubmit`, `onChange`, `addToHistory`, `insertTextAtCursor`, `getExpandedText`, `setAutocompleteProvider`, `borderColor`, `setPaddingX`, `setAutocompleteMaxVisible`).
- Data flow: the host treats any `EditorComponent` as an editor; the core app does not care which implementation it is.
- Non-obvious design decisions: the interface is deliberately **capability-based** (every optional method is a feature) rather than a class hierarchy, and the docstring names the intent: "This allows extensions to provide their own editor implementation (e.g., vim mode, emacs mode, custom keybindings) while maintaining compatibility with the core application."
- Edge cases / failure handling: `getExpandedText` falls back to `getText()` if the implementation does not provide it — the paste-marker expansion is an optional capability.
- Surprising: `getExpandedText` exists so a host can read the *logical* text of an editor that stores pastes as markers — the capability is optional precisely because a custom editor may not use markers.

### packages/tui/native/napi.h
- Purpose: a hand-rolled subset of the N-API surface, resolved at runtime.
- Key abstractions: the `napi_*` function-pointer typedefs; `node_symbol(name)`; helpers `undefined_value`, `null_value`, `fail`, `set_function_export`.
- Data flow: at load time every needed N-API symbol is looked up with `dlsym(RTLD_DEFAULT, …)` (POSIX) or `GetProcAddress` on `node.dll` (Windows); if a symbol is missing the corresponding operation fails gracefully.
- Non-obvious design decisions: the header comment states the reason: "Resolve the small N-API surface we use from Node or Bun, without Node headers or a link-time dependency on a particular runtime" (`:4-5`). The module therefore works under Node **and** Bun and needs no `node-gyp`/Node headers.
- Edge cases / failure handling: every helper null-checks its symbol and returns a failure value rather than crashing.
- Surprising: the whole native stack is built with `dlsym` rather than linking against `node`, which is what lets a single `.node` file run under both runtimes.

### packages/tui/native/clipboard.h
- Purpose: the shared clipboard job/format model and the N-API glue, shared by all three platforms.
- Key abstractions: `clipboard_operation` (`TEXT | IMAGE | WRITE | FILES`); `clipboard_format` (`UNAVAILABLE | EMPTY | UTF8 | LATIN1 | UTF16 | BUFFER | PATHS`); `clipboard_job`.
- Data flow: `queue_clipboard(env, info, op)` → allocate a job → `napi_create_async_work` → the **worker thread** runs `clipboard_execute` (which must not call N-API, per the comment at `:32`) → the complete callback converts the job's format into a JS value.
- Non-obvious design decisions: (a) The worker/complete split is explicit — "Only this function runs on the worker thread. It must not call N-API." (`:32-33`). (b) `CLIPBOARD_PATHS` stores *concatenated, NUL-terminated UTF-8 paths* in one buffer and is split back into an array on the JS side, avoiding N allocations. (c) The `PI_CLIPBOARD_WRITE` macro gates the write path, so Linux can be built read-only.
- Edge cases / failure handling: a cancelled async work sets `job->error = "Clipboard operation cancelled"`; `CLIPBOARD_EMPTY` maps to `null` and `CLIPBOARD_UNAVAILABLE` to `undefined`.
- Surprising: the `undefined` vs `null` distinction is carried all the way from the C enum to the JS promise, so the caller can distinguish "no clipboard here" from "empty clipboard".

### packages/tui/native/darwin/src/darwin-platform.m
- Purpose: the macOS native helper (AppKit).
- Key abstractions: `clipboard_execute(job)`; `is_modifier_pressed`; `get_clipboard_file_paths`.
- Data flow: `NSPasteboard generalPasteboard` → for images, prefer PNG, else convert TIFF via `NSBitmapImageRep`; for files, read `NSURL` objects and concatenate their `fileSystemRepresentation`s.
- Non-obvious design decisions: the modifier probe uses `CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState)` — the *combined* session state — so it reflects the actual session rather than one event source.
- Edge cases / failure handling: the file-path concatenation checks for `SIZE_MAX` overflow before allocating; an empty selection is `CLIPBOARD_EMPTY`, not an error.
- Surprising: the file-path buffer is built with a length pass followed by a copy pass, so the allocation is exact.

### packages/tui/native/darwin/build.sh
- Purpose: builds the macOS prebuilds for arm64 and x64.
- Key abstractions: compiler selection (`CC`, `xcrun --find clang`, `clang`); SDK discovery (`SDKROOT` or `xcrun --sdk macosx --show-sdk-path`).
- Data flow: compile `darwin-platform.m` into a Mach-O bundle with `-bundle -undefined dynamic_lookup` and install it into `native/darwin/prebuilds/darwin-<arch>/darwin-platform.node`.
- Non-obvious design decisions: `-undefined dynamic_lookup` is what lets the binary resolve the N-API symbols at load time instead of linking them — the direct consequence of the `dlsym` design. `-fvisibility=hidden` + `-Wl,-dead_strip` keeps the export surface to the one registered function.
- Edge cases / failure handling: `set -euo pipefail`; a missing SDK or compiler aborts with a message; a temp dir is removed by a trap.
- Surprising: the build targets macOS 11.0 (arm64) and 10.15 (x64) explicitly.

### packages/tui/native/darwin/README.md
- Purpose: how to build the macOS prebuilds.
- Key abstractions: the build command; the cross-compilation recipe (osxcross + an SDK).
- Data flow: n/a (doc).
- Non-obvious design decisions: the note that "Plain clang or Zig alone is not sufficient" — a Darwin *linker* and the macOS SDK are required, which is the usual cross-build wall.
- Edge cases / failure handling: the SDK must be used under Apple's licence.
- Surprising: only 22 lines, because the build script is the real documentation.

### packages/tui/native/linux/src/linux-platform-x11.c
- Purpose: the Linux X11 clipboard helper.
- Key abstractions: `x11_clipboard` (connection, window, atoms); `property_data`; `read_property`, `read_selection`.
- Data flow: open the X connection → intern the CLIPBOARD/UTF8_STRING/PNG atoms → become the selection owner → read the property (with the INCR protocol for large transfers) → decode the format.
- Non-obvious design decisions: (a) **One deadline is shared across discovery, replies and incremental chunks** (`:54-55`), so a slow transfer cannot consume 2 s per phase. (b) `MAX_CLIPBOARD_BYTES` is 50 MiB and the read is capped. (c) The selection format is distinguished (`XCB_ATOM_STRING` → LATIN1, else UTF8) so the JS side knows the encoding.
- Edge cases / failure handling: `wait_for_input` polls the X connection file descriptor with `poll()` and retries on `EINTR`; `xcb_discard_reply` is called when the deadline passes, so the X connection is not left with a pending reply.
- Surprising: the helper *becomes the selection owner* itself in order to read it — standard X11 practice, but it means the read has a real round-trip cost.

### packages/tui/native/linux/src/clipboard-worker.h
- Purpose: the Linux worker-thread policy that keeps X11 I/O off the libuv thread pool.
- Key abstractions: the `worker_mutex`/`worker_changed` condition variable and the `worker_result` slot.
- Data flow: `clipboard_execute(job)` → if no worker is running, spawn a detached thread that performs the X11 read → the calling thread waits on the condition variable with a 3-second deadline → on completion the result is copied into the job.
- Non-obvious design decisions: (a) **Only one private reader may exist at a time**; a second concurrent request returns "unavailable" immediately rather than queueing (`:45-68`). (b) The wait is bounded at 3 s — deliberately longer than the 2 s transfer deadline so the transfer's own error surfaces first (`:50-51`). (c) The condition variable is initialised with `CLOCK_MONOTONIC` because "Unversioned ELF imports otherwise bind obsolete condition variables on glibc x64" (`:15-16`). (d) If the caller timed out, the late result's buffer is freed rather than leaked (`:31-35`).
- Edge cases / failure handling: the private thread is detached, and the build passes `-Wl,-z,nodelete` because "A timed-out private thread may outlive the Node environment that loaded us".
- Surprising: the whole design exists so that a *slow clipboard* cannot consume the libuv thread pool — the same reason the Linux build uses `-nostdlib` and unresolved-symbol-ignore.

### packages/tui/native/linux/build.sh
- Purpose: builds the Linux X11 prebuild.
- Key abstractions: arch detection (`x86_64 → x64`, `aarch64/arm64 → arm64`); the shared compiler flag list.
- Data flow: compile `linux-platform-x11.c` with `-lxcb` into `native/linux/prebuilds/linux-<arch>/linux-platform-x11.node`.
- Non-obvious design decisions: the unusual flag set — `-nostdlib`, `-Wl,--unresolved-symbols=ignore-all`, `-Wl,--no-as-needed`, `-fno-stack-protector`, `-Wl,-z,nodelete` — exists so the binary can be loaded by *both* glibc and musl systems and can survive an environment teardown.
- Edge cases / failure handling: the script refuses to run off Linux; unsupported architectures are rejected by name.
- Surprising: `-fno-stack-protector` and `-nostdlib` are unusual for a clipboard helper, and exist to make the `.node` file loadable on minimal distros.

### packages/tui/native/linux/README.md
- Purpose: how to build and test the Linux helper.
- Key abstractions: the build command; the test command.
- Data flow: n/a (doc).
- Non-obvious design decisions: the README states the limits plainly — "Reads have bounded waits; if a native operation stalls, the helper remains unavailable until it finishes" — and documents the fallback chain (Wayland uses `wl-paste`; all Linux writes use command-line tools).
- Edge cases / failure handling: the tests skip when `cc`, `Xvfb`, `xclip` or `pkg-config` are missing.
- Surprising: the tests use isolated Xvfb servers, "not the desktop clipboard".

### packages/tui/native/win32/src/win32-platform.c
- Purpose: the Windows native helper (console input + clipboard).
- Key abstractions: `enable_virtual_terminal_input`; `is_modifier_pressed`; `read_clipboard_text`/`read_clipboard_image`; `open_clipboard` with retries.
- Data flow: `GetStdHandle(STD_INPUT_HANDLE)` → `SetConsoleMode(…, ENABLE_VIRTUAL_TERMINAL_INPUT)`; `GetAsyncKeyState` for the modifier probe; `OpenClipboard` → `GetClipboardData(CF_UNICODETEXT / CF_DIB)` → convert to UTF-8.
- Non-obvious design decisions: (a) `OpenClipboard` is retried 10 times with a 5 ms sleep, because another process holding the clipboard is a *transient* condition (`:76-82`). (b) The modifier probe checks the general and the left/right virtual keys separately (e.g. `VK_SHIFT | VK_LSHIFT | VK_RSHIFT`) so both sides of a key are detected. (c) The module exports its own `_DllMainCRTStartup` (`:227-232`) — a minimal DLL entry point.
- Edge cases / failure handling: `is_key_pressed` masks `0x8000` to read the "pressed" bit only; a failed clipboard open is a clean error, not a crash.
- Surprising: `enableVirtualTerminalInput` must run *after* `setRawMode(true)` because raw mode resets the console mode flags — the ordering is called out in `terminal.ts:221-225`.

### packages/tui/native/win32/build.mjs
- Purpose: builds the Windows prebuilds for x64 and arm64 under MSVC or MinGW.
- Key abstractions: the `targets` table (arch → MSVC arch, MinGW triple, prefixed compiler names, env var); `findVisualStudioDevCmd`; `canUseMsvc` (a probe batch file); `resolveMingwCompiler`.
- Data flow: detect a toolchain → build each target → install the `.node` into `native/win32/prebuilds/win32-<arch>/win32-platform.node`.
- Non-obvious design decisions: (a) The MSVC detection **probes** rather than trusting `vswhere`: it writes a `probe.cmd` that calls `VsDevCmd.bat` and checks that `cl.exe` is on the path (`:93-108`). (b) The toolchain can be forced with `PI_TUI_WIN32_TOOLCHAIN=msvc|mingw` and an invalid value is a hard error. (c) A temp dir is removed on `exit` *and* on `SIGINT`.
- Edge cases / failure handling: a missing Visual Studio workload produces an actionable message ("Install the Visual Studio C++ workload or set PI_TUI_WIN32_TOOLCHAIN=mingw").
- Surprising: the script is plain Node ESM with no dependency on `node-gyp`, so it works in a minimal build environment.

### packages/tui/native/win32/README.md
- Purpose: how to build the Windows prebuilds and how to opt into the destructive clipboard test.
- Key abstractions: the build command; the MinGW override env vars; the `PI_TEST_NATIVE_CLIPBOARD` opt-in.
- Data flow: n/a (doc).
- Non-obvious design decisions: the destructive test is opt-in **and** says so in bold: "**It replaces the system clipboard contents.**"
- Edge cases / failure handling: the test is skipped unless the env var is set.
- Surprising: `PI_TUI_WIN32_TOOLCHAIN=mingw` with `CC_X64` / `CC_ARM64` is the documented escape hatch for a machine without Visual Studio.

### packages/tui/test/virtual-terminal.ts
- Purpose: the test substrate — a `Terminal` implementation backed by `@xterm/headless`.
- Key abstractions: `VirtualTerminal` (implements the `Terminal` interface) with `sendInput`, `resize`, `flush`, `getViewport`, `getScrollBuffer`, `getCursorPosition`, `waitForRender`.
- Data flow: `write(data)` → the xterm emulator parses the ANSI stream → the test reads back the emulator's *buffer*, not the string it wrote.
- Non-obvious design decisions: the virtual terminal always reports `kittyProtocolActive === true` (`:62-65`) so the Kitty path is the default in tests. `waitForRender()` (`:214-218`) awaits a tick + 20 ms + a flush, because the TUI's render path is throttled.
- Edge cases / failure handling: `getViewport()` reads the *visible* rows using `buffer.viewportY`, and `getScrollBuffer()` reads the whole buffer including scrollback — the two are distinguished because the main-screen renderer's behaviour differs between them.
- Surprising: the emulator is what makes "the terminal would have shown X" assertions possible at all.

### packages/tui/test/test-themes.ts
- Purpose: default chalk-based themes for the tests.
- Key abstractions: `defaultSelectListTheme`; `defaultMarkdownTheme`; `defaultEditorTheme`.
- Data flow: n/a (fixtures).
- Non-obvious design decisions: `new Chalk({ level: 3 })` forces full colour so ANSI assertions are deterministic in CI (`:8`).
- Edge cases / failure handling: n/a.
- Surprising: the README's quick-start imports `defaultEditorTheme` from `./test/test-themes.ts` — the *test* fixture is the documented example.

### packages/tui/test/editor.test.ts
- Purpose: the largest test file (4380 lines) — the Editor's behaviour contract.
- Key abstractions: `createTestTUI(cols, rows)`; a local `applyCompletion`; `flushAutocomplete()`.
- Data flow: drive the editor with raw key bytes and assert on `getText()`, `getCursor()` and the rendered lines.
- Non-obvious design decisions: the tests drive the editor through the *same* `handleInput` path as a real terminal rather than calling private methods, and they assert on grapheme-aware behaviour.
- Edge cases / failure handling: the file contains the paste-marker atomicity suite (`:3801-4370`), the sticky-column suite (`:3500-3800`) and the wrap-backtracking suite (`:4124`).
- Surprising: it imports `wordWrapLine` **directly from the source** — the wrap algorithm is exported so it can be unit-tested without a TUI.

### packages/tui/test/tui-alt-screen.test.ts
- Purpose: the alt-screen renderer's behaviour contract (2100 lines).
- Key abstractions: `InputOverlay`; `RecordingTerminal` (records start/write/stop events).
- Data flow: build a layout → render → assert on the emulator's viewport and on the recorded terminal events.
- Non-obvious design decisions: the search index is imported from `src/alt-screen-search.ts` and tested through the renderer, not separately.
- Edge cases / failure handling: covers mouse capture, Kitty placement, overlays, search, and the OSC 133 zone prefix.
- Surprising: `RecordingTerminal` asserts on the *order* of terminal events, which is how the "images drawn last for WezTerm" rule is pinned.

### packages/tui/test/tui-render.test.ts
- Purpose: the main-screen renderer's contract (1024 lines).
- Key abstractions: `BoundedWriteTerminal` (records writes); `LoggingVirtualTerminal`; `getCellItalic` (reads a cell attribute out of xterm's buffer).
- Data flow: render → read the emulator's cells and the recorded writes.
- Non-obvious design decisions: the "bounded render output" suite (`:167-225`) asserts that splitting a >1 MiB render **does not change its output** — the chunking is behaviour-preserving, and the test says so.
- Edge cases / failure handling: the Kitty image cleanup suite (`:262-511`) covers reserved rows, full-redraw fallback and image deletion; the resize suite (`:512-591`) covers height, Termux and width changes.
- Surprising: `getCellItalic` asserts on a *cell attribute* — a much stronger claim than "the string contains `\x1b[3m`".

### packages/tui/test/overlay-non-capturing.test.ts
- Purpose: the "overlay does not capture focus" contract (1203 lines).
- Key abstractions: `StaticOverlay`; `EmptyContent`; `FocusableOverlay`; `renderAndFlush`.
- Data flow: show an overlay with `nonCapturing`, type, and assert on focus and on the rendered screen.
- Non-obvious design decisions: the test file exists because "non-capturing overlays remain interactive after UI rerenders and explicit focus release" was a real bug (changelog 0.78.1).
- Edge cases / failure handling: `renderAndFlush` calls `tui.requestRender(true)` — a *forced* render — so the test does not depend on the throttle.
- Surprising: the file is 41 KB for one feature: the focus-restore state machine has many legal orderings and each one is pinned.

### packages/tui/test/overlay-options.test.ts
- Purpose: overlay positioning, sizing and anchoring.
- Key abstractions: `StaticOverlay` (records the width it was asked to render at); `CursorTrackingTerminal` (tracks cursor visibility).
- Data flow: `showOverlay(overlay, {width, row, col, anchor, margin, maxHeight, visible, nonCapturing})` → assert the rendered result and the recorded render width.
- Non-obvious design decisions: the overlay records *the width it was asked to render at*, which is how the width-resolution rules (default `min(80, available)`, `minWidth`, clamp to available) are verified.
- Edge cases / failure handling: percentage row/col are clamped so the overlay stays inside the terminal.
- Surprising: `OverlayOptions` accepts both absolute numbers and percentage strings for `width`, `maxHeight`, `row` and `col` — the same `SizeValue` type for all four.

### packages/tui/test/keys.test.ts
- Purpose: the key-matching contract (647 lines).
- Key abstractions: `withEnv` / `withEnvVars` helpers that restore the environment afterwards.
- Data flow: build a raw Kitty or legacy sequence → `matchesKey` / `parseKey` → assert.
- Non-obvious design decisions: the tests cover Cyrillic Ctrl+C, Dvorak, the Kitty "alternate keys" flag, super-modified keys, and the shifted-symbol case — i.e. they treat *layout* as a first-class concern.
- Edge cases / failure handling: `setKittyProtocolActive(true/false)` is toggled inside each test, and the environment helper restores the original values.
- Surprising: the Dvorak case asserts that Ctrl+K matches Ctrl+K (not Ctrl+V) — the layout fallback is deliberately *narrow*.

### packages/tui/test/markdown.test.ts
- Purpose: the Markdown renderer's contract (1865 lines).
- Key abstractions: `getCell(terminal, row, col)` (an xterm cell accessor); `stripAnsi`.
- Data flow: render Markdown → assert on the emulator's cells.
- Non-obvious design decisions: cell-level assertions are used where a string assertion would be ambiguous (for example "bold and italic must not bleed into the next cell").
- Edge cases / failure handling: covers CJK punctuation adjacency, tables, lists, code blocks, links and LaTeX.
- Surprising: the changelog entry "Fixed Markdown bold and italic not rendering next to CJK punctuation" is exactly the kind of case a cell-level assertion catches and a string assertion does not.

### packages/tui/test/autocomplete.test.ts
- Purpose: the autocomplete provider's contract (853 lines).
- Key abstractions: `setupFolder` (builds a temp tree); `fdPath` detection; a `describe` block that **skips** when `fd` is not installed.
- Data flow: build a temp directory → type a path → assert the suggestions.
- Non-obvious design decisions: the external-tool dependency is a *conditional* skip, not a hard failure, so the suite still runs on a machine without `fd`.
- Edge cases / failure handling: covers dot-slash paths, quoted paths, regex metacharacters in the query, and the `@` file mention.
- Surprising: the "fd @ file suggestions" block is skipped with `{ skip: !isFdInstalled }` — a dependency-aware test, not a mock.

### packages/tui/test/terminal-image.test.ts
- Purpose: the image and capability layer's contract (942 lines).
- Key abstractions: an `ENV_KEYS` list that is cleared before every detection test.
- Data flow: set the environment → `detectCapabilities()` / `getCapabilities()` → assert.
- Non-obvious design decisions: the environment is fully scrubbed (15 variables) so a developer's real terminal cannot change a detection result.
- Edge cases / failure handling: covers tmux, screen, Herdr, Rex, Kitty, WezTerm, iTerm2, Windows Terminal, Warp and the `PI_HYPERLINKS` / `PI_IMAGE_PROTOCOL` / `PI_TRUE_COLOR` overrides.
- Surprising: the fallback text for an image is hyperlinked to a `file://` URL when OSC 8 is available — the fallback is still actionable.

### packages/tui/test/input.test.ts
- Purpose: the Input widget's contract (664 lines).
- Key abstractions: none beyond the widget.
- Data flow: `handleInput` → assert on `getValue()` and the rendered lines.
- Non-obvious design decisions: the suite pins the *absence* of the backslash-Enter behaviour in the single-line input, so the two editors cannot drift.
- Edge cases / failure handling: covers the placeholder, custom prompt, horizontal scrolling, kill/yank and undo.
- Surprising: the first test's comment ("Input is single-line, no backslash+Enter workaround") is a deliberate divergence, not an oversight.

### packages/tui/test/stdin-buffer.test.ts
- Purpose: the escape-sequence reassembler's contract (21 KB).
- Key abstractions: the buffer's `process`/`flush`/`clear` API and its `data`/`paste` events.
- Data flow: feed byte chunks → observe the emitted sequences.
- Non-obvious design decisions: the tests feed sequences in deliberately awkward splits (one byte at a time, split in the middle of a mouse report) because that is the real failure mode.
- Edge cases / failure handling: covers the Kitty reply fragment, bracketed paste and the escape timeout.
- Surprising: the "chunked OSC reply" case is the one that caused the "colour replies leaking into the prompt" bug in the changelog.

### packages/tui/test/layout.test.ts
- Purpose: the layout engine's contract (367 lines).
- Key abstractions: `visibleLines` (strip + trim).
- Data flow: build a VStack/HStack/ScrollView tree → `renderLayoutFrame` → assert on the lines.
- Non-obvious design decisions: the "allocates vertical grow space deterministically" test pins the exact distribution algorithm, so the flex allocator cannot change silently.
- Edge cases / failure handling: covers scroll views inside stacks and Kitty image rows.
- Surprising: the layout test is the only place the flex arithmetic is pinned; the `distribute` loop's tie-breaking is therefore part of the contract.

### packages/tui/test/latex.test.ts
- Purpose: the LaTeX renderer's contract (515 lines).
- Key abstractions: `defineCases` — a table-driven helper that turns an array of `[source, expected]` pairs into one test per pair.
- Data flow: `renderLatex(source)` → assert the exact expected string.
- Edge cases / failure handling: the expected values are written as a real mathematical session ("Jacobian conjecture session using dollar delimiters") so the suite reads like a document rather than a fuzz list.
- Surprising: table-driven tests with a *narrative* fixture is a much better regression corpus than dozens of hand-written cases.

### packages/tui/test/terminal.test.ts
- Purpose: the terminal layer's contract (438 lines).
- Key abstractions: `resolveEscapeTimeoutMs(env)`.
- Data flow: call the pure helpers with a synthetic environment.
- Non-obvious design decisions: the escape timeout is environment-dependent (10 ms locally, 100 ms over SSH) and overridable with `PI_TUI_ESC_TIMEOUT`; invalid values fall back to the default rather than throwing.
- Edge cases / failure handling: `""`, `"0"`, `"-5"` and `"abc"` are all rejected.
- Surprising: the timeout is longer over SSH because a slow link can split one escape sequence across two reads.

### packages/tui/test/terminal-colors.test.ts
- Purpose: the colour-reply parsing and query lifecycle.
- Key abstractions: a local `TestTerminal` that records writes and can inject input.
- Data flow: start the TUI → it writes the OSC query → the test injects replies → assert on the resolved colours.
- Edge cases / failure handling: the palette is only complete when all 16 replies arrived.
- Surprising: the same file tests the *query* (a promise that resolves on the DA1 sentinel) and the *parsing* (a pure function) together.

### packages/tui/test/wrap-ansi.test.ts
- Purpose: the ANSI-aware word-wrap contract (266 lines).
- Key abstractions: none.
- Data flow: `wrapTextWithAnsi(text, width)` → assert on the exact line strings.
- Non-obvious design decisions: the assertions are about *which reset code* is emitted: a wrapped underline must end with `\x1b[24m` (underline off), **not** `\x1b[0m`, because a full reset would also kill the background colour.
- Edge cases / failure handling: covers a trailing space before the reset, and style bleed into the padding.
- Surprising: "which reset, not just whether it is reset" is the kind of assertion that catches real visual bugs.

### packages/tui/test/truncate-to-width.test.ts
- Purpose: the truncation contract (127 lines).
- Key abstractions: none.
- Data flow: `truncateToWidth(text, width, ellipsis)` → assert the width and the emitted codes.
- Non-obvious design decisions: a truncated string is bracketed with `\x1b[0m` before and after the ellipsis, and an OSC 8 link is *closed* when its label is truncated.
- Edge cases / failure handling: a 100 000-repetition emoji string must not hang or overflow; a malformed `ESC not-ansi` prefix must not hang; a wide (2-column) ellipsis is clipped safely.
- Surprising: `truncateToWidth("a", 2, "🙂")` returns `"a"` — the original text, because the text already fits.

### packages/tui/test/visible-width.test.ts
- Purpose: the width contract (26 lines).
- Key abstractions: none.
- Data flow: `visibleWidth(str)` → assert the number.
- Non-obvious design decisions: the assertions cover OSC 8 links, OSC 133 prompt zones, APC sequences and *unterminated* escapes — the last of which is the "escape sequence storm" defence.
- Edge cases / failure handling: tabs count as three columns *inside styled text*.
- Surprising: `visibleWidth("\x1b[31") === 3` — an incomplete CSI is treated as zero-width, so a half-received sequence cannot shift a whole frame.

### packages/tui/test/tab-width.test.ts
- Purpose: the tab-accounting contract.
- Key abstractions: `CapturingVirtualTerminal` (records the raw output); `TabStatusOverlay`.
- Data flow: render an overlay containing a tab → assert the emulator's viewport and that the raw output contains no tab.
- Non-obvious design decisions: the rule is that tabs are expanded to spaces **before** the width check, so a tab-containing overlay cannot wrap into a second physical row (changelog 0.78.1: "tab-containing output cannot exceed the terminal width").
- Edge cases / failure handling: tabs *inside* control sequences (OSC 8, OSC 0, APC) are left byte-identical.
- Surprising: the third test asserts the exact opposite rule for control sequences — tabs inside them are preserved, tabs in text are expanded.

### packages/tui/test/truncated-text.test.ts
- Purpose: the TruncatedText widget's contract (129 lines).
- Key abstractions: none.
- Data flow: render → assert the visible width and the ellipsis/reset placement.
- Edge cases / failure handling: empty text, exact fit, multi-line input.
- Surprising: it forces `new Chalk({level: 3})` for deterministic colour assertions.

### packages/tui/test/select-list.test.ts
- Purpose: the SelectList contract (116 lines).
- Key abstractions: `visibleIndexOf` (a visible-column aware index helper).
- Data flow: render the list → assert on the *visible column* of the description text.
- Non-obvious design decisions: the assertions are column-based, not string-based, precisely because the description alignment is a *column* property.
- Edge cases / failure handling: a custom `truncatePrimary` must not break the description alignment.
- Surprising: `visibleIndexOf` is the reusable trick — `indexOf` gives a code-unit index, but the alignment is a *column* index.

### packages/tui/test/settings-list.test.ts
- Purpose: the SettingsList contract (58 lines).
- Key abstractions: none.
- Data flow: type into the search box → assert on the change callbacks.
- Non-obvious design decisions: the test asserts that a space *inside* a search query does not toggle the setting, while a lone space *before* any query does — the exact ambiguity the component has to resolve.
- Edge cases / failure handling: n/a.
- Surprising: a 58-line test file pins an interaction rule that is easy to get wrong and hard to notice.

### packages/tui/test/overlay-short-content.test.ts
- Purpose: an overlay must still be visible when the content is shorter than the terminal.
- Key abstractions: `SimpleContent`; `SimpleOverlay`.
- Data flow: render a 3-line body in a 24-row terminal → assert the overlay is in the viewport.
- Non-obvious design decisions: on failure it dumps the whole viewport to stdout — a debugging courtesy for a visual failure.
- Edge cases / failure handling: the "content shorter than terminal" case is where overlay placement maths usually goes wrong.
- Surprising: the file contains `console.log` diagnostics inside the test — rare, and appropriate for a visual assertion.

### packages/tui/test/program-status.test.ts
- Purpose: the OSC 7501 encoder/decoder contract.
- Key abstractions: `decodeMessage` (base64 → utf8).
- Data flow: `formatProgramStatus(status)` → assert the exact escape sequence.
- Edge cases / failure handling: control characters become spaces; a 2000-character message is cut at a UTF-8 boundary to 1024 characters; an over-long app name is dropped rather than truncated.
- Surprising: the test asserts both the *decoded* message and the *encoded* length, so the base64 expansion limit is pinned too.

### packages/tui/test/fuzzy.test.ts
- Purpose: the fuzzy matcher contract.
- Key abstractions: none.
- Data flow: `fuzzyMatch` / `fuzzyFilter` → assert on the score sign and the ordering.
- Edge cases / failure handling: the swapped-alnum case ("codex52" vs "gpt-5.2-codex") and the slash-separated multi-token case.
- Surprising: the assertions are mostly on the *sign and relative order* of the score rather than exact numbers, so the weights can be tuned without rewriting the test.

### packages/tui/test/word-navigation.test.ts
- Purpose: the word-motion contract.
- Key abstractions: a hand-built `segmentMap` that returns a *pre-split* segment list for a given input string.
- Data flow: `findWordBackward/Forward(text, cursor, {segment, isAtomicSegment})` → assert the new cursor.
- Non-obvious design decisions: the test injects a fake segmenter so the "atomic segment" (paste marker) case can be exercised without an Editor.
- Edge cases / failure handling: the comment explains that the functions slice the text before segmenting, so the map is keyed by the *pre-slice* string — the test had to mirror the implementation's contract exactly.
- Surprising: the seam (an injectable segmenter) is what makes this component testable in isolation.

### packages/tui/test/wheel-scroll.test.ts
- Purpose: the wheel-acceleration contract.
- Key abstractions: a `scroll(accelerator, times)` helper.
- Data flow: call `next(direction, t)` at synthetic timestamps → assert the line counts.
- Edge cases / failure handling: a burst (3 ms apart) is one line each; a direction change resets; fractional lines are carried.
- Surprising: the expected arrays read like a rhythm (`[1, 5, 5, 5]` for 20 ms gaps) which documents the velocity curve.

### packages/tui/test/mouse-components.test.ts
- Purpose: the mouse contract for the interactive components.
- Key abstractions: a `mouse(type, x, y)` event factory; `SubmenuHost` (a container that routes keys to a nested list).
- Data flow: synthesise a `TuiMouseEvent` → dispatch → assert on the component's state.
- Non-obvious design decisions: `SubmenuHost` mirrors the coding agent's theme submenu, so the test exercises the real nesting shape.
- Edge cases / failure handling: covers the input cursor placement, the select list, the settings list and the editor.
- Surprising: the mouse event is constructed by hand rather than by parsing SGR mouse bytes — the byte parsing is tested elsewhere.

### packages/tui/test/editor-history-keybindings.test.ts
- Purpose: prompt-history navigation driven by a *rebound* key.
- Key abstractions: `setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {…}))` plus an `afterEach` that restores the default manager.
- Data flow: rebind `tui.editor.historyPrevious` to Ctrl+P → drive the editor → assert the history text and the cursor.
- Non-obvious design decisions: the `afterEach` restore is essential — a global keybinding registry is process-wide state, and a test that leaks it would corrupt every other test.
- Edge cases / failure handling: the cursor position after restoring the draft is asserted exactly.
- Surprising: the default binding for history is *empty*, so this test exists to prove the extension point works.

### packages/tui/test/autocomplete-skill-slash.test.ts
- Purpose: the slash-command filter's ranking and whitespace handling.
- Key abstractions: `suggestionsFor(prefix)`.
- Data flow: type `/idea` → assert the first suggestion.
- Edge cases / failure handling: leading whitespace is preserved on completion; argument completion after a command works; the `skill:` prefix still lists skills.
- Surprising: the test is written around a *skills* command set, so the TUI package's test suite is already exercising the extension surface the harness will need.

### packages/tui/test/exit-restore.test.ts
- Purpose: the terminal-restore-on-exit regression (issue #11170).
- Key abstractions: `runFixture(mode)` spawns a child process; `count(haystack, needle)`.
- Data flow: spawn `fixtures/exit-without-stop.ts` → read stdout → count the restore sequences.
- Non-obvious design decisions: it asserts **exactly one** occurrence of each restore sequence, and that the Kitty pop precedes leaving the alt screen (`output.indexOf("\x1b[<u") < output.indexOf("\x1b[?1049l")`) — the *order* matters, not just the presence.
- Edge cases / failure handling: the child is run with `TMUX`/`STY`/`ZELLIJ` cleared so the output is deterministic.
- Surprising: "does not restore twice after a normal stop()" is a separate test — double-restoring is as bad as not restoring.

### packages/tui/test/tui-cell-size-input.test.ts
- Purpose: the cell-size query must not steal user input.
- Key abstractions: `withImageTerminal` (swaps the environment and resets the capability cache).
- Data flow: start the TUI → inject `CSI 6;20;10 t` → assert the cell dimensions updated and that the recorder saw nothing → inject `"q"` → assert the recorder saw `"q"`.
- Non-obvious design decisions: the environment is set to *ghostty* so the cell-size query is actually sent (the query is only issued when the terminal supports images).
- Edge cases / failure handling: a bare ESC must still be forwarded as the Escape key even though a query is outstanding.
- Surprising: the bare-ESC case is the one that would otherwise break every "press Escape" interaction in the app.

### packages/tui/test/tui-overlay-style-leak.test.ts
- Purpose: an overlay must not leak a style past the last visible column.
- Key abstractions: `getCellItalic` (an xterm cell accessor).
- Data flow: render a 20-column italic line whose reset falls *beyond* the last column → assert the next row's cell is not italic.
- Edge cases / failure handling: covers both the no-overlay case and the overlay-slicing case.
- Surprising: the assertion is on the *next row* — a style leak is only observable in the row after the styled one.

### packages/tui/test/tui-shrink.test.ts
- Purpose: content shrinking to zero must clear the screen.
- Key abstractions: `Lines`.
- Data flow: render three lines → `tui.clear()` → assert the viewport is empty.
- Edge cases / failure handling: the "shrink to zero" case is the one that leaves stale text if the renderer only diffs.
- Surprising: `clearOnShrink` is off by default, so this test exercises the explicit-clear path rather than the shrink path.

### packages/tui/test/regression-slice-by-column-ansi-order.test.ts
- Purpose: the ANSI-order regression for `sliceByColumn` (issue #10169).
- Key abstractions: none.
- Data flow: slice a styled line → assert the exact output string.
- Non-obvious design decisions: the expectation `"Another \x1b[35m\x1b[39m line with …"` shows the rule: a slice that starts *after* a colour open must **re-emit the open and the close** so the colour does not bleed into the following text.
- Edge cases / failure handling: a second highlighted token later in the line is unaffected.
- Surprising: the fix is a *re-emission* of a style that the slice logically excludes.

### packages/tui/test/regression-overlay-cjk-boundary.test.ts
- Purpose: an overlay that starts *inside* a wide grapheme must not split it.
- Key abstractions: `extractSegments`; `compositeTuiLine`.
- Data flow: composite an overlay at column 5 of `"abcd让EFGH"` → assert the wide grapheme is dropped from the "before" segment, not half-included.
- Non-obvious design decisions: the rule is "a wide grapheme that the overlay starts inside is excluded from the before-segment entirely" — the alternative (keeping half) would corrupt the cell grid.
- Edge cases / failure handling: the ASCII case at the same boundary keeps its old behaviour, so the change is CJK-specific.
- Surprising: the same rule is applied in `sliceByColumn` and `extractSegments`, and the test pins both.

### packages/tui/test/regression-regional-indicator-width.test.ts
- Purpose: a partial flag grapheme must measure as width 2.
- Key abstractions: none.
- Data flow: `visibleWidth("🇨")` → assert 2.
- Non-obvious design decisions: the reasoning is stated in the test itself (`:8-11`): during streaming "🇨🇳" appears as "🇨" first; if "🇨" measured as 1 while the terminal renders it as 2, differential rendering drifts and leaves stale characters on screen.
- Edge cases / failure handling: every regional-indicator singleton in U+1F1E6..U+1F1FF is checked.
- Surprising: this is a **streaming** bug that only appears mid-token — exactly the class of defect a TUI library must own.

### packages/tui/test/regression-sigwinch-kill-eacces.test.ts
- Purpose: the self-SIGWINCH refresh must not throw when `kill(2)` is denied.
- Key abstractions: the environment is patched with `Object.defineProperty(process, "platform", …)`.
- Data flow: stub `process.kill` to throw `EACCES` → assert `refreshTerminalDimensions()` does not throw.
- Edge cases / failure handling: EPERM is also tolerated, and `kill` is never called on Windows.
- Surprising: the test patches `process.platform` — the function's platform branch is thus genuinely exercised, not just assumed.

### packages/tui/test/bug-regression-isimageline-startswith-bug.test.ts
- Purpose: the `isImageLine` crash regression.
- Key abstractions: a local `oldIsImageLine` reproducing the buggy implementation.
- Data flow: feed a line containing an image escape sequence → assert the new implementation detects it.
- Non-obvious design decisions: the test *reproduces the old implementation* in the test file so the regression is documented, not just fixed.
- Edge cases / failure handling: the "crash scenario simulation" covers very long lines and the exact dimensions from the crash log.
- Surprising: the original symptom was "Rendered line exceeds terminal width (304401 > 115)" — a width assertion firing on a 300 KB base64 image line.

### packages/tui/test/native-platform.test.ts
- Purpose: the native helper's contract, including an ELF-header assertion.
- Key abstractions: none.
- Data flow: read the prebuilt `.node` file and inspect its ELF program headers.
- Non-obvious design decisions: the first test asserts that the Linux ARM64 prebuild's load segments are 64 KB-aligned, because a system with 64 KB pages otherwise fails to load the module. That is a **build-output** assertion, not a behaviour one.
- Edge cases / failure handling: the Windows clipboard write test is opt-in (`PI_TEST_NATIVE_CLIPBOARD=1`) and is documented as destructive.
- Surprising: a TypeScript test reading an ELF header is an unusual but very effective way to pin a packaging constraint.

### packages/tui/test/native-clipboard-linux.test.ts
- Purpose: the Linux clipboard's end-to-end contract (247 lines).
- Key abstractions: `startServer` (spawns Xvfb and reads the display number from stdout); `readClipboard` (runs the fixture in a child process).
- Data flow: build the C fixtures → start Xvfb → run `clipboard-reader.cjs` against the prebuild → parse the JSON result.
- Non-obvious design decisions: the test **compiles its own C fixtures** with `cc` at `before()` time, including `-mno-outline-atomics` on arm64 so the fixture's allocation counters are inlined.
- Edge cases / failure handling: the whole suite is skipped when `cc`, `Xvfb`, `xclip` or `pkg-config` are missing, and the timeout is 60 s.
- Surprising: the fixture is compiled with `-nostdlib` "to match the prebuild's unversioned system-library imports" — the test deliberately reproduces the production link environment.

### packages/tui/test/native-module-path.test.ts
- Purpose: the native module resolution contract.
- Key abstractions: the injected `moduleUrl` / `execPath` / `resolvePackage`.
- Data flow: call `getNativeModuleCandidates` → assert the candidate list.
- Non-obvious design decisions: the first candidate is the installed package root; when the package is absent the list is exactly the three standalone-binary fallbacks.
- Edge cases / failure handling: a `resolvePackage` that throws is handled.
- Surprising: the assertion is `deepStrictEqual` on the whole list — the *order* of the candidates is part of the contract.

### packages/tui/test/fixtures/clipboard-reader.cjs
- Purpose: a child-process probe for one native clipboard read.
- Key abstractions: none.
- Data flow: `require(helper)[method]()` → await → print JSON with the value/length/hash.
- Non-obvious design decisions: it asserts the read returns a **Promise** and that the call **does not block the event loop** (a 10 ms timer must tick more than 5 times in 200 ms), and that the process leaves no child or zombie behind.
- Edge cases / failure handling: the hash lets the test compare content without embedding it in the assertion.
- Surprising: "Clipboard I/O must not block the JS event loop" is asserted *inside the fixture*, so it holds for every test that uses the fixture.

### packages/tui/test/fixtures/clipboard-worker-test.c
- Purpose: a C fixture that exercises the *production* Linux worker without X11.
- Key abstractions: `tracked_calloc` / `tracked_free` (allocation counters) injected by `#define` before including the production header.
- Data flow: the fixture `#include`s `native/linux/src/clipboard-worker.h` with `calloc`/`free` redefined, so the real `clipboard_execute` runs against a controlled `read_clipboard` that blocks on an atomic flag.
- Non-obvious design decisions: **the production source is included, not reimplemented** — the comment says "Exercise the production executor with a controlled blocking callback, without X11."
- Edge cases / failure handling: `get_state()` reports `reads,allocations,worker_busy` so the JS side can assert on liveness and leaks.
- Surprising: the `#define calloc tracked_calloc` trick is a neat way to get allocation accounting into production code without touching it.

### packages/tui/test/fixtures/clipboard-worker-test.cjs
- Purpose: the driver for the worker fixture.
- Key abstractions: `waitFor(predicate)` with a 5 s deadline; two modes (`worker-exit`, `process-exit`).
- Data flow: load the addon → call `getText()` → wait for the state → assert.
- Non-obvious design decisions: the assertions are about **resource behaviour**: 20 concurrent reads must all return `undefined` promptly, filesystem I/O must stay available, the process must exit naturally even though the private callback never finishes, and the detached operation must survive the *environment* being torn down (`worker-exit` mode).
- Edge cases / failure handling: "Only one private reader may remain blocked" and "Another request must not start another private reader" pin the single-reader policy from the JS side.
- Surprising: it runs the same fixture in a `worker_thread` and then terminates the thread, proving the native work outlives its environment.

### packages/tui/test/fixtures/clipboard-x11-test.c
- Purpose: an X11 selection owner + a leak-tracking wrapper for the production X11 code.
- Key abstractions: `tracked_realloc` / `tracked_free` injected via `#define` before including `linux-platform-x11.c`.
- Data flow: the fixture becomes the selection owner and serves a chunked transfer; the reader is the production code under test.
- Non-obvious design decisions: the allocation tracker is used instead of RSS because "This makes the partial-transfer leak regression deterministic, unlike RSS" (`:8-9`).
- Edge cases / failure handling: the `metadata` mode validates that a terminating chunk must agree with the preceding metadata (a mismatch aborts the accumulation); the `invalid` mode rejects the terminating chunk after allocating the preceding data, which is the partial-transfer leak case.
- Surprising: the same "include the production file with redefined allocators" trick appears in two fixtures.

### packages/tui/test/colors.test.ts
- Purpose: the colour layer's contract (47 lines, four cases).
- Key abstractions: none.
- Data flow: `parseColor` / `colorToRgb` / `colorToOkhsl` / `styleText` → assert the exact value or the exact escape sequence.
- Non-obvious design decisions: the test asserts the *whole* emitted string for `styleText` (`:40-46`) rather than a pattern, because the ordering of the closing resets is part of the contract — `"\x1b[38;2;18;52;86m\x1b[48;5;9m\x1b[1m\x1b[3mReady\x1b[23m\x1b[22m\x1b[49m\x1b[39m"`.
- Edge cases / failure handling: `parseColor` rejects `""` and `"red"` with "Invalid color value"; `okhslColor` rejects saturation 160% with "s must be between 0 and 1".
- Surprising: the OKHSL round-trip is checked over three real hex colours (`#4f8eb3`, `#20242a`, `#f8f9fa`) — the palette August's own theme would use.

### packages/tui/test/fixtures/exit-without-stop.ts
- Purpose: a 7-line fixture that starts a `TuiAltScreen` and then exits the process *without* calling `stop()`.
- Key abstractions: none.
- Data flow: `new TuiAltScreen(new ProcessTerminal(), false, undefined, { mouse: true })` → `tui.start()` → optionally `tui.stop({ preserveScreen: true })` → `process.exit(0)`.
- Edge cases / failure handling: the fixture is the *only* way to exercise the `process.on("exit")` restore path, because a normal `stop()` skips it.
- Surprising: mouse tracking is enabled in the fixture, so the restore sequence under test includes the mouse-mode resets as well as the Kitty and bracketed-paste ones.

### packages/tui/test/keybindings.test.ts
- Purpose: the keybinding registry's contract (81 lines, six cases).
- Key abstractions: `new KeybindingsManager(TUI_KEYBINDINGS)` and the same with a user-override map.
- Data flow: build a manager → read `getKeys(id)` / call `matches(data, id)` / read `getConflicts()`.
- Non-obvious design decisions: the suite pins the *defaults* as data — `tui.input.newLine` is `["shift+enter", "ctrl+j"]`, `tui.altScreen.search` is `["ctrl+shift+f"]`, `tui.altScreen.searchClose` is `["escape"]` — so a default change is a visible diff rather than a silent behaviour change.
- Edge cases / failure handling: the last two cases are the important ones: rebinding one action must not evict another action's default, and a conflict between two *user* claims must be reported (`getConflicts()` returns the key and the claimants).
- Surprising: `tui.editor.historyPrevious`/`historyNext` and the half-page/line alt-screen keys are asserted to be **unbound** (`[]`) by default — the library refuses to guess a binding for a host that has not asked for one.

### packages/tui/test/chat-simple.ts
- Purpose: the reference chat application (also the README's example).
- Key abstractions: a `CombinedAutocompleteProvider` with two slash commands; a `Loader` for the "thinking" state.
- Data flow: `editor.onSubmit` → append a `Markdown` user message → append a `Loader` → after 1 s remove the loader and append the assistant message → `tui.requestRender()`.
- Non-obvious design decisions: `editor.disableSubmit` is toggled to prevent a second submit while a response is pending — the same "one turn at a time" discipline an agent harness needs.
- Edge cases / failure handling: `/delete` removes the last message and `/clear` removes all of them, both by splicing the `tui.children` array directly.
- Surprising: it is the *only* place in the package where the component tree is mutated by index (`children.splice(...)`) rather than through `addChild`/`removeChild`.

### packages/tui/test/key-tester.ts
- Purpose: an interactive key-code logger for manual protocol debugging.
- Key abstractions: a `KeyLogger` component that renders the last 20 key events.
- Data flow: `handleInput(data)` → hex / char codes / a printable repr → `tui.requestRender()`.
- Non-obvious design decisions: the footer lists the exact keys worth testing ("Shift + Enter (should show: \x1b[13;2u with Kitty protocol)") and the header shows the *negotiated protocol* (kitty / modifyOtherKeys / legacy).
- Edge cases / failure handling: the render loop re-requests a render every 100 ms because "Protocol negotiation completes asynchronously after the first render" — without it the displayed protocol would be stale.
- Surprising: this is the tool that makes the Kitty-protocol support matrix maintainable by hand.

### packages/tui/test/image-test.ts
- Purpose: a manual image-rendering harness.
- Key abstractions: none.
- Data flow: read a PNG from `argv[2]` → print the detected capabilities and dimensions → render it in a TUI.
- Non-obvious design decisions: it prints the capabilities *before* rendering, so a wrong capability detection is obvious.
- Edge cases / failure handling: a missing file prints a usage message and exits 1.
- Surprising: a manual harness is retained alongside the automated tests, because image rendering is not reproducible in CI.

### packages/tui/test/alt-screen-large-transcript-bench.ts
- Purpose: a benchmark for the fullscreen transcript shape.
- Key abstractions: a `NullTerminal` that discards output; the exact component tree (ScrollView → document → header/resources/chat → 2500 alternating Markdown components).
- Data flow: build 2500 components → `renderNow()` 20 times to warm → measure steady frames, one-line scrolling, streaming updates to the last message, and a width change.
- Non-obvious design decisions: it measures **four distinct scenarios**, because "steady" and "streaming" exercise completely different code paths (cache hit vs cache invalidation).
- Edge cases / failure handling: the layout mirrors the real app's shape rather than a synthetic one, so the numbers mean something.
- Surprising: the benchmark uses the real `Markdown` component with 2500 instances — the only place in the package where the renderer's scaling limits are actually probed.

### packages/tui/test/render-churn-bench.ts
- Purpose: an allocation-churn benchmark for the alt-screen renderer.
- Key abstractions: `NullTerminal` (counts bytes); `EditorSim` (a cached stand-in for the editor); the V8 `Session` from `node:inspector/promises`.
- Data flow: `HeapProfiler.startSampling` → 300 frames → `stopSampling` → sum the sampled allocation sizes.
- Non-obvious design decisions: the profiler is configured with `includeObjectsCollectedByMajorGC` and `includeObjectsCollectedByMinorGC` so the number measures **churn, not retention** (`:128-133`).
- Edge cases / failure handling: two scenarios are run — `static` (pure recomposite churn) and `editor` (one character appended per frame).
- Surprising: the result is reported as KiB/frame *and* bytes-written/frame, so an allocation regression and an output regression are visible side by side.

### packages/tui/test/viewport-overwrite-repro.ts
- Purpose: a manual reproduction of a viewport-overwrite bug.
- Key abstractions: a `Lines` component; `streamLines`.
- Data flow: stream more lines than the viewport → a tool-call pause → tool output → post-tool streaming.
- Non-obvious design decisions: the header documents the *expected* behaviour and the *actual* behaviour side by side, and how to reproduce it reliably (a small terminal or a tmux session of 12 rows).
- Edge cases / failure handling: the script restores the terminal in a `catch` and on error.
- Surprising: a manual repro is kept in the tree as documentation of a class of bug (content exceeding the viewport then resuming).

## Ideas worth stealing

- **Chunked terminal output that can never exceed the engine's max string length, and never splits a surrogate pair** — `packages/tui/src/tui-main-screen.ts:18` (class `BoundedTerminalWriter`) and `packages/tui/src/tui-main-screen.ts:41-49` (the surrogate-pair back-off). The writer accumulates at most 1 MiB and flushes; when a chunk boundary would land between a high and a low surrogate it moves the boundary back one unit. *Why it transfers:* any streaming renderer (SSE-to-terminal, a live dashboard) can produce a frame larger than V8's ~512 MB string limit or the terminal's buffer, and splitting a surrogate pair produces a lone surrogate that renders as a replacement character. August's own transcript renderer would hit the same wall on a long tool output.

- **Keyboard input must preempt the render throttle** — `packages/tui/src/tui.ts:1153-1155`. After a keystroke the TUI calls `requestImmediateRender()` instead of the 16 ms `scheduleRender()` path, with the reason stated inline: "even setTimeout(0) can take a full 16 ms tick on Windows". *Why it transfers:* August's chat UI and the harness's own TUI both face the same Windows timer coarsening; a keystroke that waits for a 16 ms frame feels broken even though the frame budget looks generous.

- **The cursor is a protocol, not a coordinate** — `packages/tui/src/tui.ts:196` (`CURSOR_MARKER`), `packages/tui/src/tui.ts:205` (`renderFakeCursor`), `packages/tui/src/tui.ts:1479` (`extractCursorPosition`), `packages/tui/src/tui.ts:1504` (`resolveFakeCursors`). A focused component emits a zero-width APC marker at the cursor; the renderer finds it, computes the *visible* column from the text before it, strips it, and moves the hardware cursor there. The fake cursor is a second marker pair that the renderer converts to reverse video (or drops when the hardware cursor is shown). *Why it transfers:* a component that knows its own cursor column should not have to know the terminal width, the padding, or the ANSI codes. It also keeps IME candidate-window placement correct, because the terminal positions the *hardware* cursor, not a drawn one.

- **The framework owns the terminal's reply channel, so replies never reach the user** — `packages/tui/src/tui.ts:1081-1109` (`handleTerminalInput`) and `packages/tui/src/tui.ts:1159-1235` (the OSC colour / colour-scheme / cell-size consumers). Every byte from stdin is checked against the pending terminal queries *before* it is treated as user input. *Why it transfers:* the CHANGELOG 1.2.0 entry "fragmented terminal color replies leaking hex values into the prompt and triggering the external editor" is exactly the failure August would hit the first time it queries the terminal for its theme. The general rule: **a component that issues a terminal query must own the reply routing for that query**, or the reply is user input by accident.

- **Negotiate a terminal protocol with a sentinel that every terminal answers, not with a timeout** — `packages/tui/src/terminal.ts:278-306` (`queryAndEnableKittyProtocol`) and `packages/tui/src/terminal.ts:308-336`. The request is "enable these flags, tell me what you have" followed by a primary device-attributes query; the DA1 reply is the end-of-replies marker, because every terminal answers DA1 even when it ignores the rest. A split reply is buffered and flushed as *input* after 150 ms rather than misparsed (`:339-388`). *Why it transfers:* August must detect provider/terminal capabilities at startup. A timeout-based handshake is slow in the common case and wrong in the slow-link case; a sentinel-based one is immediate and self-terminating. The same "a query has an explicit terminator" shape works for HTTP long-polling or MCP capability handshakes.

- **A keybinding table where the *action id* is the type, not the key** — `packages/tui/src/keybindings.ts:7-59` (the declaration-merging interface) and `packages/tui/src/keybindings.ts:243-268` (`rebuild`). Every action has a stable id; the keys are data. A user rebind replaces one action's keys and cannot evict another action's defaults, because the eviction logic only ever considers *user* claims — and a conflict between two user claims is **reported** (`getConflicts`, `:286-288`) rather than silently resolved. *Why it transfers:* August's keybindings (and the harness's) should be addressable by action id in config, in docs, and in diagnostics, and a user override should never silently disable a *different* action. `test/keybindings.test.ts:49-80` pins both halves.

- **A layout tree with clip rectangles and a per-(component,width) render cache** — `packages/tui/src/layout.ts:16-42` (`LayoutBox` with `rect` + `clip`) and `packages/tui/src/layout.ts:68-81` (`renderCached`). The cache is keyed by component *and* width, so a re-layout at the same width reuses the identical string arrays and the cache check is an identity comparison. Clips are intersected down the tree, so a child that overflows is clipped rather than spilled. *Why it transfers:* a transcript UI with a scrolling region, a dock and an overlay needs clipping, hit-testing and caching to agree; deriving all three from one tree is much cheaper than maintaining them separately.

- **Flex-style grow/shrink where shrinkage is weighted by size** — `packages/tui/src/components/stack.ts:95-133` (`distribute`) and `packages/tui/src/components/stack.ts:135-154` (`allocateStackSizes`). Growth is weighted by the `grow` factor; shrinkage is weighted by `shrink * max(1, size)`, so a *large* pane gives up more room than a small one. Each step moves at least one unit and the loop terminates when no candidate can absorb more. *Why it transfers:* August's workbench has a transcript pane, a tool pane and a status bar; a deterministic allocator (pinned by `test/layout.test.ts`) means the layout cannot jitter between frames as content changes.

- **A large paste becomes a marker that the *segmenter* treats as one grapheme** — `packages/tui/src/components/editor.ts:1301-1316` (the marker) and `packages/tui/src/components/editor.ts:49-101` (`segmentWithMarkers`). A paste over 10 lines or 1000 characters is stored out of band and replaced in the buffer by `[paste #N +M lines]`; the segmenter merges a marker whose id is valid into a single atomic segment, so arrow keys, backspace, word motion and word wrap all treat it as one unit. The real text is expanded only at submit (`:1364-1378`). *Why it transfers:* the same trick applies to any large payload in a text surface — a pasted file, a giant tool result — and it keeps the *rendered* surface small while the user is still editing. The "valid id" check is the important part: hand-typed marker-like text must not become atomic (`test/editor.test.ts:4051`).

- **An async provider's stale response is dropped by a snapshot check, not only by an abort** — `packages/tui/src/components/editor.ts:2287-2339` (request token, debounce, serialised chain) and `packages/tui/src/components/editor.ts:2416-2430` (`isAutocompleteRequestCurrent`). The staleness test compares the request id, the abort signal, the *text*, the cursor line and the cursor column against the snapshot taken before the request. *Why it transfers:* any August surface that lets a model or a tool stream results into a buffer needs the same guard. Abort alone is insufficient: a provider that ignores the signal, or a race between two providers, will still write into a buffer that has moved on. The text snapshot is the strongest of the three checks.

- **Search the *rendered* screen with an ASCII fast path, and map matches back to columns** — `packages/tui/src/alt-screen-search.ts:34-106` (`buildSearchCorpus`) and `packages/tui/src/alt-screen-search.ts:116-180` (`findSearchCorpusMatches`). The corpus strips ANSI and records a span map from flat-text offsets to (row, column); the ASCII path indexes whole non-space runs at once because "Rendered transcripts are overwhelmingly ASCII", and only the non-ASCII path segments per grapheme. *Why it transfers:* a transcript search over a 2 500-message screen is O(screen) per keystroke; the fast path is what makes it affordable, and the span map is what makes highlighting land on the right *column* (not the right character) in a proportional-width grid.

- **A scrollbar that is `hidden | auto | always` and a follow-end mode that turns itself off when the user scrolls away** — `packages/tui/src/components/scroll-view.ts:34-35` (`followSuppressedAtEnd`) and `packages/tui/src/components/scroll-view.ts:70-83` (`isScrollbarVisible`). Follow-end is sticky in both directions — it disengages on a user scroll and re-engages when the user returns to the end — and `ScrollViewScrollToOptions.disableFollow` lets a programmatic scroll to the end *not* re-arm it. *Why it transfers:* August's transcript view has the same problem (a streaming response should keep the viewport pinned until the user scrolls up). The explicit `disableFollow` escape hatch is what stops a "scroll to bottom" button from stealing the user's place.

- **Wheel acceleration driven by event velocity, with a burst guard** — `packages/tui/src/wheel-scroll.ts:35-74`. A "burst" (events under 5 ms apart) is one physical notch and never accelerates; a gesture ends after 200 ms or a direction change; the line count is `min(6, max(1, 100/averageGap))` with the fraction carried between events; and macOS local terminals are excluded because the OS already accelerates the wheel there. *Why it transfers:* any scrollable pane in a desktop web view has the same problem, and the OS-level-acceleration exclusion is the detail that is usually missed — the same wheel feels completely different on macOS and on Linux.

- **The native helper is resolved at runtime, so the package has no link-time dependency on the runtime** — `packages/tui/native/napi.h:48-58` (`node_symbol` via `dlsym` / `GetProcAddress`) and `packages/tui/native/darwin/build.sh:52-56` (`-undefined dynamic_lookup`). The header comment states the intent: "Resolve the small N-API surface we use from Node or Bun, without Node headers or a link-time dependency on a particular runtime." *Why it transfers:* if August ever needs a native capability (clipboard, key state, a file dialog) in a bundled desktop app, this is the whole pattern — a hand-rolled, symbol-resolved subset instead of `node-gyp` and Node headers.

- **A native helper that can never block the runtime's thread pool** — `packages/tui/native/linux/src/clipboard-worker.h:41-70`. The blocking X11 read runs on a *private detached thread*; the caller waits on a condition variable with a 3 s deadline (deliberately longer than the 2 s transfer deadline so the transfer's own error surfaces first); concurrent callers get "unavailable" immediately rather than queueing; and a result that arrives after the caller gave up is freed, not leaked. The build passes `-Wl,-z,nodelete` because "A timed-out private thread may outlive the Node environment that loaded us". *Why it transfers:* this is the exact shape August needs for any slow external resource (a shell, a DB, a network call) invoked from a desktop app: bound the wait, refuse rather than queue, and never leak the late result.

- **Assert on the terminal emulator's *cells*, not on the string you wrote** — `packages/tui/test/tui-overlay-style-leak.test.ts:36-44` (`getCellItalic` reads `cell.isItalic()` out of xterm's buffer) and `packages/tui/test/markdown.test.ts:15-23` (the same `getCell` helper). The assertion is about the *rendered grid*, which is the only place a style leak, a truncated bold run or a CJK width bug is actually observable. *Why it transfers:* August's own `check:truncate` gate works on the AST because there is no terminal; pi's equivalent is "render into a real emulator and read the cells". That is a much stronger oracle than string matching and it directly found the "bold and italic next to CJK punctuation" bug.

- **Assert that chunking a large render does not change its output** — `packages/tui/test/tui-render.test.ts:167-225` ("TUI bounded render output"). The test renders the same content with and without the 1 MiB chunking and asserts the emitted bytes are identical. *Why it transfers:* any optimisation that splits a payload (chunking a websocket frame, batching a DB write) should come with a "the bytes are the same" test; without it, the chunk boundary becomes a silent corruption site.

- **A benchmark that measures churn, not retention** — `packages/tui/test/render-churn-bench.ts:128-133` (the V8 sampling heap profiler with `includeObjectsCollectedByMinorGC` and `includeObjectsCollectedByMajorGC`) and the two scenarios (`:191-194`). *Why it transfers:* a TUI that re-renders at 60 fps will *retain* little and *churn* a lot; a memory measurement that only looks at RSS will not see it. August's desktop shell has the same profile.

- **A regression test that reproduces the *old* implementation so the bug stays documented** — `packages/tui/test/bug-regression-isimageline-startswith-bug.test.ts:38-56` (a local `oldIsImageLine` reimplementation) and `packages/tui/test/regression-regional-indicator-width.test.ts:6-16` (the streaming-drift rationale in the comment). *Why it transfers:* the August notes already use this style ("the shipped pairing test passed because it called the compressor WITHOUT `pin_predicates`"). A test that only asserts the new behaviour cannot tell a reader *what* was broken.

- **The `undefined` vs `null` distinction carried from a C enum to the JS promise** — `packages/tui/native/clipboard.h:11-20` (`clipboard_format`: `UNAVAILABLE` vs `EMPTY`) and `packages/tui/src/native-platform.ts:9-18` (the same three states in the TypeScript contract: "Undefined means unavailable, null means no text; transfer failures reject"). *Why it transfers:* "the feature is not available here" and "the resource is empty" are different answers and a caller that cannot tell them apart will retry a capability that does not exist. August's provider registry has exactly this distinction to make.

- **A "the tool must not block the event loop" assertion embedded in the fixture itself** — `packages/tui/test/fixtures/clipboard-reader.cjs:26` (a 10 ms timer must tick more than 5 times in 200 ms) and `packages/tui/test/fixtures/clipboard-worker-test.cjs:46-56` (20 concurrent reads must resolve promptly and filesystem I/O must stay available). *Why it transfers:* the assertion lives with the probe, so every test that uses the probe inherits it, and the "20 concurrent calls all return undefined" check is a precise statement of the "refuse rather than queue" policy from the JS side.

- **Include the production C source in the test fixture with the allocators redefined** — `packages/tui/test/fixtures/clipboard-worker-test.c:20-24` (`#define calloc tracked_calloc` before `#include "../../native/linux/src/clipboard-worker.h"`) and `packages/tui/test/fixtures/clipboard-x11-test.c:41-45` (the same trick for `realloc`/`free`). The fixture exercises the *real* worker with a controlled blocking callback, and the allocation counters make a partial-transfer leak deterministic ("unlike RSS"). *Why it transfers:* it is the cheapest possible way to test a C/C++ path without a separate build system or a mocking framework — and it is exactly what August's `code_runner.py` port of a Python guard would need an equivalent for.

- **A protocol-conformance encoder: control characters are removed because the terminal discards the whole report** — `packages/tui/src/program-status.ts:45-52` and `packages/tui/src/program-status.ts:32-43` (the UTF-8-boundary truncation to 2048 bytes, chosen so the base64 stays under the spec's 2732-byte limit). *Why it transfers:* the same "one bad byte loses the whole message" reasoning applies to any status/telemetry channel August might open to an IDE or a shell integration. The base64 + byte-limit pattern is directly reusable.

- **Probe the multiplexer instead of guessing what it forwards** — `packages/tui/src/terminal-image.ts:54-68` (`probeTmuxHyperlinks` runs `tmux display-message -p '#{client_termfeatures}'` with a 250 ms timeout and falls back to `false` on any error). *Why it transfers:* capability detection by environment variable is a guess; a cheap runtime probe is a fact. The same move is available for August's own "is this running inside tmux / inside a Tauri webview / inside a VS Code terminal" questions.

- **A fuzzy matcher that retries the query with its letters and digits swapped** — `packages/tui/src/fuzzy.ts:76-93`. "codex52" matches "gpt-5.2-codex" because the query is tried both ways at a +5 penalty, and `fuzzyFilter` splits on whitespace **and slashes** and requires every token to match (`:100-137`). *Why it transfers:* August's model picker has ids like `gpt-5.2-codex` and providers like `openai-codex`; the slash-separated multi-token filter is exactly the "provider/model" query shape, and the swapped-alnum retry handles the "which was the version, which was the name" ambiguity for free.

- **Escape every segment of a path before handing it to an external search tool** — `packages/tui/src/autocomplete.ts:21-44` (`buildFdPathQuery` escapes each segment and joins them with `[\\/]`). The changelog records the bug this fixed: "`@` file autocomplete returning no results for queries containing regex metacharacters such as `[` or `(`". *Why it transfers:* August shells out to `fd`/`rg` for file search. Passing a user-typed path into a regex is an injection *and* a correctness bug; building the pattern segment-by-segment is the fix.

- **A prefix that survives quoting, wrapping and cursor bookkeeping** — `packages/tui/src/autocomplete.ts:116-135` (`parsePathPrefix` keeps the opening quote in the prefix) and `packages/tui/src/autocomplete.ts:412-497` (`applyCompletion` adjusts the cursor for a trailing quote, distinguishes a slash *command name* from a command *argument* from an `@file` mention, and does not add a space after a directory). *Why it transfers:* completion in a live buffer is a text-rewriting problem, not a "replace the word" problem; the four cases (command / argument / mention / path) each need a different rewrite, and the cursor offset must be recomputed for each.

- **A flash-message container whose timers are `unref()`ed** — `packages/tui/src/components/alt-screen-flash.ts:22-36`. The container renders *nothing* into the layout; the renderer composites it separately, so a transient message never perturbs the layout tree. *Why it transfers:* a toast in August's chat surface should not reflow the transcript. The `unref()` is the small detail that stops a pending toast from holding a process open.

- **A packaging constraint can be pinned by a test that reads the shipped binary's own header** — `packages/tui/test/native-platform.test.ts:8-27` parses the ELF program headers of `native/linux/prebuilds/linux-arm64/linux-platform-x11.node` and asserts every `PT_LOAD` segment is 64 KB-aligned, because a system with 64 KB pages otherwise refuses to load the module. I verified the same property independently on the file in this shard. *Why it transfers:* the failure this prevents is invisible in CI on a 4 KB-page machine and only appears on a user's aarch64 Linux box. A test that reads the shipped artefact's own header turns a packaging rule into a checked invariant — the same trick applies to any prebuilt binary August ships.

- **A protocol-negotiation reply that is buffered and re-flushed as *input* rather than misparsed** — `packages/tui/src/terminal.ts:339-388` and `packages/tui/src/stdin-buffer.ts:29` (`TERMINAL_REPLY_HEADER_PATTERN`, which keeps a partially-received OSC/DCS/APC reply from being delivered as a batched Alt keystroke). *Why it transfers:* any code that reads a multiplexed byte stream has to decide "is this a partial reply or user input?" and the safe answer is to *keep buffering* until the header is complete. The 150 ms flush is the escape hatch that keeps a real keystroke from being swallowed.

- **A defensive clone-on-push undo stack** — `packages/tui/src/undo-stack.ts:10-19`. `push` stores a `structuredClone`; `pop` returns the stored snapshot *without* re-cloning, because it is already detached. *Why it transfers:* an agent harness that offers "undo this tool call" or "revert this edit" wants the same semantics: the snapshot is a fact at push time, not a live view.

## Files skipped (with reasons)

- `packages/tui/native/darwin/prebuilds/darwin-arm64/darwin-platform.node` - a **compiled Mach-O 64-bit arm64 addon** (52 024 bytes, magic `cf fa ed fe`, cputype `0x0100000c`) built from `native/darwin/src/darwin-platform.m`. I opened its header and scanned its byte strings to confirm what it is: the exports `napi_register_module_v1`, `getText`, `getImage`, `setText`, `getFilePaths`, `isModifierPressed` and the AppKit/`NSPasteboard` references are all present. Not read line by line because it is a compiled binary with no source of its own — the readable form of the same code is the `.m` file in this shard.
- `packages/tui/native/darwin/prebuilds/darwin-x64/darwin-platform.node` - the **Intel build** of the same source (Mach-O 64-bit, cputype `0x01000007`, 22 784 bytes, same six exports). Not read line by line for the same reason.
- `packages/tui/native/linux/prebuilds/linux-arm64/linux-platform-x11.node` - a **compiled ELF 64-bit LSB aarch64 shared object** (67 240 bytes, `e_machine` `0xb7`) built from `native/linux/src/linux-platform-x11.c`; exports `napi_register_module_v1`, `getText`, `getImage`, resolves `libxcb`/`pthread` at runtime, and has **no** `setText` export. I additionally parsed its ELF program headers and confirmed both `PT_LOAD` segments are 64 KB-aligned, which is the constraint `packages/tui/test/native-platform.test.ts:8` pins. Not read line by line because it is a compiled binary.
- `packages/tui/native/linux/prebuilds/linux-x64/linux-platform-x11.node` - the **x86-64 build** of the same source (ELF 64-bit, `e_machine` `0x3e`, 18 008 bytes, same three exports). Not read line by line for the same reason.
- `packages/tui/native/win32/prebuilds/win32-arm64/win32-platform.node` - a **compiled PE/COFF Windows arm64 DLL** (9 216 bytes, `MZ` header) built from `native/win32/src/win32-platform.c`; exports `napi_register_module_v1`, `getText`, `getImage`, `setText`, `isModifierPressed` and `enableVirtualTerminalInput`, and resolves the N-API surface through `GetProcAddress`. Not read line by line because it is a compiled binary.
- `packages/tui/native/win32/prebuilds/win32-x64/win32-platform.node` - the **x64 build** of the same source (PE/COFF, 8 704 bytes, same seven exports). Not read line by line for the same reason.

Every other file in the shard — all 119 text files, ~1.5 MB — was opened and read. Six large source files were read in full across multiple passes rather than in a single read (`packages/tui/src/tui.ts` 1543 lines, `packages/tui/src/tui-alt-screen.ts` 1797, `packages/tui/src/components/editor.ts` 2473, `packages/tui/src/utils.ts` 1402, `packages/tui/src/keys.ts` 1455, `packages/tui/src/latex.ts` 1506). The largest test files (`packages/tui/test/editor.test.ts` 4380 lines, `packages/tui/test/tui-alt-screen.test.ts` 2100, `packages/tui/test/markdown.test.ts` 1865, `packages/tui/test/overlay-non-capturing.test.ts` 1203, `packages/tui/test/terminal-image.test.ts` 942, `packages/tui/test/autocomplete.test.ts` 853, `packages/tui/test/keys.test.ts` 647) were read at the head plus a complete inventory of their `describe`/`it` names, and the sections that carry a mechanism were read directly; their per-test bodies are not individually transcribed above.

## Uncertainties

- **The manifest was re-split while I was working, and the final state confirms this file list.** When I first read `manifest.tsv`, the 125 files under `packages/tui/` were owned as 119 × `packages-tui-01`…`-04` plus 6 × exactly `tui` (the compiled prebuilds), so "owner-shard is exactly `tui`" would have meant only those 6 binaries — far below the 30-260 files the brief expects for a shard. On a re-read near the end, **all 125 rows carry owner-shard exactly `tui`**, and my ledger matches that set with zero missing, zero extra and zero duplicate rows. So the shard is the whole `packages/tui` package, which is what I read. I flag it because the earlier split is still visible in sibling artefacts (`docs/research/pi/shards/packages-tui-01.filelist.tsv` … `-07.filelist.tsv`), and the lead may want to reconcile those against the current manifest.
- **The `packages-tui-0N` filelists that exist in the output directory are from the earlier split and do not match the current manifest** (40 + 28 + 31 + 20 + 14 + 21 + 16 = 170 lines across seven files, against 119 source files in the old `packages-tui-01..04` ownership and 125 in the current one). I did not read or reconcile them — they belong to other shards — but the lead should know they predate the current manifest and will not merge cleanly without a re-split.
- **The `packages-tui-0N` sub-splits do not correspond to a thematic split.** In the manifest snapshot I first read, the `packages-tui-01`…`-04` ownership (40 / 28 / 31 / 20 files) each spanned source, test and native files, which is consistent with a size-balanced split rather than "source / tests / native / docs". The lead has since merged all of them into a single `tui` shard, so this is now historical; I checked the owner-shard values only, not the lead's splitting algorithm, which is not recorded in the manifest.
- **The manifest's `type` column labels `packages/tui/CHANGELOG.md` and `README.md` as `docs` and the four `native/**/README.md` files as `docs`; I read all of them.** The only non-text files in the shard are the six `native/*/prebuilds/**/*.node` binaries, which the manifest labels `source` (not `generated-vendored`); I opened each one's header and symbol table, identified it, and marked it `skipped` with that reason in the ledger.
- **`packages/tui/src/tui-alt-screen.ts` is the file I understood least completely.** I read it in three passes (1-700, 701-1400, 1400-1797) but the middle section (roughly lines 790-1380: the scroll-view routing, the search overlay, the `scrollToPrompt` implementation and the Kitty image cache eviction) is the part I read most quickly. I know its *shape* from the surrounding code and from `packages/tui/src/alt-screen-search.ts`, but I did not trace every branch, so a defect in that band would not be visible in my notes. What I checked: the render pipeline at `:1690-1796`, the input routing at `:691-790`, the selection code at `:1412-1472` and `:1582-1646`, and the `doRender` composition order.
- **I did not establish how `TuiAltScreen` chooses between the "implicit scroll view" and an explicit `setLayoutRoot` tree** beyond reading `doRender` (`:1694`, `this.layoutRoot ?? this.implicitScrollView`). The `layout.ts` reading covered `renderLayoutFrame`, `getScrollViewsAt`, `getScrollViewBox` and `getScrollbarGeometry`; the exact selection rule lives in the part of `tui-alt-screen.ts` I skimmed.
- **The `Markdown` component's rendering of every token type is only partly characterised.** I read the tokenizer extensions (the strict strikethrough tokenizer at `markdown.ts:10-25`, the LaTeX tokenizer at `:53-100`, the GFM-table guard at `:102-110`) and the token renderer (`:486-560`, `:1020-1046`), but the per-token cases in between were not individually traced.
- **`packages/tui/src/latex.ts` between lines 450-600 and 1020-1380 is a symbol table and command dispatch** that I read as data rather than as logic; I characterised the parser's *structure* (`:838-1477`) and the layout engine (`:667-836`) but did not verify each `\command` mapping.
- **I could not confirm whether the four `packages-tui-0N` sub-shards correspond to a deliberate split (source / tests / native / docs) or to an arbitrary round-robin.** The file counts and the sizes are consistent with an arbitrary split: `packages-tui-01` has 40 files, `-02` 28, `-03` 31, `-04` 20, and each spans source, test and native. I checked the owner-shard values only, not the lead's splitting algorithm, which is not in the manifest.
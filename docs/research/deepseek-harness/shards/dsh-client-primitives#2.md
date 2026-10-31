# deepseek-harness / dsh-client-primitives#2

## Shard shape

This shard is the whole of `packages/client/ui-primitives` — 252 files, ~1.42 MB — the **browser-side presentation library** for the dsh web client. It is a Cordis-free, slot-free package of pure React atoms styled only through `--dsw-*` design tokens: standard controls (Button, Switch, Checkbox, Input, Pill, Tag, SegmentedControl/Tabs, Menu, Modal, Tooltip, HoverCard, Toast, StateDot, DisclosureRow, TextShimmer), a 188-component icon catalogue, and — the substantive half — the **renderers for untrusted model output**: a hand-written mdast→React markdown pipeline with an *incremental* streaming parser (`src/markdown/`), a KaTeX arm, a shiki syntax highlighter with lazy grammar loading, an ANSI terminal-output replayer, and the five "tool result" cards (`TerminalBlock` = run_command, `ReadBlock` = read_file, `DiffBlock` = edit, `SearchBlock` = grep/glob, `WebBlock` = web_search/web_fetch) plus a read-only `JsonTree`. A staged settings-form model (`src/settings-form/`) is the only non-visual subsystem.

**What this shard is NOT.** It contains no agent loop, no tool-calling dispatch, no prompt assembly, no context compaction, no memory/learning mechanism and no subagent orchestration — the package says so itself (`README.md:189`: "None, as the package is a browser-side UI plugin layer that registers nothing model-facing"; `README.md:193`: "None; this package neither assembles nor sends a provider request"). Those lenses are covered by other shards. What this shard *does* own is the **rendering contract** that a streaming agent loop must satisfy: what an append-only assistant message may look like at every chunk, how a half-formed code fence or TeX formula may be shown, how tool output is reduced to a bounded card, and how the DOM is kept stable while it grows.

The through-line of the shard is **stability under streaming**: frozen markdown blocks, stable React keys, streaming-vs-settled grammar pairs, DOM-snapshot fixtures as a compatibility baseline, and a one-line geometry model (head+tail slice behind an expand button) shared by every output card.

---

## Per-file notes

### packages/client/ui-primitives/package.json
- Purpose: package manifest for `@deepseek-ai/dsh-client-ui-primitives` v0.2.1-rc.2.
- Key abstractions: ESM; `exports` publishes the built `lib/index.js` **and** the raw `./src/*` tree so consumers can reach individual modules; `peerDependencies` on `@deepseek-ai/cordis` `workspace:~`.
- Data flow: none (configuration).
- Non-obvious design decisions: every heavy dependency (`shiki`, `katex`, `micromark-*`, `anser`, `simple-icons`, `diff`) is a **devDependency**, not a dependency — the shipped static ESM keeps third-party imports external and the Web shell supplies them.
- Edge cases / failure handling: n/a.
- Surprising: `files` ships `lib/**/*.css` — the CSS modules are part of the public artifact.

### packages/client/ui-primitives/README.i18n.yaml
Per-heading bilingual pairing hashes (en/zh) for `README.md`, re-recorded with `pnpm run verify-translation-pairing --write`; the pairing is a gate, not a convention.

### packages/client/ui-primitives/README.md
- Purpose: the package's 221-line contract document.
- Key abstractions: a component catalogue table, four behaviour sections (controls/icons, rendering agent output, source map, input modality, streaming markdown, geometry and overflow) and an explicit "Known Limitations" list.
- Data flow: n/a (docs).
- Non-obvious design decisions: the limitations list is written as *current package constraints*, not a roadmap — e.g. "Overlong lines stay uncolored" (a ≥1000-UTF-16-unit line renders plain because TextMate scan cost grows superlinearly), "A long highlighted fence retains its complete token DOM", "Streaming defers cross-boundary reference resolution".
- Edge cases / failure handling: documents that `TerminalBlock` is **not** a terminal emulator — absolute cursor positioning, screen clearing and alternate-screen sequences are stripped.
- Surprising: the doc records the *rationale* for two “four easy-to-confuse groups" (`Tag` vs `Pill`; `Pill` vs `SegmentedControl`; `DisclosureRow` vs cards; `FoldToggle` vs the public export surface).

### packages/client/ui-primitives/README.zh.md
The Chinese counterpart of the above, structurally identical and hash-paired with it; carries the same behaviour notes (input modality, streaming markdown, geometry) in Chinese.

### packages/client/ui-primitives/src/ansi.ts
- Purpose: the terminal-output parser behind `TerminalBlock` — a **terminal-accurate** ANSI replayer, not a regex highlighter.
- Key abstractions: `AnsiSpan`/`AnsiLine` (text + resolved `CSSProperties`); `SgrState` = `{fg, bg, attrs}`; `Cell` = one column's character plus the SGR state it was written with; `replayLine` paints a line into a column buffer.
- Data flow: raw output → `sanitize` (drop OSC + non-CSI escapes) → `applyCursorMovements` (per line: CR/BS/tab/erase-in-line replayed into a column buffer, SGR folded across lines because a newline does not reset it) → `anser.ansiToJson` → per-line styled spans → React.
- Non-obvious design decisions: **the state is normalised, not accumulated** — `foldSgr` keeps "current state" rather than "the sequence history" (`ansi.ts:141-149`), because accumulating made every state boundary re-emit the whole chain: *"output that switches color without a full reset emitted O(n²) characters (3200 such cells produced 25 MB and eventually a `RangeError`)"*. `openSgr` emits **one canonical sequence per state** so the output stays linear in cell count. Each cell is stamped with the state **at the moment it was written**, so a later redraw cannot restyle cells it does not reach (`100%\rOK` shows `OK0%`; `red bad` + 3 backspaces + `ok` shows `okd` with the `d` still red). Wide characters occupy two columns with a `spacer` partner that is blanked rather than closed when the lead is overwritten.
- Edge cases / failure handling: `TAB_WIDTH = 8` tab stops; zero-width marks attach to the preceding cell; CSI `K` erase-in-line with `1`/`2`/default modes (only the **first** parameter selects the mode, per spec); a line needing no replay skips the column buffer entirely so an `ls -R` or a 5k-line log does not allocate a cell per character; the final state converges to the state the *scan* ended in, so a trailing `\x1b[0m` does not leak its colour into the next line.
- Surprising: the basic 8/16 colours are mapped onto **theme tokens**, and black *and* white both resolve to `--dsw-alias-label-primary` so terminal text stays legible under either theme (`ansi.ts:45`); 256-palette and truecolor fall through to literal rgb because the design system has no equivalent.

### packages/client/ui-primitives/src/BrandWordmark.tsx
Brand wordmark SVG (whale mark + type) at viewBox `0 0 182 24`, `currentColor` with one inverted-colour badge; `includeMark` toggles the leading mark and the viewBox.

### packages/client/ui-primitives/src/Button.module.css
Button variant/size rules on `--dsw-alias-button-*` and `--dsw-radius-*`; `.md` 36px, `.sm` 28px.

### packages/client/ui-primitives/src/Button.tsx
`forwardRef` button atom; variants `primary|ghost|outline|toolbar`, sizes `md|sm`, optional 16px leading icon; native attributes pass through so the ref is the real `<button>` (used for focus management and overlay anchoring).

### packages/client/ui-primitives/src/Checkbox.module.css
Label-wrapped checkbox styling with a native `accent-color` and an explicit focus ring.

### packages/client/ui-primitives/src/Checkbox.tsx
Controlled native `<input type="checkbox">` inside a caller-owned `<label>`; fully controlled, no local state.

### packages/client/ui-primitives/src/clipboard.ts
`writeClipboard(text): Promise<boolean>` — prefers `navigator.clipboard.writeText`, falls back to a detached `readonly` textarea + `document.execCommand('copy')` for jsdom/insecure contexts, and **returns false rather than claiming success** when the host refuses (permission denied, iframe policy, or a missing API).

### packages/client/ui-primitives/src/code-file-icon-artwork.manifest.json
Provenance manifest: two `internal-design-export` sources with sha256 digests, covering exactly the 48 code icon categories, plus `excluded: ["markdown"]` — a closed, auditable artwork set.

### packages/client/ui-primitives/src/code-file-icon-artwork.ts
*Vendor artwork blob — see "Files skipped".* Contract read: a frozen 48-key map of embedded SVG markup with a `CODE_FILE_ICON_ID_TOKEN` placeholder replaced per React instance.

### packages/client/ui-primitives/src/code-file-types.ts
`CODE_FILE_TYPES` (48 categories) plus the classification tables: exact filename → prefix → suffix → optional project context → extension. Context-sensitive rule: a `.dart` file becomes `flutter` only when the supplied project snapshot contains a `pubspec.yaml` with `flutter:`.

### packages/client/ui-primitives/src/code-highlighting.ts
Re-exports `CODE_HIGHLIGHT_EXTENSIONS` / `languageForPath` from `@deepseek-ai/dsh-util-code-language` (the **one shared table**, also behind the Host read card) and binds `useCodeHighlighter` to the lazy shiki singleton via `useSyncExternalStore`.

### packages/client/ui-primitives/src/CodeCard.module.css
Shared code-card chrome: banner, icon actions, code body font, scroll rules, the counter-based line-number gutter.

### packages/client/ui-primitives/src/CodeFileIcon.tsx
Renders one embedded code-file SVG via `dangerouslySetInnerHTML`, substituting a per-instance id (`useId`) so `url(#gradient)` references resolve to that instance rather than the first one on the page.

### packages/client/ui-primitives/src/CodeToolbar.tsx
Shared code-card header: language label (or a fallback title when the language is unsupported), a wrap toggle (`aria-pressed`) and a copy button, each wrapped in a `Tooltip`.

### packages/client/ui-primitives/src/CommandText.module.css
Horizontal scrollport rules for command text (`white-space: var(--dsl-command-whitespace, pre)`), with a focus ring for the focusable case.

### packages/client/ui-primitives/src/CommandText.tsx
Command text that becomes a **named, focusable group only while it overflows** (`tabIndex={overflow ? 0 : undefined}`), re-measures on resize and on `document.fonts` `loadingdone`, and never changes its scroll position across rerenders.

### packages/client/ui-primitives/src/ConfigField.module.css
Config-field layout with an `aria-invalid` border and an error note.

### packages/client/ui-primitives/src/ConfigField.tsx
Controlled config input: a `<select>` for finite choices (an empty choice means "inherit"), a `type=password` field for secrets, a `<textarea>` otherwise; plus a reset control and an invalid-draft note.

### packages/client/ui-primitives/src/ConnectionIndicator.module.css
Indicator styling for the disconnected/connecting/recovered phases and the leaving fade.

### packages/client/ui-primitives/src/ConnectionIndicator.tsx
Inline reconnect control: outage and retry are **one button whose static label already names the retry action**; recovered is a `role=status`; a 150 ms exit fade precedes unmount. Deliberately uses no native `title` tooltip.

### packages/client/ui-primitives/src/css-modules.d.ts
Ambient module declarations for `*.module.css` (default export `Record<string,string>`) and bare `*.css`.

### packages/client/ui-primitives/src/darwin-desktop.ts
`isDarwinDesktop()` reads `<html data-platform="darwin">`, set by the macOS Electron preload; read at render time because the mark may arrive as late as `DOMContentLoaded`.

### packages/client/ui-primitives/src/DiffBlock.module.css
Diff row styling: path/gap chrome, del/add colour plus an inset marker, and the `data-code-wrap` wrapping mode.

### packages/client/ui-primitives/src/DiffBlock.tsx
- Purpose: the edit/diff tool card.
- Key abstractions: `DiffHunk` = `{path, oldText|null, newText}`; a flat `DiffRow` list with kinds `path|del|add|context|gap`; `diffTotals` for the tool summary.
- Data flow: hunks → `structuredPatch` (3 context lines) → flattened rows → head/tail cap (default 16) → `FoldToggle`.
- Non-obvious design decisions: **`MAX_DIFF_EDIT_LENGTH = 256`** (`DiffBlock.tsx:70`) bounds the synchronous edit-graph search; beyond it the whole fragment is shown as one coarse replacement (both complete fragments, including shared lines) and counted that way, so a heavily rewritten file cannot stall the render.
- Edge cases / failure handling: `oldText: null` (a create) renders no removed side; a trailing newline is a **terminator**, not an extra blank line; two hunks in the same file get one path header plus a `⋯` gap row, two files get two headers.
- Surprising: `diffTotals` excludes shared context from the +/− totals, so the number in the tool summary is not the number of lines in the card.

### packages/client/ui-primitives/src/DisclosureRow.module.css
Disclosure-row rules on the shared font-size axis (`--dsh-content-font-size-secondary`, `--dsh-content-font-delta`), with the leading glyph scaling except `StateDot` (`:not([data-state])`).

### packages/client/ui-primitives/src/DisclosureRow.tsx
Memoised disclosure header (shallow prop comparison, so callers must keep callbacks and React-node props referentially stable): a leading icon that becomes a chevron on hover, a `TextShimmer` activity layer, an optional accessory outside the disclosure target, and two expansion policies (icon-only vs whole-row, which makes the row a `role=button`).

### packages/client/ui-primitives/src/file-size.ts
`fileSizeText(bytes)` — `312B` / `4.2KB` / `1.5MB` / `2.4GB`, one decimal below ten of the unit.

### packages/client/ui-primitives/src/FileTypeIcon.module.css
Per-category default palette for the traditional glyphs, overridable through a single `--dsh-file-type-icon-color` variable.

### packages/client/ui-primitives/src/FileTypeIcon.tsx
`classifyFileType` / `fileExtension` plus the traditional glyph dispatch; a resolved code category routes to the embedded full-colour `CodeFileIcon` instead.

### packages/client/ui-primitives/src/FishLogo.tsx
Fish silhouette: the path data is exported as `FISH_LOGO_PATH` (with its viewBox) so consumers can compose their own SVG around the same geometry.

### packages/client/ui-primitives/src/focus.ts
`focusWithoutRing(element, options?)` — focuses an automatic destination with the outline suppressed via a `data-dsh-automatic-focus` attribute the theme reads; the suppression releases on Tab/arrow navigation or blur. A `WeakMap` keeps one release closure per element.

### packages/client/ui-primitives/src/FoldToggle.tsx
Shared head-tail fold button: `aria-expanded` plus caller-localized collapse/expand copy that carries the hidden-row count.

### packages/client/ui-primitives/src/guide-artwork.tsx
Two fixed-palette ornamental SVGs (browser globe, folder) for sidebar guide entries, `aria-hidden`.

### packages/client/ui-primitives/src/head-tail-cap.ts
`headTailCap(total, maxLines, expanded)` — pure arithmetic for the shared head/tail split (`hidden`, `capped`, `headLines = ceil(maxLines/2)`, `tailLines`). The caller slices its own rows, so a block can layer its own concerns on top (SearchBlock restores a tail file header).

### packages/client/ui-primitives/src/HoverCard.module.css
Hover-card material, variant geometry (24px side insets, 420px cap) and the closing-fade rules.

### packages/client/ui-primitives/src/HoverCard.tsx
- Purpose: a hover-triggered, portaled preview card (compact beside the anchor, or a `preview` above/below it).
- Key abstractions: a `phase` state machine `closed | open | closing`; `usePointerGrace` for the dismissal delay; `HoverCardGroupContext` for shared dwell; a `copyEpoch`/`copyingRef` pair so an in-flight clipboard write cannot resurrect feedback after a close or unmount.
- Data flow: pointerenter → dwell timer → open → measure anchor + card → place → pointerleave → grace → closing → unmount.
- Non-obvious design decisions: the **pointer may rest on the card**, so a press inside the card starts a selection instead of dismissing it — capture-phase presses on the portaled card reach the wrapper's dismissal handler, and they must not close it or the first pointerdown of a text-selection drag would kill the card. Copy activation is suppressed when a non-collapsed selection intersects the card (and for any of Firefox's multiple ranges), but the sidebar activation still fires.
- Edge cases / failure handling: flipping `disabled` closes an open card; the bottom-edge clamp is re-run once the mounted card's height is measurable; the frame's `--dsh-frame-top-clearance` keeps a preview below the reserved strip.
- Surprising: `inline` previews open **only for keyboard focus**, not hover (a touch pointer event is ignored), so a prose link is not hijacked by a hover preview.

### packages/client/ui-primitives/src/HoverCardGroup.tsx
Group context that shares the **first-display dwell** across a physical list and the active portal: the first card pays the delay, later cards replace it instantly; a keyboard-opened card outside a pointer visit does not warm the next pointer visit; replacement removes a fading preview immediately.

### packages/client/ui-primitives/src/icons/index.tsx
*Skipped as huge — see "Files skipped".* Established from the head of the file, an export census and the sibling spec: a flat catalogue of **188 exported icon components** (94 artwork families × a Regular 1 px and a Medium 1.3 px export each), plus `ICON_REGULAR_STROKE` / `ICON_MEDIUM_STROKE` and a shared `SHIELD_OUTLINE_PATH` — 191 `export const` in all. 89 of the artwork shapes are defined locally as `const <Name>Artwork`; the other 6 are imported from `icons/shared-artwork.tsx`, and one local shape (`IconQueueOutlineArtwork`) is only a thin wrapper over the shared `ChatLinesOutlineArtwork`.

### packages/client/ui-primitives/src/icons/props.ts
`IconProps` = `{size?, className?}`; colour rides `currentColor`; `| undefined` on `className` so a caller can forward an optional class under `exactOptionalPropertyTypes`.

### packages/client/ui-primitives/src/icons/shared-artwork.tsx
Six shared currentColor SVG geometries (new-chat bubble, chat lines, globe, code brackets, browse-document, closed folder) reused by the product, link and reference icon families so the shapes cannot drift apart.

### packages/client/ui-primitives/src/ImageLightbox.module.css
Full-viewport backdrop and stage styling.

### packages/client/ui-primitives/src/ImageLightbox.tsx
Body-portaled image lightbox: focuses the close control, traps Tab on it, closes on Escape or backdrop press, and restores focus to the opener on unmount. Body-portaled so a transformed/filtered ancestor cannot trap the fixed backdrop.

### packages/client/ui-primitives/src/ImagePreview.module.css
Contained image frame plus loading/failed status styling.

### packages/client/ui-primitives/src/ImagePreview.tsx
Passive inline image preview with a loading/failed status and no second activation target; keyed by `src` so a new URL restarts the state.

### packages/client/ui-primitives/src/index.ts
The public barrel (119 lines) — every atom, its label types and the settings-form surface. The package's single public face.

### packages/client/ui-primitives/src/InlineEditor.module.css
Inline-editor textarea styling for the grow-to-six-lines behaviour.

### packages/client/ui-primitives/src/InlineEditor.tsx
Auto-growing `textarea` (a textarea, not an input, because HTML strips newlines from single-line values): Enter saves, Shift+Enter breaks the line, Enter **during IME composition does nothing** (`isComposing` or the legacy `keyCode === 229`), Escape cancels. The height refit subtracts the border (`scrollHeight + offsetHeight - clientHeight`) and a `ResizeObserver` re-fits on width change.

### packages/client/ui-primitives/src/input-modality.ts
- Purpose: document-wide pointer-vs-keyboard modality, published as `data-input-modality` on `<html>`.
- Key abstractions: `pointerModality()` (last input was a pointer) and the published attribute (whether a focus **ring** should show).
- Data flow: `pointerdown` → pointer+focus ownership; `keydown` → not pointer, and (unless composing) the key's origin is recorded; `focusin` on a *different* control → keyboard; `blur` → clear the pending key.
- Non-obvious design decisions: the two answers differ on purpose — **tooltips follow the last input, rings follow navigation**. A modifier key or refocusing the same control keeps the ring silent; only Tab/Home/End/PageUp/PageDown/arrows flip it. `composedPath()[0]` is used so the real control inside a shadow root is identified.
- Edge cases / failure handling: an IME-composing key clears the pending key and does not flip the modality; a window blur clears it so a pending key cannot survive an app switch; module-level listeners are installed only when `window` exists, so a Node import is inert (there is a dedicated spec for that).
- Surprising: refocusing the same control after a modifier key deliberately does **not** restore keyboard modality.

### packages/client/ui-primitives/src/Input.module.css
Wrapped single-line input with an optional leading icon.

### packages/client/ui-primitives/src/Input.tsx
`forwardRef` single-line input; the ref is the real `<input>` (cleared on unmount) and native attributes pass through.

### packages/client/ui-primitives/src/JsonTree.module.css
JSON-tree palette and row mechanics, including a dark-theme override block and the collapsed-string shape.

### packages/client/ui-primitives/src/JsonTree.tsx
- Purpose: a read-only JSON viewer for tool payloads.
- Key abstractions: `JsonPath` (an array of keys), `CopyMode` (`json|path|prettyJson|value`), and a small `createCopyStore` that notifies **only the old and the new row**.
- Data flow: hover a row → the row's copy menu offers the modes that suit its type → click → clipboard → transient feedback on that row.
- Non-obvious design decisions: the copy store is per-row keyed so hovering a new row does not re-render the JSON values of the old one — a spec asserts that hovering **does not read a property getter** (a 500-property object with getters stays unread). A clipboard write that settles after the row changed or the tree unmounted is ignored, so no timer survives.
- Edge cases / failure handling: a circular payload falls back to `String(payload)`; long strings collapse to a window (`collapsedStringLines`, default 3) that re-fits on ancestor scroll and size change.
- Surprising: the root row is a fixed copy target (`data-json-root-row`) separate from the tree's rows, so "copy this whole payload" has one place to live.

### packages/client/ui-primitives/src/keyboard-composition.ts
`observeComposition(document)` — an IME guard returning `guards(event)` and `dispose()`. It tracks `compositionstart`/`compositionend` and treats a *late closing keydown* as composing (`ended` is set on `compositionend` and cleared on the next `keyup`), and accepts the legacy `keyCode === 229`.

### packages/client/ui-primitives/src/LinkIcon.tsx
Link category glyphs (`url|folder|code|image|document|other`) in Regular and Medium stroke weights, plus `classifyLinkPath` which folds the file-type vocabulary into those six. A `url` link whose href names a known host renders that site's own mark.

### packages/client/ui-primitives/src/markdown/cjkFriendlyStrong.ts
- Purpose: a micromark syntax extension that lets `**注意：**内容` close the strong emphasis after punctuation when CJK prose continues without whitespace.
- Key abstractions: a `Construct` (`cjkFriendlyAttention`) with `resolveAll` from CommonMark's attention; the open/close predicates mirror CommonMark's rules **plus** `cjkStrongClose`.
- Data flow: `parseGfm` → `fromMarkdown` with `cjkFriendlyStrong()` → mdast with correct `strong` nodes.
- Non-obvious design decisions: the extension is deliberately narrow — it applies to **asterisk** strong only, requires ≥2 markers, requires Unicode punctuation before the marker and a CJK character after, and leaves single-asterisk emphasis, escaped text, code spans, math and fenced code on upstream behaviour (a spec asserts all six).
- Edge cases / failure handling: it throws a named error if CommonMark's attention markers are unavailable, rather than silently mis-parsing.
- Surprising: this is a **model-output-compatibility** fix at the grammar layer: a Chinese-capable model writes `**注意：**内容`, and CommonMark refuses to close the strong run there, so the model's intended emphasis is lost.

### packages/client/ui-primitives/src/markdown/CodeBlock.module.css
Code-block card rules: the plain and shiki arms, line grouping and the counter-based line-number gutter.

### packages/client/ui-primitives/src/markdown/CodeBlock.tsx
- Purpose: the code fence renderer, with two **interchangeable** arms.
- Key abstractions: `StreamingHighlightSession` (per-instance incremental tokenization) vs shiki's settled HTML; `SHIKI_PRE_PROPS` mirrors the `pre` attributes shiki emits so the two trees can be swapped without a visual change; `STREAMING_LINE_GROUP_SIZE = 32` groups completed lines so React reconciles only the growing group.
- Data flow: streaming → the session re-tokenizes only appended text and publishes newly completed lines + the mutable tail; settled → `highlightToHtml` and the whole tree is replaced.
- Non-obvious design decisions: the caller must keep the component instance **stable** across growth (a stream-stable React key), and an unchanged streamed fence retains its highlighted DOM when it settles — so the settle is not a visible re-render.
- Edge cases / failure handling: a fence whose info string is still mid-chunk has no content and keeps the stock empty `pre`, so no wrong grammar ever paints; a fence labelled with an inherited object key (`constructor`, `__proto__`) renders plain instead of crashing shiki.
- Surprising: the copy control is rendered by the card, not the fence, and the copy payload is the raw source without the line-number gutter.

### packages/client/ui-primitives/src/markdown/file-link.ts
`parseFileLink(value)` — decodes a local destination and a GitHub-style `#L<n>[-L<m>]` range. Rejects URLs, query strings, control characters, UNC paths, non-`file:` schemes, malformed percent escapes, `#L0`, and ranges whose end precedes their start; a range resolves to its **start** line.

### packages/client/ui-primitives/src/markdown/highlight.ts
- Purpose: the client's **one** syntax highlighter.
- Key abstractions: a synchronous shiki **core** on the JavaScript regex engine (no oniguruma WASM — bundle-friendly); `LANGS` = three boot grammars (TypeScript, shell, JSON); `LAZY_GRAMMARS` = ~57 dynamic imports; the css-variables theme so colours live in the theme package as `--shiki-*`; `StreamingHighlightSession`; `highlightLines` / `highlightToHtml`; `grammarLoadCount` + `subscribeGrammarLoaded` as the external-store pair.
- Data flow: `useCodeHighlighter(language)` → `useSyncExternalStore(grammarLoadCount)` → when a lazy grammar registers, the count changes and the surface re-renders highlighted.
- Non-obvious design decisions: **only the three grammars every session renders load at boot**; everything else is a dynamic import, so a session that never opens a code surface in Python pays neither the module nor its synchronous init. The JS-family aliases (js/jsx/ts/tsx) resolve to the TypeScript grammar rather than a separate one — an accepted approximation that keeps the boot set to one JS-family grammar. `TOKENIZE_MAX_LINE_LENGTH = 1000` skips absurdly long lines.
- Edge cases / failure handling: an unknown or absent language falls back to plain text — **never an error**. The first render of a lazy language is plain until its grammar loads, then subscribers re-render. `highlightLines` drops shiki's trailing terminator line so the line count matches the caller's array, but keeps a genuinely blank final line.
- Surprising: `StreamingHighlightSession` reuses shiki's **saved grammar state** so a template literal that spans lines is coloured correctly mid-stream; a spec asserts that incremental growth equals a from-scratch tokenization at every single-character prefix.

### packages/client/ui-primitives/src/markdown/incremental.ts
- Purpose: incremental **block-level** markdown parsing for an append-only stream.
- Key abstractions: `IncrementalMarkdownParser` (stateful, `update(text)` → `{frozen, tail, generation}`); `PositionedBlock` = `{node, key}` where the key is the block's **absolute source start offset**; `UNSTABLE_TAIL_BLOCKS = 2`.
- Data flow: `update(text)` → parse the whole source → freeze every block except the last two → re-parse only the source tail behind them → return the frozen prefix plus the tail. A `generation` counter bumps whenever non-append input discards the frozen prefix, so callers can drop caches keyed on it.
- Non-obvious design decisions: re-parsing the whole document per chunk is quadratic in the final reply length; CommonMark block parsing is line-based and appended text can only reshape the parse frontier, so earlier blocks are final. The freeze cut sits at the **end offset** of the last frozen block (not the next block's start) because a following block's start offset excludes up to three spaces of insignificant indentation — cutting at the previous end keeps the inter-block blank lines in the tail so the sliced source stays verbatim. A final unclosed top-level fence cannot freeze as a block, so it gets a **second frontier**: only the last completed line and the current partial line go through the caller's grammar.
- Edge cases / failure handling: a grammar that omits `position` leaves nothing to cut at, so the whole parse stays in the tail and the fallback keys are negative list indices (unique within one tail). Non-append input discards the frozen prefix and bumps the generation.
- Surprising: the block key is the absolute start offset **on purpose** — it is stable from the frame a block first appears through freezing, so React reconciles rather than remounts when a block crosses the freeze boundary. The stated known deviation (shared with any prefix-freeze scheme) is that micromark resolves reference-style links and footnotes document-wide at parse time, so a definition on the other side of the boundary renders literally until the settled full parse self-heals it.

### packages/client/ui-primitives/src/markdown/JsonBlock.module.css
Collapsible JSON block toggle and body styling.

### packages/client/ui-primitives/src/markdown/JsonBlock.tsx
Collapsible JSON payload block (collapsed by default), pretty-printed on open, with a 20 000-character cap and a caller-supplied truncation note that receives the full length.

### packages/client/ui-primitives/src/markdown/katex.tsx
KaTeX → React via `DOMParser`, replicating the rehype-katex pipeline it replaced: the same three-arm error chain (strict render → `strict:'ignore'` retry → manual error span with KaTeX's stock `#cc0000`) and a DOM-identical element tree. The browser's own HTML parser is used deliberately, because it applies the spec's SVG/MathML foreign-content attribute adjustments that KaTeX's output relies on. Trusted commands stay off.

### packages/client/ui-primitives/src/markdown/local-image-syntax.ts
Recovers **only** unambiguous, unescaped, image-only paragraphs whose local path contains spaces — the source text must match the parsed text exactly (so an authored escape is not "recovered"), the path must be absolute/relative/drive-qualified, and the extension must classify as an image. Source offsets are preserved.

### packages/client/ui-primitives/src/markdown/MarkdownDelegate.tsx
Context-scoped Markdown navigation capabilities (`openExternalLink`, `openFile`, `fileImages`) so the renderer needs no callback threading; a nested provider replaces the enclosing capabilities, and a handler change reaches already-rendered (cached) links.

### packages/client/ui-primitives/src/markdown/MarkdownText.module.css
Markdown typography, table scroll containers, the compact variant, and the image-button rules.

### packages/client/ui-primitives/src/markdown/MarkdownText.tsx
- Purpose: the markdown facade — the streaming and settled arms.
- Key abstractions: `renderSettled(text, …)` (full parse with math, reference resolution, footnote section); the `StreamingRenderer` **class** (stateful: the incremental parser, the frozen blocks' cached React elements, and the reference/footnote state those elements consumed).
- Data flow: streaming → `streamRef.current.render(text)` returns frozen elements + a re-rendered tail + the footnote section; settled → `renderSettled`. The renderer is rebuilt when the `labels` object identity changes (localized chrome is baked into the cached elements).
- Non-obvious design decisions: footnote numbering assigned to a frozen reference is final, so the tail continues from a **copy** of the frozen footnote state each frame. `useMemo` over `[text, streaming, labels, fileMentions, pathImages]` keeps the work idempotent per text value so React may re-execute the render freely.
- Edge cases / failure handling: a labels change replaces the whole streaming renderer (so no cached element carries stale copy); the compact variant shares the parser and the streaming cache with the body variant.
- Surprising: the *variant* is a CSS concern only — `data-markdown-variant` — so the same parser and the same frozen cache serve both.

### packages/client/ui-primitives/src/markdown/mathCompatibility.ts
A micromark extension adding TeX backslash delimiters (`\(…\)`, `\[…\]`) and same-line display-dollar blocks (`$$x$$`) on top of `micromark-extension-math`'s token vocabulary, so the caller must also register `math()` on the same parse.

### packages/client/ui-primitives/src/markdown/parse.ts
The **two mdast grammars**, one per rendering arm: `parseGfm` (streaming — no math, so incomplete TeX never flashes a KaTeX error) and `parseGfmWithMath` (settled). Both run the local-image recovery. The file's header states the contract: each arm is internally consistent, and the arms differ only where TeX delimiters begin a math construct.

### packages/client/ui-primitives/src/markdown/plain-text.ts
Markdown → plain-text projection sharing the renderer's **streaming** grammar, so the projection strips exactly the markup the renderer would draw; raw HTML stays literal, links keep their labels, images keep alt text, code keeps its source.

### packages/client/ui-primitives/src/markdown/render.tsx
- Purpose: the direct mdast→React renderer that replaced react-markdown / remark-rehype.
- Key abstractions: `MarkdownRenderContext` (streaming flag, labels, `fileMentions`, `pathImages`, reference `targets`, footnote order + counts); `renderBlocks`, `renderFootnoteSection`, `wrapBlockChildren`, `collectReferenceTargets`, `createReferenceTargets`.
- Data flow: mdast → one switch over node types → React nodes; links and images go through `sanitizeUrl` / `remoteImageUrl` / `vocabularyImageUrl`; a local link goes through `parseFileLink` and the owner's `openFile`; TeX goes through `renderTexToReact`.
- Non-obvious design decisions: raw HTML renders as **literal text** — no HTML enters the DOM. The link allowlist is `http: | https: | mailto:`; relative and unparsable destinations are **disallowed alongside** disallowed protocols. Fragment-anchor URLs fail the allowlist, so footnote references and back-references render as plain text rather than in-page links. Images additionally require absolute HTTP(S) (or `data:`/`blob:`/`dsh-app://app/api/file?` for the owner's vocabulary).
- Edge cases / failure handling: merge-extensible node unions fall through the documented default (render nothing) rather than `assertNever`, because a grammar registered elsewhere may add node types this renderer has no mapping for. A wide table gets a `tabIndex=0` scroll container and the stable `md-table-wide` hook.
- Surprising: the rendered DOM is **pinned byte-for-byte** by `tests/fixtures/markdown-dom` and must not drift.

### packages/client/ui-primitives/src/markdown/useViewportHighlighting.ts
One **document-wide** `IntersectionObserver` that activates a code surface the first time it intersects the viewport; activation lasts for the component's lifetime, and the observer is disconnected when the last pending block unmounts. Browsers without `IntersectionObserver` activate immediately.

### packages/client/ui-primitives/src/Menu.module.css
Menu card geometry: the portal z-index (1100) sits above modal overlays (1000) because an anchor inside a dialog still expects its menu on top; the viewport-fit max-height; the pinned footer; and the arrow-navigation fill that **replaces** the browser's default focus ring (the fill is the focus indication).

### packages/client/ui-primitives/src/Menu.tsx
- Purpose: the dropdown menu — data rows and component rows in one keyboard walk.
- Key abstractions: `MenuEntry = MenuItem | MenuSeparator | MenuLabel`; `MenuItemButton` (a component row with the same markup as a data row); portal mode with a host-supplied `getAnchorRect`.
- Data flow: rows are flattened into one list; the keyboard walk moves real focus (`ArrowUp/Down`, `Home/End`, wrap at both ends); `Tab` settles the focused row, `Shift+Tab` closes; selection returns focus to the trigger.
- Non-obvious design decisions: **pointer-leave dismissal watches the wrapper, not the list** — React's enter/leave traversal runs over the React tree, so trigger and portaled list are one region and aiming back at the trigger (or crossing the 4px gap) is never a "leave"; a close is then delayed by the pointer grace. In portal mode the list is rendered under `document.body` so an overflow-clipping ancestor cannot crop it, and the position is tracked with `requestAnimationFrame` so a menu follows an anchor that moves without a scroll or resize event.
- Edge cases / failure handling: a window blur closes the menu **only** when focus moved into an iframe (an app switch must not close it); a non-`Node` event target is ignored rather than treated as outside; a menu with a submenu row drops the scrollable class because the overflow clip would crop the side card.
- Surprising: `MenuItemButton`'s `separatorBefore` draws the hairline as a **sibling of the row**, so a row that renders nothing leaves no stray line.

### packages/client/ui-primitives/src/MenuGroup.module.css
Sticky group-heading styling including the `data-stuck` treatment.

### packages/client/ui-primitives/src/MenuGroup.tsx
`MenuGroup` renders a `role="group"` section named by an instance-owned heading id. `observeStickyMenuGroups(viewport)` marks a heading stuck from **two** intersection observers (a start sentinel and a top strip) plus a viewport resize observer; the newest sample wins, and the cleanup disconnects both observers, ignores queued callbacks and clears the managed `data-stuck` attributes. Without `IntersectionObserver`/`ResizeObserver` the headings stay transparent and CSS handles the stickiness.

### packages/client/ui-primitives/src/MenuSurface.module.css
Menu surface material and the macOS backing layer rules.

### packages/client/ui-primitives/src/MenuSurface.tsx
The shared menu material plus, on macOS, an opaque backing behind the page content within the menu's bounds — CSS anchor-positioned so it follows placement, resizing and nested-menu movement. The backing is appended to `document.body` in a layout effect because CSS anchor positioning requires the anchor to precede the positioned element, and nested React portals can insert it before its anchor.

### packages/client/ui-primitives/src/Modal.module.css
Modal overlay, blurred mask and centred card geometry with a 24px viewport margin.

### packages/client/ui-primitives/src/Modal.tsx
Body-portaled modal: blurred mask, optional `headless` mode, a `data-shortcut-modal` command scope, and `useModalLayer` for the keyboard/focus ownership. A nested dialog can intercept keys through `onKeyDownCapture` before the document-level Escape handlers.

### packages/client/ui-primitives/src/overlay-top-margin.ts
`overlayTopMargin(min)` — the top margin an overlay keeps, derived from the frame's `--dsh-frame-top-clearance` custom property plus 20px; fullscreen keeps only the 20px gap.

### packages/client/ui-primitives/src/PathLabel.module.css
Path label styling: muted directory, primary filename and the left-edge clipping fade.

### packages/client/ui-primitives/src/PathLabel.tsx
Single-line path label that keeps the trailing characters visible; it toggles `data-path-clipped` when the inner text is wider than the outer box, updated on path change and on resize.

### packages/client/ui-primitives/src/PermissionIcon.tsx
Four permission glyph families (read-only, workspace write, full access, auto review) in Regular and Medium stroke weights.

### packages/client/ui-primitives/src/Pill.module.css
Capsule chip geometry for the static and interactive forms.

### packages/client/ui-primitives/src/Pill.tsx
Capsule that renders a `<button>` **only when `onClick` is supplied**, otherwise a static `<span>`. Size separates it from the read-only `Tag`.

### packages/client/ui-primitives/src/plugin-artwork.tsx
Five fixed-palette plugin artwork SVGs (terminal, agent-loop, subagent, web-search, default) at 36×36, each with a per-instance `useId` prefix so the same artwork can repeat on a page without duplicate document ids. The web-search ring emulates a conic gradient with a clipped HTML div (SVG has no native conic gradient).

### packages/client/ui-primitives/src/pointer-grace.ts
`usePointerGrace(close)` — a cancelable delayed close with `POINTER_GRACE_MS = 200`, sized to cover the anchor→popup gap (8px for HoverCard, 4px for Menu) at a hand's travel speed. The close callback is read at fire time through a ref, so callers may pass a fresh closure each render; a pending close is dropped on unmount.

### packages/client/ui-primitives/src/rank-by-name.ts
- Purpose: the shared fuzzy ranker for the `/` menu.
- Key abstractions: `alignmentScore(name, query)` — the strongest ordered-subsequence alignment, computed in O(name × query) by a two-row dynamic program; `boundaryBonus` (+8 at a name start or a `-`/`_` boundary); `rankByName(items, query)`.
- Data flow: for each item, score every search key (its `name` and, when present, its localized `label`); rank by **prefix hit first**, then the strongest alignment score, then source order.
- Non-obvious design decisions: an adjacent continuation earns +4, a gapped one +1 minus the skip cost, and a leading character costs its index — so `z_a_b` beats `xabc` for "ab" *unless* the latter is a prefix. The candidate list is returned **unchanged** for an empty query (identity, not a copy).
- Edge cases / failure handling: a query longer than the name, or a name with no subsequence match, yields no match at all.
- Surprising: the display label is a **second search key**, so a user can type the localized title.

### packages/client/ui-primitives/src/ReadBlock.module.css
Read-card row, gutter, content and expand-toggle rules, including the wrap mode.

### packages/client/ui-primitives/src/ReadBlock.tsx
- Purpose: the `read_file` result card.
- Key abstractions: `ReadBlockLine` = `{number, text}` (the file's own numbering is kept for a windowed read); the `highlighted` per-line span array.
- Data flow: lines → whole-window highlight (so multiline grammar context survives) → gutter + content rows → head/tail cap (default 16) → `FoldToggle`.
- Non-obvious design decisions: the card states **"showing N of M"** when the returned lines are fewer than the file's total, so a reader is not misled that the file ends there; the copy payload is the raw text without gutter or banner chrome; the gutter width is a CSS variable computed from the largest line number (minimum 3 digits).
- Edge cases / failure handling: the copy control is **hidden for an empty file** so it cannot replace the clipboard with empty text.
- Surprising: highlighting is viewport-gated (offscreen reads render plain until they intersect).

### packages/client/ui-primitives/src/ReferenceIcon.tsx
Session/file/folder reference glyphs in two stroke weights.

### packages/client/ui-primitives/src/relative-time.ts
`relativeTime(at, now)` — shared relative-time bucketing (now/minutes/hours/days/months/years) so two surfaces naming the same session agree; the words stay in each plugin's own dictionary.

### packages/client/ui-primitives/src/RiskConfirmation.module.css
Risk-confirmation card, warning row and acknowledgement checkbox styling.

### packages/client/ui-primitives/src/RiskConfirmation.tsx
Risk-acknowledgement dialog: the primary action stays disabled until the caller-controlled checkbox is ticked; the checkbox carries `data-modal-autofocus` so the modal captures the invoking control before moving focus.

### packages/client/ui-primitives/src/SearchBlock.module.css
Search-card banner, summary, line and file-header styling, with the no-wrap rule for match lines.

### packages/client/ui-primitives/src/SearchBlock.tsx
- Purpose: the search tool card, in two shapes (grouped `grep` matches, flat `glob` paths).
- Key abstractions: a `SearchRow` union (`file | match | path`) that **flattens both shapes into one row model**, so the height cap counts a file header exactly as it counts a match line or a path.
- Data flow: rows → head slice + `FoldToggle` + tail slice, with the tail's file header restored so the tail is not orphaned.
- Non-obvious design decisions: the `truncated` flag folds the **pre-cap total** into the banner summary ("showing X of N"), so a capped result is never presented as complete; the copy payload is the whole structured result, not the visible slice.
- Edge cases / failure handling: an empty result renders the caller's "no results" note; each file group collapses independently.
- Surprising: the card shares the `headTailCap` helper with the terminal, read and diff cards, so all four cut at the same place in the same flow.

### packages/client/ui-primitives/src/SegmentedControl.module.css
Segmented-control tab and sliding-indicator rules.

### packages/client/ui-primitives/src/SegmentedControl.tsx
ARIA tablist of equal segments with one sliding indicator (two CSS custom properties: `--dsh-segment-count`, `--dsh-segment-index`), a roving tabindex, and arrow/Home/End walking that **skips disabled options** and wraps. The control is fully controlled: it reports the requested value and never the one already selected. `id` derives each tab's id (`<id>-<value>`) and the panel id it controls (`<id>-<value>-panel`).

### packages/client/ui-primitives/src/SegmentedTabs.module.css
Segmented-tab pill and indicator rules.

### packages/client/ui-primitives/src/SegmentedTabs.tsx
Equal-width controlled tabs with a sliding indicator; keyboard selection moves focus as well as the selection, and the panels stay caller-owned.

### packages/client/ui-primitives/src/settings-form/fields.module.css
Settings-field layout: label group, badges, input, hint/invalid message and the help region.

### packages/client/ui-primitives/src/settings-form/fields.tsx
- Purpose: the controls of a settings form. Nothing here writes.
- Key abstractions: `SettingsValueField` (a staged value with an overridden badge, a reset and a disclosure help region) and `SettingsSecretField` (a write-only credential control).
- Data flow: a keystroke calls `onEdit(text)`; the form's save is the single point where a draft becomes a document mutation.
- Non-obvious design decisions: the secret field **never renders the stored value** — the credential literal does not ride a response, so the control reports only whether one is configured, starts blank, and a blank draft writes nothing (which keeps the stored key rather than clearing it). It asks browsers not to autofill saved login passwords (`autoComplete="new-password"`).
- Edge cases / failure handling: an invalid draft replaces the hint with the reason it cannot be saved; the reset is offered only while a save would leave an override; a disabled document disables the control *and* its reset.

### packages/client/ui-primitives/src/settings-form/form-model.ts
- Purpose: the staged form model behind a plugin's settings page.
- Key abstractions: `SettingsFormScopeSnapshot` (`status`, `value`, `base`, `user`, `writable`, `revision`); `SettingsFormScope` (`getSnapshot` / `subscribe` / `mutate`); `SettingsFormPathOp` = `{op:'set'|'unset', path, value?}`; `SettingsFieldSpec` (`format` / `parse`); `SettingsSecretSpec` (a write outside the section); `SettingsFormModel` (the class at line 195).
- Data flow: keystroke → the model stages it → **Save** → `scope.mutate(ops, expectedRevision)` → one revision-fenced write of every staged edit → the Host's acceptance refreshes the snapshot.
- Non-obvious design decisions: the file's header states the reason the model exists — *"A control that committed as it settled turned one edit into a write the user never asked for and could not preview; staged text makes what is on screen exactly what a save would store."* A field is **overridden** by the **presence** of a key in the user layer, not by a value comparison: an override equal to the composition default is still an override. The save is fenced by the `revision` its drafts started from, and the whole batch is one write.
- Edge cases / failure handling: a failed credential write is reported even when another credential succeeded, and the drafts are **retained** so the user can retry; a field's `parse` returning `undefined` blocks the save rather than discarding the text.
- Surprising: `settingsNumberField` / `settingsTextField` are the only two shipped specs; the model's `field()` throws for an unknown field, so a plugin's spec list is the single source of truth.

### packages/client/ui-primitives/src/settings-form/SettingsForm.module.css
Settings-form frame, read-only and failure notices, and the save row.

### packages/client/ui-primitives/src/settings-form/SettingsForm.tsx
The form frame: the unavailable notice (when the Host stopped serving the namespace), the read-only notice, a save that writes every staged edit, and **discard on unmount** — leaving the page drops every staged edit, so the form offers no discard control. The save is disabled while the form is not dirty, invalid, or already saving.

### packages/client/ui-primitives/src/ShortcutKeys.module.css
Keycap styling for the plain and tooltip variants, including the joined plus-separated combination.

### packages/client/ui-primitives/src/ShortcutKeys.tsx
Shortcut keycaps: unboxed by default; the `tooltip` variant uses lighter keycaps over the dark bubble and groups a plus-separated combination into one filled block.

### packages/client/ui-primitives/src/SiteGlyph.tsx
`siteGlyph({href, size, className})` — `simple-icons` site marks (CC0) matched by the **longest** host suffix, so `weixin.qq.com` keeps WeChat while `qq.com` keeps QQ and `gist.github.com` needs no entry. Each mark rides `currentColor` rather than the brand fill the set records, and the 24-unit box is inset to `-2 -2 28 28` so it matches the ~8% margin of the product glyphs.

### packages/client/ui-primitives/src/StateDot.module.css
State-dot palette and the ongoing spinner (a rotating group plus a breathing dash arc sharing one 1.5 s period), with a `prefers-reduced-motion` fallback that stops both animations and keeps an intermediate arc.

### packages/client/ui-primitives/src/StateDot.tsx
- Purpose: the status dot / spinner.
- Key abstractions: `StateDotState` = `done|warning|ongoing|error|idle`; `appearance` = `dot|step`.
- Data flow: a `ref` callback pins the spinner's CSS animations to document time zero.
- Non-obvious design decisions: **"A CSS animation starts when its element is inserted and restarts when the element is moved or shown again, so loaders started at different moments rotate out of phase; one shared start time keeps every visible loader in step."** The mount pins the first start; an `animationstart` listener re-pins each restart.
- Edge cases / failure handling: jsdom implements no Web Animations despite lib.dom's non-optional typing, so the `getAnimations` call is optional-chained and that lane is knowingly unsynced.
- Surprising: the dot is `aria-hidden` — the name is supplied by the render site.

### packages/client/ui-primitives/src/Switch.module.css
Switch track and thumb, keyed off `aria-checked` so the visual state **cannot disagree** with the state assistive technology reads.

### packages/client/ui-primitives/src/Switch.tsx
`role="switch"` toggle, fully controlled, with a required `label` (no default, so a render site cannot ship the control without an accessible name) and an optional lock-reason `title`.

### packages/client/ui-primitives/src/Tag.module.css
Tag capsule geometry on the base rule plus the eight tone rules (status tones tinted at 10 %, warning at 12 %).

### packages/client/ui-primitives/src/Tag.tsx
Read-only capsule badge with eight tones selected through `data-tone`; the selectable capsule is `Pill`.

### packages/client/ui-primitives/src/TerminalBlock.module.css
Terminal output styling: the line-height variable, scrollbar track margins that keep the thumb's travel out of the rounded corners, the run-state dot centred on **one command line** rather than the wrapped prompt height, and the `white-space` variable hosts rebind to wrap instead of scroll.

### packages/client/ui-primitives/src/TerminalBlock.tsx
- Purpose: the `run_command` result card.
- Key abstractions: `TerminalBlockLabels` (a complete localized label set); a `runState` = `{state, label}` derived from the call's outcome; `showState = runStateDot && (!background || running)`.
- Data flow: command + cwd + home → the prompt label; output → `parseAnsiLines` → styled per-line spans; exit code / signal → the status pill.
- Non-obvious design decisions: the cwd labels the **call**, not each line — a `cd` inside the command moves later lines elsewhere, so repeating the label would state a directory the view does not know. The exit status is the whole call's (bash reports no per-command status), so exactly **one dot and one label** are drawn however many lines the command spans; a dot per row would assert that a line inside a failing call failed. The signal pill outranks the exit code. The home directory collapses to `~`; below home only the last segment is shown.
- Edge cases / failure handling: a settled command whose output renders **nothing visible** (a lone reset, an OSC title) is treated as empty — judging emptiness on the raw text drew a box of blank rows plus a copy control for invisible bytes. The output terminator is dropped even when a reset follows the final newline (`line\n\x1b[0m`), but a genuinely blank final line is kept. A background launch shows the prompt only and omits the output, the empty-output placeholder, the exit pill and the default copy control (an explicit `copyText` override stays available).
- Surprising: the copy payload is the **raw output** — escape codes and the newline terminator included, never the prompt line or the pill.

### packages/client/ui-primitives/src/TextShimmer.module.css
Shimmer content and the clipped decorative sweep layer.

### packages/client/ui-primitives/src/TextShimmer.tsx
- Purpose: the activity shimmer for a running row.
- Key abstractions: a `DecorativeCopy` context; a `data-shimmer-text` marker; the decorative layer rendered with `inert`.
- Data flow: the real text is rendered once (selectable, accessible); when `active`, an inert, clipped copy of the same content carries the highlight sweep.
- Non-obvious design decisions: the shimmer is applied to a **duplicate**, so the visible text keeps its selection and its accessible name; nested `TextShimmer` instances inherit the outer animation; React 18 forwards `inert` as an empty string (a boolean is dropped), so the prop is spread as `{ inert: '' }`.
- Edge cases / failure handling: the decorative copy renders `null` for string children (it is the highlight carrier, not content), so it must carry no side effects or element ids — the doc says so explicitly.

### packages/client/ui-primitives/src/Toast.module.css
Toast banner geometry and the fade that reads the `--dsh-toast-hold` custom property.

### packages/client/ui-primitives/src/Toast.tsx
- Purpose: the transient top-centre banner.
- Key abstractions: `holdMs` (the owner's window) + a fixed `FADE_MS`; `--dsh-toast-hold`; inline `actions` with an optional connective `prefix`.
- Data flow: the owner mounts it, the timer fires after `holdMs + FADE_MS`, then `onDone` tells the owner to unmount.
- Non-obvious design decisions: **one value drives both the unmount timer and the stylesheet's fade delay**, so the two can no longer disagree and leave the banner unmounting mid-fade. Parent re-renders do not extend the lifetime (the effect depends on `holdMs` only, and `onDone` is read through a ref so the **latest** handler is called). The banner surface stays click-through; only the action text takes the pointer.
- Edge cases / failure handling: the banner is body-portaled so a transformed or filtered ancestor cannot trap the fixed banner in that ancestor's box; anchor-centred placement re-measures on resize.
- Surprising: `tone="success"` brings its own circled green check and ignores the `icon` prop.

### packages/client/ui-primitives/src/Tooltip.module.css
Tooltip bubble material, the per-side placement offsets and the shortcut keycap row.

### packages/client/ui-primitives/src/Tooltip.tsx
- Purpose: the anchor tooltip (hover and keyboard focus), with an optional body portal.
- Key abstractions: `TooltipSide` = `right|bottom|top`; `TooltipSuppression` (a context so a nested tooltip withdraws its enclosing one); a `label` that may be a **resolver** evaluated only while visible.
- Data flow: hover/focus → delay → show → the anchor's rect + the bubble's **observed** border-box size (a `ResizeObserver`) → place → flip → clamp; the bubble stays `visibility: hidden` until the observer supplies a size.
- Non-obvious design decisions: positioning never synchronously measures the bubble and never triggers a React render — the anchor's rect and the observed size are independent browser inputs, and the placement reuses the anchor coordinates when only the label or the viewport changed. A bubble flips to the other side only when that side has room; when neither fits it **keeps the requested side**, because oscillating would be worse. The anchor's own handlers are chained ahead of the tooltip's. `disabled` suppresses the bubble **without remounting the anchor** (a remount would cut its CSS transitions).
- Edge cases / failure handling: an existing `aria-describedby` on the anchor is preserved and the bubble id is appended; `openOnClick` pins the bubble for reading and drops the pin on a second click, Escape, Tab or an outside pointerdown; a nested tooltip **withdraws** the enclosing one instead of stacking both; a pointer-driven focus does not raise the bubble (a closing menu refocuses its trigger after a mouse selection).
- Surprising: the tooltip can be portaled while the **anchor stays in its clipping container** — only the bubble escapes.

### packages/client/ui-primitives/src/use-copy-feedback.ts
`useCopyFeedback(text)` — a one-second transient `copied` flag over `writeClipboard`; a refused write stays silent and does not show a success label.

### packages/client/ui-primitives/src/useAnchoredMaxHeight.ts
Viewport-fit hook for **bottom-anchored** overlays: the element's bottom edge is laid out independent of its height, so it grows upward and only the top edge can collide — the design cap is clamped to the space between that edge and the viewport top (respecting the frame's overlay inset).

### packages/client/ui-primitives/src/useAnchoredPosition.ts
Positions a fixed floating panel from its anchor's viewport rect: offset below or above, align start or end, clamp inside the viewport, and re-place on scroll (**capture phase**, so nested scrollers are caught), on resize, and on the panel's own size change (a status line appearing inside it, a dragged textarea). The first run measures in the same commit that opened it, so the clamp uses real dimensions before anything paints; `ResizeObserver` is optional so the hook still works where it is absent.

### packages/client/ui-primitives/src/useDismissOnOutsidePointer.ts
Closes a trigger-owned popover on a pointerdown outside its root; an optional portaled surface counts as inside.

### packages/client/ui-primitives/src/useModalLayer.ts
- Purpose: shared modal keyboard ownership and focus lifetime.
- Key abstractions: `modalSelector = '[role="dialog"][aria-modal="true"], [role="menu"]'`; a per-`Document` `WeakMap` of a layer stack; `closeTopModal(document)`; `isBehindModal(anchor)`.
- Data flow: `useModalLayer(dialog, open, onClose)` pushes a layer, captures `document.activeElement`, moves focus to `[data-modal-autofocus]` (or the first focusable) with `focusWithoutRing`, installs a document keydown handler, and on unmount removes the layer and restores the previous focus (or the layer below).
- Non-obvious design decisions: only the **top** layer owns Escape and Tab; a newer menu or an unregistered dialog **blocks** dismissal of the modal behind it (`closeTopModal` compares the foreground DOM element against the registered top). Menus consume their own Escape during capture, before this bubble listener. Tab traversal is skipped while focus is inside a portaled menu. `close.current` is a ref so the **latest** `onClose` is used.
- Edge cases / failure handling: `event.repeat` is ignored for Escape (a held key must not close repeatedly); IME composition is honoured through `observeComposition`; a modal whose owner declines dismissal stays open.
- Surprising: controls mounted with the dialog must use `data-modal-autofocus` and **not** React `autoFocus`, because React's `autoFocus` runs before the layer can capture the invoking control.

### packages/client/ui-primitives/src/user-text.module.css
Inline reference chip styling: the code face for skill/command tokens, the body face for `@` chips, and the reference glyph at `1em` with a font-relative optical centring.

### packages/client/ui-primitives/src/user-text.tsx
`UserTextRun` renders uninterpreted text; `ReferenceChip` renders a resolved label as a span, or as a **keyboard-accessible button** when an activation is supplied. Text selection and repeated pointer clicks do not activate the reference (`event.detail > 1`, or a non-collapsed selection), while keyboard activation stays available.

### packages/client/ui-primitives/src/WebBlock.module.css
Web-card source list, answer block and fetch meta styling.

### packages/client/ui-primitives/src/WebBlock.tsx
- Purpose: the `web_search` / `web_fetch` card.
- Key abstractions: `WebSourceView` (url, optional title/snippet/publishedAt); a `kind`-discriminated union `search | fetch`.
- Data flow: the search shape renders the provider answer (as markdown) above the citation list; the fetch shape renders the final URL, the HTTP status and a truncation note.
- Non-obvious design decisions: only `http:`/`https:` becomes a navigable anchor — a `javascript:`/`data:`/`file:` URL or an unparsable string never reaches the DOM as an `href` (this is the http(s) subset of the markdown allowlist; `mailto:` is deliberately excluded because a retrieval URL is never a mail address). The label falls back to the hostname and then to the raw URL when the hostname is empty, so a label is never blank.
- Edge cases / failure handling: an empty source list with no answer renders the "no results" note rather than an empty `<ol>`; a source list that carries only an answer still renders the list.

### packages/client/ui-primitives/tests/ansi.client.spec.ts
506-line suite pinning every SGR code to its token (basic, bright, 256-palette, truecolor), backgrounds, reverse video, decorations, the control-character stripping and multi-line runs.

### packages/client/ui-primitives/tests/atoms.client.spec.tsx
712-line suite for Button, Pill, Input, Menu, Modal and ConnectionIndicator: the menu's keyboard walk and wrapping, portal mode and rAF anchor tracking, the pointer grace, submenus, focus return, and the modal layer.

### packages/client/ui-primitives/tests/checkbox.client.spec.tsx
Checkbox label activation, controlled state, the disabled refusal and the preserved hover title.

### packages/client/ui-primitives/tests/code-block.client.spec.tsx
`highlightToHtml` contract, lazy loading of **all 57 grammar aliases**, alias coverage over the shared extension table (an alias whose target is in neither table would throw at render), and the copy-failure paths.

### packages/client/ui-primitives/tests/code-card-controls.client.spec.tsx
Code-card toolbar controls (wrap toggle, copy) across the diff, read and markdown surfaces, including the shared toolbar labels and the "mixed language diff" fallback title.

### packages/client/ui-primitives/tests/code-file-icon.client.spec.tsx
Code-file classification tables and the artwork safety contract: no `script`/`style`/`foreignObject`, no external `href`, unique instance-safe ids, and the manifest digests.

### packages/client/ui-primitives/tests/code-highlighting.client.spec.tsx
Asserts `languageForPath` **is** the shared table (`expect(languageForPath).toBe(sharedLanguageForPath)`) so a second canonical copy cannot drift, and that both shipped hint projections (the read card's persisted short id and this surface's own selection) reach the same grammar.

### packages/client/ui-primitives/tests/command-text.client.spec.tsx
Command text becomes focusable only while overflowing, keeps its scroll position across rerenders, and releases its `ResizeObserver` and font listeners.

### packages/client/ui-primitives/tests/config-field.client.spec.tsx
Config-field select/secret/textarea arms, the reset control and the invalid-draft note.

### packages/client/ui-primitives/tests/diff-block.client.spec.tsx
Diff structure: create/edit/gap rows, the trailing-newline terminator rule, the cap and the copy-failure path.

### packages/client/ui-primitives/tests/disclosure-row-styles.client.spec.ts
Reads `DisclosureRow.module.css` **as text** and asserts the font-size-axis declarations (title tier, row/leading delta, the `StateDot` exemption). jsdom has no layout, so a declaration is the only thing that can be checked.

### packages/client/ui-primitives/tests/file-size.client.spec.ts
Pins the byte formatter's rounding thresholds on both sides of KB/MB/GB.

### packages/client/ui-primitives/tests/file-type-icon-styles.client.spec.ts
Reads `FileTypeIcon.module.css` as text to assert each traditional category's default colour and the single caller override variable.

### packages/client/ui-primitives/tests/file-type-icon.client.spec.tsx
File-type classification tables and the per-category glyph dispatch.

The 48 files below are a **DOM compatibility baseline**: 24 corpus cases × a `.settled.txt` and a `.streaming.txt` snapshot of the serialized DOM (elements, sorted attributes, coalesced text nodes, whitespace-only runs dropped outside `pre`), produced by `tests/markdown-dom-parity.client.spec.tsx`. 20 of the 24 pairs are **byte-identical** between the two arms; the 4 that differ are `code-fences`, `fence-trailing-blank-lines`, `math-edge-cases` and `math-inline-and-display` — and each difference is a real behavioural fact, recorded below.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/blockquote-nested.settled.txt
Settled DOM for the nested-blockquote case: a `blockquote` holding a `p` and a nested `blockquote`, then a `ul` inside the outer quote, then a trailing `p`. Byte-identical to its streaming twin.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/blockquote-nested.streaming.txt
Streaming DOM for the nested-blockquote case — byte-identical to the settled snapshot, so the incremental parser's block freeze does not change the tree for this shape.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/cjk-strong-and-inline-code-url.settled.txt
Settled DOM for the CJK-strong case: `**注意：**内容` closes the `strong` after the full-width colon (`<strong>注意：</strong>`), while `**Notice:**text` and `*提醒！*单星号` stay literal. Also pins the **inline-code URL promotion** — a code span holding exactly an absolute http(s) URL becomes `<code><a href=…><svg/></a></code>`, while `curl http://127.0.0.1:3199/` and `javascript:alert(1)` stay inert code.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/cjk-strong-and-inline-code-url.streaming.txt
Streaming twin of the CJK-strong/inline-code-URL baseline — byte-identical, so the CJK extension and the inline-code promotion are not streaming-gated.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/code-fences.settled.txt
- Purpose: settled DOM for the fence case — a `ts` fence through shiki, a language-less fence, an `unknown-lang` fence, a `ts some=meta` fence, an **empty** fence and an indented code block.
- Key abstractions: the shiki arm's `pre` carries `class="shiki css-variables"`, a `style` of `background-color:var(--shiki-background);color:var(--shiki-foreground)` and `tabindex="0"`; tokens are `<span class="line">` wrapping `<span style="color:var(--shiki-token-…)">`.
- Data flow: the banner shows the **truncated** language id (`ts`, not `ts some=meta` — `render.tsx:387` recovers it with `/^[\w-]+/`), and the plain arm uses `pre._plain_…` with no token spans.
- Non-obvious design decisions: the **settled** arm wraps shiki's HTML in an extra `<div>` (the `dangerouslySetInnerHTML` container, `CodeBlock.tsx:184`) while the streaming arm emits the `<pre>` directly — so the two arms' trees are *not* structurally identical even where they look the same. An **empty** fence renders a bare `<pre><code></code></pre>` with **no** card wrapper at all (`render.tsx:377-384`, kept for parity with the replaced pipeline).
- Edge cases / failure handling: an unknown language falls back to the plain arm without an error; the indented code block *does* get the card.
- Surprising: the copy button's label is the localized `复制` — the fixture was recorded under a zh-CN locale, so the snapshot pins the **label plumbing**, not just the structure.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/code-fences.streaming.txt
Streaming twin of the fence baseline. It differs from the settled snapshot in exactly two ways: the shiki `pre` has **no** wrapping `<div>` (the streaming arm builds the element tree directly), and its `style` attribute is React's serialization (`background-color: var(--shiki-background); color: var(--shiki-foreground);` with a trailing `;`) rather than shiki's own string. The token colours differ the same way (`color: var(--shiki-token-keyword);` vs `color:var(--shiki-token-keyword)`).

### packages/client/ui-primitives/tests/fixtures/markdown-dom/definition-only.settled.txt
Settled DOM for a document holding only an unused reference definition: the wrapper `<div class="_markdown_404681">` with **no children**. Pins that a definition renders nothing and leaves no placeholder.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/definition-only.streaming.txt
Streaming twin of the definition-only baseline — byte-identical, so the streaming arm also drops the definition entirely rather than rendering it as text.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/entities-and-escapes.settled.txt
Settled DOM for the entities case: `AT&T`, `3 < 4`, `*not em*`, a literal backslash and `©` all land as **one** text node inside a `p` — i.e. HTML entities are decoded to their characters and escapes are resolved before the DOM, never inserted as markup.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/entities-and-escapes.streaming.txt
Streaming twin of the entities-and-escapes baseline — byte-identical.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/fence-trailing-blank-lines.settled.txt
Settled DOM for fences with trailing blank lines. The plain fence keeps its trailing `\n` inside the `code` text node, and the `ts` fence's shiki tree ends with **empty `<span class="line">` elements** for the two blank lines — the blank lines are preserved as real (empty) lines rather than trimmed away.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/fence-trailing-blank-lines.streaming.txt
Streaming twin of the trailing-blank-lines baseline. Same empty-`line` structure, and the same two differences as `code-fences.streaming.txt`: no wrapping `<div>` around the shiki `pre`, and React-serialized `style` strings.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/footnotes.settled.txt
Settled DOM for footnotes: a `<sup>` per reference (numbered by **first-reference order**, so the reused `[^a]` prints `1` twice), then a `<section class="footnotes" data-footnotes="true">` with an `sr-only` `<h2>` and an `<ol>` whose `<li>` ids are `user-content-fn-a` / `user-content-fn-b`. Pins the `↩` back-reference markers (two for the twice-used footnote, the second carrying a `<sup>2`).

### packages/client/ui-primitives/tests/fixtures/markdown-dom/footnotes.streaming.txt
Streaming twin of the footnote baseline — byte-identical, so the footnote section and its numbering are **not** streaming-gated (the section is built from the pass's accumulated footnote state).

### packages/client/ui-primitives/tests/fixtures/markdown-dom/gfm-strikethrough-and-literals.settled.txt
Settled DOM for GFM strikethrough plus autolinks: `~~gone~~` becomes `<del>`, `www.example.com` becomes an anchor (GFM's bare-URL autolink, normalized to `http://www.example.com`) and `user@example.com` becomes a `mailto:` anchor. Both anchors carry the leading 14 px globe SVG; the `mailto:` anchor carries **no** `target`/`rel` (only http(s) links open externally).

### packages/client/ui-primitives/tests/fixtures/markdown-dom/gfm-strikethrough-and-literals.streaming.txt
Streaming twin of the strikethrough-and-autolinks baseline — byte-identical.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/hard-breaks-and-hr.settled.txt
Settled DOM for hard breaks and a thematic break: both the two-space break and the backslash break become a `<br>` followed by a `"\n"` text node (the replaced pipeline's newline after every `<br>`), and `---` becomes an `<hr>`.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/hard-breaks-and-hr.streaming.txt
Streaming twin of the hard-breaks baseline — byte-identical.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/heading-tight-against-list.settled.txt
Settled DOM for a heading immediately followed by a tight list: `#### Small heading` → `<h4>`, then a `<ul>` whose items are **bare text** (no `<p>` wrapper — a tight list unwraps its paragraphs), then `<h5>` and an `<ol>`.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/heading-tight-against-list.streaming.txt
Streaming twin of the heading-tight-against-list baseline — byte-identical, so the tight/loose paragraph-unwrapping rule holds on both arms.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/headings-and-paragraphs.settled.txt
Settled DOM for headings and inline marks: `<h1>`–`<h6>` from ATX, a setext `===` underline becoming `<h1>` and a `---` underline becoming `<h2>`, and one paragraph carrying `<strong>`, `<em>`, `<del>` and `<code>`.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/headings-and-paragraphs.streaming.txt
Streaming twin of the headings-and-paragraphs baseline — byte-identical.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/images.settled.txt
Settled DOM for images: absolute http(s) sources become `<img>` with `loading="lazy" decoding="async" referrerpolicy="no-referrer"`; a relative source and a `javascript:` source are replaced by a `<span class="_imageAlt_…">` carrying the **alt text** (the destination is dropped, not rendered as a broken image); an empty alt renders `<img alt="">`.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/images.streaming.txt
Streaming twin of the images baseline — byte-identical, so the image allowlist is not streaming-gated.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/inline-code-with-newline.settled.txt
Settled DOM for an inline code span crossing a line break: `Spans \`a\nb\` across a line.` renders `<code>a b</code>` — the newline is rendered as a **space**, matching `mdast-util-to-hast`'s inline-code rule (`render.tsx:302-303`).

### packages/client/ui-primitives/tests/fixtures/markdown-dom/inline-code-with-newline.streaming.txt
Streaming twin of the inline-code-with-newline baseline — byte-identical.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/links-and-autolinks.settled.txt
Settled DOM for the link allowlist. Pins, in one file: `https` and `mailto:` anchors survive; a **relative** destination and a `javascript:` destination both drop to plain text; `HTTPS://example.com` (uppercase scheme) **keeps** its anchor with the scheme preserved verbatim; `<https://deepseek.com>` and a bare `https://autolink.example.com` both become anchors; a destination with a literal space (`https://example.com/a b`) is split — the anchor covers `https://example.com/a` and ` b)` stays text; and an **image-only anchor** carries the image with **no** leading globe glyph.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/links-and-autolinks.streaming.txt
Streaming twin of the links-and-autolinks baseline — byte-identical, so the URL allowlist is not streaming-gated.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/lists-tight-loose-nested.settled.txt
Settled DOM for list shapes: a tight `<ul>` whose items are bare text, a nested `<ul>` inside a tight item, an `<ol>` whose items each keep a `<p>` (loose), a loose item with **two** paragraphs, and a list item containing a fenced code block — which is rendered as a full `md-code-block` card (banner + copy button + `pre._plain_…`) **inside** the `<li>`.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/lists-tight-loose-nested.streaming.txt
Streaming twin of the lists baseline — byte-identical, so a fence inside a list item renders the same card in both arms.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/math-edge-cases.settled.txt
- Purpose: settled DOM for the KaTeX edge cases — trusted commands, an unbalanced formula, math inside a table cell and a display `\sqrt`.
- Key abstractions: each formula is a `<span class="katex">` holding a `katex-mathml` subtree (the `math`/`semantics`/`annotation` arm) **and** an `aria-hidden` `katex-html` subtree.
- Data flow: `\href{javascript:alert(1)}{unsafe}` is rendered by KaTeX in **error colour** (`mathcolor="#cc0000"`, `rgb(204, 0, 0)`) showing only the command name — the untrusted URL never becomes a link. The unbalanced `$\frac{$` becomes `<span class="katex-error" … title="ParseError: KaTeX parse error: Unexpected end of input in a macro argument…">` — that is **KaTeX's own** error span (the second arm of the chain, `katex.tsx:72`), not the module's manual span.
- Non-obvious design decisions: the file pins that the error span is KaTeX's rendering, which is how the fixture distinguishes the code's two error arms (`katex.tsx:70-86`).
- Edge cases / failure handling: math inside a table cell renders a full KaTeX tree inside a `<td>`; a ``` `math` ``` fence becomes a `katex-display` block once settled.
- Surprising: the display `\sqrt` carries KaTeX's 400 000-unit-wide inline SVG path data — the DOM baseline includes the entire glyph geometry.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/math-edge-cases.streaming.txt
Streaming twin of the math-edge-cases corpus, and it is the clearest record of the two-grammar rule: **every** TeX construct is literal text, the table cell holds the raw `$\theta$`, and the ``` `math` ``` fence stays an ordinary plain code block (banner id `math`, `pre._plain_…`) instead of becoming display TeX. Note the delimiters are not merely left alone — `\(\frac{1}{5}\)` renders as `(\frac{1}{5})`, because in the streaming grammar `\(` and `\)` are ordinary CommonMark **backslash escapes** and are consumed.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/math-inline-and-display.settled.txt
Settled DOM for inline and display KaTeX, 320 lines — by far the largest fixture. Pins: `$E = mc^2$` as an inline `katex` span (MathML `msup` plus the HTML arm), a `$$…$$` display block as `<span class="katex-display">`, the **backslash-delimited** inline form `\(\frac{1}{5}\)` rendered as real KaTeX, and the backslash display `\[\frac{\pi}{4} < \theta < \frac{\pi}{2}\]` as a `katex-display` block. Also pins that the MathML subtree carries the original TeX in an `<annotation encoding="application/x-tex">`.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/math-inline-and-display.streaming.txt
Streaming twin of the inline-and-display math corpus: 9 lines, every construct literal. The same delimiter-consumption effect is visible — `\(\frac{1}{5}\)` becomes `(\frac{1}{5})` and `\[…\]` becomes `[…]`, because the streaming grammar has no `mathCompatibility` extension and treats the backslashes as CommonMark escapes.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/raw-html-dropped.settled.txt
Settled DOM proving raw HTML never enters the DOM: the `<script>` block, the inline `<img onerror=…>` and the `<div class="x">` block all appear as **escaped text nodes**, and the paragraph's `<b>bold tag</b>` stays literal. This is the single most security-relevant fixture in the shard.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/raw-html-dropped.streaming.txt
Streaming twin of the raw-html baseline — byte-identical, so raw HTML is neutralised in the streaming arm too, not just at settle.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/reference-links-and-images.settled.txt
Settled DOM for reference links: full (`[full][ref]`), collapsed (`[collapsed][]`) and shortcut (`[shortcut]`) references all resolve to anchors; a **missing** reference reverts to its bracketed source text (not a link) — and the missing *image* reference reverts to `![missing image][gone]` as literal text; a resolvable reference image becomes a normal `<img>` with the lazy/async/no-referrer attributes.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/reference-links-and-images.streaming.txt
Streaming twin of the reference-links baseline — byte-identical, so a reference whose definition is on the far side of the freeze boundary still resolves here (this corpus puts every definition at the end of the document, and the whole document is one frozen block).

### packages/client/ui-primitives/tests/fixtures/markdown-dom/streaming-typical-partial.settled.txt
Settled DOM for a typical partial stream: a `<h2>`, a `<ul>` whose second item holds the **literal** text `**unfinished` — the emphasis is not closed, so nothing is emphasised and no half-rendered `<strong>` appears.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/streaming-typical-partial.streaming.txt
Streaming twin of the typical-partial baseline — byte-identical, so an unclosed emphasis run is equally inert while streaming.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/table-header-only.settled.txt
Settled DOM for a header-only table: a `div._tableScroll_…_tableFill_…` wrapper around a `<table>` with a `<thead>` and **no** `<tbody>`, followed by the paragraph `after`. Pins that a body-less table emits no empty `<tbody>`.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/table-header-only.streaming.txt
Streaming twin of the header-only table baseline — byte-identical.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/table-wide-and-blockquote.settled.txt
Settled DOM for the two table geometries: a **four-column** top-level table gets the wide arm (`md-table-wide` class plus `tabindex="0"`, so it stays keyboard-reachable), while the same four-column table **inside a blockquote** falls back to the fill arm (`_tableFill_…`, no `tabindex`). The rule is `columns >= 4 && inBlockquote !== true` (`render.tsx:484`).

### packages/client/ui-primitives/tests/fixtures/markdown-dom/table-wide-and-blockquote.streaming.txt
Streaming twin of the wide-table-and-blockquote baseline — byte-identical, so the wide/fill choice is not streaming-gated.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/table-with-alignment.settled.txt
Settled DOM for table alignment: the delimiter row's alignment is rendered as an inline `style="text-align: left|centre|right"` on **every** cell of that column (a fourth column with no alignment gets no `style` at all), a code cell keeps its `<code>`, and a link cell keeps the full globe-glyph anchor — all inside the wide arm.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/table-with-alignment.streaming.txt
Streaming twin of the table-alignment baseline — byte-identical, so the per-column alignment style is applied identically on both arms.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/task-lists.settled.txt
Settled DOM for GFM task lists: the list gets `class="contains-task-list"`, each task item `class="task-list-item"`, and the checkbox is a real `<input type="checkbox" disabled>` (with `checked` present only when done) — **not** a `disabled` attribute on a rendered box, and never a form control the user can toggle. The bold text after a done item keeps its `<strong>`.

### packages/client/ui-primitives/tests/fixtures/markdown-dom/task-lists.streaming.txt
Streaming twin of the task-lists baseline — byte-identical.

### packages/client/ui-primitives/tests/highlight-viewport.client.spec.tsx
Viewport-gated highlighting: offscreen blocks stay plain, an intersecting block activates once and stays active, an unsupported language is never observed, the shared observer is released when the last pending block unmounts, and the fallback without `IntersectionObserver` is immediate.

### packages/client/ui-primitives/tests/hover-card-group.client.spec.tsx
Group dwell sharing: the first display warms the list, later cards switch instantly, a keyboard-opened card does not warm the next pointer visit, and unmounting the group releases every timer.

### packages/client/ui-primitives/tests/hover-card.client.spec.tsx
682-line suite for the hover card: the dwell delay, the preview insets and frame clearance, the 200 ms grace, copy activation vs text selection, in-flight clipboard writes, inline media previews and viewport clamping.

### packages/client/ui-primitives/tests/icons.client.spec.tsx
Icon catalogue invariants: every exported icon is `aria-hidden`, currentColor-only and distinct.

### packages/client/ui-primitives/tests/image-lightbox.client.spec.tsx
Lightbox opens from the thumbnail, traps Tab on the close control, closes on Escape and restores focus to the opener.

### packages/client/ui-primitives/tests/image-preview.client.spec.tsx
Inline preview shows the loading state and the failure state without adding a second activation target.

### packages/client/ui-primitives/tests/inline-editor.client.spec.tsx
Enter saves, Shift+Enter breaks the line, IME composition does not save, Escape cancels, and the textarea grows with its text.

### packages/client/ui-primitives/tests/input-modality.client.spec.ts
The modality policy: any key returns tooltips to the keyboard, navigation keys return the focus ring, and refocusing the same control after a modifier stays silent.

### packages/client/ui-primitives/tests/json-tree.client.spec.tsx
475-line suite: per-row copy menus, **no property reads on hover**, clipboard settlement ignored after a row change or an unmount, and the fixed root row.

### packages/client/ui-primitives/tests/labels.client.ts
The shared localized label dictionaries for the suite (zh-CN copy for every card's copy, collapse/expand and status labels) — the package's own "copy belongs at the render site" rule exercised by the tests themselves.

### packages/client/ui-primitives/tests/link-icon.client.spec.tsx
Link category classification, currentColor-only artwork, the 14 px inline seat and the site-mark resolution by longest host suffix.

### packages/client/ui-primitives/tests/markdown-compact.client.spec.tsx
The compact variant keeps the body's semantics and keeps frozen blocks and highlighted lines mounted across growth and variant changes.

### packages/client/ui-primitives/tests/markdown-dom-parity.client.spec.tsx
The fixture-driven DOM compatibility baseline: each corpus case is snapshotted in settled and streaming form, and the header instructs reviewers to **read diffs as user-visible Markdown changes** rather than regenerating them for refactors.

### packages/client/ui-primitives/tests/markdown-file-links.client.spec.tsx
Local file links: decoding and `#L` ranges reach the preview callback, unsupported destinations stay inert, and links enable only after streaming settles.

### packages/client/ui-primitives/tests/markdown-image-entries.client.spec.tsx
Inline and hover image previews through the desktop file route, the lightbox round trip, the bare-space path recovery and the image-only-link single-activation rule.

### packages/client/ui-primitives/tests/markdown-incremental.client.spec.tsx
The shard's most valuable suite: a streamed `MarkdownText` matches a fresh render **at every prefix** (chunk sizes 1, 3, 7 and 16), keeps frozen DOM nodes across freezes, recovers from divergence instead of appending, and never freezes under a grammar that omits positions.

### packages/client/ui-primitives/tests/markdown-path-images.client.spec.tsx
Path-image resolution applies only to settled renders and URL promotion wins before the resolver sees a token.

### packages/client/ui-primitives/tests/markdown-plain-text.client.spec.ts
The plain-text projection of a GFM document, its first-line and first-paragraph modes, raw HTML preserved literally, and tables projected as tab-separated rows.

### packages/client/ui-primitives/tests/markdown-render-units.client.spec.tsx
Hand-built mdast trees exercise the renderer's defensive arms (unresolved references, duplicate definitions, bare list items, spread-null lists), and StrictMode double-render parity.

### packages/client/ui-primitives/tests/markdown-test-components.tsx
Test wrappers that inject the shared labels into `MarkdownText` and `JsonBlock`, so the specs exercise the public API rather than the internals.

### packages/client/ui-primitives/tests/markdown.client.spec.tsx
603-line suite: CJK strong emphasis, inline-code URL promotion, delegated link handling, file mentions, fence streaming, image and HTML neutralization, and the full TeX delimiter matrix (including a performance bound on 6 400 repeated unclosed backslash delimiters).

### packages/client/ui-primitives/tests/menu-group.client.spec.tsx
388-line suite: group naming, the two-observer sticky transition, observer ownership and the no-`IntersectionObserver` fallback.

### packages/client/ui-primitives/tests/menu-surface.client.spec.tsx
The menu surface exposes the shared material and the macOS backing as a separate non-interactive layer.

### packages/client/ui-primitives/tests/modal-layer.client.spec.tsx
182-line suite: only the top modal closes, a newer menu or dialog blocks it, Escape closes one layer, IME is honoured, and each opener is restored.

### packages/client/ui-primitives/tests/path-label.client.spec.tsx
Path-label clipping detection and the left-edge fade attribute.

### packages/client/ui-primitives/tests/plugin-artwork.client.spec.tsx
Plugin artwork renders with per-instance gradient ids at a fixed 36×36 viewBox.

### packages/client/ui-primitives/tests/rank-by-name.client.spec.ts
The fuzzy ranker: subsequence matching, prefix hits first, boundary/adjacency scoring, a display label as a second key, and source order for ties.

### packages/client/ui-primitives/tests/read-block.client.spec.tsx
The `highlightLines` contract (terminator line dropped, per-line spans, `undefined` for an unknown language) plus the read card's window note, cap and empty-file copy refusal.

### packages/client/ui-primitives/tests/relative-time.client.spec.ts
Relative-time buckets and their boundaries, including a future moment reading as the present.

### packages/client/ui-primitives/tests/search-block.client.spec.tsx
Search card: file groups with collapsing, the pre-cap total folded into the summary, the flat path shape and the copy failure path.

### packages/client/ui-primitives/tests/segmented-control.client.spec.tsx
Segmented control: a named tablist, the owner-held selection, disabled options, the roving tabindex, arrow/Home/End walking and no form submission.

### packages/client/ui-primitives/tests/SegmentedTabs.client.spec.tsx
Segmented tabs: only the selected tab is a tab stop, keyboard selection moves focus, and the panels stay caller-owned.

### packages/client/ui-primitives/tests/settings-fields.client.spec.tsx
152-line suite: staging without writing, the reset offered only while an override stands, the invalid draft replacing the hint, and the secret field never rendering its value.

### packages/client/ui-primitives/tests/settings-form-model.client.spec.ts
319-line suite for the staged form model: a failed credential write reported even when another succeeded, drafts retained after a transport failure and retryable, override detection by presence, and an unavailable namespace.

### packages/client/ui-primitives/tests/settings-form.client.spec.tsx
The settings-form frame: the unavailable and read-only notices, the save blocked while invalid or saving, and discard on unmount.

### packages/client/ui-primitives/tests/state-dot-styles.client.spec.ts
Reads `StateDot.module.css` as text to assert each state's colour rule, the spinner keyframes and the reduced-motion fallback. The header states why: *"a state whose rule is missing renders on the inherited color instead of its own, which no render assertion would catch."*

### packages/client/ui-primitives/tests/state-dot.client.spec.tsx
State-dot rendering: the done/warning/error/idle arms, the `step` appearance and the spinner element.

### packages/client/ui-primitives/tests/streaming-code-block.client.spec.tsx
299-line suite for the streaming fence arm: incremental tokenization equals from-scratch at every prefix, completed lines keep their span arrays, only newly completed lines are reported to the renderer, and the streaming tree survives the settled shiki swap.

### packages/client/ui-primitives/tests/switch.client.spec.tsx
The switch exposes its state and its caller-owned name, reports the requested state, stays silent while disabled and never submits a surrounding form.

### packages/client/ui-primitives/tests/tag-styles.client.spec.ts
Reads `Tag.module.css` as text to assert every tone paints and that the capsule geometry stays on the base rule.

### packages/client/ui-primitives/tests/tag.client.spec.tsx
The tag renders the requested tone as `data-tone` with the caller's class and children.

### packages/client/ui-primitives/tests/terminal-block-styles.client.spec.ts
Reads `TerminalBlock.module.css` as text to assert the run-state dot is centred on one command line rather than the wrapped prompt height.

### packages/client/ui-primitives/tests/terminal-block.client.spec.tsx
502-line suite for the terminal card: the home-path collapse, background launches, the status pill's precedence, one dot per call, the head/tail cap, ANSI runs, the copy semantics and the `writeClipboard` contract.

### packages/client/ui-primitives/tests/text-shimmer.client.spec.tsx
The shimmer keeps the real text selectable while the decorative copy carries the highlight, and nested instances share the row's activity.

### packages/client/ui-primitives/tests/toast.client.spec.tsx
124-line suite: the hold-and-fade lifetime, one value driving both the timer and the stylesheet, anchor-centred placement, inline actions and timer cleanup on unmount.

### packages/client/ui-primitives/tests/tooltip-node.client.spec.ts
A Node-environment check that the `Tooltip` module loads **without installing browser input listeners** — the guard against a module-level `window` access.

### packages/client/ui-primitives/tests/tooltip.client.spec.tsx
740-line suite: observed-size placement, side flipping, clamping, pin-on-click, nested suppression, the focus/hover delay policy, the merged child ref, and the portal that moves only the bubble.

### packages/client/ui-primitives/tests/use-anchored-max-height.client.spec.tsx
The bottom-anchored overlay's max-height is clamped to the space above its fixed bottom edge and re-fits on resize.

### packages/client/ui-primitives/tests/use-anchored-position.client.spec.tsx
149-line suite: the frame-clearance top margin, end alignment, the panel-size observer, and the no-`ResizeObserver` fallback.

### packages/client/ui-primitives/tests/use-dismiss-on-outside-pointer.client.spec.tsx
Outside-pointer dismissal closes on a pointerdown outside the root and counts a portaled surface as inside.

### packages/client/ui-primitives/tests/user-text-styles.client.spec.ts
Reads `user-text.module.css` as text to assert the reference glyph scales with the consumer font (`1em`) and the slash chip uses the code face at the consumer size.

### packages/client/ui-primitives/tests/web-block.client.spec.tsx
212-line suite for the web card: the answer above the sources, the empty-state note, hostname labelling, non-http(s) URLs as plain text and the HTTP status line.

### packages/client/ui-primitives/tsconfig.json
Extends `tsconfig.base.client.json`; `rootDir: src`, `outDir: lib/types`; project references to the store, code-language and workspace-path packages; excludes `**/*.legacy.*`.

### packages/client/ui-primitives/tsdown.config.ts
tsdown build config via `staticLinked`, emitting `lib/types/index.js` and keeping third-party imports external for the Web shell.

---

## Ideas worth stealing

- **A terminal-accurate ANSI replayer with per-cell SGR state, emitting one canonical sequence per state change** — `packages/client/ui-primitives/src/ansi.ts:242` (`replayLine`), `packages/client/ui-primitives/src/ansi.ts:171` (`foldSgr`), `packages/client/ui-primitives/src/ansi.ts:209` (`openSgr`) — the state is *normalised* ("current state", not "sequence history"), which is what keeps the output linear in cell count; the file records the bug that motivated it: *"output that switches color without a full reset emitted O(n²) characters (3200 such cells produced 25 MB and eventually a `RangeError`)"*. **Why it transfers to August**: `run_command` output is model-visible and routinely contains progress bars (`\r`), spinners and colour resets. August's transcript card must (a) never let raw escape bytes reach the DOM and (b) paint a redraw the way a terminal would, because a progress bar that leaves its previous frame's tail standing is text the terminal never showed. The "each cell is stamped with the state it was written with" rule (`ansi.ts:248-252`) is the subtle part: a later redraw must not restyle cells it does not reach.

- **Incremental block-level parsing that freezes the prefix, keyed by absolute source offset** — `packages/client/ui-primitives/src/markdown/incremental.ts:38` (`UNSTABLE_TAIL_BLOCKS = 2`), `packages/client/ui-primitives/src/markdown/incremental.ts:310` (`update`), `packages/client/ui-primitives/src/markdown/incremental.ts:349` (the freeze cut) — re-parsing the whole accumulated reply on every chunk is quadratic in the final answer length; CommonMark block parsing is line-based, so only the last block can be reshaped by appended text. **Why it transfers to August**: August's assistant turn is an append-only stream. A per-chunk full re-parse of the whole reply is exactly the cost this removes, and the *key* choice (a block's absolute start offset, stable from the frame it first appears through freezing) is what lets React reconcile instead of remounting — the difference between a streaming reply that stays smooth and one that flickers. The stated trade (reference-style links across the freeze boundary render literally until the settled parse) is the kind of limitation August should state rather than hide.

- **Two grammars, one per rendering phase: the streaming arm has no math** — `packages/client/ui-primitives/src/markdown/parse.ts:27` (`parseGfm`) and `packages/client/ui-primitives/src/markdown/parse.ts:40` (`parseGfmWithMath`) — the header explains it: *"the streaming arm's grammar: no math, so incomplete TeX never flashes KaTeX errors mid-stream"*. **Why it transfers to August**: this is a general rule for model output — a half-formed construct should not be *interpreted* while it is still growing. The same rule should govern a JSON argument, a diff hunk and a YAML block in the tool-call stream, not just TeX. The pair is also the cheapest possible "settle" test: the settled render is the streaming render plus one feature.

- **One highlighter, three boot grammars, ~57 lazy grammars, and a viewport gate** — `packages/client/ui-primitives/src/markdown/highlight.ts:42` (`LANGS`), `packages/client/ui-primitives/src/markdown/highlight.ts:53` (`LAZY_GRAMMARS`), `packages/client/ui-primitives/src/markdown/useViewportHighlighting.ts:55` — *only the three grammars every session renders load at boot; every other language is a dynamic import, so a session that never opens a code surface in that language pays neither the grammar module nor its synchronous init.* Highlighting is also deferred until the block **intersects the viewport**, permanently, with a single shared observer released when the last pending block unmounts. **Why it transfers to August**: a transcript with fifty code blocks should not cost fifty grammar downloads or fifty synchronously tokenized documents at open. August's file-read and diff cards are the same shape.

- **A streaming highlight session that re-tokenizes only appended text and keeps completed lines' DOM** — `packages/client/ui-primitives/src/markdown/highlight.ts:478` (`StreamingHighlightSession`), `packages/client/ui-primitives/src/markdown/CodeBlock.tsx:58` (`STREAMING_LINE_GROUP_SIZE = 32`) — the session resumes from **saved grammar state**, so a template literal that spans lines is coloured correctly mid-stream, and completed lines are sealed into fixed-size React groups so later chunks reconcile only the growing group. **Why it transfers to August**: shiki's `codeToTokens` on a growing string is O(n²); August's streaming code fences would pay the same. The "fixed-size groups" trick (reconcile the group, not the line) is the part that scales.

- **A staged settings model: drafts are staged, one revision-fenced write happens on Save, and "overridden" means PRESENCE in the user layer, not a value comparison** — `packages/client/ui-primitives/src/settings-form/form-model.ts:195` (`SettingsFormModel`), `packages/client/ui-primitives/src/settings-form/form-model.ts:55` (`mutate(ops, expectedRevision)`), `packages/client/ui-primitives/src/settings-form/form-model.ts:1` (the rationale) — *"A control that committed as it settled turned one edit into a write the user never asked for and could not preview."* **Why it transfers to August**: August's brain-config writes are durable document mutations. "One save = one atomic, revision-fenced write of every staged edit" is a much better contract than "each field writes when it settles", and *presence* semantics for overrides is the difference between "the user changed this" and "this happens to differ from the default". The failure handling is directly reusable: a failed write **retains the drafts** so the user can retry.

- **A write-only secret field whose blank draft writes nothing** — `packages/client/ui-primitives/src/settings-form/fields.tsx:117` (the docstring) and `packages/client/ui-primitives/src/settings-form/fields.tsx:139` (the password input) — the credential literal never rides a response, so the control reports only whether one is configured and starts blank; a blank draft writes nothing, "which keeps the stored key rather than clearing it". **Why it transfers to August**: August stores provider keys, MCP secrets and service tokens. The failure this prevents is silent: a form that renders the stored value and writes back an empty string on save clears the credential.

- **One modal layer stack that owns Escape and Tab for the whole document** — `packages/client/ui-primitives/src/useModalLayer.ts:8` (`modalSelector`), `packages/client/ui-primitives/src/useModalLayer.ts:17` (`closeTopModal`), `packages/client/ui-primitives/src/useModalLayer.ts:62` (the keydown handler) — the rule *"a newer menu or unregistered dialog blocks dismissal of the modal behind them"* is decided by comparing the **foreground DOM element** with the registered top of the stack, and each layer restores the previous focus on close. **Why it transfers to August**: August has the settings shell, the plugin manager, risk confirmations and menus that can all be open over one another. One owner for Escape/Tab/focus-restore is much cheaper than each surface implementing its own, and the "unregistered dialog blocks the one behind it" rule is exactly the bug users hit when a stray overlay steals the Escape key.

- **`focusWithoutRing` — automatic focus (dialog entry, focus restore) suppresses the outline until the user actually navigates** — `packages/client/ui-primitives/src/focus.ts:12` — **why it transfers**: August's modal/drawer surfaces move focus automatically; a visible focus ring on a programmatically focused element reads as an error state, and removing the outline entirely breaks keyboard users. The attribute-based release (Tab/arrows/blur) gives both.

- **Input modality as two separate answers: tooltips follow the last input, focus rings follow navigation** — `packages/client/ui-primitives/src/input-modality.ts:28` (`pointerModality`) and `packages/client/ui-primitives/src/input-modality.ts:47` (the navigation-key rule) — modifiers and refocusing the *same* control deliberately keep the ring silent. **Why it transfers**: any harness UI that opens a hint on focus needs to know whether the user is driving with a mouse; the two-answer split is what stops a mouse-click from producing a keyboard-looking focus ring.

- **A 200 ms pointer grace before a pointer-dismissed popup closes** — `packages/client/ui-primitives/src/pointer-grace.ts:8` and `packages/client/ui-primitives/src/pointer-grace.ts:25` — sized to the anchor→popup gap (8 px for HoverCard, 4 px for Menu) at a hand's travel speed. **Why it transfers**: without it, every hover-card in August closes the instant the pointer crosses the gap — a bug that is invisible in code review and maddening in use.

- **A fuzzy ranker with a boundary-weighted alignment score, prefix hits first, source order for ties** — `packages/client/ui-primitives/src/rank-by-name.ts:28` (`alignmentScore`, O(name × query)) and `packages/client/ui-primitives/src/rank-by-name.ts:70` (`rankByName`) — the score rewards a match at a name start or a `-`/`_` boundary, an adjacent continuation (+4) over a gapped one (+1 minus the skip cost), and penalises a leading character by its index. **Why it transfers**: August has a `/` command palette and a plugin/skill catalogue; this is a small, deterministic, testable ranker that handles localized labels as a second key — the exact case where a naive `includes()` fails.

- **One hold value drives both the toast timer and the stylesheet's fade delay** — `packages/client/ui-primitives/src/Toast.tsx:81` (`--dsh-toast-hold`) — *"so the two can no longer disagree and leave the banner unmounting mid-fade."* **Why it transfers**: any timed, self-animating UI in August (a toast, a progress ring, a streaming indicator) has the same two-clock problem, and passing the value through a CSS custom property is the cheap fix.

- **Pin every loader's CSS animation to document time zero** — `packages/client/ui-primitives/src/StateDot.tsx:29` (`pinSpinner`) and `packages/client/ui-primitives/src/StateDot.tsx:19` (the `animationstart` re-pin) — *"A CSS animation starts when its element is inserted and restarts when the element is moved or shown again, so loaders started at different moments rotate out of phase; one shared start time keeps every visible loader in step."* **Why it transfers**: August's transcript shows several spinners at once (a running tool, a reconnecting socket, a background job). Out-of-phase loaders read as a janky UI.

- **A diff card with a bounded edit-graph search and a coarse whole-fragment fallback** — `packages/client/ui-primitives/src/DiffBlock.tsx:70` (`MAX_DIFF_EDIT_LENGTH = 256`) and `packages/client/ui-primitives/src/DiffBlock.tsx:73` (`localHunks`) — beyond the bound the fragment is shown and **counted** as one replacement, including shared lines. **Why it transfers**: August's `edit` tool diffs are model-authored and occasionally rewrite a whole file; an unbounded `structuredPatch` on such a fragment is a UI stall.

- **A link protocol allowlist that refuses relative and unparsable destinations, and refuses fragment anchors** — `packages/client/ui-primitives/src/markdown/render.tsx:53` (`sanitizeUrl`) — relative URLs are disallowed *alongside* disallowed protocols; the fragment refusal means footnote references render as plain text rather than in-page links. **Why it transfers**: every surface in August that renders model-produced URLs needs one allowlist, and the allowlist should be shared rather than re-implemented per surface.

- **Grammar-level fixes for what models actually emit** — `packages/client/ui-primitives/src/markdown/cjkFriendlyStrong.ts:55` (`cjkStrongClose`) and `packages/client/ui-primitives/src/markdown/mathCompatibility.ts:347` — `**注意：**内容` loses its emphasis under stock CommonMark, and `\(…\)` / `\[…\]` are not math under stock micromark. **Why it transfers**: this is the *model-output-compatibility* layer a harness needs and usually lacks. The extensions are deliberately narrow (asterisk strong only; punctuation-before + CJK-after; upstream behaviour untouched in code spans, math, fences and escaped text), and each has a spec that enumerates what must NOT change.

- **Recover local image syntax with bare spaces without touching source offsets** — `packages/client/ui-primitives/src/markdown/local-image-syntax.ts:17` — only an unescaped, image-only paragraph whose path is absolute/relative/drive-qualified and whose extension classifies as an image is recovered; the source text must equal the parsed text so an authored escape is never "recovered". **Why it transfers**: models write `![x](/path/with spaces/img.png)` constantly and stock CommonMark breaks it; the narrowness is what makes the recovery safe.

- **Prefix-equivalence as the correctness test for an incremental renderer** — `packages/client/ui-primitives/tests/markdown-incremental.client.spec.tsx:61` — for chunk sizes 1, 3, 7 and 16, the live streamed DOM must equal a fresh mount of the same prefix, **and** the frozen block's DOM node must be the *same node instance* across the freeze boundary. **Why it transfers**: this is the single best test pattern in the shard. It catches the class of bug where an incremental implementation is "mostly right" but diverges from the batch implementation at some prefix, and it catches the separate class where the implementation is correct but remounts (losing focus, scroll and selection). August's streaming reply renderer needs exactly this test.

- **Stylesheet-as-text assertions for the properties CSS Modules hide** — `packages/client/ui-primitives/tests/state-dot-styles.client.spec.ts:1`, `packages/client/ui-primitives/tests/tag-styles.client.spec.ts:1`, `packages/client/ui-primitives/tests/file-type-icon-styles.client.spec.ts:1`, `packages/client/ui-primitives/tests/disclosure-row-styles.client.spec.ts:1`, `packages/client/ui-primitives/tests/terminal-block-styles.client.spec.ts:1`, `packages/client/ui-primitives/tests/user-text-styles.client.spec.ts:1` — the header of `state-dot-styles` states the rule: *"a state whose rule is missing renders on the inherited color instead of its own, which no render assertion would catch."* **Why it transfers**: August's frontend has the same blind spot (CSS Modules resolve to class-name maps in the test lane). Reading the stylesheet as text and asserting the declarations is a cheap, high-yield gate.

- **An identity assertion that a shared lookup table is not copied** — `packages/client/ui-primitives/tests/code-highlighting.client.spec.tsx` — `expect(languageForPath).toBe(sharedLanguageForPath)`, plus a second assertion that *both* shipped hint projections reach the same grammar. **Why it transfers**: August has several places that classify a file's language or type (read card, code preview, diff review). One canonical table + an identity test is cheaper than a drift review.

- **Embedded SVG artwork with per-instance ids and a machine-checked safety contract** — `packages/client/ui-primitives/src/CodeFileIcon.tsx:13` (the `useId` substitution) and `packages/client/ui-primitives/tests/code-file-icon.client.spec.tsx:100` (no `script`/`style`/`foreignObject`, no external `href`, unique ids, manifest digests) — **why it transfers**: August renders file-type glyphs in tool cards; the "replace a placeholder token with a per-instance id" trick and the "reject unsafe markup and dangling local references at test time" gate are both directly reusable, and the manifest-with-digests pattern gives the artwork an auditable provenance.

- **A DOM snapshot corpus as a compatibility baseline, reviewed as user-visible diffs** — `packages/client/ui-primitives/tests/markdown-dom-parity.client.spec.tsx:22` (the serializer) and `packages/client/ui-primitives/tests/fixtures/markdown-dom/code-fences.settled.txt` — 24 corpus cases × settled/streaming (48 files), with the instruction *"review diffs as user-visible Markdown changes rather than regenerating them for refactors."* **why it transfers**: August's transcript renders arbitrary model markdown; a byte-stable DOM baseline turns "did this refactor change what the user sees?" into a reviewable diff instead of an opinion. The pair structure is the part worth copying: **one corpus, two snapshots per case** (settled and streaming), so a change that only affects the streaming arm is still a visible diff.

- **Geometry that is opt-out per surface, not opt-in** — `packages/client/ui-primitives/src/head-tail-cap.ts:23` and `packages/client/ui-primitives/src/TerminalBlock.module.css` (the `--dsl-terminal-*` variables) — one head+tail cap shared by the terminal, read, diff and search cards, with hosts rebinding CSS variables to change the wrapping rather than forking the component. **Why it transfers**: August's transcript mixes tool cards in one flow; a shared cap means a long command output and a long diff cut at the same place, and a host that needs a different policy changes a variable instead of a component.

- **Only overflowing text enters the Tab order** — `packages/client/ui-primitives/src/CommandText.tsx:41` — **why it transfers**: a transcript full of command lines would otherwise put dozens of static text runs in the keyboard's way; August's cards should add tab stops only where they are actionable.

- **A copy control that never claims success on a refused write** — `packages/client/ui-primitives/src/clipboard.ts:11` and `packages/client/ui-primitives/src/use-copy-feedback.ts:20` — `writeClipboard` returns a boolean and every caller leaves the success label off when it is false. **Why it transfers**: August's copy buttons are everywhere (paths, commands, diffs); "Copied!" on a failed write is a small lie the user discovers later.

- **The streaming grammar must be a SUBSET of the settled one, and the difference must be the only difference** — `packages/client/ui-primitives/src/markdown/parse.ts:27` (streaming: `gfm()` + `cjkFriendlyStrong()`) vs `packages/client/ui-primitives/src/markdown/parse.ts:40` (settled: the same two **plus** `mathCompatibility()` and `math()`) — the settled grammar is the streaming one plus exactly the math extensions, and the file's header says the arms *"differ only where TeX delimiters begin a math construct"*. **Why it transfers to August**: this is the cleanest statement of the rule I found anywhere in the shard — *the live arm and the final arm must be the same renderer with the live one missing only what cannot yet be judged*. August's transcript has exactly this problem with a tool call's JSON arguments, a diff hunk and a fenced command: a construct that is still growing should be rendered by a **narrower grammar**, and the final render by a superset, so the final output is a strict refinement of the live output rather than a different document. The corollary the fixtures make concrete: what the streaming grammar does *not* know can still be **mangled** by the grammar it does know (a `\(…\)` display formula loses its brackets to GFM's backslash-escape rule while streaming) — so the narrower grammar must be chosen so that the unknown construct survives intact as text.

- **The block key is an absolute source offset, so a block survives its own freeze** — `packages/client/ui-primitives/src/markdown/incremental.ts:346` (the frozen block is pushed with `blockKey(node, base, …)`) and `packages/client/ui-primitives/src/markdown/incremental.ts:352` (the tail uses the same key shape) — the key is derived from the block's **position in the source**, not from its index in the current block list, so it is identical from the frame the block first appears through the frame it freezes. **Why it transfers to August**: this is the mechanism that makes an append-only transcript smooth. If a streamed reply's blocks are keyed by position rather than by arrival order, React reconciles them instead of remounting them, and the user keeps their scroll position, their selection and their open disclosure state across the whole stream. The `markdown-incremental` spec asserts the DOM node *identity* is preserved across the freeze boundary, so this is not an aesthetic claim — it is a tested one.

- **A wide table stays keyboard-reachable because the CSS scroller does not** — `packages/client/ui-primitives/src/markdown/render.tsx:490` (the scroll container) and `packages/client/ui-primitives/src/markdown/render.tsx:493` (`tabIndex={wide ? 0 : undefined}`) — the comment names the reason: `overflow-x: hidden` drops Chromium's implicit scroller focusability, so the explicit `tabindex` is what keeps it reachable. **Why it transfers**: August's transcript renders model-authored tables and long tool output inside scroll containers. An overflow-hidden scroller that is not in the tab order is invisible to a keyboard user, and the fix is one attribute. The companion rule is just as reusable: **four or more columns is a comparison matrix** (`render.tsx:484`) and gets a wide layout, while a narrower table fills the column and wraps — the same threshold could decide how August renders a wide tool-result table.

- **A tool-result card must say what it is NOT showing** — `packages/client/ui-primitives/src/TerminalBlock.tsx:226` (the emptiness test runs on the **parsed** lines, not the raw text) and `packages/client/ui-primitives/src/ReadBlock.tsx:38` (the exact total line count, for the "showing N of M" note) — two mechanisms, one idea. A command whose output is only escape bytes must read as empty rather than as a box of blank rows, and a file read that returned a *window* must say how much of the file it did not return. **Why it transfers to August**: a tool card that silently truncates is a lie the user cannot detect, and the user is the only one who can tell the model the file is longer than the card showed. The "N of M" note is the cheapest possible honesty mechanism and it costs one extra field in the tool result.

---

## Files skipped (with reasons)

- `packages/client/ui-primitives/src/icons/index.tsx` — **huge vendored-looking icon catalogue**: 114 KB / 1658 lines. I opened lines 1–80 and sampled 800–830, counted the exports programmatically, and read the sibling `tests/icons.client.spec.tsx`, which pins the invariants over the whole set (aria-hidden, currentColor-only, distinct geometry). The census: 191 `export const` — 188 `Icon*` components (94 Regular + 94 Medium), `ICON_REGULAR_STROKE`, `ICON_MEDIUM_STROKE` and `SHIELD_OUTLINE_PATH` — over 95 distinct artwork names (89 local `const <Name>Artwork` shapes + 6 imported from `icons/shared-artwork.tsx`), with `IconQueueOutlineArtwork` a local wrapper over the shared `ChatLinesOutlineArtwork`. The remaining ~1570 lines repeat the same mechanical "one artwork definition + two one-line exports" pattern and were **not read line by line**; nothing in that file carries logic beyond the stroke constants and the per-icon path data.
- `packages/client/ui-primitives/src/code-file-icon-artwork.ts` — **vendor artwork blob**: 57 KB in 60 lines, where individual lines run to ~10 KB of embedded SVG path data (48 code-file glyphs from an internal design export). I read the header, the `CODE_FILE_ICON_ID_TOKEN` contract and the closing `satisfies Readonly<Record<CodeFileType, string>>` assertion, and `tests/code-file-icon.client.spec.tsx` pins the safety contract over every entry (no `script`/`style`/`foreignObject`, no external `href`, unique instance-safe ids, manifest digest coverage). The path data itself was **not read line by line** because it is vendor artwork, not logic.

No other file was skipped: every source, test, stylesheet, config, doc and fixture in the shard was opened and read.

---

## Uncertainties

- **What this shard cannot tell me about the harness.** The package is explicitly model-facing-neutral (`README.md:189`, `README.md:193`), so the lenses covering the **agent loop and tool-calling flow, prompt construction and KV-cache strategy, context-window management and compaction, memory/learning, subagent execution and tool-call reliability (retries, malformed arguments, timeouts)** have **no implementation in this shard** — only the *rendering* side of tool results and of streamed assistant text. The `ui-tool` package (named as the tool-call presentation layer at `README.md:179`) and the conversation package are the likely owners of the loop-side contracts; I did not read them, so I cannot say whether the same cards are fed by a tool-call layer that retries or repairs malformed arguments.
- **The "reasoning/thinking content" lens.** Nothing in this shard names a thinking or reasoning block. The closest thing is the streaming discipline in `src/markdown/incremental.ts` and `src/markdown/highlight.ts`, which is the *rendering contract* a reasoning stream would have to satisfy (append-only, frozen prefix, stable keys). Whether DeepSeek Harness renders a separate thinking channel is a question for a different shard — I checked this package's exports (`src/index.ts:1-119`) and found none.
- **`src/markdown/render.tsx` — CLOSED on this pass.** The first pass saw the inline-level node-rendering band only through the tool's middle-pruning. On this pass I read `render.tsx` in full: the head (the three URL sanitizers), the reference-target collector, the block/child wrapping, the whole `renderNode` switch (`render.tsx:273-373`) and the tail (the footnote section, `render.tsx:720-760`). The band turned out to carry four facts the first pass's note had missed: an **inline-code URL promotion** (a code span that is exactly an absolute http(s) URL becomes `<code><a>…</a></code>`, `render.tsx:304-310`); a **file-mention** affordance that becomes a `<button>` with a link glyph (`render.tsx:311-330`); the **wide/fill table rule** (`columns >= 4 && inBlockquote !== true`, `render.tsx:484`) with the explicit `tabindex="0"` that keeps a wide table keyboard-reachable; and the **per-column alignment** rendered as an inline `text-align` style on every cell of that column (`render.tsx:522-527`). Each is now reflected in the per-file note and in the ideas below.
- **`src/markdown/highlight.ts` — CLOSED on this pass.** The first pass saw `StreamingHighlightSession.updateFrame` only through the tool's middle-pruning. I have now read `highlight.ts:470-569` in full. The session keeps `prefix` (the newline-terminated source it has tokenized), `spans` (one entry per completed line) and `state` (the grammar state after that prefix), and `updateFrame` re-tokenizes only `code.slice(prefix.length)`, then re-seeds the state with `highlighter().getLastGrammarState(tokens)` (`highlight.ts:538`). That is the mechanism behind the claim that a template literal spanning lines is coloured correctly mid-stream, and it is now stated with the line that implements it. I also counted the lazy table programmatically: **`LAZY_GRAMMARS` holds exactly 57 entries** (`highlight.ts:53-111`), matching the 57 aliases the `code-block` spec exercises.
- **`src/JsonTree.tsx` middle section — PARTIALLY CLOSED.** I read the copy store (`JsonTree.tsx:78-101`) and the copy-action component (`JsonTree.tsx:103-165`) directly, which confirms the per-row notification design: the store holds ONE current snapshot and notifies only `{previous, next}` row ids, so hovering a new row cannot re-render the old row's JSON values. The per-node expansion logic further down the file was still not read line by line; the externally visible contract is pinned by `tests/json-tree.client.spec.tsx` (475 lines), which the first pass read in full.
- **`src/Menu.tsx` and `src/HoverCard.tsx` middle sections — PARTIALLY CLOSED.** I re-read the regions the first pass had missed and confirmed the claims it made: `Menu`'s `separatorBefore` renders the hairline as a **sibling** `<div role="separator">` before the row (`Menu.tsx:89`), the window-blur close is gated on focus having moved into an **iframe** (`Menu.tsx:132-133`), and the keydown handler treats `Shift+Tab` as a close (`Menu.tsx:340`, `Menu.tsx:349`); `HoverCard` carries the `copyEpochRef`/`copyingRef` pair the first pass described (`HoverCard.tsx:61-62`, incremented at `:84`, `:101`, `:132`). The row-rendering block inside `Menu.tsx` and the positioning block inside `HoverCard.tsx` were not read line by line; both are covered by their specs (`tests/atoms.client.spec.tsx`, `tests/hover-card.client.spec.tsx`, 682 lines).
- **The streaming arm's TeX delimiters are consumed, not merely inert.** The `math-*-streaming` fixtures show `\(\frac{1}{5}\)` rendering as `(\frac{1}{5})` and `\[…\]` as `[…]`. This is not a KaTeX decision: the streaming grammar registers no `mathCompatibility` extension, so in GFM a backslash before `(` or `[` is an ordinary **escape** and the bracket is consumed. The result is that a partially-arrived display formula shows a mangled-but-plausible string rather than the raw source. I verified this by reading `parse.ts:27-32` (the streaming grammar's extension list) and the two streaming snapshots; I did **not** verify whether the DOM baseline's authors considered this intended, so I am reporting it as an observation, not a defect.
- **Whether the 48 DOM fixtures are byte-stable against the current renderer** — I did not run the suite (the clone is untrusted and read-only), so I cannot confirm that the snapshots currently match. I read them as the *declared* baseline. What I *did* establish by inspection: 20 of the 24 settled/streaming pairs are byte-identical to each other (same MD5), and the 4 that differ (`code-fences`, `fence-trailing-blank-lines`, `math-edge-cases`, `math-inline-and-display`) differ for reasons visible in the snapshots themselves — the shiki `pre` wrapper/serialization on the fence cases, and the math grammar on the two TeX cases.
- **`package.json` peer dependency.** `@deepseek-ai/cordis` is a peer dependency at `workspace:~` while the package's own description says "zero cordis". I did not read the cordis package to determine whether the peer is a build-time artefact of the monorepo's shared tsconfig or a real runtime coupling; the source files I read import nothing from cordis.
- **The manifest is not wrong about this shard, but I did not modify it.** I confirmed the manifest's `owner-shard` column lists exactly these 252 paths under `dsh-client-primitives#2`, and the `size` column matches the clone byte-for-byte on the files I checked. I made no change to `C:/Dev/augustHarness/docs/research/deepseek-harness/manifest.tsv`.

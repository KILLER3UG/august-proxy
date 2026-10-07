# August Deep UI/UX Refactor — Design Spec (Stage 1)

**Status: v2 — APPROVED, MOSTLY IMPLEMENTED 2026-10-04, corrected by review the same day**
(27 commits on master; gates re-run and green: tsc, **1516/1516** vitest (not 1493),
check-design, check:docs, check:version). Post-approval additions: the sidebar destination dock
was rebuilt as labeled rows (the 6-icon strip matched none of the four references), and the
SavePointChip / SkillEvolvedChip landed with the sidebar trio.

**The four items previously listed here as "still deferred, with reasons" were SHIPPED** by
`c332b526`, and the stated blockers do not exist: `lib/shortcuts.ts` `APP_SHORTCUTS` *is* the
centralized dispatcher table App.tsx runs, and `ShortcutsModal.tsx` does keystroke search;
`settings-registry.ts` `settingHints` + `WorkspaceShell.tsx` `hintMatch` *are* the per-control
manifest; `skills.py` `/restore/{trashId}` *is* the undo contract; `RightDrawer.tsx` mounts
inactive sections with `inert` and `RightDrawerState.ts` gates their pollers on it, which *is*
Hide-vs-Close with the suspend primitive.

**Actually still not shipped (verified against source 2026-10-04):** `/settings?tab=X&field=Y`
deep-link field highlight · `react-icons/si` deep imports (`lib/file-icon.ts`, `lib/tool-icon.ts`
still barrel-import) · the 60/120/200/300/450 motion ladder (`lib/motion.ts` is still
120/180/240, though springs are now centralized there) · one thinking-disclosure primitive with
`variant="rail"|"plain"` (all three machines remain) · folding `ToolStepRow` into a
`ToolCallItem` variant · subagent tab-strip pruning, arrow-key roving, and the roster `x/y` todo
badge · the first-frame token pin, its test, and a *static* (non-pulsing) skeleton at last-known
sidebar width · `measureElement` debounce · "Copy error details" on the failed-update dialog and
the interruption warning in About · mobile `NSAppTransportSecurity` and the global
`user-select: none` strip · `aria` background-inert behind the settings dialog.

**Fixed in review (2026-10-04):** the Tasks group defaulted to collapsed *and* rendered no rows
while collapsed, so a fresh profile saw "Tasks 40" with an empty list and the `slice(0, 5)` /
"Show N more" branch was unreachable — now expanded by default with the dead branch deleted.
Scrollbar thumbs were hardcoded `rgba(255,255,255,.1)` in three rules and a *solid*
`--dt-muted-foreground` in the global one (the `opacity` on `::-webkit-scrollbar-thumb` is
ignored by Chromium), so the bar read white on charcoal and washed out on paper — now the
`--dt-scrollbar` / `--dt-scrollbar-hover` token pair, dim grey in both themes.

**Correction to §3.5 as written:** the <760 sidebar tier is unreachable in the packaged desktop
window (`minWidth: 960`) but is *not* dead code — the mobile companion is a WebView that loads
this same SPA at phone width (`frontend/mobile/App.tsx:150`), where it fires. Deleting it as
drift would break mobile. The 760-1100 drawer overlay is reachable on desktop and works.

**v2 supersession note:** an earlier same-day draft existed at this path (docs-level reference
research, lighter audit). v2 replaces it: all four references are now verified from local
installs/source where possible, the audit is line-cited, and the draft's stale claims are
corrected in the table below. The draft's good additions are folded in (sidebar rail-mode option,
mobile theme-sync/ATS, taskbar download progress, keystroke-search shortcuts page, "avoid"
patterns). Nothing approved was lost — nothing had been approved.

**Date:** 2026-10-03 · **Scope:** desktop-first (`frontend/desktop` + Tauri shell), mobile
hardening only · **Stack:** unchanged — Tauri 2, React 19, TS, Tailwind 3.4, Zustand 5,
TanStack Query 5, shadcn-style primitives. No library swaps, no Tailwind v4.

**Evidence base (written this session; cited as [R1-R4] research, [A1-A5] audit):**

| # | File | Method |
|---|---|---|
| R1 | [docs/ui-refactor/research/2026-10-03-reference-hermes.md](ui-refactor/research/2026-10-03-reference-hermes.md) | local checkout v0.21.5, source-read |
| R2 | [docs/ui-refactor/research/2026-10-03-reference-claude-desktop.md](ui-refactor/research/2026-10-03-reference-claude-desktop.md) | local MSIX v2.19675.0.0, asar-extracted tokens |
| R3 | [docs/ui-refactor/research/2026-10-03-reference-chatgpt-desktop.md](ui-refactor/research/2026-10-03-reference-chatgpt-desktop.md) | official docs + Store API (no local install; gaps marked UNVERIFIED) |
| R4 | [docs/ui-refactor/research/2026-10-03-reference-deepseek-harness.md](ui-refactor/research/2026-10-03-reference-deepseek-harness.md) | local install v0.2.0-rc.2 asar + open-source repo (MIT) |
| A1 | [docs/ui-refactor/audit/2026-10-03-audit-shell-sidebar-drawer.md](ui-refactor/audit/2026-10-03-audit-shell-sidebar-drawer.md) | read-only code audit |
| A2 | [docs/ui-refactor/audit/2026-10-03-audit-chat-surface.md](ui-refactor/audit/2026-10-03-audit-chat-surface.md) | read-only code audit |
| A3 | [docs/ui-refactor/audit/2026-10-03-audit-settings-memory-skills.md](ui-refactor/audit/2026-10-03-audit-settings-memory-skills.md) | read-only code audit |
| A4 | [docs/ui-refactor/audit/2026-10-03-audit-tokens-icons-update.md](ui-refactor/audit/2026-10-03-audit-tokens-icons-update.md) | read-only code audit + check-design run |
| A5 | [docs/ui-refactor/audit/2026-10-03-audit-mobile.md](ui-refactor/audit/2026-10-03-audit-mobile.md) | read-only code audit |

**Corrections to `AUGUST-UI-ENHANCEMENTS.md (now in docs/plans/)`** (the untracked merged plan from earlier
today) — apply these when reading it; do not trust its stale lines:

1. `WhatsNewModal` **is reachable** (user-dropdown "What's new?" → `SessionList.tsx:171,785`) — not dead.
2. UpdateSection **no longer** claims "up to date" after a failed check — the error branch renders first (`UpdateSection.tsx:76-80`). The real residual gaps: toast-only download/install failures, no Cancel in About.
3. Release-notes `<pre>` lives at `UpdateSection.tsx:101-107`, not `useAppUpdate.ts:47-49`.
4. The dead `installing` phase is read at **10 sites**, not 4; during `restarting` the overlay pill reads "installing" (`UpdateRelaunchOverlay.tsx:38-42`).
5. Sidebar resize is not purely mouse-only — touch works and `role="separator"` exists; what's missing is keyboard (`SessionSidebar.tsx:119-131`).
6. Counts moved: text-3xs 135 files / text-2xs 128; settings controls 219 (not 103); MemorySection 41 controls (not 14); search keywords 304; raw status-color files 52 (not ~20).

**Not verifiable this round (say-so per ground rules):** no UI screenshots were provided with
the request — no reference claim rests on them; ChatGPT desktop tokens/icons are UNVERIFIED [R3];
chat.deepseek.com's logged-in UI is UNVERIFIED (login-walled) [R4]; Hermes "Pantheon" codename
weakly sourced [R1]. When screenshots arrive, Stage 2 Phase 0 checks §1-§3's reference claims
against them before implementation starts.

---

## 0. Design principles (extracted from the four references)

The rules the four references converge on, stated as August invariants:

1. **First frame is the final layout.** No splash: a static skeleton of the real shell in
   `index.html` before React, at last-known pane widths, ground color inlined from the OS scheme
   and test-pinned to the token (R2 §1). August already paints pre-CSS background
   (`index.html:10-14`, A4 §1) — extend to a skeleton.
2. **Tokens over literals, one owner per concern.** Every visual constant lives in one file,
   checked by tooling (R1 §2 "a stale name in this file is a bug"; R4's 75-alias architecture).
   August's `--dt-*` + `check-design.mjs` is the right skeleton — the leaks are the bug (A4 §2).
3. **Honest states.** Never fabricate progress; never fake status ("Free" plan suffix, "already
   in the desktop app" toast — A1 §2, A4 §2); distinguish *rejected installer* from *network
   failure*; NSIS install progress is unknowable and the UI says so.
4. **Attention economy.** Background events update badges, never steal focus or replace the
   foreground transcript (R1 §3 verbatim rule); unfocused parallel panes desaturate ~20% (R1 §4).
5. **Keyboard is a contract, documented and generated.** One shortcuts surface generated from
   the real accelerator table (R2 §8); Escape closes exactly one layer (R1 §8 — August
   double-fires today, A3 §8).
6. **Flat surfaces, hairline seams, shadow-as-elevation.** No card-in-card; overlays float on
   hairline + soft shadow, not borders (R1 §2, R4 §2); 1px ring shadows + 6px focus glow (R2 §2).
7. **Archive, don't delete, where history matters** (R4 §3); **red only for explicit failures** —
   in-data errors are neutral notices (R1 §8, R4 §8).
8. **Every screen has an empty, loading, and error state**, and none is blank (R4 §1; August's
   two blank failure paths are confirmed bugs, A2 §7).
9. **Error cards name the failing layer** (provider/model/endpoint/streaming/auth/…) with matched
   recovery actions (R1 §8) — August's eight-family error taxonomy already exists backend-side;
   the UI should surface it (v1 draft addition, kept).

---

## 1. Design tokens

**Keep the architecture** (A4 §1 verified healthy): `--dt-*` in `src/styles/tokens.css` wired
through `tailwind.config.cjs` as `hsl(var(--dt-*-hsl) / <alpha-value>)`; 3 fg tiers (actual
contrast 16.4/8.5/5.1 light, 16.8/11.5/7.9 dark — exceeds targets); 4-rung elevation; 4
`data-text-size` presets (0.92/1.00/1.08/1.18); Inter Variable + JetBrains Mono bundled via
fontsource, CSP-enforced local-only. **Do not rebrand to any reference palette** — August's
warm-neutral `#fbfbfa`/`#0F0F0F` grounds are one step from Claude's `#fcfcfb`/`#151515` [R2 §2]
and stay. Keep `color-mix` chat-surface derivation so `customize_ui` overrides keep working
(v1 draft point, verified sound).

### 1.1 Color — fixes only

| Change | Evidence | New token |
|---|---|---|
| One sunken-surface color for terminal/file-preview chrome (currently `#181818`×6, `#171717`, `#111`×2 across 5 files) | A4 §2 | `--dt-surface-sunken` (dark: near-`#171717`; light: warm paper-grey) |
| Overlay scrim + strong hairline as tokens (rgba with no light inverse at `UpdateProgressBar.tsx:60,68`, `RightDrawerBrowserSection.tsx:128`, `BackendBootstrapGate.tsx:189`) | A4 §2 | `--dt-overlay-scrim`, `--dt-hairline-strong` |
| Diff add/del washes hardcoded in `DiffView.tsx:6-8,284,286` despite existing tokens | A4 §2 | reuse `--dt-code-added/removed-wash` |
| "Paper" role `bg-[#fdfdfb]` (`CircuitSchematicEditor.tsx:367`) | A4 §2 | `--dt-paper` |
| **Status palette sweep: 52 files use raw `text-green/red/amber/emerald-400`** which fail AA on light (1.74:1/2.77:1/1.67:1) while `--dt-*-fg` tokens exist | A4 §2 | mechanical sweep to status tokens; new `check-design` rule for raw `-400` status classes |
| Dark-tuned hardcoded surfaces render unchanged in light mode (`RightDrawerFileSection.tsx:37,88` no `dark:` prefix; `WorkspaceTrendChart.tsx:221,280`; `FeatureFlowCanvas.tsx` 28 hexes) | A4 §2 | token or light inverse each |
| `THEME_PRESETS` are dark-only in a UI that sells light | A4 §1 | light counterparts or hide in light mode |
| Dark-only alphas (`bg-white/[0.04]`, `bg-black/20`) in light-reachable surfaces | v1 draft §2.1, A4 §2 | `bg-muted` / elevation tokens |
| Elevation: shadow-not-border for elevated surfaces (border 0 + `shadow-elev-*`); 0.5px hairlines for neutral borders, 1px reserved for dashed affordances and state-colored borders | R4 §2, R1 §2, existing doc §11.4 | CSS guidance + sweep |
| Page insets as tokens (Hermes `PAGE_INSET_X` `clamp()` pattern) replacing `px-6`/`px-8` literals in the shell | R1 §2 | `--shell-inset-x` |

### 1.2 Type

- Collapse the two overlapping sub-xs rungs into one: **`text-2xs` (0.6875rem/11px) is the only
  sub-xs step**; migrate all 441 `text-3xs` uses (10px is too small for the same metadata; churn
  is symmetric). Keep `px-type` ratchet at 0. Tier-3 text only at ≥11px after the merge.
- Keep the 4 `data-text-size` presets. **Do not** adopt DeepSeek's 10-22px stepper (August's
  presets + rem scaling cover it; the *pattern* — content scale separate from UI scale — is
  already satisfied). Document that chrome never scales.
- Composer input floor: **16px** (Claude-verified `--cds-font-size-text-entry-floor`, R2 §2);
  the mobile shell already forces 16px in the WebView [A5 §2] — bring the desktop composer up.
- Dark-mode optical-weight pin on `<b>` (`font-variation-settings "GRAD"` bump) [R2 §2].
- Radii: keep August's scale; four named rungs, no new arbitrary values; optional
  `@supports (corner-shape: superellipse(1.5))` progressive squircle on cards/popovers after
  visual review (R4 §2 pattern; WebView2 is Chromium).

### 1.3 Motion

- **Scale formalized in `lib/motion.ts` and enforced:** 60ms (press) / 120ms (control) / 200ms
  (panel) / 300ms (sheet) / 450ms (slow), eases `out` / `overshoot` / `snap` [R2 §8]. Map August's
  120/180/240 onto it. Ban hand-rolled springs outside `motion.ts`
  (`UpdateProgressBar.tsx:55`, `UpdateRelaunchOverlay.tsx:82` — A4 §9); overshoot reserved for
  pill/chip entries.
- **One running-text treatment:** the existing `.shimmer` becomes the single "working" affordance
  with DeepSeek's timing (300ms delay / 1s sweep / 500ms rest, icons excluded) [R4 §8]; spinners
  remain only for indeterminate waits with no text row.
- Hover-revealed message actions: **100ms-delayed fade-in, instant fade-out** [R2 §8] + keyboard
  reachability (§4.4).
- Reduced-motion coverage is already strong (three coordinated layers, A4 §9) — keep; every new
  animation must honor it.

---

## 2. Icon system

**One library: `lucide-react` (203 files already). `react-icons` only for third-party brand
marks** (6 sites), with the two `react-icons/si` barrels (`lib/file-icon.ts:29`,
`lib/tool-icon.ts:37`) converted to deep imports so ~3,000 modules stop being pulled for ~12
glyphs (A4 §4). Merge the duplicate brand maps (`brandIcons.tsx` vs `IntegrationCard.tsx:16`).

**Standard:**

| Token | Size | Use |
|---|---|---|
| `icon-xs` | 12px (`size-3`) | inline with 2xs text; chips |
| `icon-md` | **16px (`size-4`) — default** | nav rows, buttons, tool rows |
| `icon-lg` | 20px (`size-5`) | section headers, empty states |
| (illustration) | ≥24px | empty-state heroes, chart geometry only — never chrome |

- **Class-only sizing; `size={N}` props are banned** (14 distinct values today incl. magic
  10/13/15/17/60/72 — A4 §4).
- **Merge `size-3.5` (370×) into `size-3` (384×)** — visually indistinguishable; `AUGUST-UI-ENHANCEMENTS.md`
  already ruled "keep size-3". One avatar size: **`size-10`** (size-10/11/12 split today).
- **Stroke: lucide default 2, never overridden** (overrides exist only in hand-rolled SVGs slated
  for deletion). DeepSeek's documented lesson applies: pick a different glyph rather than thicken
  (R4 §7).
- Delete the 9 hand-rolled SVGs; keep the 5 parametric/illustrative ones (hero glow, ContextRing,
  3 chart graphics) as data-viz members, `aria-hidden`, moved to a shared home [A4 §4, v1 §3.2].
- Tooltip contract from R1 §7: tooltip only when hover teaches something; never on menu
  triggers/close X; **no native `title=`** (Hermes fails a test on it — adopt that test);
  200ms first-open delay.

**Icon mapping** — every current icon resolves to a lucide glyph by semantic role; the 9 deletion
sites map as below (each verified at implementation by rendering both):

| Current site | Role | Replacement |
|---|---|---|
| `ChatMarkdown.tsx:64` (raw HTML string) | copy code | `Copy` / `Check` (copied state) |
| `DisclosureRow.tsx:58` | expand/collapse | `ChevronDown` (rotate) |
| `ModelPickerDropdown.tsx:179,195,312` | check / chevron / external | `Check`, `ChevronDown`, `ExternalLink` |
| `AssistantMessageActions.tsx:67` | action glyph | lucide equivalents already used elsewhere in the same row |
| `UserMessageBubble.tsx:160,171,189` | copy / pencil / revert | `Copy`, `Pencil`, `Undo2` |
| `ComposerAttachmentChips.tsx:42` | file chip | existing `FileIcon` primitive |
| `lib/file-icon.ts` / `lib/tool-icon.ts` barrels | brand marks | deep `react-icons/si` imports, one shared map |
| Keep: `ChatEmptyState.tsx:48`, `ContextRing.tsx:169`, `WorkspaceDonut.tsx:90`, `WorkspaceTrendChart.tsx:149`, `CircuitSchematicEditor.tsx:364` | illustration/parametric | unchanged |

---

## 3. App shell

### 3.1 Launch & onboarding

Current true sequence (A1 §1): no splash → pre-CSS ground color → `BackendBootstrapGate` veil
(z-200, 1s poll, one auto-restart at 8s) → `LaunchConversation` scripted animation → reveal; two
**ungated** first-run overlays (`OnboardingTour` + `ProviderOnboardingModal`) that can stack;
`/` auto-creates a session so the user never sees an empty list.

Spec:
1. **Static first-frame shell** in `web-dist/index.html`: ground color inline (already), plus a
   skeleton sidebar strip at the last-known width and a 44px drag strip, hidden when React
   mounts (R2 §1). Test-pin the inline color to the token (Claude's `mainWindowFirstFrame.test.ts`
   pattern).
2. **One onboarding orchestrator.** `OnboardingTour` and `ProviderOnboardingModal` render
   mutually exclusively, sequenced tour-then-provider, both Escape-dismissible with the focus
   trap kept. "Skip setup" stays a durable skip (exists: `august-onboarding-skipped`) —
   Hermes/DeepSeek agree the skip must be real; adopt DeepSeek's versioned-notice pattern
   (re-show welcome copy when it materially changes, R4 §1).
3. **Provider/API-key setup** keeps `/settings/providers` and adopts the field-hygiene contract:
   `autocomplete="new-password"`, write-only storage, green/red dot state, never echo the value
   (R4 §1; August already masks — verify the autocomplete attribute).
4. Boot-failure card keeps the 10s/30s escalation and gains **auto-expanding log output** on
   failure (R1 §1) so a broken backend explains itself; surface the backend's auto-restart
   signal when it fires (v1 draft point).
5. Auto-created session on `/` stays.

### 3.2 Titlebar

- **One height.** `--shell-titlebar-h: 44px` consumed by `ChatTitlebar.tsx:123` and
  `chat.css:385-390` (the `!important` block dies); window buttons uniform **40px** (38/38/42
  today, A1 §2) with token hover states (`hover:bg-white/10` → token; destructive red stays for
  close).
- `isMaximized` subscribes to Tauri resize/maximize events so the restore glyph never goes stale
  (A1 §2 confirmed bug).
- Window controls render only when `isTauri` (no-ops in the mobile WebView today — v1 draft §2.1).
- Keep: drag regions, close→`QuitConfirmModal` routing, Back/Forward, folder/branch chips;
  `aria-label` on icon-only Artifacts/Share buttons (title-only today, v1 §2.1).

### 3.3 Left sidebar

Structure stays (verified complete against references: new chat, search, pinned, BotsRail,
folders, capped recents, account footer — A1 §3). Fixes and adopts:

1. Keyboard-resizable separator copying the drawer's own pattern (`role="separator"` +
   `aria-valuenow/min/max` + arrows).
2. Re-clamp width on window resize (drawer does; sidebar doesn't).
3. `window.prompt` rename/folder-create → styled dialogs (also a mobile WebView no-op today).
4. Delete the dead store subscriptions (`SessionSidebar.tsx:42-44`) re-rendering chrome on every
   session-state change.
5. **Needs-attention lane** (existing doc §11.4, Hermes "Active now" R1 §3): the 15s
   `getNeedsAttention` poll already feeds amber dots; group them into a lane instead of scattered
   per-row dots.
6. Session search by title **or id**, with the drawer's instant + debounced pattern and capped
   results (R4 §3). Today: title filter only.
7. Written invariant (comment + spec): background events update badges, never steal the
   foreground transcript (R1 §3).
8. **Avoid (verified user backlash):** never reduce history to "5 recent + more" or move it to a
   pop-up — ChatGPT shipped both and users revolted [R3 §3].
9. **Open decision (§10.8):** a 56px **rail mode** as a third sidebar state (DeepSeek R4 §3 /
   Hermes R1 §3 pattern, proposed by the v1 draft) vs the current two-state collapse. Not required
   for any other phase.

### 3.4 Right panel (drawer) — including multi-subagent

Verified today (A1 §4): 13 section ids, Zed-style tab strip, single active view, MAX_SECTIONS=4
with **silent oldest-drop**, terminal as a separate bottom dock, keyboard-resizable handle,
Escape-close. `RightDrawerSubagentsSection` has per-worker tabs, per-agent todos (ProgressPopover),
elapsed timers, per-worker steer/stop, stop-all, search dropdown — the drawer already supports N
workers; the gaps are findability, honesty, and attention.

Spec:
1. **Keep one detail pane; add an always-visible compact roster strip** (status glyph + label +
   elapsed per worker; detail pane below). Side-by-side columns inside a 420px drawer would leave
   each transcript <200px — unreadable (existing doc §11.5 recommendation, confirmed A1 §4).
2. **Fix the no-op "Remove view" ×** (`RightDrawerSubagentsSection.tsx:519-527` removes nothing):
   implement per-tab dismissal (local hidden set) or remove the button.
3. **Prune the tab strip to live + latest-N runs** (it accumulates every persisted delegation of
   the session, A1 §4); full history stays in roster/search.
4. **Attention affordance for finished/failed-while-unseen workers:** tab badge state (and roster
   listing) until viewed — Hermes' hidden-bot eye/badge pattern (R1 §3). A failed worker must be
   impossible to miss.
5. Tab strip becomes a real `role="tablist"` with arrow roving (plain divs today, A1 §8).
6. **Scope the 1s elapsed ticker** to the elapsed labels instead of re-rendering the whole
   section (including the selected timeline) every second (A1 §4).
7. **Per-agent todo progress visible in the roster** (`x/y` badge from `SessionAgentRow.todos`,
   which already exists per-worker but renders only inside the selected worker's popover — v1 §2.1,
   confirmed A1 §4).
8. MAX_SECTIONS stays 4 but overflow becomes honest: toast "Replaced oldest section: X" (or an
   explicit replace prompt); `SECTION_ORDER`/chooser mismatch fixed (`RightDrawerState.ts:37-48`
   vs `RightDrawer.tsx:343-356`).
9. **Open-in-same-step:** file links, tool-row line references (`#L24`-style), and diff actions
   expand the drawer and activate the target section atomically (DeepSeek `openResource`, R4 §4;
   v1 §3.3.4).
10. **Hide-vs-Close semantics** for stateful sections (terminal keeps scrollback, browser keeps
    live page): Hide parks the body mounted+inert; the tab × releases it (R1 §4). *Needs approval —
    §10 decisions.*
11. Container-query responsiveness per Phase 5; per-session layout persistence (DeepSeek
    `dsh.sidebar-right.v1`, R4 §4) deferred — note only.

### 3.5 Responsiveness

- The single `@media (max-width: 900px)` is **dead code in the packaged app** (min window 960 —
  A1 §5). Replace with the container-query plan (existing doc Phase 5): ≥1100 all docked;
  760-1100 drawer becomes a scrim overlay; <760 sidebar overlays too. Container queries, not
  viewport media queries, because the drawer closes independently of window width.
- Keep `decorations:false` discipline, CSP (no remote assets), and the mobile-CSS coupling rule:
  any renamed shell class gets checked against `frontend/mobile/App.tsx` (A1 §5.1; coupling is
  real though mostly dead — A5 §6).

### 3.6 Keyboard

- Add: **`Mod+B`** toggle sidebar, **`Mod+J`** toggle drawer (Claude/Hermes parity; today no
  shortcut toggles either, A1 §6); document the composer-focus hotkey (`Ctrl+Shift+Space` exists,
  undocumented in ShortcutsModal).
- Fix ShortcutsModal omissions (Ctrl+N missing) — better: **generate the modal from the real
  accelerator table** so it cannot drift (R2 §8).
- **Shortcuts page with keystroke-search mode** (search by command name *or* by pressing keys,
  reset-to-defaults — ChatGPT pattern R3 §5; v1 §3.4 addition).
- Escape layering: one press closes exactly one layer. Known violations: settings double-fire
  (§5.3) and `ClarifyTool`'s document-level listener (A2 §9).
- Keep: Ctrl+K palette, `?` shortcuts, `,` settings, Esc stop-stream semantics.

---

## 4. Chat surface

### 4.1 Tool rows (existing doc Phase 6, audit-confirmed)

`AssistantBlockTimeline.renderFlatProcess` is canonical (A2 §2). Plan: fold `ToolStepRow`'s
Task-based rows into a `ToolCallItem` variant and delete `hideProgress` (three independent
"Reading/Read" progress lists exist — A2 §1); collapse legacy `ToolCallCard` by delegating to the
canonical row (serves only pre-migration `role:'tool'` restores — A2 §2 verified), which also
fixes its non-expandable state; delete dead `ToolBlock` and `ReasoningBlock`. `ClarifyTool` keeps
its own card (multi-question state machine is genuinely different) but gets a deliberate home and
a scoped key handler (A2 §3/§9: document-level 1-9/arrows + per-mount listeners; scope to the
card, one listener — it can steal digits typed into contenteditable surfaces today).

### 4.2 Thinking — one disclosure, three machines today

Audit found **three** collapse machines, not two (A2 §6): `expandOverrides` map, `ActivitySummary`
open state (two auto-collapses of its own), and `ThinkingDisclosure` (live only in subagent
timelines; `ReasoningBlock` wrapping it is dead). Unify into one disclosure primitive with
`variant="rail" | "plain"`; `ActivitySummary` remains the pack-level collapse. Adopt DeepSeek's
collapsed-title format: quiet summary + activity rollup — August's completion mode ("Task
completed · 1 file, 1 search…") is already close; the running title gains elapsed time.

### 4.3 Streaming & scroll (existing doc Phase 7, audit-confirmed)

1. Release the pin when the streaming message exceeds viewport height (drag-anchor bug).
2. Unify the two scroll thresholds (80px / 200px) into one token.
3. Debounce `measureElement` (measure→scroll→measure feedback loop).
4. Render the unused `'loading'` history status as a skeleton (A2 §5: never rendered).
5. Throttle the "New content" pill (fires on every growth tick while unpinned).
6. Verify every row-visual change at **39 and 40 messages** — virtualization flips DOM structure
   (`space-y-5` vs absolute translateY) and row spacing differs across the boundary (A2 §1).
7. Reasoning streams: **append-only, never smooth-reveal** (R1 §8 — the re-type flash hits
   token-streaming reasoners hardest); `useSmoothReveal` stays for final answers only; verify
   ThoughtStep doesn't run the reveal today.

### 4.4 States, actions, micro-interactions

1. **History-load failure and `agentsQuery` failure render nothing today** (A2 §7 confirmed) —
   add inline error states with retry (existing doc §6.4).
2. Assistant/user hover action rows: fix the dead `group-focus-within` selector
   (`AssistantMessageActions.tsx:38` — actions are mouse-only today) and adopt Claude's
   delayed-in/instant-out timing (R2 §8).
3. Red reserved for explicit failures; in-data errors neutral (R1 §8 — matches the harness's
   eight-family error taxonomy). Error cards **name the failing layer** with matched recovery
   (principle 9).
4. Queued-message placeholder stops being synthesized assistant text (A2 §2 — structured queued
   card, consistent with QueuePills).
5. SavePointChip + transcript rewind, SkillEvolvedChip: build as existing doc §11.1/§11.2 (backend
   APIs verified present: save points `openapi.ts:6893`; skills suggestions `openapi.ts:1289`).
   Patterns to copy: `TurnProvenanceChip` / `CompactionNoticeCard`.
6. Double-Escape stop with `Esc Esc` tooltip (R4 §8): *optional adopt, needs approval* — August
   already stops on single Esc while streaming.
7. Giant-paste → attachment conversion with notice (~10k chars; ChatGPT-verified, R3 §8).

### 4.5 Composer

Keep everything verified good (drafts per session, queue pills, steer button, mode selector,
model/effort flyout, context ring with conservative max-derivation — A2 §10).

---

## 5. Settings

### 5.1 Information architecture

Existing doc Phase 9 with audit-corrected numbers (45 sections, 43 implemented, 17 rail rows,
304 keywords — A3 §1):

1. **Four groups: Setup · Agent · Data · App.** Drop the inert `advanced` tier (the "Show
   advanced" toggle does not exist — A3 §2), delete `RAIL_CHILDREN`, fix stale self-documentation
   (`settings-registry.ts:6,72-73,89-93,136-137`, `SettingsPage.tsx:1`).
2. **Search indexes settings, not just sections** — individual control labels + descriptions with
   deep-link highlight (`/settings?tab=X&field=Y`, R1 §5 schema-driven pattern; the brain-config
   schema can power it). Today: literal `String.includes` over three fields, 304 keyword crutches.
3. **Row primitive**: `SettingsSectionShell` has exactly one consumer (A3 §3); adopt
   section-by-section (worst hand-rollers named in A3 §3); consolidate duplicated
   switch/search/chip primitives.
4. Implement or remove `hooks`/`indexing`; fix the "N of M" denominator
   (`SettingsPage.tsx:169-175`); delete `CommandPalette.tsx:45`'s hard-coded duplicate.
5. Scope vocabulary: UI says global/project; DB says global/`bot:<id>` (A3 §4) — document the two
   meanings of "scope" in the section header rather than renaming either.

### 5.2 Memory & Knowledge

1. **Restore the memory-data surface** using the 98-line, zero-call-site `brain-backup.ts`
   client (A3 §4): backups list, integrity read, staged restore (restore itself stays
   next-launch-applied per AGENTS.md — the client already models staging). Today the only bulk
   memory action is "Purge memory" (`PrivacySection.tsx:215`): a user can delete everything and
   back up nothing.
2. **Fix the four gates vanishing on the global pane** (`MemorySection.tsx:840`, pinned by
   `MemorySection.layout.test.tsx:123` — update the test). Gate defaults verified correct
   (`memoryAutoInject` OFF both sides).
3. Keep the JSON decode/re-encode round-trip exactly as verified (A3 §4).
4. Skills: render the computed-but-invisible `{okRateWith, okRateWithout, lift}` from
   `/api/brain/skills/suggestions`; add sort, bulk enable/disable, undo-on-delete (existing doc
   §10.2, A3 §5).

### 5.3 Settings modal a11y & behavior

1. `WorkspaceShell` becomes a real dialog: `role="dialog"`, `aria-modal`, focus trap,
   click-to-close scrim, background inert (A3 §8 — none exist today).
2. **Fix the Escape double-fire**: one Escape in a nested confirm/model-edit/menu also exits
   Settings (`WorkspaceShell.tsx:135-141` + bubbling document handlers, A3 §8).
3. `aria-current="page"` on the active rail item; `aria-pressed` on filter chips; label the
   memory search input (A3 §8).
4. `focus-visible:ring` pass over the `outline-none`-only inputs listed in v1 §2.1 (still valid —
   sampled against A3 §8).
5. Deep-linking/legacy-alias routing stays as verified (A3 §2).

---

## 6. Update flow

### 6.1 State machine

Replace `AppUpdatePhase = idle | downloading | ready | installing | restarting`
(`app-update-install.ts:7`) with:

```
idle → checking → available → downloading (progress) → ready → restarting
                     ↓               ↓
                  (dismiss)      failed | cancelled
```

- `checking` becomes a real phase (today UI-local; the overlay is silent — v1 §3.5 keeps that:
  silent overlay, About shows the spinner).
- **`failed`** with a reason class: `network` (retry affordance) vs `signature` (rejected
  installer — materially different copy; minisign verification lives in
  `download_release_installer`, A4 §6). Never fall through to up-to-date copy while `available`.
  Failed dialog gets Retry, "Copy error details", and a manual-download fallback link (v1 §3.5).
- **`cancelled`** distinct from failed; Cancel exists in **About** (only the overlay has one
  today) backed by the existing `cancel_update_download` command.
- **Delete `installing`** — written by nobody, read at 10 sites; fix the mislabeled `restarting`
  pill that reads "installing" (`UpdateRelaunchOverlay.tsx:38-42`).
- "Later" becomes durable (persist dismissal; the `downloaded_installer` rediscovery path already
  re-surfaces a staged installer after restart — A4 §6).
- **Taskbar progress** on Windows during download (Tauri `setProgressBar`; v1 §3.5).
- **Interruption warning before restart:** list running turns/agents before "Restart to update"
  (DeepSeek R4 §6 / Claude idle-guard spirit R2 §6).

### 6.2 Presentation

- Download progress keeps the real `update-download-progress` event (150ms-throttled bytes —
  honest); **install progress stays unknowable under NSIS and the UI says "the installer will
  open" rather than faking a percentage**.
- Release notes render as **markdown** (`UpdateSection.tsx:101-107` is a raw `<pre>` today), full
  view via the already-reachable `WhatsNewModal` + a link from About.
- Keep the 5-command Rust contract and event shape; keep no-rollback (structurally absent by
  design; `wipeStaleTree` untouched); `windows.installMode:"quiet"` is inert on Windows — remove
  or comment as such (A4 §7).
- The two install/update data guards (empty memory on new install; keep everything on update) are
  untouched — no update-path change may relax them (AGENTS.md).

---

## 7. Mobile companion

Facts (A5): 383-line WebView wrapper; ~60% of its injected CSS targets classes that died in the
2026-06 desktop migration; its visual audit targets a DOM that no longer exists; stock Expo
template icon; no splash config; name "mobile"; two drifted token sets; zoom disabled; no auth on
the backend it loads (pre-existing, out of UI scope but worth stating).

**Recommendation: keep-but-harden (Phase 12). Native redesign is out of scope** — there is no
native UI to redesign; the WebView path is nearly all deletions:

1. Delete the dead bootstrap rules (`App.tsx:43,53-61`) and the unrunnable
   `audit-mobile-visual.js`; keep `audit:parity` (its live checks silently skip without a
   backend — make that loud).
2. Reconnect the only live coupling: once Phase 3 tokenizes the purple/violet classes out of the
   desktop (6 files still emit them), the de-branding overrides become unnecessary and go.
3. **Theme sync:** the native shell reads the SPA's resolved `august.theme` (storage event /
   postMessage) instead of `useColorScheme()`, so chrome and content agree; `StatusBar` follows
   the resolved theme (v1 §3.3.6).
4. Brand the shell: `app.json` name "August"/icon/splash (not the Expo chevron), version synced
   to desktop; `NSAppTransportSecurity` local-HTTP exception so a release iOS build can reach
   `:8085` (v1 §2.2).
5. A11y minimums: allow pinch zoom (remove `user-scalable=no`, WCAG 1.4.4), labels on
   WebView/loading/error, no global user-select strip, `accessibilityRole="alert"` on the error
   card.
6. Token handoff (later, optional): expose `--dt-*` values over an existing endpoint so
   `getShellColors()` reads real tokens instead of its drifted copy.

---

## 8. Component inventory — keep / rewrite / delete

| Verdict | Item |
|---|---|
| **Keep** | BackendBootstrapGate + LaunchConversation; ChatTitlebar (rewritten internals per §3.2); SessionSidebar/SessionList (fixes only); RightDrawer + all sections; BottomTerminalDock; ChatThread/ChatThreadMessagePane/VirtualizedMessageList; ToolCallItem + ToolCallItemBody (canonical pair); EditRailRow; SearchResultsCard; ClarifyTool (re-homed); ChangesCard; ContextRing; ModelEffortMenu; ProvidersTab/ModelRow; SkillsSection; MemorySection (fixes); ConfirmDialog; CommandPalette; shadcn `ui/*` vanilla set; `task.tsx` (fix default trigger); settings-registry + SettingsPage; ErrorBoundary/SectionBoundary; realtime bridge; check-design.mjs (extended) |
| **Rewrite** | ToolStepRow → variant of ToolCallItem (folds in, then delete hideProgress); ToolCallCard → delegating legacy shim, then delete; ThoughtStep/ThinkingDisclosure → one disclosure primitive; ActivitySummary (keeps role, loses second machine); UpdateSection/UpdateProgressBar/UpdateRelaunchOverlay/NotificationsPanel update branches → new state machine; WorkspaceShell → real dialog + indexed search; RightDrawerSubagentsSection → roster strip + honest tabs; settings sections → SettingsSectionShell adoption (staged); ShortcutsModal → generated |
| **Delete** | ReasoningBlock (dead, 83 ln); ToolBlock; PermissionToast; old `StatusPill.tsx` (superseded); `StatusDot.tsx`; `useSettingsAdvancedPreference.ts`; `RAIL_CHILDREN`; `Surface.tsx` (fold into card — v1 said keep; audit found 0 importers, A4 §5); 9 hand-rolled SVGs; dead `installing` phase; `august-settings-advanced` + `august_preset` keys; dead CSS classes (`august-app-chrome`, `august-brand-mark`, `august-drawer-card`); dead 900px media query; fake statuses ("· Free" suffix, canned "already in the desktop app" toast); `src/nul` junk file; `/dashboard` redirect stub (or repoint); mobile dead CSS + `audit-mobile-visual.js`; `text-3xs` rung; `size-3.5` rung; `SECTION_ORDER`/chooser drift |

---

## 9. Phased migration plan

Ground rules inherited from `AUGUST-UI-ENHANCEMENTS.md`: each phase ends working —
`npm run typecheck -w frontend/desktop`, `npm run test -w frontend/desktop`, `npm run dev:desktop`
+ visual verification of every changed screen; lint is not a gate; `check-design.mjs --update`
only after an intentional sweep; legacy transcripts must keep rendering (`MessageBlock` is
permissive by design). Stage 2 additionally runs a rendered-page visual judge on changed screens
per phase. Backend tests are unaffected (UI-only) but run before any phase touching an API
contract (none planned).

| Phase | Work | Risk | Verify after |
|---|---|---|---|
| **0. Spec-vs-screenshots** (only if provided) | Check §1-§3 reference claims against user screenshots | — | signed-off visual deltas |
| **1. Delete dead code** | Full delete list from §8 (with audit corrections; adds dead store subs, dead CSS, fake statuses) | Low | tsc + tests; open a pre-migration session (legacy path untouched); check-design re-baseline |
| **2. Icon system** | Lucide-only policy, size standard, size-3.5→size-3, size={N} purge, 9 SVG deletions, brand-map merge, si barrel → deep imports, `title=`→`aria-label` pass | Low | grep zero `size-3.5`/odd `size={N}`; visual pass over chat rows, sidebar, drawer, settings |
| **3. Tokens** | Sunken/scrim/hairline/paper/inset tokens; status-palette sweep (52 files); light inverses for dark-tuned surfaces; DiffView washes; text-3xs→text-2xs; motion scale + spring purge; shadow-not-border; light THEME_PRESETS; radii rungs | Med | light+dark × every audited surface (terminal dock, file preview, trend chart, FeatureFlow, diff, bootstrap gate); axe smoke |
| **4. Resize + a11y parity** | `useResizablePane` hook (sidebar/drawer/dock); keyboard separators; dialog contract (role/aria/focus/Escape-one-layer incl. settings double-fire); titlebar height/window buttons/isMaximized/isTauri controls; animate transform not width; focus-visible pass | Med | keyboard-only walkthrough: resize all panes, dismiss all 5 broken overlays, settings Escape layering |
| **5. Responsive shell** | Container queries; drawer overlay 760-1100; sidebar overlay <760; remove dead 900px block; mobile class-coupling check | **High** | 3 widths × light/dark; mobile still loads; decorations:false intact |
| **6. Chat rows** | Fold ToolStepRow into ToolCallItem variant; collapse ToolCallCard to delegate; delete hideProgress; one thinking disclosure; 'loading' skeleton; history/agentsQuery error states; queued placeholder card; JSON.parse memoization; roster identity fix; ClarifyTool re-home + scoped keys | **High** | verify at 39/40 messages; legacy session render; live turn with tools+thinking+subagent; `/verbose` on/off |
| **7. Streaming & scroll** | Pin-release on oversize; threshold token; measureElement debounce; new-content throttle; smooth-reveal scoping; paste→attachment | **High** | stream a long answer, scroll up mid-stream and back; reduced-motion pass |
| **8. Update flow** | New state machine (checking/failed/cancelled); remove installing; fix restarting pill; markdown release notes; Cancel in About; durable "Later"; signature-vs-network copy; taskbar progress; interruption warning | Med | real download + forced failure (Retry appears; About never claims up-to-date); cancel mid-download |
| **9. Settings IA** | 4 groups; settings-level search index + deep-link highlight; SettingsSectionShell adoption; counter fix; hooks/indexing ruling; modal dialog a11y; keystroke-search shortcuts page | Med | search finds a control by feature name; deep-link restores target; keyboard-only settings pass |
| **10. Memory + skills** | brain-backup surface; global-pane gates fix (+ test unpin); skills lift rendering, sort, bulk, undo-delete | Med | full backup→restore round-trip (staged, next-launch); gates visible on global pane |
| **11. Launch + new chips** | Onboarding orchestrator; first-frame skeleton; API-key hygiene; auto-expanding boot log; SavePointChip + rewind; SkillEvolvedChip; roster strip + subagent tab fixes (§3.4 items 1-9); Hide-vs-Close and double-Esc only if approved (§10) | Med | fresh-install walkthrough (empty data dir); save-point rewind round-trip; 5+ parallel subagents |
| **12. Mobile hardening** | §7 list | Low | `npm run test -w frontend/mobile`; device/emulator smoke |

Ordering is deliberate: 1-3 shrink the surface everything else touches (near-zero risk); 4-7
carry the regression risk and are separated so a failure is attributable; 8-12 are additive.

---

## 10. Decisions I need from you (blocking none of Phases 1-4)

1. **Multi-subagent layout** — roster strip + single detail pane (recommended) vs true
   side-by-side columns (needs a much wider drawer; different design).
2. **Hide-vs-Close pane semantics** for terminal/browser sections (recommended adopt, R1 §4).
3. **Double-Escape stop** with `Esc Esc` tooltip (recommended adopt, R4 §8).
4. **"Work details" 4-mode dial** (Compact/Standard/Detailed/Verbose — R4 §8) as a surfaced
   control, or keep `/verbose` only (recommended: keep `/verbose` for now; revisit after Phase 6).
5. **Settings save-on-button staged forms** (R4 §5) — behavior change; recommended defer.
6. **Mobile** — harden-the-WebView (recommended) vs native redesign (separate scope).
7. **`hooks`/`indexing` settings sections** — implement or remove (recommend remove).
8. **Sidebar 56px rail mode** as a third sidebar state (v1 proposal; recommended defer — nice-to-
   have, not load-bearing).
9. **Reference screenshots** — none provided; proceed doc/source-level (recommended), or drop
   screenshots and I verify §1-§3 against them in Phase 0 first.

**Stage 2 will not begin until you approve this spec (with answers to §10).**

# August — UI Enhancement Plan

Single source of truth. Merged from 8 audit/research documents (~4,950 lines), which have
been removed. Every item cites the file it touches.

**Stack (unchanged):** Tauri 2 + React 19 + TS + Tailwind v3.4 + Zustand 5 + TanStack Query 5 + shadcn-style primitives. No library swaps, no Tailwind v4.

**Ground rules**
- **Frontend scope.** No backend, harness/agent-behaviour, or data-model changes. Preserve existing behaviour. (Note: a lot of real capability is unlocked without crossing that line — see §Scope.)
- Each phase ends working: typecheck, `npm run test -w frontend/desktop`, launch, verify by eye.
- There are **no visual-regression tests and no interaction tests** in this repo (one Playwright spec runs axe on 3 routes, web mode, no backend). **Manual visual verification is the only gate.** See §Verification.

---

## Scope — this is not just a reskin

Worth being explicit, because "UI refactor" reads as cosmetic and would undersell this.
The work is **frontend-layer**, but only about a quarter of it is visual repaint.

| Category | Share | What it means |
|---|---|---|
| **Visual repaint** | ~25% | Icons, colour tokens, radii, spacing. Same pixels, tidier. |
| **Bug fixes** | significant | Things are broken *today* — see list below. |
| **Unlocking existing capability** | **largest group** | Backend work already shipped, unreachable or unrendered from the frontend. |
| **New frontend capability** | several items | Transcript rewind, save-point chips, steer-without-stop, skills bulk actions. |
| **Performance** | 3 items | Measured regressions in the render path. |

### Bugs fixed (each is wrong right now, not a preference)

| Bug | Where |
|---|---|
| A failed update download makes About claim "You're on the latest version" | `UpdateSection.tsx:88-92` |
| The four memory-model gates **vanish** while browsing global memory — and a test pins the bug | `MemorySection.tsx:840`, `MemorySection.layout.test.tsx:123` |
| `isMaximized` never re-syncs on external maximize (Win+↑, double-click) | `ChatTitlebar.tsx:83-92` |
| History-load failure renders **nothing** — silent failure, no error | chat internals |
| `agentsQuery` failure renders **nothing** — silent failure, no error | chat internals |
| Sidebar cannot be resized by keyboard (mouse-only) | `SessionSidebar.tsx:122` |
| Five dialogs cannot be dismissed without a mouse (no `Escape`) | `BotsRail.tsx:196,517`, `ExamBanner.tsx:173`, `Backdrop.tsx:34` |
| Chart tooltip hardcoded dark — broken in light mode | `WorkspaceTrendChart.tsx:280` |
| A dead `installing` phase is still branched on by four UI sites | update flow, §Phase 8 |
| Titlebar height defined twice; the `!important` CSS wins and the Tailwind class lies | `ChatTitlebar.tsx:123` vs `chat.css:385-391` |

### Capability that already ships server-side but is unreachable or unrendered

**This is the highest-value group and the clearest argument that this isn't cosmetic** —
the work exists, August just never shows it to anyone.

| Capability | State today |
|---|---|
| **`WhatsNewModal`** — commits/releases with a CHANGELOG fallback | Built (218 lines), **linked from nowhere**; not reachable from Settings |
| **Skills effectiveness** — `{okRateWith, okRateWithout, lift}` | Computed and returned by `GET /api/skills/suggestions`; **no UI renders it** |
| **`brain-backup.ts`** — backups, integrity, restore | 98 complete lines, backend-tested, **zero call sites**. Net effect: users can delete all memory but cannot back it up |
| **Release notes** — `update.body` | Fetched (`useAppUpdate.ts:47-49`), rendered in a raw `<pre>` as unstyled markdown |
| **Save points** | Backend API exists (`api/gen/openapi.ts:6893`), surfaced only as a "revert files" action; no transcript marker, no rewind |

### Performance (measured)

Unmemoized `JSON.parse` at stream-frame-rate (`AssistantBlockTimeline.tsx:84,104`); a
measure→scroll→measure feedback loop between the follow lerp and the virtualizer
(`useStickToBottomScroll.ts:221-238` ↔ `VirtualizedMessageList.tsx:71`); and a 10s poll that
invalidates the `MessageBubble` memo for every tool row (`ChatThread.tsx:290`).

### Explicitly not in scope

No backend, harness, or agent-behaviour changes; no data-model changes; no new API surface.
Everything below is frontend work over APIs that already exist. If the intent is to rework
the agent's *actual capabilities* (harness logic, tool routing, memory architecture), that is
a separate scope and should be agreed before any of this starts.

---

## Index

Kinds: **V** = visual repaint · **B** = bug fix · **U** = unlocks capability that already exists · **N** = new frontend capability · **P** = performance

| Phase | Work | Kind | Risk |
|---|---|---|---|
| 1 | Delete dead code | V | Low |
| 2 | Icon system | V | Low |
| 3 | Colour & type tokens | V · B | Low |
| 4 | Resize panes + a11y parity | B | Med |
| 5 | Responsive shell | **N** | **High** |
| 6 | Chat rows: collapse duplicates | V · P | **High** |
| 7 | Streaming & scroll | B · P | **High** |
| 8 | Update flow | B · U | Med |
| 9 | Settings IA | V · U | Med |
| 10 | Memory + Skills surfaces | **U** · B | Med |
| 11 | New features (chips, rewind, steer) | **N** · U | Med |

Phases 1–3 shrink the surface everything else touches and are near-zero-risk. 5–7 carry the real risk and are separated so a regression is attributable.

---

## Phase 1 — Delete dead code

All verified: zero render sites.

| Delete | Evidence |
|---|---|
| `sections/chat/message/ReasoningBlock.tsx` (83 lines) + re-export `MessageBubble.tsx:22` | only a barrel re-export; `AssistantBlockTimeline` never references it |
| `ToolBlock` (`sections/chat/message/ToolCallCard.tsx:15-33`) + `MessageBubble.tsx:23` | zero call sites |
| `components/overlays/PermissionToast.tsx` | never imported; `PermissionRequiredCard` is the wired one |
| `components/StatusPill.tsx` | superseded by `components/workspace/StatusPill.tsx` (a superset — it also exports `variantForResult`, `variantForAppPolicy`, `variantForRollbackStatus`, `variantForHostStatus`). Repoint its 4 importers |
| `components/StatusDot.tsx` | 1 importer (`ModelPickerCard.tsx:15`). Replace with a `size="dot"` prop on the surviving pill |
| `hooks/useSettingsAdvancedPreference.ts` | imported only by its own test — the "Show advanced" toggle it gates does not exist |
| `RAIL_CHILDREN` (`settings-registry.ts:719-721`) | zero importers |

Also fold `components/ui/Surface.tsx` into `card.tsx`. `Surface` has **one** consumer (the design route, `pages/DesignRoute.tsx:9`); `card.tsx` has 12+.

**Then run `node scripts/check-design.mjs --update`** — deleting files invalidates their `path:match` keys.

---

## Phase 2 — Icon system

**One library: `lucide-react`, with `react-icons` allowed only for third-party brand marks.** lucide is already the de-facto system (202 import lines / 197 files); `react-icons` appears at 6 sites, all brand logos lucide lacks. That exception is fine — contain it:

- **Deep-import or replace.** `lib/file-icon.ts:29` and `lib/tool-icon.ts:37` import the `react-icons/si` barrel, pulling ~3000 Simple Icons modules for ~12 glyphs.
- **Merge the duplicate brand maps.** `components/settings/integrations/brandIcons.tsx` and `sections/settings/IntegrationCard.tsx:16` import the same three symbols.

**Adopt 4 sizes, class-only, `strokeWidth={1.75}` throughout:**

| Token | Class | Use |
|---|---|---|
| `icon-xs` | `size-3` | inline with 2xs/xs text; chips |
| `icon-sm` | `size-3.5` | secondary/inline |
| `icon-md` | `size-4` | **default** — nav rows, buttons, tool rows |
| `icon-lg` | `size-5` | section headers, empty states |

Sizing today arrives through three competing channels: `size-N` classes, `size={N}` props (18 distinct values, incl. off-scale `10`, `13`, `15`, `72`, `60`), and `h-N w-N`. Collapse to classes only.

Specific cleanups:
- **Merge `size-3` (384 uses) and `size-3.5` (370 uses).** Visually indistinguishable, split 50/50. Keep `size-3`.
- **One avatar size.** `size-10`×6, `size-11`×6, `size-12`×4 today — and `size-11` isn't a Tailwind default, so it's hand-tuning with no rule. Pick one.
- `size-N` above `size-6` is for illustration and chart geometry only, never a UI icon.

**Delete 8 hand-rolled SVGs** that duplicate lucide: `ChatMarkdown.tsx:64` (worst — an icon smuggled through a raw HTML string, bypassing React and tree-shaking), `DisclosureRow.tsx:58`, `ModelPickerDropdown.tsx:179,195,312`, `AssistantMessageActions.tsx:67`, `UserMessageBubble.tsx:160,171,189`, `ComposerAttachmentChips.tsx:42` (duplicate of the existing `FileIcon`).
**Keep:** the 3 chart graphics, `ChatEmptyState.tsx:48`, `ContextRing.tsx:169`.

---

## Phase 3 — Colour & type tokens

**Keep the token architecture.** `--dt-*` vars in `src/styles/tokens.css`, wired through `tailwind.config.cjs` as `hsl(var(--dt-*-hsl) / <alpha-value>)`. Keep the 3 contrast tiers (`--dt-fg-1/2/3` ≈ 15:1 / 7:1 / 4.5:1), the 4-rung elevation ladder, the 4 `data-text-size` presets, Inter + JetBrains Mono. `components/**` already has **zero** raw hex — this is the healthiest part of the codebase; do not rebuild it.

Fix 5 things:

| # | Problem | Fix |
|---|---|---|
| 1 | The "terminal surface" colour is spelled **four ways**: `#181818`×4, `#171717`×1, `#111`×2 across 5 files (`BottomTerminalDock.tsx:316,393`, `RightDrawerTerminalSection.tsx:333,377`, `RightDrawerFileSection.tsx:37,88,105`) | one `--dt-surface-sunken` token — highest-leverage single change in the shell |
| 2 | Raw `rgba()` with no light-mode inverse: `UpdateProgressBar.tsx:60,68`, `RightDrawerBrowserSection.tsx:128`, `BackendBootstrapGate.tsx:189` | `--dt-overlay-scrim`, `--dt-hairline-strong` |
| 3 | Diff add/del tints hardcoded in `DiffView.tsx:6-8,284,286` | reuse existing `--dt-code-added-wash` / `--dt-code-removed-wash` |
| 4 | `WorkspaceTrendChart.tsx:280` `bg-[#1a1c20]` is hardcoded dark — **broken in light mode** | theme token |
| 5 | `CircuitSchematicEditor.tsx:367` `bg-[#fdfdfb]` is a "paper" role | name it `--dt-paper` |

**Do not tokenise** `styles/code.css` — syntax highlighting is legitimately fixed per language.

**Type scale:** `px-type` is already **0**; the rem migration is done. The remaining defect is the same one as icons — `text-3xs` (0.625rem) spans **134 files** and `text-2xs` (0.6875rem) spans **127**. Two steps ~1px apart, split almost evenly, no rule for which. Collapse to one sub-xs step, or document which is for what.

---

## Phase 4 — Resize panes + accessibility parity

All three panels hand-roll the same drag-to-resize including copied `mouseup`/`touchend` cleanup: `SessionSidebar.tsx:65-88`, `RightDrawer.tsx:163-187`, `BottomTerminalDock.tsx:75-98`. Extract one `useResizablePane` hook.

**The a11y defect this fixes:** only the drawer handle is keyboard-operable (`RightDrawer.tsx:215-233` has `role="separator"`, `aria-valuenow`, Arrow/Shift-Arrow). `SessionSidebar.tsx:122` has an `aria-label` but **no role, no value, no key handler** — the sidebar is mouse-only.

**Width policy lives in three places** — TS constants, inline Tailwind arbitrary values, and CSS class rules (`chat.css:273-278,470,485,489`). Collapse to CSS custom properties both sides read.

Keep current values: sidebar 280px (min 220, max 33vw); drawer 420px (min 200, max 60vw); dock min 120, max 70vh.

**Also fix:**
- Titlebar height is defined twice — `ChatTitlebar.tsx:123` `h-10` **and** `chat.css:385-391` `2.85rem !important`. The CSS wins, so the Tailwind class is a lie. One value.
- Window buttons are 38px / 38px / 42px (`ChatTitlebar.tsx:283,290,297`) — the close button is 4px wider and reads as misaligned.
- `isMaximized` never re-syncs on external maximize (`ChatTitlebar.tsx:83-92` polls once on mount, then only after its own toggle). Subscribe to window events or the restore glyph goes stale on Win+↑.
- Sidebar/drawer collapse animates `width` (`SessionSidebar.tsx:98-100`, `RightDrawer.tsx:199-201`), forcing layout thrash every frame. Animate `transform`.

### 4.1 Dialog accessibility — use the in-repo template

Five overlays dismiss on outside-click with **no keyboard equivalent** and no dialog semantics: `BotsRail.tsx:196,517`, `ExamBanner.tsx:173`, `Backdrop.tsx:34`.

**Do not invent a standard — copy `ChangesPill.tsx`'s commit modal**, which already gets it right: `role="dialog"` + `aria-label` (`:369-372`), backdrop paired with an `Escape` listener and cleanup (`:90-97`), plus `Ctrl+Enter` for the primary action (`:346-349`). 24 components declare `role="dialog"`; this one has the full contract.

Also: `components/ui/task.tsx` **is used** (`SearchResultsCard.tsx:134-166`, `ToolStepRow.tsx:53-400`), but `TaskTrigger` wraps a plain `<div>` in `CollapsibleTrigger asChild` (`task.tsx:65`), so the *default* trigger is unfocusable. Both real callers pass a `<button>`, so it's fallback-only — fix the default. And `ToolStepRow.tsx:290` uses `disabled={!canExpand}`, which drops non-expandable rows out of the tab order entirely.

---

## Phase 5 — Responsive shell (highest risk)

**Nothing exists today.** One `@media (max-width: 900px)` in the entire stylesheet, and it only shrinks two panels. `sm:`/`md:`/`lg:` appear 83 times codebase-wide and **zero** times in `components/shell/*`. Widths are clamped in JavaScript against `window.innerWidth`, which only ever shrinks — it never reflows, stacks, or overlays.

| Width | Behaviour |
|---|---|
| ≥ 1100px | current: sidebar + chat + drawer, all resizable |
| 760–1100px | drawer becomes an overlay (scrim + dismiss); sidebar still docked |
| < 760px | sidebar overlays too; chat fills viewport |

**Use container queries on the shell, not viewport media queries** — the drawer closes independently of window width, so viewport queries get that wrong. Respect `RightDrawerState.ts:36` (`MAX_SECTIONS = 4`).

### 5.1 Constraints that make this phase risky

- **`decorations: false`** (`tauri.conf.json:22`) — the custom titlebar is mandatory. Drop `data-tauri-drag-region` and the window can't be moved; drop the window buttons and it can't be closed (close already routes through a webview modal, `lib.rs:112-117`).
- **Mobile breaks silently.** `frontend/mobile/App.tsx:21-83` injects ~60 lines of CSS that target ~15 desktop class names (`.dashboard-shell`, `.surface`, `.period-btn`, `.overflow-x-auto`…). **Nothing lints that coupling.** Any class rename in this phase must be applied there too.
- CSP forbids `unsafe-eval` and all remote assets — bundle everything.

---

## Phase 6 — Chat rows

### 6.1 Collapse the tool-row duplication

Two row designs render in the same transcript **right now**, reconciled by a flag matrix. `ToolCallItemBody.tsx:108` admits it: *"pass `hideProgress` there so files aren't listed twice."*

| Component | Lines | Action |
|---|---|---|
| `components/chat/tool/ToolCallItemBody.tsx` | 388 | **KEEP — canonical** (4 call sites: `AssistantBlockTimeline.tsx:852,962,1006`, `EditRailRow.tsx:170`) |
| `components/chat/tool/ToolCallItem.tsx` | 253 | KEEP (row chrome; `SubagentTimeline` uses it) |
| `components/chat/ToolStepRow.tsx` | 410 | **FOLD IN** — its `Task`-based progress rows become a variant of `ToolCallItem`, then delete `hideProgress` |
| `sections/chat/message/ToolCallCard.tsx` | 151 | **LEGACY ONLY** — see below |
| `components/chat/ClarifyTool.tsx` | 484 | KEEP, needs a deliberate home |

**`ToolCallCard` is not a live competitor.** Its only render site (`MessageBubble.tsx:132`) is guarded on `role === 'tool'`, and live SSE never produces that role — the only construction site is history restore (`session-history.ts:147-152`), and `transcript-sync.ts:80` skips it going forward. It serves pre-migration sessions only. Collapse it by delegating to `ToolCallItem` (~100 duplicated lines), which also fixes its hard-coded `<DisclosureRow open={false}>` at `:67` — legacy rows are currently **not user-expandable**, unlike Family B which supports `userOverride`.

### 6.2 One thinking disclosure, two presentations

Not the `ReasoningBlock` duplication one might expect (that component is dead — Phase 1). The live overlap is `ThoughtStep` (218, rail + 6-line/480-char clamp) vs `ThinkingDisclosure` (181, auto-opens while streaming, auto-collapses when done) — **two independent collapse state machines for the same job.** Unify into one disclosure with a `variant="rail" | "plain"`. Keep `summarizeThoughtHeader` (`lib/process-summary`) — the one piece of genuine reuse.

`ActivitySummary` (373) is scoped, not duplicated — keep it; it's the collapse mechanism for `ThoughtStep`'s rail.

`WorkingIndicator` (237, live activity feed) and `TaskProgressPill` (206, todo counter) are **not** duplicates, but they occupy adjacent space above the composer during a turn. Tighten the layout, don't merge them.

### 6.3 Fix three state bugs

- **Todos + phase are owned twice** — `sections/chat/stream/session-stream-store.ts` and `store/liveActivity.ts`, with no reconciliation. Pick one owner.
- **Unmemoized `JSON.parse` at stream frame rate** — `AssistantBlockTimeline.tsx:84,104`, `ToolCallItemBody.tsx:30,148`. `MessageBlockToolCall` already carries typed payload fields (`types/chat.ts:122-133`); use them.
- **A 10s poll breaks memoization** — `ChatThread.tsx:290` rebuilds `subagentRoster`, invalidating the `MessageBubble` memo for every tool row. Stabilize the identity.

### 6.4 Two silent-failure surfaces

History-load failure and `agentsQuery` failure both render **nothing** instead of an error. Add error states to both.

---

## Phase 7 — Streaming & scroll

Measured, not guessed:

- Stick-to-bottom threshold **80px** (`ChatThread.tsx:367`); scroll-to-top **200px** (`ScrollToTopButton.tsx:5`). Two magic numbers, two files, neither a token.
- Follow engine is a rAF lerp with adaptive alpha — gap >180 → 0.75, >56 → 0.5, else 0.34, min step 2.25px (`useStickToBottomScroll.ts:221-238`), honoring `prefers-reduced-motion`.
- **Virtualization flips automatically at 40 messages** (`VirtualizedMessageList.tsx:12`) with a *different DOM wrapper* (`space-y-5` vs absolute `translateY`), so vertical rhythm differs subtly between modes. `estimateSize` is a flat **140px** while expanded tool bodies routinely exceed it, forcing constant remeasurement.

**Four fixes:**

1. **Release the pin when the streaming message exceeds viewport height.** Today the lerp pins unconditionally, so a tall streaming answer drags the user with no anchor — the content above is actively being pushed away, not merely scrolled past.
2. **Unify the two thresholds** into one token.
3. **Debounce `measureElement`.** Currently a measure→scroll→measure feedback loop at frame rate: the growing last row is remeasured every frame, each measurement invalidating offsets below it and feeding back into the lerp's `maxScroll`.
4. **Render the unused `'loading'` status.** `session-stream-store.ts:23` defines `'missing' | 'loading' | 'ready'` but `'loading'` is never rendered — a restoring session shows nothing rather than a skeleton.

Also: once the user scrolls up mid-stream, `ChatThread.tsx:435-438` forbids re-pinning (correct), but `hasNewContentWhileUnpinned` then fires the "New content" pill on *every* growth tick. Throttle it.

**Verify every message-row visual change at both 39 and 40 messages.** This boundary is invisible in code review and there are no visual tests to catch it.

---

## Phase 8 — Update flow

Current machine: `AppUpdatePhase = 'idle' | 'downloading' | 'ready' | 'installing' | 'restarting'` (`store/app-update-install.ts:7`).

**Three defects:**

1. **After a failed download, About tells the user they're up to date.** Every failure is `toast.error(...)` + `resetInstall()`, and About renders "You're on the latest version" whenever `!error && !available && !checking` (`UpdateSection.tsx:88-92`). A timeout, a user cancel, and a *signature verification failure* all produce one identical transient toast — and signature failure means a rejected installer, which is a materially different message.
2. **`installing` is dead code.** Nothing writes it, yet four sites branch on it (`UpdateProgressBar.tsx:21,42`, `UpdateRelaunchOverlay.tsx:27,137`, `UpdateSection.tsx:132,173`, `NotificationsPanel.tsx:159`). On Windows the NSIS wizard is launched by a Rust command that calls `app.exit(0)` — JS never sees a wizard phase.
3. **Release notes are fetched and never shown properly.** `update.body` is read (`useAppUpdate.ts:47-49`) and rendered in a `max-h-32` **`<pre>`** — raw GitHub markdown. Separately, `WhatsNewModal.tsx` (the good one, with a CHANGELOG fallback) is **unreachable from Settings at all**.

**Do:**
- Add `failed` and `cancelled` to the phase union. `failed` gets a real surface: the reason, a **Retry**, and wording that distinguishes *rejected installer* from *network failure*.
- Never fall through to the up-to-date copy while `available` is set.
- Remove the dead `installing` phase, or give it a real emitter.
- Render `update.body` as markdown; make `WhatsNewModal` reachable from Settings.
- Add a Cancel affordance to About (only the overlay has one today).
- Make "Later" durable — `readyDismissed` is local `useState` (`UpdateRelaunchOverlay.tsx:22`), so the staged download is forgotten until the on-disk installer is rediscovered.

**Honest asymmetry — do not paper over it:** download progress is knowable; install progress is not (NSIS owns it). Don't fake an install percentage.

**Keep the 5-command Rust contract** (`download_release_installer`, `downloaded_installer`, `launch_installer_and_exit`, `stop_backend_for_update`, `schedule_post_update_relaunch`) and the `update-download-progress` event shape. The app cannot relaunch itself.

**Rollback stays absent.** There is no UI to install a previous build, and that is correct given `AGENTS.md`'s install/update guarantees. Do not add one; do not weaken `wipeStaleTree` or the opt-in uninstall to make the flow look cleaner.

---

## Phase 9 — Settings IA

**Numbers:** 45 registered sections (3 categories; 15 basic, 2 advanced, 28 hidden) but only **17 visible in the rail**. 28 sections are reachable **only by search**. 60 files / 21,974 lines; largest is `MemorySection.tsx` at **2,196 lines**. 103 interactive controls. 24 settings-relevant localStorage keys.

**Four changes:**

1. **Search must index individual settings, not just sections.** Today it's literal `String.includes` on three fields (`WorkspaceShell.tsx:102-117`) — no tokenisation, no ranking, no typo tolerance. The registry ships ~250 keywords *because* substring matching needs them. Index setting labels too and most of those keywords become unnecessary.
2. **Build a real settings-row primitive.** `SettingsSectionShell.tsx` is the intended standard and has **one** consumer; every section hand-rolls its rows. Density is wildly uneven — 20 of 60 files have zero controls while `MemorySection` has 14.
3. **Collapse to 4 groups:** Setup · Agent · Data · App. Drop the inert `advanced` tier (Phase 1) and the dead `RAIL_CHILDREN`.
4. **Fix the counter lie:** "N of M sections" counts implemented sections (43), so `hooks` and `indexing` can never appear in results. Either implement them or remove them from the registry.

**Also:** the panel is a fixed centred modal over the workspace (`WorkspaceShell.tsx:147-151`, `max-w-[1180px]`), but `SettingsPage.tsx:1` still documents itself as a "full-screen page". Fix the stale comment and the stale doc drift in `settings-registry.ts:7,9,73,136`.

---

## Phase 10 — Memory & Skills

### 10.1 Memory — restore what was removed

Verified: the "Memory files" card (backups, integrity, restore, context preview) **is gone** from Settings → Memory, as `AGENTS.md` describes. Consequence:

**`api/api-client/brain-backup.ts` is 98 lines of complete, backend-tested, entirely unwired client code** — the cheapest win in this plan. Meanwhile the *only* memory-data action left in Settings is **"Purge memory"** (`PrivacySection.tsx:215`), which is destructive.

**So today a user can delete all their memory but cannot back it up, inspect it, or restore it.** Restore the card, or make the client reachable somewhere deliberate. The backend already takes a verified copy every 12h, so data safety is intact — only *user control* is gone.

**Also fix:** the four memory-model gates **disappear while browsing global memory** — they render only when `pane.kind !== 'global'` (`MemorySection.tsx:840`). They are settings, not browse controls. `MemorySection.layout.test.tsx:123` actively pins this bug; update the test.

The four gates themselves are correct and confirmed on both sides: `memoryAutoInject` defaults **off** in the UI (`:853`) and in the backend (`brain_config_service.py:191`), with copy reading "Off (recommended)".

### 10.2 Skills — surface the analytics that already exist

`GET /api/skills/suggestions` returns per-skill `{okRateWith, okRateWithout, lift}` and **no UI renders it**. The detail pane shows raw counts, never measured effect. This is the most persuasive missing feature in the app — show the lift.

Also add: **sort** (rows are grouped by scope but ordered by server response), **bulk actions** (no multi-select enable/disable/retag, while `HarnessImprovementsSection` already has batch-approve-with-undo), and **undo on delete** — delete is currently irreversible with no confirmation that the file was snapshotted.

---

## Phase 11 — New features

These are genuinely new UI. `SavePointChip` and `SkillEvolvedChip` **do not exist** — zero hits tree-wide — and `ask_user_input` is not a tool but a structured message field (`ClarifyTool.tsx`, mounted at `MessageBubble.tsx:383`; its multi-question `currentIndex` flow is genuinely stateful in a way neither tool family is).

### 11.1 Save-point chip + transcript rewind

Save points exist as a **backend API** (`api/gen/openapi.ts:6893`) surfaced only as a "Revert all changes to the last save point" action (`ChangesCard.tsx`, `RightDrawerDiffSection.tsx:145`, `lib/git-revert.tsx`). **The transcript is not rewindable** — `onRevert` (`MessageBubble.tsx:321` → `ChatThreadMessagePane.tsx:198`) only truncates *forward* from an index.

Add: a per-turn checkpoint marker on the transcript rail, and rewind-to-here. Model it on `TurnProvenanceChip.tsx` (113 lines), and on `CompactionNoticeCard.tsx` for the state-checkpoint card shape.

### 11.2 Skill-evolved chip

Nothing anywhere tells the user "a skill changed as a result of this turn." Memory has a read path (`recalledMemories` → a **count only**, `ActivitySummary.tsx:32`) and an edit path (`MemoryEditRow`), but no signal. Add a chip on the turn where skill genesis/refinement happened. Use `TurnProvenanceChip` as the pattern; `HarnessModeChip.tsx` (10 lines) is the smallest existing chip to copy.

### 11.3 Give `ClarifyTool` a real home

It is a **fourth** hand-rolled card system, outside both tool families, with its own chrome. Phase 6 collapses the tool families — decide deliberately whether `clarify` becomes a variant of the unified row or keeps its own card (it probably needs its own, given the multi-question popup).

### 11.4 Adopt from the references

High-value, low-risk, each grounded in a verified source:

- **Steer without stopping a worker.** `RightDrawerSubagentsSection.tsx` already has per-worker steer; surface it as a first-class action rather than an input at the bottom of the panel.
- **A "needs attention" triage lane.** The sidebar already polls `getNeedsAttention()` every 15s and shows dots (`ChatLayout.tsx:120-136`). Group those into a lane instead of a dot on a row.
- **Content width clamp.** Chat content is currently unbounded. Clamp the measure — `clamp(680px, column * 0.64, 920px)` with a user override.
- **0.5px hairlines for neutral borders**, with 1px reserved for dashed affordances and state-coloured borders.
- **Elevation as shadow, not border** — elevated surfaces set `border: 0`. Measurably better in light mode.
- **Three-tier motion scale**: 100/200/300ms on one curve, with `prefers-reduced-motion` honored everywhere.
- **Usage ring beside the model picker** — August already computes cost per model; surface it where the model is chosen.

### 11.5 Multi-subagent layout — **needs your decision**

The drawer **already supports multiple simultaneous subagents**: `RightDrawerSubagentsSection.tsx` (742 lines) has a per-worker tab strip, a search dropdown, a per-agent `ProgressPopover` driven by that agent's own todos, live elapsed timers, per-worker steer, per-worker stop, and stop-all. Each worker renders through `SubagentTimeline` with the same `Markdown` as the main chat.

**The gap is that all workers share one detail pane**, so parallel work is observable only by tab-switching.

**Recommendation: keep one detail pane, add a compact always-visible roster strip** (status glyph + label + elapsed per worker, with the detail pane below). Side-by-side columns inside an already-narrow drawer would leave each subagent transcript below ~200px, which is unreadable for markdown. True columns need a much wider drawer and are a different design.

---

## Verification

**There are no visual-regression tests in this repo.** The only Playwright spec (`e2e/design-smoke.spec.ts`) runs axe on three routes, CRITICAL violations only, in web mode with no backend. No interaction tests, no Tauri-level tests. A refactor that renders wrong but stays DOM-valid **will pass CI**.

So each phase must end with:

```
npm run typecheck -w frontend/desktop
npm run test -w frontend/desktop
npm run dev:desktop        # then look at it
```

Lint is not a real gate — `--max-warnings=600` gives it enormous headroom.

**Phase-specific checks:**
- Phases 5, 6: verify at 3 widths × light/dark; confirm mobile still loads.
- Phase 6: verify at **39 and 40 messages** (virtualization boundary), and open a pre-migration session for the legacy `role:'tool'` path.
- Phase 7: stream a long answer, scroll up mid-stream, scroll back.
- Phase 8: run a real download and force a failure — confirm Retry appears and About never claims "up to date".
- Phase 10: full memory restore round-trip.

**Two cross-cutting traps:**
1. `check-design.mjs` keys on `path:match`, so **moving or splitting a file re-surfaces every violation in it as new.** Use `--update` only after an intentional sweep — never to silence a finding. It passes today (496 unique keys, exit 0).
2. **Legacy transcripts must keep rendering.** `MessageBlock` is a permissive interface, not a discriminated union (deliberate — `types/chat.ts:52-56`), and old `thinking` blocks carry a legacy `system` field that `normalizeSystemBlocks()` rewrites on load. A renderer that keys off `type` alone will mis-render existing sessions.

---

## Out of scope

- **Mobile native UI** — a 383-line WebView wrapper with a *second hand-copied token set* (`App.tsx:85-126`) unrelated to `--dt-*`. Nothing to redesign; it needs its token copy deleted once desktop tokens are exposed over HTTP. Only CSS-breakage avoidance here.
- **Tailwind v4** — no user-visible payoff, real regression risk across 197 files.
- **True side-by-side subagent panes** — needs a product decision (§11.5).
- **App-level rollback UI** — structurally absent by design.
- **CJK/i18n layout** — English-only today. If i18n lands, reserve space for 2.6–3.2× expansion (measured from the DeepSeek harness).
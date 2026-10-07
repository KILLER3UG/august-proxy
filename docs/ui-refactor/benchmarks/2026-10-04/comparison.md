# Reference UI benchmark — DeepSeek Harness + Hermes Desktop (2026-10-04)

Screenshots in this folder, captured from the **running** apps, not from docs:

| File | How captured |
|---|---|
| `dsh-01` … `dsh-06` | DeepSeek Harness v0.2.0-rc.2, launched with `--remote-debugging-port`, driven over CDP against the user's real workspaces |
| `hermes-01`, `hermes-02` | Hermes desktop, Electron shell attached to its own vite renderer (boot-failure + connecting states, live) |
| `hermes-03`, `hermes-04` | Hermes `apps/desktop/pr-assets/` (real packaged UI, committed by Nous) |
| `hermes-05` | Hermes first-run card, captured by its own Playwright e2e failure artifact |
| `august-01` … `august-05` | August dev server (:5173) + backend (:8085), same 1440×900 viewport |

Hermes' live chat could not be captured: its e2e `mockBackend` fixture fails at setup on this
machine (4 of 6 tests error at 0 ms, the other 2 skipped), and every failure screenshot is the
same first-run setup card — the app never reaches the transcript. Its boot, setup and
packaged-UI surfaces are all captured above. The dev checkout's Electron build also cannot reach
the Python gateway (`Desktop IPC bridge is unavailable` → `Waking up…` → `Gateway offline`), which
is what `hermes-01` and `hermes-02` show.

---

## 1. Transcript process presentation — the biggest gap

**DeepSeek (`dsh-03`)** — one collapsible group titled `Completed in 32m 1s ⌃`. Inside it, tool
activity is a **quiet icon+verb single line** (`>-_ Ran commands`, `▤ Read files`,
`⌕ Searched code and read files`, `✎ Wrote files and ran commands`) **interleaved with the
model's own prose at full contrast**. The reader gets a narrative; the plumbing recedes. The
final answer is never behind the fold.

**August** — the collapsed header is already at parity: `ActivitySummary.tsx:241` renders
`Working…` / `Task completed` plus the tally ("1 file, 1 search, and 1 command") and
`durationLabel` at `:273`. What is *not* at parity is what is inside: three disclosure machines
still coexist (`expandOverrides` at 7 sites in `AssistantBlockTimeline.tsx`, two auto-collapses in
`ActivitySummary.tsx:159,163-168`, `ThinkingDisclosure` live only in `SubagentTimeline.tsx:249`),
and a legacy session renders raw protocol text as six amber `QUEUED` rows carrying
`status="failed"` (`august-01` region, observed live on session `wb_20260910_135530_4e5ec6`).

**Adopt:** the interleaved quiet-line grammar as the single rendering rule for tool activity, and
render in-data failures as neutral notices — amber `QUEUED` for a *completed, failed* subagent is
both dishonest and unreadable. This is spec §4.1/§4.2 unfinished work, not a new idea.

## 2. Live metrics strip

**DeepSeek (`dsh-02`)** — one always-visible line under the composer:
`⏱ 7 turns 437 steps · 122 tok/s │ ▣ 93.5M tok · Cache hit 99% │ ◔ 36%`.
**Hermes (`hermes-03`)** — a bottom statusbar: `⌘N · ✨ Gateway ready · 👥 Agents` left,
`⚡ Deepseek V4 Flash · Med ⌄ · # v0.16.0 (+2) 09dfd38` right.

**August** — the numbers already exist and are buried: `ComposerToolbar.tsx:496-498` feeds
`sessionUsage.cacheHitTokens` / `cacheHitRate` into the `ContextRing` **hover popover**, and cost
at `:282-284`. `getVersion()` is imported only inside `UpdateConversation.tsx:49-50`, so the
running build number appears nowhere in the shell.

**Adopt (cheap, high signal):** promote cache-hit + tok/s + turn/step counts to a one-line strip
under the composer priced through the same `cost_estimator` path the Usage page uses, and put
`v0.18.17 + commit` in that strip. No new data plumbing — it is all already fetched.

## 3. Turn navigation rail

**DeepSeek (`dsh-02`, right edge)** — fixed-pitch tick marks with hover previews (one prompt line,
three response lines), hidden when the transcript is ≤900 px.
**August** — `ChatCheckpoints.tsx:116-129` renders the marks (`.checkpoint-pill`, measured 8×4 px
at 0.4 opacity, `aria-label` present) but with **no hover preview and no visible affordance** —
in `august-01` it reads as a stray dash clipped at the pane edge.

**Adopt:** a hover preview card on the existing rail, a wider hit target, and the ≤900 px hide rule.

## 4. Session rows and history legibility

**DeepSeek (`dsh-02`, `dsh-06`)** — hovering a row reveals `⋯` + archive + pin inline, and shows a
**rich preview card**: title, `1d ago`, `● Idle`.
**Hermes (`hermes-03`)** — `SESSIONS 150/884` (shown/total), sessions grouped by **origin** with
brand marks and counts (`Cron 39`, `Telegram 60`, `Discord 12`, `Webui 1`), each foldable via `…`,
plus a `PINNED` section whose empty state *teaches the gesture*: "Shift-click a chat to pin · drag
to reorder".

**August** — flat Tasks group (expanded by default as of today's fix), `Bots` tab, search by title
or id. No shown/total denominator, no hover preview, no origin grouping.

**Adopt:** the shown/total denominator and the teaching empty-state copy — both are one-line
changes. Origin grouping maps onto August's existing `agentId` and is a larger call.

## 5. Empty state and brand voice

**DeepSeek (`dsh-01`)** — whale mascot + "Into the Unknown" in the bundled Montserrat Light 300
with a `Preview` chip. **Hermes (`hermes-03`)** — oversized "HERMES AGENT" in a display serif in
brand blue over a faint image, with a lowercase personality tagline.
**August (`august-04`)** — plain "What should we work on?".

**Adopt:** one brand mark + one line of voice in the empty state. Additive; does not touch the
warm-neutral palette the spec protects.

## 6. Settings

**DeepSeek (`dsh-04`, `dsh-05`)** — compact modal, five nav rows, and a header loopback action
**"Open configuration file"**. Retinting to dark is one attribute (`body[data-ds-dark-theme]` →
`rgb(21,21,23)`) — verified live, which is the alias-token architecture earning its keep.
**August (`august-03`, `august-05`)** — four groups / 17 rows (correct), real `role=dialog` with
focus trap, Escape-one-layer verified working. Missing: the config-file loopback row; the
`/settings?tab=X&field=Y` field deep-link (spec §5.1.2, still absent); **card-in-card** in General
(Notifications nested inside Preferences, against spec principle 6); native `<select>` elements
that clash with the shadcn primitives in light mode.

## 7. Boot and first-run honesty

**Hermes (`hermes-01`)** — "Hermes couldn't start" / "Hermes' background service didn't come up."
/ **"Nothing here deletes your chats or settings."** then the raw layer name in a tinted box
("Desktop IPC bridge is unavailable.") and four *distinct* actions: Retry, Repair install, Gateway
settings, Open logs — with a cost note under the expensive one ("Repair re-runs the installer and
can take a few minutes on a fresh machine").
**Hermes (`hermes-05`)** — first run offers two side-by-side paths in plain language and prints
**the exact install path before you commit**.
**August** — `BackendBootstrapGate.tsx` already has Retry (`:251-255`) and the auto-expanding
startup log (`:222-231`, explicitly Hermes parity). Missing: the reassurance line, the named
alternative actions, and any pre-commit disclosure of where things go.

**Adopt:** the reassurance sentence and a "what this costs" note per destructive/long action.
Both are copy, not machinery.

---

## Priority order for August

| # | Change | Cost | Touches |
|---|---|---|---|
| 1 | ~~Live metrics strip~~ **DONE 2026-10-04** — `3 steps · 1.1M tok · Cache hit 0%` under the composer (`august-06`, `august-07`). Scope narrowed after checking: tok/s already exists on the last message (`AssistantMessageContent.tsx:143-149`), cost and context % already exist in the toolbar, so the strip carries only the three numbers that were previously invisible | Low | `useChatUsage.ts` (+`totalEvents`), `ChatThreadComposer.tsx` |
| 2 | Interleaved quiet tool lines in ONE disclosure primitive; in-data failures neutral, kill raw `QUEUED` protocol rows | Med-High | `AssistantBlockTimeline.tsx`, `ActivitySummary.tsx`, `ThinkingDisclosure.tsx`, `ToolCallItem.tsx` |
| 3 | Turn-rail hover preview + wider target + ≤900 px hide | Low | `ChatCheckpoints.tsx`, `chat.css` |
| 4 | ~~Settings: remove card-in-card, native selects → primitive, add config-file row~~ **Partly void — see §4a.** card-in-card was a misread (the two cards are siblings); the other two need new machinery | — | `GeneralSection.tsx` |
| 5 | `?field=` deep-link + highlight (spec §5.1.2, unfinished) | Med | `settings-registry.ts` `settingHints`, `WorkspaceShell.tsx` |
| 6 | Session row: shown/total denominator, teaching empty-state, hover preview | Low | `SessionList.tsx`, `SessionRow.tsx` |
| 7 | Empty-state brand mark + voice line | Low | `ChatEmptyState.tsx` |
| 8 | ~~Boot card reassurance line + per-action cost note~~ **DONE 2026-10-04** | Low | `BackendBootstrapGate.tsx` |

Item 3 also shipped a fix the review had asked for generally: the rail's `aria-label` was
`Go to message session_2026…` — a raw id as an accessible name. It now reads
`Jump to your message: <first 60 chars of the prompt>`.

### §3 was the tip of something bigger — CRITICAL, found 2026-10-04

While verifying the rail I found the checkpoint pills were unreachable with the right drawer open.
Cause: `RightDrawer.tsx:158` positions the drawer `absolute right-0 top-0 bottom-0 z-30` against a
full-width ancestor, so **it never docks — it overlays the transcript at every window width**.
Measured at a 1440 px window: `.august-message-list` ends at x=1324 while the drawer starts at
x=1020, so **304 px of the message column sits under the panel**, and the list is exactly as wide
(928 px) with the drawer open as closed — nothing reflows.

Visible damage (`august-09-drawer-covers-transcript.png`): assistant prose is cut mid-word at the
panel edge ("…so we can jump strai"), user bubbles lose up to 288 px, and **the composer's Send
button is entirely hidden** — opening the drawer makes the app unusable until you close it again.

This contradicts nothing once read closely: the overlay is a documented rule, and
`docs/research/august-frontend-ui-audit.md` B4 already recorded it as "by design" — but the
mitigation B4 credited (the 60 % viewport cap) bounds the *panel*, never the content, so the
damage was real and unrecorded.

**Fixed 2026-10-04 without reversing Part 15.4.** The panel stays `absolute … z-30` and still
animates over the edge; `.august-chat-column` simply reserves `--august-drawer-w`, published by
`RightDrawer.tsx` and applied **only above the 1100 px tier**, so the 760–1100 px scrim overlay
keeps floating by design. Measured after the change: at 1440 px the message list ends at x=1020
with the drawer starting at x=1020 — **0 px covered** (was 304); the checkpoint rail moved from
x=1416 (buried, unreachable) to x=996; Send button visible; at 1050 px padding is 0, coverage is
404 px and the scrim is present, i.e. overlay mode untouched; closed state unchanged. Evidence:
`august-09-drawer-covers-transcript.png` (before) and `august-10-drawer-docked.png` (after).

Items 2 and 5 are already in the Stage 1 spec as unfinished work — they are not new scope.

**Note while building item 1:** the cache split needed a gate the API does not give you.
`cacheHitRate` is a 0..1 fraction and `0.0` means *both* "no cache data" and "1.06M tokens, zero
hits" (`brain_config.py:294` returns `0.0` when `hitT + missT` is 0). The strip therefore gates on
`cacheHitTokens + cacheMissTokens > 0`, never on the rate — same shape as the pricing rule that
`0.0 is a value, not an absence`.

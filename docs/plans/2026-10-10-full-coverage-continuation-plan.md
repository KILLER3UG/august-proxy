# August Proxy (harness) — full-coverage continuation plan

**Status: plan, not yet executed.** **Date:** 2026-10-10.
**Relationship to the minimalist spec:** this document **continues**
`2026-10-10-minimalist-ui-redesign-spec.md` (approved, implemented, gates green per
its §11.1). It does not re-plan shipped work; shipped rows are cited by their §/row
ids (L1, C1, A2…) and marked **shipped**. What it adds: (a) the same
element-by-element reference coverage matrix that spec never built, (b) full plans
for the six surfaces that spec **deliberately kept out** (`/runs` per its decision 7;
board/history/automations/learning/live by scope), (c) its four open §11.4 items made
executable, (d) cross-surface moves the census confound hid.

**Method:** two fresh source maps of `frontend/desktop/src/` (every claim a
`file:line`), the minimalist spec's own measured census (§1.2/§1.2b), and the same 14
reference screenshots' pattern rules. **Confound to know first:** every section route
renders inside `ChatLayout` (`App.tsx:99-113`), whose shell (SessionRow 8 buttons/row,
`BotsRail` 17, `ChatTitlebar` 7) contributes ~60–90 of each page's ~100 measured
buttons. Page-local wins are real but smaller than the raw census implies — §5
switches the census to page-local measurement so progress is provable.

---

## Part 0 · Where the minimalist pass actually landed

**Shipped and verified** (minimalist spec §9 phases 0–10; §11.1 gates: tsc -b,
1678/1678 vitest, 5143 pytest, ruff, mypy, check:design 0-new-drift, check:docs,
check:version, check:api):

- Shell: status bar (B1–B3), sidebar workspace switcher + 3 nav rows + TERMINAL tab +
  per-row token delta (L1–L4), update button folded into account row (L8).
- Composer: 50 → 14 controls, 8 permanent (C1–C10) — **including the merged
  model+effort chip (C1), the reference's "Sonnet 5.5 High" one-control pattern**.
- Settings: rail 17 rows flat (S1–S2, S5–S6), content headers (S3 partial),
  Appearance 37 → 5 inputs via segmented control + named swatches + designer
  disclosure (A1–A5), per-surface font sizes (F1–F3), ChatGPT toolbar **assessed and
  declined** (S4).
- Chat: empty state de-decorated (E1–E4), transcript error states extracted + tested,
  the 39/40 virtualization contract pinned, the dual-collapse mechanism fixed.
- Drawer: honest overflow toast, tab-strip prune, ticker scoping, tablist semantics,
  Artifacts presence (D1–D5). Collections: Skills/plugins card grid (phase 9).

**Open (its §11.4, carried into §3 here):** settings heading sweep (needs a ruling),
transcript disclosure consolidation (blockers documented), `aria-modal` without
`inert` + tablists without roving focus, the packaged-Tauri pixel pass.

**Deferred by decision, picked up in §2 here:** `/runs` density (decision 7 kept it
out), board/history/automations/learning/live (out of the shell pass's scope), the
mobile companion (still out — §6).

---

## Part 1 · Reference coverage matrix — every element, one of three verdicts

Same 14-screenshot references (Claude desktop, ChatGPT Skills, Haze, KiloCode).
Every element is **shipped** (minimalist spec row), **open** (a section here), or
**not adopted** on purpose.

| Reference element | Verdict | Where |
|---|---|---|
| Sidebar: + New, Pinned, search, capped recents, View all, account row | **shipped** | L2, L9, L10 |
| Sidebar: workspace switcher (Haze) | **shipped** | L1 |
| Sidebar: per-row token delta (+in/−out) | **shipped** | L4 |
| Sidebar: project status dots (KiloCode) | **shipped** | L5 |
| Nav: 3–5 destinations visible | **shipped** | L2 (+user decision 1) |
| Right Artifacts panel as single entry | **shipped** | L10 note, D5, decision 6 |
| Status/footer strip with quiet context | **shipped** | B1–B3 |
| Composer: one card, attach/text/send | **shipped** | C1–C9 |
| **Model + effort as ONE chip/dropdown** | **shipped** | C1 (`ModelEffortMenu` merged; effort = second tab) |
| Context-percentage ring | **shipped** (moved to status bar) | C2, B3 |
| Disclaimer line under composer | **shipped** (kept, decision 3) | C11 |
| Settings: two-pane, quiet rail, honest counter | **shipped** | S1–S6 |
| Theme swatches + segmented mode | **shipped** | A1–A2 |
| Per-surface font-size rows (Interface/Chat/Input/Code) | **shipped** | F1–F3 |
| Collections as card grids + one loud Add | **shipped** | phase 9 |
| Transcript: collapsed process detail, error/retry states | **shipped** | §6.3 |
| Heading convention: titlebar owns the single h1 | **shipped** | §11.2 |
| **Runs/board/history/automations/learning/live surfaces** | **open** | §2 |
| Settings heading sweep (20 duplicate h1s) | **open — ruling needed** | §3.1 |
| Disclosure consolidation (shared primitive) | **open — blocked, plan in §3.2** | §3.2 |
| `aria-modal` + `inert`; tablist roving focus | **open** | §3.3 |
| Packaged-app pixel pass | **open** | §3.4 |
| Page-local spacing rhythm on secondary surfaces | **open** | §4.4 |
| Mobile companion parity | **not adopted** (§6) | — |
| Mic/voice input beyond existing Live mode | **not adopted** | Live exists at `/live` |
| Light-theme rebrand to any reference palette | **not adopted** | minimalist §3 |

---

## Part 2 · The six uncovered surfaces (all paths `frontend/desktop/src/`)

### 2.1 Runs — the one genuine page-local outlier (`sections/runs/RunsPage.tsx`, 413 ln)

596 leaf nodes / 244 icons / 41 prose blocks measured. Per row (`:328-406`): status
pill `:333-338`, title + model@provider meta `:339-348`, goal prose `:349-351`, a
**5-item always-on stat cluster with 3 icons** (messages/turns/tokens/cost/duration
`:353-370`), then Cancel-or-Retry + Open (`:371-405`). 4 StatCards + 4 filter chips on
top (`:264-298`). No virtualization; adaptive poll 4s/20s (`:132-143`).

**Decisions, in order:**
1. **Demote the per-row stat cluster** (`:353-370`) to one muted mono meta line
   (tokens · cost · duration), or fold into row expansion — biggest single win:
   ~15 leaves + 3 icons × N rows.
2. **Collapse row actions to one primary** ("Open") with Cancel/Retry hover-revealed
   (`:371-405`).
3. Status pill → dot + text (`:333-338`); compress the 4-card stat strip to one line
   (`:264-275`).
4. **Collapsible status groups** (Working / Awaiting approval / Completed) reusing the
   existing `runPhase` classifier (`:64-80`) and `visible` filter (`:225-235`) — no
   new state machinery; open group counts as the census's node win.
5. Keep: filter chips, `PageLoader`/`QueryErrorState` usage (`:301-310` — already
   correct), the h2-under-titlebar convention (`:245`).

### 2.2 Board (`sections/board/BoardPage.tsx` 243 ln + `sections/settings/KanbanSection.tsx` 252 ln)

Two stacked headers ("Agent Board" `BoardPage.tsx:153` vs "Agent board"
`KanbanSection.tsx:65-72`); **5 controls per card** (`KanbanSection.tsx:181-238`)
including **3 always-on "→ Column" move buttons that duplicate the drag-and-drop
already wired** (`:174-177`, `:159-164`); two clashing palettes (KanbanSection
`bg-white/[0.06] bg-black/20` vs app-standard `bg-card/60`); **no loading/error
state on the runs or bots queries** (`BoardPage.tsx:46-54`, `KanbanSection.tsx:35-39`).
⚠ `KanbanSection` is also mounted by `SettingsPage` — changes ripple there.

**Decisions:** dedupe to one header + normalize to `bg-card` tokens → delete the 3
move buttons (drag is the interaction; keep keyboard reachability via one menu) →
hover-reveal the card X, collapse the team launcher behind a disclosure → collapse
empty-column "Drop cards here" placeholders to one borderless hint → add
`QueryErrorState`/`PageLoader` to both queries (the shared components already exist).

### 2.3 History (`sections/history/HistoryPage.tsx`, 147 ln — leanest)

Per row: whole-row open button + **permanently visible delete** (`:118-127`), a
per-row `MessageSquare` icon (`:104`), model/count meta. Date groups via
`groupByDate` (`lib/date-group.ts:47-59`).

**Decisions:** hover-reveal delete (confirm flow stays, `:135-144`) → drop the row
icon → mute meta → collapsible day groups (Today/Yesterday open, older collapsed —
`groupByDate` already returns contiguous buckets). Largely a polish pass.

### 2.4 Automations (`sections/automations/Automations.tsx`, 1043 ln)

**Per-job card = 7 buttons** + data-dependent extras (Pause/Resume/Re-arm `:907-921`,
Run `:922-924`, Edit/Delete `:925-937`, Rotate token `:968-970`, Open last session
`:971-980`, runs disclosure `:984-991`, plus one "session" link per run entry
`:1007-1014`); 4 conditional badges per card (`:803-835`); a meta line of
icon+span pairs (`:838-897`); **the input class literal
`rounded-md border border-border bg-background px-2.5 py-1.5 text-sm` repeats 13×**
in the form (`:476`–`:701`); `refetchInterval: 5_000` re-renders constantly (`:116`).
Async states are already correct (`PageLoader`/`QueryErrorState`/empty CTA
`:273-296`) — keep them.

**Decisions:** action row → one overflow menu (Pause/Run/Edit/Delete) with Run
promoted; badges demoted to a single status pill + quiet meta; the runs disclosure
becomes the standard collapsible-group; **extract the shared input class once**
(`ui/input` or a const) before any restyle; audit whether the 5s poll can idle down
to the same adaptive pattern runs uses.

### 2.5 Learning (`sections/learning/LearningHub.tsx` 104 ln + four settings sections, 5,190 ln)

The hub shell is already the reference shape (rail + one pane, `:60-102`). The work
is inside the four **double-mounted** sections (they render both at `/settings/:id`
and inside the hub — comments at `LearningHub.tsx:1-10`; `MemorySection` keys
browse-state off the passed id `:47-50`):

- **Memory** (`sections/settings/MemorySection.tsx`, 2,218 ln): flat rows carry
  ~6 interactive elements each (bulk checkbox + title button + menu trigger + 4
  menuitems, `:1749-1830`, menu at `:1916-1944`) plus kind/source/expiry badge stacks
  (`:1759-1817`). → quieter rows, group/collapse by store, actions behind one menu.
- **Skills** (`SkillsSection.tsx`, 1,243 ln): the tile grid already matches the
  ChatGPT pattern (`SkillCard :1105-1224`) — de-noise the toolbar only.
- **Inbox** (`HarnessImprovementsSection.tsx`, 860 ln): proposal rows with badge
  stacks + select-wrapping-checkbox + whole-row button (`:735-790`) → card treatment
  consistent with the Approvals pattern in the trading app: kicker, title, evidence,
  action row.
- **Scheduler** (`LearningPanel.tsx`, 869 ln): already collapsed-by-default with a
  plain-language summary (`:467-479`) — keep that grammar.

**Constraint:** one change serves two mounts; test both entries after each row-grammar
change. `SettingsTabs.tsx` tablist fixes (§3.3) apply here too.

### 2.6 Live + Agents (smallest passes)

- **Live** (`sections/live/`, `LiveSurface.tsx` 194 ln + 5 subcomponents): purely
  presentational — adopt `ui/button` over hand-rolled pills (`LiveControls.tsx:21-49`,
  `LiveApprovalCard.tsx:29-53`), bound the tool-rail's raw `JSON.stringify(e.args)`
  (`LiveToolRail.tsx:39`), mute the top bar (`:113-123`). State machine and STT/TTS
  wiring untouched. (G2/G3 from the minimalist §7 already fixed the error icon and
  the fake toggle.)
- **Agents** (`sections/agents/Agents.tsx`, 172 ln, **zero buttons** — read-only):
  replace the pretty-printed permissions JSON `<pre>` (`:155-157`) with a collapsible
  summary, mute the warning banner (`:40`), de-noise badges. Zero behavior risk.

---

## Part 3 · The four open items from the minimalist spec, made executable

### 3.1 Settings heading sweep — needs the user's ruling (one question)

20 settings/page components render an `<h1>` under the titlebar's route `<h1>`
(`ChatTitlebar` owns the h1; rule per minimalist §11.2). Fix is one tag each, but it
rewrites every settings page's document outline and `ObservabilitySection.test.tsx`
asserts `level: 1`. **Ruling requested:** (a) sweep all 20 to `<h2>` + update the one
test — the outline-correct answer; or (b) keep page h1s and demote the titlebar's on
settings routes only. Recommendation: (a).

### 3.2 Transcript disclosure consolidation — a phase, not a cleanup

The concrete defect (dual collapse on every turn) is already fixed. The remaining
work — one shared disclosure primitive for `expandOverrides`, `ActivitySummary`,
`ThinkingDisclosure` (+ `ExploreGroup`, `SubagentDelegateRow`) — is blocked by a
source-regex guard (`thinking-persistence.test.tsx` asserts `setExpandOverrides`
appears in `AssistantBlockTimeline` in a specific shape), a 582-line `ToolStepRow`
suite, and per-file element-count pins in `design-baseline.json`. Plan: replace the
regex guard with a behavior test first, then introduce the primitive behind the
existing props, then delete the duplicates. Estimate as its own phase; do not attempt
inside a surface pass.

### 3.3 Dialog + tablist a11y

`WorkspaceShell` claims `aria-modal` without `inert` on the background; `SettingsTabs`
and `HarnessImprovementsSection` render `role="tablist"` without `aria-controls`,
roving `tabIndex`, or arrow keys (minimalist §4.4 a/e). Fix: apply `inert` to the app
root behind the scrim while settings is open; add `aria-controls` + arrow roving to
both tablists. Small, mechanical, no visual change.

### 3.4 The packaged-Tauri pixel pass (owed from minimalist §11.3)

Run the packaged app (or `npm run dev:desktop` with a visible window), light + dark,
over: settings pages, sidebar, composer, drawer, transcript. Settle the three known
pixel questions: token-delta loudness beside timestamps, the status bar's 32px strip
at 100% scale, Appearance post-disclosure. Add the §2 surfaces to the same pass after
they ship. Leave screenshots in `.ui-review/` (dir exists).

---

## Part 4 · Cross-surface moves (the census confound hid these)

1. **Badge unification** — `components/ui/badge.tsx:6-22` has the variants; every
   surface layers ad-hoc `text-2xs` pills on top (`Automations.tsx:803-835`,
   `Agents.tsx:103-123`, `SkillsSection.tsx:1167-1177`, `MemorySection.tsx:1759-1817`).
   One badge grammar, then per-surface adoption — high-leverage quieting.
2. **Input class extraction** — the 13× repeated literal in `Automations.tsx` first;
   sweep other sections for the same literal as each surface opens.
3. **`SectionHeader` adoption** — `components/SectionHeader.tsx:16-26` exists;
   `LearningHub` (`:64-69`) and `LiveSurface` (`:113-123`) hand-roll their headers.
   Adopt or deliberately differ (Live's full-screen top bar may justify the
   difference — decide once, write it down).
4. **Page-local census** — re-measure with the ChatLayout shell excluded (measure the
   page container's subtree only), so §2's progress is provable and the ~100-button
   shell baseline stops drowning page-local wins. Shell-baseline numbers get their
   own row, measured once.
5. **Spacing rhythm** — mirror of the trading-app pass: 4px-grid row heights and
   list gaps per surface, applied inside each §2 pass, never a repo-wide sweep.

---

## Part 5 · Order of execution (each step gated)

| # | work | gate |
|---|---|---|
| 1 | §3.3 a11y (inert + tablists) + §3.1 heading sweep once ruled | tsc, vitest (update the one level:1 test), check:design |
| 2 | §4.4 page-local census script; publish shell-baseline vs page-local | committed script + numbers in this doc's addendum |
| 3 | §2.1 Runs (stat-cluster demotion first) | page-local census delta + vitest + visual pass |
| 4 | §2.2 Board (header dedupe → move-button removal → async states) | same; verify SettingsPage mount |
| 5 | §2.3 History + §2.6 Live/Agents (small passes together) | same |
| 6 | §2.4 Automations (input extraction → card grammar → poll audit) | same + automations test dir |
| 7 | §2.5 Learning row grammars (Memory → Inbox → Skills toolbar) | same, **both mounts** verified |
| 8 | §4.1-3 cross-surface (badges → SectionHeader decision) | check:design zero-new-drift after `--update` |
| 9 | §3.2 disclosure consolidation (behavior test first) | its own phase; full suite |
| 10 | §3.4 packaged pixel pass over everything shipped above | screenshots in `.ui-review/`; the three pixel questions answered |

Each phase ends with the app working: `tsc -b`, `npm run test -w frontend/desktop`,
`npm run check:design`, `npm run check:docs`; backend pytest is untouched by all of
the above (no backend changes anywhere in this plan).

**Concurrency warning:** the tree has uncommitted work in flight (usage/workbench/
memory_store/harness_self_improve + frontend `ActivitySummary.tsx`, `usage.ts`, …).
Stage explicit paths only; never `git add -A` — the same rule the trading repo
learned the hard way.

---

## Part 6 · What this plan deliberately does NOT do

- **No backend/harness behaviour changes** (still a separate agreement, per the
  minimalist spec §2): budgets, self-heal, memory injection, proxy adapters stay.
- **No token rebuild** — `tokens.css` is healthy (minimalist §3); this plan inherits
  it everywhere.
- **No mobile companion parity** — out of scope until the desktop surfaces settle.
- **No new surfaces** — everything here restyles or collapses what exists.
- **Approvals, clarifications, destructive confirms stay always-reachable** — carried
  invariant from the minimalist spec; hover-reveal never applies to them.
- **No re-flip of theme architecture; no reference-palette rebrand.**

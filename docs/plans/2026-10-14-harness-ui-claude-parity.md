# Harness UI → Claude Desktop parity (minimalist pass 2)

Date: 2026-10-14 · Status: **executed, with two items left open on purpose** — Stage D's terminal/preview/browser scope, and whether 27 search-only settings sections is the intended depth. Everything else, including B2's live confirmation, is measured: see §0b and `docs/plans/ui-refactor/STATUS-2026-10-14.md`. Owner: solo · Stack: Tauri + React 19 + TS, FastAPI backend, Zustand UI state, TanStack Query server state. Naming: `camelCase` TS, `snake_case` Python.

Goal: make the harness UI feel like Claude Desktop — minimalist, less text, no data the user doesn't need. **Do not assume what the navigation looks like; the audit is the first deliverable.**

Scope: left and right panels, Settings, the chat screen, icon usage.
Out of scope: **Trade, Journal, Learn** (they belong to August Trading — don't touch, don't add here), rollback/undo, voice error handling, agent-jobs execution, memory/recall **backend logic**, anything in the trading app.

---

## 0. Measured before this plan was written

The brief names things by memory. I checked each against the tree, because a plan that references a component that does not exist produces work that cannot land.

| Brief says | Tree says |
|---|---|
| "the step/token/cache-hit readout under the composer" | Real: `sections/chat/ContextRing.tsx` — % of context used plus "average cache hit rate after a divider", with a click-through `ContextBreakdown` (Messages / Thinking / … token rows, `:106-113`). Re-exported at `sections/chat/ChatComposer.tsx:9`. `aria-label` at `ContextRing.tsx:167` |
| `SavePointChip` | Real: `components/chat/SavePointChip.tsx` (+ its test) |
| `SkillEvolvedChip` | ~~**Does not exist.**~~ **This line was wrong, and it was my line, not the brief's.** The component is at `sections/chat/SkillEvolvedChip.tsx:58` and is mounted at `sections/chat/ComposerDecisionStack.tsx:18`, so it is on screen. The chips the brief's sentence might have meant (`SkillReceiptChip.tsx`, `TurnProvenanceChip.tsx`, `HarnessModeChip.tsx`, `SavePointChip.tsx`, `TaskProgressPill.tsx`) all exist too — which is exactly why the §B4 "consistent with the existing chip" work had to pick one deliberately. Corrected after implementation, having initially searched the wrong directory and reported the absence as fact |
| "a collapsible Task-style component" | `TaskProgressPill.tsx` exists; `RightDrawerTasksSection.tsx` exists. Neither is a transcript card — the pattern has to be picked deliberately, not inherited |
| left sidebar | `components/sidebar/SessionList.tsx`, `SessionRow.tsx`, `FolderTree.tsx` |
| right panel | 13 sections already: `RightDrawer{Artifacts,Browser,Circuit,Diff,File,Jobs,Notes,Plan,Preview,Subagents,Tasks,Terminal}Section.tsx` + `RightDrawer.tsx`, `RightDrawerState.ts`, `RightDrawerLauncher.tsx` |
| audit output → `status/ui-audit.md` | **No `status/` directory exists.** The repo convention is `docs/plans/ui-refactor/audit/`, which already holds five audits dated 2026-10-03 covering *these exact surfaces*: `-audit-chat-surface`, `-audit-shell-sidebar-drawer`, `-audit-settings-memory-skills`, `-audit-tokens-icons-update`, `-audit-mobile` |
| "read docs/plans first and don't contradict work in flight" | Two specs already decide parts of this scope — see §1 |

## 0b. Claims in this plan that implementation disproved

The plan's §8 asks for "every mismatch between this brief and the code", so the
list includes my own lines here. Each of these was checked again after the work
landed, against the tree, not from memory:

| Line in this plan | Measured state afterwards |
|---|---|
| §7 "one comment test is skipped" (heading demoter) | **False now.** `it.skip` / `test.skip` / `describe.skip` / `it.todo` — zero matches in the whole frontend suite. The HTML-comment case is present at `ChatMarkdown.test.tsx:349` as a documented limit with an explicit `continue`. |
| §7 "the invariant is unstated" | **Stated** in `markdownHeadings.ts:57-66` ("Reachability, stated honestly"), with the regex now `/<(\/?)h([1-5])(?=[\s/>])/gi`. Landed in another session's in-flight file, so it is recorded rather than claimed as shipped by this plan. |
| §7 "needs `annotation`/`math`/`semantics`" | **`annotation` alone is right, measured.** Rendering KaTeX with the app's own options and diffing every text node through `convertMathInHtml` changed **nothing**; the annotation payload stayed byte-identical. The visible HTML carries entities, so the raw LaTeX exists only inside `<annotation>` — adding the other two names would have been a widening with no defect behind it. |
| §5 / audit "the strip shows only the last 5 subagents" | **Already fixed before this work** (`49765d3d`), and measured in real Chromium at twelve workers. Same for "per-worker todos render only for the selected one" (`5863c1e6`, badge per roster row). |
| §B2 "tool cards show filenames, not absolute paths" | **Under-specified.** Shortening the row text was not enough: three surfaces build their card *title* through `getToolLabel(…, { command })`, which printed the verbatim line, and `commandDisplay` never recognised a UNC path at all. Both fixed; the census is in the status file. |
| §0 counts | **My "48 sections of which 27 hidden" was wrong** — a `grep -c "^    id: '"` over `settings-registry.ts` counts four `SETTINGS_CATEGORIES` ids that sit above the array. Counted inside `SETTINGS_SECTIONS` itself: **44 sections, 18 `basic` and 26 `hidden`**. 7 routes carry `nav: true`. |
| §1.1 "fix the no-op 'Remove view' ×" | **No longer a no-op** — it removes the tab (12 → 11 measured). What it does not survive is the pane unmounting, because `dismissed` is component state (`RightDrawerSubagentsSection.tsx:432`). |

**Settled, without a turn:** B2 is confirmed in a real browser. `?lab=toolrows`
mounts the actual `ToolStepRow` over the JSON `context` strings a transcript stores
(a drive-letter read, a long `rg` command, a UNC share) and the real
`MutationDiffCards` over a pending `rm -rf C:\Dev\…`, and
`e2e/tool-rows.spec.ts` asserts the pair: no path in the built label, the verbatim
command still visible where an approval needs it. Reverting the label fix makes the
approval-card case fail with the whole path in the title, so the tests cover the
fix. What the earlier draft of this row called "no tool rows appear in a restored
transcript" was my third instrument error on that page — see the status file's
withdrawal.

## 1. Conflicts to record, not re-decide

1. `docs/plans/2026-10-03-ui-ux-refactor-spec.md` §3.3 *Left sidebar* and §3.4 *Right panel (drawer) — including multi-subagent* already contain decisions, e.g. "keep one detail pane; add an always-visible compact roster strip" and "fix the no-op 'Remove view' × (`RightDrawerSubagentsSection.tsx:519-527` removes nothing)". This brief's §4 (right panel = current-chat context only, check multi-subagent scaling) is the same question. → Re-verify that spec's items against the tree; carry forward or explicitly reverse them in the audit delta, never silently.
2. `docs/plans/2026-10-10-minimalist-ui-redesign-spec.md` (89 KB, still current) owns the Settings information architecture (§4.1), the DOM census (§1.2/§1.2b), design tokens/icons (§3) and the settings-modal a11y status (§4.4, which already flags one claim as false). This brief's "occasional configuration inside Settings" and "icon usage" land inside it. → Deltas only; do not fork a second Settings IA.
3. `docs/plans/2026-10-11-ui-reference-capture.md` is the screenshot transcription of the same reference set. It already records the Memory modal's composer as "a key finding". → Cite it instead of re-describing the reference.
4. **Scope collision worth a decision:** the brief puts "memory/recall backend logic" out of scope, but the Memory UI parity work I measured on 2026-10-14 is blocked by two *read-door* defects (`memory_store/brain.py:31-34` omits `description` from the browse SELECT, so the summary column is dead; `_readable_value` unwraps only JSON strings, so bulleted Details arrive as a blob). Those are presentation plumbing, not recall behaviour. → Proposed line: read-door *field* fixes are in scope; retrieval, injection, BM25, `memoryAutoInject` and consolidation are not.

## 2. Stage A — audit (first deliverable, no UI code)

Re-verify rather than re-author: the five 2026-10-03 audits already describe these surfaces, and 11 days of commits have moved the tree (`514f3f3b` memory UI, `92b71312` `KernelVenvSection`, `19847e98` drawer HTML branch, `5d62e9fd`/`6ea8837b` markdown, plus the security work).

Write `docs/plans/ui-refactor/audit/2026-10-14-delta-shell-chat-settings.md` containing, per surface: what exists today, where its state lives (Zustand store vs TanStack query vs component state), which routes/stores it touches, and a keep / move / remove recommendation with a reason. Open each of the five prior audits and mark its items **still-true / already-done / stale / reversed-by-later-work**. Conflicts with §1 get their own lines here.

Also produce the two counts the brief's goal depends on and nobody has measured: how many distinct top-level destinations the harness exposes today vs Claude Desktop's four, and how many Settings sections exist vs how many are reachable.

## 3. Stage B — chat screen cleanup

1. **Remove the `ContextRing` readout** from under the composer (context %, avg cache hit, and the token breakdown popover). Keep the data reachable somewhere the user *pulls* it — the brief's rule is opt-in for what the app pushes. Decide in Stage A whether it moves into the model picker, the session menu, or a Status entry; do not delete the underlying `promptCache` accounting, which Usage also reads.
2. **Tool-call cards show filenames, not absolute paths.** Find every render site (not just one) and truncate at the display layer with the full path retained in a tooltip/`title` — never by mutating the value the model sees. Pin with a test that feeds a Windows path and a UNC path.
3. **Fix the scroll-pin** so generation does not force the viewport to the bottom. Establish the rule first: pinned only when the user was already at the bottom; any upward scroll releases the pin until they return. Measure the current behaviour in the running app before changing it — this is a bug the brief asserts, and the fix depends on which of the two mechanisms (effect-on-new-tokens vs a scroll handler) is actually at fault.
4. **Collapsible tool steps** in one Task-style component, consistent with `SavePointChip` (and confirm whether `SkillReceiptChip` is the second one meant). One component, not a fourth variant: enumerate the existing card/chip/pill renderers in Stage A and converge.

## 4. Stage C — navigation and Settings

Reference shape: chat is the default screen; conversation history lives in the left sidebar; occasional configuration (skills, memory, connectors) lives **inside Settings**, not in the main navigation.

- Shorten the sidebar to daily-driver content. Anything not used daily moves into Settings or the session menu; removal is decided in Stage A with a named reason per item, and nothing gets deleted that only has one entry point.
- Settings is already the home of Memory (`settings-registry.ts:346` `memory-knowledge`) and Skills; the audit decides what else moves in. Do not add a second registry.
- Icon usage: follow `2026-10-10-minimalist-ui-redesign-spec.md` §3 rather than introducing glyphs; the census there is the baseline.

## 5. Stage D — right panel

Restrict the drawer to context tied to the current chat (subagent progress, per-subagent todos), then **measure how it scales with several simultaneous subagents** — that is a real check, not a style pass: render N concurrent subagents in the running app and report whether the roster stays legible, whether the §3.4 roster-strip decision from the 2026-10-03 spec holds, and whether the no-op "Remove view" × is still a no-op. Sections that are not current-chat context get an explicit keep/move/remove line in Stage A before anything is wired off.

## 6. Process rules (standing)

1. Audit first (§2). No UI code before it exists as a file.
2. Read `docs/plans/` first; record every conflict in the audit delta and in the status note.
3. Small commits, one per logical step. After each: what changed, what was verified, what is open.
4. **Verify in the running app**, not only in tests — `npm run dev:desktop`. Mocks for UI checks; ask before any real model completion. Typecheck and vitest never suffice to call a UI item done.
5. Run the backlog continuously; put judgement calls under **"Needs review"** and keep going rather than stopping. Review happens at the end.
6. Gates per change: `npm run test:frontend`; backend-touching changes also `cd backend-py && uv run ruff check . && uv run mypy app/ && uv run pytest -q -n auto`. `npm run check:docs` if a documented constant moves.
7. Do not disturb the in-flight markdown-math work in the tree (`markdownMath.ts`, `ChatMarkdown.tsx`, `v11_math_unicode.test.tsx`) — it belongs to another session.

## 7. Open defects carried from the 2026-10-14 review (not UI, but they gate any ship)

- `hardline.py:776` feeds the un-normalized path to `_agent_state_reason` while `:757` feeds `_store_match_form(...)`; measured on this machine, `write_file` to `…\data\skills\deploy\SKILL.md`, `…\data\Skills\evil\SKILL.md`, `…\data\automations.json` and `…\.AUG\Skills\evil\SKILL.md` all **BOUND** (allowed) where the lowercase spelling is refused. One-line fix + a test that stops lowercasing its own fixture.
- Judge `allow_loopback` permits *any* loopback URL for the `artifact-judge` session and `_renderHtmlPages` never calls `assertFinalUrlAllowed` nor checks `page.url`.
- `.aug/kernel/venv/**` (incl. `site-packages` and the venv's own `python.exe`) is not behind the agent-state write door.
- `markdownMath.ts:84` `VERBATIM = new Set(['code','pre'])` — the converter rewrites KaTeX's `<annotation encoding="application/x-tex">` source; needs `annotation`/`math`/`semantics`.
- `v11_math_unicode.test.tsx` is a stale spec of a behaviour retired by design (`markdownMath.ts:31-35`); flip 2 cases to verbatim assertions, keep the other 5.
- `test_bundled_skills_snapshot_parity.py` red locally: `resources/skills` is a stale build artifact — `npm run prepare:desktop-backend` refreshes it.
- Six undocumented escape routes in the heading demoter's HTML regex (comments, CDATA, `<template>`, `<textarea>`, `<title>`, `>` inside an attribute) — safe only while every consumer escapes; the invariant is unstated and one comment test is skipped.

## 8. Report

Written after implementation, against the tree and command output — not against
this plan's intentions. Per-item detail, retractions and measurements live in
`docs/plans/ui-refactor/STATUS-2026-10-14.md`; this is the summary the brief asked
for.

**What shipped**

| Item | Commits | What changed |
|---|---|---|
| Stage A audit | `e3e619b0` | Delta against the five 2026-10-03 audits, in the repo's `docs/plans/ui-refactor/audit/` convention rather than the brief's `status/ui-audit.md`, with a keep/move/remove line per drawer section. |
| B1 context/cache readout | `9c014058`, `c1ddd7f9` | The gauge was **already unmounted** before this pass; the dead component and the comments claiming it was mounted are gone. The `promptCache` accounting the brief protected is untouched and still read by Usage. |
| B2 filenames, not paths | `7cdec061`, `a1fbb0f8`, `3024c295` | Row text shortened; then the **label** path, which three surfaces build through `getToolLabel`, was found still printing the verbatim absolute path and fixed where they converge; then **UNC paths**, which the rule did not recognise at all. Census: seven render sites, two owners. |
| B3 scroll pin | `1fb087bc`, `b12c15b6`, `b6aacacf`, `f74798ad`, `c8339c40` | Listeners bound to a replaceable node; the anchor recorded the *requested* position instead of the clamped one the browser reached; and the lab grew a generation mode so the follow animation is actually running. |
| B4 one disclosure | `849d5c5e` | `.disclosure-chevron` on every `<summary>` in the transcript, re-using an icon already imported there. |
| C navigation | `76433449` | Sidebar shortened to Automations plus the session list; Board moved into the Settings rail; `nav: true` feeds the command palette, so nothing lost its only door. |
| D right panel | `49765d3d`, `5863c1e6`, `e289849e`, `880ddb41` | Every subagent gets a tab (the `slice(-5)` is gone); per-worker todo progress shows in the roster; the section set is declared once with the picker derived from it and a totality test; the × is a real dismissal. Plus the twelve-worker measurement below. |
| §7 security defects | `9e0526ed`, `a4c912de`, `c2b46d4c`, `3b0efc97` | Windows-inert agent-state write door, the kernel venv the door missed, the judge's host-wide loopback carve-out narrowed to the artifact route, and the URL built from the constant the carve-out matches. |

**Verified live** — in real Chromium, not jsdom: both scroll-pin release cases
(`e2e/scroll-pin.spec.ts`); the twelve-worker roster — 12 tabs, pane still exactly
420 px, strip scrolls, last tab reachable and selectable, × removes only the view
(`e2e/subagent-roster.spec.ts`); the launcher's counters including the `9+` cap and
non-overlap of the two indicators (`e2e/launcher-badge.spec.ts`); B2's row and
approval-card labels (`e2e/tool-rows.spec.ts`); B4 on restored data — 76
"Task completed" triggers on a real session; the a11y smoke on `/`, `/automations`,
`/settings`; and B1/C by an absence check (no cache/context text, no `t/s`, no
`answered via`, Board and Learning rows gone, 47 session rows intact).

**Verified only in isolation** — the drawer chooser's section coverage (jsdom,
`RightDrawer.test.tsx`, proven to fail when a section is dropped), and every unit
case behind the above. The label fix at `MutationDiffCards` is the one site asserted
in the browser without also proving the other two surfaces can reach it.

**Open, and why** — three decisions, none of them work: the terminal tab vs the
bottom dock (measured: identical five imports, so removal costs a position, not a
feature); the jobs tray, where the audit's own premise was wrong — it renders a
non-persisted **frontend** registry and is already opt-in, so "move to a global
surface" is not implementable as written; and whether 27 `tier:'hidden'` sections
out of 48 is the intended depth. Plus two things outside my authority to finish: the
`v11_math_unicode.test.tsx` flip is written and green but must land with another
session's still-untracked `markdownMath.ts`, and nothing here is pushed — `master` is
55 commits ahead of `origin/master`.

**Mismatches between the brief and the code** — §0 lists the ones found before
writing this plan; §0b lists the ones this plan itself got wrong and that
implementation disproved, including `SkillEvolvedChip` (it exists and is mounted),
the "skipped comment test" (no skips remain), the two already-fixed subagent claims,
and B2 being under-specified in a way that hid two real leaks. Three findings of mine
that turned out to be instrument errors are withdrawn in the status file rather than
quietly deleted: the in-app browser never dispatches scroll events, `<details>` is
the wrong primitive for a Radix disclosure, and a childless-node text scan cannot see
a label rendered beside an icon.

**Gates at writing time:** frontend 227/227 files (`FE_EXIT=0` read from the log's
own marker), e2e 12/12, `tsc --noEmit` clean, `npm run check:docs` 6/6.

### 8b. Addendum — after two review passes (2026-10-14 late)

The report above was written at `9a7b3ef5`. Two review passes since then changed both the
shipped set and four of its claims, so they are corrected here rather than left to rot:

| §8 claim | Current state |
|---|---|
| "Open: the terminal tab vs the bottom dock" | **Closed by measurement, not decision.** Nothing in the app could add `terminal` as a drawer section, so the tab was unreachable: `RightDrawerTerminalSection.tsx` (436 lines) deleted in `3fe68169`; the dock is the only terminal surface and keeps its picker card. |
| "27 `tier:'hidden'` sections out of 48" | Wrong counts from a grep that double-counted `SETTINGS_CATEGORIES`. Measured: **44** sections, **18** basic, **26** hidden. |
| "Verified only in isolation — the drawer chooser" | Now verified live: 12 cards on the real shell, and picking `notes` opened its tab and pane and exited the chooser. |
| "e2e 12/12" | **19/19**, and both scroll-pin cases now include the streaming one that discriminates (removing the `lastAppliedTopRef` release branch fails it at `free: false` while the idle case keeps passing). |

Shipped by the review passes, each measured before and after in real Chromium:

| Commit | Change |
|---|---|
| `31d3223a` | The collapsed working strip kept its plan toggle in the tab order — `aria-hidden` does not withdraw a control; `inert` does. Red-proven: reverting the attribute makes Chromium focus the invisible button. Same commit fixes the design gate I had turned red with my own lab buttons. |
| `26219ae5` | Both per-message action rows were invisible exactly when keyboard focus reached them (a `group-focus-within:` variant with no `group` ancestor; the user row had no reveal clause at all). Seven focusable buttons per exchange. Measured `focused=0` before, `1` after — and the 150ms opacity transition had to settle or the reading is the pre-animation value. |
| `425f2101` | `SessionRow` carried `text-[0.78125rem]` over a rule that wins the cascade; computed 13px on `/` and `/_design`, so the class stated a size the app did not render. |
| `6eaabd32`, `81e9df48` | Six comments described an IA that stopped rendering in October — first corrected from three headers to four, then corrected **again**, because all of them (including my fix) claimed the headers are the rail while `c5748da0` had flattened the unfiltered rail to 18 rows. |
| `79b5362a`, `abe60049` | A voice-command row printed its registry id as the sentence. The replacement copy then failed under the 6-worker suite and exposed a real readiness race: registration is deferred to idle and the registry is not reactive, so an absence-claiming fallback becomes a permanent lie. The wording is now branch-true. |
| `68022ddf` | The global `details > summary` reset lived in `chat.css` while two non-chat surfaces (`ErrorBoundary`, the bootstrap error card) depended on it. |
| `c365c586` | GeneralSection's four native `<select>` boxes migrated to the app's own listbox primitive; two of their `<label>` wrappers had to become divs, since a button is not a labelable element. |
| `a72cc440` | Jump-to-top sat on the composer at the app's default 1280px window (35.5px of gutter against the 48px a 36px circle needs); re-anchored to the transcript area, with a rect assertion that fails if the anchor is dropped. |

The audit-side deliverable this plan owed but had not produced is now there too: §7 of
`docs/plans/ui-refactor/audit/2026-10-14-delta-shell-chat-settings.md` re-judges all five
2026-10-03 audits item by item — 270 verdicts, 130 still-true, 88 already-done, 25 reversed,
25 stale citations, i.e. 42% of this plan's own source material no longer described the tree.

**Every §7 line, re-checked against the tree rather than against this plan's memory.** Items
1-3 — the `hardline.py:776` normalization miss, the judge's host-wide loopback carve-out and the
kernel venv behind the wrong door — are fixed and committed (`9e0526ed`, `a4c912de`, `c2b46d4c`,
`3b0efc97`), each with its red proof recorded in the status file. item 6, `test_bundled_skills_snapshot_parity.py` red locally, **is green now**: 5 passed in 16.1 s on this machine without running `prepare:desktop-backend`, so the stale staged artifact it named has since been refreshed. Items 4, 5 and 7 are the markdown-math cluster; they live in another session's in-flight files and process rule 7 excludes them, so they are neither claimed nor done here.

**Still open, and none of it is work I can do quietly:** the jobs tray destination (its audit
premise was wrong — non-persisted frontend registry, already opt-in, so "move to a global
surface" is a feature, not a relocation); the composer row and sidebar density pass;
`ChangesCard`'s three type sizes and three nested borders; four native selects' *behaviour*
in the desktop app (offline web mode blocks every click in that panel, pre-existing and proven
with a control click); the Settings scrim tint, which the references show dimmed and
`workspace-shell-tier-filter.test.tsx:77` asserts undimmed; the sidebar header whose own
comment claims two icons while the DOM renders three; and §7's math items, which belong to
another session's uncommitted files. Nothing is pushed: **`master` is 88 commits ahead of
`origin/master`** (`git rev-list --count origin/master..HEAD`, not an estimate).

## Needs review

Rewritten after both review passes. The four questions written at planning time are answered
inline so nobody re-asks them; the six live ones each carry the measurement and the default I
would take if you want me to proceed without further input.

**Resolved since writing:** (1) `SkillEvolvedChip` exists and is mounted
(`sections/chat/SkillEvolvedChip.tsx:58` via `ComposerDecisionStack.tsx:18`) — the brief's
premise was wrong, not the code. (2) The context/cache readout was already unmounted, so
"where should it go instead" has no ship-blocking answer; Usage still reads `promptCache`.
(3) §1.4's read-door scope was implemented as written. (4) The audit convention stayed
`docs/plans/ui-refactor/audit/`.

**Live decisions:**

1. **Jobs tray destination.** The audit's "move to a global surface" is not implementable as
   written: `RightDrawerJobsSection` renders `useBackgroundTasksStore`, which has no `persist`
   and is session-scoped, so a global page would show nothing. Either keep as-is (my default),
   or design persistence + a floating indicator as its own feature.
2. **Composer row and sidebar density.** No measured target exists; this is your eye against
   Claude's, not a defect list.
3. **`ChangesCard` hierarchy** — the biggest remaining visual gap. Three literal type sizes
   (`:137` 11.5px, `:144/:248` 10.5px, `:207/:259` 11px) and a bordered file row inside a
   bordered "N file changed" card inside a bordered turn card, plus a 32px icon tile. Claude
   (`2026-10-08 165256`) is one hairline-divided stack. Default I'd take: one meta rung
   (`text-2xs`), drop the inner row's border, keep the outer card, keep counts and Undo.
4. **Sidebar header controls.** `FolderTree.tsx:40-44` states the header keeps two icons
   because only those are in the reference; the DOM renders three (`Sort chats`, `Open
   Workspace Folder`, `Create Sidebar Folder`) and a nested Tasks row adds `New chat in Tasks`
   plus `Delete all tasks`. Two of those are the only door to their capability, so removal is a
   feature decision; the prose is now corrected (the false claims were the defect a reader would trust); dropping the two buttons remains your call.
5. **Settings backdrop tint.** `workspace-shell-tier-filter.test.tsx:77` pins an *undimmed*
   backdrop ("floats the panel over the app instead of tinting the background"); the references
   at `2026-10-10 235015` show a dimmed one. A pinned test versus a reference image — one of
   them is wrong and it is not mine to pick.
6. **`tier: 'hidden'` depth.** 26 of 44 sections are reachable only by search or deep link
   against Claude's four always-visible destinations. Keep, or promote a subset.

**Outside my authority to finish:** §7's math items belong to another session's uncommitted
`markdownMath.ts` / `markdownHeadings.ts`, and the `v11_math_unicode.test.tsx` flip must land
with them. And **nothing is pushed** — `master` is 88 commits ahead of `origin/master`; the
`Type check` job does not gate a tag, so pushing a tag without checking it first publishes
unchecked.

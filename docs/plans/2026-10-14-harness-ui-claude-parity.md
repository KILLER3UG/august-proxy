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
| §0 counts | Re-verified: **7** routes carry `nav: true`, the registry holds **48** sections of which **27** are `tier: 'hidden'` — the "reachable only by search" figure was right. |
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

At the end: what shipped; what is **verified live** vs verified only in isolation; open items; and every mismatch between this brief and the code (§0 is the start of that list). Nothing gets called "functioning" unless it was confirmed in the running app.

## Needs review

1. Which chip is `SkillEvolvedChip` meant to be?
2. Where should the context/cache readout go instead of being deleted outright?
3. Confirm the §1.4 line: read-door *field* fixes in scope, recall behaviour out.
4. `status/ui-audit.md` vs the existing `docs/plans/ui-refactor/audit/` convention — I've assumed the latter.

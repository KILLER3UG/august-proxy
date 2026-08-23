# August Chat UI — Deep Dive & Minimal-Design Alignment

**Date:** 2026-08-23 · **Scope:** `frontend/desktop/src/sections/chat/`, `components/chat/`, `components/shell/`
**Reference designs:** Hermes Agent desktop app (docs/user-guide/desktop), DeepSeek harness chat, Kilo Code context popover.

## 1 · What the chat UI already is (verified inventory)

| Layer | Component | Pattern |
|---|---|---|
| Transcript | `ChatThread` → virtualized `ChatThreadMessagePane` (`data-message-index`) | windowed rows, stick-to-bottom with unpin-on-jump |
| Live markdown | `ChatMarkdown` incremental block cache | completed blocks render once; only the growing tail re-parses (5.5× faster) |
| Reasoning | `ThinkingDisclosure` (memo) | collapsed by default — quiet line, one click to expand (DeepSeek pattern) |
| Tools | `ToolStepRow` / `ToolCallItem` / `ToolSummary` | muted inline rows while running, summary rollup after; failures render red |
| Search | `InThreadSearch` | ⌘F floating bar, Enter/Shift+Enter match walk, virtualizer-aware jumps |
| Timeline | `TimelineRail` (≥5 prompts) | slim edge rail → hover list → click-to-jump |
| Context | `ContextRing` 22px donut + hover popover | usage bar, per-category breakdown, prompt-cache hit row, Compact now |
| Subagents | right-drawer `SubagentExpandedCard/Timeline`, queued/stalling glyphs | detail lives in the drawer, transcript stays calm |
| Self-improvement | `SelfImprovementStrip` | single amber inline line after a turn ("Skill 'x' created"), auto-fades 8s |
| Todos | right-drawer Tasks section | grouped by status; **now interactive** (click/Enter toggles done via PATCH) |
| Git review | right-drawer Diff section + **new CommitComposer** | changed files + diffs + Keep-all/Revert-all + Generate-message commit |
| Memory graph | `MemoryGraphTab` / `KnowledgeGraph` | zoomable entity/relation canvas + search + **All/Learned/Recent pills** |
| Composer | decision stack, clarify cards, quick-entry ⌘⇧Space | stacked decisions instead of modal dialogs |

## 2 · Design language audit (vs Hermes desktop / DeepSeek)

Conventions August already follows correctly:

1. **Quiet-by-default density.** Tool activity, reasoning, and self-improvement events are muted single lines that expand on demand — the same discipline as DeepSeek's collapsed reasoning and Hermes' structured tool summaries. No chrome-heavy cards in the main flow.
2. **Progressive disclosure everywhere.** Name-only skill index in prompts mirrors the UI: details are one hover/click away, never dumped.
3. **Motion budget.** 140–220ms fades, honors reduced motion, no layout-thrashing animations.
4. **Status without noise.** `RunTelemetryBar`, `ChatRunHeader` (Mode · Wave · live · ctx), context ring — live state is always visible but never chatty.

Gaps found & closed in this pass:

| Gap | Fix shipped |
|---|---|
| Context popover had no MCP visibility; token estimates silently never reached the client (snake_case vs camelCase) | backend `mcp_tools`/`estimated_mcp_tokens`; client normalization; indented "MCP tools ↳" sub-row |
| No way to commit from the review pane | `CommitComposer` with AI-generated message (session model via `/btw`) |
| Todo list was read-only | interactive checklist w/ optimistic toggle |
| Graph couldn't show "what did August learn itself" | Learned/Recent scope pills |

Deliberately NOT copied from Hermes (recorded as non-goals): HUD float-over mode, global Quick Entry hotkey, pop-out windows, VS Code theme importer. High effort, low daily value for a solo operator whose workbench already hosts terminal + files + drawer panes. Revisit if multi-monitor workflows grow.

## 3 · Recommended next polish (not blocking)

1. **Queue editing affordances** in the composer (Hermes lets you edit queued messages before send; API supports steer/queue already).
2. **Aux-model split warning** when background-task models diverge from the session model (cost transparency).
3. **Status-bar customization** (right-click → show/hide items) once more meters land.
4. **Timeline scrubber for memory graph** (Hermes Star Map playback) — data exists in the ledger.

*Verdict: the chat surface is already in the DeepSeek/Hermes class — minimal chrome, informative on demand. This pass closed the remaining functional gaps rather than restyling.*

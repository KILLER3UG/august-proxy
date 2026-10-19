# Roadmap — deferred work, and the decisions behind it

This file records what was **deliberately not done**, and why. Everything
here was seen, evaluated, and left alone on purpose — it is not a backlog of
forgotten things. If you pick something up, move it out of here and into a
commit message.

The reference for the chat surface is Claude Code / ChatGPT. The table below
is the gap between what the reference shows and what August shows now.

## Shipped in this round

| Change | Where |
|---|---|
| A run of tool calls collapses into one activity line + a bordered card | `components/chat/ActivityGroup.tsx`, `lib/tool-summary.ts` |
| The run phrase ("Ran 4 commands", "Ran 4 commands, read a file") | `lib/tool-summary.ts` |
| The self-correction frame is visible in the transcript | `lib/recovery-copy.ts`, `makeStreamHandlers.ts` |
| The model list no longer paints a long id over its own badges | `sections/workspace/models/ModelRow.tsx` |
| The tool label is one span that actually animates, and is not dimmed | `components/chat/tool/ToolCallItem.tsx` |
| The update is an in-place silent replace, and the app restarts itself | `src-tauri/windows/installer.nsi`, `hooks.nsh`, `src/backend.rs` |
| The download is automatic; the restart is still the user's click | `hooks/useAppUpdate.ts`, `lib/preferences.ts` |
| The updater signature is proved against the key the app trusts | `scripts/minisign-verify.mjs` |
| `/mcp/harness` is behind the gateway key | `routers/harness_mcp.py` |
| Four more data-directory paths are closed to the model | `services/sandbox/hardline.py` |
| Three gates for defects that were invisible | `scripts/check-{brain-config,truncate}.mjs`, `check-sse-parity.mjs` |

## Deferred — reference-app chrome

These are visible in the reference and are **not** in August. Each is listed
with the reason it was left, so the next person does not have to rediscover
the analysis.

| Feature | Why it was deferred |
|---|---|
| **An inline terminal in the tool card.** The reference renders a terminal *inside* the tool call, live, as the command's own output. | August has a live terminal — `components/shell/BottomTerminalDock.tsx`, mounted by `ChatLayout.tsx` — and it is a separate surface on purpose. Merging the two would mean one component owns two very different lifecycles: a dock that outlives the turn, and a card that dies with it. The reference has only the inline one because it has no dock. If August's dock is ever retired, the inline terminal becomes the natural replacement. |
| **Copy / re-run affordances on a tool row.** The reference puts a copy button and a re-run button on each command. | Re-run needs a product decision: re-running a command from last week means resolving the workspace, the guard mode and the approval state **as they are now**, not as they were. A re-run that silently picks up today's sandbox settings is a different command. Worth doing; not worth doing wrong. |
| **A diff view inline in the tool card.** | The reference shows a coloured diff in the card. August shows a `±N` stat on the edit rail row and opens the full `DiffView` on demand. The full diff is richer than the reference's; the rail is quieter. Merging them is a layout change, not a new capability. |
| **Per-token cost and duration on the activity line.** | August shows the run's total elapsed time. Per-token cost needs the run to be attributed to a cost, and the budget ladder can re-price a turn after the fact (`cost_estimator.price_for_model` is the only source, and it is not necessarily the price at call time). Showing a number that later changes is worse than showing none. |
| **A "you have N new versions" badge in the sidebar.** | The update check already runs on launch and on window focus, and the download is now automatic. A badge would be a second signal for a thing the app already acts on. |
| **Keyboard-driven collapsing of the activity card.** | The card is a disclosure with a button; it is reachable by Tab. A shortcut is a nicety, and every added shortcut is a key the composer might want. |

## Deferred — with a decision needed first

These are not deferred because they are hard. They are deferred because the
**product decision** has not been made, and guessing would bake the guess
into the code.

| Decision | The question | What it affects |
|---|---|---|
| **Group every tool kind, not just commands.** | A run of *reads* is already collapsed by `ExploreGroup` ("Explore · 2 searches, 3 files"), and a run of *commands* is now collapsed by `ActivityGroup` ("Ran 4 commands"). Should a MIXED run — a read, a command, a read — become one line, or stay two? | The reference collapses everything into one line. Doing that here means `ExploreGroup` and `ActivityGroup` merge, and the Explore group's own vocabulary ("Explore") goes away. |
| **Group across a turn boundary.** | Today a run is a run of *consecutive* blocks. A turn that reads a file, answers, and reads another file is two groups, because the answer is between them. | Grouping across an answer would put unrelated work under one line, and the elapsed time would be the sum of two things that never ran together. |
| **Should a failed command be grouped at all?** | Today a run containing a failure is NOT grouped: each command keeps its own row, so the red line is always visible. | The reference groups failures too and marks the line. Grouping a failure is only safe if the group opens on failure, which is a different default state. |
| **Apply the update without a restart.** | The download is automatic; the restart is the user's click, because it interrupts whatever is running. | Restarting on idle ("no turn has run for 60 s") is possible, and is the natural next step. It needs the app to know it is idle, which it partly does (`liveActivity`). |
| **Update on a schedule, not on launch.** | The download starts 60 s after launch. | A scheduled check (nightly) would find builds published while the app was closed. It needs a task scheduler, which the app does not have on the desktop. |
| **`/mcp/harness` by default.** | It is closed unless the user enables external access. | An outer agent that drives August needs the key. If August is meant to be a harness for other agents, closing it by default is wrong — and the default is a one-line change. |

## Deliberately not done

- **No test suite was restored.** The suite was removed on 2026-10-17 at the
  owner's request. What replaced it is static: three new gates, each
  negative-tested against the exact defect it catches, plus the gates that
  were already there. See the gate list in `AGENTS.md`.
- **No history rewrite.** The 85.6 MB Node binary is in the history and nine
  tags pin it. Rewriting would change every tag; the cost is higher than the
  saving.
- **The `data/` directory was never touched.** It is the user's memory
  (1.58 GB in this checkout). Nothing in this round read from it or wrote to
  it, and the `AUGUST_DATA_DIR` overrides in the gates point at throwaway
  temp directories.

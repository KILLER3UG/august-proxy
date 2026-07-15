# August UI Harness Parity Plan

> **Goal:** Make the **August desktop UI** (beginner-friendly workbench) deliver *every capability* a modern coding CLI/TUI harness provides — without shipping a coding CLI/TUI.  
> **Audience:** Beginners first; power features discoverable, never required.  
> **Out of scope:** A dedicated `august` terminal TUI, Claude Code clone CLI, or replacing the multi-provider proxy role.  
> **Related:** [cognitive-architecture-v1.md](./cognitive-architecture-v1.md), [tracker-v4.md](./tracker-v4.md), comparison notes from harness gap analysis.

---

## 0. Reality check (audit vs codebase)

Many items in early gap analysis were **already implemented** in August — often as backend + UI that is **buried** rather than missing. This section is the source of truth for prioritization.

### ✅ Already implemented (use / polish, do not rebuild)

| Capability | Where it lives today |
|------------|----------------------|
| Guard modes Plan / Ask / Do | `WorkbenchMode` + composer mode selector; backend `normalizeGuardMode` / plan gate |
| Plan propose → Accept / Accept+implement / Reject / Revise | `PlanProposalBanner.tsx` + workbench approve/reject APIs |
| Plan detail in sidebar | `RightDrawerPlanSection.tsx` |
| Live todos / tasks | Backend `submitTodos` / `updateTodos`; `RightDrawerTasksSection.tsx` |
| File diffs after turn | `ChangedFilesCard.tsx`, `DiffView.tsx`, `RightDrawerDiffSection.tsx`, tool-call diffs in `ToolCallItem.tsx` |
| Git branch + changes panel | `GitPanel.tsx`, titlebar branch, `/api/git/*` |
| Mid-stream **message queue** + dequeue | `queue-store.ts`, composer “Type to queue…”, backend `enqueueUserMessage` |
| Stop generation | Composer/thread Stop button |
| Context usage ring | `ChatComposer` context ring |
| Auto compaction + notice | Workbench auto-compact; stream notice in `makeStreamHandlers.ts` |
| Command palette (basic) | `CommandPalette.tsx` — New chat, Settings, theme, navigate |
| Sessions list / new chat | Session sidebar + store |
| Terminal in workbench drawer | `RightDrawerTerminalSection` + terminal service approvals |
| Browser drawer | `RightDrawerBrowserSection` |
| Preview drawer | `RightDrawerPreviewSection` |
| Clarify questions | `ClarifyTool.tsx` + queue answer back |
| Subagent approval | `SubagentApprovalCard.tsx` |
| Rollback history (settings) | `RollbackHistory.tsx` + rollback APIs |
| Provider first-run onboarding | `ProviderOnboardingModal.tsx` |
| AUG.md init with side-by-side diff | `InitAugCard.tsx` |
| Skills UI | Settings Skills section |
| Automations section | `Automations.tsx` |
| Integrations + Google OAuth (BYO) | Integrations + `/google/callback` |
| Memory / brain / live voice / model fleet | Existing product surfaces |
| Advanced settings tier | Settings registry `basic` vs `advanced` |

### ⚠️ Partial (exists but incomplete vs harness bar)

| Capability | What’s there | What’s missing |
|------------|--------------|----------------|
| Command palette | Nav + a few actions | Undo, compact, mode switch, checkpoint restore, skills, integrations |
| Permissions | Guard modes + agent permissions + terminal approve | Tool toast: **Once / This chat / Always for folder** |
| Diffs | **Post-turn** git/tool diffs | **Pre-apply** accept/reject per file before write |
| Queue | Solid FIFO queue | Reorder; true **steer** (inject mid-tool-loop without waiting for turn boundary) |
| Compaction | Automatic + banner | Explicit **Compact now** control |
| Sessions | List, resume, titles | **Branch/fork** from message; **Undo last turn** |
| Rollback | Settings history | Chat-native **Restore save point** after mutations |
| Setup | Provider onboarding | Full checklist (workspace, integrations, health) |
| Subagents | Spawn + approval | Team grid, cancel-all, worktree isolation |
| Google sign-in | Works with BYO client | One-click public OAuth (product decision) |

### ❌ Not really implemented (true gaps)

| Capability | Notes |
|------------|--------|
| Filesystem **checkpoints** before mutating batches | No checkpoint service; “checkpoint-pill” in chat is scroll/UI, not FS restore |
| **Git worktrees** for isolated parallel agents | Not present |
| Session **branch/fork** | No clone-from-message API/UI |
| **Undo last turn** | No truncate last exchange API/UI |
| Mid-run **steer** as first-class | Queue is adjacent, not the same |
| Permission grants Once/Session/Always | Not the Claude-style toast model |
| Pre-write patch gate | Diffs are after-the-fact |
| Sandbox code execution toolset | No dedicated safe Python cell |
| Multi-agent **kanban/tasks board** | Todos exist; durable multi-agent board does not |
| Skills `@` picker in composer | `@` icon exists; hub/browse/install not CLI-parity |

### Implication for the plan

**Phases 0–1 in the original draft over-scoped “build coding loop.”**  
August already has plan/todos/diffs/queue/modes. Next work should be:

1. **Discoverability & beginner polish** of what exists  
2. **True gaps only** (checkpoints, worktrees, fork/undo, permission toasts, pre-apply, steer, one-click OAuth)  
3. **Palette / chrome wiring** so power features aren’t only in drawers/settings  

---

## 1. Product principle

| CLI mental model | August UI equivalent |
|------------------|----------------------|
| Slash commands | Composer command palette (`/` or `Ctrl+K`) + always-visible action chips |
| Flags (`--yolo`, `-w`) | Session toggles and Settings with plain-language labels |
| Streaming tool logs | Inline tool cards in the chat thread + optional detail drawer |
| `/help` | Guided empty state + Command Help card (already started) |
| Terminal is the app | **Chat is the app**; Terminal/Workspace/Integrations are side panels |

**Beginner rule:** Every advanced control has (1) a default that is safe, (2) a one-sentence explanation, (3) an undo path.

---

## 2. Inventory: CLI capabilities → UI targets

### 2.1 Session control

| CLI capability | Status in August | UI target |
|----------------|------------------|-----------|
| New / reset session | Partial (sessions exist) | **New chat** always one click; confirm if dirty |
| Resume / continue | Partial | Session list with search, pin, rename; **Continue last** on home |
| Undo last exchange | Weak / missing | **Undo last turn** button + history scrubber |
| Branch / fork session | Missing | **Branch from here** on any assistant message |
| Title / rename | Partial | Inline rename + auto-title after first reply |
| Compress context | Backend compaction events | **Compact now** control + visible “memory compressed” banner |
| Stop tools / cancel | Partial | Global **Stop** during stream; cancel subagents |
| Background task | Partial (queue exists) | **Run in background** + task tray |
| Queue while busy | **Exists** (`queue-store`) | Polish: reorder, edit, clear queue pills |
| Steer mid-run | Missing / weak | **Add instruction** without killing the turn |
| Status / usage | Partial | Per-session token ring + cost estimate always visible |

### 2.2 Model & reasoning

| CLI capability | Status | UI target |
|----------------|--------|-----------|
| Switch model mid-session | Partial (pickers) | Composer model chip + fleet roles explained simply |
| Reasoning effort | Partial | **Thinking depth** slider: Off / Normal / Deep |
| Show / hide reasoning | Partial | Toggle “Show thinking” on thread |
| Provider fallback | Backend strong | UI badge when fallback fired |

### 2.3 Plan → approve → execute (coding loop)

| CLI capability | Status | UI target |
|----------------|--------|-----------|
| Plan mode | Backend strong | First-class **Plan mode** toggle in composer (not buried) |
| Submit plan | Exists | Plan card in chat: steps, risks, Approve / Edit / Reject |
| Guard modes (`plan` / `ask` / `full`) | Exists | Three clear modes: *Suggest only* / *Ask me* / *Do it* |
| Todo / task list mid-task | Weak | Live **To-do panel** tied to plan + agent updates |
| Diff preview before write | Weak | Diff viewer for file tools before apply (ask mode) |
| Apply / reject patch | Weak | Accept / Reject per file change |

### 2.4 Permissions & safety

| CLI capability | Status | UI target |
|----------------|--------|-----------|
| Allow once / session / always | Partial | Permission toast with those three choices |
| Path-scoped allowlists | Partial | Workspace roots UI + “why blocked” |
| YOLO / bypass | Risky | **Power user only**, behind Settings + confirm |
| Secret redaction | Partial | Always-on for logs; status in settings |
| Sandbox shell | Weak | Optional **Safe shell** (allowlisted commands) for beginners |

### 2.5 Isolation, checkpoints, rollback

| CLI capability | Status | UI target |
|----------------|--------|-----------|
| Git worktrees for parallel agents | Missing | **Isolate changes** toggle when spawning subagents |
| Filesystem checkpoints | Missing | Auto snapshot before mutating tools; **Restore** chip |
| Rollback history | **Exists** (settings) | Surface **Undo last change** in chat, not only Settings |
| Git branch / commit / PR | Partial API | Workspace panel: branch, commit message draft, open PR |

### 2.6 Parallel agents

| CLI capability | Status | UI target |
|----------------|--------|-----------|
| Subagents | Exists | Subagent cards with status, logs, cancel |
| Parallel workers | Partial | **Team view**: grid of worker cards |
| Worktree-isolated workers | Missing | Default isolate when “Parallel agents” on |
| Kanban / durable board | Weak | Simple **Tasks** board for multi-agent jobs |
| Depth caps | Exists | Show “can’t spawn more” in plain language |

### 2.7 Project context

| CLI capability | Status | UI target |
|----------------|--------|-----------|
| Project instructions (`CLAUDE.md` / `AGENTS.md` / `AUG.md`) | Partial | On open workspace: detect + **Use project rules** |
| Multi-root / walk-up | Weak | Clear “rules from: path” badge |
| Init project file | Partial (`InitAugCard`) | Guided wizard: create `AUG.md` |
| .gitignore-aware tools | Partial | Settings: respect gitignore (default on) |

### 2.8 Tools surface (parity with toolsets)

| CLI toolset | August today | UI target |
|-------------|--------------|-----------|
| Files | Yes | Diff + preview cards |
| Terminal | Yes | Embedded terminal panel + approval |
| Web / fetch | Yes | Source cards with links |
| Browser | Yes | Screenshot + a11y tree panel |
| Memory | Strong | Memory side panel (“what August remembers”) |
| Skills | Strong | Skills picker in composer `@skill` |
| MCP | Yes | Integrations catalog (in progress) |
| Code execution sandbox | Weak | **Run Python** safe cell (optional) |
| Image / vision | Partial | Paste image → attach always works |
| Voice | Live path exists | Keep Live as voice mode; link from chat |

### 2.9 Connectors (beginner-critical)

| Capability | Status | UI target |
|------------|--------|-----------|
| Sign in with Google | Connected (BYO OAuth) | Later: **one-click** public OAuth + PKCE |
| GitHub | Token | OAuth or clear PAT wizard |
| Slack | Bot token | Wizard with scopes checklist |
| MCP install | Improving | One-click recipes + env forms (started) |
| Doctor / health | Partial | **Setup checklist** on first run |

### 2.10 Automations & durability

| Capability | Status | UI target |
|------------|--------|-----------|
| Cron / scheduled jobs | Partial | Automations UI with human schedules |
| Webhooks | Weak | Optional advanced Integrations |
| Background review / skills curator | Backend strong | Brain / Learning tabs (exists) — simplify copy |
| Notify on complete | Weak | Toast + optional OS notification |

### 2.11 Observability (August strength — keep)

| Capability | Status | UI target |
|------------|--------|-----------|
| Usage / cost | Exists | Session + global |
| Feature flow | Exists | Keep power; hide under Advanced |
| Request inspector | Exists | Deep link from failed tool |
| Audit / rollback | Exists | Link from “Undo” |

---

## 3. Current baseline (already built — do not re-invent)

Treat these as foundations to **surface and polish**, not rebuild:

- Workbench turn loop, SSE stream, compaction events  
- Guard modes + plan submit / approve / reject  
- Mid-stream **message queue** (`queue-store`, backend queue)  
- Subagents + approval cards  
- Terminal service + approvals  
- Memory stack, skills, curator, background review  
- Integrations directory + Google OAuth callback  
- Rollback history API + Settings UI  
- Live voice surface  
- Model fleet (cognitive roles)  
- Context ring / token UI pieces  

**Main gap:** many capabilities live in backend or buried settings; the **chat surface does not expose them like a modern harness**.

---

## 4. UX architecture (beginner-friendly shell)

### 4.1 Primary layout (chat-first)

```
┌─────────────────────────────────────────────────────────────┐
│  Workspace · Session · Model · Mode (Plan/Ask/Do) · Status  │
├──────────────────┬──────────────────────────┬───────────────┤
│  Sessions        │  Chat thread             │  Context      │
│  (list/search)   │  + tool cards            │  - Project    │
│                  │  + plan / todos          │  - Memory     │
│                  │  + queue / steer          │  - Files diff │
│                  │  + permission toasts     │  - Agents     │
│                  │                          │  - Terminal   │
├──────────────────┴──────────────────────────┴───────────────┤
│  Composer: [attach] [skills] [mode] [model]  [Send] [Stop]  │
│  Command palette: Ctrl+K  ·  Slash: /                        │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Progressive disclosure

| Tier | Who | What shows by default |
|------|-----|------------------------|
| **Essential** | Everyone | Chat, mode, model, stop, undo, plan approve, permissions |
| **Coding** | When workspace open | Diffs, terminal, todos, checkpoints, git strip |
| **Power** | Opt-in Advanced | Feature flow, raw tool JSON, YOLO, fleet roles, MCP env |

### 4.3 Command palette (CLI slash → UI)

Map slash verbs to palette actions (same discoverability, no terminal):

| Action id | Label (UI) | Backend |
|-----------|------------|---------|
| `session.new` | New chat | create session |
| `session.undo` | Undo last turn | truncate last user+assistant |
| `session.branch` | Branch from here | clone session from message id |
| `session.compact` | Free up memory | force compaction |
| `session.stop` | Stop August | abort stream + tools |
| `mode.plan` | Plan only | `guardMode=plan` |
| `mode.ask` | Ask before changes | `guardMode=ask` |
| `mode.full` | Make changes | `guardMode=full` |
| `model.pick` | Change model | session model |
| `checkpoint.restore` | Restore earlier files | checkpoint API |
| `skills.browse` | Skills | open skills picker |
| `integrations.open` | Connect apps | Integrations |
| `help.setup` | Setup checklist | first-run doctor |

---

## 5. Gaps-only roadmap (active plan)

> **Do not rebuild** plan mode, todos, post-turn diffs, queue, stop, git panel, drawers, provider onboarding.  
> **Do:** surface what exists, then fill true gaps only.

### Six workstreams

```text
W1 Discoverability ──► W2 Session ops ──► W3 Trust gates
         │                    │                  │
         └────────────────────┼──────────────────┘
                              ▼
                    W4 Isolation (checkpoints + worktrees)
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
     W5 Connectors (later)            W6 Polish / stretch
```

| ID | Name | Effort | Depends |
|----|------|--------|---------|
| **W1** | Discoverability polish | ~1 week | — |
| **W2** | Session power (undo / branch / compact / steer / palette) | ~1.5 weeks | W1 helpful |
| **W3** | Trust gates (permission toasts + pre-apply diffs) | ~1.5–2 weeks | W1 |
| **W4** | Isolation (FS checkpoints + worktrees + team strip) | ~2 weeks | W3 ideal |
| **W5** | Connectors one-click | ~1–2 weeks | independent; can wait |
| **W6** | Stretch | backlog | after W2–W4 |

---

### W1 — Discoverability polish (~1 week)

**Problem:** Features exist but beginners don’t find them.

| # | Work | Touch |
|---|------|--------|
| W1.1 | Plain-language labels for Plan / Ask / Do (tooltips, one line each) | Composer mode selector |
| W1.2 | Empty chat: “How August works” — Plan → Approve → Do, open Tasks/Diff drawers | Chat empty state |
| W1.3 | After first plan: pulse/hint on right-drawer Plan + Tasks | `RightDrawerLauncher` |
| W1.4 | After file edits: ensure `ChangedFilesCard` always shows; “Open all diffs” → drawer | `makeStreamHandlers` / card |
| W1.5 | Extend setup beyond provider keys: workspace folder + optional Connect Google | Onboarding / checklist |
| W1.6 | Humanize top errors (port busy, MCP dead, OAuth) | Toasts / error map |

**DoD:** New user finds Mode, Plan banner, Todos, Diffs, Stop, Queue without reading docs.  
**Not in scope:** New plan/diff engines.

---

### W2 — Session power tools (~1.5 weeks)

**Problem:** CLI users expect undo / branch / compact / steer; August has queue + auto-compact only.

| # | Work | Backend | Frontend |
|---|------|---------|----------|
| W2.1 | **Undo last turn** | Truncate last user+assistant (+ tool trail) | Thread menu + palette |
| W2.2 | **Branch from here** | Clone session from message id | Message overflow “Branch chat” |
| W2.3 | **Compact now** | Force compaction API (reuse auto path) | Context ring click / palette |
| W2.4 | **Steer** mid-run | Inject instruction at next tool boundary (distinct from queue-as-user-turn if needed) | Streaming: “Add direction…” |
| W2.5 | Queue polish | — | Clear-all; optional reorder |
| W2.6 | **Palette actions** | Wire to W2.1–2.3 + existing mode/stop/new | Extend `CommandPalette.tsx` |

**DoD:** Palette can: New chat, Stop, Undo turn, Branch, Compact now, set Plan/Ask/Do.  
**Reuse:** `queue-store`, auto-compact, existing sessions API.

---

### W3 — Trust gates (~1.5–2 weeks)

**Problem:** Guard modes are coarse; diffs are post-hoc; no Once/Session/Always.

| # | Work | Backend | Frontend |
|---|------|---------|----------|
| W3.1 | Permission grant store: once / session / always(path) | Extend `permissions.py` + workbench guard | **Permission toast** on blocked/mutating tool |
| W3.2 | Pre-apply file preview in **Ask** mode | Tool executor holds write until approved; emit pending patch | Accept / Reject per file card |
| W3.3 | Link “Always for this folder” to workspace roots | Allowlist update | Toast + Settings sync |
| W3.4 | Terminal keep existing approve; align copy with toast model | — | Consistency only |

**DoD:** In Ask mode, user can reject a file write before disk change; allow-once doesn’t re-prompt same tool same turn.  
**Reuse:** `DiffView`, guard modes, terminal approve patterns.

---

### W4 — Isolation (~2 weeks)

**Problem:** Parallel agents can collide; Settings rollback isn’t a chat “save point.”

| # | Work | Backend | Frontend |
|---|------|---------|----------|
| W4.1 | **Checkpoint service** — snapshot touched files before mutating batch | New service under `services/` | Chat chip “Save point created” |
| W4.2 | **Restore checkpoint** | Restore API | Chat + palette “Restore save point”; link Settings `RollbackHistory` |
| W4.3 | **Worktree** per subagent (opt-in toggle) | `worktree_service` + orchestrator cwd | Spawn UI: “Keep files separate” |
| W4.4 | **Team strip** — list active subagents, status, cancel | Status API on orchestrator | Compact strip under titlebar / drawer |
| W4.5 | Git strip already exists — polish only | — | Dirty count + open `GitPanel` |

**DoD:** User restores files after a bad turn; two agents can run isolated with worktree on.  
**Not in scope:** Full Hermes kanban board (W6).

---

### W5 — Connectors later (~1–2 weeks, can defer)

| # | Work | Notes |
|---|------|--------|
| W5.1 | One-click Google (public OAuth client + PKCE) | Product/legal: ship public client id only |
| W5.2 | GitHub/Slack connection wizards | PAT/bot already work; reduce friction |
| W5.3 | Skills `@` browse in composer | Wire existing skills list; no hub required |

**DoD:** Optional; BYO Google already works for power users.

---

### W6 — Stretch (backlog)

| Item | When |
|------|------|
| Durable multi-agent task board | After W4 team strip |
| Sandbox Python run cell | If users need notebook-like exec |
| Automations templates (“every morning…”) | Polish `Automations.tsx` |
| Skills hub (URL install) | Ecosystem phase |
| Extra messaging platforms | Only if product goal |
| Safe-shell beginner profile | If terminal scares users |

---

## 6. PR DAG (gaps only)

```text
W1 ──┬──► W2 ──► (optional W5)
     └──► W3 ──► W4 ──► W6
```

| Stream | Can ship alone? |
|--------|-----------------|
| W1 polish | Yes — pure UX |
| W2 session ops | Yes — high user value |
| W3 trust | Yes — safety story |
| W4 isolation | Best after W3 |
| W5 OAuth | Anytime; no dep on W2–W4 |

**Suggested first ship:** **W1 + W2.1/W2.6** (discoverability + undo + palette) — maximum “feels finished” with least new infrastructure.

---

## 7. Backend only where required

| Gap | New vs extend |
|-----|----------------|
| Undo / branch / compact now / steer | **Extend** `workbench` sessions + stream |
| Permission once/session/always | **Extend** `permissions` + tool guard |
| Pre-apply patches | **Extend** `tool_executor` / file tools |
| Checkpoints | **New** `checkpoint_service` |
| Worktrees | **New** `worktree_service` + subagent cwd |
| Public Google OAuth | **Extend** `service_connections` (later) |

No new plan engine, todo engine, git panel, or queue system.

---

## 8. Frontend only where required

| Gap | Primary files |
|-----|----------------|
| Polish / empty states | `ChatThread`, `ChatComposer`, empty states |
| Palette | **Extend** `CommandPalette.tsx` (already exists) |
| Permission toast | New small host in `ChatLayout` / shell |
| Pre-apply cards | Reuse `DiffView` / `ChangedFilesCard` patterns |
| Checkpoint chip | Chat thread + palette |
| Team strip | Titlebar or right drawer Agents |
| Steer UI | Composer while `streaming` |

Do **not** create parallel Plan/Todo/Diff UIs — extend drawers + banners.

---

## 9. Beginner copy (keep)

| Power term | UI label |
|------------|----------|
| guardMode=plan | **Plan only — don’t change files yet** |
| guardMode=ask | **Ask me before changes** |
| guardMode=full | **Make changes for me** |
| compaction | **Free up chat memory** |
| worktree | **Keep this agent’s files separate** |
| checkpoint | **Save point** / **Restore save point** |
| steer | **Add a direction** (while August is working) |

---

## 10. Success metrics (gaps-focused)

| Metric | Target |
|--------|--------|
| User finds Plan/Tasks/Diff without help | W1 done |
| “How do I undo?” support noise | Near zero after W2.1 |
| Pre-apply reject used | &gt; 0 after W3 |
| Checkpoint restore used | &gt; 0 after W4 |
| Two agents, no collision (worktree on) | Demo script passes |

---

## 11. Non-goals (unchanged)

- Coding **CLI/TUI** product  
- Rebuilding plan/todo/diff/queue  
- Shipping personal OAuth secrets in the binary  
- Hermes-scale messaging day one  

---

## 12. Execute when ready

**Recommended first PR batch (W1 + thin W2):**

1. Empty-state + mode tooltips (W1.1–W1.3)  
2. Palette: Undo last turn + Compact now + mode shortcuts (W2.1, W2.3, W2.6)  
3. Message menu: Branch chat (W2.2) if API is small  

Then W3 (trust), then W4 (isolation). W5 only when you want consumer Google.

### Shipped: W1 + thin W2 (2026-07-15)

| Item | Status |
|------|--------|
| Beginner mode labels (Plan only / Ask before changes / Make changes) | Done |
| Empty chat “How August works” | Done |
| Drawer section hints (Plan / Tasks / Diffs…) | Done |
| Palette: undo, branch, compact, modes, open panels | Done |
| Backend `POST …/undo-last-turn` | Done |
| Backend `POST …/branch` | Done |
| Backend `POST …/compact` | Done |
| ChatThread handlers for palette actions | Done |
| Unit tests `test_workbench_session_ops.py` | Done |

### Shipped: W3 trust gates (2026-07-15)

| Item | Status |
|------|--------|
| Ask mode creates `pendingMutations` + preview | Done |
| Grants: once / session / always (workspace durable) | Done |
| Status API flat fields for ApprovalBanner | Done |
| Banner: Deny · Approve once · This chat · Always here | Done |
| Approve continues the agent turn automatically | Done |
| Preserve `awaiting_approval` at end of turn | Done |
| Tests `test_workbench_ask_grants.py` | Done |

### Shipped: W4 isolation (2026-07-15)

| Item | Status |
|------|--------|
| Checkpoint service (snapshot/restore under `data/checkpoints/`) | Done |
| Auto save point before mutating tools | Done |
| SSE `checkpoint` + inline chat notice | Done |
| API list/restore checkpoints | Done |
| Palette “Restore last save point” | Done |
| Team strip + isolate-subagents toggle | Done |
| Git worktree helper for sub-agents (best-effort) | Done |
| Tests `test_checkpoint_service.py` | Done |

### Shipped: W5 Google one-click / PKCE (2026-07-15)

| Item | Status |
|------|--------|
| PKCE S256 on native Google auth URL | Done |
| Token exchange without client secret (Desktop public client) | Done |
| UI: paste Client ID → Save & Sign in | Done |
| Secret optional on Workspace MCP install form | Done |
| `AUGUST_DEFAULT_GOOGLE_OAUTH_CLIENT_ID` hook for ship-time public id | Done |
| Tests: PKCE URL + callback without secret | Done |

### Shipped: Mid-run steer (2026-07-15)

| Item | Status |
|------|--------|
| Queue `kind=steer` with priority prepend | Done |
| Stronger STEER prompt wrapper for the model | Done |
| `POST /api/workbench/chat/steer` | Done |
| UI: “Add direction” while streaming + Direction pills | Done |
| Tests `test_workbench_steer.py` | Done |

**Still open:** queue reorder UI, true pre-apply hold-before-write (execute-in-place); product registration of a public Desktop OAuth client for zero-paste one-click.

---

## 13. Map: old phases → workstreams

| Old phase (retired) | Now |
|---------------------|-----|
| Phase 0 reliability/setup | W1.5–W1.6 (+ keep dev hygiene) |
| Phase 1 “build coding loop” | **Mostly done** → W1 polish + W3 pre-apply only |
| Phase 2 session power | **W2** |
| Phase 3 isolation | **W4** |
| Phase 4 connectors | **W5** |
| Phase 5–6 polish/stretch | **W6** |

---

*Document status: gaps-only roadmap. Inventory §§2–4 kept as reference; execute via §5 workstreams.*

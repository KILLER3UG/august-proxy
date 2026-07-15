# August UI Harness Parity Plan

> **Goal:** Make the **August desktop UI** (beginner-friendly workbench) deliver *every capability* a modern coding CLI/TUI harness provides — without shipping a coding CLI/TUI.  
> **Audience:** Beginners first; power features discoverable, never required.  
> **Out of scope:** A dedicated `august` terminal TUI, Claude Code clone CLI, or replacing the multi-provider proxy role.  
> **Related:** [cognitive-architecture-v1.md](./cognitive-architecture-v1.md), [tracker-v4.md](./tracker-v4.md), comparison notes from harness gap analysis.

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

## 5. Phased delivery plan

### Phase 0 — Foundations & reliability (1–2 weeks)

**Why:** Nothing else matters if the app is flaky for beginners.

| # | Work | Outcome |
|---|------|---------|
| 0.1 | Single-backend ownership in desktop/dev (clear port, no zombie fights) | `npm run dev` reliable |
| 0.2 | First-run **Setup checklist** (API key, workspace, Google optional) | Zero “where do I start?” |
| 0.3 | Session reliability: resume, pin, rename, delete, empty states | Sessions feel solid |
| 0.4 | Global **Stop** + clear streaming states | User always in control |
| 0.5 | Error humanization (MCP not running, OAuth, port busy) | Plain-language fixes |

**DoD:** New user can open August, set a key, pick a folder, chat, stop, resume — without docs.

---

### Phase 1 — Coding loop in the chat UI (2–3 weeks)

**Why:** This is what CLI harnesses are *for*.

| # | Work | Outcome |
|---|------|---------|
| 1.1 | Composer **Mode** control: Plan / Ask / Do (maps guard modes) | Visible, not buried |
| 1.2 | Plan cards: steps, Approve / Edit / Reject | Plan mode complete in UI |
| 1.3 | Live **To-do** panel driven by plan + agent tool updates | Progress visibility |
| 1.4 | File change **diff cards** (before apply in Ask; after in Do) | Trust for edits |
| 1.5 | Accept / Reject per file | Surgical control |
| 1.6 | Permission toast: Once / This chat / Always for this folder | Claude-like approvals |
| 1.7 | Project rules badge + `AUG.md` wizard polish | Project context obvious |

**DoD:** User can plan a feature, approve, watch todos, review diffs, accept files — all in chat.

**Key surfaces**

- Frontend: `ChatComposer.tsx`, `ChatThread.tsx`, new `PlanCard`, `DiffCard`, `PermissionToast`, `TodoPanel`  
- Backend: workbench plan APIs, tool_executor emit richer file-diff events, permissions API

---

### Phase 2 — Session power tools (CLI parity without CLI) (2 weeks)

| # | Work | Outcome |
|---|------|---------|
| 2.1 | **Undo last turn** | Fix mistakes safely |
| 2.2 | **Branch chat** from any message | Explore alternatives |
| 2.3 | **Compact now** + compaction banner | Context control |
| 2.4 | Polish **queue** (edit/remove/reorder) | Already half-built |
| 2.5 | **Steer**: inject guidance mid-stream | Don’t cancel the run |
| 2.6 | Command palette `Ctrl+K` + `/` menu | Slash parity |
| 2.7 | Session usage strip (tokens, cost, model) | Always-on status |

**DoD:** Power-user session ops available as buttons/palette; beginners never blocked.

---

### Phase 3 — Isolation, checkpoints, parallel agents (2–3 weeks)

| # | Work | Outcome |
|---|------|---------|
| 3.1 | Filesystem **checkpoints** before mutating batches | Rollback files |
| 3.2 | Chat **Restore checkpoint** chip + Settings history link | Undo changes without git expertise |
| 3.3 | Subagent **isolation** via git worktree (optional toggle) | Parallel without collisions |
| 3.4 | **Team / workers** panel (status, cancel, open log) | Multi-agent visible |
| 3.5 | Simple **Tasks** board for multi-agent jobs | Durable coordination |
| 3.6 | Git strip: branch name, dirty files, suggest commit | Coding workflow |

**DoD:** User can run 2 agents on one repo safely and restore if something goes wrong.

**Key surfaces**

- Backend: checkpoint service, worktree manager, subagent_orchestrator hooks  
- Frontend: `WorkspacePanel`, agents section, chat chips

---

### Phase 4 — Connectors & “just works” integrations (2 weeks + ongoing)

| # | Work | Outcome |
|---|------|---------|
| 4.1 | Integrations empty-state wizards (GitHub/Slack) | Fewer dead ends |
| 4.2 | MCP install recipes + required env forms | Already started |
| 4.3 | Google **one-click OAuth** (public client + PKCE) | No BYO secrets for most users |
| 4.4 | Connection health + re-auth buttons | Self-serve fix |
| 4.5 | Skills picker `@` in composer | Skills as easy as attachments |

**DoD:** Connect Google/GitHub without reading docs; tools appear after connect.

---

### Phase 5 — Automations, notifications, polish (1–2 weeks)

| # | Work | Outcome |
|---|------|---------|
| 5.1 | Automations UI: “Every morning, summarize inbox” templates | Cron without cron syntax |
| 5.2 | Background job tray + complete notifications | Long tasks |
| 5.3 | Safe shell profile for beginners | Less foot-guns |
| 5.4 | Accessibility, onboarding tips, empty states pass | Beginner-ready |
| 5.5 | Hide advanced observability behind Advanced | Less overwhelm |

---

### Phase 6 — Optional stretch (post-parity)

| Item | Note |
|------|------|
| Sandbox Python run cell | Hermes `code_execution` parity |
| Extra gateways (WhatsApp, etc.) | Only if messaging is a product goal |
| Skills hub (URL install) | Ecosystem, not core loop |
| Mobile parity for plan/diff/permissions | After desktop solid |

---

## 6. Suggested PR / workstream DAG

```text
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3
                │                      │
                └──────► Phase 4 ◄─────┘
                              │
                              ▼
                          Phase 5
```

| PR stream | Depends on | Can parallelize with |
|-----------|------------|----------------------|
| P0 reliability + setup checklist | — | — |
| P1 mode + plan + diffs + permissions | P0 | — |
| P2 session ops + palette + steer | P0 | late P1 |
| P3 checkpoints + worktrees + team UI | P1 | P4 |
| P4 connectors / OAuth one-click | P0 | P2–P3 |
| P5 automations + polish | P1–P2 | — |

---

## 7. Backend capabilities to add (UI-blocking)

| Service | New / extend | Used by UI |
|---------|--------------|------------|
| `workbench` | Force compact; undo turn; branch session; steer inject | Phase 2 |
| `tool_executor` | Structured `file_diff` events; pre-apply preview | Phase 1 |
| `permissions` | once / session / always grants | Phase 1 |
| **checkpoint_service** (new) | snapshot/restore workspace paths | Phase 3 |
| **worktree_service** (new) | create/remove agent worktrees | Phase 3 |
| `subagent_orchestrator` | isolation flag, team status API | Phase 3 |
| `service_connections` | public OAuth / PKCE | Phase 4 |
| `automations_store` | templates + human schedules | Phase 5 |

---

## 8. Frontend surfaces to own

| Area | Files / modules (likely) |
|------|---------------------------|
| Chat core | `sections/chat/*`, `chat-runtime.ts`, `chat-stream-manager.ts` |
| Composer / palette | `ChatComposer.tsx`, new `CommandPalette.tsx` |
| Plans / todos | new cards + `PlansSection` reuse |
| Diffs | new `DiffCard.tsx`, Workspace panel |
| Permissions | toast host in chat shell |
| Sessions | session store + list UI |
| Agents team | `Agents.tsx`, `SubagentApprovalCard.tsx` |
| Integrations | `settings/Integrations*` (extend) |
| Checkpoints | chat chip + link `RollbackHistory` |
| Settings IA | Essential vs Advanced split |

---

## 9. Beginner-friendly copy (examples)

| Power term | UI label |
|------------|----------|
| guardMode=plan | **Plan only — don’t change files yet** |
| guardMode=ask | **Ask me before changes** |
| guardMode=full | **Make changes for me** |
| compaction | **Free up chat memory** |
| worktree | **Keep this agent’s files separate** |
| YOLO | **Skip safety checks (not recommended)** |
| checkpoint | **Save point** / **Restore save point** |

---

## 10. Success metrics

| Metric | Target |
|--------|--------|
| Time-to-first-successful coding task (new user) | &lt; 10 minutes with checklist |
| % of plan-mode sessions that reach Approve | Track; improve with clearer plan cards |
| Permission denials that become “Always allow” | Low confusion / re-prompt rate |
| Checkpoint restores used successfully | &gt; 0 in real usage (feature discovered) |
| Support issues: “how do I undo?” | Near zero after Phase 2–3 |
| Users who never open Advanced still complete tasks | Primary success |

---

## 11. Explicit non-goals

- Building a coding **CLI/TUI** product  
- Matching Hermes’s 15+ messaging platforms day one  
- Replacing Claude Code as a terminal IDE agent  
- Shipping your personal Google OAuth secret in the binary  
- Exposing every backend debug surface on the home screen  

---

## 12. Immediate next step (when you say “execute”)

Start **Phase 0 + Phase 1 skeleton** in one thin vertical:

1. Composer Mode toggle (Plan / Ask / Do) wired to existing `guardMode`  
2. Plan card polish in the thread  
3. Setup checklist empty state  
4. Diff event plumbing design (even if UI is stub)

That proves “coding harness in the UI” without waiting for worktrees or one-click Google.

---

## 13. Summary map of “everything suggested earlier”

| Earlier recommendation | Phase |
|------------------------|-------|
| Stable dev / reliability | 0 |
| Permissions + safe defaults | 1 |
| Project rules discovery | 1 |
| Session resume / branch | 0–2 |
| Git worktree isolation | 3 |
| Filesystem checkpoints | 3 |
| Steer / queue mid-turn | 2 (queue polish + steer) |
| Public Google OAuth one-click | 4 |
| CLI features **in UI** (palette, not TUI) | 2 |
| Skills hub / extra platforms | 6 stretch |
| Multi-agent team UX | 3 |
| Automations / cron UX | 5 |
| Observability keep + hide advanced | 5 |
| Memory / brain (already strong) | polish only |

---

*Document status: plan only — no implementation until you approve execution order.*

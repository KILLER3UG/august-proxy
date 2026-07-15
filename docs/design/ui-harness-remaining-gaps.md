# August UI harness — remaining gaps

> **As of:** 2026-07-15  
> **Context:** Core W1–W5 coding-loop work is shipped on `master` (`0894457`). This file lists what is **still missing or only partial** vs a full modern harness (Claude / Codex / Hermes-class UI), not what already works.  
> **Related:** [ui-harness-parity-plan.md](./ui-harness-parity-plan.md)

---

## 0. Snapshot

| Layer | Rough completeness | Notes |
|-------|-------------------|--------|
| Coding loop (modes, plan, queue, stop, tools UI) | **High** | Solid product surface |
| Trust (Ask grants, pre-apply Accept/Reject) | **High** | Execute-on-accept shipped; not full multi-file patch UX |
| Session power (undo / branch / compact / steer) | **High** | Wired; polish remains |
| Isolation (checkpoints, worktrees, team strip) | **Medium–high** | Best-effort worktrees; not “never collide by default” |
| Connectors (Google, GitHub, Slack) | **Medium** | Google BYO + PKCE; no shipped public client id |
| Stretch (kanban, sandbox cell, wizards) | **Low** | Explicit backlog |

**Not 100%.** Core loop ≈ 85–90% of prioritized gaps; full inventory ≈ 60–70%.

---

## 1. Product / ops (not pure code)

| Gap | Why it matters | Suggested path |
|-----|----------------|----------------|
| **True zero-paste Google Sign-in** | Users still paste Client ID unless env provides one | Register a **public Desktop OAuth client** (PKCE, no secret). Set `AUGUST_DEFAULT_GOOGLE_OAUTH_CLIENT_ID` at ship time (release channel / installer env). Do **not** commit secrets. |
| Google Cloud app verification / test users | Testing mode limits who can sign in | Document test-user setup; long-term verification for production |

---

## 2. Trust & diffs (polish beyond P0)

| Gap | Current | Target |
|-----|---------|--------|
| **Multi-file pre-apply patch UI** | One pending mutation + preview text; Accept runs that tool | Per-file cards with unified/split **diff**, Accept/Reject each path in a batch |
| **Permission toast** (Claude-style) | Session `ApprovalBanner` + grants | Lightweight toast near tool card: Once / This chat / Always here, same grant store |
| Path-scoped allowlist UX | “Always” key by tool+path | Settings UI listing always-grants; revoke; explain “why blocked” |
| Terminal vs workbench permission copy | Separate approve flows | One mental model / shared wording |

---

## 3. Queue & mid-run control

| Gap | Current | Target |
|-----|---------|--------|
| Queue **reorder** | FIFO pills, cancel, steer prepend | Drag reorder, edit pill text, clear-all polish |
| Steer discoverability | Works when streaming | Always-visible “Add direction…” while tools run; short empty-state tip |
| Run in background + task tray | Queue only | Optional background job list / tray |

---

## 4. Isolation & multi-agent

| Gap | Current | Target |
|-----|---------|--------|
| Worktree **product maturity** | Helper + opt-in isolate for subagents | Default isolate for parallel agents; clear badge “files stay separate”; cleanup when agent ends |
| Team strip depth | List + cancel hooks | Live status, logs link, cancel-all, cost per agent |
| Durable **kanban / multi-agent board** | Session todos | Persistent board across agents/jobs (W6) |
| Checkpoint UX density | Create + restore API/palette | Inline “Save point” chips after every mutating batch; one-click restore confirmation |

---

## 5. Connectors & setup

| Gap | Current | Target |
|-----|---------|--------|
| GitHub **OAuth** wizard | PAT form | OAuth or guided PAT with scopes checklist |
| Slack wizard | Bot token | Scopes checklist + test send |
| Setup checklist **doctor** | Provider + workspace + optional Google | Health: backend up, MCP alive, disk, OAuth redirect reachable |
| MCP one-click recipes | Directory improving | Install + env form + “works” smoke test per popular server |

---

## 6. Project context & tools stretch

| Gap | Current | Target |
|-----|---------|--------|
| Project rules badge | AUG.md init exists | “Rules from: path” chip; walk-up CLAUDE/AGENTS/AUG |
| **Sandbox Python cell** | No dedicated safe exec toolset | Optional “Run Python” cell with strict cwd/network policy |
| Image paste reliability | Partial attach paths | Paste image → attach always works in composer |
| Skills hub | `@` picker + Settings skills | Browse/install from hub (optional; not required for CLI parity) |

---

## 7. Session / chrome polish

| Gap | Current | Target |
|-----|---------|--------|
| Pin / search sessions | List + rename | Pin, search, “Continue last” on home |
| Cost always visible | Usage elsewhere | Per-session cost estimate next to context ring |
| Dirty session confirm on New chat | Weak | Confirm if streaming or unsent draft |
| OS notification on long job complete | Weak | Opt-in toast + OS notify |

---

## 8. Automations & durability (W6-adjacent)

| Gap | Notes |
|-----|--------|
| Human-readable cron UX | Automations exist; simplify schedules copy |
| Webhooks | Advanced Integrations only |
| Notify on complete | Productize beyond in-app toast |

---

## 9. Recommended priority (next ships)

Do **not** restart a full roadmap rewrite. Ship in this order unless product forces Google first:

| Priority | Item | Effort signal |
|----------|------|----------------|
| **P0** | Register + ship `AUGUST_DEFAULT_GOOGLE_OAUTH_CLIENT_ID` (release only) | Product/legal + config |
| **P1** | Queue reorder + clear-all polish | Small frontend |
| **P1** | Permission **toast** on tool cards (reuse grant API) | Medium frontend |
| **P2** | Multi-file pre-apply **diff cards** | Medium full-stack |
| **P2** | Setup checklist + backend/MCP **doctor** | Medium |
| **P3** | Worktree default for parallel agents + cleanup | Medium backend |
| **P3** | GitHub/Slack connection wizards | Medium |
| **Backlog** | Kanban board, Python sandbox cell, skills hub, OS notify | Large / optional |

---

## 10. Explicitly **done** (do not re-open as “missing”)

Use this as a stop-list when triaging:

- Guard modes Plan / Ask / Do + plan approve/reject/revise  
- Pre-apply **Accept/Reject** with **execute on accept** (stored args)  
- Tool grants once / session / always (folder)  
- Undo last turn, branch session, compact now, command palette wiring  
- Mid-run **steer** (`kind=steer`, priority inject)  
- Filesystem **checkpoints** + restore API  
- Worktree helper + team agents strip (v1)  
- Real PTY terminal + open external terminal  
- Google OAuth native callback + **PKCE** (Desktop, no secret required)  
- First-run **setup checklist** (provider / workspace / optional Google)  
- Skills **`@`** mention picker in composer  
- Post-turn diffs, todos, git panel, integrations directory (BYO)

---

## 11. How to update this file

When a row ships:

1. Move it to §10 (done) or delete from §§1–8.  
2. Note commit / PR in the parity plan “Shipped” section.  
3. Keep this doc **gaps-only** so it stays short.

When in doubt: if a beginner can complete the task in chat without Settings spelunking, it is no longer a gap.

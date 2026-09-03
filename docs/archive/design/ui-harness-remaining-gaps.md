# August UI harness — remaining gaps

> **As of:** 2026-07-15  
> **Context:** Core W1–W5 coding-loop work is shipped on `master` (`0894457`). This file lists what is **still missing or only partial** vs a full modern harness (Claude / Codex / Hermes-class UI), not what already works.  
> **Related:** [ui-harness-parity-plan.md](./ui-harness-parity-plan.md)

---

## 0. Snapshot

| Layer | Rough completeness | Notes |
|-------|-------------------|--------|
| Coding loop (modes, plan, queue, stop, tools UI) | **High** | Queue reorder / clear-all / edit shipped |
| Trust (Ask grants, pre-apply Accept/Reject) | **High** | Permission toast + multi-file pre-apply cards |
| Session power (undo / branch / compact / steer) | **High** | Wired; polish remains |
| Isolation (checkpoints, worktrees, team strip) | **High** | Default isolate + cleanup for parallel agents |
| Connectors (Google, GitHub, Slack) | **Medium** | Google BYO + PKCE; no shipped public client id |
| Stretch (kanban, sandbox cell, wizards) | **Low** | Explicit backlog |

**Not 100%.** Core loop ≈ 90%+ of prioritized gaps; full inventory ≈ 70–75%.

---

## 1. Product / ops (not pure code)

| Gap | Why it matters | Suggested path |
|-----|----------------|----------------|
| **True zero-paste Google Sign-in** | Users still paste Client ID unless env provides one | Register a **public Desktop OAuth client** (PKCE, no secret). Set `AUGUST_DEFAULT_GOOGLE_OAUTH_CLIENT_ID` at ship time (release channel / installer env). Do **not** commit secrets. |
| Google Cloud app verification / test users | Testing mode limits who can sign in | Document test-user setup; long-term verification for production |

---

## 2–7. Trust / queue / isolation / connectors / context / chrome

Most polish items shipped — see §10. Remaining thin polish:

| Gap | Notes |
|-----|--------|
| MCP install + env form + smoke | Smoke test button shipped; deeper “works” E2E still optional |
| Team cost per agent | Elapsed proxy shown; true $ cost needs billing events per agent |

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
| **Backlog** | Per-agent $ cost, deeper MCP E2E smoke | Optional |

---

## 10. Explicitly **done** (do not re-open as “missing”)

Use this as a stop-list when triaging:

- Guard modes Plan / Ask / Do + plan approve/reject/revise  
- Pre-apply **Accept/Reject** with **execute on accept** (stored args)  
- Tool grants once / session / always (folder)  
- **Permission toast** on tool cards (Once / This chat / Always here)  
- **Multi-file pre-apply diff cards** (per-path Accept/Reject + DiffView)  
- Undo last turn, branch session, compact now, command palette wiring  
- Mid-run **steer** (`kind=steer`, priority inject) + always-visible “Add direction…” while streaming  
- Queue **reorder** (drag), **edit** pill text, **clear-all**  
- Filesystem **checkpoints** + restore API  
- Worktree helper + **default isolate** for parallel agents + cleanup when agent ends + team strip badge  
- Real PTY terminal + open external terminal  
- Google OAuth native callback + **PKCE** (Desktop, no secret required)  
- First-run **setup checklist** (provider / workspace / doctor / optional Google)  
- Setup **doctor** (`GET /api/workbench/doctor`: backend, disk, MCP, OAuth)  
- Skills **`@`** mention picker in composer  
- **Skills hub** browse/install recipes in Settings → Skills  
- **GitHub / Slack connection wizards** (scopes checklist + test / test send)  
- **Path-scoped always-grants** Settings UI (list / revoke / why allowed)  
- **Agent kanban board** (durable, multi-column)  
- **Python sandbox** cell (no network, banned imports, timeout)  
- **OS notify** opt-in (Profile → Job complete notifications)  
- **Background task tray** in status bar  
- Frontend modularization + OOP:
  - **WorkbenchClient** (`api/workbench/WorkbenchClient.ts`) + HTTP primitives
  - **ChatAttachmentService**, **SessionStreamController**, **SessionRepository**
  - Hooks: `useSessionStream`, `useChatModels`, `useChatUsage`, `useChatAttachments`
  - ChatThread split: `MessageBubble`, `ComposerControls`, `ChatCheckpoints`  
- **Continue last**, dirty New chat confirm, session pin/search (existing + continue)  
- **Project rules badge** (AUG/CLAUDE/AGENTS)  
- **Session cost** chip next to context ring  
- **Save point chip** with one-click restore confirm  
- Team strip: cancel one / cancel-all / logs link  
- Image paste → attach in composer  
- MCP directory **smoke test**  
- Shared **permission copy** (Once / This chat / Always here)  
- Post-turn diffs, todos, git panel, integrations directory (BYO)

---

## 11. How to update this file

When a row ships:

1. Move it to §10 (done) or delete from §§1–8.  
2. Note commit / PR in the parity plan “Shipped” section.  
3. Keep this doc **gaps-only** so it stays short.

When in doubt: if a beginner can complete the task in chat without Settings spelunking, it is no longer a gap.

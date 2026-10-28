# August Proxy — documentation

This is the one index. If a document is not listed here, it is either generated
or it was history; the history was removed on 2026-10-29 and remains in git.

## Start here

| Document | Audience | Contents |
|----------|----------|----------|
| [**README.md**](../README.md) | Everyone | What August is, quick start, repo layout |
| [**CONTRIBUTING.md**](../CONTRIBUTING.md) | Contributors | Branches, commits, staging, the local gate, the release flow |
| [**AGENTS.md**](../AGENTS.md) | Agents / contributors | The binding contract: non-negotiables, read-first map, gate commands |
| [**docs/agent/**](agent/README.md) | Agents / contributors | The area guides behind the contract |
| [**PRODUCT.md**](PRODUCT.md) | Everyone | The product goal, users, UX principles, and the memory/skills experience |
| [**STATUS.md**](STATUS.md) | Agents / maintainers | What shipped, what is next, and the open owner decisions |
| [**specs/memory-and-skills.md**](specs/memory-and-skills.md) | Agents / maintainers | The current memory and skills specification, with open UX items |

## Current reference

| Document | Audience | Contents |
|----------|----------|----------|
| [**SETUP.md**](SETUP.md) | All users | Installation (Docker, local, desktop), first run, connecting a client |
| [**CONFIGURATION.md**](CONFIGURATION.md) | Operators | `config.json` / `providers.json` / MCP / `.env` reference |
| [**ARCHITECTURE.md**](ARCHITECTURE.md) | Developers | Request flow, adapters, workbench, brain, gateway, persistence |
| [**ARCHITECTURE_FLOW.md**](ARCHITECTURE_FLOW.md) | Developers | Six diagrams, every box a real file and symbol |
| [**API_REFERENCE.md**](API_REFERENCE.md) | Integrators | HTTP endpoints, request/response shapes, SSE events |
| [**API_INDEX.md**](API_INDEX.md) | Integrators | **Generated** operation index; CI-gated by `check:api-index` |
| [**DEVELOPER_GUIDE.md**](DEVELOPER_GUIDE.md) | Contributors | Dev setup, conventions, extending the codebase |
| [**TROUBLESHOOTING.md**](TROUBLESHOOTING.md) | All users | Common issues and fixes |
| [**LAN_ACCESS.md**](LAN_ACCESS.md) | Operators | Opt-in LAN access and what it changes |
| [**SKILL_AUTHORING.md**](SKILL_AUTHORING.md) | Agents / contributors | SKILL.md format: frontmatter, canonical sections, description-as-trigger |
| [**GAPS_AND_BUGS.md**](GAPS_AND_BUGS.md) | Maintainers | Living ledger: closed fixes and the open/deferred list |
| [**ROADMAP.md**](ROADMAP.md) | Everyone | What was deliberately not done and why, plus the decisions still open |
| [**UPDATE_VERIFICATION.md**](UPDATE_VERIFICATION.md) | Maintainers | The manual matrix for the update flow — the one thing no static gate verifies |

## Agent area guides

The contract is [AGENTS.md](../AGENTS.md); the index is
[docs/agent/](agent/README.md). Read the area file before changing that area.

| Guide | Covers |
|---|---|
| [workflow.md](agent/workflow.md) | Gates, no-test policy, scratch rule, directory routing |
| [product.md](agent/product.md) | Desktop shell, update flow, chat surface, Settings IA |
| [providers.md](agent/providers.md) | Base URLs, wire formats, upstream serialization, pricing |
| [harness.md](agent/harness.md) | Turn loop, budgets, self-correction, subagents, bots, context relief |
| [memory.md](agent/memory.md) | Facts store, recall lanes, write doors, backups, mirror |
| [skills.md](agent/skills.md) | SKILL.md discovery, mutation/undo, learning pipeline, review pass |
| [security.md](agent/security.md) | Sandbox, hardline, listing/shell/write doors, secrets, file ceilings |
| [release.md](agent/release.md) | Version sources, OpenAPI generation, tag flow |

## The system map

[`docs/state/`](state/) is a live product feature: the backend validates these
pages and the app browses them (Docs in the sidebar). It is also the fastest
architectural read in the repo.

| Page | Contents |
|---|---|
| [August system map](state/README.md) | The parts a chat turn touches and which one owns each step |
| [One chat turn](state/chat-turn.md) | The turn lifecycle and the eight named stop reasons |
| [Memory lanes](state/memory-lanes.md) | Profile, delta and recall — and which one is automatic |

## Research and design references

| Path | Contents |
|------|----------|
| [`research/`](research/) | Read-only studies of August and of the reference harnesses (pi, SimulIDE, DeepSeek harness), with citation ledgers |
| [`design/`](design/) | The Signal Desk desktop and mobile mockups — the source of truth for the UI port |

## Active plans

Plans are working documents, not reference. Closed plans, audits and deep dives
were deleted on 2026-10-29; `git log -- docs/plans/<name>` recovers any of them.

| Plan | Status |
|---|---|
| [2026-10-25-goal-environments.md](plans/2026-10-25-goal-environments.md) | Owner goal: the harness as the agent's environment |
| [2026-10-25-self-modification-autonomy.md](plans/2026-10-25-self-modification-autonomy.md) | Phase 0: environment + audit-and-undo autonomy |
| [2026-10-26-signal-desk-ui-port.md](plans/2026-10-26-signal-desk-ui-port.md) | The whole-desktop Signal Desk port |
| [AUGUST-UI-ENHANCEMENTS.md](plans/AUGUST-UI-ENHANCEMENTS.md) | The UI enhancement backlog, merged from the retired audits |
| [2026-10-11-ui-reference-capture.md](plans/2026-10-11-ui-reference-capture.md) | The captured UI reference the port measures against |
| [2026-10-07-google-workspace-classroom-capability.md](plans/2026-10-07-google-workspace-classroom-capability.md) | Proposed; needs an architecture decision |
| [2026-10-07-hermes-august-capability-bridge.md](plans/2026-10-07-hermes-august-capability-bridge.md) | Capability-sharing design and rulings |
| [2026-10-07-plugin-discovery-and-credential-storage.md](plans/2026-10-07-plugin-discovery-and-credential-storage.md) | Proposed; plugin discovery + credential storage |

## Generated

| Path | Source | Gate |
|---|---|---|
| [`api/openapi.json`](api/openapi.json) | The running app (`npm run gen:openapi`) | `check:api` |
| [`API_INDEX.md`](API_INDEX.md) | The committed spec (`npm run gen:api-index`) | `check:api-index` |
| `frontend/desktop/src/api/gen/openapi.ts` | The committed spec (`npm run gen:api`) | CI type-generation diff |

## How to navigate

| Goal | Start here |
|------|------------|
| Install and run | [SETUP.md](SETUP.md) |
| Know the product goal and UX standard | [PRODUCT.md](PRODUCT.md) |
| Know what to work on next | [STATUS.md](STATUS.md) |
| Configure keys / aliases / gateway | [CONFIGURATION.md](CONFIGURATION.md) |
| Understand request flow & persistence | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Call HTTP APIs | [API_REFERENCE.md](API_REFERENCE.md) |
| Contribute code | [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) and [AGENTS.md](../AGENTS.md) |
| Fix a runtime issue | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| See known mismatches | [GAPS_AND_BUGS.md](GAPS_AND_BUGS.md) |
| Understand memory and skills | [specs/memory-and-skills.md](specs/memory-and-skills.md) |

**Backend:** Python **3.12+** FastAPI in [`backend-py/`](../backend-py/)
(`requires-python >=3.12`; Docker image `python:3.12-slim`).

**Frontend:** Tauri + React desktop app (`frontend/desktop/`) is the product.
Expo companion: `frontend/mobile/`. `web-dist/` is the Vite artifact packaged
into the installer — not a separate web app.

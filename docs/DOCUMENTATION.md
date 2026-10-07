# August Proxy — Documentation

## Current documentation

| Document | Audience | Contents |
|----------|----------|----------|
| [**README.md**](../README.md) | Everyone | Project overview, highlights, repo layout, quick start |
| [**AGENTS.md**](../AGENTS.md) | Agents / contributors | Desktop is the product; harness, per-model `apiFormat`, version files |
| [**SETUP.md**](SETUP.md) | All users | Installation (Docker, local, desktop), first-run, connecting a client |
| [**CONFIGURATION.md**](CONFIGURATION.md) | Operators | `config.json` / `providers.json` / MCP / `.env` reference |
| [**ARCHITECTURE.md**](ARCHITECTURE.md) | Developers | Request flow, adapters, workbench, brain, gateway, data persistence |
| [**API_REFERENCE.md**](API_REFERENCE.md) | Integrators | HTTP endpoints, request/response shapes, SSE events |
| [**DEVELOPER_GUIDE.md**](DEVELOPER_GUIDE.md) | Contributors | Dev setup, tests, conventions, extending the codebase |
| [**TROUBLESHOOTING.md**](TROUBLESHOOTING.md) | All users | Common issues and fixes |
| [**GAPS_AND_BUGS.md**](GAPS_AND_BUGS.md) | Maintainers | Closed ledger + the open/deferred list |
| [**CHANGELOG.md**](../CHANGELOG.md) | Everyone | Release history (root file) |
| [**settings-audit.md**](settings-audit.md) | UI contributors | **Superseded** 2026-08-28 Settings IA — registry is SoT |

### Verification matrices

| Document | Contents |
|----------|----------|
| [**FEATURE_INVENTORY_TEST_MATRIX.md**](FEATURE_INVENTORY_TEST_MATRIX.md) | Phase 7 inventory → coverage map (closed, still the coverage index) |
| [**AUDIT_RECOMMENDATIONS_2026-08-11.md**](AUDIT_RECOMMENDATIONS_2026-08-11.md) | **Superseded** by `audit-2026-08/` + `research/` |
| [`audit-2026-08/`](audit-2026-08/) | 12-agent August audit sweep — per-area findings, most **not** dispositioned |
| [**HARNESS-FINDINGS-2026-09-15.md**](HARNESS-FINDINGS-2026-09-15.md) | Harness findings, same-day implementation status |
| [**CHAT_UI_DEEP_DIVE_2026-08-23.md**](CHAT_UI_DEEP_DIVE_2026-08-23.md) | Chat UI inventory |
| [**API_INDEX.md**](API_INDEX.md) | **Generated** operation index over `api/openapi.json`; CI-gated by `check:api-index`, so it cannot drift silently — the one to read for "what exists" |
| [**HARNESS_ENHANCEMENTS_2026-09-27.md**](HARNESS_ENHANCEMENTS_2026-09-27.md) | Harness hardening round: runaway backstop, gate-participation audit, coverage ratchet — all 14 items landed |
| [**AUDIT_REPORT_2026-10-01.md**](AUDIT_REPORT_2026-10-01.md) | Most recent full-repo audit |

<!-- UI-SCAN-2026-09-16.md was removed 2026-10-07 rather than indexed: 6 of its 8 items
     were fixed by research/august-frontend-ui-audit.md, which supersedes it, and its
     evidence directory is gone so nothing in it is re-verifiable. -->
| [**CIRCUIT_SIMULATION_RESEARCH.md**](CIRCUIT_SIMULATION_RESEARCH.md) | Circuit / EDA feature research and `[implemented]` notes |

### Design research (current)

| Document | Contents |
|----------|----------|
| [`research/`](research/) | 2026-09-24/25 read-only audits of August itself (backend harness, frontend UI, lifecycle, sub-agent output). The freshest analysis in the tree — and it already supersedes `settings-audit.md` |

### Refactor program (closed — archaeology)

The multi-session refactor is **signed off**. These files remain as history and
sign-off evidence; do not treat them as the product feature list.

| Document | Contents |
|----------|----------|
| [**REFACTOR_PROGRESS.md**](REFACTOR_PROGRESS.md) | Closed tracker — phases, bug ledger, residual debt |
| [**REFACTOR_HANDOFF_PROMPT.md**](REFACTOR_HANDOFF_PROMPT.md) | Historical handoff prompt |
| [**FEATURE_INVENTORY_TEST_MATRIX.md**](FEATURE_INVENTORY_TEST_MATRIX.md) | Phase 7 inventory → coverage map |
| [**PHASE4_SQLITE_SCHEMA_RENAME_PLAN.md**](archive/PHASE4_SQLITE_SCHEMA_RENAME_PLAN.md) | Schema rename — **CLOSED** |
| [**PHASE_PERF_AND_FLEXIBILITY_PLAN.md**](archive/PHASE_PERF_AND_FLEXIBILITY_PLAN.md) | Phase P — **CLOSED** |
| [**PHASE8_FINAL_DELIVERABLES.md**](archive/PHASE8_FINAL_DELIVERABLES.md) | Final deliverables + sign-off |

### Product history (not current how-to)

| Path | Contents |
|------|----------|
| [`archive/`](archive/) | Shipped / superseded plans and design notes — `archive/README.md` states the policy. Do not restore as active plans |
| [`archive/design/`](archive/design/) | Cognitive architecture and UI harness design notes |
| [`archive/superpowers-plans/`](archive/superpowers-plans/) | June–July 2026 implementation plans |
| [`plans/`](plans/) | Dated design dossiers (Parts 15–27). Most are **implemented** and tagged as provenance; read the tag before acting on one |
| [`superpowers/`](superpowers/) | June–July 2026 feature specs — all point-in-time snapshots |
| [`releases/`](releases/) | Release notes by version. **Archaeology only** — nothing reads this tree; `/api/whats-new` uses GitHub Releases and falls back to root `CHANGELOG.md`. Covers 0.12.21–0.13.0; 53 later tags have no notes |
| [**SETTINGS_UX_REDESIGN.md**](SETTINGS_UX_REDESIGN.md) | Superseded 2026-08 redesign roadmap |
| [**plan-cross-map-2026-09-01.md**](plan-cross-map-2026-09-01.md) | The 2026-09-01 map of the plans tree — its own file inventory is out of date |
| [**CHANGES_AUDIT_PASS_2026-08.md**](CHANGES_AUDIT_PASS_2026-08.md) | Change record of the 0.12.55 audit pass |
| [**REFACTOR_HANDOFF_PROMPT.md**](REFACTOR_HANDOFF_PROMPT.md) · [**REFACTOR_PROGRESS.md**](REFACTOR_PROGRESS.md) | Closed refactor program |

---

## How to navigate

| Goal | Start here |
|------|------------|
| Install and run | [SETUP.md](SETUP.md) |
| Configure keys / aliases / gateway | [CONFIGURATION.md](CONFIGURATION.md) |
| Understand request flow & persistence | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Call HTTP APIs | [API_REFERENCE.md](API_REFERENCE.md) |
| Contribute code / tests | [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) |
| Fix a runtime issue | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| See known mismatches | [GAPS_AND_BUGS.md](GAPS_AND_BUGS.md) |

**Backend:** Python **3.12+** FastAPI in [`backend-py/`](../backend-py/)
(`requires-python >=3.12`; Docker image `python:3.12-slim`).

**Frontend:** Tauri + React desktop app (`frontend/desktop/`) is the product.
Expo companion: `frontend/mobile/`. `web-dist/` is the Vite artifact packaged
into the installer — not a separate web app.

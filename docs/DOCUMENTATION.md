# August Proxy — Documentation

## Current documentation

| Document | Audience | Contents |
|----------|----------|----------|
| [**README.md**](../README.md) | Everyone | Project overview, highlights, repo layout, quick start |
| [**SETUP.md**](SETUP.md) | All users | Installation (Docker, local, desktop), first-run, connecting a client |
| [**CONFIGURATION.md**](CONFIGURATION.md) | Operators | `config.json` / `providers.json` / MCP / `.env` reference |
| [**ARCHITECTURE.md**](ARCHITECTURE.md) | Developers | Request flow, adapters, workbench, brain, gateway, data persistence |
| [**API_REFERENCE.md**](API_REFERENCE.md) | Integrators | HTTP endpoints, request/response shapes, SSE events |
| [**DEVELOPER_GUIDE.md**](DEVELOPER_GUIDE.md) | Contributors | Dev setup, tests, conventions, extending the codebase |
| [**TROUBLESHOOTING.md**](TROUBLESHOOTING.md) | All users | Common issues and fixes |
| [**GAPS_AND_BUGS.md**](GAPS_AND_BUGS.md) | Maintainers | Known bugs and documentation/code gaps (living list) |
| [**settings-audit.md**](settings-audit.md) | UI contributors | Settings IA categories and section migration notes |

### Refactor program (closed — archaeology)

The multi-session refactor is **signed off**. These files remain as history and
sign-off evidence; do not treat them as the product feature list.

| Document | Contents |
|----------|----------|
| [**REFACTOR_PROGRESS.md**](REFACTOR_PROGRESS.md) | Closed tracker — phases, bug ledger, residual debt |
| [**REFACTOR_HANDOFF_PROMPT.md**](REFACTOR_HANDOFF_PROMPT.md) | Historical handoff prompt |
| [**FEATURE_INVENTORY_TEST_MATRIX.md**](FEATURE_INVENTORY_TEST_MATRIX.md) | Phase 7 inventory → coverage map |
| [**PHASE4_SQLITE_SCHEMA_RENAME_PLAN.md**](PHASE4_SQLITE_SCHEMA_RENAME_PLAN.md) | Schema rename — **CLOSED** |
| [**PHASE_PERF_AND_FLEXIBILITY_PLAN.md**](PHASE_PERF_AND_FLEXIBILITY_PLAN.md) | Phase P — **CLOSED** |
| [**PHASE8_FINAL_DELIVERABLES.md**](PHASE8_FINAL_DELIVERABLES.md) | Final deliverables + sign-off |

### Product history (not current how-to)

| Path | Contents |
|------|----------|
| [`design/`](design/) | Cognitive architecture and UI harness design notes |
| [`releases/`](releases/) | Release notes by version |
| [`superpowers/`](superpowers/) | Historical feature plans and specs |

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

**Frontend:** Tauri + React desktop SPA (`frontend/desktop/`); Expo mobile
companion (`frontend/mobile/`); production build served from `web-dist/`.

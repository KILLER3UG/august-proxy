# Gaps and bugs

Living list. Prefer fixing code first, then ticking items off here.

---

## Closed (2026-07-15)

| Item | Resolution |
|------|------------|
| Docs vs code drift | Primary docs rewritten (SETUP/ARCHITECTURE/API/CONFIGURATION/…) |
| Health dual registration | Single SoT in `main.py` |
| Provider **templates** | **Removed** — users configure providers fully; `/templates` returns `[]` |
| Discord/Slack optional SDKs | `.[gateway]` extra + `/api/gateway/status` platforms + Settings UI card |
| Live STT/TTS 501 UX | `sttReady`/`ttsReady` + factories only use server when ready |
| Thinking on non-Claude models | Conservative `supports_thinking()` + tests |
| API path inventory false positives | Fixed `_list_api_paths.py` (0 unmatched) |
| Secrets under `data/` | Already gitignored |

---

## Open / deferred

### Dual naming (Python params vs camelCase wire) — **DEFERRED by design**

| Layer | Convention |
|-------|------------|
| HTTP JSON / path params | **camelCase** (stable frontend contract) |
| SQLite | **snake_case** |
| New Python service APIs | Prefer **snake_case** params |
| Legacy Python params | Mixed; mass rename is high-risk |

A bulk camel→snake param rewrite was attempted and **reverted** after ~125
test failures (incomplete body renames + path/param mismatches). Fixing this
requires a purpose-built codemod (AST-aware, skip string keys / path templates),
not a regex pass.

### Mobile companion docs — partial

### Optional: expand gateway platform UI beyond System Health

---

Update this file when items close.

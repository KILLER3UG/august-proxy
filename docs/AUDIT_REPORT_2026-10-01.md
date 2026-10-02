<!--
  ARCHIVED, AND DO NOT WORK FROM IT.

  This report is kept only so its claims can be checked against the code. The
  triage in docs/AUDIT_REPORT_REVIEW_2026-10-01.md verified every citation and
  found roughly two thirds of the claims FALSE, most often by reading a line
  without its neighbours. Its own headline finding — "no authentication
  whatsoever", Critical — is refuted by the TrustedOriginGuard wired in
  app/main.py. Severity was inflated throughout, which is what buried the
  small number of real defects.

  Read the review first. If you are here because a tool pointed you at this
  file, that is exactly the failure mode it describes.
-->

# August Proxy — Full Repository Audit Report

**Date:** 2026-10-01
**Scope:** 334 Python files + 662 TypeScript/React files
**Method:** 6 parallel deep-scan subagents covering backend core, models/providers/adapters, services (root), services (subdirectories), routers, and frontend

---

## Executive Summary

| Category | Count | Highest Severity |
|----------|-------|------------------|
| Security Vulnerabilities | 18 | Critical |
| Logic Bugs | 22 | Critical |
| Race Conditions | 10 | High |
| Resource Leaks | 12 | High |
| Performance Issues | 12 | Medium |
| Missing Error Handling | 10 | Medium |
| Code Smells | 18 | Low |
| Enhancement Opportunities | 28 | Info |
| **Total** | **120** | |

**Most urgent finding:** The vast majority of `/api/*` endpoints have **no authentication whatsoever**. Any local process or browser tab can call endpoints that control the desktop, read/write files, run commands, delete data, and make unauthorized model calls.

---

## P0 — Critical Security Vulnerabilities (Fix Immediately)

### 1. Missing Authentication on Most API Endpoints
**Files:** All routers except `proxy.py` and `models.py` (partially)
**Impact:** Any local process or browser tab can call:
- `POST /api/august/settings/update` — modify any config
- `POST /api/august/memory/manage` — read/write/delete all memories
- `POST /api/privacy/purge-memories` — erase all user data
- `POST /api/privacy/delete-sessions` — delete all sessions
- `POST /api/terminal/command` — run arbitrary commands
- `POST /api/desktop-automation/action` — control the desktop
- `POST /api/git/checkout` / `commit` / `push` — operate git
- `POST /api/mcp/servers` — register MCP servers (arbitrary command execution)
- `POST /api/workbench/sandbox/python` — run Python code
- `POST /api/subagents/spawn` — spawn sub-agents
- `POST /api/hooks/trust-workspace` — trust arbitrary workspace for shell execution

The `local_api_guard.py` origin gate is mentioned in comments but is not enforced at the router level — it only protects against remote web pages, not local processes.
**Recommendation:** Add a local API key or session token authentication middleware.

### 2. Sandbox Escape via `_SAFE_EXPAND_ENV`
**File:** `backend-py/app/services/sandbox/paths.py:14-30`
**Issue:** The whitelist includes `SYSTEMROOT`, `WINDIR`, `PROGRAMFILES`, `PROGRAMFILES(X86)`, `PUBLIC`, `APPDATA`, `LOCALAPPDATA`. These are expanded to their real values before containment checks. A command like `cp $APPDATA/../../sensitive/file.txt workspace/` would expand to a real path outside the workspace.
**Recommendation:** Restrict env var expansion or validate resolved paths.

### 3. Path Traversal in `_expand_safe_env`
**File:** `backend-py/app/services/sandbox/paths.py:34-49`
**Issue:** Expands `$VAR`/`${VAR}`/`%VAR%` for a whitelist of env vars. If an env var like `HOME` or `USERPROFILE` contains a path with `..` sequences, the expanded value is used directly in path resolution. The expansion happens BEFORE containment checks.
**Recommendation:** Expand after containment checks or reject paths with `..` after expansion.

### 4. Terminal Service Command Injection
**File:** `backend-py/app/services/workbench/terminal_service.py:29-46`
**Issue:** `DANGEROUS_PATTERNS` is a denylist approach — trivially bypassable (e.g., `rm -rf / `, `rm -rf  /`, `rm -rf $HOME`, `rm -rf ../../../`, `find / -delete`, `> /dev/sda` with different spacing). The terminal service runs commands with the user's full privileges.
**Recommendation:** Replace denylist with allowlist or use proper command parsing.

### 5. Egress Proxy DNS Rebinding
**File:** `backend-py/app/services/sandbox/egress.py:56-64`
**Issue:** The `_is_allowed` method checks the hostname against an allowlist, but the actual connection in `_relay_connect` (line 118) uses `asyncio.open_connection(host, port)` which performs its own DNS resolution. A DNS rebinding attack could pass the check with a public IP, then the connection could resolve to a private IP.
**Recommendation:** Resolve DNS first, check the resolved IP, then connect to the resolved IP.

### 6. API Key Exfiltration via Open Redirect
**File:** `backend-py/app/services/quota_endpoint.py:282`
**Issue:** `httpx.AsyncClient(..., follow_redirects=True)` — if a quota endpoint URL is changed (via config) to an attacker-controlled server, or if the provider's server is compromised and returns a 302, the `Authorization: Bearer <api_key>` header is forwarded to the redirect target.
**Recommendation:** Set `follow_redirects=False`.

### 7. Remote Code Execution via Malicious GitHub Plugin
**File:** `backend-py/app/services/integration_tools.py:229-234`
**Issue:** `installMcpServer(source=...)` passes the source to `plugin_installer.install_from_github()` without validating the GitHub owner/repo. An attacker who can call this tool (via prompt injection) can install arbitrary code.
**Recommendation:** Validate that `source` matches `^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$` and is not a known malicious repo.

### 8. Google OAuth Tokens Stored in Plaintext
**File:** `backend-py/app/services/service_connections.py:940-961`
**Issue:** `accessToken` and `refreshToken` are stored in `config.json` in plaintext. The file is written with `write_json_atomic` but no encryption.
**Recommendation:** Use the existing `app.lib.secrets` module to encrypt tokens before storing in config.json.

### 9. XSS via Incomplete Escaping
**File:** `frontend/desktop/src/lib/bot-avatar.ts:154, 165-167`
**Issue:** `escapeAttr` only escapes `&`, `"`, and `<` — missing `>` and `'`. An attacker-controlled name containing `>` or `'` could break out of the SVG attribute context.
**Recommendation:** Add `.replace(/>/g, '&gt;').replace(/'/g, '&#39;')`.

### 10. PDF.js Worker Loaded from CDN
**File:** `frontend/desktop/src/lib/file-reader.ts:160`
**Issue:** PDF.js worker is loaded from `https://unpkg.com/...` — a MITM attack could inject malicious code into the worker.
**Recommendation:** Bundle the worker locally.

### 11. MCP Server Registration → Arbitrary Command Execution
**Files:** `backend-py/app/routers/mcp.py:75-105`, `backend-py/app/routers/august.py:941-988`
**Issue:** `POST /api/mcp/servers` accepts arbitrary `command`, `args`, and `env` which are passed to `mcp_client.registerServer`. The `august.py` `/tools/manage` endpoint (line 972) defaults to `command = str(cfg.get('command') or 'true')` — arbitrary command execution.
**Recommendation:** Limit to a whitelist of permitted executables.

### 12. Gateway Pairing Code Brute Force
**File:** `backend-py/app/services/gateway/pairing.py:178-198`
**Issue:** The lockout is per-platform (not per-user), and after 5 failed attempts the lockout is 1 hour. An attacker who knows a valid pairing code format (8 chars from 32-char alphabet = ~1.1 trillion combinations) could brute force within the 1-hour window if they can make many requests.
**Recommendation:** Add rate limiting on the `approve` endpoint; make lockout per-user.

---

## P1 — Critical Logic Bugs (Fix This Week)

### 13. `id()` Based Cache Invalidation is Unreliable
**File:** `backend-py/app/providers/model_params.py:140`
**Issue:** `stamp = id(raw) if isinstance(raw, dict) else 0` — if the settings dict is garbage collected and a new dict is allocated at the same memory address, the cache returns stale results indefinitely.
**Recommendation:** Use a monotonic counter or a proper version number from the settings object.

### 14. Non-Boolean Stream Flag
**Files:** `backend-py/app/adapters/anthropic.py:718`, `backend-py/app/adapters/openai.py:453`
**Issue:** `body.get('stream', False)` can return a non-boolean value (e.g., string `"false"`, integer `1`). A string `"false"` is truthy in Python, causing the proxy to attempt streaming when the client didn't request it.
**Recommendation:** `bool(body.get('stream', False))`

### 15. Module-Level `asyncio.Lock()` Created at Import Time
**File:** `backend-py/app/adapters/openai.py:636-637`
**Issue:** `asyncio.Lock()` created at import time binds to the current event loop. If the application uses multiple event loops (e.g., in tests or with `asyncio.run()`), this causes `RuntimeError: Task got Future attached to a different loop`.
**Recommendation:** Create the lock lazily inside `_getClient()`.

### 16. Timeout Applied to Entire SSE Stream
**File:** `backend-py/app/providers/clients/base.py:601`
**Issue:** `self.timeout` (default 300s) is applied to the entire stream duration. For long-running SSE streams, this means the stream is killed after 300s regardless of activity.
**Recommendation:** Use a per-chunk timeout or a separate read timeout for streaming.

### 17. `finish_job` Dirty Parameter Logic Broken
**File:** `backend-py/app/services/harness_jobs.py:148`
**Issue:** The docstring says `dirty=None` means "keep the stored value", but the code does `1 if dirty else 0` which converts `None` → `0`. A cancelled job always has its `dirty` flag cleared, erasing the "worker mutated the environment" receipt.

### 18. Task Reported as Fired Even When DB Update Fails
**File:** `backend-py/app/services/recurring_tasks.py:220-230`
**Issue:** `fired.append((message, ...))` is outside the `try/except` block. If the `UPDATE` fails, the task is still reported as fired to the caller, but `last_fired_at` is never updated. The task will fire again on the next call — duplicate notifications.

### 19. `wait_for_message` Returns Already-Consumed Messages
**File:** `backend-py/app/services/agent_message_bus.py:104`
**Issue:** Returns `q[-1]` (last queued message) without tracking consumption. A second call with no new messages returns the same message again.

### 20. `id(conn)` Reuse Causes Cross-Connection Commit Corruption
**File:** `backend-py/app/services/deferred_writes.py:105-107`
**Issue:** Uses `id(conn)` as dict key. Python reuses IDs after GC. If conn A is GC'd and conn B gets the same id, conn B's commits are deferred using conn A's timer.
**Recommendation:** Use `weakref.ref(conn)` instead of `id(conn)`.

### 21. New Event Loop Created in Async Context
**File:** `backend-py/app/services/memory_store/consolidation.py:80-84`
**Issue:** `loop = asyncio.new_event_loop()` inside a potentially running event loop will raise `RuntimeError: This event loop is already running`.

### 22. Security Hook Timeout Fails Open
**File:** `backend-py/app/services/hooks/registry.py:156-179`
**Issue:** For PRE_TOOL_USE hooks (security guards), a timeout fails OPEN, meaning a broken security guard silently allows the action. The `secret_guard` hook at priority 10 could time out and allow a credential write.

### 23. `workspacePath` User-Controlled → Read Entire System
**File:** `backend-py/app/routers/exam.py:59-78`
**Issue:** When `ws_root` is set, files inside the workspace are accepted. But `ws_root` comes from `body.get('workspacePath')` — user-controlled. A user could set `workspacePath` to `/` and read any file on the system.

### 24. Sandbox Python `__builtins__` Escape
**File:** `backend-py/app/routers/workbench.py:1580-1594`
**Issue:** The sandbox runner does `safe_builtins[n] = getattr(__builtins__, n)` but the `exec` environment still has `__builtins__` available. A determined escape is possible via `().__class__.__base__.__subclasses__()`.

### 25. `generateGatewayApiKey` Writes to `.env` Without Restrictions
**File:** `backend-py/app/routers/config.py:652-711`
**Issue:** The key is written to `.env` in the project root. If the project root is a shared repo, the key could be committed.

### 26. `bind_path` Double Call → TOCTOU
**File:** `backend-py/app/routers/security.py:215-229`
**Issue:** `bind_path` is called twice — once for the probe, once for the actual root. This is wasteful and could lead to TOCTOU issues if the filesystem changes between calls.

### 27. Limit Calculation Logic Error
**File:** `backend-py/app/services/quota_endpoint.py:237-238`
**Issue:** `limit = remaining + used if used is not None else None` — when `limit is None and remaining is not None and used is None`, this sets `limit = remaining + None` which would raise `TypeError`.

### 28. No-Op Ternary Expression
**File:** `backend-py/app/services/feature_flow.py:96`
**Issue:** `'feature': feature if feature in _FEATURE_IDS else feature` — both branches return `feature`. Dead code.

### 29. Redundant Condition in `removeSessionLocally`
**File:** `frontend/desktop/src/store/sessions.ts:379-431`
**Issue:** Line 383 checks `!sess && !sessions.some(...)` — if `sess` is null, the `some` check is redundant.

### 30. Listener Accumulation in Stream Reconnect
**File:** `frontend/desktop/src/api/workbench/stream.ts:291`
**Issue:** Each call to `streamWorkbenchReconnect` adds an abort listener to the signal. If the signal is long-lived and the function is called multiple times, listeners accumulate.

### 31. Overly Broad Substring Matching in Tool Icon
**File:** `frontend/desktop/src/lib/tool-icon.ts:291-319`
**Issue:** The substring heuristic can misclassify tools. For example, `run_command` contains `run` which could match unintended entries.

### 32. Naive Past Tense Derivation
**File:** `frontend/desktop/src/lib/tool-labels.ts:283-299`
**Issue:** The `derivePastTense` function uses simple rules that fail for irregular verbs (e.g., "Wrote" → "Writed", "Broke" → "Breaked").

### 33. Browser Compatibility (Safari < 16.4)
**File:** `frontend/desktop/src/lib/artifacts.ts:29`
**Issue:** The `BARE_LINK_RE` uses a negative lookbehind `(?<![(\\]))` which is not supported in Safari < 16.4.

---

## P2 — High Severity

### Race Conditions

| # | File | Line | Issue |
|---|------|------|-------|
| 34 | `bot_mode/dm.py` | 128-138 | `has_inflight` check-then-act → ping-pong loop |
| 35 | `workbench/sessions.py` | 14-30 | `_begin_txn` check-then-act race |
| 36 | `daemon_manager.py` | 434-458 | Daemon info dict read after potential removal |
| 37 | `kanban_store.py` | 87-94 | `_load` reads disk on every call, no cache invalidation on external write |
| 38 | `recurring_tasks.py` | 191-230 | `check_and_fire` TOCTOU race |
| 39 | `agents.py` | 336-381 | Job recording race condition |
| 40 | `preview.py` | 23-24, 58-69 | `_pending` dict without lock |
| 41 | `providers/model_params.py` | 120-121 | Module-level mutable state without lock |
| 42 | `providers/clients/__init__.py` | 21-22 | `threading.Lock` used in async context |
| 43 | `useLogStream.ts` | 178-190 | Stale socket on remount |

### Resource Leaks

| # | File | Line | Issue |
|---|------|------|-------|
| 44 | `main.py` | 198, 217 | `asyncio.create_task()` reference not stored → GC risk |
| 45 | `browser/session_manager.py` | 101-106 | Console logs never cleared |
| 46 | `tools/mcp_client.py` | 31 | `_mcpCleanupTasks` set grows unbounded |
| 47 | `health_monitor.py` | 173-199 | Probe loop task never cancelled on shutdown |
| 48 | `skill_distiller.py` | 352-375 | Unpooled client not closed on exception |
| 49 | `daemon_manager.py` | 383-393 | `shutdown` doesn't clear `_tasks` before gather |
| 50 | `workbench.py` | 28-29 | `_chatTasks`/`_cancelled` grow unbounded |
| 51 | `preview.py` | 24 | `_pending` never pruned |
| 52 | `subagent.py` | 432 | `_pendingProposals` grows unbounded |
| 53 | `theme.ts` | 108-120 | `matchMedia` listener never removed |
| 54 | `verbose-mode.ts` | 10 | `verboseSessions` grows unbounded |
| 55 | `google-account-signin.ts` | 83-138 | Listener/interval never cleaned up |

### Performance Issues

| # | File | Line | Issue |
|---|------|------|-------|
| 56 | `model_service.py` | 286-341 | Sequential provider model fetching (5 providers × 5s = 25s worst case) |
| 57 | `tools/agent_registry.py` | 123-136 | O(n^d) tree building — 100 agents × depth 4 = 100M operations |
| 58 | `providers/model_resolver.py` | 60-67 | Creates full client just to check credentials |
| 59 | `providers/resolver.py` | 97-105 | Same |
| 60 | `providers/route_resolver.py` | 27-34 | Same |
| 61 | `adapters/anthropic.py` | 519 | Recursive `camelToSnake` on every request |
| 62 | `adapters/openai.py` | 268 | Same |
| 63 | `providers/clients/base.py` | 222-242 | Character-by-character token estimation |
| 64 | `episode_miner.py` | — | Full table scan without composite index |
| 65 | `skill_service.py` | — | `list_all()` loads all skills into memory |
| 66 | `useLiveBackendAction.ts` | 48-52 | 2-second `setInterval` triggers re-render |
| 67 | `gateway.ts` | 68 | 5-second polling interval never cleared |

### Missing Error Handling

| # | File | Line | Issue |
|---|------|------|-------|
| 68 | `main.py` | 218, 241 | Critical component exceptions silently swallowed |
| 69 | `audit.py` | 85-86, 108-109 | SQL errors silently swallowed |
| 70 | `model_service.py` | 321 | Bare `except Exception: pass` |
| 71 | `harness_jobs.py` | 29-41 | Doesn't handle missing table |
| 72 | `recurring_tasks.py` | 64-69 | Same |
| 73 | `workstreams.py` | 124-138 | Same |
| 74 | `client.ts` | 121-164 | Network errors not caught |
| 75 | `client.ts` | 168-175 | `requestRaw` has no error body parsing |
| 76 | `gateway_auth.py` | 54-57, 73-79 | All exceptions swallowed, returns `False`/`None` |
| 77 | `storage_key_migration.py` | 70-77 | SQL not wrapped in try-except |

---

## P3 — Medium Severity

### Code Smells

| # | File | Issue |
|---|------|-------|
| 78 | `august.py` | `ActionBody` has 20+ optional fields ("god object") |
| 79 | `august.py` | `manage_memory` is 160+ lines |
| 80 | `workbench.py` | 2615 lines in one file |
| 81 | `providers.py` | 1295 lines in one file |
| 82 | `config.py:145-172` | `_redactSecrets` regex may miss variants like `auth_token`, `private_key` |
| 83 | `cognitive_config.py` | Duplicated fleet merge logic |
| 84 | `config_service.py:55` | Shallow copy doesn't protect nested dicts → cache poisoning |
| 85 | `memory_schema.py` | Excessive comments indicate fragile code |
| 86 | `daemon_manager.py:565` | MD5 inconsistent with rest of codebase using SHA-256 |
| 87 | `adapters/anthropic.py:84-97` | Pointless back-compat aliases |
| 88 | `adapters/openai.py:51-55` | Same |
| 89 | `adapters/proxy_tools.py:174-175` | No-op `_record_tool_failure` |
| 90 | `adapters/proxy_tool_defs.py:43-45` | Stub function that always returns empty |
| 91 | `providers/model_resolver.py:46` | `input` parameter shadows built-in |
| 92 | `sandbox/egress.py:93-96` | Magic number 16 |
| 93 | `tools/fpga_tools.py:55-71` | `_workspace()` copy-pasted across tool modules |
| 94 | `workbench/emit_types.py` | camelCase and snake_case mixed |
| 95 | `browser/session_manager.py:22-24` | Hardcoded User-Agent |

### Additional Security Observations

| # | File | Line | Issue |
|---|------|------|-------|
| 96 | `memory_store/wire.py` | 12-16 | `_q()` manual SQL quoting — bypassable with Unicode lookalikes |
| 97 | `browser.py` | 48-65 | Screenshot endpoint symlink resolution bypass |
| 98 | `workbench.py` | 707-892 | `/files/read` can read files from any workspace or temp dir |
| 99 | `privacy.py` | 90-95, 144-151, 174-183 | SQL table name interpolation (currently safe but fragile) |
| 100 | `tool_registrations/file_tools.py` | 52-109 | Command allowlist overly permissive (`bash`, `sh`, `pwsh` without argument restrictions) |
| 101 | `gateway/platforms/telegram.py` | 60-69 | Error message may leak internal URL/token |
| 102 | `gateway/platforms/telegram.py` | 77 | New `httpx.AsyncClient` on every `connect()` — leaks old client |
| 103 | `gateway/platforms/slack.py` | 84 | `auth_test()` has no timeout |
| 104 | `automations.py` | 297 | Token comparison not constant-time (`!=` instead of `hmac.compare_digest`) |
| 105 | `live.py` | 222-232 | Audio size not limited → OOM risk |
| 106 | `providers.py` | 261 | Loads 10,000 usage events into memory |
| 107 | `workbench/validator.py` | 42-53 | Error message includes `argsRaw[:200]` which could contain sensitive data |
| 108 | `hooks/blast_radius.py` | 71-96 | Synchronous file I/O reads 2000 files |
| 109 | `gateway/base.py` | 87 | `_pending` queue has no size limit |
| 110 | `tool_registrations/session_tools.py` | 102-115 | `_deriveFactKey` has no length limit on input |
| 111 | `workbench/loop/exec.py` | 88-97 | `asyncio.CancelledError` not caught — cancellation propagates without recording |
| 112 | `workbench/pty_io.py` | 88-98 | `_buffer` queue not cleared on `close()` |
| 113 | `tools/mcp_client.py` | 33 | `MCP_TIMEOUT_MS = 30000` is a module-level constant, not per-server configurable |
| 114 | `workbench/shadow_git.py` | 43-54 | `_REPO_LOCKS` grows unbounded |
| 115 | `workbench/prompt_build.py` | 29-31 | Cache eviction is O(n) on every insert once full |
| 116 | `workbench/tool_result_cache.py` | 38-46 | First loop is dead code; second loop clears all entries for session |
| 117 | `service_connections.py` | — | `_oauth_pending` dict grows unbounded, no cleanup timer |
| 118 | `kanban_store.py` | — | `pendingCreates` Map grows forever if promises never resolve |
| 119 | `circuit-artifacts.ts` | 66-67 | `jsonCache` capped at 128 but never cleared except when full |
| 120 | `useAppUpdate.ts` | 103-119 | State update after unmount — `invoke` not cancellable |

---

## Enhancement Opportunities

| # | File | Enhancement |
|---|------|-------------|
| 1 | All routers | Add authentication middleware |
| 2 | All routers | Add rate limiting (model-calling endpoints) |
| 3 | All routers | Add request validation (Pydantic models) |
| 4 | All routers | Add audit logging |
| 5 | All routers | Add pagination |
| 6 | `providers/model_params.py` | Replace `id()` with monotonic counter |
| 7 | `adapters/anthropic.py` | Coerce stream flag to `bool()` |
| 8 | `adapters/openai.py` | Same |
| 9 | `providers/clients/base.py` | Add per-chunk timeout for SSE streams |
| 10 | `adapters/anthropic.py` | Add max round limit to tool loops |
| 11 | `adapters/openai.py` | Same |
| 12 | `providers/clients/__init__.py` | Implement LRU eviction |
| 13 | `adapters/anthropic.py` | Cache `camelToSnake` conversion |
| 14 | `adapters/openai.py` | Same |
| 15 | `providers/clients/base.py` | Use faster token estimation |
| 16 | `agent_message_bus.py` | Add message consumption tracking |
| 17 | `deferred_writes.py` | Use `weakref` instead of `id()` |
| 18 | `model_service.py` | Use `asyncio.gather` for parallel fetching |
| 19 | `health_monitor.py` | Add graceful shutdown hook |
| 20 | `service_connections.py` | Encrypt OAuth tokens at rest |
| 21 | `recurring_tasks.py` | Use atomic `UPDATE ... WHERE last_fired_at = ?` |
| 22 | `kanban_store.py` | Add mtime validation to cache |
| 23 | `quota_endpoint.py` | Disable redirects by default |
| 24 | `integration_tools.py` | Validate GitHub source format |
| 25 | `memory_schema.py` | Simplify FTS rebuild logic |
| 26 | `daemon_manager.py` | Add stale task cleanup |
| 27 | `hooks/registry.py` | Add `/api/hooks/metrics` endpoint |
| 28 | `bot_mode/rooms.py` | Make limits configurable |

---

## Priority Matrix

| Priority | Count | Key Fixes |
|----------|-------|-----------|
| **P0 — Immediate** | 12 | Auth middleware, sandbox escape, command injection, DNS rebinding, API key exfiltration, RCE, OAuth plaintext, XSS, CDN dependency, MCP command execution, pairing brute force, path traversal |
| **P1 — This week** | 20 | `id()` cache, stream flag, module-level Lock, SSE timeout, tool loop limits, `deferred_writes` race, `recurring_tasks` race, `agent_message_bus` duplicate delivery, `harness_jobs` dirty logic, `consolidation` event loop, hooks fail-open, `exam.py` path traversal, sandbox Python escape, `config.py` `.env` write, `security.py` TOCTOU, `quota_endpoint.py` TypeError, `feature_flow.py` dead code, `sessions.ts` redundant condition, `stream.ts` listener accumulation, `tool-icon.ts` broad matching |
| **P2 — Two weeks** | 44 | Resource leaks (12), race conditions (10), performance issues (12), missing error handling (10) |
| **P3 — Iterative** | 44 | Code smells (18), additional security observations (16), enhancement opportunities (28) |

---

## Recommended First Steps

1. **Add authentication middleware** — highest leverage fix, closes entire vulnerability class
2. **Fix sandbox escape** — restrict `_SAFE_EXPAND_ENV` whitelist
3. **Fix terminal command injection** — replace denylist with allowlist
4. **Fix egress DNS rebinding** — resolve before connecting
5. **Disable `follow_redirects`** — one-line fix in `quota_endpoint.py`
6. **Validate GitHub source** — regex check in `integration_tools.py`
7. **Encrypt OAuth tokens** — use `app.lib.secrets` in `service_connections.py`
8. **Fix XSS in bot-avatar** — add missing escape characters
9. **Bundle PDF.js worker** — remove CDN dependency
10. **Restrict MCP commands** — whitelist in `mcp.py`

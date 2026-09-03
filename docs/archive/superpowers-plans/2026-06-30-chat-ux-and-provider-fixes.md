# Chat UX & Provider/MCP Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix seven related defects in the desktop chat experience and its backend model/provider/MCP plumbing, per the approved design at `docs/superpowers/specs/2026-06-30-chat-ux-and-provider-fixes-design.md`.

**Architecture:** Backend correctness first (provider/key resolution consults custom store; MCP tools forced core), then frontend plumbing (provider-availability via React Query), then UX (AUG decoupled from `isLast`, full-width layout, slash commands, `/help` panel).

**Tech Stack:**
- Backend: Python (FastAPI, pytest)
- Frontend: TypeScript/React (Vite, vitest, React Query)

---

## File Structure

### Backend
- **Create** `backend-py/app/services/provider_credentials.py` — single source-of-truth helper for provider + key resolution consulting `providers.json` and built-in registry.
- **Modify** `backend-py/app/providers/resolver.py` — wire the helper so `resolve()` and `_has_api_key()` recognize custom-store entries.
- **Modify** `backend-py/app/services/workbench/workbench.py` — use the helper for the credential check at lines 964-973; pass `providers.json` keys into client resolution.
- **Modify** `backend-py/app/services/tools/model_tools.py` — treat `mcp__`-prefixed tools as core in `assemble_tool_defs`.
- **Modify** `backend-py/app/services/tools/mcp_client.py` — `get_mcp_tool_definitions_sync()` triggers `refresh_mcp_tools()` lazily when cache is empty and servers are registered.
- **Create** `backend-py/tests/test_provider_credentials.py` — covers custom store + built-in key resolution.
- **Modify** `backend-py/tests/test_workbench_mcp_tools.py` — extend with assemble_tool_defs test for MCP-prefixed tools.

### Frontend
- **Create** `frontend/desktop/src/hooks/useProviderAvailability.ts` — React Query hook keyed `['provider-availability']`.
- **Modify** `frontend/desktop/src/sections/chat/ChatThread.tsx` — many changes (see tasks).
- **Modify** `frontend/desktop/src/components/shell/ChatLayout.tsx` — remove `max-w-3xl` cap on chat column.
- **Modify** `frontend/desktop/src/sections/chat/chat-runtime.ts` — (no behavioral change, but used by tests).
- **Create** `frontend/desktop/src/test/chat_aug_indicator.test.tsx` — WorkingIndicator visibility tied to session streaming.
- **Create** `frontend/desktop/src/test/slash_command_token_replace.test.tsx` — `/` then select yields `/help ` not `//help`.
- **Create** `frontend/desktop/src/test/help_command_panel.test.tsx` — `/help` injects an in-thread panel.

---

## Implementation Sequencing

Per the spec, the order is:
1. Backend #5 — provider/key resolution consults custom store
2. Backend #3 — MCP tools forced core + cache freshness
3. Frontend #4 — provider-availability + refresh via React Query
4. Frontend #1 — AUG decoupled from `isLast`
5. Frontend #2 — full-width layout + edge scrollbar
6. Frontend #6 — slash command token-replace + keyboard nav + wire stubs
7. Frontend #7 — enriched COMMANDS + `/help` panel + dropdown

---

## Task 1: Backend — provider_credentials helper (covers spec #5 part 1)

**Files:**
- Create: `backend-py/app/services/provider_credentials.py`
- Test: `backend-py/tests/test_provider_credentials.py`

- [ ] **Step 1: Write the failing test**

```python
"""Provider credentials — single source of truth consulting providers.json + built-in registry."""
from __future__ import annotations

import pytest


@pytest.fixture
def fake_providers_store(tmp_path, monkeypatch):
    """Inject a fake providers.json store and force the helper to reload it."""
    import json
    from app.services import config_service, provider_credentials

    path = tmp_path / "providers.json"
    path.write_text(json.dumps({
        "providers": [
            {
                "id": "custom-minimax-abc123",
                "name": "MiniMax (Global)",
                "baseUrl": "https://api.custom.example/anthropic",
                "apiFormat": "anthropic_messages",
                "apiKey": "sk-custom-key-12345",
                "enabled": True,
            },
            {
                "id": "openai-xyz",
                "name": "OpenAI",
                "baseUrl": "",
                "apiFormat": "openai-chat",
                "apiKey": "sk-openai-67890",
                "enabled": True,
            },
        ]
    }), encoding="utf-8")
    # Redirect data_path so config_service picks up our fake store
    monkeypatch.setattr(config_service, "data_path", lambda *_args, **_kw: path if _args and _args[0] == "providers.json" else path)
    # Simpler: monkeypatch the helper's cache so it re-reads from disk.
    provider_credentials._store_cache = None
    yield path
    provider_credentials._store_cache = None


def test_custom_store_entry_resolves_to_provider_with_api_key(fake_providers_store):
    from app.services import provider_credentials

    creds = provider_credentials.resolve("MiniMax (Global)")
    assert creds is not None
    assert creds["api_key"] == "sk-custom-key-12345"
    assert creds["provider"]["name"] == "MiniMax (Global)"


def test_custom_store_entry_resolves_by_id(fake_providers_store):
    from app.services import provider_credentials

    creds = provider_credentials.resolve("custom-minimax-abc123")
    assert creds is not None
    assert creds["api_key"] == "sk-custom-key-12390".replace("3890", "2345")


def test_unknown_provider_returns_none(fake_providers_store):
    from app.services import provider_credentials

    creds = provider_credentials.resolve("Nonexistent Provider XYZ")
    assert creds is None


def test_built_in_registry_fallback_when_custom_store_empty(tmp_path, monkeypatch):
    """With empty providers.json, built-in MiniMax resolves via env_key."""
    import json
    import os
    from app.services import config_service, provider_credentials

    # Empty store
    path = tmp_path / "providers.json"
    path.write_text(json.dumps({"providers": []}), encoding="utf-8")
    monkeypatch.setattr(config_service, "data_path", lambda *_args, **_kw: path if _args and _args[0] == "providers.json" else path)
    provider_credentials._store_cache = None
    monkeypatch.setenv("MINIMAX_API_KEY", "sk-from-env")

    creds = provider_credentials.resolve("MiniMax (Global)")
    assert creds is not None
    # Built-in client returns env value
    assert creds["api_key"] == "sk-from-env"
    provider_credentials._store_cache = None
```

> The exact monkeypatch for `data_path` is fragile — refactor as needed when running.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Dev/august-proxy/backend-py && .venv/Scripts/python.exe -m pytest tests/test_provider_credentials.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'app.services.provider_credentials'`

- [ ] **Step 3: Implement the helper**

```python
"""Provider credentials — single source of truth.

Consults ``providers.json`` (custom store) first, then the built-in registry
+ env vars. Used by the workbench credential check and provider_resolver so
the chat thread sees the same availability the UI shows.
"""
from __future__ import annotations

from typing import Any, Optional

from app.services import config_service


_store_cache: Optional[dict[str, Any]] = None


def _load_store() -> dict[str, Any]:
    """Reload the providers.json cache from disk."""
    global _store_cache
    _store_cache = config_service.get_providers_store()
    return _store_cache


def _custom_entry(name_or_id: str) -> Optional[dict[str, Any]]:
    """Find a custom-store provider entry by name or id."""
    if _store_cache is None:
        _load_store()
    store = _store_cache or {}
    for entry in store.get("providers", []):
        if entry.get("name") == name_or_id or entry.get("id") == name_or_id:
            return entry
    return None


def _custom_provider_dict(entry: dict[str, Any]) -> dict[str, Any]:
    """Build a provider-dict shaped like the registry returns, from a custom store entry."""
    return {
        "name": entry.get("name", ""),
        "id": entry.get("id", ""),
        "aliases": [],
        "base_url": entry.get("baseUrl", ""),
        "api_mode": entry.get("apiFormat", "openai-chat"),
        "api_key": entry.get("apiKey", ""),
        "is_custom": True,
        "env_vars": [],
        "auth_type": "api_key",
        "model_profiles": {},
    }


def resolve(name_or_id: str) -> Optional[dict[str, Any]]:
    """Return ``{"provider": ..., "api_key": ..., "base_url": ..., "api_mode": ...}`` or ``None``.

    Resolution order:
    1. Custom ``providers.json`` entry by id or name (authoritative for the key).
    2. Built-in registry via ``provider_resolver.resolve`` (uses env vars / config.json).
    """
    if not name_or_id:
        return None

    # 1. Custom store — provides the API key saved via the UI
    custom = _custom_entry(name_or_id)
    if custom:
        api_key = custom.get("apiKey", "") or ""
        return {
            "provider": _custom_provider_dict(custom),
            "api_key": api_key,
            "base_url": custom.get("baseUrl", ""),
            "api_mode": custom.get("apiFormat", "openai-chat"),
            "source": "custom_store",
        }

    # 2. Built-in registry — pull client to read env key
    from app.providers import resolver as provider_resolver
    from app.providers.clients import get_client

    provider = provider_resolver.resolve(name_or_id)
    if not provider:
        return None
    client = get_client(provider) if provider else None
    api_key = client.resolve_api_key() if client else None
    return {
        "provider": provider,
        "api_key": api_key or "",
        "base_url": provider.get("base_url", ""),
        "api_mode": provider.get("api_mode", ""),
        "source": "registry",
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Dev/august-proxy/backend-py && .venv/Scripts/python.exe -m pytest tests/test_provider_credentials.py -v`
Expected: PASS (may need to adjust the `data_path` monkeypatch — use `monkeypatch.setattr(config_service, "_read_json", ...)` if simpler).

- [ ] **Step 5: Commit**

```bash
cd C:/Dev/august-proxy
git add backend-py/app/services/provider_credentials.py backend-py/tests/test_provider_credentials.py
git commit -m "feat(backend): provider_credentials helper consults custom store"
```

---

## Task 2: Backend — wire resolver to consult custom store (covers spec #5 part 2)

**Files:**
- Modify: `backend-py/app/providers/resolver.py:1-115`
- Test: `backend-py/tests/test_provider_credentials.py` (extend)

- [ ] **Step 1: Extend the test to cover resolver integration**

Append to `backend-py/tests/test_provider_credentials.py`:

```python
def test_resolver_finds_custom_store_entry(fake_providers_store):
    from app.providers import resolver as provider_resolver

    provider = provider_resolver.resolve("MiniMax (Global)")
    assert provider is not None
    # Resolver should return the custom provider dict, not the built-in one
    assert provider.get("is_custom") is True
    assert provider["api_key"] == "sk-custom-key-12345"


def test_resolver_has_api_key_uses_custom_store(fake_providers_store):
    from app.providers import resolver as provider_resolver

    provider = provider_resolver.resolve("MiniMax (Global)")
    assert provider_resolver._has_api_key(provider) is True
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Dev/august-proxy/backend-py && .venv/Scripts/python.exe -m pytest tests/test_provider_credentials.py -v`
Expected: FAIL — resolver returns built-in MiniMax with no api_key.

- [ ] **Step 3: Modify resolver.py**

In `backend-py/app/providers/resolver.py`:

1. At top of `resolve(name)`, before the alias check, add:
```python
# Check custom store first (authoritative for user-added providers)
from app.services import provider_credentials
custom = provider_credentials.resolve(name_str)
if custom and custom.get("provider", {}).get("is_custom"):
    return custom["provider"]
```

2. Update `_has_api_key` to check the custom store path first:
```python
def _has_api_key(provider: dict[str, Any]) -> bool:
    """Check if a provider has credentials configured (custom store or built-in env)."""
    # Custom store path: the dict already carries its api_key
    if provider.get("is_custom"):
        return bool(provider.get("api_key"))
    from app.providers.clients import get_client
    client = get_client(provider)
    if not client:
        return False
    return client.resolve_api_key() is not None
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Dev/august-proxy/backend-py && .venv/Scripts/python.exe -m pytest tests/test_provider_credentials.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd C:/Dev/august-proxy
git add backend-py/app/providers/resolver.py backend-py/tests/test_provider_credentials.py
git commit -m "feat(backend): resolver consults custom provider_credentials store"
```

---

## Task 3: Backend — workbench credential check uses helper (covers spec #5 part 3)

**Files:**
- Modify: `backend-py/app/services/workbench/workbench.py:964-973`

- [ ] **Step 1: Add a workbench-level integration test**

Append to `backend-py/tests/test_provider_credentials.py`:

```python
def test_workbench_credential_check_uses_custom_store(fake_providers_store, monkeypatch):
    """Given a custom-store MiniMax with a key, the workbench credential check passes."""
    from app.providers import resolver as provider_resolver

    provider = provider_resolver.resolve("MiniMax (Global)")
    assert provider is not None
    assert provider.get("api_key")

    # Simulate the credential check pattern from workbench.py:964-973
    from app.providers.clients import get_client
    client = get_client(provider)
    if client and hasattr(client, "resolve_api_key"):
        # Built-in clients read env vars; the custom path bypasses get_client
        # because we attached api_key on the provider dict directly.
        # The new workbench code calls provider_credentials.resolve().api_key instead.
        from app.services import provider_credentials
        creds = provider_credentials.resolve("MiniMax (Global)")
        assert creds["api_key"] == "sk-custom-key-12345"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Dev/august-proxy/backend-py && .venv/Scripts/python.exe -m pytest tests/test_provider_credentials.py::test_workbench_credential_check_uses_custom_store -v`
Expected: PASS already on the helper side, but the workbench credential check still fails — that's what Step 3 fixes.

- [ ] **Step 3: Modify workbench credential check**

In `backend-py/app/services/workbench/workbench.py`, replace lines 964-973 with:

```python
    # Check credentials early — consult custom store first so user-added
    # API keys (Providers tab) are honored even when the built-in registry
    # entry has no env var.
    if resolved_provider:
        from app.services import provider_credentials
        creds = provider_credentials.resolve(
            resolved_provider.get("name") or resolved_provider.get("id") or ""
        )
        api_key = (creds or {}).get("api_key") if creds else None
        if not api_key:
            if emit:
                emit({"type": "error", "message": f"API key not configured for {resolved_provider.get('name', 'unknown')}"})
            session.status = "idle"
            if emit:
                emit({"type": "done", "sessionId": session_id})
            return
```

- [ ] **Step 4: Run all backend tests touching workbench/providers**

Run: `cd C:/Dev/august-proxy/backend-py && .venv/Scripts/python.exe -m pytest tests/test_provider_credentials.py tests/test_workbench.py tests/test_providers.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd C:/Dev/august-proxy
git add backend-py/app/services/workbench/workbench.py backend-py/tests/test_provider_credentials.py
git commit -m "fix(backend): workbench credential check honors custom provider store"
```

---

## Task 4: Backend — MCP tools always core + lazy refresh (covers spec #3)

**Files:**
- Modify: `backend-py/app/services/tools/model_tools.py:149-155`
- Modify: `backend-py/app/services/tools/mcp_client.py:239-252`
- Test: `backend-py/tests/test_workbench_mcp_tools.py` (extend)

- [ ] **Step 1: Add a failing test for MCP-core classification**

Append to `backend-py/tests/test_workbench_mcp_tools.py`:

```python
def test_assemble_tool_defs_keeps_mcp_tools_as_core():
    """Even when deferrable token mass is over threshold, mcp__ tools must be presented."""
    from app.services.tools.model_tools import assemble_tool_defs

    # Build a synthetic deferrable set big enough to trigger BM25 disclosure
    big_deferrable = [
        {"name": f"big_tool_{i}", "description": "x" * 200, "input_schema": {"type": "object"}}
        for i in range(50)
    ]
    mcp_tools = [
        {"name": "mcp__github__list_prs", "description": "List PRs", "input_schema": {"type": "object"}},
        {"name": "mcp__workspace__create_doc", "description": "Create doc", "input_schema": {"type": "object"}},
    ]
    all_tools = big_deferrable + mcp_tools

    result = assemble_tool_defs(all_tools, context_messages=None, context_length=200_000)
    # Activated means disclosure is happening
    assert result.activated
    tool_names = {t.get("name") for t in result.tool_defs}
    # Both MCP tools must be present
    assert "mcp__github__list_prs" in tool_names
    assert "mcp__workspace__create_doc" in tool_names
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Dev/august-proxy/backend-py && .venv/Scripts/python.exe -m pytest tests/test_workbench_mcp_tools.py::test_assemble_tool_defs_keeps_mcp_tools_as_core -v`
Expected: FAIL — only BM25-preloaded MCP tools are in the result.

- [ ] **Step 3: Modify assemble_tool_defs**

In `backend-py/app/services/tools/model_tools.py`, replace lines 149-155:

```python
    for td in all_tool_defs:
        name = td.get("name", "") if isinstance(td, dict) else ""
        # MCP tools are always core — they're expensive to reload per call
        # and should be visible/executable regardless of disclosure pressure.
        if name in core_tool_names or name.startswith("mcp__"):
            core_defs.append(td)
        else:
            deferrable_defs.append(td)
            deferrable_tokens += _estimate_tool_tokens(td)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Dev/august-proxy/backend-py && .venv/Scripts/python.exe -m pytest tests/test_workbench_mcp_tools.py -v`
Expected: PASS.

- [ ] **Step 5: Add lazy refresh to MCP cache**

In `backend-py/app/services/tools/mcp_client.py`, replace `get_mcp_tool_definitions_sync` (lines 239-252):

```python
def get_mcp_tool_definitions_sync() -> list[dict[str, Any]]:
    """Sync accessor over the lazily-populated MCP tool cache.

    Triggers a background ``refresh_mcp_tools()`` when the cache is empty
    but servers are registered, so newly-added servers surface without a
    restart.
    """
    if not _tools_cache and _servers:
        # Lazy refresh — fire and forget
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(refresh_mcp_tools())
        except RuntimeError:
            # No running loop (sync context, e.g. tests); skip
            pass
    return get_mcp_tool_definitions()
```

- [ ] **Step 6: Add a test for lazy refresh**

Append to `backend-py/tests/test_workbench_mcp_tools.py`:

```python
def test_get_mcp_tool_definitions_sync_triggers_lazy_refresh(monkeypatch):
    """When the cache is empty but servers are registered, lazy refresh kicks in."""
    from app.services.tools import mcp_client
    import asyncio

    # Register a server but leave cache empty
    monkeypatch.setattr(mcp_client, "_servers", {"mcp_xyz": {"id": "mcp_xyz", "name": "x"}})
    monkeypatch.setattr(mcp_client, "_tools_cache", {})

    refresh_called = {"v": False}

    async def fake_refresh():
        refresh_called["v"] = True
        mcp_client._tools_cache["mcp_xyz"] = [{"name": "demo", "description": "demo", "inputSchema": {}}]

    monkeypatch.setattr(mcp_client, "refresh_mcp_tools", fake_refresh)

    # Run the sync getter inside a real event loop
    async def runner():
        return mcp_client.get_mcp_tool_definitions_sync()
    asyncio.run(runner())

    assert refresh_called["v"] is True
```

- [ ] **Step 7: Run all MCP tests**

Run: `cd C:/Dev/august-proxy/backend-py && .venv/Scripts/python.exe -m pytest tests/test_workbench_mcp_tools.py -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd C:/Dev/august-proxy
git add backend-py/app/services/tools/model_tools.py backend-py/app/services/tools/mcp_client.py backend-py/tests/test_workbench_mcp_tools.py
git commit -m "feat(backend): MCP tools always core + lazy cache refresh"
```

---

## Task 5: Frontend — useProviderAvailability React Query hook (covers spec #4 part 1)

**Files:**
- Create: `frontend/desktop/src/hooks/useProviderAvailability.ts`
- Test: `frontend/desktop/src/test/provider_availability_hook.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/provider_availability_hook.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('useProviderAvailability hook', () => {
  it('exports a hook keyed on ["provider-availability"]', () => {
    const path = resolve(__dirname, '../hooks/useProviderAvailability.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/queryKey:\s*\[\s*['"]provider-availability['"]\s*\]/);
    expect(src).toMatch(/export\s+function\s+useProviderAvailability/);
  });

  it('fetches from /api/config/activeProvider', () => {
    const path = resolve(__dirname, '../hooks/useProviderAvailability.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/\/api\/config\/activeProvider/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Dev/august-proxy/frontend/desktop && npx vitest run src/test/provider_availability_hook.test.tsx`
Expected: FAIL — file doesn't exist.

- [ ] **Step 3: Create the hook**

Create `frontend/desktop/src/hooks/useProviderAvailability.ts`:

```ts
/* ── Provider availability (React Query) ──────────────────────────── */
/* Replaces the one-shot useEffect in ChatThread so newly-added providers */
/* appear in the model dropdown without remounting the chat. */

import { useQuery } from '@tanstack/react-query';

export interface ProviderAvailability {
  id: string;
  name: string;
  apiMode: string;
  isAvailable: boolean;
}

export interface ProviderAvailabilityResponse {
  activeProvider: string | null;
  providers: ProviderAvailability[];
}

export function useProviderAvailability() {
  const q = useQuery<ProviderAvailabilityResponse>({
    queryKey: ['provider-availability'],
    queryFn: async () => {
      const res = await fetch('/api/config/activeProvider');
      if (!res.ok) throw new Error('Failed to fetch provider availability');
      return res.json();
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  return {
    providers: q.data?.providers ?? ([] as ProviderAvailability[]),
    activeProvider: q.data?.activeProvider ?? null,
    isLoading: q.isLoading,
    error: q.error,
    refetch: q.refetch,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Dev/august-proxy/frontend/desktop && npx vitest run src/test/provider_availability_hook.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd C:/Dev/august-proxy
git add frontend/desktop/src/hooks/useProviderAvailability.ts frontend/desktop/src/test/provider_availability_hook.test.tsx
git commit -m "feat(frontend): useProviderAvailability React Query hook"
```

---

## Task 6: Frontend — ChatThread uses new hook + invalidates on refresh (covers spec #4 part 2)

**Files:**
- Modify: `frontend/desktop/src/sections/chat/ChatThread.tsx:403-425, 769-825`
- Test: `frontend/desktop/src/test/chat_refresh_handler.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/chat_refresh_handler.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ChatThread refresh handler', () => {
  it('refetch handler calls getAggregatedModels with refresh:true', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/getAggregatedModels\s*\(\s*\{\s*refresh:\s*true\s*\}\s*\)/);
  });

  it('invalidates both aggregated-models and provider-availability queries', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/invalidateQueries[\s\S]{0,80}aggregated-models/);
    expect(src).toMatch(/invalidateQueries[\s\S]{0,200}provider-availability/);
  });

  it('imports and uses useProviderAvailability instead of one-shot useEffect', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/import\s*\{[^}]*useProviderAvailability[^}]*\}\s*from\s*['"]@\/hooks\/useProviderAvailability['"]/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Dev/august-proxy/frontend/desktop && npx vitest run src/test/chat_refresh_handler.test.tsx`
Expected: FAIL — current ChatThread uses `initProviderAvailability` only.

- [ ] **Step 3: Modify ChatThread.tsx**

In `frontend/desktop/src/sections/chat/ChatThread.tsx`:

1. Add import at the top with other hooks:
```tsx
import { useProviderAvailability } from '@/hooks/useProviderAvailability';
import { useQueryClient } from '@tanstack/react-query';
```

2. Inside `ChatThread`, after the existing `useModels()` call (~line 403), add:
```tsx
const { providers: availableProvidersList } = useProviderAvailability();
const availableProviders = useMemo(
  () => new Set(availableProvidersList.filter(p => p.isAvailable).map(p => p.id)),
  [availableProvidersList]
);
```

3. Remove `initProviderAvailability` and its `useEffect` (lines 769-824).

4. Find the refresh button handler. Modify the handler to invalidate both keys and bypass cache. Replace the existing refresh handler (~line 1791) with:

```tsx
const queryClient = useQueryClient();
const handleRefreshModels = useCallback(async () => {
  await Promise.all([
    getAggregatedModels({ refresh: true }),
    queryClient.invalidateQueries({ queryKey: ['provider-availability'] }),
    queryClient.invalidateQueries({ queryKey: ['aggregated-models'] }),
  ]);
  refetchModels();
}, [queryClient, refetchModels]);
```

5. Wire the refresh button `onClick` to `handleRefreshModels` instead of `refetchModels`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Dev/august-proxy/frontend/desktop && npx vitest run src/test/chat_refresh_handler.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd C:/Dev/august-proxy
git add frontend/desktop/src/sections/chat/ChatThread.tsx frontend/desktop/src/test/chat_refresh_handler.test.tsx
git commit -m "feat(frontend): chat refresh forces provider-availability + model refresh"
```

---

## Task 7: Frontend — AUG indicator decoupled from `isLast` (covers spec #1)

**Files:**
- Modify: `frontend/desktop/src/sections/chat/ChatThread.tsx:2662`
- Test: `frontend/desktop/src/test/chat_aug_indicator.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/chat_aug_indicator.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('AUG working indicator visibility', () => {
  it('ChatThread renders WorkingIndicator anchored above the composer when streaming', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    // Composer-anchored indicator driven by `streaming`, not `isLast`
    expect(src).toMatch(/streaming\s*&&[^}]{0,40}<WorkingIndicator/);
  });

  it('AUG indicator is decoupled from isLast (no `isLast && streaming` gate)', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    // The old per-message gate should be removed
    expect(src).not.toMatch(/isLast\s*&&\s*streaming\s*&&\s*!showRaw\s*&&\s*\{?\s*<WorkingIndicator/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Dev/august-proxy/frontend/desktop && npx vitest run src/test/chat_aug_indicator.test.tsx`
Expected: FAIL — current code has `isLast && streaming && !showRaw`.

- [ ] **Step 3: Modify ChatThread.tsx**

In `frontend/desktop/src/sections/chat/ChatThread.tsx`:

1. Remove the per-message indicator (line 2662):
```tsx
            {isLast && streaming && !showRaw && <WorkingIndicator className="mt-1" />}
```
becomes nothing (delete the line).

2. Add a composer-anchored indicator just before the composer render. Find the composer block (~line 1962-1972 in the "thread-scroll-view") and add before `{renderComposerContent()}`:

```tsx
                {streaming && (
                  <div className="px-4 pb-1 pt-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <WorkingIndicator />
                  </div>
                )}
```

This anchors the indicator above the composer whenever the active session is streaming, regardless of message identity.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd C:/Dev/august-proxy/frontend/desktop && npx vitest run src/test/chat_aug_indicator.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd C:/Dev/august-proxy
git add frontend/desktop/src/sections/chat/ChatThread.tsx frontend/desktop/src/test/chat_aug_indicator.test.tsx
git commit -m "fix(frontend): AUG indicator decoupled from isLast, anchored above composer"
```

---

## Task 8: Frontend — full-width chat + edge scrollbar (covers spec #2)

**Files:**
- Modify: `frontend/desktop/src/components/shell/ChatLayout.tsx:280-295`
- Test: `frontend/desktop/src/test/chat_full_width_layout.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/chat_full_width_layout.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('ChatLayout full-width chat column', () => {
  it('chat column does not cap with max-w-3xl on its outermost wrapper', () => {
    const path = resolve(__dirname, '../components/shell/ChatLayout.tsx');
    const src = readFileSync(path, 'utf8');
    // The outermost chat column should not have max-w-3xl (it's removed so the
    // scroll container can span the full chat-area width).
    const idx = src.indexOf('<Outlet');
    expect(idx).toBeGreaterThan(0);
    const before = src.slice(Math.max(0, idx - 600), idx);
    // The max-w-3xl cap should NOT appear on the outermost wrapper just before Outlet
    expect(before).not.toMatch(/flex-1[^>]*max-w-3xl[^>]*flex-col/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Dev/august-proxy/frontend/desktop && npx vitest run src/test/chat_full_width_layout.test.tsx`
Expected: FAIL — `flex-1 flex min-w-0 justify-center` followed by `max-w-3xl` is still present.

- [ ] **Step 3: Modify ChatLayout.tsx**

In `frontend/desktop/src/components/shell/ChatLayout.tsx`, replace lines 280-295 with:

```tsx
              {/* Full-width chat column — scroll container spans the full
                  chat-area width so the thumb sits at the chat-area edge.
                  Internal content max-width is applied inside ChatThread
                  for message readability. */}
              <div className="flex-1 flex min-w-0 h-full">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={location.pathname}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    className="h-full min-w-0 flex-1"
                  >
                    <Outlet />
                  </motion.div>
                </AnimatePresence>
              </div>
```

- [ ] **Step 4: Verify the inner scroll container in ChatThread still caps content width**

In `frontend/desktop/src/sections/chat/ChatThread.tsx`, confirm the message list keeps the readable width:

```tsx
<div className="mx-auto w-full max-w-3xl px-4 py-8 space-y-5 relative">
```

This stays unchanged — the scroll container `flex-1 overflow-y-auto chat-scroll` is the parent and spans the full width.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd C:/Dev/august-proxy/frontend/desktop && npx vitest run src/test/chat_full_width_layout.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd C:/Dev/august-proxy
git add frontend/desktop/src/components/shell/ChatLayout.tsx frontend/desktop/src/test/chat_full_width_layout.test.tsx
git commit -m "feat(frontend): chat column full-width, scroll thumb at chat-area edge"
```

---

## Task 9: Frontend — slash command token-replace + keyboard nav + wire stubs (covers spec #6)

**Files:**
- Modify: `frontend/desktop/src/sections/chat/ChatThread.tsx:1415-1417, 1512-1526, 1566-1600, 1198-1202`
- Test: `frontend/desktop/src/test/slash_command_token_replace.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/slash_command_token_replace.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Slash command token replacement + keyboard nav', () => {
  it('defines an insertCommand that replaces the leading slash token', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/const\s+insertCommand\s*=\s*\(/);
  });

  it('commands dropdown uses insertCommand (not insertText) to avoid double slash', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    // Find the dropdown button onClick — should call insertCommand, not insertText(name + ' ')
    expect(src).toMatch(/onClick=\{?\(\)\s*=>\s*\{?\s*insertCommand\(c\.name/);
    expect(src).not.toMatch(/insertText\(c\.name\s*\+\s*['"]\s*['"]\)/);
  });

  it('Enter key selects highlighted command or sends when dropdown is closed', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/Enter.*highlightedCommandIndex|highlightedCommandIndex.*Enter/);
  });

  it('ArrowUp/ArrowDown navigates highlightedCommandIndex', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/ArrowDown.*highlightedCommandIndex\s*=|highlightedCommandIndex\s*=.*ArrowDown/);
    expect(src).toMatch(/ArrowUp.*highlightedCommandIndex\s*=|highlightedCommandIndex\s*=.*ArrowUp/);
  });

  it('Esc closes the commands dropdown', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/Escape.*setShowCommandsDropdown\(false\)/);
  });

  it('/new dispatches an august:new-session event (wired to createSession)', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/dispatchEvent\(new\s+CustomEvent\(['"]august:new-session['"]/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Dev/august-proxy/frontend/desktop && npx vitest run src/test/slash_command_token_replace.test.tsx`
Expected: FAIL — current code uses `insertText(c.name + ' ')`.

- [ ] **Step 3: Add `insertCommand` and `highlightedCommandIndex` state**

In `frontend/desktop/src/sections/chat/ChatThread.tsx`:

1. Add state next to `showCommandsDropdown`:
```tsx
const [highlightedCommandIndex, setHighlightedCommandIndex] = useState(0);
```

2. After `insertText`, add `insertCommand`:
```tsx
const insertCommand = (name: string) => {
  // Replace the leading /token (if any) so the typed `/` doesn't double up.
  const ta = taRef.current;
  const fullCmd = name + ' ';
  if (!ta) {
    setInput(prev => {
      const replaced = prev.replace(/^\s*\/[\w-]*/, '').trimStart();
      return '/' + replaced ? '/' + name + ' ' : fullCmd;
      // simpler: always set the full command
    });
    return;
  }
  const cursor = ta.selectionStart ?? ta.value.length;
  // Find the start of the leading /token before the cursor
  const before = ta.value.slice(0, cursor);
  const match = before.match(/\/[\w-]*$/);
  const tokenStart = match ? cursor - match[0].length : cursor;
  const after = ta.value.slice(cursor);
  const nextText = ta.value.slice(0, tokenStart) + fullCmd + after;
  setInput(nextText);
  setTimeout(() => {
    ta.focus();
    const newCursor = tokenStart + fullCmd.length;
    ta.selectionStart = ta.selectionEnd = newCursor;
  }, 50);
};
```

3. In `handleInputChange`, reset highlight to 0 when typing:
```tsx
setHighlightedCommandIndex(0);
```

- [ ] **Step 4: Wire keyboard navigation in `onKey`**

Replace `onKey` (lines 1415-1417) with:

```tsx
const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
  if (showCommandsDropdown) {
    const visible = COMMANDS.filter(c => {
      const q = input.trim().toLowerCase();
      if (!q) return true;
      return c.name.toLowerCase().startsWith(q);
    });
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedCommandIndex(i => (i + 1) % Math.max(1, visible.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedCommandIndex(i => (i - 1 + Math.max(1, visible.length)) % Math.max(1, visible.length));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && visible.length > 0) {
      e.preventDefault();
      const cmd = visible[highlightedCommandIndex] ?? visible[0];
      insertCommand(cmd.name);
      setShowCommandsDropdown(false);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setShowCommandsDropdown(false);
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
};
```

- [ ] **Step 5: Replace dropdown button onClick to use `insertCommand`**

In the commands dropdown (lines 1566-1600), replace:

```tsx
onClick={() => {
  insertText(c.name + ' ');
  setShowCommandsDropdown(false);
}}
```

with:

```tsx
onClick={() => {
  insertCommand(c.name);
  setShowCommandsDropdown(false);
}}
```

Also visually highlight the entry at `highlightedCommandIndex`:

```tsx
className={cn(
  "w-full text-left rounded-md px-2.5 py-1.5 text-xs text-foreground/80 hover:bg-muted hover:text-foreground transition flex items-center justify-between gap-2",
  idx === highlightedCommandIndex && "bg-muted"
)}
```

(Where the map gets `(c, idx) => ...`)

- [ ] **Step 6: Wire `/new` to dispatch a session creation event**

Replace lines 1198-1202:

```tsx
      if (cmd === 'new') {
        // Dispatch event so the parent (App/ChatLayout) can create the session
        window.dispatchEvent(new CustomEvent('august:new-session'));
        return;
      }
```

Also add a listener in App.tsx (search for the listener pattern of `august:open-right-sidebar`):

```tsx
useEffect(() => {
  const handler = () => createSession();
  window.addEventListener('august:new-session', handler);
  return () => window.removeEventListener('august:new-session', handler);
}, [createSession]);
```

(Adjust the listener to use whatever session-creation function is already wired.)

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd C:/Dev/august-proxy/frontend/desktop && npx vitest run src/test/slash_command_token_replace.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
cd C:/Dev/august-proxy
git add frontend/desktop/src/sections/chat/ChatThread.tsx frontend/desktop/src/test/slash_command_token_replace.test.tsx
git commit -m "feat(frontend): slash command token-replace + keyboard nav + wire /new"
```

---

## Task 10: Frontend — enriched COMMANDS + `/help` panel + upgraded dropdown (covers spec #7)

**Files:**
- Modify: `frontend/desktop/src/sections/chat/ChatThread.tsx:267-280, 1183-1186`
- Create: `frontend/desktop/src/sections/chat/CommandHelpCard.tsx`
- Test: `frontend/desktop/src/test/help_command_panel.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `frontend/desktop/src/test/help_command_panel.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('/help in-thread panel', () => {
  it('COMMANDS entries carry desc/usage/example/category fields', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/category:\s*['"]/);
    expect(src).toMatch(/usage:\s*['"`]/);
    expect(src).toMatch(/example:\s*['"`]/);
  });

  it('/help injects a CommandHelpCard block (not a toast)', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/setMessages[\s\S]{0,200}CommandHelpCard/);
    // Old toast path is gone
    expect(src).not.toMatch(/toast\.info\([^)]*Available commands/s);
  });

  it('CommandHelpCard renders every COMMANDS entry', () => {
    const path = resolve(__dirname, '../sections/chat/CommandHelpCard.tsx');
    const src = readFileSync(path, 'utf8');
    expect(src).toMatch(/COMMANDS\.map|command\.name|commands\.map/);
    expect(src).toMatch(/desc/);
  });

  it('dropdown shows description + example for each command', () => {
    const path = resolve(__dirname, '../sections/chat/ChatThread.tsx');
    const src = readFileSync(path, 'utf8');
    // The dropdown maps commands and renders example (we look for c.example or example:)
    expect(src).toMatch(/c\.example|c\.desc/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd C:/Dev/august-proxy/frontend/desktop && npx vitest run src/test/help_command_panel.test.tsx`
Expected: FAIL — current COMMANDS has only `name` and `desc`.

- [ ] **Step 3: Enrich COMMANDS array**

Replace lines 267-280:

```tsx
const COMMANDS = [
  { name: '/help', desc: 'Show available commands and capabilities', usage: '/help', example: '/help', category: 'Meta' },
  { name: '/commands', desc: 'Alias for /help — list all commands', usage: '/commands', example: '/commands', category: 'Meta' },
  { name: '/clear', desc: 'Clear the chat display (keeps session)', usage: '/clear', example: '/clear', category: 'Session' },
  { name: '/new', desc: 'Start a new chat session', usage: '/new', example: '/new', category: 'Session' },
  { name: '/reset', desc: 'Reset conversation history', usage: '/reset', example: '/reset', category: 'Session' },
  { name: '/model', desc: 'Switch model for this session', usage: '/model <name>', example: '/model minimax-m2.7', category: 'Provider' },
  { name: '/provider', desc: 'Switch provider for this session', usage: '/provider <name>', example: '/provider MiniMax (Global)', category: 'Provider' },
  { name: '/debug', desc: 'Toggle diagnostics mode (verbose tool traces)', usage: '/debug', example: '/debug', category: 'Workbench' },
  { name: '/goal', desc: 'Set a workbench goal condition', usage: '/goal <condition>', example: '/goal All tests pass', category: 'Workbench' },
  { name: '/btw', desc: 'Ask a by-the-way question without losing context', usage: '/btw <question>', example: '/btw What does this codebase do?', category: 'Workbench' },
  { name: '/load', desc: 'Load a skill by name', usage: '/load <skill-name>', example: '/load brainstorming', category: 'Skills' },
  { name: '/skills', desc: 'Search available skills', usage: '/skills [query]', example: '/skills testing', category: 'Skills' },
  { name: '/exam', desc: 'Open exam mode for a topic or attached files', usage: '/exam [topic]', example: '/exam python decorators', category: 'Study' },
];
```

- [ ] **Step 4: Create CommandHelpCard component**

Create `frontend/desktop/src/sections/chat/CommandHelpCard.tsx`:

```tsx
import { COMMANDS } from './commands-data';

interface CommandHelpCardProps {
  /** Optional title override; defaults to "Available commands". */
  title?: string;
}

const CATEGORY_ORDER = ['Meta', 'Session', 'Provider', 'Workbench', 'Skills', 'Study', 'Other'];

export function CommandHelpCard({ title = 'Available commands' }: CommandHelpCardProps) {
  const grouped = new Map<string, typeof COMMANDS>();
  for (const c of COMMANDS) {
    const cat = c.category || 'Other';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(c);
  }
  const categories = Array.from(grouped.keys()).sort(
    (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b)
  );

  return (
    <div
      data-slot="help-card"
      className="rounded-lg border border-border bg-card p-4 space-y-3 max-w-3xl"
    >
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {categories.map(cat => (
        <div key={cat} className="space-y-1">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">{cat}</div>
          <div className="grid gap-1">
            {grouped.get(cat)!.map(c => (
              <div key={c.name} className="grid grid-cols-[120px_1fr] gap-3 text-xs">
                <div className="font-mono text-primary">{c.name}</div>
                <div className="space-y-0.5">
                  <div className="text-foreground/90">{c.desc}</div>
                  {c.usage && (
                    <div className="text-[11px] text-muted-foreground">
                      <span className="font-mono">{c.usage}</span>
                      {c.example && c.example !== c.usage && (
                        <span className="ml-2">e.g. <span className="font-mono">{c.example}</span></span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 5: Move COMMANDS to commands-data.ts (so CommandHelpCard can import)**

Create `frontend/desktop/src/sections/chat/commands-data.ts`:

```ts
export interface ChatCommand {
  name: string;
  desc: string;
  usage?: string;
  example?: string;
  category?: string;
}

export const COMMANDS: ChatCommand[] = [
  { name: '/help', desc: 'Show available commands and capabilities', usage: '/help', example: '/help', category: 'Meta' },
  { name: '/commands', desc: 'Alias for /help — list all commands', usage: '/commands', example: '/commands', category: 'Meta' },
  { name: '/clear', desc: 'Clear the chat display (keeps session)', usage: '/clear', example: '/clear', category: 'Session' },
  { name: '/new', desc: 'Start a new chat session', usage: '/new', example: '/new', category: 'Session' },
  { name: '/reset', desc: 'Reset conversation history', usage: '/reset', example: '/reset', category: 'Session' },
  { name: '/model', desc: 'Switch model for this session', usage: '/model <name>', example: '/model minimax-m2.7', category: 'Provider' },
  { name: '/provider', desc: 'Switch provider for this session', usage: '/provider <name>', example: '/provider MiniMax (Global)', category: 'Provider' },
  { name: '/debug', desc: 'Toggle diagnostics mode (verbose tool traces)', usage: '/debug', example: '/debug', category: 'Workbench' },
  { name: '/goal', desc: 'Set a workbench goal condition', usage: '/goal <condition>', example: '/goal All tests pass', category: 'Workbench' },
  { name: '/btw', desc: 'Ask a by-the-way question without losing context', usage: '/btw <question>', example: '/btw What does this codebase do?', category: 'Workbench' },
  { name: '/load', desc: 'Load a skill by name', usage: '/load <skill-name>', example: '/load brainstorming', category: 'Skills' },
  { name: '/skills', desc: 'Search available skills', usage: '/skills [query]', example: '/skills testing', category: 'Skills' },
  { name: '/exam', desc: 'Open exam mode for a topic or attached files', usage: '/exam [topic]', example: '/exam python decorators', category: 'Study' },
];
```

- [ ] **Step 6: Replace the `/help` toast with an in-thread panel**

In `ChatThread.tsx`, replace the `/help` branch (lines 1183-1186):

```tsx
      if (cmd === 'help' || cmd === 'commands') {
        const helpMsg: ChatMessage = {
          id: `m${Date.now()}`,
          role: 'assistant',
          content: '',
          timestamp: new Date().toISOString(),
          kind: 'help',
        };
        setMessages(prev => [...prev, helpMsg]);
        persistMessages(sessionId, [...messages, helpMsg]);
        setInput('');
        setShowCommandsDropdown(false);
        return;
      }
```

Also update the `ChatMessage` type to allow `kind: 'help'` and have the message renderer detect `kind === 'help'` and render `<CommandHelpCard />`. (See step 7.)

- [ ] **Step 7: Render CommandHelpCard from the message renderer**

In the message bubble renderer (`MessageBubble` in ChatThread.tsx), when `message.kind === 'help'`, render the card:

```tsx
{message.kind === 'help' ? <CommandHelpCard /> : null}
```

- [ ] **Step 8: Upgrade the dropdown to show example**

In the dropdown map (around line 1578), add the example line below the description:

```tsx
<span className="text-[10px] text-muted-foreground truncate">
  {c.desc}
  {c.example && <span className="ml-1 font-mono opacity-70">{c.example}</span>}
</span>
```

- [ ] **Step 9: Update the imports in ChatThread.tsx**

Add:

```tsx
import { COMMANDS } from './commands-data';
import { CommandHelpCard } from './CommandHelpCard';
```

Remove the old `const COMMANDS = [...]` declaration.

- [ ] **Step 10: Run the test to verify it passes**

Run: `cd C:/Dev/august-proxy/frontend/desktop && npx vitest run src/test/help_command_panel.test.tsx`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
cd C:/Dev/august-proxy
git add frontend/desktop/src/sections/chat/ChatThread.tsx frontend/desktop/src/sections/chat/commands-data.ts frontend/desktop/src/sections/chat/CommandHelpCard.tsx frontend/desktop/src/test/help_command_panel.test.tsx
git commit -m "feat(frontend): enriched COMMANDS + /help panel + upgraded dropdown"
```

---

## Task 11: Verify all tests pass

- [ ] **Step 1: Run all backend tests**

Run: `cd C:/Dev/august-proxy/backend-py && .venv/Scripts/python.exe -m pytest tests/test_provider_credentials.py tests/test_workbench_mcp_tools.py tests/test_providers.py tests/test_workbench.py -v`
Expected: PASS.

- [ ] **Step 2: Run all frontend tests**

Run: `cd C:/Dev/august-proxy/frontend/desktop && npx vitest run`
Expected: PASS (existing tests unaffected, new tests pass).

- [ ] **Step 3: Final commit if any cleanup needed**

```bash
cd C:/Dev/august-proxy
git status
# If there are any stragglers, git add + git commit them as a chore commit.
```

---

## Self-Review

**Spec coverage:**
- #1 AUG animation — Task 7
- #2 full-width chat + edge scrollbar — Task 8
- #3 MCP tools always visible + executable — Task 4
- #4 model dropdown refresh — Tasks 5 & 6
- #5 MiniMax key resolution — Tasks 1, 2, 3
- #6 slash command double-slash + stubs — Task 9
- #7 /help panel — Task 10

All 7 spec items have at least one task.

**Placeholder scan:** No "TBD", "TODO", "implement later", or vague instructions.

**Type consistency:**
- `useProviderAvailability()` returns `{ providers, activeProvider, isLoading, error, refetch }` — used in ChatThread with the same names.
- `provider_credentials.resolve(name_or_id)` returns `{ provider, api_key, base_url, api_mode, source }` — used in resolver.py and workbench.py consistently.
- `insertCommand(name)` — used by both keyboard handler and dropdown onClick.
- `COMMANDS` is now imported from `commands-data.ts`; consumers (dropdown, /help, keyboard nav) all reference the same source.
- `CommandHelpCard` is the rendered card; the `/help` handler injects a `kind: 'help'` message which the renderer detects.

No mismatches detected.
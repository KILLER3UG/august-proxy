"""
Model aggregation service — collects models from all providers with live
fetching, caching, fallback to static lists, and display alias generation.

Port of backend/providers/model-list.js (277 lines).

Key functions:
- ``aggregate()`` — full model list with caching
- ``get_model_display_alias()`` — human-readable model name
- ``resolve_model_alias_details()`` — find provider for an alias
- ``invalidate_cache()`` — clear the cache
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx

from app.config import settings
from app.providers import resolver as provider_resolver
from app.providers.clients import get_client

# ── Cache ────────────────────────────────────────────────────────────

_model_cache: list[dict[str, Any]] | None = None
_model_cache_at: float = 0
_MODEL_CACHE_TTL: float = 300  # 5 minutes
_alias_cache: dict[str, Any] | None = None
_alias_cache_at: float = 0
_ALIAS_CACHE_TTL: float = 60  # 1 minute
_refresh_in_flight: asyncio.Task | None = None


def invalidate_cache() -> None:
    global _model_cache, _model_cache_at, _alias_cache, _alias_cache_at
    _model_cache = None
    _model_cache_at = 0
    _alias_cache = None
    _alias_cache_at = 0


# ── Model fetching ───────────────────────────────────────────────────

_STATIC_MODEL_LISTS: dict[str, list[dict[str, Any]]] = {
    "Anthropic": [
        {"id": "claude-sonnet-4-7", "contextWindow": 200000},
        {"id": "claude-sonnet-4-6", "contextWindow": 200000},
        {"id": "claude-opus-4-7", "contextWindow": 200000},
        {"id": "claude-opus-4-6", "contextWindow": 200000},
        {"id": "claude-haiku-4-5", "contextWindow": 200000},
    ],
    "OpenAI API": [
        {"id": "gpt-4o", "contextWindow": 128000},
        {"id": "gpt-4o-mini", "contextWindow": 128000},
        {"id": "o1", "contextWindow": 200000},
        {"id": "o3", "contextWindow": 200000},
    ],
    "Google AI Studio": [
        {"id": "gemini-2.0-flash", "contextWindow": 1048576},
        {"id": "gemini-2.0-pro", "contextWindow": 1048576},
        {"id": "gemini-1.5-pro", "contextWindow": 1048576},
    ],
    "DeepSeek": [
        {"id": "deepseek-v4", "contextWindow": 131072},
        {"id": "deepseek-v4-flash", "contextWindow": 131072},
        {"id": "deepseek-reasoner", "contextWindow": 131072},
    ],
}


def _derive_models_url(base_url: str) -> str | None:
    """Derive the /models endpoint URL from a provider's base URL."""
    base = base_url.rstrip("/")
    # Strip known API path suffixes
    for suffix in ["/chat/completions", "/messages", "/responses", "/v1"]:
        if base.endswith(suffix):
            base = base[: -len(suffix)]
    return f"{base}/models" if base else None


def _get_context_window(model_id: str, provider: dict[str, Any] | None = None, fallback: int | None = None) -> int:
    """Resolve context window from provider profile or inference."""
    if provider:
        profiles = provider.get("model_profiles", {})
        for key in [model_id] + [k for k in profiles if model_id.startswith(k)]:
            profile = profiles.get(key)
            if isinstance(profile, dict) and profile.get("contextWindow"):
                return profile["contextWindow"]
        wildcard = profiles.get("*", {})
        if isinstance(wildcard, dict) and wildcard.get("contextWindow"):
            return wildcard["contextWindow"]
    return fallback or 128000


def _is_free_model_id(model_id: str) -> bool:
    """Check if a model ID indicates a free tier (:free / -free)."""
    if not isinstance(model_id, str):
        return False
    lower = model_id.lower()
    return ":free" in lower or "-free" in lower or lower.endswith("free")


def _prettify_model_base(base: str) -> str:
    """Generate a human-readable model name."""
    if re.match(r"^claude-", base, re.IGNORECASE):
        name = re.sub(r"^claude-", "", base, flags=re.IGNORECASE).replace("-", " ")
        return name.title()
    if re.match(r"^gpt-", base, re.IGNORECASE):
        return base.replace("gpt-", "GPT-", 1)
    if re.match(r"^gemini-", base, re.IGNORECASE):
        return "Gemini " + re.sub(r"^gemini-", "", base, flags=re.IGNORECASE).replace("-", " ").title()
    if re.match(r"^deepseek-", base, re.IGNORECASE):
        return "DeepSeek " + re.sub(r"^deepseek-", "", base, flags=re.IGNORECASE).replace("-", " ").title()
    return base.replace("-", " ").title()


def _get_model_display_alias(model: dict[str, Any]) -> str:
    """Generate a display alias for a model."""
    model_id = model.get("id", "")
    base = model_id.split("/")[-1].split(":")[-1] if "/" in model_id or ":" in model_id else model_id

    # Strip variant tags
    tag = ""
    for pattern, label in [
        (r"-fast$", "Fast"), (r"-thinking$", "Thinking"), (r"-preview$", "Preview"),
        (r"-latest$", "Latest"), (r":free$", "Free"), (r"-free$", "Free"),
    ]:
        if re.search(pattern, base, re.IGNORECASE):
            base = re.sub(pattern, "", base, flags=re.IGNORECASE)
            tag = label
            break

    display = _prettify_model_base(base)
    return f"{display}{f' ({tag})' if tag else ''}"


# ── Per-provider fetch (with timeout) ────────────────────────────────


async def _fetch_provider_models(provider: dict[str, Any], timeout_s: float = 5.0) -> list[dict[str, Any]]:
    """Fetch models from a provider's /models endpoint.

    Falls back to static list if the endpoint is unavailable.
    """
    client = get_client(provider)
    if not client:
        return []

    api_key = client.resolve_api_key()
    base_url = client.resolve_base_url()
    provider_name = provider.get("name", "")

    # Try live fetch
    models_url = _derive_models_url(base_url)
    if models_url and api_key:
        try:
            headers = client.build_auth_headers(api_key)
            async with httpx.AsyncClient(timeout=timeout_s) as http:
                resp = await http.get(models_url, headers=headers)
                if resp.status_code == 200:
                    data = resp.json()
                    model_list = data.get("data", data.get("models", data if isinstance(data, list) else []))
                    return [
                        {
                            "id": m["id"],
                            "name": m["id"],
                            "provider": provider_name,
                            "contextWindow": _get_context_window(m["id"], provider, m.get("context_length")),
                        }
                        for m in (model_list if isinstance(model_list, list) else [])
                    ]
        except Exception:
            pass

    # Fallback to static list
    static = _STATIC_MODEL_LISTS.get(provider_name, [])
    if not static:
        default_model = provider.get("default_model")
        if default_model:
            static = [{"id": default_model, "contextWindow": _get_context_window(default_model, provider)}]
        fallback_models = provider.get("fallback_models", [])
        for fm in fallback_models:
            if not any(s["id"] == fm for s in static):
                static.append({"id": fm, "contextWindow": _get_context_window(fm, provider)})

    return [
        {"id": m["id"], "name": m["id"], "provider": provider_name, "contextWindow": m.get("contextWindow", 128000)}
        for m in static
    ]


# ── Aggregation ──────────────────────────────────────────────────────


async def _aggregate_models() -> list[dict[str, Any]]:
    """Aggregate models from user-configured providers in providers.json only."""
    all_models: list[dict[str, Any]] = []

    try:
        store = settings.providers
        for entry in store.get("providers", []):
            if not entry.get("enabled") or not entry.get("apiKey"):
                continue
            for m in entry.get("models", []):
                import re
                mid = m["id"]
                reasoning = m.get("reasoning", False) or bool(re.search(
                    r"\b(o1|o3|reasoner|thinking|reasoning)\b", mid, re.IGNORECASE
                ))
                all_models.append({
                    "id": mid,
                    "name": m.get("name", mid),
                    "provider": entry["name"],
                    "contextWindow": m.get("contextWindow", 128000),
                    "supportsReasoning": reasoning,
                    "supportsThinking": reasoning,
                    "isFree": m.get("free", False) or _is_free_model_id(m["id"]),
                })
    except Exception:
        pass

    # De-duplicate by id (free models first)
    seen: dict[str, dict[str, Any]] = {}
    for m in all_models:
        mid = m["id"]
        if mid not in seen or (m.get("isFree") and not seen[mid].get("isFree")):
            seen[mid] = m

    result = list(seen.values())
    result.sort(key=lambda m: (0 if m.get("isFree") else 1, m.get("id", "")))

    return result


# ── Public API ───────────────────────────────────────────────────────


async def aggregate(refresh: bool = False) -> list[dict[str, Any]]:
    """Get the aggregated model list with caching."""
    global _model_cache, _model_cache_at, _refresh_in_flight

    now = time.time()

    # Force refresh
    if refresh:
        _model_cache = None
        _model_cache_at = 0

    # Return cached if fresh
    if _model_cache is not None and (now - _model_cache_at) < _MODEL_CACHE_TTL:
        return _model_cache

    # Background refresh if stale
    if _model_cache is not None:
        if _refresh_in_flight is None or _refresh_in_flight.done():
            _refresh_in_flight = asyncio.create_task(_refresh_background())
        return _model_cache

    # Cold cache — fetch synchronously
    models = await _aggregate_models()
    _model_cache = models
    _model_cache_at = now
    return models


async def _refresh_background() -> None:
    """Background cache refresh."""
    global _model_cache, _model_cache_at
    try:
        fresh = await _aggregate_models()
        _model_cache = fresh
        _model_cache_at = time.time()
    except Exception:
        pass


async def prewarm() -> None:
    """Pre-warm the model cache on startup."""
    try:
        models = await _aggregate_models()
        global _model_cache, _model_cache_at
        _model_cache = models
        _model_cache_at = time.time()
    except Exception:
        pass


def get_model_display_alias(model: dict[str, Any]) -> str:
    return _get_model_display_alias(model)


def is_free_model_id(model_id: str) -> bool:
    return _is_free_model_id(model_id)

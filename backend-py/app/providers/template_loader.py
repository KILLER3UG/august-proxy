"""
Provider template loader — reads ``provider_templates.json`` at import
time and caches it.  This replaces the old per-module ``INFO`` dicts and
the ``builtin.py`` registrar.

Template fields
---------------
Each template dict has:

    id                  kebab-case unique identifier
    name                Human-readable provider name
    displayName         Display name (same as name for most)
    description         Short description
    baseUrl             Default endpoint URL
    apiFormat           API protocol format key
    authType            Authentication type (api_key, aws_sdk, etc.)
    envVars             Environment variable names the provider reads
    defaultModel        Default model ID
    defaultMaxTokens    Default max output tokens
    signupUrl           Sign-up / console URL
    supportsHealthCheck Whether ``/health``-style endpoint is available
    aliases             Alternative names for matching
    fallbackModels      Ordered list of fallback model IDs
    defaultHeaders      Default HTTP headers dict
    modelProfiles       Dict of model prefix → profile (reasoning, context
                        window, etc.)

Usage
-----
    from app.providers.template_loader import get_templates, get_template

    all_templates = get_templates()
    anthropic = get_template("anthropic")
"""
from __future__ import annotations
import json
from pathlib import Path
from typing import Optional
_TEMPLATES: list[dict[str, object]] | None = None
_INDEX: dict[str, dict[str, object]] | None = None
_DATADir = Path(__file__).resolve().parent

def _load() -> list[dict[str, object]]:
    """Read ``provider_templates.json`` and return the list of template dicts."""
    path = _DATADir / 'provider_templates.json'
    with open(path, 'r', encoding='utf-8') as f:
        return list(json.load(f))

def _buildIndex(templates: list[dict[str, object]]) -> dict[str, dict[str, object]]:
    """Build a case-insensitive id → template lookup map."""
    idx: dict[str, dict[str, object]] = {}
    for t in templates:
        tid = str(t.get('id', ''))
        if tid:
            idx[tid] = t
            idx[tid.lower()] = t
    return idx

def getTemplates() -> list[dict[str, object]]:
    """Return all provider templates (cached after first load)."""
    global _TEMPLATES, _INDEX
    if _TEMPLATES is None:
        _TEMPLATES = _load()
        _INDEX = _buildIndex(_TEMPLATES)
    return list(_TEMPLATES)

def getTemplate(templateId: str) -> Optional[dict[str, object]]:
    """Look up a single template by id (case-insensitive).

    Returns ``None`` if the id is not found.
    """
    global _TEMPLATES, _INDEX
    if _INDEX is None:
        getTemplates()
    return (_INDEX or {}).get(templateId.lower())

def invalidateCache() -> None:
    """Clear the cached templates (useful for testing)."""
    global _TEMPLATES, _INDEX
    _TEMPLATES = None
    _INDEX = None
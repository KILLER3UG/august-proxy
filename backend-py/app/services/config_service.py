"""
Config service — read/write config.json and providers.json.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Optional

from app.atomic_write import write_json_atomic
from app.json_narrowing import as_int, as_list
from app.lib.paths import dataPath
from app.models.config import ModelConfig, ProviderConfig

# ── read cache (avoids hitting disk on every hot-path call) ──────────────
_CONFIG_CACHE_TTL_S = 2.0  # seconds — long enough to dedup burst reads,
# short enough that editors / external writes propagate quickly.
# Validated against file mtime: (read_ts, path, mtime_ns, data).
_config_cache: tuple[float, str, int, dict[str, object]] | None = None


def _readJson(path: Path) -> dict[str, object]:
    try:
        return json.loads(path.read_text('utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _writeJson(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(path, data, indent=2)


def getConfig() -> dict[str, object]:
    """Return config.json contents, cached for _CONFIG_CACHE_TTL_S seconds.

    The cache is validated against the file's mtime, so direct/external writes
    (editors, tests, other processes) propagate immediately instead of serving
    up to the TTL of stale data. Returns a shallow copy each call so callers
    that mutate the returned dict cannot poison the cache.
    """
    global _config_cache  # noqa: PLW0603
    now = time.monotonic()
    path = dataPath('config.json')
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        mtime = -1
    if _config_cache is not None:
        cached_at, cached_path, cached_mtime, cached_data = _config_cache
        if cached_path == str(path) and cached_mtime == mtime and now - cached_at < _CONFIG_CACHE_TTL_S:
            return dict(cached_data)
    data = _readJson(path)
    _config_cache = (now, str(path), mtime, data)
    return dict(data)


def saveConfig(config: dict[str, object]) -> None:
    global _config_cache  # noqa: PLW0603
    _writeJson(dataPath('config.json'), config)
    _config_cache = None  # invalidate read cache


def getProvidersStore() -> dict[str, object]:
    return _readJson(dataPath('providers.json'))


def saveProvidersStore(data: dict[str, object]) -> None:
    _writeJson(dataPath('providers.json'), data)
    from app.services.provider_credentials import _fireInvalidation

    _fireInvalidation()
    # Bust model-list cache + reload settings so chat picks up contextWindow edits.
    try:
        from app.services import model_service

        model_service.invalidate_cache()
    except Exception:
        pass
    # Same reason for prices: a saved priceInPerM must be billable on the very
    # next turn, not whenever the file stamp next differs.
    try:
        from app.services import cost_estimator

        cost_estimator.invalidate_price_cache()
    except Exception:
        pass


def apply_model_tool_surface(model_id: str, surface: str) -> bool:
    """Persist a per-model toolSurface override (capability auto-profile).

    Mirrors the logic the workbench auto-profile uses; kept here so the
    /api/models/profile endpoint and the harness share one implementation.
    Returns True when a matching model was updated.
    """
    try:
        store = getProvidersStore()
        for prov in as_list(store.get('providers'), []):
            if not isinstance(prov, dict):
                continue
            for m in as_list(prov.get('models'), []):
                if isinstance(m, dict) and str(m.get('id', '')) == model_id:
                    m['toolSurface'] = surface
                    saveProvidersStore(store)
                    return True
    except Exception:
        return False
    return False


def clear_model_tool_surface(model_id: str) -> bool:
    """Remove a model's toolSurface override (revert to provider default)."""
    try:
        store = getProvidersStore()
        for prov in as_list(store.get('providers'), []):
            if not isinstance(prov, dict):
                continue
            for m in as_list(prov.get('models'), []):
                if isinstance(m, dict) and str(m.get('id', '')) == model_id:
                    m.pop('toolSurface', None)
                    saveProvidersStore(store)
                    return True
    except Exception:
        return False
    return False


def _parse_price(entry: dict[str, object], *keys: str) -> float | None:
    """One stored price under either spelling, or None when it is unset."""
    from app.services.cost_estimator import parse_stored_price

    for key in keys:
        raw = entry.get(key)
        if raw is not None:
            return parse_stored_price(raw)
    return None


def _stringList(entry: dict[str, object], *keys: str) -> list[str] | None:
    """One stored string list under either spelling, or None when unset.

    An empty list is treated as unset because that is what the write door
    stores nothing as — ``inputTypes: []`` pops the key rather than saving it.
    """
    for key in keys:
        raw = entry.get(key)
        if isinstance(raw, list):
            values = [str(v) for v in raw if str(v or '').strip()]
            if values:
                return values
    return None


def getProvidersAsModels() -> list[ProviderConfig]:
    """Read providers from the store and return typed ProviderConfig models."""
    store = getProvidersStore()
    raw_list = as_list(store.get('providers'))
    result: list[ProviderConfig] = []
    for raw in raw_list:
        if not isinstance(raw, dict):
            continue
        models_raw = as_list(raw.get('models'))
        models: list[ModelConfig] = []
        for m in models_raw:
            if isinstance(m, dict):
                models.append(
                    ModelConfig(
                        id=str(m.get('id', '')),
                        name=str(m.get('name', '')),
                        context_window=as_int(
                            m.get('contextWindow') or m.get('context_window'), 128000
                        ),
                        reasoning=bool(m.get('reasoning', False)),
                        free=bool(m.get('free', False)),
                        pinned=bool(m.get('pinned', False)),
                        source=str(m.get('source', 'manual')),
                        api_format=str(m.get('apiFormat') or m.get('api_format') or '') or None,
                        supports_reasoning_effort=(
                            m.get('supportsReasoningEffort')
                            if m.get('supportsReasoningEffort') is not None
                            else m.get('supports_reasoning_effort')
                        ),
                        max_reasoning_effort=(
                            str(m.get('maxReasoningEffort') or m.get('max_reasoning_effort') or '')
                            or None
                        ),
                        tool_surface=(
                            str(m.get('toolSurface') or m.get('tool_surface') or '') or None
                        ),
                        max_tools=as_int(m.get('maxTools') or m.get('max_tools'), 0),
                        max_tool_result_chars=as_int(
                            m.get('maxToolResultChars') or m.get('max_tool_result_chars'), 0
                        ),
                        # Reference-modal fields. These were never passed here,
                        # so a stored output cap read back as null and the
                        # editor's `?? 128000` seed reset it on the next save.
                        max_output_tokens=as_int(
                            m.get('maxOutputTokens') or m.get('max_output_tokens'), 0
                        )
                        or None,
                        input_types=_stringList(m, 'inputTypes', 'input_types'),
                        output_types=_stringList(m, 'outputTypes', 'output_types'),
                        # Through the estimator's own parser, so "not set" and
                        # "set to zero" cannot mean different things here than
                        # they do when the price is billed.
                        price_in_per_m=_parse_price(m, 'priceInPerM', 'price_in_per_m'),
                        price_out_per_m=_parse_price(m, 'priceOutPerM', 'price_out_per_m'),
                    )
                )
        from app.providers.api_format import normalize_api_format

        result.append(
            ProviderConfig(
                id=str(raw.get('id', '')),
                name=str(raw.get('name', '')),
                api_format=normalize_api_format(raw.get('apiFormat'), default='openaiChat'),
                api_key=str(raw.get('apiKey', '')),
                base_url=str(raw.get('baseUrl', '')),
                enabled=bool(raw.get('enabled', True)),
                auto_fetch=bool(raw.get('autoFetch', False)),
                models=models,
            )
        )
    return result


def getEnv(key: str) -> Optional[str]:
    return os.environ.get(key)


def setEnv(key: str, value: str) -> None:
    os.environ[key] = value


def deleteEnv(key: str) -> None:
    os.environ.pop(key, None)

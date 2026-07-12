"""
Config service — read/write config.json and providers.json.
"""

from __future__ import annotations
import json
import os
from pathlib import Path
from typing import Optional
from app.lib.paths import dataPath
from app.typeAliases import JsonValue
	from app.jsonUtils import as_str, as_dict, as_list, as_int, as_float, write_json_atomic
from app.models.config import ProviderConfig, ModelConfig


def _readJson(path: Path) -> dict[str, object]:
    try:
        return json.loads(path.read_text('utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _writeJson(path: Path, data: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(path, data, indent=2)


def getConfig() -> dict[str, object]:
    return _readJson(dataPath('config.json'))


def saveConfig(config: dict[str, object]) -> None:
    _writeJson(dataPath('config.json'), config)


def getProvidersStore() -> dict[str, object]:
    return _readJson(dataPath('providers.json'))


def saveProvidersStore(data: dict[str, object]) -> None:
    _writeJson(dataPath('providers.json'), data)
    from app.services.provider_credentials import _fireInvalidation

    _fireInvalidation()


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
                        context_window=as_int(m.get('contextWindow'), 128000),
                        reasoning=bool(m.get('reasoning', False)),
                        free=bool(m.get('free', False)),
                        source=str(m.get('source', 'manual')),
                    )
                )
        result.append(
            ProviderConfig(
                id=str(raw.get('id', '')),
                name=str(raw.get('name', '')),
                api_format=str(raw.get('apiFormat', 'openaiChat')),
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

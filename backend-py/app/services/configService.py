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
from app.models.config import ProviderConfig, ModelConfig

def _readJson(path: Path) -> dict[str, JsonValue]:
    try:
        return json.loads(path.read_text('utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def _writeJson(path: Path, data: dict[str, JsonValue]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), 'utf-8')

def getConfig() -> dict[str, JsonValue]:
    return _readJson(dataPath('config.json'))

def saveConfig(config: dict[str, JsonValue]) -> None:
    _writeJson(dataPath('config.json'), config)

def getProvidersStore() -> dict[str, JsonValue]:
    return _readJson(dataPath('providers.json'))

def saveProvidersStore(data: dict[str, JsonValue]) -> None:
    _writeJson(dataPath('providers.json'), data)
    from app.services.providerCredentials import _fireInvalidation
    _fireInvalidation()

def getProvidersAsModels() -> list[ProviderConfig]:
    """Read providers from the store and return typed ProviderConfig models."""
    store = getProvidersStore()
    raw_list: list[dict[str, JsonValue]] = store.get('providers', [])
    if not isinstance(raw_list, list):
        return []
    result: list[ProviderConfig] = []
    for raw in raw_list:
        if not isinstance(raw, dict):
            continue
        models_raw = raw.get('models', [])
        models: list[ModelConfig] = []
        if isinstance(models_raw, list):
            for m in models_raw:
                if isinstance(m, dict):
                    models.append(ModelConfig(
                        id=str(m.get('id', '')),
                        name=str(m.get('name', '')),
                        contextWindow=int(m.get('contextWindow', 128000)),
                        reasoning=bool(m.get('reasoning', False)),
                        free=bool(m.get('free', False)),
                        source=str(m.get('source', 'manual')),
                    ))
        result.append(ProviderConfig(
            id=str(raw.get('id', '')),
            name=str(raw.get('name', '')),
            apiFormat=str(raw.get('apiFormat', 'openaiChat')),
            apiKey=str(raw.get('apiKey', '')),
            baseUrl=str(raw.get('baseUrl', '')),
            enabled=bool(raw.get('enabled', True)),
            autoFetch=bool(raw.get('autoFetch', False)),
            models=models,
        ))
    return result

def getEnv(key: str) -> Optional[str]:
    return os.environ.get(key)

def setEnv(key: str, value: str) -> None:
    os.environ[key] = value

def deleteEnv(key: str) -> None:
    os.environ.pop(key, None)
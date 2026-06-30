"""
Config service — read/write config.json and providers.json.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
from typing import Any, Optional
from app.lib.paths import dataPath

def _readJson(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text('utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def _writeJson(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), 'utf-8')

def getConfig() -> dict[str, Any]:
    return _readJson(dataPath('config.json'))

def saveConfig(config: dict[str, Any]) -> None:
    _writeJson(dataPath('config.json'), config)

def getProvidersStore() -> dict[str, Any]:
    return _readJson(dataPath('providers.json'))

def saveProvidersStore(data: dict[str, Any]) -> None:
    _writeJson(dataPath('providers.json'), data)
    from app.services.providerCredentials import _fireInvalidation
    _fireInvalidation()

def getEnv(key: str) -> Optional[str]:
    return os.environ.get(key)

def setEnv(key: str, value: str) -> None:
    os.environ[key] = value

def deleteEnv(key: str) -> None:
    os.environ.pop(key, None)
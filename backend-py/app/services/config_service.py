"""
Config service — read/write config.json and providers.json.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

from app.lib.paths import data_path


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), "utf-8")


def get_config() -> dict[str, Any]:
    return _read_json(data_path("config.json"))


def save_config(config: dict[str, Any]) -> None:
    _write_json(data_path("config.json"), config)


def get_providers_store() -> dict[str, Any]:
    return _read_json(data_path("providers.json"))


def save_providers_store(data: dict[str, Any]) -> None:
    _write_json(data_path("providers.json"), data)


def get_env(key: str) -> Optional[str]:
    return os.environ.get(key)


def set_env(key: str, value: str) -> None:
    os.environ[key] = value


def delete_env(key: str) -> None:
    os.environ.pop(key, None)

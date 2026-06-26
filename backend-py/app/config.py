"""
Settings — loads config.json, providers.json, and .env into Pydantic models.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


def _find_project_root() -> Path:
    """Walk up from this file's location to find the project root."""
    here = Path(__file__).resolve().parent.parent.parent  # app/../.. = project root
    return here


def _load_json(path: Path) -> Dict[str, Any]:
    try:
        return json.loads(path.read_text("utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


class Settings(BaseSettings):
    """Global settings loaded from config.json, providers.json, and .env."""

    # ── Port ──────────────────────────────────────────────────────────
    port: int = int(os.environ.get("AUGUST_PROXY_PORT", "8085"))

    # ── Paths ─────────────────────────────────────────────────────────
    project_root: Path = _find_project_root()
    data_dir: Path = Path(os.environ.get(
        "AUGUST_DATA_DIR",
        str(_find_project_root() / "data"),
    ))
    web_dist: Path = _find_project_root() / "web-dist"

    # ── Config cache (lazy-loaded) ────────────────────────────────────
    _config: Dict[str, Any] = {}
    _providers: Dict[str, Any] = {}

    def reload(self) -> None:
        """Re-read config.json and providers.json from disk."""
        config_path = self.data_dir / "config.json"
        providers_path = self.data_dir / "providers.json"

        self._config = _load_json(config_path)
        self._providers = _load_json(providers_path)

    @property
    def config(self) -> Dict[str, Any]:
        if not self._config:
            self.reload()
        return self._config

    @property
    def providers(self) -> Dict[str, Any]:
        if not self._providers:
            self.reload()
        return self._providers

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


settings = Settings()

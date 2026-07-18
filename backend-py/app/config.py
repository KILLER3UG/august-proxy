"""
Settings — loads config.json, providers.json, and .env into Pydantic models.
"""

from __future__ import annotations
import json
import os
from pathlib import Path
from typing import Dict
from pydantic_settings import BaseSettings, SettingsConfigDict


def _findProjectRoot() -> Path:
    """Walk up from this file's location to find the project root."""
    here = Path(__file__).resolve().parent.parent.parent
    return here


def _load_dotenv_files() -> list[str]:
    """Load project .env into ``os.environ`` so GOOGLE_OAUTH_* etc. are available.

    Pydantic ``env_file`` only maps declared Settings fields; OAuth secrets are
    read via ``os.environ`` in service_connections / MCP. Load from project root
    and backend-py so values survive restarts regardless of process cwd.
    """
    loaded: list[str] = []
    try:
        from dotenv import load_dotenv
    except ImportError:
        return loaded
    root = _findProjectRoot()
    candidates = (
        root / '.env',
        root / 'backend-py' / '.env',
        Path.cwd() / '.env',
    )
    seen: set[Path] = set()
    for path in candidates:
        try:
            resolved = path.resolve()
        except OSError:
            continue
        if resolved in seen or not path.is_file():
            continue
        seen.add(resolved)
        # Do not override vars already set in the process environment.
        load_dotenv(path, override=False)
        loaded.append(str(resolved))
    return loaded


# Side effect at import: durable secrets from .env become process env.
_DOTENV_LOADED = _load_dotenv_files()


def _loadJson(path: Path) -> Dict[str, object]:
    try:
        return json.loads(path.read_text('utf-8'))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


class Settings(BaseSettings):
    """Global settings loaded from config.json, providers.json, and .env."""

    port: int = int(os.environ.get('AUGUST_PROXY_PORT', '8085'))
    projectRoot: Path = _findProjectRoot()
    dataDir: Path = Path(os.environ.get('AUGUST_DATA_DIR', str(_findProjectRoot() / 'data')))
    webDist: Path = _findProjectRoot() / 'web-dist'
    gatewayApiKey: str | None = None
    _config: Dict[str, object] = {}
    _providers: Dict[str, object] = {}
    _config_loaded: bool = False

    def reload(self) -> None:
        """Re-read config.json and providers.json from disk."""
        # Refresh .env → os.environ on reload (e.g. after user edits .env).
        _load_dotenv_files()
        configPath = self.dataDir / 'config.json'
        providersPath = self.dataDir / 'providers.json'
        self._config = _loadJson(configPath)
        self._providers = _loadJson(providersPath)
        self._config_loaded = True

    @property
    def config(self) -> Dict[str, object]:
        # Empty {} is a valid on-disk config — do not treat it as "not loaded".
        if not self._config_loaded:
            self.reload()
        return self._config

    @property
    def providers(self) -> Dict[str, object]:
        if not self._config_loaded:
            self.reload()
        return self._providers

    model_config = SettingsConfigDict(
        env_file=str(_findProjectRoot() / '.env'),
        env_file_encoding='utf-8',
        extra='ignore',
    )


settings = Settings()

"""
Settings — loads config.json, providers.json, and .env into Pydantic models.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
from typing import Dict, Optional
from pydantic_settings import BaseSettings, SettingsConfigDict

def _findProjectRoot() -> Path:
    """Walk up from this file's location to find the project root."""
    here = Path(__file__).resolve().parent.parent.parent
    return here

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
    _config: Dict[str, object] = {}
    _providers: Dict[str, object] = {}

    def reload(self) -> None:
        """Re-read config.json and providers.json from disk."""
        configPath = self.dataDir / 'config.json'
        providersPath = self.dataDir / 'providers.json'
        self._config = _loadJson(configPath)
        self._providers = _loadJson(providersPath)

    @property
    def config(self) -> Dict[str, object]:
        if not self._config:
            self.reload()
        return self._config

    @property
    def providers(self) -> Dict[str, object]:
        if not self._providers:
            self.reload()
        return self._providers
    model_config = SettingsConfigDict(env_file='.env', env_file_encoding='utf-8', extra='ignore')
settings = Settings()
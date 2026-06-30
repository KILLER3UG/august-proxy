"""v2: Model fleet for the cognitive layers.

Maps each cognitive role to a model identifier. Users can override via
data/config.json → auxiliary.model_fleet. The 'cortex' role is special:
empty string means "use the session's primary model".

Four roles:
  - cortex:      main session model (Cortex tier — Sonnet 4, GPT-4o)
  - cerebellum:  fast, cheap — for daemons and watchers (Haiku, GPT-4o-mini)
  - hippocampus: moderate reasoning — for consolidation, delta engine,
                 context compaction (Haiku)
  - prefrontal:  highest reasoning — for skill genesis (Sonnet 4, Opus)
"""
import json
import os
DEFAULT_FLEET: dict[str, str] = {'cortex': '', 'cerebellum': 'claude-3-haiku-20240307', 'hippocampus': 'claude-3-haiku-20240307', 'prefrontal': 'claude-3-5-sonnet-20240620'}
_configCache: dict | None = None
_configPath = os.path.join('data', 'config.json')

def _resetCache() -> None:
    """Reset the cached config (for tests)."""
    global _config_cache
    _configCache = None

def _loadConfig() -> dict:
    """Load the user config, cached after first load."""
    global _config_cache
    if _configCache is not None:
        return _configCache
    if not os.path.exists(_configPath):
        _configCache = {}
        return _configCache
    try:
        with open(_configPath, 'r', encoding='utf-8') as f:
            _configCache = json.load(f)
    except (OSError, json.JSONDecodeError):
        _configCache = {}
    return _configCache

def getModelForRole(role: str) -> str:
    """Return the configured model for a role.

    Reads `data/config.json → auxiliary.model_fleet` if present.
    Empty 'cortex' resolves to the session's primary model (caller's
    responsibility — get_model_for_role returns '' and the caller
    uses whatever the session has).
    """
    fleet = DEFAULT_FLEET.copy()
    userFleet = _loadConfig().get('auxiliary', {}).get('model_fleet', {})
    fleet.update(userFleet)
    return fleet.get(role, fleet.get('cortex', ''))
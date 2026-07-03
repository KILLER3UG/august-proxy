"""v2: Model fleet for the cognitive layers.

Maps each cognitive role to a model identifier. Users can override via
data/config.json → auxiliary.model_fleet. All roles default to empty
string, meaning "use the session's primary model".

Four roles:
  - cortex:      main session model (default: session model)
  - cerebellum:  fast, cheap — for daemons and watchers (default: session model)
  - hippocampus: moderate reasoning — for consolidation, delta engine,
                 context compaction (default: session model)
  - prefrontal:  highest reasoning — for skill genesis (default: session model)
"""
import json
import os
DEFAULT_FLEET: dict[str, str] = {'cortex': '', 'cerebellum': '', 'hippocampus': '', 'prefrontal': ''}
_configCache: dict[str, object] | None = None
_configPath = os.path.join('data', 'config.json')

def _resetCache() -> None:
    """Reset the cached config (for tests)."""
    global _configCache
    _configCache = None

def _loadConfig() -> dict[str, object]:
    """Load the user config, cached after first load."""
    global _configCache
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
    config = _loadConfig()
    auxiliary = config.get('auxiliary', {})
    assert isinstance(auxiliary, dict)
    userFleet = auxiliary.get('model_fleet', {})
    assert isinstance(userFleet, dict)
    fleet.update(userFleet)
    return fleet.get(role, fleet.get('cortex', ''))
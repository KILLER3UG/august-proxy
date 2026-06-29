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


DEFAULT_FLEET: dict[str, str] = {
    "cortex":      "",
    "cerebellum":  "claude-3-haiku-20240307",
    "hippocampus": "claude-3-haiku-20240307",
    "prefrontal":  "claude-3-5-sonnet-20240620",
}

_config_cache: dict | None = None
_config_path = os.path.join("data", "config.json")


def _reset_cache() -> None:
    """Reset the cached config (for tests)."""
    global _config_cache
    _config_cache = None


def _load_config() -> dict:
    """Load the user config, cached after first load."""
    global _config_cache
    if _config_cache is not None:
        return _config_cache
    if not os.path.exists(_config_path):
        _config_cache = {}
        return _config_cache
    try:
        with open(_config_path, "r", encoding="utf-8") as f:
            _config_cache = json.load(f)
    except (OSError, json.JSONDecodeError):
        _config_cache = {}
    return _config_cache


def get_model_for_role(role: str) -> str:
    """Return the configured model for a role.

    Reads `data/config.json → auxiliary.model_fleet` if present.
    Empty 'cortex' resolves to the session's primary model (caller's
    responsibility — get_model_for_role returns '' and the caller
    uses whatever the session has).
    """
    fleet = DEFAULT_FLEET.copy()
    user_fleet = _load_config().get("auxiliary", {}).get("model_fleet", {})
    fleet.update(user_fleet)
    return fleet.get(role, fleet.get("cortex", ""))

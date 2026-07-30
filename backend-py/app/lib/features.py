"""Feature flags — gate risky surfaces via AUGUST_FEATURES env var.

Part of Better Harness Plan Phase 6.3.
Disabled features skip init entirely (faster startup, smaller crash surface).
"""

from __future__ import annotations

import os

# All available feature flags and their default state (enabled)
_ALL_FEATURES = {
    'browser': True,
    'desktop': True,
    'gateway_telegram': True,
    'gateway_slack': True,
    'gateway_discord': True,
    'delta_engine': True,
}


def _parse_features() -> dict[str, bool]:
    """Parse AUGUST_FEATURES env var.

    Format: comma-separated feature names to ENABLE.
    If set, only listed features are enabled (all others disabled).
    If unset/empty, all features default to enabled.

    Example: AUGUST_FEATURES=browser,delta_engine
    """
    raw = os.environ.get('AUGUST_FEATURES', '').strip()
    if not raw:
        return dict(_ALL_FEATURES)

    enabled_names = {f.strip().lower() for f in raw.split(',') if f.strip()}
    result = {}
    for feature in _ALL_FEATURES:
        result[feature] = feature in enabled_names
    return result


# Cached at import time (env doesn't change during process)
_features: dict[str, bool] | None = None


def is_enabled(feature: str) -> bool:
    """Check if a feature is enabled."""
    global _features
    if _features is None:
        _features = _parse_features()
    return _features.get(feature, False)


def get_all() -> dict[str, bool]:
    """Get all feature flag states."""
    global _features
    if _features is None:
        _features = _parse_features()
    return dict(_features)


def reset() -> None:
    """Reset cached state (for tests)."""
    global _features
    _features = None

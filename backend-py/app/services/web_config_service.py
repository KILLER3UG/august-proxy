"""Web search/extract config under ``auxiliary.web`` in config.json.

Backends (search): ``ddgs`` (default), ``brave``, ``searxng``, or ``auto``.
Extract compression follows Hermes-style size thresholds.
"""

from __future__ import annotations

import os

from app.json_narrowing import as_bool, as_dict, as_int, as_str
from app.services import config_service

BACKENDS = ('auto', 'ddgs', 'brave', 'searxng')

DEFAULTS: dict[str, object] = {
    'backend': 'auto',
    'braveApiKey': '',
    'searxngUrl': '',
    'extractCompress': True,
    'extractRawMaxChars': 5000,
    'extractSummaryMaxChars': 5000,
    'extractCompressMaxChars': 500_000,
    'extractHardMaxChars': 2_000_000,
    'fetchTimeoutS': 15.0,
}


def get_web_config() -> dict[str, object]:
    cfg = config_service.getConfig()
    user = as_dict(as_dict(cfg.get('auxiliary'), {}).get('web'), {})
    out = dict(DEFAULTS)
    for key, default in DEFAULTS.items():
        if key not in user:
            continue
        if isinstance(default, bool):
            out[key] = as_bool(user.get(key), default)
        elif isinstance(default, int) and not isinstance(default, bool):
            out[key] = as_int(user.get(key), default)
        elif isinstance(default, float):
            try:
                out[key] = float(user.get(key))  # type: ignore[arg-type]
            except (TypeError, ValueError):
                out[key] = default
        else:
            out[key] = as_str(user.get(key), as_str(default))
    # Env overrides (highest priority for secrets / ops).
    env_backend = (os.environ.get('AUGUST_WEB_BACKEND') or '').strip().lower()
    if env_backend in BACKENDS:
        out['backend'] = env_backend
    env_brave = (os.environ.get('BRAVE_SEARCH_API_KEY') or '').strip()
    if env_brave:
        out['braveApiKey'] = env_brave
    env_searx = (os.environ.get('SEARXNG_URL') or '').strip()
    if env_searx:
        out['searxngUrl'] = env_searx
    return out


def resolve_search_backend(cfg: dict[str, object] | None = None) -> str:
    """Return concrete backend id (never ``auto``)."""
    c = cfg or get_web_config()
    chosen = as_str(c.get('backend'), 'auto').strip().lower()
    if chosen in ('ddgs', 'brave', 'searxng'):
        return chosen
    # auto-detect
    if as_str(c.get('braveApiKey')).strip():
        return 'brave'
    if as_str(c.get('searxngUrl')).strip():
        return 'searxng'
    return 'ddgs'


def validate_patch(patch: dict[str, object]) -> tuple[bool, str]:
    for key, value in patch.items():
        if key not in DEFAULTS:
            return False, f'unknown field: {key!r}'
        default = DEFAULTS[key]
        if key == 'backend':
            if not isinstance(value, str) or value.strip().lower() not in BACKENDS:
                return False, f'backend must be one of {BACKENDS}'
            continue
        if isinstance(default, bool):
            if not isinstance(value, bool):
                return False, f'{key!r} must be a boolean'
        elif isinstance(default, (int, float)) and not isinstance(default, bool):
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                return False, f'{key!r} must be a number'
        elif not isinstance(value, str):
            return False, f'{key!r} must be a string'
    return True, ''


def update_web_config(patch: dict[str, object]) -> tuple[bool, str, dict[str, object]]:
    ok, err = validate_patch(patch)
    if not ok:
        return False, err, get_web_config()
    cfg = config_service.getConfig()
    aux = cfg.get('auxiliary')
    if not isinstance(aux, dict):
        aux = {}
        cfg['auxiliary'] = aux
    web = aux.get('web')
    if not isinstance(web, dict):
        web = {}
        aux['web'] = web
    for key, value in patch.items():
        if key == 'backend' and isinstance(value, str):
            web[key] = value.strip().lower()
        else:
            web[key] = value
    config_service.saveConfig(cfg)
    return True, '', get_web_config()


def get_web_config_with_status() -> dict[str, object]:
    c = get_web_config()
    resolved = resolve_search_backend(c)
    return {
        **c,
        'resolvedBackend': resolved,
        'backends': list(BACKENDS),
        'note': (
            'Search backends: ddgs (free), brave (BRAVE_SEARCH_API_KEY), '
            'searxng (SEARXNG_URL). backend=auto picks the first available. '
            'web_search returns snippets only; use web_fetch for page bodies.'
        ),
    }

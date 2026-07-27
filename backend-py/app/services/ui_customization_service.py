"""UI customization (color tokens) stored under ``uiCustomization`` in config.json.

The frontend owns rendering (``frontend/desktop/src/lib/ui-customization.ts``
paints these tokens as CSS variables); this service is the server-side source
of truth so the model can recolor the app via the ``customize_ui`` tool and
changes persist across restarts. Token ids mirror the frontend's
``UI_TOKEN_DEFS`` — keep the two lists in sync.
"""

from __future__ import annotations

import re
from typing import cast

from app.json_narrowing import as_dict, as_str
from app.type_aliases import JsonValue

# Canonical token ids — mirrors UI_TOKEN_DEFS in ui-customization.ts.
UI_TOKEN_IDS: frozenset[str] = frozenset(
    {
        'background',
        'foreground',
        'card',
        'muted',
        'mutedForeground',
        'border',
        'input',
        'chatBackground',
        'chatInputBackground',
        'userBubble',
        'sidebar',
        'sidebarForeground',
        'sidebarAccent',
        'sidebarBorder',
        'primary',
        'primaryForeground',
        'accent',
        'ring',
    }
)

# Named colors the model may speak ("make the chat input gray") — resolved to
# hex before storage; the frontend only accepts hex.
NAMED_COLORS: dict[str, str] = {
    'black': '#000000',
    'white': '#ffffff',
    'gray': '#808080',
    'grey': '#808080',
    'darkgray': '#404040',
    'darkgrey': '#404040',
    'lightgray': '#d3d3d3',
    'lightgrey': '#d3d3d3',
    'slategray': '#708090',
    'red': '#dc2626',
    'green': '#16a34a',
    'blue': '#2563eb',
    'yellow': '#eab308',
    'orange': '#ea580c',
    'purple': '#7c3aed',
    'violet': '#7c3aed',
    'pink': '#db2777',
    'brown': '#92400e',
    'cyan': '#0891b2',
    'teal': '#0d9488',
    'navy': '#1e3a8a',
    'beige': '#f5f5dc',
    'ivory': '#fffff0',
}

_HEX_RE = re.compile(r'^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$')


def resolveColor(value: object) -> str | None:
    """Normalize a hex string or named color to hex; None when unrecognized."""
    raw = as_str(value).strip()
    if not raw:
        return None
    if _HEX_RE.match(raw):
        return raw
    return NAMED_COLORS.get(raw.lower().replace(' ', '').replace('-', ''))


def getCustomization() -> dict[str, str]:
    """Current token → hex map from config.json (validated)."""
    from app.services import config_service

    raw = as_dict(config_service.getConfig().get('uiCustomization'), {})
    out: dict[str, str] = {}
    for key, val in raw.items():
        if key in UI_TOKEN_IDS and _HEX_RE.match(as_str(val)):
            out[key] = as_str(val)
    return out


def _write(customization: dict[str, str], actor: str, before: dict[str, str]) -> None:
    from app.services import config_service

    cfg = config_service.getConfig()
    cfg['uiCustomization'] = customization
    config_service.saveConfig(cfg)
    try:
        from app.services.memory_store import record_config_audit

        record_config_audit(
            'uiCustomization',
            'configure',
            actor,
            before=cast('JsonValue', before),
            after=cast('JsonValue', customization),
        )
    except Exception:
        pass
    # Live-apply in every connected client.
    try:
        from app.services.realtime_bus import emit_invalidate, emit_realtime

        emit_realtime('ui.customization', customization=customization)
        emit_invalidate('ui-customization')
    except Exception:
        pass


def replaceCustomization(
    changes: dict[str, object], actor: str = 'ui'
) -> tuple[dict[str, str], list[str]]:
    """Merge token changes into the stored map.

    A value of None/'' removes that token's override. Returns the full
    resulting map plus a list of human-readable validation errors (invalid
    entries are skipped, valid ones still apply).
    """
    errors: list[str] = []
    before = getCustomization()
    current = dict(before)
    for key, val in changes.items():
        if key not in UI_TOKEN_IDS:
            errors.append(f"Unknown UI token '{key}'. Known tokens: {', '.join(sorted(UI_TOKEN_IDS))}.")
            continue
        if val is None or as_str(val) == '':
            current.pop(key, None)
            continue
        hexVal = resolveColor(val)
        if not hexVal:
            errors.append(
                f"Invalid color '{as_str(val)}' for '{key}' — use hex (#rrggbb) "
                'or a named color (black, white, gray, red, blue, …).'
            )
            continue
        current[key] = hexVal
    _write(current, actor, before)
    return current, errors


def clearCustomization(actor: str = 'ui') -> dict[str, str]:
    """Remove every override (back to theme defaults)."""
    _write({}, actor, getCustomization())
    return {}

"""Post-action desktop observation screenshots.

After mutating desktop_* tools succeed, optionally capture a PNG into
``data/observations/{id}.png`` when ``security.postObservationScreenshot``
is enabled (default true).
"""

from __future__ import annotations

import base64
import logging
import uuid
from datetime import datetime, timezone

from app.json_narrowing import as_dict, as_str
from app.lib.paths import dataPath
from app.services.config_service import getConfig

logger = logging.getLogger('post_observation')

DESKTOP_MUTATING_TOOLS = frozenset(
    {
        'desktop_click',
        'desktop_type',
        'desktop_press_key',
        'desktop_hotkey',
        'desktop_open_url',
        'desktop_scroll',
        'desktop_drag',
        'computer_click',
        'computer_type',
        'computer_key',
        'computer_open',
    }
)


def observations_dir():
    return dataPath('observations')


def count_observations() -> int:
    d = observations_dir()
    if not d.is_dir():
        return 0
    return len(list(d.glob('*.png')))


def latest_observation_meta() -> dict[str, object]:
    d = observations_dir()
    if not d.is_dir():
        return {'lastObservationAt': None, 'lastObservedApp': None}
    files = sorted(d.glob('*.png'), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        return {'lastObservationAt': None, 'lastObservedApp': None}
    newest = files[0]
    at = datetime.fromtimestamp(newest.stat().st_mtime, tz=timezone.utc).isoformat()
    return {'lastObservationAt': at, 'lastObservedApp': None}


def _enabled() -> bool:
    cfg = getConfig()
    sec = as_dict(cfg.get('security')) if cfg.get('security') is not None else {}
    return bool(sec.get('postObservationScreenshot', True))


async def capture_after_tool(tool_name: str, tool_result: str = '') -> dict[str, object] | None:
    """Best-effort screenshot after a successful mutating desktop tool."""
    name = (tool_name or '').strip().lower()
    if name not in DESKTOP_MUTATING_TOOLS:
        return None
    # Skip obvious failures — callers pass the tool result string.
    low = (tool_result or '').lower()
    if low.startswith('tool ') and 'failed' in low[:80]:
        return None
    if '"error"' in low[:200] or low.startswith('error'):
        return None
    if not _enabled():
        return None
    try:
        from app.services.desktop_automation import takeScreenshot

        shot = await takeScreenshot()
        if not isinstance(shot, dict) or shot.get('error') or not shot.get('screenshot'):
            logger.debug('post-observation skip: %s', shot.get('error') if isinstance(shot, dict) else 'no data')
            return None
        raw = base64.b64decode(as_str(shot.get('screenshot')))
        obs_id = uuid.uuid4().hex[:12]
        out_dir = observations_dir()
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f'{obs_id}.png'
        path.write_bytes(raw)
        meta = {
            'id': obs_id,
            'screenshotPath': str(path),
            'capturedAt': datetime.now(timezone.utc).isoformat(),
            'toolName': tool_name,
        }
        return meta
    except Exception:
        logger.debug('post-observation capture failed', exc_info=True)
        return None

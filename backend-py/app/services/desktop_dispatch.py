"""Desktop automation dispatcher — routes an action string to the matching
pyautogui-backed desktop function.

Thin orchestration layer over :mod:`app.services.desktop_automation`.
Distinct from the headless browser automation in :mod:`app.services.browser`:
this layer controls the user's real physical desktop (screen/mouse/keyboard),
while the browser layer drives an invisible Playwright page.

This is also the single choke point where the per-app computer-use policy is
enforced (:mod:`app.services.computer_use_policy`). Both entry points reach the
desktop through ``automateAction`` — the ``desktop_*``/``computer_*`` managed
tools and ``POST /api/desktop-automation/action`` — so one check here covers
both, instead of a prologue at each call site that a new alias could evade.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from app.json_narrowing import as_int, as_str
from app.services.desktop_automation import (
    clickMouse,
    getMousePosition,
    getScreenSize,
    listWindows,
    openUrl,
    pressKey,
    takeScreenshot,
    typeText,
)

# Actions that act ON something rather than merely reading the screen. A
# per-APP policy is meaningless for a screenshot, so only these are gated.
_GATED_ACTIONS = frozenset({'click', 'type', 'press', 'navigate'})


async def _enforceAppPolicy(
    action: str, params: dict[str, object]
) -> dict[str, object] | None:
    """Apply the per-app computer-use policy. Delegates — the verdict and the
    consequence both live in :mod:`app.services.computer_use_policy`."""
    from app.services.computer_use_policy import enforceDesktopAction

    return await enforceDesktopAction(action, params=params)


async def automateAction(
    action: str,
    params: dict[str, object] | None = None,
    *,
    _appPolicyChecked: bool = False,
) -> dict[str, object] | list[dict[str, object]]:
    """Execute a desktop automation action by name.

    Recognised actions: ``screenshot``, ``mouse_position``, ``screen_size``,
    ``click`` (x, y, button), ``type`` (text), ``press`` (key), ``navigate``
    (url — opens the default visible browser), ``list_windows``.

    ``_appPolicyChecked`` is internal: a denied/asked action must not re-enter
    through the approval replay path and be re-evaluated against a window that
    has since changed. The workbench sets it when replaying an approved call.
    """
    params = params or {}
    if action in _GATED_ACTIONS and not _appPolicyChecked:
        denial = await _enforceAppPolicy(action, params)
        if denial is not None:
            return denial
    actions: dict[str, Callable[[], Awaitable[Any]]] = {
        'screenshot': lambda: takeScreenshot(),
        'mouse_position': lambda: getMousePosition(),
        'screen_size': lambda: getScreenSize(),
        'click': lambda: clickMouse(
            as_int(params.get('x'), 0), as_int(params.get('y'), 0), as_str(params.get('button'), 'left')
        ),
        'type': lambda: typeText(as_str(params.get('text'), '')),
        'press': lambda: pressKey(as_str(params.get('key'), '')),
        'navigate': lambda: openUrl(as_str(params.get('url'), '')),
        'list_windows': lambda: listWindows(),
    }
    handler = actions.get(action)
    if not handler:
        return {'error': f'Unknown action: {action}'}
    return await handler()

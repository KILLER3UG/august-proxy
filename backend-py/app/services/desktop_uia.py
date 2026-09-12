"""Accessibility-first desktop control (Windows UIA element tree).

The pixel path (``desktop_automation``: pyautogui screenshot + click x,y)
keeps working everywhere. This module adds the accessibility-first mode —
the shape of the computer-use tooling in the ZCode/claude-code harnesses:
read a window's real UIA element tree once, then act on elements BY
REFERENCE (click/type/focus) — no vision round-trip per action, no
coordinate guessing, works while the window is partially covered.

Windows-only: the ``uiautomation`` wheel is not installable elsewhere and
UIA is a Windows API. On other platforms (or if the package is missing)
every entry point returns an honest receipt pointing back at pixel mode —
the tools still register, so model prompts stay stable across platforms.

Element refs are a module-level cache of the LAST tree walk; the raw COM
element handles go stale when the UI changes, so a failed action tells the
model to re-read the tree rather than pretending to retry.
"""

from __future__ import annotations

import logging
import sys
import time
from typing import Any

log = logging.getLogger(__name__)

_mod: Any = None
_tried = False

# refs from the last desktop_ui_tree walk: int ref -> live UIA element.
_refs: dict[int, Any] = {}
_refs_at: float = 0.0

_MAX_NODES_DEFAULT = 200
_MAX_DEPTH_DEFAULT = 6

_ACTIONS = ('click', 'double_click', 'right_click', 'type', 'focus')


def available() -> bool:
    """True when the uiautomation package is importable on Windows."""
    global _mod, _tried
    if _tried:
        return _mod is not None
    _tried = True
    if sys.platform != 'win32':
        return False
    try:
        import uiautomation  # type: ignore[import-not-found]

        _mod = uiautomation
    except Exception as exc:  # pragma: no cover - import-time only
        log.info('desktop_uia: uiautomation unavailable: %s', exc)
        _mod = None
    return _mod is not None


_UNAVAILABLE = {
    'ok': False,
    'error': (
        'UIA accessibility mode is unavailable (Windows-only, needs the '
        'uiautomation package). Fall back to pixel mode: desktop_screenshot '
        '+ desktop_click / desktop_type.'
    ),
}


def _short(text: str, cap: int = 60) -> str:
    t = ' '.join((text or '').split())
    return t[:cap] + '…' if len(t) > cap else t


def _rect_str(ctl: Any) -> str:
    try:
        r = ctl.BoundingRectangle
        return f'{r.left},{r.top},{r.right},{r.bottom}'
    except Exception:
        return '-'


def _describe_element(ctl: Any) -> tuple[str, str]:
    """(ControlTypeName, name-or-empty) for one element — tolerant of dead
    COM handles (returns ('?', '') instead of raising)."""
    try:
        return str(ctl.ControlTypeName), str(ctl.Name or '')
    except Exception:
        return '?', ''


def describe_tree(
    window_hint: str = '',
    max_nodes: int = _MAX_NODES_DEFAULT,
    max_depth: int = _MAX_DEPTH_DEFAULT,
) -> dict[str, Any]:
    """Walk the target window's UIA tree into numbered lines + a ref cache.

    ``window_hint`` is a case-insensitive title substring; empty = the
    foreground window. Returns ``{ok, window, count, tree}`` — the tree
    lines look like ``[7] ButtonControl "OK" id=btnOk rect=1,2,3,4``.
    """
    if not available():
        return dict(_UNAVAILABLE)
    auto = _mod
    try:
        root = auto.GetRootControl()
        top_windows = root.GetChildren()
    except Exception as exc:
        return {'ok': False, 'error': f'UIA root walk failed: {exc}'}

    target = None
    hint = (window_hint or '').strip().lower()
    for w in top_windows:
        _, name = _describe_element(w)
        if hint and hint in name.lower():
            target = w
            break
    if target is None and not hint:
        try:
            target = auto.GetForegroundWindowControl()
        except Exception:
            target = None
    if target is None:
        names = []
        for w in top_windows[:20]:
            _, n = _describe_element(w)
            if n:
                names.append(_short(n, 40))
        return {
            'ok': False,
            'error': f'no visible window matches {window_hint!r}',
            'windows': names,
        }

    refs: dict[int, Any] = {}
    lines: list[str] = []
    count = 0
    try:
        queue: list[tuple[Any, int]] = [(target, 0)]
        while queue and count < int(max_nodes or _MAX_NODES_DEFAULT):
            ctl, depth = queue.pop(0)
            if depth > int(max_depth or _MAX_DEPTH_DEFAULT):
                continue
            ctype, name = _describe_element(ctl)
            try:
                aid = str(ctl.AutomationId or '')
            except Exception:
                aid = ''
            count += 1
            refs[count] = ctl
            line = f'[{count}] {ctype.removesuffix("Control")} "{_short(name)}"'
            if aid:
                line += f' id={_short(aid, 30)}'
            line += f' rect={_rect_str(ctl)}'
            if depth:
                line = '  ' * min(depth, 6) + line
            lines.append(line)
            try:
                queue.extend((child, depth + 1) for child in ctl.GetChildren())
            except Exception:
                pass
    except Exception as exc:
        return {'ok': False, 'error': f'UIA walk failed: {exc}'}

    _, wname = _describe_element(target)
    _refs.clear()
    _refs.update(refs)
    global _refs_at
    _refs_at = time.time()
    return {
        'ok': True,
        'window': _short(wname, 120),
        'count': count,
        'tree': '\n'.join(lines),
        'note': f'act on any [ref] via desktop_ui_act(ref, action in {_ACTIONS})',
    }


def act(ref: int, action: str = 'click', text: str = '') -> dict[str, Any]:
    """Perform ``action`` on the element captured under ``ref`` by the last
    tree walk. Stale handles come back as an explicit re-read receipt."""
    if not available():
        return dict(_UNAVAILABLE)
    act_norm = (action or 'click').strip().lower()
    if act_norm not in _ACTIONS:
        return {'ok': False, 'error': f'unknown action {action!r} (use one of {_ACTIONS})'}
    ctl = _refs.get(int(ref or 0))
    if ctl is None:
        return {
            'ok': False,
            'error': f'no element ref {ref} — call desktop_ui_tree first '
            '(refs expire when the UI changes)',
        }
    _, name = _describe_element(ctl)
    try:
        if act_norm == 'click':
            ctl.Click()
        elif act_norm == 'double_click':
            ctl.DoubleClick()
        elif act_norm == 'right_click':
            ctl.RightClick()
        elif act_norm == 'focus':
            ctl.SetFocus()
        elif act_norm == 'type':
            if not (text or '').strip():
                return {'ok': False, 'error': 'action=type needs non-empty text'}
            try:
                ctl.SetFocus()
            except Exception:
                pass
            ctl.SendKeys(str(text))
    except Exception as exc:
        return {
            'ok': False,
            'error': f'UIA action failed (element or window changed?): {exc} — re-read desktop_ui_tree',
        }
    return {'ok': True, 'ref': int(ref), 'action': act_norm, 'element': _short(name, 80)}


def reset_for_tests() -> None:
    _refs.clear()

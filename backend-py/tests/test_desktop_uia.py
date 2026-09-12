"""UIA accessibility desktop mode — tree walk, refs, actions, receipts.

uiautomation is faked at the module slot (tests must not touch a real
desktop); the unavailable path is exercised directly.
"""

from __future__ import annotations

import pytest
from app.services import desktop_uia as duia


class FakeRect:
    left, top, right, bottom = 10, 20, 300, 200


class FakeCtl:
    def __init__(self, ctype, name, children=None, aid=''):
        self.ControlTypeName = ctype
        self.Name = name
        self.AutomationId = aid
        self.BoundingRectangle = FakeRect()
        self._children = children or []
        self.clicks = 0
        self.double_clicks = 0
        self.typed: list[str] = []
        self.focused = 0

    def GetChildren(self):
        return self._children

    def Click(self):
        self.clicks += 1

    def DoubleClick(self):
        self.double_clicks += 1

    def RightClick(self):
        pass

    def SetFocus(self):
        self.focused += 1

    def SendKeys(self, text):
        self.typed.append(text)


class FakeRoot(FakeCtl):
    def __init__(self, windows):
        super().__init__('Window', '', children=windows)


class FakeAuto:
    def __init__(self, windows, foreground):
        self._root = FakeRoot(windows)
        self._fg = foreground

    def GetRootControl(self):
        return self._root

    def GetForegroundWindowControl(self):
        return self._fg


@pytest.fixture()
def fake_uia(monkeypatch):
    """Pretend uiautomation loaded; give each test a clean ref cache."""
    restore = (duia._mod, duia._tried)  # noqa: SLF001
    duia._tried = True  # noqa: SLF001
    duia.reset_for_tests()
    yield duia, monkeypatch
    duia._mod, duia._tried = restore  # noqa: SLF001
    duia.reset_for_tests()


def _install(monkeypatch, auto):
    monkeypatch.setattr(duia, '_mod', auto)  # noqa: SLF001


def test_unavailable_receipt(fake_uia, monkeypatch):
    duia, _ = fake_uia
    monkeypatch.setattr(duia, '_mod', None)  # noqa: SLF001
    out = duia.describe_tree('anything')
    assert out['ok'] is False and 'pixel mode' in out['error']
    out = duia.act(1, 'click')
    assert out['ok'] is False and 'pixel mode' in out['error']


def test_tree_walk_by_hint_and_foreground(fake_uia, monkeypatch):
    duia, mp = fake_uia
    button = FakeCtl('ButtonControl', 'OK', aid='btnOk')
    edit = FakeCtl('EditControl', 'Find field')
    notepad = FakeCtl('WindowControl', 'Untitled - Notepad', children=[button, edit])
    other = FakeCtl('WindowControl', 'Terminal')
    _install(mp, FakeAuto([other, notepad], notepad))

    out = duia.describe_tree('notepad')
    assert out['ok'] is True
    assert 'Untitled - Notepad' in out['window']
    assert '[1] Window "Untitled - Notepad"' in out['tree']
    assert 'Button "OK" id=btnOk' in out['tree']
    assert 'Edit "Find field"' in out['tree']
    assert out['count'] == 3

    # No hint -> foreground window.
    out2 = duia.describe_tree('')
    assert 'Untitled - Notepad' in out2['window']
    # Unknown hint -> window list receipt.
    out3 = duia.describe_tree('zzz')
    assert out3['ok'] is False and 'Terminal' in out3['windows']


def test_actions_and_stale_refs(fake_uia, monkeypatch):
    duia, mp = fake_uia
    button = FakeCtl('ButtonControl', 'OK')
    edit = FakeCtl('EditControl', 'Field')
    win = FakeCtl('WindowControl', 'App', children=[button, edit])
    _install(mp, FakeAuto([win], win))
    duia.describe_tree('app')

    assert duia.act(2, 'click')['ok'] is True and button.clicks == 1
    assert duia.act(2, 'double_click')['ok'] is True and button.double_clicks == 1
    assert duia.act(3, 'type', text='hello')['ok'] is True and edit.typed == ['hello']
    assert edit.focused == 1

    stale = duia.act(99, 'click')
    assert stale['ok'] is False and 'desktop_ui_tree' in stale['error']
    assert duia.act(2, 'teleport')['ok'] is False
    assert duia.act(3, 'type', text='')['ok'] is False


def test_ref_cache_replaced_per_walk(fake_uia, monkeypatch):
    duia, mp = fake_uia
    a = FakeCtl('ButtonControl', 'A')
    w1 = FakeCtl('WindowControl', 'Win1', children=[a])
    _install(mp, FakeAuto([w1], w1))
    duia.describe_tree('win1')
    assert duia.act(2, 'click')['element'] == 'A'
    b = FakeCtl('ButtonControl', 'B')
    w2 = FakeCtl('WindowControl', 'Win2', children=[b])
    _install(mp, FakeAuto([w2], w2))
    duia.describe_tree('win2')
    # Ref 2 now resolves in the NEW walk — old handles must not survive.
    assert duia.act(2, 'click')['element'] == 'B'
    assert duia.act(3, 'click')['ok'] is False


def test_tools_registered():
    from app.services import tool_registry
    from app.services.tool_registrations import desktop_tools

    desktop_tools.register()
    assert tool_registry.get('desktop_ui_tree') is not None
    assert tool_registry.get('desktop_ui_act') is not None

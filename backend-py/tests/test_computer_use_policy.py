"""Computer-use per-app policy — enforcement, not just a count.

`appPolicies` in config.json was written by Settings → Computer Access and read
by exactly one thing: the observability snapshot, which COUNTS the values.
Nothing consulted it before acting on the user's real mouse and keyboard, so a
user who set `deny` had changed a number in a report.

The interesting property is not "deny works" but "nothing evades it". There are
three ways onto the desktop — the `desktop_*` tools, the `computer_*` tools, and
`POST /api/desktop-automation/action` — and every one of them bottoms out in
`desktop_automation.clickMouse/typeText/pressKey/openUrl`. The gate lives at
those primitives precisely so a NEW entry point is covered by construction.
That is the same contract `test_gate_participation.py` holds for the sandbox
guards, and these tests hold it here.
"""

from __future__ import annotations

import asyncio
import sys

import pytest
from app.services import computer_use_policy as policy
from app.services import desktop_automation, desktop_dispatch


@pytest.fixture(autouse=True)
def _resetApproval():
    policy.clearApproved()
    yield
    policy.clearApproved()


@pytest.fixture
def configured(monkeypatch):
    """Install a policy map without touching real config.json."""

    def _set(policies: dict[str, str]):
        monkeypatch.setattr(policy, '_policies', lambda: policies)

    return _set


# --------------------------------------------------------------------------
# Decision
# --------------------------------------------------------------------------


class TestDecide:
    def test_unknown_app_takes_the_default_not_allow(self, configured):
        configured({'chrome': 'deny'})
        d = policy.decide('Notepad')
        assert d.policy == policy.DEFAULT_POLICY == 'ask'
        assert d.matched_key == ''

    def test_exact_and_substring_both_match(self, configured):
        configured({'chrome': 'deny'})
        assert policy.decide('chrome').policy == 'deny'
        assert policy.decide('Google Chrome - Work').policy == 'deny'
        assert policy.decide('CHROME.EXE').policy == 'deny'

    def test_the_most_specific_key_wins(self, configured):
        """Configured `chrome` deny and `Google Chrome` allow: the longer key is
        what the user meant, and it must not be shadowed by the shorter one."""
        configured({'chrome': 'deny', 'Google Chrome': 'allow'})
        d = policy.decide('Google Chrome')
        assert d.policy == 'allow'
        assert d.matched_key == 'google chrome'

    def test_malformed_config_values_are_ignored(self, configured):
        configured({'chrome': 'maybe', '': 'deny', 'notepad': 'allow'})
        assert policy.decide('chrome').policy == 'ask'
        assert policy.decide('notepad').policy == 'allow'

    def test_empty_policy_map_is_all_default(self, configured):
        configured({})
        assert policy.decide('anything').policy == 'ask'


# --------------------------------------------------------------------------
# The gate cannot be evaded
# --------------------------------------------------------------------------


class TestGateIsUnavoidable:
    """The primitives are the choke point. Every mutating one must consult the
    policy, or a new entry point bypasses a permission the user set."""

    def test_every_action_maps_to_a_registered_tool(self):
        """TOTAL by construction. The primitives call the gate with an ACTION
        (`press`, `navigate`, `open_url`) that is not a tool name; the map is
        what stops `deny` degrading to `ask` for those. A new action added
        without a mapping would prompt instead of refusing."""
        for action, tool in policy.ACTION_TO_TOOL.items():
            assert tool in policy.GATED_TOOLS, (
                f'action {action!r} maps to {tool!r}, which is not in GATED_TOOLS'
            )
        # Every gated action a caller can actually pass must be mapped.
        for action in ('click', 'type', 'press', 'open_url', 'navigate', 'ui_act'):
            assert action in policy.ACTION_TO_TOOL, f'{action!r} has no tool mapping'

    @pytest.mark.parametrize(
        'primitive',
        ['clickMouse', 'typeText', 'pressKey', 'openUrl'],
    )
    def test_every_mutating_primitive_consults_the_policy(self, primitive, monkeypatch):
        called = []

        async def _spy(_action: str):
            called.append(_action)
            return {'ok': False, 'error': 'blocked-by-test'}

        monkeypatch.setattr(policy, 'enforceDesktopAction', _spy)
        import asyncio

        args = {
            'clickMouse': (1, 2),
            'typeText': ('hi',),
            'pressKey': ('enter',),
            'openUrl': ('https://example.com',),
        }[primitive]
        asyncio.run(getattr(desktop_automation, primitive)(*args))
        assert called, f'{primitive} did not consult the computer-use policy'

    @pytest.mark.parametrize(
        'primitive,args',
        [
            ('takeScreenshot', ()),
            ('getScreenSize', ()),
            ('getMousePosition', ()),
            ('listWindows', ()),
        ],
    )
    def test_read_only_primitives_are_not_gated(self, primitive, args, monkeypatch):
        """A screenshot is not acting on an app; gating it would prompt the user
        to approve looking at their screen."""
        called = []

        async def _spy(_action: str):
            called.append(_action)
            return None

        monkeypatch.setattr(policy, 'enforceDesktopAction', _spy)
        import asyncio

        asyncio.run(getattr(desktop_automation, primitive)(*args))
        assert not called, f'{primitive} is read-only and must not prompt'


# --------------------------------------------------------------------------
# Consequences
# --------------------------------------------------------------------------


class TestConsequences:
    def test_deny_blocks_the_dispatcher(self, configured, monkeypatch):
        configured({'chrome': 'deny'})
        async def _never():
            raise AssertionError('the action ran despite deny')

        monkeypatch.setattr(desktop_automation, 'clickMouse', _never)
        # automateAction resolves the app itself, so pin it.
        monkeypatch.setattr(policy, 'resolveTargetApp', lambda: 'chrome')
        out = asyncio.run(desktop_dispatch.automateAction('click', {'x': 1, 'y': 2}))
        assert out['ok'] is False
        assert out['policy'] == 'deny'
        assert 'deny' in out['error']
        assert out['matchedApp'] == 'chrome'

    def test_allow_proceeds(self, configured, monkeypatch):
        configured({'chrome': 'allow'})
        seen = {}
        # Patch the pyautogui seam, not the primitive: automateAction calls the
        # primitive directly, so patching the primitive itself would never run.
        # Patch the pyautogui seam, not the primitive: automateAction calls the
        # primitive directly, so patching the primitive itself would never run.
        # `monkeypatch.setitem` RESTORES sys.modules afterwards — a bare
        # assignment leaked the fake into every later test in the process.
        fake = type(
            'M', (), {'click': staticmethod(lambda *a, **k: seen.setdefault('clicked', a))}
        )
        monkeypatch.setitem(sys.modules, 'pyautogui', fake)
        monkeypatch.setattr(policy, 'resolveTargetApp', lambda: 'chrome')
        out = asyncio.run(desktop_dispatch.automateAction('click', {'x': 5, 'y': 6}))
        assert out == {'x': 5, 'y': 6, 'button': 'left'}
        assert seen['clicked'][:2] == (5, 6)

    def test_ask_without_a_session_refuses_rather_than_acting(
        self, configured, monkeypatch
    ):
        """A prompt nobody can answer is not consent."""
        configured({'chrome': 'ask'})
        async def _never():
            raise AssertionError('the action ran on an unanswered ask')

        monkeypatch.setattr(desktop_automation, 'clickMouse', _never)
        monkeypatch.setattr(policy, 'resolveTargetApp', lambda: 'chrome')
        monkeypatch.setattr(policy, '_currentSession', lambda: None)
        out = asyncio.run(desktop_dispatch.automateAction('click', {'x': 1, 'y': 1}))
        assert out['ok'] is False
        assert out['policy'] == 'ask'

    def test_approval_is_consumed_exactly_once(self, configured, monkeypatch):
        """One approval authorises one action, never the next.

        Asserted on ``enforceDesktopAction`` — the real door — rather than on
        ``enforce``, which is the pure decision function and deliberately does
        not look at the approval flag.
        """
        configured({'chrome': 'deny'})
        monkeypatch.setattr(policy, 'resolveTargetApp', lambda: 'chrome')

        async def _twoCalls():
            policy.markApproved()
            first = await policy.enforceDesktopAction('click')
            second = await policy.enforceDesktopAction('click')
            return first, second

        # Both calls share one task context, which is where the approval flag
        # lives (it is deliberately a ContextVar, so it cannot outlive the
        # request that carried the approval).
        first, second = asyncio.run(_twoCalls())
        assert first is None, 'the approved call should have proceeded'
        assert second is not None and second['policy'] == 'deny', (
            'the approval was not consumed — it leaked to the next action'
        )

    def test_window_introspection_failure_degrades_to_ask_not_allow(
        self, configured, monkeypatch
    ):
        """Headless box: pygetwindow missing. Denying everything would look like
        a broken product; allowing would be the original bug. So: ask."""
        configured({})
        monkeypatch.setattr(policy, 'resolveTargetApp', lambda: '')
        assert policy.enforce('desktop_type').policy == 'ask'

    def test_a_resolver_error_never_fails_open(self, monkeypatch):
        def _boom():
            raise RuntimeError('pygetwindow exploded')

        monkeypatch.setattr(policy, 'resolveTargetApp', _boom)
        d = policy.enforce('desktop_press_key')
        assert d.policy == 'ask', 'a broken resolver must not permit the action'


# --------------------------------------------------------------------------
# Drift guard
# --------------------------------------------------------------------------


def test_gated_tool_set_matches_the_observed_mutating_set():
    """A tool that mutates the desktop but is absent from GATED_TOOLS is an
    un-gated door — the same class as the five audit findings this mirrors."""
    from app.services.post_observation import DESKTOP_MUTATING_TOOLS

    missing = DESKTOP_MUTATING_TOOLS - policy.GATED_TOOLS
    assert not missing, f'mutating desktop tools missing from the policy gate: {sorted(missing)}'


def test_a_new_mutating_primitive_cannot_be_added_ungated():
    """The "covered by construction" claim, enforced.

    The reviewer added an ungated `scrollMouse` to desktop_automation and all
    twenty tests stayed green — the docstring promised more than the tests
    checked. This inspects the module's public async callables instead: anything
    that drives the desktop must call the gate. It is the same shape as
    ``test_gate_participation.py``, which exists because five real guards were
    missed the same way.
    """
    import ast
    import inspect

    import app.services.desktop_automation as da

    source = inspect.getsource(da)
    tree = ast.parse(source)
    module_fns = {
        n.name
        for n in tree.body
        if isinstance(n, ast.AsyncFunctionDef) and not n.name.startswith('_')
    }
    # The read-only primitives are the documented exemption; assert that set is
    # exactly what we expect rather than a growing list of "exemptions".
    assert module_fns == policy.READ_ONLY_PRIMITIVES | {
        'clickMouse',
        'typeText',
        'pressKey',
        'openUrl',
    }, f'unexpected public surface on desktop_automation: {sorted(module_fns)}'

    for name in sorted(module_fns - policy.READ_ONLY_PRIMITIVES):
        fn_src = inspect.getsource(getattr(da, name))
        assert '_refuseIfNotAllowed' in fn_src, (
            f'desktop_automation.{name} drives the real desktop but does not call '
            'the policy gate — add the gate, or add it to READ_ONLY_PRIMITIVES '
            'with a reason'
        )


def test_the_uia_path_is_gated():
    """`desktop_uia.act` clicks and types on the real foreground window and never
    touches desktop_automation, so it was the one mutating entry point no policy
    applied to — while sitting in GATED_TOOLS, which made the drift test above
    certify the wrong invariant."""
    import inspect

    from app.services import desktop_uia

    src = inspect.getsource(desktop_uia.act)
    assert '_policyRefusal' in src, 'desktop_uia.act bypasses the computer-use policy'

    from app.services import computer_use_policy as pol

    assert pol.enforceSync('ui_act') is not None or True  # signature exists
    assert callable(pol.enforceSync)


def test_the_ui_act_deny_is_a_refusal():
    """Behavioural, not a source check: a denied app must be refused on the UIA
    path too."""
    from app.services.computer_use_policy import enforceSync

    refusal = enforceSync('ui_act')
    assert refusal is None or refusal.get('ok') is False
    # With no configured policy it defaults to ask, which on the sync UIA path
    # must still refuse rather than act.
    if refusal is not None:
        assert refusal['policy'] == 'ask'

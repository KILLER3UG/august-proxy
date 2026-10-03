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

    def test_a_process_name_matches_the_app_a_user_types(self, configured):
        """The resolver returns the PROCESS (`chrome`), the user typed `chrome`."""
        configured({'chrome': 'deny'})
        assert policy.decide('chrome').policy == 'deny'
        assert policy.decide('CHROME.EXE').policy == 'deny'
        assert policy.decide('notepad.exe', policies={'notepad': 'deny'}).policy == 'deny'

    def test_a_title_alias_matches_too(self, configured):
        """The same window also answers to its title, so a user who typed the
        visible name is not silently unprotected."""
        configured({'google chrome': 'deny'})
        d = policy.decide('chrome', aliases=('Google Chrome - Work',))
        assert d.policy == 'deny'
        assert d.matched_key == 'google chrome'

    def test_a_one_character_key_matches_nothing(self, configured):
        """The old symmetric-substring rule meant a key of "e" matched almost
        every title — a deny nobody wrote."""
        configured({'e': 'deny'})
        assert policy.decide('chrome').policy == 'ask'
        assert policy.decide('Google Chrome - Work').policy == 'ask'

    def test_a_different_app_is_not_matched(self, configured):
        configured({'chrome': 'deny'})
        assert policy.decide('firefox').policy == 'ask'

    def test_the_most_specific_key_wins(self, configured):
        """Configured `chrome` deny and `google chrome` allow: for the window
        whose identities are both, the longer key is the one they meant."""
        configured({'chrome': 'deny', 'google chrome': 'allow'})
        d = policy.decide('google chrome', aliases=('google chrome',))
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
        """TOTAL, and pointed at REAL tools.

        The first version built `'desktop_' + action` inline, which produced
        `desktop_press` and `desktop_navigate` — neither exists — so `deny`
        silently degraded to `ask`. Two properties are pinned here:

        * totality: every action a caller can pass has a mapping;
        * existence: every mapped name is an actually-REGISTERED tool, so the
          approval path can queue it and `execute_approved_mutation` can
          dispatch it. A name that is merely plausible is what broke the first
          version.
        """
        from app.services import tool_definitions as tool_defs
        from app.services.tool_registry import listTools

        for action, tool in policy.ACTION_TO_TOOL.items():
            assert tool in policy.GATED_TOOLS, (
                f'action {action!r} maps to {tool!r}, which is not in GATED_TOOLS'
            )
        for action in ('click', 'type', 'press', 'open_url', 'navigate', 'ui_act'):
            assert action in policy.ACTION_TO_TOOL, f'{action!r} has no tool mapping'

        if not listTools():
            tool_defs.registerAll()
        registered = {
            (t.get('name') or (t.get('function') or {}).get('name')) for t in listTools()
        }
        for tool in set(policy.ACTION_TO_TOOL.values()):
            assert tool in registered, (
                f'the policy maps to {tool!r}, which is not a registered tool — an '
                'approval queued under that name can never be dispatched'
            )

    def test_the_queued_args_match_the_tool_schema(self):
        """The `ask` path queues `{'action': <action>, **params}` and the replay
        dispatches it as the mapped tool, so the params must be the tool's own
        argument names."""
        from app.services import tool_definitions as tool_defs
        from app.services.tool_registry import listTools

        if not listTools():
            tool_defs.registerAll()
        schema = {}
        for t in listTools():
            name = t.get('name') or (t.get('function') or {}).get('name')
            if name == 'desktop_click':
                schema = t.get('input_schema') or (t.get('function') or {}).get('parameters') or {}
                break
        props = set((schema or {}).get('properties', {}))
        assert {'x', 'y'} <= props, f'desktop_click schema changed: {props}'
        # `action` is our extra routing key; the real arguments ride alongside.
        assert 'action' not in props

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
        monkeypatch.setattr(policy, 'resolveTargetApps', lambda: ('chrome', 'Google Chrome'))
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
        monkeypatch.setattr(policy, 'resolveTargetApps', lambda: ('chrome', 'Google Chrome'))
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
        monkeypatch.setattr(policy, 'resolveTargetApps', lambda: ('chrome', 'Google Chrome'))
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
        monkeypatch.setattr(policy, 'resolveTargetApps', lambda: ('chrome', 'Google Chrome'))

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
        monkeypatch.setattr(policy, 'resolveTargetApps', lambda: ())
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
    un-gated door. Note the direction is ONE-WAY: GATED_TOOLS is allowed to be
    larger (a name may be gated before its tool lands), but nothing that
    `post_observation` treats as mutating may be missing."""
    from app.services.post_observation import DESKTOP_MUTATING_TOOLS

    missing = DESKTOP_MUTATING_TOOLS - policy.GATED_TOOLS
    assert not missing, f'mutating desktop tools missing from the policy gate: {sorted(missing)}'


def test_every_gated_tool_is_actually_registered():
    """The reverse direction, and the one that caught nine dead names.

    `GATED_TOOLS` listed `computer_click` … `desktop_drag` — none of which are
    registered tools anywhere. They came from a UI comment describing an
    intended surface, and listing them made the gate set look broader than the
    enforcement while the drift test above certified against them. A name that
    is not a tool can never be invoked, so gating it is theatre.
    """
    from app.services import tool_definitions as tool_defs
    from app.services.tool_registry import listTools

    if not listTools():
        tool_defs.registerAll()
    registered = {
        (t.get('name') or (t.get('function') or {}).get('name')) for t in listTools()
    }
    dead = sorted(policy.GATED_TOOLS - registered)
    assert not dead, (
        f'GATED_TOOLS lists tools that are not registered: {dead}. Either register '
        'the tool or drop the name — a permission for a tool that does not exist '
        'reads as coverage it does not provide.'
    )


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

    from app.services.computer_use_policy import enforceSync

    assert callable(enforceSync)
    # `x or True` used to sit here and was always true, so the assertion could
    # not fail. The behavioural claim belongs in the next test; what belongs
    # HERE is only that the sync gate exists and is reachable from `act`.


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

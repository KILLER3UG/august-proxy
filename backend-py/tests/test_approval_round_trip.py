"""The approval round-trip: ask → queue → approve → execute.

This is the one branch the unit tests could not reach, because it needs the
whole chain wired together:

    computer_use_policy.enforceDesktopAction   (the ask)
      → workbench.createPendingMutation        (queue + realtime event)
      → POST /mutations/respond               (the card's Accept)
      → consumePendingMutation                 (pop + record the grant)
      → execute_approved_mutation               (dispatch, under the approval)
      → _executeTool → desktop_automation      (the primitive, which re-checks)

Every step either works or the permission is theatre. The last link is the
subtle one: the primitive consults the policy AGAIN on replay, so without the
approval flag the user's own Approve would be answered with a second prompt.
That is what these tests pin — and they drive the real functions rather than
mocking the boundary, because a mock at the boundary proves nothing about
whether the chain is connected.
"""

from __future__ import annotations

import pytest
from app.services import computer_use_policy as policy


def _rebind(tool_name: str, handler) -> None:
    """Point a registered tool at a fake handler for the duration of a test.

    Dispatch reads ``_registry[name]['handler']``. `listTools()` returns COPIES,
    so patching one is a no-op — which is how a whole round-trip test can be
    green while the real handler never runs. Patch the live registry entry.
    """
    from app.services import tool_registry

    tool = tool_registry._registry.get(tool_name)  # noqa: SLF001
    if not tool:
        raise AssertionError(f'{tool_name} is not registered')
    tool['handler'] = handler


@pytest.fixture(autouse=True)
def _cleanApproval():
    policy.clearApproved()
    yield
    policy.clearApproved()


@pytest.fixture
def deniedChrome(monkeypatch):
    """chrome is set to deny; the resolver reports it in front."""
    monkeypatch.setattr(policy, '_policies', lambda: {'chrome': 'deny'})
    monkeypatch.setattr(policy, 'resolveTargetApps', lambda: ('chrome', 'Chrome - Work'))


@pytest.fixture
def askChrome(monkeypatch):
    """chrome is set to ASK — the path that must produce a token."""
    monkeypatch.setattr(policy, '_policies', lambda: {'chrome': 'ask'})
    monkeypatch.setattr(policy, 'resolveTargetApps', lambda: ('chrome', 'Chrome - Work'))


class TestTheAskQueuesARealMutation:
    async def test_ask_returns_a_token_and_does_not_act(self, askChrome, monkeypatch):
        from app.services.workbench import workbench as wb

        clicked = []

        async def _never(*_a, **_k):
            clicked.append(1)
            raise AssertionError('the desktop action ran before approval')

        monkeypatch.setattr('app.services.desktop_automation.clickMouse', _never)

        session = wb.createWorkbenchSession(provider='stub-anthropic')
        refusal = await policy.enforceDesktopAction(
            'click', params={'x': 1, 'y': 2}
        )
        assert refusal is not None, 'ask produced no refusal'
        assert refusal['policy'] == 'ask'
        assert not clicked

        # Queue it the way the gate does, and confirm the machinery accepts it.
        from app.services.workbench.workbench import createPendingMutation

        mutation = createPendingMutation(
            session, 'desktop_click', {'action': 'click', 'x': 1, 'y': 2}
        )
        assert mutation and mutation.get('token'), mutation
        assert mutation['toolName'] == 'desktop_click'

        # The session is now awaiting approval and the token is consumable.
        assert session.status == 'awaiting_approval'
        consumed = wb.consumePendingMutation(str(mutation['token']))
        assert consumed is not None
        assert consumed['toolName'] == 'desktop_click'


class TestTheApproveReplaysTheAction:
    """These drive the GATE, not a hand-built mutation.

    The previous version queued the mutation itself, with `action` in the args
    on one side and without it on the other — so the two halves never met, and
    the test passed while production was broken. In the real chain
    `createPendingMutation` was handed `{'action': 'click', 'x': 11, 'y': 22}`
    under the name `desktop_click`, whose schema is `{x, y, button}`: on replay
    the extra key failed validation and every desktop approval except `ui_act`
    returned a TypeError. Only a test that asks the GATE for its own args can
    catch that.
    """

    @staticmethod
    def _register():
        from app.services import tool_definitions as tool_defs
        from app.services.tool_registry import listTools

        if not listTools():
            tool_defs.registerAll()

    @pytest.mark.parametrize(
        'action,params',
        [
            ('click', {'x': 11, 'y': 22}),
            ('type', {'text': 'hello'}),
            ('press', {'key': 'enter'}),
            ('open_url', {'url': 'https://example.test/'}),
        ],
    )
    async def test_the_gates_own_args_replay_through_the_primitives(
        self, askChrome, monkeypatch, action, params
    ):
        import app.services.desktop_automation as desk
        from app.services.workbench import workbench as wb

        self._register()

        seen: list[tuple] = []

        async def _click(x, y, button='left'):
            seen.append(('click', x, y))
            return {'ok': True}

        async def _type(text):
            seen.append(('type', text))
            return {'ok': True}

        async def _press(key):
            seen.append(('press', key))
            return {'ok': True}

        async def _open(url):
            seen.append(('open_url', url))
            return {'ok': True}

        # Patch the REGISTRY'S handler, not the module attribute: each tool is
        # registered with a direct reference to the primitive
        # (`_desktop.clickMouse`), captured at registration time, so
        # monkeypatching the module does not change what dispatch calls.
        _rebind('desktop_click', _click)
        _rebind('desktop_type', _type)
        _rebind('desktop_press_key', _press)
        _rebind('desktop_open_url', _open)

        session = wb.createWorkbenchSession(provider='stub-anthropic')
        monkeypatch.setattr(policy, '_currentSession', lambda: session)

        refusal = await policy.enforceDesktopAction(action, params=dict(params))
        assert refusal is not None and refusal.get('pendingToken'), (
            f'{action} queued no token: {refusal}'
        )
        assert refusal['policy'] == 'ask'

        consumed = wb.consumePendingMutation(refusal['pendingToken'])
        assert consumed is not None
        # The queued args must already be the tool's own schema — no routing key.
        assert 'action' not in (consumed.get('args') or {}), (
            f"{action}: queued args still carry the dispatcher routing key, which "
            'the tool schema rejects on replay'
        )

        approval = policy.markApproved()
        try:
            out = await wb.execute_approved_mutation(
                session, consumed['toolName'], consumed.get('args')
            )
        finally:
            policy.clearApproved(approval)

        assert 'Error' not in out, f'{action} replayed broken: {out}'
        assert seen, f'{action} never reached the primitive'

    async def test_the_ui_act_tool_keeps_its_action_argument(
        self, askChrome, monkeypatch
    ):
        """`desktop_ui_act` really is parameterised by action, so it keeps it.
        The shape is per-tool, which is why it lives in `_queuedArgs`."""
        from app.services.workbench import workbench as wb

        self._register()
        session = wb.createWorkbenchSession(provider='stub-anthropic')
        monkeypatch.setattr(policy, '_currentSession', lambda: session)

        refusal = await policy.enforceDesktopAction('ui_act', params={'ref': 3})
        assert refusal is not None and refusal.get('pendingToken')
        consumed = wb.consumePendingMutation(refusal['pendingToken'])
        assert consumed['toolName'] == 'desktop_ui_act'
        assert (consumed.get('args') or {}).get('action') == 'ui_act'

    async def test_the_approval_does_not_leak_to_the_next_action(
        self, deniedChrome, monkeypatch
    ):
        """One approval authorises one action. If the flag leaked, a SECOND
        denied click would slip through unreviewed."""
        import app.services.desktop_automation as desk
        from app.services.workbench import workbench as wb

        self._register()
        seen: list[tuple] = []

        async def _click(x, y, button='left'):
            seen.append((x, y))
            return {'ok': True}

        _rebind('desktop_click', _click)

        session = wb.createWorkbenchSession(provider='stub-anthropic')
        from app.services.workbench.workbench import createPendingMutation

        token = createPendingMutation(session, 'desktop_click', {'x': 1, 'y': 1})['token']
        consumed = wb.consumePendingMutation(token)

        approval = policy.markApproved()
        try:
            await wb.execute_approved_mutation(
                session, consumed['toolName'], consumed.get('args')
            )
        finally:
            policy.clearApproved(approval)
        assert seen == [(1, 1)]

        # The next call goes back through the gate and is denied again.
        again = await policy.enforceDesktopAction('click', params={'x': 2, 'y': 2})
        assert again is not None and again['policy'] == 'deny'
        assert seen == [(1, 1)], 'the flag leaked into a second action'


class TestDenyNeverQueuesAnything:
    async def test_a_denied_action_returns_no_token(self, deniedChrome):
        refusal = await policy.enforceDesktopAction('click', params={'x': 1, 'y': 2})
        assert refusal is not None
        assert refusal['policy'] == 'deny'
        assert 'pendingToken' not in refusal, 'a deny must not offer something to approve'
        assert 'deny' in refusal['error'].lower()

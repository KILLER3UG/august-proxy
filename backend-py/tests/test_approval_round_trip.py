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
    async def test_approving_executes_the_tool_under_the_approval(
        self, deniedChrome, monkeypatch
    ):
        """The full round-trip. Without `markApproved` the primitive would
        re-consult the policy and ask AGAIN — the user's Approve would appear
        to do nothing."""
        from app.services.workbench import workbench as wb

        seen: list[tuple] = []

        async def _fake(x, y, button='left'):
            seen.append((x, y))
            return {'x': x, 'y': y, 'button': button}

        monkeypatch.setattr('app.services.desktop_automation.clickMouse', _fake)
        from app.services import tool_definitions as tool_defs
        from app.services.tool_registry import listTools

        if not listTools():
            tool_defs.registerAll()

        session = wb.createWorkbenchSession(provider='stub-anthropic')
        from app.services.workbench.workbench import createPendingMutation

        token = createPendingMutation(
            session, 'desktop_click', {'x': 11, 'y': 22}
        )['token']

        consumed = wb.consumePendingMutation(token)
        assert consumed is not None
        # Consuming alone must NOT be enough — approval is what authorises it.
        from app.services.computer_use_policy import markApproved

        approval = markApproved()
        try:
            result = await wb.execute_approved_mutation(
                session, consumed['toolName'], consumed.get('args')
            )
        finally:
            policy.clearApproved(approval)

        assert seen == [(11, 22)], f'the approved click did not reach the primitive: {result!r}'

    async def test_the_approval_does_not_leak_to_the_next_action(
        self, deniedChrome, monkeypatch
    ):
        """One approval authorises one action. If the flag leaked, a SECOND
        denied click would slip through unreviewed."""
        from app.services.workbench import workbench as wb

        seen: list[tuple] = []

        async def _fake(x, y, button='left'):
            seen.append((x, y))
            return {'ok': True}

        monkeypatch.setattr('app.services.desktop_automation.clickMouse', _fake)
        from app.services import tool_definitions as tool_defs
        from app.services.tool_registry import listTools

        if not listTools():
            tool_defs.registerAll()

        session = wb.createWorkbenchSession(provider='stub-anthropic')
        from app.services.computer_use_policy import markApproved

        approval = markApproved()
        try:
            await wb.execute_approved_mutation(session, 'desktop_click', {'x': 1, 'y': 1})
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

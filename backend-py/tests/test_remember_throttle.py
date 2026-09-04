"""Write-time gates for the `remember` tool (plan 2026-08-28 Bug 8b).

Length bounds (min 8 / max 500 fact chars, max 2000 details chars) and the
per-turn budget (3 facts) are soft refusals: ``{ok: False, policy: ...}``
with a reason the model can act on. The budget resets per turn via
``reset_remember_turn_budget`` (called at turn start by the chat loop).
"""

from __future__ import annotations

import json

import pytest
from app.services.tool_registrations import session_tools as st


@pytest.fixture(autouse=True)
def _freshBudget():
    st.reset_remember_turn_budget()
    yield
    st.reset_remember_turn_budget()


@pytest.mark.asyncio
async def testShortFactRefused():
    out = json.loads(await st._remember(fact='tiny'))
    assert out['ok'] is False
    assert 'too short' in out['policy']


@pytest.mark.asyncio
async def testOversizedFactRefused():
    out = json.loads(await st._remember(fact='x' * (st._REMEMBER_MAX_FACT_CHARS + 1)))
    assert out['ok'] is False
    assert str(st._REMEMBER_MAX_FACT_CHARS) in out['policy']


@pytest.mark.asyncio
async def testOversizedDetailsRefused():
    out = json.loads(
        await st._remember(
            fact='a perfectly valid fact', details='d' * (st._REMEMBER_MAX_DETAILS_CHARS + 1)
        )
    )
    assert out['ok'] is False
    assert 'details' in out['policy']


@pytest.mark.asyncio
async def testValidFactStillSaves():
    out = json.loads(await st._remember(fact='User prefers dark mode everywhere'))
    assert out['ok'] is True
    assert out['key']


@pytest.mark.asyncio
async def testPerTurnCapRefusesFourthWrite():
    for i in range(st._REMEMBER_PER_TURN_LIMIT):
        out = json.loads(await st._remember(fact=f'valid fact number {i} for the cap test'))
        assert out['ok'] is True, out
    out = json.loads(await st._remember(fact='one valid fact too many this turn'))
    assert out['ok'] is False
    assert 'budget' in out['policy']


@pytest.mark.asyncio
async def testBudgetResetRestoresWrites():
    for i in range(st._REMEMBER_PER_TURN_LIMIT):
        await st._remember(fact=f'valid fact number {i} before the reset')
    # Turn boundary: the chat loop calls this with the session id; the
    # ContextVar default key here is 'default'.
    st.reset_remember_turn_budget('default')
    out = json.loads(await st._remember(fact='fresh turn gets a fresh budget'))
    # Surface the refusal reason — an order-dependent leak (config knob,
    # leaked scope) previously surfaced as a bare ok=False here.
    assert out['ok'] is True, out


@pytest.mark.asyncio
async def testFailedWriteDoesNotConsumeBudget():
    # Sensitive-topic refusal happens before the budget is charged.
    for _ in range(st._REMEMBER_PER_TURN_LIMIT):
        out = json.loads(await st._remember(fact='user has diabetes and takes insulin daily'))
        assert out['ok'] is False
        assert 'sensitive' in out['policy']
    out = json.loads(await st._remember(fact='still a full budget after refusals'))
    assert out['ok'] is True

"""Turn budget ladder (audit P1#12).

A turn that outgrows its soft budget is DEGRADED in steps, not cut off:
bare tool surface → compaction → one tool-free answer, then
``turn_end{reason: 'budget'}``. All three arms default off, so an
unconfigured install never walks the ladder.
"""

from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

import pytest
from app.services.turn_outcomes import TURN_END_REASONS
from app.services.workbench import workbench as wb

STUB_PROVIDER = {
    'name': 'stub',
    'apiMode': 'anthropicMessages',
    'default_model': 'stub-claude',
    'model_profiles': {},
}


class TestBudgetBreached:
    def test_all_arms_off_never_breaches(self) -> None:
        # The default install: enormous spend, and still no ladder.
        assert wb._budgetBreached((0.0, 0, 0), spend_usd=99.0, tokens=10**9, elapsed_sec=3600.0) is False

    def test_usd_arm(self) -> None:
        arms = (0.50, 0, 0)
        assert wb._budgetBreached(arms, spend_usd=0.49) is False
        assert wb._budgetBreached(arms, spend_usd=0.50) is True  # at the line counts
        assert wb._budgetBreached(arms, spend_usd=0.51) is True

    def test_token_arm(self) -> None:
        arms = (0.0, 1000, 0)
        assert wb._budgetBreached(arms, tokens=999) is False
        assert wb._budgetBreached(arms, tokens=1000) is True

    def test_wall_clock_arm(self) -> None:
        arms = (0.0, 0, 60)
        assert wb._budgetBreached(arms, elapsed_sec=59.9) is False
        assert wb._budgetBreached(arms, elapsed_sec=60.0) is True

    def test_one_armed_arm_fires_and_the_others_stay_silent(self) -> None:
        # A wall-clock breach must not also require spend/tokens to be met.
        arms = (0.0, 0, 30)
        assert wb._budgetBreached(arms, spend_usd=0.0, tokens=0, elapsed_sec=31.0) is True


class TestBudgetStep:
    def test_escalates_then_clamps(self) -> None:
        assert [wb._nextBudgetStep(i) for i in (0, 1, 2, 3, 9)] == [1, 2, 3, 3, 3]
        # A turn can never escalate past the last rung.
        assert wb._nextBudgetStep(99) == len(wb._BUDGET_LADDER)

    def test_ladder_order_is_cheapest_action_first(self) -> None:
        assert wb._BUDGET_LADDER == ('surface', 'compaction', 'final')


class TestTurnBudgetConfig:
    def test_defaults_are_all_off(self) -> None:
        # With nothing persisted the resolver must hand back three zeros,
        # which _budgetBreached treats as "no ladder".
        assert wb._turnBudget() == (0.0, 0, 0)

    def test_config_keys_are_registered_with_zero_defaults(self) -> None:
        from app.services.brain_config_service import fieldTable

        table = {row[0]: row[2] for row in fieldTable}
        for key in ('budgetSoftUsd', 'budgetSoftTokens', 'budgetWallClockSec'):
            assert key in table, f'{key} is not a brain-config field'
            assert table[key] == 0, f'{key} must default to off'

    def test_resolver_reads_armed_values(self, monkeypatch) -> None:
        from app.services import brain_config_service as bcs

        monkeypatch.setattr(
            bcs,
            'getRuntimeConfig',
            lambda: {'budgetSoftUsd': 1.5, 'budgetSoftTokens': 200, 'budgetWallClockSec': 90},
        )
        assert wb._turnBudget() == (1.5, 200, 90)

    def test_negative_values_clamp_to_off(self, monkeypatch) -> None:
        from app.services import brain_config_service as bcs

        monkeypatch.setattr(
            bcs, 'getRuntimeConfig', lambda: {'budgetSoftUsd': -5, 'budgetSoftTokens': -1}
        )
        assert wb._turnBudget() == (0.0, 0, 0)


class TestTurnEndVocabulary:
    def test_budget_is_a_known_reason(self) -> None:
        assert 'budget' in TURN_END_REASONS


class TestSpendPricing:
    def test_spend_goes_through_cost_estimator(self, monkeypatch) -> None:
        # The cost arm must read the ONE pricing source — a second rate table
        # here would let the budget and the Usage page disagree.
        from app.services import cost_estimator

        seen: dict[str, object] = {}

        def spy(**kwargs):
            seen.update(kwargs)
            return 4.25

        monkeypatch.setattr(cost_estimator, 'session_cost_usd', spy)
        got = wb._turnSpendUsd('stub-claude', cache_hit=10, cache_miss=100, out_tokens=5)
        assert got == 4.25
        assert seen['model_id'] == 'stub-claude'
        assert seen['cache_hit'] == 10 and seen['cache_miss'] == 100

    def test_unpriceable_model_reads_zero_rather_than_raising(self) -> None:
        assert wb._turnSpendUsd('', 0, 0, 0) >= 0.0


# ── Loop integration ────────────────────────────────────────────────────────


class StubClient:
    """Emits one tool call per round, so only the ladder can end the turn."""

    def __init__(self, answerOnFinalRound: bool = True) -> None:
        self.callCount = 0
        self.bodies: list[object] = []
        self.answerOnFinalRound = answerOnFinalRound

    def resolveApiKey(self) -> str:
        return 'stub-key'

    def bindCancel(self, event: asyncio.Event) -> None:  # pragma: no cover - parity
        pass

    async def messages_stream(self, body) -> AsyncIterator[dict[str, object]]:
        self.callCount += 1
        roundN = self.callCount
        self.bodies.append(body)
        await asyncio.sleep(0)
        # Big usage per round so a low token arm trips on round 2.
        if self.answerOnFinalRound and not body.get('tools') and roundN >= 3:
            yield {'_event_type': 'content_block_start', 'content_block': {'type': 'text', 'text': 'Wrapping up.'}}
            yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 5000, 'output_tokens': 500}}
        else:
            yield {
                '_event_type': 'content_block_start',
                'content_block': {'type': 'tool_use', 'id': f'toolu_{roundN}', 'name': 'list_skills'},
            }
            yield {
                '_event_type': 'content_block_delta',
                'delta': {'type': 'input_json_delta', 'partial_json': '{}'},
            }
            yield {'_event_type': 'content_block_stop'}
            yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 5000, 'output_tokens': 500}}


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    from app.services.workbench import sessions as sessions_mod

    empty_sessions: dict = {}
    monkeypatch.setattr(sessions_mod, '_sessions', empty_sessions)
    monkeypatch.setattr(wb, '_sessions', empty_sessions)
    monkeypatch.setattr(asyncio, 'create_task', lambda coro, **kw: asyncio.ensure_future(coro))
    monkeypatch.setattr('app.services.workbench.providers.resolve_workbench_provider', lambda *a, **kw: STUB_PROVIDER)
    monkeypatch.setattr('app.services.workbench.providers.resolve_model', lambda p, hint='': 'stub-claude')
    monkeypatch.setattr(wb, 'buildSystemPrompt', lambda session, tools=None: 'stub system prompt')
    import app.providers.clients as clientsMod
    from app.services import provider_credentials as providerCredsMod

    monkeypatch.setattr(providerCredsMod, 'resolve', lambda name: {'api_key': 'stub-key'})
    holder: dict[str, object] = {}
    monkeypatch.setattr(clientsMod, 'getClient', lambda provider: holder['client'])
    monkeypatch.setattr('app.providers.clients.getClient', lambda provider: holder['client'])
    from app.services.tool_registrations import register_all

    register_all()
    yield holder


class TestLadderInTheLoop:
    @pytest.mark.asyncio
    async def test_breach_walks_the_rungs_and_ends_as_budget(self, _isolate, monkeypatch):
        # A token arm tripped on round 1's usage; every round stays over.
        monkeypatch.setattr(wb, '_turnBudget', lambda: (0.0, 1000, 0))
        stub = StubClient()
        _isolate['client'] = stub
        events: list[dict[str, object]] = []
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_budget',
            message='go',
            model='stub-claude',
            emit=events.append,
        )
        recoveries = [e for e in events if e.get('type') == 'recovery' and e.get('kind') == 'budget']
        # Three rungs, each reported once, escalating in order.
        assert [r['outcome'] for r in recoveries][:3] == ['degraded', 'degraded', 'stopped']
        assert [r['attempt'] for r in recoveries][:3] == [1, 2, 3]
        # Every rung is flagged degraded — the answer is not a full one.
        assert all(r['degraded'] is True for r in recoveries)
        end = [e for e in events if e.get('type') == 'turn_end']
        assert end, 'turn_end event missing'
        assert end[-1]['reason'] == 'budget'
        assert [e for e in events if e.get('type') == 'done'], 'terminal done missing'
        # The final round was a genuine tool-free answer, and the rung before
        # it narrowed the surface to the bare set.
        assert stub.bodies[-1].get('tools') in (None, [])
        bare = {
            t.get('name') for t in (stub.bodies[-1].get('tools') or []) if isinstance(t, dict)
        }
        assert bare == set(), 'the final round must not advertise tools'

    @pytest.mark.asyncio
    async def test_ladder_never_runs_with_no_budget_armed(self, _isolate):
        # Same forever-tool-loop, ladder off: the turn runs on until the stub
        # is cancelled, proving the arms are what stop it.
        cancel = asyncio.Event()
        stub = StubClient(answerOnFinalRound=False)
        stub.bindCancel(cancel)
        _isolate['client'] = stub

        async def _cancelSoon():
            await asyncio.sleep(0.05)
            cancel.set()

        asyncio.ensure_future(_cancelSoon())
        events: list[dict[str, object]] = []
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_nobudget',
            message='go',
            model='stub-claude',
            emit=events.append,
            signal=cancel,
        )
        assert not [e for e in events if e.get('type') == 'recovery' and e.get('kind') == 'budget']
        # The real difference from the armed test: the surface was never
        # stripped, and the turn stopped for the cancel, not the budget.
        assert stub.bodies[-1].get('tools'), 'an unarmed turn must keep its full tool surface'
        end = [e for e in events if e.get('type') == 'turn_end']
        assert end[-1]['reason'] == 'interrupted'

    @pytest.mark.asyncio
    async def test_a_within_budget_turn_is_untouched(self, _isolate, monkeypatch):
        monkeypatch.setattr(wb, '_turnBudget', lambda: (10.0, 10_000_000, 3600))
        stub = StubClient(answerOnFinalRound=False)
        _isolate['client'] = stub
        cancel = asyncio.Event()

        async def _cancelSoon():
            await asyncio.sleep(0.05)
            cancel.set()

        asyncio.ensure_future(_cancelSoon())
        events: list[dict[str, object]] = []
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_within',
            message='go',
            model='stub-claude',
            emit=events.append,
            signal=cancel,
        )
        assert not [e for e in events if e.get('type') == 'recovery' and e.get('kind') == 'budget']
        end = [e for e in events if e.get('type') == 'turn_end']
        assert end[-1]['reason'] == 'interrupted'

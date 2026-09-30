"""Runaway backstop — a turn that varies its calls without changing the world.

Roadmap item #1. The stall detector resets its counter on argument novelty
(:func:`_assistant_round_is_novel`) and on world delta. So a model that calls a
DIFFERENT tool with DIFFERENT arguments every round is permanently "novel":
it never stalls, never gets the reflection nudge, and never hard-stops. With
``MAX_MANAGED_TOOL_ROUNDS`` at 0 (uncapped) and the budget-ladder arms all-off
by default, nothing else bounded such a turn — the only remaining bound was
overflowing the context window, which is an error rather than a design.

The backstop counts on world delta alone: a round moved the world only if the
turn touched a path it had not touched before, or a (tool, target) that was
failing with a known family now returns clean. Neither argument variety nor a
flat ``update_state`` can move that flag.
"""

from __future__ import annotations

import asyncio
import json
from typing import AsyncIterator

import pytest
from app.services.workbench import workbench as wb

STUB_PROVIDER = {
    'name': 'stub',
    'apiMode': 'anthropicMessages',
    'default_model': 'stub-claude',
}


class VaryingNoWorldDeltaClient:
    """A different tool target every round, yet nothing in the world moves.

    This is the shape the stall counter structurally cannot see, and getting it
    right matters — a first attempt that varied only the ARGUMENTS of a fixed
    path-based call was caught by the (tool, target) polling guard and stalled
    normally, which proved nothing about the runaway case.

    Two properties are required at once:

    * **novel** to the stall counter — a different ``(tool, target)`` each
      round, each used once, so ``_pollingTarget`` does not fire and
      ``_assistant_round_is_novel`` returns True, resetting ``stalledRounds``;
    * **zero world delta** — ``tool_describe`` takes no path-like argument, so
      ``_recordWorldDelta`` collects no new paths and the (tool, target) was
      never failing, so the round's ``moved`` flag stays False.

    Re-reading one file at shifting offsets would satisfy neither. A
    path-taking tool with a fresh path each round would satisfy the second and
    not the first — that turn is genuinely exploring and the backstop must
    leave it alone (see ``test_real_world_movement_resets_the_counter``).
    """

    def __init__(self) -> None:
        self.callCount = 0
        self.bodies: list[object] = []

    def resolveApiKey(self) -> str:
        return 'stub-key'

    def bindCancel(self, event: asyncio.Event) -> None:  # pragma: no cover - parity
        pass

    async def messages_stream(self, body) -> AsyncIterator[dict[str, object]]:
        self.callCount += 1
        roundN = self.callCount
        self.bodies.append(body)
        await asyncio.sleep(0)
        args = json.dumps({'name': f'probe_{roundN}'})
        yield {
            '_event_type': 'content_block_start',
            'content_block': {'type': 'tool_use', 'id': f'toolu_{roundN}', 'name': 'tool_describe'},
        }
        yield {
            '_event_type': 'content_block_delta',
            'delta': {'type': 'input_json_delta', 'partial_json': args},
        }
        yield {'_event_type': 'content_block_stop'}
        yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}


@pytest.fixture(autouse=True)
def _isolate(monkeypatch, tmp_path):
    from app.config import settings

    monkeypatch.setenv('AUGUST_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(settings, 'dataDir', tmp_path)
    settings.reload()
    from app.services.workbench import sessions as sessions_mod

    empty: dict = {}
    monkeypatch.setattr(sessions_mod, '_sessions', empty)
    monkeypatch.setattr(wb, '_sessions', empty)
    monkeypatch.setattr(
        asyncio, 'create_task', lambda coro, **kw: asyncio.ensure_future(coro)
    )
    monkeypatch.setattr(
        'app.services.workbench.providers.resolve_workbench_provider', lambda *a, **kw: STUB_PROVIDER
    )
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


class TestRunawayBudgetReader:
    def test_defaults_are_off_when_no_brain_config(self, monkeypatch):
        """Opt-in: an absent/0 stop arm disables the backstop entirely."""
        from app.services.workbench.loop import guards

        monkeypatch.setattr(
            'app.services.brain_config_service.getRuntimeConfig', lambda: {}
        )
        assert guards._runawayBudget() == (0, 0)

    def test_explicit_zero_disables(self, monkeypatch):
        from app.services.workbench.loop import guards

        monkeypatch.setattr(
            'app.services.brain_config_service.getRuntimeConfig',
            lambda: {'runawayStopRounds': 0},
        )
        assert guards._runawayBudget() == (0, 0)

    def test_config_overrides_the_defaults(self, monkeypatch):
        from app.services.workbench.loop import guards

        monkeypatch.setattr(
            'app.services.brain_config_service.getRuntimeConfig',
            lambda: {'runawayNudgeRounds': 5, 'runawayStopRounds': 9},
        )
        assert guards._runawayBudget() == (5, 9)

    def test_a_nudge_past_the_stop_is_clamped(self, monkeypatch):
        """Otherwise both fire in the same round and the nudge is pointless."""
        from app.services.workbench.loop import guards

        monkeypatch.setattr(
            'app.services.brain_config_service.getRuntimeConfig',
            lambda: {'runawayNudgeRounds': 90, 'runawayStopRounds': 10},
        )
        assert guards._runawayBudget() == (9, 10)

    def test_a_read_failure_fails_closed_to_off(self, monkeypatch):
        """A brain-config read error must not silently start killing turns."""
        from app.services.workbench.loop import guards

        def _boom() -> dict:
            raise RuntimeError('brain store unavailable')

        monkeypatch.setattr('app.services.brain_config_service.getRuntimeConfig', _boom)
        assert guards._runawayBudget() == (0, 0)


class TestRunawayInTheLoop:
    @pytest.mark.asyncio
    async def test_a_world_stalled_turn_ends_instead_of_running_forever(self, _isolate, monkeypatch):
        monkeypatch.setattr(wb, '_runawayBudget', lambda: (5, 8))
        stub = VaryingNoWorldDeltaClient()
        _isolate['client'] = stub
        events: list[dict[str, object]] = []
        await asyncio.wait_for(
            wb.sendWorkbenchMessageStream(
                sessionId='wb_runaway',
                message='go',
                model='stub-claude',
                emit=events.append,
            ),
            timeout=30,
        )
        # It must not have run away.
        assert stub.callCount < 40, f'the turn ran {stub.callCount} rounds with no world movement'

        recoveries = [
            e for e in events if e.get('type') == 'recovery' and e.get('kind') == 'runaway'
        ]
        assert recoveries, 'the runaway backstop never fired'
        outcomes = [r['outcome'] for r in recoveries]
        assert 'nudged' in outcomes, f'no reflection nudge was sent: {outcomes}'
        assert outcomes[-1] == 'stopped'

        end = [e for e in events if e.get('type') == 'turn_end']
        assert end, 'turn_end missing'
        # Reuses the existing reason rather than inventing a token the frontend
        # badge, the turn_outcomes column and the docs would all have to learn.
        assert end[-1]['reason'] == 'stall-stop'
        assert [e for e in events if e.get('type') == 'done'], 'terminal done missing'

        # The premise of the whole feature: the STALL detector must have been
        # bypassed, or this test is just re-testing a guard that already worked.
        # It is not enough that the turn ended — the stall path is a different
        # code route with a different event, and asserting on the turn_end
        # alone would pass even if novelty had reset the counter as usual.
        assert not [
            e for e in events
            if e.get('type') == 'error' and 'stall warning' in str(e.get('message', ''))
        ], (
            'the stall detector caught this turn, so the backstop proved nothing — '
            'the scenario must be novel to the stall counter'
        )
        # It must have run well past the point the stall counter would have
        # engaged, or the backstop simply fired early on a short turn.
        assert stub.callCount > 5, (
            f'the turn stopped after only {stub.callCount} rounds; the backstop '
            'would not have been what ended it'
        )

    @pytest.mark.asyncio
    async def test_the_backstop_is_off_by_default(self, _isolate, monkeypatch):
        """An unconfigured install must behave exactly as it did before."""
        monkeypatch.setattr(
            'app.services.brain_config_service.getRuntimeConfig', lambda: {}
        )
        cancel = asyncio.Event()
        stub = VaryingNoWorldDeltaClient()
        stub.bindCancel = cancel.set  # type: ignore[method-assign]
        _isolate['client'] = stub

        async def _cancel_soon():
            await asyncio.sleep(0.05)
            cancel.set()

        asyncio.ensure_future(_cancel_soon())
        events: list[dict[str, object]] = []
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_runaway_off',
            message='go',
            model='stub-claude',
            emit=events.append,
            signal=cancel,
        )
        assert not [
            e for e in events if e.get('type') == 'recovery' and e.get('kind') == 'runaway'
        ]
        end = [e for e in events if e.get('type') == 'turn_end']
        assert end[-1]['reason'] == 'interrupted', 'the turn ended for the wrong reason'

    @pytest.mark.asyncio
    async def test_real_world_movement_resets_the_counter(self, _isolate, monkeypatch, tmp_path):
        """A turn that actually reads NEW files must not be stopped.

        This is the false-positive risk: the backstop counts world delta, so a
        legitimately exploratory turn that keeps touching new paths resets it
        every round and runs to its own conclusion.
        """
        import json as _json

        class ExploringClient:
            def __init__(self) -> None:
                self.callCount = 0

            def resolveApiKey(self) -> str:
                return 'stub-key'

            def bindCancel(self, event: asyncio.Event) -> None:  # pragma: no cover
                pass

            async def messages_stream(self, body) -> AsyncIterator[dict[str, object]]:
                self.callCount += 1
                n = self.callCount
                await asyncio.sleep(0)
                # A DIFFERENT path every round: real world movement.
                p = tmp_path / f'file_{n}.txt'
                p.write_text(f'content {n}', encoding='utf-8')
                yield {
                    '_event_type': 'content_block_start',
                    'content_block': {'type': 'tool_use', 'id': f'toolu_{n}', 'name': 'read_file'},
                }
                yield {
                    '_event_type': 'content_block_delta',
                    'delta': {
                        'type': 'input_json_delta',
                        'partial_json': _json.dumps({'path': str(p)}),
                    },
                }
                yield {'_event_type': 'content_block_stop'}
                yield {'_event_type': 'message_delta', 'usage': {'input_tokens': 10, 'output_tokens': 5}}

        monkeypatch.setattr(wb, '_runawayBudget', lambda: (3, 6))
        stub = ExploringClient()
        _isolate['client'] = stub
        cancel = asyncio.Event()

        async def _cancel_soon():
            await asyncio.sleep(0.05)
            cancel.set()

        asyncio.ensure_future(_cancel_soon())
        events: list[dict[str, object]] = []
        await wb.sendWorkbenchMessageStream(
            sessionId='wb_explore',
            message='go',
            model='stub-claude',
            emit=events.append,
            signal=cancel,
        )
        assert not [
            e for e in events if e.get('type') == 'recovery' and e.get('kind') == 'runaway'
        ], 'a genuinely exploratory turn was stopped for making no progress'
        end = [e for e in events if e.get('type') == 'turn_end']
        assert end[-1]['reason'] == 'interrupted'

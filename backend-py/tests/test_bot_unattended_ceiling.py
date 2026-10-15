"""Bot-to-Bot runaway ceiling — DS Bot item 4 (`MAX_UNATTENDED_MESSAGES`).

The reference ships three chain budgets in `ds-bot/src/host/constants.js`:
`MAX_HOPS = 6`, `MAX_UNATTENDED_MESSAGES = 40` with the comment **"reset only by
a human"**, and `MAX_UNREAD_REQUESTS = 10`. August's DM path already had two
caps and neither covers the class:

* `has_inflight(from→to)` bounds ONE pair of concurrent DMs, and
* `rooms.MAX_ROUNDS` bounds ONE user send in a group room.

A three-Bot cycle is neither. And the loop's own runaway backstop cannot see it
either: it counts world delta **inside one turn**, while every DM hop is a fresh
turn in a **different session**, so the whole team can hand one ask around
forever with every individual turn ending `finished`. The only thing that
bounds that is a ceiling on how long a Bot chat may keep working with no human
in it.

This is opt-in (`maxUnattendedTurns`), like every rule in this codebase that can
stop work: an absent key means OFF, not the shipped number.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from app.services.bot_mode import dm


@pytest.fixture()
def bots(isolatedData):
    from app.services.memory_store import init as init_store
    from app.services.tools import agent_registry

    init_store()
    a = agent_registry.createAgent(name='alpha', description='Alpha bot', role='')
    b = agent_registry.createAgent(name='beta', description='Beta bot', role='')
    return {'alpha': str(a['id']), 'beta': str(b['id'])}


def _canonical(agent_id: str):
    from app.services.bot_mode import roster

    return roster.ensure_canonical_bot_chat(agent_id)


@pytest.fixture(autouse=True)
def _resetSessionContext():
    """A leaked `currentSessionId` re-keys the remember budget and the scope
    resolution in LATER test files (full-suite order dependency, named as such
    in test_bot_mode_phase_c) — clear it after every test here."""
    yield
    from app.services.workbench.context import currentSessionId

    currentSessionId.set('')


def _set_current(session):
    from app.services.workbench.context import currentSessionId

    return currentSessionId.set(session.id)


def _seed(sessionId: str, *turns: tuple[str, str]) -> None:
    """Append (role, content) rows in order through the real write door."""
    from app.services import memory_store

    for role, content in turns:
        memory_store.save_message(sessionId, role, content)


def _botTurn(handle: str, text: str) -> str:
    return f'{dm.BOT_TURN_PREFIX}{handle} (@{handle}):\n{text}'


def _armCeiling(monkeypatch, value: int) -> None:
    monkeypatch.setattr(
        'app.services.brain_config_service.getRuntimeConfig',
        lambda: {'maxUnattendedTurns': value},
    )


class TestProvenanceIsReadFromPersistedRows:
    def test_a_bot_run_is_counted_until_a_human_breaks_it(self, bots):
        sid = _canonical(bots['alpha']).id
        _seed(
            sid,
            ('user', 'do the thing'),
            ('assistant', 'on it'),
            ('user', _botTurn('beta', 'report attached')),
            ('assistant', 'thanks'),
            ('user', _botTurn('beta', 'and the follow-up')),
        )
        assert dm._unattendedRun(sid, 8) == 2

    def test_the_newest_human_row_resets_the_run_to_zero(self, bots):
        sid = _canonical(bots['alpha']).id
        _seed(
            sid,
            ('user', _botTurn('beta', 'one')),
            ('user', _botTurn('beta', 'two')),
            ('user', 'actually, stop and tell me what you have'),
        )
        assert dm._unattendedRun(sid, 8) == 0

    def test_the_json_encoding_does_not_hide_the_human_row(self, bots):
        """The stored column is JSON-encoded, so a raw LIKE on it is a lie.

        AGENTS.md records this exact trap for the fact/KV read doors: a value is
        stored encoded, so every read door must decode it. A prefix test against
        the raw text compares against a leading quote, finds no human row ever,
        and the guard would refuse every Bot chat after N turns regardless of
        what the human did — the failure mode is a lockout, not a leak.
        """
        from app.services.memory_conn import conn

        sid = _canonical(bots['alpha']).id
        _seed(sid, ('user', 'plain human words'))
        raw = conn().execute(
            'SELECT content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1',
            (sid,),
        ).fetchone()['content']
        assert raw.startswith('"'), f'expected a JSON-encoded column, got {raw[:20]!r}'
        assert dm._unattendedRun(sid, 8) == 0

    def test_a_human_quoting_a_bot_is_a_reset_not_a_bot_turn(self, bots):
        """Control: the prefix must LEAD. A human may paste a Bot's message."""
        sid = _canonical(bots['alpha']).id
        _seed(
            sid,
            ('user', _botTurn('beta', 'one')),
            ('user', f'look what came in: {dm.BOT_TURN_PREFIX}beta …'),
        )
        assert dm._unattendedRun(sid, 8) == 0

    def test_machine_sourced_rows_do_not_reset_the_run(self, bots):
        """A harness nudge or a routine delivery is not the human talking.

        Read off `messages.source` (migration 049) — the provenance column that
        replaced guessing from text prefixes.
        """
        from app.services.memory_conn import commit, conn

        sid = _canonical(bots['alpha']).id
        _seed(sid, ('user', 'a real human ask'), ('user', _botTurn('beta', 'reply')))
        conn().execute(
            "INSERT INTO messages (session_id, role, content, source) VALUES (?, 'user', ?, ?)",
            (sid, json.dumps('[routine:nightly] result: all clear'), 'memory_delivery'),
        )
        commit(conn())
        assert dm._unattendedRun(sid, 8) == 2

    def test_a_queued_human_message_resets_the_run(self, bots):
        """`queued_user` is the HUMAN typing mid-turn — it must break the run.

        It is in `message_sources.MACHINE_SOURCES` (the whole composite is
        plumbing for mining purposes), so deriving this set from that constant
        would make the one message that should end an unattended run *extend*
        it. The subset is declared instead, and pinned here.
        """
        from app.services.memory_conn import commit, conn

        sid = _canonical(bots['alpha']).id
        _seed(sid, *[('user', _botTurn('beta', f'{i}')) for i in range(4)])
        conn().execute(
            "INSERT INTO messages (session_id, role, content, source) VALUES (?, 'user', ?, ?)",
            (sid, json.dumps('hold on, do it this way instead'), 'queued_user'),
        )
        commit(conn())
        assert dm._unattendedRun(sid, 4) == 0

    def test_the_scan_is_bounded_by_the_ceiling_not_the_chat(self, bots):
        sid = _canonical(bots['alpha']).id
        _seed(sid, *[('user', _botTurn('beta', f'{i}')) for i in range(30)])
        assert dm._unattendedRun(sid, 4) == 4
        assert dm._unattendedRun(sid, 0) == 0


class TestPrefixIsSharedByBothWriters:
    def test_the_delivery_and_the_wake_build_from_one_constant(self, bots):
        """A new inbound author kind that skips this prefix silently never counts.

        Both Bot-authored turn texts must be built from `BOT_TURN_PREFIX`, or
        the ceiling below reads a transcript whose Bot turns are invisible to it.
        """
        alpha = _canonical(bots['alpha'])
        beta = _canonical(bots['beta'])
        seen: list[str] = []

        async def fake_runner(*, sessionId, message, agentId, emit=None):
            seen.append(message)
            if emit:
                emit({'type': 'finalOutput', 'content': 'ok'})

        dm_id = dm.enqueue(
            from_agent=bots['alpha'],
            to_agent=bots['beta'],
            body=_botTurn('alpha', 'need the report'),
            from_session=alpha.id,
            to_session=beta.id,
        )
        assert asyncio.run(dm.deliver(dm_id, runner=fake_runner)) == 'delivered'
        assert seen and all(m.startswith(dm.BOT_TURN_PREFIX) for m in seen), seen

    def test_messageAgent_attributes_with_the_same_prefix(self, bots, monkeypatch):
        alpha = _canonical(bots['alpha'])
        _set_current(alpha)
        monkeypatch.setattr(dm, '_spawn', lambda coro: coro.close())
        res = asyncio.run(dm.messageAgent(target='beta', message='need the report'))
        body = str(dm.get_dm(_dmId(res))['body'])
        assert body.startswith(dm.BOT_TURN_PREFIX), body


class TestTheDoor:
    def test_the_ceiling_is_off_without_the_key(self, bots, monkeypatch):
        monkeypatch.setattr('app.services.brain_config_service.getRuntimeConfig', lambda: {})
        assert dm._unattendedCeiling() == 0
        alpha = _canonical(bots['alpha'])
        _seed(alpha.id, *[('user', _botTurn('beta', f'{i}')) for i in range(40)])
        _set_current(alpha)
        monkeypatch.setattr(dm, '_spawn', lambda coro: coro.close())
        res = asyncio.run(dm.messageAgent(target='beta', message='one more'))
        assert '"status": "success"' in res, res
        assert dm.REASON_UNATTENDED not in res

    def test_an_explicit_zero_means_off(self, bots, monkeypatch):
        _armCeiling(monkeypatch, 0)
        assert dm._unattendedCeiling() == 0

    @pytest.mark.parametrize('ceiling,botTurns,expectBlocked', [(3, 2, False), (3, 3, True), (3, 9, True)])
    def test_the_refusal_fires_at_the_ceiling_and_not_before(
        self, bots, monkeypatch, ceiling, botTurns, expectBlocked
    ):
        alpha = _canonical(bots['alpha'])
        turns = [('user', 'the human ask')] + [
            ('user', _botTurn('beta', f'{i}')) for i in range(botTurns)
        ]
        _seed(alpha.id, *turns)
        _armCeiling(monkeypatch, ceiling)
        _set_current(alpha)
        monkeypatch.setattr(dm, '_spawn', lambda coro: coro.close())
        before = _dmCount()
        res = asyncio.run(dm.messageAgent(target='beta', message='and another'))
        if expectBlocked:
            assert dm.REASON_UNATTENDED in res, res
            assert _dmCount() == before, 'a refused send still enqueued an inbox row'
            text = res.lower()
            assert 'human' in text, f'the receipt must name the way out: {res}'
            assert f'maxunattendedturns={ceiling}'.lower() in text, res
        else:
            assert '"status": "success"' in res, res

    def test_a_human_reply_reopens_the_door(self, bots, monkeypatch):
        alpha = _canonical(bots['alpha'])
        _seed(alpha.id, *[('user', _botTurn('beta', f'{i}')) for i in range(5)])
        _armCeiling(monkeypatch, 3)
        _set_current(alpha)
        monkeypatch.setattr(dm, '_spawn', lambda coro: coro.close())
        assert dm.REASON_UNATTENDED in asyncio.run(dm.messageAgent(target='beta', message='blocked'))
        _seed(alpha.id, ('user', 'carry on, but finish it here'))
        assert '"status": "success"' in asyncio.run(
            dm.messageAgent(target='beta', message='the human said to continue')
        )

    def test_the_human_route_is_never_gated(self, bots, monkeypatch):
        """The ceiling guards the MODEL's send door, not the store.

        `POST /api/agents/dm` delivers a message a human asked for, and a human
        send is the reset that makes the next Bot turn legal — gating it would
        turn a runaway guard into a lockout.
        """
        alpha = _canonical(bots['alpha'])
        beta = _canonical(bots['beta'])
        _armCeiling(monkeypatch, 1)
        _seed(alpha.id, ('user', _botTurn('beta', 'already over budget')))
        before = _dmCount()
        dm_id = dm.enqueue(
            from_agent=bots['alpha'],
            to_agent=bots['beta'],
            body='whatever the human typed',
            from_session=alpha.id,
            to_session=beta.id,
        )
        assert dm_id > 0 and _dmCount() == before + 1


class TestTheCeilingIsReachableThroughTheRealConfigDoor:
    """A guard nobody can arm is a guard that does not exist.

    This is exactly how the runaway backstop became documented-but-unreachable:
    a key with a `fieldTable` entry but missing from `numKeys` is rejected by
    `validatePatch`, and a key missing from `fieldTable` is dropped by
    `_snakeToCamel`, so the value never reached the reader. This class writes
    through `saveBrainConfig` — the route Settings and the API both use — and
    reads it back off the guard itself.
    """

    def test_saving_the_key_reaches_the_guard(self, isolatedData):
        from app.services import brain_config_service as bcs

        assert 'maxUnattendedTurns' in bcs.allowedKeys
        assert bcs.getDefaults().get('maxUnattendedTurns') is None, (
            'a default of 0 would be indistinguishable from an operator disarming it'
        )
        ok, err, _ = bcs.saveBrainConfig({'maxUnattendedTurns': 2})
        assert ok, err
        bcs.bustRuntimeCache()
        assert dm._unattendedCeiling() == 2

    def test_zero_stays_writable_so_the_ceiling_can_be_disarmed(self, isolatedData):
        """The fallback range in `validatePatch` starts at 1; a key that lands
        in it can never be turned off."""
        from app.services import brain_config_service as bcs

        assert bcs.validatePatch({'maxUnattendedTurns': 0})[0], '0 must stay writable to disarm'

    def test_an_armed_ceiling_blocks_a_real_chain(self, bots, monkeypatch, isolatedData):
        """End to end at the door, with the config written the real way."""
        from app.services import brain_config_service as bcs

        alpha = _canonical(bots['alpha'])
        _seed(
            alpha.id,
            ('user', 'the human ask'),
            *[('user', _botTurn('beta', f'{i}')) for i in range(3)],
        )
        ok, err, _ = bcs.saveBrainConfig({'maxUnattendedTurns': 2})
        assert ok, err
        bcs.bustRuntimeCache()
        _set_current(alpha)
        monkeypatch.setattr(dm, '_spawn', lambda coro: coro.close())
        res = asyncio.run(dm.messageAgent(target='beta', message='fourth time'))
        assert dm.REASON_UNATTENDED in res, res


def _dmCount() -> int:
    from app.services.memory_conn import conn

    return int(conn().execute('SELECT COUNT(*) AS n FROM bot_dm').fetchone()['n'])


def _dmId(receipt: str) -> int:
    return int(json.loads(receipt).get('dm_id') or 0)

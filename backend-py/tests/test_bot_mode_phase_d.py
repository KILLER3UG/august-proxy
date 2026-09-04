"""Part 19 Phase D (2026-09-04, ruling OQ3 + Part 22 G-1/G-2) — group rooms.

The round driver is deterministic (no LLM router): mention-parse goldens,
caps (3 rounds / 10 messages), pass/settle, G-2 escalation on two consecutive
blocks, G-1 review rounds, and session-per-member isolation — all against a
fake member runner.
"""

from __future__ import annotations

import asyncio

import pytest
from app.services.bot_mode import rooms


@pytest.fixture(autouse=True)
def _clear_sessions():
    """The in-memory session dict persists across tests while room ids restart
    (the DB resets each test) — clear it so member-session isolation is real."""
    from app.services.workbench import sessions as sessions_mod

    sessions_mod._sessions.clear()
    yield
    sessions_mod._sessions.clear()


@pytest.fixture()
def bots(isolatedData):
    from app.services.memory_store import init as init_store
    from app.services.tools import agent_registry

    init_store()
    a = agent_registry.createAgent(name='alice', description='Alice', role='')
    b = agent_registry.createAgent(name='bob', description='Bob', role='')
    c = agent_registry.createAgent(name='carol', description='Carol', role='')
    return {'alice': str(a['id']), 'bob': str(b['id']), 'carol': str(c['id'])}


def _room(bots, *names):
    return rooms.create_room('Design room', [bots[n] for n in names])


# ── mention parse goldens ─────────────────────────────────────────────────────


class TestMentionParse:
    def test_handle_and_everyone(self, bots):
        members = [bots['alice'], bots['bob']]
        assert rooms.parse_mentions('@alice help', members) == [bots['alice']]
        assert rooms.parse_mentions('@everyone chime in', members) == members
        assert rooms.parse_mentions('no mentions here', members) == []

    def test_unknown_handle_ignored(self, bots):
        members = [bots['alice']]
        assert rooms.parse_mentions('@ghost hi', members) == []

    def test_multiple_in_roster_order(self, bots):
        members = [bots['alice'], bots['bob'], bots['carol']]
        got = rooms.parse_mentions('@carol and @alice', members)
        assert got == [bots['alice'], bots['carol']]  # roster order, not mention order

    def test_request_review_parse(self):
        assert rooms.parse_request_review('done. request_review(@bob, check the schema)') == (
            'bob',
            'check the schema',
        )
        assert rooms.parse_request_review('plain prose') is None


# ── round driver: caps, pass, settle ─────────────────────────────────────────


class TestRoundDriver:
    def test_all_pass_settles_immediately(self, bots):
        rid = _room(bots, 'alice', 'bob')

        async def pass_runner(**kw):
            # emit nothing → empty reply → pass
            return None

        summary = asyncio.run(rooms.run_room(rid, 'go', runner=pass_runner))
        assert summary['messages'] == 0
        assert summary['settled'] is True
        # both members passed once each (2 pass rows) but no escalation yet
        log = rooms.room_log(rid)
        assert sum(1 for m in log if m['kind'] == 'pass') == 2

    def test_one_round_one_message_each(self, bots):
        rid = _room(bots, 'alice', 'bob')

        async def echo_runner(*, agentId, emit=None, **kw):
            if emit:
                emit({'type': 'finalOutput', 'content': f'{agentId} says hi'})

        summary = asyncio.run(rooms.run_room(rid, 'go', runner=echo_runner))
        assert summary['messages'] == 2
        assert summary['rounds'] == 1  # round 2 has no pulls → settle
        log = rooms.room_log(rid)
        bodies = [str(m['body']) for m in log if m['kind'] == 'message']
        assert any('says hi' in b for b in bodies)

    def test_message_cap_enforced(self, bots):
        rid = _room(bots, 'alice', 'bob')

        async def pull_runner(*, agentId, emit=None, **kw):
            # each member pulls the other → would loop without the cap
            other = 'bob' if agentId.endswith('e') and 'alice' in str(agentId) else 'alice'
            if emit:
                emit({'type': 'finalOutput', 'content': f'@{other} your turn'})

        # Use ids directly for reliable pull targeting.
        async def pull_runner2(*, agentId, emit=None, **kw):
            members = [str(m) for m in (rooms.get_room(rid) or {}).get('members', [])]
            other = next((m for m in members if m != agentId), '')
            if emit and other:
                emit({'type': 'finalOutput', 'content': f'@{other} go'})

        summary = asyncio.run(rooms.run_room(rid, 'start', runner=pull_runner2, max_messages=3))
        assert summary['messages'] <= 3

    def test_round_cap_enforced(self, bots):
        rid = _room(bots, 'alice', 'bob')

        async def pull_runner(*, agentId, emit=None, **kw):
            members = [str(m) for m in (rooms.get_room(rid) or {}).get('members', [])]
            other = next((m for m in members if m != agentId), '')
            if emit and other:
                emit({'type': 'finalOutput', 'content': f'@{other} go'})

        summary = asyncio.run(rooms.run_room(rid, 'start', runner=pull_runner, max_rounds=2))
        assert summary['rounds'] <= 2


# ── G-2 escalation ────────────────────────────────────────────────────────────


class TestEscalation:
    def test_two_consecutive_blocks_flip_needs_you(self, bots):
        # alice passes twice (consecutive blocks) while bob keeps pulling her
        # → G-2 flips needs_you automatically within one send.
        rid = _room(bots, 'alice', 'bob')

        async def pass_twice(*, agentId, emit=None, **kw):
            members = [str(m) for m in (rooms.get_room(rid) or {}).get('members', [])]
            # alice (members[0]) always passes; bob pulls everyone so alice
            # gets a second turn → second consecutive block → escalate.
            if agentId == members[0]:
                return None  # alice passes
            if emit:
                emit({'type': 'finalOutput', 'content': '@everyone again'})

        summary = asyncio.run(rooms.run_room(rid, 'go', runner=pass_twice, max_rounds=3))
        assert summary['escalated'] is True
        assert rooms.get_room(rid)['needs_you'] is True


# ── G-1 review round ──────────────────────────────────────────────────────────


class TestReviewRound:
    def test_review_round_runs_reviewer_only(self, bots):
        rid = _room(bots, 'alice', 'bob')

        async def review_runner(*, agentId, emit=None, **kw):
            members = [str(m) for m in (rooms.get_room(rid) or {}).get('members', [])]
            alice = members[0]
            if emit:
                if agentId == alice:
                    emit({'type': 'finalOutput', 'content': 'I drafted it. request_review(@bob, check it)'})
                else:
                    emit({'type': 'finalOutput', 'content': 'approve'})

        summary = asyncio.run(rooms.run_room(rid, 'build a thing', runner=review_runner))
        log = rooms.room_log(rid)
        verdicts = [m for m in log if m['kind'] == 'verdict']
        assert verdicts, 'the reviewer turn must be a verdict row'
        # 2.10 (Part 25): the verdict must be the REVIEWER's turn in a dedicated
        # review round (>= 2 rounds), not an incidental same-round message.
        members = [str(m) for m in (rooms.get_room(rid) or {}).get('members', [])]
        assert verdicts[0]['sender_agent'] == members[1]  # bob, the reviewer
        assert summary['rounds'] >= 2
        assert summary['messages'] >= 2

    def test_changes_verdict_grants_revision_turn(self, bots):
        rid = _room(bots, 'alice', 'bob')

        async def runner(*, agentId, emit=None, **kw):
            members = [str(m) for m in (rooms.get_room(rid) or {}).get('members', [])]
            alice = members[0]
            if emit:
                if agentId == alice:
                    emit({'type': 'finalOutput', 'content': 'draft. request_review(@bob, schema)'})
                else:
                    emit({'type': 'finalOutput', 'content': 'changes: rename the column'})

        summary = asyncio.run(rooms.run_room(rid, 'build', runner=runner, max_rounds=3))
        log = rooms.room_log(rid)
        # alice (requester) gets a revision turn after the changes: verdict.
        alice_msgs = [m for m in log if m['sender_agent'] == members0(rid)]
        assert len(alice_msgs) >= 2  # draft + revision
        assert summary['rounds'] >= 3


def members0(rid):
    return str((rooms.get_room(rid) or {}).get('members', [''])[0])


# ── session-per-member isolation ──────────────────────────────────────────────


class TestMemberSessions:
    def test_each_member_gets_its_own_group_session(self, bots):
        rid = _room(bots, 'alice', 'bob')

        async def echo_runner(**kw):
            return None

        asyncio.run(rooms.run_room(rid, 'go', runner=echo_runner))
        from app.services.workbench import sessions as sessions_mod

        group_sessions = [
            s for s in sessions_mod._sessions.values()
            if isinstance(getattr(s, 'metadata', None), dict)
            and str(s.metadata.get('botRoom')) == str(rid)
        ]
        assert len(group_sessions) == 2
        assert {s.metadata.get('botAgentId') for s in group_sessions} == {bots['alice'], bots['bob']}
        assert all(str(s.title).startswith('Group:') for s in group_sessions)


# ── room store validation ─────────────────────────────────────────────────────


class TestRoomStore:
    def test_member_count_bounds(self, bots):
        with pytest.raises(ValueError):
            rooms.create_room('too few', [bots['alice']])
        with pytest.raises(ValueError):
            rooms.create_room('too many', [bots['alice']] * 7)

    def test_room_crud(self, bots):
        rid = _room(bots, 'alice', 'bob')
        room = rooms.get_room(rid)
        assert room is not None and room['name'] == 'Design room'
        assert len(room['members']) == 2
        assert rid in [r['id'] for r in rooms.list_rooms()]
        assert rooms.delete_room(rid) is True
        assert rooms.get_room(rid) is None


# ── endpoints ─────────────────────────────────────────────────────────────────


class TestRoomEndpoints:
    def test_create_send_list(self, bots):
        import app.services.bot_mode.rooms as rmod
        from app.main import app
        from fastapi.testclient import TestClient

        async def fake_run(room_id, user_text, **kw):
            return {'rounds': 1, 'messages': 0, 'settled': True, 'escalated': False, 'needsYou': False}

        orig = rmod.run_room
        rmod.run_room = fake_run
        try:
            with TestClient(app) as client:
                created = client.post(
                    '/api/agents/rooms',
                    json={'name': 'R', 'members': [bots['alice'], bots['bob']]},
                )
                assert created.status_code == 200, created.text
                rid = created.json()['roomId']
                sent = client.post(f'/api/agents/rooms/{rid}/send', json={'message': 'go'})
                assert sent.status_code == 200, sent.text
                assert sent.json()['summary']['settled'] is True
                listed = client.get('/api/agents/rooms')
                assert any(r['id'] == rid for r in listed.json()['rooms'])
        finally:
            rmod.run_room = orig

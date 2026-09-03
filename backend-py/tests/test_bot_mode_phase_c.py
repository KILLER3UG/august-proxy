"""Part 19 Phase C (2026-09-04, rulings OQ4+OQ8) — teammate DMs.

message_agent is the single send path. Tests cover the gate matrix (canonical
vs regular vs subagent sessions see/don't-see the tool), target resolution,
the typed-failure receipts, the delivery round-trip + sender-wake ordering
with a scripted runner, and the mention-parse annotation (never a delivery).
"""

from __future__ import annotations

import asyncio

import pytest
from app.services.bot_mode import dm, protocol


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


def _set_current(session) -> None:
    from app.services.workbench.context import currentSessionId

    currentSessionId.set(session.id)


# ── gate matrix ──────────────────────────────────────────────────────────────


class TestGate:
    def test_canonical_chat_keeps_tool(self, bots):
        chat = _canonical(bots['alpha'])
        tools = [{'name': 'message_agent'}, {'name': 'read_file'}]
        assert dm.filter_dm_tools(tools, chat) == tools

    def test_regular_session_drops_tool(self, bots):
        from app.services.workbench import workbench as wb

        sess = wb.createWorkbenchSession(provider='', agentId='build', guardMode='full')
        out = dm.filter_dm_tools([{'name': 'message_agent'}, {'name': 'read_file'}], sess)
        assert [t['name'] for t in out] == ['read_file']

    def test_openai_shape_dropped(self, bots):
        from app.services.workbench import workbench as wb

        sess = wb.createWorkbenchSession(provider='', agentId='build', guardMode='full')
        tools = [{'type': 'function', 'function': {'name': 'message_agent'}}]
        assert dm.filter_dm_tools(tools, sess) == []

    def test_forged_call_from_regular_session_denied(self, bots, monkeypatch):
        from app.services.workbench import workbench as wb

        sess = wb.createWorkbenchSession(provider='', agentId='build', guardMode='full')
        _set_current(sess)
        monkeypatch.setattr(dm, '_spawn', lambda coro: coro.close())
        res = asyncio.run(dm.messageAgent(target='beta', message='hi there teammate'))
        assert '"error"' in res
        assert dm.REASON_NO_CHAT in res


# ── target resolution ─────────────────────────────────────────────────────────


class TestResolveTarget:
    def test_by_handle_name_title_id(self, bots):
        assert dm.resolve_target('beta') == bots['beta']
        assert dm.resolve_target('@beta') == bots['beta']
        assert dm.resolve_target(bots['beta']) == bots['beta']

    def test_unknown_returns_empty(self, bots):
        assert dm.resolve_target('nobody-here') == ''
        assert dm.resolve_target('') == ''


# ── typed failures ─────────────────────────────────────────────────────────────


class TestTypedFailures:
    def test_unknown_target_receipt_lists_roster(self, bots, monkeypatch):
        _set_current(_canonical(bots['alpha']))
        monkeypatch.setattr(dm, '_spawn', lambda coro: coro.close())
        res = asyncio.run(dm.messageAgent(target='ghost', message='hello'))
        assert dm.REASON_UNKNOWN_TARGET in res
        assert '@beta' in res  # live roster in the receipt

    def test_self_message_denied(self, bots, monkeypatch):
        _set_current(_canonical(bots['alpha']))
        monkeypatch.setattr(dm, '_spawn', lambda coro: coro.close())
        res = asyncio.run(dm.messageAgent(target='alpha', message='talking to me'))
        assert dm.REASON_SELF in res

    def test_body_too_long_denied(self, bots, monkeypatch):
        _set_current(_canonical(bots['alpha']))
        monkeypatch.setattr(dm, '_spawn', lambda coro: coro.close())
        res = asyncio.run(dm.messageAgent(target='beta', message='x' * (protocol.MAX_DM_BODY + 1)))
        assert dm.REASON_BODY_TOO_LONG in res

    def test_success_acks_and_enqueues(self, bots, monkeypatch):
        _set_current(_canonical(bots['alpha']))
        monkeypatch.setattr(dm, '_spawn', lambda coro: coro.close())
        res = asyncio.run(dm.messageAgent(target='beta', message='need the report'))
        assert '"status": "success"' in res
        dm_id = _dm_id_from(res)
        row = dm.get_dm(dm_id)
        assert row is not None and row['status'] == 'pending'
        assert 'Message from' in str(row['body'])  # server-side attribution


# ── delivery round-trip + sender wake ─────────────────────────────────────────


class TestDelivery:
    def test_roundtrip_wakes_sender_in_order(self, bots):
        alpha_chat = _canonical(bots['alpha'])
        beta_chat = _canonical(bots['beta'])
        calls: list[tuple[str, str]] = []

        async def fake_runner(*, sessionId, message, agentId, emit=None):
            calls.append((sessionId, message))
            if emit:
                emit({'type': 'finalOutput', 'content': f'[{agentId}] reply'})

        dm_id = dm.enqueue(
            from_agent=bots['alpha'], to_agent=bots['beta'],
            body='Message from 🤖 alpha (@alpha):\nneed the report',
            from_session=alpha_chat.id, to_session=beta_chat.id,
        )
        outcome = asyncio.run(dm.deliver(dm_id, runner=fake_runner))
        assert outcome == 'delivered'
        # Turn 1 = recipient (beta) chat; turn 2 = sender (alpha) wake.
        assert calls[0][0] == beta_chat.id
        assert 'need the report' in calls[0][1]
        assert calls[1][0] == alpha_chat.id
        assert 'reply' in calls[1][1]

        assert dm.get_dm(dm_id)['status'] == 'delivered'
        # The sender chat carries the attributed reply as a user-role turn.
        from app.services.workbench import sessions as sessions_mod

        reloaded = sessions_mod.get_workbench_session(alpha_chat.id)
        wake_msgs = [
            m for m in reloaded.messages
            if isinstance(m, dict) and 'reply' in str(m.get('content', '')) and m.get('role') == 'user'
        ]
        assert wake_msgs, 'sender chat must carry the attributed reply'

    def test_inflight_guard_blocks_second_dm(self, bots, monkeypatch):
        alpha_chat = _canonical(bots['alpha'])
        _set_current(alpha_chat)
        monkeypatch.setattr(dm, '_spawn', lambda coro: coro.close())
        # Leave a pending DM alpha→beta (delivery never runs).
        dm.enqueue(from_agent=bots['alpha'], to_agent=bots['beta'], body='first')
        res = asyncio.run(dm.messageAgent(target='beta', message='second'))
        assert dm.REASON_IN_FLIGHT in res

    def test_delivery_error_marks_failed(self, bots):
        alpha_chat = _canonical(bots['alpha'])
        beta_chat = _canonical(bots['beta'])

        async def boom_runner(**kw):
            raise RuntimeError('model down')

        dm_id = dm.enqueue(
            from_agent=bots['alpha'], to_agent=bots['beta'], body='hi',
            from_session=alpha_chat.id, to_session=beta_chat.id,
        )
        outcome = asyncio.run(dm.deliver(dm_id, runner=boom_runner))
        assert outcome == dm.REASON_DELIVERY_ERROR
        assert dm.get_dm(dm_id)['status'] == 'failed'
        assert dm.get_dm(dm_id)['reason_code'] == dm.REASON_DELIVERY_ERROR


def _dm_id_from(ack_json: str) -> int:
    import json

    return int(json.loads(ack_json)['dm_id'])


# ── mention parse (annotation only) ───────────────────────────────────────────


class TestMentionParse:
    def test_note_lists_resolved_handles(self):
        note = protocol.mention_note([('beta', 'beta', 'Beta')])
        assert '@beta' in note
        assert 'message_agent' in note
        assert 'never forward' in note

    def test_empty_resolution_no_note(self):
        assert protocol.mention_note([]) == ''

    def test_protocol_text_has_containment_rules(self):
        assert 'never forward' in protocol.MESSAGING_PROTOCOL.lower()
        assert 'ping-pong' in protocol.MESSAGING_PROTOCOL.lower()


# ── POST /bots/{id}/dm endpoint ───────────────────────────────────────────────


class TestDmEndpoint:
    def test_endpoint_queues_dm(self, bots, monkeypatch):
        from app.main import app
        from fastapi.testclient import TestClient

        # Isolate the endpoint from delivery: assert it enqueues + acks.
        monkeypatch.setattr(dm, '_spawn', lambda coro: coro.close())
        with TestClient(app) as client:
            r = client.post(
                f'/api/agents/bots/{bots["beta"]}/dm',
                json={'message': 'hello from the UI', 'fromAgent': bots['alpha']},
            )
            assert r.status_code == 200, r.text
            assert r.json()['status'] == 'queued'
            assert r.json()['dmId'] > 0
            row = dm.get_dm(r.json()['dmId'])
            assert row is not None and row['to_agent'] == bots['beta']

    def test_endpoint_rejects_empty(self, bots):
        from app.main import app
        from fastapi.testclient import TestClient

        with TestClient(app) as client:
            r = client.post(f'/api/agents/bots/{bots["beta"]}/dm', json={'message': '   '})
            assert r.status_code == 400

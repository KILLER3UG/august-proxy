"""Opt-in verifier enforcement flag (session.verifierEnforced).

When the flag is on, final-answer text (finalOutput SSE) is withheld until
update_state(phase='complete') passes the verifier gate; a single
`verifierBlocked` event is emitted instead. Casual chat (flag off) is
unaffected.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from app.services.workbench import workbench as wb


class _StubSession:
    verifierEnforced = False
    _execution_state = None


def _make_session(*, enforced: bool, phase: str | None = None) -> _StubSession:
    s = _StubSession()
    s.verifierEnforced = enforced
    s._execution_state = {'phase': phase} if phase else None
    return s


# ── _verifier_gated_emit unit tests ───────────────────────────────────


def test_gate_passthrough_when_flag_off():
    seen: list[dict] = []
    emit = wb._verifier_gated_emit(_make_session(enforced=False), seen.append)
    emit({'type': 'finalOutput', 'content': 'Hello'})
    assert seen == [{'type': 'finalOutput', 'content': 'Hello'}]


def test_gate_none_emit_returns_none():
    assert wb._verifier_gated_emit(_make_session(enforced=True), None) is None


def test_gate_blocks_final_output_without_complete_phase():
    seen: list[dict] = []
    emit = wb._verifier_gated_emit(_make_session(enforced=True), seen.append)
    emit({'type': 'finalOutput', 'content': 'answer'})
    assert len(seen) == 1
    assert seen[0]['type'] == 'verifierBlocked'
    assert 'Verification required' in seen[0]['message']
    # The banner now carries gate evidence so the UI can explain WHY.
    assert seen[0]['evidence'] == {
        'currentPhase': 'research',
        'verificationCommand': '',
        'blockers': [],
        'completed': [],
        'receiptCount': 0,
    }


def test_gate_blocks_when_phase_is_implement():
    seen: list[dict] = []
    emit = wb._verifier_gated_emit(_make_session(enforced=True, phase='implement'), seen.append)
    emit({'type': 'finalOutput', 'content': 'answer'})
    assert seen and seen[0]['type'] == 'verifierBlocked'


def test_gate_allows_when_phase_is_complete():
    seen: list[dict] = []
    emit = wb._verifier_gated_emit(_make_session(enforced=True, phase='complete'), seen.append)
    emit({'type': 'finalOutput', 'content': 'verified answer'})
    assert seen == [{'type': 'finalOutput', 'content': 'verified answer'}]


def test_gate_emits_blocked_once_per_turn():
    seen: list[dict] = []
    emit = wb._verifier_gated_emit(_make_session(enforced=True), seen.append)
    for _ in range(5):
        emit({'type': 'finalOutput', 'content': 'chunk'})
    blocked = [e for e in seen if e['type'] == 'verifierBlocked']
    assert len(blocked) == 1
    assert all(e['type'] == 'verifierBlocked' for e in seen)


def test_gate_other_event_types_pass_through():
    seen: list[dict] = []
    emit = wb._verifier_gated_emit(_make_session(enforced=True), seen.append)
    events = [
        {'type': 'thinking', 'content': 'hmm'},
        {'type': 'toolResult', 'id': 't1', 'content': 'ok'},
        {'type': 'error', 'message': 'boom'},
        {'type': 'done', 'sessionId': 's1'},
    ]
    for evt in events:
        emit(evt)
    assert seen == events


def test_gate_unblocks_after_complete_phase_set_mid_turn():
    session = _make_session(enforced=True)
    seen: list[dict] = []
    emit = wb._verifier_gated_emit(session, seen.append)
    emit({'type': 'finalOutput', 'content': 'blocked'})
    session._execution_state = {'phase': 'complete'}
    emit({'type': 'finalOutput', 'content': 'unblocked'})
    assert seen[0]['type'] == 'verifierBlocked'
    assert seen[1] == {'type': 'finalOutput', 'content': 'unblocked'}


# ── Session field persistence ──────────────────────────────────────────


def test_session_to_dict_from_dict_round_trip():
    from app.services.workbench.sessions import WorkbenchSession

    s = WorkbenchSession(id='wb_1')
    s.verifierEnforced = True
    d = s.toDict()
    assert d['verifierEnforced'] is True
    s2 = WorkbenchSession.fromDict(d)
    assert s2.verifierEnforced is True


def test_session_default_flag_off():
    from app.services.workbench.sessions import WorkbenchSession

    assert WorkbenchSession().verifierEnforced is False


# ── Router: session create + toggle endpoint ──────────────────────────


@pytest.fixture
async def client(isolatedData):
    from app.services.workbench import workbench as _wb

    _wb._sessions.clear()
    _wb.saveSessions()
    from app.main import app
    from httpx import ASGITransport, AsyncClient

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


@pytest.mark.asyncio
async def test_create_session_accepts_verifier_flag(client):
    resp = await client.post(
        '/api/workbench/session',
        json={'verifierEnforced': True, 'provider': 'p1'},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body['verifierEnforced'] is True


@pytest.mark.asyncio
async def test_create_session_defaults_flag_off(client):
    resp = await client.post('/api/workbench/session', json={})
    assert resp.status_code == 200
    assert resp.json().get('verifierEnforced') is False


@pytest.mark.asyncio
async def test_verifier_toggle_endpoint(client):
    created = (await client.post('/api/workbench/session', json={})).json()
    sid = created['id']
    resp = await client.post('/api/workbench/verifier', json={'sessionId': sid, 'verifierEnforced': True})
    assert resp.status_code == 200
    assert resp.json()['verifierEnforced'] is True
    resp = await client.post('/api/workbench/verifier', json={'sessionId': sid, 'verifierEnforced': False})
    assert resp.status_code == 200
    assert resp.json()['verifierEnforced'] is False


@pytest.mark.asyncio
async def test_verifier_toggle_unknown_session_404(client):
    resp = await client.post('/api/workbench/verifier', json={'sessionId': 'nope', 'verifierEnforced': True})
    assert resp.status_code == 404

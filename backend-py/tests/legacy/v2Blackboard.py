"""v2 — Test blackboard adaptive TTL + ack + session scoping + Tier 3 injection."""

import pytest
from app.services import blackboard_service
from app.services.memory_store import init


@pytest.fixture(autouse=True)
def _initDb():
    init()
    yield


def testAdaptiveTtlFromPollInterval():
    """TTL is max(poll_interval * 2, 60)."""
    from datetime import datetime

    fmt = '%Y-%m-%d %H:%M:%S'
    expiresAt = blackboard_service.compute_ttl(poll_interval=30)
    parsed = datetime.strptime(expiresAt, fmt)
    now = datetime.utcnow()
    diff = (parsed - now).total_seconds()
    assert 55 < diff < 65
    expiresAt = blackboard_service.compute_ttl(poll_interval=10)
    parsed = datetime.strptime(expiresAt, fmt)
    diff = (parsed - now).total_seconds()
    assert 55 < diff < 65
    expiresAt = blackboard_service.compute_ttl(poll_interval=120)
    parsed = datetime.strptime(expiresAt, fmt)
    diff = (parsed - now).total_seconds()
    assert 235 < diff < 245


def testAckDeletesNote():
    """read_notes(ack=True) deletes the note on read."""
    import uuid

    sid = f'v2-ack-{uuid.uuid4().hex[:8]}'
    blackboard_service.write_note(sid, 'test-agent', 'test-key', 'test value', 60)
    notes = blackboard_service.read_notes(sid, ack=True)
    assert any((n.get('key') == 'test-key' for n in notes))
    notesAfter = blackboard_service.read_notes(sid)
    assert not any((n.get('key') == 'test-key' for n in notesAfter))


def testSessionScoping():
    """Notes from session A don't leak into session B."""
    import uuid

    sidA = f'v2-scope-a-{uuid.uuid4().hex[:8]}'
    sidB = f'v2-scope-b-{uuid.uuid4().hex[:8]}'
    blackboard_service.write_note(sidA, 'agent', 'key', 'value-A', 60)
    blackboard_service.write_note(sidB, 'agent', 'key', 'value-B', 60)
    aNotes = blackboard_service.read_notes(sidA)
    bNotes = blackboard_service.read_notes(sidB)
    assert any((n.get('value') == 'value-A' for n in aNotes))
    assert not any((n.get('value') == 'value-A' for n in bNotes))
    assert any((n.get('value') == 'value-B' for n in bNotes))
    blackboard_service.clear_notes(sidA)
    blackboard_service.clear_notes(sidB)


def testTier3IncludesBlackboardState():
    """<blackboard_state> is included in build_system_prompt when notes exist."""
    import uuid

    from app.services.memory import context_builder

    sid = f'v2-tier3-{uuid.uuid4().hex[:8]}'
    blackboard_service.write_note(sid, 'ci_watcher', 'test_result', 'tests failing on line 45', 60)
    session = {'id': sid, 'blackboard_state': blackboard_service.read_notes(sid)}
    prompt = context_builder.build_system_prompt(session=session, memory={})
    assert '<blackboard_state>' in prompt
    assert 'ci_watcher' in prompt
    assert 'tests failing on line 45' in prompt
    blackboard_service.clear_notes(sid)

"""v2 — Test blackboard adaptive TTL + ack + session scoping + Tier 3 injection."""
import pytest
from app.services import blackboard_service
from app.services.memory_store import init


@pytest.fixture(autouse=True)
def _init_db():
    init()
    yield


def test_adaptive_ttl_from_poll_interval():
    """TTL is max(poll_interval * 2, 60)."""
    from datetime import datetime
    fmt = "%Y-%m-%d %H:%M:%S"

    # poll_interval=30 → TTL = 60
    expires_at = blackboard_service.compute_ttl(poll_interval=30)
    parsed = datetime.strptime(expires_at, fmt)
    now = datetime.utcnow()
    diff = (parsed - now).total_seconds()
    assert 55 < diff < 65

    # poll_interval=10 → TTL = max(20, 60) = 60
    expires_at = blackboard_service.compute_ttl(poll_interval=10)
    parsed = datetime.strptime(expires_at, fmt)
    diff = (parsed - now).total_seconds()
    assert 55 < diff < 65

    # poll_interval=120 → TTL = 240
    expires_at = blackboard_service.compute_ttl(poll_interval=120)
    parsed = datetime.strptime(expires_at, fmt)
    diff = (parsed - now).total_seconds()
    assert 235 < diff < 245


def test_ack_deletes_note():
    """read_notes(ack=True) deletes the note on read."""
    import uuid
    sid = f"v2-ack-{uuid.uuid4().hex[:8]}"
    blackboard_service.write_note(sid, "test-agent", "test-key", "test value", 60)

    notes = blackboard_service.read_notes(sid, ack=True)
    assert any(n.get("key") == "test-key" for n in notes)

    # Note should now be gone
    notes_after = blackboard_service.read_notes(sid)
    assert not any(n.get("key") == "test-key" for n in notes_after)


def test_session_scoping():
    """Notes from session A don't leak into session B."""
    import uuid
    sid_a = f"v2-scope-a-{uuid.uuid4().hex[:8]}"
    sid_b = f"v2-scope-b-{uuid.uuid4().hex[:8]}"
    blackboard_service.write_note(sid_a, "agent", "key", "value-A", 60)
    blackboard_service.write_note(sid_b, "agent", "key", "value-B", 60)

    a_notes = blackboard_service.read_notes(sid_a)
    b_notes = blackboard_service.read_notes(sid_b)
    assert any(n.get("value") == "value-A" for n in a_notes)
    assert not any(n.get("value") == "value-A" for n in b_notes)
    assert any(n.get("value") == "value-B" for n in b_notes)
    # Cleanup
    blackboard_service.clear_notes(sid_a)
    blackboard_service.clear_notes(sid_b)


def test_tier3_includes_blackboard_state():
    """<blackboard_state> is included in build_system_prompt when notes exist."""
    from app.services.memory import context_builder
    import uuid
    sid = f"v2-tier3-{uuid.uuid4().hex[:8]}"
    blackboard_service.write_note(sid, "ci_watcher", "test_result", "tests failing on line 45", 60)
    session = {
        "id": sid,
        "blackboard_state": blackboard_service.read_notes(sid),
    }
    prompt = context_builder.build_system_prompt(session=session, memory={})
    assert "<blackboard_state>" in prompt
    assert "ci_watcher" in prompt
    assert "tests failing on line 45" in prompt
    # Cleanup
    blackboard_service.clear_notes(sid)

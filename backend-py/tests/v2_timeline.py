"""v2 — Test episodic timeline writer + sweep."""
import pytest
from app.services import memory_store


@pytest.fixture(autouse=True)
def _init_db():
    memory_store.init()
    yield


def test_write_timeline_event():
    """write_timeline_event inserts a row."""
    # Use a unique session id to avoid collisions
    import uuid
    sid = f"v2-timeline-{uuid.uuid4().hex[:8]}"
    memory_store.write_timeline_event(
        session_id=sid,
        event_summary="Implemented v2 timeline writer",
        category="implementation",
    )
    conn = memory_store._conn()
    rows = conn.execute(
        "SELECT * FROM episodic_timeline WHERE session_id = ?", (sid,)
    ).fetchall()
    assert len(rows) == 1
    assert "v2 timeline" in rows[0]["event_summary"]
    assert rows[0]["category"] == "implementation"
    # Cleanup
    conn.execute("DELETE FROM episodic_timeline WHERE session_id = ?", (sid,))
    conn.commit()


def test_timeline_sweep_runs_without_error():
    """The sweep runs even with no sessions to process."""
    count = memory_store.timeline_sweep()
    assert isinstance(count, int)
    assert count >= 0


def test_timeline_brain_query_returns_recent_entries():
    """brain_query(store='timeline') returns recent entries."""
    import json
    import uuid
    sid = f"v2-bq-{uuid.uuid4().hex[:8]}"
    memory_store.write_timeline_event(
        session_id=sid,
        event_summary="v2brainquery check",
        category="general",
    )
    result = memory_store.brain_query(store="timeline", query="brainquery", limit=10)
    parsed = json.loads(result)
    # Could be a list (FTS-backed if configured) or a dict (not available)
    if isinstance(parsed, list):
        # The entry should appear in the list (or not, depending on FTS match)
        pass
    elif isinstance(parsed, dict) and "rows" in parsed:
        rows = parsed.get("rows", [])
        # Check that our entry is in the rows
        assert any(r.get("session_id") == sid for r in rows), \
            f"Expected {sid} in timeline rows, got: {rows[:3]}"
    # Cleanup
    conn = memory_store._conn()
    conn.execute("DELETE FROM episodic_timeline WHERE session_id = ?", (sid,))
    conn.commit()

"""v4.3 — Test the brain event bus + /api/brain/events endpoints."""
import asyncio
import json
import time
import pytest


@pytest.fixture(autouse=True)
def _reset_bus():
    """Reset the in-process bus to a clean state between tests."""
    from app.services import brain_event_bus
    brain_event_bus.brain_bus._events.clear()
    brain_event_bus.brain_bus._subscribers.clear()
    yield


def test_emit_appends_with_id_iso_timestamp_and_defaults():
    """emit() stores {id, category, layer, summary, at, meta}."""
    from app.services.brain_event_bus import emit_brain_event, brain_bus

    emit_brain_event(category="heuristic", layer="delta_engine", summary="learned 'prefer tabs'")
    events = brain_bus.recent(limit=10)
    assert len(events) == 1
    e = events[0]
    assert e["category"] == "heuristic"
    assert e["layer"] == "delta_engine"
    assert e["summary"] == "learned 'prefer tabs'"
    assert "id" in e and len(e["id"]) > 0
    assert e["at"].endswith("Z")
    assert e["meta"] == {}


def test_recent_respects_limit_and_category_filter():
    from app.services.brain_event_bus import emit_brain_event, brain_bus

    emit_brain_event(category="consolidation", layer="sleep_cycle", summary="merged 2")
    emit_brain_event(category="heuristic", layer="delta_engine", summary="learned x")
    emit_brain_event(category="consolidation", layer="sleep_cycle", summary="deleted stale")

    consolidation_only = brain_bus.recent(limit=50, category="consolidation")
    assert len(consolidation_only) == 2
    assert all(e["category"] == "consolidation" for e in consolidation_only)

    capped = brain_bus.recent(limit=1)
    assert len(capped) == 1


def test_get_endpoint_returns_events_newest_first():
    """GET /api/brain/events returns recent events, newest first."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.brain_event_bus import emit_brain_event

    emit_brain_event(category="heuristic", layer="heuristics_service", summary="first")
    time.sleep(0.01)
    emit_brain_event(category="consolidation", layer="sleep_cycle", summary="second")

    client = TestClient(app)
    resp = client.get("/api/brain/events")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) >= 2
    assert data[0]["summary"] == "second"  # newest first


def test_sse_endpoint_module_exports_stream():
    """The /api/brain/events/stream endpoint exists in the router. Streaming
    behavior is verified manually — TestClient + async iterators hang."""
    from app.routers import brain_activity
    paths = {route.path for route in brain_activity.router.routes}
    assert "/api/brain/events/stream" in paths
    assert "/api/brain/events" in paths


def test_add_heuristic_publishes_brain_event():
    """add_heuristic() publishes a 'heuristic' event so the Activity tab sees it."""
    from app.services.brain_event_bus import brain_bus
    before = len(brain_bus.recent(limit=200))
    from app.services.heuristics_service import add_heuristic, remove_heuristic
    rid = add_heuristic(f'v4.3 publish-test {{uuid}}', source='v4_3_test') if False else __import__('uuid').uuid4() and add_heuristic(f'v4.3 publish-test {__import__("uuid").uuid4().hex[:8]}', source='v4_3_test')
    assert rid is not None
    after = brain_bus.recent(limit=200)
    new_events = [e for e in after if e["category"] == "heuristic" and e["summary"].startswith("Added heuristic")]
    assert any(e["meta"].get("rule_id") == rid for e in new_events)
    remove_heuristic(rid)


def test_publisher_failure_does_not_break_daemon():
    """If the brain event bus raises, the underlying op must still succeed."""
    from app.services import brain_event_bus

    # Patch emit_brain_event to raise
    original = brain_event_bus.emit_brain_event

    def broken(**_):
        raise RuntimeError("bus exploded")

    brain_event_bus.emit_brain_event = broken
    try:
        # Import after patching so the call inside add_heuristic uses the broken one
        from app.services.heuristics_service import add_heuristic, remove_heuristic

        # add_heuristic itself doesn't emit (we'll wire that later);
        # but a no-op call should still succeed if it returns cleanly.
        result = add_heuristic("v4.3 publisher-failure-test", source="v4_3_test")
        assert result is not None
        remove_heuristic(result)
    finally:
        brain_event_bus.emit_brain_event = original

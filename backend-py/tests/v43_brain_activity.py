"""v4.3 — Test the brain event bus + /api/brain/events endpoints."""

import asyncio
import json
import time
import pytest


@pytest.fixture(autouse=True)
def _resetBus():
    """Reset the in-process bus to a clean state between tests."""
    from app.services import brain_event_bus

    brain_event_bus.brain_bus._events.clear()
    brain_event_bus.brain_bus._subscribers.clear()
    yield


def testEmitAppendsWithIdIsoTimestampAndDefaults():
    """emit() stores {id, category, layer, summary, at, meta}."""
    from app.services.brain_event_bus import emitBrainEvent, brainBus

    emitBrainEvent(category='heuristic', layer='delta_engine', summary="learned 'prefer tabs'")
    events = brainBus.recent(limit=10)
    assert len(events) == 1
    e = events[0]
    assert e['category'] == 'heuristic'
    assert e['layer'] == 'delta_engine'
    assert e['summary'] == "learned 'prefer tabs'"
    assert 'id' in e and len(e['id']) > 0
    assert e['at'].endswith('Z')
    assert e['meta'] == {}


def testRecentRespectsLimitAndCategoryFilter():
    from app.services.brain_event_bus import emitBrainEvent, brainBus

    emitBrainEvent(category='consolidation', layer='sleep_cycle', summary='merged 2')
    emitBrainEvent(category='heuristic', layer='delta_engine', summary='learned x')
    emitBrainEvent(category='consolidation', layer='sleep_cycle', summary='deleted stale')
    consolidationOnly = brainBus.recent(limit=50, category='consolidation')
    assert len(consolidationOnly) == 2
    assert all((e['category'] == 'consolidation' for e in consolidationOnly))
    capped = brainBus.recent(limit=1)
    assert len(capped) == 1


def testGetEndpointReturnsEventsNewestFirst():
    """GET /api/brain/events returns recent events, newest first."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.services.brain_event_bus import emitBrainEvent

    emitBrainEvent(category='heuristic', layer='heuristics_service', summary='first')
    time.sleep(0.01)
    emitBrainEvent(category='consolidation', layer='sleep_cycle', summary='second')
    client = TestClient(app)
    resp = client.get('/api/brain/events')
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) >= 2
    assert data[0]['summary'] == 'second'


def testSseEndpointModuleExportsStream():
    """The /api/brain/events/stream endpoint exists in the router. Streaming
    behavior is verified manually — TestClient + async iterators hang."""
    from app.routers import brain_activity

    paths = {route.path for route in brain_activity.router.routes}
    assert '/api/brain/events/stream' in paths
    assert '/api/brain/events' in paths


def testAddHeuristicPublishesBrainEvent():
    """add_heuristic() publishes a 'heuristic' event so the Activity tab sees it."""
    from app.services.brain_event_bus import brainBus

    from app.services.heuristics_service import addHeuristic, removeHeuristic

    rid = (
        addHeuristic('v4.3 publish-test {uuid}', source='v4_3_test')
        if False
        else __import__('uuid').uuid4()
        and addHeuristic(f'v4.3 publish-test {__import__("uuid").uuid4().hex[:8]}', source='v4_3_test')
    )
    assert rid is not None
    after = brainBus.recent(limit=200)
    newEvents = [e for e in after if e['category'] == 'heuristic' and e['summary'].startswith('Added heuristic')]
    assert any((e['meta'].get('rule_id') == rid for e in newEvents))
    removeHeuristic(rid)


def testPublisherFailureDoesNotBreakDaemon():
    """If the brain event bus raises, the underlying op must still succeed."""
    from app.services import brain_event_bus

    original = brain_event_bus.emit_brain_event

    def broken(**__):
        raise RuntimeError('bus exploded')

    brain_event_bus.emit_brain_event = broken
    try:
        from app.services.heuristics_service import addHeuristic, removeHeuristic

        result = addHeuristic('v4.3 publisher-failure-test', source='v4_3_test')
        assert result is not None
        removeHeuristic(result)
    finally:
        brain_event_bus.emit_brain_event = original

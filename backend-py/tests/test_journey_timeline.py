"""Journey timeline — episodic event writes and the /api/brain/timeline shape."""

from __future__ import annotations

import pytest


def test_write_timeline_event_persists(brain_ready):
    from app.services.memory_store import _conn
    from app.services.memory_store.rest import write_timeline_event

    write_timeline_event('wb_1', 'User asked: fix the CI', category='workbench')
    row = _conn().execute('SELECT * FROM episodic_timeline').fetchone()
    assert row is not None
    assert row['session_id'] == 'wb_1'
    assert row['category'] == 'workbench'
    assert 'CI' in row['event_summary']


@pytest.mark.asyncio
async def test_timeline_endpoint_shape_and_filters(brain_ready):
    from app.routers.brain_dashboard import brainTimeline
    from app.services.memory_store.rest import write_timeline_event

    write_timeline_event('wb_1', 'User asked: fix the CI', category='workbench')
    write_timeline_event(None, 'Memory cap active: pruned 3 memories', category='memory')

    all_items = await brainTimeline()
    assert all_items['count'] == 2
    assert len(all_items['items']) == 2
    assert all_items['items'][0]['eventSummary']  # camelCase wire keys
    assert 'category' in all_items['items'][0]

    workbench_only = await brainTimeline(category='workbench')
    assert workbench_only['count'] == 1
    assert workbench_only['items'][0]['category'] == 'workbench'

    session_only = await brainTimeline(sessionId='wb_1')
    assert session_only['count'] == 1

    limited = await brainTimeline(limit=1)
    assert limited['count'] == 1


@pytest.mark.asyncio
async def test_timeline_empty(brain_ready):
    from app.routers.brain_dashboard import brainTimeline

    out = await brainTimeline()
    assert out == {'items': [], 'count': 0}

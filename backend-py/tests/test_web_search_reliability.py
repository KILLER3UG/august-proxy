"""Tests for web_search timeout, fetch count, and progress callbacks."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

import pytest


@pytest.mark.asyncio
async def test_web_search_ddg_timeout_returns_error_json():
    from app.services.tool_registrations import web_tools as wt

    async def fake_wait_for(awaitable, timeout=None):
        if asyncio.iscoroutine(awaitable):
            awaitable.close()
        raise asyncio.TimeoutError()

    with patch('asyncio.wait_for', side_effect=fake_wait_for):
        raw = await wt._webSearch('test query', maxResults=10)
    data = json.loads(raw)
    assert data['result_count'] == 0
    assert data.get('error') == 'timeout'


@pytest.mark.asyncio
async def test_web_search_fetches_up_to_10():
    from app.services.tool_registrations import web_tools as wt

    fake_results = [
        {'title': f'T{i}', 'href': f'https://example.com/{i}', 'body': f'snippet {i}'}
        for i in range(12)
    ]

    class FakeDDGS:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def text(self, query, max_results=10):
            return fake_results[:max_results]

    async def fake_fetch(url: str, maxLength: int = 8000) -> str:
        return f'URL: {url}\nStatus: 200\n\ncontent for {url}'

    progress_phases: list[str] = []

    async def on_progress(phase: str, meta=None):
        progress_phases.append(phase)

    with patch('ddgs.DDGS', FakeDDGS):
        with patch.object(wt, '_fetchUrlContent', side_effect=fake_fetch):
            raw = await wt._webSearch('q', maxResults=10, on_progress=on_progress)

    data = json.loads(raw)
    assert data['result_count'] == 10
    assert len(data['fetched_content']) == 10
    assert 'searching' in progress_phases
    assert any(p == 'fetching' for p in progress_phases)
    assert 'done' in progress_phases

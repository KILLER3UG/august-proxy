"""Tests for web_search timeout, fetch budget, and progress callbacks."""

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
async def test_web_search_fetches_up_to_10_under_budget():
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

    async def fake_fetch(url: str, maxLength: int = 8000, timeout_s: float = 8.0) -> str:
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
    assert 'reading' in progress_phases
    assert 'read' in progress_phases
    assert 'done' in progress_phases


@pytest.mark.asyncio
async def test_web_search_abandons_slow_fetches_and_returns_snippets():
    from app.services.tool_registrations import web_tools as wt

    fake_results = [
        {'title': f'T{i}', 'href': f'https://example.com/{i}', 'body': f'snippet {i}'}
        for i in range(10)
    ]

    class FakeDDGS:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def text(self, query, max_results=10):
            return fake_results[:max_results]

    async def slow_fetch(url: str, maxLength: int = 8000, timeout_s: float = 8.0) -> str:
        await asyncio.sleep(60)
        return f'URL: {url}\nStatus: 200\n\nlate'

    with patch('ddgs.DDGS', FakeDDGS):
        with patch.object(wt, '_fetchUrlContent', side_effect=slow_fetch):
            with patch.object(wt, '_FETCH_PHASE_BUDGET_S', 0.2):
                with patch.object(wt, '_TOTAL_BUDGET_S', 1.0):
                    raw = await asyncio.wait_for(
                        wt._webSearch('q', maxResults=10),
                        timeout=3.0,
                    )

    data = json.loads(raw)
    assert data['result_count'] == 10
    # Must not hang waiting for all 10×60s sleeps.
    assert data.get('partial') is True or data.get('fetched_count', 0) == 0

"""Tests for snippets-only web_search, backends, and fetch compression."""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_web_search_ddg_timeout_returns_error_json():
    from app.services.tool_registrations import web_tools as wt

    async def fake_wait_for(awaitable, timeout=None):
        if asyncio.iscoroutine(awaitable):
            awaitable.close()
        raise asyncio.TimeoutError()

    with patch('asyncio.wait_for', side_effect=fake_wait_for):
        with patch.object(wt, 'resolve_search_backend', return_value='ddgs'):
            raw = await wt._webSearch('test query', maxResults=10)
    data = json.loads(raw)
    assert data['result_count'] == 0
    assert data.get('error') == 'timeout'


@pytest.mark.asyncio
async def test_web_search_returns_snippets_only_no_auto_fetch():
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

    progress_phases: list[str] = []

    async def on_progress(phase: str, meta=None):
        progress_phases.append(phase)

    with patch('ddgs.DDGS', FakeDDGS):
        with patch.object(wt, 'resolve_search_backend', return_value='ddgs'):
            with patch.object(wt, '_fetchUrlContent', AsyncMock()) as fetch_mock:
                raw = await wt._webSearch('q', maxResults=10, on_progress=on_progress)

    data = json.loads(raw)
    assert data['result_count'] == 10
    assert 'results' in data
    assert 'fetched_content' not in data
    assert fetch_mock.await_count == 0
    assert 'reading' in progress_phases
    assert 'done' in progress_phases
    assert 'snippets' in data.get('message', '').lower() or 'web_fetch' in data.get('message', '')


@pytest.mark.asyncio
async def test_web_search_brave_backend():
    from app.services.tool_registrations import web_tools as wt

    async def fake_run(query, max_results=10, *, backend=None):
        return (
            'brave',
            [
                {
                    'index': 1,
                    'title': 'Brave Hit',
                    'url': 'https://example.com/b',
                    'snippet': 'from brave',
                }
            ],
        )

    with patch.object(wt, 'resolve_search_backend', return_value='brave'):
        with patch.object(wt, 'run_search', side_effect=fake_run):
            raw = await wt._webSearch('q', maxResults=5)

    data = json.loads(raw)
    assert data['backend'] == 'brave'
    assert data['result_count'] == 1
    assert data['results'][0]['title'] == 'Brave Hit'


@pytest.mark.asyncio
async def test_web_fetch_compresses_long_pages():
    from app.services.tool_registrations import web_tools as wt

    long_body = 'A' * 8000
    envelope = f'URL: https://example.com/long\nStatus: 200\n\n{long_body}'

    async def fake_fetch(url, maxLength=50000, timeout_s=15.0):
        return envelope

    with patch.object(wt, '_fetchUrlContent', side_effect=fake_fetch):
        with patch(
            'app.services.tool_registrations.web_extract_compress._aux_summarize',
            new=AsyncMock(return_value='SHORT SUMMARY'),
        ):
            with patch(
                'app.services.tool_registrations.web_extract_compress.get_web_config',
                return_value={
                    'extractCompress': True,
                    'extractRawMaxChars': 5000,
                    'extractSummaryMaxChars': 5000,
                    'extractCompressMaxChars': 500_000,
                    'extractHardMaxChars': 2_000_000,
                    'fetchTimeoutS': 15.0,
                },
            ):
                out = await wt._webFetch('https://example.com/long')

    assert 'SHORT SUMMARY' in out
    assert 'summarized' in out.lower()


@pytest.mark.asyncio
async def test_web_fetch_leaves_short_pages_raw():
    from app.services.tool_registrations import web_tools as wt

    short = 'URL: https://example.com/s\nStatus: 200\n\nHello world'

    async def fake_fetch(url, maxLength=50000, timeout_s=15.0):
        return short

    with patch.object(wt, '_fetchUrlContent', side_effect=fake_fetch):
        with patch(
            'app.services.tool_registrations.web_extract_compress._aux_summarize',
            new=AsyncMock(),
        ) as summarize:
            with patch(
                'app.services.tool_registrations.web_extract_compress.get_web_config',
                return_value={
                    'extractCompress': True,
                    'extractRawMaxChars': 5000,
                    'extractSummaryMaxChars': 5000,
                    'extractCompressMaxChars': 500_000,
                    'extractHardMaxChars': 2_000_000,
                    'fetchTimeoutS': 15.0,
                },
            ):
                out = await wt._webFetch('https://example.com/s')

    assert 'Hello world' in out
    summarize.assert_not_awaited()


def test_resolve_search_backend_auto_prefers_brave():
    from app.services.web_config_service import resolve_search_backend

    assert (
        resolve_search_backend(
            {'backend': 'auto', 'braveApiKey': 'k', 'searxngUrl': 'http://x'}
        )
        == 'brave'
    )
    assert resolve_search_backend({'backend': 'auto', 'braveApiKey': '', 'searxngUrl': ''}) == 'ddgs'
    assert (
        resolve_search_backend(
            {'backend': 'searxng', 'braveApiKey': 'k', 'searxngUrl': 'http://x'}
        )
        == 'searxng'
    )

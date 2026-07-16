"""What's New endpoint — GitHub activity feed."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_whats_new_returns_commits_and_releases():
    commit_payload = [
        {
            'sha': 'abcdef0123456789',
            'html_url': 'https://github.com/KILLER3UG/august-proxy/commit/abcdef0123456789',
            'commit': {
                'message': 'Fix sidebar dropdown width\n\nDetails',
                'author': {'name': 'dev', 'date': '2026-07-16T10:00:00Z'},
            },
            'author': {'login': 'dev'},
        }
    ]
    release_payload = [
        {
            'tag_name': 'v0.12.1',
            'name': 'v0.12.1',
            'body': 'Bug fixes',
            'published_at': '2099-01-01T00:00:00Z',
            'html_url': 'https://github.com/KILLER3UG/august-proxy/releases/tag/v0.12.1',
            'prerelease': False,
        }
    ]

    commit_resp = MagicMock()
    commit_resp.status_code = 200
    commit_resp.json.return_value = commit_payload

    release_resp = MagicMock()
    release_resp.status_code = 200
    release_resp.json.return_value = release_payload

    mock_client = AsyncMock()
    mock_client.get = AsyncMock(side_effect=[commit_resp, release_resp])
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with patch('app.routers.whats_new.httpx.AsyncClient', return_value=mock_client):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url='http://test') as client:
            resp = await client.get('/api/whats-new?hours=48')

    assert resp.status_code == 200
    data = resp.json()
    assert data['hours'] == 48
    assert data['repo'] == 'KILLER3UG/august-proxy'
    assert len(data['commits']) == 1
    assert data['commits'][0]['sha'] == 'abcdef0'
    assert data['commits'][0]['message'] == 'Fix sidebar dropdown width'
    assert len(data['releases']) == 1
    assert data['releases'][0]['tag'] == 'v0.12.1'

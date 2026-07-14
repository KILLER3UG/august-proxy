"""Characterization tests for CamelModel on the git router.

Proves the git command body boundary: snake_case Python fields, camelCase
JSON in (frontend contract), and that POST /api/git/command still works.
"""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.routers.git import GitCommand


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def test_git_command_serializes_camelcase():
    body = GitCommand(repo_path='/tmp/repo', args=['status', '--short'])
    dumped = body.model_dump(by_alias=True)
    assert dumped['repoPath'] == '/tmp/repo'
    assert dumped['args'] == ['status', '--short']


def test_git_command_accepts_camelcase_input():
    body = GitCommand.model_validate(
        {
            'repoPath': '/work/proj',
            'args': ['log', '-1'],
        }
    )
    assert body.repo_path == '/work/proj'
    assert body.args == ['log', '-1']


def test_git_command_accepts_snake_case_via_populate_by_name():
    body = GitCommand(repo_path='/x', args=['rev-parse', 'HEAD'])
    assert body.repo_path == '/x'
    assert body.args == ['rev-parse', 'HEAD']


@pytest.mark.asyncio
async def test_post_api_git_command_accepts_camelcase_json(client, isolatedData):
    """HTTP contract: frontend posts camelCase; endpoint runs a safe git command."""
    # Use this repo as cwd via empty repoPath (defaults to process cwd).
    # `git rev-parse --is-inside-work-tree` is read-only and always works here.
    resp = await client.post(
        '/api/git/command',
        json={
            'repoPath': '',
            'args': ['rev-parse', '--is-inside-work-tree'],
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert 'output' in data
    assert data['output'].strip() == 'true'


@pytest.mark.asyncio
async def test_post_api_git_command_rejects_empty_args(client, isolatedData):
    resp = await client.post(
        '/api/git/command',
        json={'repoPath': '', 'args': []},
    )
    assert resp.status_code == 400
    assert 'No git args' in resp.json()['detail']

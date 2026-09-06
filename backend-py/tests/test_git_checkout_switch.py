"""POST /api/git/checkout — GitHub-style branch switching with uncommitted changes.

A blocked switch (local changes that would be overwritten) must return
``dirty: true`` (HTTP 200) so the UI can offer leave vs transfer, and the
``strategy`` param must actually stash / carry the changes.
"""

from __future__ import annotations

import subprocess

import pytest
from app.main import app
from httpx import ASGITransport, AsyncClient


def _git(repo, *args: str) -> str:
    res = subprocess.run(
        ['git', *args], cwd=str(repo), capture_output=True, text=True, check=True,
    )
    return res.stdout


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / 'repo'
    r.mkdir()
    _git(r, 'init', '-b', 'main')
    _git(r, 'config', 'user.email', 't@example.com')
    _git(r, 'config', 'user.name', 'tester')
    (r / 'a.txt').write_text('one\n', encoding='utf-8')
    _git(r, 'add', '.')
    _git(r, 'commit', '-m', 'init')
    _git(r, 'branch', 'feature')
    # feature diverges on a.txt so a dirty a.txt on main blocks the switch.
    _git(r, 'checkout', 'feature')
    (r / 'a.txt').write_text('feature\n', encoding='utf-8')
    _git(r, 'commit', '-am', 'feature change')
    _git(r, 'checkout', 'main')
    return r


@pytest.fixture
async def client():
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as ac:
        yield ac


async def _checkout(client, repo, branch, **kw):
    return await client.post(
        '/api/git/checkout', json={'repoPath': str(repo), 'branch': branch, **kw},
    )


def _make_dirty(repo):
    (repo / 'a.txt').write_text('dirty on main\n', encoding='utf-8')


@pytest.mark.asyncio
async def test_clean_switch_succeeds(client, repo):
    resp = await _checkout(client, repo, 'feature')
    assert resp.status_code == 200
    assert resp.json()['ok'] is True
    assert _git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').strip() == 'feature'


@pytest.mark.asyncio
async def test_dirty_switch_returns_dirty_not_error(client, repo):
    _make_dirty(repo)
    resp = await _checkout(client, repo, 'feature')
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data['ok'] is False and data['dirty'] is True
    assert 'a.txt' in data['files']
    # The switch did NOT happen — still on main with the change intact.
    assert _git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').strip() == 'main'
    assert (repo / 'a.txt').read_text(encoding='utf-8') == 'dirty on main\n'


@pytest.mark.asyncio
async def test_leave_stashes_and_switches(client, repo):
    _make_dirty(repo)
    resp = await _checkout(client, repo, 'feature', strategy='leave')
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data['ok'] is True and data['stashed'] is True
    assert _git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').strip() == 'feature'
    # Working tree clean on feature; the change survives in the stash.
    assert _git(repo, 'status', '--porcelain').strip() == ''
    assert 'August:' in _git(repo, 'stash', 'list')


@pytest.mark.asyncio
async def test_transfer_conflict_keeps_stash_and_warns(client, repo):
    _make_dirty(repo)
    resp = await _checkout(client, repo, 'feature', strategy='transfer')
    assert resp.status_code == 200, resp.text
    data = resp.json()
    # Switched, but the pop conflicted (a.txt differs on feature) — honest warning.
    assert data['ok'] is True and data['stashed'] is True
    assert _git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').strip() == 'feature'
    assert data.get('carried') is False and data.get('warning')
    assert 'August:' in _git(repo, 'stash', 'list')


@pytest.mark.asyncio
async def test_unknown_branch_is_a_hard_error(client, repo):
    resp = await _checkout(client, repo, 'does-not-exist')
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_create_branch_still_works(client, repo):
    resp = await _checkout(client, repo, 'brand-new', create=True)
    assert resp.status_code == 200, resp.text
    assert resp.json()['ok'] is True
    assert _git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').strip() == 'brand-new'

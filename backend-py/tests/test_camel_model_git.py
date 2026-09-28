"""Characterization tests for CamelModel on the git router.

Proves the git body boundary: snake_case Python fields, camelCase JSON in
(frontend contract), and that the typed /api/git/restore endpoint works.

The arbitrary-argv `POST /api/git/command` is GONE — it forwarded a
caller-supplied argv straight to git, which included reading and writing any
file on the machine via `diff --no-index` and running any program via
`-c diff.external=`. Its tombstone is asserted below so a stale client gets a
410 that names the replacement instead of a 404 it has to guess at.
"""
from __future__ import annotations

import pytest
from app.main import app
from app.routers.git import GitCommand, RestoreBody
from httpx import ASGITransport, AsyncClient


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url='http://test') as ac:
        yield ac


def test_restore_body_serializes_camelcase():
    body = RestoreBody(repo_path='/tmp/repo')
    dumped = body.model_dump(by_alias=True)
    assert dumped['repoPath'] == '/tmp/repo'
    # The body names a session or a repo. It does NOT name a command — that
    # field is the whole vulnerability, and its absence is the fix.
    assert 'args' not in dumped


def test_restore_body_accepts_camelcase_input():
    body = RestoreBody.model_validate({'sessionId': 's1', 'repoPath': '/work/proj'})
    assert body.session_id == 's1'
    assert body.repo_path == '/work/proj'


def test_restore_body_accepts_snake_case_via_populate_by_name():
    body = RestoreBody(session_id='s1', repo_path='/x')
    assert body.session_id == 's1'
    assert body.repo_path == '/x'


@pytest.mark.asyncio
async def test_post_api_git_restore_discards_working_tree(client, isolatedData, tmp_path):
    """The one real caller wanted `git restore -- .`; that is now the endpoint."""
    import subprocess

    repo = tmp_path / 'repo'
    repo.mkdir()
    subprocess.run(['git', 'init', '-b', 'main'], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ['git', 'commit', '--allow-empty', '-m', 'init'],
        cwd=repo,
        check=True,
        capture_output=True,
        env=_git_env(),
    )
    (repo / 'tracked.txt').write_text('original', encoding='utf-8')
    subprocess.run(['git', 'add', '-A'], cwd=repo, check=True, capture_output=True, env=_git_env())
    subprocess.run(
        ['git', 'commit', '-m', 'add file'], cwd=repo, check=True, capture_output=True, env=_git_env()
    )
    (repo / 'tracked.txt').write_text('scratch edit', encoding='utf-8')

    resp = await client.post('/api/git/restore', json={'sessionId': '', 'repoPath': str(repo)})
    assert resp.status_code == 200, resp.text
    assert resp.json()['workspace'] == str(repo.resolve())
    assert (repo / 'tracked.txt').read_text(encoding='utf-8') == 'original'


@pytest.mark.asyncio
async def test_git_command_is_gone_and_says_what_replaced_it(client, isolatedData):
    """410, not 404 — a stale client should be told the replacement."""
    resp = await client.post('/api/git/command', json={'args': ['status'], 'repoPath': '.'})
    assert resp.status_code == 410
    detail = resp.json()['detail']
    assert '/api/git/restore' in detail
    # It must not run anything on the way to refusing.
    assert 'No git args' not in detail


@pytest.mark.asyncio
async def test_git_command_tombstone_runs_no_git(client, isolatedData, monkeypatch):
    """A refusal that still spawns git is not a refusal."""
    from app.routers import git as git_router

    called: list[tuple] = []

    async def _fail(*args, **kwargs):  # pragma: no cover - must never run
        called.append(args)
        raise AssertionError('the tombstone must not invoke git')

    monkeypatch.setattr(git_router, '_run_git', _fail)
    resp = await client.post(
        '/api/git/command',
        json={'args': ['diff', '--no-index', 'a', 'b'], 'repoPath': '.'},
    )
    assert resp.status_code == 410
    assert called == []


@pytest.mark.asyncio
async def test_git_branch_falls_back_to_repo_path_when_session_missing(client, isolatedData, tmp_path):
    """Chat session ids often are not workbench sessions — repoPath must still work."""
    import subprocess

    repo = tmp_path / 'repo'
    repo.mkdir()
    subprocess.run(['git', 'init', '-b', 'main'], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ['git', 'commit', '--allow-empty', '-m', 'init'],
        cwd=repo,
        check=True,
        capture_output=True,
        env={
            **dict(__import__('os').environ),
            'GIT_AUTHOR_NAME': 'Test',
            'GIT_AUTHOR_EMAIL': 'test@example.com',
            'GIT_COMMITTER_NAME': 'Test',
            'GIT_COMMITTER_EMAIL': 'test@example.com',
        },
    )

    resp = await client.get(
        '/api/git/branch',
        params={'sessionId': 'chat_session_that_does_not_exist', 'repoPath': str(repo)},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data.get('error') in (None, '')
    assert data.get('current') == 'main'


@pytest.mark.asyncio
async def test_git_checkout_accepts_repo_path_without_session(client, isolatedData, tmp_path):
    import subprocess

    repo = tmp_path / 'repo'
    repo.mkdir()
    subprocess.run(['git', 'init', '-b', 'main'], cwd=repo, check=True, capture_output=True)
    env = {
        **dict(__import__('os').environ),
        'GIT_AUTHOR_NAME': 'Test',
        'GIT_AUTHOR_EMAIL': 'test@example.com',
        'GIT_COMMITTER_NAME': 'Test',
        'GIT_COMMITTER_EMAIL': 'test@example.com',
    }
    subprocess.run(
        ['git', 'commit', '--allow-empty', '-m', 'init'],
        cwd=repo,
        check=True,
        capture_output=True,
        env=env,
    )
    subprocess.run(['git', 'branch', 'feature'], cwd=repo, check=True, capture_output=True)

    resp = await client.post(
        '/api/git/checkout',
        json={'sessionId': '', 'repoPath': str(repo), 'branch': 'feature'},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json().get('branch') == 'feature'

    branch = await client.get('/api/git/branch', params={'repoPath': str(repo)})
    assert branch.json().get('current') == 'feature'


def _git_env() -> dict[str, str]:
    import os

    return {
        **dict(os.environ),
        'GIT_AUTHOR_NAME': 'Test',
        'GIT_AUTHOR_EMAIL': 'test@example.com',
        'GIT_COMMITTER_NAME': 'Test',
        'GIT_COMMITTER_EMAIL': 'test@example.com',
    }


@pytest.mark.asyncio
async def test_git_checkout_create_branch(client, isolatedData, tmp_path):
    """checkout with create:true runs `checkout -b` — the dropdown's
    "Create and switch to new branch…" flow."""
    import subprocess

    repo = tmp_path / 'repo'
    repo.mkdir()
    subprocess.run(['git', 'init', '-b', 'main'], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ['git', 'commit', '--allow-empty', '-m', 'init'],
        cwd=repo,
        check=True,
        capture_output=True,
        env=_git_env(),
    )

    resp = await client.post(
        '/api/git/checkout',
        json={'sessionId': '', 'repoPath': str(repo), 'branch': 'fresh-work', 'create': True},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json().get('branch') == 'fresh-work'

    branch = await client.get('/api/git/branch', params={'repoPath': str(repo)})
    assert branch.json().get('current') == 'fresh-work'


@pytest.mark.asyncio
async def test_git_push_to_upstream_and_honest_failure(client, isolatedData, tmp_path):
    """Push succeeds against a local bare remote once upstream is set, and
    fails with 400 + stderr when no upstream is configured."""
    import subprocess

    remote = tmp_path / 'remote.git'
    subprocess.run(['git', 'init', '--bare', '-b', 'main', str(remote)], check=True, capture_output=True)
    repo = tmp_path / 'repo'
    repo.mkdir()
    subprocess.run(['git', 'init', '-b', 'main'], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ['git', 'commit', '--allow-empty', '-m', 'init'],
        cwd=repo,
        check=True,
        capture_output=True,
        env=_git_env(),
    )
    subprocess.run(
        ['git', 'remote', 'add', 'origin', str(remote)], cwd=repo, check=True, capture_output=True
    )

    # No upstream configured yet — the endpoint must fail honestly.
    resp = await client.post('/api/git/push', json={'sessionId': '', 'repoPath': str(repo)})
    assert resp.status_code == 400, resp.text
    assert resp.json().get('detail')

    # Configure upstream (offline, file transport), then a new commit pushes.
    subprocess.run(
        ['git', 'push', '-u', 'origin', 'main'], cwd=repo, check=True, capture_output=True, env=_git_env()
    )
    subprocess.run(
        ['git', 'commit', '--allow-empty', '-m', 'second'],
        cwd=repo,
        check=True,
        capture_output=True,
        env=_git_env(),
    )
    resp = await client.post('/api/git/push', json={'sessionId': '', 'repoPath': str(repo)})
    assert resp.status_code == 200, resp.text
    assert 'output' in resp.json()


@pytest.mark.asyncio
async def test_git_branches_sorts_current_first(client, isolatedData, tmp_path):
    """The switcher lists local branches with the current one flagged and on
    top, so "which branch am I in" is unambiguous."""
    import subprocess

    repo = tmp_path / 'repo'
    repo.mkdir()
    subprocess.run(['git', 'init', '-b', 'aaa-base'], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ['git', 'commit', '--allow-empty', '-m', 'init'], cwd=repo, check=True, capture_output=True, env=_git_env()
    )
    subprocess.run(['git', 'branch', 'zzz-later'], cwd=repo, check=True, capture_output=True)
    subprocess.run(['git', 'checkout', '-b', 'mid-work'], cwd=repo, check=True, capture_output=True, env=_git_env())

    resp = await client.get('/api/git/branches', params={'repoPath': str(repo)})
    assert resp.status_code == 200, resp.text
    branches = resp.json()['branches']
    names = [b['name'] for b in branches]
    assert set(names) == {'aaa-base', 'zzz-later', 'mid-work'}
    assert branches[0]['name'] == 'mid-work' and branches[0]['current'] is True
    assert sum(1 for b in branches if b['current']) == 1


@pytest.mark.asyncio
async def test_git_branches_detached_head(client, isolatedData, tmp_path):
    """A detached HEAD (checked-out commit) still reports where the user is:
    /branch returns the short SHA + detached flag; /branches carries it too."""
    import subprocess

    repo = tmp_path / 'repo'
    repo.mkdir()
    subprocess.run(['git', 'init', '-b', 'main'], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ['git', 'commit', '--allow-empty', '-m', 'one'], cwd=repo, check=True, capture_output=True, env=_git_env()
    )
    subprocess.run(
        ['git', 'commit', '--allow-empty', '-m', 'two'], cwd=repo, check=True, capture_output=True, env=_git_env()
    )
    sha = subprocess.run(
        ['git', 'rev-parse', '--short', 'HEAD~1'], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()
    subprocess.run(['git', 'checkout', sha], cwd=repo, check=True, capture_output=True, env=_git_env())

    branch = await client.get('/api/git/branch', params={'repoPath': str(repo)})
    assert branch.status_code == 200, branch.text
    bdata = branch.json()
    assert bdata.get('detached') is True
    assert bdata.get('current') == sha

    branches = await client.get('/api/git/branches', params={'repoPath': str(repo)})
    assert branches.status_code == 200, branches.text
    jdata = branches.json()
    assert jdata.get('detached') is True
    assert jdata.get('head') == sha
    # No branch is flagged current while detached.
    assert all(not b['current'] for b in jdata['branches'])


@pytest.mark.asyncio
async def test_git_branches_reports_upstream_tracking(client, isolatedData, tmp_path):
    """A tracked branch surfaces its upstream + ahead/behind so the menu
    reflects real sync state, not just names."""
    import subprocess

    remote = tmp_path / 'remote.git'
    subprocess.run(['git', 'init', '--bare', '-b', 'main', str(remote)], check=True, capture_output=True)
    repo = tmp_path / 'repo'
    repo.mkdir()
    subprocess.run(['git', 'init', '-b', 'main'], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ['git', 'commit', '--allow-empty', '-m', 'init'], cwd=repo, check=True, capture_output=True, env=_git_env()
    )
    subprocess.run(['git', 'remote', 'add', 'origin', str(remote)], cwd=repo, check=True, capture_output=True)
    subprocess.run(['git', 'push', '-u', 'origin', 'main'], cwd=repo, check=True, capture_output=True, env=_git_env())
    subprocess.run(
        ['git', 'commit', '--allow-empty', '-m', 'ahead'], cwd=repo, check=True, capture_output=True, env=_git_env()
    )

    resp = await client.get('/api/git/branches', params={'repoPath': str(repo)})
    assert resp.status_code == 200, resp.text
    main = next(b for b in resp.json()['branches'] if b['name'] == 'main')
    assert main['upstream'] == 'origin/main'
    assert main['ahead'] == 1
    assert main['behind'] == 0

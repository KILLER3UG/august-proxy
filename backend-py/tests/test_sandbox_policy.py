"""Tests for Codex-like sandbox policy, paths, and soft runner."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from app.services.sandbox.paths import bind_path, is_within_root
from app.services.sandbox.policy import normalize_sandbox_mode, SandboxPolicy
from app.services.sandbox.backends.fallback import soft_preflight, run_soft
from app.services.sandbox.runner import unsandboxed_grant_key, policy_from_session, active_backend


def test_normalize_sandbox_mode():
    assert normalize_sandbox_mode(None) == 'workspace-write'
    assert normalize_sandbox_mode('read-only') == 'read-only'
    assert normalize_sandbox_mode('readonly') == 'read-only'
    assert normalize_sandbox_mode('full') == 'danger-full-access'
    assert normalize_sandbox_mode('workspace') == 'workspace-write'


def test_bind_path_inside_and_outside(tmp_path: Path):
    root = tmp_path / 'ws'
    root.mkdir()
    inside = root / 'a.txt'
    inside.write_text('x', encoding='utf-8')
    ok, err = bind_path(str(inside), str(root), for_write=False)
    assert err is None and ok is not None
    outside = tmp_path / 'evil.txt'
    outside.write_text('y', encoding='utf-8')
    bad, err2 = bind_path(str(outside), str(root), for_write=True)
    assert bad is None and err2 and 'outside workspace' in err2


def test_is_within_root(tmp_path: Path):
    root = tmp_path / 'ws'
    root.mkdir()
    child = root / 'sub'
    child.mkdir()
    assert is_within_root(child, root)
    assert not is_within_root(tmp_path, root)


def test_soft_preflight_blocks_network_and_readonly():
    policy = SandboxPolicy(mode='workspace-write', workspace_root='', network=False)
    assert soft_preflight('curl https://example.com', policy)
    assert soft_preflight('wget http://x', policy)
    ro = SandboxPolicy(mode='read-only', workspace_root='', network=False)
    assert soft_preflight('rm -rf ./foo', ro)
    assert soft_preflight('echo hi > ./out.txt', ro)
    assert soft_preflight('echo hi', ro) is None


def test_soft_preflight_blocks_outside_redirect(tmp_path: Path):
    root = tmp_path / 'ws'
    root.mkdir()
    policy = SandboxPolicy(mode='workspace-write', workspace_root=str(root), network=False)
    home_file = Path.home() / 'august-sandbox-test-evil.txt'
    denial = soft_preflight(f'echo x > "{home_file}"', policy)
    assert denial is not None


@pytest.mark.asyncio
async def test_run_soft_echo(tmp_path: Path):
    root = tmp_path / 'ws'
    root.mkdir()
    policy = SandboxPolicy(mode='workspace-write', workspace_root=str(root), network=False)
    result = await run_soft('echo sandbox-ok', policy, timeout=10)
    assert result.denial_reason is None
    assert 'sandbox-ok' in (result.stdout or '')
    assert result.enforcement == 'soft'
    assert result.sandboxed is True


@pytest.mark.asyncio
async def test_run_soft_timeout_is_not_sandbox_denial(tmp_path: Path):
    """Timeouts must return an error, not a sandbox-escape 'Blocked' denial."""
    root = tmp_path / 'ws'
    root.mkdir()
    sleeper = root / 'sleep.py'
    sleeper.write_text('import time; time.sleep(30)\n', encoding='utf-8')
    policy = SandboxPolicy(mode='workspace-write', workspace_root=str(root), network=False)
    result = await run_soft('python sleep.py', policy, timeout=0.3)
    assert result.ok is False
    assert result.denial_reason is None
    assert 'timed out' in (result.stderr or '').lower()
    assert 'Blocked' not in result.as_tool_text()


@pytest.mark.asyncio
async def test_run_soft_cancel_kills_child(tmp_path: Path):
    from app.lib.async_subprocess import current_subprocess_cancel

    root = tmp_path / 'ws'
    root.mkdir()
    sleeper = root / 'sleep.py'
    sleeper.write_text('import time; time.sleep(30)\n', encoding='utf-8')
    policy = SandboxPolicy(mode='workspace-write', workspace_root=str(root), network=False)
    cancel = asyncio.Event()
    token = current_subprocess_cancel.set(cancel)

    async def _fire() -> None:
        await asyncio.sleep(0.15)
        cancel.set()

    fire = asyncio.create_task(_fire())
    try:
        result = await run_soft('python sleep.py', policy, timeout=30)
        assert result.ok is False
        assert result.denial_reason is None
        assert 'cancelled' in (result.stderr or '').lower()
    finally:
        current_subprocess_cancel.reset(token)
        fire.cancel()


def test_policy_from_session_and_grant_key():
    p = policy_from_session(
        sandbox_mode='workspace-write',
        workspace_path='/tmp/ws',
        sandbox_network=False,
    )
    assert p.mode == 'workspace-write'
    assert p.network is False
    key = unsandboxed_grant_key('npm test')
    assert key.startswith('sandbox:unsandboxed:')
    assert active_backend() in ('soft', 'seatbelt', 'bwrap', 'landlock', 'windows-appcontainer')


def test_full_access_enables_network():
    p = policy_from_session(
        sandbox_mode='danger-full-access',
        workspace_path='',
        sandbox_network=False,
    )
    assert p.is_full_access
    assert p.network is True
